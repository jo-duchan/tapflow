/** `CI` is set by GitHub Actions, GitLab CI, CircleCI, Buildkite and most others (`false`, `0` and empty mean
 *  not CI). Jenkins and Azure Pipelines set no `CI`, so their own markers count too. */
export function runningInCI(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env['CI']
  if (v !== undefined && v !== '' && v.toLowerCase() !== 'false' && v !== '0') return true
  return Boolean(env['JENKINS_URL'] || env['TF_BUILD'])
}

export interface CiContext {
  provider: string
  branch?: string
  commit?: string
  jobUrl?: string
}

/** Every value present, or undefined — a link built from half its parts points somewhere else. */
function all(...parts: (string | undefined)[]): string[] | undefined {
  return parts.every((p) => p !== undefined && p !== '') ? (parts as string[]) : undefined
}

/**
 * Where a CI run came from, for its run record: the provider, the branch, the commit and a link back to the job.
 * Null outside CI. A CI that is not one of these is still CI, with nothing more to say about it.
 */
export function ciContext(env: NodeJS.ProcessEnv = process.env): CiContext | null {
  if (!runningInCI(env)) return null
  const pick = (provider: string, branch?: string, commit?: string, jobUrl?: string): CiContext => ({
    provider,
    ...(branch ? { branch } : {}),
    ...(commit ? { commit } : {}),
    ...(jobUrl ? { jobUrl } : {}),
  })

  if (env['GITHUB_ACTIONS'] === 'true') {
    const gh = all(env['GITHUB_SERVER_URL'], env['GITHUB_REPOSITORY'], env['GITHUB_RUN_ID'])
    // `GITHUB_HEAD_REF` is the PR's branch and is empty on a push, where `GITHUB_REF_NAME` is the branch.
    // The workflow run, not the job: no variable names the job. `/attempts/N` keeps a re-run's link on its own
    // attempt rather than the latest.
    const attempt = env['GITHUB_RUN_ATTEMPT'] ? `/attempts/${env['GITHUB_RUN_ATTEMPT']}` : ''
    return pick('github', env['GITHUB_HEAD_REF'] || env['GITHUB_REF_NAME'], env['GITHUB_SHA'],
      gh && `${gh[0]}/${gh[1]}/actions/runs/${gh[2]}${attempt}`)
  }
  if (env['GITLAB_CI']) return pick('gitlab', env['CI_COMMIT_REF_NAME'], env['CI_COMMIT_SHA'], env['CI_JOB_URL'])
  if (env['CIRCLECI']) return pick('circleci', env['CIRCLE_BRANCH'], env['CIRCLE_SHA1'], env['CIRCLE_BUILD_URL'])
  if (env['BUILDKITE']) {
    const url = env['BUILDKITE_BUILD_URL']
    return pick('buildkite', env['BUILDKITE_BRANCH'], env['BUILDKITE_COMMIT'],
      url && (env['BUILDKITE_JOB_ID'] ? `${url}#${env['BUILDKITE_JOB_ID']}` : url))
  }
  // A multibranch pipeline names the branch in `BRANCH_NAME` (`PR-12` for a pull request, whose source branch is
  // `CHANGE_BRANCH`); the Git plugin's `GIT_BRANCH` is `origin/main`-shaped and the fallback for freestyle jobs.
  if (env['JENKINS_URL']) {
    return pick('jenkins', env['CHANGE_BRANCH'] || env['BRANCH_NAME'] || env['GIT_BRANCH'], env['GIT_COMMIT'], env['BUILD_URL'])
  }
  if (env['TF_BUILD']) {
    const az = all(env['SYSTEM_COLLECTIONURI'], env['SYSTEM_TEAMPROJECT'], env['BUILD_BUILDID'])
    // `BUILD_SOURCEBRANCHNAME` is the ref's last segment: `feature/tools` reads `tools`, and every PR build `merge`.
    const ref = env['SYSTEM_PULLREQUEST_SOURCEBRANCH'] || env['BUILD_SOURCEBRANCH']
    return pick('azure', ref?.replace(/^refs\/heads\//, ''), env['BUILD_SOURCEVERSION'],
      az && `${az[0]}${encodeURIComponent(az[1])}/_build/results?buildId=${az[2]}`)
  }
  return pick('ci')
}
