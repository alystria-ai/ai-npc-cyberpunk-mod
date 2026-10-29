// The pictures of story packs on their way to the phone Chat (scripts/Build-PackImages.mjs and scripts/Build-PhoneImages.ps1 -Packs): the name the Chat row looks up, the checks of every
// PNG, the manifest the archive build reads, and the dry run of the build. The cooking itself (WolvenKit) is not run: it needs the vendor tools and is heavy.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFile, spawnSync} from 'node:child_process';
import {mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {deflateSync} from 'node:zlib';
import {BondPacks} from './bond-pack-runner.mjs';
import {shippedPacks, validatePack} from './bond-packs.mjs';
import {PACK_IMAGES, buildManifest, checkImage, chatImage, loadPacks, packImageEntries, pictureName, readPngSize, shippedPackIds} from '../scripts/Build-PackImages.mjs';
import {atlasPath, buildAtlas, texturePath} from '../scripts/Build-PhoneImageAtlas.mjs';

const project = resolve(fileURLToPath(new URL('..', import.meta.url)));
const roster = new Set(JSON.parse(readFileSync(join(project, 'characters', 'roster.json'), 'utf8')).map(row => row.key));

// ---- a real PNG of any size (all black), without a library ----
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1; }
  return (crc ^ 0xffffffff) >>> 0;
}
const chunk = (type, data) => {
  const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]), crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
};
function png(width, height) {
  const header = Buffer.alloc(13); header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.alloc((width * 3 + 1) * height))), chunk('IEND', Buffer.alloc(0))]);
}

const entry = (extra = {}) => ({packId: 'demo-pack', key: 'door', file: 'images/door.png', width: 64, height: 32, name: 'demo_pack_door', ...extra});

test('the picture name is the one the pack runner puts in the play file, and the Chat row accepts it', () => {
  // A real pack, run by the real runner: the picture its stage names comes out with the atlas and part this build must produce.
  const pilot = JSON.parse(JSON.stringify(shippedPacks().map(row => row.pack).find(pack => pack.id === 'panam-sunset-coffee')));
  pilot.stages.find(stage => stage.id === 'walk').script.push({when: 'stage:enter', text: 'P1.sunrise.01', image: 'sunset-coffee'});
  assert.equal(validatePack(pilot, {characters: roster}).ok, true);
  const runner = new BondPacks({packs: [pilot], characters: roster, write: async () => {}, debounceMs: 0});
  runner.entries.set(pilot.id, {status: 'active', trail: [{stage: 'walk', at: 0}]});
  const fromRunner = runner.playState().quests[0].images['sunset-coffee'];
  assert.deepEqual(fromRunner, chatImage('panam-sunset-coffee', 'sunset-coffee', pilot.images['sunset-coffee']));
  assert.equal(fromRunner.atlas, 'cyberpunk_convai\\phone_images\\panam_sunset_coffee_sunset_coffee.inkatlas');
  assert.equal(fromRunner.part, 'panam_sunset_coffee_sunset_coffee');
  // mod/phone-chat.lua cleanImage: the folder, lower case letters, digits and underscores, at most 48 characters, a size of 1 to 4096.
  const lua = /^cyberpunk_convai\\phone_images\\([a-z0-9_]+)\.inkatlas$/.exec(fromRunner.atlas);
  assert.ok(lua && lua[1].length <= 48 && /^[a-z0-9_]+$/.test(fromRunner.part) && fromRunner.part === lua[1]);
  // and the archive build writes the file the atlas path names
  assert.equal(atlasPath(PACK_IMAGES.folder, fromRunner.part), fromRunner.atlas);
  assert.equal(PACK_IMAGES.folder + '\\', readFileSync(join(project, 'mod', 'phone-chat.lua'), 'utf8').match(/M\.IMAGE_FOLDER = '([^']+)'/)[1].replaceAll('\\\\', '\\'));
});

test('a long pack id falls back to the picture key alone, as the runner does', () => {
  const longId = 'a-pack-with-quite-a-long-identifier-indeed';
  assert.equal(pictureName(longId, 'door'), 'a_pack_with_quite_a_long_identifier_indeed_door'.length <= 48 ? 'a_pack_with_quite_a_long_identifier_indeed_door' : 'door');
  assert.equal(pictureName('a-pack-with-a-very-long-identifier-of-its-own', 'sunset-coffee'), 'sunset_coffee');
  assert.equal(pictureName('judy-dinner-dress', 'her-hands'), 'judy_dinner_dress_her_hands');
  const runner = new BondPacks({packs: [], characters: roster, write: async () => {}, debounceMs: 0});
  assert.ok(runner);
});

test('a PNG is read by its header, and a file that is not a PNG is not', () => {
  assert.deepEqual(readPngSize(png(64, 32)), {width: 64, height: 32});
  assert.equal(readPngSize(Buffer.from('GIF89a not a png file, long enough to be read, really it is')), null);
  assert.equal(readPngSize(Buffer.alloc(10)), null); assert.equal(readPngSize('text'), null); assert.equal(readPngSize(null), null);
  const bad = png(64, 32); bad.write('JUNK', 12, 'latin1');
  assert.equal(readPngSize(bad), null, 'the first chunk must be IHDR');
});

test('a good picture has no problems, every kind of bad one is named with its pack, picture and reason', () => {
  assert.deepEqual(checkImage(entry(), png(64, 32)), []);
  const only = (extra, bytes, pattern) => { const problems = checkImage(entry(extra), bytes); assert.equal(problems.length, 1, JSON.stringify(problems)); assert.match(problems[0], pattern); assert.match(problems[0], /^demo-pack picture door: /); };
  only({}, null, /images\/door\.png is not there/);
  only({}, Buffer.from('not a png at all, just some words in a file that is long enough'), /is not a PNG file/);
  only({}, png(32, 32), /is 32 x 32 pixels, the pack says 64 x 32/);
  only({width: 2000, height: 2000}, png(2000, 2000), /larger than 1024 pixels/);
  only({file: 'images/door.jpg'}, png(64, 32), /PNG only/);
  only({file: 'images/Door.png'}, png(64, 32), /PNG only/);
  only({file: undefined}, png(64, 32), /PNG only/);
  only({width: 0}, png(64, 32), /width and height in pixels/);
  only({width: 6.5}, png(64, 32), /width and height in pixels/);
  const big = Buffer.concat([png(64, 32), Buffer.alloc(PACK_IMAGES.maxBytes)]);
  only({}, big, /MB, the limit is 2 MB/);
  only({name: 'Bad Name'}, png(64, 32), /archive name .* is not 1 to 48/);
  assert.deepEqual(checkImage(entry({width: 1024, height: 1024}), png(1024, 1024)), [], '1024 is allowed');
});

// ---- a pack folder on disk ----
function packFolder(packs) {
  const folder = mkdtempSync(join(tmpdir(), 'pack-images-'));
  for (const [id, images] of Object.entries(packs)) {
    const pack = {format: 2, id, character: 'panam-palmer', title: 'T', images: images ? Object.fromEntries(Object.entries(images).map(([key, [width, height]]) => [key, {file: `images/${key}.png`, width, height}])) : undefined};
    writeFileSync(join(folder, `${id}.json`), JSON.stringify(pack));
    for (const [key, [width, height]] of Object.entries(images ?? {})) { mkdirSync(join(folder, id, 'images'), {recursive: true}); writeFileSync(join(folder, id, 'images', `${key}.png`), png(width, height)); }
  }
  return folder;
}

test('the manifest lists every good picture with the paths the archive build needs, and only packs with pictures count', () => {
  const folder = packFolder({'demo-pack': {door: [64, 32], 'rain-window': [128, 64]}, 'plain-pack': null, 'other-pack': {door: [16, 16]}});
  try {
    const {packs} = loadPacks(folder, {all: true});
    const result = buildManifest({packs, packFolder: folder});
    assert.equal(result.ok, true, result.problems.join(' | '));
    assert.deepEqual(result.packs, ['demo-pack', 'other-pack']);
    assert.equal(result.manifest.folder, 'cyberpunk_convai\\phone_images'); assert.equal(result.manifest.archive, 'convai_pack_images');
    assert.deepEqual(result.manifest.images.map(image => image.key), ['demo_pack_door', 'demo_pack_rain_window', 'other_pack_door']);
    const first = result.manifest.images[0];
    assert.equal(first.png, join(folder, 'demo-pack', 'images', 'door.png')); assert.equal(first.width, 64); assert.equal(first.height, 32);
    assert.equal(first.atlas, 'cyberpunk_convai\\phone_images\\demo_pack_door.inkatlas'); assert.equal(first.texture, 'cyberpunk_convai\\phone_images\\demo_pack_door.xbm');
    // the existing atlas tool reads this manifest as it reads its own registry
    for (const image of result.manifest.images) {
      const atlas = buildAtlas(result.manifest.folder, image.key).Data.RootChunk;
      assert.equal(atlas.slots.Elements[0].parts[0].partName.$value, image.key);
      assert.equal(atlas.slots.Elements[0].texture.DepotPath.$value, image.texture);
      assert.equal(texturePath(result.manifest.folder, image.key), image.texture);
    }
  } finally { rmSync(folder, {recursive: true, force: true}); }
});

test('every problem is reported together, a bad picture is left out of the manifest, and a file name that leaves the pack is refused unread', () => {
  const folder = packFolder({'demo-pack': {door: [64, 32], wide: [10, 10]}});
  try {
    rmSync(join(folder, 'demo-pack', 'images', 'door.png'));
    writeFileSync(join(folder, 'demo-pack', 'images', 'wide.png'), png(11, 10));
    const {packs} = loadPacks(folder, {all: true});
    const result = buildManifest({packs, packFolder: folder});
    assert.equal(result.ok, false);
    assert.equal(result.problems.length, 2, result.problems.join(' | '));
    assert.match(result.problems.join('\n'), /door: images\/door\.png is not there/); assert.match(result.problems.join('\n'), /wide: .* is 11 x 10 pixels, the pack says 10 x 10/);
    assert.deepEqual(result.manifest.images, []);
    const read = [];
    const traversal = buildManifest({packs: [{id: 'demo-pack', images: {door: {file: 'images/../../secret.png', width: 1, height: 1}}}], packFolder: folder, read: path => { read.push(path); return png(1, 1); }});
    assert.equal(traversal.ok, false); assert.deepEqual(read, [], 'nothing outside the pack was read');
    assert.match(traversal.problems.join('\n'), /PNG only|outside the pack/);
    // two pictures that would share an archive name
    const clash = buildManifest({packs: [{id: 'abc', images: {'x-y': {file: 'images/a.png', width: 1, height: 1}, 'x_y': {file: 'images/b.png', width: 1, height: 1}}}], packFolder: folder, read: () => png(1, 1)});
    assert.match(clash.problems.join('\n'), /archive name abc_x_y is also used/);
  } finally { rmSync(folder, {recursive: true, force: true}); }
});

test('the packs are the ones named, all of a folder, or the ones the release plan ships; a name with no file is a problem', () => {
  const config = JSON.parse(readFileSync(join(project, 'packaging', 'release.config.json'), 'utf8'));
  assert.deepEqual(shippedPackIds(config), ['judy-dinner-dress', 'kerry-new-song', 'panam-truck-ransom']);
  assert.deepEqual(shippedPackIds({}), []); assert.deepEqual(shippedPackIds({appData: ['characters/roster.json', 'characters/bond-packs/../x.json']}), []);
  const folder = packFolder({'demo-pack': {door: [4, 4]}, 'other-pack': {door: [4, 4]}});
  try {
    assert.deepEqual(loadPacks(folder, {names: ['other-pack']}).packs.map(pack => pack.id), ['other-pack']);
    assert.deepEqual(loadPacks(folder, {all: true}).packs.map(pack => pack.id), ['demo-pack', 'other-pack']);
    assert.deepEqual(loadPacks(folder, {names: ['nothing-here', '../evil', 'demo-pack']}).missing, ['nothing-here', '../evil']);
    assert.deepEqual(packImageEntries({id: 'x'}), []); assert.deepEqual(packImageEntries(null), []); assert.deepEqual(packImageEntries({id: 'x', images: []}), []);
  } finally { rmSync(folder, {recursive: true, force: true}); }
});

const script = join(project, 'scripts', 'Build-PackImages.mjs');
const node = args => spawnSync(process.execPath, [script, ...args], {encoding: 'utf8'});

test('the command line writes the manifest when every picture is good, and writes nothing and exits 1 when one is not', () => {
  const folder = packFolder({'demo-pack': {door: [64, 32]}});
  const out = join(folder, 'out', 'manifest.json');
  try {
    const good = node(['--pack-folder', folder, '--pack', 'demo-pack', '--out', out]);
    assert.equal(good.status, 0, good.stderr);
    assert.match(good.stdout, /demo_pack_door\.inkatlas/);
    assert.equal(JSON.parse(readFileSync(out, 'utf8')).images[0].key, 'demo_pack_door');
    rmSync(join(folder, 'demo-pack', 'images', 'door.png')); rmSync(join(folder, 'out'), {recursive: true});
    const bad = node(['--pack-folder', folder, '--pack', 'demo-pack', '--out', out]);
    assert.equal(bad.status, 1); assert.match(bad.stderr, /PROBLEM: demo-pack picture door: images\/door\.png is not there/); assert.match(bad.stderr, /no manifest was written/);
    assert.equal(existsSync(out), false);
    assert.equal(node(['--pack-folder', folder, '--pack', 'ghost-pack', '--out', out]).status, 1);
    assert.equal(node(['--bogus']).status, 2); assert.equal(node([]).status, 2);
    assert.equal(node(['--pack-folder', join(folder, 'nowhere'), '--list']).status, 1);
  } finally { rmSync(folder, {recursive: true, force: true}); }
});

// ---- the build script's dry run: Windows PowerShell only ----
const powershell = process.platform === 'win32' ? 'powershell.exe' : null;
const ps1 = join(project, 'scripts', 'Build-PhoneImages.ps1');
const runPs1 = args => new Promise(done => execFile(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ps1, ...args], {encoding: 'utf8', timeout: 90000, windowsHide: true},
  (error, stdout, stderr) => done({code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout, stderr})));
const buildFolders = () => { try { return readdirSync(join(project, 'runtime', 'phone-images')).filter(name => name.startsWith('build-')); } catch { return []; } };

test('-Packs -WhatIf checks the pictures, prints the plan and the depot files, builds nothing and leaves nothing behind', {skip: powershell ? false : 'Windows PowerShell only', timeout: 120000}, async () => {
  const folder = packFolder({'demo-pack': {door: [64, 32]}});
  const before = buildFolders(), leftovers = () => readdirSync(tmpdir()).filter(name => name.startsWith('pack-images-') && name.endsWith('.json')).length;
  const manifestsBefore = leftovers();
  try {
    const dry = await runPs1(['-Packs', '-PackFolder', folder, '-Pack', 'demo-pack', '-WhatIf']);
    assert.equal(dry.code, 0, dry.stdout + dry.stderr);
    assert.match(dry.stdout, /What if: build convai_pack_images\.archive from 1 picture\(s\)/);
    assert.match(dry.stdout, /demo-pack door: 64x32\s+cyberpunk_convai\\phone_images\\demo_pack_door\.xbm\s+cyberpunk_convai\\phone_images\\demo_pack_door\.inkatlas\s+\(part demo_pack_door\)/);
    assert.match(dry.stdout, /What if: (the build would stop here: WolvenKit CLI is missing at|WolvenKit and the \.NET runtime are in place)/, 'it says whether the tool is there');
    assert.deepEqual(buildFolders(), before, 'no work folder was made');
    assert.equal(leftovers(), manifestsBefore, 'the temporary manifest was removed');
    // a missing picture stops it before anything else, with every problem printed
    rmSync(join(folder, 'demo-pack', 'images', 'door.png'));
    const missing = await runPs1(['-Packs', '-PackFolder', folder, '-Pack', 'demo-pack', '-WhatIf']);
    assert.notEqual(missing.code, 0);
    assert.match(missing.stdout + missing.stderr, /images\/door\.png is not there/); assert.match(missing.stdout + missing.stderr, /pictures of the story packs are not ready/);
  } finally { rmSync(folder, {recursive: true, force: true}); }
});

test('a real build with the tool missing fails with a clear sentence and builds nothing; the proof-card mode still dry-runs', {skip: powershell ? false : 'Windows PowerShell only', timeout: 120000}, async () => {
  const folder = packFolder({'demo-pack': {door: [64, 32]}}), vendor = mkdtempSync(join(tmpdir(), 'no-vendor-'));
  const before = buildFolders();
  try {
    const real = await runPs1(['-Packs', '-PackFolder', folder, '-Pack', 'demo-pack', '-VendorDirectory', vendor]);
    assert.notEqual(real.code, 0);
    assert.match((real.stdout + real.stderr).replace(/\s+/g, ' '), /WolvenKit CLI is missing at .*WolvenKit\.CLI\.exe\. See docs\/FACIAL_ANIMATION\.md/);
    assert.deepEqual(buildFolders(), before);
    const cards = await runPs1(['-WhatIf', '-VendorDirectory', vendor]);
    assert.equal(cards.code, 0, cards.stdout + cards.stderr);
    assert.match(cards.stdout, /What if: build convai_phone_images\.archive from 2 picture\(s\)/);
    assert.match(cards.stdout, /card_wide: 1024x576/);
  } finally { rmSync(folder, {recursive: true, force: true}); rmSync(vendor, {recursive: true, force: true}); }
});

test('the build script reuses the proof archive\'s own steps for pack pictures instead of copying them', () => {
  const text = readFileSync(ps1, 'utf8');
  assert.equal((text.match(/function Invoke-PhoneImageTool/g) ?? []).length, 1);
  assert.match(text, /Build-PackImages\.mjs/); assert.match(text, /Build-PhoneImageAtlas\.mjs/);
  assert.equal((text.match(/'import'/g) ?? []).length, 1, 'one import step for both kinds of picture');
  assert.match(text, /CmdletBinding\(SupportsShouldProcess\)/);
});
