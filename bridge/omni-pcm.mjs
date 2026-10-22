// OmniVoice on the mod's own audio path (2026-10-22). OmniVoice renders a whole phrase at a time (a WAV); this module turns those
// phrases into the same 24 kHz mono PCM packets the Pocket voice produces, so a reply is played by the same renderer as every other
// voice (bridge/local-pcm-host.mjs: one hidden browser page, its own Windows audio session, the game's lease for volume, pan and
// distance, the dialogue level and Voice volume as sample gain) and its face comes from the same streaming face model
// (bridge/pocket-facial-stream.mjs). Nothing here touches the game: there is no slot file, no manifest and no Audioware.
//
// `createOmniPcmVoice(...).synthesizeStream(profile, text, options)` has the contract of the Pocket worker's synthesizeStream, so
// bridge/pocket-speech.mjs (deliverPocketSpeech) and the group look-ahead buffer (BufferedPcm) take it unchanged:
//   - the text is cut into phrases (bridge/speech-phrases.mjs), the first is rendered at once and the next one is queued behind it on
//     the worker (the worker takes one job at a time, so the GPU renders phrase 2 while phrase 1 plays), never more than `ahead` phrases
//     beyond the one being sent, and never more than `maxLead` seconds of audio beyond what has been heard (a paused game does not let
//     a long reply render to its end);
//   - each finished phrase is decoded and handed to `onPcm` in packets of at most 2 s, numbered and offset like Pocket's;
//   - a phrase after the first that fails ends the reply there (`truncated`), the sentence already heard is kept; a first phrase that
//     fails throws, and the reply is written text.
import {readPcmWav} from './speech-audio.mjs';
import {splitSpeechText} from './speech-phrases.mjs';
import {throwIfCancelled} from './transport-pool.mjs';
import {randomBytes, createHash} from 'node:crypto';

export const OMNI_RATE = 24000;
// A packet is at most this many frames (the host accepts 96000); a 2 s packet keeps the renderer's acknowledgement round trips few.
export const PACKET_FRAMES = 48000;
const MAX_FRAMES = OMNI_RATE * 120;

/**
 * A phrase WAV (base64 string or Buffer) as mono Float32 samples at 24 kHz. OmniVoice answers 24 kHz already (nothing is resampled
 * then); another rate is converted with linear interpolation, and stereo is averaged. Values are the file's own, never normalised.
 */
export function wavToPcm(audio) {
  const bytes = Buffer.isBuffer(audio) ? audio : Buffer.from(String(audio), 'base64');
  const wav = readPcmWav(bytes);
  const frames = wav.data.length / wav.align, step = wav.bits / 8;
  const mono = new Float32Array(frames);
  for (let frame = 0; frame < frames; frame++) {
    let sum = 0;
    for (let channel = 0; channel < wav.channels; channel++) {
      const at = frame * wav.align + channel * step;
      const raw = wav.codec === 3 ? wav.data.readFloatLE(at) : wav.data.readIntLE(at, step) / 2 ** (wav.bits - 1);
      sum += Number.isFinite(raw) ? Math.max(-1, Math.min(1, raw)) : 0;
    }
    mono[frame] = sum / wav.channels;
  }
  if (wav.sampleRate === OMNI_RATE) return mono;
  const count = Math.max(1, Math.round(frames * OMNI_RATE / wav.sampleRate)), out = new Float32Array(count), ratio = wav.sampleRate / OMNI_RATE;
  for (let at = 0; at < count; at++) {
    const position = at * ratio, low = Math.min(frames - 1, Math.floor(position)), high = Math.min(frames - 1, low + 1), mix = position - low;
    out[at] = mono[low] * (1 - mix) + mono[high] * mix;
  }
  return out;
}

const sleepFor = (ms, signal) => new Promise((resolve, reject) => {
  const timer = setTimeout(done, ms);
  function done() { signal?.removeEventListener('abort', stop); resolve(); }
  function stop() { clearTimeout(timer); signal?.removeEventListener('abort', stop); reject(signal.reason ?? Error('cancelled')); }
  signal?.addEventListener('abort', stop, {once: true});
});

/**
 * synthesize(profile, text, {signal, steps, language}) -> Promise<{audio: base64 WAV, timing}> (the resident worker's job; one at a time).
 * voicedPhrases(phrases, {role, text}) -> phrases with voice tags written in (Natural speech), or undefined for the plain phrases.
 * steps() -> the quality setting (16 or 32), read for each reply. onPhrase({index, role, generated, seconds}) is a diagnostics hook.
 */
export function createOmniPcmVoice({synthesize, voicedPhrases, steps = () => undefined, onPhrase, ahead = 2, maxLeadSeconds = 14, sleep = sleepFor,
  pollMs = 75, now = () => performance.now()}) {
  if (typeof synthesize !== 'function') throw Error('OmniVoice synthesis is required');
  let counter = 0;
  return {
    /**
     * options: signal; onPcm(packet) (awaited, in order); role 'head' | 'tail' | undefined; language; steps; utterance (told 'pocket': not a cloud
     * voice); progress {emitted, heard} in seconds (kept by the caller: the reply stops queueing phrases while it is `maxLeadSeconds` ahead).
     */
    async synthesizeStream(profile, text, options = {}) {
      const {signal, onPcm, role, language, utterance, progress} = options;
      if (typeof onPcm !== 'function') throw Error('OmniVoice needs a PCM sink');
      throwIfCancelled(signal);
      utterance?.decide('pocket');
      const phrases = splitSpeechText(text);
      let voiced;
      try { voiced = voicedPhrases?.(phrases, {role, text}); } catch { voiced = undefined; }
      if (!Array.isArray(voiced) || voiced.length !== phrases.length) voiced = phrases;
      const quality = options.steps ?? steps();
      const owner = randomBytes(16).toString('hex'), id = ++counter;
      const modelSha256 = createHash('sha256').update(`omnivoice:${profile}`).digest('hex');
      const jobs = new Map(), inner = new AbortController(), relay = () => inner.abort(signal.reason);
      signal?.addEventListener('abort', relay, {once: true});
      if (signal?.aborted) relay();
      const queue = index => {
        if (index >= phrases.length || jobs.has(index)) return;
        const started = now();
        const job = Promise.resolve().then(() => synthesize(profile, voiced[index], {signal: inner.signal, steps: quality, ...(language ? {language} : {})}))
          .then(generated => ({generated, queuedMs: now() - started}));
        job.catch(() => {});
        jobs.set(index, job);
      };
      // The worker's one queue: this phrase, and the next one behind it.
      for (let index = 0; index < Math.min(ahead, phrases.length); index++) queue(index);
      let frames = 0, packets = 0, first;
      try {
        for (let index = 0; index < phrases.length; index++) {
          let generated;
          try {
            ({generated} = await jobs.get(index));
            throwIfCancelled(signal);
          } catch (error) {
            throwIfCancelled(signal);
            // The first phrase decides whether there is a reply at all; a later one ends it where it is.
            if (!frames) throw error;
            return {frames, chunks: packets, duration: frames / OMNI_RATE, truncated: true,
              timing: {...first?.timing, voiceProvider: 'omni', voiceEngine: 'omnivoice', voiceTailFailed: true}};
          }
          jobs.delete(index);
          const pcm = wavToPcm(generated.audio);
          if (frames + pcm.length > MAX_FRAMES) throw Error('Speech exceeded two minutes');
          first ??= generated;
          for (let at = 0; at < pcm.length; at += PACKET_FRAMES) {
            const piece = pcm.subarray(at, Math.min(pcm.length, at + PACKET_FRAMES));
            await onPcm({version: 1, engine: 'pocket-tts', sampleRate: OMNI_RATE, channels: 1, format: 'f32le', owner, id,
              profile, modelSha256, index: ++packets, offsetFrames: frames, frames: piece.length, pcm: piece.slice(),
              startSeconds: frames / OMNI_RATE});
            frames += piece.length;
            if (progress) progress.emitted = frames / OMNI_RATE;
          }
          try { onPhrase?.({index, role, generated, seconds: pcm.length / OMNI_RATE}); } catch { /* a diagnostic never affects speech */ }
          // Queue the phrase after the next one once there is room for its audio beyond what has been heard.
          const next = index + ahead;
          if (next < phrases.length) {
            while (progress && progress.emitted - progress.heard > maxLeadSeconds) { await sleep(pollMs, signal); throwIfCancelled(signal); }
            queue(next);
          }
        }
      } finally { inner.abort(); signal?.removeEventListener('abort', relay); jobs.clear(); }
      const timing = {...first?.timing, voiceProvider: 'omni', voiceEngine: 'omnivoice', voicePhrases: phrases.length};
      return {frames, chunks: packets, duration: frames / OMNI_RATE, truncated: false, timing};
    },
  };
}
