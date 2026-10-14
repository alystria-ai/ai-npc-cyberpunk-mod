import {test} from 'node:test';
import assert from 'node:assert/strict';
import {describePlace} from './place-names.mjs';

// The names below are gamedataDistrict records read from final.redscripts on 2026-10-15 (docs/DYNAMIC_CONTEXT_AUDIT.md, "Where V is").

test('a plain neighbourhood is stated as the neighbourhood and its district, and nothing says whether V is indoors', () => {
  assert.deepEqual(describePlace({district: 'SantoDomingo', area: 'Arroyo'}), {text: 'Arroyo, Santo Domingo', inside: null, kind: 'neighborhood'});
  assert.deepEqual(describePlace({district: 'Watson', area: 'Kabuki'}), {text: 'Kabuki, Watson', inside: null, kind: 'neighborhood'});
  assert.deepEqual(describePlace({district: 'Watson'}), {text: 'Watson', inside: null, kind: 'district'});
  assert.deepEqual(describePlace({district: 'Watson', area: 'Watson'}), {text: 'Watson', inside: null, kind: 'district'});
  assert.equal(describePlace({district: 'JapanTown', area: 'JapanTown'}).text, 'Japantown');
});

test('the game\'s own indoor reading, when it exists, is carried to the place', () => {
  assert.equal(describePlace({district: 'SantoDomingo', area: 'Arroyo', indoors: false}).inside, false);
  assert.equal(describePlace({district: 'SantoDomingo', area: 'Arroyo', indoors: true}).inside, true);
  assert.equal(describePlace({district: 'SantoDomingo', area: 'Arroyo', indoors: 'yes'}).inside, null, 'only a real boolean counts');
});

test('V\'s apartments and the named interiors say where V is, and they are indoors whatever the reading says', () => {
  assert.deepEqual(describePlace({district: 'LittleChina', area: 'LittleChina_VApartment', indoors: false}),
    {text: "V's apartment in Megabuilding H10", inside: true, kind: 'home'});
  assert.equal(describePlace({district: 'Northside', area: 'Northside_Apartment'}).text, "V's apartment in Northside");
  assert.deepEqual(describePlace({district: 'Westbrook', area: 'Abandoned_Apartment'}), {text: 'an apartment in Westbrook', inside: true, kind: 'venue'}, "some other apartment is not V's home");
  assert.deepEqual(describePlace({district: 'Watson', area: 'Kabuki_LizziesBar'}), {text: "Lizzie's Bar, Watson", inside: true, kind: 'venue'});
  assert.equal(describePlace({district: 'Watson', area: 'LittleChina_Afterlife'}).text, 'the Afterlife, Watson');
  assert.equal(describePlace({district: 'CityCenter', area: 'CorpoPlaza_ArasakaTowerLobby'}).text, 'Arasaka Tower Lobby, City Center');
  assert.equal(describePlace({district: 'CityCenter', area: 'CorpoPlaza_ArasakaTowerLobby'}).inside, true);
});

test('the Badlands are open country; an unknown sub-record is stated by name without claiming it is indoors or out', () => {
  assert.deepEqual(describePlace({district: 'Badlands', area: 'Badlands_RockyRidge'}), {text: 'Rocky Ridge, Badlands', inside: false, kind: 'wild'});
  assert.equal(describePlace({district: 'Badlands', area: 'Badlands_Yucca', indoors: true}).inside, true, 'a hut in the Badlands is still a hut');
  assert.deepEqual(describePlace({district: 'Dogtown', area: 'Dogtown_Expo'}), {text: 'Expo, Dogtown', inside: null, kind: 'venue'});
  assert.equal(describePlace({district: 'Dogtown', area: 'Dogtown_Expo', indoors: false}).inside, false);
});

test('nothing usable gives no place, and a malformed name is refused', () => {
  assert.equal(describePlace(), null);
  assert.equal(describePlace({}), null);
  assert.equal(describePlace({district: 'bad<>name'}), null);
  assert.equal(describePlace({district: 7}), null);
  assert.equal(describePlace({district: 'Watson', area: 'bad<>area'}).text, 'Watson');
  for (const key of ['constructor', 'toString', '__proto__']) assert.ok(['neighborhood', 'district'].includes(describePlace({district: 'Watson', area: key}).kind), key);
});
