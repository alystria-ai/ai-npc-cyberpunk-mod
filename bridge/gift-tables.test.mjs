// Gifts (bridge/gift-tables.mjs, characters/gift-tables.json, docs/BOND_QUESTS.md section 17): the tables are valid, what a character gives by tier, how she takes what V gives,
// the bond numbers, the allowlist and its file. Offline.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {giftTables, validateGiftTables, allowlist, allowlistFile, isAllowedGift, resolveGive, classify, likesFor, takesItems, tierForLevel, giftBond, GIFT_BOND, TIERS, syncAllowlist}
  from './gift-tables.mjs';

const roster = new Set(JSON.parse(readFileSync(new URL('../characters/roster.json', import.meta.url), 'utf8')).map(row => row.key));
const TEN = ['panam-palmer', 'judy-alvarez', 'johnny-silverhand', 'viktor-vektor', 'jackie-welles', 'rogue-amendiares', 'kerry-eurodyne', 'river-ward', 'takemura', 'songbird'];

test('the shipped tables are valid, cover the ten characters, and every character is on the roster', () => {
  const tables = giftTables();
  assert.deepEqual(validateGiftTables(tables), []);
  assert.deepEqual(Object.keys(tables.characters).sort(), [...TEN].sort());
  for (const key of Object.keys(tables.characters)) assert(roster.has(key), key);
});

test('the validator catches a bad record, a bad rule and a missing tier item', () => {
  const bad = structuredClone(giftTables());
  bad.characters['panam-palmer'].gives.common = {item: 'Weapons.Nope'};
  bad.characters['judy-alvarez'].likes.loved.push({prefix: 'x'});
  bad.characters['johnny-silverhand'].likes.liked.push({id: 'Items.A', prefix: 'Items.'});
  bad.characters['viktor-vektor'].gives.rare = {};
  bad.characters['river-ward'].gives.mythic = {item: 'Items.Abc'};
  const problems = validateGiftTables(bad).join(' | ');
  assert.match(problems, /panam-palmer common: item must be an Items\.\* record/);
  assert.match(problems, /judy-alvarez: a loved rule is exactly one of/);
  assert.match(problems, /johnny-silverhand: a liked rule is exactly one of/);
  assert.match(problems, /viktor-vektor rare: needs an item or a second/);
  assert.match(problems, /river-ward: mythic is not a tier/);
  assert.deepEqual(validateGiftTables(null), ['the tables need version 1 and a characters object']);
});

test('what she gives, by tier: the item, the second choice, Jackie has no legendary, Kerry\'s legendary is the car with Archangel as the second', () => {
  assert.deepEqual(resolveGive('panam-palmer', 'common'), {item: 'Items.Nomad_01_Set_TShirt', second: null});
  assert.equal(resolveGive('viktor-vektor', 'legendary').second, 'Items.SandevistanC4MK5');
  assert.equal(resolveGive('jackie-welles', 'legendary'), null, 'his top tier is a promise the game keeps');
  const kerry = resolveGive('kerry-eurodyne', 'legendary');
  assert.equal(kerry.item, null); assert.equal(kerry.vehicle, null); assert.equal(kerry.second, 'Items.Preset_Overture_Kerry'); assert.match(kerry.note, /Guinevere/);
  assert.equal(resolveGive('kerry-eurodyne', 'rare'), null, 'the rare tier is still to be chosen');
  assert.equal(resolveGive('panam-palmer', 'mythic'), null); assert.equal(resolveGive('nobody', 'common'), null);
  for (const key of TEN) for (const tier of TIERS) {
    const give = resolveGive(key, tier);
    if (give) assert(give.item || give.second, `${key} ${tier}`);
  }
});

test('each tier is given once per save: a used tier gives nothing', () => {
  assert.equal(resolveGive('panam-palmer', 'epic', {used: ['common', 'uncommon']}).item, 'Items.Preset_Copperhead_Genesis');
  assert.equal(resolveGive('panam-palmer', 'epic', {used: ['epic']}), null);
});

test('the tier a bond level earns: common 2 to 3, uncommon 4 to 5, rare 6 to 7, epic 8 to 9, legendary 10', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(tierForLevel), [null, 'common', 'common', 'uncommon', 'uncommon', 'rare', 'rare', 'epic', 'epic', 'legendary']);
  assert.equal(tierForLevel(undefined), null);
});

test('how she takes a gift: loved, liked, neutral, disliked; the most specific rule wins', () => {
  assert.equal(classify('panam-palmer', 'Items.Nomad_01_Set_Boots'), 'loved');
  assert.equal(classify('panam-palmer', 'Items.LowQualityAlcohol9'), 'liked');
  assert.equal(classify('panam-palmer', 'Items.BiotechUncommonMKI'), 'disliked', 'a Biotechnica thing');
  assert.equal(classify('panam-palmer', 'Items.Something_Else'), 'neutral');
  assert.equal(classify('judy-alvarez', 'Items.BiotechUncommonMKI'), 'loved', 'the same deck is loved by Judy (prefix)');
  assert.equal(classify('judy-alvarez', 'Items.TygerClawsJunkItem1'), 'disliked');
  assert.equal(classify('takemura', 'Items.TygerClawsJunkItem1'), 'loved', 'an exact id beats a contains rule');
  assert.equal(classify('johnny-silverhand', 'Items.ArasakaEpicMKIII'), 'disliked');
  assert.equal(classify('kerry-eurodyne', 'Items.LowQualityAlcohol3'), 'disliked');
  assert.equal(classify('nobody', 'Items.X'), 'neutral'); assert.equal(classify('panam-palmer', ''), 'neutral'); assert.equal(classify('panam-palmer', undefined), 'neutral');
  // A longer prefix beats a shorter one, an id beats both.
  const tables = {characters: {x: {likes: {loved: [{prefix: 'Items.A'}], liked: [{prefix: 'Items.Abc'}], disliked: [{id: 'Items.AbcDef'}]}}}};
  assert.equal(classify('x', 'Items.Abz', tables), 'loved'); assert.equal(classify('x', 'Items.AbcXyz', tables), 'liked'); assert.equal(classify('x', 'Items.AbcDef', tables), 'disliked');
});

test('the bond of a counted gift: loved +8, liked +4, anything else +1, disliked -4', () => {
  assert.deepEqual({...GIFT_BOND}, {loved: 8, liked: 4, neutral: 1, disliked: -4});
  assert.deepEqual(['loved', 'liked', 'neutral', 'disliked', 'nothing'].map(giftBond), [8, 4, 1, -4, 0]);
});

test('Johnny and Songbird never take items; the likes the play file carries', () => {
  assert.equal(takesItems('johnny-silverhand'), false); assert.equal(takesItems('songbird'), false); assert.equal(takesItems('panam-palmer'), true);
  const likes = likesFor('panam-palmer');
  assert.equal(likes.takes, true); assert(likes.loved.some(rule => rule.prefix === 'Items.Nomad_'));
  assert.equal(likesFor('johnny-silverhand').takes, false);
  assert.equal(likesFor('nobody'), null);
});

test('the allowlist: every id of the tables, once, sorted; a community pack may use only those', () => {
  const ids = allowlist();
  assert(ids.length > 40); assert.deepEqual(ids, [...new Set(ids)].sort());
  assert(ids.includes('Items.Preset_Overture_Kerry') && ids.includes('Items.LowQualityAlcohol9'));
  assert(ids.every(id => /^Items\.[A-Za-z0-9_]+$/.test(id)));
  assert.equal(isAllowedGift('Items.Nomad_01_Set_TShirt'), true); assert.equal(isAllowedGift('Items.Weapon_Nope'), false); assert.equal(isAllowedGift(undefined), false);
  assert.deepEqual(allowlistFile(), {version: 1, ids});
});

test('the allowlist file is written when missing or changed, and left alone when the same', async () => {
  const files = new Map();
  const io = {read: async path => { if (!files.has(path)) throw Error('ENOENT'); return files.get(path); }, write: async (path, text) => { files.set(path, text); }};
  assert.equal(await syncAllowlist({path: 'a.json', ...io}), 'written');
  assert.deepEqual(JSON.parse(files.get('a.json')), allowlistFile());
  let writes = 0;
  const counting = {...io, write: async (path, text) => { writes++; files.set(path, text); }};
  assert.equal(await syncAllowlist({path: 'a.json', ...counting}), 'same'); assert.equal(writes, 0);
  files.set('a.json', JSON.stringify({version: 1, ids: ['Items.Old']}));
  assert.equal(await syncAllowlist({path: 'a.json', ...counting}), 'written'); assert.equal(writes, 1);
  files.set('a.json', 'not json');
  assert.equal(await syncAllowlist({path: 'a.json', ...counting}), 'written');
  assert.equal(await syncAllowlist({path: 'b.json', read: io.read, write: async () => { throw Error('disk'); }}), 'failed');
  assert.equal(await syncAllowlist({}), 'failed');
});
