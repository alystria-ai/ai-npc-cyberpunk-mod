import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import fengari from 'fengari';

// Johnny's glitching hologram (docs/JOHNNY_IN_YOUR_HEAD.md, phase 3): the policy, the service and the game-facing layer of
// mod/johnny-hologram.lua in fengari with fake natives, the developer probe, the loader and hooks in init.lua and mod/seated-look.lua,
// and the setting. Nothing here can say how the glitch LOOKS; that is the live probe's job (mod/johnny-hologram-probe.lua).
const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;
const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const moduleSource = read('../mod/johnny-hologram.lua');
const probeSource = read('../mod/johnny-hologram-probe.lua');
const lookSource = read('../mod/seated-look.lua');
const headSource = read('../mod/johnny-head.lua');
const observerSource = read('../mod/battle-observer.lua');
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
const withModule = code => run(`local R = (function() ${moduleSource} end)()
${code}`);

// ---------------------------------------------------------------------------------------------------------------------
// The policy.

const policy = `
  local function context(extra)
    local c = {enabled = true, story = 'active', now = 100, wall = 1000, lastShown = nil, lines = {}, talking = false}
    for key, value in pairs(extra or {}) do c[key] = value end
    return c
  end
  local function sampleOf(extra)
    local s = {available = true, combat = false, tier = 1, dialogue = false, choices = false, call = false, vehicle = false, replacer = false}
    for key, value in pairs(extra or {}) do s[key] = value end
    return s
  end
  local function momentOf(extra)
    local m = {event = 'sit', kind = 'couch', at = 90, wall = 990, vehicle = false}
    for key, value in pairs(extra or {}) do m[key] = value end
    return m
  end
  local function why(moment, sample, c) local reason, final = R.decide(moment, sample, c); return reason, final end
`;

test('decide: a settled sit in open play with a quiet game and a free V lets him appear', () => withModule(`${policy}
  assert(why(momentOf(), sampleOf(), context()) == nil)
  assert(why(momentOf({kind = 'chair'}), sampleOf({tier = 3}), context()) == nil, 'V\\'s own chairs and couches are scene sits at tier 3')
  assert(why(momentOf(), sampleOf(), context({lastShown = 100 - R.COOLDOWN})) == nil, 'exactly the cooldown later')
  for _, kind in ipairs({'couch', 'bar', 'stool', 'bench', 'table', 'chair', 'scene'}) do assert(why(momentOf({kind = kind}), sampleOf(), context()) == nil, kind) end
`));

test('decide: what ends a moment for good, and what only makes it wait', () => withModule(`${policy}
  local function check(moment, sample, c, reason, final)
    local got, ended = why(moment, sample, c)
    assert(got == reason and ended == final, tostring(reason) .. ': got ' .. tostring(got) .. ', ' .. tostring(ended))
  end
  check(momentOf(), sampleOf(), context({enabled = false}), 'off', true)
  local function without(key) local c = context(); c[key] = nil; return c end
  check(momentOf(), sampleOf(), without('enabled'), 'off', true)
  check(momentOf(), sampleOf(), context({story = 'before'}), 'story-before', true)
  check(momentOf(), sampleOf(), context({story = 'after'}), 'story-after', true)
  check(momentOf(), sampleOf(), without('story'), 'story-unknown', true)
  check(momentOf({kind = 'bed'}), sampleOf(), context(), 'kind', true)
  check(momentOf({event = 'fall'}), sampleOf(), context(), 'kind', true)
  check(momentOf({at = 'soon'}), sampleOf(), context(), 'kind', true)
  check(nil, sampleOf(), context(), 'kind', true)
  check(momentOf(), sampleOf(), without('now'), 'unreadable', false)
  check(momentOf(), sampleOf(), context({lastShown = 100 - R.COOLDOWN + 1}), 'cooldown', true)
  check(momentOf({at = 100 - R.ARM_SECONDS - 1}), sampleOf(), context(), 'expired', true)
  check(momentOf({vehicle = true}), sampleOf(), context(), 'vehicle', true)
  check(momentOf(), nil, context(), 'unreadable', false)
  check(momentOf(), {available = false}, context(), 'unreadable', false)
  check(momentOf(), sampleOf({replacer = true}), context(), 'replacer', true)
  check(momentOf(), sampleOf({combat = true}), context(), 'combat', true)
  check(momentOf(), sampleOf({dialogue = true}), context(), 'dialogue', true)
  check(momentOf(), sampleOf({choices = true}), context(), 'dialogue', true)
  check(momentOf(), sampleOf({vehicle = true}), context(), 'vehicle', true)
  check(momentOf(), sampleOf({call = true}), context(), 'call', false)
  check(momentOf(), sampleOf({tier = 4}), context(), 'scene', true)
  check(momentOf(), sampleOf({tier = false}), context(), 'unreadable', false)
  check(momentOf(), sampleOf(), context({talking = true}), 'talking', false)
  check(momentOf({at = 100 - R.MOMENTS.sit.settle + 1}), sampleOf(), context(), 'settling', false)
  -- Lines: any game line after the sit means the sit belongs to a scene; the game's Johnny speaking at all recently ends it; any other
  -- line a little before it makes him wait; the crowd's chatter is not a line.
  check(momentOf(), sampleOf(), context({lines = {{at = 995, profileKey = 'judy-alvarez', channel = 'scene'}}}), 'scene-lines', true)
  check(momentOf(), sampleOf(), context({lines = {{at = 945, profileKey = 'johnny-silverhand', channel = 'scene'}}}), 'johnny-line', true)
  check(momentOf(), sampleOf(), context({lines = {{at = 945, profileKey = 'johnny-silverhand', channel = 'ambient'}}}), 'johnny-line', true)
  check(momentOf(), sampleOf(), context({lines = {{at = 975, profileKey = 'judy-alvarez', channel = 'scene'}}}), 'line', false)
  check(momentOf(), sampleOf(), context({lines = {{at = 975, profileKey = 'resident-male', channel = 'ambient'}}}), nil, nil)
  check(momentOf(), sampleOf(), context({lines = {{at = 900, profileKey = 'judy-alvarez', channel = 'scene'}}}), nil, nil)
  -- Order: a fight beats a call, the story beats everything but the switch.
  check(momentOf(), sampleOf({combat = true, call = true}), context(), 'combat', true)
  check(momentOf(), sampleOf({combat = true}), context({story = 'after'}), 'story-after', true)
`));

test('decide: the live sit of 2026-10-19 (scene tier 3, dialogue and choice flags up, V sitting) lets him appear; the same flags in a cutscene do not', () => withModule(`${policy}
  local live = sampleOf({tier = 3, dialogue = true, choices = true, sitting = true})
  assert(why(momentOf({kind = 'scene'}), live, context()) == nil, 'a plain sit on a couch is tier 3 with both flags up')
  for _, flags in ipairs({{dialogue = true}, {choices = true}}) do
    local sample = sampleOf({tier = 3, sitting = true}); for k, v in pairs(flags) do sample[k] = v end
    assert(why(momentOf({kind = 'bench'}), sample, context()) == nil)
  end
  local reason, final = why(momentOf({kind = 'scene'}), sampleOf({tier = 3, dialogue = true, choices = true}), context())
  assert(reason == 'dialogue' and final == true, 'no sitting verdict (a cutscene): as before')
  reason, final = why(momentOf({kind = 'scene'}), sampleOf({tier = 3, dialogue = true, choices = true, sitting = false}), context())
  assert(reason == 'dialogue' and final == true)
  -- What still holds him back while V sits: the tier, a call, a fight, a vehicle, a replacer, the lines, the story.
  assert(why(momentOf({kind = 'scene'}), sampleOf({tier = 4, dialogue = true, sitting = true}), context()) == 'scene')
  assert(why(momentOf({kind = 'scene'}), sampleOf({tier = 3, dialogue = true, sitting = true, combat = true}), context()) == 'combat')
  assert(why(momentOf({kind = 'scene'}), sampleOf({tier = 3, dialogue = true, sitting = true, replacer = true}), context()) == 'replacer')
  assert(why(momentOf({kind = 'scene'}), sampleOf({tier = 3, dialogue = true, sitting = true, vehicle = true}), context()) == 'vehicle')
  assert(why(momentOf({kind = 'scene'}), sampleOf({tier = 3, dialogue = true, sitting = true, call = true}), context()) == 'call')
  assert(why(momentOf({kind = 'scene'}), live, context({story = 'before'})) == 'story-before')
  assert(why(momentOf({kind = 'scene'}), live, context({lines = {{at = 995, profileKey = 'judy-alvarez', channel = 'scene'}}})) == 'scene-lines')
`));

test('interrupt: a plain sit\'s own scene flags do not send him away; a call, tier 4 and a cutscene do', () => withModule(`${policy}
  local live = sampleOf({tier = 3, dialogue = true, choices = true, sitting = true})
  assert(R.interrupt(live) == nil and R.interrupt(sampleOf({tier = 3, dialogue = true, choices = true})) == 'scene')
  assert(R.interrupt(sampleOf({tier = 3, dialogue = true, choices = true, sitting = false})) == 'scene')
  assert(R.interrupt(sampleOf({tier = 3, dialogue = true, sitting = true, call = true})) == 'scene')
  assert(R.interrupt(sampleOf({tier = 4, dialogue = true, sitting = true})) == 'scene' and R.interrupt(sampleOf({tier = 3, sitting = true}), 2) == 'scene')
  assert(R.interrupt(sampleOf({tier = 3, sitting = true, combat = true})) == 'combat')
`));

test('flags: the scene facts for a log line, so the next live check shows why he came, stayed or went', () => withModule(`
  assert(R.flags(nil) == '' and R.flags('x') == '')
  assert(R.flags({dialogue = true, choices = false, tier = 3, call = false, combat = false, sitting = true}) == ' (dialogue=true choices=false tier=3 call=false combat=false sitting=true)')
  assert(R.flags({tier = 1}) == ' (dialogue=nil choices=nil tier=1 call=nil combat=nil sitting=false)')
`));

test('interrupt: what makes a hologram that is there go at once', () => withModule(`${policy}
  assert(R.interrupt(nil) == 'unreadable' and R.interrupt({available = false}) == 'unreadable' and R.interrupt('x') == 'unreadable')
  assert(R.interrupt(sampleOf()) == nil and R.interrupt(sampleOf({tier = 3})) == nil and R.interrupt(sampleOf({tier = 2}), 2) == nil)
  assert(R.interrupt(sampleOf({combat = true})) == 'combat' and R.interrupt(sampleOf({replacer = true})) == 'replacer')
  for _, key in ipairs({'dialogue', 'choices', 'call'}) do assert(R.interrupt(sampleOf({[key] = true})) == 'scene', key) end
  assert(R.interrupt(sampleOf({vehicle = true})) == 'vehicle')
  assert(R.interrupt(sampleOf({tier = 4})) == 'scene' and R.interrupt(sampleOf({tier = 3}), 2) == 'scene' and R.interrupt(sampleOf({tier = false})) == 'scene')
`));

test('lineAges: seconds since the last line anyone but the crowd spoke, since the games Johnny spoke, and whether a line came after a time', () => withModule(`
  local rows = {{at = 900, profileKey = 'johnny-silverhand', channel = 'scene'}, {at = 960, profileKey = 'judy-alvarez', channel = 'scene'},
    {at = 990, profileKey = 'resident-male', channel = 'ambient'}, 'junk', {profileKey = 'x'}}
  local any, johnny, after = R.lineAges(rows, 1000, 950)
  assert(any == 40 and johnny == nil and after == true, 'the crowd is not a line; Johnny\\'s line is older than JOHNNY_QUIET: ' .. tostring(any) .. tostring(johnny))
  rows[1].at = 950
  any, johnny, after = R.lineAges(rows, 1000, 1000)
  assert(any == 40 and johnny == 50 and after == false)
  any, johnny, after = R.lineAges({}, 1000, 0)
  assert(any == nil and johnny == nil and after == false)
  any, johnny, after = R.lineAges(nil, 1000, 0)
  assert(any == nil and johnny == nil and after == false)
  any, johnny, after = R.lineAges(rows, 'now', 0)
  assert(any == nil and johnny == nil and after == false)
  local many = {}
  for index = 1, 100 do many[index] = {at = 999, profileKey = 'x', channel = 'scene'} end
  assert(R.lineAges(many, 1000, 0) == 1, 'only the newest rows are walked')
`));

test('candidates and faceYaw: spots round V in the tables order, a positive angle to Vs left, and he faces V', () => withModule(`
  local function near(a, b) return math.abs(a - b) < 1e-6 end
  local list = R.candidates({x = 10, y = 20, z = 5}, {x = 0, y = 1})
  assert(#list == #R.SPOTS and list[1].angle == 30 and list[1].distance == 2.5)
  assert(near(list[1].x, 10 - 2.5 * math.sin(math.rad(30))) and near(list[1].y, 20 + 2.5 * math.cos(math.rad(30))) and list[1].z == 5, 'left of V when V faces +y')
  assert(near(list[3].x, 10) and near(list[3].y, 22.6), 'straight ahead')
  local east = R.candidates({x = 0, y = 0, z = 0}, {x = 1, y = 0})
  assert(near(east[3].x, 2.6) and near(east[3].y, 0), 'follows V\\'s facing')
  local scaled = R.candidates({x = 0, y = 0, z = 0}, {x = 0, y = 40})
  assert(near(scaled[3].y, 2.6), 'the facing is normalised')
  local blank = R.candidates({x = 0, y = 0, z = 0}, nil)
  assert(near(blank[3].y, 2.6), 'no facing: +y')
  for _, row in ipairs(list) do assert(row.distance >= 2.0 and row.distance <= 3.0, 'two to three metres') end
  -- The game's forward at yaw t is (-sin t, cos t): a body at the spot, turned by faceYaw, looks at V.
  for _, row in ipairs(list) do
    local yaw = math.rad(R.faceYaw({x = row.x, y = row.y}, {x = 10, y = 20}))
    local fx, fy = -math.sin(yaw), math.cos(yaw)
    local dx, dy = 10 - row.x, 20 - row.y
    local length = math.sqrt(dx * dx + dy * dy)
    assert(near(fx, dx / length) and near(fy, dy / length), 'faces V from ' .. row.angle)
  end
`));

// ---------------------------------------------------------------------------------------------------------------------
// The service, with a fake game-facing layer.

const service = `
  local clockNow, wallNow = 100, 5000
  local state = {attached = false, near = false, spotAt = 2, deletes = {}, spawned = nil, flickers = {}, screens = {}, looks = {},
    spotCalls = 0, sweeps = 0, nativeCalls = 0}
  local native = {
    position = function(player) return {x = 0, y = 0, z = 0}, {x = 0, y = 1} end,
    spot = function(origin, candidate)
      state.spotCalls = state.spotCalls + 1
      if state.spotAt == false then return nil, 'no-floor' end
      if state.spotCalls < state.spotAt then return nil, 'hidden' end
      return {x = candidate.x, y = candidate.y, z = 0, yaw = 123}
    end,
    gameJohnnyNear = function(player, radius) state.radius = radius; return state.near end,
    record = function() return 'CyberpunkConvai.JohnnyHologram' end,
    spawn = function(row) state.spawned = row; return 'id-1' end,
    entity = function(id) assert(id == 'id-1'); if state.attached then return {name = 'npc'} end return nil end,
    hash = function(npc) return '777' end,
    look = function(npc, id, look) state.looks[#state.looks + 1] = look; return {phantom = 1, effects = 0, flicker = look.flicker and 8 or 0} end,
    flicker = function(npc, id, schedule) state.flickers[#state.flickers + 1] = #schedule; return #schedule end,
    delete = function(id) state.deletes[#state.deletes + 1] = id; return true end,
    sweep = function() state.sweeps = state.sweeps + 1; return state.swept or 0 end,
    screen = function(on) state.screens[#state.screens + 1] = on; return true end,
  }
  local enabled, story, rows, logged, talking, held = true, 'active', {}, {}, false, false
  local function make(extra)
    local o = {enabled = function() return enabled end, story = function() return story end, lines = function() return rows end,
      clock = function() return clockNow end, now = function() return wallNow end, native = native, hold = function() return held end,
      log = function(line) logged[#logged + 1] = line end}
    for key, value in pairs(extra or {}) do o[key] = value end
    return R.new(o)
  end
  local function sampleOf(extra)
    local s = {available = true, combat = false, tier = 1, dialogue = false, choices = false, call = false, vehicle = false, replacer = false}
    for key, value in pairs(extra or {}) do s[key] = value end
    return s
  end
  local function tick(S, seconds, sample)
    clockNow, wallNow = clockNow + seconds, wallNow + seconds
    if sample == 'none' then sample = nil elseif sample == nil then sample = sampleOf() end
    return S:tick({}, sample, true, talking)
  end
  local function lastLog() return logged[#logged] or '' end
`;
const serviceTest = (name, code) => test(name, () => withModule(`${service}${code}`));

serviceTest('service: a sit becomes one pending moment; spots are searched after the settle, two a tick; he appears once settled, then is shown when attached', `
  local S = make()
  assert(not S:active() and S:tick({}, sampleOf(), true, false) == false, 'nothing pending: nothing to do')
  assert(S:moment('sit', 'couch', {tier = 1}) == true and S:active() and not S:visible())
  assert(S:moment('fall', 'x') == false, 'only a known moment')
  assert(tick(S, 0.5) == true and state.spotCalls == 0 and state.spawned == nil, 'before the search: nothing')
  assert(tick(S, 1.5) == true and state.spotCalls == R.PLACE_PER_TICK - 0 and state.spawned == nil, 'two seconds in: the search starts, two at a time')
  assert(state.spotCalls == 2, 'two candidates this tick, the second found a spot')
  assert(tick(S, 1.0) == true and state.spawned == nil, 'found, but the sit has not settled (4 s)')
  assert(tick(S, 1.0) == true)
  local row = assert(state.spawned, 'settled: he is created')
  assert(row.record == 'CyberpunkConvai.JohnnyHologram' and row.appearance == R.LOOKS[R.DEFAULT_LOOK].appearance)
  assert(row.x ~= nil and row.y ~= nil and row.z == 0 and row.yaw == 123)
  assert(state.radius == R.GAME_JOHNNY_RADIUS, 'the game\\'s own Johnny is looked for right before')
  assert(S:active() and not S:visible() and S:status().visit.state == 'spawning' and S:status().pending == nil)
  assert(tick(S, 0.5) == true and not S:visible(), 'not attached yet')
  state.attached = true
  assert(tick(S, 0.5) == true and S:visible() and S:owns('777') and not S:owns('778') and not S:owns(nil))
  assert(#state.looks == 1 and state.looks[1] == R.LOOKS[R.DEFAULT_LOOK] and #state.screens == 0, 'the look is applied; V\\'s screen is left alone by default')
  assert(lastLog():find('shown look=' .. R.DEFAULT_LOOK, 1, true), lastLog())
`);

// The whole chain of the live failure (2026-10-19, "skipped sit kind=scene reason=dialogue" twice): the real seated-look controller hears the
// sit, the real observer reads a tier 3 scene whose dialogue and choice flags are up, init.lua's probe turns that into sample.sitting.
const sitProbeBlock = between('battleObserver.sitProbe = function(sample)', "local battles = dofile('battle-reactions.lua')");
const chain = `
  local observer = (function() ${observerSource} end)()
  local look = (function() ${lookSource} end)()
  local tier, dialogue, choices, call, combat = 3, true, {1}, nil, false
  local player = {IsAttached = function() return true end, IsDeadNoStatPool = function() return false end, IsInCombat = function() return combat end,
    GetEntityID = function() return 1 end, GetMountedVehicle = function() return nil end, IsReplacer = function() return false end}
  PlayerPuppet = {GetSceneTier = function() return tier end}
  FromVariant = function(v) return v end
  Enum = {new = function(_, v) return v end}
  Game = {GetSceneSystem = function() return {GetScriptInterface = function() return {
      IsEntityInDialogue = function() return dialogue end, IsEntityInScene = function() return true end} end} end,
    GetAllBlackboardDefs = function() return {UI_ComDevice = {PhoneCallInformation = 'call'}, UIInteractions = {DialogChoiceHubs = 'choices'}} end,
    GetBlackboardSystem = function() return {Get = function() return {GetVariant = function(_, field)
      if field == 'call' then return call end
      return {choiceHubs = choices} end} end} end}
  local battleObserver = observer
  convaiSeatedLookModule = look
  ${sitProbeBlock}
  local function sit(S)
    convaiSeatedLook = look.new({seat = function() return {tier = 3, vehicle = 0} end, classify = function() return nil end,
      queue = function() end, delay = function() return 1 end, cancel = function() end, now = function() return wallNow end,
      onSit = function(kind, seat) S:moment('sit', kind, seat) end, onStand = function() S:stand() end})
    return convaiSeatedLook.entered()
  end
  local function sampleNow() return observer.sample(player) end
`;

serviceTest('chain: a plain couch sit (tier 3, dialogue and choice flags up) is recognised as a sit, and he appears; before this fix both sits were skipped as dialogue', `${chain}
  convaiGameDialogue = {lines = rows}
  local S = make()
  assert(sit(S) == true and convaiSeatedLook.sitting == 'scene' and convaiSeatedLook.sitAt == wallNow)
  local live = sampleNow()
  assert(live.tier == 3 and live.dialogue == true and live.choices == true and live.blocked == true, 'both scene flags up, as the worst case of what the log showed (reason=dialogue)')
  assert(live.sitting == true, 'and still a plain sit')
  for _ = 1, 14 do tick(S, 0.5, sampleNow()) end
  assert(state.spawned ~= nil, 'he was created: ' .. lastLog())
  assert(lastLog():find('spawning', 1, true) and lastLog():find('dialogue=true choices=true tier=3', 1, true) and lastLog():find('sitting=true', 1, true), lastLog())
  state.attached = true
  tick(S, 0.5, sampleNow())
  assert(S:visible(), 'the sit flags do not send him away: ' .. lastLog())
  tick(S, 1, sampleNow()); tick(S, 1, sampleNow())
  assert(S:visible(), 'still there two seconds on')
  -- V stands up: he goes at once.
  convaiSeatedLook.left()
  assert(not S:active() and lastLog():find('gone reason=stood', 1, true), lastLog())
`);

serviceTest('chain: the same flags in a cutscene (a line since V sat, a call, tier 4, no sit at all) keep him away', `${chain}
  convaiGameDialogue = {lines = rows}
  local S = make()
  sit(S)
  rows[#rows + 1] = {at = wallNow, channel = 'scene', profileKey = 'judy-alvarez'}
  local scene = sampleNow()
  assert(scene.sitting == nil and scene.dialogue == true, 'a game line since V sat: not a plain sit')
  tick(S, 0.5, scene)
  assert(not S:active() and state.spawned == nil and lastLog():find('skipped sit kind=scene reason=dialogue', 1, true)
    and lastLog():find('sitting=false', 1, true), lastLog())
  rows[#rows] = nil
  local T = make()
  sit(T)
  call = {callPhase = 'StartCall'}
  assert(sampleNow().sitting == nil)
  call = nil; tier = 4
  assert(sampleNow().sitting == nil, 'tier 4')
  tier = 3; combat = true
  assert(sampleNow().sitting == nil, 'a fight')
  combat = false
  convaiSeatedLook.left()
  assert(convaiSeatedLook.sitting == nil and sampleNow().sitting == nil, 'standing: no sit, so the flags count again')
`);

serviceTest('chain: a line that arrives while he is there sends him away at once, and the log says what the flags were', `${chain}
  convaiGameDialogue = {lines = rows}
  local S = make()
  sit(S)
  for _ = 1, 14 do tick(S, 0.5, sampleNow()) end
  state.attached = true
  tick(S, 0.5, sampleNow())
  assert(S:visible())
  rows[#rows + 1] = {at = wallNow, channel = 'scene', profileKey = 'judy-alvarez'}
  tick(S, 0.5, sampleNow())
  assert(not S:active() and lastLog():find('gone reason=scene', 1, true) and lastLog():find('sitting=false', 1, true), lastLog())
`);

test('convaiPlainSitting (the manager shortcut asks it at scene tier 3): yes only while the controller says V sits and the sample agrees; a no is logged, at most every five seconds, with the facts', () => {
  const block = between('function convaiPlainSitting()', "-- V sat down (the seated-look module's onSit)");
  run(`
    local clock, logs, sample = 100, {}, {available = true, tier = 3, dialogue = true, choices = true, call = false, combat = false, sitting = true}
    os.clock = function() return clock end
    convaiLogLine = function(line) logs[#logs + 1] = line end
    Game = {GetPlayer = function() return {} end}
    local battleObserver = {sample = function() return sample end}
    ${block}
    convaiSeatedLook = nil
    assert(convaiPlainSitting() == false and #logs == 1 and logs[1]:find('sitting=nil', 1, true) and logs[1]:find('dialogue=true choices=true tier=3', 1, true), logs[1])
    clock = 102; assert(convaiPlainSitting() == false and #logs == 1, 'within five seconds: not again')
    convaiSeatedLook = {sitting = 'scene'}
    clock = 110; assert(convaiPlainSitting() == true and #logs == 1, 'a plain sit: yes, nothing logged')
    sample.sitting = nil
    assert(convaiPlainSitting() == false and #logs == 2 and logs[2]:find('sitting=scene', 1, true), 'a cutscene while the controller still holds a sit')
    sample.sitting = true; convaiSeatedLook = {sitting = nil}; clock = 120
    assert(convaiPlainSitting() == false and #logs == 3)
    convaiSeatedLook = {sitting = 'couch'}; battleObserver.sample = function() error('unreadable') end; clock = 130
    assert(convaiPlainSitting() == false and #logs == 4 and logs[4]:find('unreadable', 1, true), logs[4])
    Game.GetPlayer = function() return nil end; clock = 140
    assert(convaiPlainSitting() == false)
  `);
});

serviceTest('service: he stays VISIBLE seconds, flickers out for a flicker look, then is deleted by id; the cooldown starts with the attempt', `
  local S = make({look = 'D'})
  S:moment('sit', 'couch', {tier = 1})
  tick(S, 2); tick(S, 3); tick(S, 1)
  state.attached = true
  tick(S, 0.5)
  assert(S:visible())
  assert(tick(S, R.VISIBLE - 1) == true and S:visible() and #state.deletes == 0)
  tick(S, 1.5)
  assert(S:status().visit.state == 'leaving' and #state.flickers == 1 and state.flickers[1] == #R.FLICKER_OUT and #state.deletes == 0)
  tick(S, 0.5)
  assert(not S:active() and #state.deletes == 1 and state.deletes[1] == 'id-1' and lastLog():find('gone reason=done', 1, true), lastLog())
  S:moment('sit', 'couch', {tier = 1})
  tick(S, 3)
  assert(not S:active() and lastLog():find('reason=cooldown', 1, true) and #state.deletes == 1, 'the next sit is within the cooldown: skipped, logged: ' .. lastLog())
  clockNow = clockNow + R.COOLDOWN
  S:moment('sit', 'couch', {tier = 1})
  assert(S:active())
  assert(S:status().cooldownLeft == 0)
`);

serviceTest('service: a look without a flicker is deleted at its time; options.hold keeps him up to HOLD_MAX while a remark of his plays', `
  local S = make({look = 'C'})
  S:moment('sit', 'chair', {tier = 1})
  tick(S, 2); tick(S, 3); tick(S, 1); state.attached = true; tick(S, 0.5)
  held = true
  tick(S, R.VISIBLE + 1)
  assert(S:visible() and #state.deletes == 0, 'held')
  tick(S, R.HOLD_MAX)
  assert(#state.deletes == 1 and not S:active(), 'never longer than HOLD_MAX')
`);

serviceTest('service: Vs screen glitch is on only for SCREEN_SECONDS when the option is set, and off again if he goes early', `
  local S = make({screen = true})
  S:moment('sit', 'couch', {tier = 1})
  tick(S, 2); tick(S, 3); tick(S, 1); state.attached = true; tick(S, 0.5)
  assert(#state.screens == 1 and state.screens[1] == true)
  tick(S, R.SCREEN_SECONDS + 0.1)
  assert(#state.screens == 2 and state.screens[2] == false, 'stopped on the next tick after its time')
  local T = make({screen = true})
  state.attached = false; state.spawned = nil; state.screens = {}; state.spotCalls = 0
  clockNow = clockNow + R.COOLDOWN
  T:moment('sit', 'couch', {tier = 1})
  tick(T, 2); tick(T, 3); tick(T, 1); state.attached = true; tick(T, 0.5)
  assert(state.screens[#state.screens] == true)
  tick(T, 0.1, sampleOf({combat = true}))
  assert(state.screens[#state.screens] == false and #state.deletes >= 1, 'a fight ends him and the screen effect with him')
`);

serviceTest('service: spots that do not exist, a game Johnny nearby or an unreadable query drop the moment with a reason', `
  local S = make()
  state.spotAt = false
  S:moment('sit', 'couch', {tier = 1})
  tick(S, 2); tick(S, 1); tick(S, 1); tick(S, 1); tick(S, 1); tick(S, 1)
  assert(not S:active() and state.spawned == nil and lastLog():find('no-spot', 1, true) and lastLog():find('no-floor', 1, true), lastLog())
  assert(state.spotCalls == #R.SPOTS, 'every candidate tried, once')
  state.spotAt, state.spotCalls = 1, 0
  state.near = true
  clockNow = clockNow + R.COOLDOWN
  local T = make()
  T:moment('sit', 'couch', {tier = 1})
  tick(T, 2); tick(T, 3); tick(T, 1)
  assert(not T:active() and state.spawned == nil and lastLog():find('reason=game-johnny', 1, true), lastLog())
  state.near = nil
  clockNow = clockNow + R.COOLDOWN
  local U = make()
  U:moment('sit', 'couch', {tier = 1})
  tick(U, 2); tick(U, 3); tick(U, 1)
  assert(not U:active() and state.spawned == nil and lastLog():find('game-johnny-unreadable', 1, true), 'an unanswered query counts as yes: ' .. lastLog())
`);

serviceTest('service: while a moment waits nothing is spawned; talking, a call or a recent line only delay it; a scene, a fight or the switch end it', `
  local S = make()
  S:moment('sit', 'couch', {tier = 1})
  talking = true
  tick(S, 2); tick(S, 3); tick(S, 1)
  assert(S:active() and state.spawned == nil, 'V is talking: he waits')
  talking = false
  tick(S, 0.1, sampleOf({call = true}))
  assert(S:active() and state.spawned == nil, 'a call: he waits')
  rows = {{at = wallNow - 5, profileKey = 'judy-alvarez', channel = 'scene'}}
  rows[1].at = S.pending.wall - 10
  tick(S, 0.1)
  assert(S:active() and state.spawned == nil, 'a line just before: he waits')
  rows = {}
  tick(S, 0.1)
  assert(state.spawned ~= nil, 'free: he comes')
  S:stand()
  local T = make()
  state.spawned = nil; clockNow = clockNow + R.COOLDOWN
  T:moment('sit', 'couch', {tier = 1})
  tick(T, 3, sampleOf({combat = true}))
  assert(not T:active() and state.spawned == nil and lastLog():find('reason=combat', 1, true), 'a fight ends the moment')
  clockNow = clockNow + R.COOLDOWN
  T:moment('sit', 'couch', {tier = 1})
  enabled = false
  tick(T, 3)
  assert(not T:active() and lastLog():find('reason=off', 1, true), 'the switch ends the moment')
  enabled = true
  clockNow = clockNow + R.COOLDOWN
  story = 'after'
  T:moment('sit', 'couch', {tier = 1})
  tick(T, 3)
  assert(not T:active() and lastLog():find('story-after', 1, true), 'after an ending he is not in V\\'s head')
`);

serviceTest('service: a visit ends at once on a fight, a scene, a call, a line, the switch, V standing, and a copy that never attaches is deleted', `
  local function visit(extra)
    clockNow = clockNow + R.COOLDOWN
    state.attached, state.spotCalls, state.spawned = false, 0, nil
    local S = make(extra)
    S:moment('sit', 'couch', {tier = 1})
    tick(S, 2); tick(S, 3); tick(S, 1)
    assert(state.spawned ~= nil)
    return S
  end
  local function shown(S) state.attached = true; tick(S, 0.5); assert(S:visible()) end
  local function ends(S, sample, reason, action)
    local before = #state.deletes
    if action then action() end
    tick(S, 0.5, sample)
    assert(not S:active() and #state.deletes == before + 1 and lastLog():find('gone reason=' .. reason, 1, true), reason .. ': ' .. lastLog())
  end
  local S = visit(); shown(S); ends(S, sampleOf({combat = true}), 'combat')
  S = visit(); shown(S); ends(S, sampleOf({tier = 4}), 'scene')
  S = visit(); shown(S); ends(S, sampleOf({call = true}), 'scene')
  S = visit(); shown(S); ends(S, sampleOf({vehicle = true}), 'vehicle')
  S = visit(); shown(S); ends(S, sampleOf({replacer = true}), 'replacer')
  S = visit(); shown(S); ends(S, 'none', 'unreadable')
  S = visit(); shown(S); ends(S, sampleOf(), 'line', function() rows = {{at = wallNow + 0.5, profileKey = 'judy-alvarez', channel = 'scene'}} end)
  rows = {}
  S = visit(); shown(S); ends(S, sampleOf(), 'off', function() enabled = false end)
  enabled = true
  S = visit(); shown(S); ends(S, sampleOf(), 'stood', function() assert(S:stand() == true) end)
  S = visit(); assert(S:status().visit.state == 'spawning')
  tick(S, R.SPAWN_SECONDS + 0.5)
  assert(not S:active() and lastLog():find('gone reason=not-attached', 1, true), 'never attached: deleted')
  S = visit(); shown(S)
  local deletes = #state.deletes
  S:abandon('load')
  assert(not S:active() and #state.deletes == deletes and S.sweepDue == true, 'a world change: forgotten, no native call')
`);

serviceTest('service: the first tick of a world is a fresh start; sweep deletes left-over copies once and never while he is there', `
  local S = make()
  state.swept = 2
  assert(S:sweep() == 2 and state.sweeps == 1 and S.sweepDue == false and lastLog():find('swept 2', 1, true))
  state.swept = 0
  assert(S:sweep() == 0 and lastLog():find('swept 2', 1, true), 'nothing to log')
  S:moment('sit', 'couch', {tier = 1}); tick(S, 2); tick(S, 3); tick(S, 1); state.attached = true; tick(S, 0.5)
  assert(S:visible() and S:sweep() == 0 and state.sweeps == 2, 'not while he is there')
  local broken = make({native = setmetatable({sweep = function() error('no entity system') end}, {__index = native})})
  assert(broken:sweep() == 0, 'an error is not a crash')
  local calls = 0
  local fragile = make({native = setmetatable({record = function() error('clone failed') end}, {__index = native})})
  clockNow = clockNow + R.COOLDOWN
  fragile:moment('sit', 'couch', {tier = 1}); tick(fragile, 2); tick(fragile, 3); tick(fragile, 1)
  assert(not fragile:active() and lastLog():find('reason=record', 1, true), 'a failing record is logged, not thrown: ' .. lastLog())
  local spawnless = make({native = setmetatable({spawn = function() error('not ready') end}, {__index = native})})
  clockNow = clockNow + R.COOLDOWN
  spawnless:moment('sit', 'couch', {tier = 1}); tick(spawnless, 2); tick(spawnless, 3); tick(spawnless, 1)
  assert(not spawnless:active() and lastLog():find('reason=spawn', 1, true))
`);

serviceTest('service: a sit while he is there is ignored; V standing up with nothing pending does nothing; status is plain', `
  local S = make()
  assert(S:stand() == false)
  S:moment('sit', 'couch', {tier = 1}); tick(S, 2); tick(S, 3); tick(S, 1); state.attached = true; tick(S, 0.5)
  assert(S:moment('sit', 'chair', {tier = 1}) == false, 'one at a time')
  local status = S:status()
  for key, value in pairs(status) do assert(type(value) ~= 'function' and type(value) ~= 'userdata', key) end
  assert(status.look == R.DEFAULT_LOOK and status.visit.state == 'visible' and status.visit.entity == '777')
  assert(make({look = 'nope'}).look == R.DEFAULT_LOOK, 'an unknown look is the default')
  assert(make({look = 'A'}).look == 'A')
  local vehicle = make()
  clockNow = clockNow + R.COOLDOWN
  vehicle:moment('sit', 'couch', {tier = 1, vehicle = 3}); tick(vehicle, 5)
  assert(not vehicle:active() and lastLog():find('reason=vehicle', 1, true))
`);

// ---------------------------------------------------------------------------------------------------------------------
// The game-facing layer, with a fake entity system. Only our own tagged copy is ever changed or deleted.

const natives = `
  local calls, deleted, created, toggles, effects, visibility, delayed = {}, {}, {}, {}, {}, {}, {}
  local managed, tagged = {}, {}
  CName = {new = function(text) return 'cname:' .. text end}
  Vector4 = {new = function(x, y, z, w) return {x = x, y = y, z = z, w = w} end}
  EulerAngles = {new = function(r, p, y) return {ToQuat = function() return {yaw = y} end} end}
  TweakDBID = {new = function(name) return 'tdbid:' .. name end}
  Enum = {new = function(kind, name) return kind .. ':' .. name end}
  local records = {['Character.Silverhand'] = {IsA = function(_, c) return c == 'gamedataCharacter_Record' end}}
  TweakDB = {
    GetRecord = function(_, name) return records[name] end,
    CloneRecord = function(_, name, source) calls[#calls + 1] = 'clone ' .. name .. ' ' .. source
      if not records[source] then return false end
      records[name] = records[source]; return true end,
  }
  local nextId = 0
  local system = {
    IsReady = function() return true end,
    IsManaged = function(_, id) return managed[id] == true end,
    IsTagged = function(_, id, tag) return tagged[id] == tag end,
    IsSpawned = function(_, id) return managed[id] == true end,
    CreateEntity = function(_, spec) nextId = nextId + 1
      local id = {hash = 1000 + nextId}; managed[id] = true; tagged[id] = spec.tags[1]; created[#created + 1] = spec; return id end,
    DeleteEntity = function(_, id) deleted[#deleted + 1] = id; managed[id] = nil; return true end,
    GetTaggedIDs = function(_, tag) local ids = {}
      for id, t in pairs(tagged) do if t == tag and managed[id] then ids[#ids + 1] = id end end
      return ids end,
  }
  local stranger = {hash = 7}; managed[stranger] = true; tagged[stranger] = 'cname:SomeoneElse'
  local own = {hash = 8}; managed[own] = true; tagged[own] = 'cname:CyberpunkConvaiJohnnyHologram'
  local gameJohnny = {hash = 9}
  NewObject = function(kind)
    if kind == 'DynamicEntitySpec' then return {} end
    if kind == 'enteventsSetVisibility' then return {} end
    error('unexpected ' .. kind)
  end
  local npcs = {}
  Game = {
    GetDynamicEntitySystem = function() return system end,
    FindEntityByID = function(id) return npcs[id] end,
    GetDelaySystem = function() return {DelayEvent = function(_, npc, event, delay) delayed[#delayed + 1] = {event = event, delay = delay} end} end,
  }
  GameObjectEffectHelper = {StartEffectEvent = function(npc, name) effects[#effects + 1] = name end, StopEffectEvent = function() end}
  local N
`;
const nativeTest = (name, code) => test(name, () => withModule(`${natives}
  N = R.native
${code}`));

nativeTest('spawn: only our own record, our tag only, never saved, with a position and a facing; anything else is refused', `
  local id = N.spawn({record = R.RECORD, appearance = 'silverhand_default', x = 1, y = 2, z = 3, yaw = 90})
  assert(managed[id] and #created == 1)
  local spec = created[1]
  assert(spec.recordID == 'tdbid:' .. R.RECORD and spec.appearanceName == 'cname:silverhand_default')
  assert(spec.persistState == false and spec.persistSpawn == false, 'never saved')
  assert(#spec.tags == 1 and spec.tags[1] == 'cname:' .. R.TAG and R.TAG == 'CyberpunkConvaiJohnnyHologram', 'our tag and no other (no companion tag)')
  assert(spec.position.x == 1 and spec.position.y == 2 and spec.position.z == 3 and spec.orientation.yaw == 90)
  for _, bad in ipairs({'Character.Silverhand', 'Character.johnny_mirror', 'CyberpunkConvai.JohnnyCompanion', '', 'x'}) do
    assert(not pcall(N.spawn, {record = bad, appearance = 'a', x = 0, y = 0, z = 0, yaw = 0}), bad)
  end
  assert(#created == 1, 'refused: nothing created')
  assert(not R.TAG:find('Companion', 1, true) and not R.TAG:find('Holocall', 1, true))
`);

nativeTest('record: his record is cloned once; a source that is not a character record or a failed clone raises before anything can spawn', `
  assert(N.record() == R.RECORD and calls[1] == 'clone ' .. R.RECORD .. ' Character.Silverhand')
  assert(N.record() == R.RECORD and #calls == 1, 'once')
  assert(R.SOURCE == 'Character.Silverhand' and R.RECORD ~= R.SOURCE, 'a copy of his record, never his record')
`);

nativeTest('record: a failed clone or a wrong kind of record is an error', `
  records['Character.Silverhand'] = nil
  assert(not pcall(N.record), 'no source record: the clone fails')
  records['Character.Silverhand'] = {IsA = function() return false end}
  assert(not pcall(N.record), 'a record that is not a character record')
`);

nativeTest('delete and sweep: only an entity the entity system manages AND that carries our tag; the games own Johnny and other mods spawns are left alone', `
  assert(N.delete(stranger) == false and N.delete(gameJohnny) == false and N.delete(nil) == false and #deleted == 0)
  assert(N.delete(own) == true and #deleted == 1 and deleted[1] == own)
  managed[own], tagged[own] = true, 'cname:CyberpunkConvaiJohnnyHologram'
  local extra = {hash = 10}; managed[extra] = true; tagged[extra] = 'cname:CyberpunkConvaiJohnnyHologram'
  deleted = {}
  assert(N.sweep() == 2, 'both of ours')
  assert(#deleted == 2 and not managed[stranger] == false, 'the stranger is untouched')
  for _, id in ipairs(deleted) do assert(id == own or id == extra) end
  assert(N.sweep() == 0)
`);

nativeTest('entity: the copy once it is attached; a copy that is not ours is never returned', `
  local id = N.spawn({record = R.RECORD, appearance = 'a', x = 0, y = 0, z = 0, yaw = 0})
  assert(N.entity(id) == nil, 'not in the world yet')
  npcs[id] = {IsAttached = function() return false end, GetEntityID = function() return id end}
  assert(N.entity(id) == nil, 'not attached')
  npcs[id].IsAttached = function() return true end
  assert(N.entity(id) == npcs[id] and N.hash(npcs[id]) == tostring(id.hash))
  npcs[stranger] = {IsAttached = function() return true end}
  assert(N.entity(stranger) == nil, 'someone else\\'s spawn is not ours')
`);

nativeTest('look: the phantom controller is switched off and the entity shown for a phantom-off look, the effects are started on him, the flicker is queued through the delay system', `
  local id = N.spawn({record = R.RECORD, appearance = 'a', x = 0, y = 0, z = 0, yaw = 0})
  local queued = {}
  local phantom = {IsA = function(_, c) return c == 'gamePhantomEntityComponent' end, Toggle = function(_, on) toggles[#toggles + 1] = on end}
  local other = {IsA = function() return false end, Toggle = function() error('never touched') end}
  local npc = {GetComponents = function() return {phantom, other} end, QueueEvent = function(_, e) queued[#queued + 1] = e end}
  local report = N.look(npc, id, R.LOOKS.B)
  assert(report.phantom == 1 and #toggles == 1 and toggles[1] == false, 'the phantom controller is switched off')
  assert(report.effects == 2 and effects[1] == 'cname:glitch' and effects[2] == 'cname:johnny_intro', 'the two effect events')
  assert(#queued == 1 and queued[1].visible == true and queued[1].source == 'entVisibilityParamSource:PhantomEntitySystem', 'shown at once')
  toggles, queued, delayed = {}, {}, {}
  report = N.look(npc, id, R.LOOKS.D)
  assert(report.phantom == 1 and report.flicker == #R.FLICKER_IN, 'the flicker is queued')
  assert(#queued == 1 and queued[1].visible == R.FLICKER_IN[1][2] and R.FLICKER_IN[1][1] == 0, 'the first step (at 0 s) goes at once')
  assert(#delayed == #R.FLICKER_IN - 1, 'the rest through the delay system')
  for index = 2, #R.FLICKER_IN do
    local row = R.FLICKER_IN[index]
    assert(delayed[index - 1].event.visible == row[2] and delayed[index - 1].delay == row[1], 'step ' .. index)
  end
  toggles, delayed = {}, {}
  report = N.look(npc, id, R.LOOKS.A)
  assert(report.phantom == 0 and #toggles == 0 and report.effects == 0 and report.flicker == 0, 'phantom on: the entity is left as spawned')
  assert(not pcall(N.look, npc, stranger, R.LOOKS.B), 'a look is only ever given to our own copy')
  assert(N.flicker(npc, stranger, R.FLICKER_OUT) == 0 and #delayed == 0, 'nor a flicker')
`);

nativeTest('screen: Vs glitch effect starts and stops on V only', `
  local started, stopped = {}, {}
  GameObjectEffectHelper = {StartEffectEvent = function(target, name) started[#started + 1] = {target, name} end,
    StopEffectEvent = function(target, name) stopped[#stopped + 1] = {target, name} end}
  local player = {}
  Game.GetPlayer = function() return player end
  assert(N.screen(true) == true and started[1][1] == player and started[1][2] == 'cname:transition_glitch_loop')
  assert(N.screen(false) == true and stopped[1][1] == player and stopped[1][2] == 'cname:transition_glitch_loop')
`);

nativeTest('spot: a floor level with V, headroom and sight, from three traces of two collision groups; an answer the game does not give is not a spot', `
  local hits = {}
  local function ray(from, to, group)
    for _, rule in ipairs(hits) do
      local result = rule(from, to, group)
      if result ~= nil then return result end
    end
    return nil
  end
  Game.GetSpatialQueriesSystem = function() return {SyncRaycastByCollisionGroup = function(_, from, to, group)
    local result = ray(from, to, group)
    if result == nil then return false, nil end
    if result == 'nope' then return nil end
    return true, {position = result}
  end} end
  local origin, candidate = {x = 0, y = 0, z = 10}, {x = 2, y = 0, z = 10}
  -- open floor one metre below the start of the first ray, nothing else
  hits = {function(from, to) if from.z > to.z and from.z == 11 then return {x = 2, y = 0, z = 10} end end}
  local spot = N.spot(origin, candidate)
  assert(spot and spot.x == 2 and spot.y == 0 and spot.z == 10 and math.abs(spot.yaw - R.faceYaw({x = 2, y = 0}, origin)) < 1e-9)
  hits = {}
  local none, why = N.spot(origin, candidate)
  assert(none == nil and why == 'no-floor')
  hits = {function() return 'nope' end}
  none, why = N.spot(origin, candidate)
  assert(none == nil and why == 'no-answer', 'the game could not answer')
  hits = {function(from, to) if from.z == 11 then return {x = 2, y = 0, z = 9.2} end end}
  none, why = N.spot(origin, candidate)
  assert(none == nil and why == 'not-level')
  hits = {function(from, to) if from.z == 11 then return {x = 2, y = 0, z = 10.95} end end}
  none, why = N.spot(origin, candidate)
  assert(none == nil and why == 'inside', 'a hit where the ray starts is the inside of something')
  hits = {function(from, to) if from.z == 11 then return {x = 2, y = 0, z = 10} end
    if from.z == 10.3 then return {x = 2, y = 0, z = 11.5} end end}
  none, why = N.spot(origin, candidate)
  assert(none == nil and why == 'no-headroom')
  hits = {function(from, to) if from.z == 11 then return {x = 2, y = 0, z = 10} end
    if from.z == 11.15 then return {x = 1, y = 0, z = 11.15} end end}
  none, why = N.spot(origin, candidate)
  assert(none == nil and why == 'hidden', 'V\\'s eyes cannot see his chest')
`);

nativeTest('gameJohnnyNear: one targeting query; true only for one of the games own Johnny records', `
  local query
  TargetSearchQuery = {new = function() query = {}; return query end}
  Game['TSF_NPC;'] = function() return 'npc-filter' end
  local sets, parts = {}, {}
  Game.GetTargetingSystem = function() return {GetTargetParts = function(_, player, q) assert(q == query); sets[#sets + 1] = q; return true, parts end} end
  TS_TargetPartInfo = {GetComponent = function(part) return part end}
  local function npc(record, isNpc) return {GetEntity = function() return {IsNPC = function() return isNpc end, GetRecordID = function() return record end} end} end
  assert(N.gameJohnnyNear({}, 30) == false and #sets == 1 and query.maxDistance == 30 and query.searchFilter == 'npc-filter' and query.ignoreInstigator == true)
  parts = {npc('tdbid:Character.judy', true), npc('tdbid:Character.Silverhand', false)}
  assert(N.gameJohnnyNear({}, 30) == false, 'a Johnny record on something that is not an NPC does not count; neither does Judy')
  for _, name in ipairs({'Character.Silverhand', 'Character.johnny_mirror', 'Character.q115_suicide_johnny'}) do
    parts = {npc('tdbid:Character.judy', true), npc('tdbid:' .. name, true)}
    assert(N.gameJohnnyNear({}, 30) == true, name)
  end
  parts = {npc('tdbid:' .. R.RECORD, true)}
  assert(N.gameJohnnyNear({}, 30) == false, 'our own copy is not the game\\'s Johnny')
`);

// ---------------------------------------------------------------------------------------------------------------------
// Static rules.

test('static: nothing at load, no frame hook, no deletion or change outside the owned check, only our record is ever spawned', () => {
  assert.doesNotMatch(moduleSource, /registerForEvent|onUpdate|Override\(|ObserveAfter|ObserveBefore|Observe\(/, 'no hook of any kind');
  const top = moduleSource.slice(0, moduleSource.indexOf('local atan2'));
  assert.doesNotMatch(top.replace(/^--.*$/gm, ''), /Game\.|TweakDB|CreateEntity|DeleteEntity/);
  // Every call that changes or deletes an entity sits behind the owned check.
  for (const call of ['DeleteEntity(', 'Toggle(']) {
    for (const match of moduleSource.matchAll(new RegExp(call.replace('(', '\\('), 'g'))) {
      const function_ = moduleSource.slice(moduleSource.lastIndexOf('\nfunction N.', match.index), match.index);
      assert.match(function_, /owned\(/, `${call} in ${function_.split('\n')[1]}`);
    }
  }
  assert.match(moduleSource, /if row\.record ~= M\.RECORD then error\('not our record'\) end/);
  assert.doesNotMatch(moduleSource, /spec\.tags = \{[^}]*Companion|CyberpunkConvaiCompanion|CyberpunkConvaiHolocall/);
  // The game's own Johnny's records are only ever read (the clone source and the near check).
  const lines = moduleSource.split('\n').filter(line => /Character\.(Silverhand|johnny_mirror|q115_suicide_johnny)/.test(line) && !/^\s*--/.test(line));
  assert.ok(lines.every(line => /SOURCE =|GAME_JOHNNY =/.test(line)), lines.join('\n'));
  // The service touches the world only through the native layer, always inside pcall.
  const service = moduleSource.slice(moduleSource.indexOf('function M.new('));
  assert.doesNotMatch(service.replace(/^\s*--.*$/gm, ''), /\bGame\.|TweakDB|NewObject|Vector4/);
  assert.match(service, /local ok, a, b = pcall\(native\[name\], \.\.\.\)/);
});

test('static: the default look is one of the looks, every look names an appearance, the timing constants are sane', () => withModule(`
  assert(R.LOOKS[R.DEFAULT_LOOK], 'the default is a look')
  for key, look in pairs(R.LOOKS) do
    assert(key:match('^%u$') and type(look.appearance) == 'string' and (look.phantom == 'on' or look.phantom == 'off'), key)
    for _, name in ipairs(look.effects or {}) do assert(name:match('^[%w_]+$')) end
  end
  assert(R.COOLDOWN >= 600, 'at most once every ten minutes')
  assert(R.VISIBLE >= 3 and R.VISIBLE <= 8 and R.HOLD_MAX >= R.VISIBLE and R.HOLD_MAX <= 15)
  assert(R.SPAWN_SECONDS >= 2 and R.PLACE_PER_TICK <= 3, 'a few traces per tick')
  for _, schedule in ipairs({R.FLICKER_IN, R.FLICKER_OUT}) do
    local last = -1
    for _, step in ipairs(schedule) do assert(step[1] >= last and type(step[2]) == 'boolean'); last = step[1] end
  end
  assert(R.FLICKER_IN[#R.FLICKER_IN][2] == true, 'he stays visible after flickering in')
  assert(R.FLICKER_OUT[#R.FLICKER_OUT][2] == false, 'and hidden after flickering out')
  for _, row in ipairs(R.SPOTS) do assert(row[2] >= 2.0 and row[2] <= 3.0) end
  assert(#R.GAME_JOHNNY == 3)
`));

// ---------------------------------------------------------------------------------------------------------------------
// The hooks: seated look, loader, tick, talk target, world change.

test('seated look: a sit calls onSit with its kind and seat, standing calls onStand once, a skipped sit calls neither; both optional', () => run(`
  local L = (function() ${lookSource} end)()
  local sat, stood, log = {}, 0, {}
  local seat = {path = 'base\\\\workspots\\\\sit_couch_01', anim = 'sit', tier = 1, vehicle = 0}
  local function native(extra)
    local n = {seat = function() return seat end, queue = function() end, delay = function() return 1 end, cancel = function() end,
      classify = function(path, anim) if path:find('couch') then return 'couch' end return nil end}
    for key, value in pairs(extra or {}) do n[key] = value end
    return n
  end
  local controller = L.new(native({onSit = function(kind, s) sat[#sat + 1] = {kind, s} end, onStand = function() stood = stood + 1 end}))
  assert(controller.entered() ~= nil and #sat == 1 and sat[1][1] == 'couch' and sat[1][2] == seat)
  controller.left()
  assert(stood == 1)
  controller.left()
  assert(stood == 1, 'standing when not sitting is nothing')
  seat = {path = 'base\\\\workspots\\\\sit_bed', anim = 'sit', tier = 1, vehicle = 0}
  controller.entered(); controller.left()
  assert(#sat == 1 and stood == 1, 'not a seat: not a sit')
  seat = {path = 'base\\\\workspots\\\\sit_couch_01', anim = 'sit', tier = 1, vehicle = 5}
  controller.entered()
  assert(#sat == 1, 'in a vehicle: not a sit')
  seat = {path = 'base\\\\workspots\\\\sit_couch_01', anim = 'sit', tier = 1, vehicle = 0}
  local failing = L.new(native({onSit = function() error('boom') end, onStand = function() error('boom') end}))
  assert(failing.entered() ~= nil, 'a failing hologram never stops the free look')
  failing.left()
  local plain = L.new(native())
  plain.entered(); plain.left()
  controller.entered(); controller.forget()
  assert(stood == 1, 'a world change forgets without calling anyone')
`));

test('seated look: the install hands the two callbacks to the controller, init.lua passes them on', () => {
  assert.match(lookSource, /native = \{classify = options\.classify, log = options\.log, onSit = options\.onSit, onStand = options\.onStand, now = options\.now\}/);
  assert.match(init, /onSit = function\(kind, seat\) convaiJohnnyHologramMoment\(kind, seat\) end,\s+onStand = function\(\) convaiJohnnyHologramStand\(\) end,/);
});

test('loader: nothing is loaded with either setting off; a sit with both on creates the service once and sweeps once; stand and tick reach it', () => {
  const block = between('function convaiJohnnyHologramService()', '-- Places (Johnny speaks up, step 2)');
  const tick = between('function convaiJohnnyHologramTick(', '-- Johnny speaks up (docs/JOHNNY_IN_YOUR_HEAD.md, phase 2), on the 0.1 s game tick');
  run(`
    local inHead, hologram, loads, sweeps, moments, stands, ticks, printed = false, false, 0, 0, {}, 0, {}, {}
    manager = {johnnyInHead = function() return inHead end, johnnyHologram = function() return hologram end,
      johnnyRemarks = function() return 'off' end}
    local fake = {}
    function fake.moment(self, event, kind, seat) moments[#moments + 1] = {event, kind, seat}; return true end
    function fake.stand(self) stands = stands + 1 end
    function fake.sweep(self) sweeps = sweeps + 1; return 0 end
    function fake.tick(self, player, sample, worldReady, isTalking) ticks[#ticks + 1] = {player, sample, worldReady, isTalking}; return true end
    local options
    function dofile(path) assert(path == 'johnny-hologram.lua'); loads = loads + 1; return {new = function(o) options = o; return fake end} end
    print = function(line) printed[#printed + 1] = line end
    local head = {story = function() return 'active' end}
    function convaiJohnnyHeadService() return head end
    convaiGameDialogue = {lines = {{at = 1}}}
    convaiLogLine = function() end
    local active, groupChat, microphone, phoneChat, automatic, speech = nil, {}, {}, {}, nil, {}
    ${block}
    ${tick}
    convaiJohnnyHologramMoment('couch', {tier = 1}); convaiJohnnyHologramStand()
    assert(loads == 0 and #moments == 0 and stands == 0 and convaiJohnnyHologram == nil, 'off: nothing loaded, nothing called')
    hologram = true
    convaiJohnnyHologramMoment('couch', {tier = 1})
    assert(loads == 0, 'Johnny in your head is off too')
    inHead = true
    convaiJohnnyHologramMoment('couch', {tier = 1})
    assert(loads == 1 and sweeps == 1 and convaiJohnnyHologram == fake and #moments == 1 and moments[1][1] == 'sit' and moments[1][2] == 'couch')
    convaiJohnnyHologramMoment('chair', {tier = 1})
    assert(loads == 1 and sweeps == 1 and #moments == 2, 'created and swept once')
    assert(options.enabled() == true and options.story() == 'active' and options.lines()[1].at == 1)
    hologram = false
    assert(options.enabled() == false, 'the switch is read each time')
    hologram = true
    convaiJohnnyHologramStand(); assert(stands == 1)
    -- the tick glue: talking is any of the ways V is in a conversation or a reply plays
    convaiJohnnyHologramTick('player', 'sample', true)
    assert(#ticks == 1 and ticks[1][1] == 'player' and ticks[1][2] == 'sample' and ticks[1][3] == true and ticks[1][4] == false)
    active = {}
    convaiJohnnyHologramTick('player', 'sample', true); assert(ticks[2][4] == true, 'a conversation')
    active = nil; microphone.context = {}
    convaiJohnnyHologramTick('player', 'sample', true); assert(ticks[3][4] == true, 'recording')
    microphone.context = nil; speech.requestId = 'r'
    convaiJohnnyHologramTick('player', 'sample', true); assert(ticks[4][4] == true, 'a reply')
    speech.requestId = nil; automatic = {}
    convaiJohnnyHologramTick('player', 'sample', true); assert(ticks[5][4] == true, 'a reaction')
    automatic = nil; phoneChat.pending = {}
    convaiJohnnyHologramTick('player', 'sample', true); assert(ticks[6][4] == true, 'a phone chat')
    phoneChat.pending = nil; groupChat.round = {}
    convaiJohnnyHologramTick('player', 'sample', true); assert(ticks[7][4] == true, 'a group round')
    convaiJohnnyHologram = nil
    convaiJohnnyHologramTick('player', 'sample', true); assert(#ticks == 7, 'no service: nothing')
    -- a service that fails to load logs once and stays absent
    convaiJohnnyHologram = nil
    function dofile() error('no file') end
    convaiJohnnyHologramMoment('couch', {})
    assert(convaiJohnnyHologram == false and #printed == 1 and printed[1]:find('johnny-hologram.lua unavailable', 1, true))
    convaiJohnnyHologramMoment('couch', {})
    assert(#printed == 1, 'once')
  `);
});

test('wiring: the tick is on the 0.5 s battle sample behind active(); a sit costs nothing while off; a load abandons; the talk target passes over our copy; onUpdate has none of it', () => {
  const battles = between('local function updateBattles(player, elapsed, worldReady)', 'local now = os.time()');
  assert.match(battles, /if not battleSample or battlePoll >= 0\.5 then[\s\S]*if convaiJohnnyHologram and convaiJohnnyHologram:active\(\) then\s+convaiJohnnyGuarded\('hologram', convaiJohnnyHologramTick, player, battleSample, worldReady\)\s+end/);
  assert.match(init, /convaiJohnnyFight = nil\s+if convaiJohnnyHologram then convaiJohnnyHologram:abandon\(reason\) end/);
  assert.match(init, /if owned and not managedKey then return nil, name, body end\s+-- [^\n]*\s+if convaiJohnnyHologram and convaiJohnnyHologram\.visit and convaiJohnnyHologram:owns\(tostring\(npc:GetEntityID\(\)\.hash\)\) then return nil, name, body end/);
  const update = init.slice(init.indexOf("registerForEvent('onUpdate'"), init.indexOf("registerForEvent('onShutdown'"));
  assert.doesNotMatch(update, /convaiJohnnyHologram|johnny-hologram/);
  // The module is read from disk only inside the service function.
  assert.equal([...init.matchAll(/dofile\('johnny-hologram\.lua'\)|pcall\(dofile, 'johnny-hologram\.lua'\)/g)].length, 1);
});

test('head service: story() tells whether he is in Vs head (the hologram asks it)', () => run(`
  local H = (function() ${headSource} end)()
  local facts = {q101_done = 1}
  for _, name in ipairs(H.ENDINGS) do facts[name] = 0 end
  local S = H.new({readFact = function(name) return facts[name] end, clock = function() return 0 end})
  assert(S:story() == 'active')
  facts.q201_done = 1
  S:reset()
  assert(S:story() == 'after')
  facts.q201_done, facts.q101_done = 0, 0
  S:reset()
  assert(S:story() == 'before')
  facts.q101_done = nil
  S:reset()
  assert(S:story() == 'unreadable')
`));

// ---------------------------------------------------------------------------------------------------------------------
// The developer probe.

const probeFixture = `
  local now, cpu = 1000, 50
  os.time = function() return now end
  os.clock = function() return cpu end
  local moduleCopy = (function() ${moduleSource} end)()
  local fake = {deleted = {}, spawned = {}, looks = {}, sweepCount = 3, screens = {}, attached = false, spots = {}}
  local native = {
    position = function() return {x = 0, y = 0, z = 0}, {x = 0, y = 1} end,
    spot = function(origin, candidate) fake.spots[#fake.spots + 1] = candidate.angle
      if fake.noSpot then return nil, 'no-floor' end
      return {x = candidate.x, y = candidate.y, z = 0, yaw = 10} end,
    record = function() return moduleCopy.RECORD end,
    spawn = function(row) fake.spawned[#fake.spawned + 1] = row; return 'id-9' end,
    entity = function(id) if fake.attached then return fake.npc end return nil end,
    look = function(npc, id, look) fake.looks[#fake.looks + 1] = look; return {phantom = 1, effects = 2, flicker = look.flicker and 8 or 0} end,
    delete = function(id) fake.deleted[#fake.deleted + 1] = id; return true end,
    sweep = function() return fake.sweepCount end,
    screen = function(on) fake.screens[#fake.screens + 1] = on end,
  }
  moduleCopy.native = native
  function dofile(path) assert(path == 'johnny-hologram.lua', path); return moduleCopy end
  Game = {NameToString = function(value) return value end, GetPlayer = function() return fake.player end}
  fake.player = {GetWorldPosition = function() return {x = 0, y = 0, z = 0} end}
  fake.npc = {
    GetCurrentAppearanceName = function() return 'silverhand_default' end, IsAttached = function() return true end,
    IsVisible = function() return fake.visible ~= false end, IsDeadNoStatPool = function() return false end,
    GetWorldPosition = function() return {x = 0, y = 2.5, z = 0} end,
    GetComponents = function() return {
      {GetClassName = function() return 'entMeshComponent' end, IsA = function() return false end, name = 'body'},
      {GetClassName = function() return 'gamePhantomEntityComponent' end, IsA = function(_, c) return c == 'gamePhantomEntityComponent' end, name = 'phantom'}} end}
  manager = {johnnyInHead = function() return true end, johnnyHologram = function() return true end}
  local P = (function() ${probeSource} end)()
  local env = {player = fake.player}
  local function plain(v, depth)
    depth = depth or 0; assert(depth < 14, 'too deep')
    if type(v) == 'table' then for k, x in pairs(v) do assert(type(k) == 'string' or type(k) == 'number'); plain(x, depth + 1) end
    else assert(v == nil or type(v) == 'string' or type(v) == 'boolean' or type(v) == 'number', 'not plain: ' .. type(v)) end
  end
`;

test('probe: spawn:<look> searches a spot round V, creates one copy with that look, applies it when attached, reports what the game made of it, and deletes it at its time', () => run(`${probeFixture}
  local report = P.run('spawn:E', env)
  plain(report)
  assert(report.visit.state == 'spawning' and report.visit.look == 'E' and #fake.spawned == 1 and #fake.spots == 1)
  assert(fake.spawned[1].record == moduleCopy.RECORD and fake.spawned[1].appearance == moduleCopy.LOOKS.E.appearance)
  assert(report.looks.E.flicker == true and report.defaultLook == moduleCopy.DEFAULT_LOOK and report.settings.johnnyHologram == true)
  assert(P.tick(env) == true and #fake.looks == 0, 'not attached yet')
  fake.attached = true
  cpu = cpu + 0.5
  assert(P.tick(env) == true and #fake.looks == 1 and fake.looks[1] == moduleCopy.LOOKS.E)
  report = P.run('status', env)
  plain(report)
  local seen = report.visit.report
  assert(report.visit.state == 'visible' and seen.appearance == 'silverhand_default' and seen.phantoms == 1 and seen.visible == true and seen.distance == 2.5)
  assert(seen.componentCount == 2 and seen.components[2].phantom == true and report.visit.applied.phantom == 1)
  cpu = cpu + 2
  assert(P.tick(env) == true and report.visit.report ~= nil)
  assert(P.run('status', env).visit.report.later.visible == true, 'a second look a moment later')
  assert(#fake.deleted == 0)
  cpu = cpu + P.SHOW_SECONDS
  assert(P.tick(env) == false and #fake.deleted == 1 and fake.deleted[1] == 'id-9')
  assert(P.run('status', env).visit.state == 'gone' and P.run('status', env).visit.stoppedReason == 'done')
  assert(#P.run('status', env).summary >= 1)
`));

test('probe: a missing spot, an unknown look, an early despawn, a replaced copy, a copy that never attaches, sweep and looks', () => run(`${probeFixture}
  fake.noSpot = true
  local report = P.run('spawn:A', env)
  assert(report.visit.state == 'no-spot' and #fake.spawned == 0 and #report.visit.spotTried == #moduleCopy.SPOTS and report.visit.problem:find('no standing spot', 1, true))
  fake.noSpot = false
  assert(not pcall(P.run, 'spawn:Z', env) and #fake.spawned == 0, 'unknown look')
  assert(not pcall(P.run, 'spawn:', env))
  assert(not pcall(P.run, 'explode', env))
  P.run('spawn:B', env)
  P.run('spawn:C', env)
  assert(#fake.deleted == 1 and #fake.spawned == 2, 'a second copy replaces the first, deleting it')
  assert(P.run('despawn', env).visit.state == 'gone' and #fake.deleted == 2)
  assert(P.run('despawn', env).visit.state == 'gone' and #fake.deleted == 2, 'twice is nothing')
  P.run('spawn:A', env)
  cpu = cpu + P.SPAWN_SECONDS + 1
  assert(P.tick(env) == false and P.run('status', env).visit.problem:find('not in the world', 1, true) and #fake.deleted == 3)
  assert(P.run('sweep', env).swept == 3)
  local looks = P.run('looks', env).looks
  assert(looks.A.phantom == 'on' and looks.B.effects[1] == 'glitch' and looks.D.flicker == true)
  assert(P.tick(env) == false, 'nothing to tick')
`));

test('probe: reports are plain and bounded; without a service the status says why; a module that cannot load is an error', () => run(`${probeFixture}
  fake.attached = true
  local big = {}
  for index = 1, 200 do big[index] = {GetClassName = function() return 'entMeshComponent' end, IsA = function() return false end, name = 'm' .. index} end
  fake.npc.GetComponents = function() return big end
  P.run('spawn:A', env); cpu = cpu + 0.5; P.tick(env)
  local report = P.run('status', env)
  plain(report)
  assert(#report.visit.report.components <= P.MAX_COMPONENTS and report.visit.report.componentCount == 200)
  assert(report.service == 'not created (both settings on, then sit down)')
  convaiJohnnyHologram = {status = function() return {look = 'D'} end}
  assert(P.run('status', env).service.look == 'D')
  convaiJohnnyHologram = false
  assert(P.run('status', env).service == 'failed to load')
  P.module = nil
  function dofile() error('gone') end
  assert(not pcall(P.run, 'spawn:A', env))
`));

test('probe: the dispatcher loads it by name, the sender script knows the feature, and it ships and dev-installs', () => {
  assert.match(read('../mod/johnny-probe.lua'), /hologram = 'johnny-hologram-probe\.lua'/);
  assert.match(read('../scripts/Send-JohnnyProbe.ps1'), /ValidateSet\('place', 'relic', 'hologram', 'feats'\)/);
  for (const plan of ['../packaging/release-plan.json', '../scripts/development-files.json']) {
    const text = read(plan);
    for (const file of ['johnny-hologram.lua', 'johnny-hologram-probe.lua']) assert.ok(text.includes(`"mod/${file}"`), `${plan} lists ${file}`);
  }
  assert.doesNotMatch(probeSource, /registerForEvent|onUpdate|Observe/, 'the probe adds no hook');
});
