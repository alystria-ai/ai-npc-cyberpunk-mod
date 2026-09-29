import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import fengari from 'fengari';

const source = readFileSync(new URL('../mod/knowledge-state.lua', import.meta.url), 'utf8');
const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;
function run(body) {
  const vm = lauxlib.luaL_newstate(); lualib.luaL_openlibs(vm);
  const result = lauxlib.luaL_dostring(vm, to_luastring(`
local now, world, applies, reads, writes = 100000, 4, 0, 0, 0
local A=string.rep('a',32); local I=string.rep('b',32)
local command, binding, published, failWrite, failNative, failEncode,onBindingRead=nil,nil,nil,false,false,false,nil
local function copy(v) if type(v)~='table' then return v end;local r={};for k,x in pairs(v)do r[k]=copy(x)end;return r end
local state={status='inspected',ready=true,generation=7,revision=0,activationId='',resolved=false,
 campaignId=string.rep('c',32),branchId=string.rep('d',32),branchEpoch=1,ledgerSequence=0}
local function factory(options)
 return {inspect=function()if failNative then error('detached')end;return copy(state)end,
 capture=function()
  if failNative then error('detached')end
  if state.resolved and options.activationId==state.activationId then
   local result=copy(state);result.status='available';result.authoritative=true;result.confidence='native-live';return result
  end
  return {status='unavailable',reason='unresolved'}
 end,
 apply=function(c)
  applies=applies+1
  if c.expected.revision~=state.revision or c.expected.generation~=state.generation then return {ok=false,reason='native-command-rejected'}end
  state.activationId=options.activationId;state.revision=state.revision+1;state.resolved=true
  return {ok=true}
 end}
end
local function encode(v)
 if failEncode then error('bad encoding')end
 if v.version then published=copy(v)end
 return tostring(v.sequence or state.revision)..':'..tostring(v.identity and v.identity.status)..':'..tostring(v.ack and v.ack.id)..':'..tostring(v.ack and v.ack.ok)
end
local function options()
 return {identityFactory=factory,getSystem=function()error('factory owns native')end,
 now=function()return now end,currentGeneration=function()return world end,
 read=function(path,max)reads=reads+1;assert(max==32768);if path:find('knowledge-binding',1,true)then if onBindingRead then onBindingRead()end;return binding and 'binding'end;return command and command.raw end,
 decode=function(raw)if raw=='binding'then return copy(binding)end;assert(command and raw==command.raw);return copy(command.value)end,
 encode=encode,write=function(path,raw)writes=writes+1;return not failWrite end}
end
local m=(function()${source}end)()
local service=m.new(options())
local function issue(fields)
 local value={version=1,id=I,activationId=A,kind='claim',issuedAt=now,expiresAt=now+10000,
  worldGeneration=world,expected={generation=state.generation,revision=state.revision,activationId=state.activationId}}
 for k,v in pairs(fields or {})do value[k]=v end
 command={raw='command:'..value.id..':'..value.kind..':'..tostring(value.expiresAt),value=value}
end
${body}`));
  const error = result === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(vm, -1));
  lua.lua_close(vm); assert.equal(result, lua.LUA_OK, error);
}

test('fact and old-native command envelopes cannot cross identity backends', () => run(`
 issue({storage='quest-facts-v1'});service.update()
 assert(applies==0 and published.ack.reason=='identity-backend-mismatch')
 state.storage='quest-facts-v1';state.runtimeId=string.rep('e',32);state.factHead=2
 issue({id=string.rep('f',32)});service.update()
 assert(applies==0 and published.ack.reason=='identity-backend-mismatch')
 issue({id=string.rep('9',32),storage='quest-facts-v1'});service.update()
 assert(applies==1 and published.ack.ok)
`));

test('fact binding requires exact runtime and head and token changes even when numeric generation repeats', () => run(`
 state.storage='quest-facts-v1';state.runtimeId=string.rep('e',32);state.factHead=2
 local initial=service.snapshot()
 assert(initial.worldToken=='7:'..state.runtimeId..':unclaimed')
 issue({storage='quest-facts-v1'});service.update();command=nil
 binding={version=1,status='ready',publishedAt=now,identity=copy(state)}
 binding.identity.status='verified';binding.identity.authoritative=true
 binding.identity.userId='10000000-1000-4000-8000-100000000001'
 local value=service.capture();assert(value.status=='available')
 assert(value.worldToken=='7:'..state.runtimeId..':'..A..':'..state.branchId)
 for _,key in ipairs({'storage','runtimeId','factHead'})do
  local old=binding.identity[key];binding.identity[key]='wrong'
  assert(service.capture().reason=='bridge-binding-mismatch');binding.identity[key]=old
 end
 onBindingRead=function()state.runtimeId=string.rep('f',32)end
 assert(service.capture().reason=='binding-world-changed')
 local snapshot=service.snapshot()
 assert(snapshot.status=='ready' and snapshot.identity.status=='unavailable')
 assert(snapshot.worldToken~=value.worldToken)
`));

test('construction is inert; explicit update publishes actual native readback and heartbeat', () => run(`
 assert(reads==0 and writes==0 and applies==0)
 assert(service.status().reason=='not-started')
 service.update();assert(published.identity.status=='unavailable' and writes==1)
 issue();service.update();assert(applies==1 and published.ack.ok and published.identity.authoritative)
 local prior=writes;service.update();assert(applies==1 and writes==prior)
 now=now+600;service.update();assert(writes==prior+1 and published.publishedAt==now)
`));

test('duplicate delivery is idempotent and reused IDs cannot disguise a different command', () => run(`
 issue();service.update();service.update();assert(applies==1)
 command.raw=command.raw..':changed';command.value.kind='advance';service.update()
 assert(applies==1 and published.ack.reason=='command-id-reused')
`));

test('expired, oversized, wrong-world and malformed envelopes perform no native mutation', () => {
  for (const prepare of [
    'issue({expiresAt=now})', 'issue({worldGeneration=world-1})',
    "issue({activationId='bad'})", 'issue({expiresAt=now+30001})',
    "issue();command.raw=string.rep('x',32769)",
  ]) run(`${prepare};service.update();assert(applies==0)`);
});

test('a stale CAS acknowledgment stays rejected and state reports the actual newer revision', () => run(`
 issue();state.revision=3;service.update()
 assert(applies==1 and not published.ack.ok and published.ack.reason=='native-command-rejected')
 assert(published.inspection.revision==3 and published.identity.status=='unavailable')
`));

test('CET coordinator replacement adopts read-only lease without claiming or resolving it again', () => run(`
 issue();service.update();command=nil
 local replacement=m.new(options());replacement.update()
 assert(applies==1 and published.identity.status=='available' and published.identity.activationId==A)
`));

test('detach, invalidation and a regressed clock replace reusable identity with unavailable state', () => run(`
 issue();service.update();command=nil;failNative=true;service.update()
 assert(published.status=='unavailable' and not published.identity.authoritative)
 failNative=false;service.invalidate('load-started')
 assert(published.reason=='load-started' and published.identity.activationId==nil)
 now=now-10;service.update();assert(published.reason=='clock-regressed')
`));

test('failed publication reports unavailable and public state is detached plain data', () => run(`
 issue();service.update();local view=service.status();view.identity.activationId='changed'
 assert(service.status().identity.activationId==A)
 failWrite=true;now=now+600;assert(not service.update())
 assert(service.status().reason=='state-publication-failed')
`));

test('phone binding requires fresh bridge user identity and exact native generation lease branch and cursor', () => run(`
 issue();service.update();command=nil
 assert(service.capture().reason=='bridge-binding-unavailable')
 local user='10000000-1000-4000-8000-100000000001'
 binding={version=1,status='ready',publishedAt=now,identity=copy(state)}
 binding.identity.status='verified';binding.identity.authoritative=true;binding.identity.userId=user
 binding.identity.checkpointId='live-'..state.branchId
 local value=service.capture()
 assert(value.status=='available' and value.localUserId==user and value.userId==user)
 assert(value.confidence=='native-live' and value.worldToken=='7:'..A..':'..state.branchId)
 assert(service.inspect().generation==7)
 for _,key in ipairs({'generation','activationId','campaignId','branchId','branchEpoch','ledgerSequence'})do
  local old=binding.identity[key];binding.identity[key]='wrong'
  assert(service.capture().reason=='bridge-binding-mismatch');binding.identity[key]=old
 end
 now=now+5001;assert(service.capture().reason=='bridge-binding-expired')
`));

test('a codec failure never escapes the update callback or republishes stale identity', () => run(`
 issue();service.update();command=nil;failEncode=true
 local ok,value=pcall(service.update);assert(ok and value==false)
 assert(service.status().reason=='state-encoding-failed')
`));

test('snapshot retains current generation for dynamic facts and rejects a race while reading user binding', () => run(`
 local initial=service.snapshot()
 assert(initial.status=='ready' and initial.generation==7 and initial.worldToken=='7:unclaimed')
 assert(initial.identity.status=='unavailable')
 issue();service.update();command=nil
 binding={version=1,status='ready',publishedAt=now,identity=copy(state)}
 binding.identity.status='verified';binding.identity.authoritative=true
 binding.identity.userId='10000000-1000-4000-8000-100000000001'
 local value=service.snapshot();assert(value.status=='ready' and value.identity.localUserId)
 onBindingRead=function()state.ledgerSequence=state.ledgerSequence+1;state.revision=state.revision+1 end
 assert(service.capture().reason=='binding-world-changed')
 assert(service.snapshot().reason=='snapshot-world-changed')
 onBindingRead=nil;state.saving=true
 local paused=service.snapshot()
 assert(paused.status=='paused' and paused.reason=='save-in-progress')
 assert(paused.generation==state.generation and paused.worldToken==value.worldToken)
 assert(paused.identity.status=='unavailable' and paused.identity.userId==nil)
 state.faulted=true;assert(service.snapshot().reason=='native-world-unavailable')
`));
