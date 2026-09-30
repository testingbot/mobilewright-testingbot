import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// RunLog lives in os.tmpdir() keyed on cwd, so parallel test files would share
// (and truncate) one log. Give each file its own tmpdir.
process.env['TMPDIR'] = mkdtempSync(join(tmpdir(), 'tb-vitest-'));
