import { expect, test } from '@mobilewright/test';
import { testingbot } from '@testingbot/mobilewright-driver';

// E2E_DEFECT_REPRO=1 runs the sessionPerTest attribution check: one passing
// test followed by one failing test, each in its own TestingBot session.
//
// The defect (reported 2026-08-25, fixed in v0.3.0): the PASSING test's
// session was reported as failed, carrying the run aggregate ("1 of 2 tests
// failed. ...") and the generic name "mobilewright" instead of its own
// verdict. Intermittent — it fired once in three live runs.
//
// The session ids are printed so the run can be checked against the API,
// which is the only source of truth here: the runner prints the right thing
// even when the reporting is wrong.
if (process.env['E2E_DEFECT_REPRO'] === '1') {
  test('passes', async ({ device, screen, bundleId }) => {
    await device.launchApp(bundleId);
    console.log(`REPRO_SESSION passes=${testingbot.sessionId()}`);
    await screen.screenshot();
  });

  test('fails on purpose', async ({ device, screen, bundleId }) => {
    await device.launchApp(bundleId);
    console.log(`REPRO_SESSION fails on purpose=${testingbot.sessionId()}`);
    await expect(screen.getByText('ThisTextDoesNotExistAnywhere')).toBeVisible({ timeout: 5_000 });
  });
}
