import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {BUILT_IN_IDS, FAMILY_IDS, defaultProfile, customProfileId, profileSignature, BASE_PROFILE} from './prompt-profiles.mjs';
import {buildMessages, systemHead, LIMITS} from './mistral-prompt.mjs';
import {buildPrompt, HISTORY, MEMORY, REMEMBERED, USER_LINES} from '../scripts/judy-prompt-fixture.mjs';

// Pins the prompt every shipped profile builds, byte for byte (the cache prefix of a profile must not move without someone meaning it): Judy's fixture turn, a reaction, and for the Mature
// profiles the turn with the Mature layer on. A change to a profile's wording, order, labels or sampling changes its hash here; re-take the hash on purpose (PRINT_PINS=1 node --test
// bridge/prompt-profiles-pinned.test.mjs prints them) and say why in the commit. Re-taken on 2026-10-28 for the removed Natural speech block in the fixture's context: only `turn` and `reaction` moved, `head` (the cached prefix) and `signature` did not. The first group is the base prompt every text provider had before profiles, pinned in prompt-pinned.test.mjs too.
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
  "mistral": {"turn":"91189c9d72f2dfbe0923368c10465c4c309f3f5f0265754a937e69490e966da1","reaction":"0eb1183e8706bf59cdd187b88704f0ab2670a8ce4eae1b6957f0c8705771cbf0","head":"9c94217f23d71b52ca54132e3bc102d557dcafca196f84d4a9f579b42bdad613","signature":"1230538e5624"},
  "local-lite": {"turn":"9fb96d2a85bae27512f499cbc905e8e9ce728b2e0849d2b8078370a8af13fddd","reaction":"fcb0e13b5412e6666c5ad0117f006374117efa19b5917687fcf147d95987fec9","head":"59565b3d6364e85c56ccf78a80bce489e3fc77ca4d084bfe38b33d3daa4f0614","signature":"6b31d93812c6"},
  "local-standard": {"turn":"8e5784d7827968357b253c5f3fc10e018e82bc972539a4b5d8c4957ffa44de42","reaction":"c2bb4761f0d14f771e48655995a5cc09072beedea26ee7150496efcd83d0aed1","head":"de8d1bb43da5275dded103f43ae7138a7739d7eddb8d992dfdd863aa0968105e","signature":"ca8d2fe40cee"},
  "mature-lite": {"turn":"4c02d7c9533fc3e666b87522cf6943ce49f3cb6193cb4db6ea0fd49274e9c520","reaction":"c2bb4761f0d14f771e48655995a5cc09072beedea26ee7150496efcd83d0aed1","head":"de8d1bb43da5275dded103f43ae7138a7739d7eddb8d992dfdd863aa0968105e","mature":"68d0c0d4525622712e5f53eeeac3fda9cf083f44304aabeb2f988c7937276954","signature":"63f7ffc65544"},
  "mature-standard": {"turn":"8cd4e99b4f50fc76978e743aa1d5f8ddb9fcbacd64d6c299c4b12bf57cd2ad6c","reaction":"c0453f4c733ad5f0edad85a68885441f8ede1bf0d81cf08fcf8bca23e73e521b","head":"0659b1188e297aa74712cc210ca98a9b528ec63a3cef04316fc5aef45d643fe3","mature":"1ebac15618caab3446f050436d1dc247d95b0f1a55d675a75780e703e63d5da3","signature":"3fbdc34cb351"},
  "family:generic": {"turn":"fde9dc7ee6fc3343f725e2ec1e844e57726e6715c4f6e55f8629578338fc2a4d","reaction":"bce003068206e4ba207b8ba89b78d167813f28f80cbe56ee69d727fd55ba6b72","head":"e280e404f9a7f4db6cf79db635db722f61f92b3189b561a30b75fe257938c856","signature":"b52345098f15"},
  "family:qwen": {"turn":"8e5784d7827968357b253c5f3fc10e018e82bc972539a4b5d8c4957ffa44de42","reaction":"c2bb4761f0d14f771e48655995a5cc09072beedea26ee7150496efcd83d0aed1","head":"de8d1bb43da5275dded103f43ae7138a7739d7eddb8d992dfdd863aa0968105e","signature":"ca8d2fe40cee"},
  "family:gemma": {"turn":"8e5784d7827968357b253c5f3fc10e018e82bc972539a4b5d8c4957ffa44de42","reaction":"c2bb4761f0d14f771e48655995a5cc09072beedea26ee7150496efcd83d0aed1","head":"de8d1bb43da5275dded103f43ae7138a7739d7eddb8d992dfdd863aa0968105e","signature":"ca8d2fe40cee"},
  "family:llama": {"turn":"fde9dc7ee6fc3343f725e2ec1e844e57726e6715c4f6e55f8629578338fc2a4d","reaction":"bce003068206e4ba207b8ba89b78d167813f28f80cbe56ee69d727fd55ba6b72","head":"e280e404f9a7f4db6cf79db635db722f61f92b3189b561a30b75fe257938c856","signature":"b52345098f15"},
  "family:mistral": {"turn":"91189c9d72f2dfbe0923368c10465c4c309f3f5f0265754a937e69490e966da1","reaction":"0eb1183e8706bf59cdd187b88704f0ab2670a8ce4eae1b6957f0c8705771cbf0","head":"9c94217f23d71b52ca54132e3bc102d557dcafca196f84d4a9f579b42bdad613","signature":"1230538e5624"}
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
