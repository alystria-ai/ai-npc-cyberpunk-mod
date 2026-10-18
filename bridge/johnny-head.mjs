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
const EVENTS = new Set(['person', 'quest', 'romance']);
const ROMANCE = Object.freeze({together: name => `V and ${name} are together now; it has just become a romance in this save.`,
  friends: name => `V and ${name} have just settled on staying friends, not lovers.`,
  declined: name => `V has just turned ${name} down.`,
  night: name => `V has just spent a night with ${name}.`});
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
  return {kind: 'head', event: value.event, facts, expiresAt: value.expiresAt, maxWords: REMARK_WORDS};
}

/** The trigger of a remark: where he is, what just happened (quoted data), and the limits of the line. */
export function headTrigger(input) {
  const reaction = input.reaction, facts = reaction?.facts ?? {};
  if (reaction?.kind !== 'head') throw Error('Invalid head trigger');
  const event = reaction.event === 'person' ? `V has just been talking with ${JSON.stringify(facts.name)} in person (that scene is over now).`
    : reaction.event === 'quest' ? `V has just ${facts.outcome === 'failed' ? 'failed' : 'finished'} the job ${JSON.stringify(facts.title)}${facts.mine ? ', one of your own' : ''}.`
      : ROMANCE[facts.what](JSON.stringify(facts.name));
  const standing = STANDING[headOf({...input, reaction: undefined})?.stage] ?? '';
  return 'You are Johnny Silverhand, the engram in V\'s head; nobody but V hears you. This event was not spoken by V. '
    + event + ' ' + (standing ? `Where you and V stand: ${standing} ` : '')
    + `Speak up on your own with one in-character remark of no more than ${REMARK_WORDS} words about it, from your own view. `
    + 'Use only these facts and what you already know; do not invent what was said, who was there, rewards or outcomes. '
    + 'Do not ask any question, including a rhetorical one. Return only the spoken line, without narration or actions.';
}
