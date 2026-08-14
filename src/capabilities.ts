import type { AllocationCriteria } from '@mobilewright/protocol';
import type { AppSlot, ResolvedOptions } from './options.js';

export interface W3CCapabilities {
  alwaysMatch: Record<string, unknown>;
  firstMatch: Record<string, unknown>[];
}

/** A concrete device pinned from the catalog (real devices). */
export interface PinnedDevice {
  deviceName: string;
  platformVersion: string;
}

/** Characters that make a regex source mean something beyond its literal text. */
const REGEX_METACHARS = /[.*+?^${}()|[\]\\]/;

/**
 * Pick the configured app for an allocation, most-specific key first
 * ('ios-real' beats 'ios'). Returns the raw configured value: a local path
 * or a tb:// / https URL (the caller uploads local paths).
 */
export function appForCriteria(
  criteria: Pick<AllocationCriteria, 'platform' | 'deviceType'>,
  apps: Partial<Record<AppSlot, string>>,
): string | undefined {
  const platform = criteria.platform;
  if (!platform) return undefined;
  if (criteria.deviceType) {
    const specific = apps[`${platform}-${criteria.deviceType}` as AppSlot];
    if (specific) return specific;
  }
  return apps[platform];
}

/**
 * Build the W3C new-session payload for a set of allocation criteria.
 * Pure — catalog lookups and app uploads happen in the caller; a pinned
 * device (real-device allocations) overrides name/version wildcards, and
 * `appUrl` is the already-uploaded app under test (tb:// or https).
 */
export function buildCapabilities(
  criteria: AllocationCriteria,
  options: ResolvedOptions,
  pinned?: PinnedDevice,
  appUrl?: string,
): W3CCapabilities {
  const platform = criteria.platform;
  if (!platform) {
    throw new Error(
      'TestingBotDriver.allocate requires a platform ("ios" or "android"). ' +
      'Set `platform` in your mobilewright config (top-level or per-project `use`).',
    );
  }

  // A device pinned via criteria.deviceId comes from TestingBot's physical
  // device catalog, so a pin implies a real device even without deviceType.
  const isReal = criteria.deviceType === 'real' || (pinned !== undefined && criteria.deviceType === undefined);
  const caps: Record<string, unknown> = {
    platformName: platform === 'ios' ? 'iOS' : 'Android',
    'appium:automationName': platform === 'ios' ? 'XCUITest' : 'UiAutomator2',
  };
  if (appUrl) caps['appium:app'] = appUrl;

  // TestingBot has no app-less sessions: every session must start with an
  // app or a browser. Fail here with guidance instead of a cryptic hub error.
  const escape = options.capabilities;
  const startsWithSomething = appUrl
    || escape['appium:app'] || escape['app']
    || escape['browserName'] || escape['appium:browserName'];
  if (!startsWithSomething) {
    throw new Error(
      'TestingBot sessions must start with an app (or a browser). Declare the app under test in ' +
      "the driver options — new TestingBotDriver({ apps: { " +
      (platform === 'ios'
        ? "'ios-simulator': './build/App.zip', 'ios-real': './build/App.ipa'"
        : "android: './build/app.apk'") +
      " } }) — or set 'appium:app' / 'browserName' via the capabilities escape hatch.",
    );
  }

  if (pinned) {
    caps['appium:deviceName'] = pinned.deviceName;
    caps['appium:platformVersion'] = pinned.platformVersion;
  } else {
    // deviceNamePattern is a regex source; TestingBot's simulator/emulator
    // name matching is not regex-based, so only literal names pass through.
    if (criteria.deviceNamePattern && REGEX_METACHARS.test(criteria.deviceNamePattern)) {
      throw new Error(
        `TestingBotDriver cannot resolve the deviceName pattern /${criteria.deviceNamePattern}/ for ` +
        'simulators/emulators. Use a literal device name (e.g. deviceName: "iPhone 15"), or set ' +
        'the exact name via the capabilities escape hatch: { capabilities: { "appium:deviceName": "..." } }.',
      );
    }
    caps['appium:deviceName'] = criteria.deviceNamePattern ?? '*';
    if (criteria.osVersion) {
      // Virtual devices: only plain versions/prefixes can be forwarded as
      // platformVersion. Range expressions need catalog resolution, which the
      // MVP only implements for real devices.
      if (/[<>=\s~^]/.test(criteria.osVersion)) {
        throw new Error(
          `TestingBotDriver cannot resolve the osVersion range "${criteria.osVersion}" for ` +
          'simulators/emulators yet. Use an exact version (e.g. "17.0") or a prefix (e.g. "17").',
        );
      }
      caps['appium:platformVersion'] = criteria.osVersion;
    }
  }

  const tbOptions: Record<string, unknown> = {
    key: options.key,
    secret: options.secret,
    realDevice: isReal,
    screenrecorder: true,
    idletimeout: options.idleTimeout,
  };
  if (options.maxDuration !== undefined) tbOptions['maxduration'] = options.maxDuration;
  if (options.appiumVersion !== undefined) tbOptions['appiumVersion'] = options.appiumVersion;
  if (options.name !== undefined) tbOptions['name'] = options.name;
  if (options.build !== undefined) tbOptions['build'] = options.build;

  Object.assign(tbOptions, options.tbOptions);
  Object.assign(caps, options.capabilities);
  caps['tb:options'] = { ...tbOptions, ...(options.capabilities['tb:options'] as object | undefined) };

  return { alwaysMatch: caps, firstMatch: [{}] };
}
