import { expect, test } from '@mobilewright/test';

test('app launches and shows its main screen', async ({ device, screen, bundleId }) => {
  await device.launchApp(bundleId);
  // The milliways sample greets with its title; adjust for your own app.
  await expect(screen.getByText('Milliways', { exact: false })).toBeVisible();
  await screen.screenshot();
});

test('taps land where the hierarchy says they should', async ({ device, screen, bundleId }) => {
  await device.launchApp(bundleId);
  const button = screen.getByRole('button').nth(0);
  await expect(button).toBeVisible();
  await button.tap();
});
