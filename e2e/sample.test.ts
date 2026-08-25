import { expect, test } from '@mobilewright/test';

// E2E_FORCE_FAIL=1 adds a deliberately failing test, to verify the failure
// reaches the TestingBot dashboard as success=0 with the error message.
if (process.env['E2E_FORCE_FAIL'] === '1') {
  test('deliberately fails to verify dashboard reporting', async ({ device, screen, bundleId }) => {
    await device.launchApp(bundleId!);
    await expect(screen.getByText('This text does not exist anywhere')).toBeVisible({ timeout: 5_000 });
  });
}

test('app launches and shows its main screen', async ({ device, screen, bundleId }) => {
  await device.launchApp(bundleId!);
  // The milliways sample greets with its title; adjust for your own app.
  await expect(screen.getByText('Milliways', { exact: false })).toBeVisible();
  await screen.screenshot();
});

test('taps land where the hierarchy says they should', async ({ device, screen, bundleId }) => {
  await device.launchApp(bundleId!);
  const button = screen.getByRole('button').nth(0);
  await expect(button).toBeVisible();
  await button.tap();
});
