// The compact character text of a machine that reads prompts slowly (docs/LOCAL_AI.md, "Compact character text on slow machines").
//
// A named character's persona and the output rules are 3,500 to 3,600 tokens (Judy, with the Mature layer about 4,200) and the first turn of every
// character has to read them once. On the computers of the 0.2.4 reports (the game keeps the card busy, or the model is partly on the CPU) the
// server reads 50 to 420 tokens a second, and that read alone is 10 to 70 s of the turn. The prompt cache makes the later turns cheap, so only the
// first turn of a character pays; this module makes that first turn smaller, and only when the machine has been MEASURED to read slowly
// (`PrefillMeter.compact` in bridge/prompt-budget.mjs: two readings in a row under 600 tokens a second, back to the full text after two in a row
// at 1,000 or more).
//
// What is cut is decided by section, from fixed priorities and a character budget, with no generation and no model: the persona text is split in the
// blocks it already has (the opening paragraph, ESTABLISHED RELATIONSHIPS, ...), and the blocks are taken in order of importance until the room is
// used. The room is what the head (the persona, the output rules, the Mature or guard layer and the player's world rules) may be in all, less what is
// not the persona's own and is never cut: so the Mature layer or long world rules leave less room, never a cut rule. Never cut: the output rules, the
// format notes, the Mature or guard layer, the player's world rules, a character's own rules of speech, its remembered facts, the world block and
// everything after it. Cut: the long public-topic lore (with its "Scope" lines), the appearance, the example lines beyond two, then the tails of what is kept.
//
// The same persona gives the same text every time (a pure function of the persona, the Mature level and the world rules), and `CompactChoice` keeps the
// choice for as long as the server holds that character (until another character is spoken to or the model is loaded again), so the early part of
// the prompt does not change from turn to turn and the server's prefix cache holds it.
import {systemHead} from './mistral-prompt.mjs';
import {worldRulesBlock} from './world-rules.mjs';
import {leadingText, textTokens} from './prompt-budget.mjs';

export const COMPACT = Object.freeze({
  targetChars: 8000,   // the head, all of it, aims at this when no ratio is known: about 1,900 tokens at 4.2 characters a token (the full head of Judy is 3,570, with the Mature layer 4,200)
  minRatio: 3.8,       // the ratio the target is counted with is kept inside these (the whole prompt's ratio, ids and slang included, runs a little under the persona text's own 4.4)
  maxRatio: 4.6,
  targetTokens: 1900,  // ... and this is what it aims at: with the model's own characters-a-token ratio (the budget's TokenMeter) the target in characters follows it
  floorChars: 2600,    // the persona's own text keeps at least this much when the Mature layer and the world rules leave less room
  minPiece: 160,       // a block that would be cut to less than this is left out
  minSaving: 800,      // a persona that would lose less than this (an everyday resident) is left whole: a cut that small is not worth a different prompt
  samples: 2,          // example lines kept
  sampleChars: 240,
  // The most each kind of block may keep (characters), in the order they are taken.
  order: Object.freeze(['lead', 'style', 'identity', 'relationships', 'background', 'boiler', 'save', 'limits', 'samples', 'styleRest', 'other']),
  caps: Object.freeze({lead: 1500, style: 1100, identity: 1500, relationships: 1100, background: 800, boiler: 520, save: 700, limits: 650, styleRest: 500, other: 500}),
});

const HEADING = /^(?:[A-Z][A-Z &'/-]{3,}|Your appearance:?)$/;
const KINDS = Object.freeze({
  'ESTABLISHED BACKGROUND': 'background', 'ESTABLISHED RELATIONSHIPS': 'relationships', 'KNOWLEDGE AND CURRENT SAVE': 'save', 'KNOWLEDGE LIMITS': 'limits',
  'WHO YOU ARE NOT AND WHAT YOU KNOW': 'identity', 'IDENTITY': 'lead',
  'PUBLIC INTRINSIC TOPIC MATERIAL': null, 'Your appearance:': null, 'Your appearance': null,   // lore and looks: left out
});
const BOILERPLATE = /^Speak naturally to V\b/;   // the closing paragraph of every style text; the output rules say the same

const paragraphs = text => String(text ?? '').split(/\n\s*\n/).map(part => part.trim()).filter(Boolean);

// A block cut to `limit` characters: whole lines of a list (the heading kept), else the beginning of the text up to a sentence.
function clipBlock(block, limit) {
  const text = block.text;
  if (text.length <= limit) return text;
  const lines = text.split('\n');
  const head = block.heading ? lines.shift() : null;
  const room = limit - (head ? head.length + 1 : 0);
  if (room < COMPACT.minPiece) return null;
  const kept = [];
  let used = 0;
  if (lines.length > 1) {
    for (const line of lines) {
      const add = line.length + (kept.length ? 1 : 0);
      if (used + add > room) break;
      kept.push(line); used += add;
    }
  }
  const body = kept.length ? kept.join('\n') : leadingText(lines.join('\n'), room);
  if (body.length < Math.min(COMPACT.minPiece, lines.join('\n').length)) return null;
  return head ? `${head}\n${body}` : body;
}

/**
 * The blocks of a persona's backstory and style as [{kind, text, heading, at}], `at` being the place in the original text. A heading starts a section that goes on
 * until the next heading, blank lines inside it included (the public topic lore is one entry to a paragraph); a section that is left out takes all its paragraphs with it.
 */
function blocksOf(persona) {
  const blocks = [];
  let at = 0, section = 'lead', lead = null;
  for (const part of paragraphs(persona.backstory)) {
    const first = part.split('\n')[0].trim();
    const heading = HEADING.test(first);
    if (heading) section = first in KINDS ? KINDS[first] : 'other';
    if (section === null) continue;                                       // lore and looks: left out whole
    if (section === 'lead') {
      // The opening paragraph(s) and the IDENTITY block of an archetype are one piece.
      if (lead) lead.text += `\n\n${part}`; else { lead = {kind: 'lead', text: part, heading: false, at: at++}; blocks.push(lead); }
      continue;
    }
    // The rest of a section (a paragraph that is not headed) joins the block of its heading.
    const last = blocks.at(-1);
    if (!heading && last && last.kind === section) { last.text += `\n\n${part}`; continue; }
    blocks.push({kind: section, text: part, heading, at: at++});
  }
  const style = paragraphs(persona.style);
  const core = style.findIndex(part => !BOILERPLATE.test(part));
  style.forEach((part, index) => {
    const kind = BOILERPLATE.test(part) ? 'boiler' : index === core ? 'style' : 'styleRest';
    blocks.push({kind, text: part, heading: false, at: 1000 + index, style: true});
  });
  return blocks;
}

/**
 * The persona cut to the room it may have, or `persona` itself when nothing would be cut (a short persona, a custom one, a head that already fits).
 *   persona   from PersonaBook.persona
 *   mature    the Mature level, or null; guard: the guard layer is on (both lengthen what is never cut)
 *   limits    the prompt limits the head is built with (bridge/mistral-prompt.mjs LIMITS)
 *   charsPerToken   the model's characters-a-token ratio (bridge/prompt-budget.mjs TokenMeter, the estimator the soft target uses): the head aims at COMPACT.targetTokens of it;
 *             without one at COMPACT.targetChars
 */
export function compactPersonaFor(persona, {mature = null, guard = false, limits, charsPerToken} = {}) {
  if (!persona || typeof persona !== 'object') return persona;
  const bare = {...persona, backstory: '', style: '', samples: []};
  const fixed = systemHead({persona: bare, limits, mature, guard}).length + (persona.worldRules ? worldRulesBlock(persona.worldRules).length + 2 : 0);
  const target = Number.isFinite(charsPerToken) && charsPerToken > 0 ? Math.round(COMPACT.targetTokens * charsPerToken / 100) * 100 : COMPACT.targetChars;
  let room = Math.max(COMPACT.floorChars, target - fixed);
  const blocks = blocksOf(persona), kept = new Map();
  for (const kind of COMPACT.order) {
    if (kind === 'samples') {
      // Two example lines, if the room has them (the heading of the section is about 160 characters).
      const lines = (persona.samples ?? []).slice(0, COMPACT.samples).map(line => leadingText(String(line).replace(/\s*\n\s*/g, ' '), COMPACT.sampleChars)).filter(Boolean);
      let used = lines.length ? 160 : 0;
      const taken = [];
      for (const line of lines) { if (used + line.length + 3 > room) break; used += line.length + 3; taken.push(line); }
      if (taken.length) { kept.set('samples', taken); room -= used; }
      continue;
    }
    for (const block of blocks.filter(item => item.kind === kind)) {
      const clipped = clipBlock(block, COMPACT.caps[kind] ?? COMPACT.caps.other);
      if (clipped === null || room < Math.min(clipped.length, COMPACT.minPiece)) continue;
      const text = clipped.length > room ? clipBlock({...block, text: clipped}, room) : clipped;
      if (text === null) continue;
      kept.set(block, text); room -= text.length + 2;
    }
  }
  const take = style => blocks.filter(block => Boolean(block.style) === style && kept.has(block)).sort((a, b) => a.at - b.at).map(block => kept.get(block));
  const backstory = take(false).join('\n\n'), style = take(true).join('\n\n'), samples = kept.get('samples') ?? [];
  // A text that is not shorter was not cut: the persona stays the very object it was (and its prompt the very prompt of a fast machine).
  const before = String(persona.backstory ?? '').length + String(persona.style ?? '').length + (persona.samples ?? []).join('').length;
  if (backstory.length + style.length + samples.join('').length > before - COMPACT.minSaving || (!backstory && persona.backstory)) return persona;
  return {...persona, backstory, style, samples};
}

const same = (a, b) => a === b || (Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((item, index) => item === b[index]));

/**
 * Which persona text a turn is built with, kept for as long as the server holds that character. The choice (compact or whole) is made when a
 * character's first turn comes (the server holds another character, or this model load is new) and kept until then: a machine that turns slow in the middle of
 * a talk keeps that talk's cached prompt, and the next character starts compact. `speed` is the load's PrefillMeter; it says `compact`. Nothing is
 * computed for a machine that is not in compact mode but the comparison of the persona with the last one.
 */
export class CompactChoice {
  #memo = null;
  #announced = false;
  #told = new Map();   // the cut already named in the log, per character: a group talk that goes back and forth between two characters names each once
  constructor({log = () => {}} = {}) { this.log = log; }
  say(line) { try { this.log(line); } catch { /* a log line never fails a turn */ } }
  /**
   * The persona to build the prompt from: `persona` itself, or its compact text. `meter` (the model's TokenMeter): the ratio the head's target is counted with, the same
   * one the soft target uses, taken once for as long as the choice stands (quantised, so a ratio that wobbles does not make a different text of the same character).
   */
  personaFor(persona, {speed, meter, mature = null, guard = false, limits} = {}) {
    if (!persona || !speed) return persona;
    if (mature) guard = false;   // the Mature layer replaces the guard-only one in the head
    let memo = this.#memo;
    if (!memo || memo.speed !== speed || memo.name !== persona.name || memo.backstory !== persona.backstory || memo.style !== persona.style) {
      const ratio = Number(meter?.charsPerToken);
      memo = this.#memo = {speed, name: persona.name, backstory: persona.backstory, style: persona.style, compact: speed.compact === true, extras: null, result: persona,
        ratio: Number.isFinite(ratio) && ratio > 0 ? Math.min(COMPACT.maxRatio, Math.max(COMPACT.minRatio, Math.round(ratio * 5) / 5)) : undefined};
      if (memo.compact !== this.#announced) {
        this.#announced = memo.compact;
        const rate = speed.tokensPerSecond;
        this.say(memo.compact
          ? `The local AI: compact character text ${Number.isFinite(rate) ? `(this computer reads about ${Math.round(rate)} tokens a second)` : 'on'}; from this character's first turn, the long background, looks and extra examples are left out`
          : 'The local AI: the whole character text again (this computer reads fast enough)');
      }
    }
    if (!memo.compact) return persona;
    // The text depends on what else is in the head (Mature layer, guard, world rules, the character's own rules): a change of those cuts it again.
    const extras = JSON.stringify([mature, guard, persona.worldRules ?? '', persona.rules ?? [], persona.memories ?? [], persona.samples ?? [], persona.intro ?? '', persona.identityRule ?? '', persona.talkWords ?? 0]);
    if (memo.extras !== extras) {
      memo.extras = extras;
      memo.result = compactPersonaFor(persona, {mature, guard, limits, charsPerToken: memo.ratio});
      if (memo.result !== persona) {
        const tokens = which => Math.round(textTokens(systemHead({persona: which, limits, mature, guard}), memo.ratio));
        const line = `the head goes from about ${tokens(persona)} to ${tokens(memo.result)} tokens`, who = persona.name || 'a resident';
        if (this.#told.get(who) !== line) { this.#told.set(who, line); this.say(`The local AI: compact character text for ${who}: ${line}`); }
      }
    }
    return memo.result;
  }
}
