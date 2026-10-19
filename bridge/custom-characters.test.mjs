import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, readdir, rm, writeFile, mkdir} from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {CustomCharacters, CUSTOM_LIMITS, CUSTOM_KEY, CLONE_PREFIXES, isCustomKey, normalizeName, readRow, recordVariants, releaseVoiceFiles, rosterIndex, validateCustom} from './custom-characters.mjs';
import {CLIP, checkSpeech, checkTranscript, decodeWav, encodeWav, prepareClip} from './custom-voice-clip.mjs';
import {PersonaBook, systemHead, buildMessages} from './mistral-prompt.mjs';
import {profileFor} from './protocol.mjs';

const named = JSON.parse(await readFile(new URL('../characters/roster.json', import.meta.url), 'utf8'));
const archetypes = JSON.parse(await readFile(new URL('../characters/archetype-roster.json', import.meta.url), 'utf8'));
const rows = [...named, ...archetypes];
const roster = rosterIndex(rows);

const BIO = 'I am Rebecca, a small, loud, trigger-happy runner who grew up in Pacifica and still thinks every plan needs more explosions. I trust few people.';
const valid = (extra = {}) => ({name: 'Rebecca', gender: 'female', records: ['NCA.Character.Rebecca'], names: ['Rebecca'], bio: BIO,
  style: 'Fast, loud, a little rude.', examples: ['Boom. That is how I solve it.'], memories: ['V once lent me a gun.'], voiceText: '', ...extra});

// ---- a synthetic recording: a voiced tone, shaped like words with short pauses, at any rate, depth and channel count
function speechWav({seconds = 12, rate = 24000, channels = 1, bits = 16, level = 0.4, silent = false, clip = false, extensible = false, float = false} = {}) {
  const frames = Math.round(seconds * rate), width = float ? 4 : bits / 8, align = channels * width;
  const header = extensible ? 40 : 16, bytes = Buffer.alloc(12 + 8 + header + 8 + frames * align);
  bytes.write('RIFF', 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVE', 8); bytes.write('fmt ', 12); bytes.writeUInt32LE(header, 16);
  const codec = float ? 3 : 1;
  bytes.writeUInt16LE(extensible ? 0xFFFE : codec, 20); bytes.writeUInt16LE(channels, 22); bytes.writeUInt32LE(rate, 24); bytes.writeUInt32LE(rate * align, 28);
  bytes.writeUInt16LE(align, 32); bytes.writeUInt16LE(float ? 32 : bits, 34);
  if (extensible) { bytes.writeUInt16LE(22, 36); bytes.writeUInt16LE(float ? 32 : bits, 38); bytes.writeUInt32LE(3, 40); bytes.writeUInt16LE(codec, 44); }
  const at = 20 + header;
  bytes.write('data', at); bytes.writeUInt32LE(frames * align, at + 4);
  for (let i = 0; i < frames; i++) {
    const t = i / rate, word = silent ? 0 : (Math.sin(2 * Math.PI * 2.2 * t) > -0.7 ? 1 : 0);   // about a fifth of the time is a pause
    let sample = word * level * Math.sin(2 * Math.PI * 180 * t) * (0.6 + 0.4 * Math.sin(2 * Math.PI * 5 * t));
    if (clip) sample = Math.sign(sample) * Math.min(1, Math.abs(sample) * 20);
    for (let c = 0; c < channels; c++) {
      const place = at + 8 + i * align + c * width;
      if (float) bytes.writeFloatLE(sample, place);
      else if (bits === 16) bytes.writeInt16LE(Math.round(sample * 32767), place);
      else if (bits === 24) bytes.writeIntLE(Math.round(sample * 8388607), place, 3);
      else bytes.writeInt32LE(Math.round(sample * 2147483647), place);
    }
  }
  return bytes;
}

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
  assert.deepEqual(codes(valid({voiceText: 'w'.repeat(CLIP.transcript + 1)})), ['voice-text-long']);
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

// ---- the clip

test('a clean speech clip is kept in one canonical form: mono, 16-bit, its own rate, a plain header', () => {
  const given = speechWav({seconds: 12, rate: 48000, channels: 2, bits: 24});
  const clip = prepareClip(given);
  assert.equal(clip.ok, true, JSON.stringify(clip));
  assert.equal(clip.rate, 48000);
  assert.equal(clip.seconds, 12);
  assert.deepEqual(clip.notes, []);
  assert.equal(clip.sha256, createHash('sha256').update(clip.wav).digest('hex'));
  const back = decodeWav(clip.wav);
  assert.equal(back.ok && back.channels === 1 && back.bits === 16 && back.codec === 1, true);
  assert.equal(clip.wav.length, 44 + 12 * 48000 * 2, 'a 44-byte header and nothing else');
  assert.equal(clip.wav.readUInt32LE(4) + 8, clip.wav.length, 'an exact RIFF size, which Pocket demands');
  for (const options of [{bits: 16}, {bits: 32}, {float: true}, {extensible: true, bits: 24}, {extensible: true, float: true}, {rate: 16000}, {rate: 96000, seconds: 6}])
    assert.equal(prepareClip(speechWav(options)).ok, true, JSON.stringify(options));
  assert.deepEqual(prepareClip(speechWav({seconds: 7})).notes, ['short']);
  assert.deepEqual(prepareClip(speechWav({seconds: 19.5})).notes, ['long']);
});

test('a clip that the voices could not use or copy is refused with a reason', () => {
  const why = bytes => { const clip = prepareClip(bytes); assert.equal(clip.ok, false); return clip.code; };
  assert.equal(why(Buffer.from('not a wav at all, just some text that is long enough to pass a size check....')), 'clip-format');
  assert.equal(why(Buffer.alloc(10)), 'clip-format');
  assert.equal(why(speechWav({seconds: 12, rate: 8000})), 'clip-rate');
  assert.equal(why(speechWav({seconds: 3})), 'clip-short');
  assert.equal(why(speechWav({seconds: 21})), 'clip-long');
  assert.equal(why(speechWav({clip: true})), 'clip-clipped');
  assert.equal(why(speechWav({level: 0.004})), 'clip-quiet');
  assert.equal(why(speechWav({silent: true})), 'clip-silent');
  const truncated = speechWav({seconds: 12}).subarray(0, 24000);   // a recorder that stopped early: what is there is used, and it is too short
  assert.equal(why(truncated), 'clip-short');
  const odd = speechWav({seconds: 12}); odd.writeUInt16LE(7, 20);
  assert.equal(why(odd), 'clip-format', 'a format the workers do not read');
  assert.equal(why(Buffer.alloc(CLIP.maxUploadBytes + 1)), 'clip-big');
});

test('the words said in the clip are checked and tidied', () => {
  assert.deepEqual(checkTranscript('  Hello   there,\nchoom. '), {ok: true, text: 'Hello there, choom.'});
  assert.equal(checkTranscript('hi').code, 'voice-text-short');
  assert.equal(checkTranscript('w'.repeat(CLIP.transcript + 1)).code, 'voice-text-long');
  assert.equal(checkSpeech(new Float32Array(48000).fill(0), 24000).code, 'clip-silent');
  assert.deepEqual(encodeWav(new Float32Array([0, 1, -1]), 24000).subarray(44).toJSON().data, [0, 0, 255, 127, 1, 128]);
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
    examples: Array.from({length: 40}, (_, i) => `example ${i} ${'e'.repeat(100)}`), memories: Array.from({length: 30}, (_, i) => `memory ${i}`), voiceText: 'v'.repeat(3000),
    voice: {sha256: 'a'.repeat(64), seconds: 12, rate: 24000}});
  assert.equal(Array.from(row.name).length, CUSTOM_LIMITS.name);
  assert.equal(row.gender, 'female');
  assert.deepEqual([...row.records], ['Character.A1b']);
  assert.equal(Array.from(row.names[0]).length, CUSTOM_LIMITS.displayName);
  assert.equal(Array.from(row.bio).length, CUSTOM_LIMITS.bio);
  assert.equal(Array.from(row.style).length, CUSTOM_LIMITS.style);
  assert(row.examples.length <= CUSTOM_LIMITS.examples && row.examples.join('').length <= CUSTOM_LIMITS.exampleTotal);
  assert.equal(row.memories.length, CUSTOM_LIMITS.memories);
  assert.equal(Array.from(row.voiceText).length, CLIP.transcript);
  assert.equal(row.voice.rate, 24000);
  for (const bad of [null, 'x', {key: 'judy-alvarez', name: 'J', gender: 'female', records: ['Character.Judy'], bio: BIO}, {key: 'custom-x-aaaa', name: 'N', gender: 'robot', records: ['Character.Abc'], bio: BIO},
    {key: 'custom-x-aaaa', name: 'N', gender: 'male', bio: BIO}, {key: 'custom-x-aaaa', name: '', gender: 'male', records: ['Character.Abc'], bio: BIO}]) assert.equal(readRow(bad), null, JSON.stringify(bad));
});

// ---- a character's voice

test('a clip is checked, kept as custom-voices/<key>.wav and recorded; the voices merge it at the next start with the words said in it', async () => {
  const {store, files} = await open({});
  const made = await store.create(valid());
  await assert.rejects(store.setVoice(made.key, speechWav()), {code: 'voice-text-short'}, 'the words are needed first');
  await assert.rejects(store.setVoice(made.key, Buffer.from('nope, a long enough text to look like a file but is not a recording at all')), {code: 'voice-text-short'});
  await assert.rejects(store.setVoice(made.key, Buffer.from('nope, a long enough text to look like a file but is not a recording at all'), 'Hello there, this is me talking.'), {code: 'clip-format'});
  const done = await store.setVoice(made.key, speechWav({seconds: 11}), '  Hello there,   this is me talking. ');
  assert.equal(done.clip.seconds, 11);
  assert.equal(done.row.voiceText, 'Hello there, this is me talking.');
  const kept = files.get(`state/custom-voices/${made.key}.wav`);
  assert.equal(createHash('sha256').update(kept).digest('hex'), done.row.voice.sha256);
  assert.equal(JSON.parse(files.get('state/custom-characters.json')).characters[0].voice.sha256, done.row.voice.sha256);
  assert.deepEqual((await store.voiceExtras()).map(item => ({...item, reference: slash(item.reference)})),
    [{key: made.key, reference: `state/custom-voices/${made.key}.wav`, sha256: done.row.voice.sha256, transcript: 'Hello there, this is me talking.'}]);
  assert.equal(JSON.stringify(JSON.parse(files.get('runtime/custom-characters.json'))).includes('Hello there'), false, 'the game list never carries the words');
  // The text of a character with a clip cannot lose the words.
  await assert.rejects(store.update(made.key, valid({voiceText: ''})), error => error.code === 'invalid' && error.errors[0].code === 'voice-text-short');
  await store.update(made.key, valid({voiceText: 'Hello there, these are other words.'}));
  assert.equal(store.get(made.key).voice.sha256, done.row.voice.sha256, 'saving the text keeps the clip');
  // A damaged or replaced file is not used.
  files.set(`state/custom-voices/${made.key}.wav`, Buffer.from('changed'));
  const logged = [];
  store.log = message => logged.push(message);
  assert.deepEqual(await store.voiceExtras(), []);
  assert.match(logged.join('\n'), /does not match/);
  files.delete(`state/custom-voices/${made.key}.wav`);
  assert.deepEqual(await store.voiceExtras(), []);
});

test('removing a clip, and deleting a character, remove the file; a character with no clip speaks with the resident voice of its gender', async () => {
  const {store, files} = await open({});
  const she = await store.create(valid());
  const he = await store.create(valid({name: 'Ray', gender: 'male', records: ['NCA.Character.Ray'], names: ['Ray']}));
  assert.equal(store.voiceAlias(she.key), 'resident-female');
  assert.equal(store.voiceAlias(he.key), 'resident-male');
  assert.equal(store.voiceAlias('custom-nobody-aaaa'), null);
  await store.setVoice(she.key, speechWav(), 'Hello there, this is me talking.');
  assert.equal(files.has(`state/custom-voices/${she.key}.wav`), true);
  const cleared = await store.clearVoice(she.key);
  assert.equal(cleared.voice, null);
  assert.equal(files.has(`state/custom-voices/${she.key}.wav`), false);
  await store.setVoice(she.key, speechWav(), 'Hello there, this is me talking.');
  await store.delete(she.key);
  assert.equal(files.has(`state/custom-voices/${she.key}.wav`), false);
  assert.deepEqual(await store.voiceExtras(), []);
});

test('everything survives on a real disk, next to (not inside) any shipped data', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'custom-characters-'));
  try {
    await mkdir(join(dir, 'runtime'), {recursive: true});
    const options = {dir: join(dir, 'state'), exchangePath: join(dir, 'runtime', 'custom-characters.json'), roster};
    const first = await CustomCharacters.open(options);
    const made = await first.create(valid());
    await first.setVoice(made.key, speechWav(), 'Hello there, this is me talking.');
    assert.deepEqual((await readdir(join(dir, 'state'))).sort(), ['custom-characters.json', 'custom-voices']);
    assert.deepEqual(await readdir(join(dir, 'state', 'custom-voices')), [made.key + '.wav']);
    const second = await CustomCharacters.open(options);
    assert.equal(second.get(made.key).name, 'Rebecca');
    assert.equal((await second.voiceExtras()).length, 1);
    assert.equal(JSON.parse(await readFile(options.exchangePath, 'utf8')).characters[0].key, made.key);
    await second.delete(made.key);
    assert.deepEqual(await readdir(join(dir, 'state', 'custom-voices')), []);
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

// ---- what a clip leaves outside the data folder

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

test('the store tells the bridge when a clip or a character has gone, and a hook that fails changes nothing', async () => {
  const released = [];
  const {store} = await open({}, {onVoiceReleased: key => { released.push(key); if (released.length === 3) throw Error('hook failed'); }});
  const made = await store.create(valid());
  assert.deepEqual(released, []);
  await store.setVoice(made.key, speechWav(), 'Hello there, this is me talking.');
  assert.deepEqual(released, [], 'giving a clip releases nothing');
  await store.clearVoice(made.key);
  assert.deepEqual(released, [made.key]);
  await store.setVoice(made.key, speechWav(), 'Hello there, this is me talking.');
  assert.equal(await store.delete(made.key), true);
  assert.deepEqual(released, [made.key, made.key]);
  assert.equal(await store.delete(made.key), false);
  assert.deepEqual(released, [made.key, made.key], 'nothing to release for a character that was not there');
  const other = await store.create(valid());
  await store.clearVoice(other.key);
  await store.delete(other.key);
  assert.equal(released.length, 4, 'a throwing hook is not an error of the delete');
  assert.equal(store.size, 0);
});
