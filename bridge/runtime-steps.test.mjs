// The step markers of a Runtime (bridge/runtime-steps.mjs) and what the setup check makes of them.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {BASE_FILE, STEPS_DIR, baseText, checkRuntimeSteps, compareVersions, readRuntimeSteps, stepFileName, stepText} from './runtime-steps.mjs';
import {collectSetupCheck} from './setup-check.mjs';

async function runtime(markers) {
  const root = await mkdtemp(join(tmpdir(), 'runtime-steps-'));
  if (markers !== null) {
    await mkdir(join(root, STEPS_DIR), {recursive: true});
    if (markers.base) await writeFile(join(root, STEPS_DIR, BASE_FILE), baseText(markers.base));
    for (const [from, to] of markers.steps ?? []) await writeFile(join(root, STEPS_DIR, stepFileName(from, to)), stepText(from, to));
    for (const [name, text] of Object.entries(markers.raw ?? {})) await writeFile(join(root, STEPS_DIR, name), text);
  }
  return root;
}
const check = async (markers, current) => {
  const root = await runtime(markers);
  try { return await checkRuntimeSteps({project: root, current}); } finally { await rm(root, {recursive: true, force: true}); }
};

test('versions compare as numbers, not text', () => {
  assert.equal(compareVersions('0.2.10', '0.2.9'), 1);
  assert.equal(compareVersions('0.2', '0.2.0'), 0);
  assert.equal(compareVersions('0.2.7', '0.2.8'), -1);
  assert.equal(compareVersions('dev', '0.2.8'), null);
});

test('a Runtime without markers, or one that is still the full Runtime, has nothing to report', async () => {
  assert.deepEqual(await check(null, '0.2.8'), {code: 'none'});
  assert.deepEqual(await check({base: '0.2.8'}, '0.2.8'), {code: 'ok'});
  assert.deepEqual(await check({steps: []}, '0.2.8'), {code: 'none'});
  assert.deepEqual(await checkRuntimeSteps({project: null, current: '0.2.8'}), {code: 'none'});
  assert.deepEqual(await check({base: '0.2.8'}, null), {code: 'none'});
});

test('every step applied in order reaches the Runtime version', async () => {
  assert.deepEqual(await check({base: '0.2.6', steps: [['0.2.6', '0.2.7'], ['0.2.7', '0.2.8']]}, '0.2.8'), {code: 'ok'});
  // a full Runtime extracted later leaves the earlier step files behind and replaces the base
  assert.deepEqual(await check({base: '0.2.9', steps: [['0.2.6', '0.2.7'], ['0.2.7', '0.2.8']]}, '0.2.9'), {code: 'ok'});
});

test('a skipped step is named: the step from the version the chain stopped at', async () => {
  // base 0.2.6 and only the zip 0.2.7 -> 0.2.8 applied: the release.json says 0.2.8
  assert.deepEqual(await check({base: '0.2.6', steps: [['0.2.7', '0.2.8']]}, '0.2.8'), {code: 'gap', from: '0.2.6', to: '0.2.7'});
  // the middle one skipped
  assert.deepEqual(await check({base: '0.2.5', steps: [['0.2.5', '0.2.6'], ['0.2.7', '0.2.8']]}, '0.2.8'), {code: 'gap', from: '0.2.6', to: '0.2.7'});
  // the last one is the missing one but its marker never arrived (nothing after the chain): the gap runs to the Runtime version
  assert.deepEqual(await check({base: '0.2.6', steps: [['0.2.6', '0.2.7']]}, '0.2.9'), {code: 'gap', from: '0.2.7', to: '0.2.9'});
});

test('without a base marker (a Runtime from before the markers) the first step starts the chain', async () => {
  assert.deepEqual(await check({steps: [['0.2.8', '0.2.9']]}, '0.2.9'), {code: 'ok'});
  assert.deepEqual(await check({steps: [['0.2.8', '0.2.9'], ['0.2.10', '0.2.11']]}, '0.2.11'), {code: 'gap', from: '0.2.9', to: '0.2.10'});
});

test('an older zip applied after a newer one is reported as out of order', async () => {
  assert.deepEqual(await check({base: '0.2.6', steps: [['0.2.6', '0.2.7'], ['0.2.7', '0.2.8']]}, '0.2.7'), {code: 'order'});
});

test('the full Runtime of this version extracted over a newer one is a rollback, not an order problem, so extracting it again clears the row', async () => {
  // base 0.2.7 (the full Runtime extracted last), release 0.2.7, and the step file of a newer zip still on disk
  assert.deepEqual(await check({base: '0.2.7', steps: [['0.2.7', '0.2.8']]}, '0.2.7'), {code: 'ok'});
  // but a base older than the Runtime is still the older-zip-after-newer case
  assert.deepEqual(await check({base: '0.2.6', steps: [['0.2.6', '0.2.7'], ['0.2.7', '0.2.8']]}, '0.2.7'), {code: 'order'});
});

test('a Runtime older than the chain start, or a version that is not numbers, is not called a gap', async () => {
  assert.deepEqual(await check({base: '0.2.9'}, '0.2.8'), {code: 'none'});
  assert.deepEqual(await check({base: '0.2.9', steps: [['0.2.9', '0.3.0']]}, 'dev'), {code: 'none'});
});

test('damaged or foreign files in the folder are ignored', async () => {
  const root = await runtime({base: '0.2.6', steps: [['0.2.6', '0.2.7']], raw: {'step-bad.json': '{"from":', 'step-x.json': '{"from":"../a","to":"b"}', 'notes.txt': 'x'}});
  try {
    assert.deepEqual(await readRuntimeSteps(root), {base: '0.2.6', steps: [{from: '0.2.6', to: '0.2.7'}]});
  } finally { await rm(root, {recursive: true, force: true}); }
  assert.equal(await readRuntimeSteps(join(tmpdir(), 'no-such-runtime-folder-xyz')), null);
});

test('the setup check turns a skipped step into a problem on the versions row, with the step named', async () => {
  const root = await mkdtemp(join(tmpdir(), 'runtime-steps-check-'));
  try {
    const project = join(root, 'app'), modRoot = join(root, 'game', 'mod'), stateDirectory = join(root, 'state');
    for (const folder of [project, modRoot, stateDirectory]) await mkdir(folder, {recursive: true});
    await writeFile(join(modRoot, 'release.json'), JSON.stringify({package: 'scripts', version: '0.2.8'}));
    await writeFile(join(project, 'release.json'), JSON.stringify({package: 'runtime', version: '0.2.8'}));
    await mkdir(join(project, STEPS_DIR), {recursive: true});
    await writeFile(join(project, STEPS_DIR, BASE_FILE), baseText('0.2.6'));
    await writeFile(join(project, STEPS_DIR, stepFileName('0.2.7', '0.2.8')), stepText('0.2.7', '0.2.8'));
    const options = {game: join(root, 'game'), modRoot, project, stateDirectory, light: true, settings: {}, localAi: () => ({}), omniPack: () => ({}),
      modManagers: () => ({managers: []}), nestedPacks: async () => [], placement: async () => null, graphics: async () => [], browser: () => null, reach: async () => 'reachable'};
    const row = (await collectSetupCheck(options)).checks.find(item => item.id === 'versions');
    assert.deepEqual(row, {id: 'versions', state: 'problem', code: 'chain-gap', scripts: '0.2.8', runtime: '0.2.8', scriptsGame: '2.31', runtimeGame: '2.31', from: '0.2.6', to: '0.2.7'});
    await writeFile(join(project, STEPS_DIR, stepFileName('0.2.6', '0.2.7')), stepText('0.2.6', '0.2.7'));
    const fixed = (await collectSetupCheck(options)).checks.find(item => item.id === 'versions');
    assert.deepEqual(fixed, {id: 'versions', state: 'ok', code: 'match', scripts: '0.2.8', runtime: '0.2.8', scriptsGame: '2.31', runtimeGame: '2.31'});
  } finally { await rm(root, {recursive: true, force: true}); }
});
