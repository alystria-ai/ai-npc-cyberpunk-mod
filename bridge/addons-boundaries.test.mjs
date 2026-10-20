import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, readFile, rm} from 'node:fs/promises';
import {readFileSync, readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {resolve, sep} from 'node:path';
import {ADDON_LIMITS, ADDON_PROVIDERS, AddonHost, CET_MODS, addonRoots, discoverAddons, isAddonProfile, parseAddonInput, parseAddonSettings,
  parseAddonState, sharedMemory, validateManifest} from './addons.mjs';
import {parseInput} from './protocol.mjs';

// The edges of the add-on host (bridge side): what a manifest, a state file, a bridge module, a voice file or a request from an add-on
// may be, and what happens when it is something else. docs/ADDON_API.md is the contract; each test names the promise it pins.
// The ordinary paths are in addons.test.mjs; a test marked `todo` below asserts the behaviour the docs promise and currently fails.
const read = path => readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

function manifest(overrides = {}) {
  return {schema: 1, id: 'skippy', name: 'Skippy', version: '1.0.0', requires: {api: '1.0'},
    speakers: [{id: 'gun', name: 'Skippy', persona: {backstory: 'A smart pistol with opinions.'}}], ...overrides};
}
const speaker = (id, extra = {}) => ({id, name: id.toUpperCase(), persona: {backstory: 'A voice.'}, ...extra});

function wav({seconds = 0.5, rate = 16000, bits = 16} = {}) {
  const bytesPerSample = bits / 8, samples = Math.round(seconds * rate), data = Buffer.alloc(samples * bytesPerSample);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii'); header.writeUInt32LE(36 + data.length, 4); header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii'); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24); header.writeUInt32LE(rate * bytesPerSample, 28); header.writeUInt16LE(bytesPerSample, 32); header.writeUInt16LE(bits, 34);
  header.write('data', 36, 'ascii'); header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

const folder = () => mkdtemp(resolve(tmpdir(), 'convai-addon-edge-'));
async function addonFolder(root, name, value) {
  const dir = resolve(root, name);
  await mkdir(dir, {recursive: true});
  if (value !== undefined) await writeFile(resolve(dir, 'convai-addon.json'), typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value));
  return dir;
}
const rootsOf = dirs => dirs.map(path => ({path, children: false}));
const inputFor = (key, extra = {}) => ({profileKey: key, reaction: {kind: 'addon'}, addon: {id: 'skippy', speaker: 'gun', event: 'e'}, ...extra});

// ---- Manifest validation ----------------------------------------------------------------------------------------------------

test('manifest: every wrong type or shape is refused with a message that names the field, never a crash message', () => {
  const dir = resolve(tmpdir(), 'addon-edge');
  const voice = extra => ({speakers: [speaker('gun', {voice: {reference: 'v.wav', transcript: 'Hi.', ...extra}})]});
  const bad = [
    // Not a manifest at all.
    [null, /JSON object/], [[], /JSON object/], ['skippy', /JSON object/], [7, /JSON object/],
    // schema and id
    [{schema: '1'}, /schema/], [{schema: null}, /schema/], [{schema: undefined}, /schema/],
    [{id: 7}, /id must/], [{id: null}, /id must/], [{id: ['skippy']}, /id must/], [{id: '../skippy'}, /id must/], [{id: 'a/b'}, /id must/],
    [{id: 'a.b'}, /id must/], [{id: 'a b'}, /id must/], [{id: '1ab'}, /id must/], [{id: 'a_b'}, /id must/], [{id: 'Ab'}, /id must/],
    [{id: ''}, /id must/], [{id: 'a'}, /id must/], [{id: 'a'.repeat(25)}, /id must/],
    // name and version
    [{name: 5}, /name/], [{name: {}}, /name/], [{name: '   '}, /name/], [{name: '\u0001\u0002'}, /name/],
    [{version: 1.0}, /version/], [{version: 'v1.0'}, /version/], [{version: '1'}, /version/], [{version: '1.0.0.0'}, /version/],
    [{version: '1.0.0-'}, /version/], [{version: '1.0 '}, /version/], [{version: `${'1'.repeat(200)}.0`}, /version/],
    // requires.api
    [{requires: undefined}, /requires\.api/], [{requires: '1.0'}, /requires\.api/], [{requires: ['1.0']}, /requires\.api/],
    [{requires: {}}, /requires\.api/], [{requires: {api: 1.0}}, /requires\.api/], [{requires: {api: ''}}, /requires\.api/],
    [{requires: {api: '1.0.0'}}, /requires\.api/], [{requires: {api: 'latest'}}, /requires\.api/], [{requires: {api: '1234.0'}}, /requires\.api/],
    // bridge: always a .mjs inside the add-on's own folder
    [{bridge: 5}, /bridge/], [{bridge: ''}, /bridge/], [{bridge: ' '}, /bridge/], [{bridge: 'a/../b.mjs'}, /bridge/],
    [{bridge: '..\\b.mjs'}, /bridge/], [{bridge: '\\\\server\\share\\b.mjs'}, /bridge/], [{bridge: '/b.mjs'}, /bridge/], [{bridge: 'C:\\b.mjs'}, /bridge/],
    [{bridge: 'b.cjs'}, /bridge/], [{bridge: 'b.json'}, /bridge/], [{bridge: 'bridge'}, /bridge/],
    // speakers
    [{speakers: null}, /speakers/], [{speakers: undefined}, /speakers/], [{speakers: {}}, /speakers/], [{speakers: 'gun'}, /speakers/],
    [{speakers: [null]}, /speakers\[0\]\.id/], [{speakers: [5]}, /speakers\[0\]\.id/], [{speakers: ['gun']}, /speakers\[0\]\.id/],
    [{speakers: [{}]}, /speakers\[0\]\.id/], [{speakers: [{id: 5, name: 'X'}]}, /speakers\[0\]\.id/], [{speakers: [{id: 'Gun', name: 'X'}]}, /speakers\[0\]\.id/],
    [{speakers: [{id: '../x', name: 'X'}]}, /speakers\[0\]\.id/], [{speakers: [{id: 'g'.repeat(25), name: 'X'}]}, /speakers\[0\]\.id/],
    [{speakers: [{id: 'gun', persona: {backstory: 'x'}}]}, /name is required/], [{speakers: [{id: 'gun', name: 7, persona: {backstory: 'x'}}]}, /name is required/],
    [{speakers: [{id: 'gun', name: 'X', persona: 'A pistol.'}]}, /backstory/], [{speakers: [{id: 'gun', name: 'X', persona: {backstory: 5}}]}, /backstory/],
    [{speakers: [{id: 'gun', name: 'X', persona: {backstory: '   '}}]}, /backstory/], [{speakers: [{id: 'gun', name: 'X'}]}, /backstory/],
    // voice
    [{speakers: [speaker('gun', {voice: 'v.wav'})]}, /voice must be an object/], [voice({reference: 5}), /\.wav inside/], [voice({reference: ''}), /\.wav inside/],
    [voice({reference: 'a/../../v.wav'}), /\.wav inside/], [voice({reference: 'C:\\v.wav'}), /\.wav inside/], [voice({reference: 'v.WAVE'}), /\.wav inside/],
    [voice({transcript: 5}), /transcript is required/], [voice({transcript: '   '}), /transcript is required/],
    [voice({sha256: 'A'.repeat(64)}), /sha256/], [voice({sha256: 'a'.repeat(63)}), /sha256/], [voice({sha256: 5}), /sha256/], [voice({sha256: null}), /sha256/],
    // providers
    [{providers: 'mistral'}, /providers/], [{providers: ['mistral', 'convai']}, /never use Convai/], [{providers: [null]}, /never use Convai/],
    [{speakers: [speaker('gun', {providers: []})]}, /providers/], [{speakers: [speaker('gun', {providers: 'local'})]}, /providers/],
    // modes
    [{speakers: [speaker('gun', {modes: []})]}, /modes must be an object/], [{speakers: [speaker('gun', {modes: 'killer'})]}, /modes must be an object/],
    [{speakers: [speaker('gun', {modes: {killer: null}})]}, /must be an object/], [{speakers: [speaker('gun', {modes: {killer: 'Cold'}})]}, /must be an object/],
    [{speakers: [speaker('gun', {modes: {'../x': {name: 'X'}}})]}, /mode id/], [{speakers: [speaker('gun', {modes: {['m'.repeat(25)]: {name: 'X'}}})]}, /mode id/],
    [{speakers: [speaker('gun', {modes: {__proto__x: {name: 'X'}}})]}, /mode id/],
    [{speakers: [speaker('gun', {modes: Object.fromEntries([1, 2, 3, 4, 5].map(n => [`m${n}`, {name: `M${n}`}]))})]}, /at most 4/],
    [{speakers: [speaker('gun', {defaultMode: 'killer'})]}, /defaultMode/], [{speakers: [speaker('gun', {modes: {calm: {name: 'Calm'}}, defaultMode: 'constructor'})]}, /defaultMode/],
    [{speakers: [speaker('gun', {modes: {calm: {name: 'Calm'}}, defaultMode: 5})]}, /defaultMode/],
    [{speakers: [speaker('gun', {modes: {calm: {name: 'Calm', talkWords: '20'}}})]}, /talkWords/],
  ];
  for (const [change, pattern] of bad) {
    const input = change !== null && typeof change === 'object' && !Array.isArray(change) ? manifest(change) : change;
    let thrown;
    try { validateManifest(input, dir); } catch (error) { thrown = error; }
    const shape = JSON.stringify(change);
    assert.ok(thrown, `accepted: ${shape}`);
    assert.equal(thrown.constructor, Error, `${shape} crashed with ${thrown.constructor.name}: ${thrown.message}`);
    assert.match(thrown.message, pattern, shape);
    assert.doesNotMatch(thrown.message, /undefined|\[object|Cannot read|is not a function/, `${shape}: ${thrown.message}`);
  }
});

test('manifest: the documented limits are exact: the longest and shortest legal values load, one past them does not', () => {
  const dir = resolve(tmpdir(), 'addon-edge');
  const longest = 'a' + 'b'.repeat(23);
  assert.equal(validateManifest(manifest({id: longest}), dir).speakers[0].profileKey, `addon-${longest}-gun`);
  assert.equal(validateManifest(manifest({id: 'ab'}), dir).id, 'ab');
  assert.equal(validateManifest(manifest({id: 'a1-b2'}), dir).id, 'a1-b2');
  for (const version of ['1.0', '1.0.0', '1.0.0-beta.1', '10.20.300', '1.0.0+build.5']) assert.equal(validateManifest(manifest({version}), dir).version, version);
  assert.equal(validateManifest(manifest({requires: {api: ' 1.0 '}}), dir).requires.api, '1.0', 'the api string is kept trimmed');
  assert.equal(validateManifest(manifest({speakers: [speaker('g'), speaker('a'.repeat(24))]}), dir).speakers.length, 2, 'speaker ids run from 1 to 24 characters');
  assert.equal(validateManifest(manifest({speakers: [1, 2, 3, 4].map(n => speaker(`s${n}`))}), dir).speakers.length, 4);
  const modes = Object.fromEntries([1, 2, 3, 4].map(n => [`m${n}`, {name: `M${n}`}]));
  assert.deepEqual(Object.keys(validateManifest(manifest({speakers: [speaker('gun', {modes})]}), dir).speakers[0].modes), ['m1', 'm2', 'm3', 'm4']);
  // A bridge module may sit in a sub folder; the resolved path stays inside the add-on's folder.
  const nested = validateManifest(manifest({bridge: 'lib/deep/bridge.mjs'}), dir).bridge;
  assert.equal(nested, resolve(dir, 'lib/deep/bridge.mjs'));
  assert.ok(nested.startsWith(resolve(dir) + sep));
  // A speaker's own providers beat the add-on's; with none the add-on's list applies.
  const mixed = validateManifest(manifest({providers: ['local'], speakers: [speaker('a'), speaker('b', {providers: ['mistral']})]}), dir);
  assert.deepEqual(mixed.speakers.map(item => item.providers), [['local'], ['mistral']]);
  assert.deepEqual(validateManifest(manifest(), dir).providers, [...ADDON_PROVIDERS], 'both providers by default');
});

test('manifest: oversized text is cut to its limit, not stored whole; control characters and non-text entries are cleaned', () => {
  const dir = resolve(tmpdir(), 'addon-edge');
  const huge = 'x'.repeat(50_000);
  const modes = {wild: {name: 'W'.repeat(200), intro: huge, identityRule: huge, backstory: huge, style: huge, samples: Array(40).fill(huge), rules: Array(40).fill(huge)}};
  const parsed = validateManifest(manifest({name: huge, speakers: [{id: 'gun', name: huge, modes, defaultMode: 'wild',
    persona: {intro: huge, identityRule: huge, backstory: huge, style: huge, samples: Array(40).fill(huge), rules: Array(40).fill(huge)},
    voice: {reference: 'v.wav', transcript: huge}}]}), dir);
  assert.equal(parsed.name.length, 60);
  const [gun] = parsed.speakers;
  assert.equal(gun.name.length, 60);
  assert.deepEqual([gun.persona.intro.length, gun.persona.identityRule.length, gun.persona.backstory.length, gun.persona.style.length],
    [1200, 1200, ADDON_LIMITS.persona, 3000]);
  assert.equal(gun.persona.samples.length, ADDON_LIMITS.samples);
  assert.equal(gun.persona.rules.length, ADDON_LIMITS.rules);
  assert.ok([...gun.persona.samples, ...gun.persona.rules].every(line => line.length === ADDON_LIMITS.line), 'each example and rule is cut to 600 characters');
  assert.equal(gun.voice.transcript.length, ADDON_LIMITS.transcript);
  const wild = gun.modes.wild;
  assert.deepEqual([wild.name.length, wild.intro.length, wild.identityRule.length, wild.backstory.length, wild.style.length], [60, 1200, 1200, 4000, 3000]);
  assert.equal(wild.samples.length, ADDON_LIMITS.samples);
  assert.equal(wild.rules.length, ADDON_LIMITS.rules);
  // Control characters become spaces; blank and non-string examples are dropped.
  const clean = validateManifest(manifest({name: 'Sk\u0000ip\u0007py', speakers: [{id: 'gun', name: 'Gun\u001f', persona: {backstory: 'A\u0000B',
    samples: [5, null, {}, '   ', 'V: Hi.\nSkippy: Hiya.'], rules: 'Never swear.'}}]}), dir);
  assert.equal(clean.name, 'Sk ip py');
  assert.equal(clean.speakers[0].name, 'Gun');
  assert.equal(clean.speakers[0].persona.backstory, 'A B');
  assert.deepEqual(clean.speakers[0].persona.samples, ['V: Hi.\nSkippy: Hiya.']);
  assert.deepEqual(clean.speakers[0].persona.rules, [], 'rules that are not a list are ignored');
});

test('manifest: an add-on with no speakers is valid, voiceContext is only ever true, and a top-level convai block changes nothing', () => {
  const dir = resolve(tmpdir(), 'addon-edge');
  // A companion-context-only add-on has no speaker: nothing for the roster, nothing for the persona book.
  const quiet = validateManifest(manifest({speakers: []}), dir);
  assert.deepEqual(quiet.speakers, []);
  const host = new AddonHost({addons: [quiet]});
  const roster = [], ids = {};
  host.extend(roster, ids);
  assert.deepEqual(roster, []);
  assert.deepEqual(host.status().addons[0].speakers, []);
  assert.equal(host.active, true, 'it is still an installed add-on (its companion context works)');
  // voiceContext: true or nothing.
  for (const value of ['yes', 1, 'true', null, {}, false]) {
    assert.equal(Object.hasOwn(validateManifest(manifest({speakers: [speaker('gun', {persona: {backstory: 'x', voiceContext: value}})]}), dir).speakers[0].persona, 'voiceContext'), false, String(value));
  }
  assert.equal(validateManifest(manifest({speakers: [speaker('gun', {persona: {backstory: 'x', voiceContext: true}})]}), dir).speakers[0].persona.voiceContext, true);
  // A speaker's convai block is refused outright, whatever it holds; a convai block at the top of the manifest has nothing to attach to:
  // it is not carried into the manifest, and no roster row or Convai ID comes of it.
  for (const value of [{characterId: 'abcd-1234'}, null, false, 'abcd-1234']) {
    assert.throws(() => validateManifest(manifest({speakers: [speaker('gun', {convai: value})]}), dir), /Mistral or the local AI only/, JSON.stringify(value));
  }
  const withTop = validateManifest(manifest({convai: {characterId: 'abcd-1234', sessionId: 'x'}}), dir);
  assert.equal(Object.hasOwn(withTop, 'convai'), false);
  assert.equal(JSON.stringify(withTop).includes('abcd-1234'), false);
  const topHost = new AddonHost({addons: [withTop]});
  const topIds = {};
  topHost.extend([], topIds);
  assert.deepEqual(topIds, {});
  assert.equal(topHost.routeFor('addon-skippy-gun', {applied: 'convai', mistralKey: false, localReady: false}), null, 'with no text provider there is no route, Convai is never the fallback');
});

// ---- Discovery -------------------------------------------------------------------------------------------------------------

test('discovery: an empty, null, unreadable, BOM-marked or nested manifest never stops the add-ons around it', async () => {
  const work = await folder();
  try {
    const empty = await addonFolder(work, 'a-empty', Buffer.alloc(0));
    const nul = await addonFolder(work, 'b-null', 'null');
    const bom = await addonFolder(work, 'c-bom', `\ufeff${JSON.stringify(manifest({id: 'bomed', name: 'Marked'}))}`);
    const asFolder = resolve(work, 'd-dir-manifest');
    await mkdir(resolve(asFolder, 'convai-addon.json'), {recursive: true});
    const noId = await addonFolder(work, 'e-no-id', {id: 5, name: 'Nameless Id'});
    const partial = await addonFolder(work, 'f-partial', {schema: 2, id: 'half-done', name: 'Half\u0000 Done'});
    const longId = await addonFolder(work, 'g-long-id', {schema: 2, id: 'x'.repeat(100), name: 'N'.repeat(200)});
    const good = await addonFolder(work, 'h-good', manifest({id: 'fine'}));
    const {addons, problems} = await discoverAddons({roots: rootsOf([empty, nul, bom, asFolder, noId, partial, longId, good])});
    assert.deepEqual(addons.map(addon => addon.id), ['bomed', 'fine']);
    const by = Object.fromEntries(problems.map(problem => [problem.dir.split(/[\\/]/).pop(), problem]));
    assert.deepEqual(Object.keys(by).sort(), ['a-empty', 'b-null', 'd-dir-manifest', 'e-no-id', 'f-partial', 'g-long-id']);
    assert.ok(Object.values(by).every(problem => problem.status === 'invalid'));
    assert.match(by['a-empty'].reason, /JSON/, 'a 0-byte manifest is reported as unreadable JSON, not thrown');
    assert.match(by['b-null'].reason, /JSON object/);
    assert.equal(by['d-dir-manifest'].reason, 'manifest unreadable');
    assert.equal(by['e-no-id'].id, undefined, 'an id that is not text is not repeated back');
    assert.deepEqual([by['f-partial'].id, by['f-partial'].name], ['half-done', 'Half  Done'], 'what can be read of a broken manifest names it in the notice');
    assert.equal(by['g-long-id'].id.length, 24);
    assert.equal(by['g-long-id'].name.length, 60);
    // The game is told about problems by folder name only: no absolute path reaches addons-status.json.
    const host = new AddonHost({addons, problems});
    const status = host.status().addons;
    assert.equal(status.length, 8);
    for (const entry of status.filter(item => item.status !== 'ready')) {
      assert.equal(entry.folder.includes('/') || entry.folder.includes('\\'), false, entry.folder);
      assert.equal(JSON.stringify(entry).includes(work.replaceAll('\\', '\\\\')), false, 'no absolute path in the status');
    }
  } finally { await rm(work, {recursive: true, force: true}); }
});

test('discovery: the CET mods folder is read one level deep, files and nested folders are not add-ons, a failing folder read is skipped', async () => {
  const game = await folder();
  try {
    const mods = resolve(game, CET_MODS);
    await addonFolder(mods, 'AiNpcCyberpunkModSkippy', manifest());
    await addonFolder(mods, 'Wrapper/Inner', manifest({id: 'buried', name: 'Buried'}));
    await mkdir(mods, {recursive: true});
    await writeFile(resolve(mods, 'convai-addon.json'), JSON.stringify(manifest({id: 'loose', name: 'Loose'})));
    await writeFile(resolve(mods, 'notes.txt'), 'not a folder');
    const {addons, problems} = await discoverAddons({roots: addonRoots({game, environment: {}})});
    assert.deepEqual(addons.map(addon => addon.id), ['skippy'], 'a manifest two folders down, or loose in the mods folder, is not an add-on');
    assert.deepEqual(problems, []);
    // A mods folder that cannot be listed, or a manifest that cannot be read for a reason other than being absent.
    const denied = Object.assign(Error('denied'), {code: 'EACCES'});
    const files = {
      readdir: async path => { if (path.endsWith('mods')) throw denied; return []; },
      readFile: async path => { if (path.includes('locked')) throw denied; throw Object.assign(Error('gone'), {code: path.includes('plain') ? 'ENOTDIR' : 'ENOENT'}); }};
    const roots = [{path: resolve(game, CET_MODS), children: true}, ...rootsOf([resolve(game, 'locked'), resolve(game, 'plain'), resolve(game, 'absent')])];
    const result = await discoverAddons({roots, files});
    assert.deepEqual(result.addons, []);
    assert.deepEqual(result.problems.map(problem => [problem.dir.split(/[\\/]/).pop(), problem.status, problem.reason]), [['locked', 'invalid', 'manifest unreadable']],
      'a folder with no manifest is silent; only one that exists and cannot be read is a problem');
    // Even when the whole host cannot start the game still gets an empty, inert host.
    const host = await AddonHost.load({game, environment: {}, files: {readdir: async () => { throw Error('disk fell off'); }, readFile: async () => { throw Error('disk fell off'); }}});
    assert.equal(host.active, false);
  } finally { await rm(game, {recursive: true, force: true}); }
});

test('discovery: an add-on that needs a newer API does not reserve its id, at most eight add-ons load, and the rest are named as skipped', async () => {
  const work = await folder();
  try {
    const first = await addonFolder(work, '0-too-new', manifest({requires: {api: '1.1'}, version: '2.0.0'}));
    const second = await addonFolder(work, '1-current', manifest({version: '1.5.0'}));
    const third = await addonFolder(work, '2-twin', manifest({version: '1.6.0'}));
    let result = await discoverAddons({roots: rootsOf([first, second, third])});
    assert.deepEqual(result.addons.map(addon => addon.version), ['1.5.0'], 'the newer-API copy never loaded, so the current one is not its duplicate');
    assert.deepEqual(result.problems.map(problem => problem.status), ['incompatible', 'duplicate']);
    assert.deepEqual([result.problems[0].requires, result.problems[0].version], ['1.1', '2.0.0']);
    // The same manifest is fine on a main mod that serves 1.1.
    result = await discoverAddons({roots: rootsOf([first]), version: '1.1'});
    assert.equal(result.addons.length, 1);
    result = await discoverAddons({roots: rootsOf([first]), version: '2.0'});
    assert.equal(result.problems[0].status, 'incompatible', 'a main mod on a newer major does not serve an older major either');
    const dirs = [];
    for (let index = 0; index < 11; index++) dirs.push(await addonFolder(work, `many-${String(index).padStart(2, '0')}`, manifest({id: `addon${index}`, name: `Add-on ${index}`})));
    result = await discoverAddons({roots: rootsOf(dirs)});
    assert.equal(result.addons.length, ADDON_LIMITS.addons);
    assert.deepEqual(result.addons.map(addon => addon.id), dirs.slice(0, 8).map((_, index) => `addon${index}`), 'the first eight by folder name');
    assert.deepEqual(result.problems.map(problem => [problem.id, problem.status, problem.reason]),
      [8, 9, 10].map(index => [`addon${index}`, 'skipped', 'too many add-ons']));
  } finally { await rm(work, {recursive: true, force: true}); }
});

test('discovery: two add-ons never share a profile key (addon-<id>-<speaker> must be unambiguous across add-ons)', async () => {
  const work = await folder();
  try {
    const real = await addonFolder(work, 'a-real', manifest({id: 'delamain-cab', name: 'Delamain', speakers: [speaker('delamain')]}));
    const other = await addonFolder(work, 'b-other', manifest({id: 'delamain', name: 'Other', speakers: [speaker('cab-delamain')]}));
    const {addons, problems} = await discoverAddons({roots: rootsOf([real, other])});
    const keys = addons.flatMap(addon => addon.speakers.map(item => item.profileKey));
    assert.equal(new Set(keys).size, keys.length, `profile keys collide: ${keys.join(', ')}`);
    assert.deepEqual(addons.map(addon => addon.id), ['delamain-cab'], 'the first one keeps its speaker');
    assert.equal(problems.length, 1);
    const host = new AddonHost({addons});
    assert.equal(host.speakers.get('addon-delamain-cab-delamain').addon.id, 'delamain-cab');
  } finally { await rm(work, {recursive: true, force: true}); }
});

test('the main roster has no key that looks like an add-on speaker, and an add-on speaker can never replace a main row', () => {
  const rows = [...JSON.parse(read('../characters/roster.json')), ...JSON.parse(read('../characters/archetype-roster.json'))];
  assert.ok(rows.length > 100);
  assert.deepEqual(rows.filter(row => isAddonProfile(row.key)).map(row => row.key), [], 'every addon- key is an add-on speaker; no character may use that prefix');
  // Extending the roster only appends: a row that exists keeps its place and its data, the Convai ID of a main row is left alone, and
  // every addon-* key in the ID map is removed (also one no installed add-on owns).
  const host = new AddonHost({addons: [validateManifest(manifest(), tmpdir())]});
  const roster = rows.slice(0, 3).map(row => ({...row}));
  const before = JSON.stringify(roster);
  const [first] = roster;
  const ids = {[first.key]: 'main-id', 'addon-skippy-gun': 'stolen', 'addon-someone-else': 'stolen too'};
  const logs = [];
  const logged = new AddonHost({addons: host.addons, log: line => logs.push(line)});
  logged.extend(roster, ids);
  assert.equal(JSON.stringify(roster.slice(0, 3)), before);
  assert.equal(roster.length, 4);
  assert.deepEqual(ids, {[first.key]: 'main-id'});
  assert.equal(logs.length, 2);
  // A second extend (a reload) adds nothing again.
  logged.extend(roster, {});
  assert.equal(roster.length, 4);
  // A roster that already holds the add-on's key (a hand-edited roster) keeps its own row.
  const own = [{key: 'addon-skippy-gun', name: 'Handmade'}];
  new AddonHost({addons: host.addons}).extend(own, {});
  assert.deepEqual(own, [{key: 'addon-skippy-gun', name: 'Handmade'}]);
});

// ---- Files the game writes -------------------------------------------------------------------------------------------------

test('state and settings files: hostile keys cannot reach Object.prototype, and nesting, breadth and size are bounded', () => {
  const polluted = JSON.parse('{"__proto__": {"polluted": true}, "constructor": {"prototype": {"polluted": true}}, "prototype": {"polluted": true}}');
  const state = parseAddonState(JSON.stringify({version: 1, updated: 5, addons: {...polluted, skippy: {state: polluted, modes: polluted, memories: [polluted],
    companionContext: [{key: '__proto__', text: 'x'}], warm: polluted, stock: [polluted]}}}));
  parseAddonSettings(JSON.stringify({version: 1, addons: {...polluted, skippy: polluted}}));
  const input = parseAddonInput({id: 'skippy', speaker: 'gun', facts: polluted, blocks: [{key: '__proto__', text: 'x'}]});
  assert.equal(({}).polluted, undefined);
  assert.equal(Object.prototype.polluted, undefined);
  assert.equal(Object.getPrototypeOf(state.addons), Object.prototype, 'the map of add-ons keeps its own prototype');
  assert.deepEqual(Object.keys(state.addons).sort(), ['constructor', 'prototype', 'skippy'], 'a key that is a legal id is an own key; __proto__ is never one');
  assert.ok(input);
  // Depth, breadth, string length and total size.
  const deep = {a: {b: {c: {d: {e: 'too deep'}}}}};
  const wide = Object.fromEntries(Array.from({length: 100}, (_, index) => [`k${index}`, index]));
  const cleaned = parseAddonInput({id: 'skippy', speaker: 'gun', facts: {deep, wide, list: Array.from({length: 100}, (_, index) => index), text: 'y'.repeat(1000),
    'bad key': 1, ['k'.repeat(41)]: 2, nothing: null, flag: true}}).facts;
  assert.equal(cleaned.deep.a.b.c, null, 'nesting stops at four levels');
  assert.equal(Object.keys(cleaned.wide).length, 32);
  assert.equal(cleaned.list.length, 24);
  assert.equal(cleaned.text.length, 240);
  assert.equal(Object.hasOwn(cleaned, 'bad key'), false);
  assert.equal(Object.hasOwn(cleaned, 'k'.repeat(41)), false);
  assert.deepEqual([cleaned.nothing, cleaned.flag], [null, true]);
  assert.equal(parseAddonInput({id: 'skippy', speaker: 'gun', facts: {text: Array.from({length: 24}, () => 'z'.repeat(240))}}).facts, undefined,
    'facts that pass 4,000 characters in all are dropped, not cut');
  assert.equal(parseAddonInput({id: 'skippy', speaker: 'gun', facts: [1, 2]}).facts, undefined, 'facts must be an object');
  // maxWords, event and mode that are not valid are left out, so the defaults apply.
  const odd = parseAddonInput({id: 'skippy', speaker: 'gun', event: 'bad event', maxWords: 2.5, mode: 'Bad Mode', text: 'a'.repeat(5000)});
  assert.deepEqual(Object.keys(odd).sort(), ['id', 'speaker', 'text']);
  assert.equal(odd.text.length, ADDON_LIMITS.eventText);
  for (const maxWords of [2, 61, '8', NaN, null]) assert.equal(Object.hasOwn(parseAddonInput({id: 'skippy', speaker: 'gun', maxWords}), 'maxWords'), false, String(maxWords));
  assert.equal(parseAddonInput({id: 'skippy', speaker: 'gun', maxWords: 3}).maxWords, 3);
  assert.equal(parseAddonInput({id: 'skippy', speaker: 'gun', maxWords: 60}).maxWords, 60);
  // Blocks: a bad key, an empty text, the ninth block and one that would pass 4,000 characters in all are skipped; unknown tiers become 'world'.
  const blocks = parseAddonInput({id: 'skippy', speaker: 'gun', blocks: [{key: 'a b', text: 'bad key'}, {key: 'empty', text: '  '}, {key: 'tier', text: 'ok', tier: 'now'},
    {key: 'big1', text: 'x'.repeat(2000)}, {key: 'big2', text: 'x'.repeat(2000)}, {key: 'big3', text: 'x'.repeat(2000)}, {key: 'small', text: 'fits', tier: 'notes'}]}).blocks;
  assert.deepEqual(blocks.map(block => [block.key, block.tier]), [['tier', 'world'], ['big1', 'world'], ['big2', 'world'], ['small', 'notes']]);
  assert.ok(blocks.every(block => block.text.length <= ADDON_LIMITS.blockText));
  assert.ok(blocks.reduce((sum, block) => sum + block.text.length, 0) <= ADDON_LIMITS.blocksTotal);
  assert.equal(parseAddonInput({id: 'skippy', speaker: 'gun', blocks: Array.from({length: 20}, (_, index) => ({key: `b${index}`, text: 'x'}))}).blocks.length, ADDON_LIMITS.blocks);
});

test('state and settings files: empty, truncated or wrong-shaped documents read as "nothing yet", and one add-on cannot reach another add-on\'s speakers', () => {
  for (const raw of ['', '   \r\n', '{', '{"version": 1, "updated": 5, "addons": {"skippy": {"mod', 'null', '[]', '"text"', '7', 'true', '{}',
    JSON.stringify({version: 2, updated: 5, addons: {}}), JSON.stringify({version: 1, updated: 'now', addons: {}}), JSON.stringify({version: 1, updated: 5, addons: []}),
    JSON.stringify({version: 1, updated: 5, addons: 'skippy'}), JSON.stringify({version: 1, addons: {skippy: {}}})]) {
    assert.deepEqual(parseAddonState(raw), {addons: {}}, JSON.stringify(raw));
  }
  for (const raw of ['', '{', 'null', '[]', '{}', JSON.stringify({version: 1}), JSON.stringify({version: 1, addons: []}), JSON.stringify({version: 2, addons: {skippy: {a: 1}}})]) {
    assert.deepEqual(parseAddonSettings(raw), {}, JSON.stringify(raw));
  }
  assert.deepEqual(parseAddonState(JSON.stringify({version: 1, updated: 5, addons: {'../x': {state: {a: 1}}, 'Bad Id': {}, skippy: 'no', cab: null, ok1: {}}})).addons,
    {ok1: {companionContext: [], modes: {}, memories: [], stock: []}}, 'only well-formed add-on ids with an object survive');
  // Counts: eight add-ons, four companion blocks, the last 48 memories.
  const manyAddons = Object.fromEntries(Array.from({length: 20}, (_, index) => [`addon${index}`, {}]));
  assert.equal(Object.keys(parseAddonState(JSON.stringify({version: 1, updated: 5, addons: manyAddons})).addons).length, ADDON_LIMITS.addons);
  const entry = parseAddonState(JSON.stringify({version: 1, updated: 5, addons: {skippy: {
    companionContext: Array.from({length: 10}, (_, index) => ({key: `c${index}`, text: 'x'.repeat(2000)})),
    memories: Array.from({length: 200}, (_, index) => ({speaker: 'gun', text: `memory ${index}`, at: index}))}}})).addons.skippy;
  assert.equal(entry.companionContext.length, ADDON_LIMITS.companionBlocks);
  assert.ok(entry.companionContext.every(block => block.text.length === ADDON_LIMITS.companionText));
  assert.equal(entry.memories.length, ADDON_LIMITS.memories * ADDON_LIMITS.speakers);
  assert.equal(entry.memories.at(-1).text, 'memory 199');
  // Through the host: modes, memories and warm-ups are applied for the add-on's own speakers only.
  const host = new AddonHost({addons: [validateManifest(manifest({speakers: [speaker('gun', {modes: {calm: {name: 'Calm'}}})]}), tmpdir()),
    validateManifest(manifest({id: 'cab', name: 'Cab', speakers: [speaker('voice')]}), tmpdir())], startedAt: 0});
  const warmed = [];
  host.onWarm = key => warmed.push(key);
  host.observeState(JSON.stringify({version: 1, updated: 5, addons: {
    skippy: {modes: {gun: 'calm', voice: 'calm', stranger: 'calm'}, memories: [{speaker: 'voice', text: 'meant for the cab', at: 1}, {speaker: 'ghost', text: 'nobody', at: 1}], warm: {speaker: 'voice', at: 3}},
    nobody: {memories: [{speaker: 'gun', text: 'from an add-on that is not installed', at: 1}], warm: {speaker: 'gun', at: 4}}}}));
  assert.equal(host.modeOf('addon-skippy-gun').id, 'calm');
  assert.deepEqual(host.memories('addon-cab-voice'), [], 'skippy\'s state cannot write the cab\'s memories');
  assert.deepEqual(host.memories('addon-skippy-gun'), []);
  assert.deepEqual(Object.keys(host.journal.speakers), [], 'no journal entry for a speaker nobody owns');
  assert.deepEqual(warmed, [], 'a warm-up names a speaker of the same add-on or nothing');
  assert.equal(host.remember('judy-alvarez', 'a memory for a main character'), false);
  host.afterReply({profileKey: 'judy-alvarez', text: 'hello'}, 'a line of a main character');
  assert.deepEqual(Object.keys(host.journal.speakers), [], 'the journal is for add-on speakers only');
});

test('addon-state.json: a half-written (truncated) file keeps what was last seen, like an empty one', async () => {
  const host = new AddonHost({addons: [validateManifest(manifest({speakers: [speaker('gun', {modes: {calm: {name: 'Calm'}}})]}), tmpdir())], startedAt: 0});
  const document = JSON.stringify({version: 1, updated: 5, addons: {skippy: {companionContext: [{key: 'ride', text: 'You are riding in a cab.'}],
    stock: [{speaker: 'gun', key: 'kill', text: 'V is about to kill.', rev: 1, slots: [], blocks: []}]}}});
  host.observeState(document);
  assert.equal(host.blocks({profileKey: 'judy-alvarez'}).length, 1);
  const torn = document.slice(0, Math.floor(document.length * 0.6));
  for (const handler of Object.values(host.watchHandlers('runtime', {read: async () => torn}))) await handler();
  assert.equal(host.blocks({profileKey: 'judy-alvarez'}).length, 1, 'the companion context survived the torn read');
  assert.equal(host.state.addons.skippy.stock.length, 1, 'so did the prepared stock rows');
  // The settings file is written the same way: a torn read is not "every setting back to its default".
  const seen = [];
  host.modules.set('skippy', {onSettings: values => seen.push(values)});
  const settings = JSON.stringify({version: 1, addons: {skippy: {sarcasm: 7, loud: true}}});
  host.observeSettings(settings);
  const tornSettings = settings.slice(0, Math.floor(settings.length * 0.6));
  for (const handler of Object.values(host.watchHandlers('runtime', {read: async () => tornSettings}))) await handler();
  assert.deepEqual(host.settings, {skippy: {sarcasm: 7, loud: true}}, 'the settings survived the torn read');
  assert.equal(seen.length, 1, 'and no module was told its settings changed');
  // A complete document still replaces what was seen (also one that really is empty of add-ons).
  for (const handler of Object.values(host.watchHandlers('runtime', {read: async () => JSON.stringify({version: 1, updated: 6, addons: {}})}))) await handler();
  assert.deepEqual(host.state.addons, {}, 'a whole document is applied');
});

test('the placeholder files shipped empty (addon-state.json, addon-settings.json) and a missing runtime folder read as nothing yet', async () => {
  const runtime = await folder();
  try {
    await writeFile(resolve(runtime, 'addon-state.json'), '');
    await writeFile(resolve(runtime, 'addon-settings.json'), '');
    await writeFile(resolve(runtime, 'addons-status.json'), '');
    const host = new AddonHost({addons: [validateManifest(manifest(), tmpdir())], startedAt: 0});
    const seen = [];
    host.modules.set('skippy', {onSettings: values => seen.push(values)});
    const handlers = host.watchHandlers(runtime);
    assert.deepEqual(Object.keys(handlers).sort(), ['addon-settings.json', 'addon-state.json'], 'the status file is the bridge\'s to write, never watched');
    for (const handler of Object.values(handlers)) await handler();
    assert.deepEqual(host.state, {addons: {}});
    assert.deepEqual(host.settings, {});
    assert.deepEqual(seen, [], 'an empty settings file is not a change');
    // The folder itself missing (a game that never ran): the same.
    for (const handler of Object.values(host.watchHandlers(resolve(runtime, 'not-there')))) await handler();
    assert.deepEqual(host.state, {addons: {}});
    // The host publishes over the empty placeholder and a reader of that file can parse it.
    assert.equal(await host.publishStatus(runtime), true);
    assert.equal(JSON.parse(await readFile(resolve(runtime, 'addons-status.json'), 'utf8')).addons[0].status, 'ready');
  } finally { await rm(runtime, {recursive: true, force: true}); }
});

test('addon-journal.json: an empty, corrupt, foreign or oversized journal starts the add-on with a clean, bounded history', async () => {
  const dir = await folder();
  try {
    const host = () => new AddonHost({addons: [validateManifest(manifest(), tmpdir())], startedAt: 0});
    for (const text of ['', '   ', '{', 'null', '[]', '"x"', JSON.stringify({version: 2, speakers: {'addon-skippy-gun': {lines: [{text: 'x'}]}}}),
      JSON.stringify({version: 1, speakers: []}), JSON.stringify({version: 1, speakers: 'x'})]) {
      await writeFile(resolve(dir, 'addon-journal.json'), text);
      const candidate = host();
      await candidate.loadJournal(dir);
      assert.deepEqual([candidate.recentLines('addon-skippy-gun'), candidate.memories('addon-skippy-gun')], [[], []], JSON.stringify(text));
    }
    // Entries of speakers that are not installed are dropped; lines and memories are bounded; bad rows are skipped.
    await writeFile(resolve(dir, 'addon-journal.json'), JSON.stringify({version: 1, speakers: {
      'addon-skippy-gun': {lines: [...Array.from({length: 40}, (_, index) => ({text: `line ${index} ${'x'.repeat(1000)}`, at: 'later', event: 'e'.repeat(100)})), null, 5, {text: 7}],
        memories: [...Array.from({length: 40}, (_, index) => ({text: `memory ${index} ${'m'.repeat(1000)}`, at: index})), 'x']},
      'addon-gone-gun': {lines: [{text: 'nobody'}], memories: [{text: 'nobody'}]}, 'judy-alvarez': {lines: [{text: 'a main character'}]},
      'addon-skippy-other': 'x'}}));
    const loaded = host();
    await loaded.loadJournal(dir);
    assert.equal(loaded.recentLines('addon-skippy-gun').length, ADDON_LIMITS.recentLines);
    assert.ok(loaded.recentLines('addon-skippy-gun').every(line => line.length <= 600));
    assert.match(loaded.recentLines('addon-skippy-gun').at(-1), /^line 39 /);
    assert.equal(loaded.memories('addon-skippy-gun').length, ADDON_LIMITS.memories);
    assert.ok(loaded.memories('addon-skippy-gun').every(line => line.length <= ADDON_LIMITS.memoryText));
    assert.deepEqual(Object.keys(loaded.journal.speakers), ['addon-skippy-gun']);
    assert.ok(loaded.journal.speakers['addon-skippy-gun'].lines.every(line => line.at === 0 && (line.event === undefined || line.event.length <= 48)));
    // No state folder, no journal path: nothing is read and nothing would be written.
    const quiet = host();
    await quiet.loadJournal(undefined);
    quiet.afterReply(inputFor('addon-skippy-gun'), 'A line.');
    assert.equal(quiet.journalPath, null);
    assert.equal(quiet.journalTimer, null, 'no save is scheduled without a folder');
  } finally { await rm(dir, {recursive: true, force: true}); }
});

// ---- Bridge modules --------------------------------------------------------------------------------------------------------

test('bridge module: one that fails to import or to activate leaves its add-on working without hooks, reported once, and other add-ons keep theirs', async () => {
  const logs = [];
  const addons = ['alpha', 'broken', 'late', 'newer', 'plain'].map(id => validateManifest(manifest({id, name: id.toUpperCase(), bridge: 'bridge.mjs', speakers: [speaker('voice')]}), resolve(tmpdir(), id)));
  const host = new AddonHost({addons, log: line => logs.push(line)});
  const modules = {
    alpha: {speakerBlocks: () => [{key: 'k', text: 'alpha block'}], activate: api => { assert.equal(Object.isFrozen(api) && Object.isFrozen(api.addon), true); }},
    broken: null,   // import throws
    late: {activate() { throw Error('late boom'); }, speakerBlocks: () => [{key: 'k', text: 'never used'}]},
    newer: {apiVersion: '2.0', speakerBlocks: () => [{key: 'k', text: 'never used'}]},
    plain: {},
  };
  await host.loadModules({importModule: async path => {
    const id = ['alpha', 'broken', 'late', 'newer', 'plain'].find(name => path.includes(`${name}`));
    if (modules[id] === null) throw SyntaxError('Unexpected token }');
    return modules[id];
  }});
  assert.deepEqual([...host.modules.keys()].sort(), ['alpha', 'plain']);
  assert.deepEqual([...host.moduleErrors.entries()].sort(), [['broken', 'Unexpected token }'], ['late', 'late boom'], ['newer', 'bridge module needs add-on API 2.0']]);
  assert.equal(logs.filter(line => /bridge module not loaded/.test(line)).length, 3, 'one line for each failure, nothing repeated');
  const text = id => host.blocks(inputFor(`addon-${id}-voice`, {addon: {id, speaker: 'voice', event: 'e'}})).map(block => block.text).join('|');
  assert.match(text('alpha'), /alpha block/);
  for (const id of ['broken', 'late', 'newer', 'plain']) assert.doesNotMatch(text(id), /never used|alpha block/, id);
  for (let turn = 0; turn < 5; turn++) text('broken');
  assert.equal(logs.filter(line => /bridge module not loaded/.test(line)).length, 3, 'a turn never reports the load failure again');
  // The status the game reads keeps every add-on ready and names only the module error.
  const status = Object.fromEntries(host.status().addons.map(entry => [entry.id, entry]));
  assert.ok(Object.values(status).every(entry => entry.status === 'ready'));
  assert.equal(status.alpha.moduleError, undefined);
  assert.equal(status.broken.moduleError, 'Unexpected token }');
  // The failure counter of a hook belongs to its add-on: three failures of one add-on's check do not switch another's off.
  let good = 0;
  host.modules.set('alpha', {check: () => { good++; return null; }});
  host.modules.set('plain', {check: () => { throw Error('rule check broke'); }});
  for (let turn = 0; turn < 6; turn++) {
    host.review(inputFor('addon-plain-voice', {addon: {id: 'plain', speaker: 'voice', event: 'e'}}), 'a line');
    host.review(inputFor('addon-alpha-voice', {addon: {id: 'alpha', speaker: 'voice', event: 'e'}}), 'a line');
  }
  assert.equal(good, 6);
  assert.equal(logs.filter(line => /plain: check failed/.test(line)).length, 3);
  assert.equal(logs.filter(line => /switched off/.test(line)).length, 1);
});

test('bridge module: whatever a hook returns is bounded, sanitised and namespaced; a slow hook is logged and still used', () => {
  const logs = [];
  const host = new AddonHost({addons: [validateManifest(manifest(), tmpdir())], log: line => logs.push(line), startedAt: 0});
  const input = inputFor('addon-skippy-gun', {addon: {id: 'skippy', speaker: 'gun', event: 'e'}});
  const huge = 'T'.repeat(100_000);
  host.modules.set('skippy', {
    speakerBlocks: () => Array.from({length: 1000}, (_, index) => ({key: `k${index}`, text: huge, tier: ['now', 'system', '__proto__', 'notes', 'world', undefined][index % 6]})),
    trigger: () => huge, check: () => huge, remember: () => huge});
  const blocks = host.blocks(input);
  assert.equal(blocks.length, 1 + ADDON_LIMITS.blocks, 'the no-body note and at most eight blocks of the module');
  assert.ok(blocks.every(block => block.text.length <= ADDON_LIMITS.blockText));
  assert.ok(blocks.every(block => ['notes', 'volatile', 'world'].includes(block.tier)), `tiers: ${blocks.map(block => block.tier)}`);
  assert.ok(blocks.every(block => block.key.startsWith('addon:skippy:')), 'a module can only add blocks under its own namespace, never replace a main mod block');
  assert.equal(host.trigger(input).length, 1200);
  assert.equal(host.review(input, 'A fresh line.').rule.length, 120);
  host.afterReply(input, 'A fresh line.');
  assert.equal(host.memories('addon-skippy-gun')[0].length, ADDON_LIMITS.memoryText);
  // Return values that are not lists of blocks are ignored, and odd entries are skipped without a throw.
  for (const value of [null, undefined, 5, 'text', {}, true, () => 1]) {
    host.modules.set('skippy', {speakerBlocks: () => value});
    assert.equal(host.blocks(input)[0].tier, 'notes');
    assert.ok(host.blocks(input).every(block => !block.key.endsWith(':undefined')));
  }
  host.modules.set('skippy', {speakerBlocks: () => [null, 3, undefined, {text: 5}, {text: '   '}, {text: 'kept', key: '../../x'}, 'plain', ['array']]});
  assert.deepEqual(host.blocks(input).filter(block => block.key.startsWith('addon:skippy:') && /kept|plain/.test(block.text)).map(block => block.text), ['kept', 'plain']);
  // Return values of the trigger and check hooks that are not text: the default applies, no rule.
  for (const value of [5, {}, [], null, false, '   ']) {
    host.modules.set('skippy', {trigger: () => value, check: () => value});
    assert.match(host.trigger(input), /This event was not spoken by V/, String(value));
    assert.equal(host.review(input, 'Another fresh line.').rule, undefined, String(value));
  }
  // The 5 ms budget: a hook that runs longer is logged (with its time), and its answer is still used.
  const busy = ms => { const end = performance.now() + ms; while (performance.now() < end); };
  host.modules.set('skippy', {trigger: () => { busy(12); return 'Slow but fine.'; }});
  assert.equal(host.trigger(input), 'Slow but fine.');
  assert.ok(logs.some(line => /trigger took \d+\.\d ms; keep hooks under 5 ms/.test(line)), logs.join('\n'));
  assert.equal(host.hookFailures.get('skippy:trigger'), undefined, 'slow is not a failure, the hook stays on');
});

test('bridge module: activate or import that never settles must not hold up the bridge start', async () => {
  assert.ok(ADDON_LIMITS.moduleMs >= 2000, 'the real wait is long enough for a cold import on a slow disk');
  const hung = new Promise(() => {});
  const limit = ms => new Promise(done => setTimeout(() => done('timed out'), ms));
  for (const [label, importModule] of [['activate', async () => ({activate: () => hung})], ['import', () => hung]]) {
    const host = new AddonHost({addons: [validateManifest(manifest({bridge: 'bridge.mjs'}), tmpdir())]});
    const outcome = await Promise.race([host.loadModules({importModule, timeoutMs: 50}).then(() => 'loaded'), limit(2000)]);
    assert.equal(outcome, 'loaded', `a module whose ${label} never settles held the bridge start`);
    assert.equal(host.modules.has('skippy'), false, 'and its hooks are not used');
    assert.match(host.moduleErrors.get('skippy'), /did not finish within/, 'and the reason is kept for the status file');
  }
});

// ---- Routes, requests and voices ----------------------------------------------------------------------------------------------

test('routes: for every provider set and player state the route is never Convai, always one the speaker allows and can use (or the player\'s ready Custom provider), and the player\'s own choice wins', () => {
  const sets = [['mistral', 'local'], ['mistral'], ['local'], ['local', 'mistral']];
  const addons = sets.map((providers, index) => validateManifest(manifest({id: `set${index}`, name: `Set ${index}`, providers: index === 3 ? undefined : providers,
    speakers: [speaker('voice', index === 3 ? {providers} : {})]}), tmpdir()));
  const host = new AddonHost({addons});
  let checked = 0;
  for (const [index, providers] of sets.entries()) {
    const key = `addon-set${index}-voice`;
    for (const applied of ['convai', 'mistral', 'local', 'custom', 'groq', undefined, null, '']) {
      for (const mistralKey of [false, true]) for (const localReady of [false, true]) for (const customReady of [false, true]) {
        const route = host.routeFor(key, {applied, mistralKey, localReady, customReady});
        const usable = name => providers.includes(name) && (name === 'mistral' ? mistralKey : localReady);
        const label = JSON.stringify({providers, applied, mistralKey, localReady, customReady, route});
        checked++;
        assert.notEqual(route, 'convai', label);
        // Custom only when it is the player's chosen provider and its endpoint is ready, for every speaker; otherwise one the speaker allows.
        const custom = applied === 'custom' && customReady;
        assert.equal(route === 'custom', custom, label);
        assert.ok(route === null || route === 'custom' || providers.includes(route), label);
        // The player chose Local AI and the speaker allows it: the route is Local AI even when it is failing right now (localReady false). The turn then fails with
        // Local AI's own notice and is tried again; it is never moved to Mistral behind the player's back (owner rule 2026-10-21).
        const ownLocal = applied === 'local' && providers.includes('local');
        if (route === 'mistral') { assert.ok(mistralKey, label); assert.ok(!ownLocal, `Local AI is never exchanged for Mistral: ${label}`); }
        if (route === 'local') assert.ok(localReady || ownLocal, label);
        if (ownLocal) assert.equal(route, 'local', label);
        if (!custom && !ownLocal) {
          assert.equal(route === null, !usable('mistral') && !usable('local'), `it never gives up while something allowed works: ${label}`);
          if (usable(applied)) assert.equal(route, applied, `the player's own provider first: ${label}`);
        }
      }
    }
  }
  assert.equal(checked, 4 * 8 * 8);
  assert.equal(host.routeFor('addon-set0-voice'), null, 'no state at all means no route');
  assert.equal(host.routeFor('addon-set0-voice', {}), null);
  for (const key of ['judy-alvarez', 'addon-set0-other', '', undefined, null, 5, {}]) assert.equal(host.routeFor(key, {applied: 'mistral', mistralKey: true, localReady: true}), null, String(key));
  assert.throws(() => sharedMemory(null).recall(), TypeError, 'a missing store gives a view with no methods, never a stand-in');
});

test('protocol: an add-on remark must come from that add-on\'s own speaker profile', () => {
  const now = Date.now();
  const request = extra => JSON.stringify({requestId: '1-2-3ULL', generation: 2, entity: '3ULL', name: 'Someone', bodyType: '', profileKey: 'addon-skippy-gun',
    text: 'Combat started.', sentAt: 1, voiceOnly: true,
    reaction: {kind: 'addon', addon: 'skippy', speaker: 'gun', event: 'combat-start', priority: 3, expiresAt: now + 4000},
    addon: {id: 'skippy', speaker: 'gun', event: 'combat-start', text: 'A fight started.', maxWords: 10}, ...extra});
  assert.equal(parseInput(request()).reaction.kind, 'addon', 'the genuine request passes');
  for (const profileKey of ['judy-alvarez', 'addon-delamain-cab-delamain', 'addon-skippy-other']) {
    assert.equal(parseInput(request({profileKey})), null, `${profileKey} carried a skippy remark`);
  }
});

test('voices: a missing, empty, corrupt, too short, too long, 8-bit or wrongly hashed reference is left out, the others load, and the speaker stays', async () => {
  const work = await folder();
  try {
    const dir = resolve(work, 'addon');
    await mkdir(resolve(dir, 'voice'), {recursive: true});
    const good = wav();
    const files = {'good.wav': good, 'empty.wav': Buffer.alloc(0), 'junk.wav': Buffer.from('this is not audio '.repeat(20)), 'short.wav': wav({seconds: 0.07}),
      'long.wav': wav({seconds: 25}), 'eight.wav': wav({bits: 8}), 'wrong-hash.wav': good, 'huge.wav': Buffer.alloc(8 * 1024 * 1024 + 1), 'same.wav': good};
    for (const [name, bytes] of Object.entries(files)) await writeFile(resolve(dir, 'voice', name), bytes);
    const voice = (name, extra) => speaker(name.replace('.wav', ''), {voice: {reference: `voice/${name}`, transcript: 'Spoken words.', ...extra}});
    const first = validateManifest(manifest({id: 'first', name: 'First', speakers: [voice('good.wav'), voice('missing.wav'), voice('empty.wav'), voice('junk.wav')]}), dir);
    const second = validateManifest(manifest({id: 'second', name: 'Second', speakers: [voice('short.wav'), voice('long.wav'), voice('eight.wav'),
      voice('wrong-hash.wav', {sha256: 'f'.repeat(64)})]}), dir);
    const third = validateManifest(manifest({id: 'third', name: 'Third', speakers: [voice('huge.wav'), voice('same.wav', {sha256: undefined}), speaker('mute')]}), dir);
    const state = resolve(work, 'state'), refs = resolve(work, 'refs');
    await mkdir(state, {recursive: true});
    await writeFile(resolve(state, 'omni.json'), JSON.stringify({engine: 'omnivoice', version: 2, voices: {'judy-alvarez': {reference: 'r.wav', sha256: 'a'.repeat(64), transcript: 'hi'}}}));
    const original = await readFile(resolve(state, 'omni.json'), 'utf8');
    const logs = [];
    const host = new AddonHost({addons: [first, second, third], log: line => logs.push(line)});
    assert.equal(host.status().addons[0].speakers[0].voice, 'pending', 'before the voices are checked');
    assert.equal(host.status().addons[2].speakers[2].voice, 'none', 'a speaker without a voice entry is subtitles only');
    const paths = await host.voiceConfigPaths({pocket: undefined, omni: {short: resolve(state, 'omni.json')}, warnings: []}, {stateDirectory: state, roots: [refs]});
    const merged = JSON.parse(await readFile(paths.omni.short, 'utf8'));
    assert.deepEqual(Object.keys(merged.voices).sort(), ['addon-first-good', 'addon-third-same', 'judy-alvarez']);
    assert.equal(merged.voices['addon-first-good'].sha256, merged.voices['addon-third-same'].sha256);
    const status = Object.fromEntries(host.status().addons.flatMap(entry => entry.speakers.map(item => [item.profileKey, item.voice])));
    assert.equal(status['addon-first-good'], 'ready');
    assert.match(status['addon-first-missing'], /ENOENT/);
    assert.match(status['addon-first-empty'], /not a supported WAV/);
    assert.match(status['addon-first-junk'], /not a supported WAV/);
    assert.match(status['addon-second-short'], /0\.1 to 20 seconds/);
    assert.match(status['addon-second-long'], /0\.1 to 20 seconds/);
    assert.match(status['addon-second-eight'], /Unsupported speech WAV format/);
    assert.equal(status['addon-second-wrong-hash'], 'reference does not match voice.sha256');
    assert.match(status['addon-third-huge'], /larger than 8 MB/);
    assert.equal(status['addon-third-same'], 'ready');
    assert.equal(status['addon-third-mute'], 'none');
    assert.equal(logs.filter(line => /Add-on voice .* not used/.test(line)).length, 8, 'one line for each voice that was left out');
    // Every speaker stays a speaker: it is a roster row and speaks as subtitles.
    const roster = [];
    host.extend(roster, {});
    assert.equal(roster.length, 11);
    assert.ok([...host.speakers.keys()].every(key => host.isSpeaker(key)));
    // Only the good references were copied; the original configuration file is byte for byte what it was.
    assert.deepEqual(readdirSync(resolve(refs, 'addons')).sort(), ['addon-first-good.wav', 'addon-third-same.wav']);
    assert.equal(await readFile(resolve(state, 'omni.json'), 'utf8'), original);
    // With no usable voice at all the very same paths object comes back and nothing is written.
    const none = new AddonHost({addons: [validateManifest(manifest({id: 'solo', name: 'Solo', speakers: [voice('empty.wav'), speaker('mute')]}), dir)]});
    const same = {omni: {short: resolve(state, 'omni.json')}, warnings: []};
    assert.equal(await none.voiceConfigPaths(same, {stateDirectory: state, roots: [resolve(work, 'unused')]}), same);
    await assert.rejects(readFile(resolve(work, 'unused/addons/addon-solo-empty.wav')), {code: 'ENOENT'});
    // Without a state folder, or when the merged copy cannot be written, the original paths are used and nothing throws.
    const failing = new AddonHost({addons: [first], log: line => logs.push(line)});
    assert.equal(await failing.voiceConfigPaths(same, {}), same);
    const unwritable = await failing.voiceConfigPaths(same, {stateDirectory: state, roots: [], files: {readFile, copyFile: async () => {}, mkdir: async () => {},
      writeFile: async () => { throw Error('read-only folder'); }}});
    assert.equal(unwritable, same);
    assert.ok(logs.some(line => /Add-on voices not merged: read-only folder/.test(line)));
  } finally { await rm(work, {recursive: true, force: true}); }
});

test('the example add-on is a valid add-on and its init.lua registers exactly what its manifest declares', async () => {
  const dir = new URL('../addons/example/', import.meta.url);
  const lua = readFileSync(new URL('init.lua', dir), 'utf8');
  const exampleDir = resolve(fileURLToPath(dir));
  const parsed = validateManifest(JSON.parse(readFileSync(new URL('convai-addon.json', dir), 'utf8')), exampleDir);
  const register = /api\.register\(\{([^}]*)\}\)/.exec(lua)[1];
  assert.equal(/id = '([^']+)'/.exec(register)[1], parsed.id, 'register({id}) matches the manifest');
  assert.equal(/name = '([^']+)'/.exec(register)[1], parsed.name);
  assert.equal(/version = '([^']+)'/.exec(register)[1], parsed.version);
  assert.equal(/requires = '([^']+)'/.exec(register)[1], parsed.requires.api);
  const declared = [...lua.matchAll(/handle:speaker\(\{id = '([^']+)', name = '([^']+)'/g)].map(match => [match[1], match[2]]);
  assert.deepEqual(declared, parsed.speakers.map(item => [item.id, item.name]), 'every handle:speaker has its manifest entry');
  const modes = /local MODES = \{([^}]*)\}/.exec(lua)[1].split(',').map(item => item.trim().replace(/'/g, ''));
  assert.deepEqual(modes, Object.keys(parsed.speakers[0].modes), 'the setting\'s modes are the manifest\'s, in order');
  // Found through the development variable like any add-on, its bridge module loads for real.
  const logs = [];
  const host = await AddonHost.load({game: resolve(tmpdir(), 'no-game-here'), environment: {CYBERPUNK_CONVAI_ADDONS: exampleDir},
    log: line => logs.push(line)});
  assert.equal(host.active, true);
  assert.deepEqual([...host.modules.keys()], ['example']);
  assert.deepEqual(host.moduleErrors.size, 0);
  assert.ok(logs.some(line => /Echo bridge module active/.test(line)), logs.join('\n'));
  assert.equal(host.status().addons[0].status, 'ready');
});
