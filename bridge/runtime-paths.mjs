import {isAbsolute} from 'node:path';

// Explicit runtime paths belong to the launcher/operator. Never turn a relative
// executable into a cwd/PATH lookup or interpolate its value into a shell.
export function absoluteRuntimeOverride(value, name) {
  if (value === undefined) return undefined;
  const fullyQualified = typeof value === 'string' && (process.platform !== 'win32'
    || /^(?:[a-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+(?:[\\/]|$))/i.test(value));
  if (typeof value !== 'string' || !value || value !== value.trim()
      || /[\x00-\x1f\x7f]/.test(value) || !isAbsolute(value) || !fullyQualified) {
    // Report the option, never private directory names or its supplied contents.
    throw Error(`${name} must be an absolute filesystem path.`);
  }
  return value;
}
