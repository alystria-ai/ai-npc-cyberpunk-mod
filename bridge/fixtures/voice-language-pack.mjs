// A tiny voice language pack for tests (docs/VOICE_LANGUAGE_PACKS.md): a manifest and a few clips that are generated sine waves, a fraction of a second long.
// Never real game audio. `writePack(root, {...})` writes <root>/multilingual/<language>/ and returns what it wrote.
import {mkdir, writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {dirname, resolve} from 'node:path';

/** A canonical 44-byte-header PCM WAV of a sine wave. Defaults are the pack format: 24 kHz, mono, 16-bit. */
export function sineWav({seconds = 0.4, rate = 24000, channels = 1, bits = 16, frequency = 220, level = 0.3} = {}) {
  const frames = Math.round(seconds * rate), width = bits / 8, align = channels * width, data = Buffer.alloc(frames * align);
  for (let at = 0; at < frames; at++) {
    const value = Math.sin(2 * Math.PI * frequency * at / rate) * level;
    for (let channel = 0; channel < channels; channel++) {
      const place = at * align + channel * width;
      if (bits === 16) data.writeInt16LE(Math.round(value * 32767), place);
      else if (bits === 8) data[place] = Math.round(value * 127 + 128);
      else data.writeIntLE(Math.round(value * 8388607), place, 3);
    }
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'latin1'); header.writeUInt32LE(36 + data.length, 4); header.write('WAVEfmt ', 8, 'latin1');
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(channels, 22); header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * align, 28); header.writeUInt16LE(align, 32); header.writeUInt16LE(bits, 34);
  header.write('data', 36, 'latin1'); header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

/** The voices of the default fake pack: a named character, an archetype, an archetype's second voice, and V (male and female). */
export const FAKE_VOICES = Object.freeze({
  'panam-palmer': {file: 'picked/panam-palmer.wav', text: '我有一个计划，不过得先睡一觉。', gender: 'female', frequency: 200},
  'resident-female': {file: 'archetypes/resident-female.wav', text: '你不用告诉我。', gender: 'female', frequency: 240},
  'npc-maelstrom-male-v2': {file: 'archetypes/npc-maelstrom-male-v2.wav', text: '听着，伙计。', gender: 'male', frequency: 120},
  'v-male': {file: 'v-voice/v-male.wav', text: '走吧。', gender: 'male', frequency: 130},
  'v-female': {file: 'v-voice/v-female.wav', text: '我们走。', gender: 'female', frequency: 230},
});

/**
 * Writes a pack under `root`: manifest.json plus the clips (sine waves of the given length, a different pitch per voice).
 *   language/languageTag   the folder and the reply language code ('zh-cn' / 'zh');
 *   voices                 {key: {file, text, gender, frequency, seconds, wav (bytes to write instead), omit (the file is not written), sha256 (put in the manifest)}};
 *   manifest               edits the manifest object before it is written (a broken pack for a test).
 * Returns {directory, manifest, clips: {key: bytes}}.
 */
export async function writePack(root, {language = 'zh-cn', languageTag = 'zh', voices = FAKE_VOICES, manifest: edit = value => value, withHash = false, version = 1} = {}) {
  const directory = resolve(root, 'multilingual', language), clips = {}, rows = {};
  for (const [key, spec] of Object.entries(voices)) {
    const bytes = spec.wav ?? sineWav({seconds: spec.seconds ?? 0.4, frequency: spec.frequency ?? 200});
    clips[key] = bytes;
    if (!spec.omit) {
      await mkdir(dirname(resolve(directory, spec.file)), {recursive: true});
      await writeFile(resolve(directory, spec.file), bytes);
    }
    rows[key] = {file: spec.file, text: spec.text ?? 'Text.', seconds: spec.seconds ?? 0.4, lines: ['0123456789abcdef'], gender: spec.gender ?? 'female',
      ...(withHash || spec.sha256 ? {sha256: spec.sha256 ?? sha256(bytes)} : {})};
  }
  const manifest = edit({version, language, languageTag, gameLanguage: language, built: '2026-10-21', source: {game: '2.31', lines: 'fixture'}, voices: rows});
  await mkdir(directory, {recursive: true});
  await writeFile(resolve(directory, 'manifest.json'), typeof manifest === 'string' ? manifest : JSON.stringify(manifest, null, 1));
  return {directory, manifest, clips};
}
