/**
 * Structured JSON logging to stderr.
 * stdout is reserved for the MCP stdio protocol — never log there.
 * Logs NEVER contain passwords, OTPs, tokens, API keys, or payment data
 * because this server never accepts or stores such values.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogFields {
  tool?: string;
  requestId?: string;
  success?: boolean;
  latencyMs?: number;
  status?: number;
  eventId?: string;
  bookingCode?: string;
  errorCode?: string;
  message?: string;
  [key: string]: unknown;
}

const MIN_LEVEL: LogLevel = (process.env.SPORTYBET_LOG_LEVEL as LogLevel) || "info";
const ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

export function log(level: LogLevel, fields: LogFields = {}): void {
  if (ORDER[level] < ORDER[MIN_LEVEL]) return;
  const entry = { ts: new Date().toISOString(), level, ...fields };
  process.stderr.write(JSON.stringify(entry) + "\n");
}

export const logger = {
  debug: (f: LogFields = {}) => log("debug", f),
  info: (f: LogFields = {}) => log("info", f),
  warn: (f: LogFields = {}) => log("warn", f),
  error: (f: LogFields = {}) => log("error", f),
};