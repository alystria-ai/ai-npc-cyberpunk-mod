// The vision projectors of the Local AI and Mature models, which ship as SEPARATE small zips (owner decision 2026-10-29; docs/PACKAGING.md, "Vision files"): the pins in
// release.config.json, the checks of a downloaded file against its size and SHA-256, the manifests that NAME the expected file (the packs hold none), what the bridge does with
// a named file that is or is not installed, the builder's use of the helpers, the zip names and folders, and the pack sizes the texts promise. No network and no big file: the
// pins are read, the files in the checks are stand-ins.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {PROJECTOR_FOLDER, pinTierOf, projectorConflicts, projectorField, projectorManifestPath, projectorNotice, projectorReceipt, projectorUrl, tierProjector, validateProjectorSpec,
  verifyProjectorFile, visionFilePath, visionNoticePath, visionNoticeText, visionReceiptPath, visionZip, visionZipIds} from './lib/pack-projector.mjs';
import {hfPaths, packIdOfName, packTitle} from './lib/pack-names.mjs';
import {detectLocalAiPack} from '../bridge/local-ai-pack.mjs';
import {detectMaturePack} from '../bridge/mature-pack.mjs';
import {listLocalModels} from '../bridge/local-model-choice.mjs';
import {findProjector} from '../bridge/local-projector.mjs';
import {ggufFile} from '../bridge/fixtures/gguf-header.mjs';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const config = JSON.parse(await readFile(resolve(project, 'packaging/release.config.json'), 'utf8'));
const text = async rel => (await readFile(resolve(project, rel), 'utf8')).replaceAll('\r\n', '\n');
const standard = config.localAi.tiers.standard, lite = config.localAi.tiers.lite, matureGood = config.maturePack.tiers.good, matureLite = config.maturePack.tiers.lite;
const ROOT = config.layout.localAiDirectory;

test('every model with a vision file pins it by repository, revision, size and SHA-256', () => {
  for (const [label, tier] of [['standard', standard], ['lite', lite], ['mature standard', matureGood], ['mature lite', matureLite]]) {
    const spec = tierProjector(tier, label);
    assert(spec, `${label} has a projector`);
    assert.match(spec.file, /mmproj/i, label);
    assert.equal(spec.license, 'Apache-2.0', label);
    assert.match(spec.local, /\.gguf$/, label);
  }
  assert.match(standard.mmproj.file, /Q8_0\.gguf$/); assert.match(lite.mmproj.file, /Q8_0\.gguf$/);
  // The sizes and hashes read from the Hugging Face file lists on 2026-10-29 and checked on the downloaded files.
  assert.equal(standard.mmproj.size, 559874816); assert.equal(standard.mmproj.sha256, '197f49a93027f9843772bd24a6a9e0be2a32a788de5a3def330e9c585d86edd1');
  assert.equal(lite.mmproj.size, 366894624); assert.equal(lite.mmproj.sha256, 'db939d5f9b7014137810205e91d05e5f54afd72b0b3af9d33bd7d82f7906a55d');
  assert.equal(matureLite.mmproj.size, 675568768, '644 MiB'); assert.equal(matureLite.mmproj.sha256, 'a1e32e86ea99aa7a56f3dcfe7e63c1d0be9439d31fd07087099f15bc0fda0f22');
  assert.equal(standard.mmproj.repository, 'ggml-org/gemma-4-E4B-it-GGUF');
  assert.equal(lite.mmproj.repository, 'prism-ml/Ternary-Bonsai-2-4B-gguf');
  assert.equal(matureLite.mmproj.repository, 'HauhauCS/Qwen3.5-4B-Uncensored-HauhauCS-Aggressive');
  assert.equal(matureLite.mmproj.file, 'mmproj-Qwen3.5-4B-Uncensored-HauhauCS-Aggressive-BF16.gguf');
  assert.equal(lite.mmproj.revision, lite.revision, 'the Bonsai projector is from the same commit as the Bonsai model');
  assert.equal(matureLite.mmproj.revision, matureLite.revision, 'the Qwen3.5-4B projector is from the same commit as the Mature lite model');
});

test('the Gemma 4 E4B projector of the Local AI standard pack and of Mature standard is one pin, so extracting both zips overwrites identical bytes', () => {
  assert.deepEqual(matureGood.mmproj, standard.mmproj);
  assert.deepEqual(projectorConflicts([standard.mmproj, lite.mmproj, matureGood.mmproj, matureLite.mmproj]), []);
  assert.deepEqual(projectorConflicts([standard.mmproj, {...matureGood.mmproj, sha256: 'a'.repeat(64)}]).length, 1, 'the same file name with another hash is a conflict');
  const names = [standard, lite, matureLite].map(tier => tier.mmproj.file.toLowerCase());
  assert.equal(new Set(names).size, 3, 'three different projector files, so no two models share a path by accident');
});

test('a pin that is incomplete, not a projector or not Apache-2.0 is refused', () => {
  const good = standard.mmproj;
  assert.equal(validateProjectorSpec(good), good);
  const bad = patch => () => validateProjectorSpec({...good, ...patch}, 'x');
  assert.throws(bad({file: 'gemma-4-E4B-it-Q8_0.gguf'}), /does not look like a projector/);
  assert.throws(bad({file: 'folder/mmproj.gguf'}), /plain \.gguf file name/);
  assert.throws(bad({file: 'mmproj.bin'}), /plain \.gguf file name/);
  assert.throws(bad({revision: 'main'}), /40 digit/);
  assert.throws(bad({sha256: 'abc'}), /64 hex/);
  assert.throws(bad({size: 12}), /size/);
  assert.throws(bad({size: '559874816'}), /size/);
  assert.throws(bad({repository: 'not a repository'}), /owner\/name/);
  assert.throws(bad({license: 'Gemma'}), /Apache-2\.0/);
  assert.throws(() => validateProjectorSpec(null, 'x'), /no projector is pinned/);
  assert.equal(tierProjector({file: 'm.gguf'}, 'x'), null, 'a tier without the field has none');
  assert.throws(() => tierProjector({file: 'm.gguf', mmproj: {...good, sha256: 'zz'}}, 'x'), /64 hex/);
  assert.equal(projectorUrl(good), `https://huggingface.co/ggml-org/gemma-4-E4B-it-GGUF/resolve/${good.revision}/mmproj-gemma-4-E4B-it-Q8_0.gguf`, 'the URL names the pinned revision, never a branch');
});

test('a downloaded projector is checked against its pinned size and SHA-256', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pack projector '));
  try {
    const bytes = Buffer.alloc(1_100_000, 7);
    const spec = {...standard.mmproj, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex')};
    const file = join(directory, spec.file);
    await writeFile(file, bytes);
    assert.equal(await verifyProjectorFile(file, spec), file, 'the pinned file passes');
    // One byte more: the size is checked first.
    await writeFile(file, Buffer.concat([bytes, Buffer.from([1])]));
    await assert.rejects(verifyProjectorFile(file, spec), /is 1100001 bytes, not the pinned 1100000/);
    // The same size with one byte changed: the hash catches it.
    const changed = Buffer.from(bytes); changed[500] = 8;
    await writeFile(file, changed);
    await assert.rejects(verifyProjectorFile(file, spec), /has SHA-256 [0-9a-f]{64}, not the pinned/);
    // A missing file and a bad pin are errors, never a pass.
    await assert.rejects(verifyProjectorFile(join(directory, 'absent.gguf'), spec));
    await assert.rejects(verifyProjectorFile(file, {...spec, sha256: 'x'}), /64 hex/);
    // The checks are injectable, and the real pin of a pack is refused for a file of the wrong size.
    await assert.rejects(verifyProjectorFile(file, standard.mmproj, {sizeOf: async () => 1}), /not the pinned 559874816/);
    assert.equal(await verifyProjectorFile('x', standard.mmproj, {sizeOf: async () => standard.mmproj.size, hashOf: async () => standard.mmproj.sha256}), 'x');
  } finally { await rm(directory, {recursive: true, force: true}); }
});

test('the manifests the builder writes NAME each expected projector (the packs hold none), and the bridge finds it only when its zip is extracted', () => {
  const root = join('C:', 'game', 'app', 'local-ai');
  const embed = {file: `models/${config.localAi.embed.file}`, dim: 384, id: 'granite-embedding-107m-multilingual-q8_0'};
  const entry = (tier, extra = {}) => ({file: `models/${tier.file}`, name: tier.name, ...extra});
  // The same shapes as localAiPackage and maturePackage in packaging/build-release.mjs.
  const fragments = {
    'manifest.standard.json': {version: 1, standard: entry(standard, projectorField(tierProjector(standard))), embed},
    'manifest.lite.json': {version: 1, lite: entry(lite, projectorField(tierProjector(lite))), embed},
    'manifest.mature-standard.json': {version: 1, pack: 'mature', good: entry(matureGood, {family: matureGood.family, ...projectorField(tierProjector(matureGood))}), embed},
    'manifest.mature-lite.json': {version: 1, pack: 'mature', lite: entry(matureLite, {family: matureLite.family, ...projectorField(tierProjector(matureLite))}), embed},
  };
  // The manifest says `models/<file>`: where the vision zip writes the file, beside the model files.
  assert.equal(fragments['manifest.standard.json'].standard.mmproj, 'models/mmproj-gemma-4-E4B-it-Q8_0.gguf');
  assert.equal(fragments['manifest.lite.json'].lite.mmproj, 'models/Ternary-Bonsai-2-4B-mmproj-Q8_0.gguf');
  assert.equal(fragments['manifest.mature-standard.json'].good.mmproj, 'models/mmproj-gemma-4-E4B-it-Q8_0.gguf');
  assert.equal(fragments['manifest.mature-lite.json'].lite.mmproj, 'models/mmproj-Qwen3.5-4B-Uncensored-HauhauCS-Aggressive-BF16.gguf');
  assert.equal(projectorManifestPath(standard.mmproj), `${PROJECTOR_FOLDER}/${standard.mmproj.file}`);
  assert.equal(visionFilePath(ROOT, standard.mmproj), `${ROOT}/${PROJECTOR_FOLDER}/${standard.mmproj.file}`, 'the zip writes the file where the manifest names it');
  assert.deepEqual(projectorField(null), {});

  const files = new Map([[resolve(root, embed.file), ggufFile('bert')], [resolve(root, 'llama/llama-server.exe'), Buffer.alloc(8)]]);
  for (const tier of [standard, lite, matureGood, matureLite]) files.set(resolve(root, 'models', tier.file), ggufFile('gemma4'));
  for (const [name, manifest] of Object.entries(fragments)) files.set(resolve(root, name), JSON.stringify({...manifest, server: 'llama/llama-server.exe'}));
  const options = {project: 'x', environment: {CYBERPUNK_CONVAI_LOCAL_AI: root}, exists: path => files.has(path), readText: path => files.get(path)};
  const head = path => files.get(path);
  const finder = (file, declared, {auto = true} = {}) => findProjector({file, declared, auto}, {list: () => [], stat: path => (files.has(path) ? {size: 4096, mtimeMs: 1} : null), head});
  const models = () => Object.fromEntries(listLocalModels({pack: detectLocalAiPack(options), matureModels: detectMaturePack(options).models, findProjector: finder}).map(model => [model.id, model]));
  const projectorPath = tier => resolve(root, 'models', tier.mmproj.file);

  // 1. Only the packs are extracted: every model NAMES its projector (the name is kept, with the folder to get it from), none is found.
  let list = models();
  assert.deepEqual(Object.keys(list), ['standard', 'lite', 'mature:lite', 'mature:good']);
  assert.deepEqual(Object.values(list).map(model => model.mmproj), [null, null, null, null]);
  assert.deepEqual(Object.values(list).map(model => [model.mmprojNamed, model.visionFolder]), [
    [projectorPath(standard), 'local-ai'], [projectorPath(lite), 'local-ai'], [projectorPath(matureLite), 'mature'], [projectorPath(matureGood), 'mature']]);

  // 2. The vision zips are extracted too (real projector headers): each model is handed its own projector, and nothing else.
  for (const tier of [standard, lite, matureGood, matureLite]) files.set(projectorPath(tier), ggufFile('clip'));
  list = models();
  assert.deepEqual(Object.fromEntries(Object.entries(list).map(([id, model]) => [id, model.mmproj])), {standard: projectorPath(standard), lite: projectorPath(lite),
    'mature:lite': projectorPath(matureLite), 'mature:good': projectorPath(matureGood)});

  // 3. A named file that is not a projector (a chat model renamed, a half download that lost its header) is not used, and nothing else is looked for in its place.
  files.set(projectorPath(standard), ggufFile('gemma4'));
  assert.equal(models().standard.mmproj, null);

  // 4. A model with no name in its manifest (a custom model, an older pack) carries no named projector at all.
  const custom = listLocalModels({pack: {tiers: {standard: {file: resolve(root, 'models', standard.file), name: 'Gemma'}}}, findProjector: () => null});
  assert.deepEqual([custom[0].mmprojNamed, custom[0].visionFolder], [undefined, undefined]);
});

test('the builder names the projector in the manifests but puts none in a pack, and builds each vision zip with the one helper', async () => {
  const builder = await text('packaging/build-release.mjs');
  const body = name => { const at = builder.indexOf(`async function ${name}(`); assert(at >= 0, name); return builder.slice(at, builder.indexOf('\n}\n', at)); };
  const localAi = body('localAiPackage'), mature = body('maturePackage'), vision = body('visionPackage');
  // The packs: the manifest names it, nothing is added, no notice and no receipt claims it is inside.
  assert.match(localAi, /const projector = tierProjector\(tier, `Local AI \$\{tierKey\}`\)/);
  assert.match(localAi, /\[tierKey\]: \{file: `models\/\$\{tier\.file\}`, name: tier\.name, \.\.\.projectorField\(projector\)\}/, 'the manifest names the projector on the model entry');
  assert.match(mature, /const projector = tierProjector\(model, `Mature \$\{packKey\}`\)/);
  assert.match(mature, /family: model\.family, \.\.\.projectorField\(projector\)\}/, 'the Mature marker names it too: a Mature model is never given one by looking beside it');
  for (const [label, source] of [['Local AI', localAi], ['Mature', mature]]) {
    assert.doesNotMatch(source, /verifyProjectorFile|projectorUrl|addProjector|projectorNotice|projectorReceipt/, `${label}: no pack fetches, checks or credits a projector`);
    assert.doesNotMatch(source, /pkg\.file\([^)]*mmproj/i, `${label}: no pack file is a projector`);
  }
  assert.equal(builder.includes('async function addProjector'), false, 'the helper that put a projector inside a pack is gone');
  // The vision zip: fetched like a model, checked against the pin, written where the manifests name it.
  assert.match(vision, /const zip = visionZip\(config, id\), root = config\.layout\.localAiDirectory/);
  assert.match(vision, /verifyProjectorFile\(await localAiFile\(zip\.spec, projectorUrl\(zip\.spec\), zip\.spec\.file\), zip\.spec\)/, 'the file is checked against its pin after the fetch');
  assert.match(vision, /pkg\.file\(visionFilePath\(root, zip\.spec\)/);
  assert.match(vision, /visionNoticePath\(root, zip\.title\)/); assert.match(vision, /visionReceiptPath\(root, id\)/);
  assert.match(builder, /\.\.\.Object\.fromEntries\(visionZipIds\(config\)\.map\(id => \[id, \(\) => visionPackage\(source, config, id\)\]\)\)/, 'a builder per vision zip');
  assert.match(builder, /const PACKAGE_IDS = \[[^\]]*'mature-standard', 'vision-gemma', 'vision-bonsai', 'vision-qwen', 'micpack-european'/);
  assert.match(builder, /const OPTIONAL_PACKAGE_IDS = new Set\(\[[^\]]*'vision-gemma', 'vision-bonsai', 'vision-qwen'/, 'one zip each, no parts');
  assert.match(builder, /DEFAULT_PACKAGE_IDS = PACKAGE_IDS\.filter\([^;]*!id\.startsWith\('vision'\)/, 'never in the default set');
  assert.match(builder, /--packages LIST    comma list of [^\n]*vision-gemma,vision-bonsai,vision-qwen/);
  // Notices and receipts.
  const spec = standard.mmproj;
  assert.match(projectorNotice(spec, 'Google'), /Gemma 4 E4B vision projector \(Q8_0\) \(GGUF, made for Google's model.*Apache-2\.0.*huggingface\.co\/ggml-org\/gemma-4-E4B-it-GGUF/);
  assert.deepEqual(projectorReceipt(spec), {projector: `${spec.repository}@${spec.revision}`, projectorFile: spec.file, projectorSha256: spec.sha256});
  assert.deepEqual(projectorReceipt(null), {});
});

test('three vision zips, named after the model and its size, in the vision folder of local-ai or mature, Gemma 4 E4B in both', () => {
  assert.deepEqual(visionZipIds(config), ['vision-gemma', 'vision-bonsai', 'vision-qwen']);
  const zips = Object.fromEntries(visionZipIds(config).map(id => [id, visionZip(config, id)]));
  assert.deepEqual(Object.fromEntries(Object.entries(zips).map(([id, zip]) => [id, zip.title])),
    {'vision-gemma': 'Vision-Gemma-4-E4B-projector', 'vision-bonsai': 'Vision-Bonsai-2-4B-projector', 'vision-qwen': 'Vision-Qwen3.5-4B-projector'});
  assert.deepEqual(zips['vision-gemma'].folders, ['local-ai/vision', 'mature/vision']);
  assert.deepEqual(zips['vision-bonsai'].folders, ['local-ai/vision']);
  assert.deepEqual(zips['vision-qwen'].folders, ['mature/vision']);
  assert.deepEqual(hfPaths(config, 'vision-gemma'), ['local-ai/vision/Vision-Gemma-4-E4B-projector.zip', 'mature/vision/Vision-Gemma-4-E4B-projector.zip']);
  assert.deepEqual(hfPaths(config, 'vision-qwen'), ['mature/vision/Vision-Qwen3.5-4B-projector.zip']);
  assert.deepEqual(hfPaths(config, 'localai-lite'), ['local-ai/LocalAI-Lite-Bonsai-2-4B.zip'], 'a pack with no alsoIn has one path');
  // The same naming rule as the packs: the model's name and its size are in the file name (the pins say which model).
  assert.equal(zips['vision-gemma'].spec, standard.mmproj); assert.equal(zips['vision-bonsai'].spec, lite.mmproj); assert.equal(zips['vision-qwen'].spec, matureLite.mmproj);
  assert.match(packTitle(config, 'localai-standard'), /Gemma-4-E4B/); assert.match(packTitle(config, 'vision-gemma'), /Gemma-4-E4B/);
  assert.match(packTitle(config, 'localai-lite'), /Bonsai-2-4B/); assert.match(packTitle(config, 'vision-bonsai'), /Bonsai-2-4B/);
  assert.match(packTitle(config, 'mature-lite'), /Qwen3\.5-4B/); assert.match(packTitle(config, 'vision-qwen'), /Qwen3\.5-4B/);
  for (const zip of Object.values(zips)) assert.match(zip.title, /^Vision-.+-projector$/);
  assert.equal(packIdOfName(config, 'Vision-Qwen3.5-4B-projector-0.3.5.zip'), 'vision-qwen');
  assert.equal(packIdOfName(config, 'Vision-Gemma-4-E4B-projector.zip'), 'vision-gemma');
  // Every pack that NAMES a projector is served by a zip that carries exactly that pin, in the folder family of the pack.
  for (const [packId, tier] of [['localai-standard', standard], ['localai-lite', lite], ['mature-standard', matureGood], ['mature-lite', matureLite]]) {
    const serving = Object.values(zips).filter(zip => zip.usedBy.includes(packId));
    assert.equal(serving.length, 1, `${packId}: one vision zip`);
    assert.deepEqual(serving[0].spec, tier.mmproj, `${packId}: the zip holds the file its manifest names`);
    const family = packId.startsWith('mature') ? 'mature/vision' : 'local-ai/vision';
    assert(serving[0].folders.includes(family), `${packId}: the zip is in ${family}`);
  }
  // The folder of the notice (bridge/local-model-choice.mjs visionFolder) is where the file is.
  assert(zips['vision-gemma'].folders.includes('local-ai/vision') && zips['vision-gemma'].folders.includes('mature/vision'));
  assert.equal(pinTierOf(config, 'maturePack.tiers.lite'), matureLite);
  // Bad configs are refused.
  const broken = patch => { const copy = structuredClone(config); patch(copy); return () => visionZip(copy, 'vision-gemma'); };
  assert.throws(() => visionZip(config, 'localai-lite'), /not a vision file/);
  assert.throws(broken(copy => { copy.visionFiles.zips['vision-gemma'].pin = 'localAi.tiers.nothing'; }), /no projector is pinned/);
  assert.throws(broken(copy => { copy.packFiles.packs['vision-gemma'].folder = 'local-ai'; }), /vision/);
  assert.throws(broken(copy => { copy.packFiles.packs['vision-gemma'].title = 'Vision-Gemma'; }), /Vision-<Model>-<Params>-projector/);
  assert.throws(broken(copy => { copy.visionFiles.zips['vision-gemma'].usedBy = ['nothing']; }), /not a pack/);
});

test('what a vision zip holds: the file where the manifests name it, the licence, a notice, and a receipt the pack placer reads like a marker', async () => {
  const zip = visionZip(config, 'vision-qwen');
  assert.equal(visionFilePath(ROOT, zip.spec), `${ROOT}/models/mmproj-Qwen3.5-4B-Uncensored-HauhauCS-Aggressive-BF16.gguf`);
  assert.equal(visionReceiptPath(ROOT, 'vision-qwen'), `${ROOT}/vision-qwen.json`);
  assert.equal(visionNoticePath(ROOT, zip.title), `${ROOT}/vision/THIRD-PARTY-NOTICES-Vision-Qwen3.5-4B-projector.txt`);
  const notice = visionNoticeText(zip, config.product);
  assert.match(notice, /Qwen3\.5-4B vision projector \(BF16\)/); assert.match(notice, /Apache-2\.0/); assert.match(notice, /huggingface\.co\/HauhauCS\//);
  assert.match(notice, /mature-lite/); assert.match(notice, /\r\n/); assert.doesNotMatch(notice, /;|—|–| -- /, 'no semicolon and no dash as punctuation in the text a player may read');
  // The placer: vision-*.json is a marker of the Local AI folder, so a zip extracted one folder too deep is moved into place.
  const placer = await text('packaging/runtime/place-packs.mjs');
  const marker = new RegExp(placer.match(/const LOCAL_MARKER = \/(.*)\/;/)[1]);
  for (const name of ['manifest.standard.json', 'manifest.mature-lite.json', 'vision-gemma.json', 'vision-bonsai.json', 'vision-qwen.json']) assert.match(name, marker, name);
  for (const name of ['vision.json', 'models.json', 'manifest-x.json', 'local-ai-standard.json']) assert.doesNotMatch(name, marker, name);
});

test('the pack sizes in the texts are the sizes of what the packs hold again (the model and the embedding model), and the vision files are listed with theirs', async () => {
  const embedBytes = config.localAi.embed.size;
  const gb = bytes => (bytes / 1e9).toFixed(1), gb2 = bytes => (bytes / 1e9).toFixed(2);
  const sizes = {standard: gb(standard.size + embedBytes), lite: gb(lite.size + embedBytes), matureStandard: gb(matureGood.size + embedBytes), matureLite: gb(matureLite.size + embedBytes)};
  assert.deepEqual(sizes, {standard: '5.3', lite: '1.3', matureStandard: '5.5', matureLite: '2.8'});
  const card = await text('packaging/HF_MODEL_CARD.md');
  assert.match(card, new RegExp(`LocalAI-Standard-Gemma-4-E4B\\.zip\` \\| ${sizes.standard} GB \\|`));
  assert.match(card, new RegExp(`LocalAI-Lite-Bonsai-2-4B\\.zip\` \\| ${sizes.lite} GB \\|`));
  assert.match(card, new RegExp(`Mature-Standard-Gemma-4-E4B\\.zip\` \\| ${sizes.matureStandard} GB \\|`));
  assert.match(card, new RegExp(`Mature-Lite-Qwen3\\.5-4B\\.zip\` \\| ${sizes.matureLite} GB \\|`));
  const nexus = await text('docs/NEXUS_PAGE.md');
  assert.match(nexus, new RegExp(`Local AI standard\\[/b\\]\\[/url\\] \\(about ${sizes.standard} GB\\)`));
  assert.match(nexus, new RegExp(`Local AI lite\\[/b\\]\\[/url\\] \\(about ${sizes.lite} GB\\)`));
  assert.match(nexus, new RegExp(`Mature standard\\[/b\\]\\[/url\\] \\(about ${sizes.matureStandard} GB\\)`));
  const readme = await text('README.md');
  assert.match(readme, new RegExp(`LocalAI-Standard-Gemma-4-E4B\\.zip\\) \\| about ${sizes.standard} GB \\|`));
  assert.match(readme, new RegExp(`LocalAI-Lite-Bonsai-2-4B\\.zip\\) \\| about ${sizes.lite} GB \\|`));
  assert.match(readme, new RegExp(`Mature-Standard-Gemma-4-E4B\\.zip\\) \\| about ${sizes.matureStandard} GB \\|`));
  assert.match(readme, new RegExp(`\\| Download \\| about ${sizes.standard} GB \\| about ${sizes.lite} GB \\|`));
  const player = await text('packaging/PLAYER_README.md');
  assert.match(player, new RegExp(`about ${sizes.standard} GB for standard and about ${sizes.lite} GB for lite`));
  assert.match(player, new RegExp(`Gemma 4 E4B, about ${sizes.standard} GB`));
  assert.match(player, new RegExp(`Bonsai 2 4B, about ${sizes.lite} GB`));
  for (const rel of ['packaging/MATURE_PACK_README.md', 'packaging/MATURE_PACK_RELEASE_NOTES.md']) {
    const notes = await text(rel);
    assert.match(notes, /about 2\.8 GB/, rel); assert.match(notes, /about 5\.5 GB/, rel);
    assert.doesNotMatch(notes, /about 6\.0 GB|about 8\.7 GB|about 8\.8 GB/, `${rel}: the sizes with a projector inside are gone`);
  }
  // The vision files: the card lists each with what it is for and its size, in the folder it is in; the Mature texts and the main texts name the folder.
  const mib = bytes => `${(bytes / 1048576).toFixed(0)} MiB`;
  assert.match(card, /local-ai\/vision\/Vision-Gemma-4-E4B-projector\.zip/); assert.match(card, /local-ai\/vision\/Vision-Bonsai-2-4B-projector\.zip/);
  assert.match(card, /mature\/vision\/Vision-Gemma-4-E4B-projector\.zip/); assert.match(card, /mature\/vision\/Vision-Qwen3\.5-4B-projector\.zip/);
  for (const tier of [standard, lite, matureLite]) assert(card.includes(mib(tier.mmproj.size)) || card.includes(`${gb2(tier.mmproj.size)} GB`), `the card gives the size of ${tier.mmproj.file}`);
  for (const rel of ['README.md', 'packaging/PLAYER_README.md', 'docs/NEXUS_PAGE.md', 'packaging/MATURE_PACK_README.md', 'packaging/MATURE_PACK_RELEASE_NOTES.md']) {
    assert.match(await text(rel), /vision/i, `${rel} lists the vision files`);
  }
});
