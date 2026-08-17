import { NoDeviceAvailableError } from '@mobilewright/protocol';
import { describe, expect, it } from 'vitest';
import { toAllocationError, WebDriverError } from '../../src/errors.js';

describe('toAllocationError', () => {
  // The hub returns plain strings; these are its canonical failure messages
  // (mirrored from the hub's own analytics.js fault classification).
  it.each([
    'Waited too long for job to start: 390000 msecs: {}',
    'we are unable to fulfill your request',
    'this device is currently in use',
    'we are experiencing high load',
    'Could not acquire processing lock',
    'The hub is temporarily busy',
  ])('classifies "%s" as retriable NoDeviceAvailableError', (message) => {
    const result = toAllocationError(new WebDriverError('session not created', message, 500));
    expect(result).toBeInstanceOf(NoDeviceAvailableError);
  });

  it('treats a client-side allocation timeout as retriable (request was queued)', () => {
    const timeout = new WebDriverError('timeout', 'POST /session timed out after 300000ms', 0);
    expect(toAllocationError(timeout)).toBeInstanceOf(NoDeviceAvailableError);
  });

  it('passes NoDeviceAvailableError through unchanged', () => {
    const original = new NoDeviceAvailableError('empty catalog');
    expect(toAllocationError(original)).toBe(original);
  });

  it('leaves permanent failures untouched', () => {
    const auth = new WebDriverError('session not created', 'Invalid credentials provided', 401);
    expect(toAllocationError(auth)).toBe(auth);
    const caps = new WebDriverError('invalid argument', 'platformVersion 99.0 is not supported', 400);
    expect(toAllocationError(caps)).toBe(caps);
  });

  it('classifies the plan parallel+queue cap (real hub body) as retriable', () => {
    // Captured live 2026-08-17 from a 20-workers-on-2-parallel run.
    const body = 'You are currently at the limit of the maximum allowed parallel + queued tests ' +
      'for your TestingBot plan. Your plan allows 2 parallel tests and 4 pending tests.';
    const result = toAllocationError(new WebDriverError('session not created', body, 500));
    expect(result).toBeInstanceOf(NoDeviceAvailableError);
  });

  it('does not duplicate identical error and message fields', () => {
    const err = new WebDriverError('same text', 'same text', 500);
    expect(err.message).toBe('same text');
    const distinct = new WebDriverError('code', 'detail', 500);
    expect(distinct.message).toBe('code: detail');
  });
});
