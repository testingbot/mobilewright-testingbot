import { describe, expect, it, vi } from 'vitest';
import type { RunResultInfo, TestInfo, TestResultInfo } from '@mobilewright/protocol';
import { TestingBotTestObserver } from '../../src/observer.js';
import type { RestApiClient } from '../../src/rest-api.js';

const testInfo = (title: string): TestInfo => ({ id: title, title, titlePath: ['', 'ios', 'file', title] });
const result = (status: TestResultInfo['status'], errors: string[] = [], duration = 100): TestResultInfo =>
  ({ status, retry: 0, duration, errors, steps: [] });
const runEnd = (status: RunResultInfo['status']): RunResultInfo =>
  ({ status, startTime: new Date(0), duration: 1000 });

function fakeApi() {
  return { updateTest: vi.fn(async () => { }) } as unknown as RestApiClient & { updateTest: ReturnType<typeof vi.fn> };
}

describe('TestingBotTestObserver', () => {
  it('reports success to every allocated session on a passing run', async () => {
    const api = fakeApi();
    const observer = new TestingBotTestObserver(api, { sessions: () => [{ sessionId: 's1', spans: 0 }, { sessionId: 's2', spans: 0 }], build: 'build-7' });
    observer.onRunStart({ totalTests: 2 });
    observer.onTestEnd(testInfo('a'), result('passed'));
    observer.onTestEnd(testInfo('b'), result('passed'));
    await observer.onRunEnd(runEnd('passed'));

    expect(api.updateTest).toHaveBeenCalledTimes(2);
    expect(api.updateTest).toHaveBeenCalledWith('s1', expect.objectContaining({
      success: true,
      build: 'build-7',
      statusMessage: '2/2 tests passed',
    }));
  });

  it('reports failure with a compact summary of failing tests', async () => {
    const api = fakeApi();
    const observer = new TestingBotTestObserver(api, { sessions: () => [{ sessionId: 's1', spans: 0 }] });
    observer.onRunStart({ totalTests: 2 });
    observer.onTestEnd(testInfo('login works'), result('failed', ['Error: expected visible\n  at spec.ts:4']));
    observer.onTestEnd(testInfo('menu opens'), result('passed'));
    await observer.onRunEnd(runEnd('failed'));

    const update = api.updateTest.mock.calls[0]![1];
    expect(update.success).toBe(false);
    expect(update.statusMessage).toContain('1 of 2 tests failed');
    expect(update.statusMessage).toContain('login works: Error: expected visible');
  });

  it('never throws when reporting fails', async () => {
    const api = fakeApi();
    api.updateTest.mockRejectedValue(new Error('api down'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => { });
    const observer = new TestingBotTestObserver(api, { sessions: () => [{ sessionId: 's1', spans: 0 }] });
    observer.onTestEnd(testInfo('a'), result('passed'));
    await expect(observer.onRunEnd(runEnd('passed'))).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('gives a session its own test verdict when the timing join is unambiguous', async () => {
    const api = fakeApi();
    const now = Date.now();
    const observer = new TestingBotTestObserver(api, {
      // sessionPerTest: connect/disconnect happen INSIDE each test, and the
      // test's reported duration also covers fixture setup (allocation), so
      // each session interval is a narrow sub-interval of its test's.
      sessions: () => [
        { sessionId: 'sess-pass', spans: 1, startedAt: now - 260_000, endedAt: now - 210_000 },
        { sessionId: 'sess-fail', spans: 1, startedAt: now - 60_000, endedAt: now - 10_000 },
        { sessionId: 'sess-untimed', spans: 0 },
      ],
    });
    observer.onRunStart({ totalTests: 2 });
    // Test 1 ends 200s ago with a 150s duration (allocation included);
    // test 2 ends now. Monkey-patch Date.now around the callbacks.
    const realNow = Date.now;
    try {
      Date.now = () => now - 200_000;
      observer.onTestEnd(testInfo('login works'), result('passed', [], 150_000));
      Date.now = () => now;
      observer.onTestEnd(testInfo('checkout fails'), result('failed', ['Error: boom'], 150_000));
    } finally {
      Date.now = realNow;
    }
    await observer.onRunEnd(runEnd('failed'));

    const updates = new Map(api.updateTest.mock.calls.map(([id, update]) => [id, update]));
    expect(updates.get('sess-pass')).toMatchObject({ success: true, name: 'login works' });
    expect(updates.get('sess-fail')).toMatchObject({ success: false, name: 'checkout fails' });
    // Untimed session (reused pool session) gets the run verdict, no test name.
    expect(updates.get('sess-untimed')!.success).toBe(false);
    expect(updates.get('sess-untimed')!.name).toBeUndefined();
  });

  it('keeps the run verdict for a pooled session that hosted several tests', async () => {
    const api = fakeApi();
    const now = Date.now();
    const observer = new TestingBotTestObserver(api, {
      // Two connect/disconnect cycles merged into one record: spans=2.
      sessions: () => [{ sessionId: 'shared', spans: 2, startedAt: now - 300_000, endedAt: now }],
    });
    observer.onRunStart({ totalTests: 2 });
    observer.onTestEnd(testInfo('a'), result('passed'));
    observer.onTestEnd(testInfo('b'), result('passed'));
    await observer.onRunEnd(runEnd('passed'));
    const update = api.updateTest.mock.calls[0]![1];
    expect(update.name).toBeUndefined();
    expect(update.statusMessage).toBe('2/2 tests passed');
  });

  it('reports nothing when no test produced an outcome (test --list)', async () => {
    const api = fakeApi();
    const observer = new TestingBotTestObserver(api, { sessions: () => [{ sessionId: 'stale', spans: 1 }] });
    observer.onRunStart({ totalTests: 3 }); // list mode still announces the suite
    await observer.onRunEnd(runEnd('passed'));
    expect(api.updateTest).not.toHaveBeenCalled();
  });

  it('reports git metadata from the run report as extra plus a branch tag', async () => {
    const api = fakeApi();
    const observer = new TestingBotTestObserver(api, {
      sessions: () => [{ sessionId: 's1', spans: 0 }],
      extra: 'release=2026.8',
    });
    observer.onRunStart({ totalTests: 1 });
    observer.onTestEnd(testInfo('a'), result('passed'));
    await observer.onRunEnd({
      ...runEnd('passed'),
      // Shape produced by Playwright's captureGitInfo, via mobilewright.
      jsonReport: async () => ({
        config: {
          metadata: {
            gitCommit: {
              hash: 'abc1234def5678',
              subject: 'fix checkout crash',
              branch: 'feature/checkout',
              author: { name: 'Jochen', email: 'j@example.com' },
            },
          },
        },
      }),
    });

    const update = api.updateTest.mock.calls[0]![1];
    expect(JSON.parse(update.extra)).toEqual({
      commit: 'abc1234def5678',
      branch: 'feature/checkout',
      author: 'Jochen',
      subject: 'fix checkout crash',
      extra: 'release=2026.8', // the user's own extra is preserved, not clobbered
    });
    expect(update.groups).toEqual(['mobilewright', 'feature/checkout']);
  });

  it('keeps reporting when git metadata is absent or the report throws', async () => {
    const api = fakeApi();
    const observer = new TestingBotTestObserver(api, {
      sessions: () => [{ sessionId: 's1', spans: 0 }],
      extra: 'release=2026.8',
    });
    observer.onRunStart({ totalTests: 1 });
    observer.onTestEnd(testInfo('a'), result('passed'));
    await observer.onRunEnd({
      ...runEnd('passed'),
      jsonReport: async () => { throw new Error('report gone'); },
    });

    const update = api.updateTest.mock.calls[0]![1];
    expect(update.extra).toBe('release=2026.8'); // untouched
    expect(update.groups).toEqual(['mobilewright']);

    // ...and with no jsonReport at all (older/newer upstream shapes).
    const api2 = fakeApi();
    const observer2 = new TestingBotTestObserver(api2, { sessions: () => [{ sessionId: 's2', spans: 0 }] });
    observer2.onRunStart({ totalTests: 1 });
    observer2.onTestEnd(testInfo('a'), result('passed'));
    await observer2.onRunEnd(runEnd('passed'));
    expect(api2.updateTest.mock.calls[0]![1].extra).toBeUndefined();
  });
});
