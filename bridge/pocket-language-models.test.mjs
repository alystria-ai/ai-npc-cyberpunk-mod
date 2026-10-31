import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, rm, writeFile, utimes} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {PocketLanguageModels, PocketLanguageNotice, POCKET_LANGUAGES, POCKET_MODEL_FILES, POCKET_TOKENIZERS, NIGHT_CITY_RESPELLING, loadPocketModel, pocketSpokenText, pocketFolderOfTag, pocketModelFiles, pocketTokenizerOf} from './pocket-language-models.mjs';
import {planTurnVoice, replyVoice} from './multilingual.mjs';

const sha = character => character.repeat(64);
async function fixture(run) {
  const root = await mkdtemp(resolve(tmpdir(), 'pocket-language-'));
  try { await run(root); } finally { await rm(root, {recursive: true, force: true}); }
}
// A model folder with small stand-in files whose sizes the manifest declares.
async function model(root, language, {tag = POCKET_LANGUAGES[language].tag, mutate} = {}) {
  const directory = resolve(root, 'multilingual-pocket', language);
  await mkdir(directory, {recursive: true});
  const bytes = {'model.safetensors': 64, 'tokenizer.json': 8, 'inference.yaml': 12, 'NOTICE.txt': 5};
  for (const [name, size] of Object.entries(bytes)) await writeFile(resolve(directory, name), Buffer.alloc(size, 1));
  const manifest = {version: 1, kind: 'pocket-language-model', language, languageTag: tag, pocketLanguage: POCKET_LANGUAGES[language].pocket, built: '2026-10-22',
    pocketSource: '3.3.0', layers: 6, files: Object.fromEntries(Object.entries(bytes).map(([name, size]) => [name, {bytes: size, sha256: sha(name[0] === 'm' ? 'a' : name[0] === 't' ? 'b' : name[0] === 'i' ? 'c' : 'd')}]))};
  mutate?.(manifest);
  await writeFile(resolve(directory, 'pocket-model.json'), JSON.stringify(manifest));
  return directory;
}
// A voice pack stand-in: what the Pocket module asks of VoiceLanguagePacks (pack(tag) with a directory and entries).
const packs = (root, languages) => ({pack: tag => languages.includes(tag) ? {tag, directory: resolve(root, 'multilingual', Object.keys(POCKET_LANGUAGES).find(folder => POCKET_LANGUAGES[folder].tag === tag)),
  entries: new Map([['panam-palmer', {key: 'panam-palmer'}]])} : null});

test('a valid model is found next to the voice pack folder and described with the hashes the worker checks', async () => fixture(async root => {
  await model(root, 'fr');
  const found = new PocketLanguageModels({roots: [root], packs: packs(root, ['fr'])});
  const report = await found.scan();
  assert.equal(found.installed, true);
  assert.deepEqual(found.model('fr').expected, {sha256: sha('a'), tokenizerSha256: sha('b'), configSha256: sha('c')});
  assert.equal(found.model('fr').language, 'fr');
  assert.equal(found.model('it'), null);
  assert.deepEqual(report.problems, []);
  assert.equal(report.models[0].usable, true);
  assert.equal(report.models[0].packInstalled, true);
}));

test('speaks() needs both the model and the voice pack of the language, in the folder the worker reads; the model alone is packMissing', async () => fixture(async root => {
  await model(root, 'fr'); await model(root, 'de'); await model(root, 'es-es');
  const found = new PocketLanguageModels({roots: [root], packs: packs(root, ['fr', 'es'])});
  await found.scan();
  assert.equal(found.speaks('fr'), true);
  assert.equal(found.speaks('es'), true, 'the pack folder es-es is the reply language es');
  assert.equal(found.speaks('de'), false);
  assert.equal(found.packMissing('de'), true, 'the German model is installed, the German pack is not');
  assert.equal(found.packMissing('fr'), false);
  assert.equal(found.packMissing('it'), false, 'no model: nothing to say about a pack');
  assert.equal(found.speaks('en'), false);
  assert.equal(found.entry('fr', 'panam-palmer').key, 'panam-palmer');
  assert.equal(found.entry('fr', 'nobody'), null);
  assert.equal(found.entry('de', 'panam-palmer'), null);
  // A pack found in another root is not one the Pocket worker can read its clips from.
  const other = new PocketLanguageModels({roots: [root], packs: {pack: tag => ({tag, directory: resolve(root, '..', 'elsewhere', 'multilingual', 'fr'), entries: new Map()})}});
  await other.scan();
  assert.equal(other.speaks('fr'), false);
  assert.equal(other.packMissing('fr'), true);
}));

test('a model is all or nothing: a missing file, a wrong size, a wrong language, tag, source, layer count or manifest is ignored with one reason', async () => fixture(async root => {
  await model(root, 'fr', {mutate: manifest => { manifest.files['model.safetensors'].bytes = 65; }});
  await model(root, 'it', {tag: 'xx'});
  await model(root, 'de', {mutate: manifest => { manifest.pocketSource = '4.0.0'; }});
  await model(root, 'es-es', {mutate: manifest => { manifest.layers = 24; }});
  await model(root, 'pt-br', {mutate: manifest => { delete manifest.files['tokenizer.json']; }});
  const lines = [];
  const found = new PocketLanguageModels({roots: [root], packs: packs(root, ['fr', 'it', 'de', 'es', 'pt']), log: line => lines.push(line)});
  const report = await found.scan();
  assert.equal(found.installed, false);
  assert.equal(report.problems.length, 5);
  const why = Object.fromEntries(report.problems.map(row => [row.language, row.reason]));
  assert.match(why.fr, /model\.safetensors: 65 bytes, expected 64|1 of 4 files unusable/);
  assert.match(why.it, /languageTag/);
  assert.match(why.de, /Pocket source/);
  assert.match(why['es-es'], /layers/);
  assert.match(why['pt-br'], /does not describe tokenizer\.json/);
  assert.equal(lines.length, 5, 'one line per model');
  await found.scan();
  assert.equal(lines.length, 5, 'and only one per reason');
  // a deleted file
  await fixture(async other => {
    const directory = await model(other, 'fr');
    await rm(resolve(directory, 'inference.yaml'));
    assert.match((await loadPocketModel({directory, language: 'fr'})).problem, /inference\.yaml: file missing/);
    assert.match((await loadPocketModel({directory: resolve(other, 'nothing'), language: 'fr'})).problem, /pocket-model\.json is missing/);
    assert.match((await loadPocketModel({directory, language: 'ja'})).problem, /not a language/);
  });
}));

test('a manifest that is too large, not JSON or not an object is refused, and nothing outside the five languages is looked at', async () => fixture(async root => {
  const directory = await model(root, 'fr');
  await writeFile(resolve(directory, 'pocket-model.json'), '{not json');
  assert.match((await loadPocketModel({directory, language: 'fr'})).problem, /unreadable/);
  await writeFile(resolve(directory, 'pocket-model.json'), 'x'.repeat(70 * 1024));
  assert.match((await loadPocketModel({directory, language: 'fr'})).problem, /too large/);
  await writeFile(resolve(directory, 'pocket-model.json'), '[]');
  assert.match((await loadPocketModel({directory, language: 'fr'})).problem, /not a version 1/);
  await mkdir(resolve(root, 'multilingual-pocket', 'zh-cn'), {recursive: true});
  const found = new PocketLanguageModels({roots: [root]});
  assert.deepEqual((await found.look()).map(row => row.language), ['fr'], 'zh-cn has no Pocket model and is not listed');
}));

test('refresh looks again only when a manifest or a folder changed, and says so when the set changed', async () => fixture(async root => {
  let now = 1_000_000;
  const changes = [];
  const found = new PocketLanguageModels({roots: [root], packs: packs(root, ['fr', 'it']), now: () => now, rescanMs: 30_000, onChange: report => changes.push(report.models.length)});
  await found.scan();
  assert.equal(found.installed, false);
  await model(root, 'fr');
  assert.equal(await found.refresh(), false, 'inside the 30 s window nothing is looked at');
  now += 31_000;
  assert.equal(await found.refresh(), true);
  assert.equal(found.speaks('fr'), true);
  now += 31_000;
  assert.equal(await found.refresh(), false, 'nothing changed');
  await model(root, 'it');
  now += 31_000;
  assert.equal(await found.refresh(), true);
  assert.deepEqual(changes, [1, 2]);
  await rm(resolve(root, 'multilingual-pocket', 'fr'), {recursive: true});
  now += 31_000;
  assert.equal(await found.refresh(), true);
  assert.equal(found.has('fr'), false);
}));

test('a model the worker refused is not used again until its files change', async () => fixture(async root => {
  const directory = await model(root, 'fr');
  const lines = [];
  const found = new PocketLanguageModels({roots: [root], packs: packs(root, ['fr']), log: line => lines.push(line)});
  await found.scan();
  assert.equal(found.speaks('fr'), true);
  found.markFailed('fr', 'a file differs from its hash\nsecond line');
  found.markFailed('fr', 'again');
  assert.equal(found.speaks('fr'), false);
  assert.equal(found.model('fr'), null);
  assert.equal(found.report().models[0].usable, false);
  assert.match(found.report().models[0].refused, /a file differs from its hash second line/);
  assert.equal(lines.filter(line => /not used/.test(line)).length, 1);
  await found.scan();
  assert.equal(found.speaks('fr'), false, 'the same files: still refused');
  await model(root, 'fr', {mutate: manifest => { manifest.built = '2026-10-23'; }});
  await found.scan();
  assert.equal(found.speaks('fr'), true, 'new files: tried again');
  assert.ok(directory);
}));

test('the report names no path', async () => fixture(async root => {
  await model(root, 'fr');
  const found = new PocketLanguageModels({roots: [root], packs: packs(root, ['fr'])});
  await found.scan();
  const text = JSON.stringify(found.report());
  assert.equal(text.includes(root), false);
  assert.equal(/model\.safetensors|multilingual-pocket/.test(text), false);
}));

test('the missing-pack notice is said once per language per game session, in the order the replies came', () => {
  const notice = new PocketLanguageNotice();
  assert.equal(notice.take(), undefined);
  notice.note('fr'); notice.note('fr'); notice.note('it'); notice.note(undefined);
  assert.deepEqual(notice.take(), {keyNotice: 'pocket-language-pack', keyNoticeLanguage: 'fr'});
  assert.deepEqual(notice.take(), {keyNotice: 'pocket-language-pack', keyNoticeLanguage: 'it'});
  assert.equal(notice.take(), undefined);
  notice.note('fr'); notice.note('it');
  assert.equal(notice.take(), undefined, 'both were said already');
  notice.note('de');
  assert.equal(notice.take().keyNoticeLanguage, 'de');
});

test('"Night City" is respelled for Italian, Spanish and Portuguese only, and only in the text Pocket is given', () => {
  assert.deepEqual(NIGHT_CITY_RESPELLING, {it: 'Nait Siti', es: 'Nait Siti', pt: 'Náit Síti'});
  const line = 'Night City è tranquilla stasera. NIGHT CITY, night-city e night   city.';
  assert.equal(pocketSpokenText('it', line), 'Nait Siti è tranquilla stasera. Nait Siti, Nait Siti e Nait Siti.');
  assert.equal(pocketSpokenText('es', 'Night City'), 'Nait Siti');
  assert.equal(pocketSpokenText('pt', 'Bem-vindo a Night City'), 'Bem-vindo a Náit Síti');
  assert.equal(pocketSpokenText('fr', 'Night City'), 'Night City');
  assert.equal(pocketSpokenText('de', 'Night City'), 'Night City');
  assert.equal(pocketSpokenText('it', 'Citynight Nightcity'), 'Citynight Nightcity', 'whole words only');
  assert.equal(pocketSpokenText('it', undefined), undefined);
  assert.equal(pocketFolderOfTag('es'), 'es-es');
  assert.equal(pocketFolderOfTag('pt'), 'pt-br');
  assert.equal(pocketFolderOfTag('ja'), null);
});

test('the turn plan: Pocket speaks a language when its model and pack are installed, shows text otherwise, and names the missing pack', () => {
  const local = (speaks, packMissing = () => false, extra = {}) => ({uses: true, provider: 'pocket', convai: false, cloud: null, speaks: () => false, pocket: {speaks, packMissing}, ...extra});
  for (const textProvider of [true, false]) {
    const base = textProvider ? {textProvider: true} : {enabled: true};
    assert.equal(planTurnVoice({...base, language: 'fr', local: local(language => language === 'fr')}).engine, 'pocket');
    assert.equal(planTurnVoice({...base, language: 'fr', local: local(language => language === 'fr')}).reason, 'pocket-language');
    const none = planTurnVoice({...base, language: 'de', local: local(language => language === 'fr')});
    assert.equal(none.engine, textProvider ? 'pocket' : 'none', 'a text provider turn is decided by the finished reply');
    assert.equal(none.reason, 'english-only-voice');
    assert.equal(planTurnVoice({...base, language: 'de', local: local(() => false, language => language === 'de')}).reason, 'pocket-language-pack-missing');
    assert.equal(planTurnVoice({...base, language: 'en', local: local(() => false)}).engine, 'pocket', 'English is untouched');
    // the Voxtral voice and OmniVoice keep their own rules
    assert.equal(planTurnVoice({...base, language: 'fr', local: local(() => true, () => false, {provider: 'omni'})}).engine, 'omni');
    assert.equal(planTurnVoice({...base, language: 'fr', local: local(() => true, () => false, {cloud: 'voxtral', speaks: () => false})}).reason, 'voice-language-unsupported');
  }
  // The finished reply decides: a reply in a language with a model keeps Pocket, another one is text with the right reason.
  const fr = local(language => language === 'fr');
  const plan = planTurnVoice({textProvider: true, language: 'fr', local: fr});
  assert.deepEqual(replyVoice({plan, text: 'Salut, ça fait longtemps. Où veux-tu aller en premier avec moi ce soir ?', local: fr}), {engine: 'pocket', language: 'fr'});
  const missing = local(() => false, language => language === 'fr');
  const textPlan = planTurnVoice({textProvider: true, language: 'fr', local: missing});
  assert.deepEqual(replyVoice({plan: textPlan, text: 'Salut, ça fait longtemps. Où veux-tu aller en premier avec moi ce soir ?', local: missing}),
    {engine: 'none', language: 'fr', reason: 'pocket-language-pack-missing'});
  const enabledPlan = planTurnVoice({enabled: true, language: 'fr', local: missing});
  assert.equal(replyVoice({plan: enabledPlan, text: 'Salut, ça fait longtemps. Où veux-tu aller en premier avec moi ce soir ?', local: missing}).reason, 'pocket-language-pack-missing');
  // An older caller that passes no `pocket` fact gets today's behaviour.
  assert.equal(planTurnVoice({textProvider: true, language: 'fr', local: {uses: true, provider: 'pocket', convai: false, cloud: null, speaks: () => false}}).reason, 'english-only-voice');
});

test('the files are touched only through the injected access, and the stamp changes with the manifest', async () => fixture(async root => {
  const directory = await model(root, 'fr');
  const found = new PocketLanguageModels({roots: [root]});
  const before = await found.look();
  await utimes(resolve(directory, 'pocket-model.json'), new Date(Date.now() + 5000), new Date(Date.now() + 5000));
  const after = await found.look();
  assert.notEqual(before[0].stamp, after[0].stamp);
}));

// ---- Russian: tokenizer.model (SentencePiece) instead of tokenizer.json, and the stress table as one more file -----------------------------------------

// A Russian model folder with small stand-in files, listed the way packaging/build-pocket-models.mjs lists them.
async function russianModel(root, {mutate, skip = []} = {}) {
  const directory = resolve(root, 'multilingual-pocket', 'ru');
  await mkdir(directory, {recursive: true});
  const bytes = {'model.safetensors': 64, 'tokenizer.model': 9, 'inference.yaml': 12, 'NOTICE.txt': 5, 'stress-ru.bin': 21};
  const hashes = {'model.safetensors': sha('a'), 'tokenizer.model': sha('b'), 'inference.yaml': sha('c'), 'NOTICE.txt': sha('d'), 'stress-ru.bin': sha('e')};
  for (const [name, size] of Object.entries(bytes)) if (!skip.includes(name)) await writeFile(resolve(directory, name), Buffer.alloc(size, 1));
  const manifest = {version: 1, kind: 'pocket-language-model', language: 'ru', languageTag: 'ru', pocketLanguage: 'russian', built: '2026-10-31', pocketSource: '3.3.0', layers: 6,
    files: Object.fromEntries(Object.entries(bytes).map(([name, size]) => [name, {bytes: size, sha256: hashes[name]}]))};
  mutate?.(manifest);
  await writeFile(resolve(directory, 'pocket-model.json'), JSON.stringify(manifest));
  return directory;
}

test('ru is in the list of Pocket languages with its pack folder, tag, name and the files of its model', () => {
  assert.deepEqual(Object.keys(POCKET_LANGUAGES), ['fr', 'it', 'de', 'es-es', 'pt-br', 'ru']);
  assert.equal(POCKET_LANGUAGES.ru.tag, 'ru');
  assert.equal(POCKET_LANGUAGES.ru.name, 'Russian');
  assert.equal(pocketFolderOfTag('ru'), 'ru');
  assert.equal(pocketTokenizerOf('ru'), 'tokenizer.model');
  assert.equal(pocketTokenizerOf('fr'), 'tokenizer.json');
  assert.deepEqual(POCKET_TOKENIZERS, ['tokenizer.json', 'tokenizer.model']);
  assert.deepEqual(pocketModelFiles('ru'), ['model.safetensors', 'tokenizer.model', 'inference.yaml', 'NOTICE.txt', 'stress-ru.bin']);
  assert.deepEqual(pocketModelFiles('fr'), [...POCKET_MODEL_FILES]);
  assert.deepEqual(POCKET_MODEL_FILES, ['model.safetensors', 'tokenizer.json', 'inference.yaml', 'NOTICE.txt'], 'the default list is unchanged');
  assert.equal(Object.hasOwn(NIGHT_CITY_RESPELLING, 'ru'), false);
  assert.equal(pocketSpokenText('ru', 'Night City'), 'Night City', 'the Russian text is not respelled by the bridge (the worker marks the stress)');
});

test('a Russian model is described with the tokenizer name and the hash of every file the worker checks', async () => fixture(async root => {
  await russianModel(root);
  const found = new PocketLanguageModels({roots: [root], packs: packs(root, ['ru'])});
  const report = await found.scan();
  assert.deepEqual(report.problems, []);
  assert.deepEqual(found.model('ru').expected, {sha256: sha('a'), tokenizerName: 'tokenizer.model', tokenizerSha256: sha('b'), configSha256: sha('c'), stressSha256: sha('e')});
  assert.deepEqual(Object.keys(found.model('ru').files), ['model.safetensors', 'tokenizer.model', 'inference.yaml', 'NOTICE.txt', 'stress-ru.bin']);
  assert.equal(found.speaks('ru'), true);
  assert.equal(found.packMissing('ru'), false);
  assert.equal(found.entry('ru', 'panam-palmer').key, 'panam-palmer');
  assert.equal(report.models[0].tag, 'ru');
  assert.equal(report.models[0].usable, true);
  // A French model beside it keeps its own description.
  await model(root, 'fr');
  await found.scan();
  assert.deepEqual(found.model('fr').expected, {sha256: sha('a'), tokenizerSha256: sha('b'), configSha256: sha('c')});
}));

test('a Russian model whose manifest or folder lacks the tokenizer.model or the stress table is not used, and the model without its pack is packMissing', async () => fixture(async root => {
  for (const [label, options, reason] of [
    ['a tokenizer.json in the manifest instead of tokenizer.model', {mutate: manifest => { manifest.files['tokenizer.json'] = manifest.files['tokenizer.model']; delete manifest.files['tokenizer.model']; }}, /does not describe tokenizer\.model/],
    ['no stress table in the manifest', {mutate: manifest => { delete manifest.files['stress-ru.bin']; }}, /does not describe stress-ru\.bin/],
    ['no stress table in the folder', {skip: ['stress-ru.bin']}, /1 of 5 files unusable \(stress-ru\.bin: file missing/],
    ['no tokenizer.model in the folder', {skip: ['tokenizer.model']}, /1 of 5 files unusable \(tokenizer\.model: file missing/],
    ['a stress table of another size', {mutate: manifest => { manifest.files['stress-ru.bin'].bytes = 22; }}, /stress-ru\.bin: 21 bytes, expected 22/],
    ['a table that is too large', {mutate: manifest => { manifest.files['stress-ru.bin'].bytes = 17 * 1024 * 1024; }}, /does not describe stress-ru\.bin/],
  ]) {
    await rm(resolve(root, 'multilingual-pocket'), {recursive: true, force: true});
    const directory = await russianModel(root, options);
    const result = await loadPocketModel({directory, language: 'ru'});
    assert.match(result.problem ?? '', reason, label);
  }
  await rm(resolve(root, 'multilingual-pocket'), {recursive: true, force: true});
  await russianModel(root);
  const found = new PocketLanguageModels({roots: [root], packs: packs(root, [])});
  await found.scan();
  assert.equal(found.speaks('ru'), false);
  assert.equal(found.packMissing('ru'), true, 'the notice for a missing pack is the one of this language');
  const notice = new PocketLanguageNotice();
  notice.note('ru');
  assert.deepEqual(notice.take(), {keyNotice: 'pocket-language-pack', keyNoticeLanguage: 'ru'});
}));
