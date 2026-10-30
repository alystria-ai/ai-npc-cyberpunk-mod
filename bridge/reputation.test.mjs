// Street reputation (docs/REPUTATION_DESIGN.md): the bridge's model (groups, quest rows, deeds, witness, decay, caps, the words, the store and
// its rollback guard), the gates that keep it to ordinary NPCs, the game side (mod/reputation.lua through fengari: nothing while off, the
// hooks, the ring, the flush) and the setting (off by default).
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {
  ambientProfile, groupFor, districtKey, QUEST_ROWS, gigDistrict, storyStanding, LIFEPATH_SEEDS, normalizeEvent, effectsOf, deedStanding,
  standingOf, describeStanding, tierOf, fameOf, parseReputationSnapshot, reputationApplies, ReputationStore, addDeeds, forgetFuture,
  bookOf, DAY, MAX_CHARS, HEADER, LIMITS, recognisesV, saysOwnName,
} from './reputation.mjs';
import {isAmbientProfile, parseInput} from './protocol.mjs';
import {run, managerLua, modSource} from './startup-lua-fixture.mjs';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const pack = JSON.parse(read('../characters/world-knowledge.json'));
const archetypes = JSON.parse(read('../characters/archetypes.json'));

const known = (value, extra = {}) => ({status: 'known', value, present: true, sourceId: 's', evidenceRefs: ['e'], ...extra});
const world = ({facts = {}, journal = {}} = {}) => ({status: 'ready', facts: Object.fromEntries(Object.entries(facts).map(([k, v]) => [k, known(v)])),
  journal: Object.fromEntries(Object.entries(journal).map(([k, v]) => [k, {status: 'known', value: v, revealed: true, questKey: k.split('.').slice(0, 2).join('.')}]))});

// ------------------------------------------------------------------------------------------------------------------------- groups
test('the ambient rule is the protocol\'s, and every archetype base has a group or is a resident or a merc', () => {
  for (const key of ['resident-male', 'resident-female', 'npc-maelstrom-male', 'judy-alvarez', 'npc-', 'NPC-x', 'johnny-silverhand', 7, null]) {
    assert.equal(ambientProfile(key), isAmbientProfile(key), String(key));
  }
  for (const [base, row] of Object.entries(archetypes.bases)) {
    const group = groupFor({base, category: row.category, affiliation: row.match.affiliations?.[0]}, 'Watson');
    if (base === 'merc') assert.equal(group, null);
    else assert.ok(typeof group === 'string' && group.length, `${base} has a group`);
  }
});

test('groups: gangs, nomads, police, corporate guards by employer, residents by district, Dogtown on its own', () => {
  assert.equal(groupFor({base: 'maelstrom', category: 'gang'}), 'maelstrom');
  assert.equal(groupFor({base: 'nomad-resident', category: 'resident'}, 'Badlands'), 'aldecaldos');
  assert.equal(groupFor({base: 'maxtac', category: 'police'}), 'ncpd');
  assert.equal(groupFor({base: 'corpo-security', category: 'corpo-security', affiliation: 'Arasaka'}), 'arasaka');
  assert.equal(groupFor({base: 'corpo-security', category: 'corpo-security', affiliation: 'Zetatech'}), 'corpo');
  assert.equal(groupFor({base: 'street-resident', category: 'resident', district: 'Watson'}), 'residents:Watson');
  assert.equal(groupFor({base: 'ripperdoc', category: 'vendor'}, 'Santo Domingo'), 'residents:SantoDomingo');
  assert.equal(groupFor({base: 'dogtown-resident', category: 'resident', district: 'Pacifica', area: 'Dogtown'}), 'residents:Dogtown');
  assert.equal(groupFor({base: 'street-resident', category: 'resident'}), null, 'no district: no regional standing');
  assert.equal(groupFor({base: 'merc', category: 'faction'}), null);
  assert.equal(districtKey('Santo Domingo'), 'SantoDomingo');
});

// ------------------------------------------------------------------------------------------------------------------- the story part
test('every quest row reads an allowlisted fact or journal entry the game already scans', () => {
  const keys = [];
  const walk = node => node.all ? node.all.forEach(walk) : keys.push(node);
  for (const row of QUEST_ROWS) {
    walk(row.when);
    assert.ok(row.said.length > 8 && row.said.length < 80 && /^V /.test(row.said), row.said);
    for (const group of Object.keys(row.effects)) assert.ok(typeof group === 'string' && !group.includes(' '), group);
  }
  for (const node of keys) {
    const allow = node.type === 'fact' ? pack.factAllowlist : pack.journalAllowlist;
    assert.ok(Object.hasOwn(allow, node.key), `${node.type} ${node.key} is allowlisted`);
  }
  // Every allowlisted fixer gig maps to a district.
  const gigs = Object.keys(pack.journalAllowlist).filter(key => gigDistrict(key));
  assert.ok(gigs.length >= 60, `${gigs.length} gigs`);
  assert.equal(gigDistrict('fr5.bloodsport.quest'), 'Watson');
  assert.equal(gigDistrict('fo5.jpn01.quest'), 'Westbrook');
  assert.equal(gigDistrict('pg5.saints.completed'), 'Dogtown');
  assert.equal(gigDistrict('ah5.pickup.completed'), null);
});

test('story standing: facts count only when known and present, quest points are capped, gigs count once per quest, the lifepath seeds', () => {
  const story = storyStanding(world({facts: {q003_deal_royce_shoot: 1, q003_no_deal: 1, q003_paid_maelstrom: 0},
    journal: {'fr5.bloodsport.quest': 'succeeded', 'fixers.sts-wat-kab-01.quest': 'succeeded', 'fo5.jpn01.quest': 'active'}}), 'nomad');
  assert.equal(story.maelstrom.points, -20);
  assert.deepEqual(story.maelstrom.reasons.map(r => r.said).sort(), ['V shot Royce at All Foods', 'V shot up the Maelstrom deal at All Foods']);
  assert.equal(story['residents:Watson'].points, 4, 'two Watson gigs, +2 each');
  assert.equal(story['residents:Westbrook'], undefined, 'an active gig is not finished');
  assert.equal(story.aldecaldos.points, LIFEPATH_SEEDS.nomad.effects.aldecaldos);
  const unknown = storyStanding({status: 'ready', facts: {q003_deal_royce_shoot: {status: 'known', value: 1, present: 'unknown'}}, journal: {}});
  assert.equal(unknown.maelstrom, undefined, 'presence unknown is not proof');
  const many = Object.fromEntries(['q003_militech_virus_uploaded', 'q003_no_deal', 'q003_deal_royce_shoot', 'q003_dumdum_dead', 'sq011_patricia_combat_path',
    'q003_deal_royce_knocked_out'].map(key => [key, 1]));
  assert.equal(storyStanding(world({facts: many})).maelstrom.points, -50);
  assert.equal(storyStanding(world({facts: {...many, q003_militech_refused: 1}})).militech.points, 0);
  assert.equal(storyStanding(world({facts: {sq026_side_judy: 1}}))['tyger-claws'], undefined, 'both facts of an all-row are needed');
});

// -------------------------------------------------------------------------------------------------------------------------- deeds
const lua = (k, extra = {}) => ({k, s: 1, t: 10 * DAY, d: 'Watson', ...extra});
test('the game\'s deeds: police, affiliation and crowd decide the group, bad rows are dropped', () => {
  assert.deepEqual(normalizeEvent(lua('kill', {a: 'Maelstrom', w: true})), {k: 'kill', d: 'Watson', t: 10 * DAY, s: 1, a: 'maelstrom', x: '', w: true});
  assert.equal(normalizeEvent(lua('kill', {a: 'Maelstrom', p: true})).a, 'ncpd');
  assert.equal(normalizeEvent(lua('kill', {c: true, a: 'Civilian'})).a, 'residents:Watson');
  assert.equal(normalizeEvent(lua('kill', {a: 'Unknown'})), null, 'an unknown, non-crowd person is not counted');
  assert.equal(normalizeEvent(lua('heat', {x: 'start'})).a, 'ncpd');
  assert.equal(normalizeEvent(lua('heat', {x: 'boom'})), null);
  assert.equal(normalizeEvent(lua('react', {x: 'attack', b: 'tyger-claws', g: 'gang'})).a, 'tyger-claws');
  assert.equal(normalizeEvent(lua('react', {x: 'call-police', b: 'street-resident', g: 'resident'})).a, 'residents:Watson');
  assert.equal(normalizeEvent(lua('talk', {a: 'maelstrom'})), null, 'talk is counted by the bridge, never sent');
  assert.equal(normalizeEvent({...lua('kill', {a: 'Maelstrom'}), s: 0}), null);
  assert.equal(normalizeEvent(lua('kill', {a: 'Maelstrom', lp: 'nomad'})).lp, 'nomad');
});

const bucket = (k, a, extra = {}) => ({k, a, x: '', d: 'Watson', day: 10, w: true, n: 1, t: 10 * DAY + 100, ...extra});
test('witness rule: an open-fight kill counts at once, a quiet one only as a rumour a day later; residents hear after an hour', () => {
  const now = 10 * DAY + 200;
  assert.equal(deedStanding([bucket('kill', 'maelstrom')], now).maelstrom.points.toFixed(1), (-6 * 0.5 ** ((now / DAY - 10.5 < 0 ? 0 : now / DAY - 10.5) / 14)).toFixed(1));
  assert.equal(deedStanding([bucket('kill', 'maelstrom', {w: false})], now).maelstrom, undefined, 'nobody saw it yet');
  const later = deedStanding([bucket('kill', 'maelstrom', {w: false})], 11 * DAY + 200).maelstrom.points;
  assert.ok(later < 0 && later > -1, 'a day later: a small rumour');
  const civilian = bucket('kill', 'residents:Watson');
  assert.equal(deedStanding([civilian], now)['residents:Watson'], undefined, 'the neighbourhood has not heard yet');
  assert.ok(deedStanding([civilian], now).ncpd.points < 0, 'the police know at once');
  assert.ok(deedStanding([civilian], now + 3600)['residents:Watson'].points <= -7);
  assert.ok(deedStanding([bucket('kill', 'valentinos')], now)['sixth-street'].points > 0, 'a rival is pleased');
  assert.ok(deedStanding([bucket('kill', 'valentinos')], now).ncpd.points > 0, 'gangers off the street');
  assert.equal(deedStanding([bucket('defeat', 'maelstrom', {w: false})], now).maelstrom, undefined, 'an unseen takedown is nothing');
});

test('caps and decay: a massacre is capped per game day, deeds fade with a 14-day half-life (7 for talk), talk is small', () => {
  const day = 10, noon = (day + 0.5) * DAY;
  assert.equal(deedStanding([bucket('kill', 'maelstrom', {n: 30})], noon).maelstrom.points, -20);
  assert.equal(deedStanding([bucket('kill', 'maelstrom', {n: 30})], noon + 14 * DAY).maelstrom.points, -10);
  assert.equal(deedStanding([bucket('talk', 'maelstrom', {n: 1})], noon).maelstrom.points, 2);
  assert.equal(deedStanding([bucket('talk', 'maelstrom', {n: 10})], noon).maelstrom.points, 6, 'talk is capped too');
  assert.equal(deedStanding([bucket('talk', 'maelstrom', {n: 1})], noon + 7 * DAY).maelstrom.points, 1);
  assert.equal(deedStanding([bucket('kill', 'maelstrom', {n: 3})], noon + 100 * DAY).maelstrom, undefined, 'faded out completely');
  // Two days of fighting add up; each is capped on its own.
  const two = deedStanding([bucket('kill', 'maelstrom', {n: 10}), bucket('kill', 'maelstrom', {n: 10, day: 11, t: 11 * DAY})], 11.5 * DAY);
  assert.ok(two.maelstrom.points < -35 && two.maelstrom.points > -40, String(two.maelstrom.points));
  assert.ok(effectsOf(bucket('heat', 'ncpd', {x: 'start'})).some(e => e.group === 'residents:Watson' && e.delay === 3600));
});

// ---------------------------------------------------------------------------------------------------------------------- the words
test('the words: nothing for a neutral nobody, one line for a known name, two short lines for a standing, fear for a feared V', () => {
  assert.equal(describeStanding({group: 'maelstrom', standing: 5, reasons: []}), '');
  assert.equal(describeStanding({group: null, cred: 3}), '');
  assert.match(describeStanding({group: null, cred: 24}), /^STREET STANDING .*V is a known merc \(Street Cred 24\)\. You know nothing else about V\.$/);
  const text = describeStanding({group: 'maelstrom', standing: -60, cred: 40,
    reasons: [{said: 'V killed Maelstrom in a fight', points: -20}, {said: 'V paid Maelstrom straight at All Foods', points: 10}, {said: 'V shot Royce at All Foods', points: -10}]});
  const lines = text.split('\n');
  assert.equal(lines.length, 2);
  assert.ok(lines[0].startsWith(HEADER) && /V is an enemy/.test(lines[0]) && /scares you/.test(lines[0]));
  assert.match(lines[1], /^What you have heard: V killed Maelstrom in a fight; V shot Royce at All Foods\. V is a big name/);
  assert.doesNotMatch(lines[1], /paid/, 'only reasons that fit the standing');
  assert.ok(text.length <= MAX_CHARS);
  assert.match(describeStanding({group: 'residents:SantoDomingo', standing: 30, reasons: []}), /Word among people around Santo Domingo: V is one of the good ones/);
  assert.match(describeStanding({group: 'residents:SantoDomingo', standing: 30, reasons: [], place: false}), /people around here/);
  assert.match(describeStanding({group: 'ncpd', standing: 0, heat: 2}), /V is wanted by the NCPD right now/);
  assert.equal(describeStanding({group: 'maelstrom', standing: 0, heat: 2}), '', 'only the police know the wanted level');
  assert.deepEqual(['hostile', 'wary', 'neutral', 'friendly', 'trusted'], [-50, -20, 19, 49, 50].map(s => tierOf(s).name));
  assert.equal(fameOf(9), null);
  assert.match(fameOf(50), /legend/);
});

// -------------------------------------------------------------------------------------------------------------------- the snapshot
test('the snapshot fails closed on its shape and drops a bad deed; CET\'s empty events table is an empty list', () => {
  assert.equal(parseReputationSnapshot({version: 1, session: 'bad session!'}), null);
  assert.equal(parseReputationSnapshot({version: 2, session: 's'}), null);
  assert.equal(parseReputationSnapshot({version: 1, session: 's', events: new Array(65).fill(lua('kill', {a: 'Maelstrom'}))}), null);
  const parsed = parseReputationSnapshot({version: 1, session: 'lua-1-2', cred: 12, level: 20, t: 99.7, events: {}});
  assert.deepEqual(parsed, {version: 1, session: 'lua-1-2', events: [], cred: 12, level: 20, t: 99});
  assert.equal(parseReputationSnapshot({version: 1, session: 's', events: [lua('kill', {a: 'Maelstrom'}), {k: 'nope'}]}).events.length, 1);
});

const requestId = (n = 1, entity = '42ULL') => `${100 + n}-1-${entity}`;
const turn = (extra = {}) => ({requestId: requestId(), generation: 1, entity: '42ULL', name: 'Ganger', bodyType: 'b', profileKey: 'npc-maelstrom-male',
  text: "hey, I'm V", archetype: {base: 'maelstrom', category: 'gang', district: 'Watson'}, ...extra});   // V names themselves: the store tests are about the standing, not recognition

test('gates: only an ordinary NPC\'s private turn that carries the snapshot (the setting is on) ever gets a line', () => {
  const snapshot = {version: 1, session: 's', events: []};
  assert.equal(reputationApplies(turn({reputation: snapshot})), true);
  assert.equal(reputationApplies(turn()), false, 'off: no snapshot');
  assert.equal(reputationApplies(turn({reputation: snapshot, profileKey: 'judy-alvarez'})), false, 'a named character');
  assert.equal(reputationApplies(turn({reputation: snapshot, archetype: undefined})), false, 'no archetype facts');
  for (const extra of [{group: {}}, {reaction: {kind: 'battle'}}, {channel: 'phone'}, {holocall: {}}, {head: {}}, {addon: {}}]) {
    assert.equal(reputationApplies(turn({reputation: snapshot, ...extra})), false, JSON.stringify(extra));
  }
  // Through the real request parser.
  const raw = JSON.stringify({...turn(), requestId: '7-1-42ULL', reputation: {version: 1, session: 'lua-1', cred: 3, events: [lua('kill', {a: 'Maelstrom', w: true})]}});
  const input = parseInput(raw);
  assert.equal(input.reputation.events[0].a, 'maelstrom');
  assert.equal(parseInput(JSON.stringify({...turn(), requestId: '7-1-42ULL'})).reputation, undefined);
  assert.equal(parseInput(JSON.stringify({...turn(), requestId: '7-1-42ULL', reputation: {version: 1, session: '!'}})).reputation, undefined,
    'a bad snapshot is dropped, the turn is kept');
});

// ------------------------------------------------------------------------------------------------------------------------- the store
function fakeFs(files = {}) {
  const calls = {read: 0, stat: 0, write: 0};
  return {files, calls,
    readFile: path => { calls.read++; if (!(path in files)) { const error = Error('missing'); error.code = 'ENOENT'; throw error; } return files[path]; },
    statFile: path => { calls.stat++; if (!(path in files)) throw Object.assign(Error('missing'), {code: 'ENOENT'}); return {mtimeMs: files[path].length, size: files[path].length}; },
    write: async (path, data) => { calls.write++; files[path] = data; return true; }};
}
const store = fs => new ReputationStore({path: 'state/reputation.json', eventsPath: 'runtime/reputation-events.json', ...fs, log: () => {}, now: () => 5});

test('the store touches no file and changes no prompt while the setting is off', () => {
  const fs = fakeFs();
  const s = store(fs);
  for (const input of [turn(), turn({profileKey: 'judy-alvarez'}), undefined]) assert.equal(s.contextFor(input), '');
  assert.deepEqual(fs.calls, {read: 0, stat: 0, write: 0});
  assert.deepEqual(s.status(), {loaded: false});
});

test('the store: deeds counted once (inline and file), a decent third message, the rollback guard, one book per lifepath, one write', async () => {
  const fs = fakeFs();
  const s = store(fs);
  const kills = [1, 2, 3, 4, 5].map(n => lua('kill', {a: 'Maelstrom', w: true, s: n, t: 10 * DAY + n}));
  const snap = (extra = {}) => ({version: 1, session: 'lua-a', cred: 20, level: 15, t: 10 * DAY + 600, events: kills, ...extra});
  const first = s.contextFor(turn({reputation: parseReputationSnapshot(snap()), turnContext: {lifepath: 'streetkid'}}));
  assert.match(first, /Word among Maelstrom: V is bad news/);
  assert.match(first, /V killed Maelstrom in a fight/);
  // The bridge builds a turn's context several times, and the next turn brings the same ring: nothing is counted twice.
  s.contextFor(turn({reputation: parseReputationSnapshot(snap()), turnContext: {lifepath: 'streetkid'}}));
  s.contextFor(turn({requestId: requestId(2), reputation: parseReputationSnapshot(snap()), turnContext: {lifepath: 'streetkid'}}));
  assert.deepEqual(s.status().books, {streetkid: 1});
  // The game's file with an older part of the same ring is read first; deeds already seen are skipped.
  fs.files['runtime/reputation-events.json'] = JSON.stringify({version: 1, session: 'lua-a', events: kills.slice(0, 2)});
  s.contextFor(turn({requestId: requestId(3), reputation: parseReputationSnapshot(snap()), turnContext: {lifepath: 'streetkid'}}));
  await s.flush();
  const saved = JSON.parse(fs.files['state/reputation.json']);
  assert.equal(saved.books.streetkid.buckets.find(b => b.k === 'kill').n, 5);
  // Three messages to the same person with no reaction: one decent talk, once that game day.
  assert.equal(saved.books.streetkid.buckets.filter(b => b.k === 'talk').length, 1);
  s.contextFor(turn({requestId: requestId(4), reputation: parseReputationSnapshot(snap()), turnContext: {lifepath: 'streetkid'}}));
  await s.flush();
  assert.equal(JSON.parse(fs.files['state/reputation.json']).books.streetkid.buckets.find(b => b.k === 'talk').n, 1);
  // An earlier save is loaded: its clock is before the deeds, so they are forgotten (never invented again).
  const back = s.contextFor(turn({requestId: requestId(5), reputation: parseReputationSnapshot(snap({t: 9 * DAY, events: []})), turnContext: {lifepath: 'streetkid'}}));
  assert.doesNotMatch(back, /Word among/, 'only the fame line is left');
  await s.flush();
  assert.equal(JSON.parse(fs.files['state/reputation.json']).books.streetkid.buckets.length, 0);
  // A deed done in a nomad save goes to the nomad book, whatever save the turn is in.
  s.contextFor(turn({requestId: requestId(6), reputation: parseReputationSnapshot(snap({session: 'lua-b', events: [lua('kill', {a: 'Maelstrom', w: true, lp: 'nomad', t: 10 * DAY})]})),
    turnContext: {lifepath: 'streetkid'}}));
  assert.deepEqual(s.status().books, {streetkid: 0, nomad: 1});
  await s.flush();
  assert.ok(fs.calls.write <= 4, `writes are debounced (${fs.calls.write})`);
});

test('a damaged saved file starts empty; bounds hold', () => {
  const fs = fakeFs({'state/reputation.json': '{not json'});
  const s = store(fs);
  assert.equal(s.contextFor(turn({reputation: {version: 1, session: 's', events: []}})), '');
  assert.equal(s.status().loaded, true);
  const book = {buckets: []};
  addDeeds(book, Array.from({length: LIMITS.buckets + 40}, (_, i) => ({k: 'kill', a: 'maelstrom', x: '', d: 'W', t: i * DAY, w: true})));
  assert.equal(book.buckets.length, LIMITS.buckets);
  const future = book.buckets.filter(b => b.t > 100 * DAY + 120).length;
  assert.equal(forgetFuture(book, {t: 100 * DAY}), future);
  assert.ok(book.buckets.every(b => b.t <= 100 * DAY + 120));
  assert.equal(bookOf({worldKnowledge: {lifepath: {status: 'known', value: 'corpo'}}}), 'corpo');
  assert.equal(bookOf({}), 'unknown');
});

test('standing combines story and deeds and is bounded', () => {
  const result = standingOf('maelstrom', {maelstrom: {points: -60, reasons: [{said: 'a', points: -60}]}}, {maelstrom: {points: -80, reasons: [{said: 'b', points: -80}]}});
  assert.equal(result.standing, -100);
  assert.deepEqual(result.reasons.map(r => r.said), ['b', 'a']);
});

// --------------------------------------------------------------------------------------------------------------- the game side (Lua)
const reputationLua = modSource('reputation.lua');
const harness = (body, {enabled = true} = {}) => run(`
  local M = (function() ${reputationLua} end)()
  local written, observed = {}, {}
  local on = ${enabled ? 'true' : 'false'}
  local clockValue = 1
  local inCombat, gameSeconds, heat = true, 1000, 0
  local player = {IsInCombat = function() return inCombat end}
  local function npc(affiliation, police, crowd)
    return {GetAffiliation = function() return affiliation end, IsCharacterPolice = function() return police == true end,
      IsCrowd = function() return crowd == true end}
  end
  local V = {IsPlayer = function() return true end}
  local other = {IsPlayer = function() return false end}
  local S = M.new({enabled = function() return on end, session = 'lua-test',
    observe = function(class, method, fn) observed[class .. '.' .. method] = fn end,
    player = function() return player end, gameTime = function() return gameSeconds end, lifepath = function() return 'nomad' end,
    district = function() return {district = 'Watson', area = 'Kabuki'} end,
    ordinary = function(target) return target.story ~= true end,
    stat = function(name) return name == 'StreetCred' and 22.0 or 17.0 end,
    write = function(path, raw) written[#written + 1] = {path = path, raw = raw}; return true end,
    clock = function() return clockValue end})
  ${body}
`);

test('Lua: nothing is hooked, recorded, captured or written while the setting is off', () => {
  const out = harness(`
    report('deed', S.deed('kill', npc('Maelstrom'), V))
    report('heat', S.heat({GetHeatStageAsInt = function() return 2 end}))
    report('reaction', S.reaction('attack', {base = 'maelstrom'}))
    report('capture', S.capture() == nil)
    report('flush', S.flush('test'))
    report('written', #written)
  `, {enabled: false});
  assert.deepEqual(out, {deed: false, heat: false, reaction: false, capture: true, flush: false, written: 0});
  // And init.lua loads the module only when the setting is on; the update loop never mentions it.
  const init = read('../mod/init.lua');
  assert.match(init, /function convaiDeedsWanted\(\)\r?\n    if type\(manager\.reputation\) == 'function' and manager\.reputation\(\) then return true end\r?\n    return type\(manager\.revengeAmbushes\) == 'function' and manager\.revengeAmbushes\(\) == true\r?\nend\r?\nfunction convaiReputationWanted\(\)\r?\n    if not convaiDeedsWanted\(\) then return nil end/);
  assert.match(init, /if convaiDeedsWanted\(\) then pcall\(convaiReputationWanted\) end/);
  assert.match(init, /if convaiReputation or convaiReputationPending then pcall\(convaiReputationAttach, context\) end/);
  const update = init.slice(init.indexOf("registerForEvent('onUpdate'"), init.indexOf("registerForEvent('onShutdown'"));
  assert.doesNotMatch(update, /[Rr]eputation/, 'nothing per frame');
  assert.doesNotMatch(reputationLua, /registerForEvent|function S\.update/);
  assert.equal((init.match(/dofile, 'reputation\.lua'/g) ?? []).length, 1);
});

test('Lua: the hooks register once; kills by V are recorded with the witness flag, others are not; heat episodes; capture and flush', () => {
  const out = harness(`
    report('installed', S.install()); S.install()
    local names = {}; for name in pairs(observed) do names[#names + 1] = name end; table.sort(names); report('hooks', names)
    observed['NPCPuppet.OnDeath'](npc('Maelstrom'), {instigator = V})
    inCombat = false
    observed['NPCPuppet.OnDeath'](npc('TygerClaws'), {instigator = V})
    observed['NPCPuppet.OnDeath'](npc('Valentinos'), {instigator = other})
    observed['NPCPuppet.OnDeath'](npc('Valentinos'), {})
    local story = npc('Maelstrom'); story.story = true
    observed['NPCPuppet.OnDeath'](story, {instigator = V})
    observed['NPCPuppet.OnDefeated'](npc(nil, true), {instigator = V})
    local system = {GetHeatStageAsInt = function() return heat end}
    heat = 2; observed['PreventionSystem.ChangeHeatStage'](system)
    heat = 3; observed['PreventionSystem.ChangeHeatStage'](system)
    heat = 0; observed['PreventionSystem.ChangeHeatStage'](system)
    S.reaction('call-police', {base = 'street-resident', category = 'resident'})
    local capture = S.capture()
    report('capture', capture)
    report('flush1', S.flush('test')); report('flush2', S.flush('test'))
    report('file', written[1] and json.decode(written[1].raw) or false)
    report('path', written[1] and written[1].path or false)
    S.reset('load'); report('ringAfterReset', #S.ring); report('status', S.status())
  `);
  assert.equal(out.installed, 3);
  assert.deepEqual(out.hooks, ['NPCPuppet.OnDeath', 'NPCPuppet.OnDefeated', 'PreventionSystem.ChangeHeatStage']);
  const events = out.capture.events;
  assert.deepEqual(events.map(e => [e.k, e.a ?? e.x ?? null, e.w ?? null]), [['kill', 'Maelstrom', true], ['kill', 'TygerClaws', false],
    ['defeat', null, false], ['heat', 'start', null], ['heat', 'rise', null], ['react', 'call-police', null]]);
  assert.equal(events[2].p, true);
  assert.deepEqual(events.map(e => e.s), [1, 2, 3, 4, 5, 6]);
  assert.ok(events.every(e => e.t === 1000 && e.d === 'Watson' && e.r === 'Kabuki' && e.lp === 'nomad'));
  assert.equal(out.capture.cred, 22);
  assert.equal(out.capture.level, 17);
  assert.equal(out.capture.session, 'lua-test');
  assert.equal(out.flush1, true);
  assert.equal(out.flush2, false, 'nothing new: no second write');
  assert.equal(out.path, 'runtime/reputation-events.json');
  assert.equal(out.file.events.length, 6);
  assert.equal(out.ringAfterReset, 0);
  assert.equal(out.status.skipped['not-ordinary'], 1);
  // What the game writes is what the bridge reads.
  const parsed = parseReputationSnapshot(out.capture);
  assert.equal(parsed.events.length, 6, 'every deed the game recorded reads back');
});

test('Lua: the ring writes itself when 64 deeds wait unwritten', () => {
  const out = harness(`
    for i = 1, 64 do S.reaction('leave', {base = 'street-resident', category = 'resident'}) end
    report('written', #written); report('ring', #S.ring)
    S.reaction('leave', {}); report('ring2', #S.ring); report('written2', #written)
  `);
  assert.deepEqual(out, {written: 1, ring: 64, ring2: 64, written2: 1});
});

test('npc-reactions tells Street reputation which reaction actually started', () => {
  const source = read('../mod/npc-reactions.lua');
  assert.match(source, /if walkAway\(p, player, 'leave'\) then started\('leave', p\) end/);
  // attack and brawl share one branch (docs/NPC_THREATS_COMMANDS.md); a brawl is recorded as an attack and a cower as a leave.
  assert.match(source, /if hostile or combat then[\s\S]{0,180}started\(p\.kind, p\)/);
  assert.match(source, /local DEED = \{brawl = 'attack', cower = 'leave'\}/);
  assert.match(source, /if called then .*started\('call-police', p\) end/);
  assert.match(source, /pcall\(options\.onReaction, kind, \{base = p\.base, category = p\.category, affiliation = p\.affiliation\}\)/);
});

// ------------------------------------------------------------------------------------------------------------------------ the setting
test('the setting is on by default, saved as a boolean, and offered under Night City', () => {
  const out = run(`${managerLua}
    local manager = newManager()
    local player = newPlayer()
    manager.update(player, 0.1)
    report('default', manager.reputation()); report('saved', settingsTable().reputation)
    report('snapshot', manager.snapshot(player).settings.reputation)
    manager.applySettings(player, {reputation = false})
    report('firstOff', manager.reputation()); report('pendingBefore', convaiReputationPending == true)
    local ok = manager.applySettings(player, {reputation = true})
    report('on', ok == true and manager.reputation()); report('pending', convaiReputationPending == true)
    report('savedOn', settingsTable().reputation)
    report('bad', manager.applySettings(player, {reputation = 'yes'}) == false and manager.reputation())
    manager.applySettings(player, {reputation = false})
    report('off', manager.reputation())
  `);
  assert.deepEqual(out, {default: true, saved: true, snapshot: true, firstOff: false, pendingBefore: false, on: true, pending: true, savedOn: true, bad: true, off: false});
  const ui = read('../mod/manager-ui.lua');
  const nightCity = ui.slice(ui.indexOf("settingsPages['settings-night-city']"), ui.indexOf("settingsPages['settings-interface']"));
  assert.match(nightCity, /setting\('reputation', 'Street reputation', 'bool', snapshot\.settings\.reputation == true, true,/);
  assert.match(ui, /elseif key == 'reputation' then values\.reputation = change\.value/);
});

test('the setting\'s two strings are in the catalog and in every locale', () => {
  const catalog = JSON.parse(read('../localization/en.json')).strings;
  const row = /setting\('reputation', '([^']+)', 'bool', [^,]+, true,\s*'((?:[^'\\]|\\.)*)'\)/.exec(read('../mod/manager-ui.lua'));
  assert.ok(row, 'the row');
  const description = row[2].replace(/\\n/g, '\n');
  for (const text of [row[1], description]) assert.ok(Object.hasOwn(catalog, text), `catalog: ${text.slice(0, 40)}`);
  for (const locale of ['cs', 'de', 'es', 'fr', 'hu', 'it', 'ja', 'ko', 'pl', 'pt-br', 'ru', 'tr', 'uk', 'zh-cn', 'zh-tw']) {
    const source = read(`../mod/locales/${locale}.lua`);
    assert.ok(source.includes(`["${row[1]}"]`), `${locale}: label`);
    assert.ok(source.includes(`["${row[2]}"]`), `${locale}: description`);
  }
});

test('a stranger knows who V is only by fame (a fixed share per person, growing with Street Cred), when V says their name, or as a cop while V is wanted', () => {
  // A player report (2026-10-25): every pedestrian and guard talked as if they knew V. Strangers who do not know V hear nothing of the word on the street.
  const ids = Array.from({length: 2000}, (_, i) => `${1000 + i}ULL`);
  const share = cred => ids.filter(id => recognisesV(id, cred)).length / ids.length;
  assert.equal(share(0), 0); assert.equal(share(19), 0);
  assert.ok(Math.abs(share(20) - 0.10) < 0.03, String(share(20)));
  assert.ok(Math.abs(share(35) - 0.25) < 0.04, String(share(35)));
  assert.ok(Math.abs(share(60) - 0.40) < 0.04, String(share(60)));
  assert.equal(recognisesV('77ULL', 60), recognisesV('77ULL', 60), 'the same person always decides the same');
  for (const line of ["I'm V", 'my name is V.', "Name's V, nice to meet you", 'call me V']) assert.ok(saysOwnName(line), line);
  for (const line of ['hey', 'V is cool', 'I am very tired', "I'm Vincent"]) assert.equal(saysOwnName(line), false, line);
  const s = store(fakeFs());
  const kills = [1, 2, 3, 4, 5].map(n => lua('kill', {a: 'Maelstrom', w: true, s: n, t: 10 * DAY + n}));
  const snap = parseReputationSnapshot({version: 1, session: 'lua-a', cred: 5, level: 15, t: 10 * DAY + 600, events: kills});
  const [other, stranger] = ids.filter(id => !recognisesV(id, 5));
  assert.equal(s.contextFor(turn({entity: other, text: 'hey', reputation: snap})), '', 'a plain stranger hears nothing');  const told = s.contextFor(turn({entity: stranger, requestId: requestId(2), text: "I'm V, who runs this block?", reputation: snap}));
  assert.match(told, /V just told you their name, and you have heard of V, but you have never met V./);
  assert.match(told, /Word among Maelstrom: V is bad news/);
  assert.match(s.contextFor(turn({entity: stranger, requestId: requestId(3), text: 'and the bar?', reputation: snap})), /Word among Maelstrom/, 'remembered for the session');
  const famous = parseReputationSnapshot({version: 1, session: 'lua-a', cred: 60, level: 40, t: 10 * DAY + 600, events: kills});
  const fan = ids.find(id => recognisesV(id, 60));
  assert.match(s.contextFor(turn({entity: fan, requestId: requestId(4), text: 'hey', reputation: famous})), /You recognise V from what people say, but you have never met V./);
  assert.doesNotMatch(describeStanding({group: 'residents:Watson', standing: 80, reasons: []}), /friend,|like a respected friend|Greet V/, 'no tier treats V as an old acquaintance');
});
