// How a reply is cut into phrases for OmniVoice (bridge/omni-pcm.mjs renders and plays one phrase at a time).
//
// Every phrase is a separate render: the model starts its intonation afresh and ends it as an ending, so each cut is audible (bridge/omni-join.mjs evens the
// joins out, but a cut in the middle of a sentence is still a cut). The rules keep the cuts few and put them where a speaker pauses:
//   - the FIRST phrase is short, so the first word comes early: it ends at the first sentence end after 6 words if that is within 24 words; otherwise at the
//     last comma, semicolon or dash within 24 words; otherwise at a sentence end within 32; otherwise at 24 words;
//   - the SECOND phrase is rendered while the first plays, so it must be ready when the first ends: it ends at the last sentence end within 24 words (at least
//     6); a longer sentence is not cut, it ends at its own end if that is within 40 words;
//   - the LATER phrases have a whole phrase of audio to be rendered behind: they end at the last sentence end within 40 words (at least 12), so sentences stay
//     together and there are fewer cuts. A render costs a fixed 1.4 to 1.7 s on the GPU whatever its length up to about 5 s of speech (+0.1 s per further
//     second), so a longer phrase is cheaper than two short ones;
//   - a cut at a comma, semicolon or dash only where a phrase has no sentence end it can reach (the last such mark that fits), at the limit if there is none;
//   - a tail of fewer than four words is never left alone (it joins the phrase before it).
export const PHRASE_LIMITS = Object.freeze({
  first: Object.freeze({min: 6, soft: 24, hard: 32}),
  second: Object.freeze({min: 6, soft: 24, hard: 40}),
  later: Object.freeze({min: 12, soft: 40, hard: 40}),
});

const SENTENCE_END = /[.!?。！？…]["'”’)]*$/;
const CLAUSE_END = /[,;:，；：—]["'”’)]*$/;

export function splitSpeechText(text) {
  if (typeof text !== 'string' || !text.trim() || text.length > 12000) throw Error('Invalid speech text');
  const words = text.trim().split(/\s+/), phrases = [];
  let start = 0;
  while (start < words.length) {
    const first = !phrases.length, {min, soft, hard} = first ? PHRASE_LIMITS.first : phrases.length === 1 ? PHRASE_LIMITS.second : PHRASE_LIMITS.later;
    const limit = Math.min(words.length, start + hard);
    let sentenceSoft = 0, sentenceHard = 0, clauseSoft = 0, clauseHard = 0;
    for (let at = start + min - 1; at < limit; at++) {
      const count = at - start + 1, soon = count <= soft;
      if (SENTENCE_END.test(words[at])) {
        if (soon) { sentenceSoft = at + 1; if (first) break; }   // the first phrase stops at the first sentence end, the others take the last one that fits
        else if (!sentenceHard) sentenceHard = at + 1;
      } else if (CLAUSE_END.test(words[at])) { if (soon) clauseSoft = at + 1; else clauseHard = at + 1; }
    }
    const cap = Math.min(words.length, start + soft);
    let end = first ? (sentenceSoft || clauseSoft || sentenceHard || clauseHard || cap) : (sentenceSoft || sentenceHard || clauseHard || clauseSoft || cap);
    // Avoid an isolated short tail, which sounds like a second sentence.
    if (words.length - end < 4) end = words.length;
    phrases.push(words.slice(start, end).join(' ')); start = end;
  }
  if (phrases.length > 32) throw Error('Reply exceeds the phrase limit');
  return phrases;
}
