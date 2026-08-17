# @testingbot/mobilewright-driver

Run [Mobilewright](https://github.com/mobile-next/mobilewright) mobile tests on [TestingBot](https://testingbot.com)'s device cloud — real iOS/Android devices, iOS simulators, and Android emulators.

Requires `mobilewright >= 0.0.53` (the first release that accepts driver instances) and Node >= 18.

## Quickstart

**One command:**

```bash
npx @testingbot/mobilewright-driver init
```

answers a few questions and writes `mobilewright.config.ts` plus a sample
test (add `--yes` for defaults). Or set up manually:

**1. Install** (in your test project):

```bash
npm install --save-dev mobilewright @mobilewright/test @testingbot/mobilewright-driver
```

**2. Get your credentials** from [testingbot.com/members/user/edit](https://testingbot.com/members/user/edit):

```bash
export TESTINGBOT_KEY=...
export TESTINGBOT_SECRET=...
```

**3. Create `mobilewright.config.ts`:**

```ts
import { defineConfig } from 'mobilewright';
import { TestingBotDriver } from '@testingbot/mobilewright-driver';

export default defineConfig({
  testDir: '.',
  bundleId: 'com.example.MyApp',
  driver: new TestingBotDriver({
    // TestingBot sessions start with the app pre-installed — declare it here.
    // Local paths (.apk / .ipa / simulator .zip) upload automatically.
    apps: {
      // A single path, or an array whose first entry is the app under test
      // and the rest install alongside it (e.g. a mock server or test harness).
      android: './build/app.apk',
      'ios-simulator': './build/app-sim.zip',
      'ios-real': './build/app.ipa', // must be test-signed for real devices
    },
  }),
  projects: [
    { name: 'android', use: { platform: 'android', deviceType: 'emulator' } },
    { name: 'ios', use: { platform: 'ios', deviceType: 'real', osVersion: '>=17' } },
  ],
});
```

**4. Write a test** (`app.test.ts`):

```ts
import { test, expect } from '@mobilewright/test';

test('shows the welcome screen', async ({ device, screen, bundleId }) => {
  await device.launchApp(bundleId);
  await expect(screen.getByText('Welcome')).toBeVisible();
});
```

**5. Run:**

```bash
npx mobilewright test
```

Each device slot maps to a TestingBot session on your [dashboard](https://testingbot.com/members), with video and pass/fail reported automatically. Prefix with `DEBUG=testingbot:*` to see everything the driver does.

## Selecting devices

Device selection comes from the mobilewright project config (`use` block):

| Key | Example | Notes |
| --- | --- | --- |
| `platform` | `'ios'` \| `'android'` | required |
| `deviceType` | `'real'` \| `'simulator'` \| `'emulator'` | default: virtual device |
| `deviceName` | `/iPhone 1[45]/`, `/pixel/i` | regex, matched against TestingBot's device catalogs |
| `osVersion` | `'17'`, `'17.4'`, `'>=16 <18'` | exact, prefix, or range expression |
| `deviceId` | `'2241'` | pin one specific physical device (id from `GET /v1/devices`) |

Regexes and version ranges work on both real and virtual devices: real devices resolve against the live physical catalog (`/v1/devices` — idle devices preferred; if the chosen device is busy, TestingBot queues the session until it frees up), virtual ones against the simulator/emulator catalog (`/v1/browsers`, newest matching OS version wins).

## Sessions, naming, and reporting

- By default a device slot's TestingBot session is reused across tests (fast: you pay device startup once). Sessions that hosted exactly one test are named after that test with its own pass/fail; sessions that hosted several get a run summary (e.g. `12/12 tests passed`).
- Set **`sessionPerTest: true`** for one session, video, and named verdict **per test** — the clearest dashboard, at the cost of device startup on every test.
- Failure messages are reported to the session's status message; `build` groups sessions on the dashboard and **defaults automatically from CI environments** (GitHub Actions, GitLab, CircleCI, Buildkite, Bitrise, Travis, Azure DevOps, Jenkins, TeamCity → e.g. `owner/repo #123`), or from a `TESTINGBOT_BUILD` variable.

## All options

```ts
new TestingBotDriver({
  apps: { android: './build/app.apk' }, // app under test, most specific key wins
                                        // ('ios-real' beats 'ios'); tb:// URLs allowed.
                                        // Array = app under test first, helper apps after:
                                        //   android: ['./app.apk', './mock-server.apk']
  key: '...',                 // default: TESTINGBOT_KEY env
  secret: '...',              // default: TESTINGBOT_SECRET env
  sessionPerTest: false,      // true = fresh session (and video) per test
  name: 'checkout flow',      // session name (default 'mobilewright'; per-test names override)
  build: 'ci-1234',           // default: auto-detected from CI env / TESTINGBOT_BUILD
  testResults: 'on',          // 'off' disables pass/fail reporting

  allocationTimeout: 395_000, // ms to wait for a device (TestingBot queues busy devices)
  idleTimeout: 230,           // seconds before TestingBot reaps an idle session
  maxDuration: 1800,          // max session length in seconds
  appiumVersion: 'latest',    // pin the Appium version TestingBot uses

  timeZone: 'Europe/Brussels',   // device timezone (tz database name)
  geoCountryCode: 'DE',          // route device traffic via a proxy in this country
  throttleNetwork: '3G',         // or { downloadSpeed, uploadSpeed, latency, loss }
  autoGrantPermissions: true,    // Android: auto-grant app permission dialogs
  autoAcceptAlerts: true,        // iOS: auto-accept system permission alerts
  screenshots: true,             // screenshot at every step (default false)
  video: true,                   // session video (default true)
  recordLogs: 'strip-parameters',// command logs: true | false | 'strip-parameters'
  public: false,                 // make results publicly accessible
  extra: 'commit=abc123',        // custom metadata on the test detail page
  tabletOnly: false,             // restrict allocation to tablets
  phoneOnly: false,              // ...or to phones

  capabilities: {},           // extra Appium capabilities (escape hatch)
  tbOptions: {},              // extra tb:options entries (escape hatch)
});
```

## TestingBot commands inside tests

Some TestingBot features are runtime commands rather than session
capabilities. Import the `testingbot` helper and call them from a test body —
it targets the device session mobilewright connected for that test:

```ts
import { test, expect } from '@mobilewright/test';
import { testingbot } from '@testingbot/mobilewright-driver';

test('checkout survives a slow network', async ({ device, screen, bundleId }) => {
  await device.launchApp(bundleId);

  await testingbot.annotate('starting checkout');   // shows in the session timeline
  await testingbot.throttle('3G');
  await expect(screen.getByText('Order placed')).toBeVisible();

  console.log(testingbot.dashboardUrl());
});
```

### Available commands

| Command | TestingBot command | What it does |
| --- | --- | --- |
| `throttle(conditions)` | `tb:throttle` | Network conditions mid-test: `'Edge'`, `'3G'`, `'4G'`, `'airplane'`, `'disable'`, or `{ downloadSpeed, uploadSpeed, latency, loss }` (kb/s, ms). Reset automatically at the end of the test. |
| `annotate(text)` | `tb:test-context` | Logs a step into the session's command list, so the timeline shows what the test was doing. |
| `setName(name)` | `tb:test-name` | Names the session on the dashboard. |
| `setBuild(build)` | `tb:test-build` | Groups the session under a build. |
| `setTags([...])` | `tb:test-tags` | Tags the session. |
| `setResult(passed)` | `tb:test-result` | Overrides the pass/fail verdict (the driver reports it automatically — use this only for outcomes mobilewright cannot see). |
| `updateInfo({...})` | `tb:test-info` | Bulk update: `name`, `build`, `public`, `statusMessage`, `extra`. |
| `breakpoint()` | `tb:break` | Pauses the session for manual inspection with a live view. Debugging only — never leave it in CI. |
| `shell(command, args)` | `mobile: shell` | ADB shell on Android (whitelisted subset on physical devices). |
| `execute(script, ...args)` | any | Escape hatch for any Appium or TestingBot execute-script command. |
| `sessionId()` / `dashboardUrl()` | — | This test's TestingBot session id and dashboard link. |

Notes:

- **Throttling is reset automatically** when the test's device session is
  released, so slow-network conditions never leak into the next test that
  reuses the device.
- Calling a command outside a test body raises an explanatory error rather
  than a null-reference.
- `tb:intercept` and `tb:network` (request mocking and network logs) are
  Chrome/Edge-only on TestingBot and are therefore not exposed here.

### Recipe: name every session after its test

```ts
test.beforeEach(async ({ device }, testInfo) => {
  await testingbot.setName(testInfo.title);
  await testingbot.setTags([testInfo.project.name]);
});
```

Requesting the `device` fixture is what makes the session exist before the
hook runs. With `sessionPerTest: true` each session gets exactly one name;
in pooled mode the last test to run on a session wins (the driver still
reports per-test verdicts afterwards — see above).

## Testing localhost / staging servers (TestingBot Tunnel)

Either run a [TestingBot Tunnel](https://testingbot.com/support/tunnel) yourself and pass its identifier:

```ts
driver: new TestingBotDriver({ tunnelIdentifier: 'my-tunnel' })
```

or let the driver manage one around the run (requires Java and `npm install --save-dev testingbot-tunnel-launcher`):

```ts
driver: new TestingBotDriver({ tunnel: true })                    // anonymous tunnel
driver: new TestingBotDriver({ tunnel: { identifier: 'ci-42' } }) // named tunnel
```

The driver starts the tunnel before any device is allocated and closes it after the run.

## Running in CI (GitHub Actions example)

```yaml
jobs:
  mobile-tests:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: npm }
      - run: npm ci
      - run: npx mobilewright test
        env:
          TESTINGBOT_KEY: ${{ secrets.TESTINGBOT_KEY }}
          TESTINGBOT_SECRET: ${{ secrets.TESTINGBOT_SECRET }}
          # build name auto-detects as "owner/repo #run" — no config needed
```

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| `TestingBot credentials are missing` | Set `TESTINGBOT_KEY` / `TESTINGBOT_SECRET`, or pass `{ key, secret }`. |
| `TestingBot sessions must start with an app` | Declare the app in the driver's `apps` option (per platform / device type). |
| `No TestingBot real device matches ...` / `No TestingBot simulator matches ...` | The criteria matched nothing in the catalog — check [available devices](https://testingbot.com/support/devices), loosen `osVersion`/`deviceName`. |
| Allocation waits for minutes | The matching device is busy; TestingBot queues the session until it frees up (bounded by `allocationTimeout`). |
| `Test timeout ... while setting up "device"` | More `workers` than your plan's parallel limit: TestingBot queues up to 2× the limit server-side and the driver waits out the rest, all inside the test-scoped device fixture. The driver warns with your plan's number — set `workers` to at most that, or raise the mobilewright `timeout`. |
| `... is a simulator-only build and cannot be installed on a real device` | Build a test-signed `.ipa` for `deviceType: 'real'` projects. |
| `"..." is not installed on this device` | The config's `bundleId` is not the package id of the build in `apps` (check with `aapt2 dump packagename app.apk`), or a stale `bundleId`/env override is in play. |
| `cannot install "..." mid-session` | TestingBot has no mid-session installs — every app in `installApps` must also be listed in the driver's `apps` option (first entry = app under test, the rest install as helper apps). |
| Modifier chords fail on iOS | XCUITest cannot hold modifier keys; chords are Android-only (`clearText()` handles iOS differently). |
| Sessions show the run summary instead of a test name | The session hosted several tests; use `sessionPerTest: true` for guaranteed per-test naming. |
| `DEBUG=testingbot:*` | Prints every allocation, hub command, upload, and report the driver performs. |

## How it maps to TestingBot

| mobilewright concept | TestingBot implementation |
| --- | --- |
| device allocation | Appium session on `hub.testingbot.com` (the session UUID is the device id); busy devices queue server-side |
| app install | uploaded to TestingBot storage at allocation time and passed as `appium:app`, helper apps as `appium:otherApps` (re-signed automatically for real iOS) — no mid-session installs |
| taps/swipes/gestures | W3C pointer actions |
| view hierarchy | Appium page source, mapped to mobilewright's `ViewNode` tree |
| webviews | Appium contexts (`webViewBridge`) |
| pass/fail reporting | `PUT /v1/tests/:session` via the `TestObserver` hooks |
| video | recorded by TestingBot; `startRecording({ output })` downloads the MP4 locally at run end |

## Current limitations

- One TestingBot session may host several mobilewright tests unless `sessionPerTest: true`; multi-test sessions report the run-level verdict.
- Modifier key chords (`pressKeys(['ctrl+a'])`) work on Android only — XCUITest cannot hold modifier keys.
- `pressButton` on iOS supports `HOME`, `VOLUME_UP`, `VOLUME_DOWN`; `listApps()` reports the foreground app only.
- Screenshots are always PNG. `applyDeviceSettings` turns Android animations off best-effort via `mobile: shell` (a no-op on iOS).
- Real iOS devices need a test-signed `.ipa`; simulator builds are rejected on real devices with a clear error.
- While attached to a webview, the session's single Appium context is the web layer.

## Development

```bash
npm install
npm test          # unit + FakeHub integration tests (no credentials needed)
npm run build
```

Live e2e tests against a real TestingBot account live in `e2e/` (see `e2e/mobilewright.config.ts`).

## License

Apache-2.0
