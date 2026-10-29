// The vision projectors the Local AI and Mature packs ship (docs/PACKAGING.md, "Projectors in the packs"): the pins in release.config.json, the checks of a downloaded file
// against its size and SHA-256, the manifest naming the bridge reads (bridge/local-ai-pack.mjs, bridge/mature-pack.mjs, bridge/local-projector.mjs), the builder's use of the
// helper, and the pack sizes the texts promise. No network and no big file: the pins are read, the files in the checks are stand-ins.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {PROJECTOR_FOLDER, projectorConflicts, projectorField, projectorManifestPath, projectorNotice, projectorReceipt, projectorUrl, tierProjector, validateProjectorSpec,
  verifyProjectorFile} from './lib/pack-projector.mjs';
import {detectLocalAiPack} from '../bridge/local-ai-pack.mjs';
import {detectMaturePack} from '../bridge/mature-pack.mjs';
import {listLocalModels} from '../bridge/local-model-choice.mjs';
import {findProjector} from '../bridge/local-projector.mjs';
import {ggufFile} from '../bridge/fixtures/gguf-header.mjs';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const config = JSON.parse(await readFile(resolve(project, 'packaging/release.config.json'), 'utf8'));
const text = async rel => (await readFile(resolve(project, rel), 'utf8')).replaceAll('\r\n', '\n');
const standard = config.localAi.tiers.standard, lite = config.localAi.tiers.lite, matureGood = config.maturePack.tiers.good, matureLite = config.maturePack.tiers.lite;

test('every pack that ships a projector pins it by repository, revision, size and SHA-256, and Mature lite ships none yet', () => {
  for (const [label, tier] of [['standard', standard], ['lite', lite], ['mature standard', matureGood]]) {
    const spec = tierProjector(tier, label);
    assert(spec, `${label} has a projector`);
    assert.match(spec.file, /mmproj/i, label);
    assert.match(spec.file, /Q8_0\.gguf$/, `${label}: the Q8_0 file`);
    assert.equal(spec.license, 'Apache-2.0', label);
    assert.match(spec.local, /\.gguf$/, label);
  }
  // The sizes and hashes read from the Hugging Face file lists on 2026-10-29 and checked on the downloaded files.
  assert.equal(standard.mmproj.size, 559874816); assert.equal(standard.mmproj.sha256, '197f49a93027f9843772bd24a6a9e0be2a32a788de5a3def330e9c585d86edd1');
  assert.equal(lite.mmproj.size, 366894624); assert.equal(lite.mmproj.sha256, 'db939d5f9b7014137810205e91d05e5f54afd72b0b3af9d33bd7d82f7906a55d');
  assert.equal(standard.mmproj.repository, 'ggml-org/gemma-4-E4B-it-GGUF');
  assert.equal(lite.mmproj.repository, 'prism-ml/Ternary-Bonsai-2-4B-gguf');
  assert.equal(lite.mmproj.revision, lite.revision, 'the Bonsai projector is from the same commit as the Bonsai model');
  // The Mature lite projector (Qwen3.5-4B, 644 MiB) is not downloaded or checked: no pin, so the builder writes none.
  assert.equal(tierProjector(matureLite, 'mature lite'), null);
  assert.equal(matureLite.mmproj, undefined);
});

test('the Gemma 4 E4B projector of the Local AI standard pack and of Mature standard is one pin, so the two packs overwrite identical bytes', () => {
  assert.deepEqual(matureGood.mmproj, standard.mmproj);
  assert.deepEqual(projectorConflicts([standard.mmproj, lite.mmproj, matureGood.mmproj]), []);
  assert.deepEqual(projectorConflicts([standard.mmproj, {...matureGood.mmproj, sha256: 'a'.repeat(64)}]).length, 1, 'the same file name with another hash is a conflict');
  assert.notEqual(standard.mmproj.file.toLowerCase(), lite.mmproj.file.toLowerCase(), 'the two Local AI packs never write the same projector path');
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

test('the manifests the builder writes name each projector, and the bridge hands the model that projector and nothing else', () => {
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
  // The manifest says `models/<file>`: inside the pack, in models/ with the model files.
  assert.equal(fragments['manifest.standard.json'].standard.mmproj, 'models/mmproj-gemma-4-E4B-it-Q8_0.gguf');
  assert.equal(fragments['manifest.lite.json'].lite.mmproj, 'models/Ternary-Bonsai-2-4B-mmproj-Q8_0.gguf');
  assert.equal(fragments['manifest.mature-standard.json'].good.mmproj, 'models/mmproj-gemma-4-E4B-it-Q8_0.gguf');
  assert.equal(fragments['manifest.mature-lite.json'].lite.mmproj, undefined, 'a model with no pin has no field');
  assert.equal(projectorManifestPath(standard.mmproj), `${PROJECTOR_FOLDER}/${standard.mmproj.file}`);
  assert.deepEqual(projectorField(null), {});

  const files = new Map([[resolve(root, embed.file), ggufFile('bert')], [resolve(root, 'llama/llama-server.exe'), Buffer.alloc(8)]]);
  for (const tier of [standard, lite, matureGood, matureLite]) files.set(resolve(root, 'models', tier.file), ggufFile('gemma4'));
  for (const tier of [standard, lite, matureGood]) files.set(resolve(root, 'models', tier.mmproj.file), ggufFile('clip'));
  for (const [name, manifest] of Object.entries(fragments)) files.set(resolve(root, name), JSON.stringify({...manifest, server: 'llama/llama-server.exe'}));
  const options = {project: 'x', environment: {CYBERPUNK_CONVAI_LOCAL_AI: root}, exists: path => files.has(path), readText: path => files.get(path)};
  const pack = detectLocalAiPack(options), mature = detectMaturePack(options);
  assert.equal(pack.tiers.standard.mmproj, resolve(root, 'models', standard.mmproj.file));
  assert.equal(pack.tiers.lite.mmproj, resolve(root, 'models', lite.mmproj.file));
  assert.equal(mature.models.find(model => model.tier === 'good').mmproj, resolve(root, 'models', matureGood.mmproj.file));
  assert.equal(mature.models.find(model => model.tier === 'lite').mmproj, undefined);

  // The model list: each model gets its own projector (checked as a real projector by its GGUF header), and Mature lite none.
  const head = path => files.get(path);
  const finder = (file, declared, {auto = true} = {}) => findProjector({file, declared, auto}, {list: () => [], stat: path => (files.has(path) ? {size: 4096, mtimeMs: 1} : null), head});
  const models = Object.fromEntries(listLocalModels({pack, matureModels: mature.models, findProjector: finder}).map(model => [model.id, model.mmproj]));
  assert.deepEqual(models, {standard: resolve(root, 'models', standard.mmproj.file), lite: resolve(root, 'models', lite.mmproj.file),
    'mature:good': resolve(root, 'models', matureGood.mmproj.file), 'mature:lite': null});
  // A projector that is named but is not one (a chat model renamed, a half download that lost its header) is not used, and nothing else is looked for in its place.
  files.set(resolve(root, 'models', standard.mmproj.file), ggufFile('gemma4'));
  assert.equal(listLocalModels({pack: detectLocalAiPack(options), findProjector: finder}).find(model => model.id === 'standard').mmproj, null);
});

test('the builder fetches, checks and names the projector for both kinds of pack with the one helper, and records it in the notices and receipts', async () => {
  const builder = await text('packaging/build-release.mjs');
  const body = name => { const at = builder.indexOf(`async function ${name}(`); assert(at >= 0, name); return builder.slice(at, builder.indexOf('\n}\n', at)); };
  // One helper: the pinned file from the developer folder or the pinned revision, checked against size and hash, written into models/.
  const helper = body('addProjector');
  assert.match(helper, /tierProjector\(tier, label\)/);
  assert.match(helper, /verifyProjectorFile\(await localAiFile\(spec, projectorUrl\(spec\), spec\.file\), spec\)/, 'the file is checked against its pin after the fetch');
  assert.match(helper, /\$\{root\}\/\$\{PROJECTOR_FOLDER\}\/\$\{spec\.file\}/);
  const localAi = body('localAiPackage'), mature = body('maturePackage');
  assert.match(localAi, /const projector = await addProjector\(pkg, root, tier, `Local AI \$\{tierKey\}`\)/);
  assert.match(localAi, /\[tierKey\]: \{file: `models\/\$\{tier\.file\}`, name: tier\.name, \.\.\.projectorField\(projector\)\}/, 'the manifest names the projector on the model entry');
  assert.match(localAi, /\.\.\.projectorReceipt\(projector\)/);
  assert.match(localAi, /projectorNotice\(model\.mmproj, owner\)/);
  assert.match(mature, /const projector = await addProjector\(pkg, root, model, `Mature \$\{packKey\}`\)/);
  assert.match(mature, /family: model\.family, \.\.\.projectorField\(projector\)\}/, 'the Mature marker names it too: a Mature model is never given one by looking beside it');
  assert.match(mature, /\.\.\.projectorReceipt\(projector\)/);
  assert.match(mature, /projectorNotice\(projector, 'Google'\)/);
  // Notices and receipts.
  const spec = standard.mmproj;
  assert.match(projectorNotice(spec, 'Google'), /Gemma 4 E4B vision projector \(Q8_0\) \(GGUF, made for Google's model.*Apache-2\.0.*huggingface\.co\/ggml-org\/gemma-4-E4B-it-GGUF/);
  assert.deepEqual(projectorReceipt(spec), {projector: `${spec.repository}@${spec.revision}`, projectorFile: spec.file, projectorSha256: spec.sha256});
  assert.deepEqual(projectorReceipt(null), {});
});

test('the pack sizes in the texts are the sizes of what the packs hold: the model, the embedding model and the projector', async () => {
  const embedBytes = config.localAi.embed.size;
  const gb = bytes => (bytes / 1e9).toFixed(1);
  const sizes = {standard: gb(standard.size + embedBytes + standard.mmproj.size), lite: gb(lite.size + embedBytes + lite.mmproj.size),
    matureStandard: gb(matureGood.size + embedBytes + matureGood.mmproj.size), matureLite: gb(matureLite.size + embedBytes)};
  assert.deepEqual(sizes, {standard: '5.8', lite: '1.7', matureStandard: '6.0', matureLite: '2.8'});
  const card = await text('packaging/HF_MODEL_CARD.md');
  assert.match(card, new RegExp(`LocalAI-Standard-Gemma-4-E4B\\.zip\` \\| ${sizes.standard} GB \\|`));
  assert.match(card, new RegExp(`LocalAI-Lite-Bonsai-2-4B\\.zip\` \\| ${sizes.lite} GB \\|`));
  assert.match(card, new RegExp(`Mature-Standard-Gemma-4-E4B\\.zip\` \\| ${sizes.matureStandard} GB \\|`));
  assert.match(card, new RegExp(`Mature-Lite-Qwen3\\.5-4B\\.zip\` \\| ${sizes.matureLite} GB \\|`), 'Mature lite is unchanged');
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
});
