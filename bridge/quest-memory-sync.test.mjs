import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {QuestMemoryLedger} from './quest-memory.mjs';
import {QuestMemorySync} from './quest-memory-sync.mjs';
import {fakeClock} from './fixtures/fake-clock.mjs';

const NOW = 100000;
const MODEL = 'fast-gemma-4-31b-it';
const REST_USER = '11111111-1111-4111-8111-111111111111';
const PROVIDER_POLICY = 'explicit-rest-anonymous-live-v1';
const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => {resolve=a;reject=b;}); return {promise,resolve,reject}; };
const qualification = () => ({version:1,completed:true,runId:'isolated-test',model:MODEL,
  checks:{separateProfileFields:true,memoryEnabledReadback:true,registeredUsersViaConnect:true,
    newUsersEmpty:true,userAAddListGet:true,userBAddListGet:true,distinctUserLists:true,
    modelReadback:MODEL,crossUserGetA:{denied:true,status:403},crossUserGetB:{denied:true,status:403}},
  registration:{A:{identityEchoVerified:true,closed:true},B:{identityEchoVerified:true,closed:true}},
  cleanup:{profileAbsent:true,A:{recordsEmpty:true},B:{recordsEmpty:true}},
  anonymousLiveQualification:{version:1,completed:true,sourceRunId:'anonymous-test',model:MODEL,
    usersReused:true,newEndUserIds:0,anonymousEchoNull:true,anonymousClosed:true,
    registrationEchoVerified:true,explicitRestVerified:true,profileAbsent:true,
    mode:'memory-disabled-explicit-rest-v1',liveCharacterMemoryEnabled:false,explicitRestWithMemoryDisabled:true}});
const decision = (ledger, index=1, changes={}) => ({eventId:`decision-${index}`,factId:`choice.${index}`,
  kind:'decision',authority:'game-state',text:`V and Judy completed reviewed choice ${index}.`,outcome:'confirmed',
  stable:true,eligibleForMemory:true,characterKey:'judy-alvarez',knownBy:['judy-alvarez'],witnessedBy:['judy-alvarez'],
  visibility:'private',evidence:[{sourceId:'native-reviewed-fact',evidenceRefs:[`fact:${index}`]}],
  provenance:{packId:'reviewed',ruleId:`rule-${index}`,revision:1},identity:ledger.identity,...changes});

async function fixture(t,{saved=true,events=1,syncOptions={}}={}) {
  const directory=await mkdtemp(join(tmpdir(),'cyberpunk-memory-sync-'));
  const ledger=await QuestMemoryLedger.load({path:join(directory,'ledger.json'),now:()=>NOW});
  const qualificationPath=join(directory,'qualification.json');
  await writeFile(qualificationPath,JSON.stringify(qualification()));
  await ledger.bindIdentity({authoritative:true,campaignId:'campaign-1',branchId:'branch-1',checkpointId:'initial'});
  for(let i=1;i<=events;i++) await ledger.observe(decision(ledger,i));
  if(saved) await ledger.checkpoint({kind:'native-on-restored',branchId:'branch-1',ledgerSequence:events,checkpointId:'saved-1'});
  const log=[];
  const service={ledger,cloudQualified:true,epoch:1,
    guard(){return ledger.identity?{epoch:this.epoch,branchId:ledger.identity.branchId,userId:ledger.userId}:null;},
    isCurrent(guard){return !!guard&&JSON.stringify(guard)===JSON.stringify(this.guard());},
    async current(guard){return this.isCurrent(guard);},
    pendingCloud(options){return this.cloudQualified?ledger.pending(options).map(entry=>({...entry,
      restEndUserId:REST_USER,providerPolicy:PROVIDER_POLICY,guard:this.guard()})):[];},
    sessionIdentity(characterKey,channel,audience){const c=ledger.contextFor({characterKey,channel,audience});
      return {...c,localScopeId:c.endUserId,restEndUserId:REST_USER,providerPolicy:PROVIDER_POLICY};}};
  const adapter={enabled:true,
    async add(args){log.push(['add',args]);return {memories:[{id:`memory-${log.length}`,memory:args.memories[0]}]};},
    async scan(args){log.push(['scan',args]);return {...args,memories:[],complete:true};},
    async get(args){log.push(['get',args]);throw new Error('Unexpected record lookup');}};
  const resolveCharacter=async profileKey=>{log.push(['character',profileKey]);return {
    profileKey,characterId:`remote-${profileKey}`,verified:true,owned:true,source:'convai-character-get',
    memoryEnabled:false,model:MODEL,verifiedAt:NOW};};
  const registerScope=async args=>{log.push(['register',args]);return {ready:true,registration:{
    verified:true,endUserId:args.endUserId,characterId:args.characterId}};};
  const sync=new QuestMemorySync({service,adapter,providerQualificationPath:qualificationPath,
    resolveCharacter,registerScope,enabled:true,nativeQualified:true,now:()=>NOW,maxDurationMs:30000,...syncOptions});
  t.after(async()=>{await sync.close();await ledger.close();await rm(directory,{recursive:true,force:true});});
  const fork=async()=>{await ledger.bindIdentity({authoritative:true,campaignId:'campaign-1',branchId:'branch-2',
    checkpointId:'fork-base',parentBranchId:'branch-1',forkCheckpointId:'saved-1',forkLedgerSequence:events});service.epoch++;};
  const uncertain=async()=>{const entry=ledger.pending()[0];const lease=await ledger.claim(entry.id,{characterId:'remote-judy-alvarez',restEndUserId:REST_USER});
    await ledger.fail(lease,{ambiguous:true,code:'TIMEOUT'});return ledger.pending({includeUncertain:true}).find(row=>row.id===entry.id);};
  return {ledger,service,adapter,sync,log,qualificationPath,fork,uncertain};
}

test('all explicit gates default closed and no network callbacks run',async t=>{
  const f=await fixture(t);
  for(const [apply,code] of [
    [()=>f.sync.enabled=false,'DISABLED'],
    [()=>{f.sync.enabled=true;f.sync.nativeQualified=false;},'NATIVE_NOT_QUALIFIED'],
    [()=>{f.sync.nativeQualified=true;f.service.cloudQualified=false;},'SERVICE_CLOUD_DISABLED'],
    [()=>{f.service.cloudQualified=true;f.adapter.enabled=false;},'ADAPTER_DISABLED'],
    [()=>{f.adapter.enabled=true;f.sync.registerScope=null;},'CALLBACKS_UNAVAILABLE']]) {
    apply();const result=await f.sync.pump();assert.equal(result.status,'disabled');assert.deepEqual(result.reasons,[code]);
  }
  assert.deepEqual(f.log,[]);assert.equal(f.ledger.pending().length,1);
});

test('missing, malformed, incomplete or oversized provider qualification prevents registration',async t=>{
  const f=await fixture(t);
  for(const body of ['not json',JSON.stringify({...qualification(),completed:false}),
    JSON.stringify({...qualification(),checks:{...qualification().checks,registeredUsersViaConnect:false}}),'x'.repeat(128*1024+1)]){
    await writeFile(f.qualificationPath,body);const result=await f.sync.pump();assert.equal(result.status,'blocked');
  }
  f.sync.providerQualificationPath=join(f.qualificationPath,'missing');
  assert.equal((await f.sync.pump()).status,'blocked');assert.deepEqual(f.log,[]);
});

test('automatic memory mode qualification is required before any external callback',async t=>{
  const f=await fixture(t),old=qualification();delete old.anonymousLiveQualification;
  await writeFile(f.qualificationPath,JSON.stringify(old));
  assert.deepEqual((await f.sync.pump()).reasons,['ANONYMOUS_MEMORY_POLICY_NOT_QUALIFIED']);
  assert.deepEqual(f.log,[]);
});

test('legacy branch IDs or an unbounded destination are never sent as provider users',async t=>{
  const f=await fixture(t),pending=f.service.pendingCloud.bind(f.service);
  for(const change of [{restEndUserId:undefined},{restEndUserId:'cp2077-branch-derived'},
    {providerPolicy:undefined},{providerPolicy:'automatic-ltm'}]) {
    f.service.pendingCloud=o=>pending(o).map(row=>({...row,...change}));
    assert.deepEqual((await f.sync.pump()).reasons,['REST_IDENTITY_NOT_BOUNDED']);
  }
  assert.deepEqual(f.log,[]);assert.equal(f.ledger.pending()[0].attempts,0);
});

test('pool remapping during registration is rejected before claim',async t=>{
  const f=await fixture(t),current=f.service.sessionIdentity.bind(f.service),register=f.sync.registerScope;
  f.sync.registerScope=async args=>{const result=await register(args);
    f.service.sessionIdentity=(...query)=>({...current(...query),restEndUserId:'22222222-2222-4222-8222-222222222222'});
    return result;};
  assert.deepEqual((await f.sync.pump()).reasons,['STALE_SCOPE']);
  assert.equal(f.log.some(row=>row[0]==='add'),false);assert.equal(f.ledger.pending()[0].attempts,0);
});

test('saved episode registers exact identity before claim and one accepted write',async t=>{
  const f=await fixture(t);let atRegistration;
  const register=f.sync.registerScope;f.sync.registerScope=async args=>{atRegistration=f.ledger.pending()[0].state;return register(args);};
  const result=await f.sync.pump();assert.equal(result.acknowledged,1);assert.equal(atRegistration,'pending');
  assert.deepEqual(f.log.map(row=>row[0]),['character','register','add']);
  assert.equal(f.log[1][1].endUserId,f.log[2][1].endUserId);
  assert.equal(f.log[2][1].endUserId,REST_USER);
  assert.notEqual(f.log[1][1].localScopeId,REST_USER);
  assert.equal(f.log[1][1].characterId,'remote-judy-alvarez');assert.equal(f.log[2][1].memories.length,1);
  assert.deepEqual(f.ledger.pending(),[]);assert.equal(f.ledger.status().outbox.acknowledged,1);
  assert.equal((await f.sync.pump()).status,'idle');assert.equal(f.log.filter(row=>row[0]==='add').length,1);
});

test('unrestored local events remain staged without any provider work',async t=>{
  const f=await fixture(t,{saved:false});assert.equal((await f.sync.pump()).status,'idle');assert.deepEqual(f.log,[]);
});

test('owned memory-disabled fresh profile readback must match provider qualification',async t=>{
  const f=await fixture(t);const resolve=f.sync.resolveCharacter;
  for(const change of [{memoryEnabled:true},{owned:false},{verified:false},{source:'catalog'},
    {profileKey:'panam-palmer'},{model:'other-model'},{verifiedAt:NOW-300001},{verifiedAt:NOW+1001},{verifiedAt:'invalid'}]){
    f.sync.resolveCharacter=async key=>({...await resolve(key),...change});
    const result=await f.sync.pump();assert.deepEqual(result.reasons,['CHARACTER_NOT_VERIFIED']);
  }
  assert.equal(f.log.some(row=>row[0]==='register'||row[0]==='add'),false);assert.equal(f.ledger.pending()[0].attempts,0);
});

test('missing and mismatched SDK registration echoes fail before any claim',async t=>{
  const f=await fixture(t);
  for(const reply of [{ready:true},{ready:false,registration:{verified:true}},
    {ready:true,registration:{verified:true,endUserId:'other-user',characterId:'remote-judy-alvarez'}}]){
    f.sync.registerScope=async()=>reply;const result=await f.sync.pump();assert.deepEqual(result.reasons,['REGISTRATION_NOT_VERIFIED']);
  }
  f.sync.registerScope=async args=>({ready:true,registration:{verified:true,endUserId:args.endUserId,characterId:'other-character'}});
  assert.deepEqual((await f.sync.pump()).reasons,['REGISTRATION_NOT_VERIFIED']);
  assert.equal(f.ledger.pending()[0].attempts,0);assert.equal(f.log.some(row=>row[0]==='add'),false);
});

test('same user pair registers once within a bounded pump; concurrent pump does not duplicate it',async t=>{
  const f=await fixture(t,{events:3,syncOptions:{maxEntries:2}}),started=deferred(),release=deferred();
  const register=f.sync.registerScope;f.sync.registerScope=async args=>{started.resolve();await release.promise;return register(args);};
  const running=f.sync.pump();await started.promise;assert.equal((await f.sync.pump()).status,'busy');release.resolve();
  const result=await running;assert.equal(result.processed,2);assert.equal(result.acknowledged,2);
  assert.equal(f.log.filter(row=>row[0]==='register').length,1);assert.equal(f.ledger.pending().length,1);
  assert.equal((await f.sync.pump()).acknowledged,1);
});

test('exact groups retain separate local projections but reuse one REST identity',async t=>{
  const f=await fixture(t,{events:0});
  const pair=['judy-alvarez','panam-palmer'],other=['judy-alvarez','johnny-silverhand'];
  await f.ledger.observe(decision(f.ledger,1,{visibility:'group-safe',audience:[...pair,'johnny-silverhand']}));
  await f.ledger.registerGroup(pair);await f.ledger.registerGroup(other);
  await f.ledger.checkpoint({kind:'native-on-restored',branchId:'branch-1',ledgerSequence:1,checkpointId:'saved-2'});
  assert.equal((await f.sync.pump()).acknowledged,3);
  assert.equal(f.log.filter(row=>row[0]==='register').length,1);
  assert.deepEqual(new Set(f.log.filter(row=>row[0]==='add').map(row=>row[1].endUserId)),new Set([REST_USER]));
  const first=f.service.sessionIdentity('judy-alvarez','group',pair),second=f.service.sessionIdentity('judy-alvarez','group',other);
  assert.notEqual(first.localScopeId,second.localScopeId);assert.equal(first.restEndUserId,second.restEndUserId);
});

test('Judy and Johnny share the stable provider user across reloads but use distinct character records',async t=>{
  const f=await fixture(t,{events:0});
  await f.ledger.observe(decision(f.ledger,1,{knownBy:['judy-alvarez','johnny-silverhand'],
    witnessedBy:['judy-alvarez','johnny-silverhand']}));
  await f.ledger.checkpoint({kind:'native-on-restored',branchId:'branch-1',ledgerSequence:1,checkpointId:'shared-save'});
  assert.equal((await f.sync.pump()).acknowledged,2);
  let writes=f.log.filter(row=>row[0]==='add').map(row=>row[1]);
  assert.deepEqual(new Set(writes.map(row=>row.endUserId)),new Set([REST_USER]));
  assert.deepEqual(new Set(writes.map(row=>row.characterId)),new Set(['remote-judy-alvarez','remote-johnny-silverhand']));
  await f.ledger.bindIdentity({authoritative:true,campaignId:'campaign-1',branchId:'loaded-again',checkpointId:'child-base',
    parentBranchId:'branch-1',forkCheckpointId:'shared-save',forkLedgerSequence:1});f.service.epoch++;
  assert.equal((await f.sync.pump()).acknowledged,2);
  writes=f.log.filter(row=>row[0]==='add').map(row=>row[1]);
  assert.deepEqual(new Set(writes.map(row=>row.endUserId)),new Set([REST_USER]));
});

test('a branch change while registration is running cannot claim or submit an old entry',async t=>{
  const f=await fixture(t);const register=f.sync.registerScope;
  f.sync.registerScope=async args=>{await f.fork();return register(args);};
  const result=await f.sync.pump();assert.deepEqual(result.reasons,['STALE_SCOPE']);
  assert.equal(f.log.some(row=>row[0]==='add'),false);assert.equal(f.ledger.pending()[0].state,'pending');
});

test('a branch change after durable claim but before dispatch settles only the unused old lease',async t=>{
  const f=await fixture(t);const claim=f.ledger.claim.bind(f.ledger);
  f.ledger.claim=async(...args)=>{const lease=await claim(...args);await f.fork();return lease;};
  const result=await f.sync.pump();assert.equal(result.failed,1);assert.equal(result.obsolete,1);
  assert.equal(f.log.some(row=>row[0]==='add'),false);assert.equal(f.ledger.pending()[0].state,'pending');
  assert.equal(f.ledger.status().outbox.failed,1);
});

test('accepted response after restore acknowledges only old lease, leaving new namespace pending',async t=>{
  const f=await fixture(t);const add=f.adapter.add;
  f.adapter.add=async args=>{await f.fork();return add(args);};
  const result=await f.sync.pump();assert.equal(result.acknowledged,1);assert.equal(result.obsolete,1);
  const next=f.ledger.pending()[0];assert.equal(next.state,'pending');
  assert.notEqual(next.endUserId,f.log.find(row=>row[0]==='add')[1].endUserId);
});

test('ignored cancellation in registration is bounded and cannot dispatch later',async t=>{
  // The 80 ms budget runs on a fake clock: a busy machine cannot spend it before the callback is reached or make the bound a race.
  const clock=fakeClock();
  const f=await fixture(t,{syncOptions:{maxDurationMs:80,setTimer:clock.setTimer,clearTimer:clock.clearTimer}}),pending=deferred(),reached=deferred();let args,settled=false;
  f.sync.registerScope=input=>{args=input;reached.resolve();return pending.promise;};
  const running=f.sync.pump().then(value=>{settled=true;return value;});await reached.promise;
  assert.equal(clock.pending(),1);await clock.advance(79);assert.equal(settled,false,'still inside the budget');
  await clock.advance(1);assert.equal(settled,true,'the budget ended the pump although the callback ignores cancellation and is still pending');
  const result=await running;assert.equal(result.status,'cancelled');
  pending.resolve({ready:true,registration:{verified:true,endUserId:args.endUserId,characterId:args.characterId}});
  await new Promise(resolve=>setImmediate(resolve));assert.equal(f.log.some(row=>row[0]==='add'),false);
  assert.equal(f.ledger.pending()[0].attempts,0);
});

test('cancel after POST dispatch is uncertain; late accepted promise does not attach a new receipt',async t=>{
  const f=await fixture(t),started=deferred(),pending=deferred();let args;
  f.adapter.add=input=>{args=input;started.resolve();return pending.promise;};
  const running=f.sync.pump();await started.promise;f.sync.cancel();
  const result=await running;assert.equal(result.uncertain,1);assert.equal(result.status,'cancelled');
  assert.equal(f.ledger.pending({includeUncertain:true})[0].state,'uncertain');
  await f.fork();pending.resolve({memories:[{id:'late-memory',memory:args.memories[0]}]});
  await new Promise(resolve=>setImmediate(resolve));assert.equal(f.ledger.status().outbox.acknowledged??0,0);
  assert.equal(f.ledger.pending()[0].state,'pending');
});

test('definitive rejected writes fail once and are never automatically retried',async t=>{
  const f=await fixture(t);let calls=0;f.adapter.add=async()=>{calls++;throw Object.assign(new Error('redacted'),{code:'HTTP_ERROR',status:403,writeUncertain:false});};
  const result=await f.sync.pump();assert.equal(result.failed,1);assert.equal(result.uncertain,0);
  assert.equal((await f.sync.pump()).status,'idle');assert.equal(calls,1);assert.equal(f.ledger.status().outbox.failed,1);
});

test('ambiguous writes reconcile by read; complete or incomplete absence never retries add',async t=>{
  const f=await fixture(t);await f.uncertain();
  for(const complete of [false,true]){
    f.adapter.scan=async args=>{f.log.push(['scan',args]);return {...args,memories:[],complete};};
    const result=await f.sync.pump();assert.equal(result.uncertain,1);
    assert.equal(f.ledger.pending({includeUncertain:true})[0].state,'uncertain');
  }
  assert.equal(f.log.some(row=>row[0]==='add'||row[0]==='get'),false);
  assert.equal(f.log.find(row=>row[0]==='scan')[1].maxPages,4);
});

test('exact normalized text and a verified scoped memory ID reconcile without another write',async t=>{
  const f=await fixture(t),entry=await f.uncertain();
  f.adapter.scan=async args=>({...args,memories:[{id:'same-record',memory:`  ${entry.text.replaceAll(' ','  ')}\n`}],complete:false});
  f.adapter.get=async args=>{f.log.push(['get',args]);return {id:args.memoryId,memory:entry.text};};
  const result=await f.sync.pump();assert.equal(result.reconciled,1);assert.equal(result.acknowledged,1);
  assert.equal(f.log.find(row=>row[0]==='get')[1].endUserId,entry.restEndUserId);
  assert.equal(f.log.some(row=>row[0]==='add'),false);assert.deepEqual(f.ledger.pending({includeUncertain:true}),[]);
});

test('fresh-user 404 and invalid reconciliation identities never become empty success or retry permission',async t=>{
  const f=await fixture(t),entry=await f.uncertain();
  f.adapter.scan=async()=>{throw Object.assign(new Error('no body output'),{code:'HTTP_ERROR',status:404});};
  assert.deepEqual((await f.sync.pump()).reasons,['HTTP_ERROR']);
  f.adapter.scan=async args=>({...args,endUserId:'other-user',memories:[],complete:true});
  assert.deepEqual((await f.sync.pump()).reasons,['INVALID_RECONCILIATION_SCOPE']);
  f.adapter.scan=async args=>({...args,memories:[{id:'record',memory:entry.text}],complete:true});
  f.adapter.get=async()=>({id:'record',memory:'Different meaning.'});
  assert.deepEqual((await f.sync.pump()).reasons,['RECONCILIATION_RECORD_MISMATCH']);
  assert.equal(f.ledger.pending({includeUncertain:true})[0].state,'uncertain');assert.equal(f.log.some(row=>row[0]==='add'),false);
});

test('profile remapping cannot reconcile an earlier character binding',async t=>{
  const f=await fixture(t);await f.uncertain();const resolve=f.sync.resolveCharacter;
  f.sync.resolveCharacter=async key=>({...await resolve(key),characterId:'replacement-character'});
  assert.deepEqual((await f.sync.pump()).reasons,['CHARACTER_BINDING_CHANGED']);
  assert.equal(f.log.some(row=>row[0]==='scan'||row[0]==='add'),false);
});

test('bounded pumps rotate unresolved entries while new checkpointed episodes still progress',async t=>{
  const f=await fixture(t,{events:4,syncOptions:{maxEntries:1}});
  const first=await f.uncertain(),second=await f.uncertain();let scans=0;
  f.adapter.scan=async args=>{scans++;if(scans===1)throw Object.assign(new Error('redacted'),{code:'HTTP_ERROR',status:404});
    return {...args,memories:[{id:'second-uncertain',memory:second.text}],complete:true};};
  f.adapter.get=async args=>({id:args.memoryId,memory:second.text});
  assert.equal((await f.sync.pump()).acknowledged,1); // New saved episode.
  assert.deepEqual((await f.sync.pump()).reasons,['HTTP_ERROR']); // First uncertain remains intact.
  assert.equal((await f.sync.pump()).acknowledged,1); // Another new episode is not blocked.
  assert.equal((await f.sync.pump()).reconciled,1); // The second uncertain is not starved by the first.
  assert.deepEqual(f.ledger.pending({includeUncertain:true}).map(row=>row.id),[first.id]);
  assert.equal(f.log.filter(row=>row[0]==='add').length,2);
});

test('unverified profile at the head of pending queue does not starve another character',async t=>{
  const f=await fixture(t,{events:0,syncOptions:{maxEntries:1}});
  await f.ledger.observe(decision(f.ledger,1,{characterKey:'panam-palmer',knownBy:['panam-palmer'],witnessedBy:['panam-palmer']}));
  await f.ledger.observe(decision(f.ledger,2));
  await f.ledger.checkpoint({kind:'native-on-restored',branchId:'branch-1',ledgerSequence:2,checkpointId:'saved-2'});
  const resolve=f.sync.resolveCharacter;f.sync.resolveCharacter=async key=>({...await resolve(key),memoryEnabled:key==='panam-palmer'});
  assert.deepEqual((await f.sync.pump()).reasons,['CHARACTER_NOT_VERIFIED']);
  assert.equal((await f.sync.pump()).acknowledged,1);
  assert.equal(f.ledger.pending()[0].characterKey,'panam-palmer');
});

test('service policy revocation is checked after registration, before claiming any write',async t=>{
  const f=await fixture(t);const register=f.sync.registerScope;
  f.sync.registerScope=async args=>{const receipt=await register(args);f.service.cloudQualified=false;return receipt;};
  assert.deepEqual((await f.sync.pump()).reasons,['SERVICE_CLOUD_DISABLED']);
  assert.equal(f.ledger.pending()[0].attempts,0);assert.equal(f.log.some(row=>row[0]==='add'),false);
});

test('closing the worker cancels callbacks and never closes injected ledger or service',async t=>{
  const f=await fixture(t),started=deferred();f.sync.registerScope=()=>{started.resolve();return new Promise(()=>{});};
  const running=f.sync.pump();await started.promise;await f.sync.close();assert.equal((await running).status,'cancelled');
  assert.equal((await f.sync.pump()).status,'disabled');assert.equal(f.sync.status().closed,true);
  assert.ok(f.ledger.identity);assert.equal(f.ledger.pending()[0].attempts,0);
});
