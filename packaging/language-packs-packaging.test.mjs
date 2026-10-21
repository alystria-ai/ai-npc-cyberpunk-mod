// The voice language packs (docs/VOICE_LANGUAGE_PACKS.md) extract into voices/multilingual/<lang>/ and are theirs alone: the Runtime and the Scripts never ship
// a file there, the pack-overlap check treats the folder as pack-owned, and no removal list ever deletes in it. The bridge modules that read the packs are part
// of the Runtime's file list.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {ZipWriter} from './lib/zip.mjs';
import {checkRuntimeContents} from './check-runtime-contents.mjs';
import {requiredRuntimeFiles} from './lib/runtime-required.mjs';
import {LANGUAGE_PACK_NAME, LANGUAGE_PACK_TREE, PLUGIN, compareWithPacks} from './lib/pack-overlap.mjs';
import {checkRemovals} from './lib/runtime-removals.mjs';
import {PROTECTED, applyRuntimeRemovals, refusalFor} from './runtime/apply-removals.mjs';
import {BRIDGE_MODULES} from './runtime-layout.mjs';

const project = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const read = rel => readFile(resolve(project, rel), 'utf8');
const PACK_FILES = ['manifest.json', 'picked/panam-palmer.wav', 'archetypes/resident-female.wav', 'v-voice/v-male.wav', 'prepared/panam-palmer.ogg', 'prepared/panam-palmer.json']
  .map(file => `${PLUGIN}/voices/multilingual/zh-cn/${file}`);

test('the tree is the language packs\'; the modules that read them are in the Runtime\'s lists', async () => {
  assert.equal(LANGUAGE_PACK_TREE, `${PLUGIN}/voices/multilingual/`);
  for (const module of ['bridge/voice-language-packs.mjs', 'bridge/last-reply-capture.mjs']) {
    assert.ok(BRIDGE_MODULES.includes(module), `${module} is in runtime-layout.mjs`);
    const plan = await read('packaging/release-plan.json');
    assert.ok(plan.includes(`"${module}"`), `${module} is in release-plan.json`);
    assert.ok(existsSync(resolve(project, module)));
  }
});

test('pack overlap: a Runtime or Scripts zip with any file in the language packs\' tree is refused, whatever packs the listing knows', () => {
  const listing = {schema: 1, packs: [{name: 'OmniPack', file: 'o.zip', bytes: 1, entries: 1, claimed: [], files: [[`${PLUGIN}/voices/other.wav`, 1, '00000000']]}]};
  const clean = compareWithPacks([{path: `${PLUGIN}/voices/v-voice/v-male.wav`, size: 1, crc: '00000001'}], listing);
  assert.equal(clean.ok, true);
  const bad = compareWithPacks(PACK_FILES.map(path => ({path, size: 1, crc: '00000001'})), listing);
  assert.equal(bad.ok, false);
  assert.equal(bad.inPackTrees.length, PACK_FILES.length);
  assert.ok(bad.inPackTrees.every(item => item.pack === LANGUAGE_PACK_NAME));
  // Windows names are not case sensitive.
  assert.equal(compareWithPacks([{path: PACK_FILES[1].toUpperCase(), size: 1, crc: '00000001'}], listing).ok, false);
});

test('the Runtime contents check names a Runtime that ships anything in the language packs\' folder', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'language pack packaging '));
  try {
    const required = await requiredRuntimeFiles(project), names = Object.values(required).flat();
    const zipOf = async (name, entries) => {
      const zip = await ZipWriter.create(join(directory, name));
      for (const entry of entries) await zip.add(entry, {buffer: Buffer.from('x')});
      await zip.close();
      return join(directory, name);
    };
    const lines = [];
    assert.equal(await checkRuntimeContents([await zipOf('good.zip', names)], {log: line => lines.push(line)}), true);
    const bad = await zipOf('bad.zip', [...names, PACK_FILES[1]]);
    lines.length = 0;
    assert.equal(await checkRuntimeContents([bad], {log: line => lines.push(line)}), false);
    assert.ok(lines.some(line => line.includes('MISSING') && line.includes('multilingual/zh-cn/picked/panam-palmer.wav')), lines.join('\n'));
  } finally { await rm(directory, {recursive: true, force: true}); }
});

test('no removal list deletes in the language packs\' folder: refused by the list check, and nothing is deleted when a list names a clip', async () => {
  assert.ok(PROTECTED.includes(`${PLUGIN}/voices/multilingual/`));
  for (const path of PACK_FILES) assert.equal(refusalFor(path), 'protected', path);
  const {ok, refused} = checkRemovals([...PACK_FILES, `${PLUGIN}/voices/old/clip.wav`]);
  assert.deepEqual(ok, [`${PLUGIN}/voices/old/clip.wav`]);
  assert.equal(refused.length, PACK_FILES.length);
  // The service's start step, given such a list: the pack's files stay, the ordinary file goes.
  const root = await mkdtemp(join(tmpdir(), 'language pack removals '));
  try {
    const app = join(root, ...PLUGIN.split('/'), 'app');
    await mkdir(join(app, 'defaults'), {recursive: true});
    for (const path of [...PACK_FILES, `${PLUGIN}/voices/old/clip.wav`]) {
      await mkdir(join(root, ...path.split('/').slice(0, -1)), {recursive: true});
      await writeFile(join(root, ...path.split('/')), 'x');
    }
    await writeFile(join(app, 'defaults', 'runtime-removals.json'), JSON.stringify({version: 't', removes: [...PACK_FILES, `${PLUGIN}/voices/old/clip.wav`]}));
    const result = applyRuntimeRemovals({appDirectory: app});
    assert.equal(result.removed, 1); assert.equal(result.refused, PACK_FILES.length);
    for (const path of PACK_FILES) assert.ok(existsSync(join(root, ...path.split('/'))), path);
    assert.equal(existsSync(join(root, ...`${PLUGIN}/voices/old/clip.wav`.split('/'))), false);
  } finally { await rm(root, {recursive: true, force: true}); }
});

test('the release builder refuses to put a file of the language packs\' folder in the Runtime or the Scripts', async () => {
  const builder = await read('packaging/build-release.mjs');
  assert.match(builder, /\['scripts', 'runtime'\]\.includes\(this\.id\) && name\.toLowerCase\(\)\.startsWith\(LANGUAGE_PACK_TREE\.toLowerCase\(\)\)/);
});
