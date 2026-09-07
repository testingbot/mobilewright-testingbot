import { TestingBotDriver } from './driver.js';
import type { TestingBotDriverOptions } from './options.js';

/**
 * Config-file spelling of `new TestingBotDriver({ ... })`:
 *
 *   import { defineConfig } from 'mobilewright';
 *   import { testingbotDriver } from '@testingbot/mobilewright-driver';
 *
 *   export default defineConfig({
 *     driver: testingbotDriver({ apps: { android: './app.apk' } }),
 *   });
 *
 * Identical to the constructor — mobilewright takes the driver as an instance,
 * and this reads like the rest of the config around it.
 */
export function testingbotDriver(options: TestingBotDriverOptions = {}): TestingBotDriver {
  return new TestingBotDriver(options);
}
