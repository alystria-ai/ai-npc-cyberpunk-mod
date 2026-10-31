// The player's character edits for a Convai turn (docs/CHARACTER_EDITOR.md, "Convai").
//
// Convai's characters live in the owner's Convai account and are shared by every player, and the Gamer plan cannot update a character (its /character/update answers 401),
// so the edits a player writes in the editor (bio, speaking style, speaking rules, example lines, memories) cannot be written into the character. They travel with the
// turn instead: one context block in the dynamic info the bridge already sends before every Convai turn (the context text of updateContext in bridge/realtime-client.mjs,
// replaced each turn). It is worded as who the character is now, so it outranks the stored backstory where the two clash.
//
// Rules of the block:
//   - A character the player did not edit gets no block at all (and the text providers carry the edits in their persona, so they never get this one either).
//   - Only what the edit changed is sent: the speaking style when it was edited, the rules and the memories (they are new text), the bio paragraphs the player wrote or
//     changed (bridge/player-text.mjs playerParagraphs, the same rule the Lite prompt uses to spare them), the example lines that are not in the shipped set, and a short
//     list of the shipped paragraphs the player took out or rewrote (the stored backstory still has them, so Convai is told they are out of date).
//   - The block is kept within CONVAI_EDITS_LIMIT characters. When the edit is longer, what fits is chosen in a fixed order: the rules, the memories, the speaking style,
//     the bio paragraphs, the example lines, then the removed paragraphs. A list loses its last lines, a text is cut at a sentence, and the block never grows past the limit.
//   - The block is built once per edit: a CharacterOverrides row is frozen and replaced on every save, so its identity is the cache key and a turn costs one map lookup.
//     Nothing here reads a file.
import {cleanBlock, cleanLine} from './character-overrides.mjs';
import {playerParagraphs} from './player-text.mjs';

// Characters. The existing context of a Convai turn is routinely 10,000 to 22,000 characters, the player's world rules take up to 2,000 (4,000 with the content packs'
// lines, bridge/addon-content.mjs CONTENT_LIMITS.convaiRules) and the facts of the game's own character block stay under 4,096 bytes. 4,000 here is about 1,000 tokens at most,
// enough for the style, the rules and the memories of any edit whole and for a few paragraphs of bio.
export const CONVAI_EDITS_LIMIT = 4000;

export const CONVAI_EDITS_HEADING = 'WHO YOU ARE NOW (set by the player, and current). Where this differs from your older backstory, speaking style or rules, this is true and the older text is out of date. The limits and rules you already follow still stand.';
const LEADS = Object.freeze({
  style: 'How you speak now:',
  rules: 'Your own rules of speech now:',
  memories: 'Things you always know:',
  bio: 'Your backstory now. These paragraphs are new or rewritten, and they replace anything in your older backstory that clashes with them:',
  examples: 'Example lines in your voice:',
  removed: 'No longer true of you (taken out or rewritten in your backstory, follow the paragraphs above instead):',
});
const ORDER = ['style', 'rules', 'memories', 'bio', 'examples', 'removed'];        // how the block reads
const PRIORITY = ['rules', 'memories', 'style', 'bio', 'examples', 'removed'];     // what gets room first
const REMOVED_MAX = 4, REMOVED_LENGTH = 140, MIN_CUT = 160;

const size = text => Array.from(text).length;
const PARAGRAPH = /\n\s*\n/;

/** The start of `text` within `room` characters, ended at a sentence when one ends past 60% of it, else at a word, with an ellipsis. '' when `room` is too small to be worth it. */
function cut(text, room) {
  const chars = Array.from(text);
  if (chars.length <= room) return text;
  if (room < 2) return '';
  const piece = chars.slice(0, room - 1).join('');
  const sentences = [...piece.matchAll(/[.!?…]["'”’)\]]*(?=\s)/g)], last = sentences.at(-1);
  const end = last && last.index + last[0].length >= room * 0.6 ? last.index + last[0].length : piece.replace(/\s+\S*$/, '').length;
  const kept = piece.slice(0, end > 0 ? end : piece.length).trimEnd();
  return kept ? kept + '…' : '';
}

/** A section's body for `room` characters (the lead line included in the cost by the caller): {text, used}. */
function fitList(items, room) {
  const lines = [];
  let used = 0;
  for (const item of items) {
    const line = '- ' + item, cost = size(line) + (lines.length ? 1 : 0);
    if (used + cost > room) break;
    lines.push(line); used += cost;
  }
  return lines.join('\n');
}
function fitParagraphs(paragraphs, room) {
  const kept = [];
  let used = 0;
  for (const paragraph of paragraphs) {
    const cost = size(paragraph) + (kept.length ? 2 : 0);
    if (used + cost <= room) { kept.push(paragraph); used += cost; continue; }
    const left = room - used - (kept.length ? 2 : 0);
    if (left >= MIN_CUT || (!kept.length && left >= 40)) { const part = cut(paragraph, left); if (part) kept.push(part); }
    break;
  }
  return kept.join('\n\n');
}

/** The sections of an edit (the changed parts only), each as {list: [lines]} or {paragraphs: [text]}. */
export function editSections(override, shipped) {
  const out = {};
  if (typeof override.style === 'string' && override.style.trim()) out.style = {paragraphs: [override.style.trim()]};
  if (override.rules?.length) out.rules = {list: override.rules};
  if (override.memories?.length) out.memories = {list: override.memories};
  if (typeof override.bio === 'string') {
    const shippedBio = cleanBlock(shipped.backstory), mine = playerParagraphs(override.bio, shippedBio);
    if (mine.length) out.bio = {paragraphs: mine};
    // The shipped paragraphs that are not in the edited bio any more: the stored backstory still tells them.
    const now = new Set(override.bio.split(PARAGRAPH).map(part => part.trim()).filter(Boolean));
    const gone = shippedBio.split(PARAGRAPH).map(part => part.trim()).filter(part => part && !now.has(part));
    if (gone.length) out.removed = {list: gone.slice(0, REMOVED_MAX).map(part => cut(cleanLine(part), REMOVED_LENGTH))};
  }
  if (Array.isArray(override.examples)) {
    const known = new Set((shipped.samples ?? []).map(cleanLine)), mine = override.examples.filter(line => !known.has(cleanLine(line)));
    if (mine.length) out.examples = {list: mine};
  }
  return out;
}

/**
 * The block text for one edit, or '' when the edit has nothing to say. `shipped` is the shipped persona the editor started from ({backstory, samples}, bridge/mistral-prompt.mjs
 * PersonaBook.defaults). Pure: the same edit gives the same text.
 */
export function convaiEditsText(override, shipped, limit = CONVAI_EDITS_LIMIT) {
  if (!override || typeof override !== 'object') return '';
  const sections = editSections(override, shipped ?? {});
  if (!Object.keys(sections).length) return '';
  let room = limit - size(CONVAI_EDITS_HEADING);
  const body = {};
  for (const name of PRIORITY) {
    const section = sections[name];
    if (!section) continue;
    const cost = size(LEADS[name]) + 3;               // the blank line before and the line break after the lead
    if (room - cost <= 0) continue;
    const text = section.list ? fitList(section.list, room - cost) : fitParagraphs(section.paragraphs, room - cost);
    if (!text) continue;
    body[name] = `${LEADS[name]}\n${text}`;
    room -= cost + size(text);
  }
  const parts = ORDER.filter(name => body[name]).map(name => body[name]);
  return parts.length ? [CONVAI_EDITS_HEADING, ...parts].join('\n\n') : '';
}

export class ConvaiCharacterEdits {
  /** `overrides`: bridge/character-overrides.mjs CharacterOverrides. `personas`: the PersonaBook (the shipped profile the edit started from). */
  constructor({overrides, personas, limit = CONVAI_EDITS_LIMIT}) {
    Object.assign(this, {overrides, personas, limit});
    this.cache = new Map();   // profile key -> {row, text}
  }
  /** The block text for a character: '' without an edit. A plain lookup, the text is built when the edit first shows up or changes. */
  textFor(profileKey) {
    const row = this.overrides?.get(profileKey) ?? null;
    if (!row) { if (this.cache.size) this.cache.delete(profileKey); return ''; }
    const cached = this.cache.get(profileKey);
    if (cached?.row === row) return cached.text;
    const shipped = this.personas.defaults(profileKey);
    const text = shipped?.known ? convaiEditsText(row, shipped, this.limit) : '';
    this.cache.set(profileKey, {row, text});
    return text;
  }
  /**
   * The context blocks a Convai turn gets: [{tier: 'convai', text}], or none. While a text provider answers the turn its persona carries the edits, so the block is left out
   * (the same rule as bridge/world-rules.mjs convaiWorldRulesBlocks). Never a tier the text providers' layout reads.
   */
  blocks(profileKey, textProviderActive = false) {
    if (textProviderActive || typeof profileKey !== 'string') return [];
    const text = this.textFor(profileKey);
    return text ? [{tier: 'convai', text}] : [];
  }
}
