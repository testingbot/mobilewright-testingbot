import { describe, expect, it } from 'vitest';
import { appsForCriteria, buildCapabilities } from '../../src/capabilities.js';
import { resolveOptions } from '../../src/options.js';

const options = resolveOptions({ key: 'k', secret: 's' });

describe('buildCapabilities', () => {
  it('requires a platform', () => {
    expect(() => buildCapabilities({}, options)).toThrow(/requires a platform/);
  });

  it('builds android emulator caps by default', () => {
    const caps = buildCapabilities({ platform: 'android' }, options, undefined, ['tb://app']);
    expect(caps.alwaysMatch).toMatchObject({
      platformName: 'Android',
      'appium:automationName': 'UiAutomator2',
      'appium:deviceName': '*',
    });
    expect(caps.alwaysMatch['tb:options']).toMatchObject({
      key: 'k',
      secret: 's',
      realDevice: false,
      screenrecorder: true,
      idletimeout: 230,
      name: 'mobilewright', // sessions must never show unnamed on the dashboard
    });
  });

  it('marks real devices and applies a pinned catalog device', () => {
    const caps = buildCapabilities(
      { platform: 'ios', deviceType: 'real', osVersion: '>=17' },
      options,
      { deviceName: 'iPhone 15', platformVersion: '17.4' },
      ['tb://app'],
    );
    expect(caps.alwaysMatch).toMatchObject({
      platformName: 'iOS',
      'appium:automationName': 'XCUITest',
      'appium:deviceName': 'iPhone 15',
      'appium:platformVersion': '17.4',
    });
    expect((caps.alwaysMatch['tb:options'] as Record<string, unknown>)['realDevice']).toBe(true);
  });

  it('forwards plain osVersion for virtual devices but rejects ranges', () => {
    const caps = buildCapabilities({ platform: 'ios', deviceType: 'simulator', osVersion: '17.0' }, options, undefined, ['tb://app']);
    expect(caps.alwaysMatch['appium:platformVersion']).toBe('17.0');
    expect(caps.alwaysMatch['appium:app']).toBe('tb://app');
    expect(() =>
      buildCapabilities({ platform: 'ios', deviceType: 'simulator', osVersion: '>=17 <19' }, options, undefined, ['tb://app']),
    ).toThrow(/cannot resolve the osVersion range/);
  });

  it('requires an app (or browser) to start the session', () => {
    expect(() => buildCapabilities({ platform: 'android' }, options)).toThrow(/must start with an app/);
    // browserName via the escape hatch also satisfies the requirement
    const withBrowser = resolveOptions({ key: 'k', secret: 's', capabilities: { browserName: 'chrome' } });
    expect(() => buildCapabilities({ platform: 'android' }, withBrowser)).not.toThrow();
  });

  it('appsForCriteria picks the most specific slot and normalizes to a list', () => {
    const apps = { ios: './generic.ipa', 'ios-simulator': './sim.zip', android: ['./app.apk', './helper.apk'] };
    expect(appsForCriteria({ platform: 'ios', deviceType: 'simulator' }, apps)).toEqual(['./sim.zip']);
    expect(appsForCriteria({ platform: 'ios', deviceType: 'real' }, apps)).toEqual(['./generic.ipa']);
    expect(appsForCriteria({ platform: 'android', deviceType: 'emulator' }, apps)).toEqual(['./app.apk', './helper.apk']);
    expect(appsForCriteria({ platform: 'android' }, {})).toEqual([]);
  });

  it('sends helper apps as appium:otherApps, app under test first', () => {
    const caps = buildCapabilities({ platform: 'android' }, options, undefined,
      ['tb://main', 'tb://helper', 'tb://mock']);
    expect(caps.alwaysMatch['appium:app']).toBe('tb://main');
    expect(caps.alwaysMatch['appium:otherApps']).toEqual(['tb://helper', 'tb://mock']);
    // A single app must not add an empty otherApps list.
    const single = buildCapabilities({ platform: 'android' }, options, undefined, ['tb://main']);
    expect(single.alwaysMatch['appium:otherApps']).toBeUndefined();
  });

  it('merges user capabilities and tbOptions last as an escape hatch', () => {
    const custom = resolveOptions({
      key: 'k', secret: 's',
      capabilities: { 'appium:autoGrantPermissions': true },
      tbOptions: { timeZone: 'Europe/Brussels', idletimeout: 500 },
    });
    const caps = buildCapabilities({ platform: 'android' }, custom, undefined, ['tb://app']);
    expect(caps.alwaysMatch['appium:autoGrantPermissions']).toBe(true);
    expect(caps.alwaysMatch['tb:options']).toMatchObject({ timeZone: 'Europe/Brussels', idletimeout: 500 });
  });

  it('maps the typed TestingBot options into tb:options', () => {
    const opts = resolveOptions({
      key: 'k', secret: 's',
      timeZone: 'Europe/Brussels',
      geoCountryCode: 'DE',
      throttleNetwork: '3G',
      screenshots: true,
      video: false,
      recordLogs: 'strip-parameters',
      public: true,
      extra: 'commit=abc123',
      phoneOnly: true,
      tunnelIdentifier: 'ci-42',
    });
    const caps = buildCapabilities({ platform: 'android' }, opts, undefined, ['tb://app']);
    expect(caps.alwaysMatch['tb:options']).toMatchObject({
      timeZone: 'Europe/Brussels',
      'testingbot.geoCountryCode': 'DE',
      throttle_network: '3G',
      screenshot: true,
      screenrecorder: false,
      recordLogs: 'strip-parameters',
      public: true,
      extra: 'commit=abc123',
      phoneOnly: true,
      tunnelIdentifier: 'ci-42',
    });
  });

  it('derives tunnelIdentifier from the tunnel object', () => {
    const opts = resolveOptions({ key: 'k', secret: 's', tunnel: { identifier: 'local-1' } });
    expect(opts.tunnelIdentifier).toBe('local-1');
    expect(opts.tunnel).toEqual({ identifier: 'local-1' });
    const plain = resolveOptions({ key: 'k', secret: 's', tunnel: true });
    expect(plain.tunnel).toEqual({});
    expect(plain.tunnelIdentifier).toBeUndefined();
  });

  it('maps popup-handling options to the right platform only', () => {
    const opts = resolveOptions({ key: 'k', secret: 's', autoGrantPermissions: true, autoAcceptAlerts: true });
    const android = buildCapabilities({ platform: 'android' }, opts, undefined, ['tb://app']);
    expect(android.alwaysMatch['appium:autoGrantPermissions']).toBe(true);
    expect(android.alwaysMatch['appium:autoAcceptAlerts']).toBeUndefined();
    const ios = buildCapabilities({ platform: 'ios' }, opts, undefined, ['tb://app']);
    expect(ios.alwaysMatch['appium:autoAcceptAlerts']).toBe(true);
    expect(ios.alwaysMatch['appium:autoGrantPermissions']).toBeUndefined();
  });

  it('keeps the single-app (string) form working unchanged', () => {
    const caps = buildCapabilities({ platform: 'android' }, options, undefined, ['tb://only']);
    expect(caps.alwaysMatch['appium:app']).toBe('tb://only');
    expect(caps.alwaysMatch).not.toHaveProperty('appium:otherApps');
    // ...and a one-element array is exactly equivalent to the string form.
    const single = appsForCriteria({ platform: 'android' }, { android: './a.apk' });
    const listed = appsForCriteria({ platform: 'android' }, { android: ['./a.apk'] });
    expect(single).toEqual(listed);
  });

  it('preserves order and mixes remote and local app entries', () => {
    const apps = { android: ['tb://prebuilt', './local.apk', 'https://cdn.example/helper.apk'] };
    expect(appsForCriteria({ platform: 'android' }, apps))
      .toEqual(['tb://prebuilt', './local.apk', 'https://cdn.example/helper.apk']);
  });

  it('treats an empty or blank app list as no app at all', () => {
    expect(appsForCriteria({ platform: 'android' }, { android: [] })).toEqual([]);
    expect(appsForCriteria({ platform: 'android' }, { android: ['', './a.apk'] })).toEqual(['./a.apk']);
    // No app and no browser must still fail loudly rather than reach the hub.
    expect(() => buildCapabilities({ platform: 'android' }, options, undefined, []))
      .toThrow(/must start with an app/);
  });

  it('prefers the device-type slot even when the platform slot is a list', () => {
    const apps = { android: ['./generic.apk', './generic-helper.apk'], 'android-real': './device.apk' };
    expect(appsForCriteria({ platform: 'android', deviceType: 'real' }, apps)).toEqual(['./device.apk']);
    expect(appsForCriteria({ platform: 'android', deviceType: 'emulator' }, apps))
      .toEqual(['./generic.apk', './generic-helper.apk']);
  });
});
