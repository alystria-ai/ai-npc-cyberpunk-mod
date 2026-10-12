import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {basename} from 'node:path';
import fengari from 'fengari';
import {configureKnowledgeParts, resolveKnowledgeParts} from './knowledge-parts.mjs';
import {parseWorldSnapshot} from './world-knowledge.mjs';
import {parseJournalHistory} from './journal-history.mjs';
import {parseInput} from './protocol.mjs';

// docs/PERFORMANCE_NATIVE_PLAN.md item 1b: a turn names the world and journal parts by revision instead of carrying
// them. The bridge must rebuild exactly the snapshots the Lua collectors' capture() returns.
const worldSource = readFileSync(new URL('../mod/world-knowledge.lua', import.meta.url), 'utf8');
const historySource = readFileSync(new URL('../mod/journal-history.lua', import.meta.url), 'utf8');
const partsSource = readFileSync(new URL('../mod/knowledge-parts.lua', import.meta.url), 'utf8');
const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;

function run(body) {
  const vm = lauxlib.luaL_newstate(); lualib.luaL_openlibs(vm);
  const code = `local worldModule=(function() ${worldSource} end)()
local historyModule=(function() ${historySource} end)()
local parts=(function() ${partsSource} end)()
${fixture}
${body}`;
  const status = lauxlib.luaL_dostring(vm, to_luastring(code));
  if (status !== lua.LUA_OK) { const error = to_jsstring(lua.lua_tostring(vm, -1)); lua.lua_close(vm); assert.fail(error); }
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
        // An empty table becomes {}, as CET's JSON encoder writes it.
        return keys.length && keys.every(key => Number.isInteger(key) && key > 0 && key <= keys.length)
          ? Array.from({length: keys.length}, (_, i) => entries[i + 1]) : entries;
      }
      default: assert.fail('a function or handle escaped');
    }
  };
  const result = lua.lua_gettop(vm) ? convert(-1) : undefined; lua.lua_close(vm); return result;
}

// Files are recorded as the tables handed to the encoder, then serialized here.
const fixture = `
local now,generation,worldToken=1000,1,'lua-world-1-1'
local opens,files,serial,encoded,worldWrites=0,{},0,{},0
parts.encode=function(value) serial=serial+1;local key='json-'..serial;encoded[key]=value;return key end
parts.open=function(path,mode)
 assert(mode=='wb');opens=opens+1;if path=='runtime/knowledge-world.json' then worldWrites=worldWrites+1 end
 return {write=function(_,key) files[path]=encoded[key];return true end,close=function() return true end}
end
local values={a=1,b=-2}
local pack={version=1,gameVersions={'2.31'},factAllowlist={a={evidenceRefs={'native:fact'}},b={evidenceRefs={'native:fact'}}},
 journalAllowlist={['11']={questKey='q-one',evidenceRefs={'native:journal'}}}}
local world=worldModule.new({now=function() return now end,cpuNow=function() return 0 end,
 utcNow=function() return '2026-10-12T12:00:00Z' end,
 currentGeneration=function() return generation end,currentWorldToken=function() return worldToken end,
 adapter={isReady=function() return true end,readFact=function(key) return values[key] end,
  readJournal=function() return {value='active',revealed=true,isQuest=true,nativeHash=11} end,
  readLifepath=function() return 'corpo' end,readGameTime=function() return 4242 end}})
assert(world:configure(pack,{gameVersion='2.31'}))
local rootRows={active={{id='1',nativeId='sq_a',title='Current Quest',kind='quest',state='active'}},
 history={{id='2',nativeId='sq_b',title='Old Quest',kind='quest',state='succeeded'},
  {id='30',nativeId='sq_c',title='Older Quest',kind='quest',state='failed'}}}
local childRows={['1']={{id='10',nativeId='objective_a',kind='objective',text='Meet Judy.',state='active'}},
 ['2']={{id='20',nativeId='objective_b',kind='objective',text='Leave the room.',state='succeeded'}}}
local history=historyModule.new({now=function() return now end,currentGeneration=function() return generation end,
 currentWorldToken=function() return worldToken end,pageSize=1,
 adapter={isReady=function() return true end,
 roots=function(lane,cursor,limit)
  local rows=rootRows[lane];local page={}
  for i=cursor,math.min(#rows,cursor+limit-1) do page[#page+1]=rows[i] end
  return {rows=page,total=#rows,next=cursor+#page,done=cursor+#page>#rows}
 end,
 children=function(task,limit)
  local rows=childRows[task.id] or {};local page={}
  for i=task.cursor,math.min(#rows,task.cursor+limit-1) do page[#page+1]=rows[i] end
  return {rows=page,total=#rows,next=task.cursor+#page,done=task.cursor+#page>#rows,questState=task.quest=='1' and 'active' or 'succeeded'}
 end,
 tracked=function() return {status='known',questId='1',objectiveId='10'} end}})
local context={generation=generation,worldToken=worldToken,audience={channel='private',profileKeys={'judy-alvarez'}},identity={status='unknown'}}
local function settle()
 for _=1,200 do world:update(context);history:update(context) end
end
local function snapshot()
 local full={world=world:capture(context),history=history:capture(context)}
 local worldHeader,worldPart=world:capturePart(context)
 local historyHeader,historyParts=history:capturePart(context)
 local list={};if worldPart then list[#list+1]=worldPart end
 for _,part in ipairs(historyParts or {}) do list[#list+1]=part end
 assert(parts.publish(list))
 local copy={};for path,value in pairs(files) do copy[path]=value end
 return {full=full,request={worldKnowledge=worldHeader,journalHistory=historyHeader},files=copy,opens=opens,worldWrites=worldWrites}
end
`;

const store = files => path => {
  const value = files[`runtime/${basename(path)}`];
  if (value === undefined) throw Object.assign(new Error('missing'), {code: 'ENOENT'});
  return JSON.stringify(value);
};

test('the bridge rebuilds exactly the world and journal snapshots capture() returns, from a request a fraction of their size', () => {
  const out = run(`settle();return snapshot()`);
  assert.ok(out.request.worldKnowledge.ref && out.request.worldKnowledge.facts === undefined, 'the request names the world part');
  assert.ok(out.request.journalHistory.lanes.history.ids.length === 2 && out.request.journalHistory.lanes.active.ids[0] === '1');
  assert.deepEqual(Object.keys(out.files).sort(), ['runtime/knowledge-active.json', 'runtime/knowledge-history.json', 'runtime/knowledge-world.json']);
  configureKnowledgeParts({runtimeDir: 'runtime', readFile: store(out.files)});
  const resolved = resolveKnowledgeParts(out.request);
  assert.deepEqual(resolved.worldKnowledge, out.full.world);
  assert.deepEqual(resolved.journalHistory, out.full.history);
  assert.deepEqual(parseWorldSnapshot(resolved.worldKnowledge), parseWorldSnapshot(out.full.world));
  assert.deepEqual(parseJournalHistory(resolved.journalHistory), parseJournalHistory(out.full.history));
  assert.equal(parseWorldSnapshot(resolved.worldKnowledge).status, 'ready');
  assert.equal(parseJournalHistory(resolved.journalHistory).status, 'ready');
  assert.ok(JSON.stringify(out.request).length < JSON.stringify(out.full).length / 2);
});

test('parts are written once per revision: an unchanged rescan keeps the world revision, a changed fact makes a new one', () => {
  const out = run(`settle();local first=snapshot()
   local again=snapshot()
   now=now+40;world:demand(0);settle()
   local unchanged=snapshot()
   values.a=7;now=now+1;world:demand(0);settle()
   local changed=snapshot()
   return {first=first,again=again,unchanged=unchanged,changed=changed}`);
  assert.equal(out.again.opens, out.first.opens, 'a second turn writes nothing');
  assert.equal(out.unchanged.request.worldKnowledge.ref.revision, out.first.request.worldKnowledge.ref.revision);
  assert.equal(out.unchanged.worldWrites, 1, 'a rescan that saw the same facts does not rewrite the world part');
  assert.notEqual(out.unchanged.request.worldKnowledge.capturedAt, undefined);
  assert.ok(out.changed.request.worldKnowledge.ref.revision > out.first.request.worldKnowledge.ref.revision);
  assert.equal(out.changed.worldWrites, 2, 'a changed fact rewrites the world part once');
  configureKnowledgeParts({runtimeDir: 'runtime', readFile: store(out.changed.files)});
  const resolved = resolveKnowledgeParts(out.changed.request);
  assert.equal(resolved.worldKnowledge.facts.a.value, 7);
  assert.deepEqual(resolved.worldKnowledge, out.changed.full.world);
});

test('a lane in its first scan travels inline, and the rebuilt snapshot still matches capture()', () => {
  const out = run(`for _=1,3 do world:update(context);history:update(context) end;settle()
   rootRows.history[3]=nil;history.lanes.history.next=nil;history.lanes.history.cache=nil
   for _=1,2 do history:update(context) end
   return snapshot()`);
  assert.ok(Array.isArray(out.request.journalHistory.quests) && out.request.journalHistory.quests.length >= 1, 'scanning rows inline');
  assert.equal(out.request.journalHistory.lanes.history, undefined); assert.ok(out.request.journalHistory.lanes.active);
  configureKnowledgeParts({runtimeDir: 'runtime', readFile: store(out.files)});
  const resolved = resolveKnowledgeParts(out.request);
  assert.deepEqual(parseJournalHistory(resolved.journalHistory), parseJournalHistory(out.full.history));
});

test('a missing, stale or other-world part makes that snapshot unavailable for the turn, never a guess', () => {
  const out = run(`settle();return snapshot()`);
  configureKnowledgeParts({runtimeDir: 'runtime', readFile: () => { throw new Error('missing'); }});
  const missing = resolveKnowledgeParts(out.request);
  assert.equal(missing.worldKnowledge.status, 'unavailable'); assert.equal(missing.worldKnowledge.reason, 'knowledge-part-missing');
  assert.equal(missing.journalHistory.status, 'unavailable');
  for (const mutate of [files => { files['runtime/knowledge-world.json'].revision += 1; },
    files => { files['runtime/knowledge-world.json'].worldToken = 'lua-world-9-9'; },
    files => { files['runtime/knowledge-world.json'].generation = 2; }]) {
    const files = structuredClone(out.files); mutate(files);
    configureKnowledgeParts({runtimeDir: 'runtime', readFile: store(files)});
    assert.equal(resolveKnowledgeParts(out.request).worldKnowledge.status, 'unavailable');
  }
  // A request without references is returned unchanged.
  const plain = {requestId: 'x', worldKnowledge: out.full.world};
  assert.equal(resolveKnowledgeParts(plain), plain);
});

test('parseInput rebuilds the parts, and a kept part survives its file being replaced by a newer revision', () => {
  const out = run(`settle();local first=snapshot();values.b=3;now=now+1;world:demand(0);settle();return {first=first,second=snapshot()}`);
  const files = structuredClone(out.first.files);
  const reads = [];
  configureKnowledgeParts({runtimeDir: 'runtime', readFile: path => { reads.push(basename(path)); return store(files)(path); }});
  const request = {requestId: '1-2-3ULL', generation: 2, entity: '3ULL', name: 'Judy', bodyType: 'WomanAverage',
    profileKey: 'judy-alvarez', text: 'Hello', ...out.first.request};
  const parsed = parseInput(JSON.stringify(request));
  assert.equal(parsed.worldKnowledge.status, 'ready'); assert.equal(parsed.journalHistory.status, 'ready');
  assert.equal(parsed.worldKnowledge.facts.b.value, -2);
  Object.assign(files, out.second.files);
  const again = parseInput(JSON.stringify(request));
  assert.equal(again.worldKnowledge.facts.b.value, -2, 'the revision the request names, from the bridge\'s store');
  assert.equal(reads.filter(name => name === 'knowledge-world.json').length, 1, 'read once');
  assert.equal(parseInput(JSON.stringify({...request, ...out.second.request})).worldKnowledge.facts.b.value, 3);
});
