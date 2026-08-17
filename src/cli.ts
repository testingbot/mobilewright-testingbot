#!/usr/bin/env node
import { createInterface } from 'node:readline/promises';
import { runInit } from './init.js';
import { VERSION } from './version.js';

const command = process.argv[2];
const nonInteractive = process.argv.includes('--yes') || process.argv.includes('-y') || !process.stdin.isTTY;

async function main(): Promise<void> {
  if (command === 'init') {
    const rl = nonInteractive ? undefined : createInterface({ input: process.stdin, output: process.stdout });
    try {
      console.log(`@testingbot/mobilewright-driver ${VERSION} — project setup\n`);
      await runInit(process.cwd(), {
        ask: async (question, fallback) => {
          if (!rl) return fallback;
          const answer = (await rl.question(`${question} [${fallback}]: `)).trim();
          return answer || fallback;
        },
        log: (message) => console.log(message),
      }, !nonInteractive);
    } finally {
      rl?.close();
    }
    return;
  }

  console.log(`@testingbot/mobilewright-driver ${VERSION}

Usage:
  npx @testingbot/mobilewright-driver init [--yes]

  init   Scaffold mobilewright.config.ts and a sample test in the current
         directory. --yes (or a non-interactive shell) accepts all defaults.

Docs: https://github.com/testingbot/mobilewright-testingbot`);
  if (command !== undefined && command !== 'help' && command !== '--help') process.exitCode = 1;
}

main().catch((err) => {
  console.error(String(err));
  process.exitCode = 1;
});
