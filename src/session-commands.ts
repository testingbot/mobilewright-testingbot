import type { TestingBotDriver } from './driver.js';

/**
 * The driver instance currently connected in THIS process. mobilewright loads
 * `mobilewright.config.ts` in every worker and connects the driver instance it
 * exports, and test files run in that same worker process — so tests can reach
 * the live session through this registry without mobilewright needing to pass
 * the driver through its fixtures. Workers are single-test-at-a-time, so one
 * slot is enough; parallel workers are separate processes with their own.
 */
let active: TestingBotDriver | undefined;

/** @internal — called by TestingBotDriver.connect()/disconnect(). */
export function setActiveDriver(driver: TestingBotDriver | undefined): void {
  active = driver;
}

function requireActive(command: string): TestingBotDriver {
  if (!active) {
    throw new Error(
      `TestingBot: ${command} needs a connected device session. Call it inside a test body ` +
      '(mobilewright connects the device before the test runs), not at module scope.',
    );
  }
  return active;
}

/** Network conditions accepted by `testingbot.throttle()`. */
export type ThrottlePreset = 'Edge' | '3G' | '4G' | 'airplane' | 'disable';
export interface ThrottleProfile {
  downloadSpeed?: number;
  uploadSpeed?: number;
  latency?: number;
  loss?: number;
  disable?: boolean;
}

/**
 * TestingBot-specific commands, callable from inside a mobilewright test:
 *
 *   import { testingbot } from '@testingbot/mobilewright-driver';
 *   await testingbot.throttle('3G');
 */
export const testingbot = {
  /**
   * Change network conditions mid-test (`tb:throttle`). Pass a preset
   * ("Edge", "3G", "4G", "airplane", "disable") or a custom profile.
   * Throttling is reset automatically when the test's device session is
   * released, so it cannot leak into the next test on a pooled device.
   */
  async throttle(conditions: ThrottlePreset | ThrottleProfile): Promise<void> {
    await requireActive('throttle()').throttle(conditions);
  },

  /**
   * Run an ADB shell command on Android (`mobile: shell`). Physical devices
   * allow a whitelisted subset (am/pm/input/getprop/settings/dumpsys, ...);
   * emulators allow everything.
   */
  async shell<T = unknown>(command: string, args: string[] = []): Promise<T> {
    return await requireActive('shell()').executeScript<T>('mobile: shell', { command, args });
  },

  /**
   * Name this session on the TestingBot dashboard (`tb:test-name`). Useful
   * per test — see the README recipe for naming every session from a
   * `beforeEach`. In pooled mode the last test to run on a session wins.
   */
  async setName(name: string): Promise<void> {
    await requireActive('setName()').executeScript(`tb:test-name=${oneLine(name)}`);
  },

  /** Group this session under a build on the dashboard (`tb:test-build`). */
  async setBuild(build: string): Promise<void> {
    await requireActive('setBuild()').executeScript(`tb:test-build=${oneLine(build)}`);
  },

  /** Tag this session (`tb:test-tags`). */
  async setTags(tags: string[]): Promise<void> {
    await requireActive('setTags()').executeScript(`tb:test-tags=${tags.map(oneLine).join(',')}`);
  },

  /**
   * Mark the session passed or failed (`tb:test-result`). The driver already
   * reports the run's verdict automatically — use this only to override it,
   * e.g. to fail a session for a reason mobilewright cannot see.
   */
  async setResult(passed: boolean | 'passed' | 'failed'): Promise<void> {
    const value = typeof passed === 'string' ? passed : (passed ? 'passed' : 'failed');
    await requireActive('setResult()').executeScript(`tb:test-result=${value}`);
  },

  /**
   * Log a step into the session's command list (`tb:test-context`), so the
   * TestingBot timeline shows what the test was doing at that point.
   */
  async annotate(context: string): Promise<void> {
    await requireActive('annotate()').executeScript(`tb:test-context=${oneLine(context)}`);
  },

  /** Update several session fields at once (`tb:test-info`). */
  async updateInfo(info: {
    name?: string;
    build?: string;
    public?: boolean;
    statusMessage?: string;
    extra?: string;
  }): Promise<void> {
    const payload: Record<string, unknown> = {};
    if (info.name !== undefined) payload['name'] = oneLine(info.name);
    if (info.build !== undefined) payload['build'] = oneLine(info.build);
    if (info.public !== undefined) payload['public'] = info.public;
    // The hub decodeURIComponent()s these two — send them encoded so a stray
    // '%' in the text cannot make the whole update throw server-side.
    if (info.statusMessage !== undefined) payload['status_message'] = encodeURIComponent(info.statusMessage);
    if (info.extra !== undefined) payload['extra'] = encodeURIComponent(info.extra);
    await requireActive('updateInfo()').executeScript(`tb:test-info=${JSON.stringify(payload)}`);
  },

  /**
   * Pause the session for manual inspection (`tb:break`) — the test result
   * page offers a live view with mouse/keyboard control. Debugging only: it
   * blocks until you resume, so never leave it in CI.
   */
  async breakpoint(): Promise<void> {
    await requireActive('breakpoint()').executeScript('tb:break');
  },

  /** Escape hatch: run any Appium or TestingBot execute-script command. */
  async execute<T = unknown>(script: string, ...args: unknown[]): Promise<T> {
    return await requireActive('execute()').executeScript<T>(script, ...args);
  },

  /** WebDriver session id of the device this test is running on. */
  sessionId(): string {
    return requireActive('sessionId()').currentSessionId();
  },

  /** Link to this test's session on the TestingBot dashboard. */
  dashboardUrl(): string {
    return `https://testingbot.com/members/tests/${this.sessionId()}`;
  },
};

/** tb: commands are string-encoded, so newlines would corrupt the payload. */
function oneLine(value: string): string {
  return value.replace(/\s*\n\s*/g, ' ').trim();
}
