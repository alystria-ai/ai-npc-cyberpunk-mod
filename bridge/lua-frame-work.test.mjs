// The fourth Lua performance round (docs/PERFORMANCE_NATIVE_PLAN.md): onUpdate and the per-frame module paths make no native
// call, closure or table they do not need on a quiet frame, and give the same answers as before.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import fengari from 'fengari';

const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;
const read = (name) => readFileSync(new URL(`../mod/${name}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const subtitlesSource = read('subtitles.lua');
const speechSource = read('speech.lua');
const facialSource = read('facial-playback.lua');

function run(code) {
  const state = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(state);
  const status = lauxlib.luaL_dostring(state, to_luastring(code));
  const error = status === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(state, -1));
  lua.lua_close(state);
  assert.equal(status, lua.LUA_OK, error);
}

// speech.lua with the real subtitles and facial players (as bridge/playback-settings.test.mjs loads them), a counted
// Game.GetPlayer and a recorded speech-state.json.
const speechFixture = `
  local playerReads, published, cursor, playerHash = 0, 0, 0, 'player'
  local player = {
    ConvaiManagerVoice=function() return true end,
    ConvaiManagerSubtitles=function() return false end,
    GetEntityID=function() return {hash=playerHash} end,
    ConvaiSpeechStart=function() return true end,
    ConvaiSpeechStop=function() end,
    ConvaiSpeechPosition=function() return cursor end,
    ConvaiSpeechPause=function() end
  }
  local board={SetVariant=function() end, GetBool=function() return false end}
  Game={GetPlayer=function() playerReads=playerReads+1; return player end,
    GetAllBlackboardDefs=function() return {UI_System={}, UIGameData={}} end,
    GetBlackboardSystem=function() return {Get=function() return board end} end}
  CRUID=function(v) return v end
  ToVariant=function(v) return v end
  CName={new=function(v) return v end}
  scnDialogLineData={new=function() return {} end}
  scnDialogLineType={OwnerlessRegular=1}
  json={encode=function() return '{}' end}
  io.open=function(path)
    if path ~= 'runtime/speech-state.json' then return nil end
    published=published+1
    return {write=function() return true end, close=function() return true end}
  end
  local captions=(function() ${subtitlesSource} end)()
  local face=(function() ${facialSource} end)()
  dofile=function(path) return path=='facial-playback.lua' and face or captions end
  local speech=(function() ${speechSource} end)()
`;

test('speech: a quiet frame asks the game for nobody; the 2 s heartbeat asks once and still publishes the lease', () => run(`${speechFixture}
  for _ = 1, 7 do speech.update(0.25) end
  assert(playerReads == 0, 'a quiet frame read the player ' .. playerReads .. ' times')
  assert(published == 0)
  speech.update(0.25)
  assert(playerReads == 1, 'the heartbeat frame read the player ' .. playerReads .. ' times')
  assert(published == 1 and speech.available == true and speech.heartbeat == 0)
  for _ = 1, 7 do speech.update(0.25) end
  assert(playerReads == 1 and published == 1, 'the frames after the heartbeat were not quiet again')
`));

test('speech: a reply in progress still reads V every frame, plays to its end, and is abandoned when V changes', () => run(`${speechFixture}
  speech.available=true
  speech.target={GetEntityID=function() return {hash='npc'} end,
    IsAttached=function() return true end, IsDeadNoStatPool=function() return false end}
  local context={entity='npc', requestId='one', name='Judy'}
  local reply={text='Hello V', audio={slot=0,event='convai_reply_0',duration=2}}
  assert(speech.start(context, reply))
  local before = playerReads
  cursor = 0.5; speech.update(0.1)
  assert(playerReads > before, 'a speaking frame did not read V')
  assert(speech.requestId == 'one' and speech.state == 'playing')
  cursor = 2; speech.update(0.1)
  assert(not speech.requestId and speech.state == 'finished', tostring(speech.state))
  cursor = 0
  assert(speech.start({entity='npc', requestId='two', name='Judy'}, reply))
  playerHash = 'someone-else'
  speech.update(0.1)
  assert(not speech.requestId, 'a reply outlived a change of V')
`));

// init.lua's per-frame native checks are plain functions that take what they read: a pcall(function() ... end) in onUpdate built a
// closure (and boxed its captured locals) on every frame. The helpers are cut out of init.lua and run against a fake player.
const initSource = read('init.lua');
const helperText = initSource.slice(initSource.indexOf('convaiSessionReady = function'), initSource.indexOf("-- The face layer's per-frame context"));
const quietFrame = initSource.slice(initSource.indexOf("registerForEvent('onUpdate'"), initSource.indexOf('if poll < 0.1 then return end'));

test('onUpdate: the frames that run on every tick build no closure (session, world, phone, composer and submission checks are named functions)', () => {
  assert.ok(helperText.includes('convaiWorldReady = function') && helperText.includes('convaiInvoke = function'));
  assert.ok(quietFrame.length > 2000, 'the per-frame half of onUpdate was found');
  assert.ok(!quietFrame.includes('pcall(function'), 'a pcall(function() ... end) is back on the every-frame path');
  assert.ok(/pcall\(convaiSessionReady, menuPlayer, worldSuspended\)/.test(quietFrame));
  assert.ok(/pcall\(convaiWorldReady, requests, menuPlayer\)/.test(quietFrame));
  assert.ok(/pcall\(convaiInvoke, menuPlayer, 'ConvaiPhoneIsOpen'\)/.test(quietFrame));
  // The ten-per-second tick uses this frame's V instead of asking the game a second time.
  assert.ok(/mark\('init:tick'\)[\s\S]{0,300}local player = menuPlayer\b/.test(initSource));
});

const menuText = initSource.slice(initSource.indexOf('convaiInMenu = function()'), initSource.indexOf('local function gameplayCanAcquire'));
test('onUpdate helpers: one ConvaiFrameFlags call answers the session, world, menu and phone checks, and scripts without it keep the separate calls', () => run(`
  local others, flagReads, mask = 0, 0, 0
  local function native() others = others + 1 end
  local requests = {IsPreGame=function() native(); return false end, IsGamePaused=function() native(); return false end}
  local player = {ConvaiFrameFlags=function() flagReads = flagReads + 1; return mask end,
    IsAttached=function() native(); return true end, IsDeadNoStatPool=function() native(); return false end,
    ConvaiComposerOpen=function() native(); return false end, ConvaiPhoneIsOpen=function() native(); return false end}
  Game = {GetSystemRequestsHandler=function() native(); return requests end}
  convaiHeartbeat = {frame = 1}
  ${menuText}
  ${helperText}
  local ATTACHED, DEAD, PREGAME, PAUSED, MENU, COMPOSER, PHONE = 1, 2, 4, 8, 16, 32, 64
  local function frame(bits)
    convaiHeartbeat.frame = convaiHeartbeat.frame + 1; mask = bits; flagReads, others = 0, 0
    local ok, ready, handler = pcall(convaiSessionReady, player, false)
    assert(ok)
    local world
    if ready then local okWorld; okWorld, world = pcall(convaiWorldReady, handler, player); assert(okWorld) end
    return ready, world, handler
  end
  local ready, world, handler = frame(ATTACHED)
  assert(ready == true and world == true and handler == convaiHeartbeat and flagReads == 1 and others == 0, 'running: ' .. others .. ' other calls')
  assert(convaiInMenu() == false and others == 0, 'the frame flags seed the menu read')
  assert(select(1, frame(ATTACHED + DEAD)) == false and select(1, frame(ATTACHED + PREGAME)) == false and select(1, frame(0)) == false)
  ready, world = frame(ATTACHED + PAUSED); assert(ready == true and world == false)
  ready, world = frame(ATTACHED + MENU); assert(ready == true and world == false, 'menu'); assert(convaiInMenu() == true and others == 0, 'menu seed ' .. others)
  ready, world = frame(ATTACHED + COMPOSER); assert(ready == true and world == false and convaiInMenu() == false)
  ready, world = frame(ATTACHED + PHONE); assert(world == true and convaiHeartbeat.flags % 128 >= 64 and others == 0, 'phone')
  ready, world = frame(ATTACHED + MENU + COMPOSER + PAUSED + PHONE); assert(world == false and convaiInMenu() == true)
  assert(not pcall(convaiSessionReady, nil, true) or select(1, convaiSessionReady(nil, true)) == false)
  -- Scripts without the method: the separate calls answer (as before), and the flags are not asked again for 1200 frames.
  local old = {IsAttached=player.IsAttached, IsDeadNoStatPool=player.IsDeadNoStatPool, ConvaiComposerOpen=player.ConvaiComposerOpen}
  convaiHeartbeat.frame = 5000; others = 0
  local okOld, readyOld, handlerOld = pcall(convaiSessionReady, old, false)
  assert(okOld and readyOld == true and handlerOld == requests and others == 4 and convaiHeartbeat.flagsRetryAt == 6200, 'the old path answered')
  convaiHeartbeat.frame = 5001; others = 0; flagReads = 0
  readyOld, handlerOld = convaiSessionReady(player, false)
  assert(readyOld == true and handlerOld == requests and flagReads == 0, 'no new attempt inside the retry window')
  convaiHeartbeat.frame = 6200; mask = ATTACHED; others = 0
  readyOld, handlerOld = convaiSessionReady(player, false)
  assert(readyOld == true and handlerOld == convaiHeartbeat and others == 0, 'the flags are tried again after the window')
`));

test('onUpdate helpers: they answer exactly as the closures did (attached, alive, past the main menu, running, no menu, composer closed)', () => run(`
  local calls = {}
  local state = {attached=true, dead=false, preGame=false, paused=false, composer=false, menu=false, phone=true}
  local requests = {IsPreGame=function() calls[#calls+1]='pre'; return state.preGame end,
    IsGamePaused=function() calls[#calls+1]='paused'; return state.paused end}
  local player = {IsAttached=function() calls[#calls+1]='attached'; return state.attached end,
    IsDeadNoStatPool=function() calls[#calls+1]='dead'; return state.dead end,
    ConvaiComposerOpen=function() calls[#calls+1]='composer'; return state.composer end,
    ConvaiPhoneIsOpen=function() return state.phone end,
    ConvaiBoom=function() error('native failure') end}
  Game={GetSystemRequestsHandler=function() calls[#calls+1]='handler'; return requests end}
  convaiInMenu=function() calls[#calls+1]='menu'; return state.menu end
  convaiHeartbeat = {frame = 1}
  ${helperText}
  local function ready(p, suspended) return pcall(convaiSessionReady, p, suspended) end
  local ok, value, handler = ready(player, false)
  assert(ok and value == true and handler == requests, 'a running session answers true with the requests handler')
  state.preGame = true
  ok, value = ready(player, false); assert(ok and not value, 'the main menu is not a session')
  state.preGame = false
  state.dead = true; ok, value = ready(player, false); assert(ok and not value); state.dead = false
  state.attached = false; ok, value = ready(player, false); assert(ok and not value); state.attached = true
  ok, value = ready(nil, false); assert(ok and not value, 'no player')
  calls = {}
  ok, value = ready(player, true); assert(ok and not value and #calls == 0, 'a suspended world reads nothing')
  -- A native that throws is caught by the caller's pcall, as it was inside the closure.
  player.IsAttached = function() error('detached') end
  ok = ready(player, false); assert(not ok)
  player.IsAttached = function() return true end
  -- The pause check: the same three conditions, in the same order, stopping at the first that fails.
  calls = {}
  assert(convaiWorldReady(requests, player) == true)
  assert(table.concat(calls, ',') == 'paused,menu,composer', table.concat(calls, ','))
  state.paused = true; calls = {}
  assert(convaiWorldReady(requests, player) == false and table.concat(calls, ',') == 'paused')
  state.paused = false; state.menu = true; calls = {}
  assert(convaiWorldReady(requests, player) == false and table.concat(calls, ',') == 'paused,menu')
  state.menu = false; state.composer = true
  assert(convaiWorldReady(requests, player) == false)
  -- object:method() without a closure.
  assert(convaiInvoke(player, 'ConvaiPhoneIsOpen') == true)
  assert(select('#', pcall(convaiInvoke, player, 'ConvaiBoom')) == 2 and not pcall(convaiInvoke, player, 'ConvaiBoom'))
`));

// A reply in progress asked the game for V and for the menu flag on every frame (GetPlayer, GetEntityID, and the blackboard
// definitions, system, blackboard and value: five or six native calls for the flag alone). init.lua now hands speech.update the V
// it fetched for the frame and the menu flag comes from its cached reader (the definition and its id are read once).
const speakingFixture = `${speechFixture}
  speech.available=true
  speech.target={GetEntityID=function() return {hash='npc'} end,
    IsAttached=function() return true end, IsDeadNoStatPool=function() return false end}
  local reply={text='Hello V', audio={slot=0,event='convai_reply_0',duration=2}}
  assert(speech.start({entity='npc', requestId='one', name='Judy'}, reply))
  local reads, boards, definitions, paused = 0, 0, 0, nil
  local getPlayer, getBoard, getDefinitions = Game.GetPlayer, Game.GetBlackboardSystem, Game.GetAllBlackboardDefs
  Game.GetPlayer = function() reads = reads + 1; return getPlayer() end
  Game.GetBlackboardSystem = function() boards = boards + 1; return getBoard() end
  Game.GetAllBlackboardDefs = function() definitions = definitions + 1; return getDefinitions() end
  player.ConvaiSpeechPause = function(_, value) paused = value end
`;

test('speech: a speaking frame takes V from init.lua and the menu flag from its cached reader, and pauses with the menu as before', () => run(`${speakingFixture}
  local menu = false
  convaiInMenu = function() return menu end
  -- The first heard frame starts the caption and the lease (once per reply); count the frames after it.
  cursor = 0.4; speech.update(0.1, nil, player)
  reads, boards, definitions = 0, 0, 0
  cursor = 0.5; speech.update(0.1, nil, player)
  assert(reads == 0 and boards == 0 and definitions == 0, 'a speaking frame asked the game for V ' .. reads .. ' and the blackboard ' .. boards .. ' times')
  assert(speech.state == 'playing' and speech.paused == false)
  menu = true; cursor = 0.6; speech.update(0.1, nil, player)
  assert(speech.paused == true and paused == true, 'the menu did not pause the reply')
  menu = false; speech.update(0.1, nil, player)
  assert(speech.paused == false and paused == false, 'closing the menu did not resume it')
  assert(reads == 0 and boards == 0 and definitions == 0)
  -- A change of V is still caught (the player passed in is the one compared with the reply's owner).
  playerHash = 'someone-else'
  speech.update(0.1, nil, player)
  assert(not speech.requestId, 'a reply outlived a change of V')
`));

test('speech: without the frame\'s V or the cached reader (a test, an older init) the same frame asks the game as before', () => run(`${speakingFixture}
  convaiInMenu = nil
  cursor = 0.4; speech.update(0.1)
  reads, boards, definitions = 0, 0, 0
  cursor = 0.5; speech.update(0.1)
  assert(reads == 1, 'V was read ' .. reads .. ' times')
  assert(boards == 1 and definitions == 1, 'the blackboard was read through the definitions')
  assert(speech.state == 'playing' and speech.paused == false)
`));

test('speech: with V passed in, the 2 s heartbeat asks the game for nobody and still publishes the lease', () => run(`${speechFixture}
  for _ = 1, 8 do speech.update(0.25, nil, player) end
  assert(playerReads == 0, 'the heartbeat read V ' .. playerReads .. ' times')
  assert(published == 1 and speech.available == true and speech.heartbeat == 0)
`));

test('subtitles: a frame with a caption up takes V from init.lua (one Game.GetPlayer call and a closure fewer per frame), and asks once without it', () => run(`${speechFixture}
  player.ConvaiManagerSubtitles=function() return true end
  captions.pages={'Hello'}; captions.page=1; captions.remaining=5; captions.mode='dialogue'
  captions.update(0.1, player)
  assert(playerReads == 0, 'subtitles.update read V ' .. playerReads .. ' times although init handed it over')
  assert(captions.pages and captions.remaining < 5, 'the caption was not advanced')
  captions.update(0.1)
  assert(playerReads == 1, 'without the frame V the caption asked the game ' .. playerReads .. ' times')
  assert(captions.enabled(player) == true and captions.enabled() == true and playerReads == 2)
  -- A different V ends the caption, whichever way V arrived.
  captions.playerID = 'someone-else'
  captions.update(0.1, player)
  assert(captions.pages == nil, 'a caption outlived a change of V')
`));

test('onUpdate hands the frame\'s V to speech and subtitles', () => {
  assert.ok(/pcall\(speech\.update, tonumber\(delta\) or 0,\s*expressionContext,\s*menuPlayer\)/.test(initSource));
  assert.ok(/pcall\(subtitles\.update, tonumber\(delta\) or 0, menuPlayer\)/.test(initSource));
});
