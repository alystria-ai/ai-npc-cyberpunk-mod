// Keeping the player's own words when a character text has to be shortened (docs/CHARACTER_EDITOR.md, "When a text is cut").
//
// The prompt builder shortens a character's text in three places: over the length cap of the model's profile (the Lite model's is 6,000 characters), for a
// computer that reads prompts slowly (bridge/compact-persona.mjs) and for a server with a small context (bridge/prompt-budget.mjs). Each cut keeps the beginning of
// the bio and drops the end, which is exactly where a player adds a new fact. So a bio edited in the editor carries the paragraphs the player wrote or changed
// (`bioEdits`, made by `playerParagraphs`) and every cut takes the shipped paragraphs from the end first and leaves those.
//
// Pure functions, no state and no imports, so the modules above can all use them without a cycle.

const PARAGRAPH = /\n\s*\n/;

/** The paragraphs of the edited bio that are not paragraphs of the shipped bio: what the player wrote or changed (trimmed, in order, each once). */
export function playerParagraphs(bio, shipped) {
  const known = new Set(String(shipped ?? '').split(PARAGRAPH).map(part => part.trim()).filter(Boolean));
  const out = [];
  for (const part of String(bio ?? '').split(PARAGRAPH).map(item => item.trim())) if (part && !known.has(part) && !out.includes(part)) out.push(part);
  return out;
}

// The beginning of a paragraph up to `limit` characters, ended at a sentence (or else a word).
function leading(text, limit) {
  if (text.length <= limit) return text;
  const piece = text.slice(0, limit);
  const sentences = [...piece.matchAll(/[.!?…]["'”’)\]]*(?=\s)/g)], last = sentences.at(-1);
  const end = last && last.index + last[0].length >= limit * 0.6 ? last.index + last[0].length : piece.replace(/\s+\S*$/, '').length;
  return piece.slice(0, end > 0 ? end : limit).trimEnd();
}

/**
 * `text` made at least `drop` characters shorter. With `spare` (the player's paragraphs) the other paragraphs go first, last paragraph first, the last one that is
 * needed only in part; the spared ones stay. What is still to be dropped then (all the other paragraphs are gone, or there is no `spare`) is cut from the end of the
 * whole text, down to 500 characters, as every cut did before: unless `fallback` is false, which leaves it to the caller.
 * Returns {text, short}: `short` is how many characters are still to be dropped (only when `fallback` is false).
 */
export function trimSparing(text, spare, drop, {fallback = true} = {}) {
  let value = String(text ?? ''), rest = Math.max(0, drop);
  const spared = new Set((spare ?? []).map(item => String(item).trim()));
  if (rest > 0 && (spared.size || !fallback)) {
    const parts = value.split(PARAGRAPH);
    for (let i = parts.length - 1; i >= 0 && rest > 0; i--) {
      const part = parts[i];
      if (spared.has(part.trim())) continue;
      if (part.length + 2 <= rest) { rest -= part.length + 2; parts[i] = null; continue; }
      const kept = leading(part, part.length - rest - 1);
      if (kept.length >= 160) { parts[i] = kept + '…'; rest = 0; } else { rest = Math.max(0, rest - part.length - 2); parts[i] = null; }
    }
    value = parts.filter(part => part !== null).join('\n\n');
  }
  if (rest > 0 && fallback) {
    value = value.slice(0, Math.max(500, value.length - rest)).trimEnd() + '…';
    rest = 0;
  }
  return {text: value, short: rest};
}
