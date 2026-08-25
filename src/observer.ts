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
  /** Worker process that ran this session's test, when unambiguous. */
  workerIndex?: number;
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
  /** Playwright's stable test id — also the JSON report's `spec.id`. */
  id: string;
  title: string;
  failed: boolean;
  summary?: string;
  /** Wall-clock interval of the (final) attempt: reconstructed at onTestEnd,
   *  replaced by the worker's own stamps when the run report supplies them. */
  startedAt: number;
  endedAt: number;
  /** Worker process that ran the final attempt, per the run report. */
  workerIndex?: number;
  /** Interval came from the run report — i.e. from the worker's own clock. */
  fromReport?: boolean;
}

/** What the run report adds to an outcome the reporter events cannot. */
interface ReportedTiming {
  workerIndex?: number;
  startedAt: number;
  endedAt: number;
}

/**
 * Reports outcomes to TestingBot. Sessions whose wall-clock interval maps to
 * exactly one test (sessionPerTest mode) get that test's name and verdict;
 * a reused pool session hosting many tests gets the run-level verdict, which
 * genuinely describes it. A session that is neither — an ambiguous overlap
 * under high concurrency, or one whose test span never reached the run file —
 * gets build/extra/tags only: an unknown verdict is reported as unknown
 * rather than as the run's, which on a failed run would mark a session failed
 * on another test's behalf. Strictly best-effort throughout: reporting
 * failures never fail the test run.
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
      id: test.id,
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
    // One read of the run report serves both git metadata and the attribution
    // join below.
    const report = await readJsonReport(result);
    const outcomes = applyReportedTimings([...this.outcomes.values()], readTestTimings(report));
    const failures = outcomes.filter((o) => o.failed).map((o) => o.summary).filter(Boolean).slice(0, 10);
    const runMessage = success
      ? `${outcomes.length}/${this.totalTests} tests passed`
      : `${failures.length} of ${outcomes.length} tests failed. ${failures.join(' | ')}`.slice(0, 500);

    const git = readGitInfo(report);
    const extra = buildExtra(this.context.extra, git);
    const groups = ['mobilewright', ...(git?.branch ? [git.branch] : [])];

    const sessions = this.context.sessions();
    debug('run ended (%s), reporting to %d session(s)%s', result.status, sessions.length,
      git ? ` with git ${git.commit?.slice(0, 8) ?? '?'} (${git.branch ?? 'no branch'})` : '');
    const attributed = this.attribute(sessions, outcomes);
    for (const session of sessions) {
      const test = attributed.get(session.sessionId);
      // An unattributable session must never inherit the run's failure: on a
      // failed run that would stamp another test's verdict onto a session
      // whose own test passed. The aggregate is only safe when the failing
      // test cannot have run anywhere else — a session that hosted several
      // tests, or the run's only session — or when the run passed, where
      // every session's verdict is "passed" anyway.
      const mayInheritRunVerdict = success || session.spans > 1 || sessions.length === 1;
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
            ...(mayInheritRunVerdict ? { success, statusMessage: runMessage } : {}),
            build: this.context.build,
            extra,
            groups,
          });
        debug('reported %s -> %s', session.sessionId, test
          ? `test "${test.title}"`
          : mayInheritRunVerdict ? `run success=${success}` : 'metadata only (verdict left untouched)');
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
   * Map each session to the single test that ran inside it, when unambiguous.
   *
   * Direction matters: connect() and disconnect() happen INSIDE the test, so
   * the session interval is a sub-interval of its test's — but a test's
   * reported duration also covers fixture setup (device allocation), so the
   * test interval is much wider than the session's. Sessions are therefore
   * scored by how much of the SESSION each test interval covers, never the
   * other way around.
   *
   * Wall clock is the only join available: the worker process that owns the
   * session never learns which test it is running (`ConnectionConfig` carries
   * no test identity), so the coordinator has to line the two up after the
   * fact. Everything below is therefore built to abstain rather than guess —
   * a session with no confident, exclusive match gets no verdict at all.
   */
  private attribute(sessions: ReportableSession[], outcomes: TestOutcome[]): Map<string, TestOutcome> {
    // Clock skew tolerance between the worker's stamps and ours. Report-sourced
    // intervals need none: the worker measured both ends of the comparison.
    const SLACK_MS = 2_000;
    const slackFor = (outcome: TestOutcome): number => outcome.fromReport ? 0 : SLACK_MS;
    // A test must cover at least this much of the session to claim it.
    const MIN_COVERAGE = 0.5;

    const claims: { sessionId: string; outcome: TestOutcome; coverage: number }[] = [];
    for (const session of sessions) {
      // A session that hosted several tests has no single correct name/verdict.
      if (session.spans > 1) {
        debug('%s hosted %d tests — no single verdict', session.sessionId, session.spans);
        continue;
      }
      if (session.spans === 0) {
        debug('%s has no recorded test span — unattributable', session.sessionId);
        continue;
      }
      if (session.startedAt === undefined || session.endedAt === undefined) {
        debug('%s has no recorded interval — unattributable', session.sessionId);
        continue;
      }
      // Connect and disconnect can land in the same millisecond (a fast test on
      // an already-warm session), and a zero-length interval overlaps nothing.
      // Give every interval — session and test alike — at least 1ms of width so
      // a degenerate one stays comparable instead of scoring zero against all.
      const sessionEnd = Math.max(session.endedAt, session.startedAt + 1);
      const span = sessionEnd - session.startedAt;
      // Identity first: a test the report places in another worker process
      // cannot have run in this session, whatever the clocks say. Pairs where
      // either side's worker is unknown stay eligible and fall through to the
      // timing join below.
      const eligible = outcomes.filter((outcome) =>
        session.workerIndex === undefined || outcome.workerIndex === undefined ||
        outcome.workerIndex === session.workerIndex);
      if (eligible.length < outcomes.length) {
        debug('%s ran in worker %d — %d of %d tests eligible',
          session.sessionId, session.workerIndex, eligible.length, outcomes.length);
      }
      const scored = eligible
        .map((outcome) => ({
          outcome,
          coverage: Math.max(0,
            Math.min(sessionEnd, Math.max(outcome.endedAt, outcome.startedAt + 1) + slackFor(outcome)) -
            Math.max(session.startedAt!, outcome.startedAt - slackFor(outcome)),
          ) / span,
        }))
        .filter((c) => c.coverage >= MIN_COVERAGE)
        .sort((a, b) => b.coverage - a.coverage);
      if (scored.length === 0) {
        debug('%s overlaps no test interval — unattributable', session.sessionId);
        continue;
      }
      if (scored.length > 1 && scored[1]!.coverage >= scored[0]!.coverage) {
        debug('%d tests overlap session %s equally — unattributable', scored.length, session.sessionId);
        continue;
      }
      claims.push({ sessionId: session.sessionId, outcome: scored[0]!.outcome, coverage: scored[0]!.coverage });
    }

    // One test ran in one session: when several sessions claim the same test,
    // the best-covered one wins, and a tie means neither may have it.
    const attributed = new Map<string, TestOutcome>();
    for (const outcome of new Set(claims.map((c) => c.outcome))) {
      const rivals = claims.filter((c) => c.outcome === outcome).sort((a, b) => b.coverage - a.coverage);
      if (rivals.length > 1 && rivals[1]!.coverage >= rivals[0]!.coverage) {
        debug('%d sessions claim test "%s" equally — none attributed', rivals.length, outcome.title);
        continue;
      }
      if (rivals.length > 1) {
        debug('%d sessions claim test "%s" — %s wins', rivals.length, outcome.title, rivals[0]!.sessionId);
      }
      attributed.set(rivals[0]!.sessionId, outcome);
    }
    return attributed;
  }
}

/**
 * Playwright's JSON report for this run, when mobilewright exposes one.
 * Documented upstream as a transitional escape hatch, so every reader below is
 * feature-detected and silent on failure: the report may sharpen reporting,
 * but nothing may depend on it. Read once per run and shared.
 */
export async function readJsonReport(result: RunResultInfo): Promise<Record<string, unknown> | undefined> {
  try {
    return await result.jsonReport?.() as Record<string, unknown> | undefined;
  } catch (err) {
    debug('could not read the run report: %s', err);
    return undefined;
  }
}

/**
 * Per-test worker index and interval, keyed by `spec.id` — which is the same
 * id `onTestEnd` receives as `TestInfo.id`. Two things the reporter events
 * cannot give us:
 *
 * - **which worker process ran the test.** The driver stamps that same index
 *   on its run-file session records from inside the worker, so this is a real
 *   identity join, not a heuristic — it rules out every test that provably ran
 *   somewhere else, which is what makes concurrent runs attributable at all.
 * - **the worker's own timestamps.** `onTestEnd` can only reconstruct the
 *   interval from `Date.now()` in the coordinator, after reporter dispatch;
 *   any delay there shifts the whole interval away from the session's.
 *
 * Later attempts win, matching how `onTestEnd` overwrites retried tests.
 */
export function readTestTimings(report: Record<string, unknown> | undefined): Map<string, ReportedTiming> {
  const timings = new Map<string, ReportedTiming>();
  const walk = (suite: Record<string, unknown>): void => {
    for (const spec of arr(suite['specs'])) {
      const id = str(spec['id']);
      const results = arr(spec['tests']).flatMap((test) => arr(test['results']));
      const final = results[results.length - 1];
      if (id === undefined || final === undefined) continue;
      const startedAt = Date.parse(str(final['startTime']) ?? '');
      const duration = final['duration'];
      if (!Number.isFinite(startedAt) || typeof duration !== 'number') continue;
      // Playwright reports workerIndex -1 for tests it never got to run.
      const workerIndex = typeof final['workerIndex'] === 'number' && final['workerIndex'] >= 0
        ? final['workerIndex']
        : undefined;
      timings.set(id, { workerIndex, startedAt, endedAt: startedAt + duration });
    }
    for (const child of arr(suite['suites'])) walk(child);
  };
  try {
    for (const suite of arr(report?.['suites'])) walk(suite);
  } catch (err) {
    debug('could not read test timings from the run report: %s', err);
    return new Map();
  }
  return timings;
}

/** Overlay report timings onto the outcomes collected from the event hooks. */
export function applyReportedTimings(
  outcomes: TestOutcome[],
  timings: Map<string, ReportedTiming>,
): TestOutcome[] {
  if (timings.size === 0) return outcomes;
  let joined = 0;
  const merged = outcomes.map((outcome) => {
    const timing = timings.get(outcome.id);
    if (!timing) return outcome;
    joined += 1;
    return { ...outcome, ...timing, fromReport: true };
  });
  debug('run report supplied worker identity and timings for %d/%d tests', joined, outcomes.length);
  return merged;
}

/**
 * Git metadata mobilewright captures into the Playwright report
 * (`config.metadata.gitCommit`, populated when `captureGitInfo` is on —
 * Playwright does this automatically on CI).
 */
export function readGitInfo(report: Record<string, unknown> | undefined): GitInfo | undefined {
  try {
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

function arr(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value as Record<string, unknown>[] : [];
}
