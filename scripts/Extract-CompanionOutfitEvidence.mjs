// The evidence behind mod/companion-outfits-data.lua (docs/COMPANION_OUTFITS.md): for every model record the list names, the entity template of the record
// and the appearance names that template lists, read from the INSTALLED game, once per game version.
//
//   node scripts/Extract-CompanionOutfitEvidence.mjs --game "E:\SteamLibrary\steamapps\common\Cyberpunk 2077" --game "E:\SteamLibrary\Cyberpunk2077-2.31"
//   node scripts/Extract-CompanionOutfitEvidence.mjs --game <root> [--game <root>] --check      (compare with the committed file, write nothing)
//   options: --wolvenkit <WolvenKit.CLI.exe>   (default vendor\wolvenkit-console-9.0.1\WolvenKit.CLI.exe of the main checkout, found through git)
//
// Read-only on the game folders. Nothing is installed: the template of a record is read from the shipped REDmod tweak sources (tools/redmod/tweaks,
// entityTemplatePath, through the parent records), the template file is unbundled and serialised by the pinned WolvenKit CLI into a temp folder, and
// its `appearances[].name` list is what ScheduleAppearanceChange accepts for that entity. Two games must list identical names for a record or the
// script fails: the list is one table for both builds.
import {readFileSync, writeFileSync, readdirSync, statSync, mkdirSync, mkdtempSync, rmSync, existsSync} from 'node:fs';
import {join, resolve, dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = join(root, 'mod', 'companion-outfits-data.lua');
const EVIDENCE = join(root, 'characters', 'companion-outfit-evidence.json');

/** The records and outfit names of mod/companion-outfits-data.lua (the file is read as text: one record per line, one outfit per line). */
export function readOutfitList(text) {
  const characters = {};
  let current = null;
  for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
    const head = /\['(Character\.[^']+)'\] = \{base = '([^']+)'/.exec(line);
    if (head) { current = characters[head[1]] = {base: head[2], outfits: []}; continue; }
    const row = /^\s*\{'([^']+)', '(\w+)'\}/.exec(line);
    if (row && current) current.outfits.push(row[1]);
  }
  return characters;
}

/** record name -> {template, defaultAppearance} from every .tweak under the game's tools/redmod/tweaks, following parents. */
export function templatesOf(gameRoot, records) {
  const files = [];
  (function walk(dir) {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path); else if (name.endsWith('.tweak')) files.push(path);
    }
  })(join(gameRoot, 'tools', 'redmod', 'tweaks'));
  const known = new Map();
  const pattern = /^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*([A-Za-z_][A-Za-z0-9_.]*)\s*\{/gm;
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    let match;
    pattern.lastIndex = 0;
    while ((match = pattern.exec(text))) {
      const end = text.indexOf('\n}', pattern.lastIndex);
      const body = end < 0 ? '' : text.slice(pattern.lastIndex, end);
      known.set(match[1], {parent: match[2].replace(/^Character\./, ''),
        template: /entityTemplatePath\s*=\s*"([^"]+)"/.exec(body)?.[1] ?? null});
    }
  }
  const resolveTemplate = (name, depth = 0) => {
    const row = known.get(name);
    if (!row || depth > 12) return null;
    return row.template ?? resolveTemplate(row.parent, depth + 1);
  };
  return Object.fromEntries(records.map(record => [record, resolveTemplate(record.replace(/^Character\./, ''))]));
}

/** The appearance names and the default of a serialised entity template (WolvenKit JSON). */
export function appearancesOf(json) {
  const value = x => (x && typeof x === 'object' ? x.$value : x);
  const rootChunk = json?.Data?.RootChunk;
  return {default: value(rootChunk?.defaultAppearance) ?? null, names: (rootChunk?.appearances ?? []).map(row => value(row?.name)).filter(Boolean)};
}

function wolvenKit(explicit) {
  if (explicit) return resolve(explicit);
  const common = execFileSync('git', ['rev-parse', '--git-common-dir'], {cwd: root, encoding: 'utf8'}).trim();
  return resolve(root, common, '..', 'vendor', 'wolvenkit-console-9.0.1', 'WolvenKit.CLI.exe');
}

function readGame(gameRoot, templates, tool) {
  const out = mkdtempSync(join(tmpdir(), 'outfit-evidence-'));
  try {
    const paths = [...new Set(Object.values(templates).filter(Boolean))];
    const regex = '^(' + paths.map(path => path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')$';
    for (const folder of ['content', 'ep1']) {
      const dir = join(gameRoot, 'archive', 'pc', folder);
      if (!existsSync(dir)) continue;
      for (const name of readdirSync(dir).filter(file => file.endsWith('.archive') && !/^(?:lang_|audio_)/.test(file))) {
        execFileSync(tool, ['unbundle', join(dir, name), '-o', out, '-r', regex, '-v', 'Quiet'], {stdio: 'ignore'});
      }
    }
    execFileSync(tool, ['convert', 'serialize', out, '-v', 'Quiet'], {stdio: 'ignore'});
    const result = {};
    for (const path of paths) {
      const file = join(out, ...path.split('\\')) + '.json';
      if (!existsSync(file)) throw new Error(`${gameRoot}: ${path} was not found in the archives`);
      result[path] = appearancesOf(JSON.parse(readFileSync(file, 'utf8')));
    }
    return result;
  } finally { rmSync(out, {recursive: true, force: true}); }
}

export function buildEvidence(list, games) {
  const records = {};
  for (const [record, character] of Object.entries(list).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    let agreed = null;
    for (const game of games) {
      const template = game.templates[record];
      if (!template) throw new Error(`${record}: no entity template in ${game.root}`);
      const row = game.read[template];
      for (const name of character.outfits) if (!row.names.includes(name)) throw new Error(`${record}: ${name} is not listed by ${template} (${game.root})`);
      const seen = JSON.stringify([template, row.default, [...row.names].sort()]);
      if (agreed !== null && agreed.key !== seen) throw new Error(`${record}: the games list different appearances`);
      agreed = {key: seen, template, default: row.default, names: [...row.names].sort()};
    }
    records[record] = {template: agreed.template.replace(/\\/g, '/'), templateDefault: agreed.default, listedAppearances: agreed.names};
  }
  return records;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const roots = [], flags = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--game') roots.push(resolve(args[++i]));
    else if (args[i] === '--wolvenkit') flags.wolvenkit = args[++i];
    else if (args[i] === '--check') flags.check = true;
  }
  if (!roots.length) { console.error('usage: node scripts/Extract-CompanionOutfitEvidence.mjs --game <game folder> [--game <second game folder>] [--check]'); process.exit(2); }
  const list = readOutfitList(readFileSync(DATA, 'utf8'));
  const tool = wolvenKit(flags.wolvenkit);
  const games = roots.map(gameRoot => {
    const templates = templatesOf(gameRoot, Object.keys(list));
    return {root: gameRoot, templates, read: readGame(gameRoot, templates, tool)};
  });
  const records = buildEvidence(list, games);
  const old = existsSync(EVIDENCE) ? JSON.parse(readFileSync(EVIDENCE, 'utf8')) : {about: '', records: {}};
  if (flags.check) {
    const same = JSON.stringify(records) === JSON.stringify(old.records);
    console.log(same ? 'the evidence file matches the installed game' : 'the evidence file differs from the installed game');
    process.exit(same ? 0 : 1);
  }
  mkdirSync(dirname(EVIDENCE), {recursive: true});
  writeFileSync(EVIDENCE, JSON.stringify({about: old.about, records}, null, 1) + '\n');
  console.log(`${Object.keys(records).length} records written to characters/companion-outfit-evidence.json`);
}
