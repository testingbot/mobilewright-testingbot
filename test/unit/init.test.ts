import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_ANSWERS, renderConfig, renderSampleTest, runInit } from '../../src/init.js';

function fakeIo(answers: Record<string, string> = {}) {
  const logs: string[] = [];
  return {
    io: {
      ask: async (question: string, fallback: string) =>
        Object.entries(answers).find(([key]) => question.includes(key))?.[1] ?? fallback,
      log: (message: string) => { logs.push(message); },
    },
    logs,
  };
}

describe('init scaffolder', () => {
  it('renders a sample test that compiles under strict TypeScript', () => {
    // The bundleId fixture is typed `string | undefined` while launchApp()
    // takes a `string`, so a bare `bundleId` makes the very first file a new
    // user opens fail to typecheck. init has just written the bundleId into
    // the config, so asserting it is correct.
    const sample = renderSampleTest(DEFAULT_ANSWERS);
    expect(sample).toContain('launchApp(bundleId!)');
    expect(sample).not.toMatch(/launchApp\(bundleId\)/);
  });

  it('renders a config that matches the chosen targets and apps', () => {
    const config = renderConfig({
      bundleId: 'com.tb.Demo',
      targets: ['ios-simulator', 'ios-real'],
      apps: { 'ios-simulator': './sim.zip', 'ios-real': './app.ipa' },
      sessionPerTest: true,
    });
    expect(config).toContain("bundleId: 'com.tb.Demo'");
    expect(config).toContain("'ios-simulator': './sim.zip',");
    expect(config).toContain("'ios-real': './app.ipa',");
    expect(config).toContain('sessionPerTest: true');
    expect(config).toContain("deviceType: 'simulator'");
    expect(config).toContain("deviceType: 'real'");
    expect(config).not.toContain('android');
  });

  it('writes config + sample test and lists missing dependencies', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tb-init-'));
    const { io, logs } = fakeIo();
    await runInit(dir, io, false);
    expect(readFileSync(join(dir, 'mobilewright.config.ts'), 'utf-8')).toContain('TestingBotDriver');
    expect(readFileSync(join(dir, 'app.test.ts'), 'utf-8')).toContain('@mobilewright/test');
    expect(logs.join('\n')).toContain('npm install --save-dev mobilewright');
  });

  it('answers drive the interactive flow', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tb-init-'));
    const { io } = fakeIo({
      'bundle id': 'com.tb.Interactive',
      'Targets': 'ios-real',
      '.ipa': './signed.ipa',
      'per test': 'y',
    });
    await runInit(dir, io, true);
    const config = readFileSync(join(dir, 'mobilewright.config.ts'), 'utf-8');
    expect(config).toContain('com.tb.Interactive');
    expect(config).toContain("'ios-real': './signed.ipa'");
    expect(config).toContain('sessionPerTest: true');
  });

  it('refuses to overwrite an existing config', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tb-init-'));
    writeFileSync(join(dir, 'mobilewright.config.ts'), '// precious');
    const { io, logs } = fakeIo();
    await runInit(dir, io, false);
    expect(readFileSync(join(dir, 'mobilewright.config.ts'), 'utf-8')).toBe('// precious');
    expect(logs.join('\n')).toContain('not overwriting');
  });

  it('defaults stay in sync with the documented quickstart', () => {
    expect(renderConfig(DEFAULT_ANSWERS)).toContain("android: './build/app.apk'");
  });
});
