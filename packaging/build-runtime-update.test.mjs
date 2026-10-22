// The Runtime update zip builder (packaging/build-runtime-update.mjs): which files it takes from the new full Runtime, what it puts in the removal list,
// and that the update extracted over the old Runtime and started leaves exactly the new Runtime. Tiny fixture zips in a temporary folder; no real Runtime.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {ZipWriter, listZip} from './lib/zip.mjs';
import {extractEntry, readEntry} from './lib/zip-entry.mjs';
import {sha256File} from './lib/files.mjs';
import {PLUGIN, REMOVALS_FILE, applyRuntimeRemovals} from './runtime/apply-removals.mjs';
import {REMOVALS_ENTRY, removalListText} from './lib/runtime-removals.mjs';
import {BASE_FILE, STEPS_DIR, baseText, stepFileName} from '../bridge/runtime-steps.mjs';
import {RELEASE_ENTRY, buildRuntimeUpdate, compareRuntimes, runtimeFiles} from './build-runtime-update.mjs';

const project = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const NOTE = 'HOW TO INSTALL - extract into your Cyberpunk 2077 folder.txt';
const APP = `${PLUGIN}/app`;
const BASE_ENTRY = `${APP}/${STEPS_DIR}/${BASE_FILE}`, STEP_ENTRY = `${APP}/${STEPS_DIR}/${stepFileName("0.2.2", "0.2.3")}`;
const quiet = () => {};
const temporary = () => mkdtemp(join(tmpdir(), 'runtime update test '));
const release = (version, extra = {}) => JSON.stringify({product: 'AI-NPC-Cyberpunk-Mod', package: 'runtime', version, commit: `c-${version}`, ...extra}, null, 2) + '\n';

// A zip from {path: text | Buffer}, in path order.
async function makeZip(path, files, options) {
  const writer = await ZipWriter.create(path, options);
  for (const name of Object.keys(files).sort()) await writer.add(name, {buffer: Buffer.isBuffer(files[name]) ? files[name] : Buffer.from(files[name])});
  await writer.close();
  return path;
}
const entriesOf = async zip => Object.fromEntries(await Promise.all((await listZip(zip)).map(async entry => [entry.name, (await readEntry(zip, entry)).toString('utf8')])));

const BIG = randomBytes(300_000).toString('base64'); // compresses a little, spans several chunks
const packListing = {schema: 1, packs: [{name: 'OmniPack', file: 'o.zip', bytes: 1, entries: 2, claimed: [{prefix: `${PLUGIN}/app/omni/python/`, entries: 1}],
  files: [[`${PLUGIN}/voices/pack-owned.wav`, 3, '00000000']]}]};

// The old and new Runtime the tests share.
function fixture(directory) {
  const old = {
    [NOTE]: 'install note',
    [`${APP}/bridge/convai-bridge.mjs`]: 'bridge v1',
    [`${APP}/bridge/old-module.mjs`]: 'old module',
    [`${APP}/models/model.bin`]: BIG,
    [`${APP}/launcher/start-service.mjs`]: 'start v1',
    [`${PLUGIN}/voices/keep.wav`]: 'keep',
    [`${PLUGIN}/voices/renamed-from.wav`]: 'clip',
    [`${PLUGIN}/voices/pack-owned.wav`]: 'pack file',
    [`${PLUGIN}/voices/empty.txt`]: '',
    [`${PLUGIN}/launcher.ini`]: 'ini',
    [RELEASE_ENTRY]: release('0.2.2'),
    [BASE_ENTRY]: baseText('0.2.2'),
    'archive/pc/mod/convai_old.archive': 'archive v1',
    'r6/audioware/CyberpunkConvai/reply-0.wav': 'reply',
  };
  const next = {
    ...old,
    [`${APP}/bridge/convai-bridge.mjs`]: 'bridge v2 with more',
    [`${APP}/bridge/new-module.mjs`]: 'new module',
    [`${APP}/launcher/apply-removals.mjs`]: 'step',
    [`${PLUGIN}/voices/renamed-to.wav`]: 'clip',
    [RELEASE_ENTRY]: release('0.2.3'),
    [BASE_ENTRY]: baseText('0.2.3'),
    [REMOVALS_ENTRY]: removalListText('0.2.3', [`${PLUGIN}/voices/declared-gone.wav`]),
  };
  for (const gone of [`${APP}/bridge/old-module.mjs`, `${PLUGIN}/voices/renamed-from.wav`, `${PLUGIN}/voices/pack-owned.wav`, 'archive/pc/mod/convai_old.archive', NOTE]) delete next[gone];
  return {old, next};
}

test('compares two Runtimes by path, size and CRC-32: added, changed, unchanged, removed', async () => {
  const dir = await temporary();
  try {
    const {old, next} = fixture(dir);
    const before = await runtimeFiles([await makeZip(join(dir, 'old.zip'), old)]), after = await runtimeFiles([await makeZip(join(dir, 'new.zip'), next)]);
    const diff = compareRuntimes(before, after);
    assert.deepEqual(diff.added.map(item => item.name), [`${APP}/bridge/new-module.mjs`, `${APP}/defaults/runtime-removals.json`, `${APP}/launcher/apply-removals.mjs`, `${PLUGIN}/voices/renamed-to.wav`]);
    assert.deepEqual(diff.changed.map(item => item.name), [`${APP}/bridge/convai-bridge.mjs`, BASE_ENTRY, RELEASE_ENTRY]);
    assert.deepEqual(diff.removed.map(item => item.name), [NOTE, 'archive/pc/mod/convai_old.archive', `${APP}/bridge/old-module.mjs`, `${PLUGIN}/voices/pack-owned.wav`, `${PLUGIN}/voices/renamed-from.wav`]);
    assert.equal(diff.unchanged, 6);
    // Windows names are not case sensitive: a path that only changes case is the same file.
    const cased = compareRuntimes(await runtimeFiles([await makeZip(join(dir, 'a.zip'), {'Red4ext/X.TXT': 'same'})]), await runtimeFiles([await makeZip(join(dir, 'b.zip'), {'red4ext/x.txt': 'same'})]));
    assert.deepEqual([cased.added.length, cased.changed.length, cased.removed.length, cased.unchanged], [0, 0, 0, 1]);
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test('the update holds only what changed, the new version stamp and a removal list that names what went away', async () => {
  const dir = await temporary();
  try {
    const {old, next} = fixture(dir);
    const oldZip = await makeZip(join(dir, 'old.zip'), old), newZip = await makeZip(join(dir, 'new.zip'), next);
    const log = [];
    const summary = await buildRuntimeUpdate({oldZips: [oldZip], newZips: [newZip], out: join(dir, 'out'), listing: packListing, log: line => log.push(line)});
    assert.equal(summary.from, '0.2.2');
    assert.equal(summary.to, '0.2.3');
    const name = 'AI-NPC-Cyberpunk-Mod-Runtime-Update-0.2.2-to-0.2.3';
    assert.deepEqual((await readdir(join(dir, 'out'))).sort(), [`${name}.files.json`, `${name}.sha256`, `${name}.zip`]);
    const zip = join(dir, 'out', `${name}.zip`);
    const held = await entriesOf(zip);
    assert.deepEqual(Object.keys(held).sort(), [`${APP}/bridge/convai-bridge.mjs`, `${APP}/bridge/new-module.mjs`, `${APP}/defaults/runtime-removals.json`, STEP_ENTRY, `${APP}/launcher/apply-removals.mjs`,
      RELEASE_ENTRY, `${PLUGIN}/voices/renamed-to.wav`].sort());
    // The zip carries its own step marker and never the base marker of either full Runtime (bridge/runtime-steps.mjs).
    assert.deepEqual(JSON.parse(held[STEP_ENTRY]), {from: '0.2.2', to: '0.2.3'});
    assert.equal(held[BASE_ENTRY], undefined);
    assert.equal(held[`${APP}/bridge/convai-bridge.mjs`], 'bridge v2 with more');
    assert.equal(JSON.parse(held[RELEASE_ENTRY]).version, '0.2.3');
    // Removed: the bridge module, the renamed clip, the old archive, and what the new Runtime's own list declares. Not removed: the file a pack ships and the
    // install note at the top of the game folder (the start step may only delete under the folders a Runtime installs into).
    assert.deepEqual(JSON.parse(held[REMOVALS_ENTRY]), {version: '0.2.3', removes: ['archive/pc/mod/convai_old.archive', `${APP}/bridge/old-module.mjs`, `${PLUGIN}/voices/declared-gone.wav`, `${PLUGIN}/voices/renamed-from.wav`]});
    assert.deepEqual(summary.leftInPlace, [`${NOTE} (outside the folders a Runtime installs into)`, `${PLUGIN}/voices/pack-owned.wav (an optional pack ships it)`]);
    assert.equal(summary.added, 4);
    assert.equal(summary.changed, 3);
    assert.match(log.join('\n'), /1 file\(s\) in the removal list|4 file\(s\) in the removal list/);
    assert.match(log.join('\n'), /left in place, not in the removal list: .*pack-owned\.wav \(an optional pack ships it\)/);
    // The listing: every file, with its size and SHA-256, and the zip's own hash.
    const files = JSON.parse(await readFile(join(dir, 'out', `${name}.files.json`), 'utf8'));
    assert.deepEqual(files.map(file => file.path), Object.keys(held).sort());
    assert.deepEqual(files.find(file => file.path === `${APP}/bridge/new-module.mjs`), {path: `${APP}/bridge/new-module.mjs`, bytes: 10,
      sha256: (await import('node:crypto')).createHash('sha256').update('new module').digest('hex')});
    assert.equal(await readFile(join(dir, 'out', `${name}.sha256`), 'utf8'), `${await sha256File(zip)}  ${name}.zip\n`);
    assert.equal(summary.sha256, await sha256File(zip));
    // Nothing from the work folder is left behind, and the zip the build wrote is complete (no .tmp).
    assert.equal((await readdir(join(dir, 'out'))).some(file => file.endsWith('.tmp')), false);
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test('the same inputs give the same bytes', async () => {
  const dir = await temporary();
  try {
    const {old, next} = fixture(dir);
    const oldZip = await makeZip(join(dir, 'old.zip'), old), newZip = await makeZip(join(dir, 'new.zip'), next);
    const one = await buildRuntimeUpdate({oldZips: [oldZip], newZips: [newZip], out: join(dir, 'one'), listing: packListing, log: quiet});
    const two = await buildRuntimeUpdate({oldZips: [oldZip], newZips: [newZip], out: join(dir, 'two'), listing: packListing, log: quiet});
    assert.equal(one.sha256, two.sha256);
    // And it does not matter how the new full zip was made: the same files in another order, stored or deflated, give the same update.
    const again = await makeZip(join(dir, 'new2.zip'), Object.fromEntries(Object.entries(next).reverse()), {level: 1});
    const three = await buildRuntimeUpdate({oldZips: [oldZip], newZips: [again], out: join(dir, 'three'), listing: packListing, log: quiet});
    assert.equal((await entriesOf(join(dir, 'three', 'AI-NPC-Cyberpunk-Mod-Runtime-Update-0.2.2-to-0.2.3.zip')))[`${APP}/bridge/convai-bridge.mjs`], 'bridge v2 with more');
    assert.equal(three.entries, one.entries);
  } finally { await rm(dir, {recursive: true, force: true}); }
});

// Extracts a zip over a folder the way a player's Replace does.
async function extractOver(zip, folder) {
  for (const entry of await listZip(zip)) {
    const target = join(folder, ...entry.name.split('/'));
    await mkdir(dirname(target), {recursive: true});
    await extractEntry(zip, entry, target);
  }
}
async function tree(path, rel = '') {
  const out = {};
  for (const entry of await readdir(path, {withFileTypes: true})) {
    const name = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) Object.assign(out, await tree(join(path, entry.name), name));
    else out[name] = await sha256File(join(path, entry.name));
  }
  return out;
}

test('the old Runtime with the update extracted over it and the removal list applied is exactly the new Runtime', async () => {
  const dir = await temporary();
  try {
    const {old, next} = fixture(dir);
    // The old Runtime also holds what a player's folder holds: files that belong to no Runtime must survive.
    const oldZip = await makeZip(join(dir, 'old.zip'), old), newZip = await makeZip(join(dir, 'new.zip'), next);
    const {zip} = await buildRuntimeUpdate({oldZips: [oldZip], newZips: [newZip], out: join(dir, 'out'), listing: null, log: quiet});
    const player = join(dir, 'player'), expected = join(dir, 'expected');
    await extractOver(oldZip, player);
    await mkdir(join(player, 'archive/pc/mod'), {recursive: true});
    await writeFile(join(player, 'archive/pc/mod/another_mod.archive'), 'someone else\'s');
    await extractOver(zip, player);
    const result = applyRuntimeRemovals({appDirectory: join(player, APP), log: quiet});
    assert.equal(result.state, 'done');
    assert.equal(result.refused, 0);
    await extractOver(newZip, expected);
    const now = await tree(player), want = await tree(expected);
    // The update's removal list is its own (what went away); the new full Runtime's declares only its own extras.
    assert.notEqual(now[REMOVALS_ENTRY], want[REMOVALS_ENTRY]);
    delete now[REMOVALS_ENTRY]; delete want[REMOVALS_ENTRY];
    // The update adds its step marker and leaves the base marker as the old full Runtime had it.
    assert.notEqual(now[STEP_ENTRY], undefined);
    assert.equal(JSON.parse(await readFile(join(player, BASE_ENTRY), 'utf8')).base, '0.2.2');
    delete now[STEP_ENTRY]; delete now[BASE_ENTRY]; delete want[BASE_ENTRY];
    // Without a pack listing the pack file goes too; the install note stays (outside what the start step may delete) and the player's other mod is untouched.
    assert.equal(now['archive/pc/mod/another_mod.archive'] !== undefined, true);
    delete now['archive/pc/mod/another_mod.archive'];
    assert.equal(now[NOTE] !== undefined, true, 'the install note is left in place');
    delete now[NOTE];
    assert.deepEqual(now, want);
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test('a Runtime in several zips is compared as one, and versions can be named instead of read', async () => {
  const dir = await temporary();
  try {
    const {old, next} = fixture(dir);
    const split = (files, a) => Object.fromEntries(Object.entries(files).filter(([name]) => (name.length % 2 === 0) === a));
    const oldParts = [await makeZip(join(dir, 'old1.zip'), split(old, true)), await makeZip(join(dir, 'old2.zip'), split(old, false))];
    const newParts = [await makeZip(join(dir, 'new1.zip'), split(next, true)), await makeZip(join(dir, 'new2.zip'), split(next, false))];
    const summary = await buildRuntimeUpdate({oldZips: oldParts, newZips: newParts, out: join(dir, 'out'), from: '0.2.2', to: '0.2.3', listing: null, log: quiet});
    assert.equal(summary.added, 4);
    assert.equal(summary.changed, 3);
    // The same path in two parts is fine only when the bytes are the same.
    const clash = [await makeZip(join(dir, 'c1.zip'), {'a/b.txt': 'one'}), await makeZip(join(dir, 'c2.zip'), {'a/b.txt': 'two'})];
    await assert.rejects(runtimeFiles(clash), /different bytes/);
    await runtimeFiles([clash[0], await makeZip(join(dir, 'c3.zip'), {'a/b.txt': 'one'})]);
    // No release.json and no names given: it says what to pass.
    const bare = await makeZip(join(dir, 'bare.zip'), {'x.txt': 'x'});
    await assert.rejects(buildRuntimeUpdate({oldZips: [bare], newZips: [newParts[0]], out: join(dir, 'o2'), log: quiet}), /--from/);
    await assert.rejects(buildRuntimeUpdate({oldZips: [oldParts[0]], newZips: [oldParts[0]], out: join(dir, 'o3'), log: quiet}), /Both Runtimes are version|release\.json/);
    await assert.rejects(buildRuntimeUpdate({oldZips: oldParts, newZips: newParts, out: join(dir, 'o4'), from: '0.2', to: '0.2', log: quiet}), /Both Runtimes are version 0\.2/);
    await assert.rejects(buildRuntimeUpdate({oldZips: oldParts, newZips: newParts, out: join(dir, 'o5'), from: '../x', to: '1', log: quiet}), /Unusable version/);
    await assert.rejects(buildRuntimeUpdate({oldZips: [], newZips: newParts, out: join(dir, 'o6'), log: quiet}), /Name the previous/);
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test('extra removals are listed when the start step may delete them and refused when it may not', async () => {
  const dir = await temporary();
  try {
    const {old, next} = fixture(dir);
    const summary = await buildRuntimeUpdate({oldZips: [await makeZip(join(dir, 'old.zip'), old)], newZips: [await makeZip(join(dir, 'new.zip'), next)], out: join(dir, 'out'), listing: null,
      remove: [`${PLUGIN}/voices/extra.wav`, `${PLUGIN}/launcher.ini`, 'bin/x64/Cyberpunk2077.exe', `${APP}/bridge/new-module.mjs`], log: quiet});
    const held = await entriesOf(summary.zip);
    assert.deepEqual(JSON.parse(held[REMOVALS_ENTRY]).removes, ['archive/pc/mod/convai_old.archive', `${APP}/bridge/old-module.mjs`, `${PLUGIN}/voices/declared-gone.wav`,
      `${PLUGIN}/voices/extra.wav`, `${PLUGIN}/voices/pack-owned.wav`, `${PLUGIN}/voices/renamed-from.wav`]);
    assert.deepEqual(summary.leftInPlace.map(line => line.replace(/ \(.*\)$/, '')).sort(), [NOTE, `${APP}/bridge/new-module.mjs`, 'bin/x64/Cyberpunk2077.exe', `${PLUGIN}/launcher.ini`].sort());
    assert.match(summary.leftInPlace.find(line => line.includes('new-module')), /the new Runtime ships it/);
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test('entries are read back exactly: stored, deflated, empty and ZIP64, and a damaged one is caught', async () => {
  const dir = await temporary();
  try {
    const png = randomBytes(5000);
    const zip = await makeZip(join(dir, 'a.zip'), {'big.txt': BIG, 'empty.txt': '', 'pic.png': png, 'small.txt': 'hello'});
    const entries = await listZip(zip);
    assert.deepEqual(entries.map(entry => [entry.name, entry.method]), [['big.txt', 8], ['empty.txt', 8], ['pic.png', 0], ['small.txt', 8]]);
    for (const entry of entries) assert.equal(typeof entry.offset, 'number');
    assert.equal((await readEntry(zip, entries[0])).toString(), BIG);
    assert.equal((await readEntry(zip, entries[1])).length, 0);
    assert.deepEqual(await readEntry(zip, entries[2]), png);
    await assert.rejects(readEntry(zip, entries[0], {limit: 10}), /larger than/);
    // Entries written as ZIP64 (the sizes in an extra field) read the same.
    const big = await makeZip(join(dir, 'z.zip'), {'x.bin': png, 'y.txt': BIG}, {zip64Entry: 100});
    const zipped = await listZip(big);
    assert.deepEqual(await readEntry(big, zipped[0]), png);
    assert.equal((await readEntry(big, zipped[1])).toString(), BIG);
    const out = join(dir, 'x.bin');
    assert.equal(await extractEntry(big, zipped[0], out), png.length);
    assert.deepEqual(await readFile(out), png);
    // A flipped byte in the stored picture: the CRC-32 check refuses it.
    const bytes = await readFile(zip);
    bytes[entries[2].offset + 30 + 'pic.png'.length + 100] ^= 0xff;
    await writeFile(join(dir, 'bad.zip'), bytes);
    const bad = (await listZip(join(dir, 'bad.zip')))[2];
    await assert.rejects(readEntry(join(dir, 'bad.zip'), bad), /CRC-32/);
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test('the command line: usage with no arguments, and the same result as the function with them', async () => {
  const dir = await temporary();
  try {
    const script = join(project, 'packaging/build-runtime-update.mjs');
    const none = spawnSync(process.execPath, [script], {encoding: 'utf8'});
    assert.equal(none.status, 2);
    assert.match(none.stderr, /Usage: build-runtime-update\.mjs --old/);
    const {old, next} = fixture(dir);
    const oldZip = await makeZip(join(dir, 'old.zip'), old), newZip = await makeZip(join(dir, 'new.zip'), next);
    const run = spawnSync(process.execPath, [script, '--old', oldZip, '--new', newZip, '--out', join(dir, 'out')], {encoding: 'utf8'});
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /AI-NPC-Cyberpunk-Mod-Runtime-Update-0\.2\.2-to-0\.2\.3\.zip: .* MiB, 7 files \(4 added, 3 changed, 6 unchanged and left out\), 5 file\(s\) in the removal list\./);
    assert.match(run.stdout, /left in place, not in the removal list: HOW TO INSTALL/);
    assert.equal(run.stdout.trim().split('\n').pop().startsWith('SHA-256 '), true);
    const failed = spawnSync(process.execPath, [script, '--old', join(dir, 'missing.zip'), '--new', newZip, '--out', join(dir, 'out2')], {encoding: 'utf8'});
    assert.equal(failed.status, 1);
    assert.equal(await stat(join(dir, 'out2')).then(() => true, () => false), false, 'a failed run leaves no output folder');
  } finally { await rm(dir, {recursive: true, force: true}); }
});
