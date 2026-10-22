// The Mistral cloud voice (Voxtral): an optional Companion voice that speaks a reply with Mistral's text-to-speech
// (Voxtral TTS 3, `voxtral-mini-tts-3-0`; the older `voxtral-mini-tts-latest` when the account refuses it), cloned from the character's own reference clip (OmniVoice long set, else short set, else the
// Pocket reference, else clips extracted for that character), on the player's free Mistral key (docs/CLOUD_VOICE_VOXTRAL.md,
// docs/FREE_CLOUD_OPTION_RESEARCH.md).
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
//    throws a VoxtralError; the voice selection asks once more with a longer wait (timeout, network, request), and a reply with still no
//    audio is shown as written text: no local voice (Pocket, OmniVoice) is loaded or used for it. Once audio is playing a later failure ends
//    that reply's audio early (the written reply is complete) rather than playing two voices. The same holds for the rest of a
//    reply (the second part of a long one, or the tail after a streamed first sentence): it is asked for again once, with a longer
//    limit, and if that fails too the reply ends after the part already heard; no other voice speaks it.
//  - A refusal that can be a hiccup (HTTP 403, 408, 5xx, a short 429) is asked again once at once, inside the ask (`fetchPart`, a wait of
//    about 0.3 s, never more than a second in all), and only a 401 or a 403 that repeats is a refused key (2026-10-17: one 403 in a group
//    round was reported as a bad key and silenced two voices). Speech requests in flight are capped (`request-gate.mjs`), the held next
//    speaker of a group round (`ahead: true`) last, so a burst stays small and the speaker being heard never waits for it.
//  - A 403 whose own body says "guardrail" (or that the request was "blocked", `isContentRefusal`) is a refusal of that one line's text,
//    not of the key: it is a VoxtralError of kind 'content', never asked again (it would be refused the same way), never a pause of the
//    voice (the next reply's voice is asked as usual), never a tightening of the request gate, never reported as a refused key, and it
//    leaves no degraded state. That reply is shown as written text; one log line says so. No other voice speaks it: the voice of a turn is
//    chosen when it starts (before any text exists), and the Convai voice is never part of that choice unless the player chose it.
//  - An ordinary NPC (an archetype or resident voice, never a named character) is cloned from ONE clip, always the same one: the archetype
//    references are several game lines joined with silence, each in its own delivery, and Voxtral clones every request afresh, so a reply spoken as
//    two to four requests came out in different-sounding voices, depending on which line each request leaned on (2026-10-21, `singleClip`).
//  - One request per reply (the whole text, streamed), never one per sentence: a free Mistral key may be limited to about one
//    request a second for the whole workspace, shared with the text replies. Every request goes through the shared scheduler
//    (bridge/mistral-rate.mjs), text first; the first-audio limit counts from the moment the request is actually sent.
//  - The key is only ever put in the Authorization header of a request to api.mistral.ai; it is never logged, put in a message
//    or kept in a state file. Messages pass through `redact`.
import {createHash, randomBytes} from 'node:crypto';
import {readFile, readdir} from 'node:fs/promises';
import {resolve, sep} from 'node:path';
import {cancelled, throwIfCancelled} from './transport-pool.mjs';
import {mistralScheduler, PRIORITY} from './mistral-rate.mjs';
import {cloudFetchOptions} from './mistral-client.mjs';
import {RequestGate} from './request-gate.mjs';
import {isVariantKey} from './voice-variants.mjs';
import {VOXTRAL_TTS_MODEL, VOXTRAL_TTS_FALLBACK_MODEL, modelRefused, voxtralSpeaks} from './voxtral-languages.mjs';
import {PLAYER_REFERENCE_PREFIX, isPlayerReference, playerReferenceValid} from './voice-profile-registry.mjs';

export const VOXTRAL_ENDPOINT = 'https://api.mistral.ai/v1/audio/speech';
// Voxtral TTS 3 (released 2026-10-20). The `-latest` alias still points to the March 2026 model, so the v3 id is asked by name; an account that
// refuses it (unknown, not on the plan, 404 or a repeated 403) is served by the alias instead, from then on, with one log line (fetchPart).
export const VOXTRAL_MODEL = VOXTRAL_TTS_MODEL;
export const VOXTRAL_FALLBACK_MODEL = VOXTRAL_TTS_FALLBACK_MODEL;
export const VOXTRAL_RATE = 24000;
export const VOXTRAL_LIMITS = Object.freeze({
  firstAudioMs: 5000,        // no audio this long after the request was sent: it is asked again once with a longer wait, then the reply is written (a long reply is split to stay well inside)
  // The written reply appears with the first audio, so a stalled request holds the text (measured first audio: 90% within 1.4 s, at most 2.5 s; a stall is one call
  // in ten, 5 to 11 s, and a second ask is nearly always quick). A first ask that has given no audio after hedgeMs is asked a second time in parallel, and the
  // first audio of either is the reply's (the other is cancelled before it hands on a sample). 2026-10-22 review: the text waited up to 17 s, 29 s with queueing.
  hedgeMs: 2500,
  // The rest of a reply whose first part was heard in this voice is never given to another voice. It is asked for as soon as the text
  // is known, with these limits, and again once if the first ask fails before any audio (the first part's audio buys the time;
  // Voxtral's server-side spikes are 5 to 11 s on about one call in ten, and a second ask is nearly always quick):
  tailFirstAudioMs: 6000,    // the first ask
  tailRetryAudioMs: 10000,   // the second ask
  tailMaxQueueMs: 15000,     // waiting this long behind other Mistral requests fails the ask
  splitMinChars: 160,        // a reply shorter than this is one request
  firstPartMinChars: 40,     // the first request of a split reply holds at least this much (a short opening joins the next sentence)
  firstPartMaxChars: 120,    // with no sentence end near, the first request ends at a clause break before this
  restMinChars: 40,          // a split that would leave less than this for the second request is not made
  splitMarginMs: 1500,       // the second request's audio is released this long before the first one's would run out
  splitGraceMs: 400,         // the second request is always given at least this long after the first part is done
  stallMs: 8000,             // silence this long inside a running stream ends it
  // After `speech.audio.done` the rest of the stream (a few bytes) is read, in the background, for at most this long, so its connection goes
  // back to the shared pool for the next request; a stream cut off instead closes its connection, and the next request (the rest of the
  // reply, the next turn's first sentence) paid DNS, TCP and TLS again: about 50 to 90 ms of its first audio (measured 2026-10-19).
  drainMs: 250,
  maxChars: 4000,            // longer text cannot be spoken (the model's context is 4,096 tokens): written reply
  maxQueueMs: 6000,          // waiting this long behind other Mistral requests: the reply is written
  frameSamples: 2400,        // 100 ms packets, the size Pocket's own packets are in the same range
  maxReferenceSeconds: 25,   // a longer clip is cut (the searched references are 8 to 18 s)
  extractedTargetSeconds: 12, // clips extracted for a character are joined until they reach this length (never past the maximum)
  extractedClips: 8,         // at most this many extracted clips are read for one reference
  maxReferenceBytes: 4_000_000,
  cachedReferences: 32,
  modelRetryMs: 600_000,     // after the account refused the v3 model and the older one answered: the older one is asked this long, then v3 is tried again
  limitCooldownMs: 20_000,   // after a 429, no request for the server's Retry-After (this when it names none, at most 60 s)
  // V's own line (lane 'v') is asked beside the companion's reply on the same key. A 429 that its request earned pauses V's lane only
  // (until the server's Retry-After, as above), and the Mistral scheduler, which every request of the key shares, is held for this long at
  // most: the companion's reply is never silenced for 20 to 60 s by a limit that V's echo hit (2026-10-22 review of the 0.2.x reports).
  vPauseCapMs: 1500,
  keyCooldownMs: 60_000,     // after the key was refused (HTTP 401)
  forbiddenCooldownMs: 20_000, // after an HTTP 403 that was still there on the quick second try (2026-10-17: one 403 mid-round was not a bad key)
  // A refusal that can be a hiccup (HTTP 403, 429 with a short Retry-After, 408, 5xx) is tried again once at once, inside the reply's own ask,
  // after this short wait; a Retry-After longer than the budget is not waited for. No turn is held back longer than the budget for a retry.
  // A 401 is a refused key and is never tried again.
  retryWaitMs: 300,
  retryBudgetMs: 1000,
  maxConcurrent: 4,          // speech requests in flight at once (a group round can ask for the speaker, V's line and the held next speaker together)
  maxAhead: 1,               // of those, at most this many for the held next speaker (a look-ahead never takes every slot)
  tightConcurrent: 2,        // after a refusal that may be a burst limit: this many at once ...
  tightMs: 30_000,           // ... for this long
});
// A fixed identity for the packets (the PCM host checks owner/profile/model stay the same through one reply).
// (Fixed for both models: a reply never changes model, but the identity must not depend on which one answered.)
const MODEL_ID = createHash('sha256').update('voxtral-mini-tts').digest('hex');
// Where a reference came from, by registry order (setReferences): shown in the diagnostics and the log.
const REFERENCE_SOURCES = ['omni-long', 'omni-short', 'pocket'];
// The references of ordinary NPCs (scripts/archetype-voices): several whole game lines joined with 0.4 s of silence. Named characters' clips are elsewhere.
const AMBIENT_REFERENCES = 'runtime/voice-references/archetypes/';
// The cache key of a language pack's reference is <language>|<voice key>: no voice key holds a bar.
const LANGUAGE_SEPARATOR = '|';
// A voice key that may name a folder: lower-case letters, digits and hyphens only.
const SAFE_VOICE_KEY = /^[a-z0-9][a-z0-9-]*$/;
// What a second ask can cure (not a refused key, not text that cannot be spoken).
const ASK_AGAIN = new Set(['timeout', 'network', 'request', 'limit']);
const KEY_SHAPE = /\b[A-Za-z0-9]{28,}\b/g;

/** Text with the key (when given) and anything shaped like one removed. */
export const redact = (text, apiKey) => {
  let out = String(text ?? '');
  if (typeof apiKey === 'string' && apiKey.length >= 8) out = out.split(apiKey).join('[key]');
  return out.replace(KEY_SHAPE, '[key]');
};

/**
 * kind: 'no-key', 'no-reference', 'key' (refused), 'limit' (429), 'timeout' (no first audio in time), 'network' (unreachable,
 * a server fault or a stalled stream), 'request' (a refused request or an unusable answer), 'text' (not speakable), 'content' (the
 * server's guardrail refused this line's text: not a key, a limit or a fault, and the same text would be refused again).
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

// A body that is a web page (a gateway or firewall block page), and wording that blames the key, the account or the network.
const MARKUP_BODY = /<\s*(?:!doctype|html|head|body)\b/i;
const NOT_CONTENT = /\b(?:key|token|account|organi[sz]ation|workspace|credentials?|ip|address|access|subscription|plan)\b/i;

/**
 * Is this a 403 in which the server itself says the text was refused: its own body names a guardrail, or says "blocked" (plain or JSON
 * body, not a web page, and not blaming the key, the account or the network: "your key is blocked" stays a key problem)? Only the
 * body the server sent is looked at (its first 2,000 characters), never the request or anything this module made up.
 */
export function isContentRefusal(status, body) {
  if (status !== 403 || typeof body !== 'string') return false;
  const text = body.slice(0, 2000);
  if (/guardrail/i.test(text)) return true;
  return /\bblocked\b/i.test(text) && !MARKUP_BODY.test(text) && !NOT_CONTENT.test(text);
}

/** Maps an HTTP status to a VoxtralError. */
export function mapStatus(status, body, {headers, apiKey} = {}) {
  const detail = (typeof body === 'string' && body ? body.slice(0, 160) : `HTTP ${status}`);
  const options = {status, retryAfterMs: retryAfter(headers), apiKey};
  // The server refused this line's text (its guardrail), not the key: nothing here says "key", and nothing pauses or retries (see noteFailure).
  if (isContentRefusal(status, body)) return new VoxtralError('content', 'refused this line (guardrail)', options);
  // What the server said goes in the log line (the key and anything shaped like one are scrubbed): the line must show whether a 403 was
  // a refused key or something else (a gateway page, a burst limit).
  const said = typeof body === 'string' ? body.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100) : '';
  if (status === 401 || status === 403) return new VoxtralError('key', `did not accept the API key (HTTP ${status}${said ? `: ${said}` : ''})`, options);
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

/** A canonical-header PCM WAV's format and sample bytes, or null for anything else (only plain PCM can be joined). */
function pcmParts(bytes) {
  if (bytes.length < 44 || bytes.toString('latin1', 0, 4) !== 'RIFF' || bytes.toString('latin1', 8, 12) !== 'WAVE') return null;
  let at = 12, format = null;
  while (at + 8 <= bytes.length) {
    const id = bytes.toString('latin1', at, at + 4), length = bytes.readUInt32LE(at + 4);
    if (id === 'fmt ' && at + 24 <= bytes.length) {
      format = {tag: bytes.readUInt16LE(at + 8), channels: bytes.readUInt16LE(at + 10), rate: bytes.readUInt32LE(at + 12), bits: bytes.readUInt16LE(at + 22)};
    }
    if (id === 'data') {
      if (!format || format.tag !== 1 || !format.channels || !format.rate || !format.bits) return null;
      return {...format, data: bytes.subarray(at + 8, Math.min(bytes.length, at + 8 + length))};
    }
    at += 8 + length + (length & 1);
  }
  return null;
}

/**
 * Clips of one voice joined end to end into a single WAV: the first clip sets the format, a clip of another format is skipped,
 * and joining stops once `targetSeconds` is reached. A clip that would pass `maxSeconds` is skipped (the first clip is
 * kept whatever its length; the caller cuts it). Returns null when no clip can be used.
 */
export function joinWavs(clips, {targetSeconds = VOXTRAL_LIMITS.extractedTargetSeconds, maxSeconds = VOXTRAL_LIMITS.maxReferenceSeconds} = {}) {
  let format = null, seconds = 0;
  const parts = [];
  for (const clip of clips) {
    const wav = pcmParts(clip);
    if (!wav || !wav.data.length) continue;
    if (format && (wav.rate !== format.rate || wav.channels !== format.channels || wav.bits !== format.bits)) continue;
    const align = wav.channels * (wav.bits / 8), length = wav.data.length - (wav.data.length % align);
    if (!Number.isInteger(align) || length <= 0) continue;
    const clipSeconds = length / align / wav.rate;
    if (format && seconds + clipSeconds > maxSeconds) continue;
    format = format ?? wav;
    parts.push(wav.data.subarray(0, length)); seconds += clipSeconds;
    if (seconds >= targetSeconds) break;
  }
  if (!format) return null;
  return wavFile(format, Buffer.concat(parts));
}

/** A canonical 44-byte-header PCM WAV of `data` in `format` ({channels, rate, bits}). */
function wavFile(format, data) {
  const header = Buffer.alloc(44), align = format.channels * (format.bits / 8);
  header.write('RIFF', 0, 'latin1'); header.writeUInt32LE(36 + data.length, 4); header.write('WAVEfmt ', 8, 'latin1');
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(format.channels, 22);
  header.writeUInt32LE(format.rate, 24); header.writeUInt32LE(format.rate * align, 28); header.writeUInt16LE(align, 32);
  header.writeUInt16LE(format.bits, 34); header.write('data', 36, 'latin1'); header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

// The clips of an archetype reference are joined with 0.4 s of silence, and each clip carries about 0.3 s of silent (exact zero) edges of its own, so the
// seam between two clips is about a second of zeros, longer than any pause inside a line (measured over all 178 references: 154 of them split into
// exactly the number of clips they were built from, the rest at most one off). A pause that long in a line splits it too: harmless, the longest piece is kept.
export const SINGLE_CLIP = Object.freeze({
  version: 1,           // part of the prepared slot's identity (oneClipHash): a change here prepares the clips again
  minGapSeconds: 0.9,   // a run of digital silence this long is a seam between clips
  minSeconds: 2,        // the longest clip is used only when it is at least this long (a shorter one is too little to clone from)
});

/**
 * The longest clip of a reference joined from several (a canonical PCM WAV of 16 bits or more), cut out at its seams and trimmed of its silent
 * edges, as a WAV; the first one of equal length, so the same file always gives the same clip. Null when there is nothing to choose
 * (one clip only, another file type, or the longest clip is under `minSeconds`): the reference is then used as it is.
 */
export function singleClip(bytes, {minGapSeconds = SINGLE_CLIP.minGapSeconds, minSeconds = SINGLE_CLIP.minSeconds} = {}) {
  const wav = pcmParts(bytes);
  if (!wav || wav.bits < 16) return null;
  const align = wav.channels * (wav.bits / 8), frames = Math.floor(wav.data.length / align), minGap = Math.round(minGapSeconds * wav.rate);
  if (!Number.isInteger(align) || frames <= minGap) return null;
  const clips = [];
  let start = -1, last = -1;
  for (let frame = 0; frame < frames; frame++) {
    const at = frame * align;
    let silent = true;
    for (let offset = 0; offset < align; offset++) if (wav.data[at + offset] !== 0) { silent = false; break; }
    if (silent) continue;
    if (start >= 0 && frame - last - 1 >= minGap) { clips.push([start, last + 1]); start = -1; }
    if (start < 0) start = frame;
    last = frame;
  }
  if (start >= 0) clips.push([start, last + 1]);
  if (clips.length < 2) return null;
  let best = clips[0];
  for (const clip of clips) if (clip[1] - clip[0] > best[1] - best[0]) best = clip;
  if ((best[1] - best[0]) / wav.rate < minSeconds) return null;
  return wavFile(wav, wav.data.subarray(best[0] * align, best[1] * align));
}
// The length of a WAV in seconds, to one decimal (for the log).
function wavSeconds(bytes) {
  const wav = pcmParts(bytes);
  return wav ? Math.round(wav.data.length / (wav.channels * (wav.bits / 8)) / wav.rate * 10) / 10 : 0;
}
// The identity of the prepared slot (bridge/voxtral-reference.mjs keys it by the source clip's hash) of a reference that was cut to one clip:
// not the registry's hash of the joined file, or a slot prepared from the joined file would be used in its place.
const oneClipHash = sha256 => createHash('sha256').update(`${sha256}|one-clip-${SINGLE_CLIP.version}`).digest('hex');

// ---- long replies -------------------------------------------------------------------------------------------------------------

/**
 * A long reply as [first sentence, the rest] so the first request is short and its audio starts sooner; anything else is [text].
 * The first part ends at the first sentence end (a full stop, ! ? or an ellipsis followed by a space, or a line break) that leaves at
 * least `firstPartMinChars` characters in it (a short "Hey V." joins the next sentence); when no sentence end comes before
 * `firstPartMaxChars`, at the last comma, semicolon, colon or dash before it. Short replies, and a split that would leave the rest
 * under `restMinChars`, stay one request.
 */
export function splitReply(text, {splitMinChars = VOXTRAL_LIMITS.splitMinChars, firstPartMinChars = VOXTRAL_LIMITS.firstPartMinChars,
    firstPartMaxChars = VOXTRAL_LIMITS.firstPartMaxChars, restMinChars = VOXTRAL_LIMITS.restMinChars} = {}) {
  if (typeof text !== 'string' || text.length < splitMinChars) return [text];
  const closers = '"\')]”’', ends = '.!?…';
  const spaceAt = at => at >= text.length || text[at] === ' ' || text[at] === '\t' || text[at] === '\n' || text[at] === '\r';
  let cut = -1;
  for (let at = 0; at < text.length && cut < 0; at++) {
    const char = text[at];
    if (char === '\n' && at + 1 >= firstPartMinChars) cut = at + 1;
    else if (ends.includes(char)) {
      let end = at + 1;
      while (end < text.length && (ends.includes(text[end]) || closers.includes(text[end]))) end++;
      if (spaceAt(end) && end >= firstPartMinChars) cut = end;
      at = end - 1;
    }
  }
  if (cut < 0 || cut > firstPartMaxChars * 2) {
    // No sentence end in reach: the last clause break before the maximum.
    cut = -1;
    for (let at = Math.min(firstPartMaxChars, text.length - 1); at >= firstPartMinChars; at--) {
      if (',;:'.includes(text[at - 1]) && text[at] === ' ') { cut = at + 1; break; }
    }
  }
  if (cut < firstPartMinChars) return [text];
  const first = text.slice(0, cut).trim(), rest = text.slice(cut).trim();
  return first && rest.length >= restMinChars ? [first, rest] : [text];
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
   * getKey: () => the Mistral key or null. referenceRoot: the folder 'runtime/voice-references/' maps to. playerRoot: the folder
   * 'runtime/player-voices/' maps to (the player's own clips, in the data folder; an absolute folder or null: a player entry then has no
   * reference). registry: a voice
   * registry ({profiles: {key: {reference, sha256}}}) or an ordered list of them (OmniVoice long, OmniVoice short, Pocket: the first
   * that has a usable clip for a voice wins); set later with setReferences. onChange: called when the voice becomes degraded or
   * recovers. fetchImpl, read, list, setTimer, clearTimer, now, endpoint: for tests.
   * fetchOptions: (url, fetchImpl) => Promise<extra fetch options>: the shared keep-alive pool of the text routes for api.mistral.ai with the
   * built-in fetch (bridge/mistral-client.mjs cloudFetchOptions), so a speech request uses the connections the composer's warm-up opened.
   */
  constructor({getKey, referenceRoot, playerRoot = null, registry, onChange = () => {}, onLog = () => {}, fetchImpl = globalThis.fetch,
    read = readFile, list = readdir, endpoint = VOXTRAL_ENDPOINT, limits = {}, setTimer = setTimeout, clearTimer = clearTimeout,
    now = () => performance.now(), clock = Date.now, scheduler = mistralScheduler, prepare, fetchOptions = cloudFetchOptions, languagePacks = null} = {}) {
    if (typeof getKey !== 'function') throw Error('Invalid Voxtral configuration');
    Object.assign(this, {getKey, referenceRoot, playerRoot, registries: [].concat(registry ?? []).filter(Boolean), onChange, onLog, fetchImpl, read, list, endpoint,
      setTimer, clearTimer, now, clock, scheduler, prepare, fetchOptions, languagePacks});
    this.limits = Object.freeze({...VOXTRAL_LIMITS, ...limits});
    this.gate = new RequestGate({limit: this.limits.maxConcurrent, aheadLimit: this.limits.maxAhead, tightLimit: this.limits.tightConcurrent,
      tightMs: this.limits.tightMs, now: clock, setTimer, clearTimer});
    this.references = new Map();      // voice key -> Promise<{base64, bytes, seconds}|null>
    // The API documents only MP3 and WAV references and also decodes Ogg (2026-10-13). If it ever refuses the Ogg one, the references are
    // prepared as MP3 from then on (`prepare(..., {safeFormat: true})`); the reply that met the refusal is written only.
    this.safeFormat = false;
    this.owner = randomBytes(16).toString('hex'); this.sequence = 0;
    // degraded: why the last attempt fell back (null: working or not tried). until: no request before this time (a limit or a refused key).
    this.degraded = null; this.until = 0; this.untilV = 0; this.spoke = 0; this.fellBack = 0;
    this.lastKey = undefined;         // the key the cool-down (until) belongs to
    // The model asked: Voxtral TTS 3 (22 languages), unless the account refused it and the older alias (9 languages) answered instead: the alias is then
    // asked for `modelRetryMs`, after which the v3 id is tried again (a refusal can be a plan change, a roll-out or a hiccup that looked like one).
    this.fallbackUntil = 0; this.fallbackLogged = false;
  }
  /** The model asked now (see fetchPart). */
  get model() { return this.clock() < this.fallbackUntil ? VOXTRAL_FALLBACK_MODEL : VOXTRAL_MODEL; }
  /** Does the voice speak `language` ('fr')? English always; the rest depends on the model in use (bridge/voxtral-languages.mjs). */
  speaks(language) { return voxtralSpeaks(language, this.model); }
  setReferences(registry) { this.registries = [].concat(registry ?? []).filter(Boolean); this.references.clear(); }
  /**
   * The registries again after a player changed some voices (bridge/voice-selection.mjs setVoices): only the cached references of `keys` are
   * dropped (they are read and encoded again from the registries' new entries the next time that voice speaks), every other voice keeps its own.
   * A reply already asking holds the reference it started with. Returns the keys that had a cached reference.
   */
  replaceReferences(registry, keys = []) {
    this.registries = [].concat(registry ?? []).filter(Boolean);
    return keys.filter(key => this.references.delete(key));
  }
  /** Has this voice's reference been read and encoded already (it was spoken, or warmed)? */
  hasCachedReference(key) { return this.references.has(key); }
  /** The key now. A refused-key or limit cool-down belongs to the key that earned it: a key saved in its place is tried at once. */
  #key() {
    const apiKey = this.getKey();
    if (apiKey !== this.lastKey) {
      if (this.lastKey !== undefined) this.until = this.untilV = 0;
      this.lastKey = apiKey;
    }
    return apiKey;
  }
  get hasKey() { return !!this.#key(); }
  /** Whether a request may be made now (a key, and not inside a limit or refused-key cool-down). */
  get ready() { return this.hasKey && this.clock() >= this.until; }
  /** The same for V's own line (lane 'v'): also not inside a limit that V's own requests earned. */
  get readyForV() { return this.ready && this.clock() >= this.untilV; }
  /** Milliseconds until a request of the companion's lane may be made again (0: now). */
  get cooldownMs() { return Math.max(0, this.until - this.clock()); }
  /** Does a registry name a reference clip for this voice key (without reading it)? Clips extracted for a character are found only when read. */
  hasReference(key) {
    return this.registries.some(registry => {
      const reference = registry?.profiles?.[key]?.reference;
      // A player's own clip can be read only when the player folder is known: without it the voice has no reference (written reply).
      return !!reference && (!isPlayerReference(reference) || !!this.playerRoot);
    });
  }
  log(message) { try { this.onLog(`[Voxtral] ${message}\n`); } catch { /* a log line never affects speech */ } }
  note(reason) {
    const changed = (this.degraded?.reason ?? null) !== (reason ?? null);
    this.degraded = reason ? {reason, at: this.clock()} : null;
    if (reason) this.fellBack++;
    if (changed) { try { this.onChange(this.degraded); } catch { /* observers never break speech */ } }
  }

  /**
   * The voice language pack's entry for this voice in a reply language (bridge/voice-language-packs.mjs), or null: English, no pack, a voice the pack lacks, or a
   * voice the player gave a clip of their own (their choice is not replaced).
   */
  languageEntry(key, language) {
    if (!language || language === 'en' || !this.languagePacks) return null;
    if (this.registries.some(registry => isPlayerReference(registry?.profiles?.[key]?.reference))) return null;
    return this.languagePacks.entry(language, key) ?? null;
  }
  /** The set (multilingual/<lang>/picked/<voice>) the reference of this voice in this language comes from, or null: the English reference speaks. */
  languageSet(key, language) { return this.languageEntry(key, language)?.set ?? null; }
  /** The packs' references are read again (a pack was installed, changed or removed while the service ran). */
  forgetLanguageReferences() { for (const id of [...this.references.keys()]) if (id.includes(LANGUAGE_SEPARATOR)) this.references.delete(id); }

  /**
   * The encoded reference of a voice, cached in memory (one read and one encoding per voice, per process). `language`: the reply's language code when it is
   * not English; a voice with a pack entry in that language is cloned from the pack's clip, and one without keeps the English reference. The cache is keyed by
   * the language as well, so the English and the Mandarin reference of one character never replace each other.
   */
  reference(key, language) {
    const entry = this.languageEntry(key, language);
    const id = entry ? `${entry.language}${LANGUAGE_SEPARATOR}${key}` : key;
    const cached = this.references.get(id);
    if (cached) {
      // Most recent last, so the oldest is the one dropped.
      this.references.delete(id); this.references.set(id, cached);
      return cached;
    }
    // A pack clip that cannot be used (missing, changed since the pack was checked, refused by the encoder) is spoken from the English reference, with one log line.
    const fromPack = () => this.buildFromPack(key, entry).catch(error => {
      this.log(`${key}: the ${entry.language} pack clip is not usable (${String(error?.message ?? error).slice(0, 80)}); using the English reference`);
      return null;
    }).then(found => found ?? this.build(key));
    const pending = (entry ? fromPack() : this.build(key)).catch(() => null);
    this.references.set(id, pending);
    // A reference that could not be built is tried again next time (the file may appear later).
    pending.then(value => { if (!value && this.references.get(id) === pending) this.references.delete(id); });
    while (this.references.size > this.limits.cachedReferences) this.references.delete(this.references.keys().next().value);
    return pending;
  }

  /**
   * The reference of a voice from a voice language pack entry: the clip (checked against the pack's hash when the manifest has one), cut and encoded like any
   * reference, the pack's own prepared slot (<pack>/prepared/<key>.json + .ogg) used when it fits (same signature) and made, and kept there, when it is missing.
   * An archetypes/ clip is an ordinary NPC's and speaks from one clip of the joined reference (singleClip), like the English archetype references. The release
   * builder of the packs calls this too, so the slots it ships are the ones read here. Returns {base64, bytes, source, format, ...} or null.
   */
  async buildFromPack(key, entry) {
    const bytes = await this.read(entry.path);
    if (bytes.length > this.limits.maxReferenceBytes * 4) return null;
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (entry.sha256 && sha256 !== entry.sha256) throw Error('the clip does not match the manifest');
    return this.finishReference(key, bytes, `language-pack:${entry.language}`, sha256, {ordinary: entry.kind === 'archetypes', slots: entry.preparedDirectory ?? null});
  }

  /**
   * A reference clip made small and encoded (the work `build` ends with). `sha256` names the source clip; `ordinary`: an ordinary NPC's clip, cut to one clip;
   * `player`: a player's own clip (its slot is kept in the player's data folder); `slots`: a folder the prepared slot is kept in instead of the shared one.
   */
  async finishReference(key, bytes, source, sha256, {player = false, ordinary = false, slots = null} = {}) {
    // An ordinary NPC speaks from one clip, the same one for every request of every reply (see the rule at the top of this file).
    if (ordinary) {
      const one = singleClip(bytes);
      if (one) {
        this.log(`${key}: cloned from one clip, ${wavSeconds(one)} s of the ${wavSeconds(bytes)} s reference`);
        bytes = one; sha256 = sha256 ? oneClipHash(sha256) : undefined;
      }
    }
    bytes = capWav(bytes, this.limits.maxReferenceSeconds);
    // `prepare` (bridge/voxtral-reference.mjs): a smaller clip to send instead (every request carries the reference, and the upload is
    // most of the first-audio wait). A clip it cannot make smaller is sent as it is.
    if (this.prepare) {
      try {
        const made = await this.prepare(bytes, {key, ...(sha256 ? {sha256} : {}), ...(player ? {player: true} : {}), ...(slots ? {slots} : {}), ...(this.safeFormat ? {safeFormat: true} : {})});
        if (made?.bytes?.length && made.bytes.length < bytes.length) {
          return {base64: made.bytes.toString('base64'), bytes: made.bytes.length, source, format: made.format, originalBytes: bytes.length, cached: made.cached === true};
        }
      } catch { /* the clip is sent as it is */ }
    }
    return bytes.length > this.limits.maxReferenceBytes ? null : {base64: bytes.toString('base64'), bytes: bytes.length, source, format: 'wav'};
  }

  /**
   * Builds the reference of a voice. Order: the registries in turn (OmniVoice long, OmniVoice short, Pocket), each entry's file
   * checked against its recorded hash; then any clips extracted for the character under runtime/voice-references/extracted/,
   * joined up to the working length. A voice with none of these has no reference (the reply is written only).
   * An entry that names the player's own clip (runtime/player-voices/<key>.wav) is read from `playerRoot` only, and `prepare` is told
   * `player: true` so the bridge keeps that clip's prepared slot in the player's data folder, never beside the shipped ones.
   */
  async build(key) {
    const finish = (bytes, source, sha256, player = false, ordinary = false) => this.finishReference(key, bytes, source, sha256, {player, ordinary});
    const root = this.referenceRoot ? resolve(this.referenceRoot) : null;
    const playerRoot = this.playerRoot ? resolve(this.playerRoot) : null;
    const within = (base, path) => path === base || path.startsWith(base + sep);
    const prefix = 'runtime/voice-references/';
    for (const [index, registry] of this.registries.entries()) {
      const entry = registry?.profiles?.[key];
      if (!entry?.reference) continue;
      // The player's own clip: one plain <key>.wav inside the player folder, and only there (a descriptor never chooses another path).
      const player = isPlayerReference(entry.reference);
      if (player ? !playerRoot || !playerReferenceValid(entry.reference) || !entry.sha256 : !root || !entry.reference.startsWith(prefix)) continue;
      const base = player ? playerRoot : root;
      const path = resolve(base, entry.reference.slice((player ? PLAYER_REFERENCE_PREFIX : prefix).length));
      if (!within(base, path)) continue;
      try {
        const bytes = await this.read(path);
        if (bytes.length > this.limits.maxReferenceBytes * 4) continue;
        // The registry carries the file's hash: a changed file is not the reference that was validated.
        if (entry.sha256 && createHash('sha256').update(bytes).digest('hex') !== entry.sha256) continue;
        const found = await finish(bytes, player ? 'player' : REFERENCE_SOURCES[index] ?? 'registry', entry.sha256 || undefined, player,
          !player && entry.reference.startsWith(AMBIENT_REFERENCES));
        if (found) return found;
      } catch { /* this entry's file is unusable: try the next source */ }
    }
    if (!root) return null;
    const inside = path => within(root, path);
    // A variant key (a second voice of an ambient profile) is a different voice from its profile: never borrow the profile's clips.
    if (isVariantKey(key) || !SAFE_VOICE_KEY.test(key)) return null;
    const directory = resolve(root, 'extracted', key);
    if (!inside(directory)) return null;
    let names;
    try { names = (await this.list(directory)).filter(name => typeof name === 'string' && name.toLowerCase().endsWith('.wav')).sort(); } catch { return null; }
    const clips = [];
    let seconds = 0;
    for (const name of names.slice(0, this.limits.extractedClips)) {
      try {
        const bytes = await this.read(resolve(directory, name));
        if (bytes.length > this.limits.maxReferenceBytes * 4) continue;
        clips.push(bytes);
        const wav = pcmParts(bytes);
        if (wav) seconds += wav.data.length / (wav.channels * (wav.bits / 8)) / wav.rate;
      } catch { /* an unreadable clip is skipped */ }
      if (seconds >= this.limits.extractedTargetSeconds) break; // enough to join: the rest are not read
    }
    const joined = joinWavs(clips, {targetSeconds: this.limits.extractedTargetSeconds, maxSeconds: this.limits.maxReferenceSeconds});
    return joined ? await finish(joined, 'extracted') : null;
  }

  /**
   * Speaks `text` as the voice `key`, handing `onPcm` 24 kHz mono float32 packets of Pocket's shape. Resolves with the
   * stream's summary. Throws a VoxtralError when nothing was delivered (the caller asks again or writes the reply, or, with `continuation`, ends the
   * reply), `cancelled` when `signal` aborts, and the consumer's own error (marked `sink`) when `onPcm` fails.
   * `firstAudioMs`: the wait for the first audio of this call when it is not the default (the voice selection asks again once with a
   * longer one after a first ask gave no audio, bridge/voice-selection.mjs).
   * `continuation: true`: this text is the rest of a reply whose first part was already heard in this voice. It gets the longer
   * limits and the second ask (`tail*` limits), and it is not held back by a limit cool-down that began after that first part.
   */
  async synthesizeStream(key, text, {signal, onPcm, continuation = false, firstAudioMs, ahead = false, language, lane = 'companion'} = {}) {
    throwIfCancelled(signal);
    if (typeof onPcm !== 'function') throw Error('Voxtral streaming requires a PCM consumer');
    const apiKey = this.#key();
    const fail = (kind, detail, extra) => new VoxtralError(kind, detail, {apiKey, ...extra});
    try {
      if (typeof text !== 'string' || !text.trim() || text.length > this.limits.maxChars
          || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) throw fail('text', 'cannot speak this text');
      if (!apiKey) throw fail('no-key', 'has no Mistral key');
      if (!continuation && this.clock() < (lane === 'v' ? Math.max(this.until, this.untilV) : this.until)) throw fail('limit', 'is waiting out a limit');
      const queued = this.now();
      const reference = await this.reference(key, language);
      throwIfCancelled(signal);
      if (!reference) throw fail('no-reference', 'has no reference clip for this voice');
      const {partFailure, ...result} = await this.stream({key, text, apiKey, reference, signal, onPcm, queued, fail, continuation, firstAudioMs, ahead, lane});
      this.spoke++;
      // The second request of a split reply can fail on its own: the reply ends after the part already spoken (result.truncated).
      if (partFailure) this.noteFailure(partFailure, 'the rest of the reply', apiKey, lane);
      else if (lane !== 'v') this.note(null);
      return result;
    } catch (error) {
      if (error instanceof VoxtralError) this.noteFailure(error, continuation ? 'the rest of the reply' : '', apiKey, lane);
      throw error;
    }
  }

  /** Records why Voxtral could not deliver (a limit or a refused key pauses requests) and says so in the log. */
  noteFailure(error, scope = '', apiKey = this.lastKey, lane = 'companion') {
    // The server's guardrail refused this one line: no pause (the next reply's voice is asked as usual), no degraded state (that would
    // publish an unavailable voice that is not the case) and one line, with no key wording. The written reply stands.
    if (error.kind === 'content') {
      this.log(scope ? `refused the rest of this reply (guardrail), the reply ends after the part already heard` : 'refused this line (guardrail); shown as text');
      return;
    }
    // A key saved while the request was in flight is another key: the old one's refusal or limit does not pause it.
    if (apiKey === this.lastKey) {
      // A limit that V's own request earned pauses V's lane only: the companion's reply on the same key is asked as usual (and earns its own pause if the key
      // really is limited). A refused key is the key's, whoever asked.
      if (error.kind === 'limit' && error.status === 429) {
        const until = this.clock() + (error.retryAfterMs ?? this.limits.limitCooldownMs);
        if (lane === 'v') this.untilV = Math.max(this.untilV, until); else this.until = until;
      }
      if (error.kind === 'key') this.until = this.clock() + (error.status === 403 ? this.limits.forbiddenCooldownMs : this.limits.keyCooldownMs);
    }
    // A voice without a reference, or text that cannot be spoken, is that reply's problem, not the service's.
    // V's own failures (lane 'v') are V's: they do not mark the companion's voice as degraded (its notice, its status line).
    if (error.kind !== 'text' && error.kind !== 'no-reference' && (lane !== 'v' || error.kind === 'key')) this.note(error.kind);
    // The message is already scrubbed of the key; its detail says which limit was hit (for example how long it waited).
    const detail = String(error.message ?? '').replace(/^Voxtral /, '').replace(/ \[voxtral:[a-z-]+\]$/, '');
    const why = `${error.kind}${error.status ? ` (HTTP ${error.status})` : ''}${detail ? ` - ${detail}` : ''}`;
    // The rest of a reply is never given to another voice: it fails, and the reply ends after the part that was heard.
    this.log(scope ? `${scope} could not be spoken, the reply ends after the part already heard (the voice is not switched): ${why}` : `could not speak this reply: ${why}`);
  }

  /**
   * One reply as one request, or (a long reply) as two requests sent together: its first sentence, for a fast first audio, and the
   * rest. The packets reach `onPcm` in order: the first part as it arrives, the second part held until the first one is done
   * and then released (at once if it is complete, else when the first part's audio is about to run out). The second part is asked
   * for again once if it fails before any audio, with longer limits; if it still fails the reply ends after the first part
   * (`truncated`, `partFailure` set): the rest is never spoken by another voice. Only the first part failing before any audio
   * throws, and then nothing was heard, so the caller may ask again.
   */
  async stream({key, text, apiKey, reference, signal, onPcm, queued, fail, continuation = false, firstAudioMs, ahead = false, lane = 'companion'}) {
    const parts = splitReply(text, this.limits);
    const id = ++this.sequence, started = this.now();
    let delivered = 0, chunks = 0, firstEmitAt = null, lastEmitAt = null, maxGapMs = 0;
    const emit = async samples => {
      // How steadily the service delivers: the longest wait between two packets of this line (a voice that breaks shows it here).
      const arrived = this.now();
      if (lastEmitAt !== null) maxGapMs = Math.max(maxGapMs, arrived - lastEmitAt);
      lastEmitAt = arrived;
      const packet = {version: 1, engine: 'pocket-tts', profile: key, owner: this.owner, id, index: chunks + 1,
        sampleRate: VOXTRAL_RATE, channels: 1, pcm: samples, format: 'f32le', offsetFrames: delivered,
        frames: samples.length, timebase: 'audio-seconds', startSeconds: delivered / VOXTRAL_RATE,
        modelSha256: MODEL_ID, timing: {voicePcmReceivedMs: this.now() - started}};
      try { await onPcm(packet); }
      catch (error) { error.sink = true; throw error; }
      delivered += samples.length; chunks++;
      firstEmitAt ??= this.now();
    };
    // Asked for again once (longer limits) when it is a rest of the reply: its first part, or an earlier part, was heard in this voice.
    // `firstAudioMs` (the caller asking again after a first ask gave no audio) replaces the default wait for the first audio.
    const part = (partText, partSignal, onSamples, again = continuation) => (again ? this.fetchPartAgain : firstAudioMs ? this.fetchPart : this.fetchHedged).call(this,
      {text: partText, apiKey, reference, signal: partSignal, fail, onSamples, ahead, lane, ...(firstAudioMs && !again ? {firstAudioMs} : {})});
    const summary = (first, extra = {}) => {
      const truncated = !first.done || !!extra.truncated;
      return {provider: 'voxtral', engine: 'voxtral', sampleRate: VOXTRAL_RATE, channels: 1, frames: delivered, chunks,
        duration: delivered / VOXTRAL_RATE, modelSha256: MODEL_ID, truncated,
        timing: {voiceProvider: 'pocket', voiceEngine: 'voxtral', voiceCloud: true, voiceWarm: true,
          voiceFirstPcmReceivedMs: first.firstMs, voiceGenerationMs: this.now() - started, voiceRoundTripMs: this.now() - started,
          voiceQueueMs: first.sentAt - queued, voiceReferenceBytes: reference.bytes, voiceReferenceSource: reference.source, voiceReferenceFormat: reference.format,
          voiceRequests: parts.length, voicePackets: chunks, voiceMaxGapMs: Math.round(maxGapMs), voiceAudioSeconds: Math.round(delivered / VOXTRAL_RATE * 100) / 100,
          ...(truncated ? {voiceTruncated: true} : {})}};
    };
    const logFirst = first => this.log(`first audio ${Math.round(first.firstMs)}ms, chars ${text.length}`
      + (parts.length > 1 ? ` (first request ${parts[0].length} chars, second ${parts[1].length})` : ''));

    if (parts.length === 1) {
      const first = await part(parts[0], signal, emit);
      if (!delivered) throw fail('request', 'answered without audio');
      logFirst(first);
      return summary(first);
    }

    // Two requests, started together. The second one's audio is held until the first one's has been handed on.
    const second = new AbortController();
    const relay = () => second.abort(cancelled());
    signal?.addEventListener('abort', relay, {once: true});
    if (signal?.aborted) relay();
    const held = [];
    let live = false, forwarded = 0, secondFailure = null, secondDone = false, secondFirstMs = null, secondCut = false, timer = null;
    // The first request is made first: the scheduler serves requests of one priority in the order they were asked.
    const firstTask = part(parts[0], signal, emit);
    firstTask.catch(() => {});
    const secondTask = part(parts[1], second.signal, async samples => {
      if (live) { forwarded++; await emit(samples); } else held.push(samples);
    }, true).then(result => { secondDone = true; secondFirstMs = result.firstMs; secondCut = !result.done; }, error => { secondFailure = error; });
    try {
      let first;
      try { first = await firstTask; }
      catch (error) { second.abort(cancelled()); await secondTask; throw error; }
      if (!delivered) { second.abort(cancelled()); await secondTask; throw fail('request', 'answered without audio'); }
      logFirst(first);
      if (!first.done) {
        // The first part ended early: its audio is cut here, and the rest would follow a gap in the sentence. Stop at this point.
        second.abort(cancelled()); await secondTask;
        return summary(first);
      }
      // Wait for the second part, but not past the moment the first part's audio would run out (a little before it).
      if (!secondDone && !secondFailure) {
        const remaining = Math.max(this.limits.splitGraceMs, delivered / VOXTRAL_RATE * 1000 - (this.now() - firstEmitAt) - this.limits.splitMarginMs);
        if (remaining > 0) {
          await Promise.race([secondTask, new Promise(finish => { timer = this.setTimer(finish, remaining); timer?.unref?.(); })]);
          this.clearTimer(timer);
        }
      }
      throwIfCancelled(signal);
      // Nothing of the second part may have arrived by now (the first part's audio is nearly over): the player waits in silence for
      // it rather than hearing another voice. It is asked for again once, then the reply ends (below).
      if (!secondFailure && secondDone && secondCut && !forwarded && !held.length) {
        // The second request ended before any of its audio could be handed on: nothing of the rest can be spoken.
        secondFailure = fail('network', 'ended the rest of the reply early');
      }
      if (!secondFailure) {
        // Whatever is held goes now; if the second part is still running, the rest follows as it arrives.
        while (held.length) { forwarded++; await emit(held.shift()); }
        live = true;
        await secondTask;
        throwIfCancelled(signal);
      }
      if (secondFailure) {
        if (secondFailure.sink || !(secondFailure instanceof VoxtralError)) throw secondFailure;
        // The reply ends where its audio stopped (after the first part, or inside the second): never another voice.
        const result = summary(first, {truncated: true});
        result.partFailure = secondFailure;
        return result;
      }
      if (secondFirstMs !== null) this.log(`second request first audio ${Math.round(secondFirstMs)}ms`);
      return summary(first, secondCut ? {truncated: true} : {});
    } finally {
      this.clearTimer(timer);
      signal?.removeEventListener('abort', relay);
      if (!second.signal.aborted) second.abort(cancelled('Voxtral reply completed'));
    }
  }

  /**
   * `fetchPart` for the rest of a reply: the first ask has `tailFirstAudioMs`, and when it fails before any audio (no audio in time, a
   * dropped connection, a server fault, an empty answer, a limit) it is asked once more with `tailRetryAudioMs`. A key that was
   * refused, a cancellation and the consumer's own error are not asked again. Nothing is handed on before audio exists, so a second ask
   * can never double anything.
   */
  async fetchPartAgain(args) {
    const asks = [this.limits.tailFirstAudioMs, this.limits.tailRetryAudioMs];
    for (let ask = 0; ; ask++) {
      try { return await this.fetchPart({...args, firstAudioMs: asks[ask], maxQueueMs: this.limits.tailMaxQueueMs}); }
      catch (error) {
        if (ask >= asks.length - 1 || args.signal?.aborted || !(error instanceof VoxtralError) || error.retried || !ASK_AGAIN.has(error.kind)) throw error;
        this.log(`the rest of the reply: ${error.kind}${error.status ? ` (HTTP ${error.status})` : ''}, asking again`);
      }
    }
  }

  /**
   * The first ask of a reply's first part, hedged: when it has given no audio `hedgeMs` after it was SENT (not queued: a wait behind the gate or the scheduler is not a
   * stall), the same text is asked a second time in parallel and the first audio of either wins (the winner's samples are the only ones handed on; the other request is
   * cancelled before it hands on a single one). A failure before the hedge is due is the first ask's own (its quick retries and the caller's second ask follow as ever);
   * once both are running the reply fails only when both have, and with the FIRST ask's error (the hedge is a secondary: its 429 or its retried flag never replaces it, and
   * a limit it earns holds the scheduler for a moment only, like V's). V's own lines (lane 'v') are not hedged: they would double the key's quota for a line that can wait.
   */
  fetchHedged(args) {
    const {hedgeMs} = this.limits;
    if (!(hedgeMs > 0) || args.signal?.aborted || args.lane === 'v') return this.fetchPart(args);
    return new Promise((resolve, reject) => {
      const own = [new AbortController(), new AbortController()], errors = [null, null];
      let winner = null, running = 1, done = false, armed = false, hedged = false, timer = null;
      const relay = () => own.forEach(controller => controller.abort(args.signal.reason ?? cancelled()));
      args.signal?.addEventListener('abort', relay, {once: true});
      const finish = settle => {
        if (done) return; done = true;
        this.clearTimer(timer); args.signal?.removeEventListener('abort', relay);
        for (const controller of own) if (!controller.signal.aborted) controller.abort(cancelled('Voxtral ask finished'));
        settle();
      };
      const guard = index => async samples => {
        if (winner === null) { winner = index; if (index === 1) this.log('the second ask of the line was first to give audio'); own[1 - index].abort(cancelled('the other ask of this line was first')); }
        if (winner !== index) throw cancelled();
        return args.onSamples(samples);
      };
      const run = index => {
        this.fetchPart({...args, signal: own[index].signal, onSamples: guard(index), secondary: index === 1,
          ...(index === 0 ? {onSent: () => arm()} : {})}).then(value => {
          if (winner === index || (winner === null && !done)) finish(() => resolve(value));
        }, error => {
          if (done || (winner !== null && winner !== index)) return;
          if (winner === index) { finish(() => reject(error)); return; }
          errors[index] = error; running--;
          // The hedge was not due yet, or both asks have failed: the first ask's own failure stands.
          if (running === 0) finish(() => reject(errors[0] ?? errors[1]));
        });
      };
      // Armed once, when the first ask is actually sent.
      const arm = () => {
        if (armed || done) return; armed = true;
        timer = this.setTimer(() => {
          timer = null;
          if (done || winner !== null || args.signal?.aborted) return;
          hedged = true; running++;
          this.log(`no audio ${hedgeMs} ms after the request was sent; the same line is asked a second time in parallel`);
          run(1);
        }, hedgeMs);
        timer?.unref?.();
      };
      run(0);
    });
  }

  /**
   * How long to wait before the one quick second ask after `error` (attempt 0 failed), or null for none. Only an answer the server gave
   * before any audio can be asked again, and only one that can be a hiccup: an HTTP 403 (if it is still there on the second ask it is
   * reported as a refused key), a 408, a 5xx, or a 429 whose Retry-After fits `retryBudgetMs` (none given: `retryWaitMs`). A 401 is a
   * refused key: never again. A guardrail refusal of the text ('content', also an HTTP 403) is never asked again: the same text is refused
   * the same way. The wait is at most `retryBudgetMs` (about a second), so a turn is never held longer than that for it.
   */
  retryWait(error, attempt) {
    if (attempt > 0 || !(error instanceof VoxtralError) || !error.status || error.kind === 'content') return null;
    const {status} = error, {retryWaitMs, retryBudgetMs} = this.limits;
    if (status === 429) { const wait = error.retryAfterMs ?? retryWaitMs; return wait <= retryBudgetMs ? wait : null; }
    return status === 403 || status === 408 || status >= 500 ? retryWaitMs : null;
  }

  /** Waits `ms` (cut short by `signal`, which throws the cancellation). */
  pauseFor(ms, signal) {
    return new Promise((resolve, reject) => {
      let timer;
      const onAbort = () => { this.clearTimer(timer); reject(signal.reason ?? cancelled()); };
      timer = this.setTimer(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
      timer?.unref?.();
      if (signal?.aborted) onAbort(); else signal?.addEventListener('abort', onAbort, {once: true});
    });
  }

  /**
   * One request, asked again once at once (after a short wait, see retryWait) when the server answered with a refusal that can be a hiccup.
   * Nothing has been handed on at that point, so a second ask can never double any audio. A failure that is still there after the
   * quick tries is thrown with `retried: true` (the voice selection does not ask a third time).
   */
  async fetchPart(args) {
    let model = this.model;
    for (let attempt = 0; ; attempt++) {
      try {
        const answer = await this.fetchOnce({...args, model});
        // The older model answered where the v3 id was refused: it is the model for a while (the log says so once).
        if (model === VOXTRAL_FALLBACK_MODEL && this.clock() >= this.fallbackUntil) {
          this.fallbackUntil = this.clock() + this.limits.modelRetryMs;
          if (!this.fallbackLogged) { this.fallbackLogged = true; this.log(`${VOXTRAL_MODEL} was refused for this key; using ${model} instead (fewer languages)`); }
        }
        return answer;
      } catch (error) {
        // The account refuses the v3 id (not the key, not a limit): the same request goes to the alias at once, and it becomes the model only if it
        // answers. A 403 has already had its quick second ask when it counts, so the alias is not asked twice for it.
        if (model === VOXTRAL_MODEL && !args.signal?.aborted && error instanceof VoxtralError && modelRefused(error, attempt)) {
          model = VOXTRAL_FALLBACK_MODEL; attempt = error.status === 403 ? 0 : -1;
          continue;
        }
        const wait = args.signal?.aborted ? null : this.retryWait(error, attempt);
        if (wait === null) { if (attempt > 0 && error instanceof VoxtralError) error.retried = true; throw error; }
        this.log(`${error.kind}${error.status ? ` (HTTP ${error.status})` : ''}, asking again in ${wait} ms`);
        await this.pauseFor(wait, args.signal);
      }
    }
  }

  /**
   * One request: sends `text`, reads the server-sent events and hands `onSamples` whole 100 ms frames of float32 audio, in order.
   * Resolves with {done, frames, firstMs (from the send to the first audio), sentAt}. Before any audio has been handed on every
   * failure throws a VoxtralError; after that a failure ends this request's audio where it stopped (done: false).
   * `ahead`: the held next speaker of a group round (it never takes the slots the speaker being heard needs, see bridge/request-gate.mjs).
   */
  async fetchOnce({text, model = this.model, apiKey, reference, signal, fail, onSamples, ahead = false, lane = 'companion', secondary = false, onSent, firstAudioMs = this.limits.firstAudioMs, maxQueueMs = this.limits.maxQueueMs}) {
    const controller = new AbortController();
    const onAbort = () => controller.abort(cancelled());
    signal?.addEventListener('abort', onAbort, {once: true});
    if (signal?.aborted) onAbort();
    let timer, timedOut = null, frames = 0, firstMs = null, sentAt = null;
    const arm = (ms, kind) => {
      this.clearTimer(timer);
      timer = this.setTimer(() => { timedOut = kind; controller.abort(Error(`voxtral ${kind}`)); }, ms);
      timer?.unref?.();
    };
    let carry = Buffer.alloc(0), pending = new Float32Array(0), response;
    // Whole 100 ms frames while audio arrives; the remainder waits for the next event or the end.
    const push = async (bytes, final) => {
      const joined = carry.length ? Buffer.concat([carry, bytes]) : bytes;
      const whole = joined.length - (joined.length % 4);
      carry = Buffer.from(joined.subarray(whole));
      if (whole) {
        firstMs ??= this.now() - sentAt;
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
        await onSamples(pending.slice(from, end));
        frames += end - from;
        from = end;
      }
      if (from) pending = pending.slice(from);
    };
    let release = null, events = null, finished = false;
    try {
      const gateStarted = this.now();
      try {
        // A burst of speech requests is kept small (a group round); the speaker being heard is never held back for the look-ahead.
        release = await this.gate.acquire({ahead, signal: controller.signal, maxQueueMs});
      } catch (error) {
        throwIfCancelled(signal);
        if (error?.code === 'queue-timeout') throw fail('timeout', 'waited too long behind other speech requests');
        throw fail('network', error?.message || 'is unreachable');
      }
      maxQueueMs = Math.max(1, maxQueueMs - (this.now() - gateStarted));
      // The connection pool the text routes keep warm for this host (nothing for a test's server or another fetch).
      let pooled = {};
      try { pooled = (await this.fetchOptions?.(this.endpoint, this.fetchImpl)) ?? {}; } catch { pooled = {}; }
      try {
        response = await this.scheduler.schedule(() => {
          // The first-audio limit counts from the moment the request is sent, not from when it queued behind other Mistral requests.
          sentAt = this.now();
          arm(firstAudioMs, 'timeout');
          try { onSent?.(); } catch { /* a hedge timer never affects the request */ }
          return this.fetchImpl(this.endpoint, {method: 'POST', signal: controller.signal, ...pooled,
            headers: {authorization: `Bearer ${apiKey}`, 'content-type': 'application/json', accept: 'text/event-stream'},
            body: JSON.stringify({model, input: text, ref_audio: reference.base64, response_format: 'pcm', stream: true})});
        }, {priority: PRIORITY.TTS, signal: controller.signal, maxQueueMs});
      } catch (error) {
        throwIfCancelled(signal);
        if (error?.code === 'queue-timeout') throw fail('timeout', 'waited too long behind other Mistral requests');
        throw timedOut ? fail('timeout', `gave no audio within ${firstAudioMs} ms`) : fail('network', error?.message || 'is unreachable');
      }
      this.scheduler.noteHeaders(response.headers);
      if (!response.ok) {
        const body = await response.text().catch(() => '');
        const failure = mapStatus(response.status, body, {headers: response.headers, apiKey});
        // A 429 holds every Mistral request (text included) for the server's retry-after; one that V's line earned holds them only briefly (vPauseCapMs).
        // The hedge's own request (a secondary) is held to the same short pause: it is the reply's second try, not its only one.
        if (failure.kind === 'limit') this.scheduler.pause(lane === 'v' || secondary ? Math.min(failure.retryAfterMs ?? this.limits.vPauseCapMs, this.limits.vPauseCapMs) : failure.retryAfterMs);
        // A refusal that can be a burst limit (a 403, a 429, a server fault): fewer speech requests at once for a while. A guardrail
        // refusal of this line's text is not one.
        if (!secondary && failure.kind !== 'content' && (failure.status === 403 || failure.status === 429 || failure.status >= 500)) this.gate.tighten();
        if (failure.status === 400 && reference.format === 'ogg' && !this.safeFormat && /audio|mp3|wav/i.test(body)) {
          this.safeFormat = true; this.references.clear();
          this.log('the Ogg reference was refused; the references are prepared as MP3 from now on');
        }
        throw failure;
      }
      if (!response.body) throw fail('request', 'answered without a stream');
      let done = false;
      // Read by hand (not `for await`): leaving a `for await` cancels the body, which closes the connection; after the last event the
      // rest of the body is read instead (drainRest), so the connection is reused.
      events = sseEvents(response.body)[Symbol.asyncIterator]();
      try {
        for (;;) {
          const step = await events.next();
          if (step.done) break;
          const raw = step.value;
          let event; try { event = JSON.parse(raw); } catch { continue; }
          if (event?.type === 'speech.audio.delta' && typeof event.audio_data === 'string') {
            await push(Buffer.from(event.audio_data, 'base64'), false);
            // Audio is flowing: the first-audio limit is over, a long silence is the next limit.
            if (frames) arm(this.limits.stallMs, 'stall');
          } else if (event?.type === 'speech.audio.done') { done = true; break; }
          else if (event?.type === 'error' || event?.error) throw fail('request', String(event.message ?? event.error?.message ?? 'reported an error'));
        }
        await push(Buffer.alloc(0), true);
      } catch (error) {
        throwIfCancelled(signal);
        if (error.sink || error instanceof VoxtralError && frames === 0) throw error;
        if (frames === 0) throw timedOut === 'timeout' ? fail('timeout', `gave no audio within ${firstAudioMs} ms`) : fail('network', error?.message || 'stream failed');
        // Audio is already playing: end this request's audio here, after the last whole sample received.
        this.log(`stream ended early after ${(frames / VOXTRAL_RATE).toFixed(1)} s: ${redact(error?.message, apiKey).slice(0, 80)}`);
        done = false;
        try { await push(Buffer.alloc(0), true); } catch (flushError) { if (flushError.sink) throw flushError; }
      }
      if (!frames) throw fail('request', 'answered without audio');
      finished = done;
      return {done, frames, firstMs, sentAt};
    } finally {
      this.clearTimer(timer);
      signal?.removeEventListener('abort', onAbort);
      // A stream that ended with its last event: the rest of the body is read in the background so the connection is reused. Any other
      // ending frees the connection at once, as before.
      if (finished && events && !controller.signal.aborted) this.drainRest(events, controller);
      else if (!controller.signal.aborted) controller.abort(cancelled('Voxtral request completed'));
      release?.();
    }
  }

  /**
   * Reads what is left of a finished stream (after `speech.audio.done`) for at most `drainMs`, then aborts the request if the body has not
   * ended by then (its connection is closed, as an abort always did). Runs in the background: nothing of the reply waits for it, and the
   * speech request's slot is already given back. Never throws.
   */
  drainRest(events, controller) {
    const timer = this.setTimer(() => { if (!controller.signal.aborted) controller.abort(cancelled('Voxtral request completed')); }, this.limits.drainMs);
    timer?.unref?.();
    void (async () => {
      try { while (!(await events.next()).done) { /* the bytes after the last event */ } }
      catch { /* aborted at the limit, or the stream failed: nothing to reuse */ }
      finally { this.clearTimer(timer); }
    })();
  }
}
