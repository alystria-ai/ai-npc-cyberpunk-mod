import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {NAMED_PLACES} from './named-places-data.mjs';
import {namedPlaceAt, parsePosition, parseCaptures, placesToCapture, placesWithPositions, setCaptures, captureReader} from './named-places.mjs';
import {describePlace} from './place-names.mjs';
import {parseTurnContext, describeTurnContext, turnContextWhere} from './turn-context.mjs';
import {stripSnapshot, KINDS} from './dynamic-info.mjs';

const H10 = NAMED_PLACES.find(place => place.id === 'v-apartment-h10');
// A list with Misty's measured, as a capture would make it.
const MEASURED = new Map([['mistys-esoterica', {x: -1000, y: 1300, z: 40}]]);

const snapshot = (extra = {}) => ({version: 1, status: 'ready', hour: 23, minute: 5, district: 'Watson', area: 'LittleChina', vehicle: false, motion: 'still',
  party: [{key: 'judy-alvarez', name: 'Judy Alvarez', activity: 'standing'}], ...extra});
const turnFor = (turnContext, extra = {}) => ({profileKey: 'judy-alvarez', name: 'Judy Alvarez', text: 'Hey', turnContext, ...extra});

test('the list: every place has an id the probe can record, a phrase, a radius; only a position a file ties to the place is filled in (H10), the rest wait for a capture', () => {
  const ids = NAMED_PLACES.map(place => place.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const place of NAMED_PLACES) {
    assert.match(place.id, /^[a-z0-9-]{1,40}$/, 'the probe takes letters, digits and - only');
    assert.ok(place.phrase.length > 4 && place.radius > 0 && place.radius <= 60, place.id);
    assert.ok(!/[;—–]|--/.test(place.phrase), place.id);
    const placed = [place.x, place.y, place.z].every(Number.isFinite), none = [place.x, place.y, place.z].every(value => value === null);
    assert.ok(placed || none, `${place.id}: a position is all three numbers or none`);
    if (placed) assert.ok(place.source, `${place.id}: a position needs its source`);
  }
  for (const wanted of ['afterlife', 'lizzies-bar', 'mistys-esoterica', 'victors-clinic', 'v-apartment-h10', 'toms-diner', 'el-coyote-cojo', 'sunset-motel', 'clouds']) {
    assert.ok(ids.includes(wanted), wanted);
  }
  const placed = NAMED_PLACES.filter(place => Number.isFinite(place.x)).map(place => place.id).sort();
  assert.deepEqual(placed, ['afterlife', 'arasaka-tower-ceo', 'clouds', 'el-coyote-cojo', 'judys-apartment', 'lizzies-bar', 'totentanz', 'v-apartment-corpo', 'v-apartment-h10', 'v-apartment-northside', 'wakakos-office']);
  assert.ok(!ids.includes('embers'), 'Embers was dropped: its cell height does not fit the street next to it');
  // The ones still to measure in the game, with the probe that does it.
  assert.deepEqual(placesToCapture([...NAMED_PLACES], new Map()).map(item => item.id).sort(), ['mistys-esoterica', 'sunset-motel', 'toms-diner', 'victors-clinic']);
  assert.equal(placesToCapture([...NAMED_PLACES], new Map()).find(item => item.id === 'toms-diner').probe, 'quest capture:toms-diner');
  // A position names its source, a streaming cell says so and is wide in height, and the sources agree with the repo where the repo has a point of its own.
  for (const place of NAMED_PLACES.filter(item => Number.isFinite(item.x))) {
    assert.match(place.source, /^(?:repo|teleport|sector grid):/, place.id);
    if (/^sector grid/.test(place.source)) assert.ok(place.approx === true && place.dz >= 36, `${place.id}: a streaming cell is approximate`);
    else assert.ok(!place.approx, place.id);
  }
  const near = (x, y, place) => Math.hypot(place.x - x, place.y - y);
  assert.ok(near(-1606.33, 362.66, NAMED_PLACES.find(item => item.id === 'v-apartment-corpo')) < 15, 'the Corpo Plaza flat agrees with the repo survey entry');
  assert.ok(near(-1503.80, 2224.92, NAMED_PLACES.find(item => item.id === 'v-apartment-northside')) < 6, 'the Northside flat agrees with the repo survey entry');
  assert.ok(near(-1385.26, 1272.44, NAMED_PLACES.find(item => item.id === 'v-apartment-h10')) < 3, 'H10 holds the repo\'s Johnny spot');
  // No two places claim the same spot: horizontal reach and height reach both overlap only for a place inside another, which none is.
  for (const [index, one] of NAMED_PLACES.entries()) for (const two of NAMED_PLACES.slice(index + 1)) {
    if (![one.x, two.x].every(Number.isFinite)) continue;
    const overlap = Math.hypot(one.x - two.x, one.y - two.y) < one.radius + two.radius && Math.abs(one.z - two.z) <= one.dz + two.dz;
    assert.ok(!overlap, `${one.id} and ${two.id} overlap`);
  }
});

test('a position: three finite numbers within the world, rounded to a tenth; anything else is none', () => {
  assert.deepEqual(parsePosition({x: -1385.04, y: 1270.06, z: 123.06}), {x: -1385, y: 1270.1, z: 123.1});
  for (const bad of [null, undefined, 5, 'x', [], {x: 1, y: 2}, {x: 'a', y: 1, z: 1}, {x: NaN, y: 1, z: 1}, {x: Infinity, y: 1, z: 1}, {x: 1e6, y: 1, z: 1}]) assert.equal(parsePosition(bad), null, JSON.stringify(bad));
});

test('V inside the H10 flat is at the verified place, in its radius and floor only, and the district must agree', () => {
  assert.equal(namedPlaceAt({x: -1384, y: 1271, z: 123.06})?.id, 'v-apartment-h10');
  assert.equal(namedPlaceAt({x: -1391.87, y: 1271.69, z: 123.08})?.id, 'v-apartment-h10', 'the survey entry point');
  assert.equal(namedPlaceAt({x: -1376.41, y: 1267.79, z: 122.69})?.id, 'v-apartment-h10', 'the couch corner');
  assert.equal(namedPlaceAt({x: -1384, y: 1300, z: 123}), null, 'thirty metres north is the street');
  assert.equal(namedPlaceAt({x: -1384, y: 1271, z: 140}), null, 'another floor of the tower');
  assert.equal(namedPlaceAt({x: -1384, y: 1271, z: 123}, {district: 'Heywood'}), null, 'the game says another district');
  assert.equal(namedPlaceAt({x: -1384, y: 1271, z: 123}, {district: 'Watson'})?.id, 'v-apartment-h10');
  assert.equal(namedPlaceAt({x: -1602.3, y: 356.2, z: 48.62})?.id, 'v-apartment-corpo', 'the old "H10" couch seat is the Corpo Plaza flat (docs/HOUSEMATES.md), not H10');
  assert.equal(namedPlaceAt(null), null);
  assert.equal(namedPlaceAt({x: 'a'}), null);
});

test('a place with no position is never matched; a measured one is, until the shipped list has it, and the deepest of two overlapping places wins', () => {
  assert.equal(namedPlaceAt({x: -1000, y: 1300, z: 40}, {measured: new Map()}), null, 'Mistys shop is not measured yet');
  assert.equal(namedPlaceAt({x: -1000, y: 1300, z: 40}, {measured: MEASURED})?.id, 'mistys-esoterica');
  assert.equal(namedPlaceAt({x: -1000, y: 1330, z: 40}, {measured: MEASURED}), null, 'beyond its 25 m');
  assert.equal(namedPlaceAt({x: -1000, y: 1300, z: 52}, {measured: MEASURED}), null, 'another floor');
  assert.equal(placesWithPositions(NAMED_PLACES, MEASURED).find(place => place.id === 'mistys-esoterica').x, -1000);
  const list = [{id: 'a', phrase: 'a', x: 0, y: 0, z: 0, radius: 20}, {id: 'b', phrase: 'b', x: 8, y: 0, z: 0, radius: 6}];
  assert.equal(namedPlaceAt({x: 7, y: 0, z: 0}, {list})?.id, 'b');
  assert.equal(namedPlaceAt({x: 2, y: 0, z: 0}, {list})?.id, 'a');
});

test('the developer probe\'s file: measured positions of the known ids only, a guess (captured false) and bad numbers are left out', () => {
  const file = JSON.stringify({places: {'mistys-esoterica': {name: 'mistys-esoterica', x: -1000.4, y: 1300.2, z: 40, radius: 8, captured: true, district: 'Watson', area: 'LittleChina'},
    clouds: {x: 1, y: 2, z: 3, captured: false}, 'toms-diner': {x: 'a', y: 2, z: 3, captured: true}, 'not-a-place': {x: 1, y: 2, z: 3, captured: true}}});
  const found = parseCaptures(file);
  assert.deepEqual([...found.keys()], ['mistys-esoterica']);
  assert.deepEqual(found.get('mistys-esoterica'), {x: -1000.4, y: 1300.2, z: 40});
  for (const bad of ['', 'not json', '[]', '{"places": 5}', '{"places": []}', null]) assert.equal(parseCaptures(bad).size, 0, String(bad));
});

test('the capture reader loads the file when it changes, forgets it when it goes, and checks no more often than its interval', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'places-'));
  const path = join(directory, 'quest-place-capture.json');
  let clock = 0;
  const lines = [];
  const reader = captureReader({path, everyMs: 5000, now: () => clock, log: line => lines.push(line)});
  try {
    assert.equal(await reader.poll(), false, 'no file');
    await writeFile(path, JSON.stringify({places: {'mistys-esoterica': {x: -1000, y: 1300, z: 40, captured: true}}}));
    clock = 1000;
    assert.equal(await reader.poll(), false, 'inside the interval nothing is looked at');
    clock = 6000;
    assert.equal(await reader.poll(), true);
    assert.equal(namedPlaceAt({x: -1000, y: 1300, z: 40})?.id, 'mistys-esoterica');
    assert.ok(lines.some(line => /1 position\(s\) measured in the game \(mistys-esoterica\)/.test(line)) && !lines.join().includes('1300'), 'the log names the place, not the position');
    clock = 12000;
    assert.equal(await reader.poll(), false, 'unchanged');
    await rm(path);
    clock = 18000;
    assert.equal(await reader.poll(), true);
    assert.equal(namedPlaceAt({x: -1000, y: 1300, z: 40}), null);
  } finally { setCaptures(new Map()); await rm(directory, {recursive: true, force: true}); }
});

test('the wording: inside a named place when the game says V is indoors, at it otherwise, near it in a vehicle; a record that names an interior is kept', () => {
  setCaptures(new Map());
  try {
    const at = extra => describeTurnContext(turnFor(snapshot({position: {x: -1455.1, y: 1011, z: 17.8}, ...extra})), {}).text;
    assert.match(at({indoors: true}), /You are inside the Afterlife, a merc bar in Little China, Watson\./);
    assert.match(at({indoors: false}), /You are at the Afterlife, a merc bar in Little China, Watson\./);
    assert.match(at({}), /You are at the Afterlife, a merc bar in Little China, Watson\./, 'the game could not say: "at", no claim of indoors');
    assert.match(at({vehicle: true, motion: undefined}), /near the Afterlife, a merc bar in Little China, Watson\./);
    assert.doesNotMatch(at({indoors: true}), /1011|1455|somewhere in|which building is not given/);
    // Out of its radius: the neighbourhood, as before.
    assert.match(describeTurnContext(turnFor(snapshot({position: {x: -1400, y: 1011, z: 17.8}})), {}).text, /You are somewhere in Little China, Watson; exactly where is not given\./);
    // A record that names the interior wins (the game itself said which place).
    assert.match(describeTurnContext(turnFor(snapshot({area: 'LittleChina_MistysShop', position: {x: -1455.1, y: 1011, z: 17.8}})), {}).text, /You are inside Misty's Esoterica, Watson\./);
    // Without a position, or with the Location kind switched off, nothing is named.
    assert.match(describeTurnContext(turnFor(snapshot()), {}).text, /somewhere in Little China, Watson/);
    const off = describeTurnContext(turnFor(snapshot({position: {x: -1455.1, y: 1011, z: 17.8}})), {off: new Set(['location'])}).text;
    assert.doesNotMatch(off, /Afterlife|Little China/);
  } finally { setCaptures(new Map()); }
});

test('V\'s apartment in H10 is named from the position alone, whatever record the game reports', () => {
  const text = describeTurnContext(turnFor(snapshot({position: {x: -1384.5, y: 1271, z: 123.06}})), {}).text;
  assert.match(text, /You are inside V's apartment in Megabuilding H10, Little China, Watson\./);
  const phone = describeTurnContext({profileKey: 'judy-alvarez', name: 'Judy Alvarez', text: 'Hey', channel: 'phone', turnContext: snapshot({position: {x: -1384.5, y: 1271, z: 123.06}})}, {}).text;
  assert.doesNotMatch(phone, /1271|1384/);
});

test('the position is validated with the snapshot, needs a district, is owned by the Location kind, and is never in the words', () => {
  const parsed = parseTurnContext(snapshot({position: {x: -1384.04, y: 1271.04, z: 123.06}}));
  assert.deepEqual(parsed.position, {x: -1384, y: 1271, z: 123.1});
  assert.equal(parseTurnContext(snapshot({position: {x: 'a', y: 1, z: 1}})).position, undefined);
  assert.equal(parseTurnContext(snapshot({position: [1, 2, 3]})).position, undefined);
  assert.equal(parseTurnContext({version: 1, status: 'ready', hour: 3, minute: 5, position: {x: 1, y: 2, z: 3}}).position, undefined, 'no district, no place to name');
  assert.ok(KINDS.includes('location'));
  assert.equal(stripSnapshot(parsed, new Set(['location'])).position, undefined);
  assert.deepEqual(stripSnapshot(parsed, new Set(['time'])).position, parsed.position);
});

test('describePlace: a named place by position replaces a bare neighbourhood only', () => {
  const named = {phrase: 'the Afterlife, a merc bar in Little China, Watson', home: false};
  assert.deepEqual(describePlace({district: 'Watson', area: 'LittleChina', indoors: true, named}), {text: named.phrase, inside: true, kind: 'named'});
  assert.deepEqual(describePlace({district: 'Watson', indoors: false, named}), {text: named.phrase, inside: false, kind: 'named'}, 'no sub-record at all');
  assert.equal(describePlace({district: 'Watson', area: 'Kabuki_LizziesBar', named}).kind, 'venue', 'the game\'s own record wins');
  assert.equal(describePlace({district: 'Watson', area: 'LittleChina', named: {phrase: "V's flat", home: true}}).kind, 'home');
  assert.equal(describePlace({district: 'Watson', area: 'LittleChina'}).kind, 'neighborhood');
});

test('turnContextWhere gives the sentence the context carries, for the Developer mode transcript, and nothing without a context', () => {
  assert.equal(turnContextWhere(turnFor(snapshot({position: {x: -1384.5, y: 1271, z: 123.06}}))), "You are inside V's apartment in Megabuilding H10, Little China, Watson.");
  assert.equal(turnContextWhere(turnFor(snapshot())), 'You are somewhere in Little China, Watson; exactly where is not given.');
  assert.equal(turnContextWhere({text: 'Hey'}), '');
  assert.equal(turnContextWhere(null), '');
  assert.equal(turnContextWhere(turnFor(snapshot()), {off: new Set(['location'])}), '');
});

test('the places with a position: the exact ones are found at their teleport, a streaming cell only indoors or when the game cannot say, and a district that disagrees stops a match', () => {
  const at = (id, extra = {}) => { const place = NAMED_PLACES.find(item => item.id === id); return namedPlaceAt({x: place.x, y: place.y, z: place.z}, extra)?.id; };
  for (const id of ['afterlife', 'clouds', 'v-apartment-corpo', 'v-apartment-northside', 'arasaka-tower-ceo', 'v-apartment-h10']) assert.equal(at(id), id, id);
  for (const id of ['lizzies-bar', 'el-coyote-cojo', 'judys-apartment', 'totentanz', 'wakakos-office']) {
    assert.equal(at(id), id, id);
    assert.equal(at(id, {indoors: true}), id, `${id} indoors`);
    assert.equal(at(id, {indoors: false}), undefined, `${id}: a streaming cell is not claimed in the open air`);
  }
  assert.equal(at('afterlife', {indoors: false}), 'afterlife', 'an exact position is not dropped outdoors (the door is outside)');
  // Home district is Watson for the Watson places, and another district stops them.
  assert.equal(at('lizzies-bar', {district: 'Watson'}), 'lizzies-bar');
  assert.equal(at('lizzies-bar', {district: 'Heywood'}), undefined);
  assert.equal(at('afterlife', {district: 'Watson'}), 'afterlife');
  assert.equal(at('afterlife', {district: 'SantoDomingo'}), undefined);
  // Two places far apart do not mix, and the floor matters: Wakako's office is 100 m below Clouds, about 47 m away.
  assert.equal(namedPlaceAt({x: -625.4, y: 794.6, z: 132.3})?.id, 'clouds');
  assert.equal(namedPlaceAt({x: -672, y: 800, z: 32}, {indoors: true})?.id, 'wakakos-office');
  assert.equal(namedPlaceAt({x: -1455, y: 1011, z: 80}), null, 'forty metres above the Afterlife is not the Afterlife');
});
