import { deflateSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TestingBotDriver } from '../../src/driver.js';
import { pngSize } from '../../src/png.js';
import { FakeHub } from '../fake-hub/fake-hub.js';

/** Solid RGBA PNG of the given pixel size (CRCs zeroed; the driver never checks them). */
function solidPng(width: number, height: number): Buffer {
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 4, 0x7f)]);
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    return Buffer.concat([len, Buffer.from(type, 'latin1'), data, Buffer.alloc(4)]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.concat(Array(height).fill(row)))), chunk('IEND', Buffer.alloc(0)),
  ]);
}

describe('driver features against FakeHub', () => {
  let hub: FakeHub;
  const options = (extra: Record<string, unknown> = {}) => ({
    key: 'k', secret: 's', hubUrl: hub.hubUrl, apiUrl: hub.apiUrl,
    allocationTimeout: 5_000, commandTimeout: 2_000,
    apps: { ios: 'tb://ios', android: 'tb://android' } as const,
    ...extra,
  });

  beforeEach(async () => {
    hub = new FakeHub();
    await hub.start();
  });
  afterEach(async () => {
    await hub.stop();
  });

  async function connected(platform: 'ios' | 'android', extra: Record<string, unknown> = {}) {
    const driver = new TestingBotDriver(options(extra));
    await driver.prepare();
    const allocated = await driver.allocate({ platform }, new Set());
    await driver.connect({ platform, deviceId: allocated.deviceId });
    return { driver, sessionId: allocated.deviceId };
  }

  const settingsCalls = () => hub.requests.filter((r) => r.path.endsWith('/appium/settings'));

  it('applies per-platform snapshot tuning once at allocation', async () => {
    await connected('ios');
    await connected('android', { snapshotTuning: { snapshotMaxDepth: 40 } });
    expect(settingsCalls().map((r) => r.body)).toEqual([
      { settings: { waitForIdleTimeout: 0, animationCoolOffTimeout: 0 } },
      { settings: { waitForIdleTimeout: 0, snapshotMaxDepth: 40 } },
    ]);
  });

  it('skips snapshot tuning when disabled', async () => {
    await connected('ios', { snapshotTuning: false });
    expect(settingsCalls()).toHaveLength(0);
  });

  it('crops screenshot({ clip }) from points to pixels using the screen scale', async () => {
    hub.screenshotPng = solidPng(393 * 3, 852 * 3); // /window/rect is 393x852 → scale 3
    const { driver } = await connected('ios');
    const element = await driver.screenshot({ clip: { x: 10, y: 20, width: 100, height: 50 } } as never);
    expect(pngSize(element)).toEqual({ width: 300, height: 150 });
    const half = await driver.screenshot({ scale: 0.5 } as never);
    expect(pngSize(half)).toEqual({ width: 590, height: 1278 });
  });

  it('turns BACK on iOS into a left-edge swipe', async () => {
    const { driver } = await connected('ios');
    await driver.pressButton('BACK');
    const actions = hub.requests.filter((r) => r.path.endsWith('/actions')).at(-1)!.body as {
      actions: { actions: { type: string; x?: number }[] }[];
    };
    const moves = actions.actions[0]!.actions.filter((a) => a.type === 'pointerMove');
    expect(moves[0]!.x).toBeLessThanOrEqual(5);
    expect(moves.at(-1)!.x).toBeGreaterThan(393 / 2);
  });

  it('clears the focused iOS field through its element reference', async () => {
    hub.activeElementId = 'el-42';
    const { driver } = await connected('ios');
    await driver.fill('hello');
    const paths = hub.requests.map((r) => `${r.method} ${r.path.replace(/^\/wd\/hub\/session\/[^/]+/, '')}`);
    expect(paths).toContain('GET /element/active');
    expect(paths).toContain('POST /element/el-42/clear');
  });

  it('falls back to backspaces when there is no active element', async () => {
    const { driver } = await connected('ios');
    await driver.clearText();
    expect(hub.requests.some((r) => r.path.endsWith('/clear'))).toBe(false);
    expect(hub.requests.some((r) => r.path.endsWith('/actions'))).toBe(true);
  });

  it("judges visibility by bounds with visibility: 'bounds'", async () => {
    const { driver: native } = await connected('ios');
    const { driver: bounds } = await connected('ios', { visibility: 'bounds' });
    const flat = (nodes: { isVisible: boolean; bounds: { width: number; height: number }; children: never[] }[]): typeof nodes =>
      nodes.flatMap((n) => [n, ...flat(n.children)]);
    const n = flat((await native.getViewHierarchy()) as never);
    const b = flat((await bounds.getViewHierarchy()) as never);
    b.forEach((node) => expect(node.isVisible).toBe(node.bounds.width > 0 && node.bounds.height > 0));
    expect(n.length).toBe(b.length);
    // The fixture's "Offscreen" label is visible="false" but has a frame.
    const idx = n.findIndex((node) => (node as { label?: string }).label === 'Offscreen');
    expect(n[idx]!.isVisible).toBe(false);
    expect(b[idx]!.isVisible).toBe(true);
  });
});
