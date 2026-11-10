import { describe, expect, it } from 'vitest';
import { exactVerdict } from '../../src/observer.js';
import { attemptName, attemptOutcome, type CurrentTestInfo } from '../../src/test-info.js';

const info = (over: Partial<CurrentTestInfo> = {}): CurrentTestInfo => ({
  testId: 't1', title: 'adds numbers', titlePath: ['calc.test.ts', 'calculator', 'adds numbers'],
  retry: 0, status: 'passed', expectedStatus: 'passed', errors: [], annotations: [], project: { name: 'android' },
  ...over,
});

describe('attemptName', () => {
  it('drops the file and joins describe blocks', () => {
    expect(attemptName(info())).toBe('calculator › adds numbers');
  });
  it('marks retries', () => {
    expect(attemptName(info({ retry: 2 }))).toBe('calculator › adds numbers (retry 2)');
  });
});

describe('attemptOutcome', () => {
  it('is undefined while the test body still runs', () => {
    expect(attemptOutcome(info({ status: undefined }))).toBeUndefined();
  });
  it('treats an expected failure (test.fail) as passed', () => {
    expect(attemptOutcome(info({ status: 'failed', expectedStatus: 'failed' }))!.status).toBe('passed');
  });
  it('reports the first error line without ANSI codes', () => {
    const out = attemptOutcome(info({
      status: 'failed',
      errors: [{ message: '\u001b[31mExpectError: Expected "42"\u001b[39m\n  at foo.ts:3' }],
    }))!;
    expect(out).toMatchObject({ status: 'failed', error: 'ExpectError: Expected "42"' });
  });
  it('maps timeouts to failed and skips to skipped', () => {
    expect(attemptOutcome(info({ status: 'timedOut' }))).toMatchObject({ status: 'failed', error: 'timedOut' });
    expect(attemptOutcome(info({ status: 'skipped' }))!.status).toBe('skipped');
  });
});

describe('exactVerdict', () => {
  const a = { id: 'a', title: 'A', retry: 0, status: 'passed' as const };
  const b = { id: 'b', title: 'B', retry: 0, status: 'failed' as const, error: 'boom' };
  it('names a single-attempt session after its test', () => {
    expect(exactVerdict([b])).toEqual({ name: 'B', success: false, statusMessage: 'boom' });
  });
  it('fails a pooled session if any attempt failed, keeping its name', () => {
    expect(exactVerdict([a, b])).toEqual({ success: false, statusMessage: '1 of 2 tests failed. B: boom' });
    expect(exactVerdict([a, a])).toEqual({ success: true, statusMessage: '2 tests passed' });
  });
  it('gives skipped-only sessions no verdict', () => {
    expect(exactVerdict([{ ...a, status: 'skipped' }])).toEqual({ name: 'A', statusMessage: 'skipped' });
  });
});
