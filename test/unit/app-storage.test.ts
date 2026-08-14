import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { AppStorage } from '../../src/app-storage.js';
import type { RestApiClient } from '../../src/rest-api.js';

function zipFixture(name: string, content = 'payload'): string {
  const path = join(tmpdir(), name);
  writeFileSync(path, Buffer.concat([Buffer.from('PK\x03\x04'), Buffer.from(content)]));
  return path;
}

function fakeApi(entry: Record<string, unknown>) {
  return {
    uploadApp: vi.fn(async () => ({ app_url: 'tb://abc', state: 'DONE', ...entry })),
    getStorageEntry: vi.fn(async () => ({ app_url: 'tb://abc', state: 'DONE', ...entry })),
  } as unknown as RestApiClient & { uploadApp: ReturnType<typeof vi.fn> };
}

describe('AppStorage', () => {
  it('rejects files that are not ZIP containers', async () => {
    const path = join(tmpdir(), 'not-an-app.txt');
    writeFileSync(path, 'just text');
    const storage = new AppStorage(fakeApi({}));
    await expect(storage.ensureUploaded(path, undefined)).rejects.toThrow(/does not look like an app package/);
  });

  it('uploads once per content hash across repeated installs', async () => {
    const api = fakeApi({});
    const storage = new AppStorage(api);
    const path = zipFixture('app-a.zip');
    await storage.ensureUploaded(path, 'simulator');
    await storage.ensureUploaded(path, 'simulator');
    expect(api.uploadApp).toHaveBeenCalledTimes(1);
  });

  it('blocks simulator-only builds on real devices with an actionable message', async () => {
    const storage = new AppStorage(fakeApi({ sim_only: true }));
    const path = zipFixture('app-sim.zip', 'sim-build');
    await expect(storage.ensureUploaded(path, 'real')).rejects.toThrow(/simulator-only build/);
    // ...but allows it on simulators.
    await expect(storage.ensureUploaded(path, 'simulator')).resolves.toMatchObject({ app_url: 'tb://abc' });
  });
});
