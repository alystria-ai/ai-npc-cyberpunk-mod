// Subtitle language (Settings > Interface, runtime/settings.json `subtitleLanguage`, 2026-10-31).
//
// The characters speak the Voice language and the subtitles show another one: a Russian player hears English and reads Russian. The reply is written and
// spoken exactly as before. When `subtitleLanguage` is not 'same', one extra short request to the SAME text provider the player talks with translates the
// finished reply (never a second provider: with Local AI the translation runs on Local AI, nothing about a local voice reaches a cloud). It starts the moment
// the reply text is complete and runs beside the voice, which never waits for it.
//
// Where the translation is shown (this is the whole design, docs/SUBTITLE_LANGUAGE.md):
//   - A spoken reply (Pocket, Voxtral, OmniVoice, the Convai route when a text provider answers): the subtitle is the ORIGINAL text while the translation is
//     on its way, and the translation takes its place the moment it arrives (`show`, called by the continuous speech state on each poll, never awaited).
//     The state document carries the translated text and the caption cues cut from it, so the game's existing revision path (mod/subtitles.lua reviseTimed)
//     re-lays the page. The swap happens once per reply, a second or so after the text is complete, which is usually during the first or second sentence.
//     Holding the subtitle back instead would leave the first sentences unread, and a subtitle that arrives after the sentence was said is worse than
//     one that changes language once.
//   - A written reply (Phone Chat, a voice that cannot speak the language, Voice off): there is no sound to keep in step, so the reply waits for the
//     translation for at most `WRITTEN_WAIT_MS` (`LOCAL_WRITTEN_WAIT_MS` on Local AI) and is shown in the original if it is not there by then.
//   - The face, the lip sync, the emotion plan, the memory and the voice always use the ORIGINAL text. Only what is drawn as a subtitle or a chat line changes.
//
// Nothing is kept beyond the turn: an entry is dropped when its reply ends (`release`), when the world resets (`clear`), when it is older than `ENTRY_TTL_MS`,
// and the table never holds more than `MAX_ENTRIES`. No file is written. A failure of any kind leaves the original text on screen (never an error).
import {MOD_LANGUAGES} from './speech-language.mjs';
import {OTHER_LANGUAGE_CODES} from './other-languages.mjs';
import {LANGUAGE_NAMES} from './multilingual.mjs';

export const SUBTITLE_SAME = 'same';
/** The choices, in the order of the row: Same as speech (the default), English, the mod's other languages, then the Other languages. mod/manager.lua holds the same list. */
export const SUBTITLE_LANGUAGES = Object.freeze([SUBTITLE_SAME, 'en', ...MOD_LANGUAGES.filter(code => code !== 'en'), ...OTHER_LANGUAGE_CODES]);

/** {setting, target}: the saved choice (anything unknown reads as Same as speech) and the language to translate into, or null when the subtitles are the speech. */
export function subtitleLanguageFrom(settings) {
  const raw = settings?.subtitleLanguage;
  const setting = SUBTITLE_LANGUAGES.includes(raw) ? raw : SUBTITLE_SAME;
  return {setting, target: setting === SUBTITLE_SAME ? null : setting};
}

export const MAX_ENTRIES = 8;
export const ENTRY_TTL_MS = 120_000;
/** A reply must be this long to be worth a request at all (a bare "Hm." is shown as it is). */
export const MIN_CHARS = 2, MAX_CHARS = 1800;
/** The longest a written reply (no sound) waits for its translation. Local AI answers slower and shares the card with the game. */
export const WRITTEN_WAIT_MS = 3500, LOCAL_WRITTEN_WAIT_MS = 7000;
/** The request's own limits: a translation that takes longer is dropped (the original stays). */
export const REQUEST_TOTAL_MS = 12_000, LOCAL_REQUEST_TOTAL_MS = 30_000;

/** The request: one system message, one user message holding only the reply. No persona, no history, no memory, nothing about the player. */
export function translationMessages({text, to, from = null}) {
  const target = LANGUAGE_NAMES[to] ?? to;
  const source = from ? ` from ${LANGUAGE_NAMES[from] ?? from}` : '';
  return [
    {role: 'system', content: `You translate the subtitles of a video game${source} into ${target}. Translate the line the user sends. `
      + 'Keep the same number of sentences in the same order, the speaker\'s tone and slang, and every name and place as it is. '
      + 'Do not add, explain or comment. Answer with the translation only, with no quotes.'},
    {role: 'user', content: text},
  ];
}

/** The translation as text to show, or null when the answer cannot be trusted (empty, a refusal-sized rambling, or the same as the original). */
export function cleanTranslation(answer, original) {
  if (typeof answer !== 'string') return null;
  let text = answer.replace(/\r/g, '').trim();
  // A model may wrap the line in quotes or a code fence, or start with a label.
  text = text.replace(/^```[a-z]*\n?|\n?```$/g, '').trim();
  text = text.replace(/^(?:translation|translated|subtitle)\s*:\s*/i, '').trim();
  if (/^["“„«].*["”»]$/su.test(text) && !/["“„«].*["”»]/su.test(text.slice(1, -1))) text = text.slice(1, -1).trim();
  text = text.replace(/\s*\n+\s*/g, ' ').replace(/\s{2,}/g, ' ');
  if (!text || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) return null;
  if (text.length > Math.max(60, original.length * 4)) return null;
  if (text === original.trim()) return null;
  return text;
}

// The text the renderer finished with and the text the provider returned are the same reply, written the same way except for spacing and a cut ending
// (a reply trimmed at its last whole sentence): they match when one is the start of the other once the spaces are folded.
const folded = text => String(text).replace(/\s+/g, ' ').trim();
export function sameReply(a, b) {
  const x = folded(a), y = folded(b);
  return x.length > 0 && y.length > 0 && (x === y || x.startsWith(y) || y.startsWith(x));
}

/**
 * The per-turn table of translations. `translate({text, to, from, signal})` is the text provider's one request (TextProviderHost.translate): it resolves to
 * the translated text or null, and never to anything else; here it is guarded again, so a faulty provider cannot break a reply.
 */
export class SubtitleTranslations {
  constructor({translate = null, now = Date.now, log = () => {}, setTimer = setTimeout, clearTimer = clearTimeout} = {}) {
    Object.assign(this, {translate, now, log, setTimer, clearTimer});
    this.target = null;
    this.entries = new Map();
    this.unavailableNoted = false;
  }

  /** The language to translate into (a code), or null for Same as speech. Changing it drops what is in flight. */
  setTarget(code) {
    const next = typeof code === 'string' && code && code !== SUBTITLE_SAME ? code : null;
    if (next === this.target) return false;
    this.target = next; this.clear();
    return true;
  }

  /** Is a translation wanted at all (a target is set and the player's text provider can do it)? */
  get active() { return this.target !== null && typeof this.translate === 'function'; }

  #sweep() {
    const limit = this.now() - ENTRY_TTL_MS;
    for (const [id, entry] of this.entries) if (entry.at < limit) this.release(id);
    while (this.entries.size >= MAX_ENTRIES) this.release(this.entries.keys().next().value);
  }

  /**
   * Starts the request for one finished reply, at once, and returns without waiting: `id` is the turn (its request id), `text` the finished reply,
   * `speech` the language it is spoken in (null when not known). Skips (and returns false) when no target is set, the text is too short or too long, or the
   * reply is already in the target language. Never throws.
   */
  begin(id, text, {speech = null, signal} = {}) {
    try {
      if (!this.active || typeof id !== 'string' || !id || typeof text !== 'string') return false;
      const trimmed = text.trim();
      if (trimmed.length < MIN_CHARS || trimmed.length > MAX_CHARS) return false;
      if (speech && speech === this.target) return false;
      this.#sweep();
      const own = new AbortController();
      const entry = {original: text, target: this.target, at: this.now(), done: false, value: null, own, waiters: new Set()};
      const stop = () => own.abort();
      if (signal) { if (signal.aborted) return false; signal.addEventListener('abort', stop, {once: true}); entry.unlisten = () => signal.removeEventListener('abort', stop); }
      this.entries.set(id, entry);
      entry.promise = (async () => {
        let value = null;
        try { value = cleanTranslation(await this.translate({text: trimmed, to: entry.target, from: speech, signal: own.signal}), trimmed); }
        catch (error) { if (!own.signal.aborted) this.#failed(error); }
        entry.value = this.entries.get(id) === entry ? value : null;
        entry.done = true;
        for (const wake of entry.waiters) wake();
        entry.waiters.clear();
        return entry.value;
      })();
      return true;
    } catch (error) { this.#failed(error); return false; }
  }

  #failed(error) {
    // One line per kind, never the text: a log line must not carry the player's conversation.
    if (this.unavailableNoted) return;
    this.unavailableNoted = true;
    try { this.log(`subtitle translation failed (${String(error?.reason ?? error?.kind ?? error?.name ?? 'error').slice(0, 40)}): the subtitles stay in the speech language`); } catch { /* a log never breaks a turn */ }
  }

  /**
   * The subtitle to draw for a spoken reply, asked on every state poll and never waiting: the translation once it is here and `original` is the finished
   * text it was made from, otherwise `original` itself (the reply is still being written, or the translation is on its way, or it failed).
   */
  show(id, original, complete = true) {
    const entry = this.entries.get(id);
    if (!entry || !entry.done || !entry.value || complete !== true || !sameReply(entry.original, original)) return original;
    return entry.value;
  }

  /** True while the request for `id` is in flight. */
  pending(id) { const entry = this.entries.get(id); return !!entry && !entry.done; }

  /**
   * The text of a reply with no sound to keep in step (a chat line, a written reply): the translation if it arrives within `ms`, else `original`. Never
   * rejects and never waits longer than `ms`.
   */
  async wait(id, original, ms) {
    const entry = this.entries.get(id);
    if (!entry) return original;
    if (!entry.done) {
      await new Promise(resolve => {
        const timer = this.setTimer(resolve, ms);
        entry.waiters.add(() => { this.clearTimer(timer); resolve(); });
      });
    }
    return this.show(id, original, true);
  }

  /** The reply of `id` is over: its entry is dropped (and an unfinished request is abandoned). */
  release(id) {
    const entry = this.entries.get(id);
    if (!entry) return;
    this.entries.delete(id);
    try { entry.unlisten?.(); } catch { /* already gone */ }
    if (!entry.done) { try { entry.own.abort(); } catch { /* already over */ } }
    for (const wake of entry.waiters) wake();
    entry.waiters.clear();
  }

  clear() { for (const id of [...this.entries.keys()]) this.release(id); }
}
