import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

/**
 * Tiny JSONL file shared between the coordinator process (allocator half,
 * observer) and worker processes (session half) of one mobilewright run —
 * needed by sessionPerTest, where workers create WebDriver sessions the
 * coordinator never sees but the observer must still report on. Keyed by
 * cwd, since all processes of a run share it; the coordinator truncates the
 * file in prepare() so stale entries from a previous run cannot leak in.
 */

export interface SessionRecord {
  type: 'session';
  sessionId: string;
  /** Wall-clock ms of connect()/disconnect() — present on records written at
   *  test end, used to attribute a test's verdict to its session. */
  startedAt?: number;
  endedAt?: number;
  /** Playwright's TEST_WORKER_INDEX for the process that ran this test. The
   *  identity half of the observer's session-to-test join: the run report
   *  reports the same index per test, so a session can be matched against the
   *  tests of its own worker instead of every test in the run. */
  workerIndex?: number;
}

export interface AppRecord {
  type: 'app';
  platform: string;
  deviceType?: string;
  /** Uploaded app URLs: app under test first, then any otherApps. */
  urls: string[];
}

export interface RecordingRecord {
  type: 'recording';
  sessionId: string;
  /** Local MP4 path the caller asked stopRecording() to produce. */
  output: string;
}

type Record_ = SessionRecord | AppRecord | RecordingRecord;

export interface MergedSession {
  sessionId: string;
  /** Number of connect/disconnect cycles (= tests) recorded for this session. */
  spans: number;
  startedAt?: number;
  endedAt?: number;
  /** The worker process that ran this session's test(s) — only when every
   *  recorded cycle agrees, since a pooled slot re-granted across workers has
   *  no single owner. */
  workerIndex?: number;
}

export class RunLog {
  readonly path: string;

  constructor(dir: string = tmpdir(), key: string = process.cwd()) {
    const hash = createHash('sha256').update(key).digest('hex').slice(0, 12);
    this.path = join(dir, `testingbot-mobilewright-${hash}.jsonl`);
  }

  truncate(): void {
    try {
      writeFileSync(this.path, '');
    } catch {
      // best-effort — a failed truncate only risks over-reporting old sessions
    }
  }

  append(record: Record_): void {
    try {
      appendFileSync(this.path, JSON.stringify(record) + '\n');
    } catch {
      // best-effort — reporting degrades, tests must not fail over this
    }
  }

  read(): Record_[] {
    try {
      return readFileSync(this.path, 'utf-8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record_);
    } catch {
      return [];
    }
  }

  /**
   * Session records merged by id. A pooled session hosts one test per
   * connect/disconnect cycle, so it accumulates one timed record per test:
   * `spans` counts them, and startedAt/endedAt cover their union. A session
   * with exactly one span hosted exactly one test — attributable; more than
   * one span means several tests shared it.
   */
  sessions(): MergedSession[] {
    const byId = new Map<string, MergedSession>();
    const workersSeen = new Map<string, Set<number>>();
    for (const record of this.read()) {
      if (record.type !== 'session') continue;
      const merged = byId.get(record.sessionId) ?? { sessionId: record.sessionId, spans: 0 };
      if (record.startedAt !== undefined && record.endedAt !== undefined) {
        merged.spans += 1;
        merged.startedAt = Math.min(merged.startedAt ?? record.startedAt, record.startedAt);
        merged.endedAt = Math.max(merged.endedAt ?? record.endedAt, record.endedAt);
      }
      if (record.workerIndex !== undefined) {
        const seen = workersSeen.get(record.sessionId) ?? new Set<number>();
        seen.add(record.workerIndex);
        workersSeen.set(record.sessionId, seen);
      }
      byId.set(record.sessionId, merged);
    }
    for (const merged of byId.values()) {
      const seen = workersSeen.get(merged.sessionId);
      if (seen?.size === 1) merged.workerIndex = [...seen][0];
    }
    return [...byId.values()];
  }

  sessionIds(): string[] {
    return this.sessions().map((r) => r.sessionId);
  }

  recordings(): RecordingRecord[] {
    return this.read().filter((r): r is RecordingRecord => r.type === 'recording');
  }

  appUrlsFor(platform: string, deviceType: string | undefined): string[] | undefined {
    const apps = this.read().filter((r): r is AppRecord => r.type === 'app');
    return (
      apps.find((a) => a.platform === platform && a.deviceType === deviceType) ??
      apps.find((a) => a.platform === platform)
    )?.urls;
  }
}
