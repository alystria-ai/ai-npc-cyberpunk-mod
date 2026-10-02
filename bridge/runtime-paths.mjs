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

// A portable worker must never combine packaged weights with a development
// adapter or put its cache back into the immutable application directory.
export const OMNI_RUNTIME_PATHS = Object.freeze({
  modelDirectory: 'CYBERPUNK_CONVAI_OMNI_MODEL',
  adapterDirectory: 'CYBERPUNK_CONVAI_OMNI_ADAPTER',
  referenceDirectory: 'CYBERPUNK_CONVAI_OMNI_REFERENCES',
  cacheDirectory: 'CYBERPUNK_CONVAI_OMNI_CACHE',
});

export function omniRuntimeOverrides(paths) {
  const result = {};
  for (const [field, name] of Object.entries(OMNI_RUNTIME_PATHS)) {
    const path = absoluteRuntimeOverride(paths?.[field], name);
    if (path !== undefined) result[name] = path;
  }
  if (!Object.keys(result).length) return undefined;
  if (Object.keys(result).length !== Object.keys(OMNI_RUNTIME_PATHS).length) {
    throw Error('Portable OmniVoice requires model, adapter, reference and cache paths together.');
  }
  return Object.freeze(result);
}
