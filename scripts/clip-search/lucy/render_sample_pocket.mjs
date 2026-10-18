// Render one sample line in Lucy Kushinada's Pocket voice, offline: the live Pocket student on the CPU, her live reference from
// runtime/pocket-voices.autobest.json, no game and no bridge.  Writes a 24 kHz mono 16-bit WAV.
// Usage: node render_sample_pocket.mjs <project root (the main checkout)> <work dir> <out.wav> "<text>"
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const [project, work, out, text] = process.argv.slice(2);
const {PocketVoice} = await import(pathToFileURL(resolve(project, 'bridge/pocket-voice.mjs')).href);
const source = JSON.parse((await readFile(resolve(project, 'runtime/pocket-voices.autobest.json'), 'utf8')).replace(/^\uFEFF/, ''));
const key = 'lucy-kushinada';
const workDirectory = resolve(work, 'pocket-work'); await mkdir(workDirectory, {recursive: true});
const {proposal: _p, ...rest} = source;
const config = {...rest, runtime: {...rest.runtime, workDirectory}, voices: {[key]: source.voices[key]}, preparation: {startupProfiles: [], maxCachedProfiles: 2}};
const configPath = resolve(work, 'pocket-sample-config.json');
await writeFile(configPath, JSON.stringify(config, null, 1));
const logs = [];
const client = new PocketVoice(config, {project, configPath, pythonExecutable: config.runtime.pythonExecutable, onLog: line => logs.push(line.slice(0, 300))});
const chunks = [];
try {
  const t0 = performance.now();
  await client.start();
  await client.prepareProfile(key);
  const result = await client.synthesizeStream(key, text, {onPcm: packet => chunks.push(Float32Array.from(packet.pcm))});
  console.log(JSON.stringify({seconds: result.duration, wallMs: Math.round(performance.now() - t0), generationMs: result.timing?.voiceGenerationMs}));
} finally { await client.close(); }
const total = chunks.reduce((n, c) => n + c.length, 0);
const pcm = Buffer.alloc(total * 2); let at = 0;
for (const c of chunks) for (const v of c) { pcm.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(v * 32767))), at); at += 2; }
const header = Buffer.alloc(44);
header.write('RIFF', 0); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVEfmt ', 8); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20);
header.writeUInt16LE(1, 22); header.writeUInt32LE(24000, 24); header.writeUInt32LE(48000, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
await writeFile(out, Buffer.concat([header, pcm]));
console.log('wrote', out, (total / 24000).toFixed(2), 's', logs.slice(-2).join(' | '));
