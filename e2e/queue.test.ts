import { expect, test } from '@mobilewright/test';

// E2E_QUEUE=1 enables 20 quick tests for the over-parallelism soak:
// run with E2E_WORKERS=20 against a plan whose parallel limit is 1 to watch
// the hub queue POST /session per slot while tests drain through the limit.
if (process.env['E2E_QUEUE'] === '1') {
  for (let i = 1; i <= 20; i++) {
    test(`queue drain #${String(i).padStart(2, '0')}`, async ({ device, screen, bundleId }) => {
      await device.launchApp(bundleId!);
      await expect(screen.getByText('Milliways', { exact: false })).toBeVisible();
    });
  }
}
