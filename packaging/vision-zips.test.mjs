// The three vision files (a model's projector as a small zip of its own, docs/PACKAGING.md, "Vision files"), built for real by packaging/build-release.mjs and read back
// (node --test packaging/vision-zips.test.mjs). Small generated stand-in files stand for the projectors: the pins of release.config.json are replaced through --release-config
// by the stand-ins' sizes and hashes, and the builder takes them from a developer folder (--models local --local-ai-source). No download, no secret, no big file. The same build
// with a wrong byte must stop.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn, spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {listZip} from './lib/zip.mjs';
import {detectLocalAiPack} from '../bridge/local-ai-pack.mjs';
import {ggufFile} from '../bridge/fixtures/gguf-header.mjs';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const builder = resolve(project, 'packaging/build-release.mjs');
const config = JSON.parse(await readFile(resolve(project, 'packaging/release.config.json'), 'utf8'));
const ROOT = config.layout.localAiDirectory;
const NOTE = 'HOW TO INSTALL - extract into your Cyberpunk 2077 folder.txt';
const VERSION = '0.3.5';
const TAR = process.platform === 'win32' ? resolve(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
// pack id -> where its pin is in the release config
const PINS = {'vision-gemma': ['localAi', 'tiers', 'standard'], 'vision-bonsai': ['localAi', 'tiers', 'lite'], 'vision-qwen': ['maturePack', 'tiers', 'lite']};
const tierOf = (copy, path) => path.reduce((value, key) => value[key], copy);

// A projector header (architecture clip) padded to a different size per file: the pin check reads size and hash, the bridge checks the header.
const standIn = index => Buffer.concat([ggufFile('clip'), Buffer.alloc(1_100_000 + 50_000 * index, index + 1)]);

async function prepare(root) {
  const copy = structuredClone(config), bytes = {};
  let index = 0;
  for (const [id, path] of Object.entries(PINS)) {
    const tier = tierOf(copy, path), data = standIn(index++);
    bytes[id] = data;
    Object.assign(tier.mmproj, {size: data.length, sha256: sha(data)});
    await mkdir(dirname(join(root, 'dev', tier.mmproj.local)), {recursive: true});
    await writeFile(join(root, 'dev', tier.mmproj.local), data);
  }
  const configFile = join(root, 'release.config.json');
  await writeFile(configFile, JSON.stringify(copy, null, 1));
  return {copy, bytes, configFile};
}

function build({configFile, root, packages, extra = []}) {
  const args = [builder, '--version', VERSION, '--dry-run', '--worktree', '--models', 'local', '--local-ai-source', join(root, 'dev'), '--packages', packages, '--out', join(root, 'out'),
    '--cache', join(root, 'cache'), '--release-config', configFile, ...extra];
  const environment = {...process.env};
  delete environment.CYBERPUNK_CONVAI_LOCAL_AI_DEV;
  return new Promise(done => {
    const child = spawn(process.execPath, args, {env: environment, windowsHide: true});
    let output = '';
    child.stdout.on('data', data => { output += data; });
    child.stderr.on('data', data => { output += data; });
    child.on('close', status => done({status, output}));
  });
}

async function extract(zip, destination) {
  await mkdir(destination, {recursive: true});
  const result = spawnSync(TAR, ['-xf', zip, '-C', destination], {encoding: 'utf8'});
  assert.equal(result.status, 0, result.stderr);
}

test('each vision zip holds exactly the projector at models/, the licence, a notice and a receipt, and nothing of a model pack', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ai npc vision zips '));
  try {
    const {copy, bytes, configFile} = await prepare(root);
    const run = await build({configFile, root, packages: 'vision-gemma,vision-bonsai,vision-qwen'});
    assert.equal(run.status, 0, run.output);
    for (const [id, path] of Object.entries(PINS)) {
      const pack = copy.packFiles.packs[id], spec = tierOf(copy, path).mmproj, zip = join(root, 'out', 'packages', `${pack.title}-${VERSION}.zip`);
      const entries = await listZip(zip);
      const names = entries.map(entry => entry.name).sort();
      assert.deepEqual(names, [NOTE, `${ROOT}/licenses/Apache-2.0.txt`, `${ROOT}/models/${spec.file}`, `${ROOT}/vision-${id.replace('vision-', '')}.json`,
        `${ROOT}/vision/THIRD-PARTY-NOTICES-${pack.title}.txt`].sort(), `${id}: exactly these files`);
      assert(!names.some(name => /manifest\.|local-ai-|mature-pack|embedding|granite|llama/i.test(name)), `${id}: no pack file, no model, no embedding model`);
      // The file is the stand-in's bytes, at the path the pack manifests name.
      const out = join(root, `unpacked-${id}`);
      await extract(zip, out);
      assert.equal(sha(await readFile(join(out, ROOT, 'models', spec.file))), spec.sha256, `${id}: the pinned bytes`);
      assert.equal(entries.find(entry => entry.name === `${ROOT}/models/${spec.file}`).uncompressed, bytes[id].length);
      const receipt = JSON.parse(await readFile(join(out, ROOT, `${id}.json`), 'utf8'));
      assert.deepEqual(receipt, {product: copy.product, package: id, version: VERSION, commit: 'worktree', usedBy: copy.visionFiles.zips[id].usedBy,
        projector: `${spec.repository}@${spec.revision}`, projectorFile: spec.file, projectorSha256: spec.sha256});
      const notice = await readFile(join(out, ROOT, 'vision', `THIRD-PARTY-NOTICES-${pack.title}.txt`), 'utf8');
      assert(notice.includes(spec.repository) && notice.includes('Apache-2.0'), `${id}: the notice names the repository and the licence`);
      assert(notice.includes('\r\n') && !/[^\r]\n/.test(notice), `${id}: CRLF line ends`);
      assert.doesNotMatch(notice, /;|\u2014|\u2013/, `${id}: no semicolon and no long dash`);
      assert.equal(await readFile(join(out, ROOT, 'licenses', 'Apache-2.0.txt'), 'utf8'), await readFile(resolve(project, 'packaging/licenses/Apache-2.0.txt'), 'utf8'), `${id}: the licence text of the packs`);
    }
    // Extracted together with a pack's manifest (the game folder after both downloads), the bridge hands the model its projector.
    const game = join(root, 'game');
    for (const id of Object.keys(PINS)) await extract(join(root, 'out', 'packages', `${copy.packFiles.packs[id].title}-${VERSION}.zip`), game);
    const localAi = join(game, ROOT);
    await mkdir(join(localAi, 'models'), {recursive: true});
    const standard = copy.localAi.tiers.standard;
    await writeFile(join(localAi, 'models', standard.file), ggufFile('gemma4'));
    await writeFile(join(localAi, 'models', copy.localAi.embed.file), ggufFile('bert'));
    await writeFile(join(localAi, 'manifest.standard.json'), JSON.stringify({version: 1, standard: {file: `models/${standard.file}`, name: standard.name, mmproj: `models/${standard.mmproj.file}`},
      embed: {file: `models/${copy.localAi.embed.file}`, dim: 384, id: 'granite'}}));
    const pack = detectLocalAiPack({project: 'x', environment: {CYBERPUNK_CONVAI_LOCAL_AI: localAi}});
    assert.equal(pack.tiers.standard.mmproj, resolve(localAi, 'models', standard.mmproj.file), 'the file the zip wrote is the file the manifest names');
  } finally { await rm(root, {recursive: true, force: true}); }
});

test('a vision zip is refused when the file differs from its pin by one byte, and a vision id that is not pinned does not exist', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ai npc vision bad '));
  try {
    const {copy, configFile} = await prepare(root);
    const file = join(root, 'dev', copy.localAi.tiers.lite.mmproj.local);
    const bytes = await readFile(file);
    bytes[bytes.length - 1] ^= 1;
    await writeFile(file, bytes);
    const run = await build({configFile, root, packages: 'vision-bonsai'});
    assert.notEqual(run.status, 0, 'the build stops');
    assert.match(run.output, /differs from the pinned/);
    const unknown = await build({configFile, root, packages: 'vision-nothing'});
    assert.notEqual(unknown.status, 0);
    assert.match(unknown.output, /Unknown package: vision-nothing/);
  } finally { await rm(root, {recursive: true, force: true}); }
});
