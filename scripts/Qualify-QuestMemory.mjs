// One disposable, explicitly owned profile at a time. Never imports live IDs.
// Default is a plan; --run performs the bounded qualification and cleanup.
import {readFile,mkdir,open,rename,unlink} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID,createHash} from 'node:crypto';
import {chromium} from 'playwright';
import {build} from 'esbuild';
import {createServer} from 'node:http';
import {ConvaiMemoryAdapter,normalizeMemoryText} from '../bridge/convai-memory.mjs';
import {characterPayload,verifyCharacter} from './character-payload.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const output=resolve(root,'runtime','memory-qualification');
const receiptPath=resolve(output,'receipt.json');
const reportPath=resolve(root,'research','cyberpunk','MEMORY_QUALIFICATION.md');
const args=new Set(process.argv.slice(2));
if([...args].some(arg=>!['--run','--cleanup-only','--new-run'].includes(arg)))throw Error('Use --run or --cleanup-only.');
if(args.has('--new-run')&&!args.has('--run'))throw Error('--new-run requires --run.');
const hash=value=>createHash('sha256').update(String(value)).digest('hex').slice(0,16);
const parse=raw=>JSON.parse(raw.replace(/^\uFEFF/,''));
const roster=parse(await readFile(resolve(root,'characters','roster.json'),'utf8'));
const reference=roster.find(row=>row.key==='judy-alvarez')??roster[0];
if(!args.has('--run')&&!args.has('--cleanup-only')){
  console.log(JSON.stringify({mode:'plan',temporaryProfiles:1,model:reference.model,
    existingProfilesModified:0,checks:['memory enable readback','A/B add/list/get isolation','owned-profile cleanup'],
    runsConversations:false,receipt:'runtime/memory-qualification/receipt.json'}));
  process.exit(0);
}
await mkdir(output,{recursive:true});
let receipt;
try{receipt=parse(await readFile(receiptPath,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
let previousRuns=[];
if(args.has('--new-run')){
  previousRuns=receipt?.previousRuns??(receipt?.previousRun?[receipt.previousRun]:[]);
  if(!receipt?.cleanup?.profileAbsent||previousRuns.length>=4)throw Error('A corrected run requires a cleaned prior probe; five total attempts is the limit.');
  previousRuns=[...previousRuns,{runId:receipt.runId,profileRemoved:true,checks:receipt.checks,failure:receipt.failure}];
  const archived=await open(resolve(output,'receipt-'+receipt.runId+'.json'),'wx');
  try{await archived.writeFile(JSON.stringify(receipt,null,2)+'\n');await archived.sync();}finally{await archived.close();}
  receipt=undefined;
}
if(receipt?.cleanup?.profileAbsent===true){
  console.log('Prior disposable profile cleanup verified; qualification '+(receipt.completed?'passed':'is incomplete')+'. No new profile created.');process.exit(0);
}
if(args.has('--cleanup-only')&&!receipt){console.log('No qualification receipt exists; nothing to clean.');process.exit(0);}
let lock;
try{lock=await open(resolve(output,'qualification.lock'),'wx');}catch{throw Error('Qualification lock exists; inspect its owner before another run.');}
await lock.writeFile(String(process.pid));await lock.sync();
const save=async()=>{
  const temp=receiptPath+'.tmp-'+randomUUID(),file=await open(temp,'wx');
  try{await file.writeFile(JSON.stringify(receipt,null,2)+'\n');await file.sync();}finally{await file.close();}
  await rename(temp,receiptPath);
};
const failure=(code,status)=>Object.assign(new Error(code),{code,status});
const summary=error=>({code:typeof error?.code==='string'?error.code:'LOCAL_'+String(error?.name??'Error').replace(/[^A-Za-z]/g,''),
  ...(Number.isInteger(error?.status)?{status:error.status}:{})});
let key,adapter,probeBrowser,probePage,probeServer,lastRequest=0;
async function diagnostic(response,endpoint){
  // Keep only a small redacted error message, never headers, requests, tokens
  // or arbitrary provider payloads. This is evidence, not API instructions.
  const reader=response.clone().body?.getReader();if(!reader)return;
  const chunks=[];let size=0;
  try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>4096){void reader.cancel().catch(()=>{});return;}chunks.push(value);}}
  finally{reader.releaseLock();}
  let data;try{data=JSON.parse(Buffer.concat(chunks,size).toString('utf8'));}catch{return;}
  const raw=data?.ERROR??data?.detail??data?.error??data?.message;
  let message=typeof raw==='string'?raw:'Structured provider error (message omitted)';
  for(const secret of [key,receipt?.characterId,receipt?.users?.A,receipt?.users?.B].filter(Boolean))message=message.split(secret).join('[redacted]');
  message=message.replace(/[a-f0-9]{8}-[a-f0-9-]{27,}/gi,'[redacted-id]').replace(/\b[a-f0-9]{28,}\b/gi,'[redacted-token]')
    .replace(/[\u0000-\u001f]/g,' ').slice(0,320);
  receipt.httpErrors??=[];if(receipt.httpErrors.length<20)receipt.httpErrors.push({endpoint,status:response.status,message});
  await save();
}
async function probeFetch(url,options){
  const response=await fetch(url,options);
  if(!response.ok)await diagnostic(response,new URL(url).pathname);
  return response;
}
async function registerUser(user){
  receipt.registration??={};
  if(receipt.registration[user]?.closed)return;
  if(receipt.registration[user]?.dispatched)throw failure('REGISTER_UNCERTAIN_NO_RETRY');
  receipt.registration[user]={dispatched:true};await save();
  // Use the exact installed Convai SDK over the mod's proven LiveKit path.
  // No user message, microphone, context update or model trigger is sent.
  const connected=await probePage.evaluate(config=>window.memoryProbe.register(config),
    {apiKey:key,characterId:receipt.characterId,endUserId:receipt.users[user]});
  if(connected.error)throw failure(connected.error);
  if(connected.endUserId!==receipt.users[user])throw failure('CONNECT_IDENTITY_MISMATCH');
  receipt.registration[user]={dispatched:true,identityEchoVerified:true,transport:'livekit',closed:connected.closed===true};await save();
}
async function startProbe(){
  const bundled=await build({stdin:{resolveDir:root,contents:`
    import {ConvaiClient} from '@convai/web-sdk/vanilla';
    window.memoryProbe={register:async(config)=>{
      const client=new ConvaiClient({...config,transport:'livekit',characterSessionId:'-1',
        startWithAudioOn:false,enableVideo:false,enableLipsync:false,ttsEnabled:false,logRtviMessages:false});
      let timer,result;
      try{
        await Promise.race([client.connect(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('REGISTER_TIMEOUT')),30000);})]);
        result={endUserId:client.state.endUserId};
      }catch{result={error:'REGISTER_SDK_FAILED'};}
      finally{clearTimeout(timer);try{await client.disconnect();result.closed=true;}catch{result.closed=false;}}
      return result;
    }};`},bundle:true,write:false,format:'iife',platform:'browser',logLevel:'silent'});
  const source=bundled.outputFiles[0].text;
  probeServer=createServer((request,response)=>{
    if(request.headers.host!==`127.0.0.1:${probeServer.address()?.port}`){response.writeHead(403).end();return;}
    response.setHeader('Cache-Control','no-store');
    if(request.url==='/probe.js'){response.setHeader('Content-Type','text/javascript');response.end(source);}
    else if(request.url==='/'){response.setHeader('Content-Type','text/html');response.end('<!doctype html><script src="/probe.js"></script>');}
    else response.writeHead(404).end();
  });
  await new Promise((done,reject)=>{probeServer.once('error',reject);probeServer.listen(0,'127.0.0.1',done);});
  probeBrowser=await chromium.launch({channel:'msedge',headless:true,args:['--autoplay-policy=no-user-gesture-required']});
  probePage=await probeBrowser.newPage();await probePage.goto(`http://127.0.0.1:${probeServer.address().port}`);
  await probePage.waitForFunction(()=>typeof window.memoryProbe?.register==='function');
}
async function core(endpoint,body){
  if(!['/character/create','/character/get','/character/update','/character/list','/character/delete'].includes(endpoint))throw failure('INVALID_ENDPOINT');
  // Space provider operations without retrying ambiguous mutations.
  await new Promise(done=>setTimeout(done,Math.max(0,1100-(Date.now()-lastRequest))));lastRequest=Date.now();
  let response;
  try{response=await fetch('https://api.convai.com'+endpoint,{method:'POST',headers:{'Content-Type':'application/json','CONVAI-API-KEY':key},
    body:JSON.stringify(body),signal:AbortSignal.timeout(30000)});}catch{throw failure('CORE_TRANSPORT_UNCERTAIN');}
  if(!response.ok){await response.body?.cancel().catch(()=>{});throw failure('CORE_HTTP_ERROR',response.status);}
  const reader=response.body.getReader(),chunks=[];let size=0;
  try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>4*1024*1024)throw failure('CORE_RESPONSE_TOO_LARGE');chunks.push(value);}}
  finally{reader.releaseLock();}
  let data;try{data=JSON.parse(Buffer.concat(chunks,size).toString('utf8'));if(typeof data==='string')data=JSON.parse(data);}catch{throw failure('CORE_INVALID_JSON');}
  if(!data||typeof data!=='object'||['ERROR','API_ERROR','INTERNAL_ERROR'].some(field=>data[field]))throw failure('CORE_API_REJECTED');
  return data;
}
const idOk=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,255}$/.test(value);
async function owned(){
  if(!idOk(receipt.characterId))throw failure('NO_OWNED_CHARACTER_ID');
  const detail=await core('/character/get',{charID:receipt.characterId});
  if(detail.character_id!==receipt.characterId||detail.character_name!==receipt.payload.charName
    ||typeof detail.backstory!=='string'||!detail.backstory.includes(receipt.marker))throw failure('OWNERSHIP_MISMATCH');
  return detail;
}
async function discoverInterruptedCreate(){
  const list=await core('/character/list',{});if(!Array.isArray(list.characters))throw failure('CORE_INVALID_LIST');
  const found=[];
  for(const row of list.characters.filter(row=>row.character_name===receipt.payload.charName)){
    const detail=await core('/character/get',{charID:row.character_id});
    if(detail.backstory?.includes(receipt.marker))found.push(row.character_id);
  }
  if(found.length!==1)throw failure(found.length?'AMBIGUOUS_OWNED_PROFILE':'CREATE_UNRESOLVED_NO_RETRY');
  receipt.characterId=found[0];receipt.createRecovered=true;await save();
}
async function list(user){return adapter.list({characterId:receipt.characterId,endUserId:receipt.users[user],page:1,pageSize:100});}
async function add(user){
  if(receipt.add[user]?.records)return receipt.add[user].records;
  if(receipt.add[user]?.dispatched){
    const existing=await list(user);
    const exact=existing.memories.filter(row=>normalizeMemoryText(row.memory)===normalizeMemoryText(receipt.facts[user]));
    if(!exact.length)throw failure('AMBIGUOUS_ADD_NOT_RETRIED');
    receipt.add[user]={...receipt.add[user],records:exact,reconciled:true};await save();return exact;
  }
  receipt.add[user]={dispatched:true};await save();
  const response=await adapter.add({characterId:receipt.characterId,endUserId:receipt.users[user],memories:[receipt.facts[user]]});
  receipt.add[user].records=response.memories;await save();return response.memories;
}
async function crossGetDenied(user,memoryId){
  try{await adapter.get({characterId:receipt.characterId,endUserId:receipt.users[user],memoryId});}
  catch(error){if(error.code==='HTTP_ERROR'&&[403,404].includes(error.status))return {denied:true,status:error.status};throw error;}
  throw failure('CROSS_USER_GET_EXPOSED');
}
async function cleanup(){
  if(!receipt.characterId&&receipt.createDispatched)await discoverInterruptedCreate();
  if(!receipt.characterId)return;
  receipt.cleanup??={};
  const discovered=await core('/character/list',{});
  if(!Array.isArray(discovered.characters))throw failure('CORE_INVALID_LIST');
  if(!discovered.characters.some(row=>row.character_id===receipt.characterId)){
    receipt.cleanup.profileAbsent=true;await save();return;
  }
  await owned();
  for(const user of ['A','B']){
    try{
      const scan=await adapter.scan({characterId:receipt.characterId,endUserId:receipt.users[user],maxPages:2});
      if(!scan.complete)throw failure('CLEANUP_SCAN_INCOMPLETE');
      for(const row of scan.memories){
        await adapter.delete({characterId:receipt.characterId,endUserId:receipt.users[user],memoryId:row.id});
      }
      const after=await list(user);receipt.cleanup[user]={recordsEmpty:after.total_count===0};
    }catch(error){receipt.cleanup[user]={failure:summary(error)};}
    await save();
  }
  // Fresh ownership readback precedes deletion. An interrupted delete is
  // reconciled by the next list rather than blindly repeated.
  const before=await core('/character/list',{});
  if(!before.characters?.some(row=>row.character_id===receipt.characterId)){
    receipt.cleanup.profileAbsent=true;await save();return;
  }
  if(receipt.cleanup.profileDeleteDispatched)throw failure('PROFILE_DELETE_UNCERTAIN_NO_RETRY');
  await owned();receipt.cleanup.profileDeleteDispatched=true;await save();
  await core('/character/delete',{charID:receipt.characterId});
  const after=await core('/character/list',{});
  receipt.cleanup.profileAbsent=Array.isArray(after.characters)&&!after.characters.some(row=>row.character_id===receipt.characterId);
  if(!receipt.cleanup.profileAbsent)throw failure('PROFILE_DELETE_NOT_CONFIRMED');
  await save();
}
async function report(){
  const checks=receipt.checks??{};
  const rows=Object.entries(checks).map(([name,value])=>`| ${name} | ${typeof value==='object'?JSON.stringify(value):String(value)} |`).join('\n');
  const text=`# Convai memory API qualification\n\nRun: ${receipt.started}\n\n`+
    `- Profile: one disposable mod-owned test character (receipt hash \`${hash(receipt.characterId??receipt.runId)}\`).\n`+
    `- Selected model: \`${receipt.model}\`; production character IDs modified: **0**.\n`+
    `- No user message, microphone audio or model-generation request submitted. Synthetic facts only; two newly generated end-user UUIDs.\n`+
    `- Result: **${receipt.completed?'explicit REST qualification passed':'incomplete'}**.\n`+
    `- Disposable profile removal verified: **${receipt.cleanup?.profileAbsent===true?'yes':'no'}**.\n\n`+
    `- Individual memory records removed and lists empty before profile deletion: A **${receipt.cleanup?.A?.recordsEmpty===true?'yes':'unverified'}**, B **${receipt.cleanup?.B?.recordsEmpty===true?'yes':'unverified'}**.\n\n`+
    `| Check | Observed result |\n| --- | --- |\n${rows}\n\n`+
    ((receipt.previousRuns??(receipt.previousRun?[receipt.previousRun]:[])).length?'Earlier setup probes: '+JSON.stringify((receipt.previousRuns??[receipt.previousRun]).map(row=>({removed:row.profileRemoved,failure:row.failure})))+'. Every earlier disposable profile was removed before the next run.\n\n':'')+
    (receipt.httpErrors?.length?'Redacted provider diagnostics: `'+JSON.stringify(receipt.httpErrors)+'`.\n\n':'')+
    (receipt.failure?`Failure: \`${receipt.failure.code}\`${receipt.failure.status?` (HTTP ${receipt.failure.status})`:''}.\n\n`:'')+
    (receipt.cleanupFailure?`Cleanup limitation: \`${receipt.cleanupFailure.code}\`. Recovery receipt remains in ignored runtime storage.\n\n`:'')+
    `## What this proves\n\n${receipt.completed?'The recorded results qualify character memory configuration readback and explicit add/list/get ownership for the tested account and model configuration.':'Only the successful checks in the table are established; explicit add/list/get ownership qualification remains incomplete.'} They do not prove automatic conversation extraction, cancellation exclusion, dynamic-context extraction behavior, save restoration, or realtime conversational recall. No production memory setting was enabled by this script.\n\n`+
    `## Exact supported wire\n\nCharacter enable uses POST \`/character/update\` with \`{charID,memorySettings:{enabled:true}}\`; readback uses POST \`/character/get\` and \`memory_settings.enabled\`. The write/read casing difference is deliberate. Memory operations use JSON POST \`/memory/add|list|get|delete\` with \`character_id\` and \`end_user_id\`.\n\n`+
    `[Official Unreal memory implementation](https://github.com/Conv-AI/Convai-UnrealEngine-SDK-V4/blob/98575b10a0b85facd570ed29decb5a65a8b3b49b/Source/Convai/Private/RestAPI/ConvaiLTMProxy.cpp), [Web SDK memory guide](https://docs.convai.com/api-docs/plugins-and-integrations/web-plugins/convai-web-sdk/long-term-memory), [character API](https://docs.convai.com/api-docs/api-reference/core-api-reference/character-crafting-apis/character-api). Installed Web SDK 1.7.0 \`dist/core/MemoryManager.js\` provides the exact memory endpoint bodies.\n\n`+
    `## Reproducibility and recovery\n\n\`node scripts/Qualify-QuestMemory.mjs\` previews the plan. \`--run\` executes or resumes one owned test; the durable receipt prevents accidental duplicate profiles. \`--cleanup-only\` resumes exact receipt-based cleanup. An explicitly authorized \`--new-run --run\` archives a verified-cleaned prior receipt before a corrected probe; at most five attempts are permitted and only one profile may remain alive. An ambiguous create or add is never blindly repeated. The hidden browser and official SDK bundle are preflighted before remote profile creation. Keys, raw remote IDs and responses remain out of this report; the detailed recovery receipt is ignored under \`runtime/memory-qualification/\`. Modern end-user account deletion has no verified wire endpoint here; temporary user records may remain after their character-specific memories and test character are removed.\n`;
  await mkdir(dirname(reportPath),{recursive:true});
  const file=await open(reportPath,'w');try{await file.writeFile(text);}finally{await file.close();}
}
try{
  const raw=(await readFile(process.env.CYBERPUNK_CONVAI_KEY_FILE??resolve(root,'runtime','convai-key.txt'),'utf8')).trim();
  key=/^api-key\s*=\s*(\S+)\s*$/i.exec(raw)?.[1];if(!key)throw failure('KEY_FILE_FORMAT');
  adapter=new ConvaiMemoryAdapter({key,enabled:true,timeoutMs:30000,fetchImpl:probeFetch});
  if(!args.has('--cleanup-only'))await startProbe();
  if(!receipt){
    const runId=randomUUID(),marker=`[CyberpunkConvai disposable memory qualification:${runId}]`;
    receipt={version:1,runId,started:new Date().toISOString(),model:reference.model,marker,...(previousRuns.length?{previousRuns}:{}),
      payload:characterPayload({key:'disposable-memory-test',name:'Cyberpunk Memory Qualification '+runId.replace(/-/g,'').slice(0,12),
        voice:reference.voice,model:reference.model,
        backstory:'A temporary synthetic verification character for scoped memory API testing. No game lore or real personal information. '+marker,
        speakingStyleDescription:'Brief factual answers. This disposable profile is for API verification.',
        speakingStyleSampleDialogues:'Visitor: What is this?\nVerifier: A temporary memory isolation test.'}),
      users:{A:randomUUID(),B:randomUUID()},
      facts:{A:'The user named a fictional pet Tinwhistle and chose amber as its color.',
        B:'The user named a fictional pet Mooncopper and chose indigo as its color.'},add:{},checks:{},completed:false};
    await save();
  }
  if(!args.has('--cleanup-only')){
    if(!receipt.characterId){
      if(receipt.createDispatched)await discoverInterruptedCreate();
      else{
        receipt.createDispatched=true;await save();
        const created=await core('/character/create',receipt.payload);
        if(!idOk(created.charID))throw failure('CREATE_ID_MISSING');
        receipt.characterId=created.charID;await save();
      }
    }
    const before=await owned();verifyCharacter(receipt.characterId,before,receipt.payload,'disposable-memory-test');
    receipt.checks.separateProfileFields=true;receipt.checks.memoryInitiallyEnabled=before.memory_settings?.enabled===true;await save();
    if(before.memory_settings?.enabled!==true){
      if(receipt.enableDispatched)throw failure('ENABLE_UNCERTAIN_NO_RETRY');
      receipt.enableDispatched=true;await save();
      await core('/character/update',{charID:receipt.characterId,memorySettings:{enabled:true}});
    }
    const enabled=await owned();
    if(enabled.memory_settings?.enabled!==true)throw failure('MEMORY_ENABLE_NOT_CONFIRMED');
    verifyCharacter(receipt.characterId,enabled,receipt.payload,'disposable-memory-test');
    receipt.checks.memoryEnabledReadback=true;await save();
    const models=await core('/character/list',{});
    const model=models.characters?.find(row=>row.character_id===receipt.characterId)?.personalised_prompt_config?.MODEL;
    if(model!==receipt.model)throw failure('MODEL_READBACK_MISMATCH');
    receipt.checks.modelReadback=model;await save();
    console.log('Disposable profile and character memory setting verified.');
    await registerUser('A');await registerUser('B');
    receipt.checks.registeredUsersViaConnect=true;await save();
    if(!receipt.add.A){
      const emptyA=await list('A'),emptyB=await list('B');
      if(emptyA.total_count!==0||emptyB.total_count!==0)throw failure('FRESH_USER_NOT_EMPTY');
      receipt.checks.newUsersEmpty=true;await save();
    }
    const addedA=await add('A'),afterA=await list('A');
    if(!addedA.every(row=>afterA.memories.some(got=>got.id===row.id)))throw failure('A_ADD_LIST_MISMATCH');
    for(const row of addedA)await adapter.get({characterId:receipt.characterId,endUserId:receipt.users.A,memoryId:row.id});
    if(!receipt.add.B&&((await list('B')).total_count!==0))throw failure('A_MEMORY_EXPOSED_TO_B');
    receipt.checks.userAAddListGet=true;receipt.checks.crossUserGetB=await crossGetDenied('B',addedA[0].id);await save();
    const addedB=await add('B'),afterB=await list('B'),finalA=await list('A');
    if(!addedB.every(row=>afterB.memories.some(got=>got.id===row.id)))throw failure('B_ADD_LIST_MISMATCH');
    if(finalA.memories.some(a=>afterB.memories.some(b=>a.id===b.id)))throw failure('MEMORY_IDS_SHARED_ACROSS_USERS');
    for(const row of addedB)await adapter.get({characterId:receipt.characterId,endUserId:receipt.users.B,memoryId:row.id});
    receipt.checks.userBAddListGet=true;receipt.checks.crossUserGetA=await crossGetDenied('A',addedB[0].id);
    receipt.checks.distinctUserLists=true;receipt.completed=true;receipt.finished=new Date().toISOString();await save();
    console.log('A/B explicit memory isolation verified; cleaning disposable records and profile.');
  }
}catch(error){
  if(receipt){receipt.failure=summary(error);await save();}
  console.error('Qualification stopped: '+summary(error).code+(error.status?' (HTTP '+error.status+')':''));process.exitCode=1;
}finally{
  await probeBrowser?.close().catch(()=>{});
  probeServer?.close();
  if(receipt&&key){
    try{await cleanup();}catch(error){receipt.cleanupFailure=summary(error);await save();process.exitCode=1;console.error('Cleanup requires follow-up: '+receipt.cleanupFailure.code);}
    await report();
  }
  await lock.close();await unlink(resolve(output,'qualification.lock'));
}
console.log(JSON.stringify({completed:receipt?.completed===true,profileRemoved:receipt?.cleanup?.profileAbsent===true,
  report:'research/cyberpunk/MEMORY_QUALIFICATION.md'}));
