import createDebug from 'debug';
import { WebDriverError } from './errors.js';
import type { WebDriverClient } from './webdriver-client.js';

const debug = createDebug('testingbot:keepalive');

const PING_INTERVAL_MS = 45_000;
const MAX_CONSECUTIVE_FAILURES = 3;

/**
 * Pings live sessions so TestingBot's idle reaper doesn't kill pooled slots:
 * a slot idles between allocate() and the first worker command, and between
 * tests when the pool re-grants it. Pings hit the hub (not the rate-limited
 * REST API) via a cheap read-only command.
 */
export class Keepalive {
  private readonly client: WebDriverClient;
  private readonly timers = new Map<string, NodeJS.Timeout>();

  constructor(client: WebDriverClient) {
    this.client = client;
  }

  start(sessionId: string): void {
    if (this.timers.has(sessionId)) return;
    let failures = 0;
    const timer = setInterval(() => {
      this.client.get(sessionId, '/orientation', { timeout: 15_000 }).then(
        () => { failures = 0; },
        (err) => {
          // Stop immediately when the session is definitively gone; tolerate
          // transient failures (timeouts, network blips) so one hiccup does
          // not leave a live session unprotected from the idle reaper.
          const gone = err instanceof WebDriverError && (err.httpStatus === 404 || err.error === 'invalid session id');
          failures += 1;
          if (gone || failures >= MAX_CONSECUTIVE_FAILURES) {
            debug('ping failed for %s (%s), stopping keepalive: %s', sessionId, gone ? 'session gone' : 'repeated failures', err);
            this.stop(sessionId);
          } else {
            debug('transient ping failure %d/%d for %s: %s', failures, MAX_CONSECUTIVE_FAILURES, sessionId, err);
          }
        },
      );
    }, PING_INTERVAL_MS);
    timer.unref?.();
    this.timers.set(sessionId, timer);
    debug('started for %s', sessionId);
  }

  stop(sessionId: string): void {
    const timer = this.timers.get(sessionId);
    if (timer) {
      clearInterval(timer);
      this.timers.delete(sessionId);
      debug('stopped for %s', sessionId);
    }
  }

  stopAll(): void {
    for (const sessionId of [...this.timers.keys()]) this.stop(sessionId);
  }
}
