// Which story pack lines have no prepared audio (docs/QUEST_LINE_AUDIO.md). Offline, reads only. Does not make any audio: the audio is generated on the owner's PC.
//
//   node scripts/Check-QuestLineAudio.mjs [--packs <folder>] [--audio-dir <folder>] [--list <file>] [--out <file>] [--json] [--strict]
//
// For every pack in the folder (default characters/bond-packs) it collects the lines a quest can SAY: the `say` rows of every stage and ending, and the `say` steps of every
// scripted call. A `text` row (a Phone Chat message) and a call's `text` need no audio. Each spoken line is looked up exactly as the bridge does at play time
// (bridge/bond-pack-runner.mjs lineFor): the line has an `audio` field (audio/<name>.wav inside the pack) and that file is in <packs>/<pack id>/. With --audio-dir the file
// is also looked for by name, <dir>/<pack id>/<audio or audio/<line id>>.(wav|ogg|opus|flac|mp3), and with --list (a JSON {"<pack id>": ["<line id>", ...]} or a text file of
// "<pack id>/<line id>" rows) a line named there counts as prepared. A line used but not defined in its pack is a pack error and is listed apart.
// Exit status 0, or 1 with --strict when a spoken line has no audio or is undefined.
import {existsSync, readFileSync, writeFileSync, readdirSync} from 'node:fs';
import {resolve, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const DEFAULT_PACKS = fileURLToPath(new URL('../characters/bond-packs/', import.meta.url));
const EXTENSIONS = ['wav', 'ogg', 'opus', 'flac', 'mp3'];

/** The spoken line ids of a pack, in the order they first appear: {spoken: [id], texts: [id]}. */
export function usedLines(pack) {
  const spoken = new Set(), texts = new Set();
  const rows = list => { for (const row of Array.isArray(list) ? list : []) {
    if (row && typeof row === 'object' && typeof row.say === 'string') spoken.add(row.say);
    if (row && typeof row === 'object' && typeof row.text === 'string') texts.add(row.text);
  } };
  for (const stage of pack.stages ?? []) rows(stage.script);
  for (const ending of Object.values(pack.endings ?? {})) rows(ending?.script);
  for (const call of Object.values(pack.calls ?? {})) {
    for (const step of call?.steps ?? []) if (typeof step?.say === 'string') spoken.add(step.say);
    if (typeof call?.text === 'string') texts.add(call.text);
  }
  return {spoken: [...spoken], texts: [...texts]};
}

/** What is wrong with one pack's audio: {used, undefined, missing, prepared}. `prepared(packId, lineId, line)` is true when audio is known to exist. */
export function checkPack(pack, {folder, audioDir = null, listed = new Set()} = {}) {
  const {spoken} = usedLines(pack);
  const out = {pack: pack.id, spoken, undefinedLines: [], missing: [], prepared: []};
  for (const id of spoken) {
    const line = pack.lines?.[id];
    if (!line) { out.undefinedLines.push(id); continue; }
    let found = false;
    if (typeof line.audio === 'string' && folder && existsSync(resolve(folder, pack.id, line.audio))) found = true;
    if (!found && audioDir) {
      const names = [line.audio, `audio/${id}`, id].filter(Boolean).map(name => name.replace(/\.(wav|ogg|opus|flac|mp3)$/, ''));
      found = names.some(name => EXTENSIONS.some(ext => existsSync(resolve(audioDir, pack.id, `${name}.${ext}`))));
    }
    if (!found && listed.has(`${pack.id}/${id}`)) found = true;
    (found ? out.prepared : out.missing).push(id);
  }
  return out;
}

function readList(file) {
  const listed = new Set();
  const text = readFileSync(file, 'utf8');
  try {
    const value = JSON.parse(text);
    for (const [pack, ids] of Object.entries(value ?? {})) for (const id of Array.isArray(ids) ? ids : []) listed.add(`${pack}/${id}`);
  } catch {
    for (const row of text.split(/\r?\n/)) { const trimmed = row.trim(); if (trimmed && !trimmed.startsWith('#')) listed.add(trimmed); }
  }
  return listed;
}

export function loadPacks(folder) {
  return readdirSync(folder).filter(name => name.endsWith('.json')).sort().map(name => JSON.parse(readFileSync(join(folder, name), 'utf8')));
}

export function report(results) {
  const total = results.reduce((sum, row) => sum + row.spoken.length, 0), missing = results.reduce((sum, row) => sum + row.missing.length, 0);
  const undefinedCount = results.reduce((sum, row) => sum + row.undefinedLines.length, 0);
  const lines = [`Spoken lines in ${results.length} packs: ${total}. With prepared audio: ${total - missing - undefinedCount}. Missing audio: ${missing}. Used but not defined: ${undefinedCount}.`, ''];
  for (const row of results) {
    if (!row.missing.length && !row.undefinedLines.length) continue;
    lines.push(`${row.pack} (${row.missing.length} of ${row.spoken.length} missing)${row.undefinedLines.length ? ` UNDEFINED: ${row.undefinedLines.join(', ')}` : ''}`);
    lines.push(`  ${row.missing.join(' ')}`);
  }
  return lines.join('\n') + '\n';
}

function main(argv) {
  const get = name => { const index = argv.indexOf(name); return index >= 0 ? argv[index + 1] : null; };
  const folder = resolve(get('--packs') ?? DEFAULT_PACKS);
  const audioDir = get('--audio-dir') ? resolve(get('--audio-dir')) : null;
  const listed = get('--list') ? readList(resolve(get('--list'))) : new Set();
  const results = loadPacks(folder).map(pack => checkPack(pack, {folder, audioDir, listed}));
  const body = argv.includes('--json') ? JSON.stringify(results.map(({pack, spoken, missing, undefinedLines}) => ({pack, spoken: spoken.length, missing, undefinedLines})), null, 2) + '\n' : report(results);
  if (get('--out')) writeFileSync(resolve(get('--out')), body); else process.stdout.write(body);
  const bad = results.some(row => row.missing.length || row.undefinedLines.length);
  if (argv.includes('--strict') && bad) process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main(process.argv.slice(2));
