import {test} from 'node:test';
import assert from 'node:assert/strict';
import {lua} from './housemate-fixture.mjs';

// The next line of the pair chat is written while the one before it is said (mod/housemate-chat.lua: env.prepare, env.unprepare, poke). The scheduler against
// a fake speech pipeline; the game side of the same flow is bridge/housemate-chat-game.test.mjs, the bridge side bridge/house-chat-lookahead.test.mjs.
const CHAT = `
  local Chat = dofile('housemate-chat.lua')
  local world = {level = 'rare', may = true, speaking = nil, requests = {}, people = {}, ended = {}, vpos = {x = 0, y = 0, z = 0}, limiter = true, noted = {}}
  local function person(key, x) return {key = key, name = key:upper(), serial = 1, entity = key .. 'ULL', x = x, y = 0, z = 0} end
  world.people = {person('a', 2), person('b', 4), person('c', 30)}
  local r = 0.1
  local env = {
    now = function() return 0 end,
    random = function() r = (r * 7.13 + 0.17) % 1 return r end,
    level = function() return world.level end,
    mayStart = function() return world.may end,
    vPos = function() return world.vpos end,
    people = function() return world.people end,
    limiter = {allow = function() return world.limiter end, note = function(kind, lines) world.noted[#world.noted + 1] = lines end},
    speak = function(req) if world.refuse then return false end world.requests[#world.requests + 1] = req; world.speaking = 'busy'; world.text = nil; return true end,
    status = function() return world.speaking, world.text end,
    cancelSpeak = function() world.cancelled = (world.cancelled or 0) + 1; world.speaking = nil end,
    ended = function(reason) world.ended[#world.ended + 1] = reason end,
    log = function() end,
  }
  local prepared, unprepared = {}, 0
  local function withPreparing()
    env.prepare = function(req) prepared[#prepared + 1] = req; return true end
    env.unprepare = function() unprepared = unprepared + 1 end
  end
  local chat = Chat.new(env)
`;

// One line prepared behind the first, the first still in the air.
const PREPARED = `
  withPreparing()
  chat = Chat.new(env)
  chat.update(1)
  world.text = 'x'
  chat.update(1)
  assert(#prepared == 1 and unprepared == 0)
`;

test('a line is asked for at the very end of the one before: no pause of the scheduler\'s own, and a poke reads the end at once', () => {
  lua(`${CHAT}
    chat.update(1)
    assert(#world.requests == 1)
    world.speaking = 'done'; world.text = 'one'
    -- no step goes by: the game side says the line has ended, and the next one is requested in that very call
    chat.poke()
    assert(#world.requests == 2, 'the next line was not asked for at once')
    assert(world.requests[2].prepared == nil and world.requests[2].gap == nil, 'nothing was prepared, so no beat is added')
    -- a poke with nothing to read changes nothing
    chat.poke(); chat.poke()
    assert(#world.requests == 2)
    chat.interrupt('left', true)
    chat.poke()
    assert(chat.active() == false)
  `);
});

test('the next speaker\'s line is prepared once, as soon as the text of the line in the air is known, with that text in view', () => {
  lua(`${CHAT}
    withPreparing()
    chat = Chat.new(env)
    chat.update(1)
    assert(#world.requests == 1 and #prepared == 0)
    chat.update(1)                       -- the line is in the air but its text is not known yet
    assert(#prepared == 0)
    world.text = 'first words'
    chat.update(1); chat.update(1); chat.update(1)
    assert(#prepared == 1, 'prepared ' .. #prepared)
    local line, ahead = world.requests[1], prepared[1]
    assert(ahead.n == 2 and ahead.speaker.key == line.partner.key and ahead.partner.key == line.speaker.key)
    assert(#ahead.lines == 1 and ahead.lines[1].text == 'first words' and ahead.lines[1].speaker == line.speaker.name)
    assert(ahead.topic == nil and ahead.of == line.of)
    -- the line has been heard: the very same request goes out, flagged, with a short beat
    world.speaking = 'done'
    chat.poke()
    assert(#world.requests == 2 and unprepared == 0)
    local sent = world.requests[2]
    assert(sent.prepared == true and sent.n == 2 and sent.speaker.key == ahead.speaker.key)
    assert(sent.gap >= 0.25 and sent.gap <= 0.5, 'the beat is ' .. tostring(sent.gap))
    assert(#sent.lines == 1 and sent.lines[1].text == 'first words')
  `);
});

test('every line but the last is prepared behind the one before it, never past the length of the chat, and the last is not', () => {
  lua(`${CHAT}
    withPreparing()
    chat = Chat.new(env)
    for _ = 1, 400 do
      chat.update(1)
      if world.speaking == 'busy' then
        world.text = 'line ' .. #world.requests
        chat.update(1)
        world.speaking = 'done'
        chat.poke()
      end
      if not chat.active() then break end
    end
    local n = #world.requests
    assert(n == 7 or n == 8, 'lines ' .. n)
    assert(#prepared == n - 1, 'prepared ' .. #prepared .. ' of ' .. n)
    for i, req in ipairs(prepared) do
      assert(req.n == i + 1 and req.n <= world.requests[1].of)
      assert(world.requests[i + 1].prepared == true and world.requests[i + 1].speaker.key == req.speaker.key)
      assert(#req.lines == math.min(i, 6) and req.lines[#req.lines].text == 'line ' .. i)
    end
    assert(world.ended[1] == 'done')
  `);
});

test('a prepared line that is no longer the one to send (somebody left) is withdrawn and the next line is an ordinary request', () => {
  lua(`${CHAT}
    world.people = {person('a', 2), person('b', 4), person('c', 6)}
    env.groupSize = function() return 3 end
    withPreparing()
    chat = Chat.new(env)
    chat.update(1)
    world.text = 'x'
    chat.update(1)
    assert(#prepared == 1)
    local speaker = prepared[1].speaker.key
    -- the person who was to speak next has gone from the flat
    local rest = {}
    for _, p in ipairs(world.people) do if p.key ~= speaker then rest[#rest + 1] = p end end
    world.people = rest
    world.speaking = 'done'
    chat.poke()
    assert(unprepared == 1, 'the prepared line was not withdrawn')
    assert(#world.requests == 2 and world.requests[2].prepared == nil and world.requests[2].speaker.key ~= speaker)
  `);
});

test('a stop after the line in the air, a hard stop, a failed line, a cancelled one and a timeout all withdraw what was prepared', () => {
  lua(`${CHAT}${PREPARED}
    chat.interrupt('talk', false)
    assert(unprepared == 0 and chat.active(), 'the line in the air is finished first')
    world.speaking = 'done'
    chat.poke()
    assert(chat.active() == false and world.ended[1] == 'talk' and unprepared == 1 and #world.requests == 1, 'no further line is asked for')
  `);
  lua(`${CHAT}${PREPARED}
    chat.interrupt('left', true)
    assert(chat.active() == false and unprepared == 1 and world.cancelled == 1)
  `);
  lua(`${CHAT}${PREPARED}
    world.speaking = 'failed'
    chat.update(1)
    assert(chat.active() == false and unprepared == 1 and world.ended[1] == 'failed')
  `);
  lua(`${CHAT}${PREPARED}
    world.speaking = 'cancelled'
    chat.update(1)
    assert(chat.active() == false and unprepared == 1)
  `);
  lua(`${CHAT}${PREPARED}
    for _ = 1, 100 do chat.update(1) end
    assert(chat.active() == false and unprepared == 1 and world.ended[1] == 'failed')
  `);
});

test('a refused preparation is not asked again for that line and costs nothing: the next line is an ordinary request', () => {
  lua(`${CHAT}
    local asked = 0
    env.prepare = function() asked = asked + 1; return false end
    env.unprepare = function() error('nothing was prepared') end
    chat = Chat.new(env)
    chat.update(1)
    world.text = 'x'
    for _ = 1, 5 do chat.update(1) end
    assert(asked == 1, 'asked ' .. asked)
    world.speaking = 'done'
    chat.poke()
    assert(#world.requests == 2 and world.requests[2].prepared == nil)
    -- a preparation that raises is the same
    env.prepare = function() error('boom') end
    world.text = 'y'
    chat.update(1); chat.update(1)
    world.speaking = 'done'
    chat.poke()
    assert(#world.requests == 3 and world.requests[3].prepared == nil)
  `);
});

test('V talks while the next line waits for its beat or for the channel: nothing was in the air, so the chat ends at once and the waiting line is cancelled', () => {
  lua(`${CHAT}
    chat.update(1)
    world.speaking = 'done'; world.text = 'one'
    chat.poke()
    assert(#world.requests == 2)
    world.speaking = 'waiting'          -- queued behind its beat, nothing sent yet
    chat.interrupt('talk', false)
    assert(chat.active() == false and world.ended[1] == 'talk' and world.cancelled == 1)
  `);
  // a line that is already sent is still finished first
  lua(`${CHAT}
    chat.update(1)
    world.speaking = 'busy'
    chat.interrupt('talk', false)
    assert(chat.active() and (world.cancelled or 0) == 0)
  `);
});

test('V stops being able to hear them between two lines: the chat ends as dropped instead of asking for the next one', () => {
  lua(`${CHAT}
    chat.update(1)
    world.may = false
    world.speaking = 'done'; world.text = 'one'
    chat.poke()
    assert(chat.active() == false and world.ended[1] == 'dropped' and #world.requests == 1)
  `);
});
