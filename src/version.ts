import { createRequire } from 'node:module';

// Resolves to the package root from both src/ (tests) and dist/ (published).
const { version } = createRequire(import.meta.url)('../package.json') as { version: string };

export const VERSION: string = version;

/** Sent on every hub and REST request so TestingBot can attribute traffic. */
export const USER_AGENT = `testingbot-mobilewright-driver/${version} (node ${process.version})`;
