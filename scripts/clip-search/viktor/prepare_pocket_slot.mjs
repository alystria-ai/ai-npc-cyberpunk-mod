// Prepare one voice's Pocket voice state offline with the live Pocket config, keeping it on disk ("Keep prepared voices"), and speak one line.
//
//   node prepare_pocket_slot.mjs <project root (the main checkout)> <voice key> <out.wav> "<text>"
//
// Starts the live Pocket worker (CPU) with only this voice in the registry, prepares it with keep = true, so the state file
// <Pocket work dir>/prepared-voices/<key>-<24 hex>.safetensors is written where the bridge looks for it, then synthesizes the line and writes a
// 24 kHz mono WAV.  The file name carries the reference's identity, so an earlier reference's file is simply never used again.  Stop-safe: the
// worker is closed in `finally`.  Do not run it while the bridge's own Pocket worker is running (the work directory has a lock).
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const here = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const [project, key, out, text] = process.argv.slice(2);
const {PocketVoice} = await import(pathToFileURL(resolve(here, 'bridge/pocket-voice.mjs')).href);
const source = JSON.parse((await readFile(resolve(project, 'runtime/pocket-voices.autobest.json'), 'utf8')).replace(/^﻿/, ''));
const {proposal: _p, ...rest} = source;
const work = rest.runtime.workDirectory;
await mkdir(work, {recursive: true});
const config = {...rest, voices: {[key]: source.voices[key]}, preparation: {startupProfiles: [], maxCachedProfiles: 2}};
const configPath = resolve(project, 'runtime', 'pocket-viktor-prepare-config.tmp.json');
await writeFile(configPath, JSON.stringify(config, null, 1));
const logs = [];
const client = new PocketVoice(config, {project, configPath, pythonExecutable: config.runtime.pythonExecutable, keepPreparedVoices: true,
  onLog: line => logs.push(line.slice(0, 300))});
const chunks = [];
try {
  const t0 = performance.now();
  await client.start();
  await client.prepareProfile(key);
  const result = await client.synthesizeStream(key, text, {onPcm: packet => chunks.push(Float32Array.from(packet.pcm))});
  console.log(JSON.stringify({seconds: result.duration, wallMs: Math.round(performance.now() - t0), generationMs: result.timing?.voiceGenerationMs}));
} finally { await client.close(); }
const {rm} = await import('node:fs/promises');
await rm(configPath, {force: true});
const total = chunks.reduce((n, c) => n + c.length, 0);
const pcm = Buffer.alloc(total * 2); let at = 0;
for (const c of chunks) for (const v of c) { pcm.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(v * 32767))), at); at += 2; }
const header = Buffer.alloc(44);
header.write('RIFF', 0); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVEfmt ', 8); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20);
header.writeUInt16LE(1, 22); header.writeUInt32LE(24000, 24); header.writeUInt32LE(48000, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
await mkdir(dirname(out), {recursive: true});
await writeFile(out, Buffer.concat([header, pcm]));
console.log('wrote', out, (total / 24000).toFixed(2), 's', logs.slice(-2).join(' | '));
