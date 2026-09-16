// Retry policy. p-retry is ESM-only; we lazy-import it to keep CommonJS happy.

import { logger } from "../lib/logger";

const log = logger.child({ module: "worker.retry" });

export interface RetryOpts {
  retries?: number;
  minTimeoutMs?: number;
  maxTimeoutMs?: number;
  // Resource/operation label for logs.
  label?: string;
  // Predicate: return false to stop retrying immediately (e.g. auth errors).
  shouldRetry?: (err: unknown) => boolean;
}

const TRANSIENT_STATUS_CODES = new Set([408, 429, 500, 502, 503, 504]);

export function isTransient(err: unknown): boolean {
  if (!(err instanceof Error)) return true;
  const msg = err.message;
  // Shopify throttle / rate-limit signals
  if (/THROTTLED|MAX_COST_EXCEEDED|throttled/i.test(msg)) return true;
  if (/network|ECONN|ETIMEDOUT|fetch failed|socket hang up/i.test(msg)) return true;
  // PostgREST transient
  if (/connection reset|deadlock detected|tcp connection/i.test(msg)) return true;
  for (const code of TRANSIENT_STATUS_CODES) {
    if (msg.includes(String(code))) return true;
  }
  return false;
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOpts = {},
): Promise<T> {
  const { default: pRetry, AbortError } = await import("p-retry");
  const retries = opts.retries ?? 4;
  const label = opts.label ?? "op";
  return pRetry(
    async () => {
      try {
        return await fn();
      } catch (err) {
        const transient =
          opts.shouldRetry !== undefined ? opts.shouldRetry(err) : isTransient(err);
        if (!transient) {
          // Wrap as AbortError so p-retry stops immediately.
          throw new AbortError(err instanceof Error ? err : new Error(String(err)));
        }
        throw err;
      }
    },
    {
      retries,
      minTimeout: opts.minTimeoutMs ?? 500,
      maxTimeout: opts.maxTimeoutMs ?? 30000,
      randomize: true,
      onFailedAttempt: (e) => {
        const errAny = e as unknown as { message?: string; attemptNumber: number; retriesLeft: number };
        log.warn(
          { label, attempt: errAny.attemptNumber, retriesLeft: errAny.retriesLeft, err: errAny.message },
          "Retrying after transient failure",
        );
      },
    },
  );
}
