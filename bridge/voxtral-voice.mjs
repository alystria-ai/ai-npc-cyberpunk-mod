// The Mistral cloud voice (Voxtral): an optional Companion voice that speaks a reply with Mistral's text-to-speech
// (`voxtral-mini-tts-latest`), cloned from the character's own OmniVoice "long" reference clip, on the player's free Mistral
// key (docs/CLOUD_VOICE_VOXTRAL.md, docs/FREE_CLOUD_OPTION_RESEARCH.md).
//
// It speaks through the same interface as Pocket TTS: `synthesizeStream(voiceKey, text, {signal, onPcm})` hands `onPcm` packets of
// 24 kHz mono float32 audio, so the written reply, the subtitles, the lip sync and the facial model (all driven by those
// packets) are the Pocket path unchanged. The packets carry Pocket's transport marker (`engine: 'pocket-tts'`), which the PCM host
// requires; `timing.voiceEngine` says the audio really came from Voxtral.
//
// Rules this module keeps:
//  - Mistral streams server-sent events: `speech.audio.delta` with base64 raw 32-bit float little-endian PCM, then
//    `speech.audio.done`. (Decoding the bytes as 16-bit garbles the sound.)
//  - Saved voices need a paid plan, so the reference clip is sent with every request. Its base64 form is cached per voice in
//    memory and never rebuilt.
//  - A cloud call can fail or stall (about one call in ten took 11 s in the measurements). Before any audio has been delivered
//    every failure (no key, no reference, a refused or limited request, a network error, no first audio within `firstAudioMs`)
//    throws a VoxtralError, and the caller speaks that reply with Pocket instead. Once audio is playing a later failure ends
//    that reply's audio early (the written reply is complete) rather than playing two voices.
//  - One request per reply (the whole text, streamed), never one per sentence: a free Mistral key may be limited to about one
//    request a second for the whole workspace, shared with the text replies. Every request goes through the shared scheduler
//    (bridge/mistral-rate.mjs), text first; the first-audio limit counts from the moment the request is actually sent.
//  - The key is only ever put in the Authorization header of a request to api.mistral.ai; it is never logged, put in a message
//    or kept in a state file. Messages pass through `redact`.
import {createHash, randomBytes} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {resolve, sep} from 'node:path';
import {cancelled, throwIfCancelled} from './transport-pool.mjs';
import {mistralScheduler, PRIORITY} from './mistral-rate.mjs';

export const VOXTRAL_ENDPOINT = 'https://api.mistral.ai/v1/audio/speech';
export const VOXTRAL_MODEL = 'voxtral-mini-tts-latest';
export const VOXTRAL_RATE = 24000;
export const VOXTRAL_LIMITS = Object.freeze({
  firstAudioMs: 4000,        // no audio by then: Pocket speaks this reply
  stallMs: 8000,             // silence this long inside a running stream ends it
  maxChars: 4000,            // longer text goes to Pocket (the model's context is 4,096 tokens)
  maxQueueMs: 6000,          // waiting this long behind other Mistral requests: Pocket speaks this reply
  frameSamples: 2400,        // 100 ms packets, the size Pocket's own packets are in the same range
  maxReferenceSeconds: 25,   // a longer clip is cut (the searched references are 8 to 18 s)
  maxReferenceBytes: 4_000_000,
  cachedReferences: 32,
  limitCooldownMs: 20_000,   // after a 429, no request for the server's Retry-After (this when it names none, at most 60 s)
  keyCooldownMs: 60_000,     // after the key was refused
});
// A fixed identity for the packets (the PCM host checks owner/profile/model stay the same through one reply).
const MODEL_ID = createHash('sha256').update(VOXTRAL_MODEL).digest('hex');
const KEY_SHAPE = /\b[A-Za-z0-9]{28,}\b/g;

/** Text with the key (when given) and anything shaped like one removed. */
export const redact = (text, apiKey) => {
  let out = String(text ?? '');
  if (typeof apiKey === 'string' && apiKey.length >= 8) out = out.split(apiKey).join('[key]');
  return out.replace(KEY_SHAPE, '[key]');
};

/**
 * kind: 'no-key', 'no-reference', 'key' (refused), 'limit' (429), 'timeout' (no first audio in time), 'network' (unreachable,
 * a server fault or a stalled stream), 'request' (a refused request or an unusable answer), 'text' (not speakable).
 * Always thrown before any audio reached `onPcm` (or by the consumer itself, marked `sink`).
 */
export class VoxtralError extends Error {
  constructor(kind, detail, {status, retryAfterMs, apiKey} = {}) {
    super(`Voxtral ${redact(detail, apiKey).slice(0, 200)} [voxtral:${kind}]`);
    this.name = 'VoxtralError';
    Object.assign(this, {kind, status, retryAfterMs});
  }
}

const retryAfter = headers => {
  const raw = headers?.get?.('retry-after');
  const seconds = raw === null || raw === undefined || raw === '' ? NaN : Number(raw);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.min(seconds, 60) * 1000 : undefined;
};

/** Maps an HTTP status to a VoxtralError. */
export function mapStatus(status, body, {headers, apiKey} = {}) {
  const detail = (typeof body === 'string' && body ? body.slice(0, 160) : `HTTP ${status}`);
  const options = {status, retryAfterMs: retryAfter(headers), apiKey};
  if (status === 401 || status === 403) return new VoxtralError('key', 'did not accept the API key', options);
  if (status === 429) return new VoxtralError('limit', 'rate limited', options);
  if (status === 408 || status >= 500) return new VoxtralError('network', detail, options);
  return new VoxtralError('request', detail, options);
}

// ---- reference clips ----------------------------------------------------------------------------------------------------

/** The WAV bytes cut to at most `seconds` of audio (a canonical PCM file; anything else is returned as is). */
export function capWav(bytes, seconds = VOXTRAL_LIMITS.maxReferenceSeconds) {
  if (bytes.length < 44 || bytes.toString('latin1', 0, 4) !== 'RIFF' || bytes.toString('latin1', 8, 12) !== 'WAVE') return bytes;
  let at = 12, rate = 0, align = 0, dataAt = -1, dataLength = 0;
  while (at + 8 <= bytes.length) {
    const id = bytes.toString('latin1', at, at + 4), length = bytes.readUInt32LE(at + 4);
    if (id === 'fmt ' && at + 24 <= bytes.length) { rate = bytes.readUInt32LE(at + 12); align = bytes.readUInt16LE(at + 20); }
    if (id === 'data') { dataAt = at + 8; dataLength = Math.min(length, bytes.length - dataAt); break; }
    at += 8 + length + (length & 1);
  }
  if (dataAt < 0 || !rate || !align) return bytes;
  const keep = Math.floor(seconds * rate) * align;
  if (dataLength <= keep) return bytes;
  const out = Buffer.concat([bytes.subarray(0, dataAt), bytes.subarray(dataAt, dataAt + keep)]);
  out.writeUInt32LE(out.length - 8, 4);
  out.writeUInt32LE(keep, dataAt - 4);
  return out;
}

// ---- server-sent events -------------------------------------------------------------------------------------------------

/** Yields the joined data payload of each server-sent event of a byte stream (CRLF, comments and split chunks handled). */
export async function* sseEvents(body) {
  const decoder = new TextDecoder('utf-8');
  let buffer = '', data = [];
  const lines = text => text.split(/\r\n|\n|\r/);
  const handle = line => {
    if (line === '') { if (!data.length) return undefined; const joined = data.join('\n'); data = []; return joined; }
    if (line.startsWith(':')) return undefined;
    const colon = line.indexOf(':'), field = colon < 0 ? line : line.slice(0, colon);
    if (field !== 'data') return undefined;
    let value = colon < 0 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    data.push(value);
    return undefined;
  };
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, {stream: true});
    const parts = lines(buffer);
    buffer = parts.pop();
    // A bare "\r" at the very end may be the first half of a CRLF: keep it for the next chunk.
    for (const line of parts) { const event = handle(line); if (event !== undefined) yield event; }
  }
  buffer += decoder.decode();
  for (const line of lines(buffer)) { const event = handle(line); if (event !== undefined) yield event; }
  const last = handle('');
  if (last !== undefined) yield last;
}

// ---- the voice ---------------------------------------------------------------------------------------------------------

export class VoxtralVoice {
  /**
   * getKey: () => the Mistral key or null. referenceRoot: the folder 'runtime/voice-references/' maps to. registry: the OmniVoice
   * long voice registry ({profiles: {key: {reference, sha256}}}); set later with setReferences. onChange: called when the voice
   * becomes degraded or recovers. fetchImpl, readFile, setTimer, clearTimer, now, endpoint: for tests.
   */
  constructor({getKey, referenceRoot, registry, onChange = () => {}, onLog = () => {}, fetchImpl = globalThis.fetch,
    read = readFile, endpoint = VOXTRAL_ENDPOINT, limits = {}, setTimer = setTimeout, clearTimer = clearTimeout,
    now = () => performance.now(), clock = Date.now, scheduler = mistralScheduler} = {}) {
    if (typeof getKey !== 'function') throw Error('Invalid Voxtral configuration');
    Object.assign(this, {getKey, referenceRoot, registry, onChange, onLog, fetchImpl, read, endpoint, setTimer, clearTimer, now, clock, scheduler});
    this.limits = Object.freeze({...VOXTRAL_LIMITS, ...limits});
    this.references = new Map();      // voice key -> Promise<{base64, bytes, seconds}|null>
    this.owner = randomBytes(16).toString('hex'); this.sequence = 0;
    // degraded: why the last attempt fell back (null: working or not tried). until: no request before this time (a limit or a refused key).
    this.degraded = null; this.until = 0; this.spoke = 0; this.fellBack = 0;
  }
  setReferences(registry) { this.registry = registry; this.references.clear(); }
  get hasKey() { return !!this.getKey(); }
  /** Whether a request may be made now (a key, and not inside a limit or refused-key cool-down). */
  get ready() { return this.hasKey && this.clock() >= this.until; }
  /** Does this voice key have a reference clip to clone (without reading it)? */
  hasReference(key) { return !!this.registry?.profiles?.[key]?.reference; }
  log(message) { try { this.onLog(`[Voxtral] ${message}\n`); } catch { /* a log line never affects speech */ } }
  note(reason) {
    const changed = (this.degraded?.reason ?? null) !== (reason ?? null);
    this.degraded = reason ? {reason, at: this.clock()} : null;
    if (reason) this.fellBack++;
    if (changed) { try { this.onChange(this.degraded); } catch { /* observers never break speech */ } }
  }

  /** The encoded reference of a voice, cached in memory (one read and one encoding per voice, per process). */
  reference(key) {
    const cached = this.references.get(key);
    if (cached) {
      // Most recent last, so the oldest is the one dropped.
      this.references.delete(key); this.references.set(key, cached);
      return cached;
    }
    const entry = this.registry?.profiles?.[key];
    const pending = !entry?.reference ? Promise.resolve(null) : (async () => {
      const prefix = 'runtime/voice-references/';
      if (!this.referenceRoot || !entry.reference.startsWith(prefix)) return null;
      const root = resolve(this.referenceRoot), path = resolve(root, entry.reference.slice(prefix.length));
      if (path !== root && !path.startsWith(root + sep)) return null;
      let bytes = await this.read(path);
      if (bytes.length > this.limits.maxReferenceBytes * 4) return null;
      // The registry carries the file's hash: a changed file is not the reference that was validated.
      if (entry.sha256 && createHash('sha256').update(bytes).digest('hex') !== entry.sha256) return null;
      bytes = capWav(bytes, this.limits.maxReferenceSeconds);
      if (bytes.length > this.limits.maxReferenceBytes) return null;
      return {base64: bytes.toString('base64'), bytes: bytes.length};
    })().catch(() => null);
    this.references.set(key, pending);
    // A reference that could not be built is tried again next time (the file may appear later).
    pending.then(value => { if (!value && this.references.get(key) === pending) this.references.delete(key); });
    while (this.references.size > this.limits.cachedReferences) this.references.delete(this.references.keys().next().value);
    return pending;
  }

  /**
   * Speaks `text` as the voice `key`, handing `onPcm` 24 kHz mono float32 packets of Pocket's shape. Resolves with the
   * stream's summary. Throws a VoxtralError when nothing was delivered (the caller uses Pocket), `cancelled` when `signal`
   * aborts, and the consumer's own error (marked `sink`) when `onPcm` fails.
   */
  async synthesizeStream(key, text, {signal, onPcm} = {}) {
    throwIfCancelled(signal);
    if (typeof onPcm !== 'function') throw Error('Voxtral streaming requires a PCM consumer');
    const apiKey = this.getKey();
    const fail = (kind, detail, extra) => new VoxtralError(kind, detail, {apiKey, ...extra});
    try {
      if (typeof text !== 'string' || !text.trim() || text.length > this.limits.maxChars
          || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) throw fail('text', 'cannot speak this text');
      if (!apiKey) throw fail('no-key', 'has no Mistral key');
      if (this.clock() < this.until) throw fail('limit', 'is waiting out a limit');
      const queued = this.now();
      const reference = await this.reference(key);
      throwIfCancelled(signal);
      if (!reference) throw fail('no-reference', 'has no reference clip for this voice');
      const result = await this.stream({key, text, apiKey, reference, signal, onPcm, queued, fail});
      this.note(null);
      this.spoke++;
      return result;
    } catch (error) {
      if (error instanceof VoxtralError) {
        if (error.kind === 'limit' && error.status === 429) this.until = this.clock() + (error.retryAfterMs ?? this.limits.limitCooldownMs);
        if (error.kind === 'key') this.until = this.clock() + this.limits.keyCooldownMs;
        // A voice without a reference, or text that cannot be spoken, is that reply's problem, not the service's.
        if (error.kind !== 'text' && error.kind !== 'no-reference') this.note(error.kind);
        this.log(`fell back to Pocket: ${error.kind}${error.status ? ` (HTTP ${error.status})` : ''}`);
      }
      throw error;
    }
  }

  async stream({key, text, apiKey, reference, signal, onPcm, queued, fail}) {
    const controller = new AbortController();
    const onAbort = () => controller.abort(cancelled());
    signal?.addEventListener('abort', onAbort, {once: true});
    if (signal?.aborted) onAbort();
    let timer, timedOut = null, delivered = 0, chunks = 0, firstMs = null;
    const arm = (ms, kind) => {
      this.clearTimer(timer);
      timer = this.setTimer(() => { timedOut = kind; controller.abort(Error(`voxtral ${kind}`)); }, ms);
      timer?.unref?.();
    };
    const id = ++this.sequence, started = this.now();
    let carry = Buffer.alloc(0), pending = new Float32Array(0), response;
    const emit = async packetSamples => {
      const packet = {version: 1, engine: 'pocket-tts', profile: key, owner: this.owner, id, index: chunks + 1,
        sampleRate: VOXTRAL_RATE, channels: 1, pcm: packetSamples, format: 'f32le', offsetFrames: delivered,
        frames: packetSamples.length, timebase: 'audio-seconds', startSeconds: delivered / VOXTRAL_RATE,
        modelSha256: MODEL_ID, timing: {voicePcmReceivedMs: this.now() - started}};
      try { await onPcm(packet); }
      catch (error) { error.sink = true; throw error; }
      delivered += packetSamples.length; chunks++;
      firstMs ??= this.now() - started;
    };
    // Whole 100 ms packets while audio arrives; the remainder waits for the next event or the end.
    const push = async (bytes, final) => {
      const joined = carry.length ? Buffer.concat([carry, bytes]) : bytes;
      const whole = joined.length - (joined.length % 4);
      carry = Buffer.from(joined.subarray(whole));
      if (whole) {
        const samples = new Float32Array(whole / 4);
        for (let at = 0; at < samples.length; at++) {
          const value = joined.readFloatLE(at * 4);
          samples[at] = Number.isFinite(value) ? value : 0;
        }
        const merged = new Float32Array(pending.length + samples.length);
        merged.set(pending); merged.set(samples, pending.length);
        pending = merged;
      }
      const size = this.limits.frameSamples;
      let from = 0;
      while (pending.length - from >= size || (final && pending.length - from > 0)) {
        const end = Math.min(from + size, pending.length);
        await emit(pending.slice(from, end));
        from = end;
      }
      if (from) pending = pending.slice(from);
    };
    try {
      try {
        response = await this.scheduler.schedule(() => {
          // The first-audio limit counts from the moment the request is sent, not from when it queued behind other Mistral requests.
          arm(this.limits.firstAudioMs, 'timeout');
          return this.fetchImpl(this.endpoint, {method: 'POST', signal: controller.signal,
            headers: {authorization: `Bearer ${apiKey}`, 'content-type': 'application/json', accept: 'text/event-stream'},
            body: JSON.stringify({model: VOXTRAL_MODEL, input: text, ref_audio: reference.base64, response_format: 'pcm', stream: true})});
        }, {priority: PRIORITY.TTS, signal: controller.signal, maxQueueMs: this.limits.maxQueueMs});
      } catch (error) {
        throwIfCancelled(signal);
        if (error?.code === 'queue-timeout') throw fail('timeout', 'waited too long behind other Mistral requests');
        throw timedOut ? fail('timeout', `gave no audio within ${this.limits.firstAudioMs} ms`) : fail('network', error?.message || 'is unreachable');
      }
      this.scheduler.noteHeaders(response.headers);
      if (!response.ok) {
        const body = await response.text().catch(() => '');
        const failure = mapStatus(response.status, body, {headers: response.headers, apiKey});
        // A 429 holds every Mistral request (text included) for the server's retry-after.
        if (failure.kind === 'limit') this.scheduler.pause(failure.retryAfterMs);
        throw failure;
      }
      if (!response.body) throw fail('request', 'answered without a stream');
      let done = false;
      try {
        for await (const raw of sseEvents(response.body)) {
          let event; try { event = JSON.parse(raw); } catch { continue; }
          if (event?.type === 'speech.audio.delta' && typeof event.audio_data === 'string') {
            await push(Buffer.from(event.audio_data, 'base64'), false);
            // Audio is flowing: the first-audio limit is over, a long silence is the next limit.
            if (delivered) arm(this.limits.stallMs, 'stall');
          } else if (event?.type === 'speech.audio.done') { done = true; break; }
          else if (event?.type === 'error' || event?.error) throw fail('request', String(event.message ?? event.error?.message ?? 'reported an error'));
        }
        await push(Buffer.alloc(0), true);
      } catch (error) {
        throwIfCancelled(signal);
        if (error.sink || error instanceof VoxtralError && delivered === 0) throw error;
        if (delivered === 0) throw timedOut === 'timeout' ? fail('timeout', `gave no audio within ${this.limits.firstAudioMs} ms`) : fail('network', error?.message || 'stream failed');
        // Audio is already playing: end this reply's audio here, after the last whole sample received.
        this.log(`stream ended early after ${(delivered / VOXTRAL_RATE).toFixed(1)} s: ${redact(error?.message, apiKey).slice(0, 80)}`);
        done = false;
        try { await push(Buffer.alloc(0), true); } catch (flushError) { if (flushError.sink) throw flushError; }
      }
      if (!delivered) throw fail('request', 'answered without audio');
      const truncated = !done;
      return {provider: 'voxtral', engine: 'voxtral', sampleRate: VOXTRAL_RATE, channels: 1, frames: delivered, chunks,
        duration: delivered / VOXTRAL_RATE, modelSha256: MODEL_ID, truncated,
        timing: {voiceProvider: 'pocket', voiceEngine: 'voxtral', voiceCloud: true, voiceWarm: true,
          voiceFirstPcmReceivedMs: firstMs, voiceGenerationMs: this.now() - started, voiceRoundTripMs: this.now() - started,
          voiceQueueMs: started - queued, voiceReferenceBytes: reference.bytes, ...(truncated ? {voiceTruncated: true} : {})}};
    } finally {
      this.clearTimer(timer);
      signal?.removeEventListener('abort', onAbort);
      // Free the connection whichever way this ended.
      if (!controller.signal.aborted) controller.abort(cancelled('Voxtral request completed'));
    }
  }
}
