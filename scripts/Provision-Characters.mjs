import {readFile, writeFile, rename, mkdir, open, unlink} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const runtime=resolve(root,'runtime');
const args=process.argv.slice(2),apply=args.includes('--apply');
const onlyIndex=args.indexOf('--only');
const only=onlyIndex<0?null:new Set(args[onlyIndex+1].split(','));
const read=async path=>JSON.parse((await readFile(path,'utf8')).replace(/^\uFEFF/,''));
const atomic=async(path,value)=>{await writeFile(path+'.tmp',JSON.stringify(value,null,2)+'\n');await rename(path+'.tmp',path);};
const roster=await read(resolve(root,'characters/roster.json'));
const selected=roster.filter(p=>!only||only.has(p.key));
if(only&&selected.length!==only.size)throw Error('Unknown profile in --only selection.');
if(!apply){console.log(JSON.stringify({mode:'plan',count:selected.length,characters:selected.map(p=>({key:p.key,name:p.name,words:p.backstory.split(/\s+/).length,voice:p.voiceName,model:p.model}))},null,2));process.exit(0);}
const keyPath=process.env.CYBERPUNK_CONVAI_KEY_FILE||resolve(runtime,'convai-key.txt');
const key=/^api-key\s*=\s*(\S+)\s*$/i.exec((await readFile(keyPath,'utf8')).trim())?.[1];
if(!key)throw Error('Local key file must contain api-key=...');
await mkdir(runtime,{recursive:true});
let lock;
try{lock=await open(resolve(runtime,'character-provision.lock'),'wx');}
catch{throw Error('Another profile provision may be running. Inspect runtime/character-provision.lock before retrying.');}
await lock.writeFile(String(process.pid));
const mappingPath=resolve(runtime,'characters.json'),verifiedPath=resolve(runtime,'characters-verified.json');
const mapping=await read(mappingPath).catch(()=>({}));
const verified=await read(verifiedPath).catch(()=>({}));
const batch=resolve(runtime,'profile-enrichment',new Date().toISOString().replace(/[:.]/g,'-'));
await mkdir(batch,{recursive:true});
await atomic(resolve(batch,'mapping-before.json'),mapping);
const report={started:new Date().toISOString(),profiles:[],completed:false};
let lastRequest=0;
const delay=ms=>new Promise(done=>setTimeout(done,ms));
async function api(endpoint,body,canRetry=true){
  for(let attempt=0;attempt<5;attempt++){
    await delay(Math.max(0,1100-(Date.now()-lastRequest)));lastRequest=Date.now();
    let response;
    try{response=await fetch('https://api.convai.com'+endpoint,{method:'POST',headers:{'CONVAI-API-KEY':key,'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(45000)});}
    catch{if(!canRetry||attempt===4)throw Error(endpoint+' transport failed');await delay(2000*(attempt+1));continue;}
    let data;try{data=await response.json();if(typeof data==='string')data=JSON.parse(data);}catch{throw Error(endpoint+' returned invalid JSON');}
    const rejected=['ERROR','API_ERROR','INTERNAL_ERROR'].find(k=>data?.[k]);
    if(response.status===429||String(rejected&&data[rejected]).toLowerCase().includes('request limit')){
      if(attempt===4)throw Error(endpoint+' rate limit persisted');
      console.log('Core API rate limit: waiting before retry.');await delay(30000);continue;
    }
    if(!response.ok||rejected){
      if(canRetry&&response.status>=500&&attempt<4){await delay(3000*(attempt+1));continue;}
      await atomic(resolve(runtime,'profile-provision-error.json'),{endpoint,status:response.status,response:JSON.parse(JSON.stringify(data).split(key).join('[redacted]'))});
      throw Error(endpoint+' rejected request (HTTP '+response.status+')');
    }
    return data;
  }
}
const marker=p=>`[CyberpunkConvai profile v2:${p.key}]`;
// Core API labels reject punctuation such as the hyphen in Chang-Hoon.
// The roster, prompt identity and in-game display retain the canonical name.
const apiName=p=>p.name.replace(/[^\p{L}\p{N} ]/gu,' ').replace(/\s+/g,' ').trim();
const verify=(p,id,actual)=>{
  if(actual.character_id!==id||actual.character_name!==apiName(p)||actual.voice_type!==p.voice||actual.backstory!==p.backstory)throw Error('Profile readback mismatch: '+p.key);
};
try{
  const cloud=await api('/character/list',{});
  const owned=new Map(cloud.characters.map(p=>[p.character_id,p]));
  for(const profile of selected){
    if(!profile.voice.startsWith('convai-kokoro-')||!profile.backstory||!profile.model)throw Error('Incomplete profile: '+profile.key);
    const hash=createHash('sha256').update(JSON.stringify({name:profile.name,backstory:profile.backstory,voice:profile.voice,model:profile.model})).digest('hex');
    let id=mapping[profile.key],before;
    if(id&&!owned.has(id))throw Error('Mapped profile is not in the account: '+profile.key);
    // Recover a prior create interrupted before the local ID mapping was saved.
    // Matching by name alone is insufficient to take ownership of a character.
    if(!id){
      const possible=cloud.characters.filter(p=>p.character_name===profile.name||p.character_name===apiName(profile));
      for(const candidate of possible){
        const detail=await api('/character/get',{charID:candidate.character_id});
        if(detail.backstory?.includes(marker(profile))){if(id)throw Error('Multiple owned profile markers: '+profile.key);id=candidate.character_id;before=detail;}
      }
      if(id){mapping[profile.key]=id;await atomic(mappingPath,mapping);}
    }
    const payload={charName:apiName(profile),voiceType:profile.voice,backstory:profile.backstory,model_group_name:profile.model};
    let created=false;
    if(!id){
      // Never automatically repeat an ambiguous creation: a subsequent run
      // discovers its ownership marker before attempting another create.
      const result=await api('/character/create',payload,false);
      if(typeof result.charID!=='string'||!result.charID)throw Error('No character ID returned for '+profile.key);
      id=result.charID;mapping[profile.key]=id;await atomic(mappingPath,mapping);created=true;
    }else{
      before??=await api('/character/get',{charID:id});
      await atomic(resolve(batch,profile.key+'-before.json'),before);
      const model=owned.get(id)?.personalised_prompt_config?.MODEL;
      if(before.backstory!==profile.backstory||before.voice_type!==profile.voice||before.character_name!==apiName(profile)||model!==profile.model){
        const result=await api('/character/update',{charID:id,...payload});
        if(result.STATUS!=='SUCCESS')throw Error('Profile update did not confirm success: '+profile.key);
      }
    }
    const actual=await api('/character/get',{charID:id});
    verify(profile,id,actual);
    await atomic(resolve(batch,profile.key+'-verified.json'),actual);
    verified[profile.key]=hash;await atomic(verifiedPath,verified);
    report.profiles.push({key:profile.key,id,created,backstoryVerified:true,voiceVerified:true,modelVerified:false,words:profile.backstory.split(/\s+/).length,memoryEnabled:actual.memory_settings?.enabled===true});
    await atomic(resolve(runtime,'profile-enrichment-report.json'),report);
    console.log('Verified '+profile.name+': description and Kokoro voice ('+profile.backstory.split(/\s+/).length+' words).');
  }
  const final=await api('/character/list',{});
  for(const item of report.profiles){
    const expected=selected.find(p=>p.key===item.key),actual=final.characters.find(p=>p.character_id===item.id);
    item.model=actual?.personalised_prompt_config?.MODEL;
    item.modelVerified=item.model===expected.model;
    if(!item.modelVerified)throw Error('Model readback mismatch: '+item.key);
  }
  report.completed=true;report.finished=new Date().toISOString();
  await atomic(resolve(runtime,'profile-enrichment-report.json'),report);
  await atomic(resolve(batch,'report.json'),report);
  console.log('Verified '+report.profiles.length+' profiles, including the reference LLM model.');
}catch(error){
  report.error=error.message;await atomic(resolve(runtime,'profile-enrichment-report.json'),report);
  throw error;
}finally{await lock.close();await unlink(resolve(runtime,'character-provision.lock'));}
