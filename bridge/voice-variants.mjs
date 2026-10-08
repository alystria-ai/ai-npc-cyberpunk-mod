import {createHash} from 'node:crypto';

// Several local voices for one ambient profile (docs/LOCAL_VOICES.md, "Several voices per profile").
//
// Variant 1 is the profile key itself; further voices are registered in the same voice configurations as
// `<profileKey>-v2` .. `<profileKey>-v4`. A variant key is a voice-registry entry only: it is not a profile, has no
// Convai character and never appears as a conversation profile, a route key or in any per-profile list.
// Routing (is this profile spoken locally, by which provider) always uses the BASE key; only the voice that is
// finally synthesized uses the picked key. Pure functions, no I/O.
export const FIRST_VARIANT = 2;
export const LAST_VARIANT = 4;
const VARIANT = /^(.+)-v([2-4])$/;

export const isVariantKey = key => typeof key === 'string' && VARIANT.test(key);
// The profile a variant key belongs to; any other key is its own base.
export const baseProfileOf = key => typeof key === 'string' ? VARIANT.exec(key)?.[1] ?? key : key;
// Registry keys that are real profiles (variant keys removed).
export const withoutVariants = keys => [...keys].filter(key => !isVariantKey(key));

// The voices of one profile among `knownKeys` (a Set or array): the base key if present, then the existing
// `-v2..-v4` keys, in that order.
export function variantKeys(profileKey, knownKeys) {
  if (typeof profileKey !== 'string' || !profileKey || isVariantKey(profileKey)) return [];
  const known = knownKeys instanceof Set ? knownKeys : new Set(knownKeys ?? []);
  const keys = [];
  if (known.has(profileKey)) keys.push(profileKey);
  for (let number = FIRST_VARIANT; number <= LAST_VARIANT; number++) {
    const key = `${profileKey}-v${number}`;
    if (known.has(key)) keys.push(key);
  }
  return keys;
}

// The stable identity of the speaking NPC: a vendor's shop record (set for one-shop vendors) beats the actor entity
// ("123456ULL"). null when the request carries neither.
export function variantSeed(input) {
  const text = value => typeof value === 'string' && value.length > 0 ? value : null;
  return text(input?.archetype?.memoryKey) ?? text(input?.entity);
}

// The voice key that speaks this NPC: SHA-256 of `${profileKey}|${seed}`, modulo the number of AVAILABLE variants
// (the ones the current backend can speak). No seed, or no usable variant, gives the base key. The same inputs
// always give the same key, across restarts.
export function pickVoiceKey(profileKey, seed, available) {
  if (typeof seed !== 'string' || !seed) return profileKey;
  const choices = variantKeys(profileKey, available);
  if (!choices.length) return profileKey;
  if (choices.length === 1) return choices[0];
  const digest = createHash('sha256').update(`${profileKey}|${seed}`).digest();
  return choices[Number(digest.readBigUInt64BE(0) % BigInt(choices.length))];
}
