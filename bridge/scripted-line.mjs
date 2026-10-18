// Scripted lines (development only): a companion speaks an EXACT prepared line through the mod's real reply pipeline, with the
// language model skipped. The game side is `speak-line <who> <file.json>` in mod/face-test.lua (installed only by the development file
// list) and scripts/Send-ScriptedLine.ps1; the bridge side is runScriptedTurn in bridge/convai-bridge.mjs, which only honours a
// request while Developer mode is on in runtime/settings.json. Nothing here is reachable from the player's UI.
//
// The JSON file holds {text, audio?, engine?}:
//   text    the exact line; it may carry the pipeline's own tags (bridge/emotion-tags.mjs: {joy} {warm:strong} ...; voice sounds in
//           square brackets for the engines that render them). Tags move the face exactly as in a model reply.
//   audio   an absolute path to a prepared WAV (any rate, one or more channels). THAT audio plays, unchanged apart from the mixdown to
//           mono and, when needed, resampling to 24 kHz. The lip sync and face timeline are computed from it by the same analysis
//           that serves synthesized audio (the Pocket continuous route: PocketFacialStream over the packets this module hands out).
//   engine  'pocket', 'voxtral' or 'inworld': synthesize the text live through that voice. Ignored when `audio` is given. With neither,
//           the engine the player's settings chose speaks it.
//   route   'game': the line takes the place of the model's reply and goes through the ordinary reply path from there (the voice the
//           player's settings chose, that voice's own lip sync and face, and the ordinary publish). With `audio`, that WAV is the voice
//           (the whole-file face analysis, as for OmniVoice); `engine` is ignored.
import {randomBytes, createHash} from 'node:crypto';
import {isAbsolute} from 'node:path';
import {decodeWav} from './voxtral-reference.mjs';
import {stripSpeechTags} from './natural-speech.mjs';
import {throwIfCancelled} from './transport-pool.mjs';

export const SCRIPTED_RATE = 24000;
export const SCRIPTED_ENGINES = Object.freeze(['pocket', 'voxtral', 'inworld']);
export const SCRIPTED_MAX_TEXT = 1200;          // the request parser's own limit for a line
export const SCRIPTED_MAX_SECONDS = 100;        // the local PCM host takes 120 s at most
const PACKET_FRAMES = 2400;                     // 100 ms, like the cloud voices' packets
const MODEL_ID = createHash('sha256').update('scripted-prepared-audio').digest('hex');

/** The file's JSON as {text, audio?, engine?, route?}; throws an Error that says what is wrong. */
export function parseScriptedLine(raw) {
  let value;
  try { value = JSON.parse(String(raw).replace(/^﻿/, '')); } catch { throw Error('the scripted line file is not JSON'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('the scripted line file must hold a JSON object');
  const {text, audio, engine, route} = value;
  if (typeof text !== 'string' || !text.trim() || text.length > SCRIPTED_MAX_TEXT) throw Error(`"text" must be 1 to ${SCRIPTED_MAX_TEXT} characters`);
  if (audio !== undefined && (typeof audio !== 'string' || !isAbsolute(audio) || !/\.wav$/i.test(audio))) throw Error('"audio" must be an absolute path to a .wav file');
  if (engine !== undefined && !SCRIPTED_ENGINES.includes(engine)) throw Error(`"engine" must be one of ${SCRIPTED_ENGINES.join(', ')}`);
  if (route !== undefined && route !== 'game') throw Error('"route" must be "game" when given');
  if (route === 'game') return {text: text.trim(), route, ...(audio ? {audio} : {})};
  return {text: text.trim(), ...(audio ? {audio} : {}), ...(engine ? {engine} : {})};
}

/** A WAV file's bytes as mono float32 at 24 kHz (channels averaged, linear resampling only when the rate differs). */
export function pcmFromWav(bytes, {maxSeconds = SCRIPTED_MAX_SECONDS} = {}) {
  const {rate, channels, samples} = decodeWav(Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes));
  const frames = samples[0].length;
  if (!frames) throw Error('the WAV holds no audio');
  const mono = new Float32Array(frames);
  for (let at = 0; at < frames; at++) {
    let sum = 0;
    for (let channel = 0; channel < channels; channel++) sum += samples[channel][at];
    mono[at] = sum / channels;
  }
  let out = mono;
  if (rate !== SCRIPTED_RATE) {
    const length = Math.max(1, Math.round(frames * SCRIPTED_RATE / rate));
    out = new Float32Array(length);
    const step = rate / SCRIPTED_RATE;
    for (let at = 0; at < length; at++) {
      const position = at * step, base = Math.floor(position), next = Math.min(frames - 1, base + 1), part = position - base;
      out[at] = mono[Math.min(frames - 1, base)] * (1 - part) + mono[next] * part;
    }
  }
  if (out.length / SCRIPTED_RATE > maxSeconds) throw Error(`the audio is longer than ${maxSeconds} s`);
  return out;
}

/**
 * A voice that "synthesizes" prepared audio: the same interface as Pocket and the cloud voices
 * (`synthesizeStream(key, text, {signal, onPcm})`), handing `onPcm` 100 ms packets of the file's samples with Pocket's transport
 * marker, so the continuous speech, the face analysis and the subtitles treat them like synthesized audio.
 */
export function preparedVoice(pcm, {owner = randomBytes(16).toString('hex'), packetFrames = PACKET_FRAMES} = {}) {
  let sequence = 0;
  return {
    prepared: true,
    async synthesizeStream(key, _text, {signal, onPcm, utterance} = {}) {
      if (typeof onPcm !== 'function') throw Error('Prepared audio requires a PCM consumer');
      const id = ++sequence, started = Date.now();
      let delivered = 0, chunks = 0;
      while (delivered < pcm.length) {
        throwIfCancelled(signal);
        const samples = pcm.slice(delivered, delivered + packetFrames);
        const packet = {version: 1, engine: 'pocket-tts', profile: key, owner, id, index: chunks + 1,
          sampleRate: SCRIPTED_RATE, channels: 1, pcm: samples, format: 'f32le', offsetFrames: delivered,
          frames: samples.length, timebase: 'audio-seconds', startSeconds: delivered / SCRIPTED_RATE,
          modelSha256: MODEL_ID, timing: {voicePcmReceivedMs: Date.now() - started}};
        await onPcm(packet);
        delivered += samples.length; chunks++;
      }
      utterance?.decide('pocket');
      return {provider: 'prepared', engine: 'prepared', sampleRate: SCRIPTED_RATE, channels: 1, frames: delivered, chunks,
        duration: delivered / SCRIPTED_RATE, modelSha256: MODEL_ID, truncated: false,
        timing: {voiceProvider: 'pocket', voiceEngine: 'prepared', voiceAudioSeconds: Math.round(delivered / SCRIPTED_RATE * 100) / 100}};
    },
  };
}

/**
 * The voice for a live line: the named engine of `localVoice` (a VoiceSelection), or the player's own choice when `engine` is
 * undefined. A cloud voice is asked directly (its own key, limits and reference clip), never through the player's setting.
 * Throws when the engine cannot speak now (no key, Pocket not the active local route).
 */
export function engineVoice(engine, localVoice) {
  if (engine === undefined) return localVoice;
  if (engine === 'pocket') {
    if (!localVoice.pocketRoute) throw Error('Pocket is not the active local voice (set Voices to Pocket, or use a prepared file)');
    return localVoice;
  }
  const cloud = localVoice[engine];
  if (!cloud) throw Error(`the ${engine} voice is not available`);
  if (!cloud.hasKey) throw Error(`the ${engine} voice has no key`);
  return {
    synthesizeStream(key, text, options = {}) {
      const {utterance, role: _role, onPcm, ...plain} = options;
      let started = false;
      return cloud.synthesizeStream(key, stripSpeechTags(text), {...plain, onPcm: packet => {
        if (!started) { started = true; utterance?.decide(engine); }
        return onPcm(packet);
      }});
    },
  };
}
