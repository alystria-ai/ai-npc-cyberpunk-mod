import {test} from 'node:test';
import assert from 'node:assert/strict';
import {AUTO_MODEL, chooseLocalModel, describeLocalModels, listLocalModels, modelNeedMiB, normalisePin, stillSatisfies} from './local-model-choice.mjs';
import {allowanceFor} from './mature-content.mjs';

const MiB = {std: 5280, lite: 1311, bigMature: 5400, smallMature: 1400};
const sizes = {'std.gguf': MiB.std, 'lite.gguf': MiB.lite, 'models/big-uncensored.gguf': MiB.bigMature, 'models/small.gguf': MiB.smallMature};
const sizeOf = file => sizes[file] ?? 0;
const pack = {tiers: {standard: {file: 'std.gguf', name: 'Gemma-4-E4B'}, lite: {file: 'lite.gguf', name: 'Qwen3.5-2B'}}};
const matureModels = [{file: 'models/big-uncensored.gguf', name: 'Gemma-4-E4B-uncensored', family: 'gemma', present: true},
  {file: 'models/small.gguf', name: 'Qwen3.5-2B-plain-name', family: 'qwen', present: true}];

const stock = listLocalModels({pack});
const withMature = listLocalModels({pack, matureModels});
const pick = (models, options) => chooseLocalModel({models, sizeOf, freeMiB: 24000, ...options});
const needOf = id => { const item = withMature.find(model => model.id === id); return modelNeedMiB(item, sizeOf(item.file)); };

test('the list: standard, lite, then the Mature pack models; absent files are left out; names say uncensored', () => {
  assert.deepEqual(stock.map(model => model.id), ['standard', 'lite']);
  assert.deepEqual(withMature.map(model => model.id), ['standard', 'lite', 'mature:big-uncensored', 'mature:small']);
  assert.equal(withMature[2].uncensored, true);
  assert.equal(withMature[0].uncensored, false);
  assert.deepEqual(listLocalModels({pack, matureModels: [{file: 'models/gone.gguf', name: 'Gone', present: false}]}).map(model => model.id), ['standard', 'lite']);
  assert.deepEqual(listLocalModels({pack: {tiers: {standard: null, lite: pack.tiers.lite}}}).map(model => model.id), ['lite']);
  assert.deepEqual(listLocalModels({}), []);
  // The allowance reads the loaded name: a marker name that does not say so still reads as uncensored (full level).
  assert.equal(allowanceFor(withMature[3].loadedName).uncensored, true);
  assert.equal(withMature[3].name, 'Qwen3.5-2B-plain-name');
  assert.equal(allowanceFor(withMature[0].loadedName).uncensored, false);
  // Two files with the same base name keep distinct ids.
  const twins = listLocalModels({pack: {tiers: {}}, matureModels: [{file: 'a/x.gguf', name: 'X'}, {file: 'b/x.gguf', name: 'X'}]});
  assert.deepEqual(twins.map(model => model.id), ['mature:x', 'mature:x-2']);
});

test('auto without the Mature pack: the best installed model that fits, whatever the Mature setting says', () => {
  for (const matureOn of [false, true]) {
    assert.equal(pick(stock, {matureOn}).model.id, 'standard');
    assert.equal(pick(stock, {matureOn, freeMiB: needOf('standard') - 1}).model.id, 'lite');
  }
  const result = pick(stock);
  assert.equal(result.pinned, false); assert.equal(result.fellBack, null); assert.equal(result.profile, 'standard');
});

test('auto with the Mature pack and Mature content off never picks an uncensored model', () => {
  assert.equal(pick(withMature, {matureOn: false}).model.id, 'standard');
  assert.equal(pick(withMature, {matureOn: false, freeMiB: 2100}).model.id, 'lite');
});

test('auto with the Mature pack and Mature content on prefers the largest uncensored model that fits', () => {
  assert.equal(pick(withMature, {matureOn: true}).model.id, 'mature:big-uncensored');
  assert.equal(pick(withMature, {matureOn: true, freeMiB: needOf('mature:big-uncensored') - 1}).model.id, 'mature:small');
  // The big one's profile is by size (standard headroom), the small one's lite.
  assert.equal(pick(withMature, {matureOn: true}).profile, 'standard');
  assert.equal(pick(withMature, {matureOn: true, freeMiB: needOf('mature:small')}).profile, 'lite');
  // None of the uncensored models fits: the ordinary ones are the fallback, never an uncensored one that does not fit.
  const tight = needOf('mature:small') - 1;
  assert.ok(tight >= needOf('lite'), 'the lite model still fits (test premise)');
  assert.equal(pick(withMature, {matureOn: true, freeMiB: tight}).model.id, 'lite');
});

test('a pinned model is used whatever fits better, and whatever Mature content says', () => {
  assert.equal(pick(withMature, {pin: 'lite'}).model.id, 'lite');
  assert.equal(pick(withMature, {pin: 'lite', matureOn: true}).model.id, 'lite');
  const pinned = pick(withMature, {pin: 'mature:big-uncensored', matureOn: false});
  assert.equal(pinned.model.id, 'mature:big-uncensored'); assert.equal(pinned.pinned, true); assert.equal(pinned.fellBack, null);
  assert.equal(pick(withMature, {pin: 'standard', matureOn: true}).model.id, 'standard');
  assert.equal(pick(withMature, {pin: AUTO_MODEL, matureOn: true}).model.id, 'mature:big-uncensored');
});

test('a pinned model that is missing falls back to auto, and says why', () => {
  const missing = pick(stock, {pin: 'mature:big-uncensored'});
  assert.equal(missing.model.id, 'standard'); assert.equal(missing.fellBack, 'missing'); assert.equal(missing.pinned, false);
  // With Mature content on and the pack gone, the fallback is still never an uncensored model.
  assert.equal(pick(stock, {pin: 'mature:big-uncensored', matureOn: true}).model.id, 'standard');
  assert.equal(pick(withMature, {pin: 'nonsense', matureOn: true}).fellBack, 'missing');
});

test('a pinned model that does not fit falls back to auto, and says why (the low-memory fallback)', () => {
  const free = needOf('standard') - 1;
  const result = pick(stock, {pin: 'standard', freeMiB: free});
  assert.equal(result.model.id, 'lite'); assert.equal(result.fellBack, 'low-memory');
  // A pinned uncensored model that does not fit: Mature on picks the uncensored one that fits, Mature off an ordinary one.
  const small = needOf('mature:big-uncensored') - 1;
  assert.equal(pick(withMature, {pin: 'mature:big-uncensored', matureOn: true, freeMiB: small}).model.id, 'mature:small');
  const off = pick(withMature, {pin: 'mature:big-uncensored', matureOn: false, freeMiB: small});
  assert.equal(off.model.id, 'standard'); assert.equal(off.fellBack, 'low-memory');
});

test('nothing fits, or nothing is installed', () => {
  assert.throws(() => pick(stock, {freeMiB: 1000}), error => error.reason === 'low-memory');
  assert.throws(() => pick(withMature, {freeMiB: 1000, matureOn: true}), error => error.reason === 'low-memory');
  assert.throws(() => pick([], {}), error => error.reason === 'not-installed');
  assert.throws(() => pick(stock, {pin: 'standard', freeMiB: 1000}), error => error.reason === 'low-memory');
});

test('unknown free memory takes the smallest model of the group', () => {
  for (const freeMiB of [null, NaN]) {
    assert.equal(pick(stock, {freeMiB}).model.id, 'lite');
    assert.equal(pick(withMature, {freeMiB, matureOn: true}).model.id, 'mature:small');
    assert.equal(pick(withMature, {freeMiB, matureOn: false}).model.id, 'lite');
    assert.equal(pick(stock, {freeMiB, pin: 'standard'}).model.id, 'standard');
  }
  // Without sizes the standard model is still preferred when memory is known and fits (the older rule).
  assert.equal(chooseLocalModel({models: stock, freeMiB: 3500, sizeOf: () => 0}).model.id, 'standard');
  assert.equal(chooseLocalModel({models: stock, freeMiB: 3499, sizeOf: () => 0}).model.id, 'lite');
});

test('pins are read defensively', () => {
  assert.equal(normalisePin('auto'), 'auto');
  assert.equal(normalisePin('lite'), 'lite');
  assert.equal(normalisePin('mature:x-1.q4_k_m'), 'mature:x-1.q4_k_m');
  for (const bad of [undefined, null, 5, '', 'a b', '../x', 'x'.repeat(81), {}]) assert.equal(normalisePin(bad), 'auto');
});

test('stillSatisfies: a pin needs that model, auto any model of the group it would pick from', () => {
  assert.equal(stillSatisfies({loadedId: 'standard', models: withMature, pin: 'standard'}), true);
  assert.equal(stillSatisfies({loadedId: 'standard', models: withMature, pin: 'lite'}), false);
  assert.equal(stillSatisfies({loadedId: 'lite', models: withMature, pin: 'auto', matureOn: false}), true);
  assert.equal(stillSatisfies({loadedId: 'standard', models: withMature, pin: 'auto', matureOn: true}), false);
  assert.equal(stillSatisfies({loadedId: 'mature:small', models: withMature, pin: 'auto', matureOn: true}), true);
  assert.equal(stillSatisfies({loadedId: 'mature:small', models: withMature, pin: 'auto', matureOn: false}), false);
  assert.equal(stillSatisfies({loadedId: 'standard', models: stock, pin: 'auto', matureOn: true}), true, 'no uncensored model installed');
  assert.equal(stillSatisfies({loadedId: 'standard', models: stock, pin: 'gone', matureOn: false}), true, 'a missing pin is auto');
  assert.equal(stillSatisfies({loadedId: null, models: stock}), false);
});

test('the published list has names and sizes only', () => {
  const list = describeLocalModels(withMature, sizeOf);
  assert.deepEqual(list[0], {id: 'standard', name: 'Gemma-4-E4B', sizeMiB: 5280});
  assert.equal(list.length, 4);
  for (const entry of list) assert.deepEqual(Object.keys(entry).sort(), ['id', 'name', 'sizeMiB']);
});
