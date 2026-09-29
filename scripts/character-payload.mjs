// Convai's create/update request uses three separate flat text fields.
// Readback nests the latter two under speaking_style. See docs/CHARACTER_API.md.
import {isDeepStrictEqual} from 'node:util';

export const apiCharacterName = profile => profile.name
  .replace(/[^\p{L}\p{N} ]/gu, ' ').replace(/\s+/g, ' ').trim();

export function characterPayload(profile) {
  for (const field of ['name', 'voice', 'model', 'backstory',
    'speakingStyleDescription', 'speakingStyleSampleDialogues']) {
    if (typeof profile[field] !== 'string' || !profile[field].trim()) {
      throw Error(`Missing ${field} for ${profile.key}; rebuild the character profiles.`);
    }
  }
  return {
    charName: apiCharacterName(profile),
    voiceType: profile.voice,
    backstory: profile.backstory,
    speaking_style_description: profile.speakingStyleDescription,
    speaking_style_sample_dialogues: profile.speakingStyleSampleDialogues,
    model_group_name: profile.model,
  };
}

export function characterMatches(actual, expected) {
  return actual?.character_name === expected.charName
    && actual.voice_type === expected.voiceType
    && actual.backstory === expected.backstory
    && actual.speaking_style?.description === expected.speaking_style_description
    && actual.speaking_style?.sample_dialogues === expected.speaking_style_sample_dialogues;
}

export function verifyCharacter(id, actual, expected, key) {
  if (actual?.character_id !== id || !characterMatches(actual, expected)) {
    throw Error(`Profile readback mismatch: ${key} (name, voice or one of the three description fields).`);
  }
}

export function verifyMemoryConfiguration(before, actual, key) {
  // Core returns credit estimates alongside the actual memory policy. Exclude
  // those server-provided cost values while requiring every configuration
  // field, including memory enablement, to remain intact.
  const configuration = value => Object.fromEntries(Object.entries(value?.memory_settings || {})
    .filter(([field]) => !['ltm_min_credit_cost_e8', 'kb_min_credit_cost_e8'].includes(field)));
  if (!isDeepStrictEqual(configuration(before), configuration(actual))) {
    throw Error(`Memory configuration changed during profile update: ${key}. Inspect the saved before/readback snapshots.`);
  }
}
