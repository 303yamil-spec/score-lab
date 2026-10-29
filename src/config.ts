import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface AppConfig {
  region: string;
  apiBaseUrl: string;
  timeoutMs: number;
  apiKey: string | null;
  minRequestIntervalMs: number;
  maxConcurrentRequests: number;
  maxRetries: number;
  cacheTtlMs: number;
  tzOffsetMinutes: number;
}

const DEFAULTS = {
  SPORTYBET_REGION: "ng",
  SPORTYBET_API_BASE_URL: "https://www.sportybet.com",
  SPORTYBET_TIMEOUT_MS: "15000",
  SPORTYBET_API_KEY: "",
  SPORTYBET_MIN_INTERVAL_MS: "250",
  SPORTYBET_MAX_CONCURRENCY: "4",
  SPORTYBET_MAX_RETRIES: "3",
  SPORTYBET_CACHE_TTL_MS: "90000",
  SPORTYBET_TZ_OFFSET_MIN: "60",
};

function num(value: string | undefined, fallback: string): number {
  const n = Number(value ?? fallback);
  return Number.isFinite(n) ? n : Number(fallback);
}

function tryLoadDotEnv(): void {
  const candidates = [
    resolve(process.cwd(), ".env"),
    resolve(dirname(fileURLToPath(import.meta.url)), "..", ".env"),
  ];
  for (const file of candidates) {
    try {
      const content = readFileSync(file, "utf8");
      for (const line of content.split(/\r?\n/)) {
        const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
        if (!m || line.trim().startsWith("#")) continue;
        const value = m[2]!.replace(/^["']|["']$/g, "");
        if (process.env[m[1]!] === undefined) process.env[m[1]!] = value;
      }
      return;
    } catch {
      /* no .env in this location */
    }
  }
}

tryLoadDotEnv();

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return {
    region: (env.SPORTYBET_REGION ?? DEFAULTS.SPORTYBET_REGION).toLowerCase().trim() || "ng",
    apiBaseUrl: (env.SPORTYBET_API_BASE_URL ?? DEFAULTS.SPORTYBET_API_BASE_URL).replace(/\/+$/, ""),
    timeoutMs: num(env.SPORTYBET_TIMEOUT_MS, DEFAULTS.SPORTYBET_TIMEOUT_MS),
    apiKey: (env.SPORTYBET_API_KEY ?? "").trim() || null,
    minRequestIntervalMs: num(env.SPORTYBET_MIN_INTERVAL_MS, DEFAULTS.SPORTYBET_MIN_INTERVAL_MS),
    maxConcurrentRequests: num(env.SPORTYBET_MAX_CONCURRENCY, DEFAULTS.SPORTYBET_MAX_CONCURRENCY),
    maxRetries: num(env.SPORTYBET_MAX_RETRIES, DEFAULTS.SPORTYBET_MAX_RETRIES),
    cacheTtlMs: num(env.SPORTYBET_CACHE_TTL_MS, DEFAULTS.SPORTYBET_CACHE_TTL_MS),
    tzOffsetMinutes: num(env.SPORTYBET_TZ_OFFSET_MIN, DEFAULTS.SPORTYBET_TZ_OFFSET_MIN),
  };
}