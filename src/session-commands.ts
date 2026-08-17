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
