import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {BUILT_IN_IDS, FAMILY_IDS, defaultProfile, customProfileId, profileSignature, BASE_PROFILE} from './prompt-profiles.mjs';
import {buildMessages, systemHead, LIMITS} from './mistral-prompt.mjs';
import {buildPrompt, HISTORY, MEMORY, REMEMBERED, USER_LINES} from '../scripts/judy-prompt-fixture.mjs';

// Pins the prompt every shipped profile builds, byte for byte (the cache prefix of a profile must not move without someone meaning it): Judy's fixture turn, a reaction, and for the Mature
// profiles the turn with the Mature layer on. A change to a profile's wording, order, labels or sampling changes its hash here; re-take the hash on purpose (PRINT_PINS=1 node --test
// bridge/prompt-profiles-pinned.test.mjs prints them) and say why in the commit. The first group is the base prompt every text provider had before profiles, pinned in prompt-pinned.test.mjs too.
const prompt = buildPrompt();
const sha = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const build = (profile, extra = {}) => buildMessages({persona: prompt.persona, memory: MEMORY, history: HISTORY, contextParts: prompt.contextParts, remembered: REMEMBERED, text: USER_LINES.a, limits: LIMITS, profile, ...extra});
const familyId = family => `family:${family}`;
const profileOf = id => (id.startsWith('family:') ? defaultProfile(customProfileId('http://example.test', 'x'), {family: id.slice(7)}) : defaultProfile(id));

const IDS = [...BUILT_IN_IDS, ...FAMILY_IDS.map(familyId)];
const MATURE = new Set(['mature-lite', 'mature-standard']);
const table = () => Object.fromEntries(IDS.map(id => {
  const profile = profileOf(id);
  return [id, {turn: sha(build(profile)), reaction: sha(build(profile, {text: 'a loot event', reaction: true})), head: sha(systemHead({persona: prompt.persona, profile})),
    ...(MATURE.has(id) ? {mature: sha(build(profile, {mature: 'full'}))} : {}), signature: profileSignature(profile)}];
}));

const PINNED = {
  "mistral": {"turn":"246cef719ae806e21b020f63c8f3268db2945a60eb59befcb0a22e068721f75c","reaction":"a4014c6a00aa75cbc3d61f69233a492ae18668d9c8b13cec5e5ae22e9bfff05a","head":"9c94217f23d71b52ca54132e3bc102d557dcafca196f84d4a9f579b42bdad613","signature":"429dc7810157"},
  "local-lite": {"turn":"b9488a764ceeadeda8d88cae76b1188d6b510558bb876109bb8a29ce55e59b70","reaction":"6683e7d6f7b00bdbbbc80899ddf384c5819d7679308e43adbcd8bd194ed80ebb","head":"59565b3d6364e85c56ccf78a80bce489e3fc77ca4d084bfe38b33d3daa4f0614","signature":"a5f26858893d"},
  "local-standard": {"turn":"3f49e013ae553b12ab6e77e713927ee78c7d8baa1913a22107a697e0207d4e6c","reaction":"6ee220a6e899bda7e5047494c838ab84dda60c4a0dea226222938cf83c6b985b","head":"de8d1bb43da5275dded103f43ae7138a7739d7eddb8d992dfdd863aa0968105e","signature":"f7d2016dba6b"},
  "mature-lite": {"turn":"62e4962f393215e12158e1f0211674e3694bdfcf9d2e134e002b1f95d5f4e469","reaction":"6ee220a6e899bda7e5047494c838ab84dda60c4a0dea226222938cf83c6b985b","head":"de8d1bb43da5275dded103f43ae7138a7739d7eddb8d992dfdd863aa0968105e","mature":"cbf5fbbb6f4d8cbb289fd3de1b32e7d9fc0e11e6a11f3d298afad83a67b82341","signature":"f9a7c3471202"},
  "mature-standard": {"turn":"06b0bae49fec4b359b06897166c9e067eb565b8597d17cc408c25df063995063","reaction":"51e1aa0eb687cfc2a43182bbe7f89cd08d8c2ae463c11391318c667b1a8211aa","head":"0659b1188e297aa74712cc210ca98a9b528ec63a3cef04316fc5aef45d643fe3","mature":"3b035a45fb711ff0ac8bcdb6f2f142e341ba9e8edefbb6b176dd781bedc6de25","signature":"17613c33f35c"},
  "family:generic": {"turn":"a5ded27888f73053173cdac97e5b779c924eec27c4b6dcb2e38598bfa6358476","reaction":"ca95a028a356817ee92628512116f37adf06ade3ea0f6aaf455d315fb2919d82","head":"e280e404f9a7f4db6cf79db635db722f61f92b3189b561a30b75fe257938c856","signature":"9389d1dc73b5"},
  "family:qwen": {"turn":"3f49e013ae553b12ab6e77e713927ee78c7d8baa1913a22107a697e0207d4e6c","reaction":"6ee220a6e899bda7e5047494c838ab84dda60c4a0dea226222938cf83c6b985b","head":"de8d1bb43da5275dded103f43ae7138a7739d7eddb8d992dfdd863aa0968105e","signature":"f7d2016dba6b"},
  "family:gemma": {"turn":"3f49e013ae553b12ab6e77e713927ee78c7d8baa1913a22107a697e0207d4e6c","reaction":"6ee220a6e899bda7e5047494c838ab84dda60c4a0dea226222938cf83c6b985b","head":"de8d1bb43da5275dded103f43ae7138a7739d7eddb8d992dfdd863aa0968105e","signature":"f7d2016dba6b"},
  "family:llama": {"turn":"a5ded27888f73053173cdac97e5b779c924eec27c4b6dcb2e38598bfa6358476","reaction":"ca95a028a356817ee92628512116f37adf06ade3ea0f6aaf455d315fb2919d82","head":"e280e404f9a7f4db6cf79db635db722f61f92b3189b561a30b75fe257938c856","signature":"9389d1dc73b5"},
  "family:mistral": {"turn":"246cef719ae806e21b020f63c8f3268db2945a60eb59befcb0a22e068721f75c","reaction":"a4014c6a00aa75cbc3d61f69233a492ae18668d9c8b13cec5e5ae22e9bfff05a","head":"9c94217f23d71b52ca54132e3bc102d557dcafca196f84d4a9f579b42bdad613","signature":"429dc7810157"}
};

test('the prompt of every shipped profile is pinned', () => {
  const actual = table();
  if (process.env.PRINT_PINS) console.log(JSON.stringify(actual, null, 2));
  assert.deepEqual(Object.keys(PINNED).sort(), IDS.slice().sort(), 'every profile has a pin');
  for (const id of IDS) assert.deepEqual(actual[id], PINNED[id], id);
});

test('the base profile is the prompt before profiles; the tuned profiles differ from it and from each other; generic and llama are the base', () => {
  const actual = table(), base = sha(build(BASE_PROFILE));
  assert.equal(base, sha(build(undefined)));
  assert.equal(actual['family:generic'].turn, base);
  assert.equal(actual['family:llama'].turn, base);
  const tuned = ['mistral', 'local-lite', 'local-standard', 'mature-lite', 'mature-standard'];
  assert.equal(new Set(tuned.map(id => actual[id].turn)).size, tuned.length);
  for (const id of tuned) assert.notEqual(actual[id].turn, base, id);
  // A Custom endpoint serving a Gemma or Qwen model starts from the Standard wording; one serving a Mistral model from the Mistral profile.
  assert.equal(actual['family:gemma'].turn, actual['local-standard'].turn);
  assert.equal(actual['family:mistral'].turn, actual.mistral.turn);
});
