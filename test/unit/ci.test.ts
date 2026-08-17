import { describe, expect, it } from 'vitest';
import { detectCiBuild } from '../../src/ci.js';
import { withAllocationContext, NoDeviceAvailableError } from '../../src/errors.js';

describe('detectCiBuild', () => {
  it('returns undefined outside CI', () => {
    expect(detectCiBuild({})).toBeUndefined();
  });

  it('TESTINGBOT_BUILD always wins', () => {
    expect(detectCiBuild({ TESTINGBOT_BUILD: 'release-7', GITHUB_ACTIONS: 'true' })).toBe('release-7');
  });

  it.each([
    [{ GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'testingbot/app', GITHUB_RUN_NUMBER: '42' }, 'testingbot/app #42'],
    [{ GITLAB_CI: 'true', CI_PROJECT_PATH: 'group/app', CI_PIPELINE_IID: '7' }, 'group/app #7'],
    [{ CIRCLECI: 'true', CIRCLE_PROJECT_REPONAME: 'app', CIRCLE_BUILD_NUM: '9' }, 'app #9'],
    [{ BUILDKITE: 'true', BUILDKITE_PIPELINE_SLUG: 'app', BUILDKITE_BUILD_NUMBER: '3' }, 'app #3'],
    [{ BITRISE_IO: 'true', BITRISE_APP_TITLE: 'MyApp', BITRISE_BUILD_NUMBER: '11' }, 'MyApp #11'],
    [{ JENKINS_URL: 'http://ci', JOB_NAME: 'app-tests', BUILD_NUMBER: '5' }, 'app-tests #5'],
  ])('detects %o', (env, expected) => {
    expect(detectCiBuild(env as Record<string, string>)).toBe(expected);
  });

  it('degrades to partial info when some variables are missing', () => {
    expect(detectCiBuild({ GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'o/r' })).toBe('o/r');
  });
});

describe('withAllocationContext', () => {
  it('adds criteria and a hint for known hub failures', () => {
    const wrapped = withAllocationContext(new Error('Unknown browserName: undefined'), 'android, emulator');
    expect(wrapped.message).toContain('android, emulator');
    expect(wrapped.message).toContain('Hint:');
    expect(wrapped.cause).toBeInstanceOf(Error);
  });

  it('never wraps the retriable class the pool instanceof-checks', () => {
    const retriable = new NoDeviceAvailableError('busy');
    expect(withAllocationContext(retriable, 'ios')).toBe(retriable);
  });
});
