import createDebug from 'debug';
import type { ResolvedOptions } from './options.js';

const debug = createDebug('testingbot:tunnel');

interface RunningTunnel {
  close(callback: () => void): void;
}

type LauncherFn = (
  options: Record<string, unknown>,
  callback: (err: Error | null | undefined, tunnel: RunningTunnel) => void,
) => void;

/**
 * Starts/stops a TestingBot Tunnel around the run via the official
 * `testingbot-tunnel-launcher` package — an optional peer dependency, since
 * it needs Java on the machine. Only the coordinator's prepare()/dispose()
 * touch this; workers just put the tunnelIdentifier into their caps.
 */
export class TunnelManager {
  private running: RunningTunnel | undefined;

  async start(options: ResolvedOptions): Promise<void> {
    if (!options.tunnel || this.running) return;
    let launcher: LauncherFn;
    try {
      const mod = await import('testingbot-tunnel-launcher');
      launcher = (mod as { default?: LauncherFn }).default ?? (mod as unknown as LauncherFn);
    } catch {
      throw new Error(
        'The `tunnel` option needs the optional testingbot-tunnel-launcher package (and Java). ' +
        'Install it with: npm install --save-dev testingbot-tunnel-launcher — or start the tunnel ' +
        'yourself and use the `tunnelIdentifier` option instead.',
      );
    }

    const { identifier, ...rest } = options.tunnel;
    const launcherOptions: Record<string, unknown> = {
      apiKey: options.key,
      apiSecret: options.secret,
      ...(options.tunnelIdentifier ? { tunnelIdentifier: options.tunnelIdentifier } : {}),
      ...rest,
    };
    void identifier; // already folded into options.tunnelIdentifier at resolve time

    debug('starting TestingBot Tunnel%s', options.tunnelIdentifier ? ` (identifier ${options.tunnelIdentifier})` : '');
    this.running = await new Promise<RunningTunnel>((resolve, reject) => {
      launcher(launcherOptions, (err, tunnel) => (err ? reject(err) : resolve(tunnel)));
    });
    debug('tunnel ready');
  }

  async stop(): Promise<void> {
    const tunnel = this.running;
    if (!tunnel) return;
    this.running = undefined;
    await new Promise<void>((resolve) => tunnel.close(resolve));
    debug('tunnel closed');
  }
}
