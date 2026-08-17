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
}

export interface AppRecord {
  type: 'app';
  platform: string;
  deviceType?: string;
  url: string;
}

type Record_ = SessionRecord | AppRecord;

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

  sessionIds(): string[] {
    return this.read().filter((r): r is SessionRecord => r.type === 'session').map((r) => r.sessionId);
  }

  appUrlFor(platform: string, deviceType: string | undefined): string | undefined {
    const apps = this.read().filter((r): r is AppRecord => r.type === 'app');
    return (
      apps.find((a) => a.platform === platform && a.deviceType === deviceType) ??
      apps.find((a) => a.platform === platform)
    )?.url;
  }
}
