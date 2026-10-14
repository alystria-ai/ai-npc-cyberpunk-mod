import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import fengari from 'fengari';
import {parseGameDialogue, selectGameDialogue, gameDialogueContext, episodes, MAX_AGE, MAX_LINES, MAX_CHARS}
  from './game-dialogue.mjs';
import {parseInput} from './protocol.mjs';
import {conversationContext} from './quest-context.mjs';
import {turnKey} from './group-lookahead.mjs';
import {parsePhoneState} from './phone-chat.mjs';

const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;
const source = readFileSync(new URL('../mod/game-dialogue.lua', import.meta.url), 'utf8');
const groupSource = readFileSync(new URL('../mod/group-chat.lua', import.meta.url), 'utf8');
const initSource = readFileSync(new URL('../mod/init.lua', import.meta.url), 'utf8');
const microphoneSource = readFileSync(new URL('../mod/microphone.lua', import.meta.url), 'utf8');
const phoneSource = readFileSync(new URL('../mod/phone-chat.lua', import.meta.url), 'utf8');

// ---------------------------------------------------------------- bridge side
let serial = 0;
const line = (age, fields) => ({id: `g-${++serial}`, age, kind: 'line', channel: 'scene', speaker: 'npc', ...fields});
const v = (age, text, fields = {}) => line(age, {speaker: 'v', text, ...fields});
const judy = (age, text, fields = {}) => line(age, {entity: '11ULL', profileKey: 'judy-alvarez', name: 'Judy', text, ...fields});
const river = (age, text, fields = {}) => line(age, {entity: '22ULL', profileKey: 'river-ward', name: 'River', text, ...fields});
const snapshot = lines => ({version: 1, status: 'ready', lines});
const turn = (lines, extra = {}) => ({requestId: '100-1-11ULL', generation: 1, entity: '11ULL', profileKey: 'judy-alvarez',
  name: 'Judy', bodyType: 'WomanAverage', text: 'So what now?', gameDialogue: snapshot(lines), ...extra});
const texts = input => selectGameDialogue(input).map(row => row.text);

test('the snapshot parser keeps bounded public fields and fails closed without losing the message', () => {
  const rows = [judy(30, 'You <b>came</b>\nback.'), v(25, 'Had to.'),
    {id: 'g-x', age: 5, kind: 'choice', channel: 'scene', speaker: 'v', text: '[Hug her]', addressee: 'judy-alvarez',
      present: ['judy-alvarez', 'judy-alvarez'], secret: 'dropped'}];
  const parsed = parseGameDialogue(snapshot(rows));
  assert.equal(parsed.status, 'ready');
  assert.equal(parsed.lines[0].text, 'You came back.');
  assert.deepEqual(parsed.lines[2], {id: 'g-x', age: 5, kind: 'choice', channel: 'scene', speaker: 'v', text: '[Hug her]',
    addressee: 'judy-alvarez', present: ['judy-alvarez']});
  assert.deepEqual(parseGameDialogue({version: 1, status: 'ready', lines: {}}).lines, []);
  assert.equal(parseGameDialogue(undefined), undefined);
  for (const bad of [null, {}, {version: 2, status: 'ready', lines: []}, {version: 1, status: 'ready'},
    snapshot([{...judy(1, 'x'), age: -1}]), snapshot([{...judy(1, 'x'), kind: 'bark'}]),
    snapshot([{...judy(1, 'x'), entity: 'abc'}]), snapshot([{...judy(1, 'x'), profileKey: 'Judy Alvarez'}]),
    snapshot([{...judy(1, 'x'), text: 'LocKey#1234'}]), snapshot([{...judy(1, 'x'), text: 'y'.repeat(601)}]),
    snapshot([{...judy(1, 'x'), kind: 'choice'}]), snapshot([judy(1, 'a'), {...judy(2, 'b'), id: 'g-dup'}, {...judy(3, 'c'), id: 'g-dup'}]),
    snapshot(Array.from({length: 49}, (_, i) => judy(i, 'x')))]) {
    assert.equal(parseGameDialogue(bad).status, 'unavailable', JSON.stringify(bad)?.slice(0, 120));
    const parsed = parseInput(JSON.stringify(turn([], {gameDialogue: bad})));
    assert.equal(parsed.text, 'So what now?');
    assert.equal(parsed.gameDialogue.status, 'unavailable');
    assert.equal(gameDialogueContext(parsed), '');
  }
  const kept = parseInput(JSON.stringify(turn([judy(10, 'Hey.')])));
  assert.equal(kept.gameDialogue.lines[0].text, 'Hey.');
  assert.equal(parseInput(JSON.stringify({...turn([]), gameDialogue: undefined})).gameDialogue, undefined);
});

test('only an episode the addressed character took part in is used, and never an unrelated private scene', () => {
  const lines = [river(170, 'Joss is worried.'), v(165, 'I will talk to her.'), river(160, 'Thanks, V.'),
    judy(60, 'Took you long enough.'), v(55, 'Traffic.'), judy(50, 'Sure it was.')];
  assert.equal(episodes(parseGameDialogue(snapshot(lines)).lines).length, 2);
  assert.deepEqual(texts(turn(lines)), ['Took you long enough.', 'Traffic.', 'Sure it was.']);
  const forRiver = turn(lines, {entity: '22ULL', profileKey: 'river-ward', name: 'River'});
  assert.deepEqual(texts(forRiver), ['Joss is worried.', 'I will talk to her.', 'Thanks, V.']);
  // Nobody involved: nothing at all, not even V's own lines.
  assert.deepEqual(texts(turn(lines, {entity: '33ULL', profileKey: 'panam-palmer', name: 'Panam'})), []);
  // Another speaker inside the same live scene stays (others present in that scene).
  const scene = [judy(40, 'This is Maiko.'), line(38, {entity: '44ULL', profileKey: 'maiko-maeda', name: 'Maiko', text: 'Charmed.'}),
    v(36, 'Likewise.')];
  assert.deepEqual(texts(turn(scene)), ['This is Maiko.', 'Charmed.', 'Likewise.']);
  // A new speaker after a pause is a different scene.
  const later = [judy(100, 'Bye, V.'), v(98, 'Later.'), river(70, 'Got a minute?'), v(68, 'Sure.')];
  assert.deepEqual(texts(turn(later)), ['Bye, V.', 'Later.']);
});

test('a mod companion standing next to V counts for a scene, but phone calls are only for the caller', () => {
  const scene = [river(40, 'Need a hand with Randy.', {present: ['judy-alvarez']}), v(35, 'Count me in.', {present: ['judy-alvarez']})];
  assert.deepEqual(texts(turn(scene)), ['Need a hand with Randy.', 'Count me in.']);
  const call = [line(30, {channel: 'phone', entity: '55ULL', profileKey: 'panam-palmer', name: 'Panam', contact: 'panam',
      text: 'Get to the camp.', present: ['judy-alvarez']}),
    v(25, 'On my way.', {channel: 'phone', present: ['judy-alvarez']})];
  assert.deepEqual(texts(turn(call)), []);
  const panam = turn(call, {entity: '66ULL', profileKey: 'panam-palmer', name: 'Panam'});
  assert.deepEqual(texts(panam), ['Get to the camp.', 'On my way.']);
  assert.match(gameDialogueContext(panam), /\[phone call\] You: "Get to the camp\."/);
  assert.match(gameDialogueContext(panam), /\[phone call\] V: "On my way\."/);
  // A call never merges with the in-person scene right before it.
  const mixed = [judy(60, 'Your phone.'), ...call];
  assert.deepEqual(texts(turn(mixed)), ['Your phone.']);
});

test('barks and crowd chatter count only from the addressed actor; a resident profile is never an identity', () => {
  const crowd = (age, entity, text) => line(age, {channel: 'ambient', entity, name: 'Pedestrian', text});
  const lines = [judy(40, 'Stay close.'), crowd(38, '77ULL', 'Watch it, choom!'), v(36, 'Will do.'),
    line(35, {channel: 'ambient', entity: '11ULL', profileKey: 'judy-alvarez', name: 'Judy', text: 'Hm.'})];
  assert.deepEqual(texts(turn(lines)), ['Stay close.', 'Will do.', 'Hm.']);
  const pedestrian = turn(lines, {entity: '77ULL', profileKey: 'resident-male', name: 'Pedestrian'});
  assert.deepEqual(texts(pedestrian), ['Stay close.', 'Watch it, choom!', 'Will do.']);
  assert.match(gameDialogueContext(pedestrian), /You: "Watch it, choom!"/);
  // Another resident (same generic profile, different body) gets nothing.
  assert.deepEqual(texts(turn(lines, {entity: '78ULL', profileKey: 'resident-male'})), []);
  // Generic profile keys on lines never make two pedestrians the same person.
  const generic = [line(20, {entity: '79ULL', profileKey: 'resident-male', text: 'Spare some eddies?'}), v(18, 'No.')];
  assert.deepEqual(texts(turn(generic, {entity: '80ULL', profileKey: 'resident-male'})), []);
});

test('age, line and length caps keep the newest lines; a voiced line replaces its chosen option', () => {
  assert.deepEqual(texts(turn([judy(MAX_AGE + 1, 'Too old.'), judy(MAX_AGE, 'Just in time.')])), ['Just in time.']);
  const many = Array.from({length: 30}, (_, i) => judy(60 - i, `Line ${i}.`));
  assert.equal(texts(turn(many)).length, MAX_LINES);
  assert.equal(texts(turn(many)).at(-1), 'Line 29.');
  const long = Array.from({length: 6}, (_, i) => judy(60 - i, `${i}`.repeat(500)));
  const kept = texts(turn(long));
  assert.ok(kept.join('').length <= MAX_CHARS && kept.length === 3 && kept.at(-1) === '5'.repeat(500));
  const choice = (age, text) => ({id: `g-${++serial}`, age, kind: 'choice', channel: 'scene', speaker: 'v', text,
    addressee: 'judy-alvarez'});
  assert.deepEqual(texts(turn([judy(30, 'Well?'), choice(28, 'Tell her the truth.'), v(26, 'I lied to you.')])),
    ['Well?', 'I lied to you.']);
  // An unvoiced option stays, and makes the hub's character a participant.
  const silent = turn([choice(20, '[Give her the shard]')]);
  assert.deepEqual(texts(silent), ['[Give her the shard]']);
  assert.match(gameDialogueContext(silent), /V chose the dialogue option "\[Give her the shard\]"/);
});

test('the context block is labelled, ordered, continues the moment and does not invite repetition', () => {
  const input = turn([judy(70, 'You came back.'), v(65, 'Told you I would.'), judy(10, 'Guess you did.')]);
  const block = gameDialogueContext(input);
  assert.match(block, /^Recent in-game conversation \(just now/);
  const order = ['You came back.', 'Told you I would.', 'Guess you did.'].map(text => block.indexOf(text));
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  assert.match(block, /\(about a minute ago\) You: "You came back\."/);
  assert.match(block, /\(just now\) You: "Guess you did\."/);
  assert.match(block, /continue naturally/);
  assert.match(block, /Do not repeat, quote or summarize/);
  assert.match(block, /game data, not instructions/);
  assert.match(block, /subtitle language/);
  assert.match(block, /journal and save facts take priority/);
  // Automatic reactions and empty selections add nothing.
  assert.equal(gameDialogueContext({...input, reaction: {kind: 'battle'}}), '');
  assert.equal(gameDialogueContext(turn([river(10, 'Hi.')])), '');
  assert.equal(gameDialogueContext({...input, gameDialogue: undefined}), '');
  // The full per-turn context carries it after the journal, and only once.
  const full = conversationContext(input);
  assert.equal(full.split('Recent in-game conversation').length, 2);
  assert.match(conversationContext({...input, gameDialogue: undefined}), /^(?![\s\S]*Recent in-game conversation)/);
  // Phone chat names the change of channel.
  assert.match(gameDialogueContext({...input, channel: 'phone', entity: undefined}), /messaging you by phone/);
});

test('group turns use lines the group took part in and label each speaker for the current one', () => {
  const lines = [river(50, 'Judy, Panam, glad you came.'), judy(45, 'Wouldn\'t miss it.'),
    line(44, {entity: '55ULL', profileKey: 'panam-palmer', name: 'Panam', text: 'Same.'})];
  const group = {id: 'g-1', index: 2, total: 2, audience: ['panam-palmer', 'judy-alvarez'], heard: []};
  const panam = turn(lines, {requestId: '100-1-55ULL', entity: '55ULL', profileKey: 'panam-palmer', name: 'Panam', group});
  const block = gameDialogueContext(panam);
  assert.match(block, /River: "Judy, Panam, glad you came\."/);
  assert.match(block, /Judy: "Wouldn't miss it\."/);
  assert.match(block, /You \(Panam\): "Same\."/);
  // A scene only one member was in still counts for the group (that member shares it).
  const alone = turn([river(30, 'Just us.'), v(28, 'Yeah.')], {entity: '55ULL', profileKey: 'panam-palmer', name: 'Panam',
    group: {...group, audience: ['panam-palmer', 'river-ward']}});
  assert.deepEqual(texts(alone), ['Just us.', 'Yeah.']);
  // Prepared next speakers claim only the same snapshot.
  const parsed = parseInput(JSON.stringify(panam));
  const other = parseInput(JSON.stringify({...panam, gameDialogue: snapshot([judy(1, 'Different.')])}));
  assert.notEqual(turnKey(parsed), turnKey(other));
  assert.equal(turnKey(parsed), turnKey(parseInput(JSON.stringify(panam))));
});

test('phone chat state carries the snapshot and scopes it by the contact profile', () => {
  const state = {version: 1, world: 'lua-world-1', updated: 1, active: true,
    request: {id: 'lua-world-1-1', contact: 'judy', text: 'About earlier', gameDialogue: snapshot([judy(20, 'See you tonight.')])}};
  const parsed = parsePhoneState(JSON.stringify(state));
  assert.equal(parsed.request.gameDialogue.lines.length, 1);
  const block = gameDialogueContext({...parsed.request, profileKey: 'judy-alvarez', channel: 'phone'});
  assert.match(block, /You: "See you tonight\."/);
  assert.equal(gameDialogueContext({...parsed.request, profileKey: 'panam-palmer', channel: 'phone'}), '');
  const broken = parsePhoneState(JSON.stringify({...state, request: {...state.request, gameDialogue: {version: 1, status: 'ready', lines: 'x'}}}));
  assert.equal(broken.request.text, 'About earlier');
  assert.equal(broken.request.gameDialogue.status, 'unavailable');
});

// ---------------------------------------------------------------- Lua adapter
function runLua(code) {
  const vm = lauxlib.luaL_newstate(); lualib.luaL_openlibs(vm);
  try {
    const status = lauxlib.luaL_dostring(vm, to_luastring(code));
    const error = status === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(vm, -1));
    const line = Number(/\]:(\d+):/.exec(error)?.[1]);
    assert.equal(status, lua.LUA_OK, error + (line ? '\n' + code.split('\n')[line - 1] : ''));
    lua.lua_getglobal(vm, to_luastring('RESULT'));
    return lua.lua_isstring(vm, -1) ? to_jsstring(lua.lua_tostring(vm, -1)) : null;
  } finally { lua.lua_close(vm); }
}
// Minimal JSON encoder with CET's convention: an empty table encodes as {}.
const encoder = `
local function encode(value)
  local kind = type(value)
  if kind == 'string' then return '"' .. value:gsub('[%c"\\\\]', function(c) return string.format('\\\\u%04x', c:byte()) end) .. '"' end
  if kind == 'number' then return string.format('%d', value) end
  if kind == 'boolean' then return tostring(value) end
  if kind ~= 'table' then return 'null' end
  if #value > 0 then
    local parts = {}
    for _, item in ipairs(value) do parts[#parts + 1] = encode(item) end
    return '[' .. table.concat(parts, ',') .. ']'
  end
  local keys, parts = {}, {}
  for key in pairs(value) do keys[#keys + 1] = key end
  table.sort(keys)
  for _, key in ipairs(keys) do parts[#parts + 1] = encode(tostring(key)) .. ':' .. encode(value[key]) end
  return '{' .. table.concat(parts, ',') .. '}'
end`;
const adapter = `
${encoder}
local api = (function() ${source} end)()
local now, enabled, present = 1000, true, {}
local player = {id = '99ULL'}
local state = {combat = false, braindance = false, replacer = false, call = nil}
local subtitles = {serial = 0}
local hubActive = 7
local N = {
  player = function() return player end, ready = function(p) return p ~= nil end,
  entity = function(o) return o.id end, braindance = function() return state.braindance end,
  replacer = function() return state.replacer end, playerCombat = function() return state.combat end,
  npcCombat = function(o) return o.combat == true end, isVehicle = function(o) return o.vehicle == true end,
  call = function() return state.call end, lineType = function(value) return value end,
  text = function(line) return line.text end,
  speakerName = function(line) return line.speakerName or (line.speaker and line.speaker.name) end,
  lineId = function(line) return tostring(line.id) end, lineNumber = function(line) return tonumber(line.id) end,
  fromVariant = function(value) return value end,
  dialogChoice = function(value) return value.isSuccess == true and value.visualizerType == 'Dialog' end,
  activeHub = function() return hubActive end, localized = function(text) return text end,
  subtitles = function() return subtitles end}
local profiles = {['11ULL'] = {'judy-alvarez', 'Judy'}, ['22ULL'] = {'river-ward', 'River'},
  ['77ULL'] = {'resident-female', 'NC Resident'}}
local dialogue = api.new({native = N, now = function() return now end, enabled = function() return enabled end,
  resolve = function(speaker) local p = profiles[speaker.id]; if p then return p[1], p[2] end end,
  resolveName = function(name) if name == 'Judy' then return 'judy-alvarez' end end,
  contactKey = function(contact) if contact == 'panam' then return 'panam-palmer' end end,
  present = function() return present end})
local JUDY, RIVER, CROWD = {id = '11ULL', name = 'Judy'}, {id = '22ULL', name = 'River'}, {id = '77ULL', name = 'Pedestrian'}
local nextId = 100
local function show(speaker, text, kind, extra)
  nextId = nextId + 1
  local line = {id = nextId, type = kind or 'Regular', speaker = speaker, text = text}
  for key, value in pairs(extra or {}) do line[key] = value end
  return dialogue:line(line, 'show'), line
end
local function rows() local snap = dialogue:capture(); return snap and snap.lines or {} end
`;
const lua$ = body => runLua(adapter + '\n' + body);

test('the adapter records scene lines with speaker identity, V lines and nearby companions', () => {
  const raw = lua$(`
    present = {'judy-alvarez', 'resident-male', 'judy-alvarez'}
    assert(show(RIVER, 'Joss wants to see you.'))
    now = now + 3
    assert(show(player, 'Let\\'s go.'))
    local lines = rows()
    assert(#lines == 2)
    assert(lines[1].speaker == 'npc' and lines[1].entity == '22ULL' and lines[1].profileKey == 'river-ward')
    assert(lines[1].name == 'River' and lines[1].channel == 'scene' and lines[1].age == 3)
    assert(#lines[1].present == 1 and lines[1].present[1] == 'judy-alvarez')
    assert(lines[2].speaker == 'v' and lines[2].entity == nil and lines[2].profileKey == nil and lines[2].age == 0)
    RESULT = encode(dialogue:capture())`);
  const parsed = parseGameDialogue(JSON.parse(raw));
  assert.equal(parsed.status, 'ready');
  assert.deepEqual(texts({...turn([]), gameDialogue: parsed}), ['Joss wants to see you.', 'Let\'s go.']);
});

test('both subtitle hooks and repeated lines record once; the mod\'s own replies never record', () => lua$(`
  local _, line = show(JUDY, 'Hey, V.')
  assert(dialogue:line(line, 'event') == false)
  assert(show(JUDY, 'Hey, V.') == false, 'same words from the same speaker within seconds')
  now = now + 10
  assert(show(JUDY, 'Hey, V.'), 'a real repeat later is a new line')
  subtitles.serial = 5
  local own = {id = 0x436F6E760000 + 4, type = 'OwnerlessRegular', speakerName = 'Judy', text = 'AI reply'}
  assert(dialogue:line(own, 'show') == false)
  subtitles.line = {id = 'current'}
  assert(dialogue:line({id = 'current', type = 'OwnerlessRegular', speakerName = 'Judy', text = 'Another'}, 'show') == false)
  local status = dialogue:status()
  assert(status.hooks.show == 5 and status.hooks.event == 1 and status.skipped['mod-reply'] == 2)
  assert(status.skipped.duplicate == 1 and status.skipped.repeated == 1 and #rows() == 2)
`));

test('game voice lines are reported to the add-on host once each, with their own duration or an estimate; the mod\'s own replies, crowd chatter and TV never are', () => lua$(`
  local heard, wanted = {}, true
  local second = api.new({native = N, now = function() return now end, enabled = function() return false end,
    onGameLineWanted = function() return wanted end,
    onGameLine = function(seconds, kind, measured) heard[#heard + 1] = {seconds = seconds, kind = kind, measured = measured} end})
  local function say(speaker, text, kind, extra)
    nextId = nextId + 1
    local line = {id = nextId, type = kind or 'Regular', speaker = speaker, text = text}
    for key, value in pairs(extra or {}) do line[key] = value end
    second:line(line, 'show')
    return line
  end
  -- The context setting is off here (enabled() is false), and the host is still told: the two are independent.
  local line = say(JUDY, 'Welcome aboard.', 'Regular', {duration = 3.25})
  assert(#heard == 1 and heard[1].seconds == 3.25 and heard[1].kind == 'Regular' and heard[1].measured == true)
  second:line(line, 'event')
  assert(#heard == 1, 'the second subtitle hook shows the same line: reported once')
  say(JUDY, 'one two three four five six seven eight nine ten', 'Holocall')
  assert(#heard == 2 and heard[2].measured == false and math.abs(heard[2].seconds - 4.8) < 0.01, 'estimated from the words: ' .. heard[2].seconds)
  say(JUDY, 'Hi.', 'Regular', {duration = 99})
  assert(heard[3].measured == false and heard[3].seconds == 1.5, 'an absurd duration is not trusted; short lines still count for a moment')
  say(JUDY, string.rep('word ', 80), 'Radio')
  assert(heard[4].seconds == 10 and heard[4].kind == 'Radio', 'bounded')
  for _, kind in ipairs({'OverHead', 'OverHeadAlwaysVisible', 'GlobalTV', 'Narrator', 'Invisible', 'unknown'}) do say(CROWD, 'Chatter ' .. kind, kind) end
  assert(#heard == 4, 'crowd chatter and broadcasts never hold a remark back')
  subtitles.serial = 5
  say({id = '11ULL'}, 'AI reply', 'OwnerlessRegular', {id = 0x436F6E760000 + 4})
  assert(#heard == 4, 'the mod\\'s own replies never count as the game talking')
  wanted = false
  say(JUDY, 'Nobody is listening.', 'Regular', {duration = 2})
  assert(#heard == 4, 'no add-on registered: not even read')
  wanted = true
  local broken = api.new({native = N, now = function() return now end, onGameLine = function() error('boom') end})
  assert(pcall(function() broken:line({id = 9000, type = 'Regular', speaker = JUDY, text = 'x'}, 'show') end))
`));

test('lines an add-on replaces: the subtitle filter hides only its character\'s lines, the voice stop and the log are sent once, and nothing runs without a rule', () => lua$(`
  local muted, heard, stopped, hidden, active, again = {}, {}, {}, {}, true, 0
  local rule = {name = 'Skippy', audio = {'vo_3d_important'}}
  local native = setmetatable({
    stopAudio = function(line, events) stopped[#stopped + 1] = events[1]; return 'stop-sent(' .. events[1] .. ')', function() again = again + 1 end end,
    hideLine = function(line) hidden[#hidden + 1] = line.id; return true end,
  }, {__index = N})
  local installed
  local function make(withOverride, replace)
    return api.new({native = native, now = function() return now end, enabled = function() return false end,
      onGameLineWanted = function() return true end,
      onGameLine = function(seconds, kind, measured) heard[#heard + 1] = {seconds = seconds, kind = kind, measured = measured} end,
      matchWanted = function() return active end,
      matchLine = function(line, context) if line.speakerName == 'Skippy' then return rule, replace end return nil end,
      onMuted = function(r, info) muted[#muted + 1] = info end,
      override = withOverride and function(class, method, fn) installed = {class = class, method = method, fn = fn} end or function() error('no such method') end,
      log = function() end})
  end
  local dialogue2 = make(true, true)
  assert(dialogue2:installMute() == true and installed.class == 'SubtitlesGameController' and installed.method == 'ShouldDisplayLine')
  assert(dialogue2:status().subtitleFilter == true)
  local function ask(line) return installed.fn(nil, line, function() return 'shown' end) end
  assert(ask({id = 500, speakerName = 'Skippy', type = 'Invisible'}) == false, 'his line is not displayed')
  assert(ask({id = 501, speakerName = 'Judy'}) == 'shown', 'anyone else is left alone')
  subtitles.serial = 5
  assert(ask({id = 0x436F6E760000 + 4, speakerName = 'Skippy', type = 'OwnerlessRegular'}) == 'shown', 'our own caption is never hidden')
  active = false
  assert(ask({id = 502, speakerName = 'Skippy'}) == 'shown', 'no rule wanted: nothing is looked at')
  active = true
  -- The line then reaches the subtitle hooks: stop the voice, tell the host, once.
  local line = {id = 503, speakerName = 'Skippy', type = 'Invisible', duration = 2.5}
  dialogue2:line(line, 'show')
  dialogue2:line(line, 'event')
  assert(#stopped == 1 and stopped[1] == 'vo_3d_important' and #muted == 1 and #hidden == 0)
  assert(muted[1].seconds == 2.5 and muted[1].measured == true and muted[1].audio == 'stop-sent(vo_3d_important)' and muted[1].subtitle == 'filtered' and muted[1].id == '000503')
  -- The same stop can be sent again later (it holds the line's own speaker and events, and is handed to the host with the muted line).
  assert(type(muted[1].repeatStop) == 'function' and again == 0)
  muted[1].repeatStop()
  assert(again == 1)
  assert(#heard == 0 and dialogue2:status().muted.Skippy == 1)
  -- Switched off by the player (matchLine says replace = false): the game talks, the host is told it is talking.
  local off = make(true, false)
  off:line({id = 504, speakerName = 'Skippy', type = 'Invisible', duration = 2}, 'show')
  assert(#stopped == 1 and #muted == 1 and #heard == 1 and heard[1].kind == 'Skippy' and heard[1].seconds == 2)
  -- The override could not be installed: the line is hidden right after it was handed to the HUD.
  local fallback = make(false, true)
  assert(fallback:installMute() == false and fallback:status().subtitleFilter == false)
  fallback:line({id = 505, speakerName = 'Skippy', type = 'Regular', duration = 2}, 'show')
  assert(#hidden == 1 and hidden[1] == 505 and muted[2].subtitle == 'hidden-after')
  -- No rule declared: not even matchLine is called.
  active = false
  local calls = 0
  local plain = api.new({native = native, now = function() return now end, onGameLineWanted = function() return true end,
    onGameLine = function() end, matchWanted = function() return false end, matchLine = function() calls = calls + 1 end})
  plain:line({id = 506, speakerName = 'Skippy', type = 'Regular', duration = 2}, 'show')
  assert(calls == 0 and plain:shouldHide({id = 507, speakerName = 'Skippy'}) == false)
`));

test('TV, radio, narrator, braindance, flashbacks and combat barks are excluded', () => lua$(`
  for _, kind in ipairs({'GlobalTV', 'GlobalTVAlwaysVisible', 'Narrator', 'Invisible', 'SceneComment',
      'AlwaysCinematicNoSpeaker', 'Radio', 'unknown'}) do
    assert(show(JUDY, 'Broadcast ' .. kind, kind) == false, kind)
  end
  state.braindance = true; assert(show(JUDY, 'Recorded memory') == false); state.braindance = false
  state.replacer = true; assert(show(JUDY, 'Johnny flashback') == false); state.replacer = false
  state.combat = true
  assert(show(CROWD, 'Get down!', 'OverHead') == false)
  assert(show(JUDY, 'Scripted line in a fight'), 'scripted dialogue still counts during combat')
  state.combat = false
  CROWD.combat = true; assert(show(CROWD, 'Die!', 'OverHead') == false); CROWD.combat = nil
  assert(show(CROWD, 'Nice jacket.', 'OverHead'))
  local lines = rows()
  assert(#lines == 2 and lines[2].channel == 'ambient' and lines[2].entity == '77ULL')
  assert(lines[2].profileKey == nil, 'generic resident profile is not sent as an identity')
  local skipped = dialogue:status().skipped
  assert(skipped.type == 7 and skipped.radio == 1 and skipped.braindance == 1 and skipped.replacer == 1 and skipped.combat == 2)
`));

test('phone calls are labelled with the contact, and radio-styled lines count only during a call', () => lua$(`
  state.call = {active = true, contact = 'panam'}
  assert(show(nil, 'Get to the camp.', 'Regular', {speakerName = 'Panam'}))
  assert(show({id = '55ULL', name = 'Panam'}, 'Bring the car.', 'Radio'))
  assert(show({id = '56ULL', vehicle = true}, 'Car radio host', 'Radio') == false)
  assert(show(player, 'On my way.'))
  state.call = nil
  assert(show(nil, 'Holo from nowhere', 'Holocall', {speakerName = 'Unknown'}))
  local lines = rows()
  assert(#lines == 4)
  assert(lines[1].channel == 'phone' and lines[1].profileKey == 'panam-palmer' and lines[1].contact == 'panam' and lines[1].entity == nil)
  assert(lines[2].channel == 'phone' and lines[3].speaker == 'v' and lines[3].channel == 'phone')
  assert(lines[4].channel == 'phone' and lines[4].contact == nil and lines[4].name == 'Unknown')
  assert(lines[1].present == nil, 'companions nearby do not join a call')
`));

test('dialogue choices are named from the hub the player saw, with the hub character as addressee', () => lua$(`
  dialogue:dialogHubs({choiceHubs = {{id = 7, title = 'Judy', choices = {{localizedName = 'Ask about Evelyn'},
    {localizedName = '<icon>[Leave]'}}}}})
  dialogue:dialogHubs({choiceHubs = {}})
  assert(dialogue:choice({isSuccess = true, visualizerType = 'Dialog', choiceIdx = 1}))
  assert(dialogue:choice({isSuccess = true, visualizerType = 'Device', choiceIdx = 0}) == false)
  assert(dialogue:choice({isSuccess = false, visualizerType = 'Dialog', choiceIdx = 0}) == false)
  hubActive = 99; dialogue.hubs = {}
  now = now + 10
  assert(dialogue:choice({isSuccess = true, visualizerType = 'Dialog', choiceIdx = 0, choice = {caption = 'Fallback caption'}}))
  local lines = rows()
  assert(#lines == 2 and lines[1].kind == 'choice' and lines[1].speaker == 'v')
  assert(lines[1].text == '[Leave]' and lines[1].addressee == 'judy-alvarez')
  assert(lines[2].text == 'Fallback caption' and lines[2].addressee == nil)
`));

test('the buffer is bounded by age and size, text is cleaned, and reset or Off clears it', () => lua$(`
  for i = 1, 60 do assert(show(JUDY, 'Line ' .. i)); now = now + 1 end
  local lines = rows()
  assert(#lines == api.MAX_LINES and lines[#lines].text == 'Line 60' and lines[1].text == 'Line 21')
  for i = 1, 15 do assert(show({id = (900 + i) .. 'ULL'}, 'Chatter ' .. i, 'OverHead', {speakerName = 'Pedestrian'})) end
  local ambient = 0
  for _, row in ipairs(rows()) do if row.channel == 'ambient' then ambient = ambient + 1 end end
  assert(ambient == api.MAX_AMBIENT, 'crowd chatter cannot push out the scene')
  now = now + api.MAX_AGE + 1
  assert(dialogue:capture() == nil, 'everything older than the window is gone')
  assert(show(JUDY, '<b>Hi</b>\\n  there') and rows()[1].text == 'Hi there')
  assert(show(JUDY, 'LocKey#123') == false and show(JUDY, '   ') == false)
  local long = string.rep('a', 595) .. 'ééé'
  assert(show(JUDY, long))
  local cut = rows()[2].text
  assert(#cut <= api.MAX_TEXT and cut:sub(-3) == '...' and not cut:find('\\195%.%.%.$'), 'UTF-8 never split')
  dialogue:reset('save restored')
  assert(dialogue:capture() == nil)
  assert(show(JUDY, 'After load'))
  enabled = false
  assert(show(JUDY, 'Ignored') == false and dialogue:capture() == nil and #dialogue.lines == 0)
`));

test('install registers the subtitle, choice and hub hooks; a failing hook is contained', () => lua$(`
  local hooks = {}
  local installed = api.new({native = N, now = function() return now end,
    resolve = function(speaker) local p = profiles[speaker.id]; if p then return p[1], p[2] end end,
    observe = function(class, method, fn) hooks[class .. '.' .. method] = fn end})
  assert(installed:install() and installed:install())
  for _, name in ipairs({'BaseSubtitlesGameController.ShowDialogLines', 'BaseSubtitlesGameController.OnShowDialogLine',
      'PreventionSystem.OnPlayerChoice', 'InteractionUIBase.OnDialogsData'}) do assert(hooks[name], name) end
  local line = {id = 5, type = 'Regular', speaker = JUDY, text = 'Hooked.'}
  hooks['BaseSubtitlesGameController.ShowDialogLines'](nil, {line})
  hooks['BaseSubtitlesGameController.OnShowDialogLine'](nil, {line})
  hooks['InteractionUIBase.OnDialogsData'](nil, {choiceHubs = {{id = 7, title = 'Judy', choices = {{localizedName = 'Okay.'}}}}})
  hooks['PreventionSystem.OnPlayerChoice'](nil, {isSuccess = true, visualizerType = 'Dialog', choiceIdx = 0})
  local snap = installed:capture()
  assert(#snap.lines == 2 and snap.lines[1].text == 'Hooked.' and snap.lines[2].text == 'Okay.')
  local status = installed:status()
  assert(status.hooks.show == 1 and status.hooks.event == 1 and status.hooks.choice == 1 and status.hooks.hubs == 1)
  N.lineId = function() error('native failure') end
  hooks['BaseSubtitlesGameController.ShowDialogLines'](nil, {{id = 6, type = 'Regular', text = 'x'}})
  assert(installed:status().skipped.invalid == 1)
  installed.line = function() error('boom') end
  hooks['BaseSubtitlesGameController.ShowDialogLines'](nil, {line})
  assert(installed:status().lastError:find('boom'))
`));

test('each of the four hooks writes one probe.log line the first time it fires in a session, and no more', () => {
  lua$(`
  local hooks, lines = {}, {}
  local installed = api.new({native = N, now = function() return now end,
    log = function(line) lines[#lines + 1] = line end,
    resolve = function(speaker) local p = profiles[speaker.id]; if p then return p[1], p[2] end end,
    observe = function(class, method, fn) hooks[class .. '.' .. method] = fn end})
  assert(installed:install())
  assert(#lines == 0, 'installing a hook logs nothing')
  local line = {id = 5, type = 'Regular', speaker = JUDY, text = 'Hooked.'}
  local SHOW, EVENT = 'BaseSubtitlesGameController.ShowDialogLines', 'BaseSubtitlesGameController.OnShowDialogLine'
  local CHOICE, HUBS = 'PreventionSystem.OnPlayerChoice', 'InteractionUIBase.OnDialogsData'
  hooks[SHOW](nil, {line}); hooks[SHOW](nil, {line}); hooks[SHOW](nil, {line})
  assert(#lines == 1 and lines[1] == 'Game dialogue: hook show fired (' .. SHOW .. ')', lines[1])
  hooks[EVENT](nil, {line}); hooks[EVENT](nil, {line})
  assert(#lines == 2 and lines[2] == 'Game dialogue: hook event fired (' .. EVENT .. ')', lines[2])
  hooks[HUBS](nil, {choiceHubs = {{id = 7, title = 'Judy', choices = {{localizedName = 'Okay.'}}}}})
  hooks[HUBS](nil, {choiceHubs = {}})
  assert(#lines == 3 and lines[3] == 'Game dialogue: hook hubs fired (' .. HUBS .. ')', lines[3])
  hooks[CHOICE](nil, {isSuccess = true, visualizerType = 'Dialog', choiceIdx = 0})
  hooks[CHOICE](nil, {isSuccess = true, visualizerType = 'Dialog', choiceIdx = 0})
  assert(lines[4] == 'Game dialogue: hook choice fired (' .. CHOICE .. ')', lines[4])
  -- The choice hook adds one line per outcome (decision ledger probe): the first recorded pick and the first skip reason, no option text.
  assert(#lines == 6 and lines[5]:find('^Game dialogue: choice recorded #1 %(index=0 hub=7 options=1') and not lines[5]:find('Okay', 1, true), lines[5])
  assert(lines[6] == 'Game dialogue: choice not recorded (repeated)', lines[6])
  -- A fired hook stays quiet for the rest of the session, through a world reset and with the setting off.
  installed:reset('save restored'); enabled = false
  for _, name in ipairs({SHOW, EVENT, CHOICE, HUBS}) do hooks[name](nil, {line}) end
  assert(#lines == 7 and lines[7] == 'Game dialogue: choice not recorded (not-dialogue visualizer=? success=?)', lines[7])
  -- Even a call the module ignores proves that the game called the hook; a failing log never breaks it.
  local quiet = api.new({native = N, now = function() return now end, log = function() error('log failed') end,
    observe = function(class, method, fn) hooks[class .. '.' .. method] = fn end})
  assert(quiet:install())
  hooks[SHOW](nil, 'not a table')
  assert(quiet.fired.show == true and quiet:status().lastError == nil)
  -- No log function at all is fine too.
  local silent = api.new({native = N, now = function() return now end,
    observe = function(class, method, fn) hooks[class .. '.' .. method] = fn end})
  assert(silent:install()); hooks[CHOICE](nil, nil)
  assert(silent.fired.choice == true)
`);
  assert.match(initSource, /if gameDialogue then gameDialogue\.options\.log = log end/);
  // Still no per-frame work: the first-sighting check runs inside the observer callbacks only.
  assert.doesNotMatch(source, /registerForEvent|onUpdate/);
});

test('group rounds share one snapshot with the prepared and voiced speakers', () => {
  const vm = `local group = (function() ${groupSource} end)()
    local captures = 0
    group.captureGameDialogue = function() captures = captures + 1; return {version = 1, status = 'ready', serial = captures} end
    local function p(key, id) return {profileKey = key, entity = id .. 'ULL', name = key, bodyType = 'test', npc = id} end
    local judy, panam = p('judy', 1), p('panam', 2)
    local live = {['1ULL'] = true, ['2ULL'] = true}
    group.start('round-1', {judy, panam}, 'What happened?')
    local first = group.next(10, 100, live)
    assert(first.gameDialogue.serial == 1 and captures == 1)
    assert(group.received(first.requestId, 'Nothing much.', false, {'judy', 'panam'}, nil, nil))
    local prepared = group.preview(11, 101, live)
    assert(prepared.gameDialogue.serial == 1 and captures == 1)
    local voice = group.startVoice('voice-1', {judy, panam}, 20, 200)
    assert(voice.gameDialogue.serial == 2)
    voice.gameDialogue = {version = 1, status = 'ready', serial = 9}
    assert(group.voiceSubmitted(voice) and group.round.gameDialogue.serial == 9)`;
  runLua(vm);
});

test('every manual send path captures the snapshot; automatic reactions never do', () => {
  const send = initSource.slice(initSource.indexOf('local function sendRequest(context)'), initSource.indexOf('-- A managed copy can be reassigned'));
  assert.match(send, /if not context\.reaction and convaiGameDialogue then\s+context\.gameDialogue = context\.gameDialogue or convaiGameDialogue:capture\(\)/);
  assert.match(initSource, /groupChat\.captureGameDialogue = captureGameDialogue/);
  assert.match(initSource, /phoneChat\.captureGameDialogue = captureGameDialogue/);
  assert.match(initSource, /microphone\.captureGameDialogue = captureGameDialogue/);
  assert.match(initSource, /if preserveTransit ~= true and convaiGameDialogue then convaiGameDialogue:reset\(reason\) end/);
  assert.match(initSource, /convaiGameDialogue:install\(\)/);
  assert.equal(microphoneSource.match(/context\.gameDialogue = M\.captureGameDialogue and M\.captureGameDialogue\(\)/g).length, 2);
  assert.match(phoneSource, /local gameDialogue = capture\(M\.captureGameDialogue\)/);
  assert.match(phoneSource, /battle = battle, gameDialogue = gameDialogue\}/);
});

test('the voice stop of a muted line is sent on the line speaker and can be sent again with the same entity id and events', () => lua$(`
  local calls = {}
  Game = Game or {}
  Game.GetAudioSystem = function() return {Stop = function(_, name, id) calls[#calls + 1] = name .. '@' .. id end} end
  CName = CName or {}
  CName.new = function(name) return name end
  local native = api.new({}).native
  local events = {'vo_3d', 'vo_2d'}
  local speaker = {GetEntityID = function() return 'E1' end}
  local text, again = native.stopAudio({speaker = speaker}, events)
  assert(text == 'stop-sent(vo_3d,vo_2d)' and type(again) == 'function' and #calls == 2 and calls[1] == 'vo_3d@E1' and calls[2] == 'vo_2d@E1')
  events[1] = 'changed'                                -- the list the rule owns is copied, not held
  again()
  assert(#calls == 4 and calls[3] == 'vo_3d@E1' and calls[4] == 'vo_2d@E1')
  assert(native.stopAudio({speaker = speaker}, {}) == 'no-event-known')
  assert(native.stopAudio({}, {'vo_3d'}) == 'no-speaker')
  assert(#calls == 4, 'nothing sent without a speaker or an event')
`));

test('a rule\'s own silence function runs once per muted line with the line and its type, its text joins the log, its repeat is chained to the voice stop, and a failure changes nothing', () => lua$(`
  local muted, calls = {}, {}
  local firstAgain = 0
  local native = setmetatable({
    stopAudio = function(line, events) return 'stop-sent(' .. (events[1] or '?') .. ')', function() firstAgain = firstAgain + 1 end end,
    hideLine = function() return true end,
  }, {__index = N})
  local function make(rule)
    return api.new({native = native, now = function() return now end, enabled = function() return false end,
      onGameLineWanted = function() return true end, onGameLine = function() end,
      matchWanted = function() return true end,
      matchLine = function(line) if line.speakerName == 'Skippy' then return rule, true end return nil end,
      onMuted = function(r, info) muted[#muted + 1] = info end, log = function() end})
  end
  local again = 0
  local rule = {name = 'Skippy', audio = {'vo_3d_important'}, silence = function(line, context)
    calls[#calls + 1] = line.id .. ':' .. context.typeName()
    return 'gun-stop(1)', function() again = again + 1 end
  end}
  local dialogue2 = make(rule)
  dialogue2:line({id = 600, speakerName = 'Skippy', type = 'Invisible', duration = 2}, 'show')
  dialogue2:line({id = 600, speakerName = 'Skippy', type = 'Invisible', duration = 2}, 'event')
  assert(#calls == 1 and calls[1] == '600:Invisible', 'once per line')
  assert(muted[1].audio == 'stop-sent(vo_3d_important)+gun-stop(1)', muted[1].audio)
  muted[1].repeatStop()
  assert(firstAgain == 1 and again == 1, 'both repeats run together')
  -- A rule with no voice event at all still repeats what silence gave.
  local quiet = make({name = 'Skippy', silence = function() return 'x', function() again = again + 10 end end})
  quiet:line({id = 601, speakerName = 'Skippy', type = 'Invisible', duration = 2}, 'show')
  assert(type(muted[2].repeatStop) == 'function' and muted[2].audio:find('+x', 1, true))
  muted[2].repeatStop()
  assert(again == 11)
  -- A silence function that fails, or returns nothing, leaves the stop and the muting as they were.
  local broken = make({name = 'Skippy', audio = {'vo_3d_important'}, silence = function() error('boom') end})
  broken:line({id = 602, speakerName = 'Skippy', type = 'Invisible', duration = 2}, 'show')
  assert(muted[3].audio == 'stop-sent(vo_3d_important)' and type(muted[3].repeatStop) == 'function')
  local nothing = make({name = 'Skippy', audio = {'vo_3d_important'}, silence = function() end})
  nothing:line({id = 603, speakerName = 'Skippy', type = 'Invisible', duration = 2}, 'show')
  assert(muted[4].audio == 'stop-sent(vo_3d_important)')
  -- A line the player did not ask to have replaced is never silenced.
  local off = api.new({native = native, now = function() return now end, enabled = function() return false end,
    onGameLineWanted = function() return true end, onGameLine = function() end, matchWanted = function() return true end,
    matchLine = function() return rule, false end, onMuted = function() error('not muted') end, log = function() end})
  local before = #calls
  off:line({id = 604, speakerName = 'Skippy', type = 'Invisible', duration = 2}, 'show')
  assert(#calls == before)
`));
