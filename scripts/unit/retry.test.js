// Unit tests for the retry helper.
// Run: node --test scripts/unit/retry.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  withRetry,
  isRetryableHttpStatus,
  isRetryableError,
  httpError,
  RetryableHttpError,
  HttpError
} from "../../src/retry.js";

const noSleep = () => Promise.resolve();

test("isRetryableHttpStatus: 408/429/5xx yes, 4xx no", () => {
  for (const s of [408, 429, 500, 502, 503, 504]) assert.equal(isRetryableHttpStatus(s), true, String(s));
  for (const s of [400, 401, 403, 404, 200]) assert.equal(isRetryableHttpStatus(s), false, String(s));
});

test("isRetryableError: network codes and fetch-failed are retryable", () => {
  assert.equal(isRetryableError({ code: "ECONNRESET" }), true);
  assert.equal(isRetryableError({ cause: { code: "ETIMEDOUT" } }), true);
  const te = new TypeError("fetch failed");
  assert.equal(isRetryableError(te), true);
  assert.equal(isRetryableError(new Error("nope")), false);
  assert.equal(isRetryableError(null), false);
});

test("httpError: retryable status → RetryableHttpError, else HttpError", () => {
  assert.ok(httpError(503) instanceof RetryableHttpError);
  assert.ok(httpError(400) instanceof HttpError);
  assert.equal(httpError(400).status, 400);
});

test("withRetry: succeeds first try, no retry", async () => {
  let calls = 0;
  const out = await withRetry(async () => { calls++; return "ok"; }, { sleep: noSleep });
  assert.equal(out, "ok");
  assert.equal(calls, 1);
});

test("withRetry: retries a retryable error then succeeds", async () => {
  let calls = 0;
  const out = await withRetry(
    async () => { calls++; if (calls === 1) throw httpError(429); return "ok"; },
    { retries: 1, sleep: noSleep }
  );
  assert.equal(out, "ok");
  assert.equal(calls, 2);
});

test("withRetry: does NOT retry a non-retryable error", async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(async () => { calls++; throw httpError(400); }, { retries: 2, sleep: noSleep }),
    (err) => err instanceof HttpError && err.status === 400
  );
  assert.equal(calls, 1);
});

test("withRetry: gives up after exhausting retries and rethrows last", async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(async () => { calls++; throw httpError(500); }, { retries: 2, sleep: noSleep }),
    (err) => err instanceof RetryableHttpError && err.status === 500
  );
  assert.equal(calls, 3); // initial + 2 retries
});

test("withRetry: onRetry fires once per retry with the attempt index", async () => {
  const seen = [];
  await withRetry(
    async () => { if (seen.length < 1) throw httpError(503); return "ok"; },
    { retries: 1, sleep: noSleep, onRetry: (_e, attempt) => seen.push(attempt) }
  );
  assert.deepEqual(seen, [0]);
});

test("withRetry: an AbortError (timeout) is not retried by default", async () => {
  let calls = 0;
  const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
  await assert.rejects(
    withRetry(async () => { calls++; throw abort; }, { retries: 2, sleep: noSleep })
  );
  assert.equal(calls, 1);
});
