import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import fengari from 'fengari';

// Johnny in your head (docs/JOHNNY_IN_YOUR_HEAD.md): the story gate, the standing, the busy gate and the service of
// mod/johnny-head.lua, in fengari.
const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;
const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const moduleSource = read('../mod/johnny-head.lua');

function run(code) {
  const state = lauxlib.luaL_newstate(); lualib.luaL_openlibs(state);
  const result = lauxlib.luaL_dostring(state, to_luastring(code));
  const error = result === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(state, -1));
  lua.lua_close(state); assert.equal(result, lua.LUA_OK, error);
}
const withModule = code => run(`local J = (function() ${moduleSource} end)()
  -- Every fact the module knows, at zero, with overrides.
  local function facts(over)
    local f = {[J.START] = 1}
    for _, name in ipairs(J.ENDINGS) do f[name] = 0 end
    for _, row in ipairs(J.MILESTONES) do f[row.fact] = 0 end
    for k, v in pairs(over or {}) do if v == false then f[k] = nil else f[k] = v end end
    return f
  end
  local function list(t) return table.concat(t, ',') end
${code}`);

// ---------------------------------------------------------------------------------------------------------------------
// The story gate.

test('story: in V\'s head after Playing for Time until an ending removes him; an unreadable fact closes the gate', () => withModule(`
  assert(J.START == 'q101_done')
  assert(J.story(facts()) == 'active')
  assert(J.story(facts({q101_done = 0})) == 'before', 'before the story puts him there')
  for _, name in ipairs({'q201_active', 'q201_done', 'q202_active', 'q202_done', 'q203_active', 'q204_active', 'q204_done', 'q307_2079'}) do
    assert(J.story(facts({[name] = 1})) == 'after', name .. ' is an ending that removes him')
  end
  assert(#J.ENDINGS == 8)
  assert(J.story(facts({q101_done = false})) == 'unreadable')
  assert(J.story(facts({q203_active = false})) == 'unreadable', 'an unread ending must not open the gate')
  assert(J.story(facts({q101_done = 0, q203_active = false})) == 'before', 'nothing past the start is needed before it')
  assert(J.story(nil) == 'unreadable' and J.story({}) == 'unreadable')
`));

// ---------------------------------------------------------------------------------------------------------------------
// The standing.

test('stage: wary, grudging, friends and close follow the shared milestones; the milestones are listed in order', () => withModule(`
  local stage, reached = J.stage(facts())
  assert(stage == 'wary' and #reached == 0)
  stage, reached = J.stage(facts({q110_made_contact_with_alt = 1}))
  assert(stage == 'grudging' and list(reached) == 'alt')
  stage, reached = J.stage(facts({sq031_cool_metal_fire_done = 1, sq031_porsche_unlocked = 1}))
  assert(stage == 'grudging' and list(reached) == 'bender,porsche', 'no second chance: grudging however much is shared')
  stage, reached = J.stage(facts({sq032_johnny_friend = 1}))
  assert(stage == 'friends' and list(reached) == 'second-chance')
  stage = J.stage(facts({sq032_johnny_friend = 1, sq031_cool_metal_fire_done = 1, sq031_rogue_date_done = 1}))
  assert(stage == 'friends', 'his night out does not count towards close')
  stage, reached = J.stage(facts({sq032_johnny_friend = 1, sq031_rogue_date_done = 1, sq031_samurai_concert_done = 1}))
  assert(stage == 'close' and list(reached) == 'second-chance,rogue-date,reunion')
  stage, reached = J.stage(facts({sq032_johnny_friend = 1, q110_made_contact_with_alt = 1, sq031_porsche_unlocked = 1, sq031_cool_metal_fire_done = 1}))
  assert(stage == 'close' and list(reached) == 'alt,bender,porsche,second-chance')
  -- A fact counts only above zero; an unread milestone is simply not reached.
  stage = J.stage(facts({sq032_johnny_friend = false, q110_made_contact_with_alt = 1}))
  assert(stage == 'grudging')
  -- Not in V's head: the story state, with nothing reached.
  stage, reached = J.stage(facts({q101_done = 0, sq032_johnny_friend = 1}))
  assert(stage == 'before' and #reached == 0)
  assert(J.stage(facts({q204_done = 1})) == 'after')
  assert(J.stage(facts({q101_done = false})) == 'unreadable')
  -- Every milestone has a fact name, and the ids are what the bridge words (bridge/johnny-head.mjs).
  local ids = {}
  for _, row in ipairs(J.MILESTONES) do assert(type(row.fact) == 'string' and row.fact ~= ''); ids[#ids + 1] = row.id end
  assert(list(ids) == 'alt,bender,porsche,second-chance,rogue-date,reunion')
  local head = J.headField('friends', {'second-chance'})
  assert(head.version == 1 and head.stage == 'friends' and head.milestones[1] == 'second-chance')
  assert(type(J.headField('wary').milestones) == 'table')
`));

// ---------------------------------------------------------------------------------------------------------------------
// The busy gate.

test('busy: the game has the floor in a scene, a call, a quest conversation, a fight, a replacer, or right after a line of his', () => withModule(`
  local function sample(over)
    local s = {available = true, tier = 1, dialogue = false, choices = false, call = false, combat = false, replacer = false, vehicle = false}
    for k, v in pairs(over or {}) do s[k] = v end
    return s
  end
  assert(J.busy(sample()) == nil, 'open gameplay')
  assert(J.busy(sample({vehicle = true})) == nil, 'a drive is fine: he talks in the car')
  assert(J.busy(sample({choices = true})) == nil, 'a choice at tier 1 is the Talk prompt on a vendor, not a conversation')
  assert(J.busy(sample({tier = 2})) == 'scene', 'staged gameplay: the game often stages its own Johnny there')
  assert(J.busy(sample({tier = 3})) == 'scene' and J.busy(sample({tier = 5})) == 'scene')
  assert(J.busy(sample({tier = false, choices = true})) == 'scene', 'a choice with the tier unknown fails closed')
  assert(J.busy(sample({tier = false})) == nil)
  assert(J.busy(sample({dialogue = true})) == 'dialogue')
  assert(J.busy(sample({call = true})) == 'call')
  assert(J.busy(sample({combat = true})) == 'combat')
  assert(J.busy(sample({replacer = true})) == 'replacer', 'the player is someone else (a flashback as Johnny)')
  assert(J.busy(sample(), true) == 'johnny-speaking')
  assert(J.busy(sample({replacer = true, call = true, dialogue = true, tier = 3, combat = true}), true) == 'replacer', 'the first reason wins')
  assert(J.busy(sample({call = true, tier = 3})) == 'call')
  assert(J.busy(nil) == 'unreadable' and J.busy({available = false}) == 'unreadable')
`));

test('recentLine: a game line of his in the last seconds, newest first, never older ones or other speakers', () => withModule(`
  local rows = {{profileKey = 'johnny-silverhand', at = 100}, {profileKey = 'judy-alvarez', at = 195}, {at = 196}}
  assert(J.recentLine(rows, 200, J.KEY, 10) == false, 'his line is 100 s old')
  rows[#rows + 1] = {profileKey = 'johnny-silverhand', at = 192}
  assert(J.recentLine(rows, 200, J.KEY, 10) == true)
  assert(J.recentLine(rows, 203, J.KEY, 10) == false, 'just past the window')
  assert(J.recentLine({}, 200, J.KEY, 10) == false and J.recentLine(nil, 200, J.KEY, 10) == false)
  assert(J.recentLine({{profileKey = 'johnny-silverhand'}}, 200, J.KEY, 10) == false, 'a row without a time is skipped')
  assert(J.LINE_SECONDS == 10)
`));

// ---------------------------------------------------------------------------------------------------------------------
// The service against a fake game.

const service = `
  local t, wall, values, reads = 0, 1000, {}, {}
  for name, value in pairs(facts()) do values[name] = value end
  local readable = true
  local function readFact(name)
    reads[#reads + 1] = name
    if not readable then error('no quests system') end
    return values[name] or 0
  end
  local state = {sample = {available = true, tier = 1, dialogue = false, choices = false, call = false, combat = false, replacer = false}, samples = 0}
  local rows = {}
  local S = J.new({readFact = readFact, clock = function() return t end, now = function() return wall end,
    sample = function(player) state.samples = state.samples + 1; assert(player == 'V'); return state.sample end,
    lines = function() return rows end})
  local player = {GetEntityID = function() return {hash = '4242ULL'} end}
  local function tick(seconds) t = t + seconds; wall = wall + seconds end
`;

test('service: facts held five seconds, nothing past the start read before it, refusals held 0.4 s', () => withModule(`${service}
  values.q101_done = 0
  assert(S:refusal('V') == 'before')
  assert(#reads == 1 and reads[1] == 'q101_done', 'before the story only the start is read')
  assert(state.samples == 0, 'no sample is taken when he is not in V\\'s head')
  values.q101_done = 1
  assert(S:refusal('V') == 'before', 'held 0.4 s')
  tick(0.5)
  assert(S:refusal('V') == 'before', 'the facts are held 5 s')
  tick(5)
  assert(S:refusal('V') == nil, 'in V\\'s head and the game does not have the floor')
  assert(#reads == 1 + 1 + #J.ENDINGS + #J.MILESTONES, 'fifteen reads in all')
  assert(state.samples == 1)
  state.sample.combat = true
  assert(S:refusal('V') == nil, 'held')
  tick(0.5)
  assert(S:refusal('V') == 'combat' and state.samples == 2)
  state.sample.combat = false
  rows[1] = {profileKey = 'johnny-silverhand', at = wall - 3}
  tick(0.5)
  assert(S:refusal('V') == 'johnny-speaking')
  tick(10)
  assert(S:refusal('V') == nil, 'his game line is older than ten seconds now')
  values.q307_2079 = 1
  tick(5)
  assert(S:refusal('V') == 'after')
  readable = false
  S:reset()
  assert(S:refusal('V') == 'unreadable' and S:standing() == 'unknown')
`));

test('service: the partner is V\'s own entity with his profile, voice only and the head field; the standing for the settings page', () => withModule(`${service}
  values.sq032_johnny_friend, values.sq031_rogue_date_done, values.sq031_samurai_concert_done = 1, 1, 1
  local partner = assert(S:partner(player))
  assert(partner.npc == player and partner.entity == '4242ULL','V\\'s entity hash')
  assert(partner.profileKey == 'johnny-silverhand' and partner.name == 'Johnny Silverhand' and partner.voiceOnly == true and partner.bodyType == '')
  assert(partner.holocall == nil, 'not a holocall: his own marker')
  assert(partner.head.version == 1 and partner.head.stage == 'close' and table.concat(partner.head.milestones, ',') == 'second-chance,rogue-date,reunion')
  assert(S:standing() == 'close')
  assert(S:partner({GetEntityID = function() error('gone') end}) == nil)
  values.q101_done = 0
  S:reset()
  assert(S:standing() == 'before')
`));

test('the module is read-only, has no update entry point and never touches the game\'s Johnny', () => {
  assert.doesNotMatch(moduleSource, /registerForEvent|onUpdate|function [A-Za-z.:]*update\b/);
  assert.doesNotMatch(moduleSource, /:Set[A-Z]\w*\(|:Apply\w*\(|:Play\w*\(|:Queue\w*\(|:Send\w*\(|CreateEntity|DeleteEntity|io\.open|os\.remove/);
  assert.doesNotMatch(moduleSource, /Character\.Silverhand|GetLookAtObject|GetTargetParts/, 'no lookup of the game\'s Johnny');
});
