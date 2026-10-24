import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, readFile, rm} from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {AddonHost, discoverAddons, validateManifest} from './addons.mjs';
import {AddonContent, CONTENT_NAMES_FILE, CONTENT_POOLS_FILE, validateContent} from './addon-content.mjs';
import {DATA_LIMITS, deriveSummary, insideFolder, loadContentFiles, poolProblems, validateCharacters, validateConvai, validateNamePools} from './addon-content-data.mjs';
import {PersonaBook, systemHead} from './mistral-prompt.mjs';
import {CharacterOverrides} from './character-overrides.mjs';
import {RelationshipRouting} from './relationship-routing.mjs';
import {rosterLookup} from './addons.mjs';
import {validate as scriptPoolProblems} from '../scripts/Build-NpcNamePools.mjs';

// Content packs, the data parts (add-on API 1.1): rewritten characters and names, Convai twins, name pools, the memory flag.
const read = path => readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const pack = (id, content, extra = {}) => ({id, name: `${id[0].toUpperCase()}${id.slice(1)} pack`, version: '1.0.0', requires: '1.1', content, ...extra});
const dirOf = id => `/mods/AiNpcCyberpunkMod${id[0].toUpperCase()}${id.slice(1)}`;
const hostOf = (...manifests) => new AddonHost({addons: manifests.map(value => validateManifest(value, dirOf(value.id)))});
const setSwitches = (host, values) => host.observeSettings(JSON.stringify({version: 1, addons: Object.fromEntries(Object.entries(values).map(([id, on]) => [id, {contentEnabled: on}]))}));
const logs = () => { const lines = []; return Object.assign(message => lines.push(message), {lines}); };
const BACKSTORY = 'A tavern keeper of the old quarter who remembers every face and forgets no debt, and who has opinions about all of them.';
const roster = () => [
  {key: 'judy-alvarez', name: 'Judy Alvarez', aliases: ['Judy'], gender: 'FEMALE', records: ['Character.judy'], backstory: 'Shipped Judy backstory, a braindance editor from Mox.',
    speakingStyleDescription: 'Shipped style.', speakingStyleSampleDialogues: 'Shipped one.\n\nShipped two.'},
  {key: 'jackie-welles', name: 'Jackie Welles', gender: 'MALE', backstory: 'Shipped Jackie backstory, a merc from Heywood and V\'s best friend.', speakingStyleDescription: 'Loud.', speakingStyleSampleDialogues: 'Hey choom.'},
  {key: 'npc-ncpd-male', kind: 'archetype', name: '', backstory: 'Shipped NCPD officer backstory, a patrol cop in a long coat with a short temper.', speakingStyleDescription: '', speakingStyleSampleDialogues: ''},
  {key: 'addon-skippy-gun', kind: 'addon', name: 'Skippy', backstory: 'A gun.'},
];
const medieval = (extra = {}) => pack('medieval', {memory: 'separate', characters: {
  'judy-alvarez': {name: 'Judith of the Dreamweavers', backstory: BACKSTORY, speakingStyleSampleDialogues: 'Well met.\n\nSit, traveller.'},
  'npc-ncpd-male': {backstory: 'A watchman of the city gate, stern and tired, who keeps the peace with a staff and a loud voice.'},
  'addon-skippy-gun': {backstory: 'This line must never be used because add-on speakers are not touched by a pack.'},
  'nobody-here': {backstory: 'A character that the mod does not have, so this entry is left out and logged once.'}}, ...extra});

test('characters: the three texts and the name are checked with the limits of a player\'s edit; the rest of a character cannot be changed', () => {
  const ok = validateCharacters({'judy-alvarez': {name: '  Judith  ', backstory: BACKSTORY, speakingStyleDescription: 'Warm.', speakingStyleSampleDialogues: 'One.\n\n\n\nTwo.'}});
  assert.deepEqual(ok, {'judy-alvarez': {name: 'Judith', backstory: BACKSTORY, speakingStyleDescription: 'Warm.', speakingStyleSampleDialogues: 'One.\n\nTwo.'}});
  assert.deepEqual(validateCharacters([{key: 'jackie-welles', backstory: BACKSTORY}]), {'jackie-welles': {backstory: BACKSTORY}}, 'the rows of characters/roster.json work too');
  const bad = (value, pattern) => assert.throws(() => validateCharacters(value), pattern);
  bad({'judy-alvarez': {gender: 'MALE'}}, /judy-alvarez\.gender cannot be changed by a pack/);
  bad({'judy-alvarez': {records: ['Character.x']}}, /records cannot be changed/);
  bad({'judy-alvarez': {voice: 'x'}}, /voice cannot be changed/);
  bad({'judy-alvarez': {aliases: ['x']}}, /aliases cannot be changed/);
  bad({'Judy Alvarez': {backstory: BACKSTORY}}, /not a profile key/);
  bad(JSON.parse('{"__proto__": {"backstory": "' + BACKSTORY + '"}}'), /not a profile key/);
  bad({'judy-alvarez': {}}, /changes nothing/);
  bad({'judy-alvarez': 'text'}, /must be an object/);
  bad({'judy-alvarez': {name: ' '}}, /name is empty/);
  bad({'judy-alvarez': {name: 'n'.repeat(81)}}, /name is longer than 80/);
  bad({'judy-alvarez': {backstory: 'short'}}, /shorter than 40/);
  bad({'judy-alvarez': {backstory: 'b'.repeat(DATA_LIMITS.bio + 1)}}, /longer than 9000/);
  bad({'judy-alvarez': {backstory: BACKSTORY, speakingStyleDescription: 's'.repeat(DATA_LIMITS.style + 1)}}, /speakingStyleDescription is longer than 1800/);
  bad({'judy-alvarez': {backstory: 5}}, /backstory must be a text/);
  bad({'judy-alvarez': {speakingStyleSampleDialogues: Array.from({length: 21}, (_, index) => `Line ${index}.`).join('\n\n')}}, /more than 20 examples/);
  bad({'judy-alvarez': {speakingStyleSampleDialogues: 'x'.repeat(601)}}, /example longer than 600/);
  bad({'judy-alvarez': {backstory: 'b'.repeat(8000), speakingStyleDescription: 's'.repeat(1700), speakingStyleSampleDialogues: Array.from({length: 10}, () => 'e'.repeat(590)).join('\n\n')}}, /characters in all/);
  bad(Object.fromEntries(Array.from({length: DATA_LIMITS.characters + 1}, (_, index) => [`key-${index}`, {name: 'N'}])), /more than 512 characters/);
  bad([{backstory: BACKSTORY}], /must be an object with a key/);
  bad([{key: 'judy-alvarez', backstory: BACKSTORY}, {key: 'judy-alvarez', name: 'X'}], /listed twice/);
  bad('text', /must be an object of profile keys/);
  // The same through a manifest: inline, and a bad one skips the pack.
  assert.deepEqual(validateManifest(medieval(), dirOf('medieval')).content.characters['npc-ncpd-male'], {backstory: 'A watchman of the city gate, stern and tired, who keeps the peace with a staff and a loud voice.'});
  assert.throws(() => validateManifest(pack('medieval', {characters: {'judy-alvarez': {gender: 'MALE'}}}), dirOf('medieval')), /gender cannot be changed/);
});

test('summary: an optional pack text with its own cap, kept as given; one is made from the backstory when a pack gives none, and published next to the names', async () => {
  assert.deepEqual(validateCharacters({'judy-alvarez': {summary: '  Judith,   keeper of the\nDreamweavers.  '}}), {'judy-alvarez': {summary: 'Judith, keeper of the\nDreamweavers.'}}, 'a summary alone changes something');
  const bad = (value, pattern) => assert.throws(() => validateCharacters(value), pattern);
  bad({'judy-alvarez': {summary: ' '}}, /summary is empty/);
  bad({'judy-alvarez': {summary: 5}}, /summary must be a text/);
  bad({'judy-alvarez': {summary: 's'.repeat(DATA_LIMITS.summary + 1)}}, /summary is longer than 1300/);
  assert.equal(validateCharacters({'judy-alvarez': {summary: 's'.repeat(DATA_LIMITS.summary)}})['judy-alvarez'].summary.length, DATA_LIMITS.summary);
  // Derived: the first one or two sentences, without the profile marker and bracketed tags, capped.
  const text = "I am Aaron of Dogtown, a boxer. Fighting offers a road [fight]. A third sentence stays out.\n\n[CyberpunkConvai profile v2:aaron-waines]";
  assert.equal(deriveSummary(text), 'I am Aaron of Dogtown, a boxer. Fighting offers a road.');
  assert.equal(deriveSummary('Dr. Smith went home with Mr. Jones. He slept. And more.'), 'Dr. Smith went home with Mr. Jones. He slept.');
  assert.equal(deriveSummary('[CyberpunkConvai profile v2:x]'), '');
  const long = deriveSummary('Word '.repeat(300));
  assert.ok(Array.from(long).length <= DATA_LIMITS.derivedSummary && long.endsWith('Word...'), long.slice(-20));
  assert.equal(deriveSummary(`A${'a'.repeat(299)}. B${'b'.repeat(299)}. Tail.`), `A${'a'.repeat(299)}.`, 'the second sentence only while both fit');
  // Published: the pack's own summary wins over a derived one; a pack with a summary only is listed.
  const dir = await mkdtemp(resolve(tmpdir(), 'convai-publish-'));
  try {
    const own = pack('own', {characters: {'judy-alvarez': {name: 'Judith', summary: 'Judith keeps the guild.', backstory: BACKSTORY}, 'jackie-welles': {name: 'Jack'}}});
    const only = pack('only', {characters: {'jackie-welles': {summary: 'A knight of the road.'}}});
    await new AddonContent({host: hostOf(own, only)}).publish(dir);
    assert.deepEqual(JSON.parse(await readFile(resolve(dir, CONTENT_NAMES_FILE), 'utf8')), {version: 1, packs: [
      {id: 'only', names: {}, summaries: {'jackie-welles': 'A knight of the road.'}},
      {id: 'own', names: {'judy-alvarez': 'Judith', 'jackie-welles': 'Jack'}, summaries: {'judy-alvarez': 'Judith keeps the guild.'}}]});
    // A name-only pack keeps the old file format: no summaries field.
    await new AddonContent({host: hostOf(pack('names', {characters: {'jackie-welles': {name: 'Jack'}}}))}).publish(dir);
    assert.deepEqual(JSON.parse(await readFile(resolve(dir, CONTENT_NAMES_FILE), 'utf8')), {version: 1, packs: [{id: 'names', names: {'jackie-welles': 'Jack'}}]});
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test('characters in a file: the path stays inside the pack folder, the file is checked whole before anything is used, a bad one skips the pack cleanly', async () => {
  for (const path of ['../characters.json', '/etc/x.json', 'C:/x.json', 'a/../../x.json', 'characters.txt', '', '.', './x.json']) assert.equal(insideFolder('/mods/Pack', path), null, path);
  assert.ok(insideFolder('/mods/Pack', 'characters.json').endsWith('characters.json'));
  assert.ok(insideFolder('/mods/Pack', 'data/characters.json'));
  assert.throws(() => validateContent({characters: '../x.json'}, {dir: '/mods/Pack'}), /must be a \.json file path inside the add-on folder/);
  assert.throws(() => validateContent({characters: 'characters.json'}), /must be a \.json file path inside/, 'without a folder there is no file');
  const mods = await mkdtemp(resolve(tmpdir(), 'convai-content-files-'));
  try {
    const put = async (name, files) => { const dir = resolve(mods, name); await mkdir(dir, {recursive: true}); for (const [file, text] of Object.entries(files)) await writeFile(resolve(dir, file), text); return dir; };
    const good = {'judy-alvarez': {name: 'Judith', backstory: BACKSTORY}};
    await put('AiNpcCyberpunkModGood', {'convai-addon.json': JSON.stringify(pack('good', {characters: 'characters.json'})), 'characters.json': JSON.stringify(good)});
    await put('AiNpcCyberpunkModBadjson', {'convai-addon.json': JSON.stringify(pack('badjson', {characters: 'characters.json'})), 'characters.json': '{ not json'});
    await put('AiNpcCyberpunkModBadfield', {'convai-addon.json': JSON.stringify(pack('badfield', {characters: 'characters.json'})), 'characters.json': JSON.stringify({'judy-alvarez': {voice: 'x'}})});
    await put('AiNpcCyberpunkModMissing', {'convai-addon.json': JSON.stringify(pack('missing', {characters: 'characters.json'}))});
    await put('AiNpcCyberpunkModHuge', {'convai-addon.json': JSON.stringify(pack('huge', {characters: 'characters.json'})), 'characters.json': JSON.stringify({'judy-alvarez': {backstory: 'x'.repeat(DATA_LIMITS.charactersFile)}})});
    await put('AiNpcCyberpunkModEscape', {'convai-addon.json': JSON.stringify(pack('escape', {characters: '../AiNpcCyberpunkModGood/characters.json'}))});
    await put('AiNpcCyberpunkModBom', {'convai-addon.json': JSON.stringify(pack('bom', {characters: 'characters.json'})), 'characters.json': '\uFEFF' + JSON.stringify(good)});
    const found = await discoverAddons({roots: [{path: mods, children: true}]});
    assert.deepEqual(found.addons.map(addon => addon.id).sort(), ['bom', 'good']);
    assert.deepEqual(found.addons.find(addon => addon.id === 'good').content.characters, good);
    assert.equal(found.addons.find(addon => addon.id === 'good').content.files.characters.endsWith('characters.json'), true);
    const reasons = Object.fromEntries(found.problems.map(item => [item.id, item.reason]));
    assert.match(reasons.badjson, /^content\.characters: the file characters\.json is not valid JSON$/);
    assert.match(reasons.badfield, /judy-alvarez\.voice cannot be changed/);
    assert.match(reasons.missing, /the file characters\.json cannot be read/);
    assert.match(reasons.huge, /is larger than 3072 KB/);
    assert.match(reasons.escape, /must be a \.json file path inside the add-on folder/);
    assert.ok(found.problems.every(item => item.status === 'invalid'));
    // The game is told once for each; the others still load.
    assert.equal(new AddonHost(found).status().addons.filter(item => item.status === 'invalid').length, 5);
    assert.deepEqual(Object.keys(await loadContentFiles({files: {}})), ['files']);
  } finally { await rm(mods, {recursive: true, force: true}); }
});

test('a pack\'s text is the character\'s persona (Mistral, Local AI, Custom), the player\'s own edits still win, and switching the pack off puts everything back', async () => {
  const host = hostOf(medieval()), lines = logs();
  const content = new AddonContent({host, log: lines});
  const rows = roster();
  const shipped = JSON.parse(JSON.stringify(rows));
  const overrides = await CharacterOverrides.open({});
  const book = new PersonaBook(rows, {overrides});
  const before = book.persona('judy-alvarez');
  content.bindRoster(rows);
  const on = book.persona('judy-alvarez');
  assert.equal(on.name, 'Judith of the Dreamweavers');
  assert.equal(on.backstory, BACKSTORY);
  assert.deepEqual(on.samples, ['Well met.', 'Sit, traveller.']);
  assert.equal(on.style, 'Shipped style.', 'a field the pack does not give stays the shipped one');
  assert.equal(book.persona('judy-alvarez').backstory, on.backstory, 'the same text on every turn');
  assert.equal(book.persona('npc-ncpd-male').backstory, 'A watchman of the city gate, stern and tired, who keeps the peace with a staff and a loud voice.', 'an archetype key too');
  assert.equal(book.persona('jackie-welles').backstory, shipped[1].backstory, 'a character no pack lists is untouched');
  assert.equal(rows[3].backstory, 'A gun.', 'an add-on speaker is never touched');
  assert.match(systemHead({persona: on}), /You are Judith of the Dreamweavers/);
  assert.match(systemHead({persona: on}), /tavern keeper of the old quarter/);
  assert.doesNotMatch(systemHead({persona: on}), /Judy Alvarez/);
  // The old name stays an alias, so what V says or types is still recognised.
  assert.deepEqual(rows[0].aliases, ['Judy', 'Judy Alvarez']);
  const lookup = rosterLookup(rows);
  host.characterLookup = lookup;
  assert.equal(lookup('Judy Alvarez').key, 'judy-alvarez');
  assert.equal(lookup('Judith of the Dreamweavers').key, 'judy-alvarez');
  assert.equal(lookup('judy').key, 'judy-alvarez');
  // The player's own edit wins over the pack, field by field.
  await overrides.set('judy-alvarez', {bio: 'The player wrote this bio of Judy, which is long enough to be accepted by the limits of the editor.'});
  const mine = book.persona('judy-alvarez');
  assert.match(mine.backstory, /The player wrote this bio/);
  assert.deepEqual(mine.samples, ['Well met.', 'Sit, traveller.'], 'what the player did not edit is the pack\'s');
  assert.equal(mine.name, 'Judith of the Dreamweavers');
  // Off: the shipped rows, field for field.
  setSwitches(host, {medieval: false});
  assert.deepEqual(JSON.parse(JSON.stringify(rows)), shipped);
  assert.equal(book.persona('npc-ncpd-male').backstory, shipped[2].backstory);
  assert.deepEqual(book.persona('judy-alvarez').samples, before.samples);
  assert.equal(book.persona('judy-alvarez').name, 'Judy Alvarez');
  assert.equal(lookup('Judith of the Dreamweavers'), null, 'the lookup is rebuilt: the new name is gone');
  assert.equal(lookup('Judy').key, 'judy-alvarez');
  await overrides.reset('judy-alvarez');
  assert.equal(book.persona('judy-alvarez').backstory, shipped[0].backstory);
  // On again, and an unknown key is said once.
  setSwitches(host, {medieval: true});
  assert.equal(book.persona('judy-alvarez').name, 'Judith of the Dreamweavers');
  assert.equal(lines.lines.filter(line => /names nobody-here, which is not a character of the mod/.test(line)).length, 1);
});

test('two packs: a later one wins per field and per name; the shipped name is the alias, not the first pack\'s', () => {
  const a = pack('alpha', {characters: {'judy-alvarez': {name: 'Alpha Judy', backstory: BACKSTORY, speakingStyleDescription: 'Alpha style.'}}});
  const b = pack('beta', {characters: {'judy-alvarez': {name: 'Beta Judy', speakingStyleDescription: 'Beta style.'}}});
  const rows = roster(), host = hostOf(b, a);
  const content = new AddonContent({host});
  content.bindRoster(rows);
  assert.equal(rows[0].name, 'Beta Judy');
  assert.equal(rows[0].backstory, BACKSTORY);
  assert.equal(rows[0].speakingStyleDescription, 'Beta style.');
  assert.deepEqual(rows[0].aliases, ['Judy', 'Judy Alvarez']);
  setSwitches(host, {beta: false});
  assert.equal(rows[0].name, 'Alpha Judy');
  assert.equal(rows[0].speakingStyleDescription, 'Alpha style.');
  setSwitches(host, {beta: false, alpha: false});
  assert.equal(rows[0].name, 'Judy Alvarez');
  assert.deepEqual(rows[0].aliases, ['Judy']);
  assert.equal(rows[0].speakingStyleDescription, 'Shipped style.');
});

test('no pack, or a pack without characters: the roster is never touched', () => {
  const rows = roster(), copy = JSON.parse(JSON.stringify(rows));
  new AddonContent({host: new AddonHost()}).bindRoster(rows);
  new AddonContent({host: hostOf(pack('quiet', {worldRules: ['One.']}))}).bindRoster(rows);
  assert.deepEqual(rows, copy);
  assert.ok(rows.every(row => !Object.getOwnPropertySymbols(row).length), 'not even a bookkeeping field');
});

test('Convai twins: used while the pack is on, a key without a twin keeps its character, the multilingual twin wins for a turn in another language, off goes back', () => {
  const ids = {'judy-alvarez': 'id-judy', 'jackie-welles': 'id-jackie', 'panam-palmer': 'id-panam'};
  const host = hostOf(medieval({convai: {'judy-alvarez': 'id-judy-medieval', 'jackie-welles': 'id-jackie-medieval'}}));
  const lines = logs();
  const content = new AddonContent({host, log: lines});
  const twins = content.convaiTwins({ids, taken: ['id-judy-ml']});
  assert.deepEqual(twins.map(twin => [twin.profileKey, twin.key, twin.characterId]), [['judy-alvarez', 'judy-alvarez-medieval', 'id-judy-medieval'], ['jackie-welles', 'jackie-welles-medieval', 'id-jackie-medieval']]);
  let own = false;   // the player's own key has no twins (keys.singleSession)
  const routes = new RelationshipRouting({ordinaryIds: ids, multilingual: {'judy-alvarez': 'id-judy-ml'}, packTwins: twins, packTwinFor: key => (own ? null : content.twinFor(key))});
  const pick = (key, multilingual) => routes.select(key, null, {multilingual});
  assert.equal(pick('judy-alvarez').characterId, 'id-judy-medieval');
  assert.equal(pick('judy-alvarez').providerProfileKey, 'judy-alvarez-medieval');
  assert.equal(pick('jackie-welles').characterId, 'id-jackie-medieval');
  assert.equal(pick('panam-palmer').characterId, 'id-panam', 'a key without a twin falls back to the ordinary Convai character');
  assert.equal(pick('judy-alvarez', true).characterId, 'id-judy-ml', 'a turn in another language goes to the multilingual twin, which answers in the player\'s language');
  assert.equal(pick('jackie-welles', true).characterId, 'id-jackie-medieval', 'no multilingual twin: the pack\'s');
  // The registry knows the twins as siblings of the original (memory guards, Forget).
  assert.equal(routes.providerIds['judy-alvarez-medieval'], 'id-judy-medieval');
  assert.equal(routes.providerFamilies['judy-alvarez-medieval'], 'judy-alvarez');
  assert.equal(routes.markerKeys['judy-alvarez-medieval'], 'judy-alvarez:medieval');
  assert.equal(routes.providerKeyForGuard('judy-alvarez', {characterId: 'id-judy-medieval'}), 'judy-alvarez-medieval');
  assert.equal(routes.guardSelected('judy-alvarez', {characterId: 'id-judy-medieval'}, null), true);
  assert.ok(routes.routedProfiles.includes('judy-alvarez') && routes.routedProfiles.includes('jackie-welles'));
  // Off: the normal charIDs. A change of the route is noticed by the next settings poll (connections are retired for the characters whose route changed).
  routes.update(undefined, undefined, {boundary: null});
  setSwitches(host, {medieval: false});
  assert.equal(pick('judy-alvarez').characterId, 'id-judy');
  assert.equal(pick('jackie-welles').characterId, 'id-jackie');
  assert.equal(routes.update(undefined, undefined, {boundary: null}), true);
  assert.deepEqual(routes.consumeRouteChanges().sort(), ['jackie-welles', 'judy-alvarez']);
  setSwitches(host, {medieval: true});
  assert.equal(pick('judy-alvarez').characterId, 'id-judy-medieval');
  own = true;
  assert.equal(pick('judy-alvarez').characterId, 'id-judy', 'a player on their own Convai key has no twins');
  // A twin that cannot be used is left out with one line, and never stops the bridge.
  const odd = new AddonContent({host: hostOf(pack('odd', {convai: {'nobody-here': 'id-x', 'judy-alvarez': 'id-jackie', 'jackie-welles': 'id-fine'}})), log: lines});
  assert.deepEqual(odd.convaiTwins({ids}).map(twin => twin.key), ['jackie-welles-odd']);
  assert.ok(lines.lines.some(line => /twin of nobody-here is not used: the mod has no Convai character for that key/.test(line)));
  assert.ok(lines.lines.some(line => /twin of judy-alvarez is not used: another character already uses that id/.test(line)));
  assert.throws(() => validateConvai({'judy-alvarez': 'id with spaces'}), /not a Convai character id/);
  assert.throws(() => validateConvai({'judy-alvarez': 'same', 'jackie-welles': 'same'}), /repeats a character id/);
  assert.throws(() => validateConvai([]), /must be an object/);
  // Without any twin the routing is exactly what it was.
  const plain = new RelationshipRouting({ordinaryIds: ids, multilingual: {}});
  assert.equal(plain.select('judy-alvarez', null).characterId, 'id-judy');
  assert.deepEqual(plain.routedProfiles, []);
  // The bridge wires it for the shared plan only.
  const bridge = read('./convai-bridge.mjs');
  assert.match(bridge, /packTwinFor: profileKey => \(keys\.singleSession \? null : addonContent\.twinFor\(profileKey\)\)/);
});

test('name pools: the rules of the shipped pools, the shipped data passes, and a broken pack is skipped cleanly', async () => {
  const shipped = JSON.parse(read('../characters/npc-name-pools.json'));
  assert.deepEqual(poolProblems(shipped), []);
  assert.deepEqual(scriptPoolProblems(shipped), []);
  const broken = structuredClone(shipped);
  delete broken.cultures.latino;
  broken.cultures.arabic.male = broken.cultures.arabic.male.slice(0, 5);
  broken.cultures.chinese.female.push('Not 1 name');
  broken.handleStyles.nomad.push(shipped.blockedFullNames[0]);
  broken.handleStyles.extra = ['X'];
  assert.deepEqual(poolProblems(broken).sort(), scriptPoolProblems(broken).sort(), 'the same problems as scripts/Build-NpcNamePools.mjs finds');
  assert.equal(poolProblems(broken).length > 3, true);
  assert.throws(() => validateNamePools(broken), /content\.namePools: .*missing culture latino/);
  assert.equal(validateNamePools(shipped).cultures.latino.male.length, shipped.cultures.latino.male.length);
  assert.throws(() => validateNamePools('text'), /not an object/);
  // Inline in the manifest, and through a file.
  assert.equal(Object.keys(validateManifest(pack('names', {namePools: shipped}), dirOf('names')).content.namePools.cultures).length, 16);
  assert.throws(() => validateManifest(pack('names', {namePools: broken}), dirOf('names')), /missing culture latino/);
  const dir = await mkdtemp(resolve(tmpdir(), 'convai-pools-'));
  try {
    await writeFile(resolve(dir, 'convai-addon.json'), JSON.stringify(pack('names', {namePools: 'pools.json'})));
    await writeFile(resolve(dir, 'pools.json'), JSON.stringify(broken));
    const found = await discoverAddons({roots: [{path: dir, children: false}]});
    assert.equal(found.addons.length, 0);
    assert.match(found.problems[0].reason, /^content\.namePools \(pools\.json\): .*missing culture latino/);
    await writeFile(resolve(dir, 'pools.json'), JSON.stringify(shipped));
    const again = await discoverAddons({roots: [{path: dir, children: false}]});
    assert.equal(again.addons[0].content.namePools.blockedFullNames.length, shipped.blockedFullNames.length);
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test('the files for the game: new names and name pools of every installed pack, nothing without them, a stale file emptied', async () => {
  const dir = await mkdtemp(resolve(tmpdir(), 'convai-publish-'));
  try {
    const shipped = JSON.parse(read('../characters/npc-name-pools.json'));
    const host = hostOf(medieval(), pack('plain', {worldRules: ['One.']}), pack('pools', {namePools: shipped}));
    const content = new AddonContent({host});
    await content.publish(dir);
    const names = JSON.parse(await readFile(resolve(dir, CONTENT_NAMES_FILE), 'utf8'));
    // The summaries ride along: no pack summary here, so each is made from the pack's backstory (one sentence each).
    assert.deepEqual(names, {version: 1, packs: [{id: 'medieval', names: {'judy-alvarez': 'Judith of the Dreamweavers'}, summaries: {'judy-alvarez': BACKSTORY,
      'npc-ncpd-male': 'A watchman of the city gate, stern and tired, who keeps the peace with a staff and a loud voice.',
      'addon-skippy-gun': 'This line must never be used because add-on speakers are not touched by a pack.',
      'nobody-here': 'A character that the mod does not have, so this entry is left out and logged once.'}}]});
    const pools = JSON.parse(await readFile(resolve(dir, CONTENT_POOLS_FILE), 'utf8'));
    assert.deepEqual(pools.packs.map(item => item.id), ['pools']);
    assert.equal(pools.packs[0].pools.cultures.latino.male.length, shipped.cultures.latino.male.length);
    setSwitches(host, {medieval: false});
    await content.publish(dir);
    assert.equal(JSON.parse(await readFile(resolve(dir, CONTENT_NAMES_FILE), 'utf8')).packs.length, 1, 'switched-off packs are listed too: the game applies its own switches');
    // Nothing to say: a file an earlier run left is emptied; no file is created.
    const empty = await mkdtemp(resolve(tmpdir(), 'convai-publish-'));
    try {
      await writeFile(resolve(empty, CONTENT_NAMES_FILE), '{"old":1}');
      await new AddonContent({host: hostOf(pack('plain', {worldRules: ['One.']}))}).publish(empty);
      assert.equal(await readFile(resolve(empty, CONTENT_NAMES_FILE), 'utf8'), '');
      await assert.rejects(readFile(resolve(empty, CONTENT_POOLS_FILE), 'utf8'), /ENOENT/);
    } finally { await rm(empty, {recursive: true, force: true}); }
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test('the memory flag: shared by default, separate names the pack, the last switched-on pack wins, off is the normal key', () => {
  assert.equal(validateManifest(pack('quiet', {worldRules: ['One.']}), dirOf('quiet')).content.memory, 'shared');
  assert.throws(() => validateManifest(pack('bad', {memory: 'yes'}), dirOf('bad')), /content\.memory must be "shared" or "separate"/);
  const host = hostOf(medieval(), pack('zeta', {memory: 'separate', worldRules: ['One.']}));
  const content = new AddonContent({host});
  assert.equal(content.memoryScope(), 'zeta');
  assert.equal(content.memoryKey('judy-alvarez'), 'judy-alvarez@zeta');
  assert.equal(content.memoryKey('judy-alvarez@zeta'), 'judy-alvarez@zeta', 'never doubled');
  setSwitches(host, {zeta: false});
  assert.equal(content.memoryKey('judy-alvarez'), 'judy-alvarez@medieval');
  setSwitches(host, {zeta: false, medieval: false});
  assert.equal(content.memoryScope(), null);
  assert.equal(content.memoryKey('judy-alvarez'), 'judy-alvarez');
  assert.equal(new AddonContent({host: hostOf(pack('shared', {worldRules: ['One.']}))}).memoryKey('judy-alvarez'), 'judy-alvarez');
});

test('content packs know no game version: no game field, one zip, no per-game suffix, and the setup check never reads an add-on', async () => {
  // A `game` (or any other unknown) field in a pack is not a check and not an error: the same manifest is valid for every game.
  const withGame = {...pack('medieval', {worldRules: ['One.']}), game: '2.5', gameVersion: '2.31'};
  assert.deepEqual(validateManifest(withGame, dirOf('medieval')).content.worldRules, ['One.']);
  assert.equal(JSON.stringify(validateManifest(pack('medieval', {worldRules: ['One.']}), dirOf('medieval'))).includes('"game"'), false);
  // The validators never ask which game runs: nothing in the add-on and content modules reads a game version.
  for (const file of ['./addons.mjs', './addon-content.mjs', './addon-content-data.mjs', '../packaging/build-addon.mjs']) {
    assert.doesNotMatch(read(file), /gameVersion|GetGameVersion|game-variants|for-2\.31|exeVersion/, file);
  }
  // The add-on packaging has no per-game build and no suffix; the variants file talks about the main mod's packages only.
  const build = read('../packaging/build-addon.mjs');
  assert.doesNotMatch(build, /--game|suffix/);
  const variants = JSON.parse(read('../packaging/game-variants.json'));
  assert.doesNotMatch(JSON.stringify(variants), /addon|content pack/i);
  // The game-side setup check (the game mismatch notice) and the error reports look at the main mod's files and versions, never at add-on folders.
  for (const file of ['../mod/setup-check.lua', '../mod/error-reports.lua', '../bridge/setup-check.mjs']) {
    let text = '';
    try { text = read(file); } catch { continue; }
    assert.doesNotMatch(text, /convai-addon|addons-status|AiNpcCyberpunkMod[A-Z]|contentPacks/, file);
  }
  // One download for both games: the pack's zip name and folder carry no game.
  const { addonArchiveName, addonFolderName } = await import('../packaging/build-addon.mjs');
  assert.equal(addonArchiveName({id: 'medieval', version: '1.0.0'}), 'AI-NPC-Cyberpunk-Mod-Medieval-1.0.0');
  assert.equal(addonFolderName('medieval'), 'AiNpcCyberpunkModMedieval');
});
