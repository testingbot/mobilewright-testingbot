# Changelog

## 0.4.0 — 2026-09-07

Tracks `@mobilewright/protocol` 0.0.56.

### Added
- `setGeolocation(geolocation | null)` — required by `MobilewrightSession` as of
  protocol 0.0.56. Routed through the platform drivers' own extensions
  (`mobile: setGeolocation` / `mobile: resetGeolocation` on UiAutomator2,
  `mobile: setSimulatedLocation` / `mobile: clearSimulatedLocation` on XCUITest)
  rather than the deprecated, Android-only `/location` endpoint. Emulators and
  simulators always support it; real devices depend on the OS version
  TestingBot's Appium build covers (iOS 17+ for XCUITest).
- `testingbotDriver({ ... })` — a factory equivalent to
  `new TestingBotDriver({ ... })`, for config files that read better as
  configuration. The constructor is unchanged.
- The `Geolocation` type is exported. It is declared locally rather than
  re-exported from the protocol: the type does not exist in 0.0.53, the floor
  of the supported peer range, and the shape is identical.

### Changed
- **Node floor raised to 20.19** (from 18), matching `mobilewright`'s own
  `engines.node` since 0.0.56. Nothing in this package needed the bump; it was
  already unreachable to run the driver on Node 18.

### Known gaps
- `ScreenshotOptions.clip`, also new in protocol 0.0.56, is not honoured —
  `screenshot({ clip })` returns the full screen uncropped. TestingBot returns a
  whole-screen PNG with no server-side crop, so supporting it means cropping
  client-side.

## 0.3.1 — 2026-08-25

- Fix the `init` scaffold emitting a config that failed to typecheck under
  strict TypeScript.
- Add the `sessionPerTest` attribution repro to the e2e harness.

(0.3.0 was tagged but never published; its change is listed below.)

## 0.3.0 — 2026-08-25

### Fixed
- **Session-to-test attribution.** A passing test's session could be reported
  with the run-level verdict: any session the observer could not join to a test
  fell through to the run aggregate. Sessions are now attributed by *worker
  identity* — Playwright's worker index, visible to both the worker process and
  the run report — with timing used only to break ties within a worker. A
  session that still cannot be attributed gets its build, tags and extra data
  but **no** verdict; the driver abstains rather than name a session after the
  wrong test. Every abstention is logged under `DEBUG=testingbot:observer`.

  Verified over 11 live runs, including concurrent ones where one worker's
  session ran entirely inside another worker's window and timing alone was
  genuinely ambiguous.

## 0.2.0 — 2026-08-17

First substantive public release.

### Devices and sessions
- Device allocation as an Appium session on `hub.testingbot.com`; the session
  UUID is the pool's device id and workers re-attach to it by id. Busy devices
  queue server-side.
- Virtual-device criteria (`deviceName` patterns, `osVersion` ranges) resolved
  against the `/v1/browsers` catalog; real devices picked from the full device
  list, preferring idle ones.
- Allocation aligned with the hub's queueing model, including the plan's
  parallel-plus-queue cap classified as retriable, and a warning when a run asks
  for more parallel sessions than the plan allows.
- `sessionPerTest: true` for a fresh TestingBot session per test.
- Driver-managed TestingBot Local tunnels (`tunnel: true`, or a named tunnel).

### Apps
- Apps declared per platform slot and uploaded to TestingBot storage at
  allocation time, passed as `appium:app`; helper apps via `appium:otherApps`.
  Uploads are deduplicated by sha256 within a run.
- Launch failures are diagnosed: a bundle id that is simply not installed is
  distinguished from a genuinely missing launcher activity.

### Reporting
- A bundled `TestObserver`: session names, pass/fail, build, and git metadata
  (commit, branch, author, subject) pushed to TestingBot; session videos
  downloaded to `RecordingOptions.output` at run end.
- TestingBot runtime commands available inside tests via the `testingbot`
  helper (`throttle`, `shell`, `setName`, `setBuild`, `setTags`, `setResult`,
  `annotate`, `updateInfo`, `breakpoint`, `execute`).

### Other
- `webViewBridge` over Appium contexts.
- `npx @testingbot/mobilewright-driver init` scaffolder.
- Published via npm trusted publishing (OIDC) — no publish token anywhere.

## 0.1.0 — 2026-08-17

Initial release: allocation via Appium sessions, app install carried in the
session capabilities, and observer-based reporting.
