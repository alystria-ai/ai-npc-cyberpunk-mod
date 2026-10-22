// The leaner OmniVoice pack (docs/PACKAGING.md, "The OmniVoice pack"): what it leaves out, the float16 model and its pins, the clips that stay in the
// Runtime, and the tool that makes the pack from an existing zip (packaging/rebuild-omni-pack.mjs). No real pack is needed: the checks run on listings
// and on a small synthetic pack zip.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {ZipWriter, listZip} from './lib/zip.mjs';
import {readEntry} from './lib/zip-entry.mjs';
import {OMNI_MODEL_FILE, OMNI_PRECISION, PLUGIN, TEST_FILES_KEPT, isDraftClip, isPythonTestFile, isTorchBinCopy, omniLeaveOutReason, omniMarker, omniNoticeLines, omniPythonSkip, runtimeClipSet} from './lib/omni-pack-rules.mjs';
import {planRebuild} from './rebuild-omni-pack.mjs';
import {INSTALL_NOTE, INSTALL_NOTE_NAME} from './build-pocket-models.mjs';
import {compareWithPacks, validateListing} from './lib/pack-overlap.mjs';

const project = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const readJson = async rel => JSON.parse((await readFile(resolve(project, rel), 'utf8')).replace(/^﻿/, ''));
const config = await readJson('packaging/release.config.json');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const SITE = `${PLUGIN}/app/omni/python/Lib/site-packages`;

test('a Python package\'s tests folders are left out, and the packages named testing stay', () => {
  for (const path of [`${SITE}/pandas/tests/frame/test_a.py`, `${SITE}/numpy/_core/tests/test_x.py`, `${SITE}/scipy/io/matlab/tests/data/x.mat`,
    `${SITE}/sympy/physics/quantum/tests/__init__.py`, `${SITE}/joblib/test/test_parallel.py`, `${SITE}/lightning_utilities/test/x.py`]) {
    assert.equal(isPythonTestFile(path), true, path);
    assert.equal(omniLeaveOutReason(path), 'tests folder of a Python package');
  }
  for (const path of [`${SITE}/torch/testing/_internal/common_utils.py`, `${SITE}/numpy/testing/_private/utils.py`, `${SITE}/pandas/_testing/__init__.py`,
    `${SITE}/sklearn/utils/_testing.py`, `${SITE}/torch/lib/torch_cuda.dll`, `${SITE}/mypkg/contests/x.py`, `${SITE}/mypkg/test_file.py`,
    `${PLUGIN}/app/omni/voicestudio/backend/services/tts_backend.py`, `${PLUGIN}/voices/picked/autobest/tests/x.wav`]) {
    assert.equal(isPythonTestFile(path), false, path);
    assert.equal(omniLeaveOutReason(path), null, path);
  }
});

test('the one file of a tests folder that numpy.testing imports stays, so the worker\'s import chain (scipy, transformers) still works', () => {
  // `from numpy._core.tests._natype import pd_NA` in numpy/testing/_private/utils.py (the install test found it: the worker died importing transformers' AutoFeatureExtractor).
  assert.deepEqual(TEST_FILES_KEPT, ['numpy/_core/tests/_natype.py']);
  assert.equal(isPythonTestFile(`${SITE}/numpy/_core/tests/_natype.py`), false);
  assert.equal(omniLeaveOutReason(`${SITE}/numpy/_core/tests/_natype.py`), null);
  for (const name of ['test_array_coercion.py', '_locales.py', 'data/x.npy']) assert.equal(isPythonTestFile(`${SITE}/numpy/_core/tests/${name}`), true, name);
  assert.equal(isPythonTestFile(`${SITE}/other/numpy/_core/tests/_natype.py`), true, 'only numpy\'s own');
});

test('the DLL copies in torch/bin go, the ones torch loads from torch/lib stay, and so do the executables\' neighbours', () => {
  for (const name of ['fbgemm.dll', 'asmjit.dll', 'FBGEMM.DLL']) assert.equal(isTorchBinCopy(`${SITE}/torch/bin/${name}`), true, name);
  for (const path of [`${SITE}/torch/lib/fbgemm.dll`, `${SITE}/torch/lib/asmjit.dll`, `${SITE}/torch/bin/other.dll`, `${SITE}/torch/bin/sub/fbgemm.dll`, `${SITE}/other/bin/fbgemm.dll`]) {
    assert.equal(isTorchBinCopy(path), false, path);
  }
  assert.equal(omniLeaveOutReason(`${SITE}/torch/bin/fbgemm.dll`), 'copy of a DLL in torch/lib');
  // The same rules, for a build that walks the staged Python folder.
  assert.equal(omniPythonSkip('Lib/site-packages/pandas/tests/x.py'), true);
  assert.equal(omniPythonSkip('Lib/site-packages/torch/bin/fbgemm.dll'), true);
  assert.equal(omniPythonSkip('Lib/site-packages/torch/lib/fbgemm.dll'), false);
  assert.equal(omniPythonSkip('python.exe'), false);
});

test('the draft clips of the first cast are left out and no other clip is', () => {
  for (const key of ['coach-fred', 'jim-jarry', 'life-coach']) assert.equal(isDraftClip(`${PLUGIN}/voices/full-cast-draft/${key}/reference.wav`), true, key);
  assert.equal(omniLeaveOutReason(`${PLUGIN}/voices/archetypes/omni-long/npc-ncpd-male.wav`), null);
  assert.equal(omniLeaveOutReason(`${PLUGIN}/voices/prepared/aaron.ogg`), null);
  assert.equal(omniLeaveOutReason(`${PLUGIN}/app/omni/defaults/local-voices.autobest-long.json`), null, 'the older lists stay, they are the read-second fall-back');
});

test('the model is pinned twice: the upstream file and the float16 file made from it, and the audio tokenizer is not converted', () => {
  const model = config.toolchain.omniModel;
  const upstream = model.files['model.safetensors'], converted = model.converted['model.safetensors'];
  assert.equal(upstream.size, 2450344112); assert.match(upstream.sha256, /^[a-f0-9]{64}$/);
  assert.match(converted.sha256, /^[a-f0-9]{64}$/); assert.notEqual(converted.sha256, upstream.sha256);
  // float16 is two bytes per weight: the file is a little over half of the float32 one (the header and the one int64 tensor stay).
  assert(converted.size > upstream.size / 2 && converted.size < upstream.size / 2 + 100_000, `${converted.size} bytes`);
  assert.deepEqual([converted.from, converted.to, converted.script], ['float32', 'float16', 'packaging/convert-omni-fp16.py']);
  assert.deepEqual(Object.keys(model.converted), ['model.safetensors'], 'only the language model');
  assert.deepEqual(OMNI_PRECISION, {model: 'float16', audioTokenizer: 'float32'});
  assert.equal(OMNI_MODEL_FILE, `${PLUGIN}/app/omni/model/model.safetensors`);
});

test('the converter rounds every float32 tensor to float16, refuses anything else, keeps integers, and checks its own output', async () => {
  const text = await readFile(resolve(project, config.toolchain.omniModel.converted['model.safetensors'].script), 'utf8');
  assert.match(text, /tensor\.to\(torch\.float16\)/);
  assert.match(text, /a finite float32 value overflows float16/);
  assert.match(text, /is not float32; this converter only knows the upstream float32 file/);
  assert.match(text, /not torch\.equal\(again, expected\)/);
  assert.match(text, /save_file\(converted, target, metadata=metadata\)/, 'the metadata of the input is kept');
  // The worker loads float16 and refuses any other precision: the reason the file may be float16.
  const worker = await readFile(resolve(project, 'bridge/resident-voice-worker.py'), 'utf8');
  assert.match(worker, /backend\.dtype != 'torch\.float16'/);
  assert.match(worker, /OmniVoice did not load with the expected FP16 weights/);
});

test('the build converts the model with the pack\'s own Python, checks the result against the pin, and uses the same notices and marker as the rebuild tool', async () => {
  const builder = await readFile(resolve(project, 'packaging/build-release.mjs'), 'utf8');
  const omni = builder.slice(builder.indexOf('async function omniPackage('), builder.indexOf('async function localAiFile('));
  assert.match(omni, /if \(rel === 'model\.safetensors'\) path = await omniHalfPrecisionModel\(path, model, modelDir, resolve\(pythonDir, 'python\.exe'\), source\);/);
  assert.match(omni, /skip: rel => PYTHON_SKIP\(rel\) \|\| omniPythonSkip\(rel\)/, 'the Python tree without tests folders and DLL copies');
  assert.match(omni, /omniNoticesText\(omniNoticeLines\(\{tool, studio\}\)\)/);
  assert.match(omni, /omniMarker\(\{config, version, commit: source\.commit\}\)/);
  assert.match(omni, /runtimeClipSet\(await readJson\(resolve\(source\.root, config\.omniPack\.runtimeClips\)\)\)/, 'the clips the Runtime carries are not packed');
  assert.match(omni, /with other bytes than this build's clip/);
  assert.match(builder, /The float16 OmniVoice model is \$\{actual\}, not the pinned/);
  const notices = omniNoticeLines({tool: config.toolchain, studio: config.toolchain.voiceStudio}).join('\n');
  const {files, converted} = config.toolchain.omniModel, pin = converted['model.safetensors'];
  assert(notices.includes(files['model.safetensors'].sha256) && notices.includes(pin.sha256), 'the notice names both files');
  assert.match(notices, /CHANGED: app\/omni\/model\/model\.safetensors is the upstream file with its weights rounded from float32 to float16/);
  assert.match(notices, /The other model files, including the audio tokenizer, are the unmodified upstream files/);
  const marker = omniMarker({config, version: '0.2.9', commit: 'abc'});
  assert.equal(marker.model, `${config.toolchain.omniModel.repository}@${config.toolchain.omniModel.revision}`, 'the launcher reads this field');
  assert.deepEqual([marker.precision, marker.modelFileSha256, marker.version], [OMNI_PRECISION, pin.sha256, '0.2.9']);
});

test('the 120 Omni clips the Runtime carries stay in the Runtime: the listing names them, no pack ships them, and the Runtime ships them', async () => {
  const clips = runtimeClipSet(await readJson(config.omniPack.runtimeClips));
  assert.equal(clips.size, 120, '60 voices, a long and a short clip each');
  const kinds = new Map();
  for (const {path} of clips.values()) {
    const kind = /\/voices\/(archetypes|picked\/autobest)\/omni-(long|short)\/[^/]+\.wav$/.exec(path);
    assert(kind, path);
    kinds.set(`${kind[1]} ${kind[2]}`, (kinds.get(`${kind[1]} ${kind[2]}`) ?? 0) + 1);
  }
  assert.deepEqual([...kinds].sort(), [['archetypes long', 11], ['archetypes short', 11], ['picked/autobest long', 49], ['picked/autobest short', 49]]);
  const packs = validateListing(await readJson('packaging/pack-listings/packs-0.2.9.json'));
  const runtime = (await readJson('packaging/pack-listings/runtime-0.2.9-pack-folders.json')).files;
  const inRuntime = new Map(runtime.map(([path, size, crc]) => [path.toLowerCase(), `${size}:${crc}`]));
  for (const {path, size, crc} of clips.values()) {
    assert.equal(inRuntime.get(path.toLowerCase()), `${size}:${crc}`, `the Runtime carries ${path}`);
    for (const pack of packs.packs) assert(!pack.files.some(([name]) => name.toLowerCase() === path.toLowerCase()), `${pack.name} also ships ${path}`);
  }
  assert.throws(() => runtimeClipSet({schema: 2}), /Not a Runtime clip listing/);
});

// ---- the tool that makes the pack from an existing zip --------------------------------------------------------------------------------------

test('planRebuild keeps what stays, names what goes and why, and reports a clip the Runtime carries', () => {
  const entry = (name, uncompressed = 10) => ({name, uncompressed});
  const entries = [entry(`${SITE}/pandas/tests/a.py`), entry(`${SITE}/pandas/core/b.py`), entry(`${SITE}/torch/bin/asmjit.dll`), entry(`${SITE}/torch/lib/asmjit.dll`),
    entry(`${PLUGIN}/voices/full-cast-draft/jim-jarry/reference.wav`), entry(OMNI_MODEL_FILE, 99), entry(`${PLUGIN}/app/omni/omni-pack.json`), entry(`${PLUGIN}/voices/x/`)];
  const plan = planRebuild(entries, new Map([[`${PLUGIN}/voices/archetypes/omni-long/new.wav`.toLowerCase(), {}]]));
  assert.deepEqual(plan.keep.map(item => item.name), [`${SITE}/pandas/core/b.py`, `${SITE}/torch/lib/asmjit.dll`]);
  assert.deepEqual(plan.leave.map(item => item.why), ['tests folder of a Python package', 'copy of a DLL in torch/lib', 'draft clip of the first cast']);
  assert.deepEqual(plan.replaced, [OMNI_MODEL_FILE, `${PLUGIN}/app/omni/omni-pack.json`]);
  assert.deepEqual(plan.clash, []);
  assert.deepEqual(planRebuild([entry(`${PLUGIN}/voices/archetypes/omni-long/NEW.wav`)], new Map([[`${PLUGIN}/voices/archetypes/omni-long/new.wav`.toLowerCase(), {}]])).clash,
    [`${PLUGIN}/voices/archetypes/omni-long/NEW.wav`], 'names are compared without regard to case, like Windows does');
});

test('the rebuild tool writes the lean pack: float16 model, no tests folders, DLL copies or draft clips, new notices, marker and install note, everything else byte for byte', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'omni rebuild test '));
  try {
    const upstream = Buffer.from('UPSTREAM-FLOAT32-WEIGHTS'.repeat(200)), half = upstream.subarray(0, upstream.length / 2);
    const converter = join(directory, 'convert.mjs');
    await writeFile(converter, `import {readFileSync, writeFileSync} from 'node:fs';\nconst bytes = readFileSync(process.argv[2]);\nwriteFileSync(process.argv[3], bytes.subarray(0, bytes.length / 2));\n`);
    const clipListing = join(directory, 'clips.json');
    const clipPath = `${PLUGIN}/voices/archetypes/omni-long/runtime-has-this.wav`;
    await writeFile(clipListing, JSON.stringify({schema: 1, files: [[clipPath, 3, '00000000']]}));
    const fake = structuredClone(config);
    fake.toolchain.omniModel.files['model.safetensors'] = {size: upstream.length, sha256: sha(upstream)};
    fake.toolchain.omniModel.converted['model.safetensors'] = {size: half.length, sha256: sha(half), from: 'float32', to: 'float16', script: converter};
    fake.omniPack.runtimeClips = clipListing;
    const configFile = join(directory, 'release.config.json');
    await writeFile(configFile, JSON.stringify(fake));

    const kept = {
      [`${PLUGIN}/app/omni/model/config.json`]: '{"dtype": "float32"}', [`${PLUGIN}/app/omni/model/audio_tokenizer/model.safetensors`]: 'TOKENIZER',
      [`${SITE}/numpy/testing/x.py`]: 'testing is a package', [`${SITE}/torch/lib/fbgemm.dll`]: 'DLL', [`${PLUGIN}/app/omni/python/python.exe`]: 'EXE',
      [`${PLUGIN}/voices/archetypes/omni-long/npc-ncpd-male.wav`]: 'clip', [`${PLUGIN}/voices/prepared/aaron.json`]: '{}',
    };
    const gone = {[`${SITE}/pandas/tests/test_a.py`]: 'x', [`${SITE}/joblib/test/test_b.py`]: 'x', [`${SITE}/torch/bin/fbgemm.dll`]: 'DLL',
      [`${PLUGIN}/voices/full-cast-draft/coach-fred/reference.wav`]: 'draft'};
    const old = join(directory, 'old.zip');
    const writer = await ZipWriter.create(old);
    const all = {...kept, ...gone, [OMNI_MODEL_FILE]: upstream, [`${PLUGIN}/app/omni/THIRD-PARTY-NOTICES.txt`]: 'old notices', [`${PLUGIN}/app/omni/omni-pack.json`]: '{"version":"0.2"}'};
    for (const [path, content] of Object.entries(all)) await writer.add(path, {buffer: Buffer.from(content)});
    await writer.close();

    const args = [resolve(project, 'packaging/rebuild-omni-pack.mjs'), '--from', old, '--out', join(directory, 'out'), '--version', '9.9.9', '--python', process.execPath,
      '--release-config', configFile, '--commit', 'deadbeef', '--timestamp', '1792678298'];
    const run = spawnSync(process.execPath, args, {encoding: 'utf8'});
    assert.equal(run.status, 0, run.stderr + run.stdout);
    const zip = join(directory, 'out/OmniPack-9.9.9.zip');
    const entries = await listZip(zip);
    const names = entries.map(entry => entry.name);
    assert.deepEqual(names, [...names].sort(), 'sorted, like the builder');
    for (const path of Object.keys(gone)) assert(!names.includes(path), `${path} is left out`);
    assert.deepEqual(names.filter(name => !(name in kept) && name !== OMNI_MODEL_FILE).sort(),
      [INSTALL_NOTE_NAME, `${PLUGIN}/app/omni/THIRD-PARTY-NOTICES.txt`, `${PLUGIN}/app/omni/omni-pack.json`].sort(), 'only the files the tool writes itself are new');
    const read = async name => readEntry(zip, entries.find(entry => entry.name === name));
    for (const [path, content] of Object.entries(kept)) assert.equal((await read(path)).toString(), content, path);
    assert.deepEqual(await read(OMNI_MODEL_FILE), half, 'the model is the converted file');
    assert.equal((await read(INSTALL_NOTE_NAME)).toString(), INSTALL_NOTE);
    const marker = JSON.parse(await read(`${PLUGIN}/app/omni/omni-pack.json`));
    assert.deepEqual([marker.version, marker.commit, marker.precision, marker.modelFileSha256], ['9.9.9', 'deadbeef', OMNI_PRECISION, sha(half)]);
    assert.match((await read(`${PLUGIN}/app/omni/THIRD-PARTY-NOTICES.txt`)).toString(), /CHANGED: app\/omni\/model\/model\.safetensors/);
    const files = JSON.parse(await readFile(join(directory, 'out/OmniPack-9.9.9.files.json'), 'utf8'));
    assert.equal(files.length, entries.length); assert.equal(files.find(file => file.path === OMNI_MODEL_FILE).sha256, sha(half));

    // A pack that already holds a clip the Runtime carries stops the tool; a model that is not the pinned upstream file does too.
    const clashing = join(directory, 'clash.zip');
    const second = await ZipWriter.create(clashing);
    await second.add(OMNI_MODEL_FILE, {buffer: upstream}); await second.add(clipPath, {buffer: Buffer.from('abc')});
    await second.close();
    const clash = spawnSync(process.execPath, args.map(item => item === old ? clashing : item), {encoding: 'utf8'});
    assert.notEqual(clash.status, 0); assert.match(clash.stderr, /holds 1 clip\(s\) the Runtime carries/);
    const wrong = join(directory, 'wrong.zip');
    const third = await ZipWriter.create(wrong);
    await third.add(OMNI_MODEL_FILE, {buffer: Buffer.concat([upstream.subarray(0, upstream.length - 1), Buffer.from('!')])});
    await third.close();
    const bad = spawnSync(process.execPath, args.map(item => item === old ? wrong : item), {encoding: 'utf8'});
    assert.notEqual(bad.status, 0); assert.match(bad.stderr, /not the pinned upstream file/);
  } finally { await rm(directory, {recursive: true, force: true}); }
});

test('the 0.2.9 packs share no file with the 0.2.9 Runtime, and a Runtime that shipped an OmniPack clip would be caught', async () => {
  const packs = validateListing(await readJson('packaging/pack-listings/packs-0.2.9.json'));
  const runtime = (await readJson('packaging/pack-listings/runtime-0.2.9-pack-folders.json')).files.map(([path, size, crc]) => ({path, size, crc}));
  const result = compareWithPacks(runtime, packs);
  assert.deepEqual(result.different, []); assert.deepEqual(result.inPackTrees, []);
  assert.deepEqual([...new Set(result.identical.map(item => item.path))], [INSTALL_NOTE_NAME], 'the install note is the only file both ship');
  const omni = packs.packs.find(pack => pack.name === 'OmniPack');
  const [path, size, crc] = omni.files.find(([name]) => name.includes('/voices/archetypes/omni-long/'));
  assert.equal(compareWithPacks([{path, size, crc}], packs).identical.length, 1, 'a Runtime that shipped the pack\'s clip is seen');
});
