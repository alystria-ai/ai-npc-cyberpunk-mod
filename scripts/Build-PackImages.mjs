// The pictures of story packs for the phone Chat (docs/PHONE_IMAGES.md, "Pictures of story packs"). A format 2 pack lists its pictures in an `images` table
// ({file: images/<name>.png, width, height}); a `text` row of a stage or an ending may name one with `image`. Each picture is cooked into the mod's picture archive as one texture and
// one atlas, and the Chat row finds it by the atlas path and part name the pack runner puts in the play file (bridge/bond-pack-runner.mjs lineTables): this file decides that name
// the same way, checks every PNG, and writes the manifest scripts/Build-PhoneImages.ps1 -Packs builds from. Nothing here needs WolvenKit or the game.
//
//   node scripts/Build-PackImages.mjs --out <manifest.json> [--pack-folder <dir>] [--pack <id> ...] [--all] [--list]
//
// Which packs: --pack names them, --all takes every pack file in the folder, and with neither it is the packs the release plan ships (packaging/release.config.json, the
// characters/bond-packs/ entries). A pack folder holds <pack id>.json and, beside it, <pack id>/images/<name>.png (the folder the runner also finds audio/, music/ and sfx/ in).
// Exit 0 with the manifest written, 1 with every problem listed (nothing is written), 2 for a wrong command line.
import {readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync, statSync} from 'node:fs';
import {dirname, join, resolve, sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {KEY_PATTERN, atlasPath, texturePath} from './Build-PhoneImageAtlas.mjs';

export const PACK_IMAGES = Object.freeze({
  folder: 'cyberpunk_convai\\phone_images',   // the depot folder the Chat row accepts (mod/phone-chat.lua IMAGE_FOLDER)
  archive: 'convai_pack_images',              // the archive's name (the phone-image proof archive is convai_phone_images: the two can sit side by side)
  maxSide: 1024,                              // pixels, as Build-PhoneImages.ps1 has always demanded
  maxBytes: 2 * 1024 * 1024,                  // the PNG file
  nameMost: 48,                               // the longest picture name the Chat row accepts
});
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * The name a pack picture goes by in the archive and in the Chat row: the atlas is cyberpunk_convai\phone_images\<name>.inkatlas and its one part is <name>. The rule of
 * bridge/bond-pack-runner.mjs lineTables: <pack id>_<picture key> with hyphens as underscores, or the key alone when that is longer than 48 characters.
 */
export function pictureName(packId, key) {
  const slug = `${packId}_${key}`.replace(/-/g, '_');
  return slug.length <= PACK_IMAGES.nameMost ? slug : key.replace(/-/g, '_');
}

/** What the Chat row is given for a picture (the shape of the runner's play file): {atlas, part, width, height}. */
export function chatImage(packId, key, image) {
  const name = pictureName(packId, key);
  return {atlas: atlasPath(PACK_IMAGES.folder, name), part: name, width: image.width, height: image.height};
}

/** The width and height a PNG's header states, or null when the bytes are not a PNG (the signature and a first IHDR chunk). */
export function readPngSize(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 33 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  if (bytes.readUInt32BE(8) !== 13 || bytes.toString('latin1', 12, 16) !== 'IHDR') return null;
  return {width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20)};
}

/** The pictures of a pack as [{packId, key, file, width, height, name}] (none for a pack without an images table). */
export function packImageEntries(pack) {
  if (!pack || typeof pack !== 'object' || typeof pack.id !== 'string' || !pack.images || typeof pack.images !== 'object' || Array.isArray(pack.images)) return [];
  return Object.entries(pack.images).map(([key, image]) => ({packId: pack.id, key, file: image?.file, width: image?.width, height: image?.height, name: pictureName(pack.id, key)}));
}

/**
 * Checks one picture. `bytes` is the file's content or null when it is not there. Returns the problems as sentences (an empty list is a good picture).
 */
export function checkImage(entry, bytes) {
  const where = `${entry.packId} picture ${entry.key}`;
  const problems = [];
  if (typeof entry.file !== 'string' || !/^images\/[a-z0-9][a-z0-9_\/-]{0,80}\.png$/.test(entry.file)) return [`${where}: file must be images/<name>.png inside the pack, the archive takes PNG only`];
  if (!Number.isInteger(entry.width) || !Number.isInteger(entry.height) || entry.width < 1 || entry.height < 1) return [`${where}: the pack must state a width and height in pixels`];
  if (!KEY_PATTERN.test(entry.name)) problems.push(`${where}: its archive name ${entry.name} is not 1 to ${PACK_IMAGES.nameMost} of lower case letters, digits and underscores`);
  if (bytes === null) return [...problems, `${where}: ${entry.file} is not there`];
  if (bytes.length > PACK_IMAGES.maxBytes) problems.push(`${where}: ${entry.file} is ${(bytes.length / 1048576).toFixed(1)} MB, the limit is ${PACK_IMAGES.maxBytes / 1048576} MB`);
  const size = readPngSize(bytes);
  if (!size) return [...problems, `${where}: ${entry.file} is not a PNG file`];
  if (size.width !== entry.width || size.height !== entry.height) problems.push(`${where}: ${entry.file} is ${size.width} x ${size.height} pixels, the pack says ${entry.width} x ${entry.height}`);
  if (size.width > PACK_IMAGES.maxSide || size.height > PACK_IMAGES.maxSide) problems.push(`${where}: ${entry.file} is larger than ${PACK_IMAGES.maxSide} pixels on a side`);
  return problems;
}

/**
 * The manifest for a list of packs, and every problem found. `read(path)` returns a file's bytes or null. Nothing is thrown: {ok, manifest, problems, packs}.
 * manifest: {folder, archive, images: [{key (the archive name), png (absolute), width, height, pack, imageKey, atlas, texture}]}: the key/png/width/height fields are what
 * Build-PhoneImages.ps1 and Build-PhoneImageAtlas.mjs read from a registry.
 */
export function buildManifest({packs, packFolder, read = path => { try { return readFileSync(path); } catch { return null; } }}) {
  const problems = [], images = [], names = new Map(), withImages = [];
  for (const pack of packs) {
    const entries = packImageEntries(pack);
    if (!entries.length) continue;
    withImages.push(pack.id);
    const root = resolve(packFolder, pack.id);
    for (const entry of entries) {
      const found = typeof entry.file === 'string' ? resolve(root, entry.file) : null;
      // A file name that would leave the pack's own folder is refused before anything is read.
      const inside = found !== null && found.startsWith(root + sep);
      const own = inside ? checkImage(entry, read(found)) : checkImage(entry, null).filter(problem => !/is not there/.test(problem));
      if (!inside && typeof entry.file === 'string') own.push(`${entry.packId} picture ${entry.key}: ${entry.file} points outside the pack's folder`);
      problems.push(...own);
      if (names.has(entry.name)) problems.push(`${entry.packId} picture ${entry.key}: the archive name ${entry.name} is also used by ${names.get(entry.name)}`);
      names.set(entry.name, `${entry.packId} picture ${entry.key}`);
      if (!own.length) images.push({key: entry.name, png: found, width: entry.width, height: entry.height, pack: entry.packId, imageKey: entry.key,
        atlas: atlasPath(PACK_IMAGES.folder, entry.name), texture: texturePath(PACK_IMAGES.folder, entry.name)});
    }
  }
  return {ok: problems.length === 0, manifest: {folder: PACK_IMAGES.folder, archive: PACK_IMAGES.archive, images}, problems, packs: withImages};
}

/** The pack ids the release plan ships from characters/bond-packs/ (packaging/release.config.json appData). */
export function shippedPackIds(config) {
  const ids = [];
  for (const path of Array.isArray(config?.appData) ? config.appData : []) {
    const match = /^characters\/bond-packs\/([a-z][a-z0-9-]*)\.json$/.exec(path);
    if (match) ids.push(match[1]);
  }
  return ids;
}

/** Reads the pack files of a folder (the ones named, or all of them): [{id, pack}], and the names that have no file. */
export function loadPacks(packFolder, {names = null, all = false, read = path => readFileSync(path, 'utf8'), list = folder => readdirSync(folder)} = {}) {
  const files = list(packFolder).filter(file => file.endsWith('.json')).sort();
  const wanted = all ? files.map(file => file.slice(0, -5)) : names ?? [];
  const packs = [], missing = [];
  for (const id of wanted) {
    if (!/^[a-z][a-z0-9-]{2,47}$/.test(id) || !files.includes(`${id}.json`)) { missing.push(id); continue; }
    try { packs.push(JSON.parse(read(join(packFolder, `${id}.json`)))); } catch { missing.push(id); }
  }
  return {packs, missing};
}

function parseArguments(argv) {
  const options = {out: null, packFolder: null, packs: [], all: false, list: false};
  for (let i = 0; i < argv.length; i++) {
    const argument = argv[i], value = () => argv[++i];
    if (argument === '--out') options.out = value();
    else if (argument === '--pack-folder') options.packFolder = value();
    else if (argument === '--pack') options.packs.push(value());
    else if (argument === '--all') options.all = true;
    else if (argument === '--list') options.list = true;
    else return null;
  }
  return options;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const options = parseArguments(process.argv.slice(2));
  if (!options || (!options.out && !options.list)) { console.error('usage: node Build-PackImages.mjs --out <manifest.json> [--pack-folder <dir>] [--pack <id> ...] [--all] [--list]'); process.exit(2); }
  const packFolder = resolve(options.packFolder ?? join(project, 'characters', 'bond-packs'));
  if (!existsSync(packFolder) || !statSync(packFolder).isDirectory()) { console.error(`The pack folder ${packFolder} does not exist.`); process.exit(1); }
  const config = JSON.parse(readFileSync(join(project, 'packaging', 'release.config.json'), 'utf8'));
  const names = options.packs.length ? options.packs : shippedPackIds(config);
  const {packs, missing} = loadPacks(packFolder, {names, all: options.all});
  const result = buildManifest({packs, packFolder});
  for (const id of missing) result.problems.push(`pack ${id}: there is no readable ${id}.json in ${packFolder}`);
  console.log(`Packs with pictures: ${result.packs.length ? result.packs.join(', ') : 'none'} (looked at ${packs.length} of ${options.all ? 'all the' : 'the named or shipped'} packs in ${packFolder})`);
  for (const image of result.manifest.images) console.log(`  ${image.pack} ${image.imageKey} -> ${image.atlas} (part ${image.key}, ${image.width} x ${image.height})`);
  if (result.problems.length) {
    for (const problem of result.problems) console.error(`  PROBLEM: ${problem}`);
    console.error(`${result.problems.length} problem(s): no manifest was written.`);
    process.exit(1);
  }
  if (!result.manifest.images.length) console.log('No pack names a picture: nothing to build.');
  if (options.out) { mkdirSync(dirname(resolve(options.out)), {recursive: true}); writeFileSync(options.out, JSON.stringify(result.manifest, null, 2)); console.log(`Manifest written: ${options.out}`); }
}
