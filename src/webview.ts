import createDebug from 'debug';
import type { WebViewBridge, WebViewInfo, WebViewSession } from '@mobilewright/protocol';
import type { WebDriverClient } from './webdriver-client.js';

const debug = createDebug('testingbot:webview');

const NATIVE_CONTEXT = 'NATIVE_APP';

/**
 * WebView support over Appium's context API. Attaching switches the ONE
 * WebDriver context the session has — native commands issued while a webview
 * session is open target the web layer, which is also how the reference
 * drivers behave. close() switches back to the native context.
 */
export class AppiumWebViewBridge implements WebViewBridge {
  private readonly hub: WebDriverClient;
  private readonly sessionId: () => string;

  constructor(hub: WebDriverClient, sessionId: () => string) {
    this.hub = hub;
    this.sessionId = sessionId;
  }

  async listWebViews(): Promise<WebViewInfo[]> {
    const sessionId = this.sessionId();
    // `mobile: getContexts` is richer (title/url) but not uniform across
    // drivers; fall back to the plain context list (names only).
    let entries: unknown[];
    try {
      entries = await this.hub.execute<unknown[]>(sessionId, 'mobile: getContexts', []);
    } catch {
      entries = await this.hub.get<unknown[]>(sessionId, '/contexts');
    }
    return entries
      .map((entry) => normalizeContext(entry))
      .filter((info): info is WebViewInfo => info !== undefined && info.id !== NATIVE_CONTEXT);
  }

  async attachWebView(id: string): Promise<WebViewSession> {
    const sessionId = this.sessionId();
    await this.hub.post(sessionId, '/context', { name: id });
    debug('attached to %s', id);
    return new AppiumWebViewSession(this.hub, sessionId, id);
  }
}

class AppiumWebViewSession implements WebViewSession {
  constructor(
    private readonly hub: WebDriverClient,
    private readonly sessionId: string,
    private readonly contextId: string,
  ) { }

  async evaluate<T = unknown>(expr: string): Promise<T> {
    return await this.hub.execute<T>(this.sessionId, `return (${expr});`, []);
  }

  async goto(url: string): Promise<void> {
    await this.hub.post(this.sessionId, '/url', { url });
  }

  async goBack(): Promise<void> {
    await this.hub.post(this.sessionId, '/back', {});
  }

  async goForward(): Promise<void> {
    await this.hub.post(this.sessionId, '/forward', {});
  }

  async url(): Promise<string> {
    return await this.hub.get<string>(this.sessionId, '/url');
  }

  async title(): Promise<string> {
    return await this.hub.get<string>(this.sessionId, '/title');
  }

  async reload(): Promise<void> {
    await this.hub.post(this.sessionId, '/refresh', {});
  }

  async waitForLoadState(state: 'load' | 'domcontentloaded' = 'load'): Promise<void> {
    const acceptable = state === 'load' ? ['complete'] : ['interactive', 'complete'];
    const deadline = Date.now() + 30_000;
    for (; ;) {
      const readyState = await this.evaluate<string>('document.readyState').catch(() => '');
      if (acceptable.includes(readyState)) return;
      if (Date.now() >= deadline) {
        throw new Error(`TestingBotDriver: webview ${this.contextId} did not reach "${state}" within 30s`);
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  async close(): Promise<void> {
    await this.hub.post(this.sessionId, '/context', { name: NATIVE_CONTEXT });
    debug('detached from %s', this.contextId);
  }
}

/** Contexts arrive as plain names or driver-specific objects. */
function normalizeContext(entry: unknown): WebViewInfo | undefined {
  if (typeof entry === 'string') {
    return { id: entry, url: '', title: '' };
  }
  if (entry && typeof entry === 'object') {
    const record = entry as Record<string, unknown>;
    const pages = Array.isArray(record['pages']) ? record['pages'] as Record<string, unknown>[] : [];
    const id = str(record['id']) ?? str(record['name']) ?? str(record['webviewName']);
    if (!id) return undefined;
    return {
      id,
      url: str(record['url']) ?? str(pages[0]?.['url']) ?? '',
      title: str(record['title']) ?? str(pages[0]?.['title']) ?? '',
    };
  }
  return undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}
