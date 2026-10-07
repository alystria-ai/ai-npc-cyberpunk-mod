// Real local smoke test and latency measurement for the voice workers (game closed, no bridge needed).
//
//   node scripts/Measure-VoiceStartup.mjs pocket [--voice judy-alvarez] [--keep on|off] [--restarts 2] [--clear]
//   node scripts/Measure-VoiceStartup.mjs omni   [--voice judy-alvarez] [--reference short|long] [--steps 16|32] [--keep on|off]
//   options: --config <file> (default: the file runtime/voice-configs.json names), --text "<line>", --wav <out.wav>,
//            --extra jackie-welles,... (more voices prepared and timed), --lines 3
//
// pocket: starts the worker `--restarts` times (a fresh process each time, like a new game session), and each time
//   prepares the voice (what summoning does), then streams one line. With --keep on the first start saves the voice
//   setup and later starts load it; --clear removes the saved setups first. Prints the voice preparation time,
//   where it came from (computed / disk / memory), time to first audio and the size of the saved file.
// omni: starts the GPU worker, prepares the voice (the join-time step), then renders the line(s) at the chosen
//   steps; prints the prepare time and every render.
// Close the game first: both engines use the machine. Run from a Balanced/Performance power profile for numbers
// that mean anything; the report should say which profile was active.
import {readFileSync, readdirSync, statSync, writeFileSync, mkdirSync, rmSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {PocketVoice} from '../bridge/pocket-voice.mjs';
import {ResidentVoice} from '../bridge/resident-voice.mjs';
import {resolveVoiceConfigPaths} from '../bridge/voice-config-paths.mjs';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const [engine, ...rest] = process.argv.slice(2);
const option = (name, fallback) => { const at = rest.indexOf(`--${name}`); return at < 0 ? fallback : (rest[at + 1]?.startsWith('--') || rest[at + 1] === undefined ? true : rest[at + 1]); };
const voice = option('voice', 'judy-alvarez');
const extra = String(option('extra', '')).split(',').filter(Boolean);
const keep = option('keep', 'on') !== 'off';
const text = option('text', 'I have been thinking about what you said last night, and honestly, I am not sure you are wrong about her.');
const paths = resolveVoiceConfigPaths(resolve(project, 'runtime'));
const configPath = option('config') ? resolve(option('config')) : (engine === 'pocket' ? paths.pocket : paths.omni[option('reference', 'long')]);
const config = JSON.parse(readFileSync(configPath, 'utf8').replace(/^﻿/, ''));
const round = value => Math.round(value * 10) / 10;
const wavBytes = (samples, rate = 24000) => {
  const pcm = Buffer.alloc(samples.length * 2);
  samples.forEach((sample, at) => pcm.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(sample * 32767))), at * 2));
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVEfmt ', 8); header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22); header.writeUInt32LE(rate, 24); header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
};
const report = {engine, configPath, voice, keepPreparedVoices: keep, at: new Date().toISOString()};
const log = line => process.stderr.write(line.slice(0, 200).replace(/\r?\n/g, ' ') + '\n');

async function pocket() {
  const cache = resolve(config.runtime.workDirectory, 'prepared-voices');
  if (option('clear', false)) rmSync(cache, {recursive: true, force: true});
  report.starts = [];
  for (let start = 0; start < Number(option('restarts', 2)); start++) {
    const worker = new PocketVoice(config, {project, configPath, pythonExecutable: config.runtime.pythonExecutable,
      keepPreparedVoices: keep, onLog: log});
    const entry = {start: start + 1, voices: []};
    const t0 = performance.now();
    await worker.start();
    entry.readyMs = round(performance.now() - t0);
    for (const key of [voice, ...extra]) {
      const t = performance.now();
      const receipt = await worker.prepareProfile(key);
      const voiceEntry = {voice: key, prepareWallMs: round(performance.now() - t), preparationMs: round(receipt.preparationMs ?? 0),
        source: receipt.preparationSource};
      if (key === voice) {
        const samples = [];
        for (let line = 0; line < Number(option('lines', 2)); line++) {
          const queued = performance.now(); let first;
          const result = await worker.synthesizeStream(key, text, {onPcm: packet => {
            first ??= performance.now() - queued;
            if (line === 0) samples.push(...packet.pcm);
          }});
          (voiceEntry.lines ??= []).push({firstAudioMs: round(first), generationMs: round(result.timing.voiceGenerationMs),
            audioSeconds: round(result.duration), source: result.timing.voicePreparationSource});
        }
        if (option('wav') && start === 0) writeFileSync(resolve(String(option('wav'))), wavBytes(Float32Array.from(samples)));
      }
      entry.voices.push(voiceEntry);
    }
    await worker.close();
    report.starts.push(entry);
  }
  try {
    report.savedFiles = readdirSync(cache).filter(name => name.endsWith('.safetensors')).map(name => ({
      name, mebibytes: round(statSync(resolve(cache, name)).size / 1048576)}));
  } catch { report.savedFiles = []; }
}

async function omni() {
  const steps = Number(option('steps', 16));
  const worker = new ResidentVoice(config, {project, configPath, onLog: log});
  worker.setKeepPrepared?.(keep);
  worker.setSteps(steps);
  const t0 = performance.now();
  await worker.start();
  report.readyMs = round(performance.now() - t0);
  report.steps = steps; report.reference = option('reference', 'long'); report.voices = [];
  for (const key of [voice, ...extra]) {
    const t = performance.now();
    await worker.prepareProfile(key);
    const entry = {voice: key, prepareMs: round(performance.now() - t), lines: []};
    if (key === voice) {
      for (let line = 0; line < Number(option('lines', 3)); line++) {
        const started = performance.now();
        const result = await worker.synthesize(key, text, {steps});
        entry.lines.push({firstAudioMs: round(performance.now() - started), generationMs: round(result.timing.voiceGenerationMs),
          audioSeconds: round(result.wav.duration ?? result.wav.seconds ?? 0)});
        if (option('wav') && line === 0) writeFileSync(resolve(String(option('wav'))), Buffer.from(result.audio, 'base64'));
      }
    }
    report.voices.push(entry);
  }
  await worker.close();
}

if (engine === 'pocket') await pocket();
else if (engine === 'omni') await omni();
else { console.error('usage: node scripts/Measure-VoiceStartup.mjs pocket|omni [options]'); process.exit(2); }
console.log(JSON.stringify(report, null, 2));
