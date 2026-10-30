import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {BUILT_IN_IDS, FAMILY_IDS, defaultProfile, customProfileId, profileSignature, BASE_PROFILE} from './prompt-profiles.mjs';
import {buildMessages, systemHead, LIMITS} from './mistral-prompt.mjs';
import {buildPrompt, HISTORY, MEMORY, REMEMBERED, USER_LINES} from '../scripts/judy-prompt-fixture.mjs';

// Pins the prompt every shipped profile builds, byte for byte (the cache prefix of a profile must not move without someone meaning it): Judy's fixture turn, a reaction, and for the Mature
// profiles the turn with the Mature layer on. A change to a profile's wording, order, labels or sampling changes its hash here; re-take the hash on purpose (PRINT_PINS=1 node --test
// bridge/prompt-profiles-pinned.test.mjs prints them) and say why in the commit. The first group is the base prompt every text provider had before profiles, pinned in prompt-pinned.test.mjs too.
// Re-taken on 2026-10-30 (fix/natural-talk): the world heading of every profile, V's money band only when V talks money, and the new Gemini family.
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
  "mistral": {"turn":"0c1be727f206c849bd181e6064faa70eb9ad32185be3a90f71bab0c0c6bd2016","reaction":"f67e23ea98a683ee93524c264cd73dd385f845f92d7818f18f07aef99ef6c7dd","head":"9c94217f23d71b52ca54132e3bc102d557dcafca196f84d4a9f579b42bdad613","signature":"b6fd7ef65846"},
  "local-lite": {"turn":"10949f2878a3992744dc9b02b12d952e8aa8acb398e067606b4292de6300cb6c","reaction":"2921db211e462d9c5ee029a7711aa4ac132ab69f78e312e54ad5b09ce4229735","head":"59565b3d6364e85c56ccf78a80bce489e3fc77ca4d084bfe38b33d3daa4f0614","signature":"ea6db67d14b3"},
  "local-standard": {"turn":"97d3d1d74ef3edb6658115c9efa89213084b61f9bfac02ca3dfc1f86f8e07305","reaction":"f427d868f54136c9c067364627e2e26cc80c99e2a1b1fb35c3eee971bd24795a","head":"de8d1bb43da5275dded103f43ae7138a7739d7eddb8d992dfdd863aa0968105e","signature":"87b2f69950eb"},
  "mature-lite": {"turn":"eea35e380bdf4bab214d527545989a44c5ac83790f03859e6bed5f666ae88e87","reaction":"f427d868f54136c9c067364627e2e26cc80c99e2a1b1fb35c3eee971bd24795a","head":"de8d1bb43da5275dded103f43ae7138a7739d7eddb8d992dfdd863aa0968105e","mature":"7d25cc8612037d31d15d5f4e3c9b44288b63f410d8323dd03d5d718c04374e8e","signature":"c23049cd7797"},
  "mature-standard": {"turn":"79b32792921d96211897f2373c8f887b372336b8dd172b23c112386db7e4fe8b","reaction":"10a315b20d72fe7909974792cf12c254bbe4befb9db3260db1d11d2c5db58c9a","head":"0659b1188e297aa74712cc210ca98a9b528ec63a3cef04316fc5aef45d643fe3","mature":"b6bb2897161b850647fd3515665b0357d5fe459469b835835501b046e6ea7fc3","signature":"8166bc5d2476"},
  "family:generic": {"turn":"e7f631fd314860ed26210edf71bda8e2c5180ec695b59ebb0b92300a9497fd2e","reaction":"da97a53ed834c7460ce047ccd35b20deff739664192e7a6d7c37030cbbfe8360","head":"e280e404f9a7f4db6cf79db635db722f61f92b3189b561a30b75fe257938c856","signature":"99663bfbfe54"},
  "family:qwen": {"turn":"97d3d1d74ef3edb6658115c9efa89213084b61f9bfac02ca3dfc1f86f8e07305","reaction":"f427d868f54136c9c067364627e2e26cc80c99e2a1b1fb35c3eee971bd24795a","head":"de8d1bb43da5275dded103f43ae7138a7739d7eddb8d992dfdd863aa0968105e","signature":"87b2f69950eb"},
  "family:gemma": {"turn":"97d3d1d74ef3edb6658115c9efa89213084b61f9bfac02ca3dfc1f86f8e07305","reaction":"f427d868f54136c9c067364627e2e26cc80c99e2a1b1fb35c3eee971bd24795a","head":"de8d1bb43da5275dded103f43ae7138a7739d7eddb8d992dfdd863aa0968105e","signature":"87b2f69950eb"},
  "family:gemini": {"turn":"04a25633bca6aea229b19285aa9c718272732f4dabafbb9c0c46af1ee208961a","reaction":"1f985012d1823181df323740b87d7f192a7f1ab53edc3a61ea2a208b96689d25","head":"0fefd796da2300e16155a8dd7535b8a2c07b8cd8e0d2c4cd70444b6106beb386","signature":"c535e46ec582"},
  "family:llama": {"turn":"e7f631fd314860ed26210edf71bda8e2c5180ec695b59ebb0b92300a9497fd2e","reaction":"da97a53ed834c7460ce047ccd35b20deff739664192e7a6d7c37030cbbfe8360","head":"e280e404f9a7f4db6cf79db635db722f61f92b3189b561a30b75fe257938c856","signature":"99663bfbfe54"},
  "family:mistral": {"turn":"0c1be727f206c849bd181e6064faa70eb9ad32185be3a90f71bab0c0c6bd2016","reaction":"f67e23ea98a683ee93524c264cd73dd385f845f92d7818f18f07aef99ef6c7dd","head":"9c94217f23d71b52ca54132e3bc102d557dcafca196f84d4a9f579b42bdad613","signature":"b6fd7ef65846"},
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
