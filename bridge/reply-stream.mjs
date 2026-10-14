// Reply text that is still being written, handed to the voice before the model has finished (docs/LATENCY_2026-10-12.md).
//
// The text routes (Mistral, Groq, the local AI) stream a reply token by token. A ReplyStream sits between that stream and the
// voice: the text host feeds it the raw text so far (`update`), it cleans the text the way the finished reply is cleaned and watches
// for the first complete sentence. When that sentence is safe to speak it becomes the stream's HEAD: the voice starts on it at
// once while the model writes the rest, and the rest (the TAIL) follows when the reply is finished.
//
// The head is judged on the DISPLAY text: the reply with its emotion tags ({calm}, {joy}) and voice tags ([sigh]) taken out, which
// is the text the finished reply ends with (bridge/natural-speech.mjs). With Expressive emotions on, the model opens EVERY reply
// with such a tag, so a head that had to be tag-free in the raw text was never found in the game (2026-10-13 live record: no
// streamed head in three turns). The marks of the tags inside the head are kept (`headMarks`) for the face.
//
// "Safe" is deliberately narrow, because audio cannot be taken back. The head is committed only when
//   - it is a whole sentence (a stop, question mark, exclamation mark or ellipsis followed by a space and more text), at least
//     `minHeadChars` long (a short "Hey." joins the next sentence, so the voice is not cut into scraps);
//   - it carries nothing the cleaning could still change later: no bracket, brace, parenthesis, asterisk, underscore or angle
//     bracket left once the known tags are out (stage directions, markdown, a tag that is not an emotion), and the reply does not
//     open with a quotation mark (a reply wrapped whole in quotes loses them at the end);
//   - it does not break character ("as an AI") and is not a model's reasoning, and the host's own `reject` test does not refuse it
//     (the text host refuses a sentence that repeats a line the character has already said).
// A reply that never gets such a head is voiced after it is finished, exactly as before. The head is a prefix of the finished
// reply by construction; `reconcile` enforces it when the finished reply disagrees (a second attempt that differs: the spoken part
// stands and the rest is dropped, so the text never contradicts the audio).
import {cleanReply, breaksCharacter, leaksReasoning} from './mistral-prompt.mjs';
import {displayText, parseTagged, stripSpeechTags} from './natural-speech.mjs';
import {heldFrom} from './emotion-tags.mjs';
import {markStage} from './turn-clock.mjs';

export const REPLY_STREAM_LIMITS = Object.freeze({
  minHeadChars: 28,   // about two seconds of speech: shorter openings join the next sentence
  maxHeadChars: 260,  // a first sentence longer than this is not a head (the reply is voiced as a whole)
});

// "V." and "I." end sentences here ("Hey V. Listen."): the player's name is a single capital.
const ABBREVIATION = /(?:(?<![A-Za-z])[A-HJ-UW-Z]|\b(?:Mr|Mrs|Ms|Dr|St|Jr|Sr|vs|Prof)|\d)\.$/;
const UNSAFE = /[\[\]{}()<>*_`#|\\]/;
const OPENING_QUOTE = /^["“”'‘]/;

/** The end offsets (exclusive) of the complete sentences in `text`. A stop at the very end is not complete: more may follow it. */
export function sentenceEnds(text) {
  const ends = [];
  for (const match of String(text).matchAll(/([.!?…]+["”')\]]*)(\s+)(?=\S)/g)) {
    const end = match.index + match[1].length;
    // An abbreviation or a decimal ("Dr.", "3.5") is not a sentence end.
    if (match[1] === '.' && ABBREVIATION.test(text.slice(Math.max(0, match.index - 3), match.index + 1))) continue;
    ends.push(end);
  }
  return ends;
}

/**
 * The head of a (cleaned) reply so far: the first sentences up to at least `minHeadChars`, or null when there is none yet or none
 * that is safe to speak. `{text, end}`.
 */
export function pickHead(clean, {minHeadChars = REPLY_STREAM_LIMITS.minHeadChars, maxHeadChars = REPLY_STREAM_LIMITS.maxHeadChars, reject = null} = {}) {
  if (typeof clean !== 'string' || !clean || OPENING_QUOTE.test(clean)) return null;
  for (const end of sentenceEnds(clean)) {
    if (end < minHeadChars) continue;
    if (end > maxHeadChars) return null;
    const text = clean.slice(0, end).trim();
    if (!text || UNSAFE.test(text) || breaksCharacter(text) || leaksReasoning(text) || (reject && reject(text))) return null;
    return {text, end};
  }
  return null;
}

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  promise.catch(() => {});
  return {promise, resolve, reject};
};

export class ReplyStream {
  /**
   * name         the speaker's name (a leading "Name:" label is cleaned off)
   * isTag        which bracket groups are tags (kept by the cleaning)
   * speak        false: only watch (marks the first sentence on the turn's clock), never commit a head
   */
  constructor({name = '', isTag = () => false, speak = true, limits = {}} = {}) {
    Object.assign(this, {name, isTag, speak});
    this.limits = {...REPLY_STREAM_LIMITS, ...limits};
    this.raw = ''; this.clean = ''; this.view = ''; this.headText = null; this.headMarks_ = []; this.headSounds_ = []; this.sentenceSeen = false;
    this.finishedText = null; this.failure = null; this.diverged = false; this.attempts = 1;
    this.reject = null;   // optional (text) => boolean, set by the text host: a head it refuses is not committed
    this.head_ = deferred(); this.final_ = deferred();
    this.listeners = new Set();
  }

  /** The committed head, or null. */
  get head() { return this.headText; }
  /** The emotion marks ({at, name, strength}, `at` an offset in the head) of the tags written inside the head; [] without any. */
  get headMarks() { return this.headMarks_; }
  /** The sounds ({at, name}, `at` an offset in the head) of the voice tags written inside the head; [] without any. */
  get headSounds() { return this.headSounds_; }
  /** True once a head was committed. */
  get committed() { return this.headText !== null; }
  /** True once the reply is finished (or failed): the voice's text is final. */
  get complete() { return this.finishedText !== null || this.failure !== null; }
  /** The text to show and voice now: the finished reply, else the head, else nothing. */
  get text() { return this.finishedText ?? this.headText ?? ''; }
  /** Resolves with the head when one is committed, or null when the reply ended (finished, failed or closed) without one. */
  get headReady() { return this.head_.promise; }
  /** Resolves with the finished reply text; rejects with the failure. */
  get finished() { return this.final_.promise; }
  /** The unspoken rest: the finished reply after the head ('' when there is none or the reply disagrees with its head). */
  get tail() {
    if (this.finishedText === null || this.headText === null) return '';
    return this.finishedText.startsWith(this.headText) ? this.finishedText.slice(this.headText.length).trim() : '';
  }

  /** Calls `fn` (no arguments) whenever the head or the finished text appears. Returns a function that stops it. */
  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  #changed() { for (const fn of this.listeners) { try { fn(); } catch { /* a listener never breaks the stream */ } } }

  /**
   * Hands everything this stream has been told, and everything it is told from now on, to `other` (a fresh stream for the same speaker):
   * the reply was written into this one before its listener (the voice) existed. `other` reaches the same head and the same end.
   * Used by a voice-key turn that was started on a stable live-words decode and adopted when the final words agreed
   * (bridge/local-stt-capture.mjs); until then nothing of the reply reaches the voice.
   */
  mirrorTo(other) {
    if (!other || other === this) return;
    this.mirror = other;
    other.reject = this.reject;
    if (this.raw) other.update(this.raw);
    if (this.finishedText !== null) other.finish(this.finishedText, this.meta);
    else if (this.failure) other.fail(this.failure);
  }

  /** The raw reply text so far (the model's whole answer, not a delta). A text that does not continue the earlier one is a new attempt. */
  update(raw) {
    this.#update(raw);
    if (this.mirror) { try { this.mirror.update(raw); } catch { /* a listener never breaks the stream */ } }
  }
  #update(raw) {
    if (this.complete || typeof raw !== 'string') return;
    if (this.raw && !raw.startsWith(this.raw)) {
      // The model started over (a retry, the next model). What was already committed was heard: it stands, the new attempt is ignored.
      this.attempts++;
      if (this.headText !== null) { this.diverged = true; this.raw = raw; return; }
      this.clean = ''; this.view = ''; this.sentenceSeen = false;
    }
    this.raw = raw;
    if (this.diverged) return;
    this.clean = cleanReply(raw, {name: this.name, isTag: this.isTag});
    // What a listener will read: the tags out, a tag still being written held back.
    this.view = displayText(this.clean, false);
    if (!this.sentenceSeen && sentenceEnds(this.view).length) { this.sentenceSeen = true; markStage('firstSentence'); }
    if (this.speak && this.headText === null) {
      const found = pickHead(this.view, {...this.limits, reject: this.reject});
      if (found) {
        this.headText = found.text;
        this.headMarks_ = this.#marksWithin(found.text.length);
        this.headSounds_ = this.#marksWithin(found.text.length, 'sounds');
        this.head_.resolve(found.text);
        this.#changed();
      }
    }
  }

  /**
   * The finished reply (cleaned and capped, before any tag processing) made to agree with what was already committed: when it
   * does not begin with the head, the head is the reply.
   */
  reconcile(reply) {
    if (this.headText === null || typeof reply !== 'string') return reply;
    // The reply still carries its tags; the head is display text.
    return stripSpeechTags(reply).startsWith(this.headText) ? reply : this.headText;
  }

  // The emotion tags written inside the first `length` characters of the display text.
  #marksWithin(length, kind = 'marks') {
    try {
      const cut = heldFrom(this.clean);
      return parseTagged(cut >= 0 ? this.clean.slice(0, cut) : this.clean)[kind].filter(mark => mark.at < length);
    } catch { return []; }
  }

  /**
   * The reply is finished; `text` is the text the voice and the subtitles end with (tags already removed). `meta` is the finished
   * reply as the text route returns it (emotion marks, voice-tagged text): listeners read it as `stream.meta`.
   */
  finish(text, meta) {
    if (this.complete) return this.finishedText;
    this.meta = meta;
    this.finishedText = typeof text === 'string' ? text : this.text;
    if (this.headText === null) this.head_.resolve(null);
    this.final_.resolve(this.finishedText);
    this.#changed();
    if (this.mirror) { try { this.mirror.finish(text, meta); } catch { /* a listener never breaks the stream */ } }
    return this.finishedText;
  }

  /** The reply failed. Before any head, the voice is released to wait for the error; after one, the voice ends with it. */
  fail(error) {
    if (this.complete) return;
    this.failure = error ?? Error('The reply failed');
    if (this.headText === null) this.head_.resolve(null);
    this.final_.reject(this.failure);
    this.#changed();
    if (this.mirror) { try { this.mirror.fail(error); } catch { /* a listener never breaks the stream */ } }
  }
}
