// The prepared voice of a scripted quest line (docs/QUEST_PRIMITIVES.md section 4, docs/BOND_QUESTS.md section 14.2): a line of a story pack ships its audio, rendered
// ahead in the character's voice, and this module hands that file to the mod's own renderer as the same PCM packets every other voice produces. Nothing is generated at
// play time: no model, no voice engine, no worker. The packets go through bridge/pocket-speech.mjs (deliverPocketSpeech), so the lease, the face model and the subtitles
// are those of a live reply.
//
// `createPreparedVoice(...).synthesizeStream(profile, text, options)` has the contract of createOmniPcmVoice's (bridge/omni-pcm.mjs): `onPcm` is awaited packet by packet
// (version 1, engine 'pocket-tts', 24 kHz, mono, f32le, one owner and id, numbered from 1, offset by frame, at most PACKET_FRAMES each), the abort signal stops it, and the
// utterance is told 'pocket' (not a cloud voice). The file is the caller's: `load(profile, text, options)` returns its bytes (bridge/convai-bridge.mjs gives it the
// pack's path through readPreparedFile). A file that cannot be read, is not a PCM WAV or is longer than 60 s throws a plain Error, which the caller turns into the
// subtitle path (the line is shown and never handed to a live voice).
//
// WAV is the supported prepared format now (any rate, mono or stereo, 16/24/32 bit integer or 32 bit float: bridge/omni-pcm.mjs wavToPcm converts it to 24 kHz mono).
// Opus (.ogg) is not decoded here: the renderer page will decode it later, so a pack that ships .ogg needs that step first.
import {readFile, stat} from 'node:fs/promises';
import {createHash, randomBytes} from 'node:crypto';
import {OMNI_RATE, PACKET_FRAMES, wavToPcm} from './omni-pcm.mjs';
import {throwIfCancelled} from './transport-pool.mjs';

export const PREPARED_RATE = OMNI_RATE;
// The longest prepared line (a scripted line is a sentence or two, the longest holocall beats are well under this).
export const PREPARED_MAX_SECONDS = 60;
// readPcmWav (bridge/speech-audio.mjs) refuses a larger file, so checking the size first keeps a wrong file from being read into memory.
export const PREPARED_MAX_BYTES = 24000000;

/** The bytes of a prepared line's file. A path that is not a regular file, or is too large, throws a plain Error before anything is read. */
export async function readPreparedFile(path) {
  if (typeof path !== 'string' || !path) throw Error('A prepared line needs an audio file');
  let info;
  try { info = await stat(path); } catch { throw Error('The prepared audio file cannot be read'); }
  if (!info.isFile()) throw Error('The prepared audio path is not a file');
  if (info.size > PREPARED_MAX_BYTES) throw Error('The prepared audio file is too large');
  try { return await readFile(path); } catch { throw Error('The prepared audio file cannot be read'); }
}

/** A prepared WAV's bytes as 24 kHz mono samples. Throws a plain Error (not a PCM WAV, empty, or longer than maxSeconds). */
export function decodePreparedWav(bytes, {maxSeconds = PREPARED_MAX_SECONDS} = {}) {
  if (!bytes || typeof bytes.length !== 'number' || !bytes.length) throw Error('The prepared audio file is empty');
  let pcm;
  try { pcm = wavToPcm(Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)); }
  catch { throw Error('The prepared audio file is not a supported PCM WAV'); }
  if (pcm.length > maxSeconds * PREPARED_RATE) throw Error(`The prepared audio file is longer than ${maxSeconds} seconds`);
  return pcm;
}

/**
 * load(profile, text, options) -> Promise<Buffer | Uint8Array | Float32Array>, the line's file bytes (or its samples, already decoded). rate: the rate of the packets (24000 only: the renderer's rate).
 * decode(bytes, {maxSeconds}) -> Promise<Float32Array>, optional: turns the file's bytes (any container prepared-audio.mjs knows) into 24 kHz mono samples. It throws a plain Error
 * the caller shows as the subtitle path. Without it the bytes must be a PCM WAV.
 * The result of synthesizeStream is {frames, chunks, duration, truncated: false, timing: {voiceProvider: 'prepared', voiceEngine: 'prepared'}}.
 */
export function createPreparedVoice({load, decode, rate = PREPARED_RATE, maxSeconds = PREPARED_MAX_SECONDS} = {}) {
  if (typeof load !== 'function') throw Error('A prepared voice needs a loader');
  if (rate !== PREPARED_RATE) throw Error('A prepared voice plays at 24000 Hz only');
  if (decode !== undefined && typeof decode !== 'function') throw Error('A prepared voice decoder must be a function');
  let counter = 0;
  return {
    async synthesizeStream(profile, text, options = {}) {
      const {signal, onPcm, utterance} = options;
      if (typeof onPcm !== 'function') throw Error('A prepared voice needs a PCM sink');
      throwIfCancelled(signal);
      utterance?.decide('pocket');
      let bytes;
      try { bytes = await load(profile, text, options); }
      catch (error) { throwIfCancelled(signal); throw error instanceof Error ? error : Error('The prepared audio file cannot be read'); }
      throwIfCancelled(signal);
      let pcm;
      if (bytes instanceof Float32Array) pcm = bytes;
      else if (decode) {
        try { pcm = await decode(bytes, {maxSeconds}); } catch (error) { throwIfCancelled(signal); throw error instanceof Error ? error : Error('The prepared audio file cannot be decoded'); }
        throwIfCancelled(signal);
      } else pcm = decodePreparedWav(bytes, {maxSeconds});
      if (pcm.length > maxSeconds * rate) throw Error(`The prepared audio file is longer than ${maxSeconds} seconds`);
      if (!pcm.length) throw Error('The prepared audio file is empty');
      const owner = randomBytes(16).toString('hex'), id = ++counter;
      const modelSha256 = createHash('sha256').update(`prepared:${profile}`).digest('hex');
      let frames = 0, packets = 0;
      for (let at = 0; at < pcm.length; at += PACKET_FRAMES) {
        throwIfCancelled(signal);
        const piece = pcm.subarray(at, Math.min(pcm.length, at + PACKET_FRAMES));
        await onPcm({version: 1, engine: 'pocket-tts', sampleRate: rate, channels: 1, format: 'f32le', owner, id,
          profile, modelSha256, index: ++packets, offsetFrames: frames, frames: piece.length, pcm: piece.slice(),
          startSeconds: frames / rate});
        frames += piece.length;
        if (options.progress) options.progress.emitted = frames / rate;
      }
      return {frames, chunks: packets, duration: frames / rate, truncated: false, timing: {voiceProvider: 'prepared', voiceEngine: 'prepared'}};
    },
  };
}
