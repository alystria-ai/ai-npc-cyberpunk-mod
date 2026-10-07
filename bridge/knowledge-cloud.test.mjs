import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {KnowledgeCloud} from './knowledge-cloud.mjs';
import {QuestMemoryLedger} from './quest-memory.mjs';

const MODEL='fast-gemma-4-31b-it',NOW=100000,KEY='test-only-key';
const REST_USER='11111111-1111-4111-8111-111111111111',PROVIDER_POLICY='explicit-rest-anonymous-live-v1';
const clone=value=>structuredClone(value);
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const qualified=()=>({version:1,completed:true,model:MODEL,
  checks:{separateProfileFields:true,memoryEnabledReadback:true,registeredUsersViaConnect:true,newUsersEmpty:true,
    userAAddListGet:true,userBAddListGet:true,distinctUserLists:true,modelReadback:MODEL,
    crossUserGetA:{denied:true,status:403},crossUserGetB:{denied:true,status:403}},
  registration:{A:{identityEchoVerified:true,closed:true},B:{identityEchoVerified:true,closed:true}},
  cleanup:{profileAbsent:true,A:{recordsEmpty:true},B:{recordsEmpty:true}},
  anonymousLiveQualification:{version:1,completed:true,sourceRunId:'anonymous-test',model:MODEL,
    usersReused:true,newEndUserIds:0,anonymousEchoNull:true,anonymousClosed:true,
    registrationEchoVerified:true,explicitRestVerified:true,profileAbsent:true,
    mode:'memory-disabled-explicit-rest-v1',liveCharacterMemoryEnabled:false,explicitRestWithMemoryDisabled:true}});
const policy=()=>({version:1,enabled:true,nativeQualified:true,providerQualified:true,enableOwnedProfiles:true,selectedModel:MODEL});
const episode=(ledger,i=1)=>({eventId:`event-${i}`,factId:`choice.${i}`,kind:'decision',authority:'game-state',stable:true,
  eligibleForMemory:true,text:`V completed reviewed choice ${i} with Judy.`,characterKey:'judy-alvarez',
  knownBy:['judy-alvarez'],witnessedBy:['judy-alvarez'],visibility:'private',identity:ledger.identity,
  evidence:[{sourceId:'native-fact'}],provenance:{ruleId:`rule-${i}`}});

async function fixture(t,{enabled=false,events=1,options={}}={}){
  const dir=await mkdtemp(join(tmpdir(),'knowledge-cloud-test-'));
  const qualificationPath=join(dir,'qualification.json');await writeFile(qualificationPath,JSON.stringify(qualified()));
  const ledger=await QuestMemoryLedger.load({path:join(dir,'ledger.json'),now:()=>NOW});
  await ledger.bindIdentity({authoritative:true,campaignId:'campaign',branchId:'branch',checkpointId:'initial'});
  for(let i=1;i<=events;i++)await ledger.observe(episode(ledger,i));
  await ledger.checkpoint({kind:'native-on-restored',branchId:'branch',ledgerSequence:events,checkpointId:'save'});
  const coordinator={ledger,cloudQualified:true,epoch:1,
    guard(){return ledger.identity?{branchId:ledger.identity.branchId,epoch:this.epoch}:null;},
    isCurrent(g){return !!g&&JSON.stringify(g)===JSON.stringify(this.guard());},
    async current(g){return this.isCurrent(g);},
    pendingCloud(o){return this.cloudQualified?ledger.pending(o).map(e=>({...e,restEndUserId:REST_USER,
      providerPolicy:PROVIDER_POLICY,guard:this.guard()})):[];},
    sessionIdentity(characterKey,channel,audience){const c=ledger.contextFor({characterKey,channel,audience});
      return {...c,localScopeId:c.endUserId,restEndUserId:REST_USER,providerPolicy:PROVIDER_POLICY};}};
  const state={detail:{character_id:'remote-judy',character_name:'Judy Alvarez',voice_type:'voice-1',
    backstory:'Reviewed biography.\n\n[CyberpunkConvai profile v2:judy-alvarez]',
    speaking_style:{description:'A direct style.',sample_dialogues:'An original sample.'},
    memory_settings:{enabled,memory_length:40,filters:{topic:'verified'},ltm_min_credit_cost_e8:123}},
    listing:[{character_id:'remote-judy',personalised_prompt_config:{MODEL}}],memories:[]};
  const calls=[];
  const request=async(endpoint,body)=>{calls.push({endpoint,body:clone(body)});
    if(endpoint==='/character/list')return {characters:clone(state.listing)};
    if(endpoint==='/character/get')return clone(state.detail);
    if(endpoint==='/character/update'){state.detail.memory_settings.enabled=body.memorySettings.enabled;return {STATUS:'SUCCESS'};}
    throw Error('Unexpected Core endpoint');};
  const fetchImpl=async(url,init)=>{const endpoint=new URL(url).pathname,body=JSON.parse(init.body);calls.push({endpoint,body});
    if(endpoint==='/memory/add'){const memories=body.memories.map((memory,i)=>({id:`memory-${state.memories.length+i}`,memory}));
      state.memories.push(...memories);return Response.json({memories});}
    if(endpoint==='/memory/list')return Response.json({memories:clone(state.memories),total_count:state.memories.length,
      has_more:false,page:body.page,page_size:body.page_size});
    if(endpoint==='/memory/get')return Response.json(state.memories.find(row=>row.id===body.memory_id));
    return Response.json(await request(endpoint,body));};
  const hosts=[];
  const hostFactory=()=>{const host={closed:0,warms:[],async warm(config){calls.push({endpoint:'warm'});this.warms.push(clone(config));
    return {ready:true,registration:{verified:true,endUserId:config.endUserId,characterId:config.characterId}};},
    async close(){calls.push({endpoint:'close'});this.closed++;}};hosts.push(host);return host;};
  const helper=new KnowledgeCloud({coordinator,key:KEY,ids:{'judy-alvarez':'remote-judy'},policy:policy(),
    qualificationPath,hostFactory,request,fetchImpl,now:()=>NOW,maxDurationMs:30000,cleanupTimeoutMs:100,...options});
  t.after(async()=>{await helper.close();await ledger.close();await rm(dir,{recursive:true,force:true});});
  return {helper,ledger,coordinator,state,calls,hosts,request,fetchImpl,hostFactory,qualificationPath,
    fork:async()=>{await ledger.bindIdentity({authoritative:true,campaignId:'campaign',branchId:'child',checkpointId:'base',
      parentBranchId:'branch',forkCheckpointId:'save',forkLedgerSequence:events});coordinator.epoch++;}};
}

test('construction and each closed gate are entirely inert, including missing credentials',async t=>{
  const f=await fixture(t,{options:{key:''}});assert.deepEqual(f.calls,[]);assert.deepEqual(f.hosts,[]);
  assert.equal((await f.helper.pump()).reasons[0],'KEY_UNAVAILABLE');
  for(const changes of [{enabled:false},{nativeQualified:false},{providerQualified:false},{version:2}]){
    f.helper.setPolicy({...policy(),...changes});assert.equal((await f.helper.pump()).status,'disabled');}
  assert.deepEqual(f.calls,[]);assert.equal(f.hosts.length,0);
});

test('provider evidence and coordinator admission precede every external operation',async t=>{
  const f=await fixture(t);await writeFile(f.qualificationPath,JSON.stringify({...qualified(),completed:false}));
  assert.equal((await f.helper.pump()).status,'blocked');assert.deepEqual(f.calls,[]);
  await writeFile(f.qualificationPath,JSON.stringify(qualified()));f.coordinator.cloudQualified=false;
  assert.equal((await f.helper.pump()).reasons[0],'SERVICE_CLOUD_DISABLED');assert.deepEqual(f.calls,[]);
});

test('verified memory-disabled profile archives without any character setting mutation',async t=>{
  const f=await fixture(t);const before=clone(f.state.detail);const result=await f.helper.pump();
  assert.equal(result.acknowledged,1);assert.equal(f.hosts.length,1);assert.equal(f.hosts[0].closed,1);
  assert.equal(f.calls.some(c=>c.endpoint==='/character/update'),false);
  assert.deepEqual(f.state.detail,before);
  assert.deepEqual(f.calls.map(c=>c.endpoint),['/character/list','/character/get','warm','/memory/add','close']);
});

test('registration is silent and separate while automatic character memory remains disabled',async t=>{
  const f=await fixture(t);const result=await f.helper.pump();
  assert.equal(result.acknowledged,1);assert.equal(f.calls.some(c=>c.endpoint==='/character/update'),false);
  const config=f.hosts[0].warms[0];assert.equal(config.ttsEnabled,false);assert.equal(config.sessionId,'-1');
  assert.equal(config.scope,'memory-registration:private');assert.equal(config.text,undefined);assert.equal(config.freshSession,undefined);
  assert.equal(config.endUserId,result.touchedScopes[0].endUserId);assert.equal(f.hosts[0].closed,1);
  assert.equal(JSON.stringify(f.helper.status()).includes(KEY),false);
  assert.equal(config.endUserId,REST_USER);
  assert.deepEqual(result.touchedScopes[0].conversationScopes,[]);
  assert.equal(result.touchedScopes[0].requiresIdleRefresh,false);
  assert.equal(result.touchedScopes[0].archiveOnly,true);
});

test('memory-enabled profile blocks archive integration and is never toggled automatically',async t=>{
  const f=await fixture(t,{enabled:true,options:{policy:{...policy(),enableOwnedProfiles:true}}});
  assert.deepEqual((await f.helper.pump()).reasons,['CHARACTER_AUTOMATIC_MEMORY_ENABLED']);
  assert.equal(f.calls.some(c=>c.endpoint==='/character/update'),false);assert.equal(f.hosts.length,0);
});

test('wrong marker, account membership, model and aliased mapping cannot archive a profile',async t=>{
  for(const mode of ['marker','account','model','duplicate']){
    await t.test(mode,async t=>{const f=await fixture(t,{options:mode==='duplicate'?{
      ids:{'judy-alvarez':'remote-judy','panam-palmer':'remote-judy'}}:{}});
      if(mode==='marker')f.state.detail.backstory='Biography with another owner.';
      if(mode==='account')f.state.listing=[];
      if(mode==='model')f.state.listing[0].personalised_prompt_config.MODEL='another-model';
      await f.helper.pump();assert.equal(f.calls.some(c=>c.endpoint==='/character/update'||c.endpoint==='/memory/add'),false);
      assert.equal(f.hosts.length,0);});
  }
});

test('selected policy model must match qualification before looking up the account',async t=>{
  const f=await fixture(t,{options:{policy:{...policy(),selectedModel:'another-model'}}});
  assert.deepEqual((await f.helper.pump()).reasons,['MODEL_NOT_QUALIFIED']);assert.deepEqual(f.calls,[]);
});

test('missing memory setting readback cannot certify anonymous compatibility',async t=>{
  const f=await fixture(t);f.helper.requestOverride=async(endpoint,body,options)=>{
    const result=await f.request(endpoint,body,options);if(endpoint==='/character/get')delete result.memory_settings.enabled;
    return result;};
  assert.deepEqual((await f.helper.pump()).reasons,['INVALID_MEMORY_READBACK']);
  assert.equal(f.hosts.length,0);assert.equal(f.ledger.pending()[0].attempts,0);
});

test('readback failure cannot trigger a settings write or an archive request',async t=>{
  const f=await fixture(t);f.helper.requestOverride=async(endpoint,body,options)=>{
    if(endpoint==='/character/get')throw Object.assign(Error('untrusted response'),{code:'CORE_HTTP_ERROR'});
    return f.request(endpoint,body,options);};
  assert.deepEqual((await f.helper.pump()).reasons,['CORE_HTTP_ERROR']);
  assert.equal(f.calls.some(c=>c.endpoint==='/character/update'||c.endpoint==='/memory/add'),false);
  f.helper.requestOverride=f.request;assert.equal((await f.helper.pump()).acknowledged,1);
});

test('default HTTP transport posts exact Core API bodies and does not expose response errors',async t=>{
  const f=await fixture(t,{options:{request:undefined}});const result=await f.helper.pump();
  assert.equal(result.acknowledged,1);assert.equal(f.calls.some(c=>c.endpoint==='/character/get'),true);
  f.helper.fetchImpl=async()=>Response.json({ERROR:`secret ${KEY}`},{status:401});
  await f.ledger.observe(episode(f.ledger,2));await f.ledger.checkpoint({kind:'native-on-restored',branchId:'branch',ledgerSequence:2,checkpointId:'save-2'});
  const rejected=await f.helper.pump();assert.ok(rejected.reasons.includes('CORE_HTTP_ERROR'));
  assert.equal(JSON.stringify(rejected).includes(KEY),false);
});

test('a dedicated registration host is discarded after every pump; none is created for idle work',async t=>{
  const f=await fixture(t,{events:2,options:{maxEntries:1}});
  assert.equal((await f.helper.pump()).acknowledged,1);assert.equal((await f.helper.pump()).acknowledged,1);
  assert.equal(f.hosts.length,2);assert.ok(f.hosts.every(h=>h.closed===1));
  assert.equal((await f.helper.pump()).status,'idle');assert.equal(f.hosts.length,2);
});

test('group archiving shares one REST ID and never invalidates anonymous live streams',async t=>{
  const f=await fixture(t,{events:0});const group=['judy-alvarez','panam-palmer'];
  await f.ledger.observe({...episode(f.ledger),visibility:'group-safe',audience:group});await f.ledger.registerGroup(group);
  await f.ledger.checkpoint({kind:'native-on-restored',branchId:'branch',ledgerSequence:1,checkpointId:'save-2'});
  const result=await f.helper.pump();assert.equal(result.acknowledged,2);
  assert.equal(result.touchedScopes.length,1);
  assert.deepEqual(result.touchedScopes[0].conversationScopes,[]);
  assert.equal(result.touchedScopes[0].endUserId,REST_USER);
  assert.equal(result.touchedScopes[0].requiresIdleRefresh,false);
  assert.ok(f.calls.filter(row=>row.endpoint==='/memory/add').every(row=>row.body.end_user_id===REST_USER));
  assert.equal(f.hosts[0].closed,1);
});

test('a save change during profile readback prevents registration; late add preserves only old scope',async t=>{
  const before=await fixture(t);before.helper.requestOverride=async(endpoint,body,options)=>{
    const value=await before.request(endpoint,body,options);if(endpoint==='/character/get')await before.fork();return value;};
  await before.helper.pump();assert.equal(before.calls.some(c=>c.endpoint==='/character/update'),false);
  const after=await fixture(t);const fetchImpl=after.helper.adapter.fetchImpl;
  after.helper.adapter.fetchImpl=async(url,init)=>{const reply=await fetchImpl(url,init);await after.fork();return reply;};
  const result=await after.helper.pump();assert.equal(result.acknowledged,1);assert.equal(result.touchedScopes[0].obsolete,true);
  assert.equal(result.touchedScopes[0].endUserId,REST_USER);
  assert.notEqual(result.touchedScopes[0].localScopeId,after.ledger.pending()[0].endUserId);
});

test('policy cancellation closes registration without adding memory or touching normal sessions',async t=>{
  const f=await fixture(t),started=deferred();
  f.helper.hostFactory=()=>{const host=f.hostFactory();host.warm=async()=>{started.resolve();return new Promise(()=>{});};return host;};
  const running=f.helper.pump();await started.promise;
  f.helper.setPolicy({...policy(),enabled:false});const result=await running;
  assert.equal(result.status,'cancelled');assert.equal(f.hosts[0].closed,1);
  assert.equal(f.calls.some(c=>c.endpoint==='/memory/add'),false);assert.deepEqual(result.touchedScopes,[]);
});

test('ignored Core cancellation and excessive response sizes are bounded before registration',async t=>{
  // The whole-pump budget must stay well above the request timeout: on a busy machine the
  // qualification read can take longer than a tight budget and the pump would be cancelled first.
  const f=await fixture(t,{options:{maxDurationMs:10000,requestTimeoutMs:40}});
  f.helper.requestOverride=()=>new Promise(()=>{});const started=Date.now();
  const result=await f.helper.pump();assert.ok(result.reasons.includes('CORE_TIMEOUT'));assert.ok(Date.now()-started<5000);
  f.helper.requestOverride=async()=>({data:'x'.repeat(4*1024*1024+1)});
  assert.ok((await f.helper.pump()).reasons.includes('CORE_RESPONSE_TOO_LARGE'));assert.equal(f.hosts.length,0);
});

test('host startup and cleanup cancellation cannot leave a reusable registration connection',async t=>{
  // Cancel from the outside once the host is really being created; a short whole-pump timer could
  // fire before the factory is reached when the machine is busy, leaving nothing to clean up.
  const f=await fixture(t,{options:{cleanupTimeoutMs:20}}),factory=deferred(),requested=deferred(),stop=new AbortController();
  f.helper.hostFactory=()=>{requested.resolve();return factory.promise;};
  const running=f.helper.pump({signal:stop.signal});await requested.promise;stop.abort();
  const result=await running;assert.equal(result.status,'cancelled');assert.equal(result.cleanup,'REGISTRATION_CLEANUP_PENDING');
  assert.equal((await f.helper.pump()).reasons[0],'REGISTRATION_CLEANUP_PENDING');
  const host=f.hostFactory();factory.resolve(host);await new Promise(r=>setImmediate(r));assert.equal(host.closed,1);
  assert.equal(f.helper.status().cleanupPending,false);assert.equal(f.calls.some(c=>c.endpoint==='/memory/add'),false);
});
