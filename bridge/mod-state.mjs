// Other mods' state (Settings > Dynamic info > Other mods' state, docs/DYNAMIC_INFO.md): V's tiredness, hunger, thirst, nerve, withdrawal and so on, read
// by mod/mod-state.lua from the Dark Future mod when it is installed. This module validates that table and words it. Pure string work on data
// that already arrived: nothing is read, written or awaited here.
//
// The table: {darkFuture: {hydration, nutrition, energy, nerve, injury, humanity: 0-4 (Dark Future's stage, 0 fine to 4 worst),
//                           alcohol, nicotine, narcotic: {stage: 0-4, withdrawal: 0-5}}}. Keys are all optional; unknown keys are dropped.
//
// What a character may know (the same rule as the rest of the right-now block):
//   person / head  the companion in person and Johnny in V's head: every notable state. Johnny feels it from inside V, a companion sees and hears it
//                  in V, so both get the same plain wording (body language, not a diagnosis; the mod's name is never said).
//   ambient        a stranger: only what shows on a body, "V looks exhausted / parched / starving". Never nerve, withdrawal, injury, humanity.
//   phone / call / voice  nothing (a text or a call cannot show it, and an add-on voice gets no body of V's).
// Notable = for hunger, thirst and tiredness stage 1 to 4 of 4 for a companion or Johnny (Dark Future itself starts a status effect on V at stage 1,
// and a live test showed "V is hungry" was missed at 1) but only stage 3 or 4 for a stranger, who sees a body only when it is bad; for nerve,
// injury and humanity stage 3 or 4 (nerve sits at 1 all day); for withdrawal a level of 3 or more. The sentences ride the Background line
// (bridge/turn-context.mjs): told when new, changed, or after a long silence (bridge/scenery-memory.mjs, with the signature below), never on every
// turn, so a stage that holds is said once, not recited.
// At most two short sentences: the body (energy, thirst, hunger), then the rest (nerve, withdrawal, humanity, injury), at most three phrases each.

const BODY_KEYS = ['energy', 'hydration', 'nutrition'];                  // in the order a bystander notices them
const INNER_KEYS = ['nerve', 'withdrawal', 'humanity', 'injury'];         // the rest, in the order a companion notices them
const SUBSTANCES = ['alcohol', 'nicotine', 'narcotic'];
const STAGE_KEYS = ['hydration', 'nutrition', 'energy', 'nerve', 'injury', 'humanity'];
export const MIN_STAGE = 3, MIN_BODY_STAGE = 1, MIN_WITHDRAWAL = 3, MAX_PHRASES = 3;
// The word for each notable stage, after "V is" (person, head) or "V looks" (ambient: the body only).
const WORDS = {
  energy: {1: 'a little tired', 2: 'tired', 3: 'worn out', 4: 'exhausted'},
  hydration: {1: 'a little thirsty', 2: 'thirsty', 3: 'parched', 4: 'badly dehydrated'},
  nutrition: {1: 'a little hungry', 2: 'hungry', 3: 'very hungry', 4: 'starving'},
  nerve: {3: 'badly on edge', 4: 'at the end of their nerve'},
  humanity: {3: 'losing their grip on their humanity', 4: 'close to cyberpsychosis'},
  injury: {3: 'worn down by lasting injuries', 4: 'badly battered by lasting injuries'}};
const SUBSTANCE_WORDS = {alcohol: 'alcohol', nicotine: 'nicotine', narcotic: 'narcotics'};

const plain = value => !!value && typeof value === 'object' && !Array.isArray(value);
const whole = (value, low, high) => Number.isInteger(value) && value >= low && value <= high;

/**
 * The compact note of what the game side found (mod/mod-state.lua note(): "installed=yes read=ok stage=hydration0,nutrition1,energy0,nerve1"), kept only when it
 * is plain words and digits. It is no fact for the model: it is the first half of the turn's probe line (bridge/turn-context.mjs modsProbeLine). undefined otherwise.
 */
export function parseModsRead(value) {
  return typeof value === 'string' && value.length <= 160 && /^installed=(?:yes|no) read=[a-z-]+ stage=[a-z0-9,?-]+$/.test(value) ? value : undefined;
}

/** The snapshot's `mods` table from mod/mod-state.lua, validated; undefined when absent, malformed or empty. */
export function parseMods(value) {
  if (!plain(value) || !plain(value.darkFuture)) return undefined;
  const source = value.darkFuture, darkFuture = {};
  for (const key of STAGE_KEYS) if (whole(source[key], 0, 4)) darkFuture[key] = source[key];
  for (const key of SUBSTANCES) {
    const row = source[key];
    if (plain(row) && whole(row.withdrawal, 0, 5)) darkFuture[key] = {stage: whole(row.stage, 0, 4) ? row.stage : 0, withdrawal: row.withdrawal};
  }
  return Object.keys(darkFuture).length ? {darkFuture} : undefined;
}

// The body rows a stranger sees: only the bad stages.
const AMBIENT_MIN = MIN_STAGE;

// What is worth saying: {body: [{key, stage}], inner: [{key, stage, substances?}]} in the orders above, or null when nothing is. Withdrawal is one
// row for all substances (level 4 and 5 count as the worst stage, level 3 as the lesser).
function notable(mods, floor = MIN_BODY_STAGE) {
  const state = mods?.darkFuture;
  if (!plain(state)) return null;
  const body = BODY_KEYS.filter(key => whole(state[key], floor, 4)).map(key => ({key, stage: state[key]}));
  const substances = SUBSTANCES.filter(key => whole(state[key]?.withdrawal, MIN_WITHDRAWAL, 5));
  const inner = [];
  for (const key of INNER_KEYS) {
    if (key === 'withdrawal') {
      if (substances.length) inner.push({key, stage: Math.max(...substances.map(name => state[name].withdrawal)) >= 4 ? 4 : 3, substances});
    } else if (whole(state[key], MIN_STAGE, 4)) inner.push({key, stage: state[key]});
  }
  return body.length || inner.length ? {body, inner} : null;
}

/** A short text that changes when what would be said changes, or undefined when there is nothing to say. */
export function modsSignature(mods) {
  const found = notable(mods);
  if (!found) return undefined;
  return [...found.body, ...found.inner].map(row => `${row.key}${row.stage}${row.substances ? `:${row.substances.join('+')}` : ''}`).join(',');
}

const list = names => names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
// The worst first (stage 4 before 3), the listed order breaking ties; at most MAX_PHRASES.
const worstFirst = rows => rows.map((row, order) => ({...row, order})).sort((a, b) => b.stage - a.stage || a.order - b.order).slice(0, MAX_PHRASES);
const phrase = row => row.key === 'withdrawal' ? `in withdrawal from ${list(row.substances.map(name => SUBSTANCE_WORDS[name]))}` : WORDS[row.key][row.stage];

/** The sentences for this form of turn ('person', 'head', 'ambient', 'phone', 'call', 'voice'), [] when none. */
export function modsSentences(mods, form) {
  if (form !== 'person' && form !== 'head' && form !== 'ambient') return [];
  const found = notable(mods, form === 'ambient' ? AMBIENT_MIN : MIN_BODY_STAGE);
  if (!found) return [];
  const body = worstFirst(found.body).map(phrase);
  // A stranger sees a body, nothing more: "V looks exhausted and parched."
  if (form === 'ambient') return body.length ? [`V looks ${list(body)}.`] : [];
  const sentences = [];
  if (body.length) sentences.push(`V is ${list(body)}.`);
  const inner = worstFirst(found.inner).map(phrase);
  if (inner.length) sentences.push(`V is ${list(inner)}.`);
  return sentences;
}

/**
 * The same sentences for a turn where V asks about themself ("how do I look?", "do I seem okay?", "am I hungry?"), worded as the answer to that: plain, in the
 * right-now block (not the Background line, which says "mention only if it matters"), and not left out because the conversation heard it before. [] when none.
 * Live 2026-10-26: "V is a little hungry" in the Background line, told on an earlier turn, and a companion asked "how do I look" never said it.
 */
export function modsAskedSentences(mods, form) {
  const sentences = modsSentences(mods, form);
  // Live 2026-10-26 ("can you see information on the state of my body"): a companion answered "I'm not a med-scanner" with the state in the Background line. So the
  // answer is said to be plain to see, nothing to scan or read, and to be given in the character's own words.
  return sentences.length ? [...sentences, 'V is asking how they look or how they are, and this is plain to see on V (no scan or reading needed): say it in your own words.'] : [];
}

/** What became of V's state in this turn, for the probe line: where it went, or why it did not. `said`: the sentences for this form; `known`: the snapshot carried a state. */
export function modsDisposition({asked, said, known, told, split, form}) {
  if (asked && said) return 'right-now';
  if (said) return told ? 'none(told earlier in this talk, V did not ask)' : split ? 'background' : 'right-now';
  if (form !== 'person' && form !== 'head' && form !== 'ambient') return `none(a ${form} gets none)`;
  return known ? 'none(this stage is below the bar for this form)' : 'none(no stage worth saying)';
}
