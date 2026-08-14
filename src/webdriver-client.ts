import createDebug from 'debug';
import { WebDriverError } from './errors.js';
import { USER_AGENT } from './version.js';

const debug = createDebug('testingbot:webdriver');

export type FetchFn = typeof fetch;

export interface NewSessionResult {
  sessionId: string;
  capabilities: Record<string, unknown>;
}

interface CommandOptions {
  /** Overrides the client's default per-command timeout. */
  timeout?: number;
  signal?: AbortSignal;
}

/**
 * Minimal fetch-based W3C WebDriver / Appium client. Deliberately not a
 * full client library: only the commands the driver needs, with uniform
 * timeout, abort, and error mapping.
 */
export class WebDriverClient {
  private readonly hubUrl: string;
  private readonly commandTimeout: number;
  private readonly fetchFn: FetchFn;

  constructor(hubUrl: string, commandTimeout: number, fetchFn: FetchFn = fetch) {
    this.hubUrl = hubUrl.replace(/\/+$/, '');
    this.commandTimeout = commandTimeout;
    this.fetchFn = fetchFn;
  }

  /**
   * POST /session. Exempt from the per-command timeout — device allocation
   * can queue for minutes; the caller bounds it via `opts.timeout`/`signal`.
   */
  async newSession(
    capabilities: { alwaysMatch: Record<string, unknown>; firstMatch: Record<string, unknown>[] },
    opts: CommandOptions = {},
  ): Promise<NewSessionResult> {
    const value = await this.request('POST', '/session', { capabilities }, opts) as {
      sessionId?: string;
      capabilities?: Record<string, unknown>;
    };
    const sessionId = value.sessionId;
    if (!sessionId) {
      throw new WebDriverError('session not created', 'hub response did not include a sessionId', 200);
    }
    return { sessionId, capabilities: value.capabilities ?? {} };
  }

  async deleteSession(sessionId: string, opts: CommandOptions = {}): Promise<void> {
    await this.request('DELETE', `/session/${sessionId}`, undefined, opts);
  }

  async get<T = unknown>(sessionId: string, path: string, opts: CommandOptions = {}): Promise<T> {
    return await this.request('GET', `/session/${sessionId}${path}`, undefined, opts) as T;
  }

  async post<T = unknown>(sessionId: string, path: string, body: unknown, opts: CommandOptions = {}): Promise<T> {
    return await this.request('POST', `/session/${sessionId}${path}`, body ?? {}, opts) as T;
  }

  /** Execute a script — used for Appium `mobile:` extension commands. */
  async execute<T = unknown>(sessionId: string, script: string, args: unknown[] = [], opts: CommandOptions = {}): Promise<T> {
    return await this.post<T>(sessionId, '/execute/sync', { script, args }, opts);
  }

  async performActions(sessionId: string, actions: unknown[], opts: CommandOptions = {}): Promise<void> {
    await this.post(sessionId, '/actions', { actions }, opts);
  }

  async releaseActions(sessionId: string, opts: CommandOptions = {}): Promise<void> {
    await this.request('DELETE', `/session/${sessionId}/actions`, undefined, opts);
  }

  /** Screenshot as a base64 PNG string. */
  async screenshot(sessionId: string, opts: CommandOptions = {}): Promise<string> {
    return await this.get<string>(sessionId, '/screenshot', opts);
  }

  /** Page source (Appium XML hierarchy). */
  async source(sessionId: string, opts: CommandOptions = {}): Promise<string> {
    return await this.get<string>(sessionId, '/source', opts);
  }

  private async request(
    method: string,
    path: string,
    body: unknown,
    opts: CommandOptions,
  ): Promise<unknown> {
    const url = `${this.hubUrl}${path}`;
    const timeout = opts.timeout ?? this.commandTimeout;
    const signal = opts.signal
      ? combineSignals(AbortSignal.timeout(timeout), opts.signal)
      : AbortSignal.timeout(timeout);

    debug('%s %s', method, path);
    let response: Response;
    try {
      response = await this.fetchFn(url, {
        method,
        headers: { 'Content-Type': 'application/json; charset=utf-8', 'User-Agent': USER_AGENT },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal,
      });
    } catch (err) {
      if (err instanceof Error && err.name === 'TimeoutError') {
        throw new WebDriverError('timeout', `${method} ${path} timed out after ${timeout}ms`, 0);
      }
      throw err;
    }

    let payload: { value?: unknown };
    const text = await response.text();
    try {
      payload = JSON.parse(text) as { value?: unknown };
    } catch {
      throw new WebDriverError(
        'invalid response',
        `${method} ${path} returned non-JSON (HTTP ${response.status}): ${text.slice(0, 500)}`,
        response.status,
      );
    }

    if (!response.ok) {
      const value = payload.value as { error?: string; message?: string } | undefined;
      throw new WebDriverError(
        value?.error ?? `http ${response.status}`,
        value?.message ?? text.slice(0, 500),
        response.status,
      );
    }
    return payload.value;
  }
}

/** AbortSignal.any with a fallback for Node 18/20.0-20.2 (added in 20.3). */
function combineSignals(a: AbortSignal, b: AbortSignal): AbortSignal {
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([a, b]);
  if (a.aborted) return a;
  if (b.aborted) return b;
  const controller = new AbortController();
  const onAbort = function (this: AbortSignal) { controller.abort(this.reason); };
  a.addEventListener('abort', onAbort, { once: true });
  b.addEventListener('abort', onAbort, { once: true });
  return controller.signal;
}
