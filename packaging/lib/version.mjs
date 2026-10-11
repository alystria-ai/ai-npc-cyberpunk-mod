// Release version numbers. The scheme is 0.N (0.1, 0.2, ...) with 0.N.M for a hotfix (0.2.1),
// plus -rc.N pre-releases (0.2-rc.1). The legacy 2077.N form of the first build (2077.1) still passes:
// the pattern takes two to four dot-separated numbers, with an optional -pre/+build suffix.
// .github/workflows/release.yml checks the same pattern (release.test.mjs keeps them in step).
export const VERSION_PATTERN = /^\d+(?:\.\d+){1,3}(?:[-+][0-9A-Za-z.-]+)?$/;

export const isReleaseVersion = value => typeof value === 'string' && VERSION_PATTERN.test(value);

// package.json wants semver (three numbers): 0.2 -> 0.2.0, 0.2.1 stays, 0.2.1.1 -> 0.2.1-1.
export function npmVersion(value) {
  const [core, suffix = ''] = /^([\d.]+)(.*)$/.exec(value).slice(1);
  const parts = core.split('.');
  while (parts.length < 3) parts.push('0');
  const extra = parts.length > 3 ? `-${parts.splice(3).join('.')}` : '';
  return parts.join('.') + extra + suffix.replace(/^-/, extra ? '.' : '-');
}
