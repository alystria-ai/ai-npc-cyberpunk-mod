import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import fengari from 'fengari';
const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;
const subtitles = readFileSync(new URL('../mod/subtitles.lua', import.meta.url), 'utf8');
const speech = readFileSync(new URL('../mod/speech.lua', import.meta.url), 'utf8');
const facial = readFileSync(new URL('../mod/facial-playback.lua', import.meta.url), 'utf8');

test('continuous playback respects mute and subtitle changes without restarting audio', () => {
  const state = lauxlib.luaL_newstate(); lualib.luaL_openlibs(state);
  const program = `
    local voice, visible, cursor, starts, stops, failStart = true, true, 0, 0, 0, false
    local player = {
      ConvaiManagerVoice=function() return voice end,
      ConvaiManagerSubtitles=function() return visible end,
      GetEntityID=function() return {hash='player'} end
    }
    -- The renderer's side: a fake adapter reporting the heard position (cursor) of one 5 s utterance.
    local controller={version=1,available=true}
    function controller.start() if failStart then return false,'no voice engine' end; starts=starts+1; return true end
    function controller.stop() stops=stops+1 end
    function controller.pause() return true end
    function controller.status() return {} end
    function controller.update()
      return {position=cursor,bufferedDuration=5,text='Hello V',textComplete=true,state='playing',complete=true,ended=false}
    end
    local board={SetVariant=function() end, GetBool=function() return false end}
    Game={GetPlayer=function() return player end,
      GetAllBlackboardDefs=function() return {UI_System={}, UIGameData={}} end,
      GetBlackboardSystem=function() return {Get=function() return board end} end}
    CRUID=function(v) return v end
    ToVariant=function(v) return v end
    CName={new=function(v) return v end}
    scnDialogLineData={new=function() return {} end}
    scnDialogLineType={OwnerlessRegular=1}
    io.open=function() return nil end
    local captions=(function() ${subtitles} end)()
    local face=(function() ${facial} end)()
    dofile=function(path)
      if path=='continuous-speech.lua' then return controller end
      return path=='facial-playback.lua' and face or captions
    end
    local speech=(function() ${speech} end)()
    speech.target={GetEntityID=function() return {hash='npc'} end,
      IsAttached=function() return true end, IsDeadNoStatPool=function() return false end}
    local context={entity='npc', requestId='test', name='Judy'}
    local reply={text='Hello V', continuous={version=1,id='12345678-1234-1234-1234-123456789abc'}}
    visible=false
    assert(speech.start(context,reply))
    cursor=1; speech.update(0.1); captions.update(0.1)
    assert(not captions.line and starts==1)
    visible=true
    cursor=2; speech.update(0.1)
    assert(captions.line and captions.timed and starts==1)
    visible=false; captions.update(0.1)
    assert(not captions.line and speech.requestId=='test')
    visible=true; voice=false; speech.update(0.1)
    assert(not speech.requestId and speech.state=='muted' and stops==1)
    assert(captions.line and not captions.timed)
    assert(not speech.start(context,reply) and starts==1 and captions.line)
    visible=false
    assert(not speech.start(context,reply) and not captions.line and starts==1)
    voice=true; visible=true
    failStart=true
    assert(not speech.start(context,reply) and speech.state=='playback-failed')
    assert(captions.line and not speech.requestId)
  `;
  const result = lauxlib.luaL_dostring(state, to_luastring(program));
  const error = result === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(state, -1));
  lua.lua_close(state); assert.equal(result, lua.LUA_OK, error);
});
