// A Runtime package must carry V's voice clips and its own OmniVoice lists (packaging/lib/runtime-required.mjs).
// 0.2 and 0.2.1 shipped without the V clips; these tests keep a Runtime like that from passing again:
// the helper, the zip checker (packaging/check-runtime-contents.mjs) and the places that call it, all without a build.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {ZipWriter} from './lib/zip.mjs';
import {checkRuntimeContents} from './check-runtime-contents.mjs';
import {missingRuntimeFiles, requiredRuntimeFiles} from './lib/runtime-required.mjs';

const project = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const read = rel => readFile(resolve(project, rel), 'utf8');
const PLUGIN = 'red4ext/plugins/AiNpcCyberpunkMod';
const required = await requiredRuntimeFiles(project);
const allNames = Object.values(required).flat();
const temporary = () => mkdtemp(join(tmpdir(), 'runtime contents test '));

async function zipOf(directory, name, names) {
  const zip = await ZipWriter.create(join(directory, name));
  for (const entry of names) await zip.add(entry, {buffer: Buffer.from('x')});
  await zip.close();
  return join(directory, name);
}

test('the required files come from the repository: the V manifest and the OmniVoice lists', async () => {
  assert.deepEqual(required["V's voice clips"], ['v-voice.json', 'v-male.wav', 'v-female.wav'].map(file => `${PLUGIN}/voices/v-voice/${file}`));
  // The manifest names exactly the clips that exist beside it in a development checkout; the tracked file is what the build validates.
  const manifest = JSON.parse(await read('assets/v-voice/v-voice.json'));
  assert.deepEqual(Object.values(manifest.voices).map(row => row.file).sort(), ['v-female.wav', 'v-male.wav']);
});

test('a Runtime ships no double-click support report tool: the report is made in the game (Settings > Help) or sent automatically', async () => {
  const config = JSON.parse(await read('packaging/release.config.json'));
  assert.deepEqual(Object.keys(required), ["V's voice clips", "Runtime's OmniVoice lists", 'llama.cpp engine']);
  assert(!allNames.some(name => name.endsWith('.bat')));
});

test('a complete Runtime has nothing missing; without a V clip or the manifest the group is named', () => {
  assert.deepEqual(missingRuntimeFiles(allNames, required), {});
  const male = `${PLUGIN}/voices/v-voice/v-male.wav`, manifest = `${PLUGIN}/voices/v-voice/v-voice.json`;
  assert.deepEqual(missingRuntimeFiles(allNames.filter(name => name !== male), required), {"V's voice clips": [male]});
  assert.deepEqual(missingRuntimeFiles(allNames.filter(name => name !== manifest), required), {"V's voice clips": [manifest]});
  // A Runtime like 0.2.1: none of the V files.
  const old = allNames.filter(name => !name.includes('/v-voice/'));
  assert.deepEqual(Object.keys(missingRuntimeFiles(old, required)), ["V's voice clips"]);
  // Windows names are not case sensitive.
  assert.deepEqual(missingRuntimeFiles(allNames.map(name => name.toUpperCase()), required), {});
});

test("a Runtime without its own OmniVoice lists in app/defaults is named, like 0.2.1, whose lists were at the OmniVoice pack's path", () => {
  const lists = ['local-voices.autobest-short.json', 'local-voices.autobest-long.json'].map(name => `${PLUGIN}/app/defaults/${name}`);
  assert.deepEqual(required["Runtime's OmniVoice lists"], lists);
  const old = allNames.filter(name => !lists.includes(name)).concat(lists.map(name => name.replace('/app/defaults/', '/app/omni/defaults/')));
  assert.deepEqual(missingRuntimeFiles(old, required), {"Runtime's OmniVoice lists": lists});
});

test('the zip checker passes a complete Runtime and fails one without a V clip (exit code 1)', async () => {
  const directory = await temporary();
  try {
    const run = zip => spawnSync(process.execPath, [resolve(project, 'packaging/check-runtime-contents.mjs'), zip], {encoding: 'utf8'});
    const complete = run(await zipOf(directory, 'complete.zip', [...allNames, 'other/file.txt']));
    assert.equal(complete.status, 0, complete.stdout + complete.stderr);
    assert.match(complete.stdout, /OK:/);
    const noClip = run(await zipOf(directory, 'no-clip.zip', allNames.filter(name => !name.endsWith('v-female.wav'))));
    assert.equal(noClip.status, 1);
    assert.match(noClip.stdout, /MISSING \(V's voice clips\).*v-female\.wav/);
    // Several zips are one Runtime: the clips may be in a second part.
    const lines = [];
    const split = await checkRuntimeContents([await zipOf(directory, 'part1.zip', allNames.slice(0, 5)), await zipOf(directory, 'part2.zip', allNames.slice(5))], {log: line => lines.push(line)});
    assert.equal(split, true, lines.join('\n'));
    assert.equal(run(join(directory, 'missing.zip')).status, 2, 'an unreadable zip is an error, not a pass');
  } finally { await rm(directory, {recursive: true, force: true}); }
});

test('the build and the install test still put and check these files', async () => {
  const builder = await read('packaging/build-release.mjs');
  assert.match(builder, /vVoiceReferenceFiles\(\)/);
  assert.match(builder, /\$\{plugin\}\/voices\/v-voice\/\$\{rel\}/);
  assert.doesNotMatch(builder, /supportBatch|support report/i);
  const install = await read('packaging/test-release-install.mjs');
  assert.match(install, /requiredRuntimeFiles\(project\)/);
  assert.match(install, /missingRuntimeFiles\(installed, required\)/);
  assert.match(install, /loadVVoiceReferences/);
  const docs = await read('docs/PACKAGING.md');
  assert.match(docs, /check-runtime-contents\.mjs/);
});
