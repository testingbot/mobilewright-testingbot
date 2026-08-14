/**
 * Which allocations an app entry applies to. Specific keys win over
 * platform-wide ones ('ios-real' beats 'ios').
 */
export type AppSlot =
  | 'android'
  | 'android-emulator'
  | 'android-real'
  | 'ios'
  | 'ios-simulator'
  | 'ios-real';

export interface TestingBotDriverOptions {
  /**
   * App under test per platform/device type. TestingBot sessions must start
   * with an app (or a browser) — there is no app-less session or mid-session
   * install — so the driver uploads these at allocation time and starts the
   * session with `appium:app`. Values are local paths (.apk/.ipa/.zip) or
   * existing storage URLs ("tb://...").
   *
   *   apps: { android: './build/app.apk', 'ios-simulator': './build/app.zip', 'ios-real': './build/app.ipa' }
   */
  apps?: Partial<Record<AppSlot, string>>;
  /** TestingBot API key. Default: TESTINGBOT_KEY (or TB_KEY) env variable. */
  key?: string;
  /** TestingBot API secret. Default: TESTINGBOT_SECRET (or TB_SECRET) env variable. */
  secret?: string;
  /** WebDriver hub URL. Default: https://hub.testingbot.com/wd/hub */
  hubUrl?: string;
  /** REST API base URL. Default: https://api.testingbot.com/v1 */
  apiUrl?: string;
  /**
   * Max time to wait for a device allocation (POST /session), in ms. The hub
   * queues the request until a matching device frees up and gives up after
   * 390s, so the default (395s) lets the hub's own verdict arrive first.
   */
  allocationTimeout?: number;
  /** Per-WebDriver-command timeout, in ms. Default: 60000. */
  commandTimeout?: number;
  /**
   * TestingBot idle timeout in seconds (`tb:options.idletimeout`). Pooled
   * device slots sit idle between tests, so this defaults higher than
   * TestingBot's own default of 130. Default: 230.
   */
  idleTimeout?: number;
  /** TestingBot max session duration in seconds (`tb:options.maxduration`). */
  maxDuration?: number;
  /** Pin the Appium version TestingBot uses (`tb:options.appiumVersion`). */
  appiumVersion?: string;
  /** Test name shown on the TestingBot dashboard (`tb:options.name`). */
  name?: string;
  /** Build name for grouping sessions on the dashboard (`tb:options.build`). */
  build?: string;
  /** Extra W3C/Appium capabilities, merged last (escape hatch). */
  capabilities?: Record<string, unknown>;
  /** Extra `tb:options` entries, merged last (escape hatch). */
  tbOptions?: Record<string, unknown>;
  /** Report pass/fail to TestingBot after the run. Default: 'on'. */
  testResults?: 'on' | 'off';
}

export interface ResolvedOptions {
  apps: Partial<Record<AppSlot, string>>;
  key: string;
  secret: string;
  hubUrl: string;
  apiUrl: string;
  allocationTimeout: number;
  commandTimeout: number;
  idleTimeout: number;
  maxDuration: number | undefined;
  appiumVersion: string | undefined;
  name: string | undefined;
  build: string | undefined;
  capabilities: Record<string, unknown>;
  tbOptions: Record<string, unknown>;
  testResults: 'on' | 'off';
}

/**
 * Resolve options against environment variables and defaults. Missing
 * credentials are tolerated here (`key`/`secret` become empty strings): the
 * config file constructing the driver is imported in every mobilewright
 * process, so throwing from the constructor would break unrelated commands.
 * `prepare()` fails fast instead.
 */
export function resolveOptions(options: TestingBotDriverOptions = {}): ResolvedOptions {
  return {
    apps: options.apps ?? {},
    key: options.key ?? process.env['TESTINGBOT_KEY'] ?? process.env['TB_KEY'] ?? '',
    secret: options.secret ?? process.env['TESTINGBOT_SECRET'] ?? process.env['TB_SECRET'] ?? '',
    hubUrl: (options.hubUrl ?? 'https://hub.testingbot.com/wd/hub').replace(/\/+$/, ''),
    apiUrl: (options.apiUrl ?? 'https://api.testingbot.com/v1').replace(/\/+$/, ''),
    allocationTimeout: options.allocationTimeout ?? 395_000,
    commandTimeout: options.commandTimeout ?? 60_000,
    idleTimeout: options.idleTimeout ?? 230,
    maxDuration: options.maxDuration,
    appiumVersion: options.appiumVersion,
    name: options.name,
    build: options.build,
    capabilities: options.capabilities ?? {},
    tbOptions: options.tbOptions ?? {},
    testResults: options.testResults ?? 'on',
  };
}

/** Ensure credentials are present, with an actionable message when not. */
export function requireCredentials(opts: ResolvedOptions): void {
  if (!opts.key || !opts.secret) {
    throw new Error(
      'TestingBot credentials are missing. Set TESTINGBOT_KEY and TESTINGBOT_SECRET ' +
      'environment variables, or pass { key, secret } to new TestingBotDriver(...). ' +
      'Find your credentials at https://testingbot.com/members/user/edit',
    );
  }
}
