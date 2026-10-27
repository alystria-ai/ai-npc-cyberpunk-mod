// A stand-in for bridge/resident-voice-worker.py that speaks its JSON-lines protocol (version 2) without a model, for the tests of the OmniVoice server
// (bridge/omni-server.test.mjs): a test copies it to <project>/bridge/resident-voice-worker.py and runs it with node. A voice is available when its clip is a
// file of the folder FAKE_REFERENCES (or of the player folder for runtime/player-voices/...) whose hash is the descriptor's, like the real worker's check.
// FAKE_EXIT=<code> ends the process at once (78: no CUDA). The text "SLOW:<ms> ..." delays the answer, "CRASH" ends the process, "REFUSE" answers an error frame.
'use strict';
const fs = require('fs'), path = require('path'), crypto = require('crypto');
if (process.env.FAKE_EXIT) process.exit(Number(process.env.FAKE_EXIT));
const config = JSON.parse(fs.readFileSync(process.argv[process.argv.indexOf('--config') + 1], 'utf8').replace(/^﻿/, ''));
const references = process.env.FAKE_REFERENCES || '';
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
let players = config.playerVoiceDirectory || null;
const voices = {}, available = {}, prepared = [];
function fileOf(descriptor) {
  const ref = descriptor.reference || '';
  if (ref.startsWith('runtime/player-voices/')) return players ? path.join(players, ref.slice('runtime/player-voices/'.length)) : null;
  return references ? path.join(references, ref.replace('runtime/voice-references/', '')) : null;
}
function check(key, descriptor) {
  delete available[key];
  if ((descriptor.status || 'ready') !== 'ready') return;
  const file = fileOf(descriptor);
  try { if (file && sha(fs.readFileSync(file)) === descriptor.sha256) available[key] = descriptor; } catch { /* unavailable */ }
}
for (const [key, descriptor] of Object.entries(config.voices || {})) { voices[key] = descriptor; check(key, descriptor); }
function wav(seconds) {
  const frames = Math.round(24000 * seconds), bytes = Buffer.alloc(44 + frames * 2);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(24000, 24); bytes.writeUInt32LE(48000, 28);
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(frames * 2, 40);
  for (let at = 0; at < frames; at++) bytes.writeInt16LE(Math.round(Math.sin(at / 20) * 3000), 44 + at * 2);
  return bytes;
}
const hashes = () => ({
  referenceHashes: Object.fromEntries(Object.entries(available).map(([key, value]) => [key, value.sha256])),
  transcriptHashes: Object.fromEntries(Object.entries(available).map(([key, value]) => [key, sha(Buffer.from(value.transcript, 'utf8'))]))});
const limit = (config.preparation && config.preparation.maxCachedProfiles) || 8;
function keep(key) { const at = prepared.indexOf(key); if (at >= 0) prepared.splice(at, 1); prepared.push(key); while (prepared.length > limit) prepared.shift(); }
send({op: 'state', state: 'loading'});
for (const key of (config.preparation && config.preparation.startupProfiles) || []) if (available[key]) keep(key);
setTimeout(() => send({op: 'ready', protocolVersion: 2, profiles: Object.keys(available), preparedProfiles: [...prepared], ...hashes(), device: 'cuda:0',
  dtype: 'torch.float16', runtime: 'pytorch', tensorrt: false, compiled: false, acceleration: 'eager', cudaGraph: null, cudaAllocatedMiB: 1, cudaReservedMiB: 2}), Number(process.env.FAKE_LOAD_MS || 0));
let queue = Promise.resolve();
const sleep = ms => new Promise(done => setTimeout(done, ms));
function handle(request) {
  if (request.op === 'voices') {
    if (request.playerVoiceDirectory) players = request.playerVoiceDirectory;
    const changed = [];
    for (const key of request.remove || []) { delete voices[key]; delete available[key]; changed.push(key); const at = prepared.indexOf(key); if (at >= 0) prepared.splice(at, 1); }
    for (const [key, descriptor] of Object.entries(request.set || {})) { voices[key] = descriptor; check(key, descriptor); changed.push(key); const at = prepared.indexOf(key); if (at >= 0) prepared.splice(at, 1); }
    send({op: 'voices', id: request.id, profiles: Object.keys(available), preparedProfiles: [...prepared], ...hashes(), changed});
    return;
  }
  const profile = request.profile;
  if (request.op === 'prepare') {
    const frame = {op: 'prepared', id: request.id, profile, generationMs: 3};
    if (request.languageReference) frame.languageReference = references && fs.existsSync(path.join(references, request.languageReference.reference.replace('runtime/voice-references/', ''))) ? 'used' : 'fallback';
    else keep(profile);
    send({...frame, preparedProfiles: [...prepared]});
    return;
  }
  const text = String(request.text || '');
  if (/CRASH/.test(text)) process.exit(1);
  if (/REFUSE/.test(text)) { send({op: 'error', id: request.id, profile, steps: request.steps, preparedProfiles: [...prepared]}); return; }
  const slow = /^SLOW:(\d+)/.exec(text);
  return (slow ? sleep(Number(slow[1])) : Promise.resolve()).then(() => {
    if (!request.languageReference) keep(profile);
    send({op: 'audio', id: request.id, profile, steps: request.steps, audio: wav(0.3).toString('base64'), generationMs: 7, acceleration: 'eager', cudaGraph: null,
      preparedProfiles: [...prepared], ...(request.languageReference ? {languageReference: 'used'} : {})});
  });
}
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', part => {
  buffer += part;
  let end;
  while ((end = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
    if (line.trim()) { const request = JSON.parse(line); queue = queue.then(() => handle(request)); }
  }
});
process.stdin.on('end', () => queue.then(() => process.exit(0)));
