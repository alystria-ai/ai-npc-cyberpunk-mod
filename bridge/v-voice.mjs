// V's voice for typed lines (docs/V_VOICE.md).
//
// With the setting on, what the player types to a companion is also spoken aloud in V's own voice, so the typed line sounds like
// V said it. The voice is cloned from a short reference clip cut from the game's own V lines (male or female V; assets/v-voice).
// Which engine speaks it is V's own setting (Settings > Voices > V's voice engine, runtime/settings.json `vVoiceEngine`), whatever voice
// the companions use:
//   - 'pocket' (the default): Pocket TTS on the CPU. When the companions use Pocket too, that worker speaks V (one job at a time). With any
//     other companion voice (OmniVoice, a cloud voice, the Convai voice) V has a Pocket worker of its own, loaded only for V
//     (bridge/v-helper-voice.mjs, VoiceSelection.tickVHelper).
//   - 'voxtral': the Mistral cloud voice, with the player's Mistral key. No local voice model is loaded for V (and none for the
//     companions either when they use a cloud voice).
//   - 'omni' (2026-10-21): OmniVoice, the GPU voice the companions already use, offered only while it is the companions' committed voice
//     (settings: the OmniVoice pack installed and the companion voice OmniVoice; otherwise the engine reads as Pocket, convai-bridge.mjs
//     settings poll). Nothing extra loads: no V Pocket worker, no second Omni worker. The player chose it knowing it adds a short wait
//     before the reply to a typed line, so V's line is WAITED FOR: it is never dropped for being slow (only a real failure drops it, with
//     the reason in the log), the companion's reply follows it. The overlap is kept: V's render is queued on the Omni worker the moment
//     the line is sent (it renders while the companion's text is written), the companion's own render queues right behind it.
// Never the Convai cloud voice (it cannot clone). A cloud voice never falls back to a local model: if V's cloud line fails, V is
// silent for that line (its subtitle is on screen) and the conversation is untouched.
//
// Latency comes first. The typed text goes to the companion's text model at once, exactly as without this feature; V's line is
// synthesized beside it and never in front of it. The bridge starts it at the top of the turn (convai-bridge.mjs runInput), before the
// knowledge and admission steps and the transport hand-over, because it needs only the typed text:
//   - V plays on a renderer page of its own (RealtimeHost.playVoiceLine); there is no game utterance behind it, so no face or lip sync
//     (V's subtitle is the game side's: mod/subtitles.lua showTyped shows the typed line as V's cinematic subtitle when it is sent)
//     and nothing in the game's single pending-request machinery changes.
//   - The companion's reply is ready when its first audio exists. If V's line is audible by then, the companion's audio waits (it
//     is buffered, silent and unpublished: ConvaiContinuousSpeech `hold`) until V has finished, so the two never overlap. If V's
//     line is not yet audible, the reply waits for its first audio for at most V_GRACE_MS (a short, fixed grace, the only wait on
//     V's synthesis); after that V is dropped and the reply goes on. Live 2026-10-19: V's first audio came 40 ms after the reply's
//     and the line was lost for that.
//   - A worker the companion's voice shares with V (the Pocket voice speaking both) works one job at a time. A V line still waiting for
//     its first audio when the companion's own text-to-speech request goes out is stopped, so it never stands in front of the reply's
//     voice. (A line that is already audible keeps going: the companion cannot be heard before it ends anyway.) A V line on its own
//     worker or on the cloud shares nothing with the companion, so nothing stops it. A V line on OmniVoice shares the worker but is in
//     FRONT of the companion's render in its queue, so it is not stopped either: it is the one thing the reply waits for.
//   - Any failure drops the line, writes one log line and never touches the conversation.
// V's line runs under a TurnClock of its own (the stage clock, bridge/turn-clock.mjs), so its marks never mix into the companion's.
import {createHash, randomBytes} from 'node:crypto';
import {readFile as readFileDefault} from 'node:fs/promises';
import {resolve} from 'node:path';
import {inspectReference} from './addons.mjs';
import {PcmEdges} from './pcm-edges.mjs';
import {readPcmWav} from './speech-audio.mjs';
import {voiceVolumeDb} from './dialogue-level.mjs';
import {TurnClock, withClock} from './turn-clock.mjs';

export const V_VOICE_KEYS = Object.freeze({male: 'v-male', female: 'v-female'});
/**
 * The hand-off to the companion (docs/perf, LATENCY.md). A companion reply held behind V's audible line is published to the game this
 * long before V's line ends (its sound stays held until the end), so the game's round trip (plugin poll, Lua probe, lease write: 120 to
 * 230 ms in the live records) runs during V's last moments instead of after them. 300 ms falls inside the 320 ms of silence V's line ends
 * with (bridge/pcm-edges.mjs tailMs), so the companion's caption replaces V's only after V's last word. CYBERPUNK_CONVAI_V_HANDOFF_MS
 * sets it (0: publish only when V has ended, as before).
 */
const requestedHandoff = Number(process.env.CYBERPUNK_CONVAI_V_HANDOFF_MS);
export const V_HANDOFF_LEAD_MS = Number.isFinite(requestedHandoff) && requestedHandoff >= 0 && requestedHandoff <= 2000 ? requestedHandoff : 300;
/**
 * How long a companion reply that is ready waits for V's first audio before V's line is dropped (docs/V_VOICE.md, "The grace"). It is the
 * only wait on V's synthesis. 600 ms is the renderer's own start buffer (400 ms) plus about one Pocket chunk: it covers a line whose
 * synthesis is nearly done when the reply is (live 2026-10-19: 40 ms late), while a voice that is seconds away (a cold one: 2.8 s) is not
 * waited for. CYBERPUNK_CONVAI_V_GRACE_MS sets it (0: V is dropped the moment the reply is ready, as before; at most 2000).
 */
const requestedGrace = Number(process.env.CYBERPUNK_CONVAI_V_GRACE_MS);
export const V_GRACE_MS = Number.isFinite(requestedGrace) && requestedGrace >= 0 && requestedGrace <= 2000 ? requestedGrace : 600;
/**
 * The most a rescued late line may add to the reply: the wait for its first audio plus the line itself (it no longer overlaps the model's
 * wait, so the reply follows V's end). A line whose estimated length (V_WORDS_PER_SECOND, plus the 160 ms lead-in and 320 ms tail of
 * bridge/pcm-edges.mjs) would push that past this is dropped at once, or waited for only as long as the budget allows: a long line that
 * missed the reply is not worth seconds of silence before the companion speaks. A line that is audible in time is not affected.
 */
export const V_RESCUE_BUDGET_MS = 4000;
export const V_WORDS_PER_SECOND = 2.8;
const V_EDGES_MS = 480;
export const V_MANIFEST = 'v-voice.json';
/** The longest line V speaks; a longer one is cut at the last sentence or word that fits. */
export const V_MAX_CHARS = 240;
const GENDERS = Object.keys(V_VOICE_KEYS);
/** The engines V's line can be asked of (runtime/settings.json `vVoiceEngine`); Pocket is the default. */
export const V_ENGINES = Object.freeze(['pocket', 'voxtral', 'omni']);
const SAMPLE_RATE = 24000;
const PACKET_FRAMES = 48000;

/**
 * The settings V's engine is read from: a saved engine that cannot speak right now counts as Pocket, as the settings row shows it (the saved
 * value is left alone, so the engine is back the moment it can speak). `cloudUsable`: a Mistral key is saved and Mature content is off (Voxtral).
 * `omniUsable`: the companions' chosen voice is OmniVoice and its pack is installed (a second big GPU model is never loaded for V); an Omni
 * worker that is only loading or failing does not count here, so V stays on OmniVoice (its line is skipped with the reason) and no Pocket
 * worker loads beside it.
 */
export function vSettingsFor(settings, {cloudUsable = false, omniUsable = false} = {}) {
  const engine = settings?.vVoiceEngine;
  if ((engine === 'voxtral' && !cloudUsable) || (engine === 'omni' && !omniUsable)) return {...settings, vVoiceEngine: 'pocket'};
  return settings;
}
const FILE = /^[a-z0-9][a-z0-9._-]{0,63}\.wav$/;
const SHA = /^[a-f0-9]{64}$/;

// ---- The reference clips ----------------------------------------------------------------------------------------------------

/**
 * Finds the V reference clips in the first folder that holds a manifest (assets/v-voice.json: {version: 1, voices: {male|female:
 * {file, transcript, sha256, seconds}}}). A clip that is missing, unreadable or does not match its sha256 is left out; the other
 * gender still loads. Returns {directory, voices: {male?, female?}} where each voice is {key, gender, reference (absolute .wav
 * path), sha256, transcript, seconds}. Nothing found is an empty result, never an error.
 */
export async function loadVVoiceReferences(directories, {files = {readFile: readFileDefault}, log = () => {}} = {}) {
  for (const directory of directories.filter(Boolean)) {
    let manifest;
    try { manifest = JSON.parse(String(await files.readFile(resolve(directory, V_MANIFEST), 'utf8')).replace(/^﻿/, '')); }
    catch (error) {
      if (error?.code !== 'ENOENT') log(`${V_MANIFEST} in ${directory} is unreadable: ${String(error?.message ?? error).slice(0, 120)}`);
      continue;
    }
    const voices = {};
    for (const gender of GENDERS) {
      const row = manifest?.voices?.[gender];
      if (!row) continue;
      try {
        if (typeof row.file !== 'string' || !FILE.test(row.file)) throw Error('invalid file name');
        if (typeof row.transcript !== 'string' || !row.transcript.trim() || row.transcript.length > 2000) throw Error('invalid transcript');
        if (typeof row.sha256 !== 'string' || !SHA.test(row.sha256)) throw Error('invalid sha256');
        const reference = resolve(directory, row.file);
        const {sha256, duration} = inspectReference(await files.readFile(reference));
        if (sha256 !== row.sha256) throw Error('the clip does not match its sha256');
        voices[gender] = {key: V_VOICE_KEYS[gender], gender, reference, sha256, transcript: row.transcript.trim(), seconds: duration};
      } catch (error) {
        if (error?.code !== 'ENOENT') log(`${gender} clip not used: ${String(error?.message ?? error).slice(0, 120)}`);
      }
    }
    if (Object.keys(voices).length) return {directory, voices};
  }
  return {directory: null, voices: {}};
}

/** The voices as AddonHost.voiceConfigPaths takes them (`extra`): merged into the voice configurations like an add-on's voice. */
export const extraVoices = references => Object.values(references?.voices ?? {})
  .map(({key, reference, sha256, transcript}) => ({key, reference, sha256, transcript}));

// ---- V's gender, the line, and the audio --------------------------------------------------------------------------------------

/**
 * 'male' or 'female' for V's voice: V's voice tone from the character creator (`voice`, which the game's own V lines follow), else
 * the resolved gender when the tone could not be read; null when neither is known.
 */
export function vGenderOf(turnContext) {
  const value = turnContext?.voice ?? turnContext?.gender;
  return value === 'male' || value === 'female' ? value : null;
}

/**
 * The line V speaks: the typed text on one line, no control characters, cut at V_MAX_CHARS on a sentence end (else a word end). Null
 * when nothing speakable is left (no letter or digit).
 */
export function vLineText(text, maxChars = V_MAX_CHARS) {
  if (typeof text !== 'string') return null;
  let line = text.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!/[\p{L}\p{N}]/u.test(line)) return null;
  if (line.length > maxChars) {
    const head = line.slice(0, maxChars);
    const sentence = Math.max(head.lastIndexOf('. '), head.lastIndexOf('! '), head.lastIndexOf('? '));
    const word = head.lastIndexOf(' ');
    line = (sentence >= maxChars / 3 ? head.slice(0, sentence + 1) : word >= maxChars / 3 ? head.slice(0, word) : head).trim();
  }
  return /[\p{L}\p{N}]/u.test(line) ? line : null;
}

/**
 * A rendered WAV (OmniVoice) as the packets the local PCM renderer takes (24 kHz mono f32le, in order, at most 48000 frames each).
 * Any other sample rate is resampled linearly and several channels are averaged. Plays nothing.
 */
export function wavToPackets(bytes, {profile, owner = randomBytes(16).toString('hex'), id = 1} = {}) {
  const wav = readPcmWav(bytes), {data, channels, bits, codec, sampleRate} = wav;
  const frames = data.length / wav.align, mono = new Float32Array(frames);
  const sample = (frame, channel) => {
    const at = (frame * channels + channel) * (bits / 8);
    if (codec === 3) return data.readFloatLE(at);
    if (bits === 16) return data.readInt16LE(at) / 32768;
    if (bits === 24) return data.readIntLE(at, 3) / 8388608;
    return data.readInt32LE(at) / 2147483648;
  };
  for (let frame = 0; frame < frames; frame++) {
    let sum = 0;
    for (let channel = 0; channel < channels; channel++) sum += sample(frame, channel);
    mono[frame] = Math.max(-1, Math.min(1, sum / channels));
  }
  let pcm = mono;
  if (sampleRate !== SAMPLE_RATE) {
    const length = Math.max(1, Math.round(frames * SAMPLE_RATE / sampleRate));
    pcm = new Float32Array(length);
    const ratio = sampleRate / SAMPLE_RATE;
    for (let at = 0; at < length; at++) {
      const position = at * ratio, low = Math.floor(position), high = Math.min(frames - 1, low + 1), blend = position - low;
      pcm[at] = mono[Math.min(frames - 1, low)] * (1 - blend) + mono[high] * blend;
    }
  }
  const modelSha256 = createHash('sha256').update(bytes).digest('hex');
  const packets = [];
  for (let offset = 0, index = 1; offset < pcm.length; offset += PACKET_FRAMES, index++) {
    const part = pcm.slice(offset, offset + PACKET_FRAMES);
    packets.push({version: 1, engine: 'pocket-tts', owner, id, profile, modelSha256, sampleRate: SAMPLE_RATE, channels: 1,
      format: 'f32le', index, offsetFrames: offset, frames: part.length, pcm: part});
  }
  return {packets, frames: pcm.length};
}

// ---- One line --------------------------------------------------------------------------------------------------------------

/**
 * States: 'synth' (asked for, nothing audible yet), 'playing' (the renderer holds audio: the line is audible), 'done' (it ended),
 * 'dropped' (not spoken: too slow, stopped or failed). `clear` resolves when the line is no longer audible or pending.
 */
export class VLine {
  constructor({input, key, text, plan, volume, play, stream, render, local = true, clock = new TurnClock(), signal, log = () => {}, reference = null,
    after, edges, token = 'v-' + randomBytes(8).toString('hex'), onSettled = () => {}, onAudible = () => {}, onGrace = () => {},
    graceMs = V_GRACE_MS, rescueMs = V_RESCUE_BUDGET_MS, patient = false, now = () => performance.now()}) {
    // `patient`: the player chose an engine that is waited for (OmniVoice). There is no grace and no budget: the reply waits for V's first
    // audio for as long as the render takes, and only a failure or the end of the turn drops the line.
    Object.assign(this, {input, key, text, plan, volume, playHost: play, streamVoice: stream, renderVoice: render, local, clock, log, reference,
      after, edges, token, onSettled, onAudible, onGrace, graceMs, rescueMs, patient, now});
    // The grace (V_GRACE_MS): started once, by the first time the reply asks while V is not audible yet.
    this.graceTimer = null; this.graceStarted = false; this.graceAt = 0; this.waitedMs = 0;
    this.state = 'synth';
    // How much of the line is left to be heard, from the renderer's last clock (Infinity until its whole audio is known).
    this.remainingMs = Infinity; this.remainingAt = 0; this.nearListeners = []; this.nearSignalled = false; this.nearReached = false;
    this.reason = null;
    this.controller = new AbortController();
    this.watchers = [];
    this.clear = new Promise(resolveClear => { this.resolveClear = resolveClear; });
    // The turn that owns this line ending (a newer message, a stop) stops it.
    if (signal) {
      const cancel = () => this.drop('turn-ended');
      if (signal.aborted) cancel(); else signal.addEventListener('abort', cancel, {once: true});
    }
    this.finished = this.state === 'dropped' ? Promise.resolve() : this.run();
  }

  get blocking() { return this.state === 'playing'; }
  /** The reply is ready, V is not audible yet and the grace is running: the reply waits for V's first audio (never longer than graceMs). */
  get waiting() { return this.state === 'synth' && (this.patient || this.graceTimer !== null); }
  get settled() { return this.state === 'done' || this.state === 'dropped'; }

  /** Calls `fn` once when the line stops being audible or pending (at once if it already has). */
  whenClear(fn) { this.clear.then(fn, () => {}); }

  /**
   * The companion's audio is ready: may it start? True while V is audible (the audio waits), and for the grace (graceMs, counted from
   * the first ask) while V's first audio is still being made. A line that is not audible when the grace is over is dropped, so the
   * reply waits for V's synthesis for no longer than that. Safe to call on every poll.
   */
  holds() {
    if (this.state === 'synth') this.startGrace();
    return this.state === 'playing' || this.waiting;
  }

  /** The reply asked while V is not audible: start the one grace (or drop at once when it is 0). Later asks change nothing. */
  startGrace() {
    if (this.state !== 'synth' || this.graceStarted || this.patient) return;
    this.graceStarted = true;
    // The wait is what the budget leaves after the line's own length; no room (a long line) is no wait.
    const lineMs = this.text.split(/\s+/).filter(Boolean).length / V_WORDS_PER_SECOND * 1000 + V_EDGES_MS;
    const wait = Math.min(this.graceMs, this.rescueMs - lineMs);
    if (!(wait >= 50)) { this.drop('slower-than-reply'); return; }
    this.graceAt = this.now();
    this.clock.mark('graceStart');
    try { this.onGrace(); } catch { /* a report never affects speech */ }
    this.graceTimer = setTimeout(() => { this.endGrace(); this.drop('slower-than-reply'); }, wait);
    this.graceTimer.unref?.();
  }

  endGrace() {
    if (this.graceTimer === null) return;
    clearTimeout(this.graceTimer); this.graceTimer = null;
    this.waitedMs = Math.round(this.now() - this.graceAt);
  }

  /**
   * V's audible line ends within `leadMs` (by the renderer's clock, counted on since its last report). Once true it stays true while the
   * line plays: a later clock report a few ms off never takes back a reply that was already published.
   */
  nearEnd(leadMs = V_HANDOFF_LEAD_MS) {
    if (this.state !== 'playing') return false;
    if (this.nearReached) return true;
    if (this.remainingMs - (this.now() - this.remainingAt) > leadMs) return false;
    this.nearReached = true;
    return true;
  }

  /**
   * May a continuous companion reply be published to the game now (its sound is still held while V is audible: `blocking`)? Like
   * holds(), a line that is not audible yet is dropped here. False from `leadMs` before V's end on, so the game's round trip overlaps V's
   * last moments. Safe to call on every poll.
   */
  holdsPublish(leadMs = V_HANDOFF_LEAD_MS) {
    if (this.state === 'synth') this.startGrace();
    return this.holdsPublishPeek(leadMs);
  }

  /** holdsPublish() without its side effect. */
  holdsPublishPeek(leadMs = V_HANDOFF_LEAD_MS) {
    return this.waiting || (this.state === 'playing' && !this.nearEnd(leadMs));
  }

  /** Calls `fn` once when V's line comes within the hand-off lead of its end, or stops being audible or pending (at once if it has). */
  whenNearEnd(fn) {
    if (this.nearSignalled || this.settled) { try { fn(); } catch { /* a listener never fails V */ } return; }
    this.nearListeners.push(fn);
  }

  signalNear() {
    if (this.nearSignalled) return;
    this.nearSignalled = true;
    for (const fn of this.nearListeners.splice(0)) { try { fn(); } catch { /* a listener never fails V */ } }
  }

  /** The same decision for a reply that is published as a whole (OmniVoice): resolves when V is out of the way. Never rejects. */
  async waitClear(signal) {
    if (!this.holds()) return;
    await new Promise(resolveWait => {
      const done = () => { signal?.removeEventListener('abort', done); resolveWait(); };
      this.whenClear(done);
      signal?.addEventListener('abort', done, {once: true});
      if (signal?.aborted) done();
    });
  }

  /** The companion's text-to-speech request went out: a local voice must not have V's unfinished line in front of its own. */
  companionVoiceStarted() { if (this.local && this.state === 'synth') this.drop('reply-voice-started'); }

  drop(reason) {
    if (this.settled) return;
    this.endGrace();
    this.state = 'dropped'; this.reason = reason;
    this.clock.mark('dropped');
    this.controller.abort();
    this.settle();
  }

  settle() {
    this.resolveClear();
    this.signalNear();
    try { this.onSettled(this.summary()); } catch { /* a report never affects speech */ }
  }

  summary() {
    const snapshot = this.clock.snapshot();
    return {result: this.state === 'done' ? 'played' : this.state === 'dropped' ? 'dropped' : this.state,
      ...(this.reason ? {reason: this.reason} : {}), ...(this.graceStarted ? {waitedMs: this.waitedMs} : {}), engine: this.plan.helper ? 'pocket-helper' : this.plan.engine, voice: this.key, ...(this.reference ? {reference: this.reference} : {}), chars: this.text.length,
      marks: snapshot.marks, totalMs: snapshot.totalMs};
  }

  onFrame(snapshot) {
    if (this.state === 'synth' && snapshot?.receivedFrames > 0) {
      this.endGrace();
      this.state = 'playing';
      this.clock.mark('audible');
      try { this.onAudible(); } catch { /* a report never affects speech */ }
    }
    // The time left to hear, once the whole line is in the renderer (its silent tail included).
    if (snapshot?.sourceComplete === true && Number.isFinite(snapshot.positionSeconds) && snapshot.receivedFrames > 0) {
      const rate = Number.isFinite(snapshot.sampleRate) && snapshot.sampleRate > 0 ? snapshot.sampleRate : 24000;
      this.remainingMs = Math.max(0, snapshot.receivedFrames / rate - snapshot.positionSeconds) * 1000; this.remainingAt = this.now();
      if (this.state === 'playing' && this.nearEnd()) this.signalNear();
    }
    if (snapshot?.ended && this.state === 'playing') {
      // The audible end: the companion may start now. The page is still being released; nothing waits for that.
      this.state = 'done';
      this.clock.mark('ended');
      this.settle();
    }
    // The renderer is told what the game's dialogue volume is; nothing else is asked of the game. The Voice volume setting rides in
    // makeupDb, left out at 100% so the control is then exactly the previous one; V has no dialogue-level makeup of its own.
    const makeupDb = voiceVolumeDb();
    return {allow: true, paused: false, volume: this.volume, pan: 0, ...(makeupDb ? {makeupDb} : {})};
  }

  run() {
    return withClock(this.clock, async () => {
      this.clock.mark('voiceStart');
      try {
        // A line still being released by the one before it (a quick second message): wait for it, never overlap it.
        if (this.after) {
          let timer;
          await Promise.race([this.after.catch(() => {}), new Promise(resolveWait => { timer = setTimeout(resolveWait, 3000); timer.unref?.(); })]);
          clearTimeout(timer);
        }
        if (this.settled) return;
        const signal = this.controller.signal;
        const producer = this.plan.engine === 'omni' ? this.omniProducer(signal) : this.streamProducer();
        await this.playHost({token: this.token, text: this.text}, producer,
          {signal, current: () => !this.settled || this.state === 'done', onFrame: snapshot => this.onFrame(snapshot)});
        if (this.state === 'playing') { this.state = 'done'; this.clock.mark('ended'); this.settle(); }
        else if (this.state === 'synth') this.drop('no-audio');
      } catch (error) {
        if (this.state !== 'dropped' && this.state !== 'done') {
          this.log(`V's line was not spoken (${String(error?.message ?? error).slice(0, 120)})`);
          this.drop('failed');
        }
      }
    });
  }

  /**
   * V's line on OmniVoice: one render of the whole line on the GPU worker (no streaming), then its packets, with the same air at both
   * ends as a streamed line. The render is asked for here, when the line is built, not when the renderer page is ready (a cold browser
   * would otherwise start it up to a second late): it is queued on the worker at once, behind what the worker is doing and ahead of the
   * companion's. `signal` ends a job that has not started yet; one that has started finishes on the worker and is discarded.
   */
  omniProducer(signal) {
    this.clock.mark('ttsSent');
    const language = this.plan.language && this.plan.language !== 'en' ? this.plan.language : undefined;
    const rendering = Promise.resolve().then(() => this.renderVoice(this.key, this.text, {signal, ...(language ? {language} : {})}));
    rendering.catch(() => {});
    return async emit => {
      const generated = await rendering;
      this.clock.mark('firstPcm');
      if (typeof generated?.audio !== 'string') throw Error('OmniVoice returned no audio');
      const {packets} = wavToPackets(Buffer.from(generated.audio, 'base64'), {profile: this.key});
      const edges = new PcmEdges(emit, this.edges);
      for (const packet of packets) await edges.push(packet);
      await edges.finish();
      this.clock.mark('synthDone');
      return {};
    };
  }

  streamProducer() {
    return async (emit, {signal}) => {
      this.clock.mark('ttsSent');
      let first = true;
      // Air at both ends: a short lead-in and fade, a faded end and a silent tail (bridge/pcm-edges.mjs).
      const edges = new PcmEdges(emit, this.edges);
      const response = await this.streamVoice(this.key, this.text, {signal, onPcm: packet => {
        if (first) { first = false; this.clock.mark('firstPcm'); }
        return edges.push(packet);
      }});
      await edges.finish();
      this.clock.mark('synthDone');
      return response ?? {};
    };
  }
}

// ---- The feature -----------------------------------------------------------------------------------------------------------

export class VVoice {
  /**
   * voices   {male?, female?}: what loadVVoiceReferences found (only the keys matter here)
   * planFor  (input, key) => {engine: 'pocket' | 'voxtral' | 'omni', language}: V's engine (the player's choice) and the turn's language
   * ready    key => boolean: the Pocket voice is the companions' committed voice, loaded and routed, and has that voice (it speaks V)
   * stream / play / prepare / warm   the Pocket voice and renderer calls (convai-bridge.mjs wires the real ones)
   * isLocal  () => boolean: that Pocket worker is shared with the companion (one job at a time)
   * helper   {speaks(key), ready(key), stream, prepare} or null: the Pocket worker that is V's alone (bridge/v-helper-voice.mjs). It speaks
   *          V whenever the companions' voice is not the Pocket worker itself (OmniVoice, a cloud voice, the Convai voice); `speaks` says
   *          whether it is the one in charge for this key, `ready` whether it is loaded.
   * cloud    {problem(key), stream(key, text, options), warm(key), speaks(language)} or null: the Voxtral cloud voice. `problem` is null when it
   *          can speak V's line now, else a short reason (no key, no clip, a limit cooling down); `warm` prepares V's reference clip; `speaks`
   *          says whether its model speaks a language other than English (a line in such a language is spoken, any other is skipped).
   * omni    {problem(key), render(key, text, {signal, language}), prepare(key, {signal})} or null: V's line on the OmniVoice worker the companions
   *          use (only while it is their committed voice). `problem` is null when it can render now, else a short reason (the companions are not on
   *          OmniVoice, the worker is not loaded, playback is off); `render` resolves to {audio: base64 WAV}, queued on the worker behind what it
   *          is doing and ahead of anything asked later; `prepare` is the voice's hidden warm-up render.
   * referenceLabel  gender => 'manual' | 'mod:<archive file name>' | 'shipped': which reference V's voice is cloned from now (the player's own clip, a V voice
   *          mod's, or the shipped one); it goes to each line's summary and log line. Without it the voice's own `source` (or 'shipped').
   * remember {gender, save(gender)} or null: V's gender kept between sessions (the bridge keeps it in the state folder). It lets the
   *          voice that will speak be prepared before the first typed line of a session, when the game has not said yet who V is.
   * graceMs  how long a ready reply waits for V's first audio (V_GRACE_MS)
   */
  constructor({voices = {}, planFor, ready, stream, play, prepare, warm, isLocal = () => true, helper = null, cloud = null, omni = null, log = () => {}, report = () => {},
    remember = null, graceMs = V_GRACE_MS, referenceLabel = null} = {}) {
    Object.assign(this, {voices, planFor, ready, stream, play, prepare, warm, isLocal, helper, cloud, omni, log, report, remember, graceMs, referenceLabel});
    this.enabled = false;
    this.engine = 'pocket';
    this.lastGender = null;
    try { const known = remember?.gender; if (GENDERS.includes(known)) this.lastGender = known; } catch { /* a missing memory is just a first session */ }
    this.previous = null;
    this.logged = new Set();
    // What happened to V's lines this session (the support report reads the log): counts only, no text.
    this.tally = {played: 0, dropped: 0, reasons: {}, skipped: {}};
  }

  /**
   * The setting (runtime/settings.json "vVoice", "vVoiceEngine"). On unless the player turned it off: a file that never stored it, or a
   * saved false the player never chose, counts as on. The engine is 'voxtral' or 'omni' only when that is what is stored; anything else is Pocket,
   * the default. (The bridge's settings poll has already turned a stored 'omni' into 'pocket' when the companions are not on OmniVoice, and a
   * stored 'voxtral' when there is no key: this class takes the engine it is given.) Returns whether either changed.
   */
  update(settings) {
    if (!settings || typeof settings !== 'object') return false;
    // A saved false counts only when the player set it (vVoiceChosen, mod/manager.lua): the first version saved false as its default.
    const next = settings.vVoice !== false || settings.vVoiceChosen !== true;
    const engine = V_ENGINES.includes(settings.vVoiceEngine) ? settings.vVoiceEngine : 'pocket';
    if (next === this.enabled && engine === this.engine) return false;
    this.enabled = next;
    if (engine !== this.engine) { this.engine = engine; this.logged.clear(); }
    return true;
  }

  /**
   * Every typed turn tells which V is playing (the turn context's gender), whether or not the setting is on, so the composer can
   * prepare the right voice before the first V line. Cheap: one property read.
   */
  noteGender(input) {
    const gender = vGenderOf(input?.turnContext);
    if (gender) this.know(gender);
  }

  /** V's gender is known (from a turn): kept for the next session too, written only when it changed. */
  know(gender) {
    if (this.lastGender === gender) return;
    this.lastGender = gender;
    try { this.remember?.save?.(gender); } catch { /* a memory that cannot be written costs one cold line next session */ }
  }

  get available() { return GENDERS.some(gender => this.voices[gender]); }

  /** V's line is wanted from the Pocket voice (some Pocket worker has to be loaded for it). */
  get wantsPocket() { return this.enabled && this.available && this.engine === 'pocket'; }

  once(key, line) { if (this.logged.has(key)) return; this.logged.add(key); this.log(line); }

  /**
   * Why this turn does not get a V line, or null when it does. Typed lines only: a spoken line is never replayed. A line typed to an
   * add-on's voice (a cab, a gun: input.addon names the speaker, input.reaction is not set) is a typed line like any other and gets V's
   * voice (live 2026-10-16: V was silent in the Delamain cab); an add-on remark carries a reaction and never does.
   */
  skipReason(input) {
    if (!this.enabled) return 'off';
    if (!input || input.reaction || input.source !== undefined || input.channel === 'phone') return 'not-typed';
    if (input.group && input.group.index !== 1) return 'later-group-speaker';
    if (!this.available) return 'no-clips';
    return null;
  }

  /** Can V's engine speak this key right now (a worker routed, or the cloud voice usable)? Quiet: no log, nothing started. */
  speakable(key) {
    if (this.engine === 'voxtral') return !!this.cloud && this.cloud.problem(key) === null;
    if (this.engine === 'omni') return !!this.omni && this.omni.problem(key) === null;
    return !!this.helper?.speaks(key) || (typeof this.ready === 'function' && this.ready(key) === true);
  }

  /**
   * Starts V's line for a typed turn and returns it, or null (nothing to say, or not possible). Never throws and never waits: the
   * synthesis runs beside the companion's text request.
   */
  start(input, {signal, clock} = {}) {
    try {
      const reason = this.skipReason(input);
      if (reason) {
        if (reason === 'no-clips') this.once('no-clips', "V's voice is on but the reference clips are missing (assets/v-voice); typed lines stay silent");
        return null;
      }
      const gender = vGenderOf(input.turnContext);
      const voice = gender && this.voices[gender];
      if (!voice) {
        this.once('gender:' + gender, `V's voice skipped: ${gender ? `no ${gender} clip` : "V's gender is not known for this turn"}`);
        return null;
      }
      this.know(gender);
      const text = vLineText(input.text);
      if (!text) return null;
      const plan = this.planFor(input, voice.key);
      if (!plan || (plan.engine !== 'pocket' && plan.engine !== 'voxtral' && plan.engine !== 'omni')) return null;
      // Pocket has no language but English. The Voxtral voice speaks the language the line is written in, for the languages its model lists
      // (Voxtral TTS 3: bridge/voxtral-languages.mjs): a line in another language is spoken by it, and skipped when the model does not list it.
      // OmniVoice clones the English reference into any language (the worker takes any ISO code, as for a companion's reply), so it skips none.
      const spoken = plan.language && plan.language !== 'en' ? plan.language : 'en';
      if (spoken !== 'en' && plan.engine !== 'omni' && !(plan.engine === 'voxtral' && this.cloud?.speaks?.(spoken) === true)) {
        this.once('language:' + plan.engine, `V's voice skipped: the ${plan.engine === 'voxtral' ? 'Voxtral' : 'Pocket'} voice does not speak this language`);
        return this.skip('not-english');
      }
      const volume = input.turnContext?.dialogueVolume;
      if (typeof volume !== 'number' || !Number.isFinite(volume)) { this.once('volume', "V's voice skipped: the game's dialogue volume is not known"); return this.skip('volume-unknown'); }
      if (volume <= 0.001) return null;
      let route;
      if (plan.engine === 'omni') {
        // OmniVoice, the companions' own worker. Not there (the companions are on another voice, still loading, playback Off, failed): no line,
        // the reason in the log (once per reason); nothing is loaded for it. Otherwise the render is queued on the worker NOW, ahead of the
        // companion's: the reply waits for V's first audio as long as it takes (`patient`), and only a failure drops the line.
        const problem = this.omni ? this.omni.problem(voice.key) : 'not available';
        if (problem !== null) { this.once('omni:' + problem, `V's voice skipped: OmniVoice cannot speak it now (${problem})`); return this.skip('omni-unavailable'); }
        route = {plan: {engine: 'omni', language: spoken}, render: (key, spoken, options) => this.omni.render(key, spoken, options), local: false, patient: true};
      } else if (plan.engine === 'voxtral') {
        // The cloud voice shares no worker with anyone: nothing stops it, it is simply dropped if it is not audible when the reply is.
        const problem = this.cloud ? this.cloud.problem(voice.key) : 'not available';
        if (problem !== null) { this.once('cloud:' + problem, `V's voice skipped: the Voxtral voice cannot speak it now (${problem})`); return this.skip('cloud-unavailable'); }
        // A line in another language is cloned from the voice language pack's V clip (v-voice/v-male.wav, v-female.wav) when that language has a pack: the
        // options carry the language, and the log names the clip as the routing line does for a companion.
        const packSet = spoken !== 'en' ? this.cloud.languageSet?.(voice.key, spoken) ?? null : null;
        if (packSet) this.log(`V's line in ${spoken} is cloned from ${packSet}`);
        route = {plan: {engine: 'voxtral', language: spoken}, stream: (key, text, options) => this.cloud.stream(key, text, spoken !== 'en' ? {...options, language: spoken} : options), local: false};
      } else if (this.helper?.speaks(voice.key)) {
        // V's own Pocket worker (the companions use OmniVoice, a cloud voice or the Convai voice). Still loading, or failed: V is skipped,
        // the reply never waits for it. Asking also starts a due load.
        if (!this.helper.ready(voice.key)) { this.log("V's line skipped: the Pocket voice for V is not loaded yet"); return this.skip('voice-not-loaded'); }
        route = {plan: {engine: 'pocket', helper: true, language: 'en'}, stream: (key, spoken, options) => this.helper.stream(key, spoken, options), local: false};
      } else {
        // The companions' Pocket worker speaks V too: one job at a time, so an unfinished V line steps aside for the reply's voice.
        if (!this.ready(voice.key)) { this.once('ready:' + voice.key, `V's voice skipped: the Pocket voice has no ${voice.key} voice yet`); return this.skip('voice-not-ready'); }
        route = {plan: {engine: 'pocket', language: 'en'}, stream: this.stream, local: this.isLocal()};
      }
      let reference = voice.source ?? 'shipped';
      try { reference = this.referenceLabel?.(gender) ?? reference; } catch { /* a label never affects speech */ }
      const line = new VLine({input, key: voice.key, text, plan: route.plan, volume: Math.min(1, volume), signal, log: this.log, reference,
        play: (config, producer, options) => this.play(config, producer, options), stream: route.stream, render: route.render, local: route.local,
        patient: route.patient === true, after: this.previous, graceMs: this.graceMs, onSettled: summary => { this.count(summary); this.report(input, summary); },
        onAudible: () => clock?.mark('vAudible'), onGrace: () => clock?.mark('vGrace')});
      this.previous = line.finished;
      line.whenClear(() => { clock?.mark(line.state === 'done' ? 'vEnded' : 'vDropped'); });
      // The companion's own voice request marks 'ttsSent' on the turn's clock.
      clock?.on('ttsSent', () => line.companionVoiceStarted());
      return line;
    } catch (error) {
      this.once('start:' + String(error?.message).slice(0, 40), `V's voice skipped: ${String(error?.message ?? error).slice(0, 120)}`);
      return null;
    }
  }

  /**
   * One line settled: count it, and write the running totals to the log when it was dropped (and for the first line of the session), so a
   * support report shows how often V was heard. The last such line in the log is the current total.
   */
  /** A typed line that would have had a V line but could not: counted by reason; the first of each reason also writes the totals. */
  skip(reason) {
    const first = !this.tally.skipped[reason];
    this.tally.skipped[reason] = (this.tally.skipped[reason] ?? 0) + 1;
    if (first) this.logTally();
    return null;
  }

  logTally() {
    const list = counts => Object.entries(counts).map(([reason, count]) => `${reason}=${count}`).join(' ');
    const reasons = list(this.tally.reasons), skipped = list(this.tally.skipped);
    this.log(`this session: ${this.tally.played} typed line(s) spoken, ${this.tally.dropped} not heard${reasons ? ` (${reasons})` : ''}`
      + `${skipped ? `, ${Object.values(this.tally.skipped).reduce((sum, count) => sum + count, 0)} not started (${skipped})` : ''}`);
  }

  count(summary) {
    const played = summary.result === 'played', dropped = summary.result === 'dropped';
    if (!played && !dropped) return;
    const first = this.tally.played + this.tally.dropped === 0;
    if (played) this.tally.played++;
    else { this.tally.dropped++; const reason = summary.reason ?? 'unknown'; this.tally.reasons[reason] = (this.tally.reasons[reason] ?? 0) + 1; }
    if (dropped || first) this.logTally();
  }

  /**
   * The voice keys to prepare ahead of a line, in order: the remembered or last-seen V's, else (a first session, nothing known) both, male first.
   * A key is only worth preparing where something can speak it.
   */
  preparationKeys() {
    const known = this.lastGender && this.voices[this.lastGender] ? [this.voices[this.lastGender].key]
      : GENDERS.filter(name => this.voices[name]).map(name => this.voices[name].key);
    return known;
  }

  /**
   * The composer opened (or V's own Pocket worker finished loading): warm the renderer page and prepare the voice V will speak with, so
   * the first typed line is not the slow one. For the Voxtral voice that means V's reference clip is read and encoded now (cached in
   * memory and on disk), not inside the first line. For Pocket it is the voice's clone (the reference encoded once, about 2 s on a slow
   * CPU); with V's gender known (a line this session, or remembered from an earlier one) that is one voice, else both, one after the
   * other, and the second is skipped once a line says which V it is. Work happens in the background and only here, never per frame.
   */
  warmUp({signal, page = true} = {}) {
    if (!this.enabled || !this.available) return;
    const keys = this.preparationKeys();
    // An engine that cannot speak right now (no key, no worker) warms and prepares nothing.
    if (!keys.some(key => this.speakable(key))) return;
    if (page) Promise.resolve().then(() => this.warm?.({signal})).catch(() => {});
    if (this.engine === 'omni') {
      // V's voice is prepared on the Omni worker (a hidden render, once per worker) now, while the player types, not inside the first line.
      void this.prepareOmni(keys, signal);
      return;
    }
    if (this.engine === 'voxtral') {
      for (const key of keys) { try { this.cloud?.warm?.(key); } catch { /* a warm-up never fails a turn */ } }
      return;
    }
    void this.prepareVoices(keys, signal);
  }

  async prepareOmni(keys, signal) {
    for (const key of keys) {
      if (this.lastGender && this.voices[this.lastGender]?.key !== key) continue;
      if (signal?.aborted) return;
      try { await this.omni?.prepare?.(key, {signal}); } catch { /* a warm-up never fails a turn */ }
    }
  }

  async prepareVoices(keys, signal) {
    for (const key of keys) {
      // A line (or a game report) has since said which V is playing: the other voice is not needed.
      if (this.lastGender && this.voices[this.lastGender]?.key !== key) continue;
      if (signal?.aborted) return;
      // V's own Pocket worker prepares it when it is the one in charge; otherwise the companions' Pocket worker does.
      const prepare = this.helper?.speaks(key) ? this.helper.prepare : this.prepare;
      try { await prepare?.(key, {signal}); } catch { /* a warm-up never fails a turn */ }
    }
  }
}
