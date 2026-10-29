// Pay an NPC (the `pay` primitive, docs/QUEST_PRIMITIVES.md section 10.2): V pays an ordinary cast member of a stage in eddies (a toll, a haggle, a tab, a bribe).
// Two small pure pieces, no I/O and no model:
//   payNote(spec)      the volatile note a turn to that cast member carries while the stage is armed: what is asked and the least the cast member takes
//   readPay(words, spec)  V's words read AFTER the reply (a few regular expressions, nothing in front of the reply): an amount, a plain "yes" (the asking price), a refusal
// The bridge then sends the command `pay:<id>:offer` (data {amount}) and the game checks V's balance, takes the money and raises paid / short / broke / declined. The amount
// reader is the one Eddies uses (bridge/eddies.mjs), in all its languages; "yes" and "no" are the words of bridge/bond-intent.mjs.
import {parseAmount, screenWords} from './eddies.mjs';
import {screenIntent} from './bond-intent.mjs';

const WHY = Object.freeze({toll: 'to let V through', haggle: 'for what V wants from you', tab: 'for the tab V owes you', bribe: 'to look the other way'});
const sum = n => `${Math.round(n).toLocaleString('en-US')} eddies`;

/**
 * The note for a turn to the cast member `spec.to` of an armed pay stage ({id, to, amount, min?, reason?}). Second person, no stage talk, at most 500 characters.
 * Returns '' for a spec that is not usable.
 */
export function payNote(spec) {
  if (!spec || !Number.isSafeInteger(spec.amount) || spec.amount < 1) return '';
  const min = Number.isSafeInteger(spec.min) && spec.min >= 1 && spec.min <= spec.amount ? spec.min : spec.amount;
  const why = WHY[spec.reason] ?? WHY.toll;
  const price = min < spec.amount
    ? `You ask ${sum(spec.amount)} and you will come down to ${sum(min)} at the very least if V haggles well, never lower. Do not offer the lower price yourself.`
    : `That is the price, ${sum(spec.amount)}, and you do not take less.`;
  return `You want eddies from V ${why}. ${price} V settles it in V's own words: say plainly whether what V offers is enough, and do not hand anything over or let V pass before V pays.`;
}

/**
 * V's words against an armed pay stage. Returns {kind: 'offer', amount} (V named a sum, or said yes to the asking price), {kind: 'declined'} (V said no or refused), or null
 * (nothing to act on: the stage keeps waiting). A sum V named is returned as spoken: the game compares it with `min` and the balance.
 */
export function readPay(words, spec) {
  if (typeof words !== 'string' || !words.trim() || !spec) return null;
  const screen = screenWords(words);
  if (screen.refused) return {kind: 'declined'};
  // A sum V names: from the money screen when it read an intent (give, repay ...), else the plain amount reader over the line ("deal, 100", "how about 80").
  const named = screen.amount ?? parseAmount(words.slice(0, 600).replace(/[‘’ʼ]/g, "'"));
  if (Number.isSafeInteger(named) && named >= 1) {
    const intent = screenIntent(words);
    // "I won't pay 100" never reaches here (the screen refused it); a bare "no, 50" is a refusal with a number in it.
    if (intent.no && screen.amount === null) return {kind: 'declined'};
    return {kind: 'offer', amount: named};
  }
  const intent = screenIntent(words);
  if (intent.no) return {kind: 'declined'};
  if (intent.yes) return {kind: 'offer', amount: spec.amount};
  return null;
}

/** The command data for an offer or a refusal: `pay:<id>:offer` with {amount} (a refusal is amount 0 and declined: true, flat as a command's data must be). */
export function payData(reading) {
  if (reading?.kind === 'offer') return {amount: reading.amount};
  if (reading?.kind === 'declined') return {amount: 0, declined: true};
  return null;
}

const QUEST_PACK = /^[a-z][a-z0-9-]{2,47}$/, QUEST_CAST = /^[a-z][a-z0-9-]{0,31}$/;
/**
 * The optional `quest` block of a turn request (docs/QUEST_PRIMITIVES.md 10.1): {pack, cast}, the pack id and the cast id of the ordinary cast member the turn is with. The game adds it
 * only when the target is a tagged cast spawn of an armed pay stage. Strict: anything odd (another type, an extra key, an id that is not an id) is dropped, and the turn goes on
 * without it. Returns {pack, cast} or null.
 */
export function parseQuestBlock(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const keys = Object.keys(value);
  if (keys.length !== 2 || !keys.includes('pack') || !keys.includes('cast')) return null;
  if (typeof value.pack !== 'string' || !QUEST_PACK.test(value.pack) || typeof value.cast !== 'string' || !QUEST_CAST.test(value.cast)) return null;
  return {pack: value.pack, cast: value.cast};
}
