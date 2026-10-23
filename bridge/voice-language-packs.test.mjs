import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, unlink, mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {VoiceLanguagePacks, LANGUAGE_PACKS, PACK_NAMESPACE, checkWavHeader, defaultFiles, loadPack, packOfTag} from './voice-language-packs.mjs';
import {FAKE_VOICES, sha256, sineWav, writePack} from './fixtures/voice-language-pack.mjs';
import {voiceLanguagePacksSection} from './support-report.mjs';

async function folder(run) {
  const root = await mkdtemp(resolve(tmpdir(), 'convai-language-packs-'));
  try { return await run(root); } finally { await rm(root, {recursive: true, force: true}); }
}
const packs = (root, extra = {}) => { const lines = []; return {lines, packs: new VoiceLanguagePacks({roots: [root], log: line => lines.push(line), ...extra})}; };

test('a good pack is found at start: every voice an in-memory lookup, the reference named as the routing log names it', async () => {
  await folder(async root => {
    const {clips} = await writePack(root);
    const {packs: found, lines} = packs(root);
    const report = await found.scan();
    assert.equal(found.installed, true);
    assert.deepEqual(found.languages(), ['zh']);
    assert.equal(found.has('zh'), true);
    assert.equal(found.has('en'), false);
    assert.deepEqual(report.packs, [{language: 'zh-cn', tag: 'zh', voices: 5, version: '2026-10-21'}]);
    assert.deepEqual(report.problems, []);
    const entry = found.entry('zh', 'panam-palmer');
    assert.equal(entry.set, 'multilingual/zh-cn/picked/panam-palmer');
    assert.equal(found.setOf('zh', 'resident-female'), 'multilingual/zh-cn/archetypes/resident-female');
    assert.equal(found.setOf('zh', 'v-male'), 'multilingual/zh-cn/v-voice/v-male');
    assert.equal(found.setOf('zh', 'npc-maelstrom-male-v2'), 'multilingual/zh-cn/archetypes/npc-maelstrom-male-v2');
    assert.equal(entry.kind, 'picked');
    assert.equal(entry.seconds, 0.4);
    // The worker verifies this descriptor: a path in the references namespace, the clip's hash and the words.
    assert.deepEqual(await found.omniDescriptor('zh', 'panam-palmer'), {reference: `${PACK_NAMESPACE}zh-cn/picked/panam-palmer.wav`,
      sha256: sha256(clips['panam-palmer']), transcript: FAKE_VOICES['panam-palmer'].text});
    assert.equal(lines.filter(line => line.includes('ready')).length, 1);
    // The report names no path and no words.
    const text = JSON.stringify(report);
    assert.equal(text.includes(root), false);
    assert.equal(text.includes(FAKE_VOICES['panam-palmer'].text), false);
  });
});

test('English, an unknown language and a voice the pack lacks have no entry: the English reference stays', async () => {
  await folder(async root => {
    await writePack(root);
    const {packs: found} = packs(root); await found.scan();
    assert.equal(found.entry('en', 'panam-palmer'), null);
    assert.equal(found.entry(undefined, 'panam-palmer'), null);
    assert.equal(found.entry('ja', 'panam-palmer'), null);
    assert.equal(found.entry('zh', 'judy-alvarez'), null);
    assert.equal(await found.omniDescriptor('zh', 'judy-alvarez'), null);
    assert.equal(found.entry('zh', '__proto__'), null);
  });
});

test('the manifest may carry the clip hash; without it the hash is computed once per file', async () => {
  await folder(async root => {
    const {clips} = await writePack(root, {withHash: true});
    const {packs: found} = packs(root); await found.scan();
    assert.equal(found.entry('zh', 'v-male').sha256, sha256(clips['v-male']));
    // Without a hash in the manifest: read once, then remembered while the file is unchanged.
    let reads = 0;
    await writePack(root, {language: 'fr', languageTag: 'fr'});
    const counting = {...defaultFiles, readFile: async (...args) => { reads++; return defaultFiles.readFile(...args); }};
    const second = new VoiceLanguagePacks({roots: [root], files: counting}); await second.scan();
    const afterScan = reads;
    const first = await second.omniDescriptor('fr', 'panam-palmer'), again = await second.omniDescriptor('fr', 'panam-palmer');
    assert.equal(first.sha256, again.sha256);
    assert.equal(reads - afterScan, 1, 'the clip was read once for its hash');
  });
});

test('a pack with a missing file is ignored as a whole, with one notice, and the reason is kept for the support report', async () => {
  await folder(async root => {
    await writePack(root, {voices: {...FAKE_VOICES, 'resident-female': {...FAKE_VOICES['resident-female'], omit: true}}});
    const {packs: found, lines} = packs(root);
    const report = await found.scan();
    assert.equal(found.installed, false);
    assert.equal(found.has('zh'), false);
    assert.equal(found.entry('zh', 'panam-palmer'), null, 'the good voices of a broken pack are not half-used either');
    assert.equal(report.packs.length, 0);
    assert.equal(report.problems.length, 1);
    assert.equal(report.problems[0].language, 'zh-cn');
    assert.match(report.problems[0].reason, /1 of 5 voices unusable \(resident-female: file missing\)/);
    // One notice, however many times the folder is looked at.
    await found.scan(); await found.scan();
    assert.equal(lines.filter(line => line.includes('not used')).length, 1);
    assert.match(lines[0], /multilingual pack zh-cn is not used/);
  });
});

test('a broken pack does not stop a good one beside it', async () => {
  await folder(async root => {
    await writePack(root, {language: 'ja', languageTag: 'ja', voices: {'panam-palmer': {...FAKE_VOICES['panam-palmer'], omit: true}}});
    await writePack(root, {language: 'fr', languageTag: 'fr'});
    const {packs: found} = packs(root);
    const report = await found.scan();
    assert.deepEqual(report.packs.map(pack => pack.language), ['fr']);
    assert.deepEqual(report.problems.map(row => row.language), ['ja']);
    assert.equal(found.entry('fr', 'v-male') !== null, true);
    assert.equal(found.entry('ja', 'v-male'), null);
  });
});

test('every way a pack can be broken is named, and none is used', async () => {
  const cases = [
    ['not a 24 kHz clip', {voices: {...FAKE_VOICES, 'v-male': {...FAKE_VOICES['v-male'], wav: sineWav({rate: 16000})}}}, /v-male: 16000 Hz, not 24000/],
    ['stereo', {voices: {...FAKE_VOICES, 'v-male': {...FAKE_VOICES['v-male'], wav: sineWav({channels: 2})}}}, /2 channels, not mono/],
    ['24-bit', {voices: {...FAKE_VOICES, 'v-male': {...FAKE_VOICES['v-male'], wav: sineWav({bits: 24})}}}, /24-bit, not 16/],
    ['over 20 s', {voices: {...FAKE_VOICES, 'v-male': {...FAKE_VOICES['v-male'], wav: sineWav({seconds: 20.5, rate: 24000})}}}, /20\.5 s, over the 20 s limit/],
    ['not a WAV', {voices: {...FAKE_VOICES, 'v-male': {...FAKE_VOICES['v-male'], wav: Buffer.from('this is not a wav file at all, only text'.repeat(3))}}}, /not a WAV file/],
    ['no text', {manifest: manifest => { manifest.voices['v-male'].text = '  '; return manifest; }}, /v-male: no text/],
    ['a path that climbs out', {manifest: manifest => { manifest.voices['v-male'].file = 'picked/../../x.wav'; return manifest; }}, /v-male: invalid file name/],
    ['a clip in a folder the pack does not use', {manifest: manifest => { manifest.voices['v-male'].file = 'other/v-male.wav'; return manifest; }}, /invalid file name/],
    ['a bad hash', {manifest: manifest => { manifest.voices['v-male'].sha256 = 'xyz'; return manifest; }}, /invalid sha256/],
    ['a bad voice key', {manifest: manifest => { manifest.voices['Bad Key'] = manifest.voices['v-male']; return manifest; }}, /Bad Key: not a voice key/],
    ['another version', {version: 2}, /not version 1/],
    ['the wrong language tag', {manifest: manifest => { manifest.languageTag = 'ja'; return manifest; }}, /languageTag "ja", expected zh/],
    ['the wrong folder', {manifest: manifest => { manifest.language = 'ja'; return manifest; }}, /says language "ja", the folder is zh-cn/],
    ['no voices', {manifest: manifest => { manifest.voices = {}; return manifest; }}, /lists 0 voices/],
    ['not JSON', {manifest: () => '{"version": 1,'}, /manifest\.json is unreadable/],
  ];
  for (const [name, options, reason] of cases) {
    await folder(async root => {
      await writePack(root, options);
      const {packs: found} = packs(root);
      const report = await found.scan();
      assert.equal(found.installed, false, name);
      assert.equal(report.problems.length, 1, name);
      assert.match(report.problems[0].reason, reason, name);
    });
  }
});

test('a folder without a manifest is a problem, a folder that is not a game language is not looked at', async () => {
  await folder(async root => {
    await mkdir(resolve(root, 'multilingual', 'zh-cn'), {recursive: true});
    await mkdir(resolve(root, 'multilingual', 'klingon'), {recursive: true});
    const {packs: found} = packs(root);
    const report = await found.scan();
    assert.deepEqual(report.problems, [{language: 'zh-cn', reason: 'manifest.json is missing'}]);
  });
});

test('no multilingual folder is no pack and no problem, and costs nothing', async () => {
  await folder(async root => {
    const {packs: found, lines} = packs(root);
    const report = await found.scan();
    assert.deepEqual(report, {scannedAt: report.scannedAt, packs: [], problems: []});
    assert.equal(found.installed, false);
    assert.deepEqual(lines, []);
  });
});

test('the first reference folder that has a language wins; the others are not mixed in', async () => {
  await folder(async root => {
    const second = resolve(root, 'second');
    await writePack(root, {voices: {'panam-palmer': FAKE_VOICES['panam-palmer']}});
    await writePack(second, {voices: {'panam-palmer': FAKE_VOICES['panam-palmer'], 'v-male': FAKE_VOICES['v-male']}});
    const found = new VoiceLanguagePacks({roots: [root, second]});
    await found.scan();
    assert.equal(found.pack('zh').entries.size, 1);
    assert.equal(found.entry('zh', 'v-male'), null);
  });
});

test('the live re-scan notices a pack installed, changed or removed while the game runs, and only looks hard when something changed', async () => {
  await folder(async root => {
    let time = 1_000_000, heads = 0, changes = 0;
    const files = {...defaultFiles, head: async (path, length) => { heads++; return defaultFiles.head(path, length); }};
    const {packs: found} = packs(root, {files, now: () => time, rescanMs: 30_000, onChange: () => { changes++; }});
    await found.scan();
    assert.equal(found.installed, false);
    // Too early: nothing is looked at.
    await writePack(root);
    time += 5_000;
    assert.equal(await found.refresh(), false); assert.equal(found.installed, false);
    // Due: a pack appeared.
    time += 30_000;
    assert.equal(await found.refresh(), true);
    assert.equal(found.installed, true); assert.equal(changes, 1);
    const headsAfterInstall = heads;
    assert.ok(headsAfterInstall >= 5);
    // Due again, nothing changed: the headers are not read again.
    time += 31_000;
    assert.equal(await found.refresh(), false);
    assert.equal(heads, headsAfterInstall);
    // A manifest that was edited is checked again; here it breaks the pack.
    time += 31_000;
    await writePack(root, {voices: {...FAKE_VOICES, 'v-male': {...FAKE_VOICES['v-male'], omit: true}}, manifest: value => ({...value, built: '2026-10-22'})});
    await unlink(resolve(root, 'multilingual', 'zh-cn', 'v-voice', 'v-male.wav')).catch(() => {});
    assert.equal(await found.refresh(), true);
    assert.equal(found.installed, false); assert.equal(changes, 2);
    assert.equal(found.report().problems.length, 1);
  });
});

test('the support report lists the packs (language, voices, version) and why one is not used, and nothing else', async () => {
  await folder(async root => {
    await writePack(root, {language: 'fr', languageTag: 'fr'});
    await writePack(root, {language: 'de', languageTag: 'de', voices: {'v-male': {...FAKE_VOICES['v-male'], omit: true}}});
    const {packs: found} = packs(root); await found.scan();
    const section = voiceLanguagePacksSection(found.report());
    assert.deepEqual(section.installed, [{language: 'fr', voices: 5, version: '2026-10-21'}]);
    assert.deepEqual(section.problems.map(row => row.language), ['de']);
    assert.match(section.problems[0].reason, /v-male: file missing/);
    assert.equal(typeof section.scanned, 'string');
    assert.equal(voiceLanguagePacksSection(undefined), null, 'a report made without the service does not know');
    assert.equal(JSON.stringify(section).includes(root), false);
  });
});

test('the game\'s ten voiced languages and the codes the reply-language detector reports', () => {
  assert.deepEqual(Object.keys(LANGUAGE_PACKS).sort(), ['de', 'es-es', 'fr', 'it', 'ja', 'ko', 'pl', 'pt-br', 'ru', 'zh-cn']);
  assert.equal(packOfTag('zh'), 'zh-cn'); assert.equal(packOfTag('es'), 'es-es'); assert.equal(packOfTag('pt'), 'pt-br'); assert.equal(packOfTag('en'), null);
});

test('checkWavHeader reads only the header: a streamed header and a long chunk before the data are handled', () => {
  const body = sineWav({seconds: 1});
  assert.deepEqual(checkWavHeader(body.subarray(0, 64), body.length), {seconds: 1});
  const streamed = Buffer.from(body); streamed.writeUInt32LE(0xFFFFFFFF, 40);
  assert.deepEqual(checkWavHeader(streamed.subarray(0, 64), streamed.length), {seconds: 1});
  // A LIST chunk between fmt and data.
  const list = Buffer.concat([body.subarray(0, 36), Buffer.from('LIST'), Buffer.from([4, 0, 0, 0]), Buffer.from('INFO'), body.subarray(36)]);
  assert.deepEqual(checkWavHeader(list.subarray(0, 80), list.length), {seconds: 1});
  assert.throws(() => checkWavHeader(Buffer.alloc(10), 10), /not a WAV/);
});

test('loadPack reports a language the game is not voiced in', async () => {
  assert.deepEqual(await loadPack({directory: '/nowhere', language: 'xx'}), {problem: 'not a language the game is voiced in'});
});
