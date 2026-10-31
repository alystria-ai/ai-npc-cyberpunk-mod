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
// Re-taken on 2026-10-31 (feat/natural-talk-retrieval): the world, the older-talk summary, the knowledge, the right-now block and the fresh facts moved from the system message to the start of
// the last message (after the history, so a changed world block no longer throws away the cached persona and history: a 30 turn Gemini run lost its cache on 12 turns of 30), and rule "now"
// says "the last message" instead of "the end of this message".
// Re-taken on 2026-10-30 (fix/natural-talk): the world heading of every profile, V's money band only when V talks money, and the new Gemini family.
// Re-taken on 2026-10-31 (merge of feat/natural-talk-retrieval and fix/narration-strip): the plain rule of every profile says not to narrate the voice, the tone, the face or who is speaking (the Gemini family says it as what to
// write, with no "never": "the words you say, and nothing that tells how they sound or who says them"). With those sentences taken out every hash is the one the retrieval branch pinned; the profile signatures follow the rule text.
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
  "mistral": {"turn":"1057ee2a76b8dec09d7f79c1c6561ad8539555e00798b640494f71401ac2788b","reaction":"1cbabbb92785fe1c65403a53bcd3c001c0ffec745cd79001ff62f3f6889c5836","head":"188f771ca8f7b554500480c4de404e5425a30ebac5e0bd093e469fcb7bff1ab7","signature":"5cfbee0ab7f6"},
  "local-lite": {"turn":"9718828654adcc34598d1b0e8cafb34ef66f3ce07a9073447b2ff7b72031f27d","reaction":"510214f547ff8af0950c3142d032ad82c7ee094eb4b9c00a2510bea7da50ca36","head":"4ed1f998133943c78b7abca6bbeffa86441d332f8c3940f29b9d80c643678965","signature":"6d4c8697623d"},
  "local-standard": {"turn":"3933f3a0cdb006a06640b67508c9fbf0300b6932d65d8de9e008823a46a4c290","reaction":"8cc5e2e32abda4cb25c1389e7c1125c31d8f81a022a414c629771944ea3ad4df","head":"c18d3347077fb712d846db1da0d9b489483004da5b6b59d6b00da90133902294","signature":"a2d99a66cb78"},
  "mature-lite": {"turn":"20267788a4f6eca87c6ed5fe332656050ab921455c1a6712b99a8a61382372e8","reaction":"8cc5e2e32abda4cb25c1389e7c1125c31d8f81a022a414c629771944ea3ad4df","head":"c18d3347077fb712d846db1da0d9b489483004da5b6b59d6b00da90133902294","mature":"f921b0dc135f6d33b6cdfe36f51ecadbc936c71ec141521a9c0f147fdc7d1fff","signature":"a5e236d0d5a1"},
  "mature-standard": {"turn":"7b21760748aa549d0fbf0dea7b1e554b3b7c45ee0a7fd349f8f63dee21814416","reaction":"8f0b13a20b4c2bb2bd9fb91dcd27d90b6ddecc2fd4140377cb43723cbcd97bf2","head":"94440dd5cc32d1a4e75932d3f5fbf1453cf357501295cad2f4835b7f7e0a8242","mature":"9367e6059702a1fdf59d94fa4f2d24e9e2e4b11fe3a62f94ac14091da389f2ed","signature":"4302d03172fe"},
  "family:generic": {"turn":"d4547dc1ddae17d1dd4bd07b0ccaa192fa37a9e3bc4d840b5c45796308b7e7de","reaction":"e140e34bf0ae3918e60191375b7ea7627a3fc22e5458125dbe266a05768f4068","head":"2330945d522a7c91c3b751e1215f3e0d830ffa588011a13945167c330d94efe4","signature":"e5ffeca5257b"},
  "family:qwen": {"turn":"3933f3a0cdb006a06640b67508c9fbf0300b6932d65d8de9e008823a46a4c290","reaction":"8cc5e2e32abda4cb25c1389e7c1125c31d8f81a022a414c629771944ea3ad4df","head":"c18d3347077fb712d846db1da0d9b489483004da5b6b59d6b00da90133902294","signature":"a2d99a66cb78"},
  "family:gemma": {"turn":"3933f3a0cdb006a06640b67508c9fbf0300b6932d65d8de9e008823a46a4c290","reaction":"8cc5e2e32abda4cb25c1389e7c1125c31d8f81a022a414c629771944ea3ad4df","head":"c18d3347077fb712d846db1da0d9b489483004da5b6b59d6b00da90133902294","signature":"a2d99a66cb78"},
  "family:gemini": {"turn":"0fa1ae14847ec02a91ce7b83ad52014b8fb3e559ec7886a549e83be1137a3968","reaction":"89c565ed9b1171b02be8031efbe34f958c5200e33caa20198425e5bb1fa61845","head":"e38d7261197e1aa46cab7f7be0b813b9eaf8f28f0cf836c920e769b68ef89689","signature":"8a416204b60d"},
  "family:llama": {"turn":"d4547dc1ddae17d1dd4bd07b0ccaa192fa37a9e3bc4d840b5c45796308b7e7de","reaction":"e140e34bf0ae3918e60191375b7ea7627a3fc22e5458125dbe266a05768f4068","head":"2330945d522a7c91c3b751e1215f3e0d830ffa588011a13945167c330d94efe4","signature":"e5ffeca5257b"},
  "family:mistral": {"turn":"1057ee2a76b8dec09d7f79c1c6561ad8539555e00798b640494f71401ac2788b","reaction":"1cbabbb92785fe1c65403a53bcd3c001c0ffec745cd79001ff62f3f6889c5836","head":"188f771ca8f7b554500480c4de404e5425a30ebac5e0bd093e469fcb7bff1ab7","signature":"5cfbee0ab7f6"}
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
