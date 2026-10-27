// Fresh facts: a few plain words about what is true of V this very turn when it changed or V asks about it, said where a small model cannot miss them (docs/FRESH_FACTS.md).
// A 4B model follows the talk it is shown, not the facts far above it: V stripped, the game read it, the prompt said so three times, and the reply a turn ago ("that suit") still won.
// Measured on the real Local AI models (scripts/fresh-facts-eval): the fact stated bluntly at BOTH ends of the prompt, with the history lines that say the old fact left out, took the lite
// model from 38% wrong answers to 3%; either end alone, or the long note alone, stayed at 20% to 35%.
//   - the end of the system message, after the right-now block (it is the part of the system message that changes anyway, so a prompt cache keeps everything before it),
//   - the last user message, right before V's words,
//   - the earlier exchanges whose reply says the old fact are not sent (bridge/mistral-prompt.mjs; they stay in the character's memory).
// The text is facts only: no instruction on how to react, in particular none about nudity (owner decision 2026-10-27). Pure string work on data that already arrived.

/** The block of a turn's context ({tier: 'fresh'}): `text` is the labelled form (what Convai's joined context carries), `facts` the plain sentences, `drop` a pattern source for stale replies. */
export function freshBlock(parts, {asked = false} = {}) {
  const used = (parts ?? []).filter(part => part?.text);
  // `codes`: which facts, by name only ("clothes:changed", "drinks:3"), and `asked`: V's words asked about clothes or themself. For the bridge log (docs/FRESH_FACTS.md), never text.
  const codes = used.flatMap(part => part.codes ?? []).join(',');
  if (!used.length) return {tier: 'fresh', text: '', facts: '', drop: '', codes: '', asked};
  const facts = used.map(part => part.text).join(' ');
  const drops = used.map(part => part.drop).filter(Boolean);
  return {tier: 'fresh', text: headLine(facts), facts, drop: drops.length ? drops.join('|') : '', codes, asked};
}

// The two wordings, as measured. The last user message gets the bracketed line before V's words (after the notes, before the closing, in a profile that puts the notes after V's line).
export const headLine = facts => `TRUE RIGHT NOW: ${facts}`;
export const tailLine = facts => `[RIGHT NOW, TRUE: ${facts}]`;
export const FRESH_MAX_CHARS = 600;

const esc = word => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** A reply that says an old fact: a case-insensitive pattern from source text, or null when the source is empty or not a pattern. */
export function staleTest(source) {
  if (typeof source !== 'string' || !source || source.length > 4000) return null;
  try { const pattern = new RegExp(source, 'iu'); return reply => pattern.test(String(reply ?? '')); } catch { return null; }
}
/** The words of some item names (the first letters of a word start the match, so "suits" is caught by "suit"), minus the words in `keep`. */
const STOP = new Set(['with', 'from', 'that', 'this', 'pair', 'replica', 'edition', 'mark', 'version']);
export function nameWords(names, keep = []) {
  const kept = new Set(keep.flatMap(name => (String(name).toLowerCase().match(/[a-z]{4,}/g) ?? [])));
  const words = new Set();
  for (const name of names) for (const word of String(name).toLowerCase().replace(/['’]s\b/g, '').match(/[a-z]{4,}/g) ?? []) if (!STOP.has(word) && !kept.has(word)) words.add(word);
  return [...words];
}
export const wordPattern = words => words.length ? `\\b(?:${words.map(esc).join('|')})` : '';
