// How a reply is cut into phrases for OmniVoice (bridge/omni-pcm.mjs renders and plays one phrase at a time).

export function splitSpeechText(text) {
  if (typeof text !== 'string' || !text.trim() || text.length > 12000) throw Error('Invalid speech text');
  const words = text.trim().split(/\s+/), phrases = [];
  let start = 0;
  while (start < words.length) {
    const first = !phrases.length, min = first ? 6 : 12, target = first ? 12 : 22, max = first ? 22 : 34;
    let end = Math.min(words.length, start + max), lastClause;
    for (let at = start; at < end; at++) {
      const count = at - start + 1;
      if (count >= min && /[.!?。！？]["'”’)]*$/.test(words[at])) { end = at + 1; break; }
      if (count >= min && /[,;:，；：—]["'”’)]*$/.test(words[at])) {
        lastClause = at + 1;
        if (count >= target) { end = lastClause; break; }
      }
      if (count === max && lastClause) end = lastClause;
    }
    // Avoid an isolated two-word tail, which sounds like a second sentence.
    if (words.length - end < 4) end = words.length;
    phrases.push(words.slice(start, end).join(' ')); start = end;
  }
  if (phrases.length > 32) throw Error('Reply exceeds the phrase limit');
  return phrases;
}
