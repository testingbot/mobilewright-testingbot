import { expect, test } from '@mobilewright/test';
for (let i = 1; i <= 4; i++) {
  test(`fill-repeat ${i}`, async ({ device, screen, platform }) => {
    const t = Date.now();
    await screen.getByLabel('inputA').fill(String(i * 3));
    await screen.getByLabel('inputB').fill(String(i * 4));
    // Tall keyboards (Samsung) cover the sum field, and Android drops covered
    // views from the hierarchy: dismiss the keyboard before reading the result.
    if (platform === 'android') await screen.goBack();
    try {
      if (platform === 'ios') await expect(screen.getByType('XCUIElementTypeTextField').nth(2)).toHaveValue(String(i * 7));
      else await expect(screen.getByLabel('sum')).toHaveText(String(i * 7), { timeout: 8_000 });
    } catch (err) {
      const d: any = device.driver;
      const flat = (ns: any[]): any[] => ns.flatMap((n) => [n, ...flat(n.children ?? [])]);
      const nodes = flat(await d.getViewHierarchy());
      const hits = nodes.filter((n) => /sum|Total/.test(`${n.label ?? ''}${n.text ?? ''}`));
      const xml: string = await d.hub.source(d.currentSessionId());
      console.log(`[fail] model=${test.info().annotations.find((a) => a.type === 'device.model')?.description} nodes=${nodes.length} hits=${JSON.stringify(hits.map((n) => ({ t: n.type, l: n.label, x: n.text, v: n.isVisible, b: n.bounds })))}`);
      console.log(`[fail] raw sum: ${xml.split('\n').filter((l) => /sum/.test(l)).map((l) => l.trim().slice(0, 260)).join('\n')}`);
      console.log(`[fail] top: ${xml.split('\n').slice(0, 6).map((l) => l.trim().slice(0, 200)).join('\n')}`);
      throw err;
    }
    console.log(`[fill] tuning=${process.env['E2E_NO_TUNING'] === '1' ? 'off' : 'on'} ${Date.now() - t}ms`);
  });
}
