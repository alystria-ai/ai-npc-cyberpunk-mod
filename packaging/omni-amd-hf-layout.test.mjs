// The AMD packs on Hugging Face (docs/PACKAGING.md "OmniVoice for AMD"): the names the game asks for (bridge/omni-amd-layout.mjs), the names the builder writes and the
// places the uploader puts them must be one and the same, for every card family of the pinned list. Nothing is built or uploaded: the uploader is only run with --dry-run.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {AMD_PACK_FOLDER, AMD_PACK_REPOSITORY, amdPackName, amdPackUrl} from '../bridge/omni-amd-layout.mjs';
import WHEELS from '../bridge/omni-amd-wheels.mjs';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = async rel => (await readFile(resolve(project, rel), 'utf8')).replaceAll('\r\n', '\n');
const python = ['python', 'py'].find(name => spawnSync(name, ['-I', '-c', 'import sys'], {encoding: 'utf8'}).status === 0);
const py = args => spawnSync(python, ['-I', ...args], {encoding: 'utf8', cwd: project});
const families = Object.keys(WHEELS.targets);
const names = families.map(family => amdPackName(WHEELS.roots, family));

test('every card family of the pinned list has a pack name the uploader accepts, and the game downloads it from the folder the uploader writes to', {skip: !python && 'no Python'}, async () => {
  assert.ok(families.length >= 7);
  assert.ok(names.every(Boolean), names.join());
  assert.equal(new Set(names).size, names.length);
  const directory = await mkdtemp(join(tmpdir(), 'amd hf '));
  try {
    for (const name of names) await writeFile(join(directory, name), 'x');
    await writeFile(join(directory, 'OmniAMD-gfx1201-PyTorch-2.14-ROCm-10.1.zip.part'), 'x');   // a half-built file and strangers are never uploaded
    await writeFile(join(directory, 'OmniPack.zip'), 'x');
    const run = py(['packaging/upload-packs.py', '--version', '0.3.4', '--pack', 'omni-amd', '--packages', directory, '--dry-run']);
    assert.equal(run.status, 0, run.stderr);
    const lines = run.stdout.trim().split(/\r?\n/).sort();
    assert.deepEqual(lines, names.map(name => `${join(directory, name)} -> ${AMD_PACK_REPOSITORY}/${AMD_PACK_FOLDER}/${name}`).sort());
    for (const name of names) assert.equal(amdPackUrl(name), `https://huggingface.co/${AMD_PACK_REPOSITORY}/resolve/main/${AMD_PACK_FOLDER}/${name}`);
    // The packs are the same for every game version.
    assert.notEqual(py(['packaging/upload-packs.py', '--version', '0.3.4', '--pack', 'omni-amd', '--packages', directory, '--dry-run', '--game', '2.31']).status, 0);
  } finally { await rm(directory, {recursive: true, force: true}); }
});

test('the documents list exactly these pack names, and the model card describes the voice/amd/ folder', async () => {
  const docs = await read('docs/OMNIVOICE_AMD.md');
  for (const name of names) assert.ok(docs.includes('`' + name + '`'), `docs/OMNIVOICE_AMD.md lists ${name}`);
  const card = await read('packaging/HF_MODEL_CARD.md');
  assert.ok(card.includes(`${AMD_PACK_FOLDER}/`) && card.includes('OmniAMD-<card family>-PyTorch-'), 'the model card names voice/amd/');
  assert.ok((await read('packaging/upload-packs.py')).includes(`REPOSITORY = "${AMD_PACK_REPOSITORY}"`));
});
