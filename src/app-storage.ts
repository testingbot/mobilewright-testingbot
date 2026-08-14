import { readFile } from 'node:fs/promises';
import createDebug from 'debug';
import type { DeviceType } from '@mobilewright/protocol';
import { sha256, type RestApiClient, type StorageEntry } from './rest-api.js';

const debug = createDebug('testingbot:storage');

const PROCESSING_POLL_MS = 2_000;
const PROCESSING_TIMEOUT_MS = 120_000;

/**
 * Uploads app binaries to TestingBot storage and caches by content hash so
 * a run's many install calls (one per pooled slot) upload each binary once.
 */
export class AppStorage {
  private readonly api: RestApiClient;
  /** sha256 of file contents -> settled storage entry. */
  private readonly uploads = new Map<string, Promise<StorageEntry>>();

  constructor(api: RestApiClient) {
    this.api = api;
  }

  /**
   * Upload (or reuse) the app at `path` and return its tb:// URL, validated
   * against the target device type (a simulator-only iOS build cannot install
   * on a real device and vice versa is likely a signing problem).
   */
  async ensureUploaded(path: string, targetType: DeviceType | undefined): Promise<StorageEntry> {
    const data = await readFile(path);
    if (data.length < 4 || data.readUInt16BE(0) !== 0x504b) {
      // .ipa, .apk and .zip are all ZIP containers ("PK").
      throw new Error(
        `TestingBotDriver: "${path}" does not look like an app package (.apk/.ipa/.zip expected).`,
      );
    }
    const hash = sha256(data);
    let pending = this.uploads.get(hash);
    if (!pending) {
      pending = this.uploadAndAwait(path);
      this.uploads.set(hash, pending);
      pending.catch(() => this.uploads.delete(hash)); // allow retry after failure
    }
    const entry = await pending;

    if (entry.sim_only && targetType === 'real') {
      throw new Error(
        `TestingBotDriver: "${path}" is a simulator-only build and cannot be installed on a real device. ` +
        'Build a device .ipa (and make sure it is test-signed) for deviceType: "real" projects.',
      );
    }
    return entry;
  }

  private async uploadAndAwait(path: string): Promise<StorageEntry> {
    // POST /storage answers with only {app_url}; state/url/sim_only exist
    // only on GET /storage/{appkey}, so metadata always comes from polling.
    const uploaded = await this.api.uploadApp(path);
    debug('uploaded %s -> %s', path, uploaded.app_url);

    const deadline = Date.now() + PROCESSING_TIMEOUT_MS;
    let entry: StorageEntry | undefined;
    for (; ;) {
      try {
        entry = await this.api.getStorageEntry(uploaded.app_url);
      } catch (err) {
        debug('GET storage entry failed: %s', err);
      }
      if (entry && entry.state !== 'PROCESSING') break;
      if (Date.now() >= deadline) {
        debug('storage entry %s not DONE after %dms, proceeding anyway', uploaded.app_url, PROCESSING_TIMEOUT_MS);
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, PROCESSING_POLL_MS));
    }
    return { ...entry, app_url: entry?.app_url ?? uploaded.app_url };
  }
}
