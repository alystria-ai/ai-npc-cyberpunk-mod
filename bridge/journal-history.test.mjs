import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import fengari from 'fengari';
import {parseJournalHistory, selectJournalHistory} from './journal-history.mjs';

const source = readFileSync(new URL('../mod/journal-history.lua', import.meta.url), 'utf8');
const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;
function run(body) {
  const vm = lauxlib.luaL_newstate(); lualib.luaL_openlibs(vm);
  const status = lauxlib.luaL_dostring(vm, to_luastring(`local module=(function() ${source} end)()\n${body}`));
  if (status !== lua.LUA_OK) { const error = to_jsstring(lua.lua_tostring(vm, -1)); lua.lua_close(vm); assert.fail(error); }
  function convert(index) {
    index = lua.lua_absindex(vm, index);
    switch (lua.lua_type(vm, index)) {
      case lua.LUA_TSTRING: return to_jsstring(lua.lua_tostring(vm, index));
      case lua.LUA_TNUMBER: return lua.lua_tonumber(vm, index);
      case lua.LUA_TBOOLEAN: return lua.lua_toboolean(vm, index);
      case lua.LUA_TNIL: return null;
      case lua.LUA_TTABLE: {
        const entries = {}, keys = []; lua.lua_pushnil(vm);
        while (lua.lua_next(vm, index)) { const key = convert(-2); keys.push(key); entries[key] = convert(-1); lua.lua_pop(vm, 1); }
        return keys.length && keys.every(key => Number.isInteger(key) && key > 0 && key <= keys.length)
          ? Array.from({length: keys.length}, (_, i) => entries[i + 1]) : entries;
      }
      default: assert.fail('Native handle/function escaped emitted snapshot');
    }
  }
  const result = lua.lua_gettop(vm) ? convert(-1) : undefined; lua.lua_close(vm); return result;
}
const fixture = `
local now,generation,worldToken,ready=1000,1,'world-a',true
local counts={roots=0,children=0}
local rootRows={active={{id='1',nativeId='sq_a',title='Current Quest',kind='quest',state='active'}},
 history={{id='2',nativeId='sq_b',title='Old Quest',kind='quest',state='succeeded'}}}
local childRows={['1']={{id='10',nativeId='objective_a',kind='objective',text='Meet Judy.',state='active'}},
 ['2']={{id='20',nativeId='objective_b',kind='objective',text='Leave the room.',state='succeeded'}}}
local context={generation=generation,worldToken=worldToken}
local options={now=function() return now end,currentGeneration=function() return generation end,
 currentWorldToken=function() return worldToken end,pageSize=1,
 adapter={isReady=function() return ready end,
 roots=function(lane,cursor,limit)
  counts.roots=counts.roots+1; local rows=rootRows[lane]; local page={}
  for i=cursor,math.min(#rows,cursor+limit-1) do page[#page+1]=rows[i] end
  return {rows=page,total=#rows,next=cursor+#page,done=cursor+#page>#rows}
 end,
 children=function(task,limit)
  counts.children=counts.children+1; local rows=childRows[task.id] or {}; local page={}
  for i=task.cursor,math.min(#rows,task.cursor+limit-1) do page[#page+1]=rows[i] end
  return {rows=page,total=#rows,next=task.cursor+#page,done=task.cursor+#page>#rows,
    questState=task.quest=='1' and 'active' or 'succeeded'}
 end,
 tracked=function() return {status='known',questId='1',objectiveId='10'} end}}
local function finish(m)
 for i=1,200 do
  m:update(context); local out=m:capture(context)
  if out.status=='ready' and m.lanes.active.cache and m.lanes.history.cache then return out end
 end
 error('journal scan never finished')
end
`;

test('history capture pages native work, keeps only plain data and separates active and completed inventories', () => {
  const actual = run(fixture + `
local m=module.new(options); m:update(context)
assert(counts.roots==1 and counts.children==0)
local out=finish(m)
assert(out.coverage.active.status=='complete' and out.coverage.history.status=='complete')
assert(#out.quests==2 and out.quests[1].objectives[1].text=='Meet Judy.')
out.quests[1].title='Modified'; assert(m:capture(context).quests[1].title=='Current Quest')
return m:capture(context)
`);
  const parsed = parseJournalHistory(actual);
  assert.equal(parsed.status, 'ready'); assert.equal(parsed.quests.length, 2);
  assert.equal(parsed.quests[1].state, 'succeeded');
  assert.equal(parsed.tracked.objectiveId, '10');
});

test('loads and same-generation activation changes cannot inherit old quests, even mid-scan', () => run(fixture + `
local m=module.new(options); finish(m)
worldToken='world-b'; context.worldToken=worldToken
assert(m:capture(context).status=='unavailable')
rootRows.history={}; childRows['1'][1].text='A different loaded objective.'
local out=finish(m); assert(#out.quests==1 and out.quests[1].objectives[1].text=='A different loaded objective.')
options.adapter.children=function() generation=2; return {rows={},total=0,next=1,done=true} end
local changed=module.new(options); changed:update(context); changed:update(context)
assert(changed:capture(context).status=='unavailable')
`));

test('capture marks caps, cyclic trees, failed reads and changing root counts incomplete rather than inventing absence', () => run(fixture + `
rootRows.active[2]={id='3',nativeId='sq_c',title='Another Quest',kind='quest',state='active'}
childRows['10']={{id='1',nativeId='sq_a',kind='phase',state='active'}}
options.maxQuests=1; local m=module.new(options); local out=finish(m)
assert(out.coverage.active.status=='partial' and out.coverage.active.omitted>0)
assert(out.quests[1].objectivesComplete==false)
options.adapter.children=function() error('native failure') end
local broken=module.new(options); out=finish(broken)
assert(out.coverage.active.status=='partial' and #out.quests[1].objectives==0)
`));

test('active observations expire quickly, history has an explicit longer lease, and tracked unknown is distinct from untracked', () => run(fixture + `
local m=module.new(options); finish(m); now=1006
local out=m:capture(context); assert(out.coverage.active.status=='expired' and out.coverage.history.status=='complete')
assert(#out.quests==1 and out.quests[1].id=='2')
options.adapter.tracked=function() return {status='untracked'} end
m.adapter.tracked=options.adapter.tracked; assert(m:capture(context).tracked.status=='untracked')
m.adapter.tracked=function() error('unknown tracking state') end
assert(m:capture(context).tracked.status=='unknown')
now=1181; out=m:capture(context); assert(#out.quests==0 and out.coverage.history.status=='expired')
ready=false; assert(m:capture(context).status=='unavailable'); ready=true
assert(m:capture(context).status=='unavailable')
`));

test('initial background progress is explicitly partial, and changing inventory length or clock rollback cannot masquerade as a complete scan', () => run(fixture + `
local m=module.new(options); m:update(context); local progress=m:capture(context)
assert(progress.coverage.active.status=='partial' and progress.coverage.active.scanning==true)
assert(progress.quests[1].objectivesComplete==false)
rootRows.active[2]={id='3',nativeId='sq_c',title='Another Quest',kind='quest',state='active'}
local count=0
m.adapter.roots=function(lane,cursor,limit)
 count=count+1
 return {rows={{id=tostring(50+count),nativeId='changed'..count,title='Changed',kind='quest',state='active'}},
  total=count==1 and 2 or 3,next=cursor+1,done=count>=2}
end
m:reset(); local out=finish(m)
assert(out.coverage.active.status=='partial' and out.coverage.active.unstable)
now=999; assert(m:capture(context).status=='unavailable')
`));

const nativeFixture = `
Enum={new=function(_,value) return value end}
JournalRequestContext={new=function(v) return v end}; JournalRequestStateFilter={new=function(v) return v end}
GetLocalizedText=function(v) return v end
local nodes={}
local function node(id,nativeId,class,status,text,parent)
 local n={id=id,nativeId=nativeId,class=class,state=status,text=text,parent=parent,children={}}
 function n:IsA(name) return self.class==name or (name=='gameJournalQuestObjectiveBase' and self.class=='gameJournalQuestObjective') end
 function n:GetId() return self.nativeId end
 function n:GetTitle() assert(self.class=='gameJournalQuest'); return self.text end
 function n:GetDescription() assert(self.state~='Inactive','hidden description read'); return self.text end
 nodes[id]=n; if parent then parent.children[#parent.children+1]=n end; return n
end
local folder=node(100,'quests','gameJournalContainerEntry','Inactive','')
local q=node(1,'sq_demo','gameJournalQuest','Succeeded','<b>Old Quest</b>',folder)
local phase=node(2,'phase','gameJournalQuestPhase','Succeeded','',q)
local objective=node(3,'objective','gameJournalQuestObjective','Succeeded','A revealed task.',phase)
local hidden=node(4,'hidden','gameJournalQuestObjective','Inactive','SECRET',phase)
local hiddenPhase=node(5,'future','gameJournalQuestPhase','Inactive','',q)
node(6,'futureTask','gameJournalQuestObjective','Active','SECRET CHILD',hiddenPhase)
local journal={}
function journal:GetQuests(context)
 assert(context.stateFilter.inactive==false)
 if context.stateFilter.succeeded then return nil,{q} end; return {}
end
function journal:GetChildren(entry,filter) assert(filter.inactive==false); return nil,entry.children end
function journal:GetEntry(id) return nodes[id] end
function journal:GetEntryState(entry) return entry.state end
function journal:GetEntryHash(entry) return entry.id end
function journal:GetParentEntry(entry) return entry.parent end
function journal:GetTrackedEntry() return nil end
function journal:GetIsObjectiveOptional() return false end
function journal:HasAnyDelayedStateChanges() return false end
Game={GetJournalManager=function() return journal end,GetPlayer=function() return {
 IsAttached=function() return true end,IsDeadNoStatPool=function() return false end} end,
 GetSystemRequestsHandler=function() return {IsPreGame=function() return false end} end}
local m=module.new({now=function() return 1000 end,pageSize=1})
local context={generation=1,worldToken='native-world'}
for i=1,100 do m:update(context) end
`;
test('real native adapter enumerates revealed completed objectives and paths without hidden labels or future descendants', () => {
  const actual = run(nativeFixture + 'return m:capture(context)');
  const parsed = parseJournalHistory(actual);
  assert.equal(parsed.status, 'ready');
  assert.equal(parsed.quests.length, 1);
  assert.equal(parsed.quests[0].nativePath, 'quests/sq_demo');
  assert.equal(parsed.quests[0].objectives.length, 1);
  assert.deepEqual(parsed.quests[0].objectives[0].questRelativePath, ['sq_demo', 'phase', 'objective']);
  assert.doesNotMatch(JSON.stringify(actual), /SECRET/);
  assert.equal(parsed.tracked.status, 'untracked');
});

const cover = {status: 'complete', ageSeconds: 1, windowSeconds: 0.5, observed: 2, total: 2, omitted: 0, unstable: false};
const quest = (id, title, state = 'succeeded', text = 'Leave the room.') => ({id, nativeId: `sq_${id}`, title, state,
  lane: state === 'active' ? 'active' : 'history', observedAtMs: 999000, objectivesComplete: true,
  objectives: [{id: String(Number(id) + 100), nativeId: 'task', questRelativePath: [`sq_${id}`, 'task'],
    text, state, observedAtMs: 999500}]});
const snapshot = {version: 1, status: 'ready', generation: 1, worldToken: 'world-a', capturedAtMs: 1000000,
  tracked: {status: 'known', questId: '1', objectiveId: '101'}, coverage: {active: cover, history: cover},
  quests: [quest('1', 'Current Quest', 'active', 'Meet Hanako at Embers.'), quest('2', 'Pyramid Song'), quest('3', 'Other Old Quest')]};
const select = (extra = {}) => selectJournalHistory({snapshot, generation: 1, worldToken: 'world-a', now: 1000000,
  profileKey: 'judy-alvarez', ...extra});

test('context filters history by query and character catalog while keeping current tracked objective', () => {
  const output = select({query: 'What about Pyramid Song?', questCatalog: {quests: [
    {key: 'pyramid-song', title: 'Pyramid Song', nativeIds: ['sq_2'], characters: ['judy-alvarez']}]}});
  assert.deepEqual(output.diagnostics.selected, ['1', '2']);
  assert.match(output.context, /Meet Hanako at Embers/);
  assert.match(output.context, /Pyramid Song/); assert.doesNotMatch(output.context, /Other Old Quest/);
  assert.match(output.context, /not prove any optional choice/); assert.match(output.context, /not an atomic snapshot/);
  assert.deepEqual(output.events, []);
});

test('greetings do not inject unrelated active or character-associated quests', () => {
  const extra = structuredClone(snapshot); extra.quests.push(quest('4', 'Another Active Quest', 'active'));
  const output = select({snapshot: extra, query: 'hi', trackedQuestId: '1', questCatalog: {quests: [
    {key: 'pyramid-song', title: 'Pyramid Song', nativeIds: ['sq_2'], characters: ['judy-alvarez']}]}});
  assert.deepEqual(output.diagnostics.selected, []);
  assert.doesNotMatch(output.context, /Current Quest|Pyramid Song|Another Active Quest|Meet Hanako/);
  assert.deepEqual(select({snapshot: extra, query: 'hi'}).diagnostics.selected, ['1']);
  assert.deepEqual(select({snapshot: extra, query: 'What about Pyramid Song?', trackedQuestId: '1'}).diagnostics.selected, ['2']);
});

test('explicit history questions retain past objectives from the tracked quest as well as completed jobs', () => {
  const output = select({query: 'What have we completed so far?', trackedQuestId: '1'});
  assert.deepEqual(output.diagnostics.selected, ['1', '2', '3']);
  assert.match(output.context, /Current Quest|Pyramid Song/);
});

test('generic history cannot create memories or infer hidden choice outcomes from completed status', () => {
  const output = select({query: 'What quests have we completed?'});
  assert.match(output.context, /"status":"succeeded"/);
  assert.match(output.context, /victim fate, romance or secret outcome/);
  assert.deepEqual(output.events, []);
  assert.doesNotMatch(output.context, /romantic relationship confirmed/);
});

test('invalid data, stale generation, same-generation wrong activation and expired publication fail closed', () => {
  assert.equal(select({generation: 2}).context, '');
  assert.equal(select({worldToken: 'world-b'}).context, '');
  assert.equal(select({worldToken: undefined}).context, '');
  assert.equal(select({now: 1011000}).context, '');
  const bad = structuredClone(snapshot); bad.quests[0].objectives[0].state = 'inactive';
  assert.equal(parseJournalHistory(bad).status, 'unavailable');
  bad.quests[0].objectives[0].state = 'active'; bad.quests[0].objectives[0].questRelativePath[0] = 'another_quest';
  assert.equal(parseJournalHistory(bad).status, 'unavailable');
});

test('hard prompt budgets retain complete quoted data and expose omitted objective coverage', () => {
  const large = structuredClone(snapshot); large.quests = [quest('1', 'Current Quest', 'active', 'A'.repeat(1100))];
  large.quests[0].objectives.push({...large.quests[0].objectives[0], id: '102', nativeId: 'other',
    questRelativePath: ['sq_1', 'other'], text: 'B'.repeat(1100)});
  const output = select({snapshot: large, maxChars: 2300});
  assert.ok(output.context.length <= 2300);
  const document = JSON.parse(output.context.slice(output.context.indexOf('\n') + 1));
  assert.equal(document.quests[0].objectivesComplete, false);
  assert.equal(document.quests[0].observedObjectiveCount, 2);
  assert.equal(select({maxChars: 30}).context, '');
});

test('untracked and unknown are distinct; partial inventory cannot claim all jobs complete', () => {
  const partial = structuredClone(snapshot); partial.tracked = {status: 'unknown'};
  partial.coverage.history = {...cover, status: 'partial', omitted: 3};
  assert.match(select({snapshot: partial}).context, /"status":"unknown"/);
  partial.tracked = {status: 'untracked'};
  const output = select({snapshot: partial});
  assert.match(output.context, /"status":"untracked"/); assert.match(output.context, /"status":"partial"/);
  assert.match(output.context, /never infer failure or completion from absence/);
});

test('native adapter records the game quest type once per quest and its last state-change time', () => {
  const typed = nativeFixture.replace('now=function() return 1000 end', 'now=function() return clock end').replace('local m=module.new(', `
local typeReads,stampReads,clock=0,0,1000
EnumInt=function(v) return ({MainQuest=0,SideQuest=1,MinorQuest=2})[v] end
function journal:GetQuestType(entry) typeReads=typeReads+1; return 'MinorQuest' end
function journal:GetEntryTimestamp(entry) stampReads=stampReads+1; return {seconds=entry.id*1000} end
GameTime={GetSeconds=function(t) return t.seconds end}
local m=module.new(`);
  const actual = run(typed + `local first=stampReads
clock=1040; for i=1,100 do m:update(context) end
local out=m:capture(context); out.typeReads,out.rescanned=typeReads,stampReads>first; return out`);
  assert.equal(actual.rescanned, true, 'the test really scanned the history lane twice');
  assert.equal(actual.typeReads, 1, 'cooked quest types are cached per session, not re-read every scan');
  const parsed = parseJournalHistory(actual);
  assert.equal(parsed.quests[0].questType, 'MinorQuest');
  assert.equal(parsed.quests[0].gameTimeSeconds, 1000);
  // A collector without these APIs still publishes the inventory, unannotated.
  const plain = parseJournalHistory(run(nativeFixture + 'return m:capture(context)'));
  assert.equal(plain.quests[0].questType, undefined); assert.equal(plain.quests[0].gameTimeSeconds, undefined);
});

test('quest annotations are optional and malformed ones are dropped rather than trusted', () => {
  const annotated = structuredClone(snapshot);
  annotated.quests[0].questType = 'MainQuest'; annotated.quests[0].gameTimeSeconds = 8745392;
  annotated.quests[1].questType = 'Spoiler<b>'; annotated.quests[1].gameTimeSeconds = -5;
  const parsed = parseJournalHistory(annotated);
  assert.equal(parsed.status, 'ready');
  assert.equal(parsed.quests[0].questType, 'MainQuest'); assert.equal(parsed.quests[0].gameTimeSeconds, 8745392);
  assert.equal(parsed.quests[1].questType, undefined); assert.equal(parsed.quests[1].gameTimeSeconds, undefined);
});

test('temporal words in "what did we do last?" do not pull in a job titled "Last Login"', () => {
  const titled = structuredClone(snapshot); titled.quests[2].title = 'Gig: Last Login';
  const output = selectJournalHistory({snapshot: titled, generation: 1, worldToken: 'world-a', now: 1000000,
    profileKey: 'judy-alvarez', query: 'what did we do last? what next?'});
  assert.doesNotMatch(output.context, /Last Login/);
});
