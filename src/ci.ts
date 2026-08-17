/**
 * Default the TestingBot `build` name from the CI environment so dashboard
 * sessions group by pipeline run without any configuration. An explicit
 * `build` option or TESTINGBOT_BUILD always wins. Deterministic across the
 * coordinator and worker processes, since they share the environment.
 */
export function detectCiBuild(env: Record<string, string | undefined> = process.env): string | undefined {
  if (env['TESTINGBOT_BUILD']) return env['TESTINGBOT_BUILD'];

  if (env['GITHUB_ACTIONS']) {
    return join(env['GITHUB_REPOSITORY'], num(env['GITHUB_RUN_NUMBER']));
  }
  if (env['GITLAB_CI']) {
    return join(env['CI_PROJECT_PATH'], num(env['CI_PIPELINE_IID'] ?? env['CI_PIPELINE_ID']));
  }
  if (env['CIRCLECI']) {
    return join(env['CIRCLE_PROJECT_REPONAME'], num(env['CIRCLE_BUILD_NUM']));
  }
  if (env['BUILDKITE']) {
    return join(env['BUILDKITE_PIPELINE_SLUG'], num(env['BUILDKITE_BUILD_NUMBER']));
  }
  if (env['BITRISE_IO']) {
    return join(env['BITRISE_APP_TITLE'], num(env['BITRISE_BUILD_NUMBER']));
  }
  if (env['TRAVIS']) {
    return join(env['TRAVIS_REPO_SLUG'], num(env['TRAVIS_BUILD_NUMBER']));
  }
  if (env['TF_BUILD']) { // Azure DevOps
    return join(env['BUILD_DEFINITIONNAME'], env['BUILD_BUILDNUMBER']);
  }
  if (env['JENKINS_URL']) {
    return join(env['JOB_NAME'], num(env['BUILD_NUMBER']));
  }
  if (env['TEAMCITY_VERSION']) {
    return join(env['TEAMCITY_PROJECT_NAME'], num(env['BUILD_NUMBER']));
  }
  return undefined;
}

function num(value: string | undefined): string | undefined {
  return value ? `#${value}` : undefined;
}

function join(...parts: (string | undefined)[]): string | undefined {
  const present = parts.filter((p): p is string => !!p);
  return present.length ? present.join(' ') : undefined;
}
