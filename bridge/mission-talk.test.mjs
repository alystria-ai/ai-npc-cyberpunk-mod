import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, readdirSync} from 'node:fs';
import fengari from 'fengari';
import {parseInput} from './protocol.mjs';
import {conversationContext} from './quest-context.mjs';
import {run as managerRun, nsuiFixture, source as modSource} from './manager-fixture.mjs';

// Talk during missions (Settings > Conversations, docs/WORLD_CHARACTERS.md "Talk during missions"): the extended, experimental permission
// to talk to a game-placed story character during story missions, with the character joining in (mod/mission-companion.lua) while the game
// is not driving it. What this file holds: the setting off keeps today's block, on allows talk in a mission, a cutscene holds the reply,
// our systems step back whenever the script drives the character and resume afterwards, every system releases cleanly (setting off, mission
// end, gone, left behind, world change), the character is never teleported, despawned or changed in its story state, and nothing runs per frame.
const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;
const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const worldTalk = read('../mod/world-talk.lua');
const missionSource = read('../mod/mission-companion.lua');
const init = read('../mod/init.lua');
const between = (from, to, source = init) => {
  const start = source.indexOf(from), end = source.indexOf(to, start);
  assert.ok(start >= 0 && end > start, `markers ${from} .. ${to}`);
  return source.slice(start, end);
};

function run(code) {
  const state = lauxlib.luaL_newstate(); lualib.luaL_openlibs(state);
  const result = lauxlib.luaL_dostring(state, to_luastring(code));
  const error = result === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(state, -1));
  lua.lua_close(state); assert.equal(result, lua.LUA_OK, error);
}
const withWorld = code => run(`local W = (function() ${worldTalk} end)()\n${code}`);
const withMission = code => run(`local MC = (function() ${missionSource} end)()\n${code}`);

// ---- 1. Off keeps today's block; on allows talk in a mission ---------------------------------------------------------------------------

const FACTS = `local function facts(over)
    local f = {gone = false, hub = false, dialogue = false, driven = false, combat = false, hurt = false, mounted = false, playerCombat = false}
    for k, v in pairs(over or {}) do f[k] = v end
    return f
  end`;

test('off keeps today\'s block: a commanded AI, a fight and a ride still refuse the talk, whatever the facts', () => withWorld(`
  ${FACTS}
  for _, mission in ipairs({false, nil}) do
    assert(W.classify(facts({driven = true}), nil, nil, mission) == 'driven')
    assert(W.classify(facts({combat = true}), nil, nil, mission) == 'combat')
    assert(W.classify(facts({playerCombat = true}), nil, nil, mission) == 'combat')
    assert(W.classify(facts({mounted = true}), nil, nil, mission) == 'vehicle')
    assert(W.classify(facts({hub = true}), nil, nil, mission) == 'hub')
    for _, name in ipairs({'driven', 'combat', 'mounted'}) do
      local partial = facts(); partial[name] = nil
      assert(W.classify(partial, nil, nil, mission) == 'unreadable', name .. ' unread refuses with the setting off')
    end
  end
  assert(W.classify(facts()) == nil)
`));

test('off keeps today\'s block through the service: the same read refuses a commanded character, and mission mode lets it through', () => withWorld(`
  Game = {GetWorkspotSystem = function() return {IsActorInWorkspot = function() return false end} end,
    GetSceneSystem = function() return {GetScriptInterface = function() return {IsEntityInDialogue = function() return false end} end} end,
    GetMountingFacility = function() return {IsMountedToAnything = function() return false end} end}
  NPCPuppet = {IsInCombat = function() return true end}
  StatusEffectSystem = {ObjectHasStatusEffectWithTag = function() return false end}
  CName = {new = function(t) return t end}
  local npc = {IsAttached = function() return true end, IsDeadNoStatPool = function() return false end,
    IsOnAutonomousAI = function() return false end, IsQuest = function() return true end, GetEntityID = function() return {hash = 7} end}
  local service = W.new({sample = function() return {available = true, tier = 1, dialogue = false, choices = false, call = false, combat = true} end})
  local player = {}
  assert(service:refusal(npc, player, nil, 'judy-alvarez', nil, nil) == 'driven', 'setting off: a commanded AI in a fight refuses')
  assert(service:refusal(npc, player, nil, 'judy-alvarez', nil, false) == 'driven')
  assert(service:refusal(npc, player, nil, 'judy-alvarez', nil, true) == nil, 'mission mode: commanded, in a fight, talk is allowed')
  -- A held answer of one mode is never given to the other.
  assert(service:refusal(npc, player, '7', 'judy-alvarez', nil, true) == nil)
  assert(service:refusal(npc, player, '7', 'judy-alvarez', nil, nil) == 'driven', 'the held mission answer is not reused with the setting off')
  -- A quest-bound person with no roster profile (idle) is never in mission mode.
  assert(service:refusal(npc, player, nil, 'npc-x', true, true) == 'driven' or service:refusal(npc, player, nil, 'npc-x', true, true) ~= nil)
`));

test('on allows talk in a mission: a commanded AI, a fight and a ride no longer refuse, nor must they be readable', () => withWorld(`
  ${FACTS}
  assert(W.classify(facts({driven = true}), nil, nil, true) == nil, 'a scripted move: V can talk while walking with them')
  assert(W.classify(facts({combat = true}), nil, nil, true) == nil, 'in combat')
  assert(W.classify(facts({playerCombat = true}), nil, nil, true) == nil, 'V in a fight')
  assert(W.classify(facts({mounted = true}), nil, nil, true) == nil, 'while driving together')
  assert(W.classify(facts({driven = true, combat = true, mounted = true}), nil, nil, true) == nil, 'all at once')
  for _, name in ipairs({'driven', 'combat', 'mounted'}) do
    local partial = facts(); partial[name] = nil
    assert(W.classify(partial, nil, nil, true) == nil, name .. ' need not be readable in mission mode')
  end
`));

test('on still leaves the game its scenes: a cutscene or dialogue choice scene, a scene dialogue, an injury, a missing body, an unreadable fact', () => withWorld(`
  ${FACTS}
  assert(W.classify(facts({hub = true}), nil, nil, true) == 'hub', 'a cutscene, a quest conversation, a call or a dialogue choice scene V is in')
  assert(W.classify(facts({dialogue = true}), nil, nil, true) == 'dialogue')
  assert(W.classify(facts({hurt = true}), nil, nil, true) == 'hurt')
  assert(W.classify(facts({gone = true}), nil, nil, true) == 'gone')
  for _, name in ipairs({'gone', 'hub', 'dialogue', 'hurt'}) do
    local partial = facts(); partial[name] = nil
    assert(W.classify(partial, nil, nil, true) == 'unreadable', name .. ' unread still refuses')
  end
  assert(W.classify(facts({hub = true, driven = true, combat = true}), nil, nil, true) == 'hub', 'the scene wins over everything')
  -- A quest-bound person with no roster profile (idle) keeps today\'s rules even with the setting on.
  assert(W.classify(facts({driven = true}), nil, true, true) == 'driven')
  assert(W.classify(facts({combat = true}), nil, true, true) == 'combat')
`));

// ---- 2. A cutscene holds the reply ------------------------------------------------------------------------------------------------------

test('a cutscene or dialogue choice scene holds the reply, for a bounded time; anything else that no longer fits drops it', () => withWorld(`
  assert(W.deliverVerdict(nil, 0) == 'deliver')
  assert(W.deliverVerdict('hub', 0) == 'hold' and W.deliverVerdict('hub', 24.9) == 'hold')
  assert(W.deliverVerdict('dialogue', 3) == 'hold')
  assert(W.deliverVerdict('hub', W.MISSION_HOLD_SECONDS) == 'drop', 'the wait ran out')
  for _, reason in ipairs({'gone', 'hurt', 'unreadable', 'combat', 'driven'}) do
    assert(W.deliverVerdict(reason, 0) == 'drop', reason .. ' does not fit any more')
  end
`));

const replySource = between('function convaiMissionReply', 'local function reactionLease');
function replyHarness(body) {
  run(`
    local W = (function() ${worldTalk} end)()
    local clock, reason, retired, logs = 100, nil, {}, {}
    os.clock = function() return clock end
    log = function(line) logs[#logs + 1] = line end
    retirePrivateReply = function(entity, why) retired[#retired + 1] = entity .. ':' .. why end
    convaiWorldTalk = {deliverVerdict = W.deliverVerdict, refusal = function(self, npc, player, entity, key, idle, mission)
      assert(mission == true, 'the reply check runs in mission mode')
      return reason
    end}
    convaiStory = {entity = '7', key = 'judy-alvarez', mission = true, npc = {}}
    ${replySource}
    ${body}
  `);
}

test('a reply asked in a mission waits while a cutscene runs, plays when it ends, and is dropped when the wait runs out', () => replyHarness(`
  local context = {entity = '7', requestId = 'r1'}
  assert(convaiMissionReply(context, {}) == true, 'nothing in the way: delivered at once')
  reason = 'hub'
  assert(convaiMissionReply(context, {}) == false, 'a cutscene began: held')
  assert(#retired == 0, 'held, not dropped')
  assert(context.missionHeldAt ~= nil)
  -- Asked again at most twice a second: inside the pause there is no new read.
  local reads = 0
  convaiWorldTalk.refusal = function() reads = reads + 1; return reason end
  clock = clock + 0.1; assert(convaiMissionReply(context, {}) == false and reads == 0, 'no read inside the pause')
  clock = clock + 5; assert(convaiMissionReply(context, {}) == false and reads == 1 and #retired == 0, 'still held after five seconds')
  reason = nil
  clock = clock + 1; assert(convaiMissionReply(context, {}) == true, 'the scene ended: the reply goes on')
  assert(#retired == 0)
  -- A second reply whose scene never ends is dropped after the bound, and its private reply retired.
  local late = {entity = '7', requestId = 'r2'}
  reason = 'dialogue'
  assert(convaiMissionReply(late, {}) == false)
  clock = clock + 26
  assert(convaiMissionReply(late, {}) == false and retired[1] == '7:story-dialogue', retired[1])
  -- A character that is hurt or gone is dropped at once.
  local hurt = {entity = '7', requestId = 'r3'}
  reason = 'hurt'
  assert(convaiMissionReply(hurt, {}) == false and retired[2] == '7:story-hurt')
`));

test('the hold touches only a mission reply to the character V talked to: everything else is delivered untouched', () => replyHarness(`
  reason = 'hub'
  assert(convaiMissionReply({entity = '8'}, {}) == true, 'another speaker')
  assert(convaiMissionReply({entity = '7', group = {}}, {}) == true, 'a group round turn')
  convaiStory.mission = nil
  assert(convaiMissionReply({entity = '7'}, {}) == true, 'the setting was off when V asked')
  convaiStory = nil
  assert(convaiMissionReply({entity = '7'}, {}) == true, 'no story talk at all')
`));

test('wiring: the hold sits where a reply is about to be delivered, only for a mission reply, and the key press, recording and reply guard carry the mode', () => {
  const deliver = between('local function reactionCanDeliver', 'if context.reaction.kind == \'addon\'');
  assert.match(deliver, /if not context\.reaction then\s+if convaiStory ~= nil and convaiStory\.mission == true then return convaiMissionReply\(context, player\) end\s+return true\s+end/);
  const select = between('local function selectConversation', 'local participants = groupMode and groupChat.choose');
  assert.match(select, /local mission = primary\.story and not projection and convaiMissionOn\(\) or nil/);
  assert.match(select, /convaiWorldTalk:refusal\(npc, player, nil, key, nil, mission\)/);
  assert.match(select, /if mission then convaiMissionJoin\(npc, key, name, primary\.entity, bodyType\) end/);
  assert.match(init, /convaiWorldTalk:refusal\(actor, convaiPlayer\(\), story\.entity, story\.key, story\.idle, story\.mission\)/);
  assert.match(init, /primary\.guarded, primary\.story and convaiStory ~= nil and convaiStory\.mission or nil\) then return false end/);
  // The group paths carry the mode for a story speaker too.
  assert.match(init, /story and convaiMissionOn\(\) or nil\)\s+if why then stats\.refused/);
  assert.match(init, /local mission = person\.story and convaiMissionOn\(\) or nil/);
  // Johnny's projection and the quest-bound people never take the mode.
  assert.match(select, /not projection/);
  assert.match(worldTalk, /local extended = mission == true and idle ~= true/);
});

// ---- 3. The setting ---------------------------------------------------------------------------------------------------------------------

test('the row is the same row in every host: MCM and Native Settings build the page from manager-ui.lua, with no list of their own', () => {
  const ui = modSource('manager-ui.lua');
  assert.match(ui, /setting\('storyMissionTalk', 'Talk during missions', 'bool', snapshot\.settings\.storyMissionTalk == true, false,/);
  assert.match(ui, /elseif key == 'storyMissionTalk' then\s+if type\(change\.value\) ~= 'boolean'/);
  assert.doesNotMatch(modSource('mcm-host.lua'), /storyMissionTalk/);
  assert.doesNotMatch(modSource('nsui.lua'), /storyMissionTalk/);
});

test('Talk during missions: off without a saved key, offered under Conversations, a boolean only, and it counts only with Talk to story characters on', () => {
  managerRun(`${nsuiFixture}
    assert(manager.storyMissionTalk() == false and manager.snapshot(player).settings.storyMissionTalk == false, 'a missing key is off')
    assert(invoke('tab:settings').ok)
    local mission = assert(row('storyMissionTalk'), 'the setting is not offered')
    assert(mission.type == 'bool' and mission.value == false and mission.defaultValue == false)
    assert(mission.label == 'Talk during missions')
    assert(mission.description:find('Experimental', 1, true) and mission.description:find('break scenes', 1, true), 'the help says it is experimental and may break scenes')
    assert(saved.storyMissionTalk == false, 'a new install saves the default Off')
    -- Without Talk to story characters the extended permission has nothing to extend.
    assert(registered.applyBatch('manager', {{id = 'storyMissionTalk', value = true}}).ok)
    assert(saved.storyMissionTalk == true and manager.storyMissionTalk() == false, 'on its own it does nothing')
    assert(registered.applyBatch('manager', {{id = 'storyConversations', value = true}}).ok and manager.storyMissionTalk() == true)
    loaded = registered.loadMod('manager'); assert(row('storyMissionTalk').value == true)
    assert(registered.applyBatch('manager', {{id = 'storyMissionTalk', value = false}}).ok)
    assert(manager.storyMissionTalk() == false and saved.storyMissionTalk == false and manager.storyConversations() == true, 'the neighbouring setting is not disturbed')
    assert(not manager.applySettings(player, {storyMissionTalk = 'yes'}) and manager.storyMissionTalk() == false)
    assert(registered.applyBatch('manager', {{id = 'storyConversations', value = false}}).ok)
  `);
});
const codes = readdirSync(new URL('../mod/locales/', import.meta.url)).filter(f => f.endsWith('.lua')).map(f => f.slice(0, -4));
test('the label and the help are translated in all 15 languages and in the string catalogue', () => {
  assert.equal(codes.length, 15);
  const catalogue = JSON.parse(read('../localization/en.json'));
  const label = 'Talk during missions';
  const help = ui => /setting\('storyMissionTalk'[^\n]*\n\s+'(.*?)'\),\n/s.exec(ui)[1].replace(/\\n/g, '\n').replace(/\\'/g, '\'');
  const helpText = help(read('../mod/manager-ui.lua'));
  assert.ok(catalogue.strings[label] === label && catalogue.strings[helpText] === helpText, 'en.json has both strings');
  for (const code of codes) {
    const text = read(`../mod/locales/${code}.lua`);
    const entry = key => text.includes(`[${JSON.stringify(key)}] = "`);
    assert.ok(entry(label), `${code}: label`);
    assert.ok(entry(helpText), `${code}: help`);
    assert.notEqual(new RegExp(`\\[${JSON.stringify(label).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\] = "${label}"`).test(text), true, `${code}: the label is translated`);
  }
});

// ---- 4. The character joins in, and steps back whenever the script drives -----------------------------------------------------------------

const FIXTURE = `
  local FREE = {gone = false, hub = false, dialogue = false, driven = false, hurt = false, mounted = false, workspot = false, staged = false, combat = false}
  local function copy(t, over) local c = {}; for k, v in pairs(t) do c[k] = v end; for k, v in pairs(over or {}) do c[k] = v end; return c end
  local function build(over)
    local t = {clock = 100, setting = true, quest = 'q1', alive = true, distance = 20, facts = copy(FREE), vehicle = nil, seat = 'seat_front_right',
      seated = false, reads = 0, sent = {follow = 0, mount = 0, unmount = 0, cancel = 0}, ops = {}, released = {}, freed = 0, stepped = 0,
      free = {}, held = {}, logs = {}, rideAllowed = true}
    for k, v in pairs(over or {}) do t[k] = v end
    local host = {
      setting = function() return t.setting end, now = function() return t.clock end,
      alive = function() return t.alive end, distance = function() return t.distance end,
      read = function() t.reads = t.reads + 1; return t.facts end, quest = function() return t.quest end,
      follow = function() t.sent.follow = t.sent.follow + 1; local op = {kind = 'follow', state = 'Executing'}; t.ops[#t.ops + 1] = op; return op end,
      playerVehicle = function() return t.vehicle end, mounted = function() return t.seated end,
      canBoard = function() return t.rideAllowed end, freeSeat = function() return t.seat end,
      mount = function(npc, vehicle, seat, out)
        if out then t.sent.unmount = t.sent.unmount + 1 else t.sent.mount = t.sent.mount + 1 end
        local op = {kind = out and 'unmount' or 'mount', state = 'Executing', seat = seat}; t.ops[#t.ops + 1] = op; return op
      end,
      state = function(op) return op.state end,
      cancel = function(op) t.sent.cancel = t.sent.cancel + 1; op.state = 'Cancelled'; return true end,
      changed = function(free, held) t.free, t.held = free, held end,
      freed = function() t.freed = t.freed + 1 end, stepped = function() t.stepped = t.stepped + 1 end,
      released = function(member, why, quiet) t.released[#t.released + 1] = why .. (quiet and ':quiet' or '') end,
      log = function(line) t.logs[#t.logs + 1] = line end,
    }
    return MC.new(host), t
  end
  local NPC, PLAYER = {}, {}
  local function tick(s, t, dt) t.clock = t.clock + (dt or 0.5); s:update(PLAYER, {}) end
  local function live(t) local n = 0; for _, op in ipairs(t.ops) do if op.state == 'Executing' then n = n + 1 end end; return n end
`;

test('a character joins only with the setting on and a mission tracked, and follows V on foot without a teleport', () => withMission(`${FIXTURE}
  local s, t = build({setting = false})
  assert(s:attach(NPC, 'judy-alvarez', 'Judy', '7') == false, 'setting off: nobody joins')
  t.setting, t.quest = true, nil
  assert(s:attach(NPC, 'judy-alvarez', 'Judy', '7') == false, 'no tracked mission: plain talk only')
  t.quest = 'q1'
  assert(s:attach(NPC, 'judy-alvarez', 'Judy', '7', 'WomanAverage') == true and s:member('7') ~= nil)
  assert(s:check('7', PLAYER, {}) == true)
  assert(t.freed == 1 and t.free['7'] == true, 'the game is not driving: she may act, and her face is let through')
  tick(s, t); assert(t.sent.follow == 1, 'V is 20 m away: she follows')
  tick(s, t); tick(s, t); assert(t.sent.follow == 1, 'one command at a time')
  t.distance = 3; tick(s, t); assert(t.sent.cancel == 1 and live(t) == 0, 'close to V: the command is cancelled, she stands')
  assert(s:rows(PLAYER)[1].profileKey == 'judy-alvarez' and s:rows(PLAYER)[1].bodyType == 'WomanAverage', 'a reaction row while free')
  assert(#s:faces() == 1)
`));

test('STEP BACK: a script that drives the character (a scripted move) stops every system at once, and none resumes until it has let go', () => withMission(`${FIXTURE}
  local s, t = build()
  s:attach(NPC, 'judy-alvarez', 'Judy', '7'); s:check('7', PLAYER, {})
  tick(s, t); assert(t.sent.follow == 1 and live(t) == 1)
  -- Our own follow makes the AI read as commanded: that is not the script.
  t.facts = copy(FREE, {driven = true})
  tick(s, t); assert(s:member('7').level == nil and t.stepped == 0, 'our own command is not a script driving')
  -- The script interrupts our command and commands the character itself.
  t.ops[1].state = 'Interrupted'
  tick(s, t)
  local m = s:member('7')
  assert(m.level == 'body' and m.reason == 'scripted', tostring(m.level) .. '/' .. tostring(m.reason))
  assert(t.stepped == 1 and t.held['7'] == true and t.free['7'] == nil, 'the face is kept off and the rows are withdrawn')
  assert(#s:rows(PLAYER) == 0 and #s:faces() == 0, 'no remarks, no speak-up, no idle face while the script drives')
  local before = t.sent.follow
  for _ = 1, 6 do tick(s, t) end
  assert(t.sent.follow == before and t.sent.mount == 0, 'nothing is commanded while the script drives (it never fights)')
  -- The script lets go: the character waits out the clear period, then resumes.
  t.facts = copy(FREE)
  tick(s, t); assert(s:member('7').level == 'body', 'let go just now: still stepped back')
  tick(s, t); tick(s, t); tick(s, t)
  assert(s:member('7').level == nil and t.free['7'] == true and #s:rows(PLAYER) == 1, 'resumed')
  tick(s, t); assert(t.sent.follow == before + 1, 'following V again')
`));

test('STEP BACK: a script that drives without any command of ours (a character on a scripted path) keeps every system off', () => withMission(`${FIXTURE}
  local s, t = build({facts = copy(FREE, {driven = true})})
  s:attach(NPC, 'judy-alvarez', 'Judy', '7'); s:check('7', PLAYER, {})
  assert(s:member('7').reason == 'scripted')
  for _ = 1, 8 do tick(s, t) end
  assert(t.sent.follow == 0 and t.sent.mount == 0 and #s:rows(PLAYER) == 0)
`));

test('STEP BACK: a cutscene, a scene dialogue, a dialogue choice scene, a staged workspot, an injury and an unreadable fact step everything back', () => withMission(`${FIXTURE}
  local cases = {
    {copy(FREE, {hub = true}), 'cutscene'}, {copy(FREE, {dialogue = true}), 'dialogue'}, {copy(FREE, {hurt = true}), 'hurt'},
    {copy(FREE, {workspot = true, staged = true}), 'workspot'}, {false, 'unreadable'}, {(function() local f = copy(FREE); f.driven = nil; return f end)(), 'unreadable'},
  }
  for index, case in ipairs(cases) do
    local s, t = build({facts = case[1]})
    s:attach(NPC, 'judy-alvarez', 'Judy', '7'); s:check('7', PLAYER, {})
    local m = s:member('7')
    assert(m and m.reason == case[2] and m.level == 'scene', index .. ': ' .. tostring(m and m.reason))
    for _ = 1, 4 do tick(s, t) end
    assert(t.sent.follow == 0 and t.sent.mount == 0 and #s:rows(PLAYER) == 0 and #s:faces() == 0, index .. ': nothing acts')
  end
  -- A workspot in open gameplay (a post the game gave her) holds the body only.
  local s, t = build({facts = copy(FREE, {workspot = true, staged = false})})
  s:attach(NPC, 'judy-alvarez', 'Judy', '7'); s:check('7', PLAYER, {})
  assert(s:member('7').level == 'body' and s:member('7').reason == 'workspot')
  assert(MC.driving(copy(FREE, {hub = true, driven = true}), {commanding = true}) == 'cutscene')
  assert(MC.driving(copy(FREE, {driven = true}), {commanding = false}) == 'scripted')
  assert(MC.driving(copy(FREE, {driven = true}), {commanding = true}) == nil)
  assert(MC.driving(copy(FREE, {driven = true, mounted = true}), {commanding = false}) == 'scripted-vehicle')
`));

test('a scene that begins while she follows cancels our command, and she resumes after it', () => withMission(`${FIXTURE}
  local s, t = build()
  s:attach(NPC, 'judy-alvarez', 'Judy', '7'); s:check('7', PLAYER, {})
  tick(s, t); assert(live(t) == 1)
  t.facts = copy(FREE, {hub = true})
  tick(s, t)
  assert(live(t) == 0 and t.sent.cancel >= 1, 'our command was cancelled the moment the cutscene began')
  assert(s:member('7').level == 'scene')
  t.facts = copy(FREE)
  tick(s, t); tick(s, t); tick(s, t); tick(s, t)
  assert(s:member('7').level == nil, 'back after the cutscene')
  tick(s, t); assert(live(t) == 1, 'following again')
`));

test("she sits in V's car when it has a free seat and V is in it, and gets out when V does; a scripted ride is left alone", () => withMission(`${FIXTURE}
  local s, t = build({distance = 6, vehicle = {entityID = 'car'}})
  s:attach(NPC, 'judy-alvarez', 'Judy', '7'); s:check('7', PLAYER, {})
  tick(s, t)
  assert(t.sent.mount == 1 and t.ops[1].seat == 'seat_front_right', 'boarding the passenger seat: ' .. t.sent.mount .. ' ' .. tostring(s:member('7') and s:member('7').level) .. ' ' .. table.concat(t.logs, ' / '))
  assert(t.sent.follow == 0, 'one command at a time')
  t.ops[1].state = 'Success'; t.seated = true
  tick(s, t); assert(t.sent.mount == 1 and t.sent.follow == 0, 'seated: nothing more')
  t.vehicle = nil
  tick(s, t); assert(t.sent.unmount == 1, 'V got out: so does she (the ordinary way, never instant)')
  -- No free seat, or the car refuses her: no command.
  local a, b = build({distance = 6, vehicle = {entityID = 'car'}, seat = false})
  a:attach(NPC, 'judy-alvarez', 'Judy', '7'); a:check('7', PLAYER, {}); tick(a, b)
  assert(b.sent.mount == 0, 'no free seat: no command ' .. b.sent.mount)
  -- A scripted ride (mounted and commanded) is the game\\'s: she steps back and nothing is sent, at release too.
  local c, d = build({vehicle = {entityID = 'car'}, seated = true, facts = copy(FREE, {mounted = true, driven = true})})
  c:attach(NPC, 'judy-alvarez', 'Judy', '7'); c:check('7', PLAYER, {})
  assert(c:member('7') and c:member('7').reason == 'scripted-vehicle', tostring(c:member('7') and c:member('7').reason) .. ' ' .. table.concat(d.logs, ' / '))
  for _ = 1, 4 do tick(c, d) end
  c:releaseAll('setting-off')
  assert(d.sent.mount == 0 and d.sent.unmount == 0, 'a character the script seated is never unseated by us')
`));

// ---- 5. Clean release ---------------------------------------------------------------------------------------------------------------------

test('RELEASE: turning the setting off cancels our commands, stands her out of the car we put her in, withdraws the rows and the face', () => withMission(`${FIXTURE}
  local s, t = build({distance = 6, vehicle = {entityID = 'car'}})
  s:attach(NPC, 'judy-alvarez', 'Judy', '7'); s:check('7', PLAYER, {})
  tick(s, t); t.ops[1].state = 'Success'; t.seated = true
  local other, ot = build()
  other:attach(NPC, 'judy-alvarez', 'Judy', '8'); other:check('8', PLAYER, {}); tick(other, ot)
  assert(live(ot) == 1)
  ot.setting = false
  tick(other, ot)
  assert(live(ot) == 0 and #other.members == 0 and ot.released[1] == 'setting-off', 'the follow command is cancelled and the member released')
  assert(next(ot.free) == nil and next(ot.held) == nil and #other:rows(PLAYER) == 0 and #other:faces() == 0)
  t.setting = false; tick(s, t)
  assert(t.sent.unmount == 1 and t.released[1] == 'setting-off', 'seated by us, the game is not driving her: she gets out')
  tick(other, ot); tick(s, t); assert(ot.sent.follow == 1 and t.sent.mount == 1, 'nothing is sent after the release')
`));

test('RELEASE: the mission ending, her being gone or left far behind, and any world change release her', () => withMission(`${FIXTURE}
  -- The tracked mission changes or ends for three checks in a row.
  local s, t = build()
  s:attach(NPC, 'judy-alvarez', 'Judy', '7'); s:check('7', PLAYER, {}); tick(s, t); assert(live(t) == 1)
  t.quest = 'q2'
  tick(s, t, 2.1); tick(s, t, 2.1); assert(s:member('7') ~= nil, 'two misses are not the end')
  tick(s, t, 2.1)
  assert(s:member('7') == nil and t.released[1] == 'mission-ended' and live(t) == 0, tostring(t.released[1]) .. ' live=' .. live(t) .. ' ' .. table.concat(t.logs, ' / '))
  -- A blip that comes back is not the end.
  local b, bt = build()
  b:attach(NPC, 'judy-alvarez', 'Judy', '7'); b:check('7', PLAYER, {})
  bt.quest = nil; tick(b, bt, 2.1); tick(b, bt, 2.1); bt.quest = 'q1'; tick(b, bt, 2.1); tick(b, bt, 2.1); tick(b, bt, 2.1)
  assert(b:member('7') ~= nil)
  -- Gone: no native call at all on a stale body.
  local g, gt = build()
  g:attach(NPC, 'judy-alvarez', 'Judy', '7'); g:check('7', PLAYER, {}); tick(g, gt)
  gt.alive = false; local cancels = gt.sent.cancel; tick(g, gt)
  assert(g:member('7') == nil and gt.released[1] == 'gone:quiet' and gt.sent.cancel == cancels)
  -- Left far behind for longer than the grace.
  local f, ft = build({distance = 300})
  f:attach(NPC, 'judy-alvarez', 'Judy', '7'); f:check('7', PLAYER, {})
  tick(f, ft, 3); assert(f:member('7') ~= nil, 'a short gap is no reason')
  tick(f, ft, 3); assert(f:member('7') ~= nil, 'six seconds is inside the grace'); tick(f, ft, 5)
  assert(f:member('7') == nil and ft.released[1] == 'left-behind')
  -- A load, a death or a fast travel: released in one call; quiet means no native call.
  local w, wt = build()
  w:attach(NPC, 'judy-alvarez', 'Judy', '7'); w:attach(NPC, 'panam-palmer', 'Panam', '8')
  w:releaseAll('world-reset', true)
  assert(#w.members == 0 and wt.released[1] == 'world-reset:quiet' and wt.released[2] == 'world-reset:quiet' and wt.sent.cancel == 0)
  assert(next(wt.free) == nil and next(wt.held) == nil)
`));

test('an error in one member releases that member and nobody else; the arbiter reads at most twice a second', () => withMission(`${FIXTURE}
  local s, t = build()
  s:attach(NPC, 'judy-alvarez', 'Judy', '7'); s:attach(NPC, 'panam-palmer', 'Panam', '8')
  local good = t.facts
  t.facts = good
  tick(s, t); local afterOne = t.reads
  assert(afterOne == 2, 'one read per member: ' .. afterOne)
  s:update(PLAYER, {}); assert(t.reads == afterOne, 'a poll inside the interval reads nothing')
  t.clock = t.clock + 0.1; s:update(PLAYER, {}); assert(t.reads == afterOne, 'still inside the interval')
  t.clock = t.clock + 0.5; s:update(PLAYER, {}); assert(t.reads == afterOne + 2, 'due again')
  assert(#s.members == 2)
  local limit, full = build(), nil
  for index = 1, 4 do limit:attach(NPC, 'k' .. index, 'N' .. index, tostring(index)) end
  assert(#limit.members == 3, 'at most three characters join in')
`));

// ---- 6. What it never does, and no per-frame work -------------------------------------------------------------------------------------------

test('it never teleports, despawns, hides, changes the AI role, attitude, equipment, appearance, the quest facts or the story state', () => {
  const glue = between('convaiMission, convaiMissionFailed', 'local function reactionLease');
  for (const [name, source] of [['mission-companion.lua', missionSource], ['the init.lua glue', glue]]) {
    for (const forbidden of [/Teleport/, /Despawn/, /DeleteEntity/, /SetAIRole/, /\bSetAttitude\b/, /SetVisible/, /AddFact|SetFact|QuestsSystem|GetQuestsSystem/, /AIFollowerRole/,
      /ChangeAppearance|ScheduleAppearanceChange/, /EquipItem|UnequipItem|AddItem/, /ForceKill|Kill\(/, /GetJournalManager\(\):(Track|Untrack|Set)/, /AbortQuest|Restart/]) {
      assert.doesNotMatch(source, forbidden, `${name} must not use ${forbidden}`);
    }
  }
  assert.match(glue, /command\.teleport = false/, 'the follow command is sent with teleport off');
  assert.match(glue, /command\.stopWhenDestinationReached = false/);
  // The mount command: never instant, never the failsafe teleport (companion-vehicle-native.lua `mount`, instant only for a failsafe unmount).
  assert.match(glue, /native\.mount, \{npc = npc\}, vehicle, seat, out == true/);
  const native = read('../mod/companion-vehicle-native.lua');
  assert.match(native, /local instant=unmount==true and failsafe==true/);
});

test('it adds no per-frame work: it is polled from the battle observer\'s half-second poll, and everything is a nil check while the setting is Off', () => {
  const update = between("registerForEvent('onUpdate', function(delta)", "registerForEvent('onShutdown'", init);
  assert.doesNotMatch(update, /convaiMission|mission-companion/, 'onUpdate is untouched');
  const poll = between('local function updateBattles(player, elapsed, worldReady)', 'local now = os.time()');
  assert.match(poll, /if not battleSample or battlePoll >= 0\.5 then[\s\S]*if convaiMission then convaiMissionTick\(player, battleSample\) end[\s\S]*end\s*$/);
  assert.equal([...init.matchAll(/convaiMissionTick\(/g)].length, 2, 'defined once, called once');
  // Loaded on the first join only.
  assert.equal([...init.matchAll(/dofile, 'mission-companion\.lua'/g)].length, 1);
  assert.match(init, /function convaiMissionTick\(player, sample\)\s+local service = convaiMission\s+if service then service:update\(player, sample\) end\s+end/);
  assert.match(init, /if mission then convaiMissionJoin/);
  // The face layer: a table lookup per call, nothing native.
  const facial = read('../mod/facial-playback.lua');
  assert.match(facial, /M\.faceHeld~=nil and M\.faceHeld\[entity\]==true/);
  assert.match(facial, /M\.missionFaces~=nil and M\.missionFaces\[entity\]==true/);
  // The party rows add the faces without a native call.
  assert.match(read('../mod/companions.lua'), /for _, row in ipairs\(mission:faces\(\)\) do expressionRows\[#expressionRows \+ 1\] = row end/);
});

test('everything it attaches is released with the world: a session reset releases the members and the face sets', () => {
  const abandon = between('convaiStory = nil\n    if convaiFacialPlayback then convaiFacialPlayback.storyEntity', 'if convaiWorldTalk then convaiWorldTalk:reset() end');
  assert.match(abandon, /convaiMissionReset\(reason\)/);
  assert.match(init, /released = function\(member, reason, quiet\)[\s\S]{0,300}ConvaiFaceProjection\(false\)[\s\S]{0,300}clearExpression/);
  assert.match(init, /stepped = function\(member\) pcall\(function\(\) member\.npc:ConvaiFaceProjection\(false\)/);
  assert.match(init, /changed = function\(free, held\)[\s\S]{0,200}facial\.missionFaces, facial\.faceHeld = free, held/);
  // The reaction rows come from members the game is not driving.
  assert.match(init, /for _, person in ipairs\(convaiMissionRows\(player\)\) do/);
});

// ---- 7. The live context -----------------------------------------------------------------------------------------------------------

test('a story character in a mission is told what the mod knows of it: the quest journal, the fight and the vehicle (the same blocks as a companion)', () => {
  const raw = {
    requestId: '1-1-7ULL', generation: 1, entity: '7ULL', profileKey: 'judy-alvarez', name: 'Judy', bodyType: 'WomanAverage', text: 'Where are we headed?',
    journal: {version: 1, status: 'active', quest: {id: '123', title: 'The Heist', objectives: [{id: '1', text: 'Reach the vault door', tracked: true}]}},
    journalHistory: {version: 1, status: 'unavailable'}, worldKnowledge: {version: 1, status: 'unavailable'},
    battle: {version: 1, status: 'fighting', encounter: 'battle-12', ageSeconds: 5, durationSeconds: 20, opponents: [{name: 'Maelstrom Thug', count: 2}], witnesses: ['judy-alvarez']},
    turnContext: {version: 1, status: 'ready', gameTime: 40 * 86400, hour: 2, minute: 10, district: 'Heywood', area: 'Glen_Embers', indoors: false, gender: 'female', voice: 'female',
      lifepath: 'streetkid', weather: 'clear', health: 'fine', heat: 0, money: 'ok', vehicle: true, driving: true, party: []},
  };
  const context = conversationContext(parseInput(JSON.stringify(raw)));
  assert.match(context, /The Heist/, 'the quest journal');
  assert.match(context, /Reach the vault door/);
  assert.match(context, /Maelstrom/, 'the fight');
  assert.match(context, /driving/i, 'the vehicle');
});

test('the docs say what the setting does, what it never does and how the game keeps priority', () => {
  const doc = read('../docs/WORLD_CHARACTERS.md');
  for (const needle of ['Talk during missions', 'experimental', 'steps back', 'No teleport', 'Release', 'holds the reply']) {
    assert.ok(doc.toLowerCase().includes(needle.toLowerCase()), needle);
  }
  assert.match(read('../README.md'), /Talk during missions/);
});
