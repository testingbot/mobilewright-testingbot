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

// Hub messages that indicate a temporary shortage rather than a permanent
// failure. TestingBot has no machine-readable "no device available" code yet,
// so classification rests on these patterns (fixtures captured from the live
// hub should extend this list).
const RETRIABLE_PATTERNS = [
  /no.{0,20}devices?.{0,20}(available|found)/i,
  /all.{0,20}devices?.{0,20}(busy|in use)/i,
  /device.{0,20}(busy|unavailable|in use)/i,
  /queue/i,
  /concurren/i, // "concurrency limit", "too many concurrent sessions"
  /maximum number of.{0,20}(sessions|tests)/i,
  /session limit/i,
  /timed? ?out waiting for/i,
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
  const message = err instanceof Error ? err.message : String(err);
  if (RETRIABLE_PATTERNS.some((re) => re.test(message))) {
    return new NoDeviceAvailableError(message);
  }
  return err instanceof Error ? err : new Error(message);
}
