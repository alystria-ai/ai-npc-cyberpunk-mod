// The words of a conversation, kept for as long as it lasts, so the text a turn's world blocks are chosen by does not change with every sentence.
//
// The journal history (bridge/journal-history.mjs) and the world facts (bridge/world-knowledge.mjs) are ranked by the words V just said, so a block's text changed on nearly
// every turn. They sit in the system message, ahead of the stable blocks and of the whole talk, so a fully local model read the prompt again from there on every turn: 5,000 to
// 6,500 new tokens for Judy against about 800 for a street NPC (docs/LOCAL_AI.md, "Judy's prompt was read again on every turn", measured 2026-10-29). Ranked by the words of the whole talk
// instead (every word V said to this character since the talk began, in the order they first came up, the oldest dropped past MAX_WORDS), a block changes only when V brings up a
// topic that is new to the talk, and a block that does not change is read from the cache. A talk that has been quiet for IDLE_MS starts again from nothing.
// Memory only: nothing is saved, and the words of one character are never given to another's turn.
const IDLE_MS = 10 * 60_000;
const MAX_WORDS = 40;
const MAX_TALKS = 64;

export class TopicWords {
  #talks = new Map();
  constructor({idleMs = IDLE_MS, maxWords = MAX_WORDS, maxTalks = MAX_TALKS} = {}) { Object.assign(this, {idleMs, maxWords, maxTalks}); }

  /**
   * The words of the talk with `key` (a profile key) including those of `text`, as one line to rank by. The same text again returns the same line, so a turn that is built twice agrees
   * with itself. An empty or missing text returns what the talk has so far ('' for a talk that has not begun).
   */
  fold(key, text, now = Date.now()) {
    const id = String(key ?? '');
    let talk = this.#talks.get(id);
    if (talk && now - talk.at > this.idleMs) { this.#talks.delete(id); talk = undefined; }
    const fresh = typeof text === 'string' ? (text.slice(0, 2000).toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []) : [];
    if (!talk) {
      if (!fresh.length) return '';
      talk = {words: [], at: now};
    }
    if (this.#talks.has(id)) this.#talks.delete(id);   // the most recently used last
    for (const word of fresh) if (!talk.words.includes(word)) talk.words.push(word);
    if (talk.words.length > this.maxWords) talk.words.splice(0, talk.words.length - this.maxWords);
    if (fresh.length) talk.at = now;
    this.#talks.set(id, talk);
    while (this.#talks.size > this.maxTalks) this.#talks.delete(this.#talks.keys().next().value);
    return talk.words.join(' ');
  }

  /** Forgets one talk, or all of them. */
  reset(key) { if (key === undefined) this.#talks.clear(); else this.#talks.delete(String(key)); }
}

/** The bridge's own memory of talks. */
export const topicWords = new TopicWords();
