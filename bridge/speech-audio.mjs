// A response is publishable only after its WAV has been validated and replaced
// atomically. Audioware reads these fixed slots on demand, never from memory.
import {readFile, writeFile, rename, mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {activeMakeupDb, levelWav} from './dialogue-level.mjs';

export const SLOT_COUNT = 8;

// A read-only view for animation analysis. storeSpeech writes the original
// samples, with only the dialogue-level makeup gain and peak limiter applied
// (docs/DIALOGUE_LEVEL.md); no resampling or timing change.
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

export function silentWav() {
  const bytes = Buffer.alloc(44 + 4800);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(24000, 24); bytes.writeUInt32LE(48000, 28);
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36);
  bytes.writeUInt32LE(4800, 40);
  return bytes;
}

export async function initializeAudioDepot(game) {
  const depot = resolve(game, 'r6/audioware/CyberpunkConvai');
  await mkdir(depot, {recursive: true});
  const lines = ['version: 1.0.0', 'voices:'];
  // All supported game locales use the chosen Convai voice. UI language does
  // not silently select another character or regenerate their voice.
  const locales = ['en-us', 'fr-fr', 'it-it', 'de-de', 'es-es', 'es-mx', 'pl-pl',
    'pt-br', 'ru-ru', 'kr-kr', 'zh-cn', 'zh-tw', 'jp-jp', 'ar-ar', 'cz-cz', 'hu-hu', 'tr-tr', 'th-th', 'ua-ua'];
  for (let slot = 0; slot < SLOT_COUNT; slot++) {
    await writeFile(resolve(depot, `reply-${slot}.wav`), silentWav(), {flag: 'wx'}).catch(e => { if (e.code !== 'EEXIST') throw e; });
    lines.push(`  convai_reply_${slot}:`, '    usage: on-demand');
    for (const locale of locales) lines.push(`    ${locale}: reply-${slot}.wav`);
  }
  await writeFile(resolve(depot, 'speech.yml'), lines.join('\n') + '\n');
  return depot;
}

export async function storeSpeech(base64, depot, slot, {makeupDb = activeMakeupDb()} = {}) {
  if (!Number.isInteger(slot) || slot < 0 || slot >= SLOT_COUNT) throw Error('Invalid speech slot');
  if (typeof base64 !== 'string' || base64.length > 32000000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) throw Error('Invalid speech audio');
  const source = Buffer.from(base64, 'base64');
  const info = inspectWav(source);
  // Audioware plays these slots on the game's dialogue track at unity, which is
  // quieter than vanilla dialogue: the same calibrated makeup as the browser
  // path. Matching turned off (0 dB) writes the original bytes unchanged.
  const bytes = makeupDb > 0 ? levelWav(readPcmWav(source), makeupDb) : source;
  const file = resolve(depot, `reply-${slot}.wav`), temp = file + '.tmp';
  await writeFile(temp, bytes);
  await rename(temp, file);
  return {slot, event: `convai_reply_${slot}`, ...info};
}

export async function audioReady(runtime) {
  try {
    const state = JSON.parse(await readFile(resolve(runtime, 'speech-state.json'), 'utf8'));
    return state.available === true && Date.now() - state.updated < 5000;
  } catch { return false; }
}
