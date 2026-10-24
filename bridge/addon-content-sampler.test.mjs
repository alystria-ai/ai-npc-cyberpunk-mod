import {test} from 'node:test';
import assert from 'node:assert/strict';
import {AddonHost, validateManifest} from './addons.mjs';
import {AddonContent, validateContent} from './addon-content.mjs';
import {PromptProfiles} from './prompt-profile-store.mjs';

// Content packs and the sampler fields / the Mature layer of a prompt profile: a pack's change goes through the same validateOverride a player's change does, with the same provider gating.
const pack = (id, content) => ({id, name: `${id} pack`, version: '1.0.0', requires: '1.1', content});
const hostOf = (...manifests) => new AddonHost({addons: manifests.map(value => validateManifest(value, `/mods/AiNpcCyberpunkMod${value.id}`))});
const MISTRAL = {route: 'mistral'}, LOCAL = {route: 'local', tier: 'standard', mature: false}, MATURE = {route: 'local', tier: 'standard', mature: true};
const CUSTOM = {route: 'custom', custom: {origin: 'http://127.0.0.1:1234', model: 'qwen-7b'}};

test('"*" keeps for each profile only what that profile accepts; a specific profile is checked strictly; the player stays on top', async () => {
  const content = new AddonContent({host: hostOf(pack('wide', {prompting: {'*': {sampling: {topK: 40, minP: 0.05, temperature: 0.8}, matureLayer: {tone: 'Warm and direct.'}}}}))});
  const store = new PromptProfiles({packs: content});
  const shipped = new PromptProfiles();
  const mistral = store.resolve(MISTRAL), standard = store.resolve(LOCAL), mature = store.resolve(MATURE), custom = store.resolve(CUSTOM);
  assert.equal(mistral.sampling.temperature, 0.8);
  assert.equal(mistral.sampling.topK, shipped.resolve(MISTRAL).sampling.topK, 'Mistral\'s API takes no top-K or min-P: they are left out for it');
  assert.equal(mistral.sampling.minP, shipped.resolve(MISTRAL).sampling.minP);
  assert.deepEqual(mistral.matureLayer, shipped.resolve(MISTRAL).matureLayer, 'no Mature layer for Mistral');
  assert.equal(standard.sampling.topK, 40);
  assert.deepEqual(standard.matureLayer, shipped.resolve(LOCAL).matureLayer, 'the Local AI option that runs with the Mature setting off has none');
  assert.equal(mature.matureLayer.tone, 'Warm and direct.');
  assert.equal(custom.matureLayer.tone, 'Warm and direct.');
  assert.equal(custom.sampling.minP, 0.05);
  await store.set('local-standard', {sampling: {topK: 10}});
  assert.equal(store.resolve(LOCAL).sampling.topK, 10, 'the player\'s change is laid over the pack\'s');
  assert.equal(store.resolve(LOCAL).sampling.minP, 0.05);
  const bad = (value, pattern) => assert.throws(() => validateContent(value), pattern);
  bad({prompting: {mistral: {sampling: {topK: 40}}}}, /content\.prompting\.mistral: sampling\.topK is not valid \(not-for-mistral\)/);
  bad({prompting: {mistral: {matureLayer: {tone: 'x'}}}}, /matureLayer is not valid \(no-mature-layer\)/);
  bad({prompting: {'local-standard': {matureLayer: {tone: 'x'}}}}, /no-mature-layer/);
  bad({prompting: {'*': {matureLayer: {nonsense: 'x'}}}}, /matureLayer\.nonsense is not valid \(unknown-field\)/);
  assert.deepEqual(validateContent({prompting: {'mature-lite': {matureLayer: {tone: 'x'}}}}).prompting, {'mature-lite': {matureLayer: {tone: 'x'}}});
});
