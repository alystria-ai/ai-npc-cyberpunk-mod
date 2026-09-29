import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import fengari from 'fengari';

const {lua,lauxlib,lualib,to_luastring,to_jsstring}=fengari;
const source=readFileSync(new URL('../mod/fact-identity.lua',import.meta.url),'utf8');
function run(code){
  const L=lauxlib.luaL_newstate(); lualib.luaL_openlibs(L);
  const result=lauxlib.luaL_dostring(L,to_luastring(`local Identity=(function()\n${source}\nend)()\n${fixture}\n${code}`));
  const error=result===lua.LUA_OK?'':to_jsstring(lua.lua_tostring(L,-1)); lua.lua_close(L);
  assert.equal(result,lua.LUA_OK,error);
}

// Native scalar API fault model. These execute the actual Lua driver; they do
// not qualify engine observer delivery or native save serialization ordering.
const fixture=`
local C='ffff2222333344445555666677778888'
local B='9999aaaabbbbccccddddeeeeffff1234'
local F='abcdabcdabcdabcdabcdabcdabcdabcd'
local A='10000000000000000000000000000001'
local A2='20000000000000000000000000000002'
local R='a0000000000000000000000000000001'
local R2='b0000000000000000000000000000002'
local P='cyberpunkconvai_mem_v1_'
local function copy(v) if type(v)~='table' then return v end local x={};for k,n in pairs(v)do x[k]=copy(n)end return x end
local function record(g,bank,sequence,branch,epoch)
 return {schema=1,commitGeneration=g,bank=bank,ledgerSequence=sequence or 0,
 campaignId=C,branchId=branch or B,branchEpoch=epoch or 1}
end
local function audit()
 return {version=1,storage=Identity.storage,collisionCount=0,completeWithinScope=true,
 knownFactCount=1,factNames=copy(Identity.factNames),corpusDigest=string.rep('a',64)}
end
local function environment(options)
 options=options or {}
 local e={values={},records={},writes=0,reads=0,accesses=0,world=true,changes={}}
 e.facts={}
 function e.facts:GetFactStr(name)
  e.reads=e.reads+1; if e.onRead then e.onRead(name) end; return e.values[name] or 0
 end
 function e.facts:SetFactStr(name,value)
  e.writes=e.writes+1
  if e.beforeWrite then e.beforeWrite(name,value,e.writes) end
  e.values[name]=value; e.changes[#e.changes+1]={name,value}
  if e.afterWrite then e.afterWrite(name,value,e.writes) end
 end
 function e.newRuntime(runtimeId,writeQualified,restoreQualified)
  return Identity.new({runtimeId=runtimeId or R,getFacts=function()
   e.accesses=e.accesses+1; if e.onAccess then e.onAccess() end; return e.facts
  end,isWorldAvailable=function() return e.world end,
  writeQualified=writeQualified,restoreQualified=restoreQualified,
  collisionAudit=options.audit or audit()})
 end
 e.runtime=e.newRuntime(options.runtimeId,options.writeQualified~=false,options.restoreQualified~=false)
 e.driver=e.runtime.identityFactory({activationId=A})
 e.runtime.attachCurrentWorld()
 return e
end
local function apply(e,kind,fields,driver)
 driver=driver or e.driver; local command=copy(fields or {})
 command.kind=kind; command.expected=command.expected or driver.inspect().expected
 command.confirmedRecords=command.confirmedRecords or copy(e.records)
 if command.preparedRecord then
  local r=command.preparedRecord
  command.campaignId=command.campaignId or r.campaignId
  command.branchId=command.branchId or r.branchId
  command.branchEpoch=command.branchEpoch or r.branchEpoch
  command.ledgerSequence=command.ledgerSequence or r.ledgerSequence
 end
 return driver.apply(command)
end
local function seed(e)
 local r=record(1,0);e.records={r};assert(apply(e,'claim').ok)
 assert(apply(e,'seed',{preparedRecord=r}).ok);return r
end
`;

test('reviewed collision manifest covers the exact driver names without enabling qualification',()=>{
  const report=JSON.parse(readFileSync(new URL('../research/cyberpunk/fact-identity-audit.json',import.meta.url),'utf8'));
  const hash=name=>{let value=0x811c9dc5;for(const byte of Buffer.from(name,'utf8'))value=Math.imul(value^byte,0x01000193)>>>0;return value;};
  assert.equal(report.storage,'quest-facts-v1');assert.equal(report.collisionCount,0);
  assert.equal(report.completeWithinScope,true);assert(report.knownFactCount>=13805);
  assert.equal(new Set(report.manifest.map(entry=>entry.hash32)).size,43);
  assert.deepEqual(report.manifest.map(entry=>entry.name),report.factNames);
  for(const entry of report.manifest)assert.equal(entry.hash32,hash(entry.name));
  assert(Object.values(report.qualification).every(value=>value===false));
  assert(report.coverageGaps.length>=3);
  run(`local reviewed={${report.factNames.map(name=>JSON.stringify(name)).join(',')}}
    assert(#reviewed==#Identity.factNames)
    for i,name in ipairs(reviewed)do assert(Identity.factNames[i]==name)end`);
});

test('construction has no game calls and writes require explicit qualification and audited names',()=>run(`
 local calls=0
 local runtime=Identity.new({runtimeId=R,getFacts=function() calls=calls+1 end,isWorldAvailable=function()return true end})
 assert(calls==0 and #Identity.factNames==43)
 local e=environment({writeQualified=false});e.records={record(1,0)};assert(apply(e,'claim').ok)
 assert(apply(e,'seed',{preparedRecord=e.records[1]}).reason=='fact-writes-unqualified' and e.writes==0)
 for _,mutate in ipairs({function(a)a.collisionCount=1 end,function(a)a.factNames[2]='q001_dex_dead' end,
 function(a)a.corpusDigest='bad'end,function(a)a.completeWithinScope=false end})do
  local a=audit();mutate(a);local x=environment({audit=a});x.records={record(1,0)};assert(apply(x,'claim').ok)
  assert(apply(x,'seed',{preparedRecord=x.records[1]}).reason=='fact-writes-unqualified' and x.writes==0)
 end
`));

test('seed, advance and fork read back exact native limbs and never rewrite the selected bank',()=>run(`
 local e=environment();local original=seed(e);local first=copy(e.values)
 local s=e.driver.capture();assert(s.status=='available' and s.campaignId==C and s.branchId==B)
 assert(s.factHead==2 and s.ledgerSequence==0 and s.restoredProof==nil)
 assert(e.values[P..'0_campaign_1']==65535)
 local r=record(2,1,1);e.records[#e.records+1]=r
 assert(apply(e,'advance',{preparedRecord=r}).ok)
 for name,value in pairs(first)do if name~=P..'head'then assert(e.values[name]==value)end end
 local fork=record(3,0,0,F,2);e.records[#e.records+1]=fork
 assert(apply(e,'fork',{preparedRecord=fork}).ok)
 s=e.driver.capture();assert(s.branchId==F and s.branchEpoch==2 and s.ledgerSequence==0 and s.factHead==6)
`));

test('unknown nonzero owner banks and malformed selected tuples are never overwritten',()=>run(`
 local e=environment();e.values[P..'0_campaign_1']=87;e.records={record(1,0)};assert(apply(e,'claim').ok)
 assert(apply(e,'seed',{preparedRecord=e.records[1]}).reason=='unknown-nonzero-bank' and e.writes==0)
 e=environment();seed(e);local count=e.writes;e.values[P..'0_campaign_1']=87
 e.records[#e.records+1]=record(2,1,0,F,2)
 assert(apply(e,'fork',{preparedRecord=e.records[2]}).reason=='owner-unconfirmed' and e.writes==count)
 e.values[P..'0_seal']=0;assert(e.driver.inspect().status=='unavailable' and e.writes==count)
`));

test('bounded ids, tuple fields and confirmed-record lists reject malformed mutation commands',()=>run(`
 local e=environment();seed(e);local writes=e.writes
 for _,bad in ipairs({'',string.rep('0',32),string.rep('A',32),'../campaign',string.rep('a',33)})do
  local r=record(2,1,0,F,2);r.branchId=bad
  assert(not apply(e,'fork',{preparedRecord=r,confirmedRecords={r}}).ok)
 end
 for _,bad in ipairs({-1,1.5,2147483648,math.huge})do
  local r=record(2,1,1);r.ledgerSequence=bad;assert(not apply(e,'advance',{preparedRecord=r,confirmedRecords={r}}).ok)
 end
 for _,bad in ipairs({0,1073741824,math.huge})do
  local r=record(bad,1,1);assert(not apply(e,'advance',{preparedRecord=r,confirmedRecords={r}}).ok)
 end
 local a,b=record(2,1,1),record(2,1,2)
 assert(apply(e,'advance',{preparedRecord=a,confirmedRecords={a,b}}).reason=='invalid-confirmed-records')
 assert(apply(e,'resume',{confirmedRecords={named=record(1,0)}}).reason=='invalid-confirmed-records')
 assert(e.writes==writes)
`));

test('commands compare runtime, load generation, revision, activation and native head',()=>run(`
 local e=environment();seed(e);local r=record(2,1,1);e.records[#e.records+1]=r;local expected=e.driver.inspect().expected
 for _,key in ipairs({'runtimeId','generation','revision','activationId','factHead'})do
  local stale=copy(expected);stale[key]=type(stale[key])=='number' and stale[key]+1 or R2
  assert(apply(e,'advance',{preparedRecord=r,expected=stale}).reason=='stale-guard')
 end
 assert(apply(e,'advance',{preparedRecord=r,expected=expected}).ok)
 assert(apply(e,'advance',{preparedRecord=r,expected=expected}).reason=='stale-guard')
 local other=e.runtime.identityFactory({activationId=A2});assert(apply(e,'claim',nil,other).ok)
 assert(e.driver.capture().status=='unavailable')
 assert(apply(e,'resume').reason=='lease-mismatch')
 assert(apply(e,'resume',nil,other).ok)
`));

test('CET replacement and an unobserved load require a fresh branch and cannot fabricate restoration',()=>run(`
 local e=environment();seed(e);local old=e.driver.inspect().expected
 local replacement=e.newRuntime(R2,true,true);replacement.attachCurrentWorld()
 local driver=replacement.identityFactory({activationId=A2});assert(apply(e,'claim',nil,driver).ok)
 assert(apply(e,'resume',nil,driver).reason=='fresh-branch-required')
 assert(driver.inspect().origin=='live-origin-unverified' and driver.inspect().restoredProof==nil)
 assert(apply(e,'resume',{expected=old},driver).reason=='stale-guard')
 local fork=record(2,1,0,F,2);e.records[#e.records+1]=fork
 assert(apply(e,'fork',{preparedRecord=fork},driver).ok)
 assert(driver.capture().branchId==F and driver.capture().restoredProof==nil)
`));

test('actual restored proof is immutable, registry-confirmed and qualification-gated',()=>run(`
 local e=environment();local original=seed(e);local saved=copy(e.values)
 local next=record(2,1,1);e.records[#e.records+1]=next;assert(apply(e,'advance',{preparedRecord=next}).ok)
 e.runtime.invalidate();e.values=saved;assert(e.runtime.onRestored())
 local d=e.runtime.identityFactory({activationId=A2});local before=d.inspect()
 assert(before.restoredCandidate.ledgerSequence==0 and before.restoredProof==nil)
 assert(before.origin=='native-restored' and before.restoreQualified==true)
 assert(apply(e,'claim',nil,d).ok)
 local proof=d.inspect().restoredProof
 assert(proof.kind=='native-facts-restored' and proof.source=='PlayerSystem.OnGameRestored')
 assert(proof.ledgerSequence==0 and proof.commitGeneration==1 and proof.factHead==2 and proof.bank==0)
 local fork=record(3,1,0,F,2);e.records[#e.records+1]=fork
 assert(apply(e,'fork',{preparedRecord=fork},d).ok)
 assert(d.capture().confidence=='native-live' and d.capture().restoredProof.branchId==B)
 local later=record(4,0,1,F,2);e.records[#e.records+1]=later
 assert(apply(e,'advance',{preparedRecord=later},d).ok)
 assert(d.capture().restoredProof.ledgerSequence==0 and d.capture().ledgerSequence==1)
 local x=environment({restoreQualified=false});seed(x);x.runtime.onRestored()
 assert(apply(x,'claim').ok);assert(x.driver.inspect().restoredCandidate and x.driver.inspect().restoredProof==nil)
`));

test('attach, serialization, and delayed read success never create a restore receipt',()=>run(`
 local e=environment();seed(e);e.runtime.onBeforeSave();e.runtime.onAfterSave()
 assert(e.driver.inspect().restoredProof==nil and e.driver.inspect().restoredCandidate==nil)
 e.onRead=function()error('native unavailable at boundary')end
 assert(not e.runtime.onRestored());e.onRead=nil;e.runtime.attachCurrentWorld()
 assert(e.driver.inspect().restoredCandidate==nil and e.driver.inspect().restoredProof==nil)
 assert(e.driver.inspect().origin=='live-origin-unverified')
`));

test('same-runtime head acknowledgement loss is reconciled only against the exact prepared record',()=>run(`
 for _,kind in ipairs({'seed','fork'})do
  local e=environment();local r
  if kind=='seed'then r=record(1,0);e.records={r};assert(apply(e,'claim').ok)
  else seed(e);r=record(2,1,0,F,2);e.records[#e.records+1]=r end
  e.afterWrite=function(name)if name==P..'head'then error('lost response after head write')end end
  assert(apply(e,kind,{preparedRecord=r}).reason=='fact-command-uncertain');e.afterWrite=nil
  assert(e.driver.capture().status=='unavailable' and e.driver.inspect().pendingCommit.record.commitGeneration==r.commitGeneration)
  if kind=='seed'then
   assert(apply(e,'resume').reason=='fresh-branch-required')
   local wrong=copy(r);wrong.ledgerSequence=1
   assert(apply(e,'resume',{preparedRecord=wrong}).reason=='fresh-branch-required')
  end
  local writes=e.writes;assert(apply(e,'resume',{preparedRecord=r}).ok and e.writes==writes)
  assert(e.driver.capture().branchId==r.branchId and e.driver.inspect().pendingCommit==nil)
 end
`));

test('pending commit receipt does not survive detach, restore, or a new lease',()=>run(`
 for _,event in ipairs({'detach','restore','claim'})do
  local e=environment();local r=record(1,0);e.records={r};assert(apply(e,'claim').ok)
  e.afterWrite=function(name)if name==P..'head'then error('lost head ack')end end
  assert(not apply(e,'seed',{preparedRecord=r}).ok);e.afterWrite=nil
  local d=e.driver
  if event=='detach'then e.runtime.invalidate();e.runtime.attachCurrentWorld();assert(apply(e,'claim').ok)
  elseif event=='restore'then e.runtime.onRestored();assert(apply(e,'claim').ok)
  else d=e.runtime.identityFactory({activationId=A2});assert(apply(e,'claim',nil,d).ok)end
  assert(d.inspect().pendingCommit==nil and apply(e,'resume',{preparedRecord=r},d).reason=='fresh-branch-required')
 end
`));

test('every seed scalar-write interruption leaves no exposed identity and can finish only the exact intent',()=>run(`
 for cut=1,23 do for _,timing in ipairs({'beforeWrite','afterWrite'})do
  local e=environment();local r=record(1,0);e.records={r};assert(apply(e,'claim').ok)
  e[timing]=function(_,_,n)if n==cut then error('injected scalar interruption')end end
  assert(not apply(e,'seed',{preparedRecord=r}).ok)
  assert(e.driver.capture().status=='unavailable');e[timing]=nil
  local state=e.driver.inspect();assert(state.status=='inspected')
  if state.schema==1 then assert(apply(e,'resume',{preparedRecord=r}).ok)
  else assert(apply(e,'seed',{preparedRecord=r,previousBank={bank=0,empty=true}}).ok)end
  assert(e.driver.capture().campaignId==C and e.driver.capture().ledgerSequence==0)
 end end
`));

test('partial inactive-bank recovery rejects a mixed or unregistered prior payload',()=>run(`
 local e=environment();seed(e);local r=record(2,1,1);e.records[#e.records+1]=r;local base=e.writes
 e.afterWrite=function(_,_,n)if n==base+7 then error('interrupted')end end
 assert(not apply(e,'advance',{preparedRecord=r}).ok);e.afterWrite=nil
 assert(apply(e,'resume').ok)
 e.values[P..'1_campaign_8']=666 -- not old zero or its staged new limb
 local n=e.writes
 assert(apply(e,'advance',{preparedRecord=r,previousBank={bank=1,empty=true}}).reason=='unknown-nonzero-bank')
 assert(e.writes==n)
`));

test('save, detach, restore and lost world abort before any following scalar write',()=>run(`
 for cut=1,23 do for _,event in ipairs({'save','detach','restore','unavailable'})do
  local e=environment();local r=record(1,0);e.records={r};assert(apply(e,'claim').ok)
  e.afterWrite=function(_,_,n)if n==cut then
   if event=='save'then e.runtime.onBeforeSave()
   elseif event=='detach'then e.runtime.invalidate()
   elseif event=='restore'then e.runtime.onRestored()
   else e.world=false end
  end end
  assert(not apply(e,'seed',{preparedRecord=r}).ok)
  assert(e.writes==cut and e.driver.capture().status=='unavailable')
 end end
`));

test('a load callback from the head guard read prevents the next write',()=>run(`
 local e=environment();local r=record(1,0);e.records={r};assert(apply(e,'claim').ok)
 e.afterWrite=function()e.onRead=function(name)if name==P..'head'then
  e.onRead=nil;e.runtime.invalidate()
 end end end
 assert(not apply(e,'seed',{preparedRecord=r}).ok and e.writes==1)
`));

test('mixed serializer snapshots expose only an exact registered active tuple',()=>run(`
 local e=environment();seed(e);local old=copy(e.values);local snapshots={copy(old)}
 local r=record(2,1,1);e.records[#e.records+1]=r
 e.afterWrite=function()snapshots[#snapshots+1]=copy(e.values)end
 assert(apply(e,'advance',{preparedRecord=r}).ok);e.afterWrite=nil
 -- Native serialization is not claimed atomic. Each write-prefix and either
 -- old/new head is accepted only when its selected full bank equals registry.
 for _,values in ipairs(snapshots)do for _,head in ipairs({2,5})do
  local trial=copy(values);trial[P..'head']=head;e.values=trial
  local runtime=e.newRuntime(R2,true,true);runtime.onRestored()
  local d=runtime.identityFactory({activationId=A2});local view=d.inspect()
  if view.status=='inspected'then
   assert(apply(e,'claim',nil,d).ok)
   local proof=d.inspect().restoredProof
   assert(proof and ((proof.ledgerSequence==0 and head==2)or(proof.ledgerSequence==1 and head==5)))
  else assert(d.capture().status=='unavailable')end
 end end
`));
