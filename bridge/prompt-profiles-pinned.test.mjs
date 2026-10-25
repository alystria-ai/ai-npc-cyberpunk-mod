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
  "mistral": {"turn":"59173455470f2779c3095f6c5119730f65054fdc9eec904ed43a427addfc525b","reaction":"c116e659e81550ffc074dd7703e8179420c09d322c9cd16c084c902b7d18a960","head":"9c94217f23d71b52ca54132e3bc102d557dcafca196f84d4a9f579b42bdad613","signature":"1230538e5624"},
  "local-lite": {"turn":"5b6fbf5b44afedc99dc0090a7362e1829dcfbce1977efad3e7d4fbbd173fb9db","reaction":"9588be290876a85bccd5ada081f465d3ed0c802dcb0ff4089395f68a02dcde39","head":"59565b3d6364e85c56ccf78a80bce489e3fc77ca4d084bfe38b33d3daa4f0614","signature":"6b31d93812c6"},
  "local-standard": {"turn":"8326ed909e9de59a65250cbef08b3523e653882353a2372908aa2190a5bc74e6","reaction":"1580f05fcbf33d9c1ec9c708afc17fa3a6f738546ca54aa4cfb32edb4f6d9ac3","head":"de8d1bb43da5275dded103f43ae7138a7739d7eddb8d992dfdd863aa0968105e","signature":"ca8d2fe40cee"},
  "mature-lite": {"turn":"581548016b3d3cad026f679848e02944ea60d5e7a5b568affd823cbdf35488f8","reaction":"1580f05fcbf33d9c1ec9c708afc17fa3a6f738546ca54aa4cfb32edb4f6d9ac3","head":"de8d1bb43da5275dded103f43ae7138a7739d7eddb8d992dfdd863aa0968105e","mature":"efa70c3b8d19f096368c5c6812d3b31cc205139432390f9298870a4e343f93d3","signature":"63f7ffc65544"},
  "mature-standard": {"turn":"c24a89b634cab2a510656554f4f339645ee8458fc982b02115acbc5941a2b338","reaction":"a8cc77348492c93efb922a50a21b198cc22816752a998f6b6b48248858c7fae5","head":"0659b1188e297aa74712cc210ca98a9b528ec63a3cef04316fc5aef45d643fe3","mature":"b6cdd8b6ea29ba4882213f00ebd17eeee7f67404116da9d1445086f1f357f073","signature":"3fbdc34cb351"},
  "family:generic": {"turn":"d4da002df4a1027e7536ed9d4434ede436d3420ef531f88bace8cedcb742b23d","reaction":"c0f452e89a4725d5220b665eaae39aa991c67f83098e7403b69733191c2f8af8","head":"e280e404f9a7f4db6cf79db635db722f61f92b3189b561a30b75fe257938c856","signature":"b52345098f15"},
  "family:qwen": {"turn":"8326ed909e9de59a65250cbef08b3523e653882353a2372908aa2190a5bc74e6","reaction":"1580f05fcbf33d9c1ec9c708afc17fa3a6f738546ca54aa4cfb32edb4f6d9ac3","head":"de8d1bb43da5275dded103f43ae7138a7739d7eddb8d992dfdd863aa0968105e","signature":"ca8d2fe40cee"},
  "family:gemma": {"turn":"8326ed909e9de59a65250cbef08b3523e653882353a2372908aa2190a5bc74e6","reaction":"1580f05fcbf33d9c1ec9c708afc17fa3a6f738546ca54aa4cfb32edb4f6d9ac3","head":"de8d1bb43da5275dded103f43ae7138a7739d7eddb8d992dfdd863aa0968105e","signature":"ca8d2fe40cee"},
  "family:llama": {"turn":"d4da002df4a1027e7536ed9d4434ede436d3420ef531f88bace8cedcb742b23d","reaction":"c0f452e89a4725d5220b665eaae39aa991c67f83098e7403b69733191c2f8af8","head":"e280e404f9a7f4db6cf79db635db722f61f92b3189b561a30b75fe257938c856","signature":"b52345098f15"},
  "family:mistral": {"turn":"59173455470f2779c3095f6c5119730f65054fdc9eec904ed43a427addfc525b","reaction":"c116e659e81550ffc074dd7703e8179420c09d322c9cd16c084c902b7d18a960","head":"9c94217f23d71b52ca54132e3bc102d557dcafca196f84d4a9f579b42bdad613","signature":"1230538e5624"},
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
