import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import fengari from 'fengari';

// Fixture for the Stage 0 gesture probe: an in-memory request/response file
// pair, a fake workspot system and DynamicEntitySystem, and the generated
// catalog. Exercises the request flow, guards, watchdog and ownership.
const probe = readFileSync(new URL('../mod/gesture-probe.lua', import.meta.url), 'utf8');
const catalog = readFileSync(process.env.GESTURE_CATALOG || new URL('../mod/gesture-catalog.lua', import.meta.url), 'utf8');
function run(code) {
  const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;
  const vm = lauxlib.luaL_newstate(); lualib.luaL_openlibs(vm);
  const result = lauxlib.luaL_dostring(vm, to_luastring(fixture + code));
  const error = result === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(vm, -1));
  lua.lua_close(vm); assert.equal(result, lua.LUA_OK, error);
}
const fixture = `
local files,logs={}, {}
io={open=function(path,mode)
  if mode:sub(1,1)=='r' then
    if not files[path] then return nil end
    return {read=function()return files[path] end,close=function()end}
  end
  if mode:sub(1,1)=='w' then files[path]='' end
  return {write=function(_, ...) for _,v in ipairs({...}) do files[path]=(files[path] or '')..v end end,close=function()end}
end}
json={encode=function(v) logs[#logs+1]=v;return '{}' end}
local catalogSource=[==[${catalog}]==]
local catalogLoads=0
dofile=function(path) assert(path=='gesture-catalog.lua');catalogLoads=catalogLoads+1;return load(catalogSource)() end
CName={new=function(v)return {value=v} end}
Enum={new=function(k,v)return k..'.'..v end}
NewObject=function(kind) return {kind=kind} end
local calls={}
local function record(name,...) calls[#calls+1]={name=name,args={...}} end
local function count(name) local n=0;for _,c in ipairs(calls) do if c.name==name then n=n+1 end end;return n end
local function lastLog(kind) for i=#logs,1,-1 do if logs[i].kind==kind then return logs[i] end end end
local npc={inWorkspot=false,pos={x=1,y=2,z=0}}
function npc:GetWorldPosition() return self.pos end
function npc:GetWorldOrientation() return {r=1} end
local ws={}
function ws:IsActorInWorkspot(a) return a.inWorkspot end
function ws:PlayInDevice(device,actor,...) record('PlayInDevice',device,actor,...);actor.pendingEnter=true;return true end
function ws:SendJumpToAnimEnt(actor,name,instant) record('jump',name.value,instant) end
function ws:SendFastExitSignal(actor) record('fastExit') end
function ws:StopNpcInWorkspot(actor) record('stopNpc') end
function ws:StopInDevice(actor) record('stopDevice') end
local system={spawned={},managed={},deleted={}}
function system:CreateEntity(spec) record('create',spec);local id={hash=7};self.managed[7]=true;self.spec=spec;return id end
function system:IsSpawned(id) return self.spawnReady==true end
function system:IsManaged(id) return self.managed[id.hash]==true end
function system:IsTagged(id,tag) return tag.value=='CyberpunkConvaiGestureDevice' end
function system:DeleteEntity(id) record('delete');self.managed[id.hash]=nil;return true end
function system:GetTaggedIDs() return {} end
local device={}
player={pos={x=0,y=0,z=0}}
function player:GetWorldPosition() return self.pos end
function device:GetClassName() return {value='gameObject'} end
Game={GetWorkspotSystem=function()return ws end,GetDynamicEntitySystem=function()return system end,
  FindEntityByID=function()return device end,GetPlayer=function()return player end}
local m=(function()${probe}end)()
-- These cases step 0.1 s; production polls the mailbox once a second.
m.pollPeriod=.25
local cat=load(catalogSource)()
local fam=cat.families and cat.families[(cat.characters['Character.Judy'] or {}).talk or 'on_sides']
  or {component=cat.component,idle=cat.idle,clips=cat.clips}
local function firstClip(category)
  for _,c in ipairs(fam.clips) do if c.category==category and c.perRig.woman_base and (c.character==nil or c.character=='judy') then return c end end
end
local entry={serial=1,name='Judy Alvarez',key='judy-alvarez',record='Character.Judy',npc=npc,speed=0,
  motor={kind='hold',stage='holding',feedback={state='Executing'}},person={phase='attend'}}
local held=false
local context={idle=true,settled=true,combat=false,phase='attend',
  suspendHold=function() record('suspend');return true end,resumeHold=function() record('resume') end}
local nonce=0
local function send(command) nonce=nonce+1;files['runtime/gesture-probe-request.txt']='n'..nonce..'\\n'..command end
local function step(seconds,observe)
  for i=1,math.max(1,math.floor(seconds/.1+.5)) do
    m.tick(player, .1, {{entry=entry,transport=entry.transport==true}})
    if npc.pendingEnter then npc.pendingEnter=nil;npc.inWorkspot=true end
    if observe~=false then held=m.observe(entry,context,.1) end
  end
end
local function response() return files['runtime/gesture-probe-response.txt'] or '' end
local function start(extra)
  system.spawnReady=false
  send('start judy'..(extra or ''));step(.3)
  assert(held,'movement must wait while the device spawns')
  system.spawnReady=true;step(.3)
  assert(count('PlayInDevice')>=1,'workspot must start once the device exists')
  step(.2)
  assert(m.states[1].phase=='active','probe should be active: '..tostring(m.states[1].phase))
end
`;

test('start spawns a tagged non-persistent device at the companion and plays in place', () => run(`
  start()
  local spec=system.spec
  assert(spec.templatePath=='cyberpunk_convai\\\\gestures\\\\convai_gesture_device.ent')
  assert(spec.persistState==false and spec.persistSpawn==false and spec.tags[1].value=='CyberpunkConvaiGestureDevice')
  local play=calls[count('create')+1]
  for _,c in ipairs(calls) do if c.name=='PlayInDevice' then play=c end end
  assert(play.args[4].value==fam.component,'talk family component '..tostring(play.args[4].value))
  assert(play.args[8]=='gameWorkspotSlidingBehaviour.DontPlayAtResourcePosition' and play.args[7]==0,'must play where the companion stands, no slide')
  assert(held==true)
`));

test('a gesture returns to the idle loop after its duration', () => run(`
  start()
  local clip=firstClip('neutral')
  send('jump judy '..clip.name);step(.3)
  assert(calls[#calls].name=='jump' and calls[#calls].args[1]==clip.name)
  step(clip.perRig.woman_base.duration)
  local last=calls[#calls]
  assert(last.name=='jump' and last.args[1]==fam.idle.name,'auto return to idle')
`));

test('movement asks for a fast exit, escalates if stuck, then releases the body', () => run(`
  start(' exit=fast keepdevice=off')
  context.idle=false;step(.3)
  assert(count('fastExit')==0,'own speed (entry slide) is not movement')
  context.settled=false;step(.1);context.settled=true;step(.3)
  assert(count('fastExit')==0,'a one-tick group-frame flicker is not movement')
  context.settled=false;step(.5)
  assert(count('fastExit')==0,'unsettled must persist .8 s')
  step(.4)
  assert(count('fastExit')==1 and held,'fast exit first; movement still waits')
  step(1.0)
  assert(count('stopNpc')==0 and count('stopDevice')==0,'a native exit gets time to finish')
  step(2.2)
  assert(count('stopDevice')==1 and count('stopNpc')==0,'StopInDevice after patience, never StopNpcInWorkspot')
  npc.inWorkspot=false;step(.1)
  assert(not held and m.states[1].phase=='off' and count('delete')==1,'released and device deleted')
  assert(lastLog('finished').reason=='movement:unsettled')
`));

test('V walking away more than .75 m ends the stance even if the frame looks settled', () => run(`
  start()
  for i=1,3 do player.pos={x=i*.15,y=0,z=0};step(.1) end
  assert(count('fastExit')==0,'a walking step under .75 m is fine')
  for i=4,6 do player.pos={x=i*.15,y=0,z=0};step(.1) end
  assert(count('fastExit')==1,'default exit is the native fast exit')
  assert(lastLog('guard').reason=='player-moved')
`));

test('a queued command that never starts after the exit is recovered once', () => run(`
  start()
  context.settled=false;step(1.0)
  npc.inWorkspot=false;step(.1)
  assert(m.states[1].phase=='off')
  entry.motor.feedback.state='AICommandState : Enqueued (1)'
  local released=false
  package.loaded=package.loaded or {}
  local realDofile=dofile
  dofile=function(path) if path=='companion-actuator.lua' then return {release=function(motor) released=true end} end;return realDofile(path) end
  step(1.2)
  assert(lastLog('ai-wedged') and released and lastLog('unstick'),'auto recovery')
  local unsticks=0;for _,l in ipairs(logs) do if l.kind=='unstick' then unsticks=unsticks+1 end end
  step(2);assert(unsticks==1,'only once')
`));

test('combat stops the workspot instantly', () => run(`
  start()
  context.combat=true;step(.1)
  assert(count('stopNpc')==0 and count('fastExit')==1,'instant fast exit')
  npc.inWorkspot=false;step(.1)
  assert(not held and lastLog('finished').reason=='combat')
`));

test('a copy taken by transport or not observed is stopped on the next tick', () => run(`
  start()
  step(.1,false);step(.1,false)
  assert(count('fastExit')==1,'unobserved copy must be stopped')
  assert(lastLog('exit-requested').reason=='unobserved')
`));

test('suspend variant releases and restores the owned hold', () => run(`
  start(' variant=suspend')
  assert(count('suspend')>=1)
  send('exit judy');step(.1);npc.inWorkspot=false;step(.1)
  assert(count('resume')==1 and not held)
`));

test('dismissal stops and deletes the device; abandon makes no native calls', () => run(`
  start()
  m.release(entry,'dismissed')
  assert(count('stopNpc')==1 and count('delete')==1 and m.states[1].phase=='off')
  start()
  local before=#calls
  m.abandon('world')
  assert(#calls==before and next(m.states)==nil)
`));

test('unknown commands and missing targets answer without side effects', () => run(`
  send('bogus');step(.3)
  assert(response():find('n1',1,true)==1)
  send('start nobody');step(.3)
  assert(count('create')==0)
`));

test('without a test period the mailbox follows the game: once a second with Developer mode on, every 4 s off', () => run(`
  m.pollPeriod=nil
  local developer=false
  convaiDevMailboxPeriod=function() return developer and 1 or 4 end
  m.pollAt=m.clock
  step(.1);send('bogus');step(1.5)
  assert(response()=='','answered within 1.5 s with Developer mode off')
  step(2.6);assert(response():find('n1',1,true)==1,'no answer within 4 s')
  developer=true;step(4.1)
  send('bogus');step(1.1);assert(response():find('n2',1,true)==1,'no answer within a second with Developer mode on')
  convaiDevMailboxPeriod=nil
`));

test('the idle probe holds no catalog copy: the catalog is read on the first command, once, and again only after a reload', () => run(`
  assert(catalogLoads==0,'loading the probe read the gesture catalog')
  step(.3)
  assert(catalogLoads==0,'an idle tick read the gesture catalog')
  start()
  assert(catalogLoads==1,'the first command reads the catalog once, not '..catalogLoads)
  send('bogus');step(.3)
  m.release(entry,'dismissed');start()
  assert(catalogLoads==1,'later commands reuse the copy, not '..catalogLoads)
`));
