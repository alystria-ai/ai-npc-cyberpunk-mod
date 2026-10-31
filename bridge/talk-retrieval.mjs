// Retrieval for a turn's background (docs/NATURAL_TALK_RESEARCH_2026-10-30.md, sections 14 and 15).
//
// A character's prompt used to carry, on every turn, the whole of her topic material (2,400 characters of views and anecdotes on average), the tracked quest, the open jobs, the
// journal history, the recent shared events and the world facts. A model brings up whatever it is given, so "so hows life" got a quest recital. Now each of those is a pool of
// small units and a turn takes only the few that bear on what V just said (and, for a short follow-up, the lines before it):
//
//   const retrieval = new TalkRetrieval({embedder, queryVector, topicFor, corpus, vectorsPath, log});
//   const result = await retrieval.prepare({profileKey, requestId, text, reaction}, {sources, signal});
//   result.text       the late "what comes to mind" block ('' when nothing bears on V's words)
//   result.dropped    the keys of the sources whose full block the prompt must leave out (they are replaced by `text`)
//
// A source is {key, units: [{id, text, data, importance, recency}], render(idSet) -> string, preface?}: bridge/quest-context.mjs builds the context ones (retrievalSources), the
// topic one comes from the character's roster text (bridge/topic-material.mjs) through `topicFor(profileKey)`.
//
// How a unit is chosen (all of it in this process, on demand for the turn, nothing per frame):
//   1. A line that is only small talk (a greeting, thanks, "how is it going", "so hows life", "perhaps") brings up nothing: no embedding, no scan, and the lines before it do not count.
//   2. Words: a unit passes when V's content words (stop words and chat filler removed) hit it by rarity (inverse document frequency over the roster's topic text): one rare word, or
//      half of the weight of V's words. Always available, so Gemini and Custom players without the Local AI pack get the same choice, and the first turn after a cold start too.
//   3. Meaning: when the memory embedder is already running, V's line is embedded once (the same vector the memory search uses, bridge/memory-store.mjs queryVector, with a hard
//      timeout) and compared with the vectors of the units, which are cached in memory and on disk by the hash of their text (a unit with no vector yet is judged by words alone and
//      its vector is made in the background). The embedder's own cut-off applies (memory-store.mjs RETRIEVAL_RULES: granite needs a best score of 0.70 and keeps what is within 0.10 of it).
//   4. A unit that passes either test is ranked by reciprocal rank fusion of the two lists, then a little by importance and recency (Generative Agents), and a topic view voiced in
//      the last few turns is not offered again (cooldown). Caps per source and a character budget keep the block to a few items.
import {isPureSmallTalk, retrievalRuleFor, cutoffFor} from './memory-store.mjs';
import {textKey} from './topic-material.mjs';

// ---- Words ---------------------------------------------------------------------------------------------------------------------------
// Function words, and the words of chat that carry no topic ("think", "tell", "life", "doing", "really"): a line made only of these is small talk, and none of them ranks a unit.
const STOP = new Set(('the and you your yours are was were what when where which who whom whose why how with without about from into onto that this these those there their them they then than ' +
  'have has had did does doing done not but for any all can could would should will just like know think thought tell told said say says get got its hey yeah okay one out our ours his her hers him ' +
  'she he been being because also really still ever never some more most much very remember happened happen going gonna want wanna talk talking let lets thing things stuff way back ' +
  'hows whats thats ill ive dont didnt doesnt cant wont isnt arent wasnt youre youve its hes shes theyre perhaps maybe probably guess kinda sorta actually basically honestly seriously ' +
  'life day days today tonight tomorrow yesterday lately recently these those been feel feeling feels felt look looks looking see seen seem seems sure fine good great nice cool well right ' +
  'yes yep yup nope nah hello hiya howdy sup bye goodbye later thanks thank please sorry again now then here there over off too even else other another own same such only both each ' +
  'make made makes take took takes give gave come came comes goes went gone put use used using try tried keep kept find found call called ask asked asking anyone anything everyone everything ' +
  'someone something nothing nobody everybody onto upon around between through during before after while until since once twice while still yet already always sometimes often ' +
  'choom buddy friend man dude mate pal partner lot lots bit little quite bunch kind').split(/\s+/));
const WORD = /[\p{L}\p{N}]+/gu;
// The ending of an English plural or verb form comes off, so "runners" meets "runner" and "corpos" meets "corpo". Words of other scripts are left whole.
const stem = word => (/^[a-z]+$/.test(word) && word.length > 4 ? word.replace(/(?:ing|ed|es|s)$/, '') : word);
/** The content words of a text, as stems (stop words, filler and anything under three letters left out). */
export function contentTokens(text) {
  const out = [];
  for (const raw of String(text ?? '').toLowerCase().replace(/[’']/g, '').match(WORD) ?? []) {
    if (raw.length < 3 || STOP.has(raw)) continue;
    const word = stem(raw);
    if (word.length >= 3 && !STOP.has(word)) out.push(word);
  }
  return out;
}

// Questions about work have few content words ("what now", "what should we do next", "where do I go"). They carry the words the quest and job units are written with, so they
// find them by words as well as by meaning.
const INTENT = [
  [/\bwhat(?:'s| is)?\s+(?:now|next)\b|\bwhat\s+(?:should|shall|can|do)\s+(?:i|we)\s+do\b|\bwhat\s+are\s+we\s+doing\b|\bwhere\s+(?:to|do (?:i|we)|should (?:i|we)|are we) (?:go|going|head)\b|\bwhat(?:'s| is) (?:the )?plan\b|\bwhat now\b/iu, ['quest', 'objective', 'job']],
  [/\b(?:jobs?|gigs?|work|contracts?|missions?|tasks?|quests?|errands?|assignments?|objectives?)\b/iu, ['quest', 'job']],
];
export function intentTokens(text) {
  const out = [];
  for (const [pattern, words] of INTENT) if (pattern.test(String(text ?? ''))) out.push(...words);
  return out;
}

/**
 * Is this line small talk, with nothing in it to look up? A pure greeting or thanks (bridge/memory-store.mjs isPureSmallTalk), or a line with no content word left once the stop words
 * and the filler are gone ("how is it going", "so hows life", "perhaps", "how do you feel these days"). A line about work ("what now") counts through its intent words.
 */
const GREETINGS = /long time no see|been a (?:while|minute)|good to see you|nice to see you|great to see you|what(?:'|’)?s up|what(?:'|’)?s new|anything new|how(?:'|’)?s everything|how are things|how(?:'|’)?s (?:it|things|everything|life|business|biz)\b|how have you been|how do you do/iu;
export function isChitchat(text) {
  const value = String(text ?? '');
  if (!value.trim() || isPureSmallTalk(value) || GREETINGS.test(value)) return true;
  return contentTokens(value).length === 0 && intentTokens(value).length === 0;
}

// ---- Rarity --------------------------------------------------------------------------------------------------------------------------
/** Document frequencies over a body of texts (the roster's topic items): idf(word) = ln((N + 1) / (df + 0.5)), highest for a word no text has. */
export class Corpus {
  constructor(texts = []) {
    this.df = new Map(); this.n = 0;
    for (const text of texts) this.add(text);
  }
  add(text) {
    this.n++;
    for (const word of new Set(contentTokens(text))) this.df.set(word, (this.df.get(word) ?? 0) + 1);
  }
  idf(word) { return Math.log((this.n + 1) / ((this.df.get(word) ?? 0) + 0.5)); }
}
// One rare word is enough (its idf is above this: it is in about one text in thirty of the roster's), otherwise half the weight of V's words must be in the unit and the words
// must be worth something (a sum of idf above the second number).
// A line that picks up the one before it says so: "and the plan?", "what about Mox", "so who is he?". Without such a word a short line stands alone ("long time no see" is not about Saul).
const FOLLOW_UP = /^\s*(?:and|but|so|then|also|what about|how about|what else|what of|who|whose|where|when|why|how come|really|is that|was that|does that|did that)\b/iu;
const RARE_IDF = 3.2, COVERAGE = 0.5, MIN_MASS = 2.5;

const tokenCache = new Map();
function unitTokens(text) {
  let set = tokenCache.get(text);
  if (!set) {
    if (tokenCache.size >= 6000) tokenCache.clear();
    set = new Set(contentTokens(text)); tokenCache.set(text, set);
  }
  return set;
}

/** {pass, score} of one unit for the query words, by rarity. `intent`: the words a question about work stands for; they are looked for in a unit's anchor only. */
export function lexicalMatch(query, unit, corpus, intent = []) {
  if (intent.length && unit.anchor) {
    const anchor = unitTokens(unit.anchor);
    if (intent.some(word => anchor.has(word))) return {pass: true, score: 4 * intent.filter(word => anchor.has(word)).length + (query.length ? lexicalMatch(query, unit, corpus).score : 0)};
  }
  const have = unitTokens(unit.text);
  let total = 0, mass = 0, rare = false;
  for (const word of query) {
    const weight = corpus.idf(word);
    total += weight;
    if (have.has(word)) { mass += weight; if (weight >= RARE_IDF) rare = true; }
  }
  if (!(mass > 0)) return {pass: false, score: 0};
  return {pass: rare || (mass / total >= COVERAGE && mass >= MIN_MASS), score: mass};
}

// ---- Ranking one pool of units ---------------------------------------------------------------------------------------------------------
// Reciprocal rank fusion of the two short lists; k is small because a list is at most a dozen units.
const RRF = 10;
const dot = (a, b) => { let sum = 0; for (let i = 0; i < a.length; i++) sum += a[i] * b[i]; return sum; };
/**
 * The units of one source that bear on the query, best first: [{unit, rel, via}] with `rel` 0..1 (1 = the best of this source). `query`: {tokens: [stems], vec?: Float32Array}.
 * `vectorOf(unit)` gives a unit's cached vector or undefined; `rule` is the embedder's cut-off rule (memory-store.mjs retrievalRuleFor). Pure.
 */
export function rankUnits(units, query, {corpus, vectorOf = () => undefined, rule = {min: 0.40}} = {}) {
  const lexical = [];
  if (query.tokens.length || query.intent?.length) for (const unit of units) { const hit = lexicalMatch(query.tokens, unit, corpus, query.intent ?? []); if (hit.pass) lexical.push({unit, score: hit.score}); }
  lexical.sort((a, b) => b.score - a.score);
  const meaning = [];
  if (query.vec) {
    const scored = [];
    for (const unit of units) { const vec = vectorOf(unit); if (vec && vec.length === query.vec.length) scored.push({unit, score: dot(query.vec, vec)}); }
    const cutoff = scored.length ? cutoffFor(rule, scored.map(row => row.score)) : null;
    if (cutoff !== null) meaning.push(...scored.filter(row => row.score >= cutoff).sort((a, b) => b.score - a.score));
  }
  const fused = new Map();
  const add = (rows, via) => rows.forEach((row, index) => {
    const entry = fused.get(row.unit) ?? {unit: row.unit, score: 0, via: new Set()};
    entry.score += 1 / (RRF + index + 1); entry.via.add(via); fused.set(row.unit, entry);
  });
  add(lexical, 'words'); add(meaning, 'meaning');
  const best = Math.max(0, ...[...fused.values()].map(entry => entry.score));
  return [...fused.values()].map(entry => {
    const rel = best > 0 ? entry.score / best : 0;
    return {unit: entry.unit, rel, via: [...entry.via].join('+'), order: rel + 0.06 * (entry.unit.importance ?? 0.5) + 0.04 * (entry.unit.recency ?? 0.5)};
  }).sort((a, b) => b.order - a.order);
}

// ---- Vectors, cached --------------------------------------------------------------------------------------------------------------------
const encode = vec => Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength).toString('base64');
function decode(text, dim) {
  if (typeof text !== 'string' || !(dim > 0)) return null;
  const bytes = Buffer.from(text, 'base64');
  if (bytes.length !== dim * 4) return null;
  const vec = new Float32Array(dim);
  for (let i = 0; i < dim; i++) vec[i] = bytes.readFloatLE(i * 4);
  return vec.every(Number.isFinite) ? vec : null;
}
const embedText = unit => String(unit.embed ?? unit.text ?? '').slice(0, 400);

// ---- What was said, per character ----------------------------------------------------------------------------------------------------------
const TALK_IDLE_MS = 10 * 60_000, MAX_TALKS = 64, COOLDOWN_TURNS = 3, RECENT_LINES = 2;
class TalkState {
  #talks = new Map();
  constructor({idleMs = TALK_IDLE_MS} = {}) { this.idleMs = idleMs; }
  get(key, now) {
    let talk = this.#talks.get(key);
    if (talk && now - talk.at > this.idleMs) { this.#talks.delete(key); talk = undefined; }
    if (!talk) talk = {at: now, turn: 0, recent: [], shown: new Map()};
    if (this.#talks.has(key)) this.#talks.delete(key);
    this.#talks.set(key, talk);
    while (this.#talks.size > MAX_TALKS) this.#talks.delete(this.#talks.keys().next().value);
    return talk;
  }
  reset(key) { if (key === undefined) this.#talks.clear(); else this.#talks.delete(String(key)); }
}

// The words of a character's own name (her profile key and her display name): `prepare` leaves them out of V's words.
function nameTokens(turn) {
  const words = new Set();
  for (const part of `${String(turn.profileKey ?? '').replace(/[-_.@]+/g, ' ')} ${turn.name ?? ''}`.toLowerCase().match(WORD) ?? []) { words.add(part); words.add(stem(part)); }
  return words;
}

export const RETRIEVAL_HEADING = 'WHAT COMES TO MIND (background you know, not a list: use a detail only where it fits what V said)';
// How many of each source, and how many characters of units in all (the unit's data, without the framing text that travels with it).
export const CAPS = Object.freeze({topic: 2, journal: 1, jobs: 2, history: 2, recency: 2, knowledge: 3});
export const BUDGET_CHARS = 800;   // about 200 tokens of units a turn (docs/NATURAL_TALK_RESEARCH_2026-10-30.md section 6)
const ORDER = ['topic', 'journal', 'jobs', 'history', 'recency', 'knowledge'];

export class TalkRetrieval {
  /**
   * embedder       the memory embedder (bridge/local-embed.mjs): available() / ready() / warm() / embed() / id / dim. None: words only.
   * queryVector    async (text, {timeoutMs, signal}) -> Float32Array | null; the memory store's, so a turn embeds V's words once. Default: the embedder directly.
   * topicFor       (profileKey) -> {preface, items: [{text}]} | null: a character's topic material.
   * corpus         the texts the rarity of a word is judged by (the roster's topic items).
   * vectorsPath    where the unit vectors are kept between runs (a JSON file); none: memory only.
   * quiet          () => boolean; false (a fight) holds back the background making of the vectors of a turn's units.
   */
  constructor({embedder = null, queryVector = null, topicFor = () => null, corpus = [], vectorsPath = null, read, write, now = Date.now, clock = () => performance.now(),
      queryTimeoutMs = 120, quiet = () => true, log = () => {}, setTimer = setTimeout, clearTimer = clearTimeout, state = new TalkState()} = {}) {
    Object.assign(this, {embedder, topicFor, vectorsPath, read, write, now, clock, queryTimeoutMs, quiet, log, setTimer, clearTimer, state});
    this.queryVector = queryVector ?? (async (text, {timeoutMs, signal} = {}) => {
      if (!embedder?.ready?.()) return null;
      const control = new AbortController(), stop = () => control.abort();
      signal?.addEventListener?.('abort', stop, {once: true});
      const timer = setTimer(stop, timeoutMs ?? 120);
      try { return (await embedder.embed([text], {signal: control.signal}))?.[0] ?? null; } catch { return null; } finally { clearTimer(timer); signal?.removeEventListener?.('abort', stop); }
    });
    this.corpus = corpus instanceof Corpus ? corpus : new Corpus(corpus);
    this.vectors = new Map();      // textKey -> Float32Array, for the current embedder
    this.vectorsFor = null;        // the embedder id the vectors belong to
    this.loaded = null; this.saveTimer = null; this.saving = Promise.resolve();
    this.results = new Map();      // requestId -> result: a turn built twice gets the same block
    this.pending = new Set();      // textKeys being embedded in the background
    this.disabled = false;
    this.counters = {turns: 0, smallTalk: 0, vector: 0, words: 0, empty: 0};
  }

  // ---- the disk cache
  async #load() {
    if (this.loaded) return this.loaded;
    const id = this.embedder?.id ?? null;
    // No embedder (yet): nothing to read, and a pack installed later is looked for again.
    if (!id) return undefined;
    this.vectorsFor = id;
    this.loaded = (async () => {
      if (!this.vectorsPath || !this.read) return;
      try {
        const file = JSON.parse(await this.read(this.vectorsPath));
        if (file?.version === 1 && file.embedder === id && file.dim === this.embedder.dim && file.vectors && typeof file.vectors === 'object') {
          for (const [key, text] of Object.entries(file.vectors)) { const vec = decode(text, file.dim); if (vec) this.vectors.set(key, vec); }
        }
      } catch { /* no file, or one that cannot be read: the vectors are made again */ }
    })();
    return this.loaded;
  }
  #saveSoon() {
    if (!this.vectorsPath || !this.write || this.saveTimer) return;
    this.saveTimer = this.setTimer(() => { this.saveTimer = null; void this.flush(); }, 2000);
    this.saveTimer?.unref?.();
  }
  /** Writes the vectors now (the debounced save, and the bridge's exit). Never throws. */
  async flush() {
    if (!this.vectorsPath || !this.write || !this.vectorsFor || !this.vectors.size) return;
    if (this.saveTimer) { this.clearTimer(this.saveTimer); this.saveTimer = null; }
    const dim = this.embedder?.dim;
    const vectors = {};
    for (const [key, vec] of [...this.vectors].slice(-8000)) vectors[key] = encode(vec);
    const document = JSON.stringify({version: 1, embedder: this.vectorsFor, dim, vectors});
    this.saving = this.saving.then(() => this.write(this.vectorsPath, document)).catch(() => {});
    await this.saving;
  }

  /** The units of a pool that have no vector yet. */
  #missing(units) { return units.filter(unit => !this.vectors.has(textKey(embedText(unit)))); }
  /** Makes the vectors of `units` (one request per batch the embedder takes). Only while the embedder runs, unless `start` allows it to start. Never throws. */
  async embedUnits(units, {start = false, signal} = {}) {
    try {
      const embedder = this.embedder;
      if (!embedder?.available?.() || !(start || embedder.ready?.())) return 0;
      await this.#load();
      const todo = this.#missing(units).filter(unit => !this.pending.has(textKey(embedText(unit)))).slice(0, 64);
      if (!todo.length) return 0;
      const keys = todo.map(unit => textKey(embedText(unit)));
      for (const key of keys) this.pending.add(key);
      try {
        const vectors = await embedder.embed(todo.map(embedText), {signal});
        vectors.forEach((vec, index) => { if (vec?.length === embedder.dim) this.vectors.set(keys[index], vec); });
        this.#saveSoon();
        return vectors.length;
      } finally { for (const key of keys) this.pending.delete(key); }
    } catch { return 0; }
  }

  // ---- the character's topic source
  topicSource(profileKey) {
    const material = this.topicFor(profileKey);
    if (!material?.items?.length) return null;
    const units = material.items.map((item, index) => ({id: `t${index}`, text: String(item.text).split('\n')[0], data: item.text, importance: 0.5, recency: 0.5, kind: 'topic'}));
    return {key: 'topic', preface: material.preface ?? '', units, lines: true};
  }

  /**
   * Starts the embedder for a talk with this character and makes the vectors of her topic material, in the background: never awaited, never throws. For a text route's talk.
   */
  warmFor(profileKey) {
    if (this.disabled || !this.embedder?.available?.()) return false;
    const source = this.topicSource(profileKey);
    void (async () => {
      try {
        await this.embedder.warm?.();
        if (source) await this.embedUnits(source.units, {start: true});
      } catch { /* a warm-up never matters to a turn */ }
    })();
    return true;
  }

  /** Every character's topic material, a batch at a time, while `gate()` says it is quiet (the bridge calls it once). Resolves when done or stopped. */
  async fillAll(keys, {gate = () => true, gapMs = 400, stop = () => false} = {}) {
    let made = 0;
    for (const key of keys) {
      if (stop()) break;
      while (!gate() && !stop()) await new Promise(resolve => this.setTimer(resolve, 5000));
      const source = this.topicSource(key);
      if (!source) continue;
      await this.#load();
      if (!this.#missing(source.units).length) continue;
      made += await this.embedUnits(source.units, {start: true});
      await new Promise(resolve => this.setTimer(resolve, gapMs));
    }
    return made;
  }

  // ---- a turn
  /**
   * The background for this turn. `turn`: {profileKey, requestId, text, reaction}. `options.sources`: the context sources (quest-context.mjs retrievalSources). Returns
   * {text, dropped, picked, via, reason, ms}; `dropped` lists every source that was offered, whether or not a unit of it was chosen, so the prompt leaves its full block out.
   */
  async prepare(turn, {sources = [], signal} = {}) {
    const started = this.clock();
    const key = typeof turn.requestId === 'string' ? `${turn.profileKey}|${turn.requestId}|${turn.text ?? ''}` : null;
    if (key && this.results.has(key)) return this.results.get(key);
    const topic = turn.reaction ? null : this.topicSource(turn.profileKey);
    const pools = [...(topic ? [topic] : []), ...sources.filter(source => source?.units?.length)];
    const dropped = pools.map(pool => pool.key);
    // The text each replaced block keeps in the prompt on every turn (its framing): the same whatever was chosen, so the stable part of the prompt does not move.
    const frames = Object.fromEntries(pools.filter(pool => typeof pool.frame === 'string' && pool.frame).map(pool => [pool.key, pool.frame]));
    const done = (fields) => {
      const result = {text: '', dropped, frames, picked: {}, via: 'none', reason: '', ...fields, ms: Math.round((this.clock() - started) * 100) / 100};
      this.counters.turns++;
      if (result.reason === 'small-talk') this.counters.smallTalk++; else if (!result.text) this.counters.empty++; else if (/meaning/.test(result.via)) this.counters.vector++; else this.counters.words++;
      if (key) { this.results.set(key, result); while (this.results.size > 16) this.results.delete(this.results.keys().next().value); }
      return result;
    };
    const text = String(turn.text ?? '');
    if (turn.reaction || !text.trim()) return done({reason: 'not-a-line'});
    const talk = this.state.get(String(turn.profileKey), this.now());
    // The first thing that decides: a line of small talk brings up nothing, whatever was said before it.
    if (isChitchat(text)) { talk.at = this.now(); talk.turn++; return done({reason: 'small-talk'}); }
    if (!pools.length) { this.#noteLine(talk, text); return done({reason: 'no-sources'}); }

    // The query is V's words. A line with almost nothing in it ("and Saul?", "what about her?") that finds nothing alone is tried again with what V said just before. The
    // character's own name says nothing about a topic (everything she says is hers) and is left out.
    const mine = nameTokens(turn);
    const own = contentTokens(text).filter(word => !mine.has(word)), intent = intentTokens(text);
    if (!own.length && !intent.length) { talk.at = this.now(); talk.turn++; return done({reason: 'small-talk'}); }
    const elliptical = FOLLOW_UP.test(text) && (text.match(WORD) ?? []).length <= 6 && talk.recent.length > 0;

    await this.#load();
    const rule = this.embedder?.id ? retrievalRuleFor(this.embedder.id) : {min: 0.40};
    const context = {corpus: this.corpus, rule, vectorOf: unit => this.vectors.get(textKey(embedText(unit)))};
    // The vector is made only while the embedder runs (a cold one is started for the next turn and this turn goes by words) and never waits past the timeout.
    const vectorFor = async query => (this.embedder?.ready?.() && this.vectors.size ? await this.queryVector(query, {timeoutMs: this.queryTimeoutMs, signal}).catch(() => null) : null);
    // Rank every pool, then take the best of each within its cap and the budget, best first across the pools.
    const choose = (tokens, vec) => {
      const ranked = pools.map(pool => ({pool, rows: rankUnits(pool.units, {tokens, intent, vec}, context)
        .filter(row => pool.key !== 'topic' || !(talk.shown.get(row.unit.id + row.unit.text) > talk.turn - COOLDOWN_TURNS))}));
      const candidates = ranked.flatMap(({pool, rows}) => rows.map(row => ({pool, ...row}))).sort((a, b) => b.rel - a.rel || b.order - a.order);
      const count = new Map(), taken = new Map();
      let used = 0;
      for (const row of candidates) {
        const key = row.pool.key, cap = CAPS[key] ?? 2;
        if ((count.get(key) ?? 0) >= cap) continue;
        const cost = String(row.unit.data ?? row.unit.text).length;
        if (used + cost > BUDGET_CHARS && used > 0) continue;
        used += cost; count.set(key, (count.get(key) ?? 0) + 1);
        if (!taken.has(key)) taken.set(key, []);
        taken.get(key).push(row);
      }
      return taken;
    };
    let picked = choose([...new Set(own)], await vectorFor(text));
    if (signal?.aborted) throw signal.reason ?? Object.assign(Error('cancelled'), {name: 'AbortError'});
    if (!picked.size && elliptical) {
      const before = talk.recent.slice(-RECENT_LINES);
      picked = choose([...new Set([...own, ...before.flatMap(contentTokens)])], await vectorFor(`${before.at(-1)} ${text}`));
      if (signal?.aborted) throw signal.reason ?? Object.assign(Error('cancelled'), {name: 'AbortError'});
    }
    talk.turn++; talk.at = this.now();
    this.#noteLine(talk, text);
    const pieces = [];
    const via = new Set();
    for (const name of ORDER) {
      const rows = picked.get(name);
      if (!rows) continue;
      const pool = pools.find(item => item.key === name);
      for (const row of rows) { for (const part of row.via.split('+')) via.add(part); if (name === 'topic') talk.shown.set(row.unit.id + row.unit.text, talk.turn - 1); }
      pieces.push(pool.lines
        ? [pool.preface, ...rows.map(row => `- ${String(row.unit.data).split('\n').map((line, index) => (index ? `  ${line}` : line)).join('\n')}`)].filter(Boolean).join('\n')
        : pool.render(new Set(rows.map(row => row.unit.id))));
    }
    if (talk.shown.size > 200) for (const key of [...talk.shown.keys()].slice(0, talk.shown.size - 100)) talk.shown.delete(key);
    // The units that have no vector yet are made after the turn, while the embedder runs (the next turn finds them).
    if (this.embedder?.ready?.() && this.quiet()) void this.embedUnits(pools.flatMap(pool => this.#missing(pool.units)).slice(0, 48));
    const picks = Object.fromEntries([...picked].map(([name, rows]) => [name, rows.map(row => row.unit.id)]));
    return done({text: pieces.length ? `${RETRIEVAL_HEADING}\n${pieces.join('\n\n')}` : '', picked: picks, via: [...via].join('+') || 'none', reason: pieces.length ? '' : 'nothing-close',
      detail: pools.map(pool => `${pool.key}=${picked.get(pool.key)?.length ?? 0}/${pool.units.length}`).join(' ')});
  }
  #noteLine(talk, text) {
    talk.recent.push(String(text).slice(0, 300));
    while (talk.recent.length > RECENT_LINES + 1) talk.recent.shift();
  }

  /** Forgets what the talks remember (a new save, Forget everything). */
  reset(profileKey) { this.state.reset(profileKey); this.results.clear(); }
}
