import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TestingBotDriver } from '../../src/driver.js';
import { FakeHub } from '../fake-hub/fake-hub.js';

/**
 * `fill` and `clearAppData` arrived with protocol 0.0.67; pin which Appium
 * commands they turn into.
 */
describe('fill and clearAppData against FakeHub', () => {
  let hub: FakeHub;
  let driver: TestingBotDriver;

  const driverOptions = () => ({
    key: 'k',
    secret: 's',
    hubUrl: hub.hubUrl,
    apiUrl: hub.apiUrl,
    allocationTimeout: 5_000,
    commandTimeout: 2_000,
    apps: { ios: 'tb://prebuilt-ios', android: 'tb://prebuilt-android' } as const,
  });

  const executed = () => hub.requests
    .filter((r) => r.path.endsWith('/execute/sync'))
    .map((r) => r.body as { script: string; args: unknown[] });

  const connectAndroid = async () => {
    await driver.prepare();
    const allocated = await driver.allocate({ platform: 'android', deviceType: 'emulator' }, new Set());
    await driver.connect({ platform: 'android', deviceId: allocated.deviceId });
  };

  beforeEach(async () => {
    hub = new FakeHub();
    await hub.start();
    driver = new TestingBotDriver(driverOptions());
  });

  afterEach(async () => {
    await driver.dispose();
    await hub.stop();
  });

  it('fill clears the focused field, then types the new value', async () => {
    await connectAndroid();

    await driver.fill('hello');

    expect(executed().slice(-3)).toEqual([
      { script: 'mobile: pressKey', args: [expect.objectContaining({ keycode: 29 })] }, // ctrl+a
      { script: 'mobile: pressKey', args: [expect.objectContaining({ keycode: 67 })] }, // backspace
      { script: 'mobile: type', args: [{ text: 'hello' }] },
    ]);
  });

  it("fill('') only clears", async () => {
    await connectAndroid();

    await driver.fill('');

    expect(executed().map((e) => e.script)).not.toContain('mobile: type');
  });

  it('clearAppData uses mobile: clearApp', async () => {
    await connectAndroid();

    await driver.clearAppData('com.example.app');

    expect(executed().at(-1)).toEqual({
      script: 'mobile: clearApp',
      args: [{ appId: 'com.example.app', bundleId: 'com.example.app' }],
    });
  });
});
