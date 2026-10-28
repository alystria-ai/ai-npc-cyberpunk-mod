// How a reply is cut into phrases for OmniVoice (bridge/omni-pcm.mjs renders and plays one phrase at a time).
//
// Every phrase is a separate render: the model starts its intonation afresh and ends it as an ending, so each cut is audible. The rules keep the cuts few
// and put them where a speaker pauses:
//   - the FIRST phrase is short, so the first word comes early: it ends at the first sentence end after FIRST_MIN words (a shorter sentence is joined to the
//     next one), at most FIRST_MAX words;
//   - the LATER phrases are as long as the model renders well: they end at the LAST sentence end that fits LATER_MAX words (and has at least LATER_MIN), so
//     sentences stay together and there are fewer cuts. A render costs a fixed few seconds on the GPU whatever its length up to about 5 s of speech, so a
//     longer phrase is cheaper than two short ones;
//   - a cut at a comma, semicolon or dash only where a phrase would otherwise have no sentence end inside its limit (the last such mark that fits); with no
//     mark at all, at the limit;
//   - a tail of fewer than four words is never left alone (it joins the phrase before it).
export const FIRST_MIN = 6;
export const FIRST_MAX = 26;
export const LATER_MIN = 12;
export const LATER_MAX = 40;

const SENTENCE_END = /[.!?。！？…]["'”’)]*$/;
const CLAUSE_END = /[,;:，；：—]["'”’)]*$/;

export function splitSpeechText(text) {
  if (typeof text !== 'string' || !text.trim() || text.length > 12000) throw Error('Invalid speech text');
  const words = text.trim().split(/\s+/), phrases = [];
  let start = 0;
  while (start < words.length) {
    const first = !phrases.length, min = first ? FIRST_MIN : LATER_MIN, max = first ? FIRST_MAX : LATER_MAX;
    const limit = Math.min(words.length, start + max);
    let sentence = 0, clause = 0;
    for (let at = start + min - 1; at < limit; at++) {
      if (SENTENCE_END.test(words[at])) { sentence = at + 1; if (first) break; }
      else if (CLAUSE_END.test(words[at])) clause = at + 1;
    }
    let end = sentence || clause || limit;
    // Avoid an isolated short tail, which sounds like a second sentence.
    if (words.length - end < 4) end = words.length;
    phrases.push(words.slice(start, end).join(' ')); start = end;
  }
  if (phrases.length > 32) throw Error('Reply exceeds the phrase limit');
  return phrases;
}
