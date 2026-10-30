// What a look is made of: for appearance names of a model record, the clothing meshes of each definition, read from the INSTALLED game
// (the mesh check that mod/companion-outfits-data.lua's header demands before a look is listed, docs/COMPANION_OUTFITS.md).
//
//   node scripts/Inspect-OutfitMeshes.mjs --game "E:\SteamLibrary\steamapps\common\Cyberpunk 2077" --record Character.Judy --names judy_default,judy_diving_suit_no_mask [--json out.json]
//   options: --wolvenkit <WolvenKit.CLI.exe>   (default: the vendor folder of the main checkout, found through git)
//            --work <folder>                   (keep the unbundled files there between runs; default: a temp folder that is deleted at the end)
//
// Read only on the game folder. The entity template of the record is unbundled and serialised (the same read as scripts/Extract-CompanionOutfitEvidence.mjs), its
// `appearances[]` give, per look, the `.app` resource and the definition name inside it; that `.app` is unbundled and its definition's components are listed:
// every mesh component with its mesh path, mesh appearance and chunk mask. A look can then be judged by its clothes: undress, wounds, blood and masks show here.
import {readFileSync, writeFileSync, readdirSync, mkdirSync, mkdtempSync, rmSync, existsSync} from 'node:fs';
import {join, resolve, dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {templatesOf} from './Extract-CompanionOutfitEvidence.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const value = x => (x && typeof x === 'object' && '$value' in x ? x.$value : x);
const depot = x => { const v = x?.DepotPath; return typeof v === 'string' ? v : value(v) ?? null; };

/** The (resource, definition name) of each wanted look in a serialised entity template. */
export function entityLooks(json, names) {
  const out = {};
  for (const row of json?.Data?.RootChunk?.appearances ?? []) {
    const name = value(row?.name);
    if (!name || (names && !names.includes(name))) continue;
    out[name] = {resource: depot(row.appearanceResource), definition: value(row.appearanceName)};
  }
  return out;
}

/** The mesh components of one definition of a serialised `.app`: [{name, type, mesh, meshAppearance, chunkMask, visible}]. */
export function definitionMeshes(json, definition) {
  const list = json?.Data?.RootChunk?.appearances ?? [];
  const found = list.map(row => row?.Data ?? row).find(row => value(row?.name) === definition);
  if (!found) return null;
  const meshes = [];
  for (const component of found.components ?? []) {
    const type = component?.$type;
    const mesh = depot(component?.mesh);
    if (!mesh && !/Mesh/.test(type ?? '')) continue;
    meshes.push({name: value(component.name), type, mesh, meshAppearance: value(component.meshAppearance) ?? null,
      chunkMask: value(component.chunkMask) ?? null, visible: component.isEnabled === undefined ? true : component.isEnabled});
  }
  return meshes;
}

function wolvenKit(explicit) {
  if (explicit) return resolve(explicit);
  const common = execFileSync('git', ['rev-parse', '--git-common-dir'], {cwd: root, encoding: 'utf8'}).trim();
  return resolve(root, common, '..', 'vendor', 'wolvenkit-console-9.0.1', 'WolvenKit.CLI.exe');
}

function unbundle(gameRoot, tool, paths, out) {
  const regex = '^(' + [...new Set(paths)].map(path => path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')$';
  for (const folder of ['content', 'ep1']) {
    const dir = join(gameRoot, 'archive', 'pc', folder);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir).filter(file => file.endsWith('.archive') && !/^(?:lang_|audio_)/.test(file))) {
      execFileSync(tool, ['unbundle', join(dir, name), '-o', out, '-r', regex, '-v', 'Quiet'], {stdio: 'ignore'});
    }
  }
  execFileSync(tool, ['convert', 'serialize', out, '-v', 'Quiet'], {stdio: 'ignore'});
}
const fileOf = (out, path) => join(out, ...path.split('\\')) + '.json';

/** Head, hair, nails, decals and proxies are the same in every look of a character: only the clothes tell looks apart. */
const NOT_CLOTHES = /(?:[\\/]|^)(?:h0_|he_|ht_|hx_|hb_|hh_|a0_|an0_)|nails|hair[\\/]|shadow|proxy|waterdrops|[\\/]base_bodies[\\/]/;
export const clothesOf = meshes => (meshes ?? []).filter(mesh => !NOT_CLOTHES.test(mesh.mesh ?? '') && !/^AppearanceProxyMesh$/.test(mesh.name ?? ''));

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const flags = {};
  for (let i = 0; i < args.length; i++) if (args[i].startsWith('--')) flags[args[i].slice(2)] = args[i + 1]?.startsWith('--') || i + 1 >= args.length ? true : args[++i];
  // One record and its names, or --spec a JSON file {record: [names]} (a name list of null means every look the template has).
  const spec = flags.spec ? JSON.parse(readFileSync(resolve(flags.spec), 'utf8')) : flags.record ? {[flags.record]: flags.names ? flags.names.split(',') : null} : null;
  if (!flags.game || !spec) { console.error('usage: node scripts/Inspect-OutfitMeshes.mjs --game <game folder> (--record Character.X [--names a,b] | --spec file.json) [--json out.json] [--all]'); process.exit(2); }
  const gameRoot = resolve(flags.game);
  const tool = wolvenKit(flags.wolvenkit);
  const out = flags.work ? resolve(flags.work) : mkdtempSync(join(tmpdir(), 'outfit-meshes-'));
  mkdirSync(out, {recursive: true});
  try {
    const records = Object.keys(spec);
    const templates = templatesOf(gameRoot, records);
    for (const record of records) if (!templates[record]) throw new Error(`${record}: no entity template`);
    unbundle(gameRoot, tool, Object.values(templates), out);
    const looks = {};
    for (const record of records) looks[record] = entityLooks(JSON.parse(readFileSync(fileOf(out, templates[record]), 'utf8')), spec[record]);
    unbundle(gameRoot, tool, Object.values(looks).flatMap(row => Object.values(row).map(look => look.resource)).filter(Boolean), out);
    const result = {}, cache = new Map();
    const appOf = file => { if (!cache.has(file)) cache.set(file, JSON.parse(readFileSync(file, 'utf8'))); return cache.get(file); };
    for (const record of records) {
      result[record] = {};
      for (const [name, look] of Object.entries(looks[record])) {
        const file = look.resource && fileOf(out, look.resource);
        const meshes = file && existsSync(file) ? definitionMeshes(appOf(file), look.definition) : null;
        result[record][name] = {resource: look.resource, definition: look.definition, meshes};
      }
    }
    if (flags.json) writeFileSync(resolve(flags.json), JSON.stringify(result, null, 1) + '\n');
    for (const [record, rows] of Object.entries(result)) {
      console.log(`== ${record}`);
      for (const [name, row] of Object.entries(rows)) {
        console.log(`${name}  [${row.definition}]`);
        for (const mesh of flags.all ? row.meshes ?? [] : clothesOf(row.meshes)) console.log(`    ${mesh.name}: ${(mesh.mesh ?? '').split('\\').slice(-2).join('/')} ${mesh.meshAppearance ?? ''}${mesh.chunkMask && mesh.chunkMask !== '9223372036854775807' ? ' mask=' + mesh.chunkMask : ''}${mesh.visible === false ? ' (hidden)' : ''}`);
        if (!row.meshes) console.log('    (definition not found)');
      }
    }
  } finally { if (!flags.work) rmSync(out, {recursive: true, force: true}); }
}
