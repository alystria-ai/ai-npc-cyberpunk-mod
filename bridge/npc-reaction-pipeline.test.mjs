// The whole path of an ordinary NPC's reaction, end to end (docs/NPC_REACTIONS.md), with the real pieces on every step:
//   the Lua game half (mod/npc-reactions.lua + mod/gameplay-actions.lua, run in a Lua VM over a fake game) captures the offer and writes the
//   request exactly as mod/init.lua does (a JSON text) -> parseInput -> PlayerKnowledge.prepare (the router the bridge runs) -> CompanionActions
//   admit / configFor -> the text host (a fake chat for the model) or the Convai window -> CompanionActions.deliver -> the packet file text ->
//   back into the Lua lease -> the service starts the reaction.
// Before this test each half was tested alone; a turn that dropped between two of them would have shown nothing (2026-10-21: a live test offered
// the reaction again and again and nothing ever started, with no line in the bridge log). Offline: no game, no network.
import {test, mock} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import fengari from 'fengari';
import {parseInput} from './protocol.mjs';
import {PlayerKnowledge} from './player-knowledge.mjs';
import {CompanionActions, CompanionActionWindow} from './companion-actions.mjs';
import {TextProviderHost, mistralRoute} from './text-provider-host.mjs';
import {MistralProvider} from './mistral-key.mjs';
import {MistralMemory} from './mistral-memory.mjs';
import {PersonaBook} from './mistral-prompt.mjs';

const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;
const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const reactionsSource = read('../mod/npc-reactions.lua');
const actionsSource = read('../mod/gameplay-actions.lua');
const roster = [...JSON.parse(read('../characters/roster.json')), ...JSON.parse(read('../characters/archetype-roster.json'))];
const book = new PersonaBook(roster);

// ---- The Lua half ----------------------------------------------------------------------------------------------------------------

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

// A fake game around the real two modules, wired the way mod/init.lua wires them (the offer callback, queueReaction, the world, the log).
const GAME_LUA = `
calls, logs = {}, {}
now = 5000          -- the service clock, in seconds
ms = 1792531180000  -- the actions clock, in ms
raw = nil
state = {awaiting = false, speaking = false, heat = 0}
local function count(name) calls[name] = (calls[name] or 0) + 1 end
local natives = {
  key = function(npc) return npc.id end, alive = function() return true end, child = function() return false end,
  hostile = function() return false end, inCombat = function() return true end, safe = function() return false end,
  heat = function() return state.heat end, preventionReady = function() return true end,
  callPolice = function() count('callPolice'); state.heat = 1 end,
  makeHostile = function() count('makeHostile') end, startCombat = function() count('startCombat'); return 'x' end,
  engage = function() return 'x' end,
  awayPoints = function() return {{x = 50, y = 0, z = 0, gap = 40}} end,
  walkTo = function() count('walkTo'); return {id = 'cmd'} end, commandState = function() return 'Executing' end,
  -- The threat reactions' natives (docs/NPC_THREATS_COMMANDS.md); the person is a crowd pedestrian.
  crowd = function() return true end, crowdFear = function(_, _, phase) count('crowdFear' .. phase) end, temper = function() return 'neutral' end,
  hold = function() count('hold'); return {id = 'hold'} end,
}
local npc = {id = '11147869ULL'}
local Service = (function() ${reactionsSource} end)()
service = Service.new({natives = natives, clock = function() return now end,
  log = function(line) logs[#logs + 1] = line end, logOnce = function(key, line) logs[#logs + 1] = line end,
  player = function() return {name = 'V'} end, npcFor = function(entity) return entity == npc.id and npc or nil end,
  policy = {ours = function() return false end, spawned = function() return false end, protected = function() return false end, story = function() return false end},
  storyFlag = function() return false end, refusal = function() return nil end, release = function() count('release') end,
  awaiting = function() return state.awaiting end, speaking = function() return state.speaking end,
  threats = function() return state.threats == true end})
local world = {ready = true, worldToken = 'world-fixture', generation = 2}
local Actions = (function() ${actionsSource} end)()
actions = Actions.new({world = function() return world end, clock = function() return ms end,
  -- The ride, the fight and the follow are refused for a person who is not a companion (what the live request carried: followUnavailable).
  offer = function() return nil, {available = false, code = 'no-waypoint'} end,
  tacticOffer = function() return nil, {available = false, code = 'no-target'} end,
  followOffer = function() return nil, {available = false, reason = 'unavailable'} end,
  leaveOffer = function() return nil end,
  reactionOffer = function(entity, context) return service.offer(entity, context) end,
  queueReaction = function(kind, offer, entity, requestId) return service.start(kind, offer, entity, requestId) end,
  read = function() return raw end, decode = json.decode})
-- The request the game writes for V's message n to the person (the fields mod/init.lua sets before capture; the rest is not read by the bridge half).
function request(n, text)
  local context = {generation = n, entity = npc.id, name = 'Pamela Huerta', bodyType = 'Woman', profileKey = 'npc-corpo-resident-female',
    requestId = '1792531180-' .. n .. '-' .. npc.id, text = text, sentAt = 1792531180,
    archetype = {npcName = 'Pamela Huerta', district = 'Watson', category = 'resident', title = 'corporate worker', base = 'corpo-resident',
      area = 'LittleChina', affiliation = 'Civilian'}}
  actions.capture(context, 'private-text')
  return json.encode(context)
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
    // V's nth message, as the JSON text the game writes to runtime/last-input.json.
    request: (n, text) => run(`return request(${n}, ${JSON.stringify(text)})`),
    // The packet text the bridge wrote reaches the game's poll; then the service's clock runs on until the reaction has begun.
    receive: packet => run(`raw = ${JSON.stringify(packet)}; actions.update(true); return ''`),
    advance: seconds => run(`now = now + ${seconds}; service.update(); return ''`),
    threats: on => run(`state.threats = ${on ? 'true' : 'false'}; return ''`),
    logs: () => JSON.parse(run('return json.encode(logs)')),
    calls: () => JSON.parse(run('return json.encode(calls)')),
    lease: () => JSON.parse(run('local i = actions.inspect(); return json.encode({pending = i.pending, reaction = i.reaction, state = i.state})')),
    close: () => lua.lua_close(vm),
  };
}

// ---- The bridge half -------------------------------------------------------------------------------------------------------------

const BOUNDARY = {worldToken: 'world-fixture', generation: 2};
const GUARD = {endUserId: 'fixture-user', characterId: 'fixture-character', resetEpoch: 0, characterEpoch: 0};
function router(profileKey) {
  return new PlayerKnowledge({
    playerMemory: {route: () => ({endUserId: GUARD.endUserId, guard: GUARD}), isCurrent: value => JSON.stringify(value) === JSON.stringify(GUARD)},
    pack: {version: 1, id: 'pipeline-fixture', revision: 1, gameVersions: ['2.31'], profileKeys: [profileKey], sources: [], evidence: [], factAllowlist: {}, journalAllowlist: {}, rules: []},
    getBoundary: () => BOUNDARY, isWorldCurrent: () => true,
  });
}

function broker(files, logs, probe) {
  let sequence = 0;
  return new CompanionActions({now: () => 1792531182000, createToken: () => 'drive-' + String(++sequence).padStart(20, '0'),
    publish: async (packet, options) => {
      if (options?.isCurrent && !await options.isCurrent()) return false;
      if (options?.isCurrentSync && !options.isCurrentSync()) return false;
      files.push(packet); return true;
    }, ...(logs ? {log: line => logs.push(line)} : {}), ...(probe ? {probe} : {})});
}

const settle = () => new Promise(done => setTimeout(done, 20));
const THREAT = 'give me your money or i will hurt you';

// One turn through the bridge: the request text -> parse -> prepare -> admit -> config. Returns what the turn would run with.
async function bridgeTurn(requestText, {files = [], logs, probe, change} = {}) {
  const input = parseInput(requestText);
  assert.ok(input, 'the bridge accepts the request the game wrote');
  const knowledge = router(input.profileKey);
  const prepared = await knowledge.prepare(input, BOUNDARY);
  const actions = broker(files, logs, probe);
  const config = actions.admit(change ? change(prepared) : prepared, {source: 'private-text', isCurrent: () => knowledge.current(prepared),
    isCurrentSync: () => knowledge.currentSync(prepared)});
  return {input, prepared, actions, config};
}

async function textHost(reply, deliverAction, logs, actions) {
  const delivered = [];
  const provider = new MistralProvider({keyPath: 'k.txt', readText: async () => 'api-key=' + 'test' + 'x'.repeat(28) + '\n', writeText: async () => {}});
  await provider.load(); provider.setPreference('mistral'); provider.apply();
  const route = mistralRoute({provider: {apiKey: 'test' + 'x'.repeat(28), noteSuccess() {}, noteLimit() {}, limit: null}, gapMs: 0});
  route.chat = async options => {
    options.onDelta?.(reply);
    return {text: reply, model: 'm', finishReason: 'stop', usage: {}, attempts: 1, failed: [], trace: {}};
  };
  const host = new TextProviderHost({provider, memory: await MistralMemory.open({path: null}), personas: book, routes: {mistral: route},
    log: line => logs.push(line), deliverAction: async message => { delivered.push(message); return deliverAction ? deliverAction(message) : true; },
    ...(actions ? {traceReaction: (token, info) => actions.traceReaction(token, info)} : {})});
  return {host, delivered};
}
const turnConfig = (input, config) => ({text: input.text, context: 'CURRENT PERSON', sessionId: 's',
  contextParts: {now: 'Right now: you are with V in person.', notes: '', world: 'Night City.', volatile: 'Whether you ask V anything is your own call.'},
  local: {profileKey: input.profileKey, name: input.name, channel: 'private', ambientKey: 'npc-1:' + input.entity}, companionAction: config});

// ---- The turns --------------------------------------------------------------------------------------------------------------------

test('Mistral / Local AI: V\'s first message threatens, the model opens with the tag, and the person calls the police', async () => {
  const game = luaSession();
  try {
    const requestText = game.request(1, THREAT);
    assert.deepEqual(game.lease(), {pending: true, reaction: true, state: 'available'}, 'the first message earns the offer: ' + game.logs().join(' | '));
    const wire = JSON.parse(requestText);
    assert.deepEqual(wire.reactionOffer.kinds, ['leave', 'call-police']);
    const files = [], bridgeLogs = [], trace = [];
    const turn = await bridgeTurn(requestText, {files, logs: trace});
    assert.ok(turn.config, 'the bridge admitted the turn and armed the reaction');
    assert.deepEqual(turn.config.reaction, {kinds: ['leave', 'call-police']});
    const {host, delivered} = await textHost('[call-police] Get away from me, I am calling the cops right now!', message => turn.actions.deliver(message), bridgeLogs, turn.actions);
    const result = await host.reply(turnConfig(turn.input, turn.config));
    await settle();
    assert.equal(result.text, 'Get away from me, I am calling the cops right now!');
    assert.deepEqual(delivered, [{version: 1, token: turn.config.token, reaction: 'call-police'}]);
    assert.deepEqual(trace, ['NPC reaction: person=npc-corpo-resident-female offered=leave,call-police admitted=yes route=text tag=call-police delivered=yes'],
      'exactly one line for the turn');
    assert.deepEqual(bridgeLogs, [], 'no second line from the host');
    const packet = files.find(item => item.action === 'npc-reaction');
    assert.ok(packet, 'a packet for the game was written: ' + JSON.stringify(files.map(item => item.action)));
    // The packet text reaches the game's poll; the reaction is accepted at once and starts when the reply has been heard.
    game.receive(JSON.stringify(packet));
    assert.ok(game.logs().some(line => /^NPC reaction accepted: call-police/.test(line)), game.logs().join(' | '));
    game.advance(0.1);
    assert.equal(game.calls().callPolice, undefined, 'not before the reply has been over for a moment');
    game.advance(2);
    assert.equal(game.calls().callPolice, 1, 'the police call was made: ' + game.logs().join(' | '));
    assert.ok(game.logs().some(line => /^NPC reaction: police call sent/.test(line)));
  } finally { game.close(); }
});

test('Convai: the same first message, the model requests the Call Police action, and the person calls the police', async () => {
  const game = luaSession();
  try {
    const files = [], trace = [];
    const turn = await bridgeTurn(game.request(1, THREAT), {files, logs: trace});
    assert.ok(turn.config, 'the bridge admitted the turn');
    // What the realtime page does with the offer: the window opens, the prompt carries the sentence, the model's action proposal is accepted.
    const window = new CompanionActionWindow({now: () => 1792531182000});
    assert.equal(window.open(turn.config), true, 'the window opens for the offer exactly as configFor made it');
    assert.match(CompanionActionWindow.contextText(turn.config), /Call Police drive-/);
    const message = window.accept({actions: [{name: 'Call Police ' + turn.config.token, target: turn.config.token}]});
    assert.deepEqual(message, {version: 1, token: turn.config.token, reaction: 'call-police'});
    assert.equal(await turn.actions.deliver(message), true);
    assert.deepEqual(trace, ['NPC reaction: person=npc-corpo-resident-female offered=leave,call-police admitted=yes route=convai tag=call-police delivered=yes']);
    game.receive(JSON.stringify(files.find(item => item.action === 'npc-reaction')));
    game.advance(0.1); game.advance(2);
    assert.equal(game.calls().callPolice, 1, game.logs().join(' | '));
  } finally { game.close(); }
});

test('Convai: a model that asks for no action leaves one line after the window closes, with what the page saw of the offer', async () => {
  const game = luaSession();
  mock.timers.enable({apis: ['setTimeout']});
  try {
    const trace = [];
    const turn = await bridgeTurn(game.request(1, THREAT), {logs: trace, probe: async () => 'convai=allowed:true privateManual:true verified:true armed:true published:1 accepted:0 skipped:0 skip:- ack:success'});
    assert.ok(turn.config);
    turn.actions.endTurn(turn.prepared.input);   // the bridge's input of the turn is the prepared one
    assert.deepEqual(trace, [], 'the window stays open for a late action');
    mock.timers.tick(10_000);
    await new Promise(done => setImmediate(done));
    assert.deepEqual(trace, ['NPC reaction: person=npc-corpo-resident-female offered=leave,call-police admitted=yes route=- tag=none(no-action-requested) delivered=-'
      + ' convai=allowed:true privateManual:true verified:true armed:true published:1 accepted:0 skipped:0 skip:- ack:success']);
    // A late action after the line is still handed over, quietly (the line was written once).
    assert.equal(await turn.actions.deliver({version: 1, token: turn.config.token, reaction: 'leave'}), true);
    assert.equal(trace.length, 1);
  } finally { mock.timers.reset(); game.close(); }
});

test('a turn that arms nothing says which rule stopped it, and a malformed offer is named', async () => {
  const game = luaSession();
  try {
    const requestText = game.request(1, THREAT);
    for (const [change, why] of [
      [p => ({...p, sendAllowed: false}), 'send-not-allowed'],
      [p => ({...p, route: {...p.route, channel: 'phone'}}), 'channel:phone'],
      [p => ({...p, input: {...p.input, requestId: '1-2-3ULL'}}), 'request-id'],
      [p => ({...p, input: {...p.input, reactionOffer: {...p.input.reactionOffer, actor: {id: '9ULL', key: p.input.profileKey}}}}), 'owner-mismatch'],
      [p => ({...p, worldToken: ''}), 'world-binding'],
    ]) {
      const trace = [];
      const turn = await bridgeTurn(requestText, {logs: trace, change});
      assert.equal(turn.config, null, why);
      assert.deepEqual(trace, [`NPC reaction: person=npc-corpo-resident-female offered=leave,call-police admitted=no(${why}) route=- tag=- delivered=-`], why);
    }
    // The world went stale between the parse and the admit.
    const stale = [];
    const input = parseInput(requestText), knowledge = router(input.profileKey), prepared = await knowledge.prepare(input, BOUNDARY);
    const actions = broker([], stale);
    assert.equal(actions.admit(prepared, {source: 'private-text', isCurrent: async () => false, isCurrentSync: () => false}), null);
    assert.match(stale[0], /admitted=no\(stale-world\)/);
    // An offer the game sent that the parser cannot read is named, not lost.
    const damaged = JSON.parse(requestText); damaged.reactionOffer.kinds = ['teleport'];
    const trace = [];
    const lost = await bridgeTurn(JSON.stringify(damaged), {logs: trace});
    assert.equal(lost.input.reactionOffer, undefined); assert.equal(lost.input.reactionOfferDropped, 'malformed-offer');
    assert.equal(lost.config?.reaction, undefined);
    assert.deepEqual(trace, ['NPC reaction: person=npc-corpo-resident-female offered=? admitted=no(malformed-offer) route=- tag=- delivered=-']);
  } finally { game.close(); }
});

test('a hand-over the game side refuses names the reason: the token of an older turn, a reaction not offered, a turn revoked first', async () => {
  const game = luaSession();
  try {
    const trace = [];
    const turn = await bridgeTurn(game.request(1, THREAT), {logs: trace});
    assert.equal(await turn.actions.deliver({version: 1, token: turn.config.token, reaction: 'attack'}), false);
    assert.deepEqual(trace, ['NPC reaction: person=npc-corpo-resident-female offered=leave,call-police admitted=yes route=convai tag=attack delivered=no(not-offered)']);
    const second = [];
    const next = await bridgeTurn(game.request(2, THREAT), {logs: second});
    next.actions.traceReaction(next.config.token, {route: 'text', tag: 'leave'});
    await next.actions.revoke();
    assert.deepEqual(second, ['NPC reaction: person=npc-corpo-resident-female offered=leave,call-police admitted=yes route=text tag=leave delivered=no(revoked)']);
    assert.equal(await next.actions.deliver({version: 1, token: next.config.token, reaction: 'leave'}), false);
    assert.equal(second.length, 1, 'once');
  } finally { game.close(); }
});

test('the reaction arrives for a person who threatened later too, and a polite message offers it without the model using it', async () => {
  const game = luaSession();
  try {
    game.request(1, 'good evening');
    const files = [], logs = [], trace = [];
    const second = await bridgeTurn(game.request(2, THREAT), {files, logs: trace});
    assert.ok(second.config?.reaction, 'the second message carries the offer too');
    const {host, delivered} = await textHost('[none] I do not carry cash, sorry.', undefined, logs, second.actions);
    await host.reply(turnConfig(second.input, second.config));
    await settle();
    assert.deepEqual(delivered, [], '[none] hands nothing over');
    assert.deepEqual(trace, ['NPC reaction: person=npc-corpo-resident-female offered=leave,call-police admitted=yes route=text tag=none(no-tag) delivered=-']);
  } finally { game.close(); }
});

test('threats switch on: "get down" through every real piece, the lease takes the echo with its flag, and the crowd person cowers with the crowd\'s own fear', async () => {
  const game = luaSession();
  try {
    game.threats(true);
    const requestText = game.request(1, 'Get down on the ground, now!');
    assert.deepEqual(JSON.parse(requestText).reactionOffer, {available: true, actor: {id: '11147869ULL', key: 'npc-corpo-resident-female'},
      kinds: ['leave', 'call-police', 'cower', 'get-down', 'stop'], threats: true}, 'the game offers the threat kinds with the switch on');
    const files = [], logs = [], trace = [];
    const turn = await bridgeTurn(requestText, {files, logs: trace});
    assert.deepEqual(turn.config.reaction, {kinds: ['leave', 'call-police', 'get-down'], threats: true}, 'the words left the one command');
    const {host, delivered} = await textHost('[obey] Okay, okay, I am down, please do not hurt me!', message => turn.actions.deliver(message), logs, turn.actions);
    await host.reply(turnConfig(turn.input, turn.config));
    await settle();
    assert.deepEqual(delivered, [{version: 1, token: turn.config.token, reaction: 'get-down'}]);
    assert.deepEqual(trace, ['NPC reaction: person=npc-corpo-resident-female offered=leave,call-police,get-down admitted=yes route=text tag=get-down delivered=yes screen=get-down']);
    game.receive(JSON.stringify(files.find(item => item.action === 'npc-reaction')));
    assert.ok(game.logs().some(line => /^NPC reaction accepted: get-down/.test(line)), 'the lease took the packet: ' + game.logs().join(' | '));
    game.advance(0.1); game.advance(2);
    assert.equal(game.calls().crowdFear2, 1, 'the crowd person cowers: ' + game.logs().join(' | '));
    assert.equal(game.calls().walkTo, undefined);
    // Switched off again: the next message is offered exactly as before the threat reactions.
    game.threats(false);
    assert.deepEqual(JSON.parse(game.request(2, 'Get down!')).reactionOffer, {available: true, actor: {id: '11147869ULL', key: 'npc-corpo-resident-female'},
      kinds: ['leave', 'call-police']});
  } finally { game.close(); }
});
