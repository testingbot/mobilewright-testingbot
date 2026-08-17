import createDebug from 'debug';
import type {
  RunResultInfo,
  TestInfo,
  TestObserver,
  TestResultInfo,
  TestRunInfo,
} from '@mobilewright/protocol';
import type { RestApiClient } from './rest-api.js';

const debug = createDebug('testingbot:observer');

export interface ReportableSession {
  sessionId: string;
  /** Wall-clock bounds of the session, when known (sessionPerTest). */
  startedAt?: number;
  endedAt?: number;
}

export interface ObserverContext {
  /** Every TestingBot session of this run (allocated + worker-rotated). */
  sessions(): ReportableSession[];
  build?: string;
}

interface TestOutcome {
  title: string;
  failed: boolean;
  summary?: string;
  /** Wall-clock interval of the (final) attempt, reconstructed at onTestEnd. */
  startedAt: number;
  endedAt: number;
}

/**
 * Reports outcomes to TestingBot. Sessions whose wall-clock interval maps to
 * exactly one test (sessionPerTest mode) get that test's name and verdict;
 * everything else — reused pool sessions hosting many tests, or ambiguous
 * overlaps under high concurrency — gets the run-level verdict. Strictly
 * best-effort: reporting failures never fail the test run.
 */
export class TestingBotTestObserver implements TestObserver {
  private readonly api: RestApiClient;
  private readonly context: ObserverContext;
  private totalTests = 0;
  /** Final outcome per test id — onTestEnd fires once per ATTEMPT, and a
   *  later retry overwrites the earlier attempt's result. */
  private readonly outcomes = new Map<string, TestOutcome>();

  constructor(api: RestApiClient, context: ObserverContext) {
    this.api = api;
    this.context = context;
  }

  onRunStart(run: TestRunInfo): void {
    this.totalTests = run.totalTests;
    debug('run started: %d tests', run.totalTests);
  }

  onTestEnd(test: TestInfo, result: TestResultInfo): void {
    const failed = result.status === 'failed' || result.status === 'timedOut' || result.status === 'interrupted';
    const error = result.errors[0]?.split('\n')[0] ?? result.status;
    const endedAt = Date.now();
    this.outcomes.set(test.id, {
      title: test.title,
      failed,
      summary: failed ? `${test.title}: ${error}`.slice(0, 200) : undefined,
      startedAt: endedAt - result.duration,
      endedAt,
    });
  }

  async onRunEnd(result: RunResultInfo): Promise<void> {
    const success = result.status === 'passed';
    const outcomes = [...this.outcomes.values()];
    const failures = outcomes.filter((o) => o.failed).map((o) => o.summary).filter(Boolean).slice(0, 10);
    const runMessage = success
      ? `${outcomes.length}/${this.totalTests} tests passed`
      : `${failures.length} of ${outcomes.length} tests failed. ${failures.join(' | ')}`.slice(0, 500);

    const sessions = this.context.sessions();
    debug('run ended (%s), reporting to %d session(s)', result.status, sessions.length);
    for (const session of sessions) {
      const test = this.testForSession(session, outcomes);
      try {
        await this.api.updateTest(session.sessionId, test
          ? {
            success: !test.failed,
            name: test.title,
            statusMessage: test.failed ? (test.summary ?? 'failed') : 'passed',
            build: this.context.build,
            groups: ['mobilewright'],
          }
          : {
            success,
            statusMessage: runMessage,
            build: this.context.build,
            groups: ['mobilewright'],
          });
        debug('reported %s -> %s', session.sessionId, test ? `test "${test.title}"` : `run success=${success}`);
      } catch (err) {
        // Never fail the run over reporting.
        console.warn(`TestingBotDriver: could not report result for session ${session.sessionId}: ${String(err)}`);
      }
    }
  }

  /**
   * The single test that ran inside this session, when unambiguous.
   * Direction matters: connect() and disconnect() happen INSIDE the test, so
   * the session interval is a sub-interval of its test's — but a test's
   * reported duration also covers fixture setup (device allocation), so the
   * test interval is much wider than the session's. The session midpoint must
   * therefore be looked up in the test intervals, never the other way around.
   */
  private testForSession(session: ReportableSession, outcomes: TestOutcome[]): TestOutcome | undefined {
    if (session.startedAt === undefined || session.endedAt === undefined) return undefined;
    const midpoint = (session.startedAt + session.endedAt) / 2;
    // Clock skew tolerance between the worker's stamps and ours.
    const SLACK_MS = 2_000;
    const containing = outcomes.filter((o) =>
      midpoint >= o.startedAt - SLACK_MS && midpoint <= o.endedAt + SLACK_MS,
    );
    if (containing.length === 1) return containing[0];
    if (containing.length > 1) {
      debug('%d tests overlap session %s — falling back to the run verdict', containing.length, session.sessionId);
    }
    return undefined;
  }
}
