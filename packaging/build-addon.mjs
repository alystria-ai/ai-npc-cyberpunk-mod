#!/usr/bin/env node
// Builds one add-on's own download (docs/ADDON_API.md, "Packaging"). Each add-on is its own Nexus page and its own zip:
//   CyberpunkConvai-<Name>-<version>.zip
//     bin/x64/plugins/cyber_engine_tweaks/mods/CyberpunkConvai<Name>/<the add-on folder's files>
// The main mod's packages (packaging/build-release.mjs) never include addons/, and an add-on zip never includes a main mod
// file: it is a separate CET mod folder that only talks to the main mod through GetMod('CyberpunkConvai').addons and its
// convai-addon.json manifest.
//
// Works on any add-on folder, in this repository (addons/example) or outside it. Skippy and Delamain live in repositories of their
// own, each with a self-contained copy of this builder (tools/build.mjs there, same files and same bytes): keep the rules in step.
//
// Usage: node packaging/build-addon.mjs <add-on folder> [--out dist/addons]
import {mkdir, readFile, readdir, rm} from 'node:fs/promises';
import {basename, relative, resolve, sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {ZipWriter, listZip} from './lib/zip.mjs';
import {ADDON_MANIFEST, CET_MODS, validateManifest} from '../bridge/addons.mjs';

/** Files an add-on may ship: its CET Lua, its manifest and data, its bridge module, voice references and notes. */
const SHIPPED = /\.(?:lua|json|mjs|js|wav|txt|md)$/i;
/** Never shipped: tests, evaluation scripts (eval/), dotfiles, dependency folders. */
const SKIPPED = rel => /(?:^|\/)(?:\.|node_modules\/|test\/|tests\/|eval\/)/.test(rel) || /\.test\.m?js$/i.test(rel);

/** The CET mod folder of an add-on: "skippy" -> "CyberpunkConvaiSkippy", "delamain-cab" -> "CyberpunkConvaiDelamainCab". */
export function addonFolderName(id) {
  return 'CyberpunkConvai' + id.split('-').map(part => part.charAt(0).toUpperCase() + part.slice(1)).join('');
}

/** The zip's base name: "CyberpunkConvai-Skippy-1.0.0". */
export function addonArchiveName(manifest) {
  return `${addonFolderName(manifest.id).replace(/^CyberpunkConvai/, 'CyberpunkConvai-')}-${manifest.version}`;
}

async function walk(root, dir = root) {
  const out = [];
  for (const entry of await readdir(dir, {withFileTypes: true})) {
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) out.push(...await walk(root, path));
    else if (entry.isFile()) out.push(relative(root, path).split(sep).join('/'));
  }
  return out.sort();
}

/**
 * What the zip will hold: [{name, source}]. Throws when the folder is not a valid add-on (manifest, init.lua, the bridge
 * module and every voice reference named in the manifest must be inside it).
 */
export async function addonEntries(dir) {
  const root = resolve(dir);
  const manifest = validateManifest(JSON.parse((await readFile(resolve(root, ADDON_MANIFEST), 'utf8')).replace(/^﻿/, '')), root);
  const files = (await walk(root)).filter(rel => !SKIPPED(rel));
  const refused = files.filter(rel => !SHIPPED.test(rel));
  if (refused.length) throw Error(`add-on ${manifest.id} has files an add-on cannot ship: ${refused.join(', ')}`);
  const listed = new Set(files);
  if (!listed.has('init.lua')) throw Error(`add-on ${manifest.id} has no init.lua (CET runs it)`);
  const need = [manifest.bridge, ...manifest.speakers.map(speaker => speaker.voice?.reference)].filter(Boolean);
  for (const path of need) {
    const rel = relative(root, path).split(sep).join('/');
    if (!listed.has(rel)) throw Error(`add-on ${manifest.id}: ${rel} is named in ${ADDON_MANIFEST} but not shipped`);
  }
  const folder = addonFolderName(manifest.id);
  if (folder === 'CyberpunkConvai') throw Error('an add-on cannot use the main mod folder');
  return {manifest, entries: files.map(rel => ({name: `${CET_MODS}/${folder}/${rel}`, source: resolve(root, rel)}))};
}

/** Writes the zip into `out` and returns {path, manifest, names}. */
export async function buildAddon({dir, out}) {
  const {manifest, entries} = await addonEntries(dir);
  await mkdir(out, {recursive: true});
  const path = resolve(out, `${addonArchiveName(manifest)}.zip`);
  await rm(path, {force: true});
  const zip = await ZipWriter.create(path);
  for (const entry of entries) await zip.add(entry.name, {source: entry.source});
  await zip.close();
  const names = (await listZip(path)).map(entry => entry.name);
  return {path, manifest, names};
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const dir = args.find(arg => !arg.startsWith('--'));
  const outAt = args.indexOf('--out');
  const out = resolve(outAt >= 0 && args[outAt + 1] ? args[outAt + 1] : 'dist/addons');
  if (!dir) { console.error('Usage: node packaging/build-addon.mjs addons/<id> [--out dist/addons]'); process.exit(2); }
  buildAddon({dir, out}).then(({path, names}) => {
    console.log(`${basename(path)}: ${names.length} files`);
    for (const name of names) console.log(`  ${name}`);
  }, error => { console.error(error.message); process.exit(1); });
}
