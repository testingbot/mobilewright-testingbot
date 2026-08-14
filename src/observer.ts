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

export interface ObserverContext {
  /** WebDriver session UUIDs allocated during this run. */
  sessionIds(): string[];
  build?: string;
}

/**
 * Reports the run outcome to TestingBot. One TestingBot session hosts many
 * mobilewright tests, so v1 reports a run-level verdict per session (a
 * documented limitation until per-test granularity exists server-side).
 * Strictly best-effort: reporting failures never fail the test run.
 */
export class TestingBotTestObserver implements TestObserver {
  private readonly api: RestApiClient;
  private readonly context: ObserverContext;
  private totalTests = 0;
  /** Final outcome per test id — onTestEnd fires once per ATTEMPT, and a
   *  later retry overwrites the earlier attempt's result. */
  private readonly outcomes = new Map<string, { failed: boolean; summary?: string }>();

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
    this.outcomes.set(test.id, {
      failed,
      summary: failed ? `${test.title}: ${error}`.slice(0, 200) : undefined,
    });
  }

  async onRunEnd(result: RunResultInfo): Promise<void> {
    const success = result.status === 'passed';
    const finished = this.outcomes.size;
    const failures = [...this.outcomes.values()]
      .filter((o) => o.failed)
      .map((o) => o.summary)
      .filter(Boolean)
      .slice(0, 10);
    const statusMessage = success
      ? `${finished}/${this.totalTests} tests passed`
      : `${failures.length} of ${finished} tests failed. ${failures.join(' | ')}`.slice(0, 500);

    const sessionIds = this.context.sessionIds();
    debug('run ended (%s), reporting to %d session(s)', result.status, sessionIds.length);
    for (const sessionId of sessionIds) {
      try {
        await this.api.updateTest(sessionId, {
          success,
          statusMessage,
          build: this.context.build,
          groups: ['mobilewright'],
        });
        debug('reported %s -> success=%s', sessionId, success);
      } catch (err) {
        // Never fail the run over reporting.
        console.warn(`TestingBotDriver: could not report result for session ${sessionId}: ${String(err)}`);
      }
    }
  }
}
