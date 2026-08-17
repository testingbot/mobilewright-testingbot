import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NoDeviceAvailableError } from '@mobilewright/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TestingBotDriver } from '../../src/driver.js';
import { FakeHub } from '../fake-hub/fake-hub.js';

/**
 * Exercises the driver through the same sequence mobilewright's device pool
 * performs: the coordinator's driver instance allocates and releases, a
 * separately constructed instance (the worker process re-imports the config)
 * connects by session id, disconnect is a soft detach so the pool can
 * re-grant the slot, and release actually ends the TestingBot session.
 */
describe('pool lifecycle against FakeHub', () => {
  let hub: FakeHub;
  let coordinator: TestingBotDriver;

  const driverOptions = () => ({
    key: 'k',
    secret: 's',
    hubUrl: hub.hubUrl,
    apiUrl: hub.apiUrl,
    allocationTimeout: 5_000,
    commandTimeout: 2_000,
    // TestingBot sessions must start with an app; tb:// URLs skip the upload.
    apps: { ios: 'tb://prebuilt-ios', android: 'tb://prebuilt-android' } as const,
  });

  beforeEach(async () => {
    hub = new FakeHub();
    await hub.start();
    coordinator = new TestingBotDriver(driverOptions());
  });

  afterEach(async () => {
    await coordinator.dispose();
    await hub.stop();
  });

  it('allocate → connect (second instance) → act → disconnect → reuse → release', async () => {
    await coordinator.prepare();
    const allocated = await coordinator.allocate({ platform: 'ios', deviceType: 'simulator' }, new Set());
    expect(allocated.driver).toBe('testingbot');
    expect(hub.liveSessions()).toHaveLength(1);

    // Worker 1 connects by session UUID over stateless HTTP.
    const worker = new TestingBotDriver(driverOptions());
    const session = await worker.connect({ platform: 'ios', deviceId: allocated.deviceId });
    expect(session.deviceId).toBe(allocated.deviceId);

    const nodes = await worker.getViewHierarchy();
    expect(nodes.length).toBeGreaterThan(0);
    await worker.tap(100, 200);
    const screen = await worker.getScreenSize();
    expect(screen).toMatchObject({ width: 393, height: 852 });

    // Soft detach: the TestingBot session must survive for the next test.
    await worker.disconnect();
    expect(hub.liveSessions()).toHaveLength(1);

    // The pool re-grants the same slot to another worker without re-allocating.
    const worker2 = new TestingBotDriver(driverOptions());
    await worker2.connect({ platform: 'ios', deviceId: allocated.deviceId });
    await worker2.disconnect();

    await coordinator.release(allocated.deviceId);
    expect(hub.liveSessions()).toHaveLength(0);
  });

  it('session methods before connect() fail with a clear error', async () => {
    const worker = new TestingBotDriver(driverOptions());
    await expect(worker.tap(1, 1)).rejects.toThrow('No active session. Call connect() first.');
  });

  it('maps hub "busy" errors to NoDeviceAvailableError so the pool re-queues', async () => {
    hub.busyCount = 1;
    await expect(
      coordinator.allocate({ platform: 'android' }, new Set()),
    ).rejects.toBeInstanceOf(NoDeviceAvailableError);
    // Next attempt (the pool's retry) succeeds.
    const allocated = await coordinator.allocate({ platform: 'android' }, new Set());
    expect(hub.liveSessions()).toHaveLength(1);
    await coordinator.release(allocated.deviceId);
  });

  it('pins a concrete catalog device for real-device criteria', async () => {
    const allocated = await coordinator.allocate(
      { platform: 'android', deviceType: 'real', osVersion: '>=14' },
      new Set(),
    );
    const session = hub.liveSessions()[0]!;
    expect(session.capabilities['appium:deviceName']).toBe('Pixel 8');
    expect(session.capabilities['appium:platformVersion']).toBe('14');
    expect((session.capabilities['tb:options'] as Record<string, unknown>)['realDevice']).toBe(true);
    expect(allocated.model).toBe('Pixel 8');
    await coordinator.release(allocated.deviceId);
  });

  it('pins a concrete simulator for virtual osVersion ranges via /v1/browsers', async () => {
    const allocated = await coordinator.allocate(
      { platform: 'ios', deviceType: 'simulator', osVersion: '>=16 <18' },
      new Set(),
    );
    const session = hub.liveSessions()[0]!;
    expect(session.capabilities['appium:deviceName']).toBe('iPhone 15');
    expect(session.capabilities['appium:platformVersion']).toBe('17.5');
    expect((session.capabilities['tb:options'] as Record<string, unknown>)['realDevice']).toBe(false);
    await coordinator.release(allocated.deviceId);
  });

  it('deletes a session that resolves after the pool aborted the waiter', async () => {
    hub.allocationDelay = 150;
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 30);
    await expect(
      coordinator.allocate({ platform: 'ios' }, new Set(), controller.signal),
    ).rejects.toThrow();
    // Whether fetch aborted in-flight or the session was deleted post-resolve,
    // nothing may stay allocated (billing + the pool's release-not-publish rule).
    await new Promise((r) => setTimeout(r, 300));
    expect(hub.liveSessions()).toHaveLength(0);
  });

  it('dispose sweeps leftover sessions', async () => {
    await coordinator.allocate({ platform: 'ios' }, new Set());
    await coordinator.allocate({ platform: 'ios' }, new Set());
    expect(hub.liveSessions()).toHaveLength(2);
    await coordinator.dispose();
    expect(hub.liveSessions()).toHaveLength(0);
  });

  it('uploads a local app at allocation and treats installApp as already satisfied', async () => {
    const apkPath = join(tmpdir(), 'fake-app.apk');
    writeFileSync(apkPath, Buffer.concat([Buffer.from('PK\x03\x04'), Buffer.from('apk-bytes')]));
    const driver = new TestingBotDriver({ ...driverOptions(), apps: { android: apkPath } });

    const allocated = await driver.allocate({ platform: 'android', deviceType: 'emulator' }, new Set());
    expect(hub.uploadCount).toBe(1);
    expect(hub.liveSessions()[0]!.capabilities['appium:app']).toBe('tb://fakeapp');

    const worker = new TestingBotDriver({ ...driverOptions(), apps: { android: apkPath } });
    await worker.connect({ platform: 'android', deviceId: allocated.deviceId, deviceType: 'emulator' });
    // Same build as declared: no-op instead of a mid-session install.
    await expect(worker.installApp(apkPath)).resolves.toBeUndefined();
    // A different binary cannot be installed mid-session on TestingBot.
    const otherPath = join(tmpdir(), 'other-app.apk');
    writeFileSync(otherPath, Buffer.concat([Buffer.from('PK\x03\x04'), Buffer.from('different')]));
    await expect(worker.installApp(otherPath)).rejects.toThrow(/cannot install .* mid-session/);

    await driver.release(allocated.deviceId);
    await driver.dispose();
  });

  it('installs helper apps as appium:otherApps and accepts them from installApps', async () => {
    const main = join(tmpdir(), 'multi-main.apk');
    const helper = join(tmpdir(), 'multi-helper.apk');
    writeFileSync(main, Buffer.concat([Buffer.from('PK\x03\x04'), Buffer.from('main-bytes')]));
    writeFileSync(helper, Buffer.concat([Buffer.from('PK\x03\x04'), Buffer.from('helper-bytes')]));
    const apps = { android: [main, helper] };

    const driver = new TestingBotDriver({ ...driverOptions(), apps });
    const allocated = await driver.allocate({ platform: 'android', deviceType: 'emulator' }, new Set());
    expect(hub.uploadCount).toBe(2); // both binaries uploaded once
    const caps = hub.liveSessions()[0]!.capabilities;
    expect(caps['appium:app']).toBe('tb://fakeapp');
    expect(caps['appium:otherApps']).toEqual(['tb://fakeapp']); // FakeHub returns one key for both

    // mobilewright calls installApp for every installApps entry — each of the
    // declared apps must be accepted as already installed.
    const worker = new TestingBotDriver({ ...driverOptions(), apps });
    await worker.connect({ platform: 'android', deviceId: allocated.deviceId, deviceType: 'emulator' });
    await expect(worker.installApp(main)).resolves.toBeUndefined();
    await expect(worker.installApp(helper)).resolves.toBeUndefined();

    const stranger = join(tmpdir(), 'multi-stranger.apk');
    writeFileSync(stranger, Buffer.concat([Buffer.from('PK\x03\x04'), Buffer.from('stranger')]));
    await expect(worker.installApp(stranger)).rejects.toThrow(/cannot install .* mid-session/);

    await driver.release(allocated.deviceId);
    await driver.dispose();
  });

  it('rejects allocation without a configured app', async () => {
    const driver = new TestingBotDriver({ ...driverOptions(), apps: {} });
    await expect(driver.allocate({ platform: 'ios' }, new Set())).rejects.toThrow(/must start with an app/);
    await driver.dispose();
  });

  it('warns once when the run wants more parallel sessions than the plan allows', async () => {
    const { vi } = await import('vitest');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => { });
    try {
      await coordinator.prepare(); // learns max_concurrent: 2 from /v1/user
      const a = await coordinator.allocate({ platform: 'ios' }, new Set());
      const b = await coordinator.allocate({ platform: 'ios' }, new Set());
      expect(warn).not.toHaveBeenCalled(); // at the limit is fine
      const c = await coordinator.allocate({ platform: 'ios' }, new Set());
      const d = await coordinator.allocate({ platform: 'ios' }, new Set());
      expect(warn).toHaveBeenCalledTimes(1); // over the limit, warned once
      expect(String(warn.mock.calls[0]![0])).toContain('plan allows 2');
      for (const s of [a, b, c, d]) await coordinator.release(s.deviceId);
    } finally {
      warn.mockRestore();
    }
  });

  it('observer reports the run verdict to every session, even after release', async () => {
    const a = await coordinator.allocate({ platform: 'ios' }, new Set());
    const b = await coordinator.allocate({ platform: 'ios' }, new Set());
    // Playwright teardown ordering: the pool releases every session (and
    // dispose runs) BEFORE the reporter delivers onRunEnd. Reports must
    // still reach both sessions.
    await coordinator.release(a.deviceId);
    await coordinator.dispose();
    coordinator.observer!.onRunStart?.({ totalTests: 3 });
    coordinator.observer!.onTestEnd?.(
      { id: 't1', title: 'boarding', titlePath: ['', 'ios', 'f', 'boarding'] },
      { status: 'failed', retry: 0, duration: 5, errors: ['Error: no towel'], steps: [] },
    );
    await coordinator.observer!.onRunEnd?.({ status: 'failed', startTime: new Date(0), duration: 10 });

    expect(hub.testUpdates.get(a.deviceId)).toMatchObject({ 'test[success]': '0' });
    expect(hub.testUpdates.get(b.deviceId)).toMatchObject({ 'test[success]': '0' });
    expect(String(hub.testUpdates.get(a.deviceId)!['test[status_message]'])).toContain('boarding');
  });
});

describe('sessionPerTest against FakeHub', () => {
  let hub: FakeHub;

  beforeEach(async () => {
    hub = new FakeHub();
    await hub.start();
  });

  afterEach(async () => {
    await hub.stop();
  });

  const options = () => ({
    key: 'k',
    secret: 's',
    hubUrl: hub.hubUrl,
    apiUrl: hub.apiUrl,
    allocationTimeout: 5_000,
    commandTimeout: 2_000,
    apps: { ios: 'tb://prebuilt-ios' } as const,
    sessionPerTest: true,
  });

  it('rotates the WebDriver session on every test and reports all of them', async () => {
    const coordinator = new TestingBotDriver(options());
    await coordinator.prepare();
    const allocated = await coordinator.allocate({ platform: 'ios', deviceType: 'simulator' }, new Set());

    const worker = new TestingBotDriver(options());
    // Test 1 uses the session allocate() created.
    await worker.connect({ platform: 'ios', deviceId: allocated.deviceId, deviceType: 'simulator' });
    await worker.tap(1, 1);
    await worker.disconnect();
    expect(hub.liveSessions()).toHaveLength(0); // per-test session ended at test end

    // Test 2 gets a fresh session on the same pool slot.
    await worker.connect({ platform: 'ios', deviceId: allocated.deviceId, deviceType: 'simulator' });
    const fresh = hub.liveSessions()[0]!;
    expect(fresh.id).not.toBe(allocated.deviceId);
    expect(fresh.capabilities['appium:app']).toBe('tb://prebuilt-ios');
    await worker.disconnect();
    expect(hub.liveSessions()).toHaveLength(0);

    await coordinator.release(allocated.deviceId); // original already gone — swallowed
    await coordinator.dispose();

    // The observer reports the original AND the rotated session.
    coordinator.observer!.onRunStart?.({ totalTests: 2 });
    coordinator.observer!.onTestEnd?.(
      { id: 't1', title: 'a test', titlePath: ['', 'ios', 'f', 'a test'] },
      { status: 'passed', retry: 0, duration: 5, errors: [], steps: [] },
    );
    await coordinator.observer!.onRunEnd?.({ status: 'passed', startTime: new Date(0), duration: 1 });
    expect(hub.testUpdates.get(allocated.deviceId)).toMatchObject({ 'test[success]': '1' });
    expect(hub.testUpdates.get(fresh.id)).toMatchObject({ 'test[success]': '1' });
  });

  it('a second worker process rotates instead of failing on the consumed original session', async () => {
    const coordinator = new TestingBotDriver(options());
    await coordinator.prepare();
    const allocated = await coordinator.allocate({ platform: 'ios', deviceType: 'simulator' }, new Set());

    const worker1 = new TestingBotDriver(options());
    await worker1.connect({ platform: 'ios', deviceId: allocated.deviceId, deviceType: 'simulator' });
    await worker1.disconnect(); // original session deleted

    // A different worker process (fresh driver instance) gets the same slot:
    // the original id is dead, so it must start a fresh session, not fail.
    const worker2 = new TestingBotDriver(options());
    const session = await worker2.connect({ platform: 'ios', deviceId: allocated.deviceId, deviceType: 'simulator' });
    expect(session.deviceId).toBe(allocated.deviceId); // pool handle unchanged
    expect(hub.liveSessions()).toHaveLength(1);
    await worker2.disconnect();
    await coordinator.dispose();
  });

  it('downloads the session video to the requested output path at run end', async () => {
    const coordinator = new TestingBotDriver(options());
    await coordinator.prepare();
    const allocated = await coordinator.allocate({ platform: 'ios', deviceType: 'simulator' }, new Set());

    const worker = new TestingBotDriver(options());
    await worker.connect({ platform: 'ios', deviceId: allocated.deviceId, deviceType: 'simulator' });
    const output = join(tmpdir(), `tb-e2e-video-${Date.now()}.mp4`);
    await worker.startRecording({ output });
    const result = await worker.stopRecording();
    expect(result.url).toContain('/videos/');
    await worker.disconnect();
    await coordinator.release(allocated.deviceId);

    coordinator.observer!.onRunStart?.({ totalTests: 1 });
    coordinator.observer!.onTestEnd?.(
      { id: 't1', title: 'recorded test', titlePath: ['', 'ios', 'f', 'recorded test'] },
      { status: 'passed', retry: 0, duration: 5, errors: [], steps: [] },
    );
    await coordinator.observer!.onRunEnd?.({ status: 'passed', startTime: new Date(0), duration: 1 });

    const { readFileSync } = await import('node:fs');
    expect(readFileSync(output, 'utf-8')).toContain('fake-mp4-bytes-for-');
    await coordinator.dispose();
  });

  it('webViewBridge lists, drives, and detaches from webviews', async () => {
    const coordinator = new TestingBotDriver(options());
    const allocated = await coordinator.allocate({ platform: 'ios', deviceType: 'simulator' }, new Set());
    const worker = new TestingBotDriver(options());
    await worker.connect({ platform: 'ios', deviceId: allocated.deviceId, deviceType: 'simulator' });

    const webviews = await worker.webViewBridge.listWebViews();
    expect(webviews).toEqual([{ id: 'WEBVIEW_com.example', title: 'Checkout', url: 'https://shop.example/cart' }]);

    const view = await worker.webViewBridge.attachWebView('WEBVIEW_com.example');
    expect(hub.liveSessions()[0]!.context).toBe('WEBVIEW_com.example');
    expect(await view.url()).toBe('https://shop.example/cart');
    expect(await view.title()).toBe('Checkout');
    await view.waitForLoadState();
    await view.close();
    expect(hub.liveSessions()[0]!.context).toBe('NATIVE_APP');

    await worker.disconnect();
    await coordinator.dispose();
  });

  it('explains a launch failure caused by a bundleId that is not installed', async () => {
    const apps = { ios: 'tb://prebuilt-ios' } as const;
    const coordinator = new TestingBotDriver({ ...options(), apps });
    const allocated = await coordinator.allocate({ platform: 'ios', deviceType: 'simulator' }, new Set());
    const worker = new TestingBotDriver({ ...options(), apps });
    await worker.connect({ platform: 'ios', deviceId: allocated.deviceId, deviceType: 'simulator' });

    // The config's bundleId does not match the installed build — the usual
    // cause of Appium's misleading "launchable activity" error.
    await expect(worker.launchApp('com.wrong.id')).rejects.toThrow(/is not installed on this device/);
    await expect(worker.launchApp('com.wrong.id')).rejects.toThrow(/tb:\/\/prebuilt-ios/);

    // A genuinely missing launcher activity keeps the other explanation.
    hub.launcherActivityMissing = true;
    await expect(worker.launchApp(hub.installedBundleId)).rejects.toThrow(/no resolvable launcher activity/);

    await worker.disconnect();
    await coordinator.dispose();
  });

  it('exposes TestingBot commands to test code and resets throttling at the test boundary', async () => {
    const { testingbot } = await import('../../src/session-commands.js');
    const apps = { android: 'tb://prebuilt-android' } as const;
    const coordinator = new TestingBotDriver({ ...options(), apps });
    const allocated = await coordinator.allocate({ platform: 'android', deviceType: 'emulator' }, new Set());
    const worker = new TestingBotDriver({ ...options(), apps });

    // Outside a session the helper explains itself instead of throwing TypeErrors.
    await expect(testingbot.throttle('3G')).rejects.toThrow(/needs a connected device session/);

    await worker.connect({ platform: 'android', deviceId: allocated.deviceId, deviceType: 'emulator' });
    expect(testingbot.sessionId()).toBe(allocated.deviceId);
    expect(testingbot.dashboardUrl()).toContain(allocated.deviceId);

    await testingbot.throttle('3G');
    await testingbot.shell('input', ['keyevent', '3']);
    await testingbot.execute('mobile: getCurrentPackage');

    const scripts = hub.requests
      .filter((r) => r.path.endsWith('/execute/sync'))
      .map((r) => (r.body as { script: string; args: unknown[] }));
    expect(scripts.map((s) => s.script)).toEqual(
      expect.arrayContaining(['tb:throttle', 'mobile: shell', 'mobile: getCurrentPackage']),
    );
    expect(scripts.find((s) => s.script === 'tb:throttle')!.args).toEqual(['3G']);
    expect(scripts.find((s) => s.script === 'mobile: shell')!.args)
      .toEqual([{ command: 'input', args: ['keyevent', '3'] }]);

    // Pooled sessions outlive the test — throttling must not leak forward.
    await worker.disconnect();
    const throttleCalls = hub.requests
      .filter((r) => r.path.endsWith('/execute/sync'))
      .map((r) => (r.body as { script: string; args: unknown[] }))
      .filter((s) => s.script === 'tb:throttle');
    expect(throttleCalls.at(-1)!.args).toEqual(['disable']);

    await coordinator.release(allocated.deviceId);
    await coordinator.dispose();
  });
});
