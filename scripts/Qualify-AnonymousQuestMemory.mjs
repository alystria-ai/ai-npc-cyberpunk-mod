// Historical experiment, superseded by the one-ID natural-memory runtime.
// Bounded provider qualification: reuse the two existing synthetic identities.
// Default is read-only planning; --run creates at most one disposable profile.
// Never imports production character IDs and never creates an end-user ID.
import {readFile,mkdir,open,rename,unlink} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID,createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {chromium} from 'playwright';
import {build} from 'esbuild';
import {ConvaiMemoryAdapter,normalizeMemoryText} from '../bridge/convai-memory.mjs';
import {characterPayload,verifyCharacter} from './character-payload.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const sourcePath=resolve(root,'runtime','memory-qualification','receipt.json');
const args=new Set(process.argv.slice(2));
if([...args].some(arg=>!['--run','--cleanup-only','--memory-disabled','--self-test'].includes(arg))
  ||['--run','--cleanup-only','--self-test'].filter(arg=>args.has(arg)).length>1)
  throw Error('Use --run, --cleanup-only or --self-test, optionally with --memory-disabled.');
const memoryDisabled=args.has('--memory-disabled');
const mode=memoryDisabled?'memory-disabled-explicit-rest-v1':'memory-enabled-anonymous-v1';
const outputName=memoryDisabled?'anonymous-memory-disabled-qualification':'anonymous-memory-qualification';
const output=resolve(root,'runtime',outputName);
const receiptPath=resolve(output,'receipt.json');
const reportName=memoryDisabled?'ANONYMOUS_MEMORY_DISABLED_QUALIFICATION.md':'ANONYMOUS_MEMORY_QUALIFICATION.md';
const reportPath=resolve(root,'research','cyberpunk',reportName);
const parse=text=>JSON.parse(text.replace(/^\uFEFF/,''));
const failure=(code,status)=>Object.assign(new Error(code),{code,status});
const summary=error=>({code:typeof error?.code==='string'?error.code:'LOCAL_'+String(error?.name??'Error').replace(/[^A-Za-z]/g,''),
  ...(Number.isInteger(error?.status)?{status:error.status}:{})});
const idOk=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,255}$/.test(value);
const hash=value=>createHash('sha256').update(String(value)).digest('hex').slice(0,16);
const source=parse(await readFile(sourcePath,'utf8'));
if(source.completed!==true||source.cleanup?.profileAbsent!==true
  ||!idOk(source.characterId)||!idOk(source.users?.A)||!idOk(source.users?.B)||source.users.A===source.users.B
  ||source.cleanup?.A?.recordsEmpty!==true||source.cleanup?.B?.recordsEmpty!==true
  ||source.registration?.A?.closed!==true||source.registration?.B?.closed!==true
  ||source.registration?.A?.identityEchoVerified!==true||source.registration?.B?.identityEchoVerified!==true)
  throw failure('SOURCE_QUALIFICATION_NOT_CLEAN');
const roster=parse(await readFile(resolve(root,'characters','roster.json'),'utf8'));
const reference=roster.find(row=>row.key==='judy-alvarez')??roster[0];
if(reference?.model!==source.model)throw failure('SELECTED_MODEL_CHANGED');
if(!args.has('--run')&&!args.has('--cleanup-only')&&!args.has('--self-test')){
  console.log(JSON.stringify({mode:'plan',maximumDisposableProfiles:1,model:source.model,
    qualificationMode:mode,liveCharacterMemoryEnabled:!memoryDisabled,
    existingSyntheticUsersReused:2,newEndUserIds:0,productionProfilesModified:0,
    emptyConnects:['anonymous before','existing A','existing B','anonymous after'],
    checks:['actual omitted identity and null server/client echo','clean disconnect','explicit A/B add/list/get isolation','owned record/profile cleanup'],
    microphone:false,userTurns:false,dynamicContext:false,receipt:`runtime/${outputName}/receipt.json`}));
  process.exit(0);
}
await mkdir(output,{recursive:true});
let receipt;
try{receipt=parse(await readFile(receiptPath,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
const archived=[];
const priorPaths=[resolve(root,'runtime','anonymous-memory-qualification','attempt-1-receipt.json'),
  ...(memoryDisabled?[resolve(root,'runtime','anonymous-memory-qualification','receipt.json'),
    resolve(root,'runtime','anonymous-memory-disabled-qualification','attempt-1-receipt.json')]:[])];
for(const path of priorPaths){
  let prior;try{prior=parse(await readFile(path,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
  if(!prior)continue;
  if(prior.cleanup?.profileAbsent!==true||prior.users?.A!==source.users.A||prior.users?.B!==source.users.B
    ||prior.sourceRunId!==source.runId||!idOk(prior.characterId))throw failure('ARCHIVED_PROBE_NOT_CLEAN');
  archived.push(prior);
}
if(receipt&&(receipt.sourceRunId!==source.runId||receipt.users?.A!==source.users.A||receipt.users?.B!==source.users.B
  ||receipt.model!==source.model||(memoryDisabled&&receipt.mode!==mode)))throw failure('SOURCE_IDENTITY_CHANGED');
if(args.has('--cleanup-only')&&!receipt){console.log('No anonymous qualification receipt exists; nothing to clean.');process.exit(0);}
const locks=[];
async function lock(path){
  let file;try{file=await open(path,'wx');}catch{throw failure('QUALIFICATION_LOCK_EXISTS');}
  locks.push({path,file});await file.writeFile(String(process.pid));await file.sync();
}
async function atomicJson(path,value){
  const temporary=path+'.tmp-'+randomUUID(),file=await open(temporary,'wx');
  try{await file.writeFile(JSON.stringify(value,null,2)+'\n');await file.sync();}finally{await file.close();}
  await rename(temporary,path);
}
const save=()=>atomicJson(receiptPath,receipt);
let key,adapter,browser,page,server,probeFixture,lastRequest=0;
async function readJson(response,maxBytes=4*1024*1024){
  const reader=response.body?.getReader();if(!reader)throw failure('HTTP_BODY_MISSING');
  let size=0;const chunks=[];
  try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;
    if(size>maxBytes){await reader.cancel();throw failure('HTTP_RESPONSE_TOO_LARGE');}chunks.push(value);}}
  finally{reader.releaseLock();}
  try{let data=parse(Buffer.concat(chunks,size).toString('utf8'));if(typeof data==='string')data=parse(data);return data;}
  catch{throw failure('HTTP_INVALID_JSON');}
}
async function noteHttpError(response,endpoint){
  let data;try{data=await readJson(response.clone(),4096);}catch{return;}
  let message=data?.ERROR??data?.detail??data?.error??data?.message;
  if(typeof message!=='string')message='Structured provider error omitted';
  for(const secret of [key,receipt?.characterId,source.characterId,...Object.values(source.users)].filter(Boolean))
    message=message.split(secret).join('[redacted]');
  message=message.replace(/[a-f0-9]{8}-[a-f0-9-]{27,}/gi,'[redacted-id]').replace(/\b[a-f0-9]{28,}\b/gi,'[redacted-token]')
    .replace(/[\u0000-\u001f]/g,' ').slice(0,240);
  receipt.httpErrors??=[];
  if(receipt.httpErrors.length<20)receipt.httpErrors.push({endpoint,status:response.status,message});
  await save();
}
async function spacedFetch(url,options){
  await new Promise(done=>setTimeout(done,Math.max(0,1100-(Date.now()-lastRequest))));lastRequest=Date.now();
  const response=await fetch(url,options);
  if(!response.ok)await noteHttpError(response,new URL(url).pathname);
  return response;
}
async function core(endpoint,body){
  if(!['/character/create','/character/get','/character/update','/character/list','/character/delete'].includes(endpoint))throw failure('INVALID_ENDPOINT');
  let response;
  try{response=await spacedFetch('https://api.convai.com'+endpoint,{method:'POST',
    headers:{'Content-Type':'application/json','CONVAI-API-KEY':key},body:JSON.stringify(body),signal:AbortSignal.timeout(30000)});}
  catch{throw failure('CORE_TRANSPORT_UNCERTAIN');}
  if(!response.ok){await response.body?.cancel().catch(()=>{});throw failure('CORE_HTTP_ERROR',response.status);}
  const data=await readJson(response);
  if(!data||typeof data!=='object'||['ERROR','API_ERROR','INTERNAL_ERROR'].some(field=>data[field]))throw failure('CORE_API_REJECTED');
  return data;
}
async function profileList(){
  const result=await core('/character/list',{});
  if(!Array.isArray(result.characters))throw failure('CORE_INVALID_LIST');return result.characters;
}
async function owned(){
  if(!idOk(receipt.characterId))throw failure('NO_OWNED_CHARACTER');
  const detail=await core('/character/get',{charID:receipt.characterId});
  if(detail.character_id!==receipt.characterId||detail.character_name!==receipt.payload.charName
    ||typeof detail.backstory!=='string'||!detail.backstory.includes(receipt.marker))throw failure('OWNERSHIP_MISMATCH');
  return detail;
}
async function recoverCreate(){
  const matches=[];
  for(const row of (await profileList()).filter(row=>row.character_name===receipt.payload.charName)){
    const detail=await core('/character/get',{charID:row.character_id});
    if(detail.backstory?.includes(receipt.marker))matches.push(row.character_id);
  }
  if(matches.length!==1)throw failure(matches.length?'AMBIGUOUS_OWNED_PROFILE':'CREATE_UNRESOLVED_NO_RETRY');
  receipt.characterId=matches[0];receipt.createRecovered=true;await save();
}
async function startProbe(){
  const bundle=await build({stdin:{resolveDir:root,contents:`
    import {ConvaiClient} from '@convai/web-sdk/vanilla';
    const makeCounters=()=>({connects:0,outboundHandshake:0,outboundTypes:{},blockedOutbound:0,
      microphoneRequests:0,generatedMessages:0,emptyMessageResets:0,messageTypes:{},generationStarts:0,sttActivity:0});
    const recordMessage=(counters,message)=>{
      if(message==null||(Array.isArray(message)&&message.length===0)){counters.emptyMessageResets++;return;}
      const type=typeof message.type==='string'?message.type:'unknown';
      counters.messageTypes[type]=(counters.messageTypes[type]??0)+1;
      // SDK reset emits undefined. An empty streaming bot message is different:
      // bot-llm-started creates it before the first generated text arrives.
      if(['bot-llm-text','bot-output','user-transcription'].includes(type)
        &&((typeof message.content==='string'&&message.content.trim())
          ||(type==='bot-llm-text'&&message.isStreaming===true)))counters.generatedMessages++;
    };
    const observeClient=(client,counters)=>{
      let wasThinking=false,wasListening=false;
      client.on('message',message=>recordMessage(counters,message));
      client.on('stateChange',state=>{
        if(state.isThinking===true&&!wasThinking)counters.generationStarts++;
        if(state.isListening===true&&!wasListening)counters.sttActivity++;
        wasThinking=state.isThinking===true;wasListening=state.isListening===true;
      });
      client.on('userTranscriptionChange',value=>{if(typeof value==='string'&&value.trim())counters.sttActivity++;});
    };
    const guardedPublish=(counters,publish)=>(bytes,options)=>{
      let message;try{message=JSON.parse(new TextDecoder().decode(bytes));}catch{}
      const type=typeof message?.type==='string'?message.type.replace(/[^a-z0-9-]/gi,'').slice(0,60):'unknown';
      counters.outboundTypes[type]=(counters.outboundTypes[type]??0)+1;
      if(message?.type!=='client-ready'){counters.blockedOutbound++;return Promise.reject(Error('NON_HANDSHAKE_FORBIDDEN'));}
      counters.outboundHandshake++;return publish(bytes,options);
    };
    const selfTest=async()=>{
      const counters=makeCounters(),client=new ConvaiClient({logRtviMessages:false});
      observeClient(client,counters);
      const encode=value=>new TextEncoder().encode(JSON.stringify(value));
      // Exercise the actual installed SDK's three disconnection/reset paths.
      client.room.emit('connectionStateChanged','disconnected');
      client.room.emit('disconnected',0);
      client._connectionStateHandler.resetConnectionState();
      const resetEvents=counters.emptyMessageResets;
      const resetHarmless=resetEvents===3&&counters.generatedMessages===0&&counters.generationStarts===0&&counters.sttActivity===0;
      recordMessage(counters,[]);
      const emptyArrayHarmless=counters.emptyMessageResets===4&&counters.generatedMessages===0;
      client.room.emit('dataReceived',encode({type:'bot-llm-started',data:{}}));
      const emptyStreamingDetected=counters.generatedMessages===1&&counters.generationStarts===1;
      const beforeText=counters.generatedMessages;
      client.room.emit('dataReceived',encode({type:'bot-output',data:{text:'Synthetic bot fixture',spoken:false}}));
      const botTextDetected=counters.generatedMessages>beforeText;
      const beforeUser=counters.generatedMessages;
      client.room.emit('dataReceived',encode({type:'user-transcription',data:{text:'Synthetic user fixture',final:true}}));
      const userTextDetected=counters.generatedMessages>beforeUser;
      client.room.emit('dataReceived',encode({type:'user-transcription',data:{text:'Synthetic interim fixture',final:false}}));
      const sttDetected=counters.sttActivity>0;
      const outbound=makeCounters();let nativePublications=0;
      const publish=guardedPublish(outbound,async()=>{nativePublications++;});
      await publish(encode({type:'client-ready'}),{reliable:true});
      for(const type of ['user_text_message','context-update']){try{await publish(encode({type}),{});}catch{}}
      const outboundGuarded=nativePublications===1&&outbound.outboundHandshake===1&&outbound.blockedOutbound===2;
      return {passed:resetHarmless&&emptyArrayHarmless&&emptyStreamingDetected&&botTextDetected&&userTextDetected&&sttDetected&&outboundGuarded,
        resetEvents,resetHarmless,emptyArrayHarmless,emptyStreamingDetected,botTextDetected,userTextDetected,sttDetected,outboundGuarded};
    };
    window.anonymousMemoryProbe={connect:async(config)=>{
      const anonymous=!Object.hasOwn(config,'endUserId');
      const counters=makeCounters();
      const wire={};let result={},timer,disconnectTimer;
      const redactError=value=>{
        let message=String(value??'');
        for(const secret of [config.apiKey,config.characterId,config.endUserId].filter(Boolean))
          message=message.split(secret).join('[redacted]');
        return message.replace(/[a-f0-9]{8}-[a-f0-9-]{27,}/gi,'[redacted-id]')
          .replace(/[A-Za-z0-9_=-]{26,}/g,'[redacted-token]').slice(0,240);
      };
      const nativeFetch=window.fetch.bind(window);
      window.fetch=async(input,options)=>{
        const url=typeof input==='string'?input:input.url;
        if(new URL(url,location.href).pathname!=='/connect')return nativeFetch(input,options);
        counters.connects++;
        const body=JSON.parse(options.body);
        wire.identityOmitted=!Object.hasOwn(body,'end_user_id');
        wire.identityMatches=anonymous?wire.identityOmitted:body.end_user_id===config.endUserId;
        wire.contextOmitted=!Object.hasOwn(body,'dynamic_info')&&!Object.hasOwn(body,'scene_description');
        let response;
        try{response=await nativeFetch(input,options);}
        catch(error){wire.fetchRejected=true;wire.fetchErrorClass=String(error?.name??'Error');throw error;}
        wire.httpStatus=response.status;
        if(response.ok){const data=await response.clone().json();wire.responseParsed=true;
          wire.responseNull=data.end_user_id===null;
          wire.responseMatches=anonymous?wire.responseNull:data.end_user_id===config.endUserId;}
        return response;
      };
      const media=navigator.mediaDevices,originalGetMedia=media?.getUserMedia;
      if(media)media.getUserMedia=async()=>{counters.microphoneRequests++;throw Error('MICROPHONE_FORBIDDEN');};
      const client=new ConvaiClient({...config,transport:'livekit',characterSessionId:'-1',
        startWithAudioOn:false,startWithVideoOn:false,enableVideo:false,enableLipsync:false,
        ttsEnabled:false,logRtviMessages:false});
      observeClient(client,counters);
      const local=client.room.localParticipant,originalPublish=local.publishData.bind(local);
      local.publishData=guardedPublish(counters,originalPublish);
      try{
        await Promise.race([client.connect(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('CONNECT_TIMEOUT')),30000);})]);
        result.clientEchoNull=client.state.endUserId===null;
        result.clientEchoMatches=anonymous?result.clientEchoNull:client.state.endUserId===config.endUserId;
        result.connected=client.state.isConnected===true;
        result.localTracks=client.room.localParticipant.trackPublications.size;
        await new Promise(done=>setTimeout(done,500));
      }catch(error){result.error='EMPTY_SDK_CONNECT_FAILED';result.errorClass=String(error?.name??'Error');
        result.errorDetail=redactError(error?.message);}
      finally{
        clearTimeout(timer);
        try{await Promise.race([client.disconnect(),new Promise((_,reject)=>{
          disconnectTimer=setTimeout(()=>reject(Error('DISCONNECT_TIMEOUT')),7000);})]);
          result.closed=client.room.state==='disconnected'&&client.state.isConnected===false;
        }catch{result.closed=false;}
        clearTimeout(disconnectTimer);window.fetch=nativeFetch;
        if(media&&originalGetMedia)media.getUserMedia=originalGetMedia;
      }
      return {...result,wire,counters};
    },selfTest};`},bundle:true,write:false,format:'iife',platform:'browser',logLevel:'silent'});
  const javascript=bundle.outputFiles[0].text;
  server=createServer((request,response)=>{
    if(request.headers.host!==`127.0.0.1:${server.address()?.port}`){response.writeHead(403).end();return;}
    response.setHeader('Cache-Control','no-store');
    if(request.url==='/probe.js'){response.setHeader('Content-Type','text/javascript');response.end(javascript);}
    else if(request.url==='/'){response.setHeader('Content-Type','text/html');response.end('<!doctype html><script src="/probe.js"></script>');}
    else response.writeHead(404).end();
  });
  await new Promise((done,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',done);});
  browser=await chromium.launch({channel:'msedge',headless:true,args:['--autoplay-policy=no-user-gesture-required']});
  const context=await browser.newContext({permissions:[]});page=await context.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.waitForFunction(()=>typeof window.anonymousMemoryProbe?.connect==='function');
  // No SDK connect is called by the fixture. Deny external browser requests
  // while testing so the self-test cannot touch an account or create a room.
  await page.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1'?route.continue():route.abort());
  probeFixture=await page.evaluate(()=>window.anonymousMemoryProbe.selfTest());
  await page.unroute('**/*');
  if(probeFixture.passed!==true){console.error(JSON.stringify({offlineFixture:probeFixture}));throw failure('OFFLINE_INSTRUMENTATION_SELF_TEST_FAILED');}
}
async function emptyConnect(label,user){
  const previous=receipt.connections[label];
  if(previous?.verified)return;
  if(previous?.dispatched)throw failure('CONNECT_UNCERTAIN_NO_RETRY');
  receipt.connections[label]={dispatched:true};await save();
  const config={apiKey:key,characterId:receipt.characterId,...(user?{endUserId:receipt.users[user]}:{})};
  const start=Date.now();
  const result=await page.evaluate(config=>window.anonymousMemoryProbe.connect(config),config);
  receipt.connections[label]={dispatched:true,elapsedMs:Date.now()-start,...result};await save();
  if(result.error||!result.connected||!result.closed||result.localTracks!==0
    ||result.counters.connects!==1||result.counters.microphoneRequests!==0||result.counters.blockedOutbound!==0
    ||result.counters.generatedMessages!==0||result.counters.generationStarts!==0||result.counters.sttActivity!==0
    ||!result.wire.contextOmitted||!result.wire.identityMatches
    ||!result.wire.responseMatches||!result.clientEchoMatches
    ||(!user&&(!result.wire.identityOmitted||!result.wire.responseNull||!result.clientEchoNull)))throw failure('EMPTY_CONNECT_CONTRACT_FAILED');
  receipt.connections[label].verified=true;await save();
}
const pair=user=>({characterId:receipt.characterId,endUserId:receipt.users[user]});
const list=user=>adapter.list({...pair(user),page:1,pageSize:100});
async function add(user){
  if(receipt.add[user]?.records)return receipt.add[user].records;
  if(receipt.add[user]?.dispatched)throw failure('ADD_UNCERTAIN_NO_RETRY');
  receipt.add[user]={dispatched:true};await save();
  const result=await adapter.add({...pair(user),memories:[receipt.facts[user]]});
  receipt.add[user].records=result.memories;await save();return result.memories;
}
async function crossGetDenied(user,memoryId){
  try{await adapter.get({...pair(user),memoryId});}
  catch(error){if(error.code==='HTTP_ERROR'&&[403,404].includes(error.status))return {denied:true,status:error.status};throw error;}
  throw failure('CROSS_USER_MEMORY_EXPOSED');
}
async function verifyAdded(user,records){
  const scanned=await list(user);
  if(scanned.has_more||scanned.total_count!==records.length||!records.every(record=>scanned.memories.some(row=>row.id===record.id
    &&normalizeMemoryText(row.memory)===normalizeMemoryText(record.memory))))throw failure('ADD_LIST_MISMATCH');
  for(const record of records){const got=await adapter.get({...pair(user),memoryId:record.id});
    if(normalizeMemoryText(got.memory)!==normalizeMemoryText(record.memory))throw failure('ADD_GET_MISMATCH');}
  return scanned;
}
async function cleanup(){
  if(!receipt.characterId&&receipt.createDispatched)await recoverCreate();
  if(!receipt.characterId)return;
  receipt.cleanup??={};
  if(!(await profileList()).some(row=>row.character_id===receipt.characterId)){
    receipt.cleanup.profileAbsent=true;await save();return;
  }
  await owned();
  for(const user of ['A','B']){
    if(!receipt.add[user]?.dispatched){receipt.cleanup[user]={recordsEmpty:true,noWriteDispatched:true};await save();continue;}
    try{
      const scanned=await adapter.scan({...pair(user),maxPages:2});
      if(!scanned.complete)throw failure('CLEANUP_SCAN_INCOMPLETE');
      const recordedIds=new Set((receipt.add[user].records??[]).map(row=>row.id));
      // No blanket deletion: only IDs returned from this run, or exact synthetic
      // fact readback after an uncertain add, are eligible for record cleanup.
      for(const row of scanned.memories){
        if(!recordedIds.has(row.id)&&normalizeMemoryText(row.memory)!==normalizeMemoryText(receipt.facts[user]))
          throw failure('UNOWNED_RECORD_IN_DISPOSABLE_PROFILE');
        receipt.cleanup[user]??={};receipt.cleanup[user].deletes??={};
        if(receipt.cleanup[user].deletes[row.id]?.dispatched)throw failure('DELETE_UNCERTAIN_NO_RETRY');
        receipt.cleanup[user].deletes[row.id]={dispatched:true};await save();
        await adapter.delete({...pair(user),memoryId:row.id});
        receipt.cleanup[user].deletes[row.id].acknowledged=true;await save();
      }
      const after=await list(user);receipt.cleanup[user]={...receipt.cleanup[user],recordsEmpty:after.total_count===0&&!after.has_more};
      if(!receipt.cleanup[user].recordsEmpty)throw failure('RECORD_DELETE_NOT_CONFIRMED');
    }catch(error){receipt.cleanup[user]={...receipt.cleanup[user],failure:summary(error)};}
    await save();
  }
  if(!(await profileList()).some(row=>row.character_id===receipt.characterId)){
    receipt.cleanup.profileAbsent=true;await save();return;
  }
  if(receipt.cleanup.profileDeleteDispatched)throw failure('PROFILE_DELETE_UNCERTAIN_NO_RETRY');
  await owned();receipt.cleanup.profileDeleteDispatched=true;await save();
  await core('/character/delete',{charID:receipt.characterId});
  receipt.cleanup.profileAbsent=!(await profileList()).some(row=>row.character_id===receipt.characterId);
  await save();if(!receipt.cleanup.profileAbsent)throw failure('PROFILE_DELETE_NOT_CONFIRMED');
}
function complete(){
  const policyVerified=memoryDisabled?receipt?.checks?.memoryDisabledBefore===true
    &&receipt.checks.memoryDisabledAfter===true&&receipt.checks.explicitRestWithMemoryDisabled===true:
    receipt?.checks?.memoryEnabledReadback===true;
  return receipt?.checks?.explicitRestVerified===true&&policyVerified
    &&['anonymousBefore','A','B','anonymousAfter'].every(label=>receipt.connections[label]?.verified===true)
    &&receipt.cleanup?.A?.recordsEmpty===true&&receipt.cleanup?.B?.recordsEmpty===true&&receipt.cleanup?.profileAbsent===true;
}
async function publishQualification(){
  if(!complete())return;
  const latest=parse(await readFile(sourcePath,'utf8'));
  if(latest.runId!==source.runId||latest.users?.A!==source.users.A||latest.users?.B!==source.users.B
    ||latest.cleanup?.profileAbsent!==true||latest.model!==receipt.model)throw failure('SOURCE_RECEIPT_CHANGED');
  if(latest.anonymousLiveQualification&&latest.anonymousLiveQualification.sourceRunId!==receipt.runId)
    throw failure('EXISTING_ANONYMOUS_QUALIFICATION');
  latest.anonymousLiveQualification={version:1,completed:true,sourceRunId:receipt.runId,usersReused:true,newEndUserIds:0,
    anonymousEchoNull:true,anonymousClosed:true,registrationEchoVerified:true,explicitRestVerified:true,profileAbsent:true,model:receipt.model,
    ...(memoryDisabled?{mode,liveCharacterMemoryEnabled:false,explicitRestWithMemoryDisabled:true}:{})};
  await atomicJson(sourcePath,latest);
  receipt.completed=true;receipt.publishedToOriginalReceipt=true;receipt.finished=new Date().toISOString();await save();
}
async function report(){
  const rows=['anonymousBefore','A','B','anonymousAfter'].map(label=>{
    const value=receipt.connections?.[label];
    return `| ${label} | ${!value?'not attempted':value.verified===true?'passed':'incomplete'} | ${value?.closed===true?'yes':'unverified'} |`;
  }).join('\n');
  const recordCleanup=user=>receipt.cleanup?.[user]?.noWriteDispatched?'no write was dispatched':
    receipt.cleanup?.[user]?.recordsEmpty===true?'removed and verified empty':'unverified';
  const failedConnection=Object.values(receipt.connections??{}).find(value=>value.error);
  const memoryIdentityRejected=failedConnection?.wire?.httpStatus===400
    &&failedConnection.errorDetail?.includes('end_user_id is required when the character has Long Term Memory enabled');
  const failureEvidence=failedConnection?`## Connection failure evidence\n\n`+
    `- HTTP status: **${failedConnection.wire?.httpStatus??'not captured in this run'}**. Error class: **${failedConnection.errorClass??'not captured; exception collapsed to EMPTY_SDK_CONNECT_FAILED'}**.\n`+
    (failedConnection.errorDetail?`- Redacted SDK error: \`${failedConnection.errorDetail.replace(/[`<>]/g,'')}\`.\n`:'')+
    `- Connect requests: **${failedConnection.counters?.connects??0}**; readiness handshake messages: **${failedConnection.counters?.outboundHandshake??0}**; blocked application messages: **${failedConnection.counters?.blockedOutbound??0}**.\n`+
    `- Microphone requests: **${failedConnection.counters?.microphoneRequests??0}**; generated messages: **${failedConnection.counters?.generatedMessages??0}**.\n`+
    (memoryIdentityRejected?`- The provider explicitly rejected omitted identity because character memory was enabled. This was not a microphone or handshake rejection.\n\n`:
      `- No successful server identity response was recorded. Neither microphone blocking nor application-message rejection was observed. These counters alone do not distinguish an HTTP rejection from a fetch/CORS or response-decoding failure.\n\n`)+
    (memoryIdentityRejected?`**Conclusion:** this run disproves the proposed combination of anonymous live connections and globally enabled memory on the same character. It does not determine whether explicit REST memory remains available when global character memory is disabled. That different configuration was not tested here.\n\n`:''):'';
  const text=`# Anonymous live sessions and explicit quest memory${memoryDisabled?' with automatic character memory disabled':''}\n\nDate: ${receipt.started}\n\n`+
    `- Result: **${receipt.completed?'passed':'incomplete'}**.\n- Model: \`${receipt.model}\`.\n`+
    `- Mode: \`${mode}\`.\n`+
    (memoryDisabled?`- Character memory readback was exactly disabled before the test: **${receipt.checks?.memoryDisabledBefore===true?'yes':'unverified'}**; after the test: **${receipt.checks?.memoryDisabledAfter===true?'yes':'unverified'}**. This run never enables memory.\n`:'')+
    `- One disposable profile (receipt hash \`${hash(receipt.characterId??receipt.runId)}\`); production profiles changed: **0**.\n`+
    `- Reused the exact two synthetic A/B end-user IDs from the earlier qualification. New end-user IDs: **0**.\n`+
    (archived.length?`- ${archived.length} earlier incomplete anonymous attempt(s) were separately cleaned before this explicitly authorized corrected attempt. Their ignored receipts and reports were retained; the corrected run verified earlier disposable profiles absent before creating its own. At most one probe profile was alive at a time.\n`:'')+
    `- No user message, microphone, dynamic context, or explicit generation request. Outbound application messages were restricted to the SDK's readiness handshake.\n`+
    `- Disposable profile absence confirmed: **${receipt.cleanup?.profileAbsent===true?'yes':'no'}**.\n`+
    `- Synthetic record cleanup: A **${recordCleanup('A')}**, B **${recordCleanup('B')}**.\n\n`+
    `| Empty SDK connection | Identity contract | Disconnected |\n| --- | --- | --- |\n${rows}\n\n`+
    `Explicit A/B add, list, get and cross-user denial: **${receipt.checks?.explicitRestVerified===true?'passed':'incomplete'}**.\n\n`+
    (receipt.failure?`Failure code: \`${receipt.failure.code}\`${receipt.failure.status?` (HTTP ${receipt.failure.status})`:''}.\n\n`:'')+
    (receipt.cleanupFailure?`Cleanup limitation: \`${receipt.cleanupFailure.code}\`. The ignored receipt retains exact recovery ownership.\n\n`:'')+
    failureEvidence+
    `## Scope of the result\n\nThe qualification requires actual SDK connect JSON, server response and client-state evidence. Both anonymous connections must omit \`end_user_id\` and receive null identity, before and after explicit REST memory writes. The two registration connections must echo the existing IDs exactly and all four connections must close cleanly. The table above distinguishes checks reached from checks not attempted.\n\n`+
    `An empty-session test cannot prove that spoken or dynamically injected content can never be extracted by an undocumented backend path. No conversation was generated to test extraction or recall. No independent per-session read/write flags are asserted. An incomplete result does not append qualification to the original explicit REST receipt.\n\n`+
    `## Run and recover\n\n\`node scripts/Qualify-AnonymousQuestMemory.mjs${memoryDisabled?' --memory-disabled':''}\` prints the plan without provider calls. Add \`--run\` for the one bounded probe; an existing completed or cleaned receipt cannot create another profile. Add \`--cleanup-only\` to recover exact receipt-owned resources. Ambiguous writes are not blindly retried. The source receipt and new receipt are locked during execution. Successful qualification is atomically appended to the original receipt only after every check and record/profile cleanup passes. Raw IDs and credentials are excluded from this report; recovery state is ignored under \`runtime/${outputName}/\`.\n\n`+
    (memoryDisabled?`The prior [memory-enabled negative qualification](ANONYMOUS_MEMORY_QUALIFICATION.md) is retained separately. Its HTTP 400 is not overwritten by this different policy test.\n\n`:'')+
    `## Sources\n\n- [Official Connect API](https://github.com/Conv-AI/Convai-Documentation/blob/911cc4104b6eec6187d17e342a59b0bafd8b0303/api-reference/core-api-reference/live-apis-beta/connect-api.md) documents omitted identity as null for single-character connections.\n`+
    `- [Official Web SDK memory guide](https://github.com/Conv-AI/Convai-Documentation/blob/911cc4104b6eec6187d17e342a59b0bafd8b0303/plugins-and-integrations/web-plugins/convai-web-sdk/long-term-memory.md) documents standalone MemoryManager access.\n`+
    `- Installed \`@convai/web-sdk@1.7.0\` provides the connect serializer, null identity state and clean LiveKit disconnect path.\n`;
  await mkdir(dirname(reportPath),{recursive:true});await (await import('node:fs/promises')).writeFile(reportPath,text);
}
if(args.has('--self-test')){
  try{await startProbe();console.log(JSON.stringify({mode:'offline-self-test',...probeFixture}));}
  finally{await browser?.close().catch(()=>{});if(server)await new Promise(done=>server.close(done));}
  process.exit(0);
}
try{
  await lock(resolve(root,'runtime','memory-qualification','qualification.lock'));
  await lock(resolve(output,'qualification.lock'));
  if(receipt?.cleanup?.profileAbsent===true){
    await publishQualification();await report();
    console.log('Existing anonymous probe is cleaned; no new profile or end-user ID created.');
  }else{
    const raw=(await readFile(process.env.CYBERPUNK_CONVAI_KEY_FILE??resolve(root,'runtime','convai-key.txt'),'utf8')).trim();
    key=/^api-key\s*=\s*(\S+)\s*$/i.exec(raw)?.[1];if(!key)throw failure('KEY_FILE_FORMAT');
    adapter=new ConvaiMemoryAdapter({key,enabled:true,timeoutMs:30000,fetchImpl:spacedFetch});
    if(!args.has('--cleanup-only'))await startProbe();
    if(!receipt){
      const runId=randomUUID(),marker=`[CyberpunkConvai disposable anonymous memory qualification:${runId}]`;
      receipt={version:1,runId,mode,sourceRunId:source.runId,started:new Date().toISOString(),model:source.model,marker,
        instrumentationSelfTest:probeFixture,
        users:{A:source.users.A,B:source.users.B},newEndUserIds:0,
        payload:characterPayload({key:'disposable-anonymous-memory-test',name:'Cyberpunk Anonymous Memory Test '+runId.replace(/-/g,'').slice(0,12),
          voice:reference.voice,model:source.model,backstory:'A disposable synthetic verification character with no game lore or real personal information. '+marker,
          speakingStyleDescription:'Brief factual answers; this temporary profile is used only for silent connection verification.',
          speakingStyleSampleDialogues:'Visitor: What is this?\nVerifier: A synthetic memory isolation test.'}),
        facts:{A:'The user calls a fictional research vessel Cedar Lantern and gives it teal sails.',
          B:'The user calls a fictional research vessel Copper Finch and gives it violet sails.'},
        connections:{},add:{},checks:{},completed:false};await save();
    }
    if(!args.has('--cleanup-only')){
      if((await profileList()).some(row=>row.character_id===source.characterId||archived.some(prior=>prior.characterId===row.character_id)))
        throw failure('PRIOR_PROFILE_STILL_PRESENT');
      receipt.checks.priorProfileAbsentReadback=true;await save();
      if(!receipt.characterId){
        if(receipt.createDispatched)await recoverCreate();
        else{receipt.createDispatched=true;await save();const created=await core('/character/create',receipt.payload);
          if(!idOk(created.charID))throw failure('CREATE_ID_MISSING');receipt.characterId=created.charID;await save();}
      }
      const before=await owned();verifyCharacter(receipt.characterId,before,receipt.payload,'disposable-anonymous-memory-test');
      if(memoryDisabled&&before.memory_settings?.enabled!==false)throw failure('MEMORY_DISABLED_NOT_CONFIRMED');
      if(!memoryDisabled&&before.memory_settings?.enabled!==true){
        if(receipt.enableDispatched)throw failure('ENABLE_UNCERTAIN_NO_RETRY');
        receipt.enableDispatched=true;await save();await core('/character/update',{charID:receipt.characterId,memorySettings:{enabled:true}});
      }
      const enabled=await owned();verifyCharacter(receipt.characterId,enabled,receipt.payload,'disposable-anonymous-memory-test');
      if(enabled.memory_settings?.enabled!==!memoryDisabled)throw failure('MEMORY_POLICY_NOT_CONFIRMED');
      const profile=(await profileList()).find(row=>row.character_id===receipt.characterId);
      if(profile?.personalised_prompt_config?.MODEL!==receipt.model)throw failure('MODEL_READBACK_MISMATCH');
      if(memoryDisabled)receipt.checks.memoryDisabledBefore=true;else receipt.checks.memoryEnabledReadback=true;
      receipt.checks.modelReadback=receipt.model;await save();
      console.log('Disposable profile verified; starting empty anonymous and reused-identity connections.');
      await emptyConnect('anonymousBefore');await emptyConnect('A','A');await emptyConnect('B','B');
      if(!receipt.add.A&&!receipt.add.B){
        if((await list('A')).total_count!==0||(await list('B')).total_count!==0)throw failure('DISPOSABLE_PARTITION_NOT_EMPTY');
        receipt.checks.initialPartitionsEmpty=true;await save();
      }
      const a=await add('A');await verifyAdded('A',a);
      if(!receipt.add.B&&(await list('B')).total_count!==0)throw failure('A_MEMORY_EXPOSED_TO_B');
      receipt.checks.crossGetB=await crossGetDenied('B',a[0].id);await save();
      const b=await add('B'),bList=await verifyAdded('B',b),aList=await verifyAdded('A',a);
      if(aList.memories.some(row=>bList.memories.some(other=>row.id===other.id)))throw failure('SHARED_MEMORY_ID');
      receipt.checks.crossGetA=await crossGetDenied('A',b[0].id);receipt.checks.explicitRestVerified=true;await save();
      await emptyConnect('anonymousAfter');receipt.checks.allConnectionsVerified=true;await save();
      if(memoryDisabled){
        const after=await owned();verifyCharacter(receipt.characterId,after,receipt.payload,'disposable-anonymous-memory-test');
        if(after.memory_settings?.enabled!==false)throw failure('MEMORY_DISABLED_AFTER_NOT_CONFIRMED');
        receipt.checks.memoryDisabledAfter=true;receipt.checks.explicitRestWithMemoryDisabled=true;await save();
      }
      console.log('Anonymous null identity and explicit A/B memory isolation verified; cleaning owned resources.');
    }
  }
}catch(error){
  // A competing invocation owns this receipt until both exclusive locks exist.
  if(receipt&&locks.length===2){receipt.failure=summary(error);await save();}
  console.error('Anonymous qualification stopped: '+summary(error).code+(error.status?' (HTTP '+error.status+')':''));process.exitCode=1;
}finally{
  await browser?.close().catch(()=>{});if(server)await new Promise(done=>server.close(done));
  if(receipt&&key){
    try{await cleanup();await publishQualification();}
    catch(error){receipt.cleanupFailure=summary(error);await save();process.exitCode=1;console.error('Cleanup/qualification requires follow-up: '+receipt.cleanupFailure.code);}
    await report();
  }
  for(const entry of locks.reverse()){await entry.file.close();await unlink(entry.path);}
}
console.log(JSON.stringify({completed:receipt?.completed===true,profileRemoved:receipt?.cleanup?.profileAbsent===true,newEndUserIds:0,
  report:`research/cyberpunk/${reportName}`}));
