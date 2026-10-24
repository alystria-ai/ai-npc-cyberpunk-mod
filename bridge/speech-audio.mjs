// WAV reading for the voices, and the one check of the game's speech adapter.
// (Until 2026-10-22 this file also wrote the reply WAVs that Audioware played from eight slot files. Every voice now plays through the
// mod's own renderer, so the slots, their manifest and the Audioware depot are gone; removeAudioDepot clears what older versions left.)
import {readFile, readdir, rm, rmdir} from 'node:fs/promises';
import {resolve} from 'node:path';

// A read-only view of a WAV, for animation analysis and for turning a phrase into PCM packets (bridge/omni-pcm.mjs).
export function readPcmWav(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 44 || bytes.length > 24000000
      || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') {
    throw Error('Speech response is not a supported WAV');
  }
  let format, data;
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const size = bytes.readUInt32LE(offset + 4), start = offset + 8;
    if (start + size > bytes.length) throw Error('Truncated speech WAV');
    const tag = bytes.toString('ascii', offset, offset + 4);
    if (tag === 'fmt ' && size >= 16) format = {
      codec: bytes.readUInt16LE(start), channels: bytes.readUInt16LE(start + 2),
      rate: bytes.readUInt32LE(start + 4), align: bytes.readUInt16LE(start + 12),
      bits: bytes.readUInt16LE(start + 14),
    };
    if (tag === 'data') data = bytes.subarray(start, start + size);
    offset = start + size + size % 2;
  }
  if (!format || !data || ![1, 3].includes(format.codec)
      || ![1, 2].includes(format.channels) || format.rate < 8000 || format.rate > 96000
      || ![16, 24, 32].includes(format.bits)
      || (format.codec === 3 && format.bits !== 32)
      || format.align !== format.channels * format.bits / 8 || data.length % format.align) {
    throw Error('Unsupported speech WAV format');
  }
  const duration = data.length / format.align / format.rate;
  if (duration < 0.05 || duration > 120) throw Error('Speech duration is outside the supported range');
  return {duration, sampleRate: format.rate, channels: format.channels, bits: format.bits,
    codec: format.codec, align: format.align, data};
}

export function inspectWav(bytes) {
  const {duration, sampleRate, channels, bits} = readPcmWav(bytes);
  return {duration, sampleRate, channels, bits};
}

// A short silent WAV (24 kHz mono 16-bit, 100 ms): a fixture for tests and tools that need a valid phrase file. Nothing in the bridge plays it.
export function silentWav() {
  const bytes = Buffer.alloc(44 + 4800);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(24000, 24); bytes.writeUInt32LE(48000, 28);
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36);
  bytes.writeUInt32LE(4800, 40);
  return bytes;
}

// What older versions of the mod wrote for Audioware: r6/audioware/CyberpunkConvai holds speech.yml, reply-0..7.wav and reply-pre-*.tmp.
// An Audioware that a player still has would load that manifest for nothing, so the bridge removes these files at start. Only files of
// exactly that shape are touched, the folder only when it is empty afterwards, and nothing else under r6/audioware.
const DEPOT_FILE = /^(?:speech\.yml|reply-[0-7]\.wav(?:\.tmp)?|reply-pre-[0-9a-f-]{36}\.tmp)$/;
export async function removeAudioDepot(game) {
  const depot = resolve(game, 'r6/audioware/CyberpunkConvai');
  let names;
  try { names = await readdir(depot); } catch { return 0; }
  let removed = 0;
  for (const name of names) {
    if (DEPOT_FILE.test(name) && await rm(resolve(depot, name), {force: true}).then(() => true, () => false)) removed++;
  }
  await rmdir(depot).catch(() => {});
  return removed;
}

/**
 * True when the game's speech adapter has answered recently: speech-state.json `available`, which mod/speech.lua sets once its playback adapter loaded.
 * `maxAgeMs`: how old the heartbeat may be (a running voice turn passes a longer one so a stalled game does not end it, bridge/world-session.mjs).
 * The game rewrites the file in place, so a read can land on a half-written (or empty) file: that is read once more 15 ms later before it counts as "not ready".
 */
export async function audioReady(runtime, maxAgeMs = 5000) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const state = JSON.parse(await readFile(resolve(runtime, 'speech-state.json'), 'utf8'));
      return state.available === true && Date.now() - state.updated < maxAgeMs;
    } catch (error) {
      if (attempt === 0 && error instanceof SyntaxError) { await new Promise(done => setTimeout(done, 15)); continue; }
      return false;
    }
  }
  return false;
}
