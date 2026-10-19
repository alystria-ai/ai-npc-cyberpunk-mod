// Johnny in your head (docs/JOHNNY_IN_YOUR_HEAD.md): what a head turn tells Johnny besides the companion context he already gets.
// mod/johnny-head.lua sends {version: 1, stage, milestones} on a private turn whose partner is Johnny in V's head; this module validates
// it (bridge/protocol.mjs parseHead) and words two things: where he is (the first sentence of the right-now block, bridge/turn-context.mjs)
// and where he and V stand plus how to answer "what next?" (a world block right after it, bridge/quest-context.mjs). Pure; nothing is
// written to memory. The stage comes from the save's own quest facts, so the words follow the save; nothing here guesses a percentage.

export const HEAD_PROFILE = 'johnny-silverhand';
const STAGES = new Set(['wary', 'grudging', 'friends', 'close']);
// The milestones in the order mod/johnny-head.lua lists them, each as Johnny would hear it (his own perspective, "you" is Johnny).
const MILESTONES = Object.freeze({
  alt: 'you and V reached Alt beyond the Blackwall',
  bender: "you had a night out in V's body and handed it back",
  porsche: 'V found your old Porsche',
  'second-chance': 'V gave you one last chance at the oil fields',
  'rogue-date': 'you had your night out with Rogue',
  reunion: 'Samurai played the reunion concert',
});
const STANDING = Object.freeze({
  wary: 'You and V are stuck with each other: the Relic put you in V\'s head and it is killing V. There is no trust yet; you needle V, and V has no reason to like you.',
  grudging: 'You and V have been through a few things since the Relic. There is grudging respect between you, not friendship, and neither of you has said so.',
  friends: 'At the oil fields V gave you one last chance and you said you would try. You are friends now in your own abrasive way, and you mean it when you back V.',
  close: 'You and V have been through a lot together since the oil fields. You trust V and V trusts you; you still give V hell, but you are on V\'s side.',
});
export const MAX_CHARS = 900;

const plain = value => !!value && typeof value === 'object' && !Array.isArray(value);

/** {version: 1, stage, milestones} from the game -> {stage, milestones}, or null. CET sends an empty Lua list as {}. */
export function parseHead(value) {
  if (!plain(value) || value.version !== 1 || !STAGES.has(value.stage)) return null;
  const rows = Array.isArray(value.milestones) ? value.milestones
    : plain(value.milestones) && Object.keys(value.milestones).length === 0 ? [] : null;
  if (!rows || rows.length > Object.keys(MILESTONES).length) return null;
  const milestones = [...new Set(rows.filter(id => typeof id === 'string' && Object.hasOwn(MILESTONES, id)))];
  return {stage: value.stage, milestones};
}

// The head of a turn, or null: only Johnny's own private turn, never a group round or a reaction.
export const headOf = input => input && input.profileKey === HEAD_PROFILE && !input.group && !input.reaction && plain(input.head)
  && STAGES.has(input.head.stage) ? input.head : null;

const listOf = items => items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;

/** Where he and V stand, what they have been through, and how to answer "what should I do next?". '' for any other turn. */
export function headContext(input) {
  const head = headOf(input);
  if (!head) return '';
  const lines = ['YOU AND V (from this save\'s story, this conversation only)', STANDING[head.stage]];
  const done = head.milestones.filter(id => id !== 'second-chance').map(id => MILESTONES[id]);
  if (done.length) lines.push(`Behind you both: ${listOf(done)}.`);
  lines.push('When V asks what to do next, pick one of V\'s open jobs listed in this context and say which you would do and why, in your'
    + ' own voice: your own unfinished business and buying V time matter to you; corp errands bore you. If no jobs are listed, say you'
    + ' do not know what is on V\'s list. Never invent a job.');
  lines.push('Bring this up only when it fits; never recite it.');
  const text = lines.join('\n');
  return text.length <= MAX_CHARS ? text : text.slice(0, text.lastIndexOf('\n', MAX_CHARS));
}

// ---- Johnny speaks up (phase 2): his own unprompted remark, an automatic reaction like a companion's battle line -------------------
// mod/johnny-remarks.lua sends {kind: 'head', event, facts, expiresAt} with his head field. The facts are plain values the game read
// (a roster character's name, a journal title, a romance fact's meaning); they are quoted to the model as data, never as instructions.
const EVENTS = new Set(['person', 'quest', 'romance', 'place', 'relic', 'fight']);
const ROMANCE = Object.freeze({together: name => `V and ${name} are together now; it has just become a romance in this save.`,
  friends: name => `V and ${name} have just settled on staying friends, not lovers.`,
  declined: name => `V has just turned ${name} down.`,
  night: name => `V has just spent a night with ${name}.`});
// The places of mod/johnny-remarks.lua M.PLACES (the same keys; a test holds the Lua table, this one and the research file together):
// how to say where V is, and what he knows about it, each note only from his intrinsic claims or knowledge rules
// (research/cyberpunk/native-reviews/johnny-places-20261019.json lists the sources and the evidence of every row).
//   note     what he knows about the place, said when the gate is met; '' says the place name alone
//   gate     a milestone id of his head field that the note needs (null: whenever he is in V's head)
//   altNote  said instead of the note when the game's own rule for it is met by this save (the Lua read it: facts.alt)
export const PLACES = Object.freeze({
  afterlife: {phrase: 'the Afterlife, Little China, Watson', gate: null,
    note: '',
    altNote: "Here V paid Rogue for the Hellman lead, and she sent V on to Panam. You were along for it, in V's head."},
  'arasaka-tower': {phrase: 'Corpo Plaza, City Center, where Arasaka Tower stands', gate: null,
    note: 'You say you took Arasaka Tower down in 2023 for Alt. That is your account: the records disagree on who did it and how many died, and your codex says you died in that attack.',
    altNote: 'You say you took Arasaka Tower down in 2023 for Alt, and V has lived through your memory of that raid. The records disagree on who did it and how many died.'},
  embers: {phrase: 'Embers, the Glen, Heywood', gate: null,
    note: '',
    altNote: "At Embers Hanako offered to lead V to Mikoshi under Arasaka Tower if V testified against Yorinobu. That was her offer; you heard it from inside V's head."},
  pacifica: {phrase: 'Pacifica', gate: 'alt',
    note: "In the Voodoo Boys' data fortress Maman Brigitte pulled a fragment of you off V's chip and sent V into the deep Net; you and V reached Alt beyond the Blackwall."},
  badlands: {phrase: 'the Badlands', note: '', gate: null},
  'oil-field': {phrase: 'the North Sunrise oil field, the Badlands', gate: 'second-chance',
    note: 'At the oil fields V gave you one last chance, and you said you would try.'},
  dogtown: {phrase: 'Dogtown', gate: null,
    note: '',
    altNote: 'Songbird promised V a cure in her first bargain. That was her offer, not proof that it works.'},
  'viktors-clinic': {phrase: "Viktor's clinic, Little China, Watson", gate: null,
    note: "Here Viktor told V the Relic was overwriting V's consciousness with your construct, and that V had only a few weeks left."},
  'kerry-estate': {phrase: "Kerry's estate, North Oaks, Westbrook", gate: null,
    note: "Kerry's place. You once urged him to quit Samurai and find his own path, and you still think his titles are kitsch.",
    altNote: "Kerry's place. Here Kerry recognized you talking through V, and you pitched bringing Samurai back."},
  'denny-estate': {phrase: "Denny's estate, North Oaks, Westbrook", gate: null,
    note: "Denny's place. You credit her with real talent and backbone, even when she tries your patience."},
  totentanz: {phrase: 'the Totentanz, Northside, Watson', gate: null,
    note: '',
    altNote: "V got Nancy out of the Totentanz alive; you were along for it, in V's head."},
});
// An episode of the Relic's sickness on V (mod/johnny-relic.lua: a status effect with the gameplay tag JohnnySickness, the breathing camera and
// the fullscreen distortion), said by how bad the game made it. What he knows is the head field's own: the Relic is killing V.
export const RELIC_SEVERITY = Object.freeze({low: 'a mild one', medium: 'a bad one', heavy: 'a severe one'});
// The end of a fight (mod/johnny-remarks.lua fightCounts): how long it lasted and how many went down, from the game's own counters, which
// count everything V's side did. Small whole numbers only; said with the hedge that allies' kills are in the count.
const FIGHT_LIMITS = Object.freeze({seconds: 3600, dead: 99, alive: 99});
const count = (value, max) => Number.isInteger(value) && value >= 0 && value <= max ? value : null;
const REMARK_WORDS = 25;
const cleanText = (value, limit) => typeof value === 'string' && value.length <= limit * 4
  ? value.replace(/<[^>]*>/g, '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, limit) || null : null;

/** The reaction of a remark -> {kind: 'head', event, facts, expiresAt, maxWords}, or null. Needs his profile and a valid head field. */
export function parseHeadReaction(value, head, profileKey) {
  if (!plain(value) || value.kind !== 'head' || !head || profileKey !== HEAD_PROFILE || !EVENTS.has(value.event)
      || !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= 0 || !plain(value.facts)) return null;
  const facts = {};
  if (value.event === 'person' || value.event === 'romance') {
    facts.name = cleanText(value.facts.name, 60);
    if (!facts.name) return null;
  }
  if (value.event === 'quest') {
    facts.title = cleanText(value.facts.title, 160);
    if (!facts.title || !['succeeded', 'failed'].includes(value.facts.outcome)) return null;
    facts.outcome = value.facts.outcome; facts.mine = value.facts.mine === true;
  }
  if (value.event === 'romance') {
    if (!Object.hasOwn(ROMANCE, value.facts.what)) return null;
    facts.what = value.facts.what;
  }
  if (value.event === 'place') {
    if (typeof value.facts.place !== 'string' || !Object.hasOwn(PLACES, value.facts.place)) return null;
    facts.place = value.facts.place;
    if (value.facts.alt === true && PLACES[facts.place].altNote) facts.alt = true;
  }
  if (value.event === 'relic') {
    if (typeof value.facts.severity !== 'string' || !Object.hasOwn(RELIC_SEVERITY, value.facts.severity)) return null;
    facts.severity = value.facts.severity;
  }
  if (value.event === 'fight') {
    for (const [name, max] of Object.entries(FIGHT_LIMITS)) {
      facts[name] = count(value.facts[name], max);
      if (facts[name] === null) return null;
    }
    if (facts.dead + facts.alive < 1) return null;
  }
  return {kind: 'head', event: value.event, facts, expiresAt: value.expiresAt, maxWords: REMARK_WORDS};
}

// A fight is over: about how long, how many went down, and the hedge the game's counters need.
function fightEvent(facts) {
  const down = facts.dead + facts.alive;
  const people = `${down} ${down === 1 ? 'enemy' : 'enemies'}`;
  const outcome = facts.alive === 0 ? 'all of them dead' : facts.dead === 0 ? 'all of them left alive'
    : `${facts.dead} of them dead and ${facts.alive} left alive`;
  return `A fight V was in has just ended. It lasted about ${facts.seconds} seconds and ${people} went down: ${outcome}. `
    + 'The count may include enemies that V\'s allies took down. It is over now.';
}

// V has arrived somewhere he knows: the phrase, and his note: the second one when the save has what its rule needs, else the first when
// its gate is met by the milestones of this save.
function placeEvent(key, alt, head) {
  const place = PLACES[key];
  const text = alt === true && place.altNote ? place.altNote : place.note && (!place.gate || head?.milestones.includes(place.gate)) ? place.note : '';
  const note = text ? ` ${text}` : '';
  return `V has just arrived in ${place.phrase}.${note}`;
}

/** The trigger of a remark: where he is, what just happened (quoted data), and the limits of the line. */
export function headTrigger(input) {
  const reaction = input.reaction, facts = reaction?.facts ?? {};
  if (reaction?.kind !== 'head') throw Error('Invalid head trigger');
  const head = headOf({...input, reaction: undefined});
  const event = reaction.event === 'person' ? `V has just been talking with ${JSON.stringify(facts.name)} in person (that scene is over now).`
    : reaction.event === 'quest' ? `V has just ${facts.outcome === 'failed' ? 'failed' : 'finished'} the job ${JSON.stringify(facts.title)}${facts.mine ? ', one of your own' : ''}.`
      : reaction.event === 'place' ? placeEvent(facts.place, facts.alt, head)
        : reaction.event === 'relic' ? `V has just had an attack of the Relic malfunction, ${RELIC_SEVERITY[facts.severity]}: the vision glitching, the body failing for a moment. It is over now.`
          : reaction.event === 'fight' ? fightEvent(facts)
            : ROMANCE[facts.what](JSON.stringify(facts.name));
  const standing = STANDING[head?.stage] ?? '';
  return 'You are Johnny Silverhand, the engram in V\'s head; nobody but V hears you. This event was not spoken by V. '
    + event + ' ' + (standing ? `Where you and V stand: ${standing} ` : '')
    + `Speak up on your own with one in-character remark of no more than ${REMARK_WORDS} words about it, from your own view. `
    + 'Use only these facts and what you already know; do not invent what was said, who was there, rewards or outcomes. '
    + 'Do not ask any question, including a rhetorical one. Return only the spoken line, without narration or actions.';
}
