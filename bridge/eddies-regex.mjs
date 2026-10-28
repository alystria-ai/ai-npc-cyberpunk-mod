// Small regular expressions read as one (bridge/eddies-languages.mjs).
//
// V8 compiles a regular expression whole, on its first run, and again for each string width. A grammar list written as one large alternation with Unicode case
// folding takes 50 to 100 ms to compile in a single slice, which would stall the bridge when it lands on a turn. The same list as several small expressions of
// about 70 characters compiles in about 1 ms each, so the warm-up can run in slices between other work.

/** The alternatives of a source at its top level (not inside a group or a [class], and not an escaped bar). */
export function splitTop(source) {
  const parts = [];
  let depth = 0, inClass = false, from = 0;
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (c === '\\') { i++; continue; }
    if (inClass) { if (c === ']') inClass = false; continue; }
    if (c === '[') inClass = true;
    else if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === '|' && depth === 0) { parts.push(source.slice(from, i)); from = i + 1; }
  }
  parts.push(source.slice(from));
  return parts;
}

/** Several regular expressions that read like their alternation: `exec` gives the leftmost match over the parts (the earlier part on a tie), `test` is any. */
export class Multi {
  constructor(parts) { this.parts = parts; }
  exec(text) {
    let best = null;
    for (const part of this.parts) {
      const match = part.exec(text);
      if (match && (!best || match.index < best.index)) best = match;
    }
    return best;
  }
  test(text) { return this.parts.some(part => part.test(text)); }
}

const PART_CHARS = 70;
function pack(alternatives) {
  const chunks = [];
  let current = '';
  for (const alternative of alternatives) {
    if (current && current.length + alternative.length > PART_CHARS) { chunks.push(current); current = alternative; }
    else current = current ? current + '|' + alternative : alternative;
  }
  if (current) chunks.push(current);
  return chunks;
}

// A source written as one group, `\b(?:a|b|c...)(?![\p{L}])`: the group's first-level `(?:` and its close, when the text around it is short.
function oneGroup(source) {
  const open = source.indexOf('(?:');
  if (open < 0 || open > 40) return null;
  let depth = 0, inClass = false;
  for (let i = open; i < source.length; i++) {
    const c = source[i];
    if (c === '\\') { i++; continue; }
    if (inClass) { if (c === ']') inClass = false; continue; }
    if (c === '[') inClass = true;
    else if (c === '(') depth++;
    else if (c === ')' && --depth === 0) {
      const suffix = source.slice(i + 1);
      return suffix.length <= 60 ? {prefix: source.slice(0, open), inner: source.slice(open + 3, i), suffix} : null;
    }
  }
  return null;
}

/** The source cut into chunks of about PART_CHARS characters at top-level bars, or, for a source that is one group around its alternatives, at that group's bars. */
export function chunksOf(source) {
  const top = splitTop(source);
  if (top.length > 1) return pack(top);
  const group = oneGroup(source);
  if (!group) return [source];
  const inner = splitTop(group.inner);
  if (inner.length === 1) {
    const deeper = chunksOf(group.inner);
    return deeper.length === 1 ? [source] : deeper.map(chunk => `${group.prefix}(?:${chunk})${group.suffix}`);
  }
  return pack(inner).map(chunk => `${group.prefix}(?:${chunk})${group.suffix}`);
}
