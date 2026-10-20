// Mod Organizer 2: the Pocket and OmniVoice workers start inside USVFS (node --test packaging/mo2-voice-workers.test.mjs).
//
// A player running the game through MO2 (0.2.4; 0.2.5 had the same code) never heard a voice: Pocket failed on every start with "Pocket export asset is
// missing or linked" and OmniVoice with "Portable voice assets must remain in the application directory". Both workers compared Path.resolve() results,
// and under USVFS the resolved path of a file is the mod folder that holds it, which is not where its folder resolves to when the folder is the merge of
// several mods (and the OmniVoice pack is a mod of its own). The workers now compare the paths as spelled when the service says it runs inside USVFS
// (CYBERPUNK_CONVAI_USVFS=1), refuse links as before, and the service names the pack's folder (CYBERPUNK_CONVAI_OMNI_PACK) as a second approved root.
// The decisions themselves are tested in Python (scripts/test_pocket_voice_runtime.py UsvfsPaths, scripts/test_resident_voice_paths.py UsvfsVoicePaths);
// this file tests the service side and that both sides use the same names.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {installLayout, serviceEnvironment} from './runtime/prepare-state.mjs';
import {USVFS_FLAG} from '../bridge/local-ai-pack.mjs';

const root = resolve(fileURLToPath(import.meta.url), '../..');
const read = path => readFileSync(resolve(root, path), 'utf8');
const base = {appDirectory: 'D:/Game/red4ext/plugins/X/app', gameRoot: 'D:/Game'};
const pack = 'E:/MO2/mods/AI NPC Omni pack/red4ext/plugins/X/app/omni';

test('under USVFS the service names the OmniVoice pack folder for the worker; a physical install sets nothing', () => {
  const physical = installLayout(base);
  assert.equal('CYBERPUNK_CONVAI_OMNI_PACK' in serviceEnvironment(physical, {omni: true, keyFile: 'k'}, {}), false);
  assert.equal('CYBERPUNK_CONVAI_OMNI_PACK' in serviceEnvironment(physical, {omni: true, keyFile: 'k', usvfs: false}, {}), false);
  const split = installLayout({...base, packRoots: {omni: pack}});
  const env = serviceEnvironment(split, {omni: true, keyFile: 'k', usvfs: true}, {});
  assert.equal(env.CYBERPUNK_CONVAI_OMNI_PACK, resolve(pack));
  assert.equal(env.CYBERPUNK_CONVAI_OMNI_MODEL, resolve(pack, 'model'));
  assert.equal(env.CYBERPUNK_CONVAI_OMNI_ADAPTER, resolve(pack, 'voicestudio/backend'));
  // The same folder is what the pack's model and adapter are inside, so the worker's check passes for exactly this layout.
  for (const name of ['CYBERPUNK_CONVAI_OMNI_MODEL', 'CYBERPUNK_CONVAI_OMNI_ADAPTER']) assert.ok(env[name].startsWith(env.CYBERPUNK_CONVAI_OMNI_PACK + '\\') || env[name].startsWith(env.CYBERPUNK_CONVAI_OMNI_PACK + '/'));
});

test('no pack, no pack folder; a value inherited from the environment never reaches the worker', () => {
  const split = installLayout({...base, packRoots: {omni: pack}});
  assert.equal('CYBERPUNK_CONVAI_OMNI_PACK' in serviceEnvironment(split, {omni: false, keyFile: 'k', usvfs: true}, {}), false);
  for (const options of [{omni: false, usvfs: false}, {omni: true, usvfs: false}, {omni: false, usvfs: true}]) {
    const env = serviceEnvironment(split, {keyFile: 'k', ...options}, {CYBERPUNK_CONVAI_OMNI_PACK: 'C:/somewhere/else'});
    assert.notEqual(env.CYBERPUNK_CONVAI_OMNI_PACK, 'C:/somewhere/else');
  }
});

test('the service tells serviceEnvironment whether usvfs is loaded, and the workers read the same variable names', () => {
  const start = read('packaging/runtime/start-service.mjs');
  assert.match(start, /serviceEnvironment\(layout, \{\.\.\.prepared, usvfs: Boolean\(usvfsCompat\)\}\)/);
  assert.equal(USVFS_FLAG, 'CYBERPUNK_CONVAI_USVFS');
  assert.match(read('bridge/pocket_voice_runtime.py'), /USVFS_VARIABLE = "CYBERPUNK_CONVAI_USVFS"/);
  const omni = read('bridge/resident-voice-worker.py');
  assert.match(omni, /USVFS_VARIABLE = 'CYBERPUNK_CONVAI_USVFS'/);
  assert.match(omni, /PACK_VARIABLE = 'CYBERPUNK_CONVAI_OMNI_PACK'/);
});

test('the Pocket and OmniVoice workers are given the flag: their environments start from the bridge\'s own', () => {
  // Both spawns copy process.env, which already holds the flag the service set for every process it starts (usvfs-compat.mjs childEnvironment).
  assert.match(read('bridge/pocket-voice.mjs'), /const env = \{\.\.\.process\.env,/);
  assert.match(read('bridge/resident-voice.mjs'), /const environment = \{\.\.\.process\.env,/);
  assert.match(read('packaging/runtime/usvfs-compat.mjs'), /\[USVFS_VARIABLE\]: '1'/);
  // The Pocket worker keeps the environment it starts with (cpu_environment copies it) so the flag is still there when it validates its assets.
  assert.match(read('bridge/pocket_voice_runtime.py'), /environment = dict\(os\.environ\)/);
});
