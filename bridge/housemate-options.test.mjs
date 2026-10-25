import {test} from 'node:test';
import assert from 'node:assert/strict';
import {lua} from './housemate-fixture.mjs';
import {WORLD} from './housemate-world-fake.mjs';

// The housemate options and the two bugs of the 2026-10-26 live run: Move-in apartment, Evict all housemates, a chat that stopped after its
// first line (a speaker counted as "talking" for good), and a body that cannot be made at a spot (the same spot, the same notice, every minute).

const CHAT_WIRED = `
  local Chat = dofile('housemate-chat.lua')
  local spoken = {requests = {}, status = nil, text = nil, ended = {}}
  local chat
  local function wire(c, extra)
    local chatEnv = {random = env.random, level = function() return 'normal' end, mayStart = function() return true end, vPos = env.vpos,
      people = function() return c.people() end,
      speak = function(req) spoken.requests[#spoken.requests + 1] = req; spoken.status = 'busy'; spoken.age = 0; return true end,
      status = function() return spoken.status, spoken.text end,
      cancelSpeak = function() spoken.status = nil end,
      ended = function(reason) spoken.ended[#spoken.ended + 1] = reason end, log = function() end}
    for k, v in pairs(extra or {}) do chatEnv[k] = v end
    chat = Chat.new(chatEnv)
    c.setChat(chat)
    return chat
  end
  -- one second at a time: a line is heard two seconds after it was asked for
  local function tick(c, seconds, onLine)
    for _ = 1, seconds do
      run(c, 1)
      if spoken.status == 'busy' then
        spoken.age = spoken.age + 1
        if spoken.age >= 2 then spoken.status, spoken.text = 'done', 'line ' .. #spoken.requests end
      elseif spoken.status == 'done' then spoken.status = nil end
      if onLine and spoken.requests[#spoken.requests] then onLine(spoken.requests[#spoken.requests]) end
    end
  end
`;

test('a chat goes on for all its lines in the flat (the speaker is not "talking" while she speaks her own chat line)', () => {
  lua(`${WORLD}${CHAT_WIRED}
    local c = control({['judy-alvarez'] = 'corpo', ['panam-palmer'] = 'corpo'})
    run(c, 20)
    wire(c)
    tick(c, 80)
    assert(#spoken.requests >= 7, 'lines ' .. #spoken.requests)
    assert(spoken.ended[1] == 'done', tostring(spoken.ended[1]))
  `);
});

test('a speaker who stays "talking" no longer freezes the chat in its first line: it is stepped and ends', () => {
  lua(`${WORLD}${CHAT_WIRED}
    local c = control({['judy-alvarez'] = 'corpo', ['panam-palmer'] = 'corpo'})
    run(c, 20)
    wire(c)
    -- the old sticky answer: whoever spoke last is "in a talk" from then on
    tick(c, 40, function(req) world.talking = req.speaker.entity end)
    assert(chat.active() == false, 'the chat hung in its first line')
    assert(#spoken.requests >= 1 and spoken.ended[1] ~= nil, 'ended: ' .. tostring(spoken.ended[1]))
  `);
});

test('a body that cannot be made at a spot: the spot is given up after two tries and the next try is somewhere else', () => {
  lua(`${WORLD}
    local attempts = {}
    env.bodies.spawn = function(r, spot) attempts[#attempts + 1] = spot.id; return true end   -- accepted, never made (the game refused it later)
    local c = control({['panam-palmer'] = 'corpo'})
    run(c, 600)
    assert(#attempts >= 3, 'attempts ' .. #attempts)
    local count = {}
    for _, id in ipairs(attempts) do count[id] = (count[id] or 0) + 1 end
    for id, n in pairs(count) do if not id:find('^proc:') then assert(n <= 2, id .. ' was tried ' .. n .. ' times') end end
    local rejected = false
    for _, line in ipairs(world.logs) do if line:find('spot-rejected', 1, true) and line:find('no body could be made there', 1, true) then rejected = true end end
    assert(rejected, 'the give-up is written to the log')
  `);
});

test('Evict all: every housemate of every flat moves out through the one path, bodies and seats let go, the party left alone', () => {
  lua(`${WORLD}${CHAT_WIRED}
    local c = control({['judy-alvarez'] = 'corpo', ['panam-palmer'] = 'corpo', ['rogue'] = 'corpo', ['river-ward'] = 'glen', ['kerry-eurodyne'] = 'h10'})
    run(c, 25)
    wire(c)
    assert(count(world.bodies) == 3)
    local open = 0
    for _, h in ipairs(world.handles) do if h.state ~= 'released' then open = open + 1 end end
    assert(open == 3, 'seats ' .. open)
    local before = #world.notes
    -- somebody else's party member is not a housemate and has nothing to do with it
    local serial = world.nextSerial; world.nextSerial = serial + 1
    world.party[serial] = {serial = serial, profileKey = 'misty', entityID = tostring(serial) .. 'ULL', state = 'ready'}
    assert(c.evictAll() == 5)
    assert(next(c.homes()) == nil and #c.rows() == 0, 'registry')
    assert(count(world.bodies) == 0, 'bodies left: ' .. count(world.bodies))
    for _, h in ipairs(world.handles) do assert(h.state == 'released', 'a seat is still held') end
    assert(world.party[serial] ~= nil, 'the party member was touched')
    assert(#world.notes == before, 'one notice per housemate would be noise: the page says it')
    assert(c.takenSpots('corpo')[1] == nil, 'a place is still claimed')
    -- nothing is placed again afterwards, and a second press does nothing
    run(c, 30)
    assert(count(world.bodies) == 0 and world.spawned == 3)
    assert(c.evictAll() == 0)
  `);
});

test('Evict all ends a chat the housemates were in', () => {
  lua(`${WORLD}${CHAT_WIRED}
    local c = control({['judy-alvarez'] = 'corpo', ['panam-palmer'] = 'corpo'})
    run(c, 20)
    wire(c)
    tick(c, 4)
    assert(chat.active())
    assert(c.evictAll() == 2)
    assert(chat.active() == false and next(c.homes()) == nil)
  `);
});

test('Move-in apartment: the offer carries the chosen flat only when V owns it and it is listed; Ask me or a lost flat is nothing', () => {
  lua(`${WORLD}
    world.facts.dlc6_apart_hey_gle_purchased = 0   -- Glen is not owned
    world.place = 'LittleChina_Street'
    local c = control({})
    local function offer() return c.homeOffer('1ULL', {profileKey = 'judy-alvarez'}) end
    assert(offer().fallback == nil, 'no setting: she asks')
    env.moveIn = function() return world.moveIn end
    world.moveIn = 'ask'
    assert(offer().fallback == nil)
    world.moveIn = 'corpo'
    assert(offer().fallback == 'corpo')
    world.moveIn = 'glen'
    assert(offer().fallback == nil, 'a flat V does not own falls back to asking')
    world.moveIn = 'nowhere'
    assert(offer().fallback == nil)
    world.moveIn = 'h10'
    assert(offer().fallback == 'h10')
    -- a stranger is offered no apartment at all
    local stranger = c.homeOffer('999ULL', {profileKey = 'nobody'})
    assert(stranger == nil or stranger.fallback == nil)
    -- the phone carries it too
    local phone = c.phoneOffer('judy-alvarez')
    assert(phone.fallback == 'h10')
    world.moveIn = 'corpo'
    offer()
    -- and the choice is logged
    local shown = false
    for _, line in ipairs(world.logs) do if line:find('offer-shown', 1, true) and line:find('default=corpo', 1, true) then shown = true end end
    assert(shown)
  `);
});

test('Move-in apartment: the chosen flat is one she can move into, and the list of owned flats is in page order', () => {
  lua(`${WORLD}
    world.place = 'LittleChina_Street'
    local c = control({})
    env.moveIn = function() return 'glen' end
    local offer = c.homeOffer('1ULL', {profileKey = 'judy-alvarez'})
    assert(offer.fallback == 'glen')
    assert(c.queueHome({op = 'stay', apartment = offer.fallback}, offer, '1ULL', 'r1') == true)
    assert(c.homeOf('judy-alvarez') == 'glen')
    local owned = {}
    for _, a in ipairs(c.ownedApartments()) do owned[#owned + 1] = a.id end
    assert(table.concat(owned, ',') == 'h10,corpo,glen', table.concat(owned, ','))
  `);
});
