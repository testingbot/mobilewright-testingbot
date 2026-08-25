import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RunLog } from '../../src/run-log.js';

/** A run log in its own directory, so parallel test files cannot collide. */
const runLog = () => new RunLog(mkdtempSync(join(tmpdir(), 'tb-run-log-')), 'key');

describe('RunLog.sessions', () => {
  it('counts one span per timed record and unions their bounds', () => {
    const log = runLog();
    log.append({ type: 'session', sessionId: 's1', startedAt: 100, endedAt: 200 });
    log.append({ type: 'session', sessionId: 's1', startedAt: 300, endedAt: 400 });
    expect(log.sessions()).toEqual([{ sessionId: 's1', spans: 2, startedAt: 100, endedAt: 400 }]);
  });

  it('keeps the worker index a session was recorded from', () => {
    const log = runLog();
    log.append({ type: 'session', sessionId: 's1', startedAt: 100, endedAt: 200, workerIndex: 2 });
    expect(log.sessions()[0]).toMatchObject({ workerIndex: 2 });
  });

  it('drops the worker index when a pooled session was re-granted across workers', () => {
    // Two workers ran tests on the same pooled session, so there is no single
    // owner to filter its candidate tests by.
    const log = runLog();
    log.append({ type: 'session', sessionId: 's1', startedAt: 100, endedAt: 200, workerIndex: 0 });
    log.append({ type: 'session', sessionId: 's1', startedAt: 300, endedAt: 400, workerIndex: 1 });
    expect(log.sessions()[0]!.workerIndex).toBeUndefined();
  });

  it('leaves the worker index unset outside a Playwright worker', () => {
    const log = runLog();
    log.append({ type: 'session', sessionId: 's1', startedAt: 100, endedAt: 200 });
    expect(log.sessions()[0]!.workerIndex).toBeUndefined();
  });

  it('records an untimed session with no spans and survives a truncated line', () => {
    const log = runLog();
    log.append({ type: 'session', sessionId: 's1' });
    expect(log.sessions()).toEqual([{ sessionId: 's1', spans: 0 }]);
    log.truncate();
    expect(log.sessions()).toEqual([]);
  });
});
