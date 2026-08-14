import { describe, expect, it, vi } from 'vitest';
import { WebDriverError } from '../../src/errors.js';
import { WebDriverClient, type FetchFn } from '../../src/webdriver-client.js';

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify({ value }), { status, headers: { 'Content-Type': 'application/json' } });

describe('WebDriverClient', () => {
  it('creates a session and unwraps the {value} envelope', async () => {
    const fetchFn = vi.fn<FetchFn>().mockResolvedValue(json({ sessionId: 'abc-123', capabilities: { platformName: 'iOS' } }));
    const client = new WebDriverClient('https://hub.example.com/wd/hub/', 1000, fetchFn);

    const result = await client.newSession({ alwaysMatch: {}, firstMatch: [{}] });
    expect(result).toEqual({ sessionId: 'abc-123', capabilities: { platformName: 'iOS' } });

    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe('https://hub.example.com/wd/hub/session');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(init?.body as string)).toEqual({ capabilities: { alwaysMatch: {}, firstMatch: [{}] } });
  });

  it('maps W3C error responses to WebDriverError with code and message', async () => {
    const fetchFn = vi.fn<FetchFn>().mockResolvedValue(
      json({ error: 'invalid session id', message: 'session is gone' }, 404),
    );
    const client = new WebDriverClient('https://hub.example.com/wd/hub', 1000, fetchFn);

    await expect(client.get('dead', '/orientation')).rejects.toMatchObject({
      name: 'WebDriverError',
      error: 'invalid session id',
      httpStatus: 404,
    });
  });

  it('rejects non-JSON responses with a truncated body excerpt', async () => {
    const fetchFn = vi.fn<FetchFn>().mockResolvedValue(new Response('<html>gateway timeout</html>', { status: 200 }));
    const client = new WebDriverClient('https://hub.example.com/wd/hub', 1000, fetchFn);
    await expect(client.source('s1')).rejects.toThrow(/non-JSON/);
  });

  it('turns fetch timeouts into a WebDriverError', async () => {
    const fetchFn = vi.fn<FetchFn>().mockImplementation(async (_url, init) => {
      await new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const err = new Error('timed out');
          err.name = 'TimeoutError';
          reject(err);
        });
      });
      return json(null);
    });
    const client = new WebDriverClient('https://hub.example.com/wd/hub', 20, fetchFn);
    await expect(client.get('s1', '/orientation')).rejects.toBeInstanceOf(WebDriverError);
  });

  it('sends execute scripts to /execute/sync', async () => {
    const fetchFn = vi.fn<FetchFn>().mockResolvedValue(json('ok'));
    const client = new WebDriverClient('https://hub.example.com/wd/hub', 1000, fetchFn);
    await client.execute('s1', 'mobile: activateApp', [{ bundleId: 'com.x' }]);
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe('https://hub.example.com/wd/hub/session/s1/execute/sync');
    expect(JSON.parse(init?.body as string)).toEqual({
      script: 'mobile: activateApp',
      args: [{ bundleId: 'com.x' }],
    });
  });
});
