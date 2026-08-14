import { NoDeviceAvailableError } from '@mobilewright/protocol';
import { describe, expect, it } from 'vitest';
import { toAllocationError, WebDriverError } from '../../src/errors.js';

describe('toAllocationError', () => {
  it.each([
    'There are no devices available right now',
    'All devices are busy, please retry',
    'You have reached the maximum number of concurrent sessions',
    'Session queue is full',
    'Timed out waiting for a free device',
  ])('classifies "%s" as retriable NoDeviceAvailableError', (message) => {
    const result = toAllocationError(new WebDriverError('session not created', message, 500));
    expect(result).toBeInstanceOf(NoDeviceAvailableError);
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
});
