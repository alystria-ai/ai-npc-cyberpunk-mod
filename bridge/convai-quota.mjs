// Tells a used-up Convai plan apart from other failures, so the game can say what to do about it.
//
// Evidence (docs/OWN_CONVAI_KEY.md has the sources):
//   * Convai checks the plan's quota when a session starts and every 15 seconds. When it is used up the service sends
//     one data-channel message {type: 'usage-limit-reached', quota_type: 'interaction' | 'tts', message} inside a
//     server-message, then ends the session. bridge/realtime-client.mjs turns that message into a failure whose text
//     carries "[convai-quota:<kind>]".
//   * /connect itself answers a speaker (memory user) limit with HTTP 429 "LTM speaker limit reached" or
//     "speaker limit reached", a full plan with 429 "Concurrency limit reached", and a key it does not know with 401
//     {"detail": "Invalid API key"} (probed October 10, with a made-up key).
export const QUOTA_MARKER = /\[convai-quota:(interaction|tts|plan)\]/;

/** 'quota' (plan used up), 'plan' (a plan limit other than interactions), 'rejected' (key not accepted),
 * 'busy' (concurrency) or null. Only the message text is read. */
export function classifyFailure(error) {
  const text = typeof error === 'string' ? error : typeof error?.message === 'string' ? error.message : '';
  if (!text || error?.name === 'AbortError') return null;
  if (/concurrency limit/i.test(text)) return 'busy';
  if (QUOTA_MARKER.test(text) || /exceeded usage limits|\busage limit\b|\binteraction limit\b|reached your .{0,40}\blimit\b/i.test(text)) return 'quota';
  if (/\bspeaker limit reached\b/i.test(text)) return 'plan';
  if (/\binvalid api key\b|\bapi key (?:is )?(?:invalid|rejected)\b/i.test(text)) return 'rejected';
  return null;
}

/** Remembers the last limit failure, for the settings status line and the one in-game notice. */
export class QuotaWatch {
  constructor({keys, now = Date.now, onChange = () => {}} = {}) {
    Object.assign(this, {keys, now, onChange});
    this.limit = null; this.rejected = null;
  }
  /** Records a failure. Returns the classification. */
  observe(error) {
    const kind = classifyFailure(error);
    const own = this.keys?.source === 'player', at = this.now();
    if (kind === 'quota' || kind === 'plan') { this.limit = {own, at, kind}; this.onChange(); }
    else if (kind === 'rejected') { this.rejected = {own, at}; this.onChange(); }
    return kind;
  }
  /** A reply was completed: the key works. */
  succeeded() { if (this.limit || this.rejected) this.clear(); }
  clear() { const had = !!(this.limit || this.rejected); this.limit = this.rejected = null; if (had) this.onChange(); }
  /** The notice code the game shows for this failure, or undefined (recent limit evidence is used when the error that
   * reached the caller no longer carries its text). */
  codeFor(error, {recentMs = 15000} = {}) {
    const kind = classifyFailure(error);
    const fresh = entry => entry && this.now() - entry.at <= recentMs;
    if (kind === 'quota' || kind === 'plan' || (!kind && fresh(this.limit))) {
      const own = (this.limit ?? {own: this.keys?.source === 'player'}).own;
      return own ? 'quota-own' : 'quota-shared';
    }
    // A shared key that is refused cannot be fixed by the player's wording; only their own key can be.
    if ((kind === 'rejected' || (!kind && fresh(this.rejected))) && (this.rejected ?? {own: this.keys?.source === 'player'}).own) return 'key-rejected';
    return undefined;
  }
  snapshot() {
    if (this.limit) return {state: 'used-up', own: this.limit.own, kind: this.limit.kind};
    if (this.rejected?.own) return {state: 'rejected', own: true};
    return null;
  }
}
