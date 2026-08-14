import { describe, expect, it, vi } from 'vitest';
import type { FetchFn } from '../../src/webdriver-client.js';
import { RestApiClient } from '../../src/rest-api.js';

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status });

describe('RestApiClient', () => {
  it('authenticates with HTTP Basic key:secret', async () => {
    const fetchFn = vi.fn<FetchFn>().mockResolvedValue(json({ first_name: 'Arthur' }));
    const api = new RestApiClient('https://api.example.com/v1', 'mykey', 'mysecret', fetchFn);
    await api.getUser();
    const [, init] = fetchFn.mock.calls[0]!;
    const auth = (init?.headers as Record<string, string>)['Authorization'];
    expect(auth).toBe('Basic ' + Buffer.from('mykey:mysecret').toString('base64'));
  });

  it('raises AuthenticationError on 401', async () => {
    const fetchFn = vi.fn<FetchFn>().mockResolvedValue(json({ error: 'unauthorized' }, 401));
    const api = new RestApiClient('https://api.example.com/v1', 'bad', 'creds', fetchFn);
    await expect(api.getUser()).rejects.toMatchObject({ name: 'AuthenticationError' });
  });

  it('unwraps {devices: [...]} and raw-array device lists', async () => {
    const device = { id: 1, name: 'Pixel 8', platform_name: 'Android', version: '14' };
    const fetchFn = vi.fn<FetchFn>()
      .mockResolvedValueOnce(json({ devices: [device] }))
      .mockResolvedValueOnce(json([device]));
    const api = new RestApiClient('https://api.example.com/v1', 'k', 's', fetchFn);
    expect(await api.getDevices(true)).toEqual([device]);
    expect(await api.getDevices(false)).toEqual([device]);
    expect(fetchFn.mock.calls[0]![0]).toBe('https://api.example.com/v1/devices/available');
    expect(fetchFn.mock.calls[1]![0]).toBe('https://api.example.com/v1/devices');
  });

  it('updates a test with form-encoded success/name/groups', async () => {
    const fetchFn = vi.fn<FetchFn>().mockResolvedValue(json({ success: true }));
    const api = new RestApiClient('https://api.example.com/v1', 'k', 's', fetchFn);
    await api.updateTest('sess-uuid', {
      success: false,
      name: 'mobilewright run',
      statusMessage: '2 tests failed',
      groups: ['mobilewright'],
    });
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe('https://api.example.com/v1/tests/sess-uuid');
    expect(init?.method).toBe('PUT');
    const body = init?.body as URLSearchParams;
    expect(body.get('test[success]')).toBe('0');
    expect(body.get('test[name]')).toBe('mobilewright run');
    expect(body.get('test[status_message]')).toBe('2 tests failed');
    expect(body.getAll('groups[]')).toEqual(['mobilewright']);
  });
});
