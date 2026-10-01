import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {validateKnowledgePack, resolveKnowledge} from './world-knowledge.mjs';

const pack=JSON.parse(await readFile(new URL('../research/cyberpunk/native-rules/judy-river.json',import.meta.url),'utf8'));
const prefix='jr-native.';
const ids=['disasterpiece-evelyn-extracted','both-evelyn-burial-received','revolution-overnight','pyramid-dive-completed'].map(id=>prefix+id);
const authored=pack.rules.filter(rule=>ids.includes(rule.id));
const selectedIds=result=>result.diagnostics.rules.filter(row=>row.status==='selected'&&ids.includes(row.ruleId)).map(row=>row.ruleId).sort();
const contextFacts=result=>JSON.parse(result.context.slice(result.context.indexOf('\n')+1)).facts;
function snapshot({facts={},journal={},channel='private',profiles=['judy-alvarez'],gameVersion='2.31',disclosures=[]}={}) {
 return {version:1,status:'ready',gameVersion,generation:1,capturedAt:'2026-10-01T08:00:00.000Z',
  audience:{channel,profileKeys:profiles},facts,journal,disclosures,activeQuestKeys:[]};
}
const fact=(value=1,present=true)=>({status:'known',value,present,sourceId:'native-capture',evidenceRefs:['fact-capture']});
const journal=(questKey,value='succeeded',revealed=true)=>({status:'known',value,revealed,questKey,sourceId:'native-capture',evidenceRefs:['journal-capture']});
const rescue=()=>({facts:{q105_03_done:fact()},journal:{'judy-river.disasterpiece.completed':journal('disasterpiece')}});
const burial=()=>({journal:{'judy-river.judy-burial':journal('both-sides-now','active')}});
const overnight=()=>({journal:{'judy-river.judy-overnight-breakfast':journal('talkin-bout-a-revolution','active'),
 'judy-river.judy-overnight-rested':journal('talkin-bout-a-revolution')}});
const dive=()=>({facts:{sq030_09_pier_done:fact(),sq030_lake_exploration:fact()}});
const resolve=(values={},profileKey='judy-alvarez',customPack=pack)=>resolveKnowledge({pack:customPack,snapshot:snapshot(values),profileKey,maxChars:12000});

test('Judy expansion is source qualification with exact native selectors and private participant audiences',()=>{
 assert.deepEqual(validateKnowledgePack(pack),{ok:true,errors:[]});
 assert.equal(authored.length,4);
 for(const rule of authored){
  assert.equal(rule.status,'source-verified');assert.equal(rule.reviewed,true);
  assert.deepEqual(rule.audience,{speakers:['judy-alvarez'],perspective:'participant',channels:['private','phone'],recipients:['v','judy-alvarez']});
  assert.equal(rule.narrativeLinks.length,1);
 }
 assert.equal(pack.journalAllowlist['judy-river.disasterpiece.completed'].nativeClass,'gameJournalQuest');
 assert.equal(pack.journalAllowlist['judy-river.judy-burial'].nativePath,'contacts/judy/sq026_01_burial/02_judy_msg_burial');
 assert.equal(pack.journalAllowlist['judy-river.judy-overnight-rested'].nativeClass,'gameJournalQuestObjective');
 assert.equal(pack.journalAllowlist['judy-river.judy-overnight-rested'].nativePath,'quests/side_quest/sq026_03_pizza/01_pizza_night/stay_night');
});
test('each positive historical route resolves independently for Judy in private and phone conversations',()=>{
 for(const [id,values] of [[ids[0],rescue()],[ids[1],burial()],[ids[2],overnight()],[ids[3],dive()]]){
  for(const channel of ['private','phone']) assert.deepEqual(selectedIds(resolve({...values,channel})),[id]);
 }
});
test('missing and zero flags are unknown or false rather than a rejected rescue or dive choice',()=>{
 assert.deepEqual(selectedIds(resolve()),[]);
 for(const key of ['q105_03_done','sq030_09_pier_done']){
  for(const present of [true,false,'unknown']){
   const result=resolve({facts:{[key]:fact(0,present)}});
   assert.deepEqual(selectedIds(result),[]);assert.match(result.context,/Missing information is unknown/);
  }
 }
 assert.deepEqual(selectedIds(resolve({journal:rescue().journal})),[]);
});
test('Disasterpiece needs the exact finished quest as well as the positive extraction fact',()=>{
 for(const state of ['active','failed'])assert.deepEqual(selectedIds(resolve({facts:rescue().facts,journal:{'judy-river.disasterpiece.completed':journal('disasterpiece',state)}})),[]);
 assert.deepEqual(selectedIds(resolve({facts:rescue().facts})),[]);
 assert.deepEqual(selectedIds(resolve({facts:rescue().facts,journal:{'judy-river.disasterpiece.completed':journal('pyramid-song')}})),[]);
});
test('an available or unrevealed message never qualifies burial or an overnight stay',()=>{
 for(const [key,quest] of [['judy-river.judy-burial','both-sides-now'],['judy-river.judy-overnight-breakfast','talkin-bout-a-revolution']]){
  for(const state of ['active','succeeded','failed','inactive'])assert.deepEqual(selectedIds(resolve({journal:{[key]:journal(quest,state,false)}})),[]);
 }
});
test('the overnight message alone cannot run ahead of the completed sleep objective',()=>{
 const values=overnight();delete values.journal['judy-river.judy-overnight-rested'];assert.deepEqual(selectedIds(resolve(values)),[]);
 for(const state of ['active','failed'])assert.deepEqual(selectedIds(resolve({journal:{...overnight().journal,'judy-river.judy-overnight-rested':journal('talkin-bout-a-revolution',state)}})),[]);
 const onlyObjective=overnight();delete onlyObjective.journal['judy-river.judy-overnight-breakfast'];assert.deepEqual(selectedIds(resolve(onlyObjective)),[]);
});
test('pier skip/completion without positive underwater history does not manufacture a completed dive',()=>{
 assert.deepEqual(selectedIds(resolve({facts:{sq030_09_pier_done:fact()}})),[]);
 assert.deepEqual(selectedIds(resolve({facts:{sq030_lake_exploration:fact()}})),[]);
 assert.deepEqual(selectedIds(resolve({facts:{sq030_09_pier_done:fact(),sq030_lake_exploration:fact(0)}})),[]);
 assert.deepEqual(selectedIds(resolve({facts:{sq030_09_pier_done:fact(0),sq030_lake_exploration:fact()}})),[]);
 assert.deepEqual(selectedIds(resolve({facts:{sq030_09_pier_done:fact(),sq030_lake_exploration:fact(2)}})),[ids[3]]);
});
test('refusal success and a shared Johnny flag do not establish an overnight stay or an exact disclosure',()=>{
 const result=resolve({facts:{sq026_03_done:fact(),judy_knows_johnny:fact()},
  journal:{'judy-river.revolution.completed':journal('talkin-bout-a-revolution')}});
 assert.deepEqual(selectedIds(result),[]);
 assert(!authored.some(rule=>JSON.stringify(rule.condition).includes('judy_knows_johnny')));
 assert(!authored.some(rule=>rule.topic.includes('disclosure')));
});
test('historical extraction and later death coexist without inventing Evelyn medical recovery',()=>{
 const values={facts:rescue().facts,journal:{...rescue().journal,...burial().journal}};
 const result=resolve(values);assert.deepEqual(selectedIds(result),[ids[0],ids[1]].sort());
 assert.equal(result.diagnostics.counts.conflicted,0);
 const texts=contextFacts(result).map(row=>row.text).join(' ');
 assert.match(texts,/medical recovery and later fate are separate/);assert.match(texts,/Evelyn died/);
});
test('private Judy history stays private even if a group contains Judy or supplies a disclosure receipt',()=>{
 const values={facts:{...rescue().facts,...dive().facts},journal:{...rescue().journal,...burial().journal,...overnight().journal},
  channel:'group',profiles:['judy-alvarez','river-ward'],disclosures:[{status:'known',from:'v',topic:'judy.overnight_care',outcome:'stayed',to:['judy-alvarez','river-ward'],sourceId:'player-report',evidenceRefs:['dialogue-receipt']}]};
 assert.deepEqual(selectedIds(resolve(values)),[]);assert.deepEqual(selectedIds(resolve(values,'river-ward')),[]);
 assert.deepEqual(selectedIds(resolve({...values,channel:'private',profiles:['evelyn-parker']},'evelyn-parker')),[]);
});
test('contradictory stage evidence and genuinely conflicting outcomes are suppressed',()=>{
 assert.deepEqual(selectedIds(resolve({facts:rescue().facts,journal:{'judy-river.disasterpiece.completed':journal('disasterpiece','failed')}})),[]);
 const inconsistent=structuredClone(pack),opposite=structuredClone(authored[0]);
 opposite.id='jr-native.test-contradictory-extraction';opposite.outcome='not-extracted';opposite.statement='Fixture contradicts extraction.';
 inconsistent.rules.push(opposite);
 const result=resolve(rescue(),'judy-alvarez',inconsistent);assert.deepEqual(selectedIds(result),[]);
 assert(result.diagnostics.conflicts.some(row=>row.topic==='evelyn.recovery'));
});
test('unknown game versions and a fresh rollback snapshot never reuse future Judy history',()=>{
 assert.equal(resolve({...rescue(),gameVersion:'2.32'}).diagnostics.status,'unsupported-game-version');
 assert.deepEqual(selectedIds(resolve(rescue())),[ids[0]]);
 assert.deepEqual(selectedIds(resolve()),[]);
});
