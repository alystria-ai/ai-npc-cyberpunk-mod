// Models the player added by hand (bridge/custom-models.mjs) in the model choice (bridge/local-model-choice.mjs).
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {chooseLocalModel, describeLocalModels, listLocalModels, modelNeedMiB, stillSatisfies} from './local-model-choice.mjs';
import {allowanceFor} from './mature-content.mjs';

const sizes = {'std.gguf': 5280, 'lite.gguf': 1311, 'models/big-uncensored.gguf': 5400, 'models/small.gguf': 1400,
  'custom/big.gguf': 7000, 'custom/mid.gguf': 3500, 'custom/u.gguf': 2500, 'custom/huge.gguf': 40000, 'custom/off.gguf': 6000};
const sizeOf = file => sizes[file] ?? 0;
const pack = {tiers: {standard: {file: 'std.gguf', name: 'Gemma-4-E4B'}, lite: {file: 'lite.gguf', name: 'Qwen3.5-2B'}}};
const matureModels = [{file: 'models/big-uncensored.gguf', name: 'Gemma-4-E4B-uncensored', family: 'gemma', present: true},
  {file: 'models/small.gguf', name: 'Qwen3.5-2B-plain-name', family: 'qwen', present: true}];
const custom = (id, file, extra = {}) => ({id: 'custom:' + id, name: id, file, uncensored: false, auto: false, family: null, contextSize: null, chatTemplate: null, tooLarge: false, ...extra});
const customList = [custom('big', 'custom/big.gguf', {auto: true}), custom('mid', 'custom/mid.gguf'), custom('u', 'custom/u.gguf', {uncensored: true, auto: true}),
  custom('huge', 'custom/huge.gguf', {auto: true, tooLarge: true}), custom('off', 'custom/off.gguf', {uncensored: true})];
const all = listLocalModels({pack, matureModels, customModels: customList});
const choose = (options = {}) => chooseLocalModel({models: all, sizeOf, freeMiB: 24000, ...options});

test('custom models join the list after the built-in ones, with a custom id and their manifest flags', () => {
  assert.deepEqual(all.map(model => model.id), ['standard', 'lite', 'mature:big-uncensored', 'mature:small', 'custom:big', 'custom:mid', 'custom:u', 'custom:huge', 'custom:off']);
  const mid = all.find(model => model.id === 'custom:mid');
  assert.deepEqual([mid.custom, mid.auto, mid.uncensored, mid.tier], [true, false, false, null]);
  assert.equal(listLocalModels({pack}).some(model => model.custom), false);
  assert.deepEqual(listLocalModels({pack, customModels: [custom('a', 'a.gguf'), custom('a', 'b.gguf')]}).map(model => model.id), ['standard', 'lite', 'custom:a'], 'one id, one model');
  assert.deepEqual(listLocalModels({pack, customModels: [null, {id: 5}, {id: 'custom:x'}]}).map(model => model.id), ['standard', 'lite'], 'malformed entries are dropped');
});

test('the Mature allowance reads the manifest flag, in both directions, and a family label', () => {
  assert.equal(allowanceFor('My Model', {uncensored: true}).uncensored, true);
  assert.equal(allowanceFor('My Model', {uncensored: true}).level, 'full');
  assert.equal(allowanceFor('Llama-uncensored-v2', {uncensored: false}).uncensored, false);
  assert.equal(allowanceFor('Llama-uncensored-v2', {uncensored: false}).level, 'suggestive');
  assert.equal(allowanceFor('Llama-uncensored-v2').uncensored, true, 'without a flag the name still says so');
  assert.equal(allowanceFor('My Model', {uncensored: false, family: 'qwen'}).level, 'full', 'a family label is matched like a name');
  assert.equal(allowanceFor('My Model', {family: 'llama'}).level, 'suggestive');
  assert.equal(allowanceFor('My Model', null).level, 'suggestive');
});

test('auto never picks a custom model unless its manifest says auto; the built-in models stay first', () => {
  const noAuto = listLocalModels({pack, customModels: [custom('big', 'custom/big.gguf')]});
  assert.equal(chooseLocalModel({models: noAuto, sizeOf, freeMiB: 24000}).model.id, 'standard', 'the largest model is ignored without auto');
  const withAuto = listLocalModels({pack, customModels: [custom('big', 'custom/big.gguf', {auto: true})]});
  assert.equal(chooseLocalModel({models: withAuto, sizeOf, freeMiB: 24000}).model.id, 'custom:big', 'with auto it competes by size');
  assert.equal(chooseLocalModel({models: withAuto, sizeOf, freeMiB: 6500}).model.id, 'standard', 'and it must fit like any other');
  const equal = listLocalModels({pack, customModels: [custom('same', 'std.gguf', {auto: true})]});
  assert.equal(chooseLocalModel({models: equal, sizeOf, freeMiB: 24000}).model.id, 'standard', 'equal sizes keep the built-in model first');
  assert.equal(choose({matureOn: false}).model.id, 'custom:big');
  assert.equal(choose({freeMiB: null}).model.id, 'lite', 'unknown free memory: the smallest eligible');
});

test('an uncensored custom model is eligible for Mature Auto only with Mature content on and auto: true', () => {
  assert.equal(choose({matureOn: true}).model.id, 'mature:big-uncensored', 'the largest eligible uncensored model that fits');
  const customOnly = listLocalModels({pack, customModels: customList});
  const pick = options => chooseLocalModel({models: customOnly, sizeOf, freeMiB: 24000, ...options}).model.id;
  assert.equal(pick({matureOn: true}), 'custom:u');
  assert.equal(pick({matureOn: false}), 'custom:big', 'Mature off: an uncensored model is not preferred');
  const offOnly = listLocalModels({pack, customModels: [customList[4]]});
  assert.equal(chooseLocalModel({models: offOnly, sizeOf, freeMiB: 24000, matureOn: true}).model.id, 'standard', 'uncensored without auto stays out of Auto');
  assert.equal(pick({freeMiB: 2100, matureOn: true}), 'lite', 'the ordinary models are the fallback when the uncensored one does not fit');
});

test('a pin works for a custom model that fits, and falls back (with a reason) when it is too large, short of memory, gone or broken', () => {
  const pinned = choose({pin: 'custom:mid', matureOn: true});
  assert.deepEqual([pinned.model.id, pinned.pinned, pinned.fellBack], ['custom:mid', true, null]);
  assert.equal(choose({pin: 'custom:off'}).model.id, 'custom:off', 'a pin needs neither auto nor Mature content');
  const huge = choose({pin: 'custom:huge'});
  assert.deepEqual([huge.fellBack, huge.pinned], ['low-memory', false], 'too large for the card');
  assert.notEqual(huge.model.id, 'custom:huge');
  // The server may know the card's size before the scan did.
  const bigNeed = modelNeedMiB({tier: null}, 7000);
  assert.equal(choose({pin: 'custom:big', totalMiB: bigNeed - 1}).fellBack, 'low-memory');
  assert.equal(choose({pin: 'custom:big', totalMiB: bigNeed}).fellBack, null);
  assert.equal(choose({pin: 'custom:big', freeMiB: bigNeed - 1}).fellBack, 'low-memory');
  assert.equal(choose({pin: 'custom:gone'}).fellBack, 'missing');
  const broken = all.map(model => (model.id === 'custom:big' ? {...model, broken: true} : model));
  const afterFailure = chooseLocalModel({models: broken, pin: 'custom:big', sizeOf, freeMiB: 24000});
  assert.deepEqual([afterFailure.fellBack, afterFailure.model.id], ['start-failed', 'standard']);
  assert.equal(chooseLocalModel({models: broken, sizeOf, freeMiB: 24000}).model.id, 'standard', 'auto skips a custom model that failed to start');
  // A too large model is never an Auto choice, even when it is the only one.
  assert.throws(() => chooseLocalModel({models: listLocalModels({pack: {tiers: {}}, customModels: [customList[3]]}), sizeOf, freeMiB: 90000}), error => error.reason === 'low-memory');
});

test('stillSatisfies ignores a custom model Auto would not pick, and the published list marks custom models', () => {
  assert.equal(stillSatisfies({loadedId: 'custom:mid', models: all, pin: 'auto'}), false, 'loaded by a pin that is gone: Auto would not pick it');
  assert.equal(stillSatisfies({loadedId: 'custom:big', models: all, pin: 'auto', matureOn: false}), true);
  assert.equal(stillSatisfies({loadedId: 'custom:u', models: all, pin: 'auto', matureOn: true}), true);
  assert.equal(stillSatisfies({loadedId: 'custom:mid', models: all, pin: 'custom:mid'}), true);
  const list = describeLocalModels(all, sizeOf);
  assert.deepEqual(list.find(entry => entry.id === 'custom:mid'), {id: 'custom:mid', name: 'mid', sizeMiB: 3500, custom: true, needMiB: modelNeedMiB({tier: null}, 3500)});
  assert.deepEqual(list.find(entry => entry.id === 'custom:huge'), {id: 'custom:huge', name: 'huge', sizeMiB: 40000, custom: true, needMiB: 41200, tooLarge: true});
  assert.deepEqual(Object.keys(list[0]).sort(), ['id', 'name', 'sizeMiB']);
});
