import { expect, test } from '@mobilewright/test';

const pngSize = (b: Buffer) => ({ width: b.readUInt32BE(16), height: b.readUInt32BE(20) });

test('hierarchy polling speed', async ({ device }) => {
  const driver = device.driver;
  await driver.getViewHierarchy(); // warm-up
  const times: number[] = [];
  for (let i = 0; i < 10; i++) {
    const t = Date.now();
    await driver.getViewHierarchy();
    times.push(Date.now() - t);
  }
  times.sort((a, b) => a - b);
  console.log(`[timing] tuning=${process.env['E2E_NO_TUNING'] === '1' ? 'off' : 'on'} median=${times[5]}ms min=${times[0]}ms max=${times[9]}ms all=${times.join(',')}`);
});

test('fill both inputs and read the sum', async ({ screen, platform }) => {
  await screen.getByLabel('inputA').fill('12');
  await screen.getByLabel('inputB').fill('30');
  if (platform === 'android') await screen.goBack(); // tall keyboards hide the sum field
  const sum = screen.getByLabel('sum');
  if (platform === 'ios') await expect(screen.getByType('XCUIElementTypeTextField').nth(2)).toHaveValue('42');
  else await expect(sum).toHaveText('42');
});

test('element screenshot is cropped to the element', async ({ device, screen }) => {
  const full = await screen.screenshot();
  const el = await screen.getByLabel('inputA').screenshot();
  const size = await device.driver.getScreenSize();
  const node = (await device.driver.getViewHierarchy());
  const find = (ns: any[]): any => ns.flatMap((n) => [n, ...[find(n.children ?? [])].flat()]);
  const target = find(node).filter(Boolean).find((n: any) => n.label === 'inputA');
  console.log(`[clip] full=${JSON.stringify(pngSize(full))} element=${JSON.stringify(pngSize(el))} bounds=${JSON.stringify(target?.bounds)} scale=${size.scale}`);
  expect(pngSize(el).width).toBeLessThan(pngSize(full).width / 2);
  expect(Math.abs(pngSize(el).width - Math.round(target.bounds.width * size.scale))).toBeLessThanOrEqual(2);
  expect(Math.abs(pngSize(el).height - Math.round(target.bounds.height * size.scale))).toBeLessThanOrEqual(2);
  const half = await screen.screenshot({ scale: 0.5 });
  expect(Math.abs(pngSize(half).width - pngSize(full).width / 2)).toBeLessThanOrEqual(1);
});

test('goBack navigates back on iOS (Settings app)', async ({ device, screen, platform }) => {
  test.skip(platform !== 'ios', 'iOS-only: Android BACK is a key event');
  await device.launchApp('com.apple.Preferences');
  await screen.getByText('General', { exact: true }).tap();
  await expect(screen.getByText('About', { exact: true })).toBeVisible();
  await screen.goBack();
  await expect(screen.getByText('About', { exact: true })).not.toBeVisible();
  await expect(screen.getByText('General', { exact: true })).toBeVisible();
});
