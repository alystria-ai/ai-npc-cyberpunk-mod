// Source tests for the selection logic of packaging/test-release-install.mjs in its upgrade mode (packaging/lib/install-test-plan.mjs):
// which kind of run the packages call for, which zips each upgrade path extracts, and the verdicts. No zip is read.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {MODES, baseVerdict, chooseMode, hadRetiredDlls, listingSource, packagesForPath, runtimeUpdateZips, setupCheckVerdict, staleCode, upgradePathsFor, upgradeZips} from './lib/install-test-plan.mjs';
import {RETIRED_DLLS} from './lib/code-payload.mjs';

const project = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');

// What a 0.3.4 package folder holds (2.5), and what an older one holds.
const NEW_25 = ['AI-Companions-LLM-0.3.4.zip', 'AI-Companions-LLM-0.3.4.files.json', 'AI-Companions-LLM-Update-0.3.3-to-0.3.4.zip',
  'AI-Companions-LLM-Update-0.3.3-to-0.3.4.files.json', 'Runtime-0.3.4.zip', 'Runtime-0.3.4.files.json', 'patch-report-2.5.json'];
const NEW_231 = NEW_25.map(name => name.replace(/(\.zip|\.files\.json|\.json)$/, (end, _, at) => (name.startsWith('patch') ? end : `-for-2.31${end}`)));
const OLD_25 = ['AI-NPC-Cyberpunk-Mod-Scripts-0.3.3.zip', 'Runtime-0.3.3.zip', 'Runtime-Update-0.3.2-to-0.3.3.zip', 'Runtime-0.3.3.files.json'];

test('without --update-from it is a clean install', () => {
  assert.equal(chooseMode({previous: false, names: NEW_25, version: '0.3.4'}), MODES.clean);
  assert.equal(chooseMode({previous: false, names: OLD_25, version: '0.3.3'}), MODES.clean);
});

test('the 0.3.4 packages hold no Runtime update zip, so --update-from means the code upgrade', () => {
  assert.equal(chooseMode({previous: true, names: NEW_25, version: '0.3.4'}), MODES.codeUpgrade);
  assert.equal(chooseMode({previous: true, names: NEW_231, version: '0.3.4', suffix: '-for-2.31'}), MODES.codeUpgrade);
  // The Update zip named with --update-zip is a code Update zip, not a Runtime update.
  assert.equal(chooseMode({previous: true, names: NEW_25, version: '0.3.4', updateZipArgument: 'C:\\x\\AI-Companions-LLM-Update-0.3.3-to-0.3.4.zip'}), MODES.codeUpgrade);
});

test('a real Runtime update zip among the packages (older releases) keeps the Runtime update checks', () => {
  assert.equal(chooseMode({previous: true, names: OLD_25, version: '0.3.3'}), MODES.runtimeUpdate);
  assert.equal(chooseMode({previous: true, names: [], version: '0.3.3', updateZipArgument: 'D:\\p\\Runtime-Update-0.3.2-to-0.3.3.zip'}), MODES.runtimeUpdate);
  assert.deepEqual(runtimeUpdateZips(OLD_25, '0.3.3'), ['Runtime-Update-0.3.2-to-0.3.3.zip']);
  // Another version's update zip, another game's, or a similar version number does not count.
  assert.deepEqual(runtimeUpdateZips(['Runtime-Update-0.3.2-to-0.3.3.zip', 'Runtime-Update-0.3.2-to-0.3.30.zip', 'Runtime-Update-0.3.2-to-0.3.3-for-2.31.zip'], '0.3.3'),
    ['Runtime-Update-0.3.2-to-0.3.3.zip']);
  assert.deepEqual(runtimeUpdateZips(['Runtime-Update-0.3.2-to-0.3.3-for-2.31.zip'], '0.3.3', '-for-2.31'), ['Runtime-Update-0.3.2-to-0.3.3-for-2.31.zip']);
  assert.equal(chooseMode({previous: true, names: ['Runtime-Update-0.3.2-to-0.3.3.zip'], version: '0.3.4'}), MODES.codeUpgrade);
});

test('--upgrade-path picks path a, path b or both (the default), in that order', () => {
  assert.deepEqual(upgradePathsFor(undefined), ['update', 'full']);
  assert.deepEqual(upgradePathsFor('both'), ['update', 'full']);
  assert.deepEqual(upgradePathsFor('update'), ['update']);
  assert.deepEqual(upgradePathsFor('full'), ['full']);
  assert.throws(() => upgradePathsFor('scripts'), /--upgrade-path must be one of/);
});

test('each upgrade path finds its zip, and the Full zip its listing, for both games', () => {
  const update25 = 'AI-Companions-LLM-Update-0.3.3-to-0.3.4.zip';
  const zips25 = upgradeZips({names: NEW_25, version: '0.3.4', game: '2.5', updateName: update25});
  assert.deepEqual(zips25, {update: update25, full: 'AI-Companions-LLM-0.3.4.zip', fullListing: 'AI-Companions-LLM-0.3.4.files.json'});
  assert.deepEqual(packagesForPath('update', zips25), {zip: update25, listing: null, missing: []});
  assert.deepEqual(packagesForPath('full', zips25), {zip: 'AI-Companions-LLM-0.3.4.zip', listing: 'AI-Companions-LLM-0.3.4.files.json', missing: []});

  const update231 = 'AI-Companions-LLM-Update-0.3.3-to-0.3.4-for-2.31.zip';
  const zips231 = upgradeZips({names: NEW_231, version: '0.3.4', game: '2.31', updateName: update231});
  assert.equal(zips231.update, update231);
  assert.equal(zips231.full, 'AI-Companions-LLM-0.3.4-for-2.31.zip');
  assert.equal(zips231.fullListing, 'AI-Companions-LLM-0.3.4-for-2.31.files.json');
  // The 2.5 Full zip is not taken for the 2.31 run.
  assert.equal(upgradeZips({names: NEW_25, version: '0.3.4', game: '2.31', updateName: update231}).full, null);
});

test('a path with a missing zip says what is missing, a missing listing is not a missing package', () => {
  const half = upgradeZips({names: ['AI-Companions-LLM-0.3.4.zip'], version: '0.3.4', game: '2.5', updateName: 'AI-Companions-LLM-Update-0.3.3-to-0.3.4.zip'});
  assert.deepEqual(packagesForPath('update', half).missing, ['the Update zip']);
  assert.deepEqual(packagesForPath('full', half).missing, [], 'the Full zip without its .files.json is enough: the list is worked out from the zip');
  const none = upgradeZips({names: [], version: '0.3.4', game: '2.5', updateName: undefined});
  assert.deepEqual(packagesForPath('full', none).missing, ['the Full zip']);
  assert.throws(() => packagesForPath('both', none), /Unknown upgrade path/);
});

test('base files: path b needs all of them equal, path a only none missing', () => {
  assert.equal(baseVerdict('full', {missing: [], differing: []}).ok, true);
  assert.equal(baseVerdict('full', {missing: [], differing: ['x/README.txt']}).ok, false);
  assert.equal(baseVerdict('full', {missing: ['x/node.exe'], differing: []}).ok, false);
  assert.equal(baseVerdict('update', {missing: [], differing: ['x/README.txt']}).ok, true);
  assert.equal(baseVerdict('update', {missing: ['red4ext/plugins/AiNpcCyberpunkMod/CyberpunkConvaiBase.dll'], differing: []}).ok, true, 'the do-nothing marker plugin is new in the 0.3.4 base');
  assert.equal(baseVerdict('update', {missing: ['x/new-base-file.bin'], differing: []}).ok, false);
});

test('the previous code the new release drops is found, and the base files, caches and the installed list are not', () => {
  const app = 'red4ext/plugins/AiNpcCyberpunkMod/app';
  const stale = staleCode({
    previousNames: [`${app}/bridge/convai-bridge.mjs`, `${app}/bridge/inworld-key.mjs`, `${app}/launcher/start-service.mjs`, `${app}/bridge/__pycache__/x.pyc`,
      `${app}/node/node.exe`, `${app}/defaults/scripts-code.json`, `${app}/release.json`, 'red4ext/plugins/AiNpcCyberpunkMod/CyberpunkConvai.dll'],
    codeRows: [{path: 'bridge/convai-bridge.mjs'}, {path: 'launcher/start-service.mjs'}]});
  assert.deepEqual(stale, [`${app}/bridge/inworld-key.mjs`]);
});

test('the old DLLs the launcher retires are the ones the previous release listed', () => {
  assert.deepEqual(hadRetiredDlls(RETIRED_DLLS.map(name => name.toUpperCase()).concat(['a.txt']), RETIRED_DLLS).length, 2);
  assert.deepEqual(hadRetiredDlls(['red4ext/plugins/AiNpcCyberpunkMod/CyberpunkConvai.dll'], RETIRED_DLLS), ['red4ext/plugins/AiNpcCyberpunkMod/CyberpunkConvai.dll']);
  assert.deepEqual(hadRetiredDlls([], RETIRED_DLLS), []);
});

test('the setup check verdict needs the versions row to match and tolerates only the compiler row', () => {
  const doc = checks => ({version: 1, checks});
  const good = [{id: 'versions', state: 'ok', code: 'match'}, {id: 'packs', state: 'ok', code: 'ok'}, {id: 'compiler', state: 'problem', code: 'missing'}, {id: 'gpu', state: 'unknown', code: 'unknown'}];
  assert.deepEqual(setupCheckVerdict(doc(good)), {ok: true, versions: 'ok/match', bad: []});
  assert.equal(setupCheckVerdict(doc([{id: 'versions', state: 'problem', code: 'mismatch'}])).ok, false);
  assert.equal(setupCheckVerdict(doc([{id: 'versions', state: 'problem', code: 'base-old'}, {id: 'packs', state: 'ok', code: 'ok'}])).versions, 'problem/base-old');
  const other = setupCheckVerdict(doc([...good, {id: 'packs', state: 'problem', code: 'nested'}]));
  assert.equal(other.ok, false);
  assert.deepEqual(other.bad, ['packs/nested']);
  assert.equal(setupCheckVerdict(null).ok, false);
  assert.equal(setupCheckVerdict(doc([{id: 'packs', state: 'ok', code: 'ok'}])).ok, false);
});

test('the install test wires the plan in: both paths by default, the old Runtime update checks kept', async () => {
  const script = await readFile(resolve(project, 'packaging/test-release-install.mjs'), 'utf8');
  assert.match(script, /chooseMode\(\{previous: updateFrom\.length > 0/);
  assert.match(script, /upgradePathsFor\(upgradePathOption\)/);
  assert.match(script, /legacy = mode === MODES\.runtimeUpdate/);
  // The Runtime update coverage is still there.
  for (const text of ["the installed removal list is the update's own", 'the start removed the files the update names', 'the update left its own step marker']) {
    assert.ok(script.includes(text), `missing check: ${text}`);
  }
  // The stand-in folder and the player's data folder: never a real one.
  assert.match(script, /mkdtemp\(join\(tmpdir\(\), 'convai install test '\)\)/);
  assert.match(script, /dataHome = join\(work, 'LocalAppData', 'AiNpcCyberpunkMod'\)/);
  assert.match(script, /CYBERPUNK_CONVAI_DATA_HOME: dataHome/);
});

test('a file list comes from the .files.json, else from the zip itself, and is missing only when neither is there', () => {
  const stage = {dir: 'full-v2', names: ['Runtime-0.3.4.zip', 'Runtime-0.3.4.files.json', 'AI-Companions-LLM-Update-0.3.3-to-0.3.4.zip']};
  const packages = {dir: 'packages', names: ['AI-Companions-LLM-Update-0.3.3-to-0.3.4.zip', 'AI-Companions-LLM-Update-0.3.3-to-0.3.4.files.json']};
  // The list file beside the zip is used.
  assert.deepEqual(listingSource({bases: ['Runtime-0.3.4'], folders: [stage]}), {kind: 'listing', dir: 'full-v2', base: 'Runtime-0.3.4', file: 'Runtime-0.3.4.files.json'});
  // The staging folder (the 0.3.4 release) held the Update zip without its list: the list beside the zip's other copy is found, or else the zip is read.
  const update = ['AI-Companions-LLM-Update-0.3.3-to-0.3.4'];
  assert.equal(listingSource({bases: update, folders: [stage, packages]}).dir, 'packages');
  assert.deepEqual(listingSource({bases: update, folders: [stage]}), {kind: 'zip', dir: 'full-v2', base: update[0], file: update[0] + '.zip'});
  // A list file anywhere beats a zip, whatever the folder order.
  assert.equal(listingSource({bases: update, folders: [stage, packages]}).kind, 'listing');
  // Several names a package may have (an older title): the first that exists.
  assert.equal(listingSource({bases: ['OmniPack-0.3.4', 'Runtime-0.3.4'], folders: [stage]}).base, 'Runtime-0.3.4');
  // Neither: only then is it missing.
  assert.equal(listingSource({bases: ['Nothing-0.3.4'], folders: [stage, packages]}), null);
  assert.equal(listingSource({bases: [], folders: [stage]}), null);
});
