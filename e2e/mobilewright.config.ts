import { defineConfig, type MobilewrightConfig } from 'mobilewright';
import { TestingBotDriver } from '@testingbot/mobilewright-driver';

/**
 * Live e2e config (milliways-style). Needs a real TestingBot account:
 *   TESTINGBOT_KEY=... TESTINGBOT_SECRET=... npx mobilewright test --project android-emulator
 *
 * Build the sample apps from https://github.com/mobile-next/milliways-ios
 * ("make apk" / "make zip" / "make ipa") and point the installApps paths at them.
 */
const config: MobilewrightConfig = {
  testDir: '.',
  timeout: 180_000,
  bundleId: process.env['E2E_BUNDLE_ID'] ?? 'com.mobilenext.Milliways',
  autoAppLaunch: false,
  fullyParallel: true,
  workers: Number(process.env['E2E_WORKERS'] ?? 1),
  driver: new TestingBotDriver({
    build: `mobilewright-e2e-${process.env['GITHUB_RUN_ID'] ?? 'local'}`,
    // E2E_SESSION_PER_TEST=1 -> one TestingBot session/video/verdict per test
    sessionPerTest: process.env['E2E_SESSION_PER_TEST'] === '1',
    // TestingBot sessions must start with the app — same builds as installApps below.
    apps: {
      android: process.env['E2E_APK'] ?? '../milliways/android/build/Milliways.apk',
      'ios-simulator': process.env['E2E_APP_ZIP'] ?? '../milliways/ios/build/Milliways-simulator.zip',
      'ios-real': process.env['E2E_IPA'] ?? '../milliways/ios/build/Milliways.ipa',
    },
  }),
  projects: [
    {
      name: 'android-emulator',
      use: {
        platform: 'android',
        deviceType: 'emulator',
        installApps: [process.env['E2E_APK'] ?? '../milliways/android/build/Milliways.apk'],
      },
    },
    {
      name: 'ios-simulator',
      use: {
        platform: 'ios',
        deviceType: 'simulator',
        installApps: [process.env['E2E_APP_ZIP'] ?? '../milliways/ios/build/Milliways-simulator.zip'],
      },
    },
    {
      name: 'ios-real',
      use: {
        platform: 'ios',
        deviceType: 'real',
        osVersion: '>=17',
        // Real devices need a signed .ipa (the milliways sample ships unsigned).
        installApps: [process.env['E2E_IPA'] ?? '../milliways/ios/build/Milliways.ipa'],
      },
    },
  ],
  reporter: [['list'], ['html', { outputFolder: 'mobilewright-report' }]],
};

export default defineConfig(config);
