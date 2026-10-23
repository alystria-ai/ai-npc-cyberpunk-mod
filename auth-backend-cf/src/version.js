// Mod versions look like 0.2, 0.2.1 or 0.2-rc.1 (packaging/lib/version.mjs). The suffix is ignored when comparing.
// Identical to auth-backend/api/_lib/version.js (test/parity.test.mjs compares the two).
export const VERSION_PATTERN = /^\d{1,6}(?:\.\d{1,6}){1,3}(?:[-+][0-9A-Za-z.-]{1,30})?$/;

export function parseVersion(text) {
  if (typeof text !== 'string' || !VERSION_PATTERN.test(text)) return null;
  return text.split(/[-+]/)[0].split('.').map(Number);
}

/** negative, zero or positive, like a comparator; null when either side is not a version. */
export function compareVersions(a, b) {
  const left = parseVersion(a), right = parseVersion(b);
  if (!left || !right) return null;
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference) return difference;
  }
  return 0;
}
