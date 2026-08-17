import { describe, expect, it, vi } from 'vitest';
import type { RunResultInfo, TestInfo, TestResultInfo } from '@mobilewright/protocol';
import { TestingBotTestObserver } from '../../src/observer.js';
import type { RestApiClient } from '../../src/rest-api.js';

const testInfo = (title: string): TestInfo => ({ id: title, title, titlePath: ['', 'ios', 'file', title] });
const result = (status: TestResultInfo['status'], errors: string[] = []): TestResultInfo =>
  ({ status, retry: 0, duration: 100, errors, steps: [] });
const runEnd = (status: RunResultInfo['status']): RunResultInfo =>
  ({ status, startTime: new Date(0), duration: 1000 });

function fakeApi() {
  return { updateTest: vi.fn(async () => { }) } as unknown as RestApiClient & { updateTest: ReturnType<typeof vi.fn> };
}

describe('TestingBotTestObserver', () => {
  it('reports success to every allocated session on a passing run', async () => {
    const api = fakeApi();
    const observer = new TestingBotTestObserver(api, { sessions: () => [{ sessionId: 's1' }, { sessionId: 's2' }], build: 'build-7' });
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
    const observer = new TestingBotTestObserver(api, { sessions: () => [{ sessionId: 's1' }] });
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
    const observer = new TestingBotTestObserver(api, { sessions: () => [{ sessionId: 's1' }] });
    await expect(observer.onRunEnd(runEnd('passed'))).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('gives a session its own test verdict when the timing join is unambiguous', async () => {
    const api = fakeApi();
    const now = Date.now();
    const observer = new TestingBotTestObserver(api, {
      sessions: () => [
        // sessionPerTest: one timed session per test, sequential in time.
        { sessionId: 'sess-pass', startedAt: now - 400_000, endedAt: now - 200_000 },
        { sessionId: 'sess-fail', startedAt: now - 200_000, endedAt: now + 5_000 },
        { sessionId: 'sess-untimed' },
      ],
    });
    observer.onRunStart({ totalTests: 2 });
    // First test "ends" 300s ago — simulate by monkey-patching Date.now around the call.
    const realNow = Date.now;
    try {
      Date.now = () => now - 300_000;
      observer.onTestEnd(testInfo('login works'), result('passed'));
      Date.now = () => now;
      observer.onTestEnd(testInfo('checkout fails'), result('failed', ['Error: boom']));
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
});
