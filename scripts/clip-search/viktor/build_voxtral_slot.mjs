// Build one voice's pre-built Mistral (Voxtral) reference slot offline: no network, no key, no Mistral call.
//
//   node build_voxtral_slot.mjs <project root (the main checkout, which holds runtime/)> <out dir> <voice key>
//
// The same call a conversation makes and packaging/build-release.mjs `voxtralCache` makes (VoxtralVoice.build with the bridge's reference preparer: mono
// 24 kHz, cut at a pause to about 8.5 s, Ogg Vorbis q2 with ffmpeg), over the registries in the bridge's order (OmniVoice long, OmniVoice short, Pocket)
// read from the live autobest configs.  Writes <out dir>/<key>.json (+ .ogg) and prints the slot.  ffmpeg must be on PATH (or CYBERPUNK_CONVAI_FFMPEG).
import {readFile} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const here = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const [project, outDir, key] = process.argv.slice(2);
const bridge = name => import(pathToFileURL(resolve(here, 'bridge', name)).href);
const {VoxtralVoice} = await bridge('voxtral-voice.mjs');
const {createReferencePreparer, findFfmpeg} = await bridge('voxtral-reference.mjs');
const {createVoiceProfileRegistry} = await bridge('voice-profile-registry.mjs');
if (!await findFfmpeg()) throw Error('ffmpeg is needed to build the compressed reference');
const read = file => readFile(resolve(project, 'runtime', file), 'utf8').then(text => JSON.parse(text.replace(/^﻿/, '')));
const pocket = await read('pocket-voices.autobest.json');   // wrapped as an OmniVoice list, like the release builder does
const configs = [await read('local-voices.autobest-long.json'), await read('local-voices.autobest-short.json'), {version: 2, provider: 'hybrid', engine: 'omnivoice', voices: pocket.voices}];
const voice = new VoxtralVoice({getKey: () => null, referenceRoot: resolve(project, 'runtime/voice-references'), registry: configs.map(createVoiceProfileRegistry),
  read: path => readFile(path), prepare: createReferencePreparer({cacheDirectory: resolve(outDir), onLog: message => console.log('prepare:', message)})});
const made = await voice.build(key);
if (!made) throw Error(`no reference could be prepared for ${key}`);
console.log(JSON.stringify({key, format: made.format, source: made.source, bytes: made.bytes, originalBytes: made.originalBytes, cached: made.cached}));
