import { writeFile } from 'node:fs/promises';
import createDebug from 'debug';
import {
  NoDeviceAvailableError,
  type AllocatedDevice,
  type AllocationCriteria,
  type AppInfo,
  type ConnectionConfig,
  type DeviceInfo,
  type DeviceSettings,
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
import { SessionNotActiveError, toAllocationError, withAllocationContext } from './errors.js';
import { Keepalive } from './keepalive.js';
import { parseChord, toAndroidKeyPress, toW3CKeyActions, typeTextActions } from './keys.js';
import { TestingBotTestObserver } from './observer.js';
import { requireCredentials, resolveOptions, type ResolvedOptions, type TestingBotDriverOptions } from './options.js';
import { RestApiClient } from './rest-api.js';
import { RunLog } from './run-log.js';
import { TunnelManager } from './tunnel.js';
import { AppiumWebViewBridge } from './webview.js';
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
  /** Wall-clock ms of connect(); brackets the test in sessionPerTest mode. */
  connectedAt: number;
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
  /** WebView support via Appium contexts (its presence signals capability). */
  readonly webViewBridge: AppiumWebViewBridge;

  private readonly options: ResolvedOptions;
  private readonly hub: WebDriverClient;
  private readonly api: RestApiClient;
  private readonly catalog: DeviceCatalog;
  private readonly storage: AppStorage;
  private readonly keepalive: Keepalive;
  private readonly runLog: RunLog;
  private readonly tunnel = new TunnelManager();

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
  /** sessionPerTest: pool slots whose original session this instance has already probed/used. */
  private readonly rotatedDeviceIds = new Set<string>();

  constructor(options: TestingBotDriverOptions = {}) {
    this.options = resolveOptions(options);
    this.hub = new WebDriverClient(this.options.hubUrl, this.options.commandTimeout);
    this.api = new RestApiClient(this.options.apiUrl, this.options.key, this.options.secret);
    this.catalog = new DeviceCatalog(this.api);
    this.storage = new AppStorage(this.api);
    this.keepalive = new Keepalive(this.hub);
    this.runLog = new RunLog();
    this.webViewBridge = new AppiumWebViewBridge(this.hub, () => this.session().sessionId);
    this.observer = this.options.testResults === 'off'
      ? undefined
      : new TestingBotTestObserver(this.api, {
        // Union of coordinator-allocated sessions and (with sessionPerTest)
        // the per-test sessions workers logged to the shared run file;
        // a timed worker record wins over the coordinator's untimed one.
        sessions: () => {
          const byId = new Map(
            [...this.everAllocated.keys()].map((sessionId) => [sessionId, { sessionId, spans: 0 }]),
          );
          for (const record of this.runLog.sessions()) byId.set(record.sessionId, record);
          return [...byId.values()];
        },
        build: this.options.build,
        recordings: () => this.runLog.recordings(),
      });
  }

  // ─── DeviceAllocator ────────────────────────────────────────────

  async prepare(): Promise<void> {
    requireCredentials(this.options);
    this.runLog.truncate(); // drop session/app records from any previous run
    await this.api.getUser();
    debug('credentials verified against %s', this.options.apiUrl);
    await this.tunnel.start(this.options);
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
    } else if (criteria.osVersion || criteria.deviceNamePattern) {
      // Virtual devices: resolve osVersion ranges and deviceName regexes
      // against the simulator/emulator catalog (GET /v1/browsers) — the hub's
      // own name matching is not regex-based for virtual devices.
      pinned = await this.catalog.pickVirtualDevice(criteria);
    }

    // TestingBot sessions must start with an app — resolve and upload the
    // configured one now so it can ride along in the allocation caps.
    let appUrl: string | undefined;
    const configuredApp = appForCriteria(criteria, this.options.apps);
    if (configuredApp) {
      appUrl = isRemoteApp(configuredApp)
        ? configuredApp
        : (await this.storage.ensureUploaded(configuredApp, criteria.deviceType)).app_url;
      if (this.options.sessionPerTest && criteria.platform) {
        // Workers rotating sessions per test reuse this upload instead of
        // re-uploading the binary once per worker process.
        this.runLog.append({ type: 'app', platform: criteria.platform, deviceType: criteria.deviceType, url: appUrl });
      }
    }

    const capabilities = buildCapabilities(criteria, this.options, pinned, appUrl);
    debug('allocating: %o', { ...capabilities.alwaysMatch, 'tb:options': '[redacted]' });

    if (signal?.aborted) {
      throw new NoDeviceAvailableError('allocation aborted before it started');
    }

    // POST /session queues inside the hub until a matching device frees up
    // (up to its 390s queue TTL). Aborting the socket is the correct way to
    // give up: the hub's 'aborted' handler removes the pending queue entry,
    // so nothing leaks. The one race — the response arriving just as the
    // pool aborts — is handled by deleting the session that slipped through.
    let sessionId: string;
    let caps: Record<string, unknown>;
    try {
      const controller = new AbortController();
      const onAbort = () => controller.abort();
      signal?.addEventListener('abort', onAbort, { once: true });
      try {
        ({ sessionId, capabilities: caps } = await this.hub.newSession(capabilities, {
          timeout: this.options.allocationTimeout,
          signal: controller.signal,
        }));
      } catch (err) {
        if (signal?.aborted) {
          debug('allocation aborted while queued — hub dropped the pending request');
          throw new NoDeviceAvailableError('allocation aborted');
        }
        throw withAllocationContext(toAllocationError(err), describeAllocation(criteria));
      } finally {
        signal?.removeEventListener('abort', onAbort);
      }
      if (signal?.aborted) {
        debug('allocation resolved as the pool aborted, deleting session %s', sessionId);
        await this.hub.deleteSession(sessionId)
          .catch(() => this.api.stopTest(sessionId).catch(() => { }));
        throw new NoDeviceAvailableError('allocation aborted');
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
    await this.tunnel.stop();
  }

  // ─── MobilewrightSession: connection ───────────────────────────

  async connect(config: ConnectionConfig): Promise<Session> {
    const poolDeviceId = config.deviceId;
    if (!poolDeviceId) {
      throw new Error(
        'TestingBotDriver.connect requires a deviceId (the WebDriver session UUID from allocate()). ' +
        'Run through "mobilewright test" so the device pool allocates first.',
      );
    }
    const timeout = config.timeout ?? this.options.commandTimeout;

    if (!this.options.sessionPerTest) {
      // Liveness probe — also validates the id belongs to a live TB session.
      await this.hub.get(poolDeviceId, '/orientation', { timeout });
      this.active = { sessionId: poolDeviceId, platform: config.platform, deviceType: config.deviceType, connectedAt: Date.now() };
      debug('connected to session %s', poolDeviceId);
      return { deviceId: poolDeviceId, platform: config.platform };
    }

    // sessionPerTest: the first test on this slot uses the session allocate()
    // created; every later connect starts a fresh one (the previous test's
    // session was deleted in disconnect()). The original may also already be
    // gone when another worker process ran the slot's first test — then the
    // probe fails and we rotate too.
    let sessionId: string | undefined;
    if (!this.rotatedDeviceIds.has(poolDeviceId)) {
      try {
        await this.hub.get(poolDeviceId, '/orientation', { timeout });
        sessionId = poolDeviceId;
      } catch {
        debug('slot %s has no live session, starting a fresh one', poolDeviceId);
      }
      this.rotatedDeviceIds.add(poolDeviceId);
    }
    sessionId ??= await this.startFreshSession(config);
    this.active = { sessionId, platform: config.platform, deviceType: config.deviceType, connectedAt: Date.now() };
    debug('connected to session %s (slot %s)', sessionId, poolDeviceId);
    return { deviceId: poolDeviceId, platform: config.platform };
  }

  async disconnect(): Promise<void> {
    const session = this.active;
    this.active = undefined;
    if (!session) return;
    if (!this.options.sessionPerTest) {
      // Soft detach only: the pool re-grants this slot to the next test and
      // ends the session via release(). Still record this test's interval —
      // a pooled session that hosted exactly one test can then be renamed to
      // that test at run end.
      this.runLog.append({
        type: 'session',
        sessionId: session.sessionId,
        startedAt: session.connectedAt,
        endedAt: Date.now(),
      });
      return;
    }
    // sessionPerTest: this test's session ends here; the next connect starts
    // a fresh one. The timed record lets the observer attribute this test's
    // verdict to exactly this session. release()/dispose() failures on the
    // long-gone original pool session are swallowed there.
    this.runLog.append({
      type: 'session',
      sessionId: session.sessionId,
      startedAt: session.connectedAt,
      endedAt: Date.now(),
    });
    await this.hub.deleteSession(session.sessionId)
      .catch(() => this.api.stopTest(session.sessionId).catch(() => { }));
    debug('ended per-test session %s', session.sessionId);
  }

  /** Create a new hub session for this slot from the connect() config. */
  private async startFreshSession(config: ConnectionConfig): Promise<string> {
    const criteria: AllocationCriteria = {
      platform: config.platform,
      deviceType: config.deviceType,
      osVersion: config.osVersion,
      deviceNamePattern: config.deviceName instanceof RegExp ? config.deviceName.source : config.deviceName,
    };
    let pinned: PinnedDevice | undefined;
    if (criteria.deviceType === 'real') {
      pinned = await this.catalog.pickRealDevice(criteria, this.pinCounts);
    } else if (criteria.osVersion || criteria.deviceNamePattern) {
      pinned = await this.catalog.pickVirtualDevice(criteria);
    }
    // Prefer the app the coordinator already uploaded for this platform.
    let appUrl = criteria.platform ? this.runLog.appUrlFor(criteria.platform, criteria.deviceType) : undefined;
    if (!appUrl) {
      const configuredApp = appForCriteria(criteria, this.options.apps);
      if (configuredApp) {
        appUrl = isRemoteApp(configuredApp)
          ? configuredApp
          : (await this.storage.ensureUploaded(configuredApp, criteria.deviceType)).app_url;
      }
    }
    const capabilities = buildCapabilities(criteria, this.options, pinned, appUrl);
    const { sessionId } = await this.hub.newSession(capabilities, { timeout: this.options.allocationTimeout });
    this.runLog.append({ type: 'session', sessionId });
    debug('started per-test session %s — https://testingbot.com/members/tests/%s', sessionId, sessionId);
    return sessionId;
  }

  // ─── MobilewrightSession: device settings ──────────────────────

  /**
   * Best-effort, fire-and-forget per the protocol: Android animation scales
   * via `mobile: shell` (may be unavailable depending on TestingBot's Appium
   * feature flags — failures are logged, never thrown); iOS has no equivalent.
   */
  async applyDeviceSettings(settings: DeviceSettings): Promise<void> {
    const { sessionId, platform } = this.session();
    if (platform !== 'android' || settings.animations === undefined) return;
    const value = settings.animations === 'off' ? '0' : '1';
    for (const key of ['window_animation_scale', 'transition_animation_scale', 'animator_duration_scale']) {
      try {
        await this.hub.execute(sessionId, 'mobile: shell', [{
          command: 'settings',
          args: ['put', 'global', key, value],
        }]);
      } catch (err) {
        debug('applyDeviceSettings: could not set %s (%s)', key, err);
        return; // same failure for the remaining keys — stop early
      }
    }
    debug('animations turned %s', settings.animations);
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

  async startRecording(opts: RecordingOptions): Promise<void> {
    // TestingBot records every session (tb:options.screenrecorder is enabled
    // by default in buildCapabilities); nothing to start. When the caller
    // wants a local file, note the request — the video only finalizes after
    // the session ends, so the observer downloads it at run end.
    if (opts.output) {
      this.runLog.append({ type: 'recording', sessionId: this.session().sessionId, output: opts.output });
    }
  }

  async stopRecording(): Promise<RecordingResult> {
    const { sessionId } = this.session();
    // The video asset finalizes after the session ends; return what we can.
    try {
      const test = await this.api.getTest(sessionId);
      if (typeof test.video === 'string' && test.video) {
        return { status: 'success', url: test.video, duration: test.duration };
      }
      if (test.video === false) {
        return { status: 'disabled' };
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

function describeAllocation(criteria: AllocationCriteria): string {
  const parts = [
    criteria.platform,
    criteria.deviceType,
    criteria.deviceNamePattern && `deviceName /${criteria.deviceNamePattern}/`,
    criteria.osVersion && `osVersion "${criteria.osVersion}"`,
  ].filter(Boolean);
  return parts.length ? parts.join(', ') : 'the requested device';
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
