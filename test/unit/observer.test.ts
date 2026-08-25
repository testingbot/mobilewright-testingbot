import { describe, expect, it, vi } from 'vitest';
import type { RunResultInfo, TestInfo, TestResultInfo } from '@mobilewright/protocol';
import { TestingBotTestObserver } from '../../src/observer.js';
import type { RestApiClient } from '../../src/rest-api.js';

const testInfo = (title: string): TestInfo => ({ id: title, title, titlePath: ['', 'ios', 'file', title] });
const result = (status: TestResultInfo['status'], errors: string[] = [], duration = 100): TestResultInfo =>
  ({ status, retry: 0, duration, errors, steps: [] });
const runEnd = (status: RunResultInfo['status']): RunResultInfo =>
  ({ status, startTime: new Date(0), duration: 1000 });

/**
 * Feed outcomes with explicit wall-clock bounds. onTestEnd reconstructs the
 * interval as [Date.now() - duration, Date.now()], so the clock is pinned
 * around each call rather than the timestamps being passed in directly.
 */
function stampedOutcomes(
  observer: TestingBotTestObserver,
  tests: [title: string, status: TestResultInfo['status'], startedAt: number, endedAt: number, error?: string][],
): void {
  const realNow = Date.now;
  try {
    for (const [title, status, startedAt, endedAt, error] of tests) {
      Date.now = () => endedAt;
      observer.onTestEnd(testInfo(title), result(status, error ? [error] : [], endedAt - startedAt));
    }
  } finally {
    Date.now = realNow;
  }
}

/**
 * A Playwright JSON report carrying just the fields the observer joins on:
 * `spec.id` (= TestInfo.id), and each result's worker index and worker-clock
 * interval.
 */
const jsonReport = (
  specs: { id: string; workerIndex?: number; startedAt: number; duration: number }[],
) => async () => ({
  suites: [{
    specs: specs.map((spec) => ({
      id: spec.id,
      tests: [{
        results: [{
          workerIndex: spec.workerIndex ?? 0,
          startTime: new Date(spec.startedAt).toISOString(),
          duration: spec.duration,
        }],
      }],
    })),
  }],
});

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
    // Untimed session: no test can be tied to it, so it gets neither a name
    // nor a verdict — never the failing test's, which ran elsewhere.
    expect(updates.get('sess-untimed')!.success).toBeUndefined();
    expect(updates.get('sess-untimed')!.statusMessage).toBeUndefined();
    expect(updates.get('sess-untimed')!.name).toBeUndefined();
  });

  it('never stamps a run-level failure on a session it cannot attribute', async () => {
    // The defect: sessionPerTest run, one test passes and one fails, but the
    // passing test's session cannot be joined to its outcome (its timed span
    // never reached the run file, or the intervals were ambiguous). It used
    // to inherit the run aggregate and show up on the dashboard as a failure
    // named "mobilewright" — the other test's verdict, on the wrong session.
    const api = fakeApi();
    const observer = new TestingBotTestObserver(api, {
      sessions: () => [
        { sessionId: 'sess-orphan', spans: 0 },
        { sessionId: 'sess-fail', spans: 1, startedAt: 110_000, endedAt: 200_000 },
      ],
      build: 'defect-repro',
    });
    observer.onRunStart({ totalTests: 2 });
    stampedOutcomes(observer, [
      ['passes', 'passed', 0, 90_000],
      ['fails on purpose', 'failed', 100_000, 210_000, 'ExpectError: not visible'],
    ]);
    await observer.onRunEnd(runEnd('failed'));

    const updates = new Map(api.updateTest.mock.calls.map(([id, update]) => [id, update]));
    expect(updates.get('sess-fail')).toMatchObject({ success: false, name: 'fails on purpose' });
    // The orphan is still reported to — build, extra and tags are true of the
    // whole run — but its verdict is left exactly as TestingBot had it.
    expect(updates.get('sess-orphan')).toEqual({
      build: 'defect-repro', extra: undefined, groups: ['mobilewright'],
    });
  });

  it('lets the only session of a failed run take the run verdict', async () => {
    // With a single session there is nowhere else the failing test could have
    // run, so the aggregate is about that session by construction.
    const api = fakeApi();
    const observer = new TestingBotTestObserver(api, { sessions: () => [{ sessionId: 'solo', spans: 0 }] });
    observer.onRunStart({ totalTests: 2 });
    stampedOutcomes(observer, [['a', 'passed', 0, 90_000], ['b', 'failed', 100_000, 200_000, 'Error: boom']]);
    await observer.onRunEnd(runEnd('failed'));
    expect(api.updateTest.mock.calls[0]![1]).toMatchObject({ success: false });
  });

  it('attributes a session whose test interval is skewed rather than giving up', async () => {
    // The midpoint-containment rule failed outright once the coordinator's
    // stamp for a test drifted past the session's midpoint. Coverage degrades
    // instead: the test still covers most of the session, so it still claims
    // it.
    const api = fakeApi();
    const observer = new TestingBotTestObserver(api, {
      sessions: () => [{ sessionId: 'skewed', spans: 1, startedAt: 100_000, endedAt: 140_000 }],
    });
    observer.onRunStart({ totalTests: 1 });
    // Test reported as [125_000, 200_000]: it starts after the session's
    // midpoint (120_000) yet still covers 15s of its 40s... which is under
    // half, so this one must NOT be claimed.
    stampedOutcomes(observer, [['drifted', 'passed', 125_000, 200_000]]);
    await observer.onRunEnd(runEnd('passed'));
    expect(api.updateTest.mock.calls[0]![1].name).toBeUndefined();

    // Shift the report back so the test covers 30s of the 40s session: past
    // the midpoint by the old rule's reckoning, but comfortably attributable.
    const api2 = fakeApi();
    const observer2 = new TestingBotTestObserver(api2, {
      sessions: () => [{ sessionId: 'skewed', spans: 1, startedAt: 100_000, endedAt: 140_000 }],
    });
    observer2.onRunStart({ totalTests: 1 });
    stampedOutcomes(observer2, [['drifted', 'passed', 110_000, 200_000]]);
    await observer2.onRunEnd(runEnd('passed'));
    expect(api2.updateTest.mock.calls[0]![1]).toMatchObject({ name: 'drifted', success: true });
  });

  it('attributes nothing when two sessions have an equal claim on one test', async () => {
    // Concurrent workers, one outcome recorded: both sessions sit fully
    // inside its interval. Guessing would name one of them wrongly.
    const api = fakeApi();
    const observer = new TestingBotTestObserver(api, {
      sessions: () => [
        { sessionId: 'w1', spans: 1, startedAt: 10_000, endedAt: 20_000 },
        { sessionId: 'w2', spans: 1, startedAt: 10_000, endedAt: 20_000 },
      ],
    });
    observer.onRunStart({ totalTests: 2 });
    stampedOutcomes(observer, [['shared shape', 'passed', 0, 30_000]]);
    await observer.onRunEnd(runEnd('passed'));
    for (const [, update] of api.updateTest.mock.calls) expect(update.name).toBeUndefined();
  });

  it('tells concurrent workers apart by worker index, where timing alone cannot', async () => {
    // Two workers running at the same instant: both sessions sit inside both
    // tests' intervals, so the wall clock cannot separate them and the join
    // has to abstain. The run report says which worker ran which test, and
    // the driver stamped the same index on each session record — so each
    // session gets its own verdict, and the failure stays on worker 1.
    const api = fakeApi();
    const observer = new TestingBotTestObserver(api, {
      sessions: () => [
        { sessionId: 'on-w0', spans: 1, startedAt: 10_000, endedAt: 20_000, workerIndex: 0 },
        { sessionId: 'on-w1', spans: 1, startedAt: 10_000, endedAt: 20_000, workerIndex: 1 },
      ],
    });
    observer.onRunStart({ totalTests: 2 });
    stampedOutcomes(observer, [
      ['alpha', 'passed', 0, 30_000],
      ['beta', 'failed', 0, 30_000, 'Error: boom'],
    ]);
    await observer.onRunEnd({
      ...runEnd('failed'),
      jsonReport: jsonReport([
        { id: 'alpha', workerIndex: 0, startedAt: 0, duration: 30_000 },
        { id: 'beta', workerIndex: 1, startedAt: 0, duration: 30_000 },
      ]),
    });

    const updates = new Map(api.updateTest.mock.calls.map(([id, update]) => [id, update]));
    expect(updates.get('on-w0')).toMatchObject({ name: 'alpha', success: true });
    expect(updates.get('on-w1')).toMatchObject({ name: 'beta', success: false });
  });

  it('prefers the worker\'s own timestamps over the coordinator\'s reconstruction', async () => {
    // onTestEnd can only date a test from Date.now() here, after reporter
    // dispatch; a delay shifts the whole interval clear of the session's and
    // the join gives up. The report carries the worker's own stamps.
    const api = fakeApi();
    const sessions = () => [{ sessionId: 'skewed', spans: 1, startedAt: 100_000, endedAt: 140_000 }];
    const observer = new TestingBotTestObserver(api, { sessions });
    observer.onRunStart({ totalTests: 1 });
    stampedOutcomes(observer, [['delayed report', 'passed', 499_000, 500_000]]);
    await observer.onRunEnd(runEnd('passed'));
    expect(api.updateTest.mock.calls[0]![1].name).toBeUndefined(); // nothing to join to

    const api2 = fakeApi();
    const observer2 = new TestingBotTestObserver(api2, { sessions });
    observer2.onRunStart({ totalTests: 1 });
    stampedOutcomes(observer2, [['delayed report', 'passed', 499_000, 500_000]]);
    await observer2.onRunEnd({
      ...runEnd('passed'),
      jsonReport: jsonReport([{ id: 'delayed report', startedAt: 90_000, duration: 60_000 }]),
    });
    expect(api2.updateTest.mock.calls[0]![1]).toMatchObject({ name: 'delayed report', success: true });
  });

  it('ignores report entries it cannot use and keeps the timing join', async () => {
    // workerIndex -1 marks a test Playwright never ran; a spec with no result
    // or an unparseable startTime contributes nothing. None of it may throw.
    const api = fakeApi();
    const observer = new TestingBotTestObserver(api, {
      sessions: () => [{ sessionId: 's1', spans: 1, startedAt: 110_000, endedAt: 190_000, workerIndex: 3 }],
    });
    observer.onRunStart({ totalTests: 1 });
    stampedOutcomes(observer, [['survives', 'passed', 100_000, 200_000]]);
    await observer.onRunEnd({
      ...runEnd('passed'),
      jsonReport: async () => ({
        suites: [{
          specs: [
            { id: 'survives', tests: [{ results: [{ workerIndex: -1, startTime: 'not a date', duration: 5 }] }] },
            { id: 'no-results', tests: [] },
          ],
        }],
      }),
    });
    // Fell back to the event-sourced interval, and worker 3 was not excluded
    // by an entry that carried no usable worker index.
    expect(api.updateTest.mock.calls[0]![1]).toMatchObject({ name: 'survives', success: true });
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
