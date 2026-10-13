import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import fengari from 'fengari';

// F6 / F8 with an add-on speaker anchored to V's vehicle (docs/ADDON_API.md, "Talk and group conversation"): selectConversation
// from mod/init.lua, run with stubbed world pieces. The main mod knows no add-on by name; the vehicle flag comes from the API.
const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;
const init = readFileSync(new URL('../mod/init.lua', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const from = init.indexOf("-- A character in V's own car, or one of V's companions");
const to = init.indexOf('local function voiceTargetValid');
assert.ok(from > 0 && to > from, 'selectConversation not found');
const source = init.slice(from, to);

function run(code) {
  const state = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(state);
  const status = lauxlib.luaL_dostring(state, to_luastring(code));
  const error = status === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(state, -1));
  lua.lua_close(state);
  assert.equal(status, lua.LUA_OK, error);
}

const WORLD = `
  local function npc(id, key) return {GetEntityID = function() return {hash = id} end, key = key} end
  judy, walker, cab = npc('judy', 'judy-alvarez'), npc('walker', 'npc-male'), {}
  supportedProfiles = {['judy-alvarez'] = true, ['npc-male'] = true}
  disabled = {}
  aimedNpc, notices, seated, owned, vehicle = nil, {}, {}, {}, true
  function profileEnabled(_, key) return not disabled[key] end
  function profileIdentity(n) return n.key, n.key, 'male' end
  function targetAtCrosshair() if aimedNpc then return aimedNpc, nil, {} end return nil, 'Face a nearby character to talk.', {} end
  function logTalkTarget() end
  function log() end
  function currentDistrict() return nil end
  archetypes = {keys = {}}; characterCatalog = {}
  ui = {t = function(text) return text end, boundKey = function() return 'F6' end}
  convaiNotices = {send = function(_, id, text) notices[#notices + 1] = id end}
  companions = {
    conversationCandidates = function()
      local list = {}
      for _, n in ipairs(seated) do list[#list + 1] = {npc = n, entity = n.key, profileKey = n.key, name = n.key} end
      return list
    end,
    seatedCandidates = function() return seated end,
    owns = function(n) return owned[n] == true end,
  }
  groupChat = {choose = function(primary, candidates)
    local list = {primary}
    for _, c in ipairs(candidates) do if c.profileKey ~= primary.profileKey then list[#list + 1] = c end end
    return list
  end}
  convaiTalkTarget = nil
  local voice = {npc = cab, entity = '88ULL', name = 'Delamain', bodyType = '', profileKey = 'addon-cab-delamain', voiceOnly = true, distance = 0, vehicle = true}
  convaiAddons = {live = true, talkCandidates = function() return vehicle and {voice} or {} end}
  ${source}
`;

test('F6 in a cab: nothing aimed, or a passer-by in the cone, talks to the add-on voice', () => run(`${WORLD}
  local primary = selectConversation({}, false, 'cyberpunk_convai_text')
  assert(primary and primary.profileKey == 'addon-cab-delamain' and primary.voiceOnly)
  aimedNpc = walker -- an ambient pedestrian seen through the windscreen
  primary = selectConversation({}, false, 'cyberpunk_convai_text')
  assert(primary and primary.profileKey == 'addon-cab-delamain', 'a pedestrian outside does not take the key from the cab')
`));

test('F6 in a cab: a companion or passenger under the crosshair is the target as usual', () => run(`${WORLD}
  owned[judy] = true; aimedNpc = judy
  local primary = selectConversation({}, false, 'cyberpunk_convai_text')
  assert(primary and primary.profileKey == 'judy-alvarez' and primary.npc == judy)
  owned[judy] = nil; seated = {judy} -- a seated passenger that is not (or no longer) reported as owned
  primary = selectConversation({}, false, 'cyberpunk_convai_text')
  assert(primary and primary.profileKey == 'judy-alvarez')
`));

test('F6 outside a vehicle: ordinary behaviour, the pedestrian is still the target', () => run(`${WORLD}
  vehicle = false; aimedNpc = walker
  local primary = selectConversation({}, false, 'cyberpunk_convai_text')
  assert(primary and primary.profileKey == 'npc-male')
  aimedNpc = nil
  assert(selectConversation({}, false, 'cyberpunk_convai_text') == nil and notices[#notices] == 'talk-no-target')
`));

test('F8 in a cab: the add-on voice plus the companion, aimed at the companion or at nothing', () => run(`${WORLD}
  owned[judy] = true; seated = {judy}
  local primary, together = selectConversation({}, true, 'cyberpunk_convai_group')
  assert(primary and primary.profileKey == 'addon-cab-delamain' and together and #together == 2, 'nothing aimed')
  assert(together[2].profileKey == 'judy-alvarez')
  aimedNpc = judy
  primary, together = selectConversation({}, true, 'cyberpunk_convai_group')
  assert(primary and primary.profileKey == 'judy-alvarez' and together and #together == 2, 'aimed at the companion')
  local names = {}
  for _, person in ipairs(together) do names[person.profileKey] = true end
  assert(names['addon-cab-delamain'] and names['judy-alvarez'])
  aimedNpc = walker
  primary, together = selectConversation({}, true, 'cyberpunk_convai_group')
  assert(primary.profileKey == 'addon-cab-delamain' and #together == 2, 'a pedestrian does not lead the group')
`));

test('F8 in a cab with no companion: the usual two-character notice, nothing starts', () => run(`${WORLD}
  assert(selectConversation({}, true, 'cyberpunk_convai_group') == nil and notices[#notices] == 'group-needs-two')
`));

test('F7 in a cab on a computer that cannot recognise speech: typed messages only; a character under the crosshair keeps the voice key', () => run(`${WORLD}
  assert(selectConversation({}, false, 'cyberpunk_convai_voice') == nil and notices[#notices] == 'addon-notice')
  assert(selectConversation({}, false, 'cyberpunk_convai_voice', false) == nil and notices[#notices] == 'addon-notice')
  owned[judy] = true; aimedNpc = judy
  local primary = selectConversation({}, false, 'cyberpunk_convai_voice')
  assert(primary and primary.profileKey == 'judy-alvarez')
  -- Group voice: without recognition the add-on voice is left out of the round, as before.
  seated = {judy}
  assert(selectConversation({}, true, 'cyberpunk_convai_voice', false) == nil and notices[#notices] == 'group-needs-two',
    'the add-on voice is not part of the round, so one companion alone is not a group')
`));

test('F7 in a cab with speech recognition: the add-on voice takes the voice key like the typed key', () => run(`${WORLD}
  local primary = selectConversation({}, false, 'cyberpunk_convai_voice', true)
  assert(primary and primary.profileKey == 'addon-cab-delamain' and primary.voiceOnly)
  assert(#notices == 0, 'no typed-only notice')
  aimedNpc = walker -- a pedestrian through the windscreen does not take it
  primary = selectConversation({}, false, 'cyberpunk_convai_voice', true)
  assert(primary and primary.profileKey == 'addon-cab-delamain')
  owned[judy] = true; aimedNpc = judy -- a companion under the crosshair keeps the voice key
  primary = selectConversation({}, false, 'cyberpunk_convai_voice', true)
  assert(primary and primary.profileKey == 'judy-alvarez')
`));

test('F10 in a cab with speech recognition: the add-on voice joins the companions in a voice round', () => run(`${WORLD}
  owned[judy] = true; seated = {judy}
  local primary, together = selectConversation({}, true, 'cyberpunk_convai_voice', true)
  assert(primary and primary.profileKey == 'addon-cab-delamain' and together and #together == 2, 'nothing aimed: the add-on voice leads')
  assert(together[1].voiceOnly and together[2].profileKey == 'judy-alvarez')
  aimedNpc = judy
  primary, together = selectConversation({}, true, 'cyberpunk_convai_voice', true)
  assert(primary.profileKey == 'judy-alvarez' and together and #together == 2, 'aimed at the companion: she leads, the voice joins')
  local names = {}
  for _, person in ipairs(together) do names[person.profileKey] = true end
  assert(names['addon-cab-delamain'] and names['judy-alvarez'])
  -- Without a companion the usual two-character notice.
  seated = {}; owned[judy] = nil; aimedNpc = nil
  assert(selectConversation({}, true, 'cyberpunk_convai_voice', true) == nil and notices[#notices] == 'group-needs-two')
`));

test('the voice keys without any add-on behave exactly as before, whatever the recognition flag says', () => run(`${WORLD}
  convaiAddons = nil
  aimedNpc = walker
  for _, hears in ipairs({false, true}) do
    local primary = selectConversation({}, false, 'cyberpunk_convai_voice', hears)
    assert(primary and primary.profileKey == 'npc-male' and not primary.voiceOnly)
  end
  aimedNpc = nil; notices = {}
  assert(selectConversation({}, false, 'cyberpunk_convai_voice', true) == nil and notices[#notices] == 'talk-no-target')
  convaiAddons = {live = false, talkCandidates = function() error('never asked while no add-on is live') end}
  aimedNpc = walker
  assert(selectConversation({}, false, 'cyberpunk_convai_voice', true).profileKey == 'npc-male')
`));

test('the add-on voice reaches the microphone only through generic seams: recognition asked on the key press, blocks added at begin and finish', () => {
  const toggle = init.slice(init.indexOf('local function toggleVoice'), init.indexOf('local function sendRequest'));
  assert.match(toggle, /local addonHears = convaiAddons ~= nil and convaiAddons\.live == true and manager\.speechRecognitionReady\(\) or false/);
  assert.match(toggle, /selectConversation\(player, groupMode, 'cyberpunk_convai_voice', addonHears\)/);
  assert.match(init, /microphone\.decorate = function\(context\)\n    if context\.voiceOnly and not context\.holocall and convaiAddons and convaiAddons\.live then convaiAddons\.decorate\(context\) end/);
  const microphone = readFileSync(new URL('../mod/microphone.lua', import.meta.url), 'utf8');
  assert.equal(microphone.match(/pcall\(M\.decorate, context\)/g).length, 2, 'begin and finish');
  const update = init.slice(init.indexOf("registerForEvent('onUpdate'"), init.indexOf("registerForEvent('onShutdown'"));
  assert.doesNotMatch(update, /speechRecognitionReady/, 'nothing per frame');
  assert.doesNotMatch(init + microphone, /delamain|skippy/i, 'the main mod names no add-on');
});

test('the vehicle flag comes from the API, and the key press is the only place it is resolved', () => {
  const addons = readFileSync(new URL('../mod/addons.lua', import.meta.url), 'utf8');
  assert.match(addons, /vehicle = speaker\.anchor == 'vehicle' or nil/);
  assert.doesNotMatch(source, /delamain|taxi/i, 'the main mod names no add-on');
  const update = init.slice(init.indexOf("registerForEvent('onUpdate'"), init.indexOf("registerForEvent('onShutdown'"));
  assert.doesNotMatch(update, /companionOrPassenger/);
});
