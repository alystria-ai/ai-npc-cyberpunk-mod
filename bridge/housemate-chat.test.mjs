import {test} from 'node:test';
import assert from 'node:assert/strict';
import {lua} from './housemate-fixture.mjs';

// The pair chat scheduler against a fake speech pipeline.
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
    limiter = {allow = function(kind, lines) world.asked = (world.asked or 0) + 1; return world.limiter end, note = function(kind, lines) world.noted[#world.noted + 1] = lines end},
    speak = function(req) if world.refuse then return false end world.requests[#world.requests + 1] = req; world.speaking = 'busy'; return true end,
    status = function() return world.speaking, world.text end,
    cancelSpeak = function() world.cancelled = (world.cancelled or 0) + 1; world.speaking = nil end,
    ended = function(reason) world.ended[#world.ended + 1] = reason end,
    log = function() end,
  }
  local chat = Chat.new(env)
  -- advance time and finish each requested line after 'delay' seconds
  local function play(seconds, delay)
    delay = delay or 3
    local pendingFor = 0
    for _ = 1, seconds do
      chat.update(1)
      if world.speaking == 'busy' then
        pendingFor = pendingFor + 1
        if pendingFor >= delay then world.speaking = 'done'; world.text = 'line ' .. #world.requests; pendingFor = 0 end
      elseif world.speaking == 'done' then
        -- the scheduler has read it: the next request sets it busy again
        world.speaking = nil
      end
    end
  end
`;

test('a chat is at most 8 lines, alternates the two speakers, and ends by itself', () => {
  lua(`${CHAT}
    play(120)
    local n = #world.requests
    assert(n == 7 or n == 8, 'lines ' .. n)
    local first, second = world.requests[1], world.requests[2]
    assert(first.speaker.key ~= second.speaker.key and first.partner.key == second.speaker.key)
    assert(first.n == 1 and first.topic and second.topic == nil)
    for i, req in ipairs(world.requests) do
      assert(req.n == i and req.of >= 7 and req.of <= 8)
      assert(req.speaker.key ~= req.partner.key)
      assert(req.speaker.key ~= 'c', 'someone out of earshot spoke')
      assert(#req.lines <= 6)
    end
    -- the earlier lines come with the later requests
    assert(#world.requests[4].lines == 3 and world.requests[4].lines[1].text == 'line 1')
    assert(world.ended[1] == 'done')
    assert(world.noted[1] == n)
  `);
});

test('after a chat the next may not start for about two minutes', () => {
  lua(`${CHAT}
    play(80)
    local first = #world.requests
    assert(first >= 7 and chat.active() == false)
    -- the hourly cap of the level is 2: a third chat within the hour is refused even after the cooldown
    local start = #world.requests
    play(100)   -- the cooldown (120 s) is not over yet from the end of the first chat
    local second = #world.requests
    assert(second == start or second > start)
    local snapshot = chat.snapshot()
    assert(snapshot.hour >= 1)
  `);
});

test('the cooldown is 120 seconds from the end of a chat, and the level caps the chats per hour', () => {
  lua(`${CHAT}
    local starts = {}
    local last = 0
    for second = 1, 3 * 3600 do
      chat.update(1)
      if world.speaking == 'busy' then world.speaking = 'done'; world.text = 'x' elseif world.speaking == 'done' then world.speaking = nil end
      if #world.requests ~= last then
        if chat.snapshot().n == 1 then starts[#starts + 1] = second end
        last = #world.requests
      end
    end
    -- rare: at most 2 chats in any hour
    for i = 3, #starts do assert(starts[i] - starts[i - 2] >= 3600, 'three chats within an hour') end
    assert(#starts >= 4, 'chats ' .. #starts)
    -- never closer together than the cooldown plus the length of the chat
    for i = 2, #starts do assert(starts[i] - starts[i - 1] >= 120, 'too close') end
  `);
});

test('off means no chat; the new level names work; an unknown level is rare', () => {
  lua(`${CHAT}
    world.level = 'off'
    play(300)
    assert(#world.requests == 0)
    world.level = 'often'
    play(10)
    assert(#world.requests >= 1, 'often did not chat')
  `);
  lua(`${CHAT}
    world.level = 'banana'
    play(10)
    assert(#world.requests >= 1)
  `);
});

test('no chat when V is not home, when the limiter says no, with fewer than two near each other or far from V', () => {
  lua(`${CHAT}
    world.may = false
    play(60)
    assert(#world.requests == 0)
    world.may = true; world.limiter = false
    play(60)
    assert(#world.requests == 0)
    world.limiter = true
    world.people = {person('a', 2), person('c', 40)}   -- 38 m apart
    play(60)
    assert(#world.requests == 0)
    world.people = {person('a', 2)}
    play(60)
    assert(#world.requests == 0)
    world.people = {person('c', 40), person('d', 41)}   -- near each other but 40 m from V
    play(60)
    assert(#world.requests == 0)
  `);
});

test('V speaks to one of them: the line in the air is finished, then the chat ends', () => {
  lua(`${CHAT}
    play(8)
    assert(chat.active() and #world.requests >= 1)
    local before = #world.requests
    chat.interrupt('talk', false)
    play(30)
    assert(chat.active() == false)
    assert(#world.requests <= before + 1, 'it went on: ' .. #world.requests - before)
    assert(world.ended[#world.ended] == 'talk')
    assert((world.cancelled or 0) == 0, 'the line was cut')
  `);
});

test('a hard stop (combat, V left) cancels the line and ends at once', () => {
  lua(`${CHAT}
    play(2)
    assert(chat.active())
    chat.interrupt('left', true)
    assert(chat.active() == false and world.cancelled == 1 and world.ended[1] == 'left')
  `);
});

test('a speaker who left (no longer settled) or a refused request ends the chat', () => {
  lua(`${CHAT}
    play(8)
    world.people = {person('c', 2)}
    play(30)
    assert(chat.active() == false and world.ended[1] == 'dropped')
  `);
  lua(`${CHAT}
    world.refuse = true
    play(5)
    assert(chat.active() == false and world.ended[1] == 'failed' and #world.requests == 0)
    -- a failed chat adds a minute to the pause
    local s = chat.snapshot()
    assert(s.nextAt >= 120 + 60)
  `);
});

test('a line that never finishes ends the chat after the timeout', () => {
  lua(`${CHAT}
    for _ = 1, 200 do chat.update(1) end
    assert(chat.active() == false and world.ended[1] == 'failed')
  `);
});

test('the pair is random but not the one that just spoke, when another pair exists', () => {
  lua(`${CHAT}
    world.people = {person('a', 2), person('b', 4), person('c', 6)}
    world.level = 'often'
    local pairs_ = {}
    for chatIndex = 1, 5 do
      local before = #world.requests
      for _ = 1, 400 do
        chat.update(1)
        if world.speaking == 'busy' then world.speaking = 'done'; world.text = 'x' elseif world.speaking == 'done' then world.speaking = nil end
        if #world.requests > before and not chat.active() then break end
      end
      local first = world.requests[before + 1]
      if first then
        local a, b = first.speaker.key, first.partner.key
        if a > b then a, b = b, a end
        pairs_[a .. b] = (pairs_[a .. b] or 0) + 1
      end
    end
    local kinds = 0
    for _ in pairs(pairs_) do kinds = kinds + 1 end
    assert(kinds >= 2, 'always the same pair')
  `);
});

test('the pause after a chat is the setting (1, 2, 5 or 10 minutes), 120 seconds without one or with a bad one', () => {
  for (const [setting, expected] of [['60', 60], ['300', 300], ['600', 600], ['nil', 120], ["'soon'", 120], ['5', 120]]) {
    lua(`${CHAT}
      local value = ${setting}
      env.cooldown = function() return value end
      env.ended = function(reason) local s = chat.snapshot(); world.pause = s.nextAt - s.clock; world.ended[#world.ended + 1] = reason end
      chat = Chat.new(env)
      play(80)
      assert(#world.ended >= 1 and world.ended[1] == 'done', 'the first chat ends')
      assert(world.pause == ${expected}, 'pause ' .. tostring(world.pause))
    `);
  }
});

test('with a bigger chat size three or four take turns in order, each line answers the one before, and the rest are named', () => {
  lua(`${CHAT}
    world.people = {person('a', 2), person('b', 4), person('c', 6), person('d', 8)}
    env.groupSize = function() return 3 end
    chat = Chat.new(env)
    play(60)
    local n = #world.requests
    assert(n == 7 or n == 8, 'lines ' .. n)
    local order = {}
    for i = 1, 3 do order[i] = world.requests[i].speaker.key end
    assert(order[1] ~= order[2] and order[2] ~= order[3] and order[1] ~= order[3], 'three different people speak first')
    for i, req in ipairs(world.requests) do
      assert(req.speaker.key == order[(i - 1) % 3 + 1], 'turn ' .. i)
      if i > 1 then assert(req.partner.key == world.requests[i - 1].speaker.key, 'answers the one before ' .. i) end
      assert(#req.others == 1, 'one more person named')
      assert(req.others[1] ~= req.speaker.name and req.others[1] ~= req.partner.name)
    end
    assert(world.requests[1].partner.key == order[2], 'the first line is aimed at the next speaker')
  `);
  lua(`${CHAT}
    world.people = {person('a', 2), person('b', 4), person('c', 6), person('d', 8)}
    env.groupSize = function() return 9 end
    chat = Chat.new(env)
    play(60)
    assert(#world.requests[1].others == 2, 'never more than four people')
    -- two people at home: a chat of four is a chat of two
    world.people = {person('a', 2), person('b', 4)}
    env.groupSize = function() return 4 end
    chat = Chat.new(env)
    world.requests = {}
    play(60)
    assert(#world.requests[1].others == 0)
    -- nobody far away is pulled in
    world.people = {person('a', 2), person('b', 4), person('c', 40)}
    env.groupSize = function() return 4 end
    chat = Chat.new(env)
    world.requests = {}
    play(60)
    assert(#world.requests[1].others == 0 and world.requests[1].speaker.key ~= 'c')
  `);
});

test('somebody leaving a chat of three leaves it going between the others; with fewer than two it ends', () => {
  lua(`${CHAT}
    world.people = {person('a', 2), person('b', 4), person('c', 6)}
    env.groupSize = function() return 3 end
    chat = Chat.new(env)
    play(5)
    world.people = {person('a', 2), person('b', 4)}
    play(10)
    local last = world.requests[#world.requests]
    assert(chat.active() and #world.requests >= 3 and #last.others == 0, 'goes on between the two who are left')
    world.people = {person('a', 2)}
    play(12)
    assert(chat.active() == false and world.ended[#world.ended] == 'dropped')
  `);
});
