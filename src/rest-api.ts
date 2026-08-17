import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import createDebug from 'debug';
import { AuthenticationError, RestApiError } from './errors.js';
import type { FetchFn } from './webdriver-client.js';
import { USER_AGENT } from './version.js';

const debug = createDebug('testingbot:rest');

export interface TestingBotDevice {
  id: number;
  name: string;
  model_number?: string;
  platform_name: 'Android' | 'iOS';
  version: string | number;
  available?: boolean;
}

/** One row of GET /v1/browsers — for mobile rows, a virtual device+OS combo. */
export interface BrowserEntry {
  name?: string;
  platform?: string;
  platformName?: string; // "iOS" | "Android" for mobile rows
  deviceName?: string;
  version?: string | number; // OS version for mobile rows
}

export interface StorageEntry {
  app_url: string; // "tb://<appkey>"
  state?: 'PROCESSING' | 'DONE';
  type?: string;
  sim_only?: boolean;
  url?: string;
}

export interface TestUpdate {
  success?: boolean;
  name?: string;
  statusMessage?: string;
  build?: string;
  extra?: string;
  groups?: string[];
}

export interface TestDetails {
  id?: number | string;
  /** Signed S3 URL to the recording, or false when video was disabled. */
  video?: string | false;
  /** True once asset processing (video, logs, screenshots) has finished. */
  assets_available?: boolean;
  duration?: number;
  [key: string]: unknown;
}

/** Client for api.testingbot.com/v1 (HTTP Basic auth with key:secret). */
export class RestApiClient {
  private readonly apiUrl: string;
  private readonly auth: string;
  private readonly fetchFn: FetchFn;

  constructor(apiUrl: string, key: string, secret: string, fetchFn: FetchFn = fetch) {
    this.apiUrl = apiUrl.replace(/\/+$/, '');
    this.auth = 'Basic ' + Buffer.from(`${key}:${secret}`).toString('base64');
    this.fetchFn = fetchFn;
  }

  /** Validate credentials; used by prepare() to fail fast. */
  async getUser(): Promise<Record<string, unknown>> {
    return await this.request('GET', '/user') as Record<string, unknown>;
  }

  /** Physical devices. `available` restricts to currently-acquirable ones. */
  async getDevices(available: boolean): Promise<TestingBotDevice[]> {
    const path = available ? '/devices/available' : '/devices';
    const result = await this.request('GET', path);
    // The API historically wraps lists as {devices: [...]}; accept both.
    if (Array.isArray(result)) return result as TestingBotDevice[];
    const wrapped = (result as { devices?: TestingBotDevice[] }).devices;
    return wrapped ?? [];
  }

  /** Simulator/emulator (and desktop-browser) combos; mobile rows carry platformName + deviceName + OS version. */
  async getBrowsers(): Promise<BrowserEntry[]> {
    const result = await this.request('GET', '/browsers');
    if (Array.isArray(result)) return result as BrowserEntry[];
    return ((result as { browsers?: BrowserEntry[] }).browsers) ?? [];
  }

  async getDevice(id: string | number): Promise<TestingBotDevice> {
    const result = await this.request('GET', `/devices/${id}`);
    return ((result as { device?: TestingBotDevice }).device ?? result) as TestingBotDevice;
  }

  /** Upload an app binary; returns the storage entry with its tb:// URL. */
  async uploadApp(filePath: string): Promise<StorageEntry> {
    const data = await readFile(filePath);
    debug('uploading %s (%d bytes, sha256=%s)', filePath, data.length, sha256(data).slice(0, 12));
    const form = new FormData();
    form.append('file', new Blob([data]), basename(filePath));
    const response = await this.fetchFn(`${this.apiUrl}/storage`, {
      method: 'POST',
      headers: { Authorization: this.auth, 'User-Agent': USER_AGENT },
      body: form,
    });
    return await this.parse(response, 'POST /storage') as StorageEntry;
  }

  async getStorageEntry(appUrl: string): Promise<StorageEntry> {
    const appKey = appUrl.replace(/^tb:\/\//, '');
    return await this.request('GET', `/storage/${appKey}`) as StorageEntry;
  }

  /** Update a test by WebDriver session UUID (pass/fail, name, build, ...). */
  async updateTest(sessionId: string, update: TestUpdate): Promise<void> {
    const params = new URLSearchParams();
    if (update.success !== undefined) params.set('test[success]', update.success ? '1' : '0');
    if (update.name !== undefined) params.set('test[name]', update.name);
    if (update.statusMessage !== undefined) params.set('test[status_message]', update.statusMessage);
    if (update.build !== undefined) params.set('test[build]', update.build);
    if (update.extra !== undefined) params.set('test[extra]', update.extra);
    for (const group of update.groups ?? []) params.append('groups[]', group);
    await this.request('PUT', `/tests/${sessionId}`, params);
  }

  async getTest(sessionId: string): Promise<TestDetails> {
    return await this.request('GET', `/tests/${sessionId}`) as TestDetails;
  }

  /** Force-stop a running session (fallback when DELETE /session fails). */
  async stopTest(sessionId: string): Promise<void> {
    await this.request('PUT', `/tests/${sessionId}/stop`);
  }

  private async request(method: string, path: string, body?: URLSearchParams): Promise<unknown> {
    debug('%s %s', method, path);
    const response = await this.fetchFn(`${this.apiUrl}${path}`, {
      method,
      headers: {
        Authorization: this.auth,
        'User-Agent': USER_AGENT,
        ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
      },
      body,
      signal: AbortSignal.timeout(30_000),
    });
    return await this.parse(response, `${method} ${path}`);
  }

  private async parse(response: Response, context: string): Promise<unknown> {
    const text = await response.text();
    if (response.status === 401) {
      throw new AuthenticationError(
        `TestingBot rejected the credentials (${context}). Check TESTINGBOT_KEY and TESTINGBOT_SECRET.`,
      );
    }
    if (!response.ok) {
      throw new RestApiError(`${context} failed (HTTP ${response.status}): ${text.slice(0, 500)}`, response.status);
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new RestApiError(`${context} returned non-JSON: ${text.slice(0, 200)}`, response.status);
    }
  }
}

export function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}
