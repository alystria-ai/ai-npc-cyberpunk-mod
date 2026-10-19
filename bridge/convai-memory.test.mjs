import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ConvaiMemoryAdapter,normalizeMemoryText} from './convai-memory.mjs';

const identity = {characterId:'test-character',endUserId:'test-user'};
const record = {id:'memory-1',memory:'V helped Judy.',created_at:'2026-09-30T00:00:00Z'};
const json = (body,status=200,headers={}) => new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json',...headers}});
function fake(respond,options={}) {
  const calls=[];
  const adapter=new ConvaiMemoryAdapter({key:'secret-not-for-diagnostics',enabled:true,
    fetchImpl:async(url,init)=>{calls.push({url,...init,body:JSON.parse(init.body)});return respond(calls.at(-1));},...options});
  return {adapter,calls};
}
test('construction and disabled operations never dispatch or serialize a credential',async()=>{
  let calls=0;
  const adapter=new ConvaiMemoryAdapter({key:'secret-not-for-diagnostics',fetchImpl:()=>{calls++;}});
  assert.equal(calls,0);assert.ok(!JSON.stringify(adapter).includes('secret-not-for-diagnostics'));
  await assert.rejects(adapter.add({...identity,memories:['hello']}),{code:'DISABLED'});
  assert.equal(calls,0);
});
test('all supported methods use exact official endpoints, identity pair and JSON POST',async()=>{
  const {adapter,calls}=fake(call=>{
    if(call.url.endsWith('/add'))return json({memories:[record]});
    if(call.url.endsWith('/list'))return json({memories:[record],total_count:1,has_more:false,page:2,page_size:10});
    if(call.url.endsWith('/get'))return json(record);
    if(call.url.endsWith('/delete'))return json({memory_id:record.id,deleted:true});
    return json({message:'Memory deletion in progress...',character_id:identity.characterId,end_user_id:identity.endUserId});
  });
  assert.deepEqual(await adapter.add({...identity,memories:[' V  helped Judy.\n']}),{memories:[record]});
  await adapter.list({...identity,page:2,pageSize:10});
  assert.deepEqual(await adapter.get({...identity,memoryId:record.id}),record);
  assert.deepEqual(await adapter.delete({...identity,memoryId:record.id}),{memory_id:record.id,deleted:true});
  assert.equal((await adapter.deleteAll(identity)).verifiedEmpty,false);
  assert.deepEqual(calls.map(row=>row.url),['add','list','get','delete','delete-all'].map(v=>'https://api.convai.com/memory/'+v));
  for(const call of calls){
    assert.equal(call.method,'POST');assert.equal(call.headers['Content-Type'],'application/json');
    assert.equal(call.headers['CONVAI-API-KEY'],'secret-not-for-diagnostics');
    assert.equal(call.body.character_id,identity.characterId);assert.equal(call.body.end_user_id,identity.endUserId);
  }
  assert.deepEqual(calls[0].body.memories,['V helped Judy.']);
  assert.deepEqual(calls[1].body,{character_id:identity.characterId,end_user_id:identity.endUserId,page:2,page_size:10});
});
test('identity, batch, pagination and endpoint errors are rejected before dispatch',async()=>{
  const {adapter,calls}=fake(()=>json({}));
  for(const operation of [()=>adapter.add({...identity,endUserId:'',memories:['x']}),
    ()=>adapter.add({...identity,memories:[]}),()=>adapter.add({...identity,memories:['\u0000']}),
    ()=>adapter.add({...identity,memories:['x'.repeat(6001)]}),
    ()=>adapter.list({...identity,page:0}),()=>adapter.list({...identity,pageSize:101}),
    ()=>adapter.get({...identity,memoryId:'../escape'})]) assert.throws(operation);
  await assert.rejects(adapter.request('/character/delete',{}),{code:'INVALID_ENDPOINT'});
  assert.equal(calls.length,0);
});
test('malformed and mismatched responses fail closed, without leaking submitted/provider text',async()=>{
  for(const body of [{memories:[{memory:'missing ID'}]},{memories:[]},{ERROR:'secret-not-for-diagnostics'}]){
    const {adapter}=fake(()=>json(body));
    await assert.rejects(adapter.add({...identity,memories:['private quest choice']}),error=>{
      assert.equal(error.code,'INVALID_RESPONSE');assert.equal(error.writeUncertain,true);
      assert.ok(!error.message.includes('private quest choice'));assert.ok(!error.message.includes('secret-not-for-diagnostics'));return true;
    });
  }
  const {adapter}=fake(()=>json({...record,id:'different'}));
  await assert.rejects(adapter.get({...identity,memoryId:record.id}),{code:'INVALID_RESPONSE'});
});
test('5xx and transport failures are uncertain writes; definitive rejection is not automatically retried',async()=>{
  for(const status of [400,401,403,404,429,500,503,408]){
    const {adapter,calls}=fake(()=>json({ERROR:'sensitive response body'},status));
    await assert.rejects(adapter.add({...identity,memories:['fact']}),error=>{
      assert.equal(error.status,status);assert.equal(error.writeUncertain,status>=500||status===408);
      assert.equal(error.retryable,false);assert.ok(!error.message.includes('sensitive'));return true;
    });
    assert.equal(calls.length,1);
  }
  const {adapter,calls}=fake(()=>{throw new Error('secret network error');});
  await assert.rejects(adapter.add({...identity,memories:['fact']}),{code:'NETWORK_ERROR',writeUncertain:true,retryable:false});
  assert.equal(calls.length,1);
  await assert.rejects(adapter.list(identity),{code:'NETWORK_ERROR',writeUncertain:false,retryable:true});
});
// The operations below never settle, so only the deadline can end them: a TIMEOUT rejection is the proof that the limit bounded the call.
// No elapsed-time ceiling (a busy machine would turn it into a coin flip); a hung test is stopped by the 60 s test timeout, and the
// deadline is shown to be the configured 20 ms limit and not an instant failure by a lower bound.
test('deadline bounds transport and body reads even when injected operations ignore cancellation',{timeout:60000},async()=>{
  const {adapter,calls}=fake(()=>new Promise(()=>{}),{timeoutMs:20});
  const start=Date.now();
  await assert.rejects(adapter.add({...identity,memories:['fact']}),{code:'TIMEOUT',writeUncertain:true});
  assert.ok(Date.now()-start>=15,'the configured deadline ended it, not an instant failure');assert.equal(calls.length,1);
  const hanging=new ReadableStream({pull(){return new Promise(()=>{});},cancel(){return new Promise(()=>{});}});
  const other=fake(()=>new Response(hanging),{timeoutMs:20}).adapter;
  await assert.rejects(other.list(identity),{code:'TIMEOUT',writeUncertain:false});
});
test('pre-cancel is not a submitted write; cancellation after dispatch remains uncertain',async()=>{
  const pre=new AbortController();pre.abort();
  const {adapter,calls}=fake(()=>new Promise(()=>{}));
  await assert.rejects(adapter.add({...identity,memories:['fact'],signal:pre.signal}),{code:'CANCELLED',writeUncertain:false});
  assert.equal(calls.length,0);
  const during=new AbortController();
  const promise=adapter.add({...identity,memories:['fact'],signal:during.signal});during.abort();
  await assert.rejects(promise,{code:'CANCELLED',writeUncertain:true});assert.equal(calls.length,1);
});
test('response byte limits are enforced for declared and streamed payloads',async()=>{
  for(const headers of [{},{'content-length':'10000000'}]){
    const {adapter}=fake(()=>json({memories:[{...record,memory:'x'.repeat(1000)}]},200,headers),{maxResponseBytes:128});
    await assert.rejects(adapter.add({...identity,memories:['fact']}),{code:'RESPONSE_TOO_LARGE',writeUncertain:true});
  }
});
test('pagination is bounded, de-duplicates repeated records and marks incomplete scans',async()=>{
  const {adapter,calls}=fake(call=>json({memories:[record],total_count:1000,has_more:true,
    page:call.body.page,page_size:call.body.page_size}));
  const result=await adapter.scan({...identity,maxPages:2});
  assert.equal(result.complete,false);assert.equal(result.memories.length,1);assert.equal(calls.length,2);
  const done=fake(call=>json({memories:[record],total_count:1,has_more:false,
    page:call.body.page,page_size:call.body.page_size})).adapter;
  assert.equal((await done.scan(identity)).complete,true);
});
test('normalization preserves text meaning and Unicode while making whitespace stable',()=>{
  assert.equal(normalizeMemoryText('  Cafe\u0301\n  meeting\t '),'Café meeting');
});
