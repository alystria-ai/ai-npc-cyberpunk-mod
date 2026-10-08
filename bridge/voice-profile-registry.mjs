// A character profile conditions one shared model. This registry contains no
// provider IDs, dialogue memory or generated audio, and never aliases a missing
// reference to another character. The worker verifies the actual file/hash.
export const LEGACY_LOCAL_VOICE_KEYS = Object.freeze([
  'johnny-silverhand', 'judy-alvarez', 'panam-palmer',
]);
export const VOICE_PROFILE_LIMITS = Object.freeze({profiles: 1024, transcript: 12_000,
  path: 512, startupProfiles: 3, cachedProfiles: 8});

const object = value => value && typeof value === 'object' && !Array.isArray(value);
const keyValid = value => typeof value === 'string' && /^[a-z0-9][a-z0-9-]{0,79}$/.test(value)
  && !['constructor', 'prototype', '__proto__'].includes(value);
const referenceValid = value => typeof value === 'string' && value.length <= VOICE_PROFILE_LIMITS.path
  && value.startsWith('runtime/voice-references/') && value.endsWith('.wav')
  && !/[\\\x00-\x1f\x7f:]/.test(value) && !value.split('/').some(part => !part || part === '.' || part === '..');
const transcriptValid = value => typeof value === 'string' && value.trim().length > 0
  && value.length <= VOICE_PROFILE_LIMITS.transcript && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value);

export function createVoiceProfileRegistry(config = {}) {
  if (!object(config)) throw Error('Invalid local voice configuration');
  if (config.version !== undefined && ![1, 2].includes(config.version)) throw Error('Invalid local voice configuration version');
  if (!['convai', 'hybrid'].includes(config.provider ?? 'convai')) throw Error('Unknown local speech provider');
  if (config.provider === 'hybrid' && config.engine !== 'omnivoice') throw Error('Local voices require OmniVoice');
  if (config.steps !== undefined && ![16, 32].includes(config.steps)) throw Error('Invalid local voice quality');
  const source = config.voices ?? {};
  if (!object(source) || Object.keys(source).length > VOICE_PROFILE_LIMITS.profiles) throw Error('Invalid local voice registry');
  const sourceKeys = Object.keys(source);
  if (sourceKeys.length && (config.version ?? 1) === 1
      && (sourceKeys.length !== LEGACY_LOCAL_VOICE_KEYS.length
        || sourceKeys.some(key => !LEGACY_LOCAL_VOICE_KEYS.includes(key)))) {
    throw Error('Expanded local voice profiles require configuration version 2');
  }
  const profiles = Object.create(null), unavailable = Object.create(null);
  for (const [key, value] of Object.entries(source)) {
    if (!keyValid(key) || !object(value)) throw Error('Invalid local voice profile');
    const status = value.status ?? 'ready';
    if (!['ready', 'unprepared', 'unavailable'].includes(status)) throw Error('Invalid local voice profile status');
    if (status !== 'ready') { unavailable[key] = status; continue; }
    if (!referenceValid(value.reference) || !/^[a-f0-9]{64}$/.test(value.sha256 ?? '')
        || !transcriptValid(value.transcript)) throw Error('Invalid local voice reference');
    // Snapshot rather than retaining caller-owned descriptors. Later config
    // edits cannot silently switch an utterance's reference or speaker.
    profiles[key] = Object.freeze({reference: value.reference, sha256: value.sha256,
      transcript: value.transcript, status: 'ready'});
  }
  const keys = Object.freeze(Object.keys(profiles).sort());
  const preparation = config.preparation;
  if (preparation !== undefined && (!object(preparation)
      || !['eager', 'lazy'].includes(preparation.mode))) throw Error('Invalid voice preparation policy');
  const mode = preparation?.mode ?? (sourceKeys.length <= VOICE_PROFILE_LIMITS.startupProfiles ? 'eager' : 'lazy');
  const startup = preparation?.startupProfiles ?? (mode === 'eager' ? keys
    : LEGACY_LOCAL_VOICE_KEYS.filter(key => Object.hasOwn(profiles, key)));
  if (!Array.isArray(startup) || startup.length > VOICE_PROFILE_LIMITS.startupProfiles
      || new Set(startup).size !== startup.length || startup.some(key => !Object.hasOwn(profiles, key))
      || (mode === 'eager' && (startup.length !== keys.length || keys.some(key => !startup.includes(key))))) {
    throw Error('Invalid voice startup profiles');
  }
  const cacheLimit = preparation?.maxCachedProfiles ?? VOICE_PROFILE_LIMITS.cachedProfiles;
  if (!Number.isInteger(cacheLimit) || cacheLimit < 1 || cacheLimit > VOICE_PROFILE_LIMITS.cachedProfiles
      || startup.length > cacheLimit) throw Error('Invalid voice reference cache limit');
  const policy = Object.freeze({mode, startupProfiles: Object.freeze([...startup]), maxCachedProfiles: cacheLimit});
  Object.freeze(profiles); Object.freeze(unavailable);
  return Object.freeze({profiles, unavailable, keys, preparation: policy,
    has: key => Object.hasOwn(profiles, key),
    status: key => Object.hasOwn(profiles, key) ? 'ready' : unavailable[key] ?? 'missing'});
}
