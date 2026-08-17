import { NoDeviceAvailableError } from '@mobilewright/protocol';

export { NoDeviceAvailableError };

/** Base class for all errors raised by this driver. */
export class TestingBotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TestingBotError';
  }
}

/** Credentials missing or rejected by TestingBot. */
export class AuthenticationError extends TestingBotError {
  constructor(message: string) {
    super(message);
    this.name = 'AuthenticationError';
  }
}

/** A session method was called before connect() (or after disconnect). */
export class SessionNotActiveError extends TestingBotError {
  constructor() {
    super('No active session. Call connect() first.');
    this.name = 'SessionNotActiveError';
  }
}

/** A WebDriver command returned an error response. */
export class WebDriverError extends TestingBotError {
  /** W3C error code, e.g. "invalid session id", "unknown error". */
  readonly error: string;
  readonly httpStatus: number;

  constructor(error: string, message: string, httpStatus: number) {
    // The hub sometimes puts identical text in both fields — don't double it.
    super(!message || message === error ? (message || error) : `${error}: ${message}`);
    this.name = 'WebDriverError';
    this.error = error;
    this.httpStatus = httpStatus;
  }
}

/** A TestingBot REST API call failed. */
export class RestApiError extends TestingBotError {
  readonly httpStatus: number;

  constructor(message: string, httpStatus: number) {
    super(message);
    this.name = 'RestApiError';
    this.httpStatus = httpStatus;
  }
}

// The hub has no structured error type — every failure path returns a string
// (its own analytics.js classifies faults by these exact substrings, which
// makes this list canonical). Retriable = temporary shortage or contention;
// everything else (bad capabilities, unknown browserName, ...) is permanent.
const RETRIABLE_PATTERNS = [
  /Waited too long for job to start/i,    // hub queue TTL (390s) expired (WebDriverError prefixes the code, so no ^ anchor)
  /unable to fulfill your request/i,      // no node currently matches (capacity)
  /device is currently in use/i,          // pinned real device busy
  /experiencing high load/i,
  /Could not acquire processing lock/i,
  /temporarily busy/i,
  // Plan concurrency/queue-depth cap ("... maximum allowed parallel + queued
  // tests for your TestingBot plan"): retriable — the pool re-queues the
  // waiter and serves it from a freed slot at the next test boundary.
  /limit of the maximum allowed parallel/i,
];

/**
 * Convert an allocation-time failure into `NoDeviceAvailableError` when it is
 * temporary (device shortage, concurrency limit) so the mobilewright device
 * pool re-queues instead of failing the run. The pool detects it with
 * `instanceof` against `@mobilewright/protocol` — which is why this package
 * declares protocol as a peerDependency and re-throws the protocol class.
 */
export function toAllocationError(err: unknown): Error {
  if (err instanceof NoDeviceAvailableError) return err;
  // Client-side allocationTimeout expiry while the hub still queues the
  // request: aborting the socket dropped the queue entry, and retrying later
  // is exactly right.
  if (err instanceof WebDriverError && err.error === 'timeout') {
    return new NoDeviceAvailableError(err.message);
  }
  const message = err instanceof Error ? err.message : String(err);
  if (RETRIABLE_PATTERNS.some((re) => re.test(message))) {
    return new NoDeviceAvailableError(message);
  }
  return err instanceof Error ? err : new Error(message);
}

// Actionable hints for known permanent hub failures, keyed by message pattern.
const ALLOCATION_HINTS: [RegExp, string][] = [
  [/Unknown browserName|we only serve/i,
    "Make sure the app under test is declared via the driver's `apps` option — TestingBot sessions must start with an app or a browser."],
  [/signature|provision|codesign|entitlement/i,
    'Real iOS devices need a test-signed .ipa; simulator builds and unsigned archives cannot be installed on physical hardware.'],
  [/appium.*version|version.*not supported/i,
    'Pin a known-good version with the `appiumVersion` option (e.g. "latest" or "2.0").'],
  [/invalid.*capabilit/i,
    'Check the `capabilities` / `tbOptions` escape hatches for typos — they are merged into the session request as-is.'],
];

/**
 * Wrap a permanent allocation failure with the criteria being allocated and
 * an actionable hint when the hub message matches a known cause. Retriable
 * errors pass through untouched — the pool needs the exact class.
 */
export function withAllocationContext(err: Error, criteriaDescription: string): Error {
  if (err instanceof NoDeviceAvailableError) return err;
  const hint = ALLOCATION_HINTS.find(([re]) => re.test(err.message))?.[1];
  const wrapped = new Error(
    `TestingBot could not start a session for ${criteriaDescription}: ${err.message}` +
    (hint ? `\nHint: ${hint}` : ''),
  );
  wrapped.cause = err;
  return wrapped;
}
