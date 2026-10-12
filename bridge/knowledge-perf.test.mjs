import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import fengari from 'fengari';
import {freshQuest} from './journal-history.mjs';

// Per-frame cost of the knowledge collectors (docs/PERFORMANCE_NATIVE_PLAN.md item 1): the compact pack cache, the
// event-driven re-stamp of resting caches, the history quest-count skip, background pacing with a lift on demand, and
// the ahead-of-time encoding of finished scans.
const worldSource = readFileSync(new URL('../mod/world-knowledge.lua', import.meta.url), 'utf8');
const historySource = readFileSync(new URL('../mod/journal-history.lua', import.meta.url), 'utf8');
const partsSource = readFileSync(new URL('../mod/knowledge-parts.lua', import.meta.url), 'utf8');
const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;

function run(body) {
  const vm = lauxlib.luaL_newstate(); lualib.luaL_openlibs(vm);
  const code = `local worldModule=(function() ${worldSource} end)()
local historyModule=(function() ${historySource} end)()
local parts=(function() ${partsSource} end)()
${helpers}
${body}`;
  const status = lauxlib.luaL_dostring(vm, to_luastring(code));
  if (status !== lua.LUA_OK) {
    const error = to_jsstring(lua.lua_tostring(vm, -1)); lua.lua_close(vm);
    const line = Number(/:(\d+):/.exec(error)?.[1]);
    assert.fail(line ? `${error} | at: ${code.split('\n')[line - 1]}` : error);
  }
  const convert = index => {
    index = lua.lua_absindex(vm, index);
    switch (lua.lua_type(vm, index)) {
      case lua.LUA_TSTRING: return to_jsstring(lua.lua_tostring(vm, index));
      case lua.LUA_TNUMBER: return lua.lua_tonumber(vm, index);
      case lua.LUA_TBOOLEAN: return lua.lua_toboolean(vm, index);
      case lua.LUA_TNIL: return null;
      case lua.LUA_TTABLE: {
        lua.lua_checkstack(vm, 8); const entries = {}, keys = []; lua.lua_pushnil(vm);
        while (lua.lua_next(vm, index)) { const key = convert(-2); keys.push(key); entries[key] = convert(-1); lua.lua_pop(vm, 1); }
        return keys.length && keys.every(key => Number.isInteger(key) && key > 0 && key <= keys.length)
          ? Array.from({length: keys.length}, (_, i) => entries[i + 1]) : entries;
      }
      default: assert.fail('a function or handle escaped');
    }
  };
  const result = lua.lua_gettop(vm) ? convert(-1) : undefined; lua.lua_close(vm); return result;
}

const helpers = `
-- A small real JSON encoder (sorted keys, empty table as {}), so encoded strings can be parsed by the test.
local function jsonEncode(value)
 local kind=type(value)
 if kind=='string' then return '"'..value:gsub('[\\\\"]','\\\\%0')..'"' end
 if kind=='number' or kind=='boolean' then return tostring(value) end
 assert(kind=='table','cannot encode '..kind)
 local n=#value
 if n>0 then local out={} for i=1,n do out[i]=jsonEncode(value[i]) end return '['..table.concat(out,',')..']' end
 local keys={} for k in pairs(value) do keys[#keys+1]=k end table.sort(keys)
 local out={} for _,k in ipairs(keys) do out[#out+1]=jsonEncode(tostring(k))..':'..jsonEncode(value[k]) end
 return '{'..table.concat(out,',')..'}'
end
local function deepEqual(a,b)
 if type(a)~=type(b) then return false end
 if type(a)~='table' then return a==b end
 for k,v in pairs(a) do if not deepEqual(v,b[k]) then return false end end
 for k in pairs(b) do if a[k]==nil then return false end end
 return true
end
`;

// ---------------------------------------------------------------- compact pack and its cache

const packFixture = `
local function bigPack()
 local pack={version=1,id='x',revision=7,gameVersions={'2.31'},profileKeys={'a','b'},sources={s1={path='junk'}},
  evidence={e1={blob=string.rep('x',2000)}},rules={r1={big=string.rep('y',2000)}},coWitnesses={},
  factAllowlist={},journalAllowlist={}}
 for i=1,40 do pack.factAllowlist['fact'..i]={evidenceRefs={'ev.'..i,'ev.extra'..i},writers={{jsonPath='p',value=1}},
  writerAuditScope={scope='s'}} end
 for i=1,30 do pack.journalAllowlist['j'..i]={questKey='quest'..i,nativePath='quests/q'..i..'/o',nativeClass='gameJournalQuestObjective',
  evidenceRefs={'jev.'..i,'jev.x'..i},extra={more='dropped'}} end
 pack.journalAllowlist.retired={questKey='quest-r',nativePath='quests/r/choice',nativeClass='gameJournalPhoneChoiceEntry',
  evidenceRefs={'r1','r2'},allowRetiredChoiceGroup=true,retiredGroupEvidenceRefs={'r2'},expectedHash='123',questHash='456'}
 pack.journalAllowlist['3735928559']={questKey='quest-hash',evidenceRefs={'h1'},expectedHash='3735928559'}
 return pack
end
local function fakeFile(store,path,mode)
 if mode=='wb' then
  local f={data=''}; function f:write(text) self.data=self.data..text; store[path]=self.data; return true end
  function f:close() return true end; return f
 end
 local data=store[path]; if data==nil then return nil end
 local f={pos=0}
 function f:seek(whence,offset)
  if whence=='end' then self.pos=#data; return #data end
  self.pos=offset or 0; return self.pos
 end
 function f:read(count)
  if count>=#data then local chunk=data:sub(self.pos+1); self.pos=#data; return chunk end
  local chunk=data:sub(self.pos+1,self.pos+count); self.pos=self.pos+#chunk; return chunk
 end
 function f:close() return true end
 return f
end
`;

test('the compact pack configures exactly what the full pack configures and is far smaller', () => {
  const out = run(packFixture + `
local full=bigPack(); local compact=worldModule.compactPack(full)
local a,b=worldModule.new({}),worldModule.new({})
assert(a:configure(full,{gameVersion='2.31'}) and b:configure(compact,{gameVersion='2.31'}))
assert(#a.config.facts==40 and #a.config.journal==32)
assert(deepEqual(a.config.facts,b.config.facts) and deepEqual(a.config.journal,b.config.journal))
assert(compact.factAllowlist.fact1.evidenceRefs[2]==nil and compact.journalAllowlist.retired.evidenceRefs[2]=='r2')
-- an invalid row is not repaired by compaction: both reject it the same way
local bad=bigPack(); bad.factAllowlist.fact1.evidenceRefs={'ok','not valid!'}
local x,y=worldModule.new({}),worldModule.new({})
local okFull,whyFull=x:configure(bad,{gameVersion='2.31'}); local okCompact,whyCompact=y:configure(worldModule.compactPack(bad),{gameVersion='2.31'})
assert(okFull==false and okCompact==false and whyFull==whyCompact,tostring(whyFull)..' '..tostring(whyCompact))
return {full=#jsonEncode(full),compact=#jsonEncode(compact)}
`);
  assert.ok(out.compact * 2 < out.full, `${out.compact} vs ${out.full}`);
});

test('loadPack decodes the big pack once, then a small cache keyed to the source, and rebuilds when the source changes', () => {
  const out = run(packFixture + `
local store={}; local decoded={}; local registry={}; local serial=0
local fullText=jsonEncode(bigPack())
store['world-knowledge.json']=fullText
local env={open=function(path,mode) return fakeFile(store,path,mode) end,
 decode=function(raw)
  decoded[#decoded+1]=#raw
  if raw==fullText then return bigPack() end
  return registry[raw]
 end,
 encode=function(value) serial=serial+1; local key='cache-'..serial..string.rep('.',10); registry[key]=value; return key end,
 source='world-knowledge.json',cache='runtime/knowledge-pack-lua.json'}
local first=worldModule.loadPack(env)
assert(first.sources,'sources'); assert(#decoded==1,'decoded '..#decoded); assert(decoded[1]==#fullText,'len'); assert(store[env.cache],'cache stored')
local second=worldModule.loadPack(env)
assert(#decoded==2 and decoded[2]<#fullText and second.sources==nil and second.factAllowlist.fact1)
local m=worldModule.new({}); assert(m:configure(second,{gameVersion='2.31'}))
-- a changed source (same size, one sampled byte different) is not served from the old cache
local changed=fullText:sub(1,40)..'Z'..fullText:sub(42); store['world-knowledge.json']=changed
local env2=setmetatable({decode=function(raw) decoded[#decoded+1]=#raw; if raw==changed then local p=bigPack(); p.revision=8; return p end return registry[raw] end},{__index=env})
local third=worldModule.loadPack(env2)
assert(third.revision==8 and #decoded==4 and decoded[4]==#changed,#decoded)
-- a missing source or an unreadable cache never throws
assert(worldModule.loadPack({open=function() return nil end,decode=env.decode,encode=env.encode,source='x',cache='y'})==nil)
store[env.cache]='garbage'
local fourth=worldModule.loadPack(setmetatable({decode=function(raw) if raw=='garbage' then error('bad json') end return env2.decode(raw) end},{__index=env2}))
assert(fourth.revision==8)
return {decodes=#decoded}
`);
  assert.equal(out.decodes, 5);
});

// ---------------------------------------------------------------- world collector

const worldFixture = `
local now,cpu,generation,token=100,0,1,'tok'
local calls={facts=0,journal=0,begin=0,finish=0}
local pack={version=1,gameVersions={'2.31'},factAllowlist={},journalAllowlist={}}
for i=1,5 do pack.factAllowlist['f'..i]={evidenceRefs={'e'}} end
pack.journalAllowlist.j1={questKey='q',nativePath='quests/q/o',nativeClass='gameJournalQuestObjective',evidenceRefs={'e'}}
local context={generation=1,worldToken=token,audience={channel='private',profileKeys={'judy-alvarez'}}}
local function build(extra)
 local options={now=function() return now end,cpuNow=function() return cpu end,utcNow=function() return '2026-10-13T10:00:00Z' end,
  currentGeneration=function() return generation end,currentWorldToken=function() return token end,
  adapter={isReady=function() return true end,
   readFact=function(key) calls.facts=calls.facts+1; return 3 end,
   readJournal=function() calls.journal=calls.journal+1; return {value='active',revealed=true,isQuest=true} end,
   readLifepath=function() return 'nomad' end,
   beginBatch=function() calls.begin=calls.begin+1 end,endBatch=function() calls.finish=calls.finish+1 end}}
 for k,v in pairs(extra or {}) do options[k]=v end
 local m=worldModule.new(options); assert(m:configure(pack,{gameVersion='2.31'})); return m
end
local function scan(m) for _=1,100 do local r=m:update(context); if r.status=='ready' then return end end error('no scan') end
`;

test('native systems are acquired once per batch and released even when a read errors', () => {
  run(packFixture + worldFixture + `
local m=build(); scan(m)
assert(calls.begin>=1 and calls.begin==calls.finish,calls.begin..' '..calls.finish)
local broken=build({adapter={isReady=function() return true end,readFact=function() return 3 end,
 readJournal=function() return {value='active',revealed=true} end,readLifepath=function() return nil end,
 beginBatch=function() calls.begin=calls.begin+1 end,endBatch=function() calls.finish=calls.finish+1 end}})
`);
});

test('event-driven world cache: re-stamped while nothing changed, rescanned on a change, a demand or the verify age', () => {
  run(packFixture + worldFixture + `
local m=build(); m.eventDriven=true; scan(m)
local reads=calls.facts
local scannedAt=m.cache.scanned; assert(scannedAt==100)
-- past the 30 s rest with no change event: no native read, but the cache is current again
now=131; m:update(context); assert(calls.facts==reads and m.cache.started==131 and m.nextRefresh==161)
now=170; assert(m:capture(context).status=='ready') -- 39 s old would be too old at 45 s without the re-stamp: it is 39 here, fine
now=200; m:update(context); assert(calls.facts==reads and m.nextRefresh==230)
-- a journal change event: the next rest end is a real scan
m:markChanged(); now=232; scan(m); assert(calls.facts>reads); reads=calls.facts
-- a demand always scans
m:demand(0); assert(m.nextRefresh==nil); scan(m); assert(calls.facts>reads); reads=calls.facts
-- the verify age (120 s) forces a real scan even with no event
now=m.cache.scanned+121; m.nextRefresh=now-1; scan(m); assert(calls.facts>reads)
-- without events wired nothing is re-stamped
local plain=build(); scan(plain); reads=calls.facts; now=now+31; scan(plain); assert(calls.facts>reads)
`);
});

test('the world cache keeps its revision when re-stamped, and the encoded part equals encoding the data whole', () => {
  const out = run(packFixture + worldFixture + `
parts.encode=jsonEncode
local m=build({newEncoder=function(map) return parts.newEncoder(map) end}); m.eventDriven=true; scan(m)
local revision=m.cache.revision
for _=1,40 do m:update(context) end
assert(m.cache.encoded,'encoding finished while resting')
assert(#m.cache.encoded==#jsonEncode(m.cache.data),m.cache.encoded:sub(1,200))
now=131; m:update(context); assert(m.cache.revision==revision)
local header,part=m:capturePart(context)
assert(part.encoded==m.cache.encoded)
return {encoded=part.encoded,revision=revision,whole=jsonEncode(m.cache.data)}
`);
  const data = JSON.parse(out.encoded);
  assert.deepEqual(data, JSON.parse(out.whole));
  assert.equal(Object.keys(data.facts).length, 5);
  assert.equal(data.lifepath.value, 'nomad');
});

// ---------------------------------------------------------------- journal collector

const historyFixture = `
local now,cpu,generation,token=1000,0,1,'world-a'
local counts={roots=0,children=0,rootsHistory=0}
local rootRows={active={{id='1',nativeId='sq_a',title='Current Quest',kind='quest',state='active'}},
 history={{id='2',nativeId='sq_b',title='Old Quest',kind='quest',state='succeeded'},
          {id='3',nativeId='sq_c',title='Older Quest',kind='quest',state='failed'}}}
local childRows={['1']={{id='10',nativeId='objective_a',kind='objective',text='Meet Judy.',state='active'}},
 ['2']={{id='20',nativeId='objective_b',kind='objective',text='Leave the room.',state='succeeded'}},
 ['3']={{id='30',nativeId='objective_c',kind='objective',text='Run.',state='failed'}}}
local context={generation=generation,worldToken=token}
local function build(extra)
 local options={now=function() return now end,cpuNow=function() return cpu end,currentGeneration=function() return generation end,
  currentWorldToken=function() return token end,pageSize=1,
  adapter={isReady=function() return true end,
   roots=function(lane,cursor,limit)
    counts.roots=counts.roots+1; if lane=='history' then counts.rootsHistory=counts.rootsHistory+1 end
    local rows=rootRows[lane]; local page={}
    for i=cursor,math.min(#rows,cursor+limit-1) do page[#page+1]=rows[i] end
    return {rows=page,total=#rows,next=cursor+#page,done=cursor+#page>#rows}
   end,
   children=function(task,limit)
    counts.children=counts.children+1; local rows=childRows[task.id] or {}; local page={}
    for i=task.cursor,math.min(#rows,task.cursor+limit-1) do page[#page+1]=rows[i] end
    return {rows=page,total=#rows,next=task.cursor+#page,done=task.cursor+#page>#rows,
     questState=task.quest=='1' and 'active' or (task.quest=='2' and 'succeeded' or 'failed')}
   end,
   tracked=function() return {status='untracked'} end}}
 for k,v in pairs(extra or {}) do options[k]=v end
 return historyModule.new(options)
end
local function scanAll(m)
 for _=1,300 do m:update(context); if m.lanes.active.cache and m.lanes.history.cache
  and not m.lanes.active.job and not m.lanes.history.job then return end end
 error('journal scan never finished')
end
local function total() return counts.roots+counts.children end
`;

test('a background scan is paced: one page, then a rest; a demand lifts the pacing', () => {
  run(historyFixture + `
local m=build({pace=true,restGap=0.05}); m:update(context); local first=total(); assert(first==1)
for _=1,10 do m:update(context) end
assert(total()==first,'rest between pages: no native call, no page')
cpu=0.06; m:update(context); assert(total()==first+1)
-- cost-proportional rest: a page that took 10 ms rests at least 0.3 s
local before=total(); local clock=0.06
m.cpuNow=function() clock=clock+0.01; return clock end
cpu=100; m.restUntil=0; m:update(context); assert(total()==before+1)
assert(m.restUntil>=clock+0.29,m.restUntil-clock)
-- a demand: every frame takes a page until the lane is done
m:demand({'active','history'},0)
local mark=total(); for _=1,5 do m:update(context) end
assert(total()-mark>=4,'rush takes a page per frame, got '..(total()-mark))
`);
});

test('unpaced collectors (pace off) behave as before: a page per update', () => {
  run(historyFixture + `
local m=build(); for _=1,6 do m:update(context) end; assert(total()>=3,total())
local paced=build({pace=true}); for _=1,6 do paced:update(context) end
`);
});

test('history: the same quest count ends a rescan after its first page and keeps the revision and the rows', () => {
  run(historyFixture + `
local m=build(); scanAll(m)
local revision=m.lanes.history.cache.revision; local rows=m.lanes.history.cache.quests
local scanned=m.lanes.history.cache.scanned
local pagesBefore=total(); local historyBefore=counts.rootsHistory
now=now+301 -- history rest (300 s) is over; the active lane too
for _=1,200 do m:update(context); if not m.lanes.active.job and not m.lanes.history.job and m.skipped then break end end
assert(m.skipped==1,'skipped '..tostring(m.skipped))
assert(counts.rootsHistory-historyBefore==1,'one history page read, got '..(counts.rootsHistory-historyBefore))
local h=m.lanes.history.cache
assert(h.revision==revision and h.quests==rows and h.scanned==scanned and h.started==now and h.finished==now)
assert(m.lanes.history.next==now+300)
assert(m:capture(context).coverage.history.ageSeconds==0)
-- a quest finished: the count changed, so the lane rescans fully and takes a new revision
rootRows.history[#rootRows.history+1]={id='4',nativeId='sq_d',title='Newest',kind='quest',state='succeeded'}
now=now+301
for _=1,200 do m:update(context); if not m.lanes.active.job and not m.lanes.history.job and m.lanes.history.cache.revision~=revision then break end end
assert(m.lanes.history.cache.revision~=revision and m.lanes.history.cache.total==3)
-- an unstable or failed scan is never trusted to stand in for a new one
local failing=build(); scanAll(failing); failing.lanes.history.cache.failed=true
now=now+301; local roots=counts.rootsHistory
local oldRevision=failing.lanes.history.cache.revision
for _=1,200 do failing:update(context); if failing.lanes.history.cache.revision~=oldRevision and not failing.lanes.history.job then break end end
assert(counts.rootsHistory-roots>1)
`);
});

test('history verify age forces a real rescan even when the count matches', () => {
  run(historyFixture + `
local m=build({historyVerify=60}); scanAll(m)
local revision=m.lanes.history.cache.revision
now=now+310
for _=1,200 do m:update(context); if not m.lanes.history.job and m.lanes.history.cache.revision~=revision then break end end
assert(m.lanes.history.cache.revision~=revision and not m.skipped)
`);
});

test('event-driven active lane: re-stamped rows and a new revision with no native call, rescanned on a change or the verify age', () => {
  run(historyFixture + `
local m=build(); m.eventDriven=true; scanAll(m)
local active=m.lanes.active.cache; local revision=active.revision; local pages=total()
local scanned=active.scanned
now=now+11
m:update(context)
assert(total()==pages,'no page for a resting lane with no change event')
assert(active.started==now and active.finished==now and active.revision>revision and m.lanes.active.cache==active)
for _,row in pairs(active.quests) do
 assert(row.observedAtMs==now*1000)
 for _,objective in ipairs(row.objectives) do assert(objective.observedAtMs==now*1000) end
end
assert(m:capture(context).coverage.active.status=='complete' and #m:capture(context).quests==3)
-- the hook fired: the lane must really be read again
m:markChanged(); now=now+11; local before=total()
scanAll(m); assert(total()>before and m.lanes.active.cache.scanned==now)
-- verify age (120 s) with no event
local again=m.lanes.active.cache; local rev=again.revision; before=total()
for _=1,11 do now=now+10; m:update(context) end
assert(total()==before,'re-stamped through the verify age window')
now=now+10; for _=1,200 do m:update(context); if m.lanes.active.cache~=again and not m.lanes.active.job then break end end
assert(total()>before and m.lanes.active.cache~=again)
-- without eventDriven nothing is re-stamped
local plain=build(); scanAll(plain); before=total(); now=now+11
for _=1,100 do plain:update(context); if not plain.lanes.active.job and total()>before then break end end
assert(total()>before)
`);
});

test('a demanded active lane is never re-stamped instead of scanned', () => {
  run(historyFixture + `
local m=build(); m.eventDriven=true; scanAll(m)
now=now+11; m:demand({'active'},0)
local before=total(); scanAll(m); assert(total()>before and m.lanes.active.cache.scanned==now)
`);
});

test('a finished history scan is encoded ahead of time and the part carries the string; the active part does not', () => {
  const out = run(historyFixture + `
parts.encode=jsonEncode
local m=build({newEncoder=function(map) return parts.newEncoder(map) end}); scanAll(m)
for _=1,10 do m:update(context) end
local cache=m.lanes.history.cache
assert(cache.encoded==jsonEncode({quests=cache.quests}),cache.encoded)
local header,list=m:capturePart(context)
local found={}
for _,part in ipairs(list) do found[part.name]=part end
assert(found.history.encoded==cache.encoded and found.active.encoded==nil)
return {encoded=found.history.encoded}
`);
  const data = JSON.parse(out.encoded);
  assert.deepEqual(Object.keys(data.quests).sort(), ['2', '3']);
  assert.equal(data.quests['2'].objectives[0].text, 'Leave the room.');
});

// ---------------------------------------------------------------- parts

test('publish splices an ahead-of-time encoded part into the header and falls back when the string is unusable', () => {
  const out = run(`
parts.encode=jsonEncode
local files={}
parts.open=function(path,mode) return {write=function(_,text) files[path]=text; return true end,close=function() return true end} end
local data={quests={['2']={id='2',title='Old',objectives={{id='20',text='x'}}}}}
local enc=parts.newEncoder(data.quests)
enc:step(10); assert(enc.done)
local part={name='history',revision=4,generation=1,worldToken='tok',data=data,encoded='{"quests":'..enc.text..'}'}
assert(parts.publish({part}))
local spliced=files['runtime/knowledge-history.json']
parts.reset(); part.encoded='not used'; part.revision=5
local bad=part; bad.encoded=nil; assert(parts.publish({bad}))
return {spliced=spliced,whole=files['runtime/knowledge-history.json'],expect=jsonEncode({version=1,part='history',revision=4,
 generation=1,worldToken='tok',data=data})}
`.replace('local enc=', `local enc=`));
  const spliced = JSON.parse(out.spliced);
  assert.equal(spliced.part, 'history'); assert.equal(spliced.revision, 4); assert.equal(spliced.worldToken, 'tok');
  assert.equal(spliced.data.quests['2'].title, 'Old');
  assert.deepEqual(JSON.parse(out.expect), spliced);
  assert.equal(JSON.parse(out.whole).revision, 5);
});

test('the incremental encoder equals whole-map encoding, escapes odd keys and handles an empty map', () => {
  const out = run(`
parts.encode=jsonEncode
local map={['100']={a=1},['al5.x-y']={b={1,2,3}},['we"ird']={c='d'}}
local enc=parts.newEncoder(map)
local steps=0; while not enc.done do enc:step(1); steps=steps+1; assert(steps<20) end
local empty=parts.newEncoder({}); empty:step(1)
local fail=parts.newEncoder({k={}},function() error('no') end); fail:step(1)
return {text=enc.text,whole=jsonEncode(map),empty=empty.text,failed=fail.failed,steps=steps}
`);
  assert.deepEqual(JSON.parse(out.text), JSON.parse(out.whole));
  assert.equal(out.empty, '{}'); assert.equal(out.failed, true); assert.ok(out.steps >= 3);
});

// ---------------------------------------------------------------- bridge

test('the bridge judges a finished quest by its lane age, and an active quest by its own row age as well', () => {
  const history = {coverage: {active: {ageSeconds: 2}, history: {ageSeconds: 40}}};
  const now = 5_000_000;
  const old = {lane: 'history', state: 'succeeded', observedAtMs: now - 3_000_000};
  assert.equal(freshQuest(history, old, 1, now), true);
  assert.equal(freshQuest({coverage: {...history.coverage, history: {ageSeconds: 700}}}, old, 1, now), false);
  assert.equal(freshQuest(history, {lane: 'active', state: 'active', observedAtMs: now - 20_000}, 1, now), false);
  assert.equal(freshQuest(history, {lane: 'active', state: 'active', observedAtMs: now - 5_000}, 1, now), true);
});

test('a journal change followed by a demand takes a page on the very next update, even while paced', () => {
  run(historyFixture + `
local m=build(); m.eventDriven=true; scanAll(m); m.pace=true
now=now+1; m:markChanged(); m:demand({'active','history'},0)
local before=total(); m:update(context)
assert(total()>before,'no page after demand: restUntil='..tostring(m.restUntil))
`);
});
