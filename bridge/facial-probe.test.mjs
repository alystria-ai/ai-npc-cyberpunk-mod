import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fengari from 'fengari';
const source=readFileSync(new URL('../mod/face-probe.lua',import.meta.url),'utf8');
const {lua,lauxlib,lualib,to_luastring,to_jsstring}=fengari;
function run(body) {
  const state=lauxlib.luaL_newstate(); lualib.luaL_openlibs(state);
  const status=lauxlib.luaL_dostring(state,to_luastring(`
    local report,now,menu,frames,resets,queries,updates,stops,abandons=nil,100,false,{},0,0,0,0,0
    os.time=function() return now end
    json={encode=function(value) report=value; return '{}' end}
    io.open=function() return {write=function() end,close=function() end} end
    registerForEvent=function() error('must not register CET events at runtime') end
    local player={IsAttached=function() return true end,IsDeadNoStatPool=function() return false end,
      GetEntityID=function() return {hash='player'} end}
    local npc={ConvaiFaceReady=function() return true end,ConvaiFaceStatus=function() return 'ready' end,
      ConvaiFaceApply=function(_,feature) frames[#frames+1]=feature; return true end,
      ConvaiFaceReset=function() resets=resets+1; return true end}
    Game={GetPlayer=function() queries=queries+1; return player end,
      GetAllBlackboardDefs=function() return {UI_System={IsInMenu='menu'}} end,
      GetBlackboardSystem=function() return {Get=function() return {GetBool=function() return menu end} end} end}
    NewObject=function() return {} end
    convaiCompanions={owns=function() return true end,
      conversationCandidates=function() return {{entity='judy1',name='Judy',profileKey='judy-alvarez',npc=npc}} end}
    local originalUpdate=function() updates=updates+1 end
    local originalStop=function() stops=stops+1 end
    local originalAbandon=function() abandons=abandons+1 end
    convaiSpeech={update=originalUpdate,stop=originalStop,abandon=originalAbandon}
    local probe=(function() ${source} end)()
    ${body}
  `));
  const error=status===lua.LUA_OK?'':to_jsstring(lua.lua_tostring(state,-1));
  lua.lua_close(state); assert.equal(status,lua.LUA_OK,error);
}

test('live-loaded jaw proof uses existing frames, completes two pulses, resets and restores delegates',()=>run(`
  probe.start('judy-alvarez')
  for i=1,160 do convaiSpeech.update(1/30) end
  assert(report.state=='completed' and report.restored and not probe.active)
  assert(#frames>=148 and #frames<=151 and resets==1)
  assert(frames[1].jaw_mid_open<0.01 and frames[38].jaw_mid_open>0.34)
  assert(frames[75].jaw_mid_open<0.01 and frames[113].jaw_mid_open>0.34)
  assert(updates==160 and convaiSpeech.update==originalUpdate)
  assert(convaiSpeech.stop==originalStop and convaiSpeech.abandon==originalAbandon)
`));

test('session unload drops the proof without querying destroyed actors',()=>run(`
  probe.start('judy-alvarez'); convaiSpeech.update(0.1)
  local before=queries
  Game.GetPlayer=function() error('native world has been destroyed') end
  convaiSpeech.abandon()
  assert(queries==before and resets==0 and abandons==1)
  assert(not probe.active and report.state=='unloaded' and not probe.entity)
  assert(convaiSpeech.update==originalUpdate)
`));

test('shutdown, menu and incoming speech each stop the diagnostic and restore the face',()=>run(`
  probe.start('judy-alvarez'); convaiSpeech.stop('shutdown')
  assert(report.state=='shutdown' and resets==1 and stops==1)
  probe.start('judy-alvarez'); menu=true; convaiSpeech.update(0)
  assert(report.state=='interrupted' and resets==2); menu=false
  probe.start('judy-alvarez'); convaiSpeech.requestId='real speech'; convaiSpeech.update(0.1)
  assert(report.state=='interrupted' and resets==3)
`));

test('deadline cancels zero-time updates and one probe cannot stack tick delegates',()=>run(`
  probe.start('judy-alvarez'); probe.start('judy-alvarez')
  convaiSpeech.update(0.1)
  assert(updates==1 and #frames==1 and resets==1)
  now=113; convaiSpeech.update(0)
  assert(report.state=='deadline' and resets==2 and convaiSpeech.update==originalUpdate)
`));
