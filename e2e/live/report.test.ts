import { expect, test } from '@mobilewright/test';

test.describe('reporting', () => {
  test('passes', async ({ screen }) => {
    await expect(screen.getByLabel('inputA').first()).toBeVisible();
  });
  test('fails on purpose', async ({ screen }) => {
    test.skip(process.env['E2E_FORCE_FAIL'] !== '1', 'only with E2E_FORCE_FAIL=1');
    await expect(screen.getByText('This text does not exist')).toBeVisible({ timeout: 3_000 });
  });
});
