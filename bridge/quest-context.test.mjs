import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import fengari from 'fengari';
import {parseJournal, journalContext, conversationContext} from './quest-context.mjs';
import {parseInput} from './protocol.mjs';
import {inputIdentity} from './group-prefetch.mjs';
import {PhoneChat, parsePhoneState} from './phone-chat.mjs';

const snapshot = {version: 1, status: 'active', quest: {id: '-123', title: 'Visible quest', objectives: [
  {id: '456', text: 'Meet a friend.', tracked: true, optional: false},
]}};
const input = {requestId: '100-1-10ULL', generation: 1, entity: '10ULL', profileKey: 'judy-alvarez',
  name: 'Judy', bodyType: 'WomanAverage', text: 'What should we do next?', journal: snapshot};

test('journal normalization accepts only bounded public fields and fails closed without losing the message', () => {
  assert.deepEqual(parseJournal(snapshot), snapshot);
  const copy = structuredClone(snapshot); copy.quest.unrevealedEnding = 'Secret';
  copy.quest.objectives[0].secret = 'Hidden';
  assert.deepEqual(parseJournal(copy), snapshot);
  for (const journal of [null, {}, {...snapshot, version: 2}, {...snapshot, status: 'inactive'},
    {...snapshot, quest: {...snapshot.quest, objectives: Array(9).fill(snapshot.quest.objectives[0])}},
    {...snapshot, quest: {...snapshot.quest, title: 'LocKey#12345'}},
    {...snapshot, quest: {...snapshot.quest, objectives: [{id: '1', text: 'Unknown', tracked: 'yes'}]}}]) {
    assert.equal(parseJournal(journal).status, 'unavailable');
    const parsed = parseInput(JSON.stringify({...input, journal}));
    assert.equal(parsed.text, input.text); assert.equal(parsed.journal.status, 'unavailable');
  }
  assert.deepEqual(parseJournal({...snapshot, quest: {...snapshot.quest, objectives: {}}}).quest.objectives, []);
  assert.equal(parseJournal(undefined), undefined);
});

test('quest changes invalidate prepared context and group instructions retain final-speaker ownership', () => {
  const changed = {...input, journal: {version: 1, status: 'untracked'}};
  assert.notEqual(inputIdentity(input), inputIdentity(changed));
  const first = conversationContext({...input, group: {index: 1, total: 2, audience: ['judy-alvarez', 'panam-palmer'], heard: []}});
  assert.match(first, /Do not ask V a question/); assert.match(first, /Visible quest/);
  assert.match(first, /not instructions/); assert.match(first, /not proof that you witnessed/);
  const last = conversationContext({...input, group: {index: 2, total: 2, audience: ['judy-alvarez', 'panam-palmer'], heard: []}});
  assert.match(last, /final speaker/);
  assert.match(journalContext(changed.journal), /does not mean all quests are completed/);
  assert.match(journalContext({version: 1, status: 'unavailable'}), /Do not assume earlier quest progress/);
});

test('phone sends revealed context to Convai while retaining the original display text and identity', async () => {
  const state = parsePhoneState(JSON.stringify({version: 1, world: 'save-1', updated: 100, active: true,
    request: {id: 'save-1-1', contact: 'judy', text: input.text, journal: snapshot}}));
  const calls = [], output = [];
  const phone = new PhoneChat({contacts: [{contact: 'judy', key: 'judy-alvarez'}], ids: {'judy-alvarez': 'character-id'},
    now: () => 100, reply: async call => { calls.push(call); return {text: 'Reply', sessionID: 'session'}; },
    publish: async row => output.push(row)});
  await phone.accept(state); await phone.active?.work;
  assert.equal(state.request.text, input.text);
  assert.match(calls[0].text, /Visible quest/); assert.ok(calls[0].text.endsWith(input.text));
  assert.equal(calls[0].characterId, 'character-id'); assert.equal(calls[0].voice, false);
  assert.equal(output.at(-1).text, 'Reply');
});

const source = readFileSync(new URL('../mod/quest-context.lua', import.meta.url), 'utf8');
const groupSource = readFileSync(new URL('../mod/group-chat.lua', import.meta.url), 'utf8');
function luaCheck(code) {
  const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;
  const vm = lauxlib.luaL_newstate(); lualib.luaL_openlibs(vm);
  const result = lauxlib.luaL_dostring(vm, to_luastring(code));
  const error = result === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(vm, -1));
  lua.lua_close(vm); assert.equal(result, lua.LUA_OK, error);
}
const fixture = `
Enum={new=function(_, value) return value end}
JournalRequestStateFilter={new=function(value) return value end}
GetLocalizedText=function(value) return value end
local function node(id, class, text, state)
  local entry={id=tostring(id),class=class,text=text,state=state or 'Active',children={}}
  function entry:IsA(name) return self.class==name or (name=='gameJournalQuestObjectiveBase'
    and (self.class=='gameJournalQuestObjective' or self.class=='gameJournalQuestSubObjective')) end
  function entry:GetTitle(manager) assert(manager); return self.text end
  function entry:GetDescription() assert(self.state=='Active','Read a hidden/completed description'); return self.text end
  function entry:HasCounter() return self.total~=nil end
  return entry
end
local quest=node(-1,'gameJournalQuest','The current quest')
local phase=node(2,'gameJournalQuestPhase',''); phase.parent=quest; quest.children={phase}
local objective=node(3,'gameJournalQuestObjective','Meet a friend.'); objective.parent=phase; phase.children={objective}
local journal={tracked=objective, calls=0}
function journal:GetTrackedEntry() return self.tracked end
function journal:GetEntryHash(entry) return entry.id end
function journal:GetEntryState(entry) return entry.state end
function journal:GetParentEntry(entry) return entry.parent end
function journal:GetIsObjectiveOptional(entry) return entry.optional==true end
function journal:GetObjectiveCurrentCounter(entry) return entry.current end
function journal:GetObjectiveTotalCounter(entry) return entry.total end
function journal:GetChildren(entry,filter)
  assert(filter.active and not filter.inactive and not filter.succeeded and not filter.failed)
  self.calls=self.calls+1
  -- Return extra states deliberately, to check the adapter's second guard.
  return nil,entry.children
end
local player={IsAttached=function() return true end,IsDeadNoStatPool=function() return false end}
Game={GetPlayer=function() return player end,GetJournalManager=function() return journal end,
  GetSystemRequestsHandler=function() return {IsPreGame=function() return false end} end}
local m=(function() ${source} end)()
`;

test('native journal capture excludes hidden and finished branches, keeps optional counters, and localizes visible text', () => luaCheck(fixture + `
local hidden=node(4,'gameJournalQuestObjective','SECRET FUTURE','Inactive'); hidden.parent=phase
local finished=node(5,'gameJournalQuestObjective','Finished branch','Succeeded'); finished.parent=phase
local hiddenPhase=node(6,'gameJournalQuestPhase','hidden','Inactive')
hiddenPhase.children={node(7,'gameJournalQuestObjective','SECRET UNDER HIDDEN PARENT')}
objective.optional=true; objective.current=2; objective.total=4
objective.text='<b>Rencontrez votre amie.</b>\\n  Maintenant.'
phase.children={hidden,finished,hiddenPhase,objective}
local result=m.capture()
assert(result.status=='active' and #result.quest.objectives==1 and m.lastError==nil,m.lastError)
local row=result.quest.objectives[1]
assert(row.tracked and row.optional and row.current==2 and row.total==4)
assert(row.text=='Rencontrez votre amie. Maintenant.')
assert(journal.calls==3)
`));

test('no tracked quest, native errors and save changes cannot reuse a previous snapshot', () => luaCheck(fixture + `
assert(m.capture().quest.title=='The current quest')
journal.tracked=nil; assert(m.capture().status=='untracked')
journal.tracked=objective; objective.state='Inactive'; assert(m.capture().status=='untracked')
objective.state='Active'; quest.text='A different loaded save'
assert(m.capture().quest.title=='A different loaded save')
player=nil; assert(m.capture().status=='unavailable')
Game.GetPlayer=function() error('Native world unavailable') end
assert(m.capture().status=='unavailable' and m.lastError)
`));

test('journal traversal bounds malformed cycles and large trees while prioritizing the tracked objective', () => luaCheck(fixture + `
phase.parent=phase; assert(m.capture().status=='unavailable')
phase.parent=quest; phase.children={quest}
for i=10,60 do
  phase.children[#phase.children+1]=node(i,'gameJournalQuestObjective','Visible '..i)
end
local result=m.capture()
assert(#result.quest.objectives==8 and result.quest.objectives[1].id=='3')
assert(journal.calls<=12)
`));

test('a group question and its prepared next speaker share one snapshot; the next question reads the new quest', () => luaCheck(fixture + `
local group=(function() ${groupSource} end)()
local captures=0
group.captureJournal=function() captures=captures+1; return m.capture() end
local people={{entity='10ULL',profileKey='judy',name='Judy',bodyType='WomanAverage'},
  {entity='20ULL',profileKey='panam',name='Panam',bodyType='WomanAverage'}}
local live={['10ULL']=true,['20ULL']=true}
group.start('round-1',people,'What next?')
local first=group.next(1,100,live)
quest.text='Changed after the question'
assert(group.received(first.requestId,'The visible objective.',false,{'judy','panam'}))
local preview=group.preview(2,101,live,false)
assert(preview.journal.quest.title=='The current quest' and captures==1)
group.completed(first.requestId,true)
assert(group.next(2,102,live).journal.quest.title=='The current quest')
group.start('round-2',people,'And now?')
assert(group.next(3,103,live).journal.quest.title=='Changed after the question' and captures==2)
`));
