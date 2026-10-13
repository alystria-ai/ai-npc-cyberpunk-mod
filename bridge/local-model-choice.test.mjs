import {test} from 'node:test';
import assert from 'node:assert/strict';
import {AUTO_MODEL, chooseLocalModel, defaultModelIds, describeLocalModels, listLocalModels, modelNeedMiB, normalisePin, profileOf, sortLocalModels, stillSatisfies} from './local-model-choice.mjs';
import {tierNeedMiB} from './local-llm-server.mjs';
import {allowanceFor} from './mature-content.mjs';

const MiB = {std: 5280, lite: 1311, bigMature: 5400, smallMature: 1400};
const sizes = {'std.gguf': MiB.std, 'lite.gguf': MiB.lite, 'models/big-uncensored.gguf': MiB.bigMature, 'models/small.gguf': MiB.smallMature};
const sizeOf = file => sizes[file] ?? 0;
const pack = {tiers: {standard: {file: 'std.gguf', name: 'Gemma-4-E4B'}, lite: {file: 'lite.gguf', name: 'Qwen3.5-2B'}}};
const matureModels = [{tier: 'lite', file: 'models/small.gguf', name: 'Qwen3.5-2B-plain-name', family: 'qwen', present: true},
  {tier: 'good', file: 'models/big-uncensored.gguf', name: 'Gemma-4-E4B-uncensored', family: 'gemma', present: true}];

const stock = listLocalModels({pack});
const withMature = listLocalModels({pack, matureModels});
const pick = (models, options) => chooseLocalModel({models, sizeOf, freeMiB: 24000, ...options});
const needOf = id => { const item = withMature.find(model => model.id === id); return modelNeedMiB(item, sizeOf(item.file)); };

test('the list: standard, lite, then the Mature pack models; absent files are left out; names say uncensored', () => {
  assert.deepEqual(stock.map(model => model.id), ['standard', 'lite']);
  assert.deepEqual(withMature.map(model => model.id), ['standard', 'lite', 'mature:lite', 'mature:good']);
  assert.equal(withMature[2].uncensored, true);
  assert.equal(withMature[0].uncensored, false);
  assert.deepEqual(withMature.slice(2).map(model => model.matureTier), ['lite', 'good']);
  assert.deepEqual(listLocalModels({pack, matureModels: [{tier: 'good', file: 'models/gone.gguf', name: 'Gone', present: false}]}).map(model => model.id), ['standard', 'lite']);
  assert.deepEqual(listLocalModels({pack: {tiers: {standard: null, lite: pack.tiers.lite}}}).map(model => model.id), ['lite']);
  assert.deepEqual(listLocalModels({}), []);
  // The allowance reads the loaded name: a marker name that does not say so still reads as uncensored (full level).
  assert.equal(allowanceFor(withMature[2].loadedName).uncensored, true);
  assert.equal(withMature[2].name, 'Qwen3.5-2B-plain-name');
  assert.equal(allowanceFor(withMature[0].loadedName).uncensored, false);
  // The ids do not depend on the file names, so a saved choice survives a new file name.
  const renamed = listLocalModels({pack: {tiers: {}}, matureModels: [{tier: 'good', file: 'a/x.gguf', name: 'X'}, {tier: 'lite', file: 'b/y.gguf', name: 'Y'}]});
  assert.deepEqual(renamed.map(model => model.id), ['mature:lite', 'mature:good']);
});

test('the Mature pack lists at most two models, mature:lite and mature:good; a third, an unknown-tier or a duplicate entry is ignored', () => {
  const entry = (tier, file, name = 'M') => ({tier, file, name, present: true});
  const ids = list => listLocalModels({pack: {tiers: {}}, matureModels: list}).map(model => model.id);
  // Whatever the input order, lite comes first and there are two at most.
  assert.deepEqual(ids([entry('good', 'g.gguf'), entry('lite', 'l.gguf')]), ['mature:lite', 'mature:good']);
  assert.deepEqual(ids([entry('lite', 'l.gguf'), entry('good', 'g.gguf'), entry('huge', 'h.gguf'), entry(undefined, 'n.gguf'), entry('standard', 's.gguf')]), ['mature:lite', 'mature:good']);
  // A duplicate tier: the first one counts.
  const dup = listLocalModels({pack: {tiers: {}}, matureModels: [entry('good', 'first.gguf', 'First'), entry('good', 'second.gguf', 'Second'), entry('lite', 'l.gguf')]});
  assert.deepEqual(dup.map(model => [model.id, model.file]), [['mature:lite', 'l.gguf'], ['mature:good', 'first.gguf']]);
  // One tier alone is fine; an old-shape entry without a tier is not listed.
  assert.deepEqual(ids([entry('good', 'g.gguf')]), ['mature:good']);
  assert.deepEqual(ids([{file: 'old.gguf', name: 'Old', present: true}]), []);
  assert.deepEqual(ids(undefined), []);
});

test('no choice (the default) without the Mature pack: the best installed model that fits, whatever the Mature setting says', () => {
  for (const matureOn of [false, true]) {
    assert.equal(pick(stock, {matureOn}).model.id, 'standard');
    assert.equal(pick(stock, {matureOn, freeMiB: needOf('standard') - 1}).model.id, 'lite');
  }
  const result = pick(stock);
  assert.equal(result.pinned, false); assert.equal(result.fellBack, null); assert.equal(result.profile, 'standard');
});

test('no choice (the default) with the Mature pack and Mature content off never picks an uncensored model', () => {
  assert.equal(pick(withMature, {matureOn: false}).model.id, 'standard');
  assert.equal(pick(withMature, {matureOn: false, freeMiB: 2100}).model.id, 'lite');
});

test('no choice (the default) with the Mature pack and Mature content on prefers the largest uncensored model that fits', () => {
  assert.equal(pick(withMature, {matureOn: true}).model.id, 'mature:good');
  assert.equal(pick(withMature, {matureOn: true, freeMiB: needOf('mature:good') - 1}).model.id, 'mature:lite');
  // The big one's profile is by size (standard headroom), the small one's lite.
  assert.equal(pick(withMature, {matureOn: true}).profile, 'standard');
  assert.equal(pick(withMature, {matureOn: true, freeMiB: needOf('mature:lite')}).profile, 'lite');
  // None of the uncensored models fits: the ordinary ones are the fallback, never an uncensored one that does not fit.
  const tight = needOf('mature:lite') - 1;
  assert.ok(tight >= needOf('lite'), 'the lite model still fits (test premise)');
  assert.equal(pick(withMature, {matureOn: true, freeMiB: tight}).model.id, 'lite');
});

test('a pinned model is used whatever fits better, and whatever Mature content says', () => {
  assert.equal(pick(withMature, {pin: 'lite'}).model.id, 'lite');
  assert.equal(pick(withMature, {pin: 'lite', matureOn: true}).model.id, 'lite');
  const pinned = pick(withMature, {pin: 'mature:good', matureOn: false});
  assert.equal(pinned.model.id, 'mature:good'); assert.equal(pinned.pinned, true); assert.equal(pinned.fellBack, null);
  assert.equal(pick(withMature, {pin: 'standard', matureOn: true}).model.id, 'standard');
  assert.equal(pick(withMature, {pin: AUTO_MODEL, matureOn: true}).model.id, 'mature:good');
});

test('a chosen model that is missing falls back to the default, and says why', () => {
  const missing = pick(stock, {pin: 'mature:good'});
  assert.equal(missing.model.id, 'standard'); assert.equal(missing.fellBack, 'missing'); assert.equal(missing.pinned, false);
  // With Mature content on and the pack gone, the fallback is still never an uncensored model.
  assert.equal(pick(stock, {pin: 'mature:good', matureOn: true}).model.id, 'standard');
  assert.equal(pick(withMature, {pin: 'nonsense', matureOn: true}).fellBack, 'missing');
});

test('a chosen model that does not fit falls back to the default, and says why (the low-memory fallback)', () => {
  const free = needOf('standard') - 1;
  const result = pick(stock, {pin: 'standard', freeMiB: free});
  assert.equal(result.model.id, 'lite'); assert.equal(result.fellBack, 'low-memory');
  // A pinned uncensored model that does not fit: Mature on picks the uncensored one that fits, Mature off an ordinary one.
  const small = needOf('mature:good') - 1;
  assert.equal(pick(withMature, {pin: 'mature:good', matureOn: true, freeMiB: small}).model.id, 'mature:lite');
  const off = pick(withMature, {pin: 'mature:good', matureOn: false, freeMiB: small});
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
    assert.equal(pick(withMature, {freeMiB, matureOn: true}).model.id, 'mature:lite');
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

test('stillSatisfies: a chosen model needs that model, no choice any model of the group the default would pick from', () => {
  assert.equal(stillSatisfies({loadedId: 'standard', models: withMature, pin: 'standard'}), true);
  assert.equal(stillSatisfies({loadedId: 'standard', models: withMature, pin: 'lite'}), false);
  assert.equal(stillSatisfies({loadedId: 'lite', models: withMature, pin: 'auto', matureOn: false}), true);
  assert.equal(stillSatisfies({loadedId: 'standard', models: withMature, pin: 'auto', matureOn: true}), false);
  assert.equal(stillSatisfies({loadedId: 'mature:lite', models: withMature, pin: 'auto', matureOn: true}), true);
  assert.equal(stillSatisfies({loadedId: 'mature:lite', models: withMature, pin: 'auto', matureOn: false}), false);
  assert.equal(stillSatisfies({loadedId: 'standard', models: stock, pin: 'auto', matureOn: true}), true, 'no uncensored model installed');
  assert.equal(stillSatisfies({loadedId: 'standard', models: stock, pin: 'gone', matureOn: false}), true, 'a missing pin is auto');
  assert.equal(stillSatisfies({loadedId: null, models: stock}), false);
});

test('the published list is sorted by file size, smallest first, equal sizes by name, and has names and sizes only', () => {
  const list = describeLocalModels(withMature, sizeOf);
  assert.deepEqual(list.map(entry => entry.id), ['lite', 'mature:lite', 'standard', 'mature:good'], 'smallest to largest, no Auto entry');
  assert.deepEqual(list[2], {id: 'standard', name: 'Gemma-4-E4B', sizeMiB: 5280});
  assert.equal(list.length, 4);
  for (const entry of list) assert.deepEqual(Object.keys(entry).sort(), ['id', 'name', 'sizeMiB']);
  assert.equal(list.some(entry => entry.id === AUTO_MODEL), false);
  // Equal sizes: by name (case-insensitive), then id; the input is not reordered.
  const same = [{id: 'b', name: 'Zeta', file: 'a'}, {id: 'c', name: 'alpha', file: 'b'}, {id: 'a', name: 'Alpha', file: 'c'}, {id: 'd', name: 'tiny', file: 'd'}];
  const bySame = file => (file === 'd' ? 100 : 500);
  assert.deepEqual(sortLocalModels(same, bySame).map(model => model.id), ['d', 'a', 'c', 'b']);
  assert.deepEqual(same.map(model => model.id), ['b', 'c', 'a', 'd']);
  assert.deepEqual(describeLocalModels(same, bySame).map(entry => entry.id), ['d', 'a', 'c', 'b']);
});

test('the default model: the largest that fits the free memory, shown as selected; a legacy saved `auto` means the same', () => {
  assert.equal(normalisePin('auto'), AUTO_MODEL, 'a value an older version saved still reads');
  const ids = options => defaultModelIds({models: withMature, sizeOf, freeMiB: 24000, ...options});
  assert.equal(ids().default, 'standard');
  assert.equal(ids({freeMiB: needOf('standard') - 1}).default, 'lite');
  assert.equal(ids({freeMiB: null}).default, 'lite', 'unknown free memory: the smallest, as when loading');
  assert.equal(defaultModelIds({models: [], sizeOf}).default, null);
  assert.deepEqual(defaultModelIds({models: [], sizeOf}), {default: null, mature: null});
  // It is what loading chooses for `auto` (or for no choice at all), so the row never shows a model that is not the one loaded.
  for (const freeMiB of [24000, needOf('standard') - 1, 2100]) {
    assert.equal(ids({freeMiB}).default, pick(withMature, {pin: AUTO_MODEL, freeMiB}).model.id);
    assert.equal(ids({freeMiB, matureOn: true}).default, pick(withMature, {pin: AUTO_MODEL, matureOn: true, freeMiB}).model.id);
  }
  assert.equal(ids({matureOn: true}).default, 'mature:good', 'Mature content on: the default is the uncensored model');
  // A migrated legacy value becomes the concrete id the settings page saves; loading it is a plain choice, not a fallback.
  const migrated = pick(withMature, {pin: ids().default});
  assert.deepEqual([migrated.model.id, migrated.pinned, migrated.fellBack], ['standard', true, null]);
  // Nothing fits: no default to show (and loading says low-memory).
  assert.equal(ids({freeMiB: 1000}).default, null);
});

test('turning Mature content on selects the largest uncensored model that fits, or nothing when none is installed', () => {
  const ids = options => defaultModelIds({models: withMature, sizeOf, freeMiB: 24000, ...options});
  assert.equal(ids().mature, 'mature:good');
  assert.equal(ids({freeMiB: needOf('mature:good') - 1}).mature, 'mature:lite');
  assert.equal(ids({freeMiB: needOf('mature:lite') - 1}).mature, null, 'installed but none fits: nothing is selected');
  assert.equal(defaultModelIds({models: stock, sizeOf, freeMiB: 24000}).mature, null, 'no uncensored model installed');
  assert.equal(ids({matureOn: false}).mature, 'mature:good', 'the answer does not depend on the setting being on yet');
});

test('the fallback names the model it used: the largest that fits, an uncensored one first while Mature content is on', () => {
  const missing = pick(withMature, {pin: 'gone', matureOn: false});
  assert.deepEqual([missing.fellBack, missing.model.id, missing.model.name], ['missing', 'standard', 'Gemma-4-E4B']);
  const matureMissing = pick(withMature, {pin: 'gone', matureOn: true});
  assert.deepEqual([matureMissing.fellBack, matureMissing.model.name], ['missing', 'Gemma-4-E4B-uncensored']);
  const tight = pick(withMature, {pin: 'standard', matureOn: true, freeMiB: needOf('standard') - 1});
  assert.deepEqual([tight.fellBack, tight.model.id], ['low-memory', 'mature:lite'], 'the largest uncensored model that fits');
  const failed = withMature.map(model => (model.id === 'standard' ? {...model, broken: true} : model));
  const afterFailure = chooseLocalModel({models: failed, pin: 'standard', sizeOf, freeMiB: 24000});
  assert.deepEqual([afterFailure.fellBack, afterFailure.model.id], ['start-failed', 'lite']);
});

test('Mature on: the default is mature:good when it fits, mature:lite when only that fits, and an ordinary model when no Mature model fits', () => {
  const good = needOf('mature:good'), lite = needOf('mature:lite');
  const on = freeMiB => pick(withMature, {matureOn: true, freeMiB});
  assert.equal(on(good).model.id, 'mature:good');
  assert.equal(on(good - 1).model.id, 'mature:lite');
  assert.equal(on(lite).model.id, 'mature:lite');
  assert.equal(on(lite - 1).model.id, 'lite', 'no Mature model fits: the ordinary default');
  assert.equal(on(lite - 1).fellBack, null);
  // Only one Mature model installed.
  const onlyLite = listLocalModels({pack, matureModels: matureModels.filter(model => model.tier === 'lite')});
  assert.equal(pick(onlyLite, {matureOn: true}).model.id, 'mature:lite');
  assert.equal(defaultModelIds({models: onlyLite, sizeOf, freeMiB: 24000}).mature, 'mature:lite');
  // Mature off never picks them.
  assert.equal(pick(withMature, {matureOn: false}).model.id, 'standard');
});

test('the picker lists the Mature pack models by size with the standard and lite models', () => {
  const list = describeLocalModels(withMature, sizeOf);
  assert.deepEqual(list.map(entry => [entry.id, entry.sizeMiB]), [['lite', MiB.lite], ['mature:lite', MiB.smallMature], ['standard', MiB.std], ['mature:good', MiB.bigMature]]);
  assert.deepEqual(list.map(entry => entry.name), ['Qwen3.5-2B', 'Qwen3.5-2B-plain-name', 'Gemma-4-E4B', 'Gemma-4-E4B-uncensored']);
  assert.deepEqual(describeLocalModels(listLocalModels({pack: {tiers: {}}, matureModels}), sizeOf).map(entry => entry.id), ['mature:lite', 'mature:good']);
});

test('headroom: mature:good needs its file plus the standard headroom, mature:lite its file plus the lite headroom, whatever the sizes', () => {
  const [lite, good] = withMature.filter(model => model.uncensored);
  assert.equal(profileOf(good, 100), 'standard', 'by tier, not by size');
  assert.equal(profileOf(lite, 9000), 'lite', 'by tier, not by size');
  assert.equal(modelNeedMiB(good, MiB.bigMature), tierNeedMiB('standard', MiB.bigMature));
  assert.equal(modelNeedMiB(lite, MiB.smallMature), tierNeedMiB('lite', MiB.smallMature));
  assert.equal(modelNeedMiB(good, 2000), tierNeedMiB('standard', 2000));
  assert.equal(modelNeedMiB(lite, 4000), tierNeedMiB('lite', 4000));
  assert.ok(modelNeedMiB(good, MiB.bigMature) > MiB.bigMature && modelNeedMiB(lite, MiB.smallMature) > MiB.smallMature);
  // A custom model is still by size.
  assert.equal(profileOf({tier: null, custom: true}, 3000), 'standard');
  assert.equal(profileOf({tier: null, custom: true}, 2999), 'lite');
});
