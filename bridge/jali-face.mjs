// Main-thread client for the game-trained facial model (jali-face-worker.mjs).
// Optional: if runtime/lipsync-model has no weights, every caller keeps its
// previous lip-sync path. A failed stream only removes model coverage; audio,
// subtitles and the envelope fallback continue. Playback PCM is never changed.
import {Worker} from 'node:worker_threads';
import {access} from 'node:fs/promises';
import {resolve} from 'node:path';
import {FaceModelFrames} from './jali-face-model.mjs';
import {throwIfCancelled, cancelled} from './transport-pool.mjs';
import {readPcmWav} from './speech-audio.mjs';

// Native controls written by model-driven timelines, in timeline order. The
// model's control table must match exactly (scripts/lipsync/lipsync_model.py).
export const JALI_TRACKS = Object.freeze([
  'jaw_mid_open', 'lips_together_up', 'lips_together_dn', 'lips_l_purse', 'lips_r_purse',
  'lips_l_funnel', 'lips_r_funnel', 'lips_l_corner_stretch', 'lips_r_corner_stretch',
  'lips_l_stretch', 'lips_r_stretch', 'lips_l_lower_raise', 'lips_r_lower_raise',
  'lips_l_upper_raise', 'lips_r_upper_raise', 'lips_suck_up', 'lips_suck_dn',
  'lips_puff_up', 'lips_puff_dn', 'cheek_l_puff', 'cheek_r_puff', 'tongue_mid_tip_up', 'tongue_mid_fwd',
]);
// Envelope fallback controls appended so one continuous timeline keeps a fixed track list.
export const JALI_TIMELINE_TRACKS = Object.freeze([...JALI_TRACKS, 'lips_apart_up', 'lips_apart_dn']);
export const JALI_SOURCE = 'local-jali';
export const JALI_ARTICULATION = 'jali-audio-v1';
// The Lua face samples a bounded ~35 ms behind the verified heard cursor
// (docs/LIPSYNC_DEEP_DIVE_2026-09-30.md). Read the model that far ahead so the
// rendered mouth keeps the game's own audio/animation alignment.
export const JALI_LEAD_SECONDS = .035;

export class JaliFace {
  static async load(directory, {WorkerImpl = Worker} = {}) {
    if (process.env.CYBERPUNK_CONVAI_FACE_MODEL === 'off') return null;
    const meta = resolve(directory, 'face-model.json'), weights = resolve(directory, 'face-model.bin');
    try { await access(meta); await access(weights); } catch { return null; }
    const face = new JaliFace(new WorkerImpl(new URL('./jali-face-worker.mjs', import.meta.url), {workerData: {meta, weights}}));
    try { await face.ready; } catch (error) { await face.worker.terminate(); throw error; }
    // An idle model must never keep the bridge process alive.
    face.worker.unref?.();
    return face;
  }
  constructor(worker) {
    this.worker = worker; this.sessions = new Map(); this.sequence = 0;
    this.ready = new Promise((done, fail) => {
      worker.once('error', fail);
      worker.once('exit', code => fail(Error(`Facial model worker exited (${code})`)));
      worker.on('message', message => {
        if (message.type === 'ready') {
          const names = message.controls.map(([, name]) => name);
          if (names.length !== JALI_TRACKS.length || names.some((name, index) => name !== JALI_TRACKS[index])) {
            fail(Error('Facial model controls do not match this bridge')); return;
          }
          this.info = message; done(this); return;
        }
        const session = this.sessions.get(message.id);
        if (session) session.receive(message);
      });
    });
    worker.on('error', () => this.failAll());
    worker.on('exit', () => { this.closed = true; this.failAll(); });
  }
  failAll() { for (const session of [...this.sessions.values()]) session.fail(Error('Facial model worker stopped')); }
  // Active analysis keeps the worker referenced; an idle model never keeps the process alive.
  release(id) { this.sessions.delete(id); if (!this.sessions.size) this.worker.unref?.(); }
  begin(sampleRate) {
    if (this.closed || !this.info) throw Error('Facial model is unavailable');
    const session = new JaliFaceSession(this, ++this.sequence, sampleRate);
    this.sessions.set(session.id, session); this.worker.ref?.();
    this.worker.postMessage({type: 'begin', id: session.id, sampleRate});
    return session;
  }
  // Whole phrase (Omni). Resolves with a finished FaceModelFrames.
  async analyse(pcm, sampleRate, {signal} = {}) {
    throwIfCancelled(signal);
    const session = this.begin(sampleRate);
    const cancel = () => session.close();
    signal?.addEventListener('abort', cancel, {once: true});
    try {
      for (let at = 0; at < pcm.length; at += sampleRate) session.push(pcm.subarray(at, Math.min(pcm.length, at + sampleRate)));
      session.finish();
      await session.done;
      throwIfCancelled(signal);
      return session.frames;
    } finally { signal?.removeEventListener('abort', cancel); session.close(); }
  }
  // A phrase WAV (base64). Reads a mono analysis copy; the WAV is unchanged.
  async analyseWav(audio, options) {
    const started = performance.now(), wav = readPcmWav(Buffer.from(audio, 'base64'));
    const frames = wav.data.length / wav.align, pcm = new Float32Array(frames), bytes = wav.bits / 8;
    for (let frame = 0; frame < frames; frame++) {
      let sum = 0;
      for (let channel = 0; channel < wav.channels; channel++) {
        const offset = frame * wav.align + channel * bytes;
        const raw = wav.codec === 3 ? wav.data.readFloatLE(offset) : wav.data.readIntLE(offset, bytes) / 2 ** (wav.bits - 1);
        sum += Number.isFinite(raw) ? Math.max(-1, Math.min(1, raw)) : 0;
      }
      pcm[frame] = sum / wav.channels;
    }
    const result = await this.analyse(pcm, wav.sampleRate, options);
    return {jaliFrames: result, timing: {lipAnalysisMs: performance.now() - started, lipEngine: JALI_ARTICULATION}};
  }
  close() { this.closed = true; this.sessions.clear(); return this.worker.terminate(); }
}

export class JaliFaceSession {
  constructor(owner, id, sampleRate) {
    Object.assign(this, {owner, id, sampleRate});
    this.frames = new FaceModelFrames(owner.info);
    this.onUpdate = () => {};
    this.done = new Promise((done, fail) => { this.resolve = done; this.reject = fail; });
    this.done.catch(() => {});
  }
  push(pcm) {
    if (this.closed || this.failed) return;
    const copy = Float32Array.from(pcm);
    this.owner.worker.postMessage({type: 'push', id: this.id, pcm: copy}, [copy.buffer]);
  }
  finish() { if (!this.closed && !this.failed) this.owner.worker.postMessage({type: 'finish', id: this.id}); }
  receive(message) {
    if (this.closed || this.failed) return;
    if (message.type === 'error') { this.fail(Error(message.error)); return; }
    try { this.frames.append(message.rows, {finished: message.finished, duration: message.duration}); }
    catch (error) { this.fail(error); return; }
    if (message.finished) { this.owner.release(this.id); this.resolve(this.frames); }
    try { this.onUpdate(this.frames); } catch { /* Diagnostics cannot stop voice. */ }
  }
  fail(error) {
    if (this.failed || this.closed) return;
    this.failed = error; this.owner.release(this.id); this.reject(error);
    try { this.onUpdate(this.frames); } catch { /* ignore */ }
  }
  close() {
    if (this.closed) return;
    this.closed = true; this.owner.release(this.id);
    if (!this.frames.finished) {
      try { this.owner.worker.postMessage({type: 'cancel', id: this.id}); } catch { /* worker gone */ }
      this.reject(cancelled('Facial model analysis cancelled'));
    }
  }
}

// Per-control bounds shared with mod/facial-playback.lua's validator: the
// ranges Cyberpunk's own dialogue lipsync writes (scripts/lipsync corpus).
export const JALI_LIMITS = Object.freeze({jaw_mid_open: .7, lips_together_up: 1, lips_together_dn: 1, lips_suck_dn: .8,
  lips_suck_up: .3, lips_puff_up: .45, lips_puff_dn: .45, cheek_l_puff: .35, cheek_r_puff: .35});
const limits = JALI_TIMELINE_TRACKS.map(track => JALI_LIMITS[track] ?? .5);

// Model weights at audio time `seconds`, in JALI_TIMELINE_TRACKS order and
// within the native bounds (apart controls are zero: the game's own lipsync
// never uses them).
export function jaliPose(frames, seconds) {
  return [...frames.sample(seconds), 0, 0].map((value, index) => Math.max(0, Math.min(limits[index], value)));
}
