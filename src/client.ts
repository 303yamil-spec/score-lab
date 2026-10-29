/**
 * SportyBetClient — HTTP layer for the SportyBet web API.
 *
 * Source: SportyBet's own public web API (the same endpoints the sportybet.com
 * website and mobile apps use). NOT an official developer API — undocumented
 * and subject to change. See README "API source".
 *
 * Safety:
 *  - Only reads fixtures/markets/odds.
 *  - Only creates shareable booking codes via POST /orders/share, which is an
 *    anonymous, non-staking operation. This class has NO code path that
 *    places, submits, or stakes a wager.
 *  - Polite rate limiting (min interval + concurrency cap), exponential
 *    backoff for GET retries, request timeouts, short TTL caching.
 *  - Never auto-retries the booking POST.
 */
import { loadConfig, type AppConfig } from "./config.js";
import { logger } from "./logger.js";
import { flattenFixtures, normalizeBooking } from "./normalizers.js";
import type { RawBookingResponse, RawUpcomingResponse } from "./rawTypes.js";
import type { SportyBetBooking, SportyBetFixture, SportyBetSelection } from "./types.js";
import { DEFAULT_MARKET_IDS } from "./marketCatalogue.js";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class SportyBetError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly action?: string,
    public readonly retryable = false,
  ) {
    super(message);
    this.name = "SportyBetError";
  }
}

export interface FixturesRequest {
  marketIds?: string[];
  timelineHours?: number;
  pageSize?: number;
  maxPages?: number;
}

const SPORT_ID = "sr:sport:1";
const MAX_PAGE_SIZE = 100;
const MAX_PAGES = 5;
const DEFAULT_TIMELINE_HOURS = 720;

export class SportyBetClient {
  private lastRequestAt = 0;
  private inflight = 0;
  private readonly cache = new Map<string, { at: number; fixtures: SportyBetFixture[] }>();

  constructor(private readonly cfg: AppConfig = loadConfig()) {}

  private get baseUrl(): string {
    return `${this.cfg.apiBaseUrl}/api/${this.cfg.region}`;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = {
      Accept: "application/json",
      "Content-Type": "application/json",
      "Current-Country": this.cfg.region.toUpperCase(),
    };
    return h;
  }

  /** Token-bucket style pacing: min interval between requests + concurrency cap. */
  private async acquireSlot(): Promise<void> {
    for (;;) {
      const wait = this.lastRequestAt + this.cfg.minRequestIntervalMs - Date.now();
      if (this.inflight < this.cfg.maxConcurrentRequests && wait <= 0) {
        this.lastRequestAt = Date.now();
        this.inflight++;
        return;
      }
      await sleep(Math.max(wait, 25));
    }
  }

  private releaseSlot(): void {
    this.inflight--;
  }

  private async request<T>(
    path: string,
    init: RequestInit & { retry?: boolean } = {},
  ): Promise<T> {
    const { retry = true, ...rest } = init;
    const url = `${this.baseUrl}${path}`;
    const timeoutMs = this.cfg.timeoutMs;
    let attempts = 0;
    const maxAttempts = retry ? Math.max(1, this.cfg.maxRetries + 1) : 1;

    for (;;) {
      attempts++;
      await this.acquireSlot();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const started = Date.now();
      try {
        const res = await fetch(url, { ...rest, headers: this.headers(), signal: controller.signal });
        const text = await res.text();
        const latencyMs = Date.now() - started;

        let body: unknown = null;
        try {
          body = text ? JSON.parse(text) : null;
        } catch {
          body = null;
        }

        if (!res.ok) {
          const status = res.status;
          logger.warn({
            request: rest.method ?? "GET",
            status,
            latencyMs,
            retry: attempts < maxAttempts,
          });
          const retryable = status === 429 || status >= 500;
          if (retryable && attempts < maxAttempts) {
            await this.backoff(attempts, status);
            continue;
          }
          throw this.httpError(status, body);
        }

        logger.debug({ request: rest.method ?? "GET", status: res.status, latencyMs });
        if (body === null) {
          const errMsg = `SportyBet returned an empty or unparseable response (HTTP ${res.status}).`;
          if (retry && attempts < maxAttempts) {
            logger.warn({ message: errMsg, retry: true, latencyMs });
            await this.backoff(attempts, res.status);
            continue;
          }
          throw new SportyBetError("MALFORMED_RESPONSE", errMsg, "Try again later; the upstream API may be misbehaving.", true);
        }
        return body as T;
      } catch (err) {
        const latencyMs = Date.now() - started;
        if (err instanceof SportyBetError) throw err;
        if (err instanceof Error && err.name === "AbortError") {
          if (attempts < maxAttempts) {
            logger.warn({ message: `request timed out after ${timeoutMs}ms`, retry: true, latencyMs });
            await this.backoff(attempts, 0);
            continue;
          }
          throw new SportyBetError(
            "TIMEOUT",
            `SportyBet request timed out after ${timeoutMs}ms.`,
            "Check your network connection and try again.",
            true,
          );
        }
        const networkError = err instanceof Error ? err.message : String(err);
        if (attempts < maxAttempts) {
          logger.warn({ message: `network error: ${networkError}`, retry: true, latencyMs });
          await this.backoff(attempts, 0);
          continue;
        }
        throw new SportyBetError(
          "NETWORK",
          `Could not reach SportyBet: ${networkError}`,
          "Check your network connection and try again.",
          true,
        );
      } finally {
        clearTimeout(timer);
        this.releaseSlot();
      }
    }
  }

  private async backoff(attempt: number, status: number): Promise<void> {
    const base = 500 * 2 ** (attempt - 1);
    const jitter = Math.floor(Math.random() * 200);
    const wait = status === 429 ? base * 2 : base;
    logger.debug({ message: `backing off ${wait + jitter}ms (attempt ${attempt})` });
    await sleep(wait + jitter);
  }

  private httpError(status: number, body: unknown): SportyBetError {
    const message = this.messageFrom(body);
    switch (status) {
      case 400:
        return new SportyBetError("BAD_REQUEST", message ?? "SportyBet rejected the request (HTTP 400).", "Check the request parameters and retry.");
      case 401:
        return new SportyBetError("UNAUTHORIZED", message ?? "SportyBet requires authentication (HTTP 401).", "No credentials are configured for this server; check whether the endpoint now requires a key.");
      case 403:
        return new SportyBetError("FORBIDDEN", message ?? "SportyBet refused the request (HTTP 403).", "The endpoint may have changed or the region is blocked.");
      case 404:
        return new SportyBetError("NOT_FOUND", message ?? "SportyBet endpoint not found (HTTP 404).", "The API path may have changed; see README 'API source'.");
      case 429:
        return new SportyBetError("RATE_LIMITED", message ?? "SportyBet rate limit reached (HTTP 429).", "Wait a moment and retry with fewer requests.");
      default:
        return new SportyBetError("SERVER_ERROR", message ?? `SportyBet returned HTTP ${status}.`, "Retry later; if it persists the upstream API may be down.", true);
    }
  }

  private messageFrom(body: unknown): string | null {
    if (body && typeof body === "object") {
      const b = body as Record<string, unknown>;
      if (typeof b.message === "string") return b.message;
      if (typeof b.error === "string") return b.error;
    }
    return null;
  }

  private bizError(body: unknown): SportyBetError | null {
    if (body && typeof body === "object") {
      const b = body as Record<string, unknown>;
      const bizCode = Number(b.bizCode);
      if (bizCode && bizCode !== 10000) {
        const msg = typeof b.message === "string" ? b.message : `bizCode ${bizCode}`;
        return new SportyBetError("UPSTREAM", `SportyBet rejected the request: ${msg}`, "The request may be malformed or the fixture/market may no longer exist.");
      }
    }
    return null;
  }

  private cacheKey(marketIds: string[], page: number, timelineHours: number): string {
    return `${marketIds.join(",")}:${timelineHours}:${page}`;
  }

  private cacheGet(key: string): SportyBetFixture[] | null {
    const hit = this.cache.get(key);
    if (!hit) return null;
    if (Date.now() - hit.at > this.cfg.cacheTtlMs) {
      this.cache.delete(key);
      return null;
    }
    return hit.fixtures;
  }

  private cacheSet(key: string, fixtures: SportyBetFixture[]): void {
    this.cache.set(key, { at: Date.now(), fixtures });
  }

  /**
   * Fetch upcoming football fixtures, walking pages until the limit.
   * timelineHours controls how far ahead the catalogue reaches (hours).
   */
  async getFixtures(req: FixturesRequest = {}): Promise<SportyBetFixture[]> {
    const marketIds = req.marketIds?.length ? [...new Set(req.marketIds)] : DEFAULT_MARKET_IDS;
    const timelineHours = Math.max(12, Math.min(req.timelineHours ?? DEFAULT_TIMELINE_HOURS, 720));
    const pageSize = Math.min(Math.max(req.pageSize ?? MAX_PAGE_SIZE, 1), MAX_PAGE_SIZE);
    const maxPages = Math.min(req.maxPages ?? MAX_PAGES, 20);
    const all: SportyBetFixture[] = [];

    for (let page = 1; page <= maxPages; page++) {
      const key = this.cacheKey(marketIds, page, timelineHours);
      let fixtures = this.cacheGet(key);
      if (!fixtures) {
        const params = new URLSearchParams({
          sportId: SPORT_ID,
          marketId: marketIds.join(","),
          pageSize: String(pageSize),
          pageNum: String(page),
          todayGames: "false",
          timeline: String(timelineHours),
          _t: String(Date.now()),
        });
        const raw = await this.request<RawUpcomingResponse>(
          `/factsCenter/pcUpcomingEvents?${params.toString()}`,
        );
        const bizError = this.bizError(raw);
        if (bizError) throw bizError;
        fixtures = flattenFixtures(raw.data?.tournaments);
        this.cacheSet(key, fixtures);
      }
      all.push(...fixtures);
      if (fixtures.length === 0 || fixtures.length < pageSize) break;
    }
    return all;
  }

  /** Find a specific event by id. Returns null when the event is not in the upcoming catalogue. */
  async findEvent(eventId: string, marketIds?: string[]): Promise<SportyBetFixture | null> {
    const all = await this.getFixtures({ marketIds });
    return all.find((f) => f.eventId === eventId) ?? null;
  }

  /**
   * Create a shareable SportyBet booking code for the given selections.
   * This is an anonymous, NON-STAKING operation: it returns a share code but
   * does not place, submit, or stake any wager. POST is never auto-retried.
   */
  async createBooking(selections: SportyBetSelection[]): Promise<SportyBetBooking> {
    if (!selections.length) {
      throw new SportyBetError("EMPTY_SELECTION", "No selections provided.", "Provide at least one selection.");
    }
    const payload = {
      selections: selections.map((s) => ({
        eventId: s.eventId,
        marketId: s.marketId,
        specifier: s.specifier ?? null,
        outcomeId: s.outcomeId,
      })),
    };
    const raw = await this.request<RawBookingResponse>("/orders/share", {
      method: "POST",
      body: JSON.stringify(payload),
      retry: false,
    });
    const bizError = this.bizError(raw);
    if (bizError) throw bizError;
    if (!raw.data?.shareCode) {
      throw new SportyBetError(
        "NO_BOOKING_CODE",
        "SportyBet did not return a booking code.",
        "The selections may have changed (odds moved or market closed). Refresh and rebuild.",
      );
    }
    return normalizeBooking(raw.data);
  }

  /** Read an existing booking code. Read-only — never modifies a wager. */
  async getBooking(code: string): Promise<SportyBetBooking> {
    const clean = code.trim().toUpperCase();
    if (!/^[A-Z0-9]{4,12}$/.test(clean)) {
      throw new SportyBetError("INVALID_BOOKING_CODE", `"${code}" does not look like a SportyBet booking code.`, "Booking codes are 4-12 uppercase letters/digits.");
    }
    const raw = await this.request<RawBookingResponse>(`/orders/share/${encodeURIComponent(clean)}`);
    const bizError = this.bizError(raw);
    if (bizError) throw bizError;
    if (!raw.data?.shareCode) {
      throw new SportyBetError("BOOKING_NOT_FOUND", `Booking code ${clean} was not found or has expired.`, "Re-create the booking code or check the code spelling.");
    }
    return normalizeBooking(raw.data);
  }
}