import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {BUILT_IN_IDS, FAMILY_IDS, defaultProfile, customProfileId, profileSignature, BASE_PROFILE} from './prompt-profiles.mjs';
import {buildMessages, systemHead, LIMITS} from './mistral-prompt.mjs';
import {buildPrompt, HISTORY, MEMORY, REMEMBERED, USER_LINES} from '../scripts/judy-prompt-fixture.mjs';

// Pins the prompt every shipped profile builds, byte for byte (the cache prefix of a profile must not move without someone meaning it): Judy's fixture turn, a reaction, and for the Mature
// profiles the turn with the Mature layer on. A change to a profile's wording, order, labels or sampling changes its hash here; re-take the hash on purpose (PRINT_PINS=1 node --test
// bridge/prompt-profiles-pinned.test.mjs prints them) and say why in the commit. The first group is the base prompt every text provider had before profiles, pinned in prompt-pinned.test.mjs too.
// Re-taken on 2026-10-31 (fix/talk-repetition-gear): the copy of the right-now sentence before V's words adds "Never announce that you are here or beside V, or that V is here." (a partner said "I'm still here, standing right beside you" to someone next to her).
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
  "mistral": {"turn":"0a7c4bd8eebf98af58d2ebf82f8ec745b95d50b5201f73eca7d69c8d9152c1e1","reaction":"f67e23ea98a683ee93524c264cd73dd385f845f92d7818f18f07aef99ef6c7dd","head":"9c94217f23d71b52ca54132e3bc102d557dcafca196f84d4a9f579b42bdad613","signature":"b6fd7ef65846"},
  "local-lite": {"turn":"1fbd861afa83444d9dd92641470ff80f55edefadd8306b80a2995983d049a131","reaction":"2921db211e462d9c5ee029a7711aa4ac132ab69f78e312e54ad5b09ce4229735","head":"59565b3d6364e85c56ccf78a80bce489e3fc77ca4d084bfe38b33d3daa4f0614","signature":"ea6db67d14b3"},
  "local-standard": {"turn":"99420e5c42de806f2fcb674c101b9a5174eb007900d2dad71e37f602e0522215","reaction":"f427d868f54136c9c067364627e2e26cc80c99e2a1b1fb35c3eee971bd24795a","head":"de8d1bb43da5275dded103f43ae7138a7739d7eddb8d992dfdd863aa0968105e","signature":"87b2f69950eb"},
  "mature-lite": {"turn":"45c2e0b4ef89601a04837e719fd48f093786e51f0034edee2ad026249d1250fa","reaction":"f427d868f54136c9c067364627e2e26cc80c99e2a1b1fb35c3eee971bd24795a","head":"de8d1bb43da5275dded103f43ae7138a7739d7eddb8d992dfdd863aa0968105e","mature":"61379bc7ab03cba8051f9e634763df493b2d2c74f662980455082ff251bc8ec4","signature":"c23049cd7797"},
  "mature-standard": {"turn":"c159f3a627087e62b885a22471dab8312429ee53115388645d16e55a915ad262","reaction":"10a315b20d72fe7909974792cf12c254bbe4befb9db3260db1d11d2c5db58c9a","head":"0659b1188e297aa74712cc210ca98a9b528ec63a3cef04316fc5aef45d643fe3","mature":"a33f3f82be19c11a8b5a843834237eb6418c2193e537d2bf995ee2964b6b7004","signature":"8166bc5d2476"},
  "family:generic": {"turn":"ecdd7b1aa0d971a673e8355fb5716a6345266936a1bc0d7e1bd24d5cc4323337","reaction":"da97a53ed834c7460ce047ccd35b20deff739664192e7a6d7c37030cbbfe8360","head":"e280e404f9a7f4db6cf79db635db722f61f92b3189b561a30b75fe257938c856","signature":"99663bfbfe54"},
  "family:qwen": {"turn":"99420e5c42de806f2fcb674c101b9a5174eb007900d2dad71e37f602e0522215","reaction":"f427d868f54136c9c067364627e2e26cc80c99e2a1b1fb35c3eee971bd24795a","head":"de8d1bb43da5275dded103f43ae7138a7739d7eddb8d992dfdd863aa0968105e","signature":"87b2f69950eb"},
  "family:gemma": {"turn":"99420e5c42de806f2fcb674c101b9a5174eb007900d2dad71e37f602e0522215","reaction":"f427d868f54136c9c067364627e2e26cc80c99e2a1b1fb35c3eee971bd24795a","head":"de8d1bb43da5275dded103f43ae7138a7739d7eddb8d992dfdd863aa0968105e","signature":"87b2f69950eb"},
  "family:gemini": {"turn":"960ee9892a2b4ee0103039d37a87195a231d71a3846ffe274f0d14c99e930914","reaction":"1f985012d1823181df323740b87d7f192a7f1ab53edc3a61ea2a208b96689d25","head":"0fefd796da2300e16155a8dd7535b8a2c07b8cd8e0d2c4cd70444b6106beb386","signature":"c535e46ec582"},
  "family:llama": {"turn":"ecdd7b1aa0d971a673e8355fb5716a6345266936a1bc0d7e1bd24d5cc4323337","reaction":"da97a53ed834c7460ce047ccd35b20deff739664192e7a6d7c37030cbbfe8360","head":"e280e404f9a7f4db6cf79db635db722f61f92b3189b561a30b75fe257938c856","signature":"99663bfbfe54"},
  "family:mistral": {"turn":"0a7c4bd8eebf98af58d2ebf82f8ec745b95d50b5201f73eca7d69c8d9152c1e1","reaction":"f67e23ea98a683ee93524c264cd73dd385f845f92d7818f18f07aef99ef6c7dd","head":"9c94217f23d71b52ca54132e3bc102d557dcafca196f84d4a9f579b42bdad613","signature":"b6fd7ef65846"},
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
