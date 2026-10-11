// Tells a used-up Convai plan apart from other failures, so the game can say what to do about it.
//
// Evidence (docs/OWN_CONVAI_KEY.md has the sources):
//   * Convai checks the plan's quota when a session starts and every 15 seconds. When it is used up the service sends
//     one data-channel message {type: 'usage-limit-reached', quota_type: 'interaction' | 'tts', message} inside a
//     server-message, then ends the session. bridge/realtime-client.mjs turns that message into a failure whose text
//     carries "[convai-quota:<kind>]".
//   * /connect itself answers a speaker (memory user) limit with HTTP 429 "LTM speaker limit reached" or
//     "speaker limit reached" (and 503 "LTM speaker allowance is not configured for this plan"), a full plan with 429
//     "Concurrency limit reached", and a key it does not know with 401 {"detail": "Invalid API key"} (probed October 10,
//     with a made-up key). A speaker limit is about how many people the plan may remember, not about used-up
//     interactions: it never means "plan used up". On a player's key it is answered by running without an end-user
//     identity (long-term memory off), not by blocking conversations (docs/OWN_CONVAI_KEY.md).
//   * Without an end-user identity a memory-enabled character may answer 400 "Missing end_user_id. end_user_id is
//     required when the character has Long Term Memory enabled." (kind 'memory'): then this key cannot hold the
//     conversation at all.
export const QUOTA_MARKER = /\[convai-quota:(interaction|tts|plan)\]/;

/** 'daily' (the shared key's daily cap) or 'rate' (turns too quick), both raised by bridge/shared-key-guard.mjs before a turn
 * reaches Convai; 'quota' (interactions used up), 'speaker' (the plan's memory-user limit), 'memory' (an end-user identity is required
 * and unavailable), 'rejected' (key not accepted), 'busy' (concurrency) or null. Only the message text is read. */
export function classifyFailure(error) {
  const text = typeof error === 'string' ? error : typeof error?.message === 'string' ? error.message : '';
  if (!text || error?.name === 'AbortError') return null;
  const own = /\[convai-quota:(daily|rate)\]/.exec(text);
  if (own) return own[1];
  if (/concurrency limit/i.test(text)) return 'busy';
  if (QUOTA_MARKER.test(text) || /exceeded usage limits|\busage limit\b|\binteraction limit\b|reached your .{0,40}\blimit\b/i.test(text)) return 'quota';
  if (/\bspeaker limit reached\b|\bspeaker allowance is not configured\b/i.test(text)) return 'speaker';
  if (/\bend_user_id is required\b|\bmissing end_user_id\b/i.test(text)) return 'memory';
  if (/\binvalid api key\b|\bapi key (?:is )?(?:invalid|rejected)\b|\brealtime access not allowed\b/i.test(text)) return 'rejected';
  return null;
}

/** Remembers the last limit failure, for the settings status line and the one in-game notice. */
export class QuotaWatch {
  constructor({keys, now = Date.now, onChange = () => {}} = {}) {
    Object.assign(this, {keys, now, onChange});
    this.limit = null; this.rejected = null; this.speaker = null; this.memory = null;
  }
  /** Records a failure. Returns the classification. */
  observe(error) {
    const kind = classifyFailure(error);
    const own = this.keys?.source === 'player', at = this.now();
    if (kind === 'quota') { this.limit = {own, at, kind}; this.onChange(); }
    else if (kind === 'rejected') { this.rejected = {own, at}; this.onChange(); }
    else if (kind === 'speaker') this.speaker = {own, at};
    else if (kind === 'memory') { this.memory = {own, at}; this.onChange(); }
    return kind;
  }
  /** A reply was completed: the key works. */
  succeeded() { if (this.limit || this.rejected || this.memory) this.clear(); this.speaker = null; }
  clear() {
    const had = !!(this.limit || this.rejected || this.memory);
    this.limit = this.rejected = this.speaker = this.memory = null;
    if (had) this.onChange();
  }
  /** The notice code the game shows for this failure, or undefined (recent limit evidence is used when the error that
   * reached the caller no longer carries its text). */
  codeFor(error, {recentMs = 15000, automatic = false} = {}) {
    const kind = classifyFailure(error);
    const fresh = entry => entry && this.now() - entry.at <= recentMs;
    // The shared key's daily cap: the game says so once. A rate-limited turn gets the ordinary failure text.
    // An automatic reaction (battle, loot) that meets the cap just stops: only a turn the player asked for gets the notice.
    if (kind === 'daily') return this.keys?.source === 'player' || automatic ? undefined : 'daily-limit';
    if (kind === 'quota' || (!kind && fresh(this.limit))) {
      const own = (this.limit ?? {own: this.keys?.source === 'player'}).own;
      return own ? 'quota-own' : 'quota-shared';
    }
    // A speaker limit that still reaches the caller was not recoverable on that path (a voice turn): the next turn runs
    // without memory. A key that cannot serve a memory-enabled character without an identity cannot hold the conversation.
    // The shared key never has either problem.
    if (kind === 'speaker') return this.keys?.source === 'player' ? 'key-memory' : undefined;
    if (kind === 'memory') return this.keys?.source === 'player' ? 'key-memory-needed' : undefined;
    // A shared key that is refused cannot be fixed by the player's wording; only their own key can be.
    if ((kind === 'rejected' || (!kind && fresh(this.rejected))) && (this.rejected ?? {own: this.keys?.source === 'player'}).own) return 'key-rejected';
    return undefined;
  }
  snapshot() {
    if (this.limit) return {state: 'used-up', own: this.limit.own, kind: this.limit.kind};
    if (this.rejected?.own) return {state: 'rejected', own: true};
    if (this.memory?.own) return {state: 'memory-needed', own: true};
    return null;
  }
}
