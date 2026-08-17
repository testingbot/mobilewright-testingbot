import { writeFile } from 'node:fs/promises';
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
  /** Connect/disconnect cycles (= tests) recorded for this session. */
  spans: number;
  /** Wall-clock bounds of the recorded cycles, when any exist. */
  startedAt?: number;
  endedAt?: number;
}

export interface GitInfo {
  commit?: string;
  branch?: string;
  author?: string;
  subject?: string;
}

export interface ObserverContext {
  /** Every TestingBot session of this run (allocated + worker-rotated). */
  sessions(): ReportableSession[];
  build?: string;
  /** The driver's `extra` option, merged with git metadata when reporting. */
  extra?: string;
  /** Local-video requests made via startRecording({ output }). */
  recordings?(): { sessionId: string; output: string }[];
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
    if (this.outcomes.size === 0) {
      // No test finished (e.g. "mobilewright test --list" fires onRunStart
      // and onRunEnd without any tests running) — don't report, especially
      // not to stale run-file sessions. Skipped tests still produce outcomes.
      return;
    }
    const success = result.status === 'passed';
    const outcomes = [...this.outcomes.values()];
    const failures = outcomes.filter((o) => o.failed).map((o) => o.summary).filter(Boolean).slice(0, 10);
    const runMessage = success
      ? `${outcomes.length}/${this.totalTests} tests passed`
      : `${failures.length} of ${outcomes.length} tests failed. ${failures.join(' | ')}`.slice(0, 500);

    const git = await readGitInfo(result);
    const extra = buildExtra(this.context.extra, git);
    const groups = ['mobilewright', ...(git?.branch ? [git.branch] : [])];

    const sessions = this.context.sessions();
    debug('run ended (%s), reporting to %d session(s)%s', result.status, sessions.length,
      git ? ` with git ${git.commit?.slice(0, 8) ?? '?'} (${git.branch ?? 'no branch'})` : '');
    for (const session of sessions) {
      const test = this.testForSession(session, outcomes);
      try {
        await this.api.updateTest(session.sessionId, test
          ? {
            success: !test.failed,
            name: test.title,
            statusMessage: test.failed ? (test.summary ?? 'failed') : 'passed',
            build: this.context.build,
            extra,
            groups,
          }
          : {
            success,
            statusMessage: runMessage,
            build: this.context.build,
            extra,
            groups,
          });
        debug('reported %s -> %s', session.sessionId, test ? `test "${test.title}"` : `run success=${success}`);
      } catch (err) {
        // Never fail the run over reporting.
        console.warn(`TestingBotDriver: could not report result for session ${session.sessionId}: ${String(err)}`);
      }
    }

    await this.downloadRecordings();
  }

  /**
   * Fetch session videos requested via startRecording({ output }). The MP4
   * finalizes only after the session ends, so this waits (bounded) for the
   * asset to appear. Best-effort like all reporting.
   */
  private async downloadRecordings(): Promise<void> {
    const requests = this.context.recordings?.() ?? [];
    const deadline = Date.now() + 120_000;
    for (const request of requests) {
      try {
        let videoUrl: string | undefined;
        for (; ;) {
          const test = await this.api.getTest(request.sessionId);
          if (test.video === false) {
            // Video was disabled for this session — waiting will not help.
            break;
          }
          // assets_available is the API's "processing finished" signal; a
          // populated video URL alone also suffices (the URL is presigned,
          // so it is fetched right away below).
          if ((test.assets_available ?? true) && typeof test.video === 'string' && test.video) {
            videoUrl = test.video;
            break;
          }
          if (Date.now() >= deadline) break;
          await new Promise((resolve) => setTimeout(resolve, 3_000));
        }
        if (!videoUrl) {
          console.warn(`TestingBotDriver: video for session ${request.sessionId} is unavailable (disabled or not ready in time); skipping ${request.output}`);
          continue;
        }
        const response = await fetch(videoUrl, { signal: AbortSignal.timeout(60_000) });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        await writeFile(request.output, Buffer.from(await response.arrayBuffer()));
        debug('saved recording of %s to %s', request.sessionId, request.output);
      } catch (err) {
        console.warn(`TestingBotDriver: could not download video for session ${request.sessionId}: ${String(err)}`);
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
    // A session that hosted several tests has no single correct name/verdict.
    if (session.spans !== 1) return undefined;
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

/**
 * Git metadata mobilewright captures into the Playwright report
 * (`config.metadata.gitCommit`, populated when `captureGitInfo` is on —
 * Playwright does this automatically on CI). `jsonReport()` is documented
 * upstream as a transitional escape hatch, so every step is feature-detected
 * and failures are silent: metadata must never break reporting.
 */
export async function readGitInfo(result: RunResultInfo): Promise<GitInfo | undefined> {
  try {
    const report = await result.jsonReport?.() as Record<string, unknown> | undefined;
    const config = report?.['config'] as Record<string, unknown> | undefined;
    const metadata = config?.['metadata'] as Record<string, unknown> | undefined;
    const commit = metadata?.['gitCommit'] as Record<string, unknown> | undefined;
    if (!commit) return undefined;
    const author = commit['author'] as Record<string, unknown> | undefined;
    const info: GitInfo = {
      commit: str(commit['hash']),
      branch: str(commit['branch']),
      author: str(author?.['name']),
      subject: str(commit['subject']),
    };
    return Object.values(info).some((v) => v !== undefined) ? info : undefined;
  } catch (err) {
    debug('could not read git metadata from the report: %s', err);
    return undefined;
  }
}

/** Merge the user's `extra` with git metadata for the dashboard's extra field. */
export function buildExtra(userExtra: string | undefined, git: GitInfo | undefined): string | undefined {
  if (!git) return userExtra;
  const payload: Record<string, unknown> = { ...git };
  if (userExtra !== undefined) payload['extra'] = userExtra;
  return JSON.stringify(payload);
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}
