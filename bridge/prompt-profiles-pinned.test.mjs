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
  "mistral": {"turn":"c95ae97f848c663ddc759a4fcc13218b494a910e4c132164b7421b0cea1e0c1b","reaction":"ad06800f3184a37a0a827f95fa4ce462327c137b024a85d8fcf5e1050aa7c66b","head":"e9945973930be7950edb39e9f0ea7815c44800ddc897997bbcd82253a4074903","signature":"a891c484a323"},
  "local-lite": {"turn":"0cb1200ec3b2ffb68debdbc66eaa369aa6b4dd83ac184e5c052ae5644cd7f23d","reaction":"9afaa0d274e890b2d0e2ae063346f5263d9791dcd4423a9cde0f40b3c726de61","head":"59565b3d6364e85c56ccf78a80bce489e3fc77ca4d084bfe38b33d3daa4f0614","signature":"ea6db67d14b3"},
  "local-standard": {"turn":"b7fa1cd5445d970cd8f443df3e3ad415271fa4cbaf9b69a43e2c995b51291c98","reaction":"901a5318e34585a0dffc16e3e5f1a9867eb12616cdac5000c755ca9f73516b52","head":"de8d1bb43da5275dded103f43ae7138a7739d7eddb8d992dfdd863aa0968105e","signature":"87b2f69950eb"},
  "mature-lite": {"turn":"57f0b695584d337206fdb5e230c63dfa0f99b948476ace4a10691fee3456e411","reaction":"901a5318e34585a0dffc16e3e5f1a9867eb12616cdac5000c755ca9f73516b52","head":"de8d1bb43da5275dded103f43ae7138a7739d7eddb8d992dfdd863aa0968105e","mature":"650a8fafe293babf286f1faf14a602e73c147c0852e4088a62a0f98ab30a98c9","signature":"c23049cd7797"},
  "mature-standard": {"turn":"9a2fbf9f5d7b3297630c0ba77fbd26fabae12e10b53c4bd4dddb5de61d0c7f2f","reaction":"d36fbb2c001d8cc2e3ae9635b0895a8de7a0e41889fcd88027a4d69f0bf4f640","head":"0659b1188e297aa74712cc210ca98a9b528ec63a3cef04316fc5aef45d643fe3","mature":"f531120de4ff9045d425b3c44bd9ecf7d7c189f254b56758c400c00a74ab21c6","signature":"8166bc5d2476"},
  "family:generic": {"turn":"28a85694db5cd5595c0d3154da0b47735f5fb4ca92fe16ad92b9f2cf0d00caec","reaction":"ca92b18f2e8fc4ef39c8fbc7ea76f9e4c0c42d914c3f16457fa6aedecd55de20","head":"cdad28c1c440a30cbb71c97797a0736129c734f7d0d4b426f36f9e9690514888","signature":"fd5a442734bd"},
  "family:qwen": {"turn":"b7fa1cd5445d970cd8f443df3e3ad415271fa4cbaf9b69a43e2c995b51291c98","reaction":"901a5318e34585a0dffc16e3e5f1a9867eb12616cdac5000c755ca9f73516b52","head":"de8d1bb43da5275dded103f43ae7138a7739d7eddb8d992dfdd863aa0968105e","signature":"87b2f69950eb"},
  "family:gemma": {"turn":"b7fa1cd5445d970cd8f443df3e3ad415271fa4cbaf9b69a43e2c995b51291c98","reaction":"901a5318e34585a0dffc16e3e5f1a9867eb12616cdac5000c755ca9f73516b52","head":"de8d1bb43da5275dded103f43ae7138a7739d7eddb8d992dfdd863aa0968105e","signature":"87b2f69950eb"},
  "family:gemini": {"turn":"e713eb83cebcf37307cb389f6b634b7051d30f9b0666c52e06295bb702cf9de7","reaction":"adb43181f71272622c3857de431f56cf6c112a58ab7ef46a4d8b8a21d1e1ee6c","head":"0fefd796da2300e16155a8dd7535b8a2c07b8cd8e0d2c4cd70444b6106beb386","signature":"c535e46ec582"},
  "family:llama": {"turn":"28a85694db5cd5595c0d3154da0b47735f5fb4ca92fe16ad92b9f2cf0d00caec","reaction":"ca92b18f2e8fc4ef39c8fbc7ea76f9e4c0c42d914c3f16457fa6aedecd55de20","head":"cdad28c1c440a30cbb71c97797a0736129c734f7d0d4b426f36f9e9690514888","signature":"fd5a442734bd"},
  "family:mistral": {"turn":"c95ae97f848c663ddc759a4fcc13218b494a910e4c132164b7421b0cea1e0c1b","reaction":"ad06800f3184a37a0a827f95fa4ce462327c137b024a85d8fcf5e1050aa7c66b","head":"e9945973930be7950edb39e9f0ea7815c44800ddc897997bbcd82253a4074903","signature":"a891c484a323"}
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
