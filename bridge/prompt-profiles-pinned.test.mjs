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
  "mistral": {"turn":"369365300879850ccc68b9cb331ddf30a1b6a9964b2a8f28664fb0d7637af0a6","reaction":"6cced07d136f3a69fe1d25f0598fd4343421fdc27bc601820fb0e29016aebf9b","head":"9c94217f23d71b52ca54132e3bc102d557dcafca196f84d4a9f579b42bdad613","signature":"b6fd7ef65846"},
  "local-lite": {"turn":"4885acc2723224d4e4234111cbd00bbaa07e1e370fc39d1b6442c2f202d91282","reaction":"8a1eb78e8057ededf13255b9e5f6f7b0a68d0225af21c300cb0b6b1a7fa964f8","head":"59565b3d6364e85c56ccf78a80bce489e3fc77ca4d084bfe38b33d3daa4f0614","signature":"ea6db67d14b3"},
  "local-standard": {"turn":"c085119cf6848c9eeb40cb3b652230a1e6e482bc957a3053f6f4a7532f087cb1","reaction":"27bad0a8912b331f2ec72eba77194f156bccf0b34a576edd39fb346727b50cb0","head":"de8d1bb43da5275dded103f43ae7138a7739d7eddb8d992dfdd863aa0968105e","signature":"87b2f69950eb"},
  "mature-lite": {"turn":"42c9ddf6b8881987ebafde5d896ea5d364fe980bddaffdb5007e8dfafa038a8f","reaction":"27bad0a8912b331f2ec72eba77194f156bccf0b34a576edd39fb346727b50cb0","head":"de8d1bb43da5275dded103f43ae7138a7739d7eddb8d992dfdd863aa0968105e","mature":"54ca1288915fd1ee26f20293e8d7313c3b276ed02faa301195f6425bc09077ed","signature":"c23049cd7797"},
  "mature-standard": {"turn":"6cc07e6af94749aade835574142f2881e354296e9967fe205c5f8a0884d4240f","reaction":"88911665785c11714e02835dc07ef4050fc614b8d1778075813513007be9170e","head":"0659b1188e297aa74712cc210ca98a9b528ec63a3cef04316fc5aef45d643fe3","mature":"05a7639c4713666e8f3e6bae59820c3396135ab5f37a96fd1e9d93b916f2562d","signature":"8166bc5d2476"},
  "family:generic": {"turn":"fc9696ac6f1746bc8b0a70c58ecd48db9a0b914f18217a8baf66aec371c0264c","reaction":"3df94c6ab9c737e545bb9e312a3e2605631575389a9b99c31066918af0289cdb","head":"e280e404f9a7f4db6cf79db635db722f61f92b3189b561a30b75fe257938c856","signature":"99663bfbfe54"},
  "family:qwen": {"turn":"c085119cf6848c9eeb40cb3b652230a1e6e482bc957a3053f6f4a7532f087cb1","reaction":"27bad0a8912b331f2ec72eba77194f156bccf0b34a576edd39fb346727b50cb0","head":"de8d1bb43da5275dded103f43ae7138a7739d7eddb8d992dfdd863aa0968105e","signature":"87b2f69950eb"},
  "family:gemma": {"turn":"c085119cf6848c9eeb40cb3b652230a1e6e482bc957a3053f6f4a7532f087cb1","reaction":"27bad0a8912b331f2ec72eba77194f156bccf0b34a576edd39fb346727b50cb0","head":"de8d1bb43da5275dded103f43ae7138a7739d7eddb8d992dfdd863aa0968105e","signature":"87b2f69950eb"},
  "family:gemini": {"turn":"440800e2f6b53f657c7b35086654614790838a7d880ac93739c422f926224fd9","reaction":"7d18415b44517202ebac7ba943376bf7a606f8e1931c751860b9fdc66a981401","head":"0fefd796da2300e16155a8dd7535b8a2c07b8cd8e0d2c4cd70444b6106beb386","signature":"c535e46ec582"},
  "family:llama": {"turn":"fc9696ac6f1746bc8b0a70c58ecd48db9a0b914f18217a8baf66aec371c0264c","reaction":"3df94c6ab9c737e545bb9e312a3e2605631575389a9b99c31066918af0289cdb","head":"e280e404f9a7f4db6cf79db635db722f61f92b3189b561a30b75fe257938c856","signature":"99663bfbfe54"},
  "family:mistral": {"turn":"369365300879850ccc68b9cb331ddf30a1b6a9964b2a8f28664fb0d7637af0a6","reaction":"6cced07d136f3a69fe1d25f0598fd4343421fdc27bc601820fb0e29016aebf9b","head":"9c94217f23d71b52ca54132e3bc102d557dcafca196f84d4a9f579b42bdad613","signature":"b6fd7ef65846"},
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
