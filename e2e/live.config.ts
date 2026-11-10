import { defineConfig } from 'mobilewright';
import { TestingBotDriver } from '@testingbot/mobilewright-driver';

/**
 * Production feature checks against TestingBot's public sample app (a React
 * Native calculator). Needs TESTINGBOT_KEY / TESTINGBOT_SECRET.
 *   npx mobilewright test -c live.config.ts --project android-emulator
 */
const ANDROID_APP = 'https://testingbot.com/appium/sample.apk';
const IOS_SIM_APP = 'https://testingbot.com/appium/sample.zip';

export default defineConfig({
  testDir: './live',
  timeout: 300_000,
  retries: Number(process.env['E2E_RETRIES'] ?? 0),
  workers: Number(process.env['E2E_WORKERS'] ?? 1),
  use: { actionTimeout: 30_000 },
  expect: { timeout: 30_000 },
  driver: new TestingBotDriver({
    build: `mobilewright-live-${new Date().toISOString().slice(0, 10)}`,
    sessionPerTest: process.env['E2E_SESSION_PER_TEST'] === '1',
    apps: { android: ANDROID_APP, 'ios-simulator': IOS_SIM_APP },
    ...(process.env['E2E_NO_TUNING'] === '1' ? { snapshotTuning: false as const } : {}),
    ...(process.env['E2E_VISIBILITY'] === 'bounds' ? { visibility: 'bounds' as const } : {}),
  }),
  projects: [
    { name: 'android-emulator', use: { platform: 'android', deviceType: 'emulator', bundleId: 'com.sampleapp' } },
    { name: 'android-real', use: { platform: 'android', deviceType: 'real', osVersion: '>=12', bundleId: 'com.sampleapp' } },
    { name: 'android-galaxy', use: { platform: 'android', deviceType: 'real', deviceName: /^Galaxy S2[345]$/, bundleId: 'com.sampleapp' } },
    { name: 'ios-simulator', use: { platform: 'ios', deviceType: 'simulator', bundleId: 'org.reactjs.native.example.SampleApp' } },
  ],
  reporter: [['list'], ['json', { outputFile: 'live-report.json' }], ['html', { outputFolder: 'live-html', open: 'never' }]],
});
