import { describe, expect, it, vi } from 'vitest';
import { setActiveDriver, testingbot } from '../../src/session-commands.js';
import type { TestingBotDriver } from '../../src/driver.js';

function fakeDriver() {
  const executeScript = vi.fn<(script: string, ...args: unknown[]) => Promise<unknown>>(async () => undefined);
  setActiveDriver({ executeScript, currentSessionId: () => 'sess-1' } as unknown as TestingBotDriver);
  return executeScript;
}

describe('testingbot session commands', () => {
  it('encodes annotation commands as single tb: strings', async () => {
    const exec = fakeDriver();
    await testingbot.setName('checkout flow');
    await testingbot.setBuild('ci-42');
    await testingbot.setTags(['smoke', 'checkout']);
    await testingbot.setResult(false);
    await testingbot.annotate('tapped Order');
    await testingbot.breakpoint();

    expect(exec.mock.calls.map((c) => c[0])).toEqual([
      'tb:test-name=checkout flow',
      'tb:test-build=ci-42',
      'tb:test-tags=smoke,checkout',
      'tb:test-result=failed',
      'tb:test-context=tapped Order',
      'tb:break',
    ]);
  });

  it('flattens newlines that would corrupt a string-encoded command', async () => {
    const exec = fakeDriver();
    await testingbot.annotate('line one\n   line two  ');
    expect(exec.mock.calls[0]![0]).toBe('tb:test-context=line one line two');
  });

  it('sends test-info as JSON with the hub-decoded fields URI-encoded', async () => {
    const exec = fakeDriver();
    await testingbot.updateInfo({ name: 'nightly', public: true, statusMessage: '100% done', extra: 'commit=abc' });
    const payload = JSON.parse(String(exec.mock.calls[0]![0]).replace('tb:test-info=', ''));
    expect(payload).toEqual({
      name: 'nightly',
      public: true,
      status_message: '100%25%20done',
      extra: 'commit%3Dabc',
    });
    // A raw '%' would make the hub's decodeURIComponent throw and drop the update.
    expect(decodeURIComponent(payload.status_message)).toBe('100% done');
  });

  it('explains itself when called outside a connected session', async () => {
    setActiveDriver(undefined);
    await expect(testingbot.setName('x')).rejects.toThrow(/needs a connected device session/);
    expect(() => testingbot.dashboardUrl()).toThrow(/needs a connected device session/);
  });
});
