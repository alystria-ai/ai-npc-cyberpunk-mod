import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {CharacterOverrides, EDIT_LIMITS, FIELDS, applyOverride, cleanBlock, cleanLine, personaSize, readOverride, validateOverride} from './character-overrides.mjs';
import {PersonaBook, systemHead, systemPrompt, buildMessages, repeatsLine, LIMITS} from './mistral-prompt.mjs';

const named = JSON.parse(await readFile(new URL('../characters/roster.json', import.meta.url), 'utf8'));
const archetypes = JSON.parse(await readFile(new URL('../characters/archetype-roster.json', import.meta.url), 'utf8'));
const rows = [...named, ...archetypes];
const shipped = new PersonaBook(rows);
const defaultsOf = key => {
  const persona = shipped.defaults(key);
  return {bio: cleanBlock(persona.backstory), style: cleanBlock(persona.style), rules: [], examples: persona.samples.map(cleanLine), memories: []};
};

// ---- the limits are about the shipped profiles

test('the limits leave room for every shipped profile, and the total is only a little above the longest', () => {
  let longest = 0;
  for (const row of rows) {
    const defaults = defaultsOf(row.key);
    assert(Array.from(defaults.bio).length <= EDIT_LIMITS.bio, `${row.key} bio`);
    assert(Array.from(defaults.style).length <= EDIT_LIMITS.style, `${row.key} style`);
    assert(defaults.examples.length <= EDIT_LIMITS.examples, `${row.key} example count`);
    assert(defaults.examples.every(line => Array.from(line).length <= EDIT_LIMITS.example), `${row.key} example length`);
    assert(defaults.examples.join('').length <= EDIT_LIMITS.exampleTotal, `${row.key} example total`);
    longest = Math.max(longest, personaSize(defaults));
  }
  assert(longest <= EDIT_LIMITS.total, 'an unedited profile must always be inside the total');
  assert(EDIT_LIMITS.total <= longest * 1.3, 'the total stays about as tight as the longest shipped profile');
});

// ---- cleaning

test('a block keeps its paragraphs and loses control characters, markers and runs of blank lines', () => {
  assert.equal(cleanBlock('  One\r\nTwo   \n\n\n\nThree\u0007 \t four\n[CyberpunkConvai profile v2:x]\n'), 'One\nTwo\n\nThree four');
  assert.equal(cleanLine('  a\n\tb \u0000 c  '), 'a b c');
});

// ---- validation

test('a field equal to its shipped text is not stored, and null goes back to the shipped text', () => {
  const defaults = defaultsOf('judy-alvarez');
  assert.deepEqual(validateOverride({bio: defaults.bio, examples: defaults.examples}, defaults), {ok: true, value: {}});
  assert.deepEqual(validateOverride({style: 'Calm and dry.'}, defaults), {ok: true, value: {style: 'Calm and dry.'}});
  assert.deepEqual(validateOverride({style: null}, defaults, {style: 'Calm and dry.', rules: ['Be brief.']}), {ok: true, value: {rules: ['Be brief.']}});
  // The page sends the text it was given: spacing differences alone never make a character "edited".
  assert.deepEqual(validateOverride({bio: defaults.bio + '  \r\n'}, defaults), {ok: true, value: {}});
});

test('each limit is checked and reported with a stable code, and nothing is stored on any error', () => {
  const defaults = defaultsOf('jackie-welles');
  const codes = patch => {
    const result = validateOverride(patch, defaults);
    assert.equal(result.ok, false);
    return result.errors.map(error => error.code);
  };
  assert.deepEqual(codes({bio: 'too short'}), ['bio-short']);
  assert.deepEqual(codes({bio: 'x'.repeat(EDIT_LIMITS.bio + 1)}), ['bio-long']);
  assert.deepEqual(codes({style: 'x'.repeat(EDIT_LIMITS.style + 1)}), ['style-long']);
  assert.deepEqual(codes({rules: Array.from({length: EDIT_LIMITS.rules + 1}, (_, i) => `rule ${i}`)}), ['rules-many']);
  assert.deepEqual(codes({rules: ['y'.repeat(EDIT_LIMITS.rule + 1)]}), ['rules-long']);
  assert.deepEqual(codes({examples: Array.from({length: EDIT_LIMITS.examples + 1}, (_, i) => `line ${i}`)}), ['examples-many']);
  assert.deepEqual(codes({examples: ['z'.repeat(EDIT_LIMITS.example + 1)]}), ['examples-long']);
  assert.deepEqual(codes({examples: Array.from({length: 14}, (_, i) => `${i}`.padEnd(EDIT_LIMITS.example, 'a'))}), ['examples-total']);
  assert.deepEqual(codes({memories: Array.from({length: EDIT_LIMITS.memories + 1}, (_, i) => `memory ${i}`)}), ['memories-many']);
  assert.deepEqual(codes({memories: ['m'.repeat(EDIT_LIMITS.memory + 1)]}), ['memories-long']);
  assert.deepEqual(codes({rules: 'not a list'}), ['bad-type']);
  assert.deepEqual(codes({bio: 5}), ['bad-type']);
  assert.deepEqual(codes({shoes: 'brown'}), ['unknown-field']);
  assert.deepEqual(validateOverride('nope', defaults).errors, [{field: '', code: 'bad-request'}]);
  const crowded = validateOverride({bio: 'B'.repeat(EDIT_LIMITS.bio), style: 'S'.repeat(EDIT_LIMITS.style),
    memories: Array.from({length: 12}, () => 'm'.repeat(EDIT_LIMITS.memory)).map((text, i) => text + i)}, {...defaults, bio: 'b'.repeat(100), style: ''});
  assert.deepEqual([...new Set(crowded.errors.map(error => error.code))], ['memories-long'], 'a per-item error is reported first, and the total is not checked then');
  const total = validateOverride({bio: 'B'.repeat(EDIT_LIMITS.bio), style: 'S'.repeat(EDIT_LIMITS.style),
    memories: Array.from({length: 12}, (_, i) => `${i}`.padEnd(EDIT_LIMITS.memory - 2, 'm')), rules: Array.from({length: 10}, (_, i) => `${i}`.padEnd(EDIT_LIMITS.rule - 2, 'r'))},
    {...defaults, bio: 'b'.repeat(100), style: ''});
  assert.deepEqual(total.errors, [{field: '', code: 'too-big', max: EDIT_LIMITS.total}]);
});

test('lists are tidied: blank lines dropped, repeats dropped, order kept', () => {
  const result = validateOverride({rules: ['  Never swear. ', '', 'never swear.', 'Be brief.\n']}, defaultsOf('panam-palmer'));
  assert.deepEqual(result.value.rules, ['Never swear.', 'Be brief.']);
});

test('a damaged stored file never grows the prompt: types are checked and text is cut to the limits', () => {
  const row = readOverride({bio: 'b'.repeat(EDIT_LIMITS.bio + 500), style: 7, rules: ['x'.repeat(500), '', 3, {text: 'object rule'}],
    examples: Array.from({length: 40}, (_, i) => `example ${i} ${'e'.repeat(100)}`), memories: 'nope', other: 'ignored'});
  assert.equal(Array.from(row.bio).length, EDIT_LIMITS.bio);
  assert.equal('style' in row, false);
  assert.equal(row.rules[0].length, EDIT_LIMITS.rule);
  assert.equal(row.rules[1], 'object rule');
  assert(row.examples.length <= EDIT_LIMITS.examples && row.examples.join('').length <= EDIT_LIMITS.exampleTotal);
  assert.equal('memories' in row, false);
  assert.equal('other' in row, false);
  assert.deepEqual(readOverride(null), {});
  assert.equal('bio' in readOverride({bio: 'short'}), false);
});

// ---- storage

const slash = path => path.replaceAll('\\', '/');
const memoryIo = (initial = {}) => {
  const files = new Map(Object.entries(initial)), log = {writes: [], removes: []};
  return {files, log, io: {
    read: async path => { if (!files.has(slash(path))) throw Object.assign(Error('ENOENT'), {code: 'ENOENT'}); return files.get(slash(path)); },
    write: async (path, text) => { log.writes.push(slash(path)); if (log.fail) throw Object.assign(Error('disk full'), {code: 'ENOSPC'}); files.set(slash(path), text); return true; },
    readdir: async dir => { const names = [...files.keys()].filter(path => path.startsWith(slash(dir) + '/')).map(path => path.slice(slash(dir).length + 1)); if (!names.length) throw Object.assign(Error('ENOENT'), {code: 'ENOENT'}); return names; },
    remove: async path => { log.removes.push(slash(path)); files.delete(slash(path)); },
  }};
};
const doc = (key, fields) => JSON.stringify({version: 1, key, updated: 1, ...fields});

test('edits are loaded once, kept apart per character, and read back with a plain lookup', async () => {
  const {io, files} = memoryIo({
    'v/judy-alvarez.json': doc('judy-alvarez', {style: 'Calm.', rules: ['Be brief.']}),
    'v/mismatch.json': doc('someone-else', {style: 'Wrong key.'}),
    'v/broken.json': '{not json',
    'v/notes.txt': 'ignored',
    'v/empty.json': doc('empty', {}),
  });
  const logged = [];
  const store = await CharacterOverrides.open({dir: 'v', ...io, log: message => logged.push(message)});
  assert.deepEqual(store.keys(), ['judy-alvarez']);
  assert.deepEqual({...store.get('judy-alvarez')}, {style: 'Calm.', rules: ['Be brief.']});
  assert.equal(store.get('panam-palmer'), null);
  assert.equal(Object.isFrozen(store.get('judy-alvarez')), true);
  assert.match(logged.join('\n'), /broken/);
  assert.equal(files.has('v/broken.json'), true, 'a damaged file is left on disk');
});

test('a missing folder is an empty set, and saving creates the file with only the changed fields', async () => {
  const {io, files, log} = memoryIo();
  const store = await CharacterOverrides.open({dir: 'v', ...io, now: () => 42});
  assert.deepEqual(store.keys(), []);
  const saved = await store.set('judy-alvarez', {style: 'Calm.', unknown: 'x', rules: []});
  assert.deepEqual({...saved}, {style: 'Calm.', rules: []});
  assert.deepEqual(JSON.parse(files.get('v/judy-alvarez.json')), {version: 1, key: 'judy-alvarez', updated: 42, style: 'Calm.', rules: []});
  assert.deepEqual(log.writes, ['v/judy-alvarez.json']);
});

test('saving nothing removes the file; reset removes one field or all of them', async () => {
  const {io, files, log} = memoryIo({'v/judy-alvarez.json': doc('judy-alvarez', {style: 'Calm.', rules: ['Be brief.'], memories: ['V has a sister called Lena.']})});
  const store = await CharacterOverrides.open({dir: 'v', ...io});
  await store.reset('judy-alvarez', 'rules');
  assert.deepEqual(Object.keys(store.get('judy-alvarez')).sort(), ['memories', 'style']);
  await assert.rejects(store.reset('judy-alvarez', 'shoes'), {code: 'unknown-field'});
  await store.reset('judy-alvarez');
  assert.equal(store.get('judy-alvarez'), null);
  assert.equal(files.has('v/judy-alvarez.json'), false);
  assert.deepEqual(log.removes, ['v/judy-alvarez.json']);
  assert.equal(await store.set('judy-alvarez', {}), null);
});

test('a failed save changes neither the file nor what the prompt reads, and writes happen one at a time', async () => {
  const {io, files, log} = memoryIo({'v/judy-alvarez.json': doc('judy-alvarez', {style: 'Calm.'})});
  const store = await CharacterOverrides.open({dir: 'v', ...io});
  log.fail = true;
  await assert.rejects(store.set('judy-alvarez', {style: 'Loud.'}));
  assert.equal(store.get('judy-alvarez').style, 'Calm.');
  assert.equal(JSON.parse(files.get('v/judy-alvarez.json')).style, 'Calm.');
  log.fail = false;
  const order = [];
  const slow = {...io, write: async (path, text) => { order.push('start ' + text.length); await new Promise(done => setTimeout(done, 10)); order.push('end'); return io.write(path, text); }};
  const second = await CharacterOverrides.open({dir: 'v', ...slow});
  await Promise.all([second.set('judy-alvarez', {style: 'One.'}), second.set('judy-alvarez', {style: 'Two, longer.'})]);
  assert.deepEqual(order.map(item => item.split(' ')[0]), ['start', 'end', 'start', 'end']);
  assert.equal(second.get('judy-alvarez').style, 'Two, longer.');
  await assert.rejects(store.set('../escape', {style: 'x'}), {code: 'bad-key'});
  await assert.rejects(store.set('Judy Alvarez', {style: 'x'}), {code: 'bad-key'});
});

test('edits survive a restart on a real disk, next to (not inside) any shipped data', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'character-overrides-'));
  try {
    const folder = join(dir, 'character-overrides');
    const first = await CharacterOverrides.open({dir: folder});
    await first.set('judy-alvarez', {bio: 'B'.repeat(80), rules: ['Never swear.']});
    await first.set('river-ward', {style: 'Slow.'});
    assert.deepEqual((await readdir(folder)).sort(), ['judy-alvarez.json', 'river-ward.json']);
    const second = await CharacterOverrides.open({dir: folder});
    assert.deepEqual(second.keys().sort(), ['judy-alvarez', 'river-ward']);
    assert.deepEqual([...second.get('judy-alvarez').rules], ['Never swear.']);
    await second.reset('river-ward');
    assert.deepEqual(await readdir(folder), ['judy-alvarez.json']);
    await writeFile(join(folder, 'panam-palmer.json'), '{"version":1,"key":"panam-palmer","style":');
    assert.deepEqual((await CharacterOverrides.open({dir: folder})).keys(), ['judy-alvarez']);
  } finally { await rm(dir, {recursive: true, force: true}); }
});

// ---- the prompt builder uses the edits

test('without edits (or with an empty set) every roster character gets the same persona and the same prompt as before', () => {
  const empty = new PersonaBook(rows, {overrides: {get: () => null}});
  for (const row of rows) {
    assert.deepEqual(empty.persona(row.key), shipped.persona(row.key));
    assert.equal(systemHead({persona: empty.persona(row.key)}), systemHead({persona: shipped.persona(row.key)}), row.key);
  }
  assert(!/RULES OF SPEECH|WHAT YOU KNOW AND REMEMBER/.test(systemHead({persona: shipped.persona('judy-alvarez')})));
});

test('edits replace the shipped text in the prompt, in a fixed order, and the shipped profile stays reachable', () => {
  const overrides = new CharacterOverrides({});
  overrides.rows.set('judy-alvarez', Object.freeze({bio: 'Judy runs a quiet clinic on the edge of Watson and fixes people for free. '.repeat(2), style: 'Warm, tired, funny.',
    rules: ['Never swear.', 'Answer in one sentence.'], examples: ['Sit down, you look awful, and eat something first.', 'I fix things, that is all.'], memories: ['V has a sister called Lena.']}));
  const book = new PersonaBook(rows, {overrides});
  const persona = book.persona('judy-alvarez');
  assert.equal(persona.name, 'Judy Alvarez');
  assert.deepEqual(persona.samples, ['Sit down, you look awful, and eat something first.', 'I fix things, that is all.']);
  const head = systemHead({persona});
  const at = text => head.indexOf(text);
  assert(at('WHO YOU ARE\nJudy runs a quiet clinic') > 0);
  assert(at('HOW YOU TALK\nWarm, tired, funny.') > at('WHO YOU ARE'));
  assert(at('YOUR OWN RULES OF SPEECH') > at('HOW YOU TALK'));
  assert(at('- Never swear.\n- Answer in one sentence.') > at('YOUR OWN RULES OF SPEECH'));
  assert(at('EXAMPLES OF YOUR VOICE') > at('- Answer in one sentence.'));
  assert(at('- Sit down, you look awful, and eat something first.') > at('EXAMPLES OF YOUR VOICE'));
  assert(at('WHAT YOU KNOW AND REMEMBER') > at('- I fix things, that is all.'));
  assert(at('- V has a sister called Lena.') > at('WHAT YOU KNOW AND REMEMBER'));
  assert(at('OUTPUT RULES') > at('- V has a sister called Lena.'), 'the output rules stay last and keep outranking the persona');
  assert.doesNotMatch(head, /green and pink hair|Editorial delivery/, 'the shipped bio and style are replaced, not added to');
  assert.match(systemPrompt({persona}), /^You are Judy Alvarez/);
  // The shipped profile is still there for "reset", and other characters are untouched.
  assert.match(book.defaults('judy-alvarez').backstory, /green and pink hair/);
  assert.deepEqual(book.persona('panam-palmer'), shipped.persona('panam-palmer'));
  // Lines the character already said are compared against the edited examples, not the shipped ones.
  assert.equal(repeatsLine('Sit down, you look awful, and eat something first, please.', persona.samples), true);
  assert.equal(repeatsLine('Sure. The hard part is not making somebody feel something at all.', persona.samples), false);
  const messages = buildMessages({persona, text: 'Hey.'});
  assert.match(messages[0].content, /Never swear\./);
});

test('a field that is not edited keeps following the shipped profile; an unknown key never takes an edit', () => {
  const overrides = new CharacterOverrides({});
  overrides.rows.set('judy-alvarez', Object.freeze({rules: ['Never swear.']}));
  overrides.rows.set('npc-not-in-the-roster', Object.freeze({bio: 'B'.repeat(80)}));
  const book = new PersonaBook(rows, {overrides});
  const persona = book.persona('judy-alvarez');
  assert.equal(persona.backstory, shipped.persona('judy-alvarez').backstory);
  assert.deepEqual(persona.samples, shipped.persona('judy-alvarez').samples);
  assert.deepEqual(persona.rules, ['Never swear.']);
  assert.equal(book.persona('npc-not-in-the-roster', 'Somebody').known, false);
  assert.equal(applyOverride({backstory: 'a'}, null).backstory, 'a');
});

test('an everyday person can be edited too, and the largest allowed edit still builds a prompt inside the cap', () => {
  const overrides = new CharacterOverrides({});
  overrides.rows.set('npc-food-vendor-male', Object.freeze({rules: ['Always ask what V wants to eat.']}));
  const vendor = new PersonaBook(rows, {overrides}).persona('npc-food-vendor-male');
  assert.equal(vendor.name, '');
  assert.match(systemHead({persona: vendor}), /^You are an ordinary person/);
  assert.match(systemHead({persona: vendor}), /- Always ask what V wants to eat\./);
  const biggest = readOverride({bio: 'B'.repeat(EDIT_LIMITS.bio), style: 'S'.repeat(EDIT_LIMITS.style), rules: Array.from({length: 10}, (_, i) => `${i}`.padEnd(EDIT_LIMITS.rule, 'r')),
    examples: Array.from({length: 12}, (_, i) => `${i}`.padEnd(EDIT_LIMITS.example, 'e')), memories: Array.from({length: 12}, (_, i) => `${i}`.padEnd(EDIT_LIMITS.memory, 'm'))});
  overrides.rows.set('judy-alvarez', Object.freeze(biggest));
  const head = systemHead({persona: new PersonaBook(rows, {overrides}).persona('judy-alvarez')});
  assert(head.length <= LIMITS.persona + 2000 + 400, `the head is ${head.length} characters`);
  assert.match(head, /OUTPUT RULES/);
});
