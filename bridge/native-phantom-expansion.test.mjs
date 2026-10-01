import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolveKnowledge, validateKnowledgePack} from './world-knowledge.mjs';

const pack=JSON.parse(readFileSync(new URL('../research/cyberpunk/native-rules/phantom.json',import.meta.url)));
const newIds=['phantom.native.alex.first-meeting','phantom.native.alex.farewell','phantom.native.alex.coin-gifted'];
const newRules=pack.rules.filter(row=>newIds.includes(row.id));
const observation=(value,extra={})=>({status:'known',value,sourceId:'native-scenario',evidenceRefs:['scenario:capture'],...extra});
const fact=value=>observation(value,{present:true});
const journal=(questKey,value='succeeded',extra={})=>observation(value,{questKey,revealed:true,...extra});
const base=()=>({version:1,status:'ready',gameVersion:'2.31',generation:1,capturedAt:'2026-10-01T07:00:00.000Z',gameTimeSeconds:2000,
  identity:{status:'verified',userId:'scenario-user',playthroughId:'scenario-playthrough',branchId:'scenario-branch',checkpointId:'scenario-checkpoint'},
  audience:{channel:'private',profileKeys:['alex']},activeQuestKeys:['unfinished-sympathy'],
  facts:Object.fromEntries(['q303_02_nighthawks_back_with_reed','q304_songbirds_path','q304_lab_done','q306_reed_killed','q306_launchpad_done','q306_epilogue_alex_welcomes_v','q306_alex_coin_given'].map(key=>[key,fact(1)])),
  journal:{'phantom.alex.first-meeting':journal('the-damned'),'phantom.alex.farewell':journal('unfinished-sympathy')}});
function resolve(snapshot=base(),profileKey='alex',inputPack=pack){
  return resolveKnowledge({pack:inputPack,snapshot,profileKey,maxChars:12000});
}
const selected=result=>result.diagnostics.rules.filter(row=>newIds.includes(row.ruleId)&&row.status==='selected').map(row=>row.ruleId).sort();
const content=result=>JSON.parse(result.context.slice(result.context.indexOf('\n')+1)).facts;

test('Phantom expansion admits exactly three reviewed outcomes with positive durable receipts',()=>{
  assert.equal(validateKnowledgePack(pack).ok,true);
  assert.equal(newRules.length,3);
  assert.deepEqual(selected(resolve()),[...newIds].sort());
  assert.deepEqual(newRules.flatMap(row=>row.narrativeLinks).map(row=>`${row.decisionId}/${row.outcomeKey}`).sort(),
    ['phantom.damned.alex-met/met','phantom.sympathy.meeting/met','phantom.sympathy.coin/gifted'].sort());
  for(const row of newRules){
    assert.equal(row.audience.perspective,'participant');
    assert.deepEqual(row.audience.channels,['private','phone']);
    assert.equal(row.status,'source-verified');
    for(const condition of row.condition.all.filter(c=>c.type==='fact'))assert.equal(condition.value,1);
  }
});

test('first Moth meeting is available to its two participants, including private phone contact',()=>{
  for(const profileKey of ['alex','solomon-reed'])for(const channel of ['private','phone']){
    const snapshot=base();snapshot.audience={channel,profileKeys:[profileKey]};
    assert.ok(selected(resolve(snapshot,profileKey)).includes(newIds[0]));
    const event=resolve(snapshot,profileKey).events.find(row=>row.provenance.ruleId===newIds[0]);
    assert.deepEqual(event.knownBy,[profileKey]);
    assert.deepEqual(event.witnessedBy,[]);
  }
});

test('meeting receipt cannot be inferred from zero, absence or debug journal completion alone',()=>{
  for(const receipt of [undefined,{status:'unknown'},fact(0),observation(0,{present:'unknown'})]){
    const snapshot=base();if(receipt)snapshot.facts.q303_02_nighthawks_back_with_reed=receipt;else delete snapshot.facts.q303_02_nighthawks_back_with_reed;
    assert.ok(!selected(resolve(snapshot)).includes(newIds[0]));
  }
});

test('both meeting and farewell need the exact revealed succeeded objective and matching quest',()=>{
  for(const [key,ruleId,questKey] of [['phantom.alex.first-meeting',newIds[0],'the-damned'],['phantom.alex.farewell',newIds[1],'unfinished-sympathy']]){
    for(const state of [undefined,journal(questKey,'active'),journal(questKey,'failed'),journal(questKey,'succeeded',{revealed:false}),journal('another-quest')]){
      const snapshot=base();if(state)snapshot.journal[key]=state;else delete snapshot.journal[key];
      assert.ok(!selected(resolve(snapshot)).includes(ruleId));
      if(key==='phantom.alex.farewell')assert.ok(!selected(resolve(snapshot)).includes(newIds[2]));
    }
    const wrongAlias=base();wrongAlias.journal['similar-looking-objective']=wrongAlias.journal[key];delete wrongAlias.journal[key];
    assert.ok(!selected(resolve(wrongAlias)).includes(ruleId));
  }
});

test('living farewell requires every positive completed Songbird and NCX stage receipt',()=>{
  for(const key of ['q304_songbirds_path','q304_lab_done','q306_reed_killed','q306_launchpad_done','q306_epilogue_alex_welcomes_v']){
    for(const value of [undefined,fact(0),{status:'unknown'}]){
      const snapshot=base();if(value)snapshot.facts[key]=value;else delete snapshot.facts[key];
      const result=selected(resolve(snapshot));assert.ok(!result.includes(newIds[1]),key);assert.ok(!result.includes(newIds[2]),key);
    }
  }
});

test('coin gift adds its own positive transfer receipt and never invents a kept decision',()=>{
  for(const value of [undefined,fact(0),observation(0,{present:'unknown'})]){
    const snapshot=base();if(value)snapshot.facts.q306_alex_coin_given=value;else delete snapshot.facts.q306_alex_coin_given;
    const result=resolve(snapshot);assert.ok(selected(result).includes(newIds[1]));assert.ok(!selected(result).includes(newIds[2]));
    assert.ok(!content(result).some(row=>row.topic==='relationship.alex.coin'));
  }
  const premature=base();premature.journal['phantom.alex.farewell']=journal('unfinished-sympathy','active');
  assert.ok(!selected(resolve(premature)).includes(newIds[2]));
});

test('Alex private farewell and coin knowledge do not leak to Reed, Songbird or accidental groups',()=>{
  for(const profileKey of ['solomon-reed','songbird','mr-hands','johnny-silverhand']){
    const snapshot=base();snapshot.audience.profileKeys=[profileKey];
    const result=selected(resolve(snapshot,profileKey));assert.ok(!result.includes(newIds[1]));assert.ok(!result.includes(newIds[2]));
    if(profileKey!=='solomon-reed')assert.ok(!result.includes(newIds[0]));
  }
  for(const channel of ['group']){
    const snapshot=base();snapshot.audience={channel,profileKeys:['alex','solomon-reed','songbird']};
    assert.deepEqual(selected(resolve(snapshot)),[]);
  }
});

test('contradictory Firestarter or NCX endings suppress later Alex history across speaker audiences',()=>{
  for(const conflicting of ['q304_alex_dead','q306_somi_betrayed']){
    const snapshot=base();snapshot.facts[conflicting]=fact(1);
    const result=resolve(snapshot);assert.ok(result.diagnostics.exclusiveGroupConflicts.length>0);
    assert.ok(!selected(result).includes(newIds[1]));assert.ok(!selected(result).includes(newIds[2]));
    assert.ok(selected(result).includes(newIds[0]));
  }
});

test('session-only identity keeps current participant context but produces no durable memory events',()=>{
  const snapshot=base();snapshot.identity={status:'session-only'};
  const result=resolve(snapshot);assert.equal(selected(result).length,3);assert.equal(result.events.length,0);
});

test('loading earlier history removes future Alex conclusions without retained resolver state',()=>{
  assert.equal(selected(resolve()).length,3);
  const earlier=base();earlier.generation=2;earlier.facts={};earlier.journal={};earlier.gameTimeSeconds=20;
  assert.deepEqual(selected(resolve(earlier)),[]);
  assert.equal(selected(resolve()).length,3);
});

test('fresh Phantom provenance is bound to binary and decoded JSON; dance and postcard remain unmapped',()=>{
  const evidence=pack.evidence.filter(row=>row.id==='ph-proof-oct01-release'||/^ph-proof-alex-/.test(row.id));
  assert.equal(evidence.length,4);
  for(const row of evidence)for(const ref of [row.native,...(row.nativeRefs||[])]){
    assert.match(ref.assetSha256,/^[a-f0-9]{64}$/);assert.match(ref.jsonSha256,/^[a-f0-9]{64}$/);
    assert.ok(ref.jsonPath.startsWith('scene-evidence/phantom-reviewed-oct01/raw/'));
  }
  assert.ok(!pack.rules.some(row=>(row.narrativeLinks||[]).some(link=>/dance|postcard/.test(link.decisionId))));
  assert.ok(!Object.values(pack.journalAllowlist).some(row=>row.nativeClass==='gameJournalOnscreen'));
  assert.ok(!pack.factAllowlist.q304_04e_v_dances_withalex);
});

test('every Phantom native citation carries a recorded authenticated export binding',()=>{
  for(const evidence of pack.evidence.filter(row=>row.kind==='native')){
    for(const ref of [evidence.native,...(evidence.nativeRefs||[])]){
      assert.match(ref.jsonSha256,/^[a-f0-9]{64}$/,evidence.id);
      assert.match(ref.jsonPath,/^scene-evidence\/phantom-(?:reviewed|authenticated)-oct01\/raw\//,evidence.id);
    }
  }
});
