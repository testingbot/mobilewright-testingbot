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
}

export interface AppRecord {
  type: 'app';
  platform: string;
  deviceType?: string;
  url: string;
}

type Record_ = SessionRecord | AppRecord;

export interface MergedSession {
  sessionId: string;
  /** Number of connect/disconnect cycles (= tests) recorded for this session. */
  spans: number;
  startedAt?: number;
  endedAt?: number;
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
    for (const record of this.read()) {
      if (record.type !== 'session') continue;
      const merged = byId.get(record.sessionId) ?? { sessionId: record.sessionId, spans: 0 };
      if (record.startedAt !== undefined && record.endedAt !== undefined) {
        merged.spans += 1;
        merged.startedAt = Math.min(merged.startedAt ?? record.startedAt, record.startedAt);
        merged.endedAt = Math.max(merged.endedAt ?? record.endedAt, record.endedAt);
      }
      byId.set(record.sessionId, merged);
    }
    return [...byId.values()];
  }

  sessionIds(): string[] {
    return this.sessions().map((r) => r.sessionId);
  }

  appUrlFor(platform: string, deviceType: string | undefined): string | undefined {
    const apps = this.read().filter((r): r is AppRecord => r.type === 'app');
    return (
      apps.find((a) => a.platform === platform && a.deviceType === deviceType) ??
      apps.find((a) => a.platform === platform)
    )?.url;
  }
}
