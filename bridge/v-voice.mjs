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
// Never OmniVoice (its one GPU worker could not make V's line before the companion's reply and would hold the companion's own render),
// never the Convai cloud voice (it cannot clone). A cloud voice never falls back to a local model: if V's cloud line fails, V is
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
//     line is not yet audible, it is dropped; the reply never waits for synthesis.
//   - A worker the companion's voice shares with V (the Pocket voice speaking both) works one job at a time. A V line still waiting for
//     its first audio when the companion's own text-to-speech request goes out is stopped, so it never stands in front of the reply's
//     voice. (A line that is already audible keeps going: the companion cannot be heard before it ends anyway.) A V line on its own
//     worker or on the cloud shares nothing with the companion, so nothing stops it.
//   - Any failure drops the line, writes one log line and never touches the conversation.
// V talks on their own (docs/V_TALKS.md) is the one exception to "typed lines only": the game side writes V's line as the text of an automatic
// reaction {kind: 'vtalk'}. That line is the whole point of the turn, so it is `required`: the companion's answer waits for it while it is still
// being made (up to REQUIRED_WAIT_MS), instead of the line being dropped to spare the reply.
// V's line runs under a TurnClock of its own (the stage clock, bridge/turn-clock.mjs), so its marks never mix into the companion's.
import {randomBytes} from 'node:crypto';
import {readFile as readFileDefault} from 'node:fs/promises';
import {resolve} from 'node:path';
import {inspectReference} from './addons.mjs';
import {PcmEdges} from './pcm-edges.mjs';
import {voiceVolumeDb} from './dialogue-level.mjs';
import {TurnClock, withClock} from './turn-clock.mjs';

export const V_VOICE_KEYS = Object.freeze({male: 'v-male', female: 'v-female'});
export const V_MANIFEST = 'v-voice.json';
/** The longest line V speaks; a longer one is cut at the last sentence or word that fits. */
export const V_MAX_CHARS = 240;
/** How long a required line (V talks on their own) may take to become audible before it is dropped and the reply goes on alone. */
export const REQUIRED_WAIT_MS = 6000;
const GENDERS = Object.keys(V_VOICE_KEYS);
/** The engines V's line can be asked of (runtime/settings.json `vVoiceEngine`); Pocket is the default. */
export const V_ENGINES = Object.freeze(['pocket', 'voxtral']);
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

// ---- One line --------------------------------------------------------------------------------------------------------------

/**
 * States: 'synth' (asked for, nothing audible yet), 'playing' (the renderer holds audio: the line is audible), 'done' (it ended),
 * 'dropped' (not spoken: too slow, stopped or failed). `clear` resolves when the line is no longer audible or pending.
 */
export class VLine {
  constructor({input, key, text, plan, volume, play, stream, render, local = true, clock = new TurnClock(), signal, log = () => {},
    after, edges, token = 'v-' + randomBytes(8).toString('hex'), onSettled = () => {}, onAudible = () => {}, required = false,
    waitMs = REQUIRED_WAIT_MS}) {
    Object.assign(this, {input, key, text, plan, volume, playHost: play, streamVoice: stream, renderVoice: render, local, clock, log,
      after, edges, token, onSettled, onAudible, required});
    this.state = 'synth';
    this.reason = null;
    this.controller = new AbortController();
    this.watchers = [];
    this.clear = new Promise(resolveClear => { this.resolveClear = resolveClear; });
    // The turn that owns this line ending (a newer message, a stop) stops it.
    if (signal) {
      const cancel = () => this.drop('turn-ended');
      if (signal.aborted) cancel(); else signal.addEventListener('abort', cancel, {once: true});
    }
    // A required line gets a deadline: audible within waitMs or dropped (the reply never waits longer than that for it).
    if (required && this.state === 'synth') {
      const deadline = setTimeout(() => { if (this.state === 'synth') this.drop('too-slow'); }, waitMs);
      deadline.unref?.();
      this.clear.then(() => clearTimeout(deadline), () => {});
    }
    this.finished = this.state === 'dropped' ? Promise.resolve() : this.run();
  }

  get blocking() { return this.state === 'playing' || (this.required && this.state === 'synth'); }
  get settled() { return this.state === 'done' || this.state === 'dropped'; }

  /** Calls `fn` once when the line stops being audible or pending (at once if it already has). */
  whenClear(fn) { this.clear.then(fn, () => {}); }

  /**
   * The companion's audio is ready: may it start? True while V is audible (the audio waits). A line that is not audible yet is
   * dropped here, so the reply never waits for V's synthesis. Safe to call on every poll.
   */
  holds() {
    if (this.state === 'synth' && !this.required) this.drop('slower-than-reply');
    return this.state === 'playing' || (this.required && this.state === 'synth');
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
    this.state = 'dropped'; this.reason = reason;
    this.clock.mark('dropped');
    this.controller.abort();
    this.settle();
  }

  settle() {
    this.resolveClear();
    try { this.onSettled(this.summary()); } catch { /* a report never affects speech */ }
  }

  summary() {
    const snapshot = this.clock.snapshot();
    return {result: this.state === 'done' ? 'played' : this.state === 'dropped' ? 'dropped' : this.state,
      ...(this.reason ? {reason: this.reason} : {}), engine: this.plan.helper ? 'pocket-helper' : this.plan.engine, voice: this.key, chars: this.text.length,
      marks: snapshot.marks, totalMs: snapshot.totalMs};
  }

  onFrame(snapshot) {
    if (this.state === 'synth' && snapshot?.receivedFrames > 0) {
      this.state = 'playing';
      this.clock.mark('audible');
      try { this.onAudible(); } catch { /* a report never affects speech */ }
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
        const producer = this.streamProducer();
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
   * planFor  (input, key) => {engine: 'pocket' | 'voxtral', language}: V's engine (the player's choice) and the turn's language
   * ready    key => boolean: the Pocket voice is the companions' committed voice, loaded and routed, and has that voice (it speaks V)
   * stream / play / prepare / warm   the Pocket voice and renderer calls (convai-bridge.mjs wires the real ones)
   * isLocal  () => boolean: that Pocket worker is shared with the companion (one job at a time)
   * helper   {speaks(key), ready(key), stream, prepare} or null: the Pocket worker that is V's alone (bridge/v-helper-voice.mjs). It speaks
   *          V whenever the companions' voice is not the Pocket worker itself (OmniVoice, a cloud voice, the Convai voice); `speaks` says
   *          whether it is the one in charge for this key, `ready` whether it is loaded.
   * cloud    {problem(key), stream(key, text, options), warm(key)} or null: the Voxtral cloud voice. `problem` is null when it can speak
   *          V's line now, else a short reason (no key, no clip, a limit cooling down); `warm` prepares V's reference clip.
   */
  constructor({voices = {}, planFor, ready, stream, play, prepare, warm, isLocal = () => true, helper = null, cloud = null, log = () => {}, report = () => {}} = {}) {
    Object.assign(this, {voices, planFor, ready, stream, play, prepare, warm, isLocal, helper, cloud, log, report});
    this.enabled = false;
    this.engine = 'pocket';
    this.lastGender = null;
    this.previous = null;
    this.logged = new Set();
  }

  /**
   * The setting (runtime/settings.json "vVoice", "vVoiceEngine"). On unless the player turned it off: a file that never stored it, or a
   * saved false the player never chose, counts as on. The engine is 'voxtral' only when that is what is stored; anything else is Pocket,
   * the default. Returns whether either changed.
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
    if (gender) this.lastGender = gender;
  }

  get available() { return GENDERS.some(gender => this.voices[gender]); }

  /** V's line is wanted from the Pocket voice (some Pocket worker has to be loaded for it). */
  get wantsPocket() { return this.enabled && this.available && this.engine === 'pocket'; }

  once(key, line) { if (this.logged.has(key)) return; this.logged.add(key); this.log(line); }

  /**
   * Why this turn does not get a V line, or null when it does. Typed lines only: a spoken line is never replayed. A line typed to an
   * add-on's voice (a cab, a gun: input.addon names the speaker, input.reaction is not set) is a typed line like any other and gets V's
   * voice (live 2026-10-16: V was silent in the Delamain cab); an add-on remark carries a reaction and never does. The one reaction that
   * does is V's own opener of an exchange V started (kind 'vtalk', docs/V_TALKS.md): its text is V's line.
   */
  skipReason(input) {
    if (!this.enabled) return 'off';
    if (!input || (input.reaction && input.reaction.kind !== 'vtalk') || input.source !== undefined || input.channel === 'phone') return 'not-typed';
    if (input.group && input.group.index !== 1) return 'later-group-speaker';
    if (!this.available) return 'no-clips';
    return null;
  }

  /** Can V's engine speak this key right now (a worker routed, or the cloud voice usable)? Quiet: no log, nothing started. */
  speakable(key) {
    if (this.engine === 'voxtral') return !!this.cloud && this.cloud.problem(key) === null;
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
      this.lastGender = gender;
      const text = vLineText(input.text);
      if (!text) return null;
      const plan = this.planFor(input, voice.key);
      if (!plan || (plan.engine !== 'pocket' && plan.engine !== 'voxtral')) return null;
      // Both engines speak English here (Pocket has no other language, the Mistral cloud voice is English only in this mod).
      if (plan.language && plan.language !== 'en') {
        this.once('language:' + plan.engine, `V's voice skipped: the ${plan.engine === 'voxtral' ? 'Voxtral' : 'Pocket'} voice speaks English only`);
        return null;
      }
      const volume = input.turnContext?.dialogueVolume;
      if (typeof volume !== 'number' || !Number.isFinite(volume)) { this.once('volume', "V's voice skipped: the game's dialogue volume is not known"); return null; }
      if (volume <= 0.001) return null;
      let route;
      if (plan.engine === 'voxtral') {
        // The cloud voice shares no worker with anyone: nothing stops it, it is simply dropped if it is not audible when the reply is.
        const problem = this.cloud ? this.cloud.problem(voice.key) : 'not available';
        if (problem !== null) { this.once('cloud:' + problem, `V's voice skipped: the Voxtral voice cannot speak it now (${problem})`); return null; }
        route = {plan: {engine: 'voxtral', language: 'en'}, stream: (key, spoken, options) => this.cloud.stream(key, spoken, options), local: false};
      } else if (this.helper?.speaks(voice.key)) {
        // V's own Pocket worker (the companions use OmniVoice, a cloud voice or the Convai voice). Still loading, or failed: V is skipped,
        // the reply never waits for it. Asking also starts a due load.
        if (!this.helper.ready(voice.key)) { this.log("V's line skipped: the Pocket voice for V is not loaded yet"); return null; }
        route = {plan: {engine: 'pocket', helper: true, language: 'en'}, stream: (key, spoken, options) => this.helper.stream(key, spoken, options), local: false};
      } else {
        // The companions' Pocket worker speaks V too: one job at a time, so an unfinished V line steps aside for the reply's voice.
        if (!this.ready(voice.key)) { this.once('ready:' + voice.key, `V's voice skipped: the Pocket voice has no ${voice.key} voice yet`); return null; }
        route = {plan: {engine: 'pocket', language: 'en'}, stream: this.stream, local: this.isLocal()};
      }
      const line = new VLine({input, key: voice.key, text, plan: route.plan, volume: Math.min(1, volume), signal, log: this.log,
        required: input.reaction?.kind === 'vtalk',
        play: (config, producer, options) => this.play(config, producer, options), stream: route.stream, local: route.local, after: this.previous,
        onSettled: summary => { this.report(input, summary); }, onAudible: () => clock?.mark('vAudible')});
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
   * The composer opened: warm the renderer page and the voice that was last used, so the first typed line is not the slow one. For the
   * Voxtral voice that means V's reference clip is read and encoded now (cached in memory and on disk), not inside the first line.
   */
  warmUp({signal} = {}) {
    if (!this.enabled || !this.available) return;
    const keys = GENDERS.filter(name => this.voices[name]).map(name => this.voices[name].key);
    // An engine that cannot speak right now (no key, no worker) warms and prepares nothing.
    if (!keys.some(key => this.speakable(key))) return;
    Promise.resolve().then(() => this.warm?.({signal})).catch(() => {});
    const gender = this.lastGender && this.voices[this.lastGender] ? this.lastGender : GENDERS.find(name => this.voices[name]);
    if (this.engine === 'voxtral') {
      // The clip is small and cached, so with no line yet both are prepared (the gender is not known before the first typed line).
      const wanted = this.lastGender && this.voices[this.lastGender] ? [this.voices[this.lastGender].key] : keys;
      for (const key of wanted) { try { this.cloud?.warm?.(key); } catch { /* a warm-up never fails a turn */ } }
      return;
    }
    // With one clip, or after a first line, the voice to prepare is known; with two clips and no line yet it is not worth guessing.
    if (gender && (this.lastGender || keys.length === 1)) {
      const key = this.voices[gender].key;
      // V's own Pocket worker prepares it when it is the one in charge; otherwise the companions' Pocket worker does.
      const prepare = this.helper?.speaks(key) ? this.helper.prepare : this.prepare;
      Promise.resolve().then(() => prepare?.(key, {signal})).catch(() => {});
    }
  }
}
