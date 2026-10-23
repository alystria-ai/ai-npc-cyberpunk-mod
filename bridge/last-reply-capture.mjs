// Developer mode: keeps the audio of the last spoken reply and which reference voice spoke it, so a test can compare the speaker with the reference offline
// (the in-game check of the multilingual packs: the Mandarin reply must sound like the character, not like another one).
//
//   <state>/debug/last-reply-<engine>.wav    the reply, 24 kHz mono 16-bit (engine: omni | voxtral | pocket); every phrase of the reply, in order
//   <state>/debug/last-reply-<engine>.json   {version, engine, voiceKey, language, reference, referenceUsed, seconds, sampleRate, phrases, updated}
//                                            `reference` is the voice-routing line's ref (multilingual/zh-cn/picked/panam-palmer, or the English set);
//                                            no words of the reply, no ids
//
// It costs nothing while Developer mode is off: `begin` answers undefined, and the callers write `capture?.push(packet)`. Nothing is held in memory past one
// reply, and a reply is kept to MAX_SECONDS of audio. A file is overwritten by the next reply of that engine; the folder is never cleared by the bridge.
import {mkdir, rename, writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {decodeWav, encodeWav16} from './voxtral-reference.mjs';

export const CAPTURE_FOLDER = 'debug';
export const CAPTURE_ENGINES = Object.freeze(['omni', 'voxtral', 'pocket']);
export const MAX_SECONDS = 120;

class CapturedReply {
  constructor(owner, meta) {
    this.owner = owner; this.meta = {...meta}; this.chunks = []; this.rate = 24000; this.samples = 0; this.phrases = 0; this.closed = false;
  }
  /** Facts learned after the reply began (which reference really spoke). */
  note(facts) { Object.assign(this.meta, facts); }
  /** A packet of a PCM stream (Pocket's shape: {pcm: Float32Array, sampleRate}). */
  push(packet) {
    if (this.closed || !(packet?.pcm instanceof Float32Array) || !packet.pcm.length) return;
    this.rate = Number.isFinite(packet.sampleRate) ? packet.sampleRate : this.rate;
    this.add(packet.pcm);
  }
  /** One rendered phrase (OmniVoice): a WAV as bytes or base64. Written at once, so the file is whole whenever a test reads it. */
  addWav(wav) {
    if (this.closed) return;
    try {
      const {rate, samples} = decodeWav(Buffer.isBuffer(wav) ? wav : Buffer.from(String(wav), 'base64'));
      this.rate = rate; this.phrases++;
      this.add(samples[0]);
      this.finish();
    } catch { /* a phrase that cannot be read is not kept */ }
  }
  add(pcm) {
    if (this.samples + pcm.length > MAX_SECONDS * this.rate) return;
    this.chunks.push(Float32Array.from(pcm)); this.samples += pcm.length;
  }
  /** Writes what the reply holds so far. Safe to call again: the files are replaced whole. */
  finish() {
    if (!this.samples || this.written === this.samples) return Promise.resolve();
    this.written = this.samples;
    const all = new Float32Array(this.samples);
    let at = 0;
    for (const chunk of this.chunks) { all.set(chunk, at); at += chunk.length; }
    return this.owner.write(this.meta, encodeWav16(all, this.rate), this.rate, all.length);
  }
}

export class LastReplyCapture {
  /** directory: <state>/debug. log: one line per failure (never the audio). */
  constructor({directory, log = () => {}} = {}) {
    Object.assign(this, {directory, log});
    this.on = false; this.queue = Promise.resolve();
  }
  get enabled() { return this.on; }
  /** The settings poll: Developer mode on or off. Returns true when it changed. */
  update(settings) {
    // A settings file that could not be read for a moment changes nothing.
    if (!settings || typeof settings !== 'object') return false;
    const next = settings.developerMode === true;
    if (next === this.on) return false;
    this.on = next;
    return true;
  }
  /**
   * Starts the capture of a reply: {engine, voiceKey, language, reference, referenceUsed}. Undefined while Developer mode is off (or without a folder).
   * A reply of the same engine replaces the one before it.
   */
  begin({engine, voiceKey = null, language = null, reference = null, referenceUsed = null} = {}) {
    if (!this.on || !this.directory || !CAPTURE_ENGINES.includes(engine)) return undefined;
    return new CapturedReply(this, {engine, voiceKey, language: language ?? 'en', reference, referenceUsed});
  }
  write(meta, wav, rate, samples) {
    const base = resolve(this.directory, `last-reply-${meta.engine}`);
    const info = {version: 1, ...meta, seconds: Math.round(samples / rate * 100) / 100, sampleRate: rate, updated: new Date().toISOString()};
    this.queue = this.queue.catch(() => {}).then(async () => {
      await mkdir(this.directory, {recursive: true});
      // The audio first, then the note about it: a reader that finds the note finds the audio.
      for (const [name, bytes] of [[`${base}.wav`, wav], [`${base}.json`, JSON.stringify(info, null, 1) + '\n']]) {
        await writeFile(`${name}.tmp`, bytes);
        await rename(`${name}.tmp`, name);
      }
    }).catch(error => { try { this.log(`last reply not kept (${error?.code ?? error?.message})`); } catch {} });
    return this.queue;
  }
  /** Resolves when everything queued so far is written (tests, shutdown). */
  flush() { return this.queue; }
}
