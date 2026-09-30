import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fengari from 'fengari';

const source=readFileSync(new URL('../mod/speech-cadence-probe.lua',import.meta.url),'utf8');
const diagnostics=readFileSync(new URL('../mod/diagnostics.lua',import.meta.url),'utf8');
const {lua,lauxlib,lualib,to_luastring,to_jsstring}=fengari;
function run(body) {
  const vm=lauxlib.luaL_newstate();lualib.luaL_openlibs(vm);
  const status=lauxlib.luaL_dostring(vm,to_luastring(`
    local wall,clock,report,writes,updates,stops,abandons,pauses=100,0,nil,0,0,0,0,0
    local cadence={reads=0,acceptedReads=0,updated=100000,position=0,duration=4,sourceFrames=241,
      sourceComplete=true,state='playing',wait=0,poll=0}
    registerForEvent=function()error('runtime event registration forbidden')end
    io.open=function()error('per-frame file access forbidden')end
    Game=setmetatable({},{__index=function()error('native access forbidden')end})
    local privateActor=setmetatable({},{__index=function()error('probe must not inspect actor')end})
    local face={applied=0,state='playing',position=0,feature={jaw_mid_open=.2,lips_apart_up=.1,lips_apart_dn=.15}}
    local speech={state='idle',paused=false}
    local originalSync=function(actor,position,id)
      assert(actor==privateActor and type(id)=='string')
      face.position=position;face.applied=face.applied+1
      return nil,'sync-result',position
    end
    face.sync=originalSync
    local originalStop=function(reason)stops=stops+1;speech.requestId=nil;speech.state=reason or 'idle';return false,nil,'stop-result'end
    local originalAbandon=function()abandons=abandons+1;speech.requestId=nil;return nil,'abandon-result'end
    local originalPause=function()pauses=pauses+1;return nil,'pause-result'end
    local originalUpdate=function(dt,tag)
      updates=updates+1
      if speech.requestId then
        speech.state='playing';speech.continuousFaceTarget=cadence.position
        speech.continuousFaceCursor=math.min(cadence.position,(speech.continuousFaceCursor or 0)+dt)
        local a,b,c=face.sync(privateActor,speech.continuousFaceCursor,speech.requestId)
        assert(a==nil and b=='sync-result' and c==speech.continuousFaceCursor)
      end
      return nil,tag,false
    end
    speech.update,speech.stop,speech.abandon,speech.pauseForWorld=originalUpdate,originalStop,originalAbandon,originalPause
    speech.diagnosticCadence=function()return cadence end
    local probe=(function()${source}end)().new({speech=speech,face=face,
      clock=function()return clock end,wall=function()return wall end,
      publish=function(value)writes=writes+1;report=value end})
    local function tick(dt)
      clock=clock+dt;wall=wall+dt
      return speech.update(dt,'unchanged-result')
    end
    local function startReply()
      -- Exercise the real integration order: start calls stop before assigning.
      speech.stop();speech.requestId='private request';speech.state='starting'
    end
    local function restored()
      return speech.update==originalUpdate and speech.stop==originalStop and speech.abandon==originalAbandon
        and speech.pauseForWorld==originalPause and face.sync==originalSync
    end
    ${body}
  `));
  const error=status===lua.LUA_OK?'':to_jsstring(lua.lua_tostring(vm,-1));
  lua.lua_close(vm);assert.equal(status,lua.LUA_OK,error);
}

test('live-loaded numeric probe preserves delegates, captures stalled publication and writes only once',()=>run(`
  assert(probe.start());tick(.02);assert(writes==0 and probe.active)
  startReply();assert(probe.active)
  cadence.position=.3;tick(.02);cadence.reads=1;cadence.acceptedReads=1
  local a,b,c=tick(.02);assert(a==nil and b=='unchanged-result' and c==false)
  cadence.updated=100040;cadence.position=.34;tick(.02)
  local a,b=speech.pauseForWorld();assert(a==nil and b=='pause-result' and writes==0)
  local a,b,c=speech.stop('finished');assert(a==false and b==nil and c=='stop-result')
  assert(writes==1 and report.state=='completed' and restored() and not probe.active)
  assert(#report.rows==3 and report.appliedFrames==3 and report.syncCalls==3)
  assert(report.publicationChanges==2 and report.sameTargetUpdates==1 and report.pauseForWorldCalls==1)
  assert(report.rows[2].reads==1 and report.rows[2].target==.3 and report.rows[2].cursor==.04)
  assert(report.rows[2].sourceFrames==241 and report.rows[2].jaw==.2)
  local function privateFree(value)
    if type(value)=='table'then for key,item in pairs(value)do
      assert(key~='requestId'and key~='entity'and key~='text'and key~='actor'and key~='owner')
      privateFree(item)
    end elseif type(value)=='string'then assert(not value:find('private',1,true))end
  end
  privateFree(report);assert(probe.ownedRequest==nil and probe.hooks==nil)
`));

test('finishing inside speech.update records its last tick and restores before later frames',()=>run(`
  local base=originalUpdate
  speech.update=function(dt,tag)local a,b,c=base(dt,tag);speech.stop('finished');return a,b,c end
  local closingUpdate=speech.update
  probe.start();startReply();cadence.position=.2
  local a,b,c=tick(.02)
  assert(a==nil and b=='unchanged-result'and c==false)
  assert(report.state=='completed'and #report.rows==1 and report.appliedFrames==1)
  assert(speech.update==closingUpdate and face.sync==originalSync)
  tick(.02);assert(writes==1 and updates==2)
`));

test('unload, shutdown and deadlines restore delegates without native calls or stale actor handles',()=>run(`
  probe.start();startReply();tick(.02)
  local a,b=speech.abandon();assert(a==nil and b=='abandon-result')
  assert(report.state=='unloaded'and restored()and abandons==1)
  probe.start();speech.stop('shutdown');assert(report.state=='shutdown'and restored())
  probe.start();wall=wall+121;tick(0)
  assert(report.state=='deadline'and restored())
  probe.start();wall=wall+121;speech.pauseForWorld()
  assert(report.state=='deadline'and restored())
`));

test('bounded rows and capture time stop without per-frame file writes',()=>run(`
  probe.start();startReply()
  for i=1,2500 do cadence.position=math.min(4,i/10000);tick(.0001)end
  assert(report.state=='row-limit'and #report.rows==2400 and restored()and writes==1)
  probe.start();startReply()
  for i=1,30 do tick(1)end
  assert(report.state=='deadline'and restored()and writes==2)
`));

test('cancel, replacement and another owner replacing a delegate cannot leave or overwrite stale hooks',()=>run(`
  probe.start();probe.start();assert(writes==1 and report.state=='replaced')
  startReply();tick(.02);assert(updates==1 and face.applied==1)
  local replacement=function()return 'replacement'end
  speech.pauseForWorld=replacement;probe.stop('cancelled')
  assert(report.state=='cancelled'and speech.pauseForWorld==replacement and speech.update==originalUpdate)
  speech.pauseForWorld=originalPause;probe.start();startReply();tick(.02)
  speech.requestId='different private request';tick(.02)
  assert(report.state=='replaced'and restored())
`));

test('delegate errors preserve the exact error object and restore every owned hook',()=>run(`
  local fault={private='not emitted'}
  speech.update=function()error(fault)end
  local broken=speech.update
  probe.start();local ok,err=pcall(speech.update,.01)
  assert(not ok and err==fault and report.state=='delegate-error')
  assert(speech.update==broken and face.sync==originalSync and speech.stop==originalStop)
  speech.update=originalUpdate;face.sync=function()error(fault)end
  local brokenSync=face.sync
  probe.start();startReply();local ok,err=pcall(tick,.01)
  assert(not ok and err==fault and face.sync==brokenSync and speech.update==originalUpdate)
  assert(report.state=='delegate-error'and probe.hooks==nil)
`));

test('another subsystem retaining an old wrapped delegate cannot reactivate it on rearm',()=>run(`
  probe.start();local retained=speech.update
  local external=function(...)return retained(...)end
  speech.update=external;probe.stop('cancelled')
  assert(speech.update==external and writes==1)
  probe.start();startReply();tick(.02);speech.stop('finished')
  assert(writes==2 and report.state=='completed'and #report.rows==1)
  assert(report.updates==1 and report.syncCalls==1 and updates==1)
  assert(speech.update==external and face.sync==originalSync)
  tick(.02);assert(writes==2 and updates==2)
`));

test('report-write failure cannot hide delegate results and still restores the hooks',()=>run(`
  local failing=(function()${source}end)().new({speech=speech,face=face,
    clock=function()return clock end,wall=function()return wall end,
    publish=function()error('disk full')end})
  failing.start();startReply();tick(.02)
  local a,b,c=speech.stop('finished')
  assert(a==false and b==nil and c=='stop-result' and restored())
  assert(not failing.active and failing.published==false)
`));

test('actual request-file diagnostic branch arms and cancels through existing delegates',()=>run(`
  local request='speech-cadence:arm:development'
  io.open=function(path,mode)
    assert(path=='runtime/diagnostic-request.txt'and mode=='rb')
    return {read=function()return request end,close=function()end}
  end
  local module=(function()${source}end)()
  dofile=function(path)
    assert(path=='speech-cadence-probe.lua')
    return {new=function(options)
      assert(options.speech==speech and options.face==face)
      options.clock=function()return clock end;options.wall=function()return wall end
      options.publish=function(value)writes=writes+1;report=value end
      return module.new(options)
    end}
  end
  convaiSpeech,convaiFacialPlayback=speech,face
  local function diagnostic()(function()${diagnostics}end)()end
  diagnostic();assert(convaiSpeechCadenceProbe.active and writes==0)
  startReply();tick(.02)
  request='speech-cadence:stop:development';diagnostic()
  assert(not convaiSpeechCadenceProbe.active and report.state=='cancelled'and restored())
`));
