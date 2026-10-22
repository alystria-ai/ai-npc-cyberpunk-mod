import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import fengari from 'fengari';

const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;
const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const moduleSource = read('../mod/talk-target.lua');
const init = read('../mod/init.lua');
const targeting = init.slice(init.indexOf('convaiEntityKey = function'), init.indexOf('local function resetGaze()'));

function run(code) {
  const state = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(state);
  const status = lauxlib.luaL_dostring(state, to_luastring(code));
  const error = status === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(state, -1));
  lua.lua_close(state);
  assert.equal(status, lua.LUA_OK, error);
}

// The decision rules on measured rows, with a settable clock.
const unit = `
  local module = (function() ${moduleSource} end)()
  local now = 1000
  local T = module.new({clock = function() return now end})
  local function row(id, angle, distance, extra)
    local r = {id = id, npc = id, angle = angle, distance = distance or 2}
    for k, v in pairs(extra or {}) do r[k] = v end
    return r
  end
`;

test('a roughly centred party member beats a closer, native looked-at pedestrian', () => run(`${unit}
  local judy = row('judy', 9, 3, {party = true})
  local walker = row('walker', 4, 1.5, {looked = true})
  local chosen, reason = T.choose({walker, judy})
  assert(chosen == judy and reason == 'party-centred', tostring(reason))
  -- Outside the party cone the ordinary ranking applies again.
  judy.angle = 20
  chosen, reason = T.choose({walker, judy})
  assert(chosen == walker and reason == 'nearest-to-centre')
`));

test('an ongoing conversation keeps its partner unless V clearly looks at someone else', () => run(`${unit}
  T.remember('resident')
  local resident = row('resident', 12, 2)
  local other = row('other', 7, 1.5, {looked = true})
  local chosen, reason = T.choose({other, resident})
  assert(chosen == resident and reason == 'ongoing', 'a passer-by near the crosshair stole the turn')
  other.angle = 3 -- clearly looked at, and 9 degrees closer to the crosshair
  chosen, reason = T.choose({other, resident})
  assert(chosen == other and reason == 'retarget')
  other.angle = 5; resident.angle = 12 -- clearly looked at but not clearly closer
  assert(T.choose({other, resident}) == resident)
`));

test('the partner stays only while close and roughly in view, and only for the conversation window', () => run(`${unit}
  T.remember('resident')
  local resident = row('resident', 30, 2)
  local other = row('other', 10, 3)
  assert(T.choose({resident, other}) == other, 'a partner well out of view kept the turn')
  resident.angle = 20
  assert(T.choose({resident, other}) == resident)
  assert(T.choose({other}) == other, 'a partner out of range or gone cannot be chosen')
  now = now + 121
  assert(T.partner() == nil)
  local chosen, reason = T.choose({resident, other})
  assert(chosen == other and reason == 'nearest-to-centre', 'an old conversation still held its partner')
`));

test('ambient characters never take a turn from a centred companion partner; a party member may re-target', () => run(`${unit}
  T.remember('judy')
  local judy = row('judy', 10, 2, {party = true})
  local walker = row('walker', 0, 1, {looked = true})
  local chosen, reason = T.choose({walker, judy})
  assert(chosen == judy and reason == 'ongoing')
  local panam = row('panam', 1, 2, {party = true})
  chosen, reason = T.choose({walker, judy, panam})
  assert(chosen == panam and reason == 'retarget', 'the ambient walker hid a party member V clearly looks at')
  chosen, reason = T.choose({judy, panam})
  assert(chosen == panam and reason == 'retarget')
  -- An ambient partner gives way to a party member V clearly looks at.
  T.remember('resident')
  chosen, reason = T.choose({row('resident', 20, 2), row('judy', 2, 2, {party = true})})
  assert(chosen.id == 'judy' and reason == 'retarget')
`));

test('every decision renders one probe line with the choice, reason and each candidate', () => run(`${unit}
  T.remember('judy')
  local judy = row('judy', 1.44, 2.04, {party = true})
  local walker = row('walker', 5.7, 3.01, {looked = true})
  local chosen, reason = T.choose({walker, judy})
  local line = T.describe({walker, judy}, chosen, reason, function(r) return r.id == 'judy' and 'judy-alvarez' or nil end)
  assert(line == 'Talk target: chose=judy-alvarez/judy reason=ongoing partner=judy candidates=['
    .. 'walker/walker a=5.7 d=3.0 looked; judy-alvarez/judy a=1.4 d=2.0 party partner]', line)
  assert(T.describe({}, nil, 'none'):find('chose=none reason=none', 1, true))
  local _, why = T.choose({})
  assert(why == 'none')
`));

// targetAtCrosshair itself, sliced from init.lua, with the incident geometry:
// V's eye at 1.7 m, Judy (a party member) 3 m ahead looked at in the face, and
// a pedestrian walking across 1.5 m ahead, which the native look-at reports.
const world = `
  local function npc(id, x, y)
    local n = {id = id, pos = {x = x, y = y, z = 0}}
    n.head = {x = x, y = y, z = 1.65}
    function n:IsNPC() return true end
    function n:IsAttached() return true end
    function n:IsDeadNoStatPool() return false end
    function n:GetEntityID() return {hash = id} end
    function n:GetWorldPosition() return self.pos end
    function n:GetSlotComponent() return {GetSlotTransform = function(_, slot)
      return n.head ~= nil, n.head and {position = n.head}
    end} end
    return n
  end
  local judy, walker = npc('judy', 3, 0), npc('walker', 1.5, 0.2)
  local owned = {judy = true}
  companions = {seatedCandidates = function() return {} end, onFootCandidates = function() return {} end,
    owns = function(n) return owned[n.id] == true end, visibleFromCrosshair = function() return true end}
  WorldTransform = {GetWorldPosition = function(t) return t.position end}
  WorldPosition = {ToVector4 = function(p) return p end}
  CName = {new = function(v) return v end}
  TargetSearchQuery = {new = function() return {} end}
  TS_TargetPartInfo = {GetComponent = function(part) return {GetEntity = function() return part.entity end} end}
  local parts, looked = {{entity = judy}, {entity = walker}}, walker
  local origin, forward = {x = 0, y = 0, z = 1.7}, {x = 1, y = 0, z = 0}
  local targetingSystem = {GetTargetParts = function() return true, parts end,
    GetObjectClosestToCrosshair = function() return looked end, GetLookAtObject = function() return looked end,
    GetCrosshairData = function() return origin, forward end}
  Game = {GetPlayer = function() return {} end, GetTargetingSystem = function() return targetingSystem end,
    ['TSF_NPC;'] = function() return {} end}
  ${targeting}
`;

test('replay: without the chooser the looked-at pedestrian wins; with it the centred companion does', () => run(`${world}
  convaiTalkTarget = nil
  assert(targetAtCrosshair() == walker, 'the fixture no longer reproduces the original ranking')
  local module = (function() ${moduleSource} end)()
  convaiTalkTarget = module.new()
  local chosen, reason, decision = targetAtCrosshair()
  assert(chosen == judy and reason == nil and decision.reason == 'party-centred', tostring(decision.reason))
  assert(#decision.rows == 2, 'each candidate is measured once')
  for _, row in ipairs(decision.rows) do
    if row.id == 'judy' then assert(row.party and not row.looked and row.angle < 1, 'the Head slot is an aim point') end
    if row.id == 'walker' then assert(row.looked and not row.party) end
  end
`));

test('replay: an ongoing chat with a resident survives a second pedestrian crossing the crosshair', () => run(`${world}
  owned = {}
  local module = (function() ${moduleSource} end)()
  convaiTalkTarget = module.new()
  convaiTalkTarget.remember('judy') -- here an ambient resident standing where Judy stood
  local chosen, _, decision = targetAtCrosshair()
  assert(chosen == judy and decision.reason == 'ongoing')
  -- V turns clearly to the walker: the walker is now centred and the partner is off to the side.
  forward = {x = 1.5, y = 0.2, z = -0.05}
  judy.pos.y, judy.head.y = -0.6, -0.6
  chosen, _, decision = targetAtCrosshair()
  assert(chosen == walker and decision.reason == 'retarget', tostring(decision.reason))
  -- Nobody in front: the reason the player sees is unchanged.
  forward = {x = -1, y = 0, z = 0}; looked = nil
  local none, why = targetAtCrosshair()
  assert(none == nil and why == 'Face a nearby character to talk.')
`));

test('init.lua loads the chooser, logs each talk decision and remembers the partner outside onUpdate', () => {
  const between = (start, end) => {
    const from = init.indexOf(start);
    assert.ok(from >= 0, `missing ${start}`);
    const to = init.indexOf(end, from + start.length);
    assert.ok(to > from, `missing ${end} after ${start}`);
    return init.slice(from, to);
  };
  assert.match(init, /pcall\(dofile, 'talk-target\.lua'\)/);
  const select = between('local function selectConversation(', '\nend\n');
  assert.match(select, /local npc, reason, decision = targetAtCrosshair\(\)\n\s+logTalkTarget\(decision\)/);
  assert.match(select, /pcall\(convaiTalkTarget\.remember, primary\.entity\) end\n\s+return primary, participants/);
  assert.match(between('local function logTalkTarget(', '\nend\n'), /chooser\.describe, decision\.rows/);
  assert.doesNotMatch(between("registerForEvent('onUpdate'", "registerForEvent('onShutdown'"), /TalkTarget|talkTarget/);
});

test('the chooser is packaged and deployed next to init.lua', () => {
  for (const path of ['../packaging/release-plan.json', '../scripts/development-files.json']) {
    assert.match(read(path), /"source": "mod\/talk-target\.lua",\s+"target": "bin\/x64\/plugins\/cyber_engine_tweaks\/mods\/AiNpcCyberpunkMod\/talk-target\.lua"/, path);
  }
});

// The 5 Hz gaze scan (docs/PERFORMANCE_NATIVE_PLAN.md, review 2026-10-22): one candidate per entity, no Head slot reads for an NPC
// that cannot pass the cone, and the native query separable from the measuring so the gaze can run them on two ticks.
test('gaze scan: an entity reached through several parts is measured once, and the choice is the one it always was', () => run(`${world}
  local isNpc, slotReads = 0, 0
  for _, n in ipairs({judy, walker}) do
    local inner = n.IsNPC; n.IsNPC = function(self) isNpc = isNpc + 1; return inner(self) end
    local slot = n.GetSlotComponent; n.GetSlotComponent = function(self) slotReads = slotReads + 1; return slot(self) end
  end
  parts = {{entity = judy}, {entity = judy}, {entity = judy}, {entity = walker}, {entity = walker}}
  local module = (function() ${moduleSource} end)()
  convaiTalkTarget = module.new()
  local chosen, reason, decision = targetAtCrosshair()
  assert(chosen == judy and decision.reason == 'party-centred' and #decision.rows == 2)
  assert(isNpc == 2, 'one NPC read per entity, got ' .. isNpc)
  assert(#convaiTalkNative == 2, 'the key press list holds each entity once')
`));

test('gaze scan: an NPC well outside the cone costs no Head slot read, one near the edge or looked at still does', () => run(`${world}
  local slotReads = {}
  local function count(n)
    local slot = n.GetSlotComponent; n.GetSlotComponent = function(self) slotReads[n.id] = (slotReads[n.id] or 0) + 1; return slot(self) end
  end
  local behind, side, edge = npc('behind', -3, 2), npc('side', 0.5, 6), npc('edge', 3, 2.2)
  for _, n in ipairs({judy, walker, behind, side, edge}) do count(n) end
  parts = {{entity = judy}, {entity = walker}, {entity = behind}, {entity = side}, {entity = edge}}
  convaiTalkTarget = nil
  local chosen = targetAtCrosshair()
  assert(slotReads.behind == nil, 'an NPC behind V needs no head read')
  assert(slotReads.side == nil, 'an NPC 85 degrees off needs none')
  assert(slotReads.judy == 1 and slotReads.walker == 1, 'candidates in the cone still read the head')
  assert(slotReads.edge == 1, 'an NPC near the cone edge is not skipped')
  assert(chosen == walker)
  -- The skip is geometry only: the result equals the one with every head read made.
  convaiHeadOutOfCone = function() return false end
  assert(targetAtCrosshair() == chosen)
`));

test('gaze scan: gathering and measuring are two phases, and a measuring phase with a gathered list queries nothing new', () => run(`${world}
  local queries = 0
  TargetSearchQuery = {new = function() queries = queries + 1; return {} end}
  local gathered = gatherTargets(Game.GetPlayer())
  assert(queries == 1 and #gathered.candidates == 2 and convaiTalkNative == gathered.candidates)
  local chosen, _, decision = targetAtCrosshair(gathered)
  assert(queries == 1, 'the measuring phase asked the game for no new query')
  local direct, _, directDecision = targetAtCrosshair()
  assert(queries == 2 and chosen == direct and decision.reason == directDecision.reason and #decision.rows == #directDecision.rows)
`));
