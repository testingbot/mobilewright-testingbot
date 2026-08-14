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
    super(message ? `${error}: ${message}` : error);
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
