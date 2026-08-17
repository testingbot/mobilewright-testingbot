import { detectCiBuild } from './ci.js';

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
  /**
   * Build name for grouping sessions on the dashboard (`tb:options.build`).
   * Defaults from the CI environment (GitHub Actions, GitLab, CircleCI,
   * Buildkite, Bitrise, Travis, Azure, Jenkins, TeamCity — e.g.
   * "owner/repo #123") or the TESTINGBOT_BUILD variable.
   */
  build?: string;
  /** Device timezone (tz database name, e.g. "Europe/Brussels"). Default: "Etc/UTC". */
  timeZone?: string;
  /** Route device traffic through a proxy in this country ("DE", "US", "*" = random). */
  geoCountryCode?: string;
  /** Simulate network conditions: a preset ("Edge", "3G", "4G", "airplane") or custom speeds. */
  throttleNetwork?: string | { downloadSpeed: number; uploadSpeed: number; latency: number; loss: number };
  /** Capture a screenshot at every test step. Default: false. */
  screenshots?: boolean;
  /** Record a video of each session. Default: true. */
  video?: boolean;
  /** Command-log capture: true, false, or 'strip-parameters' (redacts request params). */
  recordLogs?: boolean | 'strip-parameters';
  /** Make test results publicly accessible. Default: false. */
  public?: boolean;
  /** Custom metadata (release, commit hash, ...) shown on the test detail page. */
  extra?: string;
  /** Restrict allocation to tablets only. */
  tabletOnly?: boolean;
  /** Restrict allocation to phones only. */
  phoneOnly?: boolean;
  /**
   * Route sessions through a running TestingBot Tunnel with this identifier
   * (`tb:options.tunnelIdentifier`). Start the tunnel yourself, or use the
   * `tunnel` option to have the driver manage one.
   */
  tunnelIdentifier?: string;
  /**
   * Have the driver start a TestingBot Tunnel before the run and stop it
   * afterwards, so tests can reach localhost/staging servers. Requires the
   * optional `testingbot-tunnel-launcher` package (and Java) on the machine.
   * Pass `true`, or an object with a tunnel `identifier` and any other
   * testingbot-tunnel-launcher options.
   */
  tunnel?: boolean | ({ identifier?: string } & Record<string, unknown>);
  /** Extra W3C/Appium capabilities, merged last (escape hatch). */
  capabilities?: Record<string, unknown>;
  /** Extra `tb:options` entries, merged last (escape hatch). */
  tbOptions?: Record<string, unknown>;
  /** Report pass/fail to TestingBot after the run. Default: 'on'. */
  testResults?: 'on' | 'off';
  /**
   * Start a fresh TestingBot session for every test instead of reusing the
   * device slot's session across tests. One dashboard entry, video, and
   * pass/fail per test — at the cost of session startup time (device boot)
   * on every test. Default: false (mobilewright's pool reuses sessions).
   */
  sessionPerTest?: boolean;
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
  timeZone: string | undefined;
  geoCountryCode: string | undefined;
  throttleNetwork: string | { downloadSpeed: number; uploadSpeed: number; latency: number; loss: number } | undefined;
  screenshots: boolean | undefined;
  video: boolean;
  recordLogs: boolean | 'strip-parameters' | undefined;
  public: boolean | undefined;
  extra: string | undefined;
  tabletOnly: boolean | undefined;
  phoneOnly: boolean | undefined;
  tunnelIdentifier: string | undefined;
  tunnel: false | ({ identifier?: string } & Record<string, unknown>);
  capabilities: Record<string, unknown>;
  tbOptions: Record<string, unknown>;
  testResults: 'on' | 'off';
  sessionPerTest: boolean;
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
    build: options.build ?? detectCiBuild(),
    timeZone: options.timeZone,
    geoCountryCode: options.geoCountryCode,
    throttleNetwork: options.throttleNetwork,
    screenshots: options.screenshots,
    video: options.video ?? true,
    recordLogs: options.recordLogs,
    public: options.public,
    extra: options.extra,
    tabletOnly: options.tabletOnly,
    phoneOnly: options.phoneOnly,
    tunnelIdentifier: options.tunnelIdentifier ?? (typeof options.tunnel === 'object' ? options.tunnel.identifier : undefined),
    tunnel: options.tunnel === true ? {} : (options.tunnel || false),
    capabilities: options.capabilities ?? {},
    tbOptions: options.tbOptions ?? {},
    testResults: options.testResults ?? 'on',
    sessionPerTest: options.sessionPerTest ?? false,
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
