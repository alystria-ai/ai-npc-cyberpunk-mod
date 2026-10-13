import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {mergeNativePacks} from './build_native_pack.mjs';
import {validateNarrativeTopicIdentities} from './narrative_topic_identity.mjs';
import {resolveKnowledge} from '../../../bridge/world-knowledge.mjs';

const research=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const read=async p=>JSON.parse((await readFile(p,'utf8')).replace(/^\uFEFF/,''));
const parts=await Promise.all((await readdir(resolve(research,'native-rules'))).filter(f=>f.endsWith('.json'))
 .map(f=>read(resolve(research,'native-rules',f))));
const catalog=await read(resolve(research,'generated/quest-catalog.json'));
const decisions=new Map(catalog.quests.flatMap(q=>q.decisions.map(d=>[d.id,{...d,questKey:q.key}])));
const roster=await read(resolve(research,'../../characters/roster.json'));
const merged=mergeNativePacks(parts,roster.map(r=>r.key));
const aliasDocument=await read(resolve(research,'native-topic-aliases.json'));
const check=(pack=merged.pack,aliases=aliasDocument,ds=decisions)=>validateNarrativeTopicIdentities({pack,decisions:ds,aliasDocument:aliases});

test('all current links are exact or covered by a closed, pinned reviewed alias',()=>{
 assert.deepEqual(merged.errors,[]);const result=check();assert.deepEqual(result.errors,[]);
 // Every enabled rule's narrative link is proved, and every pinned alias is used.
 const links=merged.pack.rules.filter(r=>['source-verified','live-verified'].includes(r.status)).flatMap(r=>r.narrativeLinks||[]);
 assert.equal(result.proofs.length,links.length);
 assert.equal(result.proofs.filter(p=>p.qualification==='pinned-reviewed-alias').length,aliasDocument.aliases.length);
 assert.equal(result.proofs.filter(p=>p.qualification==='exact').length,links.length-aliasDocument.aliases.length);
});
test('actual older Aldecaldo source fails qualification without its explicit alias records',()=>{
 const actual=parts.find(p=>p.id==='cyberpunk-aldecaldos-native');
 assert(actual);const empty={version:1,aliases:[]};
 const result=check(actual,empty);assert.equal(result.errors.filter(e=>e.includes('undeclared narrative topic mismatch')).length,22);
 const ids=new Set(actual.rules.map(r=>r.id));
 const declared={version:1,aliases:aliasDocument.aliases.filter(a=>ids.has(a.ruleId))};
 assert.deepEqual(check(actual,declared).errors,[]);
});
test('changed authored meaning or native/catalog topic invalidates a previously reviewed alias',()=>{
 const selected=aliasDocument.aliases[0];
 for(const mutate of [r=>r.statement+=' Changed meaning.',r=>r.topic='future.undeclared-topic']){
  const changed=structuredClone(merged.pack);mutate(changed.rules.find(r=>r.id===selected.ruleId));
  assert(check(changed).errors.some(e=>e.includes('stale or mismatched')));
 }
 const changed=new Map([...decisions].map(([k,v])=>[k,structuredClone(v)]));
 changed.get(selected.decisionId).topic='future.catalog-change';
 assert(check(merged.pack,aliasDocument,changed).errors.some(e=>e.includes('stale or mismatched')));
});
test('missing, duplicate, unreviewed and wrong-outcome aliases are rejected',()=>{
 const missing=structuredClone(aliasDocument);missing.aliases.shift();assert(check(merged.pack,missing).errors.some(e=>e.includes('undeclared')));
 const duplicate=structuredClone(aliasDocument);duplicate.aliases.push(duplicate.aliases[0]);assert(check(merged.pack,duplicate).errors.some(e=>e.includes('duplicate')));
 const unreviewed=structuredClone(aliasDocument);unreviewed.aliases[0].reviewed=false;assert(check(merged.pack,unreviewed).errors.some(e=>e.includes('unreviewed')));
 const wrong=structuredClone(aliasDocument);wrong.aliases[0].outcomeKey='invented';assert(check(merged.pack,wrong).errors.some(e=>e.includes('stale or mismatched')));
});
test('an exact catalog name cannot bypass an existing native topic domain for a future alternative',()=>{
 const selected=aliasDocument.aliases.find(a=>a.ruleId==='aldecaldos.native.saul-riders-rescue');
 const changed=structuredClone(merged.pack),proposal=structuredClone(changed.rules.find(r=>r.id===selected.ruleId));
 proposal.id='fixture.unreviewed-rescue-alternative';proposal.topic=selected.catalogTopic;
 changed.rules.push(proposal);
 assert(check(changed).errors.some(e=>e.includes('canonical topic bypasses reviewed native topic domain')));
});
test('missing canonical topic metadata fails closed instead of skipping the identity check',()=>{
 const exact=merged.pack.rules.find(r=>r.status==='source-verified'&&r.narrativeLinks?.length&&r.topic===decisions.get(r.narrativeLinks[0].decisionId)?.topic);
 const changed=new Map([...decisions].map(([k,v])=>[k,structuredClone(v)]));
 delete changed.get(exact.narrativeLinks[0].decisionId).topic;
 assert(check(merged.pack,aliasDocument,changed).errors.some(e=>e.includes('missing or invalid linked narrative topic')));
});
const fact=(value=1)=>({status:'known',value,present:true,sourceId:'native-capture',evidenceRefs:['fact-capture']});
const journal=(questKey,value='succeeded')=>({status:'known',value,revealed:true,questKey,sourceId:'native-capture',evidenceRefs:['journal-capture']});
function selectedTopics(pack,speaker,facts,journals){const result=resolveKnowledge({pack,profileKey:speaker,maxChars:10000,snapshot:{version:1,status:'ready',gameVersion:'2.31',generation:1,
 capturedAt:'2026-10-03T06:45:00.000Z',audience:{channel:'private',profileKeys:[speaker]},facts,journal:journals,activeQuestKeys:[]}})
 ;const doc=JSON.parse(result.context.slice(result.context.indexOf('\n')+1));
 // Branch decisions are told first under `choices`, the other facts under `facts`.
 return [...(doc.choices||[]),...(doc.facts||[])].map(f=>f.topic);}
test('actual Panam compatible facets coexist; blindly forcing catalog topic equality would suppress both',()=>{
 const ids=['aldecaldos.native.panam-motel-room-shared','aldecaldos.native.panam-motel-flirt'];
 const facts={q103_slept_with_panam:fact(),q103_15_rooms_flirt:fact()};
 const journals={'aldecaldos.ghost.shared-room-entered':journal('ghost-town'),'aldecaldos.ghost.completed':journal('ghost-town')};
 const topics=ids.map(id=>merged.pack.rules.find(r=>r.id===id).topic);
 const result=selectedTopics(merged.pack,'panam-palmer',facts,journals);assert(topics.every(topic=>result.includes(topic)));
 const rewritten=structuredClone(merged.pack);for(const r of rewritten.rules.filter(r=>ids.includes(r.id)))r.topic='panam.motel-intimacy';
 assert(!selectedTopics(rewritten,'panam-palmer',facts,journals).includes('panam.motel-intimacy'));
});
test('actual Jake invitation and collection remain compatible temporal stages',()=>{
 const ids=['city-native.jake-gift-offered','city-native.jake-gift-collected'];
 const facts={gle_06_succeed:fact(),mq044_done:fact()};
 const journals={'city.jake.gift-invitation':journal('sex-on-wheels','active'),'city.jake.gift-debrief':journal('sex-on-wheels','active')};
 const topics=ids.map(id=>merged.pack.rules.find(r=>r.id===id).topic);
 const result=selectedTopics(merged.pack,'jake-estevez',facts,journals);assert(topics.every(topic=>result.includes(topic)));
 const rewritten=structuredClone(merged.pack);for(const r of rewritten.rules.filter(r=>ids.includes(r.id)))r.topic='jake.quadra.gift';
 assert(!selectedTopics(rewritten,'jake-estevez',facts,journals).includes('jake.quadra.gift'));
});
