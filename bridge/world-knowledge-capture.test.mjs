import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import fengari from 'fengari';
import {parseWorldSnapshot} from './world-knowledge.mjs';

const source = readFileSync(new URL('../mod/world-knowledge.lua', import.meta.url), 'utf8');
const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;
function run(body, prefix = '') {
  const state = lauxlib.luaL_newstate(); lualib.luaL_openlibs(state);
  const code = `${prefix}\nlocal module=(function() ${source} end)()\n${body}`;
  const status = lauxlib.luaL_dostring(state, to_luastring(code));
  const error = status === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(state, -1));
  if (status !== lua.LUA_OK) { lua.lua_close(state); assert.fail(error); }
  const convert = index => {
    index = lua.lua_absindex(state, index);
    switch (lua.lua_type(state, index)) {
      case lua.LUA_TNUMBER: return lua.lua_tonumber(state, index);
      case lua.LUA_TBOOLEAN: return lua.lua_toboolean(state, index);
      case lua.LUA_TSTRING: return to_jsstring(lua.lua_tostring(state, index));
      case lua.LUA_TNIL: return null;
      case lua.LUA_TTABLE: {
        const result = {}, keys = []; lua.lua_pushnil(state);
        while (lua.lua_next(state, index)) {
          const key = convert(-2); keys.push(key); result[key] = convert(-1); lua.lua_pop(state, 1);
        }
        return keys.length && keys.every(key => Number.isInteger(key) && key >= 1 && key <= keys.length)
          ? Array.from({length: keys.length}, (_, i) => result[i + 1]) : result;
      }
      default: assert.fail('Native/nonplain value escaped capture');
    }
  };
  const result = lua.lua_gettop(state) ? convert(-1) : undefined;
  lua.lua_close(state); return result;
}

const fixture = `
local time, cpu, generation, token, ready = 100, 0, 1, 'activation-a', true
local calls, values = {facts=0,journal=0,life=0}, {positive=1,negative=-2,zero=0}
local journalRows, proofs = {}, {}
local pack={version=1,gameVersions={'2.31'},factAllowlist={},journalAllowlist={}}
local function fact(key) pack.factAllowlist[key]={evidenceRefs={'native:fact'}} end
local function journal(key,quest) pack.journalAllowlist[key]={questKey=quest or 'test-quest',evidenceRefs={'native:journal'}} end
local context={generation=1,worldToken=token,audience={channel='private',profileKeys={'judy-alvarez'}},
 identity={status='verified',userId='user-a',playthroughId='campaign-a',branchId='branch-a',checkpointId='checkpoint-a'}}
local options={now=function() return time end,cpuNow=function() return cpu end,
 utcNow=function() return '2026-09-30T12:00:00Z' end,
 currentGeneration=function() return generation end,currentWorldToken=function() return token end,
 adapter={isReady=function() return ready end,
 readFact=function(key) calls.facts=calls.facts+1; return values[key],proofs[key] end,
 readJournal=function(key) calls.journal=calls.journal+1; return journalRows[key] end,
 readLifepath=function() calls.life=calls.life+1; return 'nomad' end}}
local function configured()
 local m=module.new(options); assert(m:configure(pack,{gameVersion='2.31'})); return m
end
local function finish(m)
 for _=1,1500 do local r=m:update(context); if r.status=='ready' or r.status=='unavailable' then return r end end
 error('capture never finished')
end
`;

test('native fact zero is unknown; nonzero and signed Int32 reads are exact, with independent presence receipts required for zero', () => run(fixture + `
for _,key in ipairs({'positive','negative','zero','knownzero','badproof','badnumber','stringnumber'}) do fact(key) end
values.knownzero,values.badproof,values.badnumber,values.stringnumber=0,0,2147483648,'1'
proofs.knownzero={status='verified',fact='knownzero',value=0,generation=1,worldToken=token,sourceId='native-presence',evidenceRefs={'presence:1'}}
proofs.badproof={status='verified',fact='badproof',value=0,generation=99,sourceId='native-presence',evidenceRefs={'presence:99'}}
local m=configured(); finish(m); local out=m:capture(context)
assert(out.status=='ready' and out.facts.positive.value==1 and out.facts.negative.value==-2)
assert(out.facts.positive.present==true and out.facts.knownzero.value==0)
assert(out.facts.knownzero.evidenceRefs[2]=='presence:1')
for _,key in ipairs({'zero','badproof','badnumber','stringnumber'}) do assert(out.facts[key].status=='unknown',key) end
`));

test('collector admits only explicitly revealed states and never treats a missing or inactive journal branch as failure', () => run(fixture + `
for index,value in ipairs({'active','succeeded','failed','inactive'}) do
 journal(tostring(index)); journalRows[tostring(index)]={value=value,revealed=true,isQuest=true}
end
journal('5'); journalRows['5']={value='succeeded',revealed=false}; journal('6')
local m=configured(); finish(m); local out=m:capture(context)
assert(out.journal['1'].value=='active' and out.journal['2'].value=='succeeded' and out.journal['3'].value=='failed')
for _,key in ipairs({'4','5','6'}) do assert(out.journal[key].status=='unknown') end
assert(#out.activeQuestKeys==1 and out.activeQuestKeys[1]=='test-quest')
`));

test('capture is cooperative and does not publish a partial cycle', () => run(fixture + `
for index=1,8 do fact('fact'..index); values['fact'..index]=index end
options.batchSize=3; local m=configured()
assert(m:update(context).status=='collecting' and calls.facts==3)
assert(m:capture(context).status=='unavailable')
assert(m:update(context).status=='collecting' and calls.facts==6)
assert(m:update(context).status=='ready' and calls.facts==8 and calls.life==1)
assert(m:capture(context).facts.fact8.value==8)
time=time+0.1; m:update(context); assert(calls.facts==8,'refreshed before configured interval')
`));

test('time budget is checked between individual native observations, with a hard operation count fallback', () => run(fixture + `
for index=1,10 do fact('fact'..index); values['fact'..index]=index end
options.cpuNow=function() cpu=cpu+0.003; return cpu end
options.batchSize=7; local m=configured()
m:update(context); assert(calls.facts==1)
options.cpuNow=function() error('timer unavailable') end
local other=configured(); other:update(context); assert(calls.facts==8)
`));

test('configure rejects unknown patches, arbitrary selectors, oversized implicit inventories and cyclic selection input before any native read', () => run(fixture + `
fact('positive'); local m=module.new(options)
assert(not m:configure(pack,{gameVersion='2.32'}))
assert(not m:configure(pack,{gameVersion='2.31',factKeys={'not_allowlisted'}}))
local cycle={}; cycle[1]=cycle
assert(not m:configure(pack,{gameVersion='2.31',factKeys=cycle}))
for i=1,513 do fact('item'..i) end
local ok,reason=m:configure(pack,{gameVersion='2.31'}); assert(not ok and reason=='selection-required')
assert(m:configure(pack,{gameVersion='2.31',factKeys={'positive'}})); finish(m)
assert(calls.facts==1 and m:capture(context).facts.positive.value==1)
`));

test('every request gets an independent audience, identity and snapshot copy', () => run(fixture + `
fact('positive'); local m=configured(); finish(m)
local first=m:capture(context); first.facts.positive.value=99; first.identity.branchId='future'; first.audience.profileKeys[1]='panam-palmer'
context.audience={channel='group',profileKeys={'judy-alvarez','panam-palmer'}}
context.identity={status='unknown'}
local second=m:capture(context)
assert(second.facts.positive.value==1 and second.identity.status=='unknown' and #second.audience.profileKeys==2)
context.audience={channel='private',profileKeys={'judy-alvarez','panam-palmer'}}
assert(m:capture(context).reason=='invalid-audience')
`));

test('world generation and activation changes invalidate cached values even when V and request generation are unchanged', () => run(fixture + `
fact('positive'); local m=configured(); finish(m); assert(m:capture(context).status=='ready')
generation=2; assert(m:capture(context).status=='unavailable')
context.generation=2; values.positive=2; finish(m); assert(m:capture(context).facts.positive.value==2)
token='activation-b'; context.worldToken=token
assert(m:capture(context).status=='unavailable'); values.positive=3; finish(m)
assert(m:capture(context).facts.positive.value==3)
ready=false; assert(m:capture(context).status=='unavailable')
ready=true; assert(m:capture(context).status=='unavailable','reused pre-unload cache')
finish(m); assert(m:capture(context).status=='ready')
`));

test('a generation change during native reads cannot publish results from two saves', () => run(fixture + `
fact('positive'); options.adapter.readFact=function() generation=2; return 1 end
local m=configured(); assert(m:update(context).status=='unavailable')
assert(m:capture(context).status=='unavailable')
`));

test('emitted activation token survives parsing and cannot be rebound by a same-generation capture after activation changes', () => {
  const actual = run(fixture + `
fact('positive'); local m=configured(); finish(m)
local old=m:capture(context); assert(old.worldToken=='activation-a')
token='activation-b'; context.worldToken=token
assert(m:capture(context).status=='unavailable','old observations inherited a new activation')
values.positive=2; finish(m); local current=m:capture(context)
assert(current.worldToken=='activation-b' and current.facts.positive.value==2)
assert(old.worldToken=='activation-a' and old.facts.positive.value==1)
return {old=old,current=current}
`);
  const old = parseWorldSnapshot(actual.old), current = parseWorldSnapshot(actual.current);
  assert.equal(old.status, 'ready'); assert.equal(current.status, 'ready');
  assert.equal(old.generation, current.generation);
  assert.equal(old.worldToken, 'activation-a'); assert.equal(current.worldToken, 'activation-b');
  assert.notEqual(old.worldToken, current.worldToken);
});

test('lease age includes the whole sampling window, and an expired cycle is discarded', () => run(fixture + `
for i=1,3 do fact('item'..i); values['item'..i]=1 end
options.batchSize=1; local m=configured(); m:update(context)
time=102; m:update(context); m:update(context); m:update(context)
assert(m:capture(context).status=='ready')
time=103.1; assert(m:capture(context).reason=='capture-expired')
m:update(context); time=107; m:update(context)
assert(m:capture(context).status=='unavailable')
`));

test('failed fresh reads replace earlier known values, while fatal readiness and clock failures clear all observations', () => run(fixture + `
fact('positive'); journal('1'); journalRows['1']={value='succeeded',revealed=true}
local m=configured(); finish(m); assert(m:capture(context).facts.positive.value==1)
m.adapter.readFact=function() error('native fact failure') end
m.adapter.readJournal=function() error('native journal failure') end
m.adapter.readLifepath=function() error('native lifepath failure') end
time=101; finish(m); local out=m:capture(context)
assert(out.facts.positive.status=='unknown' and out.journal['1'].status=='unknown' and out.lifepath.status=='unknown')
time=99; assert(m:capture(context).status=='unavailable')
time=102; finish(m); m.adapter.isReady=function() error('native world failure') end
assert(m:capture(context).status=='unavailable')
`));

const nativeFixture = `
Enum={new=function(_,value) return value end}
local stateRows, entries, lookups = {}, {}, {}
local function node(id,class,state,parent)
 local entry={id=id,class=class,state=state,parent=parent}
 function entry:IsA(type) return self.class==type or (type=='gameJournalQuestObjectiveBase'
  and (self.class=='gameJournalQuestObjective' or self.class=='gameJournalQuestSubObjective')) end
 entries[id]=entry; return entry
end
local root=node(10,'gameJournalQuest','Succeeded')
local phase=node(20,'gameJournalQuestPhase','Succeeded',root)
local objective=node(-1,'gameJournalQuestObjective','Succeeded',phase)
local manager={pending=false}
function manager:GetEntry(hash) lookups[#lookups+1]=hash; return entries[hash] or (hash==4294967295 and entries[-1]) end
function manager:GetEntryByString(path,class) assert(path=='quests/test/phase/objective' and class=='gameJournalQuestObjective'); return objective end
function manager:GetEntryHash(entry) return entry.id end
function manager:GetEntryState(entry) return entry.state end
function manager:GetParentEntry(entry) return entry.parent end
function manager:HasAnyDelayedStateChanges() return self.pending end
local attached,dead,pregame,life=true,false,false,'Corporate'
local player={IsAttached=function() return attached end,IsDeadNoStatPool=function() return dead end}
Game={GetPlayer=function() return player end,GetJournalManager=function() return manager end,
 GetQuestsSystem=function() return {GetFactStr=function(_,key) assert(key=='positive'); return 7 end} end,
 GetSystemRequestsHandler=function() return {IsPreGame=function() return pregame end} end,
 GetScriptableSystemsContainer=function() return {Get=function(_,name) assert(name=='PlayerDevelopmentSystem');
  return {GetLifePath=function(_,p) assert(p==player); return life end} end} end}
local pack={version=1,gameVersions={'2.31'},factAllowlist={positive={evidenceRefs={'native:fact'}}},
 journalAllowlist={['-1']={questKey='test-quest',questHash='10',evidenceRefs={'native:journal'}}}}
local context={generation=1,audience={channel='private',profileKeys={'judy-alvarez'}}}
local options={now=function() return 100 end,cpuNow=function() return 0 end,
 utcNow=function() return '2026-09-30T12:00:00Z' end,refreshSeconds=0}
local function capture()
 local m=module.new(options); assert(m:configure(pack,{gameVersion='2.31'})); m:update(context); return m:capture(context)
end
`;

test('default adapter uses exact Uint32 lookup, checks the complete revealed parent chain and reads the loaded player lifepath', () => run(nativeFixture + `
local out=capture(); assert(lookups[1]==4294967295 and out.journal['-1'].value=='succeeded')
assert(out.facts.positive.value==7 and out.lifepath.value=='corpo')
phase.state='Inactive'; assert(capture().journal['-1'].status=='unknown')
phase.state='Succeeded'; root.state='Inactive'; assert(capture().journal['-1'].status=='unknown')
root.state='Succeeded'; phase.parent=phase; assert(capture().journal['-1'].status=='unknown')
phase.parent=root; root.id=11; assert(capture().journal['-1'].status=='unknown')
root.id=10; life='Invalid'; assert(capture().lifepath.status=='unknown')
manager.pending=true; assert(capture().status=='unavailable')
`));

test('reviewed full journal paths may disambiguate hashes, but wrong class, missing parents and unrelated entries remain unknown', () => run(nativeFixture + `
pack.journalAllowlist['-1'].nativePath='quests/test/phase/objective'
pack.journalAllowlist['-1'].nativeClass='gameJournalQuestObjective'
assert(capture().journal['-1'].value=='succeeded' and #lookups==0)
objective.class='gameJournalPhoneMessage'; assert(capture().journal['-1'].status=='unknown')
objective.class='gameJournalQuestObjective'; objective.parent=nil
assert(capture().journal['-1'].status=='unknown')
`));

test('native ancestor work is bounded even for a very deep, noncyclic graph', () => run(nativeFixture + `
local previous=root
for i=1,30 do previous=node(100+i,'gameJournalQuestPhase','Active',previous) end
objective.parent=previous
local parentReads=0
function manager:GetParentEntry(entry) parentReads=parentReads+1; return entry.parent end
options.journalDepth=5
assert(capture().journal['-1'].status=='unknown' and parentReads==5)
`));

test('a captured Lua snapshot conforms to the bridge parser, including absent empty lists and unknown native identity', () => {
  const actual = run(nativeFixture + 'return capture()');
  const parsed = parseWorldSnapshot(actual);
  assert.equal(parsed.status, 'ready');
  assert.equal(parsed.generation, 1);
  assert.equal(parsed.facts.positive.value, 7);
  assert.equal(parsed.journal['-1'].value, 'succeeded');
  assert.deepEqual(parsed.identity, {status: 'unknown'});
  assert.deepEqual(parsed.activeQuestKeys, []);
});

test('snapshot byte budget fails closed instead of returning a truncated or oversized observation set', () => run(fixture + `
for i=1,512 do
 local suffix=tostring(i); local key=string.rep('x',155-#suffix)..suffix; fact(key); values[key]=1
 journal(tostring(i),string.rep('q',155-#suffix)..suffix)
 journalRows[tostring(i)]={value='succeeded',revealed=true}
end
options.batchSize=128; local m=configured(); finish(m)
assert(m:capture(context).reason=='snapshot-byte-limit')
`));
