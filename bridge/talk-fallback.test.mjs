import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import fengari from 'fengari';
import {companionEngine} from './companion-fixture.mjs';
import {uiLocaleBootstrap} from './ui-locale-fixture.mjs';

// Talking with nobody in view goes to the party, and Johnny has his own keys (docs/TALK_FALLBACK.md): selectConversation from mod/init.lua
// over stand-ins for the world, the real group-chat.lua, and the real companions.lua for the party order.
const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;
const read = name => readFileSync(new URL(name, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const init = read('../mod/init.lua');
const groupSource = read('../mod/group-chat.lua');
const from = init.indexOf("-- Talking with nobody in view goes to the party");
const to = init.indexOf('local function voiceTargetValid');
assert.ok(from > 0 && to > from, 'selectConversation not found');
const source = init.slice(from, to);

function run(code, prelude = '') {
  const state = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(state);
  const program = prelude + code;
  const status = lauxlib.luaL_dostring(state, to_luastring(program));
  const error = status === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(state, -1));
  const line = Number(/\]:(\d+):/.exec(error)?.[1]);
  lua.lua_close(state);
  assert.equal(status, lua.LUA_OK, error + (line ? '\n' + program.split('\n')[line - 1] : ''));
}

// A party of `n` ready members (profiles p1..pn, entities e1..en) listed in the Companion Manager's order but nearest-last, so the
// distance order and the party order differ.
const WORLD = `
  local function npc(id, key) return {GetEntityID = function() return {hash = id} end, key = key} end
  supportedProfiles, disabled, notices, lines = {}, {}, {}, {}
  party, spawnedRows, aimedNpc, head = {}, {}, nil, nil
  function setParty(n)
    party = {}
    for i = 1, n do
      local key = 'p' .. i
      supportedProfiles[key] = true
      party[i] = {npc = npc('e' .. i, key), entity = 'e' .. i, profileKey = key, name = 'P' .. i, bodyType = 'Female',
        distance = 10 - i, party = true, order = i}
    end
  end
  function profileEnabled(_, key) return not disabled[key] end
  function profileIdentity(n) return n.key, n.key, 'Female' end
  function targetAtCrosshair()
    if aimedNpc then return aimedNpc, nil, {} end
    return nil, 'Face a nearby character to talk.', {}
  end
  function logTalkTarget() end
  function log(line) lines[#lines + 1] = line end
  function currentDistrict() return nil end
  archetypes = {keys = {}}; characterCatalog = {}
  ui = {t = function(text, args) return (text:gsub('{(%w+)}', function(k) return args and args[k] or '' end)) end, boundKey = function() return 'F6' end}
  convaiNotices = {send = function(_, id, text) notices[#notices + 1] = id; notices.last = text end}
  local function byDistance()
    local list = {}
    for _, row in ipairs(party) do list[#list + 1] = row end
    for _, row in ipairs(spawnedRows) do list[#list + 1] = row end
    table.sort(list, function(a, b) return a.distance < b.distance end)
    return list
  end
  companions = {
    conversationCandidates = byDistance,
    partyInOrder = function()
      local list = {}
      for _, row in ipairs(party) do list[#list + 1] = row end
      return list
    end,
    seatedCandidates = function() return {} end,
    owns = function() return true end,
  }
  groupChat = (function() ${groupSource} end)()
  convaiTalkTarget = {remember = function() end}
  convaiAddons = nil
  convaiHolocall = nil
  -- Johnny as the head service gives him: refusal() is nil while he can talk.
  function convaiJohnnyHeadService() return head end
  convaiHeadTalk = nil
  ${source}
  local function keys(list)
    local out = {}
    for _, person in ipairs(list or {}) do out[#out + 1] = person.profileKey end
    return table.concat(out, ',')
  end
`;

test('private talk: someone faced is the target exactly as before, the party does not take the key', () => run(`${WORLD}
  setParty(3)
  local faced = npc('walker', 'p3')
  aimedNpc = faced
  local primary = selectConversation({}, false, 'cyberpunk_convai_text')
  assert(primary and primary.npc == faced and primary.entity == 'walker', 'the faced character leads')
  for _, line in ipairs(lines) do assert(not line:find('Talk fallback', 1, true), 'no fallback was used') end
`));

test('private talk, nobody faced: the first party member in the Companion Manager order, not the nearest', () => run(`${WORLD}
  setParty(3)
  local primary, together = selectConversation({}, false, 'cyberpunk_convai_voice')
  assert(primary and primary.profileKey == 'p1' and primary.entity == 'e1' and together == nil, 'the first member, though p3 is nearest')
  assert(notices.last == nil)
  local logged = false
  for _, line in ipairs(lines) do if line:find('Talk fallback: first party member p1', 1, true) then logged = true end end
  assert(logged, 'the decision is in the probe log')
  setParty(1)
  primary = selectConversation({}, false, 'cyberpunk_convai_text')
  assert(primary and primary.profileKey == 'p1', 'a party of one')
`));

test('private talk, nobody faced: a first member who is disabled or cannot answer is skipped, the next in order answers', () => run(`${WORLD}
  setParty(3)
  disabled.p1 = true
  assert(selectConversation({}, false, 'cyberpunk_convai_text').profileKey == 'p2')
  disabled.p1 = nil; supportedProfiles.p1 = nil
  assert(selectConversation({}, false, 'cyberpunk_convai_text').profileKey == 'p2')
  disabled.p2 = true; disabled.p3 = true
  assert(selectConversation({}, false, 'cyberpunk_convai_text') == nil and notices[#notices] == 'talk-no-target')
`));

test('private talk, nobody faced and no party: the nobody-to-talk-to notice, and Johnny is not reached even while he is in the head', () => run(`${WORLD}
  setParty(0)
  head = {key = 'johnny-silverhand', name = 'Johnny Silverhand', refusal = function() return nil end,
    detail = function() return '' end, partner = function() error('Johnny was asked for') end}
  supportedProfiles['johnny-silverhand'] = true
  assert(selectConversation({}, false, 'cyberpunk_convai_text') == nil)
  assert(notices[#notices] == 'talk-no-target' and notices.last == 'Face a nearby character to talk.', tostring(notices.last))
  assert(convaiHeadTalk == nil)
  assert(selectConversation({}, false, 'cyberpunk_convai_voice') == nil and notices[#notices] == 'talk-no-target')
`));

test('private talk: the party is asked for within the talk range of eight metres, and the first in range answers', () => run(`${WORLD}
  setParty(2)
  local asked
  companions.partyInOrder = function(_, radius) asked = radius; return {party[2]} end
  local primary = selectConversation({}, false, 'cyberpunk_convai_text')
  assert(asked == 8 and primary.profileKey == 'p2')
`));

test('group chat, nobody faced, party of one: no group, the usual notice', () => run(`${WORLD}
  setParty(1)
  assert(selectConversation({}, true, 'cyberpunk_convai_text') == nil and notices[#notices] == 'group-needs-two')
`));

test('group chat, nobody faced, party of two: both, the first member leading', () => run(`${WORLD}
  setParty(2)
  local primary, together = selectConversation({}, true, 'cyberpunk_convai_text')
  assert(primary.profileKey == 'p1' and keys(together) == 'p1,p2', keys(together))
`));

test('group chat, nobody faced, party of five: the first member and two others picked at random from the other four', () => run(`${WORLD}
  setParty(5)
  local seen = {}
  -- Every pair the random draw can make: random(4) then random(3) over the four others.
  for a = 1, 4 do
    for b = 1, 3 do
      local calls = {a, b}
      local n = 0
      math.random = function(m) n = n + 1; assert(calls[n] <= m, 'the draw is within the pool'); return calls[n] end
      local primary, together = selectConversation({}, true, 'cyberpunk_convai_voice')
      assert(primary.profileKey == 'p1' and #together == 3 and together[1].profileKey == 'p1', keys(together))
      assert(together[2].profileKey ~= together[3].profileKey and together[2].profileKey ~= 'p1' and together[3].profileKey ~= 'p1')
      seen[keys(together)] = true
    end
  end
  local count = 0 for _ in pairs(seen) do count = count + 1 end
  assert(count == 12, 'ordered pairs of the four others: ' .. count)
`));

test('group chat, nobody faced, party of five: with the real random generator it is always the first member and three people', () => run(`${WORLD}
  setParty(5)
  math.randomseed(7)
  local others = {}
  for _ = 1, 60 do
    local primary, together = selectConversation({}, true, 'cyberpunk_convai_text')
    assert(primary.profileKey == 'p1' and #together == 3 and together[1].profileKey == 'p1')
    others[together[2].profileKey] = true; others[together[3].profileKey] = true
  end
  assert(others.p2 and others.p3 and others.p4 and others.p5, 'every other member is picked sometimes')
`));

test('group chat, nobody faced: housemates and spawned characters fill the round only when the party cannot', () => run(`${WORLD}
  setParty(2)
  spawnedRows = {{npc = npc('h1', 'house'), entity = 'h1', profileKey = 'house', name = 'House', bodyType = 'Female', distance = 1, party = false, order = 9}}
  supportedProfiles.house = true
  local primary, together = selectConversation({}, true, 'cyberpunk_convai_text')
  assert(keys(together) == 'p1,p2,house', 'nearest is the housemate, but the party leads: ' .. keys(together))
  setParty(5)
  primary, together = selectConversation({}, true, 'cyberpunk_convai_text')
  assert(#together == 3 and not keys(together):find('house', 1, true), keys(together))
  -- No party member at all: the old rule, the nearest candidate leads.
  setParty(0)
  spawnedRows[2] = {npc = npc('h2', 'house2'), entity = 'h2', profileKey = 'house2', name = 'House2', bodyType = 'Female', distance = 3, party = false}
  supportedProfiles.house2 = true
  primary, together = selectConversation({}, true, 'cyberpunk_convai_text')
  assert(primary.profileKey == 'house' and keys(together) == 'house,house2', keys(together))
`));

test('group chat: someone faced leads and the rest follow as before (nearest first), no random draw', () => run(`${WORLD}
  setParty(5)
  aimedNpc = party[4].npc
  math.random = function() error('no random draw when someone is faced') end
  local primary, together = selectConversation({}, true, 'cyberpunk_convai_text')
  assert(primary.profileKey == 'p4' and keys(together) == 'p4,p5,p3', keys(together))
`));

test('Talk to Johnny: wherever V faces, Johnny answers while he is in the head', () => run(`${WORLD}
  setParty(3)
  local partner = {npc = {}, entity = '77ULL', name = 'Johnny Silverhand', profileKey = 'johnny-silverhand', voiceOnly = true, head = {stage = 'friends'}}
  head = {key = 'johnny-silverhand', name = 'Johnny Silverhand', refusal = function() return nil end, detail = function() return '' end,
    partner = function() return partner end}
  supportedProfiles['johnny-silverhand'] = true
  assert(selectConversation({}, false, 'cyberpunk_convai_voice', false, true) == partner)
  assert(convaiHeadTalk and convaiHeadTalk.entity == '77ULL')
  aimedNpc = party[2].npc -- facing a companion does not change it
  assert(selectConversation({}, false, 'cyberpunk_convai_text', nil, true) == partner)
  -- Not through the plain keys: facing someone is that someone, facing nobody is the party.
  assert(selectConversation({}, false, 'cyberpunk_convai_text').profileKey == 'p2')
  aimedNpc = nil
  assert(selectConversation({}, false, 'cyberpunk_convai_text').profileKey == 'p1')
`));

test('Talk to Johnny: the notices when he cannot answer (setting off, not in the head yet, busy, switched off in the manager)', () => run(`${WORLD}
  setParty(2)
  head = nil
  assert(selectConversation({}, false, 'cyberpunk_convai_text', nil, true) == nil)
  assert(notices[#notices] == 'talk-johnny-off' and notices.last == 'Johnny in your head is off. Turn it on in Settings > Conversations.', notices.last)
  head = {key = 'johnny-silverhand', name = 'Johnny Silverhand', detail = function() return 'facts' end, partner = function() error('not asked') end}
  supportedProfiles['johnny-silverhand'] = true
  for _, why in ipairs({'before', 'after', 'unreadable'}) do
    head.refusal = function() return why end
    assert(selectConversation({}, false, 'cyberpunk_convai_voice', false, true) == nil)
    assert(notices[#notices] == 'talk-johnny-away' and notices.last == 'Johnny Silverhand is not in your head right now.', why)
  end
  head.refusal = function() return 'scene' end
  assert(selectConversation({}, false, 'cyberpunk_convai_voice', false, true) == nil)
  assert(notices[#notices] == 'talk-busy' and notices.last == 'Johnny Silverhand is busy right now.', notices.last)
  head.refusal = function() return nil end
  disabled['johnny-silverhand'] = true
  assert(selectConversation({}, false, 'cyberpunk_convai_voice', false, true) == nil and notices[#notices] == 'talk-johnny-away')
  assert(convaiHeadTalk == nil)
`));

test('the party order is the Companion Manager list order: only ready copies within range, with the party flag on every candidate row', () => run(`
  local judy1, panam, judy2 = spawn('judy-alvarez'), spawn('panam-palmer'), spawn('judy-alvarez')
  for _, npc in pairs(entities) do function npc:GetBodyType() return 'Female' end end
  -- The distance order is the reverse of the join order.
  judy1.pos = {x = 6, y = 0, z = 0}; panam.pos = {x = 4, y = 0, z = 0}; judy2.pos = {x = 2, y = 0, z = 0}
  local nearest = companions.conversationCandidates(player, 8)
  assert(#nearest == 3 and nearest[1].npc == judy2 and nearest[1].party == true and nearest[1].order == 3, 'nearest first, with its place in the list')
  local ordered = companions.partyInOrder(player, 8)
  assert(#ordered == 3 and ordered[1].npc == judy1 and ordered[2].npc == panam and ordered[3].npc == judy2, 'the list order')
  assert(ordered[1].order == 1 and ordered[3].order == 3 and ordered[1].profileKey == 'judy-alvarez')
  judy1.pos = {x = 20, y = 0, z = 0}
  ordered = companions.partyInOrder(player, 8)
  assert(#ordered == 2 and ordered[1].npc == panam, 'out of range is left out, the next in order is first')
  assert(#companions.partyInOrder(nil, 8) == 0)
`, uiLocaleBootstrap + 'convaiUiLocale=uiLocaleFixture\n' + companionEngine));

test('init.lua: the fallback is decided on the key press (no tick, no update), and the Johnny keys reach selectConversation as its fifth argument', () => {
  const update = init.slice(init.indexOf("registerForEvent('onUpdate'"), init.indexOf("registerForEvent('onShutdown'"));
  assert.doesNotMatch(update, /convaiTalkFirstParty|convaiTalkGroupFromParty|convaiTalkJohnny|partyInOrder/, 'nothing per frame');
  assert.match(init, /selectConversation\(player, groupMode, 'cyberpunk_convai_text', nil, talkJohnny\)/);
  assert.match(init, /selectConversation\(player, groupMode, 'cyberpunk_convai_voice', addonHears, talkJohnny\)/);
  assert.match(init, /toggleVoice\(groupMode, 'press', key\.holdId, nil, talkJohnny\)/);
  assert.match(init, /beginTextNow\(waiting\.group, waiting\.waited, waiting\.johnny\)/);
  // Nobody faced no longer reaches Johnny: the head service is asked only from the Johnny function and the voice/remark paths.
  const select = init.slice(init.indexOf('local function selectConversation('), init.indexOf('local function voiceTargetValid'));
  assert.doesNotMatch(select, /convaiJohnnyHeadService/, 'selectConversation itself no longer asks for Johnny');
  assert.match(select, /if talkJohnny then return convaiTalkJohnny\(player\) end/);
});
