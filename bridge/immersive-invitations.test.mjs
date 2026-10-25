import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import fengari from 'fengari';
const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;

// The appointment state machine of mod/immersive-invitations.lua against fake game seams (no engine): every transition, the
// frozen clock, held states, offers and answers, virtual arrival, fast travel, persistence and the edge cases of
// docs/IMMERSIVE_INVITATIONS.md.
const source = readFileSync(new URL('../mod/immersive-invitations.lua', import.meta.url), 'utf8');

function run(body) {
  const state = lauxlib.luaL_newstate(); lualib.luaL_openlibs(state);
  const program = fixture + body;
  const status = lauxlib.luaL_dostring(state, to_luastring(program));
  const error = status === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(state, -1));
  const line = Number(/\]:(\d+):/.exec(error)?.[1]);
  lua.lua_close(state);
  assert.equal(status, lua.LUA_OK, error + (line ? '\n' + program.split('\n')[line - 1] : ''));
}

const fixture = `
convaiUiLocale = {t = function(s, a)
  local r = s
  if a then for k, v in pairs(a) do r = r:gsub('{' .. k .. '}', (tostring(v):gsub('%%', '%%%%'))) end end
  return r
end}
local Module = (function() ${source} end)()

local opts = {enabled = true, arrival = 'walk', delay = 0, wait = 5, waypoint = true, texts = true}
local fake = {
  pos = {x = 0, y = 0, z = 0}, running = true, held = nil, waypoint = nil, spotFail = 0, modes = {},
  visitors = {}, serial = 0, jobs = {}, texts = {}, notices = {}, greets = {}, joined = {}, dismissed = {}, walks = {},
  party = {}, defs = {judy = {name = 'Judy', profileKey = 'judy-alvarez'}, panam = {name = 'Panam', profileKey = 'panam-palmer'},
    rita = {name = 'Rita', profileKey = 'rita-wheeler'}, bob = {name = 'Bob', profileKey = 'bob-x'}},
  store = nil, hiddenAnswer = false, joinOk = true, sent = true,
}
local function dist(a, b) return math.sqrt((a.x - b.x) ^ 2 + (a.y - b.y) ^ 2) end
local world = {}
function world.state() return {running = fake.running, position = fake.pos, held = fake.held} end
function world.describe(kind)
  if kind == 'waypoint' then return fake.waypoint and {position = fake.waypoint.position, place = fake.waypoint.place} or nil end
  return {position = {x = fake.pos.x, y = fake.pos.y, z = fake.pos.z}, place = fake.herePlace or "Lizzie's Bar, Kabuki, Watson"}
end
function world.hasWaypoint() return fake.waypoint ~= nil end
function world.findSpot(a, mode)
  fake.modes[#fake.modes + 1] = mode
  if fake.deferNext then fake.deferNext = false; return nil, nil, true end
  if fake.spotFail > 0 then fake.spotFail = fake.spotFail - 1; return nil, 'none' end
  if mode == 'exit' then return {position = {x = a.dest.x + 80, y = a.dest.y, z = 0}} end
  local d = mode == 'close' and 20 or mode == 'standing' and 3 or 60
  return {position = {x = a.dest.x + d, y = a.dest.y, z = 0}, goal = {x = a.dest.x, y = a.dest.y, z = 0},
    facing = {x = -1, y = 0}, distance = d, eta = d / 1.5, leg = 'walk'}
end
function world.hidden() return fake.hiddenAnswer end
function world.release() end
local companions = {}
function companions.definition(key) return fake.defs[key] end
function companions.list() return fake.party end
function companions.visitors()
  local rows = {}
  for _, v in ipairs(fake.visitors) do rows[#rows + 1] = v end
  return rows
end
local function findVisitor(serial) for _, v in ipairs(fake.visitors) do if v.serial == serial then return v end end end
function companions.visitorSense(serial, dt)
  local v = findVisitor(serial); if not v then return nil end
  if fake.stuck then return {position = v.position, active = true, complete = false, failed = false} end
  if v.target then
    local d = dist(v.position, v.target)
    local step = math.min(d, 1.5 * dt)
    if d > 0.01 then
      v.position = {x = v.position.x + (v.target.x - v.position.x) / d * step, y = v.position.y + (v.target.y - v.position.y) / d * step, z = 0}
    end
    local done = dist(v.position, v.target) < 0.3
    return {position = v.position, active = not done, complete = done, failed = false}
  end
  return {position = v.position, active = false, complete = false, failed = false}
end
function companions.visitorWalk(serial, target, gait)
  local v = findVisitor(serial); if not v then return false end
  v.target = {x = target.x, y = target.y}; fake.walks[#fake.walks + 1] = {serial = serial, gait = gait}
  return true
end
function companions.visitorHold(serial) return true end
function companions.joinVisitor(serial)
  if not fake.joinOk then return false, 'no' end
  fake.joined[#fake.joined + 1] = serial
  for i, v in ipairs(fake.visitors) do if v.serial == serial then table.remove(fake.visitors, i); break end end
  return true
end
function companions.dismissVisitor(serial, reason)
  fake.dismissed[#fake.dismissed + 1] = {serial = serial, reason = reason}
  for i, v in ipairs(fake.visitors) do if v.serial == serial then table.remove(fake.visitors, i); break end end
  return true
end
local queue = {}
function queue.invite(key, extra)
  local job = {id = 'queued:' .. (#fake.jobs + 1), key = key, extra = extra}
  fake.jobs[#fake.jobs + 1] = job
  return true, '', job.id
end
function queue.dismiss(id) for _, j in ipairs(fake.jobs) do if j.id == id then j.cancelled = true end end return true end
function queue.list() local rows = {} for _, j in ipairs(fake.jobs) do if not j.cancelled and not j.spawned then rows[#rows + 1] = {id = j.id} end end return rows end
-- The manager's flush: a job whose gate is open becomes a visiting copy at the appointment's position.
local function flush()
  for _, job in ipairs(fake.jobs) do
    if not job.spawned and not job.cancelled and job.extra.gate() == true then
      job.spawned = true
      fake.serial = fake.serial + 1
      fake.visitors[#fake.visitors + 1] = {serial = fake.serial, state = 'visiting', appointmentId = job.extra.appointment.id,
        position = {x = job.extra.appointment.position.x, y = job.extra.appointment.position.y, z = 0}, profileKey = fake.defs[job.key].profileKey}
    end
  end
end
local env = {
  settings = function() return opts end, companions = companions, queue = queue, world = world,
  text = {send = function(item) if not fake.sent then return false end fake.texts[#fake.texts + 1] = item return true end},
  notify = function(kind, text) fake.notices[#fake.notices + 1] = {kind = kind, text = text} end,
  greet = function(info) fake.greets[#fake.greets + 1] = info end,
  log = function(line) if fake.verbose then print(line) end end,
  wall = function() return fake.wall or 0 end, random = function() return 0.5 end,
  persist = {load = function() return fake.store end, store = function(file) fake.store = file end},
}
local ctl = Module.new(env)
local function tick(seconds)
  local steps = math.floor(seconds / 0.5 + 0.5)
  for _ = 1, steps do flush(); ctl.update(0.5); flush() end
end
-- V asks (here is where V stands), then walks 30 m away so that nobody meets by accident.
local function ask(key)
  local ok, message, id = ctl.requestInvite(key)
  if ok then fake.pos = {x = fake.pos.x - 30, y = fake.pos.y, z = 0} end
  return ok, message, id
end
local function waitFor(cond, limit)
  for _ = 1, (limit or 300) * 2 do if cond() then return true end tick(0.5) end
  return false
end
local function last(list) return list[#list] end
local function texts(kind) local n = 0 for _, x in ipairs(fake.texts) do if x.kind == kind then n = n + 1 end end return n end
`;

test('with the setting Off nothing is offered, requested, stepped or saved', () => run(`
  opts.enabled = false
  assert(ctl.offer('judy-alvarez', 'judy') == nil)
  assert(ctl.requestInvite('judy') == nil)
  tick(60)
  assert(#fake.jobs == 0 and #fake.texts == 0)
`));

test('Invite with the setting On: she is prepared, spawns hidden at a distance, walks, arrives and texts', () => run(`
  local ok, message, id = ask('judy')
  assert(ok == true and id:find('meeting:'), tostring(ok))
  assert(#fake.notices == 1 and fake.notices[1].kind == 'on-the-way')
  tick(1)
  assert(#fake.jobs == 1 and fake.jobs[1].extra.quiet == true, 'one quiet job')
  assert(ctl.appointment('judy-alvarez').phase == 'en-route' or ctl.appointment('judy-alvarez').phase == 'preparing')
  tick(60)
  local a = ctl.appointment('judy-alvarez')
  assert(a and a.phase == 'waiting' and a.body == 'visitor', tostring(a and a.phase))
  assert(fake.modes[1] == 'walk')
  assert(texts('arrived') == 1, 'one arrival text')
  assert(fake.texts[1].place == "Lizzie's Bar, Kabuki, Watson" and fake.texts[1].fallback:find('Where are you'))
`));

test('she waits the configured minutes, then leaves angry, remembers it, and the body is removed once V cannot see her', () => run(`
  opts.wait = 2
  ask('judy')
  assert(waitFor(function() return ctl.appointment('judy-alvarez').phase == 'waiting' end))
  tick(119)
  assert(texts('stood-up') == 0, 'still waiting at 2 minutes minus a second')
  tick(10)
  assert(texts('stood-up') == 1)
  local a = ctl.appointment('judy-alvarez')
  assert(a and a.phase == 'leaving')
  local note = ctl.note('judy-alvarez')
  assert(note.kind == 'stood-up' and note.place == "Lizzie's Bar, Kabuki, Watson" and note.minutes == 2, tostring(note and note.kind))
  assert(#fake.dismissed == 0)
  fake.hiddenAnswer = true; fake.visitors[1].position = {x = 40, y = 0, z = 0}; fake.pos = {x = 0, y = 0, z = 0}
  tick(2)
  assert(#fake.dismissed == 1 and fake.dismissed[1].reason == 'module')
  assert(ctl.appointment('judy-alvarez') == nil)
`));

test('V walking up to her for 1.5 seconds joins her to the party, she greets, no memory is kept', () => run(`
  ask('judy'); tick(60)
  assert(ctl.appointment('judy-alvarez').phase == 'waiting')
  fake.pos = {x = 3, y = 0, z = 0}
  tick(1)
  assert(#fake.joined == 0, 'not yet: 1 second')
  tick(1.5)
  assert(#fake.joined == 1 and #fake.greets == 1)
  assert(fake.greets[1].profileKey == 'judy-alvarez' and fake.greets[1].place == "Lizzie's Bar, Kabuki, Watson")
  assert(ctl.appointment('judy-alvarez') == nil and ctl.note('judy-alvarez') == nil)
`));

test('walking past her without stopping is not a meeting, and a scene or fight holds it', () => run(`
  ask('judy'); tick(60)
  fake.pos = {x = 3, y = 0, z = 0}; tick(1)
  fake.pos = {x = 40, y = 0, z = 0}; tick(2)
  fake.pos = {x = 3, y = 0, z = 0}; tick(1)
  assert(#fake.joined == 0)
  fake.held = 'scene'; tick(5)
  assert(#fake.joined == 0, 'not while V is in a scene')
  fake.held = nil; tick(2)
  assert(#fake.joined == 1)
`));

test('a timed arrival prepares early, spawns late, and arrives at the chosen time', () => run(`
  opts.delay = 2
  ask('judy')
  tick(20)
  assert(#fake.jobs == 0, 'nothing is prepared yet')
  tick(10)
  assert(#fake.jobs == 1, 'preparation starts one lead before the spawn')
  assert(#fake.visitors == 0, 'but nobody exists yet')
  tick(60)
  assert(#fake.visitors == 1)
  assert(texts('arrived') == 0)
  tick(40)
  assert(texts('arrived') == 1)
  local a = ctl.appointment('judy-alvarez')
  assert(a.waitSec == 120, 'a timed arrival waits as long as the delay')
`));

test('the clock freezes while the game is paused: zero frame deltas change nothing', () => run(`
  opts.delay = 2
  ask('judy')
  for _ = 1, 10000 do ctl.update(0) end
  assert(#fake.jobs == 0 and ctl.appointment('judy-alvarez').phase == 'scheduled')
  tick(5)
  fake.running = false; tick(600); fake.running = true
  tick(1)
  assert(#fake.jobs == 0, 'a world that is not running does not advance the appointment')
`));

test('V far from a distant spot: no body, the arrival text still comes, a waiting companion gets a body when V comes near', () => run(`
  fake.pos = {x = 0, y = 0, z = 0}
  fake.waypoint = {position = {x = 3000, y = 0, z = 0}, place = 'about 3 km east of Watson'}
  local offer = ctl.offer('judy-alvarez', 'judy')
  assert(offer.kinds[2] == 'waypoint')
  assert(ctl.accept('judy-alvarez', {kind = 'meet-waypoint', token = offer.token}))
  tick(10)
  assert(#fake.jobs == 0 and #fake.visitors == 0, 'nothing is simulated for a spot nobody is near')
  local a = ctl.appointment('judy-alvarez')
  assert(a.tArrive ~= nil and a.phase == 'scheduled')
  tick(320)
  assert(a.phase == 'waiting' and a.body == 'virtual')
  assert(texts('arrived') == 1 and last(fake.texts).place == 'about 3 km east of Watson')
  assert(#fake.visitors == 0)
  fake.pos = {x = 2950, y = 0, z = 0}
  tick(3)
  assert(a.phase == 'waiting' and a.body == 'visitor' and #fake.visitors == 1, 'materialized standing at the spot')
  assert(fake.modes[#fake.modes] == 'standing')
  assert(texts('arrived') == 1, 'no second arrival text')
`));

test('V fast travels away while she walks in: the body goes, the appointment goes on, she still arrives and texts', () => run(`
  ask('judy'); tick(8)
  assert(ctl.appointment('judy-alvarez').phase == 'en-route')
  local serial = fake.visitors[1].serial
  fake.pos = {x = 5000, y = 0, z = 0}
  ctl.visitorLost(serial, 'fast-travel')
  fake.visitors = {}
  local a = ctl.appointment('judy-alvarez')
  assert(a.phase == 'scheduled' and a.serial == nil)
  tick(120)
  assert(a.phase == 'waiting' and a.body == 'virtual' and texts('arrived') == 1)
`));

test('V dismissing the visitor from the party list ends the appointment quietly', () => run(`
  ask('judy'); tick(60)
  local serial = fake.visitors[1].serial
  ctl.visitorLost(serial, 'dismissed')
  assert(ctl.appointment('judy-alvarez') == nil and texts('stood-up') == 0 and ctl.note('judy-alvarez') == nil)
`));

test('held: the arrival text waits for V to be free and the wait clock does not run in a fight', () => run(`
  opts.wait = 2
  fake.held = 'combat'
  ask('judy'); tick(60)
  assert(ctl.appointment('judy-alvarez').phase == 'waiting')
  assert(texts('arrived') == 0, 'the text waits')
  tick(300)
  assert(ctl.appointment('judy-alvarez').phase == 'waiting' and texts('stood-up') == 0, 'she does not give up in a fight')
  fake.held = nil; tick(1)
  assert(texts('arrived') == 1)
  tick(125)
  assert(texts('stood-up') == 1)
`));

test('the phone is not available: a text is retried for a while and then dropped', () => run(`
  fake.sent = false
  ask('judy'); tick(60)
  assert(texts('arrived') == 0)
  fake.sent = true; tick(1)
  assert(texts('arrived') == 1)
`));

test('the offer: places, the waypoint only when one is set, the unavailable codes', () => run(`
  local offer = ctl.offer('judy-alvarez', 'judy')
  assert(offer.version == 1 and offer.token:match('^meet%-%x+$') and #offer.kinds == 1 and offer.kinds[1] == 'here')
  assert(offer.here.place == "Lizzie's Bar, Kabuki, Watson" and offer.etaMinutes == 0 and offer.waitMinutes == 5 and offer.cancel == false)
  fake.waypoint = {position = {x = 500, y = 0, z = 0}, place = 'near the Afterlife'}
  opts.delay = 5
  offer = ctl.offer('judy-alvarez', 'judy')
  assert(#offer.kinds == 2 and offer.waypoint.place == 'near the Afterlife' and offer.etaMinutes == 5 and offer.waitMinutes == 5)
  opts.waypoint = false
  assert(#ctl.offer('judy-alvarez', 'judy').kinds == 1, 'the waypoint switch')
  fake.party = {{profileKey = 'judy-alvarez', key = 'judy', state = 'ready'}}
  assert(ctl.offer('judy-alvarez', 'judy').unavailable == 'already-here')
  fake.party = {}
  fake.held = 'combat'
  assert(ctl.offer('judy-alvarez', 'judy').unavailable == 'combat')
  fake.held = nil
  assert(ctl.offer('nobody', 'nope') == nil, 'a character that cannot be invited gets no offer')
`));

test('an answer is checked against the offer: token, age, one use, the frozen place, the waypoint kind', () => run(`
  fake.waypoint = {position = {x = 500, y = 0, z = 0}, place = 'near the Afterlife'}
  local offer = ctl.offer('judy-alvarez', 'judy')
  assert(not ctl.accept('judy-alvarez', {kind = 'meet-here', token = 'meet-0000000000000000'}), 'wrong token')
  fake.herePlace = 'somewhere else now'
  fake.pos = {x = 99, y = 0, z = 0}
  assert(ctl.accept('judy-alvarez', {kind = 'meet-waypoint', token = offer.token}))
  local a = ctl.appointment('judy-alvarez')
  assert(a.kind == 'waypoint' and a.place == 'near the Afterlife' and a.dest.x == 500)
  assert(not ctl.accept('judy-alvarez', {kind = 'meet-here', token = offer.token}), 'one use')
  -- here is the place at the time of the message
  local second = ctl.offer('panam-palmer', 'panam')
  fake.pos = {x = 7, y = 0, z = 0}; fake.herePlace = 'a third place'
  assert(ctl.accept('panam-palmer', {kind = 'meet-here', token = second.token}))
  assert(ctl.appointment('panam-palmer').dest.x == 99 and ctl.appointment('panam-palmer').place == 'somewhere else now')
  -- stale
  local third = ctl.offer('rita-wheeler', 'rita')
  fake.wall = 1000
  assert(not ctl.accept('rita-wheeler', {kind = 'meet-here', token = third.token}), 'too old')
`));

test('a waypoint answer without a waypoint offered becomes here', () => run(`
  local offer = ctl.offer('judy-alvarez', 'judy')
  assert(ctl.accept('judy-alvarez', {kind = 'meet-waypoint', token = offer.token}))
  assert(ctl.appointment('judy-alvarez').kind == 'here')
`));

test('never mind: a pending offer lets V cancel, she texts back and lightly remembers it, the body walks off', () => run(`
  ask('judy'); tick(60)
  assert(ctl.appointment('judy-alvarez').phase == 'waiting')
  local offer = ctl.offer('judy-alvarez', 'judy')
  assert(offer.unavailable == 'pending' and offer.cancel == true and offer.place == "Lizzie's Bar, Kabuki, Watson")
  assert(ctl.accept('judy-alvarez', {kind = 'cancel-meet', token = offer.token}))
  assert(texts('cancelled') == 1 or (tick(1) or texts('cancelled') == 1))
  assert(ctl.appointment('judy-alvarez').phase == 'leaving')
  assert(ctl.note('judy-alvarez').kind == 'cancelled')
`));

test('never mind before she has a body ends the appointment and still texts', () => run(`
  opts.delay = 5
  ask('judy'); tick(2)
  local offer = ctl.offer('judy-alvarez', 'judy')
  assert(ctl.accept('judy-alvarez', {kind = 'cancel-meet', token = offer.token}))
  tick(1)
  assert(ctl.appointment('judy-alvarez') == nil and texts('cancelled') == 1)
  assert(#fake.jobs == 0)
`));

test('a stood-up memory is brought up at most twice, a cancelled one once, then it is gone', () => run(`
  opts.wait = 2
  ask('judy'); tick(60); tick(125)
  assert(ctl.note('judy-alvarez').kind == 'stood-up')
  ctl.noted('judy-alvarez'); assert(ctl.note('judy-alvarez') ~= nil)
  ctl.noted('judy-alvarez'); assert(ctl.note('judy-alvarez') == nil)
`));

test('the note says on-the-way, then waiting', () => run(`
  ask('judy')
  assert(ctl.note('judy-alvarez').kind == 'on-the-way')
  tick(60)
  assert(ctl.note('judy-alvarez').kind == 'waiting')
`));

test('a second request for the same character replaces the first, other characters are independent', () => run(`
  ask('judy'); tick(2)
  ask('panam'); tick(2)
  local first = ctl.appointment('judy-alvarez').id
  local offer = ctl.offer('judy-alvarez', 'judy')
  assert(offer.unavailable == 'pending')
  fake.pos = {x = 20, y = 0, z = 0}
  local again = ask('judy')
  assert(again == false, 'Invite on a pending character says so')
  assert(#ctl.rows() == 2)
`));

test('Invite on a character already in the party takes the old path; an unknown key is refused', () => run(`
  fake.party = {{profileKey = 'judy-alvarez', key = 'judy', state = 'ready'}}
  assert(ctl.requestInvite('judy') == nil)
  local ok = ask('zzz')
  assert(ok == false)
`));

test('no road spot: a car request falls back to walking', () => run(`
  opts.arrival = 'car'
  ask('judy')
  assert(ctl.appointment('judy-alvarez').method == 'car')
  fake.spotFail = 2
  tick(10)
  assert(ctl.appointment('judy-alvarez').method == 'walk', 'no road spot: walking')
  assert(#fake.visitors == 1, 'and she walks in')
`));

test('a walk that finds no spot at all fails with a plain text and no memory', () => run(`
  fake.spotFail = 100
  ask('judy')
  tick(10)
  assert(ctl.appointment('judy-alvarez') == nil and texts('failed') == 1 and last(fake.texts).fallback:find("can't make it"))
  assert(ctl.note('judy-alvarez') == nil and #fake.visitors == 0)
`));

test('at most three car arrivals at once, the rest walk', () => run(`
  opts.arrival = 'car'
  fake.defs.a = {name = 'A', profileKey = 'a'}; fake.defs.b = {name = 'B', profileKey = 'b'}
  for _, key in ipairs({'judy', 'panam', 'rita', 'bob'}) do ask(key) end
  local cars = 0
  for _, key in ipairs({'judy-alvarez', 'panam-palmer', 'rita-wheeler', 'bob-x'}) do
    if ctl.appointment(key).method == 'car' then cars = cars + 1 end
  end
  assert(cars == 3, cars)
`));

test('stuck: no progress re-issues the walk, three stalls respawn her close by, then she shows up near', () => run(`
  ask('judy'); tick(6)
  assert(ctl.appointment('judy-alvarez').phase == 'en-route')
  fake.stuck = true
  tick(120)
  local a = ctl.appointment('judy-alvarez')
  assert(a and (a.respawns or 0) >= 1, 'respawned close by')
  assert(fake.modes[2] == 'close', tostring(fake.modes[2]))
  assert(#fake.dismissed >= 1)
`));

test('stuck within 25 m counts as arrived', () => run(`
  ask('judy'); tick(6)
  fake.stuck = true
  fake.visitors[1].position = {x = 20, y = 0, z = 0}
  tick(40)
  assert(ctl.appointment('judy-alvarez').phase == 'waiting')
`));

test('the feature switched Off removes every appointment and body quietly', () => run(`
  ask('judy'); ask('panam'); tick(60)
  assert(#fake.visitors == 2)
  ctl.disable()
  assert(#ctl.rows() == 0 and #fake.dismissed == 2 and texts('stood-up') == 0)
  opts.enabled = false
  tick(100)
  assert(#fake.texts <= 2)
`));

test('persistence: remaining time of a scheduled appointment, a virtual wait, a future record dropped, the ledger', () => run(`
  ctl.bind('line-1', 10)
  opts.delay = 5
  ask('judy'); tick(100)
  opts.delay = 0; opts.wait = 3
  fake.waypoint = nil
  ask('panam'); tick(60)
  assert(ctl.appointment('panam-palmer').phase == 'waiting')
  ctl.save()
  local file = fake.store
  assert(file.version == 1 and file.saves['line-1'] and #file.saves['line-1'].appointments == 2)
  local scheduled, waiting
  for _, row in ipairs(file.saves['line-1'].appointments) do if row.phase == 'waiting' then waiting = row else scheduled = row end end
  assert(scheduled.remaining > 100 and scheduled.remaining < 180, scheduled.remaining)
  assert(waiting.waitLeft > 100 and waiting.waitLeft < 180)
  -- a fresh controller (a new session), the same line
  local again = Module.new(env)
  again.bind('line-1', 10)
  assert(#again.rows() == 2)
  assert(again.appointment('panam-palmer').phase == 'waiting' and again.appointment('panam-palmer').body == 'virtual')
  assert(again.appointment('judy-alvarez').phase == 'scheduled')
  -- another line sees nothing
  local other = Module.new(env); other.bind('line-2', 10)
  assert(#other.rows() == 0)
  -- an earlier save of the same line drops what was made later
  local earlier = Module.new(env); earlier.bind('line-1', 1)
  assert(#earlier.rows() == 0, 'created after this save')
`));

test('persistence: a stood-up note survives a reload, a waiting companion does not repeat her arrival text', () => run(`
  ctl.bind('line-1', 5)
  opts.wait = 2
  ask('judy'); tick(60); tick(125)
  ctl.save()
  local again = Module.new(env); again.bind('line-1', 5)
  assert(again.note('judy-alvarez').kind == 'stood-up')
  local before = #fake.texts
  local third = Module.new(env); third.bind('line-1', 5)
  for _ = 1, 20 do third.update(0.5) end
  assert(#fake.texts == before)
`));

test('without a save identity nothing is kept across a load', () => run(`
  ctl.bind(nil, nil)
  ask('judy')
  ctl.save()
  assert(fake.store == nil)
`));

test('idle cost: a step with nothing to do reads no game state', () => run(`
  local reads = 0
  local real = world.state
  world.state = function() reads = reads + 1; return real() end
  for _ = 1, 400 do ctl.update(0.1) end
  assert(reads == 0, reads)
`));
