import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AppSlot } from './options.js';

/** Answers collected by `init` (defaults applied when non-interactive). */
export interface InitAnswers {
  bundleId: string;
  targets: InitTarget[];
  apps: Partial<Record<AppSlot, string>>;
  sessionPerTest: boolean;
}

export type InitTarget = 'android-emulator' | 'android-real' | 'ios-simulator' | 'ios-real';

export const DEFAULT_ANSWERS: InitAnswers = {
  bundleId: 'com.example.MyApp',
  targets: ['android-emulator'],
  apps: { android: './build/app.apk' },
  sessionPerTest: false,
};

const TARGET_PROJECTS: Record<InitTarget, string> = {
  'android-emulator': `    { name: 'android-emulator', use: { platform: 'android', deviceType: 'emulator' } },`,
  'android-real': `    { name: 'android', use: { platform: 'android', deviceType: 'real' } },`,
  'ios-simulator': `    { name: 'ios-simulator', use: { platform: 'ios', deviceType: 'simulator' } },`,
  'ios-real': `    { name: 'ios', use: { platform: 'ios', deviceType: 'real' } },`,
};

export function renderConfig(answers: InitAnswers): string {
  const apps = Object.entries(answers.apps)
    .map(([slot, path]) => `      ${slot.includes('-') ? `'${slot}'` : slot}: '${path}',`)
    .join('\n');
  return `import { defineConfig } from 'mobilewright';
import { TestingBotDriver } from '@testingbot/mobilewright-driver';

export default defineConfig({
  testDir: '.',
  bundleId: '${answers.bundleId}',
  driver: new TestingBotDriver({
    // TestingBot sessions start with the app pre-installed — declare it per
    // platform/device type. Local paths (.apk / .ipa / .zip) upload automatically.
    apps: {
${apps}
    },${answers.sessionPerTest ? `
    sessionPerTest: true, // one TestingBot session, video, and verdict per test` : ''}
  }),
  projects: [
${answers.targets.map((t) => TARGET_PROJECTS[t]).join('\n')}
  ],
});
`;
}

export function renderSampleTest(answers: InitAnswers): string {
  return `import { test, expect } from '@mobilewright/test';

test('app launches', async ({ device, screen, bundleId }) => {
  await device.launchApp(bundleId);
  // Adjust to something your app actually shows:
  await expect(screen.getByText('Welcome', { exact: false })).toBeVisible();
});
`;
}

export interface InitIo {
  ask(question: string, fallback: string): Promise<string>;
  log(message: string): void;
}

/** Scaffold mobilewright.config.ts + a sample test in `dir`. */
export async function runInit(dir: string, io: InitIo, interactive: boolean): Promise<void> {
  const configPath = join(dir, 'mobilewright.config.ts');
  if (existsSync(configPath)) {
    io.log(`${configPath} already exists — not overwriting. Delete it first to re-run init.`);
    return;
  }

  let answers = DEFAULT_ANSWERS;
  if (interactive) {
    const bundleId = await io.ask('App bundle id', DEFAULT_ANSWERS.bundleId);
    const targetsRaw = await io.ask(
      'Targets (comma-separated: android-emulator, android-real, ios-simulator, ios-real)',
      DEFAULT_ANSWERS.targets.join(','),
    );
    const targets = targetsRaw.split(',').map((t) => t.trim()).filter((t): t is InitTarget => t in TARGET_PROJECTS);
    const apps: Partial<Record<AppSlot, string>> = {};
    if (targets.some((t) => t.startsWith('android'))) {
      apps['android'] = await io.ask('Android app (.apk path)', './build/app.apk');
    }
    if (targets.includes('ios-simulator')) {
      apps['ios-simulator'] = await io.ask('iOS simulator build (.zip/.app path)', './build/app-sim.zip');
    }
    if (targets.includes('ios-real')) {
      apps['ios-real'] = await io.ask('iOS device build (test-signed .ipa path)', './build/app.ipa');
    }
    const perTest = await io.ask('One TestingBot session per test? (y/N)', 'n');
    answers = {
      bundleId,
      targets: targets.length ? targets : DEFAULT_ANSWERS.targets,
      apps: Object.keys(apps).length ? apps : DEFAULT_ANSWERS.apps,
      sessionPerTest: /^y/i.test(perTest),
    };
  }

  await writeFile(configPath, renderConfig(answers));
  io.log(`Wrote ${configPath}`);

  const testPath = join(dir, 'app.test.ts');
  if (!existsSync(testPath)) {
    await writeFile(testPath, renderSampleTest(answers));
    io.log(`Wrote ${testPath}`);
  }

  const missing = await missingDependencies(dir);
  io.log('');
  io.log('Next steps:');
  if (missing.length) {
    io.log(`  npm install --save-dev ${missing.join(' ')}`);
  }
  io.log('  export TESTINGBOT_KEY=...      # https://testingbot.com/members/user/edit');
  io.log('  export TESTINGBOT_SECRET=...');
  io.log('  npx mobilewright test');
}

async function missingDependencies(dir: string): Promise<string[]> {
  const wanted = ['mobilewright', '@mobilewright/test', '@testingbot/mobilewright-driver'];
  try {
    const pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf-8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const present = { ...pkg.dependencies, ...pkg.devDependencies };
    return wanted.filter((name) => !present[name]);
  } catch {
    return wanted;
  }
}
