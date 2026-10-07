// Release version numbers. The scheme is 2077.N (2077.1, 2077.2, ...) with 2077.N.M for a hotfix,
// so two to four dot-separated numbers are accepted, with an optional -pre/+build suffix.
// .github/workflows/release.yml checks the same pattern (release.test.mjs keeps them in step).
export const VERSION_PATTERN = /^\d+(?:\.\d+){1,3}(?:[-+][0-9A-Za-z.-]+)?$/;

export const isReleaseVersion = value => typeof value === 'string' && VERSION_PATTERN.test(value);

// package.json wants semver (three numbers): 2077.1 -> 2077.1.0, 2077.1.1 stays, 2077.1.1.1 -> 2077.1.1-1.
export function npmVersion(value) {
  const [core, suffix = ''] = /^([\d.]+)(.*)$/.exec(value).slice(1);
  const parts = core.split('.');
  while (parts.length < 3) parts.push('0');
  const extra = parts.length > 3 ? `-${parts.splice(3).join('.')}` : '';
  return parts.join('.') + extra + suffix.replace(/^-/, extra ? '.' : '-');
}
