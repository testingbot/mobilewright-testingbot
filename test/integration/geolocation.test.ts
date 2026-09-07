import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TestingBotDriver } from '../../src/driver.js';
import { FakeHub } from '../fake-hub/fake-hub.js';

/**
 * `setGeolocation` maps onto whichever vendor extension the platform's Appium
 * driver exposes, so the platform split is the whole behaviour worth pinning.
 */
describe('setGeolocation against FakeHub', () => {
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

  /** Executed scripts, in order, with their first argument. */
  const executed = () => hub.requests
    .filter((r) => r.path.endsWith('/execute/sync'))
    .map((r) => r.body as { script: string; args: unknown[] });

  beforeEach(async () => {
    hub = new FakeHub();
    await hub.start();
    driver = new TestingBotDriver(driverOptions());
  });

  afterEach(async () => {
    await driver.dispose();
    await hub.stop();
  });

  it('uses the XCUITest simulated-location extensions on iOS', async () => {
    await driver.prepare();
    const allocated = await driver.allocate({ platform: 'ios', deviceType: 'simulator' }, new Set());
    await driver.connect({ platform: 'ios', deviceId: allocated.deviceId });

    await driver.setGeolocation({ latitude: -17.833, longitude: 177.947 });
    await driver.setGeolocation(null);

    expect(executed().slice(-2)).toEqual([
      { script: 'mobile: setSimulatedLocation', args: [{ latitude: -17.833, longitude: 177.947 }] },
      { script: 'mobile: clearSimulatedLocation', args: [] },
    ]);
  });

  it('uses the UiAutomator2 geolocation extensions on Android', async () => {
    await driver.prepare();
    const allocated = await driver.allocate({ platform: 'android', deviceType: 'emulator' }, new Set());
    await driver.connect({ platform: 'android', deviceId: allocated.deviceId });

    await driver.setGeolocation({ latitude: 52.379, longitude: 4.9 });
    await driver.setGeolocation(null);

    expect(executed().slice(-2)).toEqual([
      { script: 'mobile: setGeolocation', args: [{ latitude: 52.379, longitude: 4.9 }] },
      { script: 'mobile: resetGeolocation', args: [] },
    ]);
  });
});
