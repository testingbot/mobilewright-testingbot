import { writeFile } from 'node:fs/promises';
import createDebug from 'debug';
import {
  NoDeviceAvailableError,
  type AllocatedDevice,
  type AllocationCriteria,
  type AppInfo,
  type ConnectionConfig,
  type DeviceInfo,
  type DeviceType,
  type GestureSequence,
  type HardwareButton,
  type LaunchOptions,
  type ListDevicesOptions,
  type MobilewrightDriver,
  type Orientation,
  type Platform,
  type RecordingOptions,
  type RecordingResult,
  type ScreenSize,
  type ScreenshotOptions,
  type Session,
  type SwipeDirection,
  type SwipeOptions,
  type TestObserver,
  type ViewNode,
} from '@mobilewright/protocol';
import {
  doubleTapActions,
  gestureActions,
  longPressActions,
  swipeActions,
  tapActions,
} from './actions.js';
import { AppStorage } from './app-storage.js';
import { appForCriteria, buildCapabilities, type PinnedDevice } from './capabilities.js';
import { DeviceCatalog } from './device-catalog.js';
import { SessionNotActiveError, toAllocationError } from './errors.js';
import { Keepalive } from './keepalive.js';
import { parseChord, toAndroidKeyPress, toW3CKeyActions, typeTextActions } from './keys.js';
import { TestingBotTestObserver } from './observer.js';
import { requireCredentials, resolveOptions, type ResolvedOptions, type TestingBotDriverOptions } from './options.js';
import { RestApiClient } from './rest-api.js';
import { WebDriverClient } from './webdriver-client.js';

const debug = createDebug('testingbot:driver');

interface AllocatedSession {
  sessionId: string;
  platform: Platform;
  deviceName?: string;
  osVersion?: string;
  /** Set only when this allocation pinned a catalog device by name. */
  pinnedName?: string;
}

interface ActiveSession {
  sessionId: string;
  platform: Platform;
  deviceType?: DeviceType;
  screenSize?: ScreenSize;
}

const ANDROID_BUTTON_KEYCODES: Record<HardwareButton, number> = {
  HOME: 3,
  BACK: 4,
  POWER: 26,
  VOLUME_UP: 24,
  VOLUME_DOWN: 25,
  ENTER: 66,
  DPAD_UP: 19,
  DPAD_DOWN: 20,
  DPAD_LEFT: 21,
  DPAD_RIGHT: 22,
  DPAD_CENTER: 23,
  APP_SWITCH: 187,
  LOCK: 26, // same as POWER — locks the screen
};

// XCUITest's mobile: pressButton supports exactly these names on iOS.
const IOS_BUTTON_NAMES: Partial<Record<HardwareButton, string>> = {
  HOME: 'home',
  VOLUME_UP: 'volumeup',
  VOLUME_DOWN: 'volumedown',
};

/**
 * Mobilewright driver for TestingBot's device cloud.
 *
 * The WebDriver session is the allocation: `allocate()` creates an Appium
 * session on hub.testingbot.com and hands its UUID to the device pool as the
 * deviceId; worker processes `connect()` to that UUID over plain stateless
 * HTTP. `disconnect()` only detaches (the pool re-grants slots without
 * re-allocating) — the session actually ends in `release()`/`dispose()`.
 */
export class TestingBotDriver implements MobilewrightDriver {
  readonly observer: TestObserver | undefined;

  private readonly options: ResolvedOptions;
  private readonly hub: WebDriverClient;
  private readonly api: RestApiClient;
  private readonly catalog: DeviceCatalog;
  private readonly storage: AppStorage;
  private readonly keepalive: Keepalive;

  /** Sessions created by this instance's allocate() (coordinator process). */
  private readonly allocated = new Map<string, AllocatedSession>();
  /** Every session ever allocated this run — release() does NOT remove
   *  entries, because the observer must report sessions the pool released
   *  before onRunEnd fires (which, with Playwright's teardown ordering, is
   *  all of them). */
  private readonly everAllocated = new Map<string, AllocatedSession>();
  /** Refcount of real-device names pinned by in-flight/live allocations. */
  private readonly pinCounts = new Map<string, number>();
  /** The session this instance is connected to (worker process). */
  private active: ActiveSession | undefined;

  constructor(options: TestingBotDriverOptions = {}) {
    this.options = resolveOptions(options);
    this.hub = new WebDriverClient(this.options.hubUrl, this.options.commandTimeout);
    this.api = new RestApiClient(this.options.apiUrl, this.options.key, this.options.secret);
    this.catalog = new DeviceCatalog(this.api);
    this.storage = new AppStorage(this.api);
    this.keepalive = new Keepalive(this.hub);
    this.observer = this.options.testResults === 'off'
      ? undefined
      : new TestingBotTestObserver(this.api, {
        sessionIds: () => [...this.everAllocated.keys()],
        build: this.options.build,
      });
  }

  // ─── DeviceAllocator ────────────────────────────────────────────

  async prepare(): Promise<void> {
    requireCredentials(this.options);
    await this.api.getUser();
    debug('credentials verified against %s', this.options.apiUrl);
  }

  async allocate(
    criteria: AllocationCriteria,
    _takenDeviceIds: ReadonlySet<string>,
    signal?: AbortSignal,
  ): Promise<AllocatedDevice> {
    requireCredentials(this.options);
    // takenDeviceIds is unused: every allocate() creates a fresh, exclusive
    // WebDriver session; physical-device contention is handled server-side.

    let pinned: PinnedDevice | undefined;
    let reservedName: string | undefined;
    if (criteria.deviceId) {
      pinned = await this.catalog.resolveDeviceId(criteria.deviceId);
    } else if (criteria.deviceType === 'real') {
      // pickRealDevice increments pinCounts synchronously before returning,
      // so concurrent allocates (the pool fires them without awaiting) see
      // each other's picks and spread across devices.
      pinned = await this.catalog.pickRealDevice(criteria, this.pinCounts);
      reservedName = pinned.deviceName;
    }

    // TestingBot sessions must start with an app — resolve and upload the
    // configured one now so it can ride along in the allocation caps.
    let appUrl: string | undefined;
    const configuredApp = appForCriteria(criteria, this.options.apps);
    if (configuredApp) {
      appUrl = isRemoteApp(configuredApp)
        ? configuredApp
        : (await this.storage.ensureUploaded(configuredApp, criteria.deviceType)).app_url;
    }

    const capabilities = buildCapabilities(criteria, this.options, pinned, appUrl);
    debug('allocating: %o', { ...capabilities.alwaysMatch, 'tb:options': '[redacted]' });

    if (signal?.aborted) {
      throw new NoDeviceAvailableError('allocation aborted before it started');
    }

    // The abort signal must NOT cancel the HTTP request itself: the hub may
    // already have created the session, and cancelling the fetch would lose
    // the only copy of its id — an orphaned session billing until TestingBot's
    // idle reaper finds it. Instead the request runs to completion (bounded by
    // allocationTimeout) and an abort makes allocate() throw promptly while a
    // background continuation deletes whatever the request eventually returns.
    const request = this.hub.newSession(capabilities, { timeout: this.options.allocationTimeout });

    let sessionId: string;
    let caps: Record<string, unknown>;
    try {
      if (signal) {
        let onAbort: (() => void) | undefined;
        const abortedPromise = new Promise<'aborted'>((resolve) => {
          onAbort = () => resolve('aborted');
          signal.addEventListener('abort', onAbort, { once: true });
        });
        let outcome;
        try {
          outcome = await Promise.race([
            request.then((r) => ({ r }), (err) => ({ err })),
            abortedPromise,
          ]);
        } finally {
          if (onAbort) signal.removeEventListener('abort', onAbort);
        }
        if (outcome === 'aborted') {
          request.then(
            ({ sessionId: lateId }) => {
              debug('allocation resolved after abort, deleting late session %s', lateId);
              return this.hub.deleteSession(lateId)
                .catch(() => this.api.stopTest(lateId).catch(() => { }));
            },
            () => { /* request failed anyway — nothing to clean up */ },
          );
          throw new NoDeviceAvailableError('allocation aborted');
        }
        if ('err' in outcome) throw toAllocationError(outcome.err);
        ({ sessionId, capabilities: caps } = outcome.r);
      } else {
        try {
          ({ sessionId, capabilities: caps } = await request);
        } catch (err) {
          throw toAllocationError(err);
        }
      }
    } catch (err) {
      if (reservedName) this.unpin(reservedName);
      throw err;
    }

    const platform = criteria.platform ?? (String(caps['platformName']).toLowerCase() === 'ios' ? 'ios' : 'android');
    const session: AllocatedSession = {
      sessionId,
      platform,
      deviceName: pinned?.deviceName ?? str(caps['appium:deviceName'] ?? caps['deviceName']),
      osVersion: pinned?.platformVersion ?? str(caps['appium:platformVersion'] ?? caps['platformVersion']),
      pinnedName: reservedName,
    };
    this.allocated.set(sessionId, session);
    this.everAllocated.set(sessionId, session);
    this.keepalive.start(sessionId);
    debug('allocated session %s (%s %s) — https://testingbot.com/members/tests/%s',
      sessionId, session.deviceName, session.osVersion, sessionId);

    return {
      deviceId: sessionId,
      platform,
      driver: 'testingbot',
      model: session.deviceName,
      osVersion: session.osVersion,
      type: criteria.deviceType,
    };
  }

  async release(deviceId: string): Promise<void> {
    this.keepalive.stop(deviceId);
    const session = this.allocated.get(deviceId);
    this.allocated.delete(deviceId);
    if (session?.pinnedName) this.unpin(session.pinnedName);
    try {
      await this.hub.deleteSession(deviceId);
      debug('released session %s', deviceId);
    } catch (err) {
      debug('DELETE /session/%s failed (%s), trying REST stop', deviceId, err);
      await this.api.stopTest(deviceId).catch(() => { });
    }
  }

  async dispose(): Promise<void> {
    this.keepalive.stopAll();
    const leftover = [...this.allocated.keys()];
    for (const session of this.allocated.values()) {
      if (session.pinnedName) this.unpin(session.pinnedName);
    }
    this.allocated.clear();
    await Promise.all(leftover.map((id) =>
      this.hub.deleteSession(id).catch(() => this.api.stopTest(id).catch(() => { })),
    ));
    if (leftover.length) debug('disposed %d leftover session(s)', leftover.length);
  }

  // ─── MobilewrightSession: connection ───────────────────────────

  async connect(config: ConnectionConfig): Promise<Session> {
    const sessionId = config.deviceId;
    if (!sessionId) {
      throw new Error(
        'TestingBotDriver.connect requires a deviceId (the WebDriver session UUID from allocate()). ' +
        'Run through "mobilewright test" so the device pool allocates first.',
      );
    }
    // Liveness probe — also validates the id belongs to a live TB session.
    await this.hub.get(sessionId, '/orientation', { timeout: config.timeout ?? this.options.commandTimeout });
    this.active = { sessionId, platform: config.platform, deviceType: config.deviceType };
    debug('connected to session %s', sessionId);
    return { deviceId: sessionId, platform: config.platform };
  }

  async disconnect(): Promise<void> {
    // Soft detach only: the pool re-grants this slot to the next test and
    // ends the session via release().
    this.active = undefined;
  }

  // ─── MobilewrightSession: UI hierarchy ─────────────────────────

  async getViewHierarchy(): Promise<ViewNode[]> {
    const { sessionId, platform } = this.session();
    const xml = await this.hub.source(sessionId);
    const { parseHierarchy } = await import('./hierarchy.js');
    return parseHierarchy(xml, platform);
  }

  // ─── MobilewrightSession: input ────────────────────────────────

  async tap(x: number, y: number): Promise<void> {
    await this.hub.performActions(this.session().sessionId, tapActions(x, y));
  }

  async doubleTap(x: number, y: number): Promise<void> {
    await this.hub.performActions(this.session().sessionId, doubleTapActions(x, y));
  }

  async longPress(x: number, y: number, duration?: number): Promise<void> {
    await this.hub.performActions(this.session().sessionId, longPressActions(x, y, duration));
  }

  async typeText(text: string): Promise<void> {
    const { sessionId, platform } = this.session();
    if (platform === 'android') {
      // UiAutomator2's typing extension handles unicode; W3C key actions don't.
      await this.hub.execute(sessionId, 'mobile: type', [{ text }]);
    } else {
      await this.hub.performActions(sessionId, typeTextActions(text));
    }
  }

  async pressKeys(keys: string[]): Promise<void> {
    const { sessionId, platform } = this.session();
    const chords = keys.map(parseChord);
    if (platform === 'android') {
      for (const chord of chords) {
        await this.hub.execute(sessionId, 'mobile: pressKey', [toAndroidKeyPress(chord)]);
      }
      return;
    }
    // XCUITest/WDA dispatches complete key events only — held modifiers in
    // W3C key actions do not combine into chords on iOS.
    const chorded = chords.find((c) => c.modifiers.length > 0);
    if (chorded) {
      throw new Error(
        `TestingBotDriver: modifier chords ("${chorded.modifiers.join('+')}+${chorded.key}") are not ` +
        'supported on iOS — XCUITest cannot hold modifier keys. Press single keys instead.',
      );
    }
    await this.hub.performActions(sessionId, toW3CKeyActions(chords));
  }

  async clearText(): Promise<void> {
    const { sessionId, platform } = this.session();
    if (platform === 'android') {
      // Select-all + delete on the focused field.
      await this.pressKeys(['ctrl+a', 'backspace']);
      return;
    }
    // iOS has no working select-all chord; delete the focused field's value
    // one backspace per character (hierarchy tells us how many).
    const { parseHierarchy } = await import('./hierarchy.js');
    const nodes = parseHierarchy(await this.hub.source(sessionId), 'ios');
    const focused = findFocused(nodes);
    const length = focused?.value?.length ?? 40;
    if (length > 0) {
      await this.hub.performActions(sessionId, toW3CKeyActions(
        Array.from({ length }, () => ({ modifiers: [], key: 'backspace' })),
      ));
    }
  }

  async swipe(direction: SwipeDirection, opts?: SwipeOptions): Promise<void> {
    const { sessionId } = this.session();
    const screen = await this.getScreenSize();
    await this.hub.performActions(sessionId, swipeActions(direction, screen, opts));
  }

  async gesture(gestures: GestureSequence): Promise<void> {
    await this.hub.performActions(this.session().sessionId, gestureActions(gestures));
  }

  async pressButton(button: HardwareButton): Promise<void> {
    const { sessionId, platform } = this.session();
    if (platform === 'android') {
      await this.hub.execute(sessionId, 'mobile: pressKey', [{ keycode: ANDROID_BUTTON_KEYCODES[button] }]);
      return;
    }
    const name = IOS_BUTTON_NAMES[button];
    if (!name) {
      throw new Error(`TestingBotDriver: hardware button "${button}" is not supported on iOS`);
    }
    await this.hub.execute(sessionId, 'mobile: pressButton', [{ name }]);
  }

  // ─── MobilewrightSession: screen ───────────────────────────────

  async screenshot(opts?: ScreenshotOptions): Promise<Buffer> {
    const { sessionId } = this.session();
    // TestingBot/Appium produce PNG; a jpeg format request falls back to PNG.
    const base64 = await this.hub.screenshot(sessionId);
    const buffer = Buffer.from(base64, 'base64');
    if (opts?.path) await writeFile(opts.path, buffer);
    return buffer;
  }

  async getScreenSize(): Promise<ScreenSize> {
    const session = this.session();
    if (session.screenSize) return session.screenSize;
    const rect = await this.hub.get<{ width: number; height: number }>(session.sessionId, '/window/rect');
    // scale = physical pixels / logical units: derived from one screenshot's
    // PNG header so it is correct on both platforms without extra commands.
    let scale = 1;
    try {
      const png = Buffer.from(await this.hub.screenshot(session.sessionId), 'base64');
      const pngWidth = png.readUInt32BE(16); // IHDR width
      if (pngWidth > 0 && rect.width > 0) {
        scale = Math.round((pngWidth / rect.width) * 100) / 100;
      }
    } catch {
      // scale stays 1 — viewport math still works, crops may be off on 2x/3x screens.
    }
    session.screenSize = { width: rect.width, height: rect.height, scale };
    return session.screenSize;
  }

  async getOrientation(): Promise<Orientation> {
    const value = await this.hub.get<string>(this.session().sessionId, '/orientation');
    return value.toLowerCase() === 'landscape' ? 'landscape' : 'portrait';
  }

  async setOrientation(orientation: Orientation): Promise<void> {
    const session = this.session();
    await this.hub.post(session.sessionId, '/orientation', { orientation: orientation.toUpperCase() });
    session.screenSize = undefined; // width/height swap
  }

  // ─── MobilewrightSession: apps ─────────────────────────────────

  async launchApp(bundleId: string, opts?: LaunchOptions): Promise<void> {
    const { sessionId, platform } = this.session();
    if (platform === 'android' && opts?.activity) {
      await this.hub.execute(sessionId, 'mobile: startActivity', [{
        intent: `${bundleId}/${opts.activity}`,
      }]);
      return;
    }
    await this.hub.execute(sessionId, 'mobile: activateApp', [{ appId: bundleId, bundleId }]);
  }

  async terminateApp(bundleId: string): Promise<void> {
    const { sessionId } = this.session();
    await this.hub.execute(sessionId, 'mobile: terminateApp', [{ appId: bundleId, bundleId }]);
  }

  async listApps(): Promise<AppInfo[]> {
    // TestingBot has no app-enumeration channel; the foreground app is the
    // only one that can be reported reliably (documented limitation).
    try {
      return [await this.getForegroundApp()];
    } catch {
      return [];
    }
  }

  async getForegroundApp(): Promise<AppInfo> {
    const { sessionId, platform } = this.session();
    if (platform === 'ios') {
      const info = await this.hub.execute<{ bundleId: string; name?: string }>(sessionId, 'mobile: activeAppInfo', []);
      return { bundleId: info.bundleId, name: info.name };
    }
    try {
      const pkg = await this.hub.execute<string>(sessionId, 'mobile: getCurrentPackage', []);
      return { bundleId: pkg };
    } catch {
      // Older UiAutomator2 versions only expose the legacy endpoint.
      const pkg = await this.hub.get<string>(sessionId, '/appium/device/current_package');
      return { bundleId: pkg };
    }
  }

  async installApp(path: string): Promise<void> {
    // TestingBot has no mid-session install: the app was already installed
    // at allocation time via appium:app (declared in the driver's `apps`
    // option). This call only verifies the request matches that app.
    const session = this.session();
    const declared = appForCriteria(
      { platform: session.platform, deviceType: session.deviceType },
      this.options.apps,
    );
    if (declared && (isRemoteApp(declared) || await sameFileContents(declared, path))) {
      debug('installApp(%s): already installed at allocation via appium:app, skipping', path);
      return;
    }
    throw new Error(
      `TestingBotDriver cannot install "${path}" mid-session: TestingBot sessions start with the ` +
      "app declared in the driver's `apps` option and support no later installs. " +
      (declared
        ? `The session was started with "${declared}" instead — point installApps and apps at the same build.`
        : "Declare it when constructing the driver: new TestingBotDriver({ apps: { " +
          `'${session.platform}${session.deviceType ? `-${session.deviceType}` : ''}': '${path}' } }).`),
    );
  }

  async uninstallApp(bundleId: string): Promise<void> {
    const { sessionId } = this.session();
    await this.hub.execute(sessionId, 'mobile: removeApp', [{ appId: bundleId, bundleId }]);
  }

  // ─── MobilewrightSession: device ───────────────────────────────

  async listDevices(opts?: ListDevicesOptions): Promise<DeviceInfo[]> {
    requireCredentials(this.options);
    const devices = await this.catalog.listDevices(opts?.platform);
    return opts?.state ? devices.filter((d) => d.state === opts.state) : devices;
  }

  async openUrl(url: string): Promise<void> {
    const { sessionId, platform } = this.session();
    if (platform === 'android') {
      await this.hub.execute(sessionId, 'mobile: deepLink', [{ url }]);
      return;
    }
    // XCUITest has no universal deep-link command; Safari via the WebDriver
    // url endpoint is the broadest fallback.
    try {
      await this.hub.execute(sessionId, 'mobile: deepLink', [{ url }]);
    } catch {
      await this.hub.post(sessionId, '/url', { url });
    }
  }

  // ─── MobilewrightSession: recording ────────────────────────────

  async startRecording(_opts: RecordingOptions): Promise<void> {
    // TestingBot records every session (tb:options.screenrecorder is enabled
    // by default in buildCapabilities); nothing to start.
  }

  async stopRecording(): Promise<RecordingResult> {
    const { sessionId } = this.session();
    // The video asset finalizes after the session ends; return what we can.
    try {
      const test = await this.api.getTest(sessionId);
      if (typeof test.video === 'string' && test.video) {
        return { status: 'success', url: test.video, duration: test.duration };
      }
    } catch {
      // fall through to the dashboard link
    }
    return { status: 'pending', url: `https://testingbot.com/members/tests/${sessionId}` };
  }

  // ─── internals ─────────────────────────────────────────────────

  private session(): ActiveSession {
    if (!this.active) throw new SessionNotActiveError();
    return this.active;
  }

  private unpin(name: string): void {
    const count = this.pinCounts.get(name) ?? 0;
    if (count <= 1) this.pinCounts.delete(name);
    else this.pinCounts.set(name, count - 1);
  }
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

/** Values usable directly as appium:app without an upload. */
function isRemoteApp(value: string): boolean {
  return /^(tb|https?):\/\//i.test(value);
}

/** Whether two local files hold the same bytes (path shortcut first). */
async function sameFileContents(a: string, b: string): Promise<boolean> {
  const { resolve } = await import('node:path');
  if (resolve(a) === resolve(b)) return true;
  try {
    const { readFile } = await import('node:fs/promises');
    const [dataA, dataB] = await Promise.all([readFile(a), readFile(b)]);
    return dataA.equals(dataB);
  } catch {
    return false;
  }
}

function findFocused(nodes: ViewNode[]): ViewNode | undefined {
  for (const node of nodes) {
    if (node.isFocused) return node;
    const inChildren = findFocused(node.children);
    if (inChildren) return inChildren;
  }
  return undefined;
}
