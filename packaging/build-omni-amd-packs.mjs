// Builds the AMD packs: one zip per card family with AMD's own ROCm PyTorch wheels, for Hugging Face (voice/amd/). The in-game "Set up OmniVoice for AMD"
// button downloads the zip of the player's card family from there (docs/OMNIVOICE_AMD.md, "Where the files come from"; docs/PACKAGING.md "OmniVoice for AMD").
//
//   node packaging/build-omni-amd-packs.mjs --plan                                     (what would be built: names and sizes; downloads nothing)
//   node packaging/build-omni-amd-packs.mjs --out DIR [--downloads DIR] [--target gfx1201,gfx1100] [--no-list]
//
// For each family of bridge/omni-amd-wheels.mjs (the pinned list that packaging/resolve-omni-amd.mjs writes) it
//   1. downloads every file of the family from AMD's index into --downloads (default DIR/downloads; shared between families, resumed, kept for the next family),
//      checking its size and AMD's checksum (the SHA-256 of the pinned list when it has one, else the MD5 in AMD's ETag),
//   2. writes OmniAMD-<family>-PyTorch-<v>-ROCm-<v>.zip into DIR: the wheels and the rocm source package stored as they are (they are compressed already) in the
//      pinned order, then omni-amd-pack.json (family, versions, and each file's size and SHA-256). The same files always give the same zip, byte for byte,
//   3. reads the zip back (every file is there with its size) and records its size and SHA-256 in bridge/omni-amd-packs.mjs, next to the other families'.
// Upload the zips with `python packaging/upload-packs.py --version <release> --pack omni-amd --packages DIR`, then commit the list. The game uses a pack only
// when the list names it with the files of the pinned list; otherwise it downloads AMD's files itself.
import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {mkdir, rename, rm, stat, writeFile} from 'node:fs/promises';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {AMD_PACK_MANIFEST, amdPackName} from '../bridge/omni-amd-layout.mjs';
import {downloadFile, planFor} from '../bridge/omni-amd-setup.mjs';
import WHEELS from '../bridge/omni-amd-wheels.mjs';
import PACKS from '../bridge/omni-amd-packs.mjs';
import {ZipWriter, listZip} from './lib/zip.mjs';

const here = dirname(fileURLToPath(import.meta.url));
export const LIST_PATH = resolve(here, '..', 'bridge', 'omni-amd-packs.mjs');
const MIB = 2 ** 20;

/** The packs this pinned list gives: [{target, name, files, bytes}] (bytes: the zip's size to within a few KB). Pure. */
export function planPacks(manifest, targets = Object.keys(manifest?.targets ?? {})) {
  return targets.map(target => {
    const plan = planFor(manifest, target, {packs: {}});
    const name = amdPackName(manifest.roots, target);
    if (!plan || !name) throw Error(`${target}: not in the pinned list, or its versions cannot be read`);
    return {target, name, files: plan.files.map(file => file.name), bytes: plan.filesBytes};
  });
}

export async function sha256Of(path) {
  const hash = createHash('sha256');
  for await (const part of createReadStream(path)) hash.update(part);
  return hash.digest('hex');
}

/**
 * Builds one family's pack. `downloads` holds (and receives) AMD's files. Returns {target, name, path, size, sha256, files}.
 * `fetchImpl` and `log` are for tests.
 */
export async function buildPack({manifest, target, downloads, out, fetchImpl = fetch, log = () => {}}) {
  const plan = planFor(manifest, target, {packs: {}});
  const name = amdPackName(manifest?.roots, target);
  if (!plan || !name) throw Error(`${target}: not in the pinned list, or its versions cannot be read`);
  await mkdir(downloads, {recursive: true});
  await mkdir(out, {recursive: true});
  for (const file of plan.files) {
    await downloadFile(file, join(downloads, file.name), {fetchImpl, onBytes: () => {}});
    log(`${target}: ${file.name} (${(file.size / MIB).toFixed(1)} MiB) ok`);
  }
  const path = join(out, name), temporary = `${path}.tmp`;
  await rm(temporary, {force: true});
  const zip = await ZipWriter.create(temporary);
  const entries = [];
  try {
    for (const file of plan.files) {
      const added = await zip.add(file.name, {source: join(downloads, file.name), store: true});
      if (added.uncompressed !== file.size) throw Error(`${file.name}: ${added.uncompressed} bytes, expected ${file.size}`);
      entries.push({name: file.name, kind: file.kind, project: file.project, version: file.version, size: file.size, unpacked: file.unpacked, sha256: added.sha256});
    }
    const record = {version: 1, target, name, torch: manifest.roots?.torch ?? null, python: manifest.python ?? null, source: manifest.index ?? null, files: entries};
    await zip.add(AMD_PACK_MANIFEST, {buffer: Buffer.from(JSON.stringify(record, null, 2) + '\n'), store: true});
    await zip.close();
  } catch (error) { await zip.close().catch(() => {}); await rm(temporary, {force: true}); throw error; }
  // Read back: every file is in the zip with its size.
  const listed = new Map((await listZip(temporary)).map(entry => [entry.name, entry]));
  for (const file of entries) if (listed.get(file.name)?.uncompressed !== file.size) { await rm(temporary, {force: true}); throw Error(`${name}: ${file.name} is not in the zip as it should be`); }
  if (!listed.has(AMD_PACK_MANIFEST) || listed.size !== entries.length + 1) { await rm(temporary, {force: true}); throw Error(`${name}: the zip lists other files than it should`); }
  await rm(path, {force: true});
  await rename(temporary, path);
  const size = (await stat(path)).size;
  log(`${target}: wrote ${name} (${(size / MIB).toFixed(0)} MiB)`);
  return {target, name, path, size, sha256: await sha256Of(path), files: entries.map(file => file.name)};
}

/** The text of bridge/omni-amd-packs.mjs for these packs ({target: {name, size, sha256, files, built}}). Pure. */
export function listText(packs) {
  const sorted = Object.fromEntries(Object.entries(packs).sort(([a], [b]) => a.localeCompare(b)));
  return `// Written by packaging/build-omni-amd-packs.mjs when the AMD packs are built and uploaded to Hugging Face (voice/amd/): do not edit by hand\n`
    + `// (docs/OMNIVOICE_AMD.md, docs/PACKAGING.md "OmniVoice for AMD"). One entry per card family: {name, size, sha256, files, built}. A family with no entry here,\n`
    + `// or whose \`files\` are not the list in omni-amd-wheels.mjs any more, is downloaded from AMD's own index instead.\n`
    + `export default ${JSON.stringify({version: 1, packs: sorted}, null, 2)};\n`;
}

function parseArguments(argv) {
  const options = {plan: false, list: true, targets: null, out: null, downloads: null};
  for (let i = 0; i < argv.length; i++) {
    const argument = argv[i];
    if (argument === '--plan') options.plan = true;
    else if (argument === '--no-list') options.list = false;
    else if (argument === '--target') options.targets = String(argv[++i] ?? '').split(',').filter(Boolean);
    else if (argument === '--out') options.out = resolve(argv[++i] ?? '');
    else if (argument === '--downloads') options.downloads = resolve(argv[++i] ?? '');
    else throw Error(`Unknown argument ${argument}`);
  }
  return options;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const targets = options.targets ?? Object.keys(WHEELS.targets);
  for (const target of targets) if (!WHEELS.targets[target]) throw Error(`${target}: not in bridge/omni-amd-wheels.mjs`);
  if (options.plan) {
    const planned = planPacks(WHEELS, targets);
    for (const pack of planned) console.log(`${pack.name}\t${pack.files.length} files\t${(pack.bytes / MIB).toFixed(0)} MiB`);
    const unique = new Map();
    for (const target of targets) for (const name of WHEELS.targets[target]) unique.set(name, WHEELS.files[name].size);
    console.log(`Download from AMD (each file once): ${(Array.from(unique.values()).reduce((sum, size) => sum + size, 0) / MIB).toFixed(0)} MiB. Zips together: ${(planned.reduce((sum, pack) => sum + pack.bytes, 0) / MIB).toFixed(0)} MiB.`);
    return;
  }
  if (!options.out) throw Error('--out DIR is required (or --plan)');
  const downloads = options.downloads ?? join(options.out, 'downloads');
  const built = {};
  for (const target of targets) {
    const pack = await buildPack({manifest: WHEELS, target, downloads, out: options.out, log: line => console.error(line)});
    built[target] = {name: pack.name, size: pack.size, sha256: pack.sha256, files: [...pack.files].sort(), built: new Date().toISOString().slice(0, 10)};
  }
  if (options.list) {
    await writeFile(LIST_PATH, listText({...PACKS.packs, ...built}));
    console.error(`wrote ${LIST_PATH}`);
  } else console.error(JSON.stringify(built, null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
