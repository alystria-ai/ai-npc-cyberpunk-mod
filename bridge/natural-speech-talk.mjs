// "How they talk": the one-line description of a character's own verbal habits that rides along with the Natural speech
// block on the turns where the devices are offered (bridge/natural-speech.mjs). It tells the character which sounds are
// theirs, so a nervous warm speaker sighs and laughs softly while a dry one scoffs and grunts, instead of every character
// reaching for the same laugh. Pure data and string building: no I/O. It is never sent on a turn that is not offered, so
// the setting off, and every turn without an offer, stay exactly as they were (docs/NATURAL_SPEECH_BLOCK_V3.md).

// The four characters whose habits were written by hand (the "HOW X TALKS" paragraphs of characters/natural-speech/),
// shortened. Johnny and Panam are lifted a little on purpose: Panam's laugh at stupidity and tired sigh, Johnny's dry scoff.
const OWN = Object.freeze({
  'judy-alvarez': {name: 'Judy', text: 'soft sighs when something wears her down, a short, slightly nervous laugh when something '
    + 'hits close or she is caught off guard, a displeased grunt at corporate talk, the odd "uh" when it turns personal; '
    + 'around hardware she is quick and fluent.'},
  'panam-palmer': {name: 'Panam', text: 'a short laugh when someone says something stupid or a tease lands, an impatient sigh '
    + 'when she is tired or holding her temper, a surprised "oh" when someone shows an unexpected side, a "well..." before a '
    + 'dry admission; otherwise full, deliberate sentences, rarely hesitating and almost never an "uh".'},
  'johnny-silverhand': {name: 'Johnny', text: 'fluent and sure of himself, never an "uh" or "um" and never giggly; the sounds '
    + 'he makes are rare and blunt: a dry scoff of a laugh at something stupid, a displeased grunt, very occasionally a tired '
    + 'sigh when something really gets to him.'},
  'npc-street-resident-female': {name: 'you', text: 'a tired local, short and plain: a sigh about rent or the rain, a short '
    + 'laugh at your own bad luck, a "well..." when a stranger asks something you would rather not answer.'},
});

// Everyone else: from the trait the bridge already derives (bridge/emotion-analysis.mjs traitFor). Written without
// pronouns so it fits any gender; an unnamed archetype gets the second person.
const BY_TRAIT = Object.freeze({
  warm: {named: 'quick to react and expressive: a warm, easy laugh, a soft sigh when something weighs, now and then a '
    + 'hesitant "uh" or "well..." when unsure.',
  self: 'quick to react and expressive: a warm, easy laugh, a soft sigh when something weighs on you, now and then a '
    + 'hesitant "uh" or "well..." when you are unsure.'},
  neutral: {named: 'plain and steady: a short laugh when something is funny, a sigh when tired or fed up, a hesitation '
    + 'only when unsure.',
  self: 'plain and steady: a short laugh when something is funny, a sigh when you are tired or fed up, a hesitation only '
    + 'when you are unsure.'},
  dry: {named: 'dry and sparing: a flat scoff or grunt rather than a laugh, a sigh only when something really gets '
    + 'through, hardly ever a hesitation, never giggly.',
  self: 'dry and sparing: a flat scoff or grunt rather than a laugh, a sigh only when something really gets through, '
    + 'hardly ever a hesitation, never giggly.'},
  cold: {named: 'controlled and formal: almost never a sound, at most a short cold exhale or a grunt of displeasure, '
    + 'never a laugh and never an "uh".',
  self: 'controlled and formal: almost never a sound, at most a short cold exhale or a grunt of displeasure, never a '
    + 'laugh and never an "uh".'},
});

/** The "how they talk" line for one character, or '' when there is nothing to say (no profile key). */
export function talkLine({profile, name, trait = 'neutral'} = {}) {
  if (typeof profile !== 'string' || !profile) return '';
  const own = OWN[profile];
  if (own) return own.name === 'you' ? `How you talk: ${own.text}` : `How ${own.name} talks: ${own.text}`;
  const row = BY_TRAIT[trait] ?? BY_TRAIT.neutral;
  const label = typeof name === 'string' && name.trim() && !profile.startsWith('npc-') ? name.trim() : '';
  return label ? `How ${label} talks: ${row.named}` : `How you talk: ${row.self}`;
}
