import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * In-process fake of hub.testingbot.com (WebDriver) + api.testingbot.com
 * (REST), just enough for driver lifecycle tests. Records every request.
 */
export interface RecordedRequest {
  method: string;
  path: string;
  body?: unknown;
}

export interface FakeSession {
  id: string;
  capabilities: Record<string, unknown>;
  deleted: boolean;
  context?: string;
}

// 1x1 transparent PNG
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

export class FakeHub {
  readonly sessions = new Map<string, FakeSession>();
  readonly requests: RecordedRequest[] = [];
  readonly testUpdates = new Map<string, Record<string, string | string[]>>();
  /** When > 0, POST /session fails this many times with a busy message. */
  busyCount = 0;
  /** Number of app binaries uploaded to /v1/storage. */
  uploadCount = 0;
  /** Storage keys handed out, in upload order. */
  readonly uploadedKeys: string[] = [];
  /** The only package this fake device considers installed. */
  installedBundleId = 'com.example.installed';
  /** Simulate an installed app whose launcher activity cannot be resolved. */
  launcherActivityMissing = false;
  /** Extra delay (ms) before answering POST /session. */
  allocationDelay = 0;

  private server: Server | undefined;
  private port = 0;

  get hubUrl(): string {
    return `http://127.0.0.1:${this.port}/wd/hub`;
  }

  get apiUrl(): string {
    return `http://127.0.0.1:${this.port}/v1`;
  }

  async start(): Promise<void> {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    const address = this.server.address();
    this.port = typeof address === 'object' && address ? address.port : 0;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve, reject) =>
      this.server ? this.server.close((err) => (err ? reject(err) : resolve())) : resolve());
  }

  liveSessions(): FakeSession[] {
    return [...this.sessions.values()].filter((s) => !s.deleted);
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString('utf-8');
    const path = req.url ?? '';
    const method = req.method ?? 'GET';
    let body: unknown;
    if (raw) {
      try {
        body = JSON.parse(raw);
      } catch {
        body = Object.fromEntries(new URLSearchParams(raw));
      }
    }
    this.requests.push({ method, path, body });

    const wd = (value: unknown, status = 200) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ value }));
    };
    const rest = (value: unknown, status = 200) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(value));
    };

    // ─── WebDriver ────────────────────────────────────────────────
    if (method === 'POST' && path === '/wd/hub/session') {
      if (this.allocationDelay) await new Promise((r) => setTimeout(r, this.allocationDelay));
      // Mirror the real hub: a client abort while queued removes the pending
      // request (protocols/webdriver.js 'aborted' -> removePendingRequest).
      // req.destroyed is true after normal body consumption, so check the
      // socket — it is only gone when the client actually disconnected.
      if (req.socket.destroyed) return;
      if (this.busyCount > 0) {
        this.busyCount -= 1;
        // Real hub wording (lib/registry.js): queue TTL expired.
        return wd({ error: 'session not created', message: 'Waited too long for job to start: 390000 msecs: {}' }, 500);
      }
      const capabilities = (body as { capabilities?: { alwaysMatch?: Record<string, unknown> } })
        ?.capabilities?.alwaysMatch ?? {};
      const id = randomUUID();
      this.sessions.set(id, { id, capabilities, deleted: false });
      return wd({ sessionId: id, capabilities });
    }

    const sessionMatch = path.match(/^\/wd\/hub\/session\/([^/]+)(\/.*)?$/);
    if (sessionMatch) {
      const [, id, rest_] = sessionMatch;
      const session = this.sessions.get(id!);
      if (!session || session.deleted) {
        return wd({ error: 'invalid session id', message: `session ${id} is gone` }, 404);
      }
      const sub = rest_ ?? '';
      if (method === 'DELETE' && !sub) {
        session.deleted = true;
        return wd(null);
      }
      switch (sub) {
        case '/orientation':
          return wd('PORTRAIT');
        case '/window/rect':
          return wd({ x: 0, y: 0, width: 393, height: 852 });
        case '/screenshot':
          return wd(TINY_PNG.toString('base64'));
        case '/source': {
          const platform = String(session.capabilities['platformName'] ?? 'iOS');
          const fixture = platform.toLowerCase() === 'android' ? 'android-page-source.xml' : 'ios-page-source.xml';
          return wd(readFileSync(join(import.meta.dirname, '..', 'fixtures', fixture), 'utf-8'));
        }
        case '/actions':
          return wd(null);
        case '/execute/sync': {
          const script = String((body as { script?: string })?.script ?? '');
          if (script === 'mobile: getContexts') {
            return wd([
              { id: 'NATIVE_APP' },
              { id: 'WEBVIEW_com.example', title: 'Checkout', url: 'https://shop.example/cart' },
            ]);
          }
          if (script.includes('document.readyState')) return wd('complete');
          const appId = String((((body as { args?: Record<string, string>[] })?.args ?? [])[0])?.['appId'] ?? '');
          if (script === 'mobile: isAppInstalled') {
            return wd(appId === this.installedBundleId);
          }
          if (script === 'mobile: activateApp' && (appId !== this.installedBundleId || this.launcherActivityMissing)) {
            // Verbatim shape of the real UiAutomator2 failure (captured live).
            return wd({
              error: 'unknown error',
              message: `An unknown server-side error occurred while processing the command. ` +
                `Original error: Unable to resolve the launchable activity of '${appId}'. ` +
                `Original error: No activity found`,
            }, 500);
          }
          return wd(null);
        }
        case '/context':
          if (method === 'POST') {
            session.context = String((body as { name?: string })?.name ?? '');
            return wd(null);
          }
          return wd(session.context ?? 'NATIVE_APP');
        case '/contexts':
          return wd(['NATIVE_APP', 'WEBVIEW_com.example']);
        case '/title':
          return wd('Checkout');
        case '/back':
        case '/forward':
        case '/refresh':
          return wd(null);
        case '/url':
          return wd(method === 'GET' ? 'https://shop.example/cart' : null);
        default:
          return wd(null);
      }
    }

    // ─── REST API ─────────────────────────────────────────────────
    if (path === '/v1/user') return rest({ first_name: 'Zaphod', plan: 'TEST', max_concurrent: 2, max_concurrent_mobile: 1 });
    if (path === '/v1/browsers') {
      return rest([
        { name: 'chrome', platformName: 'Android', deviceName: 'Pixel 9', version: '16.0' },
        { name: 'chrome', platformName: 'Android', deviceName: 'Galaxy S23', version: '14.0' },
        { name: 'chrome', platformName: 'Android', deviceName: 'ChromeOS Large', version: '16.0' },
        { name: 'safari', platformName: 'iOS', deviceName: 'iPhone 15', version: '17.5' },
        { name: 'safari', platformName: 'iOS', deviceName: 'iPhone 14', version: '16.4' },
        { name: 'safari', platform: 'SEQUOIA', version: '18.0' },
      ]);
    }
    if (method === 'POST' && path === '/v1/storage') {
      this.uploadCount += 1;
      // Derive a distinct key per binary from the multipart filename, so
      // tests can tell the app under test from its helper apps.
      const filename = raw.match(/filename="([^"]+)"/)?.[1] ?? `upload${this.uploadCount}`;
      const key = filename.replace(/\.[^.]+$/, '').replace(/[^a-z0-9._-]/gi, '');
      this.uploadedKeys.push(key);
      return rest({ app_url: `tb://${key}` }, 201);
    }
    const storageMatch = path.match(/^\/v1\/storage\/([^/]+)$/);
    if (storageMatch) {
      return rest({
        app_url: `tb://${storageMatch[1]}`,
        state: 'DONE',
        url: `http://127.0.0.1:${this.port}/apps/${storageMatch[1]}`,
        sim_only: false,
      });
    }
    if (path === '/v1/devices/available' || path === '/v1/devices') {
      return rest({
        devices: [
          { id: 1, name: 'Pixel 8', platform_name: 'Android', version: '14' },
          { id: 3, name: 'iPhone 15', platform_name: 'iOS', version: '17.4' },
        ],
      });
    }
    const videoMatch = path.match(/^\/videos\/([^/]+)\.mp4$/);
    if (videoMatch) {
      res.writeHead(200, { 'Content-Type': 'video/mp4' });
      res.end(Buffer.from(`fake-mp4-bytes-for-${videoMatch[1]}`));
      return;
    }
    const testMatch = path.match(/^\/v1\/tests\/([^/]+)(\/stop)?$/);
    if (testMatch) {
      const [, id, stop] = testMatch;
      if (stop) {
        const session = this.sessions.get(id!);
        if (session) session.deleted = true;
        return rest({ success: true });
      }
      if (method === 'PUT' || method === 'POST') {
        this.testUpdates.set(id!, body as Record<string, string | string[]>);
        return rest({ success: true });
      }
      return rest({ id, video: `http://127.0.0.1:${this.port}/videos/${id}.mp4`, assets_available: true, duration: 12 });
    }

    rest({ error: `FakeHub: unhandled ${method} ${path}` }, 404);
  }
}
