// Speech recognition in any language on the Mistral route: Mistral's own transcription (Voxtral Mini Transcribe 2,
// `POST https://api.mistral.ai/v1/audio/transcriptions`, model `voxtral-mini-latest`) with the player's Mistral key
// (docs/LOCAL_STT.md, "Other languages"). Used only for a recording in a language other than English while Mistral is the
// player's conversation provider; English keeps the local Moonshine recogniser.
//
// One batch request per recording, sent when the player finishes (the model has no partial results in batch mode, so there are
// no live words for these recordings). The recording is a 16 kHz mono 16-bit WAV (32 KB per second, so 8 s is 256 KB).
// The language is auto-detected unless a hint is given; Mistral's answer names the language it heard.
//
// Rules this module keeps (the same as bridge/voxtral-voice.mjs, which speaks on the same key):
//  - The key goes only into the Authorization header of a request to api.mistral.ai; it is never logged, put in a message or kept in a
//    state file. Every message passes through `redact`.
//  - Every request goes through the shared scheduler (bridge/mistral-rate.mjs) so a free key's allowance is used in order; a 429 pauses
//    every Mistral start for its Retry-After.
//  - A refusal that can be a hiccup (HTTP 403, 408, a 5xx, a network error) is asked again once at once; a 401, a 403 that repeats and
//    a key with no allowance for transcription put the transcriber into a cool-down (`ready` is false) so the next recordings go
//    straight to the fallback instead of paying a failed request each time. A new key clears the cool-down.
//  - Nothing here runs unless a recording in another language is finished: no timer, no connection, no state.
import {mistralScheduler, PRIORITY} from './mistral-rate.mjs';
import {cancelled, throwIfCancelled} from './transport-pool.mjs';

export const VOXTRAL_STT_ENDPOINT = 'https://api.mistral.ai/v1/audio/transcriptions';
export const VOXTRAL_STT_MODEL = 'voxtral-mini-latest';
export const VOXTRAL_STT_LIMITS = Object.freeze({
  requestMs: 12_000,        // one request: from the send to the full answer
  budgetMs: 16_000,         // all tries of one recording
  maxQueueMs: 6_000,        // waiting this long behind other Mistral requests fails the recording's transcription
  retryWaitMs: 300,
  limitCooldownMs: 20_000,  // after a 429 that names no Retry-After (at most 60 s)
  planCooldownMs: 600_000,  // transcription is not in this key's plan (a 403 that repeats, or an allowance of 0)
  keyCooldownMs: 600_000,   // the key was refused (401): until a different key is saved
  maxBytes: 3_000_000,      // 45 s of 16 kHz mono 16-bit is 1.44 MB; nothing near this is sent
});

const KEY_SHAPE = /\b[A-Za-z0-9]{28,}\b/g;
/** Text with the key (when given) and anything shaped like one removed. */
export const redact = (text, apiKey) => {
  let out = String(text ?? '');
  if (typeof apiKey === 'string' && apiKey.length >= 8) out = out.split(apiKey).join('[key]');
  return out.replace(KEY_SHAPE, '[key]');
};

/** kind: 'no-key' | 'key' (401) | 'plan' (not in the plan / allowance 0) | 'limit' (429) | 'timeout' | 'network' | 'request' | 'empty'. */
export class VoxtralSttError extends Error {
  constructor(kind, detail, {status, retryAfterMs, apiKey} = {}) {
    super(`Mistral transcription ${redact(detail, apiKey).slice(0, 200)} [voxtral-stt:${kind}]`);
    this.name = 'VoxtralSttError';
    Object.assign(this, {kind, status, retryAfterMs});
  }
}

/** A canonical 44-byte-header PCM WAV around 16-bit little-endian mono samples. */
export function wavFromPcm16(pcm, sampleRate = 16000) {
  const data = Buffer.isBuffer(pcm) ? pcm : Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'latin1'); header.writeUInt32LE(36 + data.length, 4); header.write('WAVEfmt ', 8, 'latin1');
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24); header.writeUInt32LE(sampleRate * 2, 28); header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34); header.write('data', 36, 'latin1'); header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

const retryAfter = headers => {
  const raw = headers?.get?.('retry-after');
  const seconds = raw === null || raw === undefined || raw === '' ? NaN : Number(raw);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.min(seconds, 60) * 1000 : undefined;
};

/** Maps an HTTP status (and what the server said) to a VoxtralSttError. */
export function mapSttStatus(status, body, {headers, apiKey} = {}) {
  const said = typeof body === 'string' ? body.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100) : '';
  const detail = `HTTP ${status}${said ? `: ${said}` : ''}`;
  const options = {status, retryAfterMs: retryAfter(headers), apiKey};
  if (status === 401) return new VoxtralSttError('key', `did not accept the API key (${detail})`, options);
  if (status === 403) return new VoxtralSttError('plan', `refused the request (${detail})`, options);
  if (status === 429) {
    // The free plan answers 429 with an allowance of 0 for models it does not include (measured for the chat models, 2026-10-11).
    if (headers?.get?.('x-ratelimit-limit-req-minute') === '0') return new VoxtralSttError('plan', 'has no allowance in this plan (limit 0)', options);
    return new VoxtralSttError('limit', 'rate limited', options);
  }
  if (status === 408 || status >= 500) return new VoxtralSttError('network', detail, options);
  return new VoxtralSttError('request', detail, options);
}

export class VoxtralStt {
  /** getKey: () => the Mistral key or null. fetchImpl, setTimer, clearTimer, clock, scheduler, endpoint, limits: for tests. */
  constructor({getKey, onLog = () => {}, fetchImpl = globalThis.fetch, endpoint = VOXTRAL_STT_ENDPOINT, model = VOXTRAL_STT_MODEL, limits = {},
      setTimer = setTimeout, clearTimer = clearTimeout, clock = Date.now, scheduler = mistralScheduler} = {}) {
    if (typeof getKey !== 'function') throw Error('Invalid Voxtral transcription configuration');
    Object.assign(this, {getKey, onLog, fetchImpl, endpoint, model, setTimer, clearTimer, clock, scheduler});
    this.limits = Object.freeze({...VOXTRAL_STT_LIMITS, ...limits});
    this.until = 0; this.reason = null; this.lastKey = undefined;
    this.requests = 0; this.failures = 0;
  }
  #key() {
    const apiKey = this.getKey();
    if (apiKey !== this.lastKey) {
      if (this.lastKey !== undefined) { this.until = 0; this.reason = null; }   // a key saved in place of the old one is tried at once
      this.lastKey = apiKey;
    }
    return apiKey;
  }
  get hasKey() { return !!this.#key(); }
  /** Whether a request may be made now: a key, and no cool-down from an earlier refusal. */
  get ready() { return this.hasKey && this.clock() >= this.until; }
  /** Why the transcriber is not ready: 'no-key', or the kind of the refusal it is cooling down from. null while it is ready. */
  get unavailableReason() { return !this.hasKey ? 'no-key' : this.clock() < this.until ? this.reason : null; }
  log(message) { try { this.onLog(`[VoxtralStt] ${message}\n`); } catch { /* a log line never affects a recording */ } }

  #cool(error) {
    const {limits} = this;
    if (error.kind === 'key') this.until = this.clock() + limits.keyCooldownMs;
    else if (error.kind === 'plan') this.until = this.clock() + limits.planCooldownMs;
    else if (error.kind === 'limit') this.until = this.clock() + Math.min(60_000, error.retryAfterMs ?? limits.limitCooldownMs);
    else return;
    this.reason = error.kind;
  }

  /**
   * Transcribes a recording: `pcm` is 16 kHz mono Int16 little-endian samples. `language`: a base code ('ru') only when the caller is
   * sure; without it the model detects the language. Resolves {text, language, ms}; `language` is what Mistral reported (a code, or null).
   * Throws VoxtralSttError (never the key) and the caller's cancellation.
   */
  async transcribe(pcm, {language = null, signal} = {}) {
    const apiKey = this.#key();
    if (!apiKey) throw new VoxtralSttError('no-key', 'has no API key');
    if (this.clock() < this.until) throw new VoxtralSttError(this.reason ?? 'limit', 'is cooling down after a refusal', {apiKey});
    if (!pcm?.length) throw new VoxtralSttError('empty', 'was given no audio');
    if (pcm.length > this.limits.maxBytes) throw new VoxtralSttError('request', 'was given too much audio');
    const wav = wavFromPcm16(pcm);
    const started = this.clock();
    for (let attempt = 0; ; attempt++) {
      try {
        const result = await this.#once({wav, apiKey, language, signal, deadline: started + this.limits.budgetMs});
        return {...result, ms: this.clock() - started};
      } catch (error) {
        throwIfCancelled(signal);
        if (!(error instanceof VoxtralSttError)) throw error;
        const hiccup = attempt === 0 && (error.kind === 'network' || error.kind === 'timeout' || (error.kind === 'plan' && error.status === 403)
          || (error.kind === 'limit' && (error.retryAfterMs ?? 0) <= 1000));
        if (!hiccup || this.clock() + this.limits.retryWaitMs >= started + this.limits.budgetMs) { this.failures++; this.#cool(error); throw error; }
        this.log(`${error.kind}${error.status ? ` (HTTP ${error.status})` : ''}, asking again in ${this.limits.retryWaitMs} ms`);
        await this.#pause(this.limits.retryWaitMs, signal);
      }
    }
  }

  #pause(ms, signal) {
    return new Promise((resolve, reject) => {
      let timer;
      const onAbort = () => { this.clearTimer(timer); reject(signal.reason ?? cancelled()); };
      timer = this.setTimer(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
      if (signal?.aborted) onAbort(); else signal?.addEventListener('abort', onAbort, {once: true});
    });
  }

  async #once({wav, apiKey, language, signal, deadline}) {
    const controller = new AbortController();
    const onAbort = () => controller.abort(signal.reason ?? cancelled());
    signal?.addEventListener('abort', onAbort, {once: true});
    if (signal?.aborted) onAbort();
    let timer, timedOut = false;
    const arm = ms => {
      this.clearTimer(timer);
      timer = this.setTimer(() => { timedOut = true; controller.abort(Error('voxtral-stt timeout')); }, ms);
      timer?.unref?.();
    };
    try {
      let response;
      try {
        response = await this.scheduler.schedule(() => {
          // The limit counts from the moment the request is sent, not from the queue.
          this.requests++;
          arm(Math.max(1000, Math.min(this.limits.requestMs, deadline - this.clock())));
          const form = new FormData();
          form.set('model', this.model);
          if (language) form.set('language', language);
          form.set('file', new Blob([wav], {type: 'audio/wav'}), 'speech.wav');
          return this.fetchImpl(this.endpoint, {method: 'POST', signal: controller.signal, headers: {authorization: `Bearer ${apiKey}`, accept: 'application/json'}, body: form});
        }, {priority: PRIORITY.TEXT, signal: controller.signal, maxQueueMs: this.limits.maxQueueMs});
      } catch (error) {
        throwIfCancelled(signal);
        if (error?.code === 'queue-timeout') throw new VoxtralSttError('timeout', 'waited too long behind other Mistral requests', {apiKey});
        throw new VoxtralSttError(timedOut ? 'timeout' : 'network', timedOut ? `gave no answer within ${this.limits.requestMs} ms` : (error?.message || 'is unreachable'), {apiKey});
      }
      this.scheduler.noteHeaders?.(response.headers);
      if (!response.ok) {
        const body = await response.text().catch(() => '');
        const failure = mapSttStatus(response.status, body, {headers: response.headers, apiKey});
        if (failure.kind === 'limit') this.scheduler.pause?.(failure.retryAfterMs);
        throw failure;
      }
      let value;
      try { value = await response.json(); }
      catch (error) {
        throwIfCancelled(signal);
        throw new VoxtralSttError(timedOut ? 'timeout' : 'request', timedOut ? 'did not finish its answer in time' : 'answered with something that is not JSON', {apiKey});
      }
      const text = typeof value?.text === 'string' ? value.text.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 1200) : null;
      if (text === null) throw new VoxtralSttError('request', 'answered without text', {apiKey});
      return {text, language: typeof value.language === 'string' && value.language ? value.language.slice(0, 20) : null};
    } finally {
      this.clearTimer(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }
}
