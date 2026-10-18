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
