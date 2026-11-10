import { createRequire } from 'node:module';
import { join } from 'node:path';
import createDebug from 'debug';

const debug = createDebug('testingbot:test-info');

/** The slice of Playwright's TestInfo the driver reads. */
export interface CurrentTestInfo {
  testId: string;
  title: string;
  /** [file, ...describe titles, title] */
  titlePath: string[];
  retry: number;
  status?: 'passed' | 'failed' | 'timedOut' | 'skipped' | 'interrupted';
  expectedStatus: 'passed' | 'failed' | 'timedOut' | 'skipped' | 'interrupted';
  errors: { message?: string }[];
  annotations: { type: string; description?: string }[];
  project: { name: string };
}

/** Outcome of one test attempt, as seen from inside the worker at disconnect(). */
export interface AttemptOutcome {
  id: string;
  title: string;
  retry: number;
  status: 'passed' | 'failed' | 'skipped';
  error?: string;
}

type PlaywrightTest = { test: { info(): CurrentTestInfo } };
let playwrightTest: PlaywrightTest | null | undefined;

/**
 * Load the `@playwright/test` copy the user's tests actually run on:
 * `test.info()` reads state held by that module instance, so it is resolved
 * the way `@mobilewright/test` resolves it, falling back to the project's own.
 */
function loadPlaywrightTest(): PlaywrightTest | null {
  if (playwrightTest !== undefined) return playwrightTest;
  const fromProject = createRequire(join(process.cwd(), 'package.json'));
  const origins = [
    () => createRequire(fromProject.resolve('@mobilewright/test')),
    () => fromProject,
  ];
  for (const origin of origins) {
    try {
      playwrightTest = origin()('@playwright/test') as PlaywrightTest;
      return playwrightTest;
    } catch {
      // try the next origin
    }
  }
  debug('@playwright/test not resolvable — per-test reporting falls back to the run observer');
  playwrightTest = null;
  return null;
}

/** The test running in this worker right now, or undefined outside a test. */
export function currentTestInfo(): CurrentTestInfo | undefined {
  try {
    return loadPlaywrightTest()?.test.info();
  } catch {
    return undefined; // test.info() throws outside a running test
  }
}

/** Dashboard name for a test attempt: describe › title, marked when retried. */
export function attemptName(info: Pick<CurrentTestInfo, 'titlePath' | 'title' | 'retry'>): string {
  const path = info.titlePath.length > 1 ? info.titlePath.slice(1) : [info.title];
  return path.join(' › ') + (info.retry > 0 ? ` (retry ${info.retry})` : '');
}

/** The attempt's outcome, valid once the test body has finished (fixture teardown). */
export function attemptOutcome(info: CurrentTestInfo): AttemptOutcome | undefined {
  if (!info.status) return undefined;
  const status = info.status === 'skipped'
    ? 'skipped'
    : info.status === info.expectedStatus ? 'passed' : 'failed';
  const message = info.errors.find((e) => e.message)?.message;
  return {
    id: info.testId,
    title: attemptName(info),
    retry: info.retry,
    status,
    ...(status === 'failed' ? { error: firstLine(message) ?? info.status } : {}),
  };
}

function firstLine(message: string | undefined): string | undefined {
  // Playwright error messages carry ANSI colour codes.
  // eslint-disable-next-line no-control-regex
  return message?.replace(/\u001b\[[0-9;]*m/g, '').split('\n').find((l) => l.trim())?.trim().slice(0, 200);
}

/** Test seam: replace the resolver (undefined restores the real one). */
export function setPlaywrightTestForTesting(value: PlaywrightTest | null | undefined): void {
  playwrightTest = value;
}
