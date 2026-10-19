import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, readdir, rm, writeFile, mkdir} from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {CustomCharacters, CUSTOM_LIMITS, CUSTOM_KEY, CLONE_PREFIXES, isCustomKey, normalizeName, readRow, recordVariants, releaseVoiceFiles, rosterIndex, validateCustom} from './custom-characters.mjs';
import {PersonaBook, systemHead, buildMessages} from './mistral-prompt.mjs';
import {profileFor} from './protocol.mjs';

const named = JSON.parse(await readFile(new URL('../characters/roster.json', import.meta.url), 'utf8'));
const archetypes = JSON.parse(await readFile(new URL('../characters/archetype-roster.json', import.meta.url), 'utf8'));
const rows = [...named, ...archetypes];
const roster = rosterIndex(rows);

const BIO = 'I am Rebecca, a small, loud, trigger-happy runner who grew up in Pacifica and still thinks every plan needs more explosions. I trust few people.';
const valid = (extra = {}) => ({name: 'Rebecca', gender: 'female', records: ['NCA.Character.Rebecca'], names: ['Rebecca'], bio: BIO,
  style: 'Fast, loud, a little rude.', examples: ['Boom. That is how I solve it.'], memories: ['V once lent me a gun.'], ...extra});

// ---- keys

test('a custom key is a reserved prefix and passes every key check of the bridge and the voice workers', async () => {
  assert.equal(named.concat(archetypes).some(row => row.key.startsWith('custom-')), false, 'no roster key starts with the reserved prefix');
  for (const key of ['custom-rebecca-k3j9', 'custom-npc-abcd', 'custom-a-b-c-d-e-f']) {
    assert(isCustomKey(key), key);
    assert(/^[a-z0-9][a-z0-9-]{0,79}$/.test(key) && /^[a-z0-9-]+$/.test(key), 'the shape every other module of the bridge asks for: ' + key);
  }
  for (const key of ['custom:rebecca', 'Custom-rebecca', 'custom-', 'custom-Rebecca', 'judy-alvarez', 'custom-a/b', '../custom-x', 'custom-x.json', 'npc-custom-x']) assert.equal(isCustomKey(key), false, key);
  const store = await CustomCharacters.open({dir: null, roster});
  const made = await store.create(valid({name: 'Rebecca “Becca” Ñoño'}));
  assert(CUSTOM_KEY.test(made.key) && made.key.startsWith('custom-rebecca-becca-nono-'), made.key);
  assert.equal((await store.create(valid({name: '日本語', records: ['NCA.Character.Other'], names: ['Other']}))).key.startsWith('custom-npc-'), true, 'a name with no letters of the keyboard still makes a key');
  assert(Object.isFrozen(made));
});

test('the clone prefixes are the Lua catalogue\'s, and a Character record also answers under them', () => {
  const lua = readFileSync(new URL('../mod/character-catalog.lua', import.meta.url), 'utf8');
  const listed = /M\.CLONE_PREFIXES = \{([^}]*)\}/.exec(lua)[1].split(',').map(item => item.trim().replace(/^'|'$/g, '')).filter(Boolean);
  assert.deepEqual([...CLONE_PREFIXES], listed);
  assert.deepEqual(recordVariants('Character.Rebecca'), ['Character.Rebecca', 'NCA.Character.Rebecca']);
  assert.deepEqual(recordVariants('NCA.Character.Rebecca'), ['NCA.Character.Rebecca']);
  assert.deepEqual(recordVariants('NCA.123456'), ['NCA.123456']);
});

// ---- validation

test('a complete character is accepted and tidied', () => {
  const result = validateCustom(valid({name: '  Rebecca  ', records: [' NCA.Character.Rebecca ', 'nca.character.rebecca', 'NCA.Character.Rebecca'], names: ['Rebecca', ' rebecca ', 'Becca'],
    examples: ['Boom.', '', 'boom.'], bio: BIO + '  \r\n\r\n\r\nMore.'}), {roster});
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(result.value.name, 'Rebecca');
  assert.deepEqual(result.value.records, ['NCA.Character.Rebecca'], 'spaces go and so do repeats, whatever their case');
  assert.deepEqual(result.value.names, ['Rebecca', 'Becca']);
  assert.deepEqual(result.value.examples, ['Boom.']);
  assert.match(result.value.bio, /\n\nMore\.$/);
});

test('each problem has its own stable code and the limit it is about', () => {
  const codes = (input, context = {roster}) => { const result = validateCustom(input, context); assert.equal(result.ok, false, JSON.stringify(input)); return result.errors.map(error => error.code); };
  assert.deepEqual(codes(valid({name: '  '})), ['name-empty']);
  assert.deepEqual(codes(valid({name: 'x'.repeat(61)})), ['name-long']);
  assert.deepEqual(codes(valid({gender: 'robot'})), ['gender-bad']);
  assert.deepEqual(codes(valid({gender: undefined})), ['gender-bad']);
  assert.deepEqual(codes(valid({records: [], names: []})), ['match-empty']);
  assert.deepEqual(codes(valid({records: ['has space inside!'], names: ['Rebecca']})), ['record-bad']);
  assert.deepEqual(codes(valid({records: ['ab']})), ['record-bad']);
  assert.deepEqual(codes(valid({records: Array.from({length: 7}, (_, i) => 'NCA.Character.R' + i)})), ['records-many']);
  assert.deepEqual(codes(valid({names: Array.from({length: 7}, (_, i) => 'Name ' + i)})), ['names-many']);
  assert.deepEqual(codes(valid({names: ['n'.repeat(61)]})), ['names-long']);
  assert.deepEqual(codes(valid({bio: 'too short'})), ['bio-short']);
  assert.deepEqual(codes(valid({bio: 'b'.repeat(9001)})), ['bio-long']);
  assert.deepEqual(codes(valid({style: 's'.repeat(1801)})), ['style-long']);
  assert.deepEqual(codes(valid({examples: Array.from({length: 21}, (_, i) => 'line ' + i)})), ['examples-many']);
  assert.deepEqual(codes(valid({examples: ['e'.repeat(241)]})), ['examples-long']);
  assert.deepEqual(codes(valid({examples: Array.from({length: 13}, (_, i) => `${i} ` + 'e'.repeat(236))})), ['examples-total']);
  assert.deepEqual(codes(valid({memories: Array.from({length: 13}, (_, i) => 'memory ' + i)})), ['memories-many']);
  assert.deepEqual(codes(valid({memories: ['m'.repeat(201)]})), ['memories-long']);
  const full = valid({bio: 'b'.repeat(9000), style: 's'.repeat(1800), examples: Array.from({length: 12}, (_, i) => `${i} ` + 'e'.repeat(230)),
    memories: Array.from({length: 12}, (_, i) => `${i} ` + 'm'.repeat(190))});
  assert.deepEqual(codes(full), ['too-big'], 'every part is inside its own limit, together they are not');
  assert.deepEqual(codes(null), ['bad-request']);
  assert.deepEqual(codes([]), ['bad-request']);
});

test('nobody else may answer to the same record or name, and a roster profile always keeps its own', () => {
  const other = readRow({key: 'custom-becca-aaaa', name: 'Becca', gender: 'female', records: ['Character.Becca'], names: ['Becca Jones'], bio: BIO});
  const errors = input => validateCustom(input, {roster, others: [other]}).errors?.map(error => `${error.field}:${error.code}:${error.other ?? ''}`) ?? [];
  assert.deepEqual(errors(valid({records: ['Character.Becca'], names: []})), ['records:match-taken:Becca']);
  assert.deepEqual(errors(valid({records: ['NCA.Character.Becca'], names: []})), ['records:match-taken:Becca'], 'her clone is hers too');
  assert.deepEqual(errors(valid({records: [], names: [' BECCA   jones '], })), ['names:match-taken:Becca']);
  assert.deepEqual(errors(valid({records: ['Character.Judy'], names: []})), ['records:match-roster:Judy Alvarez']);
  assert.deepEqual(errors(valid({records: ['NCA.Character.Judy'], names: []})), ['records:match-roster:Judy Alvarez']);
  assert.deepEqual(errors(valid({records: [], names: ['judy alvarez']})), ['names:match-roster:Judy Alvarez']);
  assert.deepEqual(errors(valid({records: [], names: ['Judy Álvarez']})), ['names:match-roster:Judy Alvarez'], 'an alias of the roster');
  assert.deepEqual(errors(valid()), []);
  assert.equal(normalizeName('  Judy   ÁLVAREZ '), 'judy Álvarez', 'the game side lowers ASCII letters only');
});

// ---- the store

const slash = path => path.replaceAll('\\', '/');
const memoryIo = (initial = {}) => {
  const files = new Map(Object.entries(initial)), log = {writes: [], removes: [], moves: []};
  return {files, log, io: {
    read: async path => { if (!files.has(slash(path))) throw Object.assign(Error('ENOENT'), {code: 'ENOENT'}); return files.get(slash(path)); },
    readBytes: async path => { if (!files.has(slash(path))) throw Object.assign(Error('ENOENT'), {code: 'ENOENT'}); return Buffer.from(files.get(slash(path))); },
    write: async (path, text) => { log.writes.push(slash(path)); if (log.fail) throw Object.assign(Error('disk full'), {code: 'ENOSPC'}); files.set(slash(path), text); return true; },
    writeBytes: async (path, bytes) => { log.writes.push(slash(path)); if (log.fail) throw Object.assign(Error('disk full'), {code: 'ENOSPC'}); files.set(slash(path), Buffer.from(bytes)); return true; },
    remove: async path => { log.removes.push(slash(path)); files.delete(slash(path)); },
    rename: async (from, to) => { log.moves.push([slash(from), slash(to)]); if (!files.has(slash(from))) throw Object.assign(Error('ENOENT'), {code: 'ENOENT'}); files.set(slash(to), files.get(slash(from))); files.delete(slash(from)); },
  }};
};
const open = (initial, options = {}) => { const bench = memoryIo(initial); return CustomCharacters.open({dir: 'state', exchangePath: 'runtime/custom-characters.json', roster, ...bench.io, now: () => 1000, ...options}).then(store => ({...bench, store})); };

test('a character is made, listed, changed and deleted, and the file and the game list follow every step', async () => {
  const {store, files, log} = await open({});
  assert.equal(store.size, 0);
  const made = await store.create(valid());
  assert.equal(store.has(made.key), true);
  const file = JSON.parse(files.get('state/custom-characters.json'));
  assert.equal(file.version, 1);
  assert.deepEqual(file.characters.map(row => row.key), [made.key]);
  assert.equal(file.characters[0].bio, BIO);
  // What the game reads: only what finds the character.
  const game = JSON.parse(files.get('runtime/custom-characters.json'));
  assert.deepEqual(game, {version: 1, revision: 1000, characters: [{key: made.key, name: 'Rebecca', gender: 'female', records: ['NCA.Character.Rebecca'], names: ['Rebecca']}]});
  assert.equal(JSON.stringify(game).includes('Boom'), false, 'no bio, style, example or memory leaves for the game list');
  const changed = await store.update(made.key, valid({name: 'Rebecca Two', names: ['Rebecca', 'Becca'], bio: BIO + ' Changed.'}));
  assert.equal(changed.name, 'Rebecca Two');
  assert.equal(changed.created, made.created);
  assert.deepEqual(JSON.parse(files.get('runtime/custom-characters.json')).characters[0].names, ['Rebecca', 'Becca']);
  await assert.rejects(store.update('custom-nobody-aaaa', valid()), {code: 'not-found'});
  await assert.rejects(store.update(made.key, valid({gender: 'x'})), {code: 'invalid'});
  assert.equal(await store.delete(made.key), true);
  assert.equal(await store.delete(made.key), false);
  assert.deepEqual(JSON.parse(files.get('state/custom-characters.json')).characters, []);
  assert.deepEqual(JSON.parse(files.get('runtime/custom-characters.json')).characters, []);
  assert.equal(log.writes.every(path => ['state/custom-characters.json', 'runtime/custom-characters.json'].includes(path)), true);
});

test('what was saved is there after a restart, and a second character cannot take the first one\'s record', async () => {
  const first = await open({});
  const a = await first.store.create(valid());
  const b = await first.store.create(valid({name: 'Lucy', records: ['NCA.Character.Lucy'], names: ['Lucy']}));
  await assert.rejects(first.store.create(valid({name: 'Copy'})), error => error.code === 'invalid' && error.errors.some(item => item.code === 'match-taken'));
  const second = await open(Object.fromEntries(first.files), {});
  assert.deepEqual(second.store.list().map(row => row.key).sort(), [a.key, b.key].sort());
  assert.equal(second.store.get(a.key).examples[0], 'Boom. That is how I solve it.');
  assert.equal(Object.isFrozen(second.store.get(a.key)), true);
});

test('only forty characters, and a failed save changes neither the file nor what the prompt reads', async () => {
  const {store, files, log} = await open({}, {limits: {...CUSTOM_LIMITS, characters: 2}});
  await store.create(valid({name: 'One', records: ['NCA.Character.One'], names: ['One']}));
  await store.create(valid({name: 'Two', records: ['NCA.Character.Two'], names: ['Two']}));
  await assert.rejects(store.create(valid({name: 'Three', records: ['NCA.Character.Three'], names: ['Three']})), {code: 'full'});
  const before = files.get('state/custom-characters.json');
  log.fail = true;
  const key = store.list()[0].key;
  await assert.rejects(store.update(key, valid({name: 'One', records: ['NCA.Character.One'], names: ['One'], style: 'Changed.'})));
  assert.equal(files.get('state/custom-characters.json'), before);
  assert.equal(store.get(key).style, 'Fast, loud, a little rude.');
  log.fail = false;
  assert.equal(CUSTOM_LIMITS.characters, 40);
});

test('writes happen one at a time, even when asked together', async () => {
  const bench = memoryIo({});
  const order = [];
  const slow = {...bench.io, write: async (path, text) => { order.push('start ' + path); await new Promise(done => setTimeout(done, 5)); order.push('end'); return bench.io.write(path, text); }};
  const store = await CustomCharacters.open({dir: 'state', roster, ...slow, now: () => 1});
  await Promise.all([store.create(valid({name: 'A', records: ['NCA.Character.A1'], names: ['A']})), store.create(valid({name: 'B', records: ['NCA.Character.B1'], names: ['B']}))]);
  assert.deepEqual(order.map(item => item.split(' ')[0]), ['start', 'end', 'start', 'end']);
  assert.equal(store.size, 2);
});

test('a damaged file is left alone until a save, then kept as .corrupt, and a half-usable one keeps what cannot be read', async () => {
  const logged = [];
  const broken = await open({'state/custom-characters.json': '{"version":1,"characters":['}, {log: message => logged.push(message)});
  assert.equal(broken.store.size, 0);
  assert.match(logged.join('\n'), /could not be read/);
  assert.equal(broken.files.get('state/custom-characters.json'), '{"version":1,"characters":[', 'opening changes nothing on disk');
  await broken.store.create(valid());
  assert.equal(broken.files.get('state/custom-characters.json.corrupt'), '{"version":1,"characters":[');
  assert.equal(JSON.parse(broken.files.get('state/custom-characters.json')).characters.length, 1);
  const good = readRow({key: 'custom-keep-aaaa', name: 'Keep', gender: 'male', records: ['Character.Keep'], bio: BIO});
  const half = JSON.stringify({version: 1, characters: [good, {key: 'custom-bad-bbbb', name: 'No bio'}, 'nonsense']});
  const partial = await open({'state/custom-characters.json': half});
  assert.deepEqual(partial.store.list().map(row => row.key), ['custom-keep-aaaa']);
  await partial.store.create(valid());
  assert.equal(partial.files.get('state/custom-characters.json.corrupt'), half, 'the rows that could not be used are still in the copy');
  const bom = await open({'state/custom-characters.json': String.fromCharCode(0xFEFF) + JSON.stringify({version: 1, characters: [good]})});
  assert.equal(bom.store.size, 1, 'a file saved with a byte order mark is read');
  const empty = await open({'state/custom-characters.json': ''});
  await empty.store.create(valid());
  assert.equal(empty.files.has('state/custom-characters.json.corrupt'), false, 'an empty file holds nothing to keep');
});

test('a stored row is cut to the limits, so a damaged or hand-edited file never grows the prompt', () => {
  const row = readRow({key: 'custom-long-aaaa', name: 'N'.repeat(100), gender: 'FEMALE', records: ['Character.A1b', 'bad!record', 'x'], names: ['n'.repeat(90)], bio: 'b'.repeat(20000), style: 's'.repeat(5000),
    examples: Array.from({length: 40}, (_, i) => `example ${i} ${'e'.repeat(100)}`), memories: Array.from({length: 30}, (_, i) => `memory ${i}`)});
  assert.equal(Array.from(row.name).length, CUSTOM_LIMITS.name);
  assert.equal(row.gender, 'female');
  assert.deepEqual([...row.records], ['Character.A1b']);
  assert.equal(Array.from(row.names[0]).length, CUSTOM_LIMITS.displayName);
  assert.equal(Array.from(row.bio).length, CUSTOM_LIMITS.bio);
  assert.equal(Array.from(row.style).length, CUSTOM_LIMITS.style);
  assert(row.examples.length <= CUSTOM_LIMITS.examples && row.examples.join('').length <= CUSTOM_LIMITS.exampleTotal);
  assert.equal(row.memories.length, CUSTOM_LIMITS.memories);
  for (const bad of [null, 'x', {key: 'judy-alvarez', name: 'J', gender: 'female', records: ['Character.Judy'], bio: BIO}, {key: 'custom-x-aaaa', name: 'N', gender: 'robot', records: ['Character.Abc'], bio: BIO},
    {key: 'custom-x-aaaa', name: 'N', gender: 'male', bio: BIO}, {key: 'custom-x-aaaa', name: '', gender: 'male', records: ['Character.Abc'], bio: BIO}]) assert.equal(readRow(bad), null, JSON.stringify(bad));
});

// ---- the voice of a character with no clip (its clip, if it has one, is kept by bridge/player-voices.mjs)

test('a character with no clip speaks with the resident voice of its gender, and a clip in an older file is ignored', async () => {
  const {store, files} = await open({});
  const she = await store.create(valid());
  const he = await store.create(valid({name: 'Ray', gender: 'male', records: ['NCA.Character.Ray'], names: ['Ray']}));
  assert.equal(store.voiceAlias(she.key), 'resident-female');
  assert.equal(store.voiceAlias(he.key), 'resident-male');
  assert.equal(store.voiceAlias('custom-nobody-aaaa'), null);
  const row = readRow({key: 'custom-old-aaaa', name: 'Old', gender: 'male', records: ['Character.Old'], bio: BIO, voiceText: 'Hello there, this is me talking.', voice: {sha256: 'a'.repeat(64), seconds: 12, rate: 24000}});
  assert.equal('voice' in row || 'voiceText' in row, false, 'clips live in the player voice store, not in the character');
  assert.equal(JSON.stringify(JSON.parse(files.get('state/custom-characters.json'))).includes('voice'), false);
  assert.equal(store.validate(valid({voiceText: 'w'.repeat(5000)}), she.key).ok, true, 'the words of a clip are not part of the character any more');
});

test('everything survives on a real disk, next to (not inside) any shipped data', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'custom-characters-'));
  try {
    await mkdir(join(dir, 'runtime'), {recursive: true});
    const options = {dir: join(dir, 'state'), exchangePath: join(dir, 'runtime', 'custom-characters.json'), roster};
    const first = await CustomCharacters.open(options);
    const made = await first.create(valid());
    assert.deepEqual((await readdir(join(dir, 'state'))).sort(), ['custom-characters.json']);
    const second = await CustomCharacters.open(options);
    assert.equal(second.get(made.key).name, 'Rebecca');
    assert.equal(JSON.parse(await readFile(options.exchangePath, 'utf8')).characters[0].key, made.key);
    await second.delete(made.key);
    assert.equal(second.size, 0);
    await writeFile(join(dir, 'state', 'custom-characters.json'), '{"version":1,"characters":');
    assert.equal((await CustomCharacters.open(options)).size, 0);
  } finally { await rm(dir, {recursive: true, force: true}); }
});

// ---- the prompt

test('the prompt of a custom character is its own text; a roster key is never taken over, and an unknown custom key is an ordinary person', async () => {
  const {store} = await open({});
  const made = await store.create(valid());
  const book = new PersonaBook(rows, {custom: store});
  const persona = book.persona(made.key, 'Ignored');
  assert.equal(persona.name, 'Rebecca');
  assert.deepEqual([persona.backstory, persona.style, persona.samples, persona.memories], [BIO, 'Fast, loud, a little rude.', ['Boom. That is how I solve it.'], ['V once lent me a gun.']]);
  assert.equal(book.has(made.key), true);
  const head = systemHead({persona});
  assert.match(head, /You are Rebecca, a real person living in Cyberpunk 2077's Night City/);
  assert.match(head, /WHO YOU ARE\nI am Rebecca/);
  assert.match(head, /HOW YOU TALK\nFast, loud/);
  assert.match(head, /EXAMPLES OF YOUR VOICE[^\n]*\n- Boom\. That is how I solve it\./);
  assert.match(head, /WHAT YOU KNOW AND REMEMBER[^\n]*\n- V once lent me a gun\./);
  const messages = buildMessages({persona, history: [], context: '', contextParts: {now: '', notes: '', world: '', volatile: ''}, text: 'Hi', remembered: []});
  assert.match(messages.at(-1).content, /\(Reply as Rebecca, out loud/);
  // With no custom store, or a key it does not know, the book behaves exactly as before.
  const shipped = new PersonaBook(rows);
  for (const row of rows) assert.deepEqual(book.persona(row.key), shipped.persona(row.key), row.key);
  assert.equal(book.persona('custom-ghost-aaaa').known, false);
  assert.match(book.persona('custom-ghost-aaaa').backstory, /ordinary person/);
  assert.equal(shipped.has(made.key), false);
});

test('the roster rows let every lookup by key find a custom character, without a Convai identity', async () => {
  const {store} = await open({});
  const made = await store.create(valid());
  const list = [...rows, ...store.rosterRows()];
  const row = profileFor({profileKey: made.key}, list);
  assert.deepEqual([row.key, row.name, row.gender, row.kind, row.aliases, row.records], [made.key, 'Rebecca', 'FEMALE', 'custom', ['Rebecca'], ['NCA.Character.Rebecca']]);
  assert.equal(row.voice, undefined);
  assert.equal(row.model, undefined);
  assert.equal(profileFor({profileKey: 'judy-alvarez'}, list).kind, 'named');
});

// ---- what a character's voice leaves outside the data folder


test('a character\'s voice files outside the data folder go with the clip, and nothing else does', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'custom-voice-files-'));
  try {
    const hex = 'a1b2c3d4e5f60718293a4b5c';
    const touch = async (path, text = 'x') => { await mkdir(join(path, '..'), {recursive: true}); await writeFile(path, text); };
    const root = join(dir, 'references'), other = join(dir, 'pocket-references'), prepared = join(dir, 'work', 'prepared-voices');
    for (const place of [root, other]) for (const name of ['custom-a-aaaa.wav', 'custom-b-bbbb.wav', 'v-male.wav', 'addon-x-y.wav', 'judy-alvarez.wav']) await touch(join(place, 'addons', name));
    await mkdir(join(root, 'addons', 'custom-dir-cccc.wav'), {recursive: true});
    await touch(join(root, 'judy-alvarez.wav'));
    for (const name of [`custom-a-aaaa-${hex}.safetensors`, `custom-a-aaaa-${hex}.safetensors.tmp`, `custom-b-bbbb-${hex}.safetensors`, `judy-alvarez-${hex}.safetensors`, 'custom-a-aaaa-short.safetensors', `custom-a-aaaa-${hex}.txt`])
      await touch(join(prepared, name));
    const names = async folder => (await readdir(folder)).sort();
    // One character: its copies under every root and its prepared setups (and a setup being written).
    assert.equal(await releaseVoiceFiles({key: 'custom-a-aaaa', roots: [root, other, root, '', null], preparedFolder: prepared}), 4);
    assert.deepEqual(await names(join(root, 'addons')), ['addon-x-y.wav', 'custom-b-bbbb.wav', 'custom-dir-cccc.wav', 'judy-alvarez.wav', 'v-male.wav']);
    assert.deepEqual(await names(join(other, 'addons')), ['addon-x-y.wav', 'custom-b-bbbb.wav', 'judy-alvarez.wav', 'v-male.wav']);
    assert.deepEqual(await names(prepared), [`custom-a-aaaa-${hex}.txt`, 'custom-a-aaaa-short.safetensors', `custom-b-bbbb-${hex}.safetensors`, `judy-alvarez-${hex}.safetensors`]);
    assert.equal((await readdir(root)).includes('judy-alvarez.wav'), true, 'the shipped references are never touched');
    // A sweep at start: every character that no character owns any more goes; the ones kept stay.
    assert.equal(await releaseVoiceFiles({keep: new Set(['custom-b-bbbb']), roots: [root, other], preparedFolder: prepared}), 0);
    assert.equal(await releaseVoiceFiles({keep: new Set(), roots: [root, other], preparedFolder: prepared}), 3);
    assert.deepEqual(await names(join(root, 'addons')), ['addon-x-y.wav', 'custom-dir-cccc.wav', 'judy-alvarez.wav', 'v-male.wav'], 'a folder with such a name is not a file');
    assert.deepEqual(await names(prepared), [`custom-a-aaaa-${hex}.txt`, 'custom-a-aaaa-short.safetensors', `judy-alvarez-${hex}.safetensors`]);
    // Folders that do not exist, and a file that cannot be removed, are no failure.
    assert.equal(await releaseVoiceFiles({key: 'custom-z-zzzz', roots: [join(dir, 'nowhere')], preparedFolder: join(dir, 'nowhere-either')}), 0);
    assert.equal(await releaseVoiceFiles({key: 'custom-a-aaaa', roots: [], preparedFolder: null}), 0);
    const stuck = {readdir: async () => [{name: 'custom-a-aaaa.wav', isFile: () => true, isSymbolicLink: () => false}], rm: async () => { throw Object.assign(Error('busy'), {code: 'EBUSY'}); }};
    assert.equal(await releaseVoiceFiles({key: 'custom-a-aaaa', roots: ['x'], files: stuck}), 0);
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test('the store tells the bridge when a character has gone, and a hook that fails changes nothing', async () => {
  const deleted = [];
  const {store} = await open({}, {onDeleted: key => { deleted.push(key); if (deleted.length === 2) throw Error('hook failed'); }});
  const made = await store.create(valid());
  await store.update(made.key, valid({bio: BIO + ' More.'}));
  assert.deepEqual(deleted, [], 'making and changing a character tells nothing');
  assert.equal(await store.delete(made.key), true);
  assert.deepEqual(deleted, [made.key]);
  assert.equal(await store.delete(made.key), false);
  assert.deepEqual(deleted, [made.key], 'nothing to tell for a character that was not there');
  const other = await store.create(valid());
  assert.equal(await store.delete(other.key), true, 'a throwing hook is not an error of the delete');
  assert.equal(deleted.length, 2);
  assert.equal(store.size, 0);
});
