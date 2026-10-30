// Keeps a character from saying her own recent lines again (docs/REPLY_VARIETY.md).
//
// A small model reads the last 8 to 11 exchanges of the talk, and what it reads it continues: after three replies that open with "Oh, you're still here, huh?" the fourth does,
// and a threat or a tease that fits the moment ("I'm gonna call you a coward in front of the whole damn camp") comes back whole in the next reply and the one after. The older
// check (repeatsLine, bridge/mistral-prompt.mjs) only catches a reply that is nearly one earlier line, so an opener or a sentence repeated inside an otherwise new reply got past it.
// A live talk with Panam Palmer on 2026-10-31 (Mistral preset, Ministral 8B) had the same opener in 4 of 7 replies and the same sentences in three consecutive replies.
//
// Two cheap steps, both plain string work on the character's own last replies (no request, no model, microseconds):
//   1. BEFORE the reply: varietyNote() words what her recent replies share, as one short note in the closing tier right after V's words ("do not open with ..., do not reuse ...").
//   2. AFTER the reply: freshenReply() leaves out an opening sentence she has opened with before and a sentence she has already said, when enough of the reply remains. Nothing is
//      asked again: a retry costs a whole turn, so it stays for a reply that is nearly one earlier reply (the existing check).
// Pure functions, no state, no I/O.

const RECENT_REPLIES = 6;      // the replies looked at for openers and clothes
const PHRASE_REPLIES = 4;      // the replies looked at for repeated phrases
const PHRASE_WORDS = 5;        // a phrase is a run of at least this many words that two replies share
const MAX_OPENERS = 3, MAX_PHRASES = 3, MAX_PHRASE_WORDS = 12;
const MIN_KEEP_WORDS = 6;      // a reply with a repeated sentence taken out keeps at least this many words, else it is left as it is

const wordsOf = text => String(text ?? '').replace(/\[[^\]]{1,40}\]|<[^>]{1,40}>/g, ' ').toLowerCase().replace(/[‘’ʼ]/g, "'").replace(/[^\p{L}\p{N}' ]+/gu, ' ').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
const sentencesOf = text => String(text ?? '').match(/[^.!?…]+(?:[.!?…]+["”')\]]*|$)\s*/g)?.map(sentence => sentence.trim()).filter(sentence => /[\p{L}\p{N}]/u.test(sentence)) ?? [];
const grams = (list, size) => { const out = []; for (let i = 0; i + size <= list.length; i++) out.push(list.slice(i, i + size).join(' ')); return out; };

// V's clothes: the words a character fixes on ("that damn suit"). Only these, so a fixation on any other word is left to the phrase check.
const CLOTHES = /\b(?:suit|suits|jacket|shirt|tee|pants|jeans|trousers|skirt|dress|dressed|coat|vest|hoodie|sweater|blazer|tie|boots|shoes|sneakers|outfit|outfits|clothes|clothing)\b/i;
/** Does a reply talk about V's clothes? */
export const mentionsClothes = reply => CLOTHES.test(String(reply ?? ''));

/** The words two or more openers have in common, from the start (at least 2 words), or the opener's own first words. */
function commonStart(lists) {
  const first = lists[0];
  let size = 0;
  while (size < MAX_PHRASE_WORDS && lists.every(list => list[size] !== undefined && list[size] === first[size])) size++;
  return first.slice(0, size);
}

/**
 * The openers to avoid: the first words (at least two) that two or more of the last replies share.
 * `replies` oldest first. Returns word lists ("oh you're still here"), the most repeated first, at most MAX_OPENERS.
 */
export function repeatedOpeners(replies) {
  const recent = (replies ?? []).slice(-RECENT_REPLIES).map(wordsOf).filter(list => list.length >= 3);
  const groups = new Map();
  for (const list of recent) {
    const key = list.slice(0, 2).join(' ');
    groups.set(key, [...(groups.get(key) ?? []), list]);
  }
  const found = [];
  for (const [key, lists] of groups) {
    if (lists.length < 2) continue;
    // The shared start, at most four words: "oh you're still here" for three replies that open so, "five hundred" for two that only share that much.
    found.push({words: commonStart(lists).slice(0, 4), count: lists.length, recency: recent.lastIndexOf(lists.at(-1))});
  }
  return found.sort((a, b) => b.count - a.count || b.recency - a.recency).slice(0, MAX_OPENERS).map(item => item.words);
}

/**
 * The phrases the last replies repeat: runs of PHRASE_WORDS words or more that two or more of the last PHRASE_REPLIES replies share, longest first, at most MAX_PHRASES.
 * When fewer than two are found, the longest sentence of the last reply is added (it is the line a model most often says again word for word), unless `standIn` is false.
 */
export function repeatedPhrases(replies, {standIn = true} = {}) {
  const recent = (replies ?? []).slice(-PHRASE_REPLIES).map(wordsOf);
  const seen = new Map();   // gram -> the indexes of the replies that have it
  recent.forEach((list, index) => { for (const gram of new Set(grams(list, PHRASE_WORDS))) seen.set(gram, [...(seen.get(gram) ?? []), index]); });
  const spans = [];
  recent.forEach((list, index) => {
    let run = null;
    for (let at = 0; at + PHRASE_WORDS <= list.length; at++) {
      const shared = (seen.get(list.slice(at, at + PHRASE_WORDS).join(' ')) ?? []).length >= 2;
      if (shared) { run = run ? {from: run.from, to: at + PHRASE_WORDS} : {from: at, to: at + PHRASE_WORDS}; }
      else if (run) { spans.push({index, words: list.slice(run.from, run.to)}); run = null; }
    }
    if (run) spans.push({index, words: list.slice(run.from, run.to)});
  });
  const text = span => span.words.slice(0, MAX_PHRASE_WORDS).join(' ');
  const unique = [];
  for (const span of spans.sort((a, b) => b.words.length - a.words.length || b.index - a.index)) {
    const line = text(span);
    if (!unique.some(other => other.includes(line) || line.includes(other))) unique.push(line);
  }
  const phrases = unique.slice(0, MAX_PHRASES);
  if (standIn && phrases.length < 2 && replies?.length) {
    const sentences = sentencesOf(replies.at(-1)).map(sentence => wordsOf(sentence)).filter(list => list.length >= 6).sort((a, b) => b.length - a.length);
    const long = sentences[0]?.slice(0, MAX_PHRASE_WORDS).join(' ');
    if (long && !phrases.some(line => line.includes(long) || long.includes(line))) phrases.push(long);
  }
  return phrases;
}

/** Have two or more of the last replies talked about V's clothes? (A fixation: "that damn suit" in most replies.) */
export const clothesFixation = replies => (replies ?? []).slice(-RECENT_REPLIES).filter(mentionsClothes).length >= 2;

const quoted = words => `"${words.join(' ')}"`;
const listOf = items => items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} or ${items.at(-1)}`;

/**
 * The note for this turn, or '' when the last replies hold nothing to avoid (fewer than two replies, or no repeat). `replies`: the character's own last replies, oldest first.
 * `clothesOk`: V's words ask about clothes or V's gear changed, so the clothes may come up. No dashes or semicolons in it: it is read by a model, but kept plain like the other notes.
 */
export function varietyNote(replies, {clothesOk = false} = {}) {
  const list = (replies ?? []).filter(reply => typeof reply === 'string' && reply.trim());
  if (list.length < 2) return '';
  const openers = repeatedOpeners(list), clothes = !clothesOk && clothesFixation(list);
  const phrases = repeatedPhrases(list, {standIn: openers.length > 0 || clothes});
  if (!openers.length && !phrases.length && !clothes) return '';
  const parts = ['Your last replies repeat themselves, so say this one in fresh words.'];
  if (openers.length) parts.push(`Do not open with ${listOf(openers.map(quoted))}.`);
  if (phrases.length) parts.push(`Do not reuse ${listOf(phrases.map(words => `"${words}"`))}.`);
  if (clothes) parts.push("You have talked about V's clothes already: leave them out unless V asks.");
  return parts.join(' ');
}

// ---- After the reply -------------------------------------------------------------------------------------------------------------------

// Words that carry little: a run of five words with fewer than two others is a stock phrase, not a repeated line.
const STOP = new Set(("a an and are as at be but by do does for from had has have he her him his how i i'd i'll i'm i've if in is it it's its just me my no not of oh on or our she so that the them then there they this to up us was we were "
  + "what when who why will with would yeah yes you you'd you'll you're you've your gonna wanna now well huh").split(' '));
const contentWords = list => list.filter(word => !STOP.has(word)).length;
// A short sentence that only announces that someone is here: "Oh, you're still here, huh?", "I'm still here, standing right beside you.", "You're back.", "I'm right here." Two people standing
// together do not say it (owner, 2026-10-31). Judged only for a talk in person (a phone call answers "I'm here" for a reason), and only a sentence of two to ten words that is nothing else:
// "I'm here to help you with that" is not an announcement.
const HERE_SUBJECT = "(?:(?:you're|you are|i'm|i am|she's|she is|he's|he is|we're|we are) )?";
const HERE_PLACE = '(?:still |just |right |really |actually )*(?:here|back|standing(?: right)? (?:here|there|beside you|next to you|with you)|(?:right )?(?:beside|next to) (?:you|me|v))';
const HERE_TAIL = '(?: (?:still|right|beside you|next to you|with you|now|huh|then|again|after all|standing(?: right)? (?:here|there|beside you|next to you)))*';
const PRESENCE = new RegExp(`^${HERE_SUBJECT}${HERE_PLACE}${HERE_TAIL}$`);
/** Does this sentence only announce that she is here, beside V, or that V is here or back? */
export function announcesPresence(sentence) {
  const words = wordsOf(sentence);
  if (words.length < 2 || words.length > 10) return false;
  // A lead-in ("oh", "well") and a tag ("huh", "aren't you", a pet name) around the announcement do not change what it is.
  const bare = words.join(' ').replace(/^(?:(?:oh|well|so|hey|ha|yeah|look|huh) )+/, '').replace(/(?: (?:huh|right|then|now|again|baby|babe|sweetheart|choom|v|aren't you|isn't it|am i|are you|don't you))+$/, '');
  return PRESENCE.test(bare);
}

// The five-word runs of the earlier replies that hold two content words or more.
function runsOf(earlier) {
  const runs = new Set();
  for (const list of earlier) for (let at = 0; at + PHRASE_WORDS <= list.length; at++) { const run = list.slice(at, at + PHRASE_WORDS); if (contentWords(run) >= 2) runs.add(run.join(' ')); }
  return runs;
}
// A sentence of at least six words that says what an earlier reply said: it holds a run of five words (two of them content words) of one, or most of its runs of four words.
function repeatsSentence(sentence, earlier, runs = runsOf(earlier)) {
  const words = wordsOf(sentence);
  if (words.length < 6) return false;
  if (grams(words, PHRASE_WORDS).some(run => runs.has(run))) return true;
  const mine = new Set(grams(words, 4));
  return earlier.some(list => { const there = new Set(grams(list, 4)); let inside = 0; for (const gram of mine) if (there.has(gram)) inside++; return mine.size > 0 && inside / mine.size >= 0.8; });
}
/** Is this sentence, said first, only an opener (three to eight words) that an earlier reply opened with: its first words are in the first ten words of one? */
function repeatsOpener(sentence, earlier) {
  const words = wordsOf(sentence);
  if (words.length < 3 || words.length > 8) return false;
  const key = words.slice(0, 3).join(' ');
  return earlier.some(list => grams(list.slice(0, 10), 3).includes(key));
}

// The words and five-word runs of the earlier replies, kept per list: the voice's head test asks again on every piece of the stream.
const preparedLists = new WeakMap();
function prepared(replies) {
  if (!Array.isArray(replies)) return {earlier: [], runs: new Set()};
  let found = preparedLists.get(replies);
  if (!found || found.size !== replies.length) {
    const earlier = replies.slice(-RECENT_REPLIES).map(wordsOf);
    found = {size: replies.length, earlier, runs: runsOf(earlier)};
    preparedLists.set(replies, found);
  }
  return found;
}

/** Does the start of a reply (a head the voice may begin with, one sentence or more) open with a repeated opener or a repeated sentence (or, in person, an announcement that someone is here)? Held back from the voice if so. */
export function headRepeats(head, replies, {inPerson = false} = {}) {
  const sentences = sentencesOf(head);
  if (!sentences.length) return false;
  if (inPerson && sentences.some(announcesPresence)) return true;
  const {earlier, runs} = prepared(replies);
  if (!earlier.length) return false;
  return repeatsOpener(sentences[0], earlier.slice(-4)) || sentences.some(sentence => repeatsSentence(sentence, earlier, runs));
}

/**
 * The reply with the opener it has used before and the sentences it has already said left out (and, for a talk in person, a sentence that only announces who is here), or null when
 * there is nothing to leave out, or too little would remain (fewer than MIN_KEEP_WORDS words: the older check asks again for that). `replies`: the character's own last replies, oldest first.
 */
export function freshenReply(reply, replies, {minKeep = MIN_KEEP_WORDS, inPerson = false} = {}) {
  const earlier = (replies ?? []).slice(-RECENT_REPLIES).map(wordsOf);
  const sentences = sentencesOf(reply);
  if (sentences.length < 2 || (!earlier.length && !inPerson)) return null;
  const runs = runsOf(earlier);
  const flagged = sentences.map((sentence, index) => (inPerson && announcesPresence(sentence)) || (index === 0 && repeatsOpener(sentence, earlier.slice(-4))) || repeatsSentence(sentence, earlier, runs));
  if (!flagged.some(Boolean)) return null;
  const kept = sentences.filter((_, index) => !flagged[index]);
  const result = kept.join(' ');
  if (!kept.length || wordsOf(result).length < minKeep) return null;
  return {reply: result, dropped: sentences.length - kept.length};
}

/**
 * The exchanges as the model is shown them: a reply that repeats an opener or a sentence of an earlier one in the list has it left out. The memory keeps what was said; only the
 * prompt is shorter. A model continues the pattern of the replies it reads, so the first "Oh, you're still here, huh?" stays and the next three do not feed it. [{v, r}] in, same out.
 */
export function dedupeHistory(history, {inPerson = false} = {}) {
  const turns = Array.isArray(history) ? history : [];
  if (!turns.length || (turns.length < 2 && !inPerson)) return turns;
  return turns.map((turn, index) => {
    if (typeof turn?.r !== 'string') return turn;
    const fresher = freshenReply(turn.r, turns.slice(0, index).map(other => other?.r), {inPerson});
    return fresher ? {...turn, r: fresher.reply} : turn;
  });
}
