// Meet requests on holocalls (docs/IMMERSIVE_INVITATIONS.md, "Holocalls"): V says "come meet me" on a call, her reply streams to the voice, and a small
// decision step after the reply makes the appointment (Mistral, Local AI, Custom) or Convai's action list does. The pieces are real on every step: the Lua
// lease (mod/gameplay-actions.lua), the service glue (mod/immersive-service.lua) and the controller (mod/immersive-invitations.lua) run in a Lua VM over a fake
// game, the request is the JSON text the game writes, then parseInput -> PlayerKnowledge.prepare -> CompanionActions admit / configFor -> the text host's
// decision (a fake chat) or the Convai window -> CompanionActions.deliver -> the packet text -> back into the Lua lease. Offline: no game, no network.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import fengari from 'fengari';
import {parseInput} from './protocol.mjs';
import {PlayerKnowledge} from './player-knowledge.mjs';
import {CompanionActions, CompanionActionWindow, publishCompanionActionContext} from './companion-actions.mjs';
import {TextProviderHost, mistralRoute} from './text-provider-host.mjs';
import {parseCallMeetOffer, callMeetNote, planCallMeet, callMeetClassifier, parseCallMeetAnswer, offeredKinds} from './call-meet.mjs';
import {PersonaBook} from './mistral-prompt.mjs';

const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;
const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const roster = [...JSON.parse(read('../characters/roster.json')), ...JSON.parse(read('../characters/archetype-roster.json'))];
const book = new PersonaBook(roster);

// ---- The offers the game makes ------------------------------------------------------------------------------------------------------------

const ACTOR = {id: '11147869ULL', key: 'judy-alvarez'};
const OPEN = {version: 1, token: 'meet-0123456789abcdef', kinds: ['here'], here: {place: "Lizzie's Bar, Kabuki, Watson"}, etaMinutes: 0, waitMinutes: 5, cancel: false};
const WITH_WAYPOINT = {...OPEN, kinds: ['here', 'waypoint'], waypoint: {place: 'Afterlife, Watson'}};
const PENDING = {version: 1, unavailable: 'pending', place: "Lizzie's Bar, Kabuki, Watson", cancel: true, token: 'meet-fedcba9876543210'};
const COMBAT = {version: 1, unavailable: 'combat'};
const wrap = (meet, available = true) => ({available, actor: {...ACTOR}, meet});

// ---- The parser, the note, the plan -----------------------------------------------------------------------------------------------------

test('the call offer: an open offer, a standing meeting that may be called off, and a reason she cannot come; anything else is no offer', () => {
  const open = parseCallMeetOffer(wrap(OPEN));
  assert.equal(open.available, true);
  assert.deepEqual(offeredKinds(open), ['meet-here']);
  assert.deepEqual(offeredKinds(parseCallMeetOffer(wrap(WITH_WAYPOINT))), ['meet-here', 'meet-waypoint']);
  assert.deepEqual(offeredKinds(parseCallMeetOffer(wrap(PENDING))), ['cancel-meet'], 'a standing meeting is answered with cancel only');
  const blocked = parseCallMeetOffer(wrap(COMBAT, false));
  assert.equal(blocked.available, false);
  assert.deepEqual(offeredKinds(blocked), [], 'nothing can be answered');
  // `raw` is the offer as the game sent it, a copy.
  const source = wrap(OPEN); const parsed = parseCallMeetOffer(source);
  assert.deepEqual(parsed.raw, source); assert.notEqual(parsed.raw, source);
  for (const bad of [null, [], {}, {...wrap(OPEN), available: false}, {...wrap(COMBAT, false), available: true}, wrap({...OPEN, token: 'x'}),
    {...wrap(OPEN), extra: 1}, {available: true, actor: {id: 'x', key: 'judy-alvarez'}, meet: OPEN}, {available: true, actor: {...ACTOR, extra: 1}, meet: OPEN},
    {available: true, actor: {id: ACTOR.id, key: 'Not A Key'}, meet: OPEN}]) {
    assert.equal(parseCallMeetOffer(bad), null, JSON.stringify(bad));
  }
});

test('the note she reads on a call: nothing for ordinary talk, the facts for a possible meeting, no tags, and the reason when she cannot come', () => {
  const open = parseCallMeetOffer(wrap(WITH_WAYPOINT));
  assert.equal(callMeetNote(open, 'how was your day'), '', 'a typed line that cannot be about a meeting pays nothing');
  const note = callMeetNote(open, 'can you come meet me?');
  assert.match(note, /Lizzie's Bar, Kabuki, Watson/);
  assert.match(note, /Afterlife, Watson/);
  assert.match(note, /right away/);
  assert.match(note, /about 5 minutes/);
  assert.match(note, /never promise to come unless you really mean to/);
  assert.doesNotMatch(note, /\[meet|tag/i, 'a call reply cannot carry a tag');
  assert.notEqual(callMeetNote(open, ''), '', 'a spoken line is not known yet: the note is always there');
  assert.equal(callMeetNote(open, 'never mind'), '', 'nothing to cancel');
  const pending = parseCallMeetOffer(wrap(PENDING));
  assert.match(callMeetNote(pending, "never mind, don't come"), /call it off|calls it off/);
  assert.equal(callMeetNote(pending, 'what are you wearing'), '');
  assert.match(callMeetNote(parseCallMeetOffer(wrap(COMBAT, false)), 'come over here'), /in a fight/);
  assert.match(callMeetNote(parseCallMeetOffer(wrap({version: 1, unavailable: 'busy'}, false)), 'come over here'), /cannot come and meet V right now/);
  assert.equal(callMeetNote(null, 'come over here'), '');
});

test('the plan: a plain call and small talk ask nothing; a meeting, the waypoint (only when V names it) and a cancel are the choices', () => {
  const open = parseCallMeetOffer(wrap(WITH_WAYPOINT));
  for (const line of ['how was the heist', 'i miss you', 'what do you think of the corpos', '']) assert.equal(planCallMeet(open, line), null, line);
  assert.deepEqual(planCallMeet(open, 'come meet me at my place').choices, ['MEET']);
  assert.deepEqual(planCallMeet(open, 'come to the waypoint').choices, ['MEET', 'WAYPOINT']);
  assert.deepEqual(planCallMeet(parseCallMeetOffer(wrap(OPEN)), 'come to the waypoint').choices, ['MEET'], 'no waypoint in the offer: no waypoint choice');
  assert.equal(planCallMeet(open, 'never mind, forget it'), null, 'nothing to cancel');
  assert.deepEqual(planCallMeet(parseCallMeetOffer(wrap(PENDING)), "never mind, don't come").choices, ['CANCEL']);
  assert.equal(planCallMeet(parseCallMeetOffer(wrap(PENDING)), 'come over here'), null, 'a standing meeting is not made twice');
  assert.equal(planCallMeet(parseCallMeetOffer(wrap(COMBAT, false)), 'come over here'), null, 'nothing is asked when the game cannot do it');
});

test('the decision request: V\'s line and her reply, the offered choices, a one-word answer; an answer outside the plan is none', () => {
  const plan = planCallMeet(parseCallMeetOffer(wrap(WITH_WAYPOINT)), 'come to the waypoint');
  const messages = callMeetClassifier(plan, {userText: 'come to the waypoint', replyText: 'On my way, give me ten.'});
  assert.equal(messages.length, 2);
  assert.match(messages[0].content, /MEET:/); assert.match(messages[0].content, /WAYPOINT:/); assert.doesNotMatch(messages[0].content, /CANCEL:/);
  assert.match(messages[0].content, /Answer with one word only: MEET, WAYPOINT, NONE/);
  assert.match(messages[1].content, /come to the waypoint/); assert.match(messages[1].content, /On my way, give me ten/);
  assert.equal(parseCallMeetAnswer('WAYPOINT', plan), 'meet-waypoint');
  assert.equal(parseCallMeetAnswer(' meet.', plan), 'meet-here');
  assert.equal(parseCallMeetAnswer('NONE', plan), null);
  assert.equal(parseCallMeetAnswer('CANCEL', plan), null, 'not a choice of this plan');
  assert.equal(parseCallMeetAnswer('I think maybe', plan), null);
  assert.equal(parseCallMeetAnswer('', plan), null);
  const here = planCallMeet(parseCallMeetOffer(wrap(WITH_WAYPOINT)), 'come meet me');
  assert.equal(parseCallMeetAnswer('WAYPOINT', here), null, 'V never named the waypoint: it is never used');
});

// ---- The request the game writes ------------------------------------------------------------------------------------------------------------

// CET's `json` global, as a small pure-Lua codec (objects and arrays; enough for the request and the packet).
const JSON_LUA = `
json = {}
local function esc(s) return (s:gsub('[%c"\\\\]', function(c) return string.format('\\\\u%04x', c:byte()) end)) end
function json.encode(v)
  local t = type(v)
  if t == 'nil' then return 'null' elseif t == 'boolean' then return tostring(v)
  elseif t == 'number' then return (v == math.floor(v) and math.abs(v) < 1e15) and string.format('%d', v) or string.format('%.14g', v)
  elseif t == 'string' then return '"' .. esc(v) .. '"'
  elseif t == 'table' then
    if #v > 0 or next(v) == nil then
      local out = {}; for i, item in ipairs(v) do out[i] = json.encode(item) end; return '[' .. table.concat(out, ',') .. ']'
    end
    local out = {}; for k, item in pairs(v) do out[#out + 1] = '"' .. esc(tostring(k)) .. '":' .. json.encode(item) end
    return '{' .. table.concat(out, ',') .. '}'
  end
  error('cannot encode ' .. t)
end
function json.decode(s)
  local i = 1
  local function ws() i = s:find('%S', i) or #s + 1 end
  local value
  local function str()
    local out = {}; i = i + 1
    while true do
      local c = s:sub(i, i)
      if c == '"' then i = i + 1; return table.concat(out) end
      if c == '\\\\' then
        local n = s:sub(i + 1, i + 1)
        if n == 'u' then out[#out + 1] = string.char(tonumber(s:sub(i + 2, i + 5), 16) % 256); i = i + 6
        else out[#out + 1] = ({n = '\\n', t = '\\t', r = '\\r'})[n] or n; i = i + 2 end
      else out[#out + 1] = c; i = i + 1 end
    end
  end
  function value()
    ws(); local c = s:sub(i, i)
    if c == '{' then
      local obj = {}; i = i + 1; ws()
      if s:sub(i, i) == '}' then i = i + 1; return obj end
      while true do
        ws(); local k = str(); ws(); i = i + 1; obj[k] = value(); ws()
        local d = s:sub(i, i); i = i + 1; if d == '}' then return obj end
      end
    elseif c == '[' then
      local arr = {}; i = i + 1; ws()
      if s:sub(i, i) == ']' then i = i + 1; return arr end
      while true do
        arr[#arr + 1] = value(); ws(); local d = s:sub(i, i); i = i + 1; if d == ']' then return arr end
      end
    elseif c == '"' then return str()
    elseif s:sub(i, i + 3) == 'true' then i = i + 4; return true
    elseif s:sub(i, i + 4) == 'false' then i = i + 5; return false
    elseif s:sub(i, i + 3) == 'null' then i = i + 4; return nil
    else local num = s:match('^-?[%d.eE+-]+', i); i = i + #num; return tonumber(num) end
  end
  return value()
end
`;

// A fake game around the real modules, wired the way mod/init.lua wires them: the lease's meetOffer / queueMeet call the service's callOffer / callAccept
// through the two globals, the controller runs over a fake world.
const GAME_LUA = `
convaiUiLocale = {t = function(s, a)
  local r = s
  if a then for k, v in pairs(a) do r = r:gsub('{' .. k .. '}', (tostring(v):gsub('%%', '%%%%'))) end end
  return r
end}
local Invite = (function() ${read('../mod/immersive-invitations.lua')} end)()
local Glue = (function() ${read('../mod/immersive-service.lua')} end)()
local Actions = (function() ${read('../mod/gameplay-actions.lua')} end)()
logs, notices, jobs = {}, {}, {}
ms = 1792531180000
raw = nil
opts = {enabled = true, arrival = 'walk', delay = 0, wait = 5, waypoint = true, texts = true}
fake = {pos = {x = 0, y = 0, z = 0}, waypoint = nil, held = nil, party = {}, offered = 0}
local world = {}
function world.state() return {running = true, position = fake.pos, held = fake.held} end
function world.describe(kind)
  if kind == 'waypoint' then return fake.waypoint and {position = fake.waypoint.position, place = fake.waypoint.place} or nil end
  return {position = {x = fake.pos.x, y = fake.pos.y, z = fake.pos.z}, place = "Lizzie's Bar, Kabuki, Watson"}
end
function world.hasWaypoint() return fake.waypoint ~= nil end
function world.hidden() return false end
function world.release() end
local companions = {}
function companions.definition(key) return key == 'judy' and {name = 'Judy', profileKey = 'judy-alvarez'} or nil end
function companions.list() return fake.party end
function companions.visitors() return {} end
function companions.phoneContactKey(contact) return contact == 'judy' and 'judy' or nil end
local queue = {}
function queue.invite(key, extra) jobs[#jobs + 1] = {key = key, extra = extra}; return true, '', 'queued:' .. #jobs end
function queue.cancelJob() return true end
function queue.hasJob() return true end
local phoneChat = {world = 'w'}
local modules = {['immersive-invitations.lua'] = Invite, ['immersive-world.lua'] = {new = function() return world end}}
service = Glue.new({manager = {immersive = function() return opts end}, queue = function() return queue end, companions = companions, phoneChat = phoneChat,
  load = function(name) return modules[name] end, notify = function(kind, text) notices[#notices + 1] = kind .. ':' .. text end,
  log = function(line) logs[#logs + 1] = line end, logOnce = function(key, line) logs[#logs + 1] = line end, held = function() return fake.held end,
  districtOf = function() return 'Watson' end, greet = function() end, persist = {}, wall = function() return fake.wall or 0 end, random = function() return 0.5 end})
-- What init.lua defines as globals (convaiMeetCallOffer / convaiMeetCallAccept).
function convaiMeetCallOffer(context)
  if not opts.enabled then return nil end
  service.get()
  fake.offered = fake.offered + 1
  return service.callOffer(context)
end
function convaiMeetCallAccept(profileKey, kind, offer) return service.callAccept(profileKey, kind, offer) end
service.tick(0.1)
W = {ready = true, worldToken = 'world-fixture', generation = 2}
actions = Actions.new({world = function() return W end, clock = function() return ms end,
  -- A call offers no ride, fight or follow even when the game could: only the meeting is leased for a call.
  offer = function() return {available = true, actor = {id = '11147869ULL', key = 'judy-alvarez'}} end,
  tacticOffer = function() return {available = true, actor = {id = '11147869ULL', key = 'judy-alvarez'}} end,
  followOffer = function() return {available = true, actor = {id = '11147869ULL', key = 'judy-alvarez'}} end,
  leaveOffer = function() return {available = true, actor = {id = '11147869ULL', key = 'judy-alvarez'}, members = {{id = '11147869ULL'}}} end,
  reactionOffer = function() return {available = true, actor = {id = '11147869ULL', key = 'judy-alvarez'}, kinds = {'leave'}} end,
  meetOffer = function(entity, context) return convaiMeetCallOffer and convaiMeetCallOffer(context) or nil end,
  queueMeet = function(kind, offer, profileKey, requestId) return convaiMeetCallAccept(profileKey, kind, offer) end,
  log = function(line) logs[#logs + 1] = line end, read = function() return raw end, decode = json.decode})
-- V's nth call line (the fields mod/init.lua sets before capture; the rest is not read by the bridge half).
function request(n, text, mode, source)
  local context = {generation = n, entity = '11147869ULL', name = 'Judy Alvarez', bodyType = '', profileKey = 'judy-alvarez',
    requestId = '1792531180-' .. n .. '-11147869ULL', text = text, sentAt = 1792531180, voiceOnly = true,
    holocall = {version = 1, contact = 'judy', mode = mode or 'audio'}}
  actions.capture(context, source or 'private-text')
  return json.encode(context)
end
function appointment()
  local a = service.get().appointment('judy-alvarez')
  if not a then return 'null' end
  return json.encode({kind = a.kind, place = a.place, phase = a.phase, x = a.dest.x, y = a.dest.y})
end
`;

function luaSession() {
  const vm = lauxlib.luaL_newstate(); lualib.luaL_openlibs(vm);
  const run = code => {
    const status = lauxlib.luaL_dostring(vm, to_luastring(code));
    const result = status === lua.LUA_OK ? (lua.lua_isstring(vm, -1) ? to_jsstring(lua.lua_tostring(vm, -1)) : '') : null;
    const error = status === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(vm, -1));
    lua.lua_settop(vm, 0);
    assert.equal(status, lua.LUA_OK, error);
    return result;
  };
  run(JSON_LUA + GAME_LUA);
  return {
    run,
    request: (n, text, mode, source) => run(`return request(${n}, ${JSON.stringify(text)}, ${mode ? JSON.stringify(mode) : 'nil'}, ${source ? JSON.stringify(source) : 'nil'})`),
    receive: packet => run(`raw = ${JSON.stringify(typeof packet === 'string' ? packet : JSON.stringify(packet))}; actions.update(true); return ''`),
    appointment: () => JSON.parse(run('return appointment()')),
    logs: () => JSON.parse(run('return json.encode(logs)')),
    lease: () => JSON.parse(run('local i = actions.inspect(); return json.encode({pending = i.pending, meet = i.meet, drive = i.drive, tactic = i.tactic, follow = i.follow, leave = i.leave, reaction = i.reaction, state = i.state})')),
    offered: () => Number(run('return tostring(fake.offered)')),
    close: () => lua.lua_close(vm),
  };
}

// ---- The bridge half --------------------------------------------------------------------------------------------------------------------

const BOUNDARY = {worldToken: 'world-fixture', generation: 2};
const GUARD = {endUserId: 'fixture-user', characterId: 'fixture-character', resetEpoch: 0, characterEpoch: 0};
function router(profileKey) {
  return new PlayerKnowledge({
    playerMemory: {route: () => ({endUserId: GUARD.endUserId, guard: GUARD}), isCurrent: value => JSON.stringify(value) === JSON.stringify(GUARD)},
    pack: {version: 1, id: 'call-fixture', revision: 1, gameVersions: ['2.31'], profileKeys: [profileKey], sources: [], evidence: [], factAllowlist: {}, journalAllowlist: {}, rules: []},
    getBoundary: () => BOUNDARY, isWorldCurrent: () => true,
  });
}
function broker(files) {
  let sequence = 0;
  return new CompanionActions({now: () => 1792531182000, createToken: () => 'drive-' + String(++sequence).padStart(20, '0'),
    publish: async (packet, options) => {
      if (options?.isCurrent && !await options.isCurrent()) return false;
      if (options?.isCurrentSync && !options.isCurrentSync()) return false;
      files.push(packet); return true;
    }});
}
// One call turn through the bridge: the request text -> parse -> prepare -> admit -> config.
async function bridgeTurn(requestText, {files = [], source = 'private-text', change} = {}) {
  const input = parseInput(requestText);
  assert.ok(input, 'the bridge accepts the request the game wrote');
  const knowledge = router(input.profileKey);
  const prepared = await knowledge.prepare(input, BOUNDARY);
  const actions = broker(files);
  const config = actions.admit(change ? change(prepared) : prepared, {source, isCurrent: () => knowledge.current(prepared), isCurrentSync: () => knowledge.currentSync(prepared)});
  return {input, prepared, actions, config, files};
}

// The text host with a fake chat. `answers` is the decision model's answer; `gate` (optional) holds the answer until it is released.
function decisionHost({answer = 'NONE', gate = null, routeName = 'mistral', onConnect = null, turn = null} = {}) {
  const chats = [], delivered = [], logs = [];
  const route = mistralRoute({provider: {apiKey: 'test' + 'x'.repeat(28), noteSuccess() {}, noteLimit() {}, limit: null}, gapMs: 0});
  if (routeName !== 'mistral') route.name = routeName;
  if (onConnect) route.connect = async (signal, options) => { onConnect(options); return {apiKey: 'k'}; };
  route.chat = async options => {
    chats.push(options);
    if (gate) await gate.promise;
    if (options.signal?.aborted) throw Object.assign(Error('aborted'), {name: 'AbortError'});
    return {text: answer, model: 'm', finishReason: 'stop', usage: {}, attempts: 1, failed: [], trace: {}};
  };
  const provider = {route: routeName, active: true, onChange() {}};
  let accept = true;
  const host = new TextProviderHost({provider, memory: null, personas: book, routes: {[routeName]: route}, log: line => logs.push(line),
    deliverAction: async message => { delivered.push(message); return accept && (turn ? turn.actions.deliver(message) : true); }});
  return {host, chats, delivered, logs, refuse: () => { accept = false; }};
}
// The mailbox also gets the empty packets of a revoke; these are the packets that ask for something.
const written = files => files.filter(item => item.action !== 'none');
const meetPacket = turn => turn.files.filter(item => item.action === 'companion-meet').at(-1);
const decide = (host, turn, userText, replyText, extra = {}) => host.decideMeet({plan: planCallMeet(turn.actions.pending.meet, userText), userText, replyText,
  token: turn.config.token, profileKey: turn.input.profileKey, signal: undefined, ...extra});

// ---- The lease -------------------------------------------------------------------------------------------------------------------------

test('a call line leases only the meeting, however much else the game could offer, and the request carries the offer', () => {
  const game = luaSession();
  try {
    const text = game.request(1, 'come meet me');
    assert.deepEqual(game.lease(), {pending: true, meet: true, drive: false, tactic: false, follow: false, leave: false, reaction: false, state: 'available'});
    const wire = JSON.parse(text);
    assert.equal(wire.meetOffer.available, true);
    assert.deepEqual(wire.meetOffer.meet.kinds, ['here']);
    assert.equal(wire.meetOffer.meet.here.place, "Lizzie's Bar, Kabuki, Watson");
    for (const name of ['chauffeurOffer', 'tacticOffer', 'followOffer', 'leaveOffer', 'reactionOffer']) assert.equal(wire[name], undefined, name);
  } finally { game.close(); }
});

test('with Immersive invitations Off a call offers nothing and the controller is never asked', () => {
  const game = luaSession();
  try {
    game.run('opts.enabled = false');
    const wire = JSON.parse(game.request(1, 'come meet me'));
    assert.equal(wire.meetOffer, undefined);
    assert.equal(game.lease().pending, false);
    assert.equal(game.offered(), 0, 'the controller was never asked');
    assert.equal(game.run('return tostring(service.get())'), 'nil');
  } finally { game.close(); }
});

test('a call she cannot answer with a meeting carries the reason for her note and leases nothing; a character already with V has none', () => {
  const game = luaSession();
  try {
    game.run("fake.held = 'combat'");
    const wire = JSON.parse(game.request(1, 'come over here'));
    assert.equal(wire.meetOffer.available, false);
    assert.equal(wire.meetOffer.meet.unavailable, 'combat');
    assert.equal(game.lease().pending, false);
    // The next admission replaces the note (and the same request again gives the same note).
    game.run('fake.held = nil');
    assert.equal(JSON.parse(game.request(2, 'come over here')).meetOffer.available, true);
    game.run("fake.party = {{profileKey = 'judy-alvarez', state = 'following'}}");
    const here = JSON.parse(game.request(3, 'come over here'));
    assert.equal(here.meetOffer, undefined, 'she is with V: no offer, no note');
    assert.equal(game.lease().pending, false);
  } finally { game.close(); }
});

// ---- The text route: the decision after the reply -------------------------------------------------------------------------------------

test('Mistral / Local AI / Custom: "come meet me" on a call makes an appointment at V\'s place', async () => {
  const game = luaSession();
  try {
    const turn = await bridgeTurn(game.request(1, 'come meet me at my place'));
    assert.ok(turn.config, 'the bridge admitted the call turn');
    assert.deepEqual(turn.config.meet, {kinds: ['here'], here: "Lizzie's Bar, Kabuki, Watson", cancel: false});
    assert.equal(turn.config.drive, false);
    // The note she reads while she answers.
    assert.match(callMeetNote(parseCallMeetOffer(turn.input.meetOffer), turn.input.text), /Lizzie's Bar/);
    // Her reply has gone to the voice; now the small decision.
    const {host, chats, delivered} = decisionHost({answer: 'MEET', turn});
    const kind = await decide(host, turn, 'come meet me at my place', "Sure, I know Lizzie's. Give me a few minutes.");
    assert.equal(kind, 'meet-here');
    assert.equal(chats.length, 1, 'one request');
    assert.deepEqual(delivered, [{version: 1, token: turn.config.token, meet: 'meet-here'}]);
    const packet = meetPacket(turn);
    assert.ok(packet, 'a packet for the game was written');
    assert.equal(packet.meet, 'meet-here'); assert.match(packet.meetToken, /^meet-[a-f0-9]{16}$/);
    game.receive(packet);
    assert.deepEqual(game.appointment(), {kind: 'here', place: "Lizzie's Bar, Kabuki, Watson", phase: 'scheduled', x: 0, y: 0});
    assert.equal(game.lease().pending, false, 'the lease is spent');
    // The very same packet again does nothing (the offer's token is one-use).
    game.run("service.get().cancel('judy-alvarez', 'x')");
    game.receive(packet);
    assert.equal(game.appointment(), null, 'a replay makes nothing');
  } finally { game.close(); }
});

test('a call that names the waypoint uses the waypoint, and only then', async () => {
  const game = luaSession();
  try {
    game.run("fake.waypoint = {position = {x = 400, y = 250, z = 0}, place = 'Afterlife, Watson'}");
    const turn = await bridgeTurn(game.request(1, 'come to the waypoint on my map'));
    assert.deepEqual(turn.config.meet.kinds, ['here', 'waypoint']);
    const {host} = decisionHost({answer: 'WAYPOINT', turn});
    assert.equal(await decide(host, turn, 'come to the waypoint on my map', 'On my way there.'), 'meet-waypoint');
    game.receive(meetPacket(turn));
    assert.deepEqual(game.appointment(), {kind: 'waypoint', place: 'Afterlife, Watson', phase: 'scheduled', x: 400, y: 250});
    // Another call: the waypoint is set, V says "come over here": the choice is not even offered, and an answer of WAYPOINT is none.
    game.run("service.get().cancel('judy-alvarez', 'x')");
    const again = await bridgeTurn(game.request(2, 'come over here'));
    const second = decisionHost({answer: 'WAYPOINT', turn: again});
    assert.equal(await decide(second.host, again, 'come over here', 'Coming.'), null);
    assert.match(second.chats[0].messages[0].content, /Answer with one word only: MEET, NONE/);
    assert.deepEqual(second.delivered, []);
    assert.equal(game.appointment(), null);
  } finally { game.close(); }
});

test('"never mind" on a call cancels a standing meeting, and does nothing when there is none', async () => {
  const game = luaSession();
  try {
    // Nothing is standing: she is not asked anything.
    const nothing = await bridgeTurn(game.request(1, "never mind, don't come"));
    const idle = decisionHost({answer: 'CANCEL', turn: nothing});
    assert.equal(await decide(idle.host, nothing, "never mind, don't come", 'Okay.'), null);
    assert.equal(idle.chats.length, 0, 'nothing to cancel: nothing is asked');
    // A meeting is made by the first call, then called off by the second.
    const first = await bridgeTurn(game.request(2, 'come meet me'));
    assert.equal(await decide(decisionHost({answer: 'MEET', turn: first}).host, first, 'come meet me', 'On my way.'), 'meet-here');
    game.receive(meetPacket(first));
    assert.equal(game.appointment().kind, 'here');
    const second = await bridgeTurn(game.request(3, "never mind, don't come"));
    assert.deepEqual(second.config.meet, {kinds: [], place: "Lizzie's Bar, Kabuki, Watson", cancel: true});
    assert.match(callMeetNote(parseCallMeetOffer(second.input.meetOffer), second.input.text), /calls it off|call it off/);
    const {host, delivered} = decisionHost({answer: 'CANCEL', turn: second});
    assert.equal(await decide(host, second, "never mind, don't come", "Okay, I'll stay put."), 'cancel-meet');
    assert.deepEqual(delivered, [{version: 1, token: second.config.token, meet: 'cancel-meet'}]);
    game.receive(meetPacket(second));
    assert.equal(game.appointment(), null, 'the appointment is gone: ' + game.logs().join(' | '));
  } finally { game.close(); }
});

test('a plain call makes nothing: no request to any model, no packet, no appointment', async () => {
  const game = luaSession();
  try {
    const turn = await bridgeTurn(game.request(1, 'how was your day, did you sleep'));
    const {host, chats, delivered} = decisionHost({answer: 'MEET', turn});
    assert.equal(planCallMeet(turn.actions.pending.meet, 'how was your day, did you sleep'), null);
    assert.equal(await decide(host, turn, 'how was your day, did you sleep', 'Fine, I slept.'), null);
    assert.equal(chats.length, 0, 'ordinary talk costs no request');
    assert.deepEqual(delivered, []); assert.deepEqual(written(turn.files), []);
    assert.equal(game.appointment(), null);
    // A line with meeting words that the model reads as none (she refused) makes nothing either.
    const asked = await bridgeTurn(game.request(2, 'come meet me'));
    const refused = decisionHost({answer: 'NONE', turn: asked});
    assert.equal(await decide(refused.host, asked, 'come meet me', "I can't, I'm busy tonight."), null);
    assert.equal(refused.chats.length, 1);
    assert.deepEqual(refused.delivered, []); assert.equal(game.appointment(), null);
    // A model that fails, or answers nonsense, is none as well.
    const broken = decisionHost({answer: 'banana', turn: asked});
    assert.equal(await decide(broken.host, asked, 'come meet me', 'Sure.'), null);
    const failing = decisionHost({turn: asked});
    failing.host.routes.mistral.chat = async () => { throw new Error('boom'); };
    assert.equal(await decide(failing.host, asked, 'come meet me', 'Sure.'), null);
    assert.ok(failing.logs.some(line => /call meeting decision failed/.test(line)));
    assert.equal(game.appointment(), null);
  } finally { game.close(); }
});

test('the decision never delays the reply: it starts after the reply, nothing waits for it, and a slow model only delays the decision', async () => {
  const game = luaSession();
  try {
    const turn = await bridgeTurn(game.request(1, 'come meet me'));
    let release; const gate = {promise: new Promise(done => { release = done; })};
    const {host, delivered, chats} = decisionHost({answer: 'MEET', gate, turn});
    // The reply is complete (the bridge has it); the decision is started and not awaited.
    const reply = {text: 'On my way.'};
    const pendingDecision = decide(host, turn, 'come meet me', reply.text);
    await new Promise(done => setImmediate(done));
    assert.equal(chats.length, 1, 'the request is out');
    assert.deepEqual(delivered, [], 'nothing yet: the model has not answered');
    assert.equal(reply.text, 'On my way.', 'the reply was never held');
    release();
    assert.equal(await pendingDecision, 'meet-here');
    assert.equal(delivered.length, 1);
  } finally { game.close(); }
});

test('the decision is background work: it asks as background, on the Local AI it gives way to any turn, and a stale or refused hand-over makes nothing', async () => {
  const game = luaSession();
  try {
    const turn = await bridgeTurn(game.request(1, 'come meet me'));
    // The Local AI: the request is a background lease, and a turn that starts stops it (as it stops a summary).
    const seen = [];
    let release; const gate = {promise: new Promise(done => { release = done; })};
    const local = decisionHost({answer: 'MEET', gate, routeName: 'local', onConnect: options => seen.push(options), turn});
    const pending = decide(local.host, turn, 'come meet me', 'Sure.');
    await new Promise(done => setImmediate(done));
    assert.equal(seen[0].background, true, 'background priority on the Local AI');
    assert.equal(local.host.stoppable.size, 1, 'a turn can stop it');
    for (const stopper of [...local.host.stoppable]) stopper.abort();   // what the start of a turn does (TextProviderHost #reply)
    release();
    assert.equal(await pending, null);
    assert.deepEqual(local.delivered, [], 'put off by a turn: nothing was handed over');
    assert.ok(local.logs.some(line => /put off: a turn needed the local model/.test(line)));
    assert.equal(local.host.stoppable.size, 0);
    // Mistral: a background request too (it queues behind turns on the account's scheduler).
    const cloud = decisionHost({answer: 'MEET', turn});
    await decide(cloud.host, turn, 'come meet me', 'Sure.');
    assert.equal(cloud.chats.length, 1);
    // The game refuses the hand-over (the next turn revoked it): the decision reports nothing made.
    const next = await bridgeTurn(game.request(2, 'come meet me'));
    const refused = decisionHost({answer: 'MEET', turn: next}); refused.refuse();
    assert.equal(await decide(refused.host, next, 'come meet me', 'Sure.'), null);
    assert.ok(refused.logs.some(line => /was not accepted/.test(line)));
    // A real stale hand-over: a newer admit revoked this turn's pending.
    const old = await bridgeTurn(game.request(3, 'come meet me'));
    const files = old.files;
    const newer = old.actions.admit(old.prepared, {source: 'private-text', isCurrent: async () => true, isCurrentSync: () => true});
    assert.ok(newer);
    assert.equal(await old.actions.deliver({version: 1, token: old.config.token, meet: 'meet-here'}), false, 'the older token is refused');
    assert.deepEqual(written(files), []);
  } finally { game.close(); }
});

// ---- The game's checks -----------------------------------------------------------------------------------------------------------------

test('the Local AI\'s slot held for a moment by other background work: the decision asks again, a few times at most', async () => {
  const game = luaSession();
  try {
    const turn = await bridgeTurn(game.request(1, 'come meet me'));
    let refusals = 2;
    const local = decisionHost({answer: 'MEET', routeName: 'local', turn, onConnect: () => {}});
    local.host.routes.local.connect = async () => {
      if (refusals-- > 0) throw Object.assign(new Error('other background work is using the model'), {reason: 'busy', noRetry: true});
      return {apiKey: 'k'};
    };
    assert.equal(await decide(local.host, turn, 'come meet me', 'Sure.'), 'meet-here', 'the third ask went through');
    const stuck = decisionHost({answer: 'MEET', routeName: 'local', turn});
    stuck.host.routes.local.connect = async () => { throw Object.assign(new Error('a turn is using the model'), {reason: 'busy', noRetry: true}); };
    assert.equal(await decide(stuck.host, turn, 'come meet me', 'Sure.'), null, 'three tries and no more');
    assert.ok(stuck.logs.some(line => /call meeting decision failed/.test(line)));
  } finally { game.close(); }
});

test('the game refuses what the offer did not allow: a wrong token, a kind not offered, another request, a replay, an expired lease', async () => {
  const game = luaSession();
  try {
    const turn = await bridgeTurn(game.request(1, 'come meet me'));
    assert.equal(await turn.actions.deliver({version: 1, token: turn.config.token, meet: 'meet-waypoint'}), false, 'the bridge does not offer a waypoint here');
    assert.equal(await turn.actions.deliver({version: 1, token: turn.config.token, meet: 'cancel-meet'}), false);
    assert.equal(await turn.actions.deliver({version: 1, token: 'drive-00000000000000000099', meet: 'meet-here'}), false);
    assert.deepEqual(written(turn.files), []);
    assert.equal(await turn.actions.deliver({version: 1, token: turn.config.token, meet: 'meet-here'}), true);
    const good = meetPacket(turn);
    // Variations of a valid packet that the lease must refuse.
    for (const [name, change] of [
      ['a wrong meet token', packet => ({...packet, meetToken: 'meet-ffffffffffffffff'})],
      ['a kind the offer lacks', packet => ({...packet, meet: 'meet-waypoint'})],
      ['a cancel with nothing standing', packet => ({...packet, meet: 'cancel-meet'})],
      ['another request', packet => ({...packet, requestId: '1792531180-9-11147869ULL', generation: 9})],
      ['another person', packet => ({...packet, profileKey: 'panam-palmer'})],
      ['another world', packet => ({...packet, worldToken: 'other'})],
      ['a different offer', packet => ({...packet, meetOffer: {...packet.meetOffer, meet: {...packet.meetOffer.meet, etaMinutes: 10}}})],
      ['an expired packet', packet => ({...packet, expiresAt: 1792531179000})],
    ]) {
      game.receive(change(good));
      assert.equal(game.appointment(), null, name);
      assert.equal(game.lease().pending, true, name + ': the lease stands for the right packet');
    }
    game.receive(good);
    assert.equal(game.appointment().kind, 'here');
    // An offer that waited past its time-to-live is refused by the controller itself (180 s of wall time).
    const late = await bridgeTurn(game.request(2, 'come meet me'));
    await late.actions.deliver({version: 1, token: late.config.token, meet: 'meet-here'});
    game.run("service.get().cancel('judy-alvarez', 'x'); fake.wall = 1000");
    game.receive(meetPacket(late));
    assert.equal(game.appointment(), null, 'stale offer: ' + game.logs().slice(-2).join(' | '));
  } finally { game.close(); }
});

test('a made appointment is the same appointment as the text makes: her next turn carries the note, and the offer then is the cancel-only one', async () => {
  const game = luaSession();
  try {
    const turn = await bridgeTurn(game.request(1, 'come meet me'));
    await turn.actions.deliver({version: 1, token: turn.config.token, meet: 'meet-here'});
    game.receive(meetPacket(turn));
    assert.equal(game.appointment().phase, 'scheduled');
    const note = JSON.parse(game.run("return json.encode(service.appointmentTurn({district = 'Watson'}, 'judy-alvarez'))"));
    assert.ok(note.appointment, 'the appointment note is on the next turn: ' + JSON.stringify(note));
    const next = JSON.parse(game.request(2, 'come over here'));
    assert.equal(next.meetOffer.meet.unavailable, 'pending');
    assert.equal(next.meetOffer.meet.cancel, true);
  } finally { game.close(); }
});

// ---- Voice calls and Convai ---------------------------------------------------------------------------------------------------------------

test('a spoken call line is admitted from the voice source and decided from the transcript; Convai uses the action list', async () => {
  const game = luaSession();
  try {
    // The voice context is captured at the key press: V's words are not known yet, the note is there.
    const text = game.request(1, '[Microphone]', 'audio', 'private-voice');
    const turn = await bridgeTurn(text, {source: 'private-voice', change: prepared => ({...prepared, route: {...prepared.route, transport: 'microphone'}})});
    assert.ok(turn.config, 'a spoken call turn arms the meeting');
    assert.equal(turn.config.source, 'private-voice');
    assert.notEqual(callMeetNote(parseCallMeetOffer(turn.input.meetOffer), turn.input.text), '', 'the placeholder is not V\'s words: the note is there');
    const {host, delivered} = decisionHost({answer: 'MEET', turn});
    // The transcript is what the recording turned into; the decision reads that.
    assert.equal(await decide(host, turn, 'hey judy, can you come over to my place', 'Yeah, on my way.'), 'meet-here');
    assert.equal(delivered.length, 1);
    game.receive(meetPacket(turn));
    assert.equal(game.appointment().kind, 'here');
  } finally { game.close(); }
});

test('Convai: the call turn arms the action list and the model requests "Meet V Here"', async () => {
  const game = luaSession();
  try {
    game.run("fake.waypoint = {position = {x = 400, y = 250, z = 0}, place = 'Afterlife, Watson'}");
    const turn = await bridgeTurn(game.request(1, 'come meet me'));
    const window = new CompanionActionWindow({now: () => 1792531182000});
    assert.equal(window.open(turn.config), true, 'the window opens for the offer exactly as configFor made it');
    const prompt = CompanionActionWindow.contextText(turn.config);
    assert.match(prompt, new RegExp('Meet V Here ' + turn.config.token));
    assert.match(prompt, /Meet V At Waypoint/); assert.match(prompt, /Lizzie's Bar/); assert.match(prompt, /Afterlife, Watson/);
    assert.doesNotMatch(prompt, /Cancel Meeting/);
    assert.match(CompanionActionWindow.unavailableText(turn.config), /cannot accept a request to meet/);
    // A driving action name is not part of a call window.
    assert.equal(window.accept({actions: [{name: 'Drive To Waypoint ' + turn.config.token}]}), null);
    assert.equal(window.accept({actions: [{name: 'Cancel Meeting ' + turn.config.token}]}), null, 'not offered');
    const message = window.accept({actions: [{name: 'Meet V Here ' + turn.config.token, target: turn.config.token}]});
    assert.deepEqual(message, {version: 1, token: turn.config.token, meet: 'meet-here'});
    assert.equal(await turn.actions.deliver(message), true);
    game.receive(meetPacket(turn));
    assert.equal(game.appointment().kind, 'here');
    // The page publishes the exact action names with the context update.
    const published = [];
    const client = {isBotReady: true, room: {localParticipant: {sid: 'PA_1', publishData: async bytes => published.push(JSON.parse(new TextDecoder().decode(bytes)))}}};
    await publishCompanionActionContext(client, {text: 'x'}, turn.config);
    const names = published[0].data.action_config.actions;
    assert.deepEqual(names, ['Meet V Here ' + turn.config.token, 'Meet V At Waypoint ' + turn.config.token]);
    assert.match(published[0].data.action_config.objects[0].description, /meeting with V/);
  } finally { game.close(); }
});

test('Convai: a standing meeting is called off with "Cancel Meeting"', async () => {
  const game = luaSession();
  try {
    const first = await bridgeTurn(game.request(1, 'come meet me'));
    await first.actions.deliver({version: 1, token: first.config.token, meet: 'meet-here'});
    game.receive(meetPacket(first));
    const turn = await bridgeTurn(game.request(2, "never mind, don't come"));
    const window = new CompanionActionWindow({now: () => 1792531182000});
    assert.equal(window.open(turn.config), true);
    assert.match(CompanionActionWindow.contextText(turn.config), /Cancel Meeting/);
    const message = window.accept({actions: [{name: 'Cancel Meeting ' + turn.config.token}]});
    assert.deepEqual(message, {version: 1, token: turn.config.token, meet: 'cancel-meet'});
    assert.equal(await turn.actions.deliver(message), true);
    game.receive(meetPacket(turn));
    assert.equal(game.appointment(), null);
  } finally { game.close(); }
});

// ---- The wire --------------------------------------------------------------------------------------------------------------------------

test('the request keeps the offer for a holocall only, as the game sent it, and drops a malformed one without rejecting the line', () => {
  const game = luaSession();
  try {
    const wire = JSON.parse(game.request(1, 'come meet me'));
    const input = parseInput(JSON.stringify(wire));
    assert.deepEqual(input.meetOffer, wire.meetOffer);
    assert.deepEqual(input.holocall, {contact: 'judy', mode: 'audio'});
    const ordinary = parseInput(JSON.stringify({...wire, holocall: undefined}));
    assert.equal(ordinary.meetOffer, undefined, 'no call: no offer');
    const damaged = parseInput(JSON.stringify({...wire, meetOffer: {...wire.meetOffer, available: 'yes'}}));
    assert.ok(damaged && damaged.meetOffer === undefined, 'the line still goes through');
  } finally { game.close(); }
});

test('the source: the decision starts after the reply without being awaited, the note joins the volatile context, the game wires the call to the lease', () => {
  const bridge = read('./convai-bridge.mjs');
  const publish = bridge.slice(bridge.indexOf('async function publishResult('), bridge.indexOf('async function publishResult(') + 400);
  assert.match(publish, /decideCallMeet\(input, result, signal\)/);
  assert.doesNotMatch(publish, /await decideCallMeet/);
  assert.match(bridge, /void mistralHost\.decideMeet\(/);
  assert.match(bridge, /callMeetNote\(parseCallMeetOffer\(input\.meetOffer\), input\.text\)/);
  const init = read('../mod/init.lua');
  assert.match(init, /if context\.holocall then[^]*?if not context\.reaction then gameplayActions\.capture\(context, 'private-text'\) end[^]*?elseif context\.head then/);
  assert.match(init, /meetOffer = function\(entity, context\)[^]*?convaiMeetCallOffer/);
  assert.match(init, /queueMeet = function\(kind, offer, profileKey, requestId\)/);
  const host = read('./text-provider-host.mjs');
  assert.match(host, /background: route\.name === 'local', priority: 'background'\}\);\s*kind = parseCallMeetAnswer/);
});
