# @testingbot/mobilewright-driver

Run [Mobilewright](https://github.com/mobile-next/mobilewright) mobile tests on [TestingBot](https://testingbot.com)'s device cloud — real iOS/Android devices, iOS simulators, and Android emulators.

Requires `mobilewright >= 0.0.53` (the first release that accepts driver instances).

## Install

```bash
npm install --save-dev @testingbot/mobilewright-driver
```

## Configure

```ts
// mobilewright.config.ts
import { defineConfig } from 'mobilewright';
import { TestingBotDriver } from '@testingbot/mobilewright-driver';

export default defineConfig({
  testDir: '.',
  bundleId: 'com.example.MyApp',
  driver: new TestingBotDriver({
    // TestingBot sessions start with the app pre-installed, so declare it
    // here (per platform / device type). Local paths upload automatically.
    apps: {
      android: './build/app.apk',
      'ios-real': './build/app.ipa',
    },
  }),
  projects: [
    {
      name: 'android-emulator',
      use: { platform: 'android', deviceType: 'emulator', installApps: ['./build/app.apk'] },
    },
    {
      name: 'ios-real',
      use: { platform: 'ios', deviceType: 'real', osVersion: '>=17', installApps: ['./build/app.ipa'] },
    },
  ],
});
```

```bash
export TESTINGBOT_KEY=...      # https://testingbot.com/members/user/edit
export TESTINGBOT_SECRET=...
npx mobilewright test
```

Each device slot maps to one TestingBot session (visible on your [dashboard](https://testingbot.com/members) with video recording). When the run finishes, the driver reports pass/fail back to TestingBot automatically.

## Options

```ts
new TestingBotDriver({
  apps: {                     // app under test, most specific key wins
    android: './build/app.apk',        // or 'android-emulator' / 'android-real'
    'ios-simulator': './build/app.zip',
    'ios-real': './build/app.ipa',     // or an existing 'tb://...' storage URL
  },
  key: '...',                 // default: TESTINGBOT_KEY env
  secret: '...',              // default: TESTINGBOT_SECRET env
  allocationTimeout: 300_000, // ms to wait for a device
  idleTimeout: 230,           // seconds before TestingBot reaps an idle session
  maxDuration: 1800,          // max session length in seconds
  appiumVersion: 'latest',    // pin the Appium version TestingBot uses
  name: 'checkout flow',      // session name on the dashboard
  build: 'ci-1234',           // build grouping on the dashboard
  testResults: 'on',          // 'off' disables pass/fail reporting
  capabilities: {},           // extra Appium capabilities (escape hatch)
  tbOptions: {},              // extra tb:options entries (escape hatch)
});
```

Device selection comes from your mobilewright project config: `platform`, `deviceType` (`real` | `simulator` | `emulator`), `deviceName` (regex), and `osVersion` (`"17"`, `">=17 <19"` — ranges are resolved against TestingBot's live real-device list).

## How it maps to TestingBot

| mobilewright concept | TestingBot implementation |
| --- | --- |
| device allocation | Appium session on `hub.testingbot.com` (the session UUID is the device id) |
| app install | uploaded to TestingBot storage at allocation time and passed as `appium:app` — TestingBot sessions must start with an app, so there is no mid-session install |
| taps/swipes/gestures | W3C pointer actions |
| view hierarchy | Appium page source, mapped to mobilewright's `ViewNode` tree |
| pass/fail reporting | `PUT /v1/tests/:session` via the `TestObserver` hooks |
| video | recorded by TestingBot automatically |

## Current limitations

- One TestingBot session can host several mobilewright tests (the pool reuses device slots); pass/fail is reported per session as the run-level verdict.
- `osVersion` ranges and `deviceName` regexes are resolved for **real devices** only; simulators/emulators need an exact version or prefix (`"17"`) and a literal device name.
- Modifier key chords (`pressKeys(['ctrl+a'])`) work on Android only — XCUITest cannot hold modifier keys; on iOS, `clearText()` deletes the focused field with backspaces instead.
- `pressButton` on iOS supports `HOME`, `VOLUME_UP`, `VOLUME_DOWN`; `listApps()` reports the foreground app only.
- Screenshots are always PNG; webviews (`webViewBridge`) and `applyDeviceSettings` are not implemented yet.
- Real iOS devices need a signed `.ipa`; simulator builds (`.zip`/`.app`) are rejected on real devices with a clear error.
- The app comes from the driver's `apps` option, installed at session start. A mobilewright `installApps` entry pointing at the same build is verified and skipped; a different binary raises an error (TestingBot supports no mid-session installs).
- `stopRecording()` returns the TestingBot video URL (the file finalizes after the session ends); it does not write a local file.

## Development

```bash
npm install
npm test          # unit + FakeHub integration tests (no credentials needed)
npm run build
```

Live e2e tests against a real TestingBot account live in `e2e/` (see `e2e/mobilewright.config.ts`).

## License

Apache-2.0
