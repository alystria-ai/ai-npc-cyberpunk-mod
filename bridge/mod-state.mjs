// Other mods' state (Settings > Dynamic info > Other mods' state, docs/DYNAMIC_INFO.md): V's tiredness, hunger, thirst, nerve, withdrawal and so on, read
// by mod/mod-state.lua from the Dark Future mod when it is installed. This module validates that table and words it. Pure string work on data
// that already arrived: nothing is read, written or awaited here.
//
// The table: {darkFuture: {hydration, nutrition, energy, nerve, injury, humanity: 0-4 (Dark Future's stage, 0 fine to 4 worst),
//                           alcohol, nicotine, narcotic: {stage: 0-4, withdrawal: 0-5}},
//             fleshAndChrome: {breath: 1-4, energy: 1-4, drinks: 1-3, smoke: 1}   (mod/vixen-state.lua: stamina, the daily energy pool, drink and a cigarette just smoked)
//             injuries: {limp, arm, head, bleed: 1-3, treated: 1}}                  (mod/vixen-state.lua: Injuries' tier in effect per kind, and "a healing item holds one back")
// Keys are all optional; unknown keys are dropped. Flesh and Chrome's energy and Dark Future's energy are the same thing to a bystander: one phrase, the worse stage.
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
// At most four short sentences, at most three phrases each: the body (breath, energy, thirst, hunger), V's injuries (Injuries: bleeding, a held arm, a limp), what V has had
// (drink, a cigarette), then the rest (nerve, withdrawal, humanity, injury). A stranger gets at most the body, the injuries that show and "V looks drunk and smells of booze".
// Drink at stage 2 and 3 is said as how V is ("V is drunk: slurring, unsteady ..."), not as something V "has had": docs/FRESH_FACTS.md.

const BODY_KEYS = ['breath', 'energy', 'hydration', 'nutrition'];       // in the order a bystander notices them
const HURT_KEYS = ['bleed', 'arm', 'limp', 'head', 'treated'];            // Injuries: what shows on V's body, the worst-looking first
const TRACE_KEYS = ['drinks', 'smoke'];                                   // Flesh and Chrome: what a person next to V smells or notices
const INNER_KEYS = ['nerve', 'withdrawal', 'humanity', 'injury'];         // the rest, in the order a companion notices them
const SUBSTANCES = ['alcohol', 'nicotine', 'narcotic'];
const STAGE_KEYS = ['hydration', 'nutrition', 'energy', 'nerve', 'injury', 'humanity'];
const FAC_KEYS = {breath: 4, energy: 4, drinks: 3, smoke: 1}, INJURY_KEYS = {limp: 3, arm: 3, head: 3, bleed: 3, treated: 1};
export const MIN_STAGE = 3, MIN_BODY_STAGE = 1, MIN_WITHDRAWAL = 3, MAX_PHRASES = 3;
// The word for each notable stage, after "V is" (person, head) or "V looks" (ambient: the body only).
const WORDS = {
  breath: {1: 'a little winded', 2: 'out of breath', 3: 'gasping for air', 4: 'too spent to run or fight'},
  energy: {1: 'a little tired', 2: 'tired', 3: 'worn out', 4: 'exhausted'},
  hydration: {1: 'a little thirsty', 2: 'thirsty', 3: 'parched', 4: 'badly dehydrated'},
  nutrition: {1: 'a little hungry', 2: 'hungry', 3: 'very hungry', 4: 'starving'},
  nerve: {3: 'badly on edge', 4: 'at the end of their nerve'},
  humanity: {3: 'losing their grip on their humanity', 4: 'close to cyberpsychosis'},
  injury: {3: 'worn down by lasting injuries', 4: 'badly battered by lasting injuries'},
  bleed: {1: 'bleeding a little', 2: 'bleeding', 3: 'bleeding heavily'},
  arm: {1: 'favouring one arm', 2: 'holding a broken arm', 3: 'barely able to use a broken arm'},
  limp: {1: 'limping a little', 2: 'limping badly', 3: 'barely able to walk on an injured leg'},
  head: {1: 'a little dazed', 2: 'dazed', 3: 'badly concussed'},
  treated: {1: 'bandaged up'}};
// A stranger sees blood, a limp, a held arm: after "V looks".
const AMBIENT_HURT = {bleed: {1: 'to be bleeding', 2: 'to be bleeding', 3: 'to be bleeding heavily'}, arm: {2: 'to be holding a hurt arm', 3: 'to be holding a hurt arm'},
  limp: {2: 'to be limping', 3: 'to be limping'}, head: {3: 'to be dazed'}};
// After "V has": a drink or two and a cigarette. Heavier drinking is not something V "has had": a small model took "V has had a lot to drink" for nothing worth saying (a live test of 2026-10-27:
// V asked "am i drunk" and was told "Not drunk, just wired"), so stage 2 and 3 are said as how V is, in plain vivid words (docs/FRESH_FACTS.md).
const TRACE_WORDS = {drinks: {1: 'had a drink or two'}, smoke: {1: 'just had a cigarette'}};
const DRUNK_SENTENCES = {2: 'V is tipsy: loose, a little loud, smelling of booze.', 3: 'V is drunk: slurring, unsteady on their feet, reeking of booze.'};
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

/** The same for the Flesh and Chrome and Injuries notes (mod/vixen-state.lua): "installed=yes read=ok state=breath0,energy1,drinks0,smoke0". The first half of the fac: and inj: probe lines. */
export function parseVixenRead(value) {
  return typeof value === 'string' && value.length <= 160 && /^installed=(?:yes|no) read=[a-z-]+ state=[a-z0-9,?-]+$/.test(value) ? value : undefined;
}

/** The snapshot's `mods` table from mod/mod-state.lua and mod/vixen-state.lua, validated; undefined when absent, malformed or empty. */
export function parseMods(value) {
  if (!plain(value)) return undefined;
  const result = {};
  if (plain(value.darkFuture)) {
    const source = value.darkFuture, darkFuture = {};
    for (const key of STAGE_KEYS) if (whole(source[key], 0, 4)) darkFuture[key] = source[key];
    for (const key of SUBSTANCES) {
      const row = source[key];
      if (plain(row) && whole(row.withdrawal, 0, 5)) darkFuture[key] = {stage: whole(row.stage, 0, 4) ? row.stage : 0, withdrawal: row.withdrawal};
    }
    if (Object.keys(darkFuture).length) result.darkFuture = darkFuture;
  }
  // Flesh and Chrome and Injuries send only the stages worth saying: 1 and up, to the most each key has.
  for (const [name, keys] of [['fleshAndChrome', FAC_KEYS], ['injuries', INJURY_KEYS]]) {
    if (!plain(value[name])) continue;
    const rows = {};
    for (const [key, most] of Object.entries(keys)) if (whole(value[name][key], 1, most)) rows[key] = value[name][key];
    if (Object.keys(rows).length) result[name] = rows;
  }
  return Object.keys(result).length ? result : undefined;
}

// The bars for a stranger, who sees a body only when it is bad: the body rows from stage 3 (breathlessness from 2), injuries by how they show.
const AMBIENT_MIN = MIN_STAGE;
const AMBIENT_FLOOR = {breath: 2, bleed: 1, arm: 2, limp: 2, head: 3, drinks: 3};

// What is worth saying: {body, hurt, trace, inner}, each a list of {key, stage, substances?} in the orders above, or null when nothing is. Withdrawal is one
// row for all substances (level 4 and 5 count as the worst stage, level 3 as the lesser). A stranger (`ambient`) gets the body, the visible injuries and strong drink only.
function notable(mods, ambient = false) {
  if (!plain(mods)) return null;
  const df = plain(mods.darkFuture) ? mods.darkFuture : {}, fac = plain(mods.fleshAndChrome) ? mods.fleshAndChrome : {}, injuries = plain(mods.injuries) ? mods.injuries : {};
  const bar = key => ambient ? AMBIENT_FLOOR[key] ?? AMBIENT_MIN : MIN_BODY_STAGE;
  // Both mods have a daily energy: one phrase, the worse of the two.
  const stages = {breath: fac.breath, energy: Math.max(whole(df.energy, 0, 4) ? df.energy : 0, whole(fac.energy, 0, 4) ? fac.energy : 0), hydration: df.hydration, nutrition: df.nutrition};
  const body = BODY_KEYS.filter(key => whole(stages[key], bar(key), 4)).map(key => ({key, stage: stages[key]}));
  let hurt = HURT_KEYS.filter(key => (!ambient || AMBIENT_HURT[key]) && whole(injuries[key], bar(key), 3)).map(key => ({key, stage: injuries[key]}));
  // "Bandaged up" says a healing item holds an injury back: said only when nothing else shows.
  if (hurt.some(row => row.key !== 'treated')) hurt = hurt.filter(row => row.key !== 'treated');
  const trace = TRACE_KEYS.filter(key => (!ambient || key === 'drinks') && whole(fac[key], bar(key), 3)).map(key => ({key, stage: fac[key]}));
  const substances = ambient ? [] : SUBSTANCES.filter(key => whole(df[key]?.withdrawal, MIN_WITHDRAWAL, 5));
  const inner = [];
  if (!ambient) {
    for (const key of INNER_KEYS) {
      if (key === 'withdrawal') {
        if (substances.length) inner.push({key, stage: Math.max(...substances.map(name => df[name].withdrawal)) >= 4 ? 4 : 3, substances});
      } else if (whole(df[key], MIN_STAGE, 4)) inner.push({key, stage: df[key]});
    }
  }
  return body.length || hurt.length || trace.length || inner.length ? {body, hurt, trace, inner} : null;
}

/** A short text that changes when what would be said changes, or undefined when there is nothing to say. */
export function modsSignature(mods) {
  const found = notable(mods);
  if (!found) return undefined;
  return [...found.body, ...found.hurt, ...found.trace, ...found.inner].map(row => `${row.key}${row.stage}${row.substances ? `:${row.substances.join('+')}` : ''}`).join(',');
}

const list = names => names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
// The worst first (stage 4 before 3), the listed order breaking ties; at most MAX_PHRASES.
const worstFirst = rows => rows.map((row, order) => ({...row, order})).sort((a, b) => b.stage - a.stage || a.order - b.order).slice(0, MAX_PHRASES);
const phrase = row => row.key === 'withdrawal' ? `in withdrawal from ${list(row.substances.map(name => SUBSTANCE_WORDS[name]))}` : WORDS[row.key][row.stage];

/** The sentences for this form of turn ('person', 'head', 'ambient', 'phone', 'call', 'voice'), [] when none. */
export function modsSentences(mods, form) {
  if (form !== 'person' && form !== 'head' && form !== 'ambient') return [];
  const found = notable(mods, form === 'ambient');
  if (!found) return [];
  const body = worstFirst(found.body).map(phrase);
  // A stranger sees a body, nothing more: "V looks exhausted and parched." "V looks to be bleeding." "V looks drunk and smells of booze."
  if (form === 'ambient') {
    const sentences = [];
    if (body.length) sentences.push(`V looks ${list(body)}.`);
    const hurt = worstFirst(found.hurt).map(row => AMBIENT_HURT[row.key][row.stage]);
    if (hurt.length) sentences.push(`V looks ${list([...new Set(hurt)])}.`);
    if (found.trace.length) sentences.push('V looks drunk and smells of booze.');
    return sentences;
  }
  const sentences = [];
  if (body.length) sentences.push(`V is ${list(body)}.`);
  const hurt = worstFirst(found.hurt).map(phrase);
  if (hurt.length) sentences.push(`V is ${list(hurt)}.`);
  const trace = worstFirst(found.trace);
  for (const row of trace) if (row.key === 'drinks' && DRUNK_SENTENCES[row.stage]) sentences.push(DRUNK_SENTENCES[row.stage]);
  const has = trace.filter(row => !(row.key === 'drinks' && DRUNK_SENTENCES[row.stage])).map(row => TRACE_WORDS[row.key][row.stage]);
  if (has.length) sentences.push(`V has ${list(has)}.`);
  const inner = worstFirst(found.inner).map(phrase);
  if (inner.length) sentences.push(`V is ${list(inner)}.`);
  return sentences;
}

// What the game side read, from its compact notes (mod/mod-state.lua, mod/vixen-state.lua): {key: stage} for the keys it read as a number, {} when none. A '?' (not running or no answer)
// and a '-' (system not found) are no reading. Only a note that says read=ok counts: "installed=yes read=ok stage=hydration0,nutrition1" -> {hydration: 0, nutrition: 1}.
export function readStages(note) {
  const found = typeof note === 'string' ? /^installed=yes read=ok (?:stage|state)=([a-z0-9,?-]+)$/.exec(note) : null;
  const stages = {};
  if (found) for (const part of found[1].split(',')) { const row = /^([a-z]+)(\d)$/.exec(part); if (row) stages[row[1]] = Number(row[2]); }
  return stages;
}

// What is fine, said only for what the game side actually read as fine (a stage below the bar for this form, and not one of the notable rows): the words after "V looks well:" or "Otherwise V is".
// A need that was not read (a '?' or '-' in the note, a mod not installed or switched off) is never claimed. A stranger sees a body only: he gets "V looks well." from the same bars.
const FINE_ORDER = [['nutrition', 'fed'], ['energy', 'rested'], ['hydration', 'not thirsty'], ['breath', 'not winded'], ['nerve', 'steady']];
const VISIBLE_HURT = ['limp', 'arm', 'head', 'bleed'];
function fineWords(mods, form, reads) {
  const ambient = form === 'ambient', found = notable(mods, ambient);
  const shown = new Set(found ? [...found.body, ...found.hurt, ...found.inner].map(row => row.key) : []);
  const bar = key => ambient ? AMBIENT_FLOOR[key] ?? AMBIENT_MIN : key === 'nerve' ? MIN_STAGE : MIN_BODY_STAGE;
  const df = readStages(reads?.darkFuture), fac = readStages(reads?.fleshAndChrome), inj = readStages(reads?.injuries);
  // Both mods have a daily energy: fine only when every reading of it is fine.
  const stages = {nutrition: [df.nutrition], energy: [df.energy, fac.energy], hydration: [df.hydration], breath: [fac.breath], nerve: ambient ? [] : [df.nerve]};
  const words = [];
  for (const [key, word] of FINE_ORDER) {
    const seen = stages[key].filter(stage => stage !== undefined);
    if (seen.length && !shown.has(key) && seen.every(stage => stage < bar(key))) words.push(word);
  }
  if (VISIBLE_HURT.every(key => inj[key] !== undefined && inj[key] < (ambient ? AMBIENT_FLOOR[key] ?? AMBIENT_MIN : MIN_BODY_STAGE)) && !(found?.hurt.length)) words.push('free of visible injuries');
  return words;
}

/**
 * The same sentences for a turn where V asks about themself ("how do I look?", "do I seem okay?", "am I hungry?"), worded as the answer to that: plain, in the
 * right-now block (not the Background line, which says "mention only if it matters"), and not left out because the conversation heard it before. [] when none.
 * Live 2026-10-26: "V is a little hungry" in the Background line, told on an earlier turn, and a companion asked "how do I look" never said it.
 * Live 2026-10-27 (Dark Future, nothing wrong, `sent=none(no stage worth saying)`): V asked "can you see my body state?" and the companion said no. With `reads` (the game side's compact notes
 * {darkFuture, fleshAndChrome, injuries}, kept by parseModsRead and parseVixenRead) the answer is also given when everything read is fine: "V looks well: fed, rested, not thirsty, steady."
 * Only what the notes say was read as a number; a need that was not read is not claimed.
 */
export function modsAskedSentences(mods, form, reads) {
  if (form !== 'person' && form !== 'head' && form !== 'ambient') return [];
  const sentences = modsSentences(mods, form), fine = fineWords(mods, form, reads);
  if (form === 'ambient') { if (!sentences.length && fine.length) sentences.push('V looks well.'); }
  else if (fine.length) sentences.push(sentences.length ? `Otherwise V is ${list(fine)}.` : `V looks well: ${fine.join(', ')}.`);
  // Live 2026-10-26 ("can you see information on the state of my body"): a companion answered "I'm not a med-scanner" with the state in the Background line. So the
  // answer is said to be plain to see, nothing to scan or read, and to be given in the character's own words.
  return sentences.length ? [...sentences, 'V is asking how they look or how they are, and this is plain to see on V (no scan or reading needed): say it in your own words.'] : [];
}

/** What became of V's state in this turn, for the probe line: where it went, or why it did not. `said`: the sentences for this form; `known`: the snapshot carried a state. */
export function modsDisposition({asked, said, known, told, split, form}) {
  if (asked && said) return 'right-now';
  if (asked) return 'right-now(fine)';   // V asked and everything read was fine: told as such (modsAskedSentences)
  if (said) return told ? 'none(told earlier in this talk, V did not ask)' : split ? 'background' : 'right-now';
  if (form !== 'person' && form !== 'head' && form !== 'ambient') return `none(a ${form} gets none)`;
  return known ? 'none(this stage is below the bar for this form)' : 'none(no stage worth saying)';
}
