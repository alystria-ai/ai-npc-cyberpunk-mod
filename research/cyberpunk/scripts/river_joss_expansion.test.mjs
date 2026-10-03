import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile, readdir} from 'node:fs/promises';
import {resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {validateKnowledgePack, resolveKnowledge} from '../../../bridge/world-knowledge.mjs';
import {mergeNativePacks, verifyNativeEvidence} from './build_native_pack.mjs';

const research=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const root=resolve(research,'../..');
const read=async p=>JSON.parse((await readFile(p,'utf8')).replace(/^\uFEFF/,''));
const pack=await read(resolve(research,'native-rules/river-joss-oct03.json'));
const catalog=await read(resolve(research,'generated/quest-catalog.json'));
const decisions=new Map(catalog.quests.flatMap(q=>q.decisions.map(d=>[d.id,{...d,questKey:q.key}])));
const ids=pack.rules.map(r=>r.id);
const previous=await read(resolve(research,'native-rules/judy-river.json'));
const roster=await read(resolve(root,'characters/roster.json'));
const merged=mergeNativePacks([previous,pack],roster.map(p=>p.key));
const selected=r=>r.diagnostics.rules.filter(r=>r.status==='selected').map(r=>r.ruleId);
const fact=(value=1,present=true)=>({status:'known',value,present,sourceId:'native-capture',evidenceRefs:['fact-capture']});
const message=(key,{value='active',revealed=true,questKey}={})=>({status:'known',value,revealed,
 questKey:questKey??pack.journalAllowlist[key].questKey,sourceId:'native-capture',evidenceRefs:['journal-capture']});
const harris=()=>({facts:{sq021_randy_kaputt:fact(),sq021_done:fact()},journal:{'river-joss.harris-report-0':message('river-joss.harris-report-0')}});
const loss=()=>({journal:{'river-joss.joss-loss-report':message('river-joss.joss-loss-report')}});
const recovery=()=>({facts:{sq021_randy_saved:fact(),sq021_done:fact()},journal:{'river-joss.joss-recovery-report':message('river-joss.joss-recovery-report')}});
const visit=(thanks=0)=>({journal:{['river-joss.joss-visit-'+thanks]:message('river-joss.joss-visit-'+thanks),
 'river-joss.joss-visit-2':message('river-joss.joss-visit-2')}});
function run(input={},speaker='joss-kutcher',customPack=pack){
 const {channel='private',profiles=[speaker],gameVersion='2.31',disclosures=[],...observed}=input;
 return resolveKnowledge({pack:customPack,profileKey:speaker,maxChars:10000,snapshot:{version:1,status:'ready',gameVersion,generation:1,
  capturedAt:'2026-10-03T06:30:00.000Z',audience:{channel,profileKeys:profiles},facts:{},journal:{},
  activeQuestKeys:[],disclosures,...observed}});
}

test('four exact reviewed participant rules link real researched outcomes without adding universal biography',()=>{
 assert.deepEqual(validateKnowledgePack(pack),{ok:true,errors:[]});
 assert.equal(pack.rules.length,4);assert.equal(Object.keys(pack.journalAllowlist).length,8);
 for(const rule of pack.rules){
  assert.equal(rule.status,'source-verified');assert.equal(rule.reviewed,true);
  assert.deepEqual(rule.audience.channels,['private','phone']);
  assert.deepEqual(rule.audience.recipients,['v',rule.audience.speakers[0]]);
  const [link]=rule.narrativeLinks;assert.equal(rule.narrativeLinks.length,1);
  const decision=decisions.get(link.decisionId);assert.equal(decision.questKey,rule.questKey);
  assert.equal(rule.topic,decision.topic);
  assert(decision.outcomes.some(o=>o.key===link.outcomeKey));
 }
 for(const alias of Object.values(pack.journalAllowlist)){
  assert.equal(alias.nativeClass,'gameJournalPhoneMessage');assert.match(alias.nativePath,/^contacts\/(?:river_ward|joss)\//);
 }
});
test('each qualified private and phone route selects its own speaker perspective',()=>{
 for(const [id,values,speaker]of [[ids[0],harris(),'river-ward'],[ids[1],loss(),'joss-kutcher'],
  [ids[2],recovery(),'joss-kutcher'],[ids[3],visit(),'joss-kutcher']]){
  for(const channel of ['private','phone'])assert.deepEqual(selected(run({...values,channel},speaker)),[id]);
 }
});
test('failed rescue flags and a revenge vow never establish a later killing',()=>{
 assert.deepEqual(selected(run({facts:harris().facts},'river-ward')),[]);
 for(const key of ['sq021_revenge','sq021_roof_left','sq021_dont_care']){
  assert.deepEqual(selected(run({facts:{...harris().facts,[key]:fact()}},'river-ward')),[]);
 }
 for(const i of [0,1,2])assert.deepEqual(selected(run({facts:harris().facts,journal:{['river-joss.harris-report-'+i]:message('river-joss.harris-report-'+i)}},'river-ward')),[ids[0]]);
});
test('a Harris report without positive failed-rescue/completion observations cannot qualify that failure route',()=>{
 assert.deepEqual(selected(run({journal:harris().journal},'river-ward')),[]);
 for(const key of ['sq021_randy_kaputt','sq021_done'])for(const present of [true,false,'unknown']){
  const values=harris();values.facts[key]=fact(0,present);assert.deepEqual(selected(run(values,'river-ward')),[]);
 }
 // This actual alternative message is not allowlisted as a killing receipt.
 assert.deepEqual(selected(run({facts:harris().facts,journal:{'river-joss.harris-forgiveness':{
  status:'known',value:'active',revealed:true,questKey:'the-hunt',sourceId:'native-capture',evidenceRefs:['journal-capture']}}},'river-ward')),[]);
});
test('message existence, wrong quest ownership and unavailable/unrevealed states withhold conclusions',()=>{
 const cases=[[harris(),'river-ward'],[loss(),'joss-kutcher'],[recovery(),'joss-kutcher'],[visit(),'joss-kutcher']];
 for(const [values,speaker]of cases)for(const key of Object.keys(values.journal)){
  for(const state of ['inactive','failed']){const changed=structuredClone(values);changed.journal[key].value=state;assert.deepEqual(selected(run(changed,speaker)),[]);}
  const hidden=structuredClone(values);hidden.journal[key].revealed=false;assert.deepEqual(selected(run(hidden,speaker)),[]);
  const wrong=structuredClone(values);wrong.journal[key].questKey='pyramid-song';assert.deepEqual(selected(run(wrong,speaker)),[]);
 }
 assert.deepEqual(selected(run()),[]);
});
test('Joss recovery needs the positive rescued state and remains an assessment rather than a medical cure',()=>{
 assert.deepEqual(selected(run({journal:recovery().journal})),[]);
 for(const key of ['sq021_randy_saved','sq021_done']){const values=recovery();values.facts[key]=fact(0);assert.deepEqual(selected(run(values)),[]);}
 const result=run(recovery());assert.match(result.context,/not proof of complete medical recovery/);
 assert.match(result.context,/not proof of complete medical recovery or a message V has read or answered/);
});
test('visit follow-up requires both a thank-you and children’s rematch, across either hospitality branch',()=>{
 for(const branch of [0,1])assert.deepEqual(selected(run(visit(branch))),[ids[3]]);
 assert.deepEqual(selected(run({journal:{'river-joss.joss-visit-0':message('river-joss.joss-visit-0')}})),[]);
 assert.deepEqual(selected(run({journal:{'river-joss.joss-visit-2':message('river-joss.joss-visit-2')}})),[]);
 assert.match(run(visit(1)).context,/does not establish a romance with River/);
});
test('private messages do not leak to other speakers or a group, even with a fabricated group disclosure',()=>{
 for(const [values,speaker]of [[harris(),'river-ward'],[loss(),'joss-kutcher'],[recovery(),'joss-kutcher'],[visit(),'joss-kutcher']]){
  const other=speaker==='river-ward'?'joss-kutcher':'river-ward';
  assert.deepEqual(selected(run(values,other)),[]);
  const group={...values,channel:'group',profiles:['river-ward','joss-kutcher'],disclosures:[{status:'known',from:'v',
   topic:'randy.rescue_outcome',outcome:'saved',to:['river-ward','joss-kutcher'],sourceId:'player-report',evidenceRefs:['dialogue-receipt']}]};
  assert.deepEqual(selected(run(group,speaker)),[]);
 }
});
test('incompatible positive Joss rescue receipts conflict instead of picking the happier history',()=>{
 const result=run({facts:recovery().facts,journal:{...loss().journal,...recovery().journal}});
 assert.deepEqual(selected(result),[]);assert(result.diagnostics.conflicts.some(c=>c.topic==='randy.rescue_outcome'));
});
test('the actual combined pack suppresses a Harris account dependent on contradictory rescue routes',()=>{
 assert.deepEqual(merged.errors,[]);
 const values=harris();values.facts.sq021_randy_saved=fact();
 const result=run(values,'river-ward',merged.pack);
 assert(!selected(result).includes(ids[0]));
 assert(result.diagnostics.exclusiveGroupConflicts.some(c=>c.id==='randy.rescue_route'));
 assert(!selected(result).some(id=>['jr-native.hunt-randy-saved','jr-native.hunt-randy-too-late'].includes(id)));
 // An unobserved competing fate is not a rejection of the known-positive loss.
 assert(selected(run(harris(),'river-ward',merged.pack)).includes(ids[0]));
 const missing=structuredClone(values);missing.facts.sq021_randy_saved={status:'unknown',reason:'not-observed'};
 assert(selected(run(missing,'river-ward',merged.pack)).includes(ids[0]));
});
test('unsupported versions and fresh rollback observations do not retain later family history',()=>{
 assert.equal(run({...visit(),gameVersion:'2.32'}).diagnostics.status,'unsupported-game-version');
 assert.deepEqual(selected(run(visit())),[ids[3]]);assert.deepEqual(selected(run()),[]);
});

const sourceGate=process.env.CYBERPUNK_NATIVE_PROVENANCE==='1';
test('recorded native binary/JSON hashes and exact typed identity/text/writer pointers verify', {skip:!sourceGate},async()=>{
 const inventory={assets:[]};
 for(const name of await readdir(resolve(research,'cache/game/scene-evidence'))){
  const file=resolve(research,'cache/game/scene-evidence',name,'inventory.json');
  const manifest=await read(file).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
  if(manifest)inventory.assets.push(...manifest.assets.map(a=>({...a,jsonPath:`scene-evidence/${name}/${a.jsonPath}`,rawPath:`scene-evidence/${name}/${a.rawPath}`})));
 }
 const cache=resolve(research,'cache/game');
 const loadArtifact=async asset=>({raw:await readFile(resolve(cache,asset.rawPath)),jsonRaw:await readFile(resolve(cache,asset.jsonPath))});
 const verify=custom=>verifyNativeEvidence({pack:custom,inventory,loadArtifact,decisions,requireJsonHashes:true});
 const result=await verify(pack);assert.deepEqual(result.errors,[]);assert.equal(result.counts.enabledRules,4);assert.equal(result.counts.legacyJsonPointers,0);
 const swapped=structuredClone(pack);const contactRef=swapped.evidence.find(e=>e.id==='jr-oct03.joss-loss-report').native;
 contactRef.expected['/id']='river_ward';assert((await verify(swapped)).errors.some(e=>e.includes('Native nested value mismatch')));
 const wrongText=structuredClone(pack);const locRef=wrongText.evidence.find(e=>e.id==='jr-oct03.joss-loss-report').nativeRefs.find(r=>r.expected?.['/primaryKey']==='10863');
 locRef.expected['/primaryKey']='10862';assert((await verify(wrongText)).errors.some(e=>e.includes('Native nested value mismatch')));
 const wrongWriter=structuredClone(pack);const writerRef=wrongWriter.evidence.find(e=>e.id==='jr-oct03.joss-loss-report').nativeRefs.find(r=>r.expected?.['/type/Data/path/Data/realPath']);
 writerRef.expected['/type/Data/path/Data/className/$value']='gameJournalQuest';assert((await verify(wrongWriter)).errors.some(e=>e.includes('Native nested value mismatch')));
 const stale=structuredClone(pack);stale.evidence[0].native.jsonSha256='0'.repeat(64);assert((await verify(stale)).errors.some(e=>e.includes('JSON export hash mismatch')));
});
