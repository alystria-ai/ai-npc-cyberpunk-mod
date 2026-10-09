// "How they talk": the one-line description of a character's own verbal habits that rides along with the Natural speech
// block on the turns where the devices are offered (bridge/natural-speech.mjs). It tells the character which sounds are
// theirs, so a nervous warm speaker sighs and laughs softly while a dry one scoffs and grunts, instead of every character
// reaching for the same laugh. Pure data and string building: no I/O. It is never sent on a turn that is not offered, so
// the setting off, and every turn without an offer, stay exactly as they were (docs/NATURAL_SPEECH_BLOCK_V3.md).

// The four characters whose habits were written by hand (the "HOW X TALKS" paragraphs of characters/natural-speech/),
// shortened. Johnny and Panam are lifted a little on purpose: Panam's laugh at stupidity and tired sigh, Johnny's dry scoff.
const OWN = Object.freeze({
  'judy-alvarez': 'soft sighs when something wears you down, a short, slightly nervous laugh when something '
    + 'hits close or you are caught off guard, a displeased grunt at corporate talk, the odd "uh" when it turns personal; '
    + 'around hardware you are quick and fluent.',
  'panam-palmer': 'a short laugh when someone says something stupid or a tease lands, an impatient sigh '
    + 'when you are tired or holding your temper, a surprised "oh" when someone shows an unexpected side, a "well..." before a '
    + 'dry admission; otherwise full, deliberate sentences, rarely hesitating and almost never an "uh".',
  'johnny-silverhand': 'fluent and sure of yourself, never an "uh" or "um" and never giggly; the sounds '
    + 'you make are rare and blunt: a dry scoff of a laugh at something stupid, a displeased grunt, very occasionally a tired '
    + 'sigh when something really gets to you.',
  'npc-street-resident-female': 'a tired local, short and plain: a sigh about rent or the rain, a short '
    + 'laugh at your own bad luck, a "well..." when a stranger asks something you would rather not answer.',
});

// Everyone else: from the trait the bridge already derives (bridge/emotion-analysis.mjs traitFor). Every line is addressed to the
// character ("you"), never "How Evelyn Parker talks:": a block that describes the speaker by name, in the third person, teaches
// the model to narrate the character instead of speaking as one (docs/FIRST_PERSON_RULE.md).
const BY_TRAIT = Object.freeze({
  warm: 'quick to react and expressive: a warm, easy laugh, a soft sigh when something weighs on you, now and then a '
    + 'hesitant "uh" or "well..." when you are unsure.',
  neutral: 'plain and steady: a short laugh when something is funny, a sigh when you are tired or fed up, a hesitation only '
    + 'when you are unsure.',
  dry: 'dry and sparing: a flat scoff or grunt rather than a laugh, a sigh only when something really gets through, '
    + 'hardly ever a hesitation, never giggly.',
  cold: 'controlled and formal: almost never a sound, at most a short cold exhale or a grunt of displeasure, never a '
    + 'laugh and never an "uh".',
});

/** The "how you talk" line for one character, or '' when there is nothing to say (no profile key). `name` is accepted and ignored. */
export function talkLine({profile, trait = 'neutral'} = {}) {
  if (typeof profile !== 'string' || !profile) return '';
  return `How you talk: ${OWN[profile] ?? BY_TRAIT[trait] ?? BY_TRAIT.neutral}`;
}
