#!/usr/bin/env node
// Prints the emotion timeline of the last replies (read-only). For each reply: speaker, time, one line per planned
// part as `[emotion intensity] "text"`, and Convai's own emotion when one arrived.
//
//   node scripts/Show-EmotionTimeline.mjs [--n 5] [--runtime <dir>] [--game-runtime <dir>]
//
// Source: `[EmotionTimeline] {...}` lines in runtime/bridge.stderr.previous.log and runtime/bridge.stderr.log, one per
// reply (bridge/convai-bridge.mjs logEmotionTimeline; that line exists only after the bridge has been restarted with
// it). Until such lines exist, the latest reply alone is read from the game copy's reply.json and
// expression-receipt.json (no history there). Only those named files are opened: never runtime/convai-key.txt or any
// *token* file. A log line carrying an API key or authorization header is skipped.
import {readFile} from 'node:fs/promises';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const PREFIX = '[EmotionTimeline] ';
const API_HEADER = /api[-_ ]?key|authorization\s*:|bearer\s/i;
const here = dirname(fileURLToPath(import.meta.url));
const DEFAULT_RUNTIME = process.env.CYBERPUNK_CONVAI_STATE || resolve(here, '..', 'runtime');
const DEFAULT_GAME_RUNTIME = 'E:\\SteamLibrary\\steamapps\\common\\Cyberpunk 2077\\bin\\x64\\plugins\\cyber_engine_tweaks\\mods\\CyberpunkConvai\\runtime';

function parseArgs(argv) {
  const options = {n: 5, runtime: DEFAULT_RUNTIME, gameRuntime: DEFAULT_GAME_RUNTIME};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = () => {
      if (i + 1 >= argv.length) throw Error(`${flag} needs a value`);
      return argv[++i];
    };
    if (flag === '--n') {
      const n = Number(value());
      if (!Number.isInteger(n) || n < 1) throw Error('--n must be a whole number of at least 1');
      options.n = n;
    } else if (flag === '--runtime') options.runtime = resolve(value());
    else if (flag === '--game-runtime') options.gameRuntime = resolve(value());
    else throw Error(`Unknown option ${flag}`);
  }
  return options;
}

async function readText(path) {
  try { return await readFile(path, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return ''; throw error; }
}

function recordsFromLog(text) {
  const records = [];
  for (const line of text.split(/\r?\n/)) {
    const at = line.indexOf(PREFIX);
    if (at < 0 || API_HEADER.test(line)) continue;
    try {
      const record = JSON.parse(line.slice(at + PREFIX.length));
      if (record && Array.isArray(record.segments)) records.push(record);
    } catch { /* a line interleaved with another writer's output */ }
  }
  return records;
}

// The latest reply only, from the game copy's files: reply.json (text, face track) and expression-receipt.json (plan).
async function latestFromGameRuntime(gameRuntime) {
  const parse = text => { try { return text ? JSON.parse(text) : null; } catch { return null; } };
  const reply = parse(await readText(join(gameRuntime, 'reply.json')));
  const receipt = parse(await readText(join(gameRuntime, 'expression-receipt.json')));
  if (!reply || typeof reply.text !== 'string') return {note: 'No reply.json in the game runtime yet.'};
  if (!receipt?.plan?.segments || receipt.requestId !== reply.requestId) {
    return {note: 'expression-receipt.json does not belong to the latest reply; no timeline to show.'};
  }
  const track = reply.face?.expressionTrack?.segments;
  const segments = receipt.plan.segments.map((segment, i) => {
    const aligned = Array.isArray(track) && track.length === receipt.plan.segments.length && track[i]?.from === segment.from;
    const dominant = segment.dominant ?? null;
    return {from: segment.from, to: segment.to, start: aligned ? track[i].start ?? null : null,
      emotion: dominant, intensity: dominant ? segment.weights?.[dominant] ?? 0 : 0,
      tags: segment.tags ?? [], text: reply.text.slice(segment.from, segment.to)};
  });
  const convai = receipt.basis === 'ordered' || receipt.basis === 'response-id'
    ? {emotion: receipt.convai, scale: receipt.scale ?? null, basis: receipt.basis} : null;
  return {record: {at: new Date(reply.updated ?? receipt.updated).toISOString(), requestId: reply.requestId,
    speaker: reply.profile, profile: reply.profile, provider: receipt.provider ?? null, selector: receipt.selector ?? null,
    summary: receipt.plan.summary ?? null, convai, segments}};
}

const clean = text => String(text ?? '').replace(/\s+/g, ' ').trim();

function formatRecord(record) {
  const lines = [`${record.speaker ?? record.profile ?? 'unknown'}  ${record.at ?? ''}  (${record.provider ?? 'provider ?'}, request ${record.requestId ?? '?'})`];
  for (const segment of record.segments) {
    const intensity = Number(segment.intensity ?? 0).toFixed(2);
    lines.push(`  [${segment.emotion ?? 'calm'} ${intensity}] "${clean(segment.text)}"`);
  }
  if (record.convai) {
    const scale = record.convai.scale == null ? '' : `, scale ${record.convai.scale}`;
    lines.push(`  Provider emotion: ${record.convai.emotion}${scale} (${record.convai.basis})`);
  }
  return lines.join('\n');
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  let records = [];
  for (const name of ['bridge.stderr.previous.log', 'bridge.stderr.log']) {
    records = records.concat(recordsFromLog(await readText(join(options.runtime, name))));
  }
  const out = [];
  if (!records.length) {
    const latest = await latestFromGameRuntime(options.gameRuntime);
    out.push('No [EmotionTimeline] lines in the bridge logs yet (restart the bridge to start logging every reply).');
    if (latest.record) {
      out.push('Showing the latest reply only, from the game runtime reply.json and expression-receipt.json:', '');
      records = [latest.record];
    } else out.push(latest.note);
  }
  const shown = records.slice(-options.n);
  if (shown.length) out.push(shown.map(formatRecord).join('\n\n'));
  process.stdout.write(out.join('\n') + '\n');
}

main().catch(error => {
  process.stderr.write(`Show-EmotionTimeline: ${error.message}\n`);
  process.exitCode = 1;
});
