import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {resolveKnowledge,validateKnowledgePack} from './world-knowledge.mjs';
import {jsonPointer} from '../research/cyberpunk/scripts/build_native_pack.mjs';

// Executes the authored source part, without installing or rebuilding generated data.
const pack=JSON.parse(await readFile(process.env.SILVERHAND_TEST_PACK
  || new URL('../research/cyberpunk/native-rules/silverhand.json',import.meta.url),'utf8'));
const observation=value=>({status:'known',value,present:value>0?true:'unknown',sourceId:'native-capture',evidenceRefs:['capture:fact']});
function result(values={},profileKey='johnny-silverhand',channel='private',profiles=[profileKey]){
  return resolveKnowledge({pack,profileKey,maxChars:12000,snapshot:{version:1,status:'ready',gameVersion:'2.31',
    generation:1,capturedAt:'2026-10-01T12:00:00.000Z',identity:{status:'verified',userId:'test-user',
      playthroughId:'test-playthrough',branchId:'test-branch',checkpointId:'test-checkpoint'},
    audience:{channel,profileKeys:profiles},facts:Object.fromEntries(Object.entries(values).map(([k,v])=>[k,observation(v)])),
    journal:{},activeQuestKeys:[],disclosures:[]}});
}
const outcomes=r=>r.events.map(e=>`${e.topic}/${e.outcome}`).sort();
const positive={mq018_fortuneteller_finished:1};
test('all native bindings have authenticated JSON hashes and original writer field assertions are preserved',()=>{
  let writers=0;
  for(const evidence of pack.evidence)for(const reference of [evidence.native,...(evidence.nativeRefs||[])]){
    assert.match(reference.assetSha256,/^[a-f0-9]{64}$/);
    assert.match(reference.jsonSha256,/^[a-f0-9]{64}$/);
    if(reference.expected){
      assert.equal(reference.expectedType,'questSetVar_NodeType');
      assert.equal(reference.expectedValue.$type,'questSetVar_NodeType');
      for(const [p,value] of Object.entries(reference.expected))assert.deepEqual(jsonPointer(reference.expectedValue,p),value);
      writers++;
    }
  }
  assert.equal(writers,13);
});
test('Silverhand source part validates and has exactly six new outcome rules',()=>{
  assert.equal(validateKnowledgePack(pack).ok,true);
  const wanted=['swedenborg-disconnected','swedenborg-left-running','swedenborg-altered','swedenborg-identified','nancy-truth-report','porsche-recovered'];
  for(const id of wanted)assert.equal(pack.rules.find(r=>r.id===`silverhand.${id}`)?.status,'source-verified');
  const added=pack.rules.filter(r=>r.questKey==='killing-in-the-name'||r.topic==='silverhand.porsche-recovery');
  assert.deepEqual(added.map(r=>r.id).sort(),wanted.map(id=>`silverhand.${id}`).sort());
});
test('missing, zero or completion alone establish no new Swedenborg outcome',()=>{
  for(const values of [{},positive,{mq018_swedenborg_disabled:0,mq018_fortune_found:0,mq018_swedenborg_exposed:0,mq018_fortuneteller_finished:0}]){
    assert.deepEqual(outcomes(result(values)),[]);
  }
});
test('each machine choice and discovery waits for its positive completion gate',()=>{
  for(const fact of ['mq018_swedenborg_disabled','mq018_swedenborg_unchanged','mq018_swedenborg_trolled','mq018_fortune_found']){
    assert.deepEqual(outcomes(result({[fact]:1})),[]);
    assert.equal(result({...positive,[fact]:1}).events.length,1);
  }
});
test('completed machine choices map distinct semantics',()=>{
  for(const [fact,outcome] of [['mq018_swedenborg_disabled','disconnected'],['mq018_swedenborg_unchanged','left-running'],['mq018_swedenborg_trolled','altered']]){
    assert.deepEqual(outcomes(result({...positive,[fact]:1})),[`swedenborg.machine-state/${outcome}`]);
  }
});
test('contradictory positive machine choices suppress that topic but keep independent discovery',()=>{
  const facts=['mq018_swedenborg_disabled','mq018_swedenborg_unchanged','mq018_swedenborg_trolled'];
  for(let i=0;i<facts.length;i++)for(let j=i+1;j<facts.length;j++){
    const r=result({...positive,[facts[i]]:1,[facts[j]]:1,mq018_fortune_found:1});
    assert.deepEqual(outcomes(r),['swedenborg.identity/bot-identified']);
  }
});
test('native bot discovery is Johnny-only and never implicitly reported to Nancy',()=>{
  const values={...positive,mq018_fortune_found:1,mq018_swedenborg_trolled:1};
  assert.deepEqual(outcomes(result(values)),['swedenborg.identity/bot-identified','swedenborg.machine-state/altered']);
  assert.deepEqual(outcomes(result(values,'nancy-hartley')),[]);
  assert.deepEqual(outcomes(result(values,'kerry-eurodyne')),[]);
});
test('completed native truth report is available to the call participants without a synthetic AI disclosure',()=>{
  for(const speaker of ['nancy-hartley','johnny-silverhand'])for(const channel of ['private','phone']){
    const r=result({mq018_swedenborg_exposed:1},speaker,channel);
    assert.deepEqual(outcomes(r),['nancy.swedenborg.disclosure/truth']);
    assert.match(r.events[0].text,/V told Nancy/);
    assert.doesNotMatch(r.events[0].text,/\b(?:possession|body|spared|altered)\b/i);
  }
});
test('zero report never becomes a withheld choice, and machine choices do not control the report',()=>{
  for(const machine of ['mq018_swedenborg_disabled','mq018_swedenborg_unchanged','mq018_swedenborg_trolled']){
    assert.deepEqual(outcomes(result({...positive,[machine]:1,mq018_swedenborg_exposed:0},'nancy-hartley')),[]);
    assert.deepEqual(outcomes(result({...positive,[machine]:1,mq018_swedenborg_exposed:1},'nancy-hartley')),['nancy.swedenborg.disclosure/truth']);
  }
});
test('group audiences and historical copies cannot borrow private 2077 discoveries',()=>{
  const values={...positive,mq018_fortune_found:1,mq018_swedenborg_unchanged:1,mq018_swedenborg_exposed:1,sq031_porsche_unlocked:1};
  assert.deepEqual(outcomes(result(values,'johnny-silverhand','group',['johnny-silverhand','nancy-hartley'])),[]);
  for(const speaker of ['santiago','spider-murphy','thompson','rogue-amendiares','adam-smasher'])assert.deepEqual(outcomes(result(values,speaker)),[]);
});
test('mercy, death and cargo preparation alone never claim Porsche recovery',()=>{
  for(const values of [{sq031_04_grayson_alive:1},{sq031_grayson_killed:1},{sq031_porsche_no_grayson:1}]){
    assert(!outcomes(result(values)).includes('silverhand.porsche-recovery/recovered'));
  }
});
test('actual positive vehicle unlock establishes historical recovery independently of Grayson fate',()=>{
  for(const values of [{},{sq031_04_grayson_alive:1},{sq031_grayson_killed:1}]){
    const r=result({...values,sq031_porsche_unlocked:1});
    assert(outcomes(r).includes('silverhand.porsche-recovery/recovered'));
    const event=r.events.find(e=>e.topic==='silverhand.porsche-recovery');
    assert.doesNotMatch(event.text,/currently|still|owned|spared|killed|location/i);
  }
});
test('broad quest completion cannot invent optional dog tags, control agreement or Archangel gift',()=>{
  const r=result({sq031_done:1,sq032_done:1,sq011_done:1,sq031_samurai_concert_done:1});
  for(const forbidden of ['silverhand.dog-tags','silverhand.rogue-control-agreement','silverhand.archangel'])assert(!r.events.some(e=>e.topic===forbidden));
});
