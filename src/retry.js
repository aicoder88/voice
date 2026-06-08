// @ts-check
// Small retry helper for the HTTP-based API calls (the LLM cleanup pass and the
// local whisper-server POST). A single transient hiccup — a 429 rate-limit, a
// 5xx, a dropped connection — would otherwise turn a good dictation into a
// failed one; one quick retry recovers most of them invisibly.
//
// NOT used for the streaming WebSocket providers (OpenAI Realtime, Deepgram): a
// mid-stream retry there risks transcribing the same audio twice, so those keep
// their existing save-the-recording-and-surface-an-error recovery instead.

/** HTTP statuses worth retrying: request timeout, rate limit, and 5xx. */
export function isRetryableHttpStatus(status) {
  return status === 408 || status === 429 || (status >= 500 && status <= 599);
}

/** Network-level errors worth retrying (connection reset / refused / DNS / generic fetch failure). */
export function isRetryableError(err) {
  if (!err) return false;
  if (err instanceof RetryableHttpError) return true;
  const code = err.code || (err.cause && err.cause.code);
  if (code && /ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|EPIPE/.test(code)) return true;
  // Undici throws a bare TypeError("fetch failed") with the real cause nested.
  return err.name === "TypeError" && /fetch failed/i.test(err.message || "");
}

/**
 * Run `fn`, retrying up to `retries` times when it throws a retryable error.
 * `fn` receives the 0-based attempt number. A non-retryable error (or running
 * out of attempts) rethrows the last error unchanged.
 *
 * @template T
 * @param {(attempt: number) => Promise<T>} fn
 * @param {{ retries?: number, delayMs?: number, isRetryable?: (err: unknown) => boolean, onRetry?: (err: unknown, attempt: number) => void, sleep?: (ms: number) => Promise<void> }} [opts]
 * @returns {Promise<T>}
 */
export async function withRetry(fn, opts = {}) {
  const {
    retries = 1,
    delayMs = 300,
    isRetryable = isRetryableError,
    onRetry,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  } = opts;
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastError = err;
      if (attempt >= retries || !isRetryable(err)) throw err;
      if (onRetry) onRetry(err, attempt);
      // Linear backoff is plenty for a single retry; keeps total added latency
      // bounded and predictable for the user waiting on their transcript.
      await sleep(delayMs * (attempt + 1));
    }
  }
  throw lastError;
}

/**
 * Sentinel error so a fetch wrapper can signal "the HTTP response itself is
 * retryable" (a 429/5xx) to withRetry, distinct from a network throw.
 */
export class RetryableHttpError extends Error {
  /** @param {number} status @param {string} [body] */
  constructor(status, body = "") {
    super(`HTTP ${status}`);
    this.name = "RetryableHttpError";
    this.status = status;
    this.body = body;
  }
}

/** A non-retryable HTTP failure (a clean 4xx) — carries the status for logging. */
export class HttpError extends Error {
  /** @param {number} status @param {string} [body] */
  constructor(status, body = "") {
    super(`HTTP ${status}`);
    this.name = "HttpError";
    this.status = status;
    this.body = body;
  }
}

/**
 * Build the right error for a non-OK HTTP response: a RetryableHttpError for a
 * 429/5xx (withRetry will retry it), a plain HttpError otherwise (it won't).
 * @param {number} status @param {string} [body]
 */
export function httpError(status, body = "") {
  return isRetryableHttpStatus(status) ? new RetryableHttpError(status, body) : new HttpError(status, body);
}
