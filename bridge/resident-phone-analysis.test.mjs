import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {readFile,writeFile,mkdir,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,join,dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {ResidentPhoneAnalysis,PHONE_ANALYSIS_LIMITS} from './resident-phone-analysis.mjs';
import {PHONE_ANALYSIS_ENGINE,PHONE_ANALYSIS_FORMAT,PHONE_ANALYSIS_FRONTEND,
  validatePhoneAnalysisConfig,verifyPhoneAnalysisAssets} from './phone-analysis-config.mjs';
const tick=()=>new Promise(done=>setImmediate(done));
const until=async predicate=>{const deadline=performance.now()+1500;while(!predicate()){
  if(performance.now()>deadline)assert.fail('Owned phone-analysis fixture missed its gate');
  await new Promise(done=>setTimeout(done,5));
}};
const sha=value=>createHash('sha256').update(value).digest('hex');
const owner={requestId:'local-phone-turn',entity:'17ULL',generation:3};
const packet=(index=1,offsetFrames=0)=>({index,offsetFrames,frames:1920,sampleRate:24000,channels:1,
  pcm:new Float32Array(1920).fill(.1)});

async function fixture(t,{holdReady=false,holdExit=false,holdPackets=false,corruptPacket=false,failVerify=false}={}){
  const folder=await mkdtemp(join(resolve(tmpdir()),'cyberpunk-phone-analysis-'));
  assert.equal(dirname(folder),resolve(tmpdir()));
  t.after(()=>rm(folder,{recursive:true,force:true}));
  const runtime={pythonExecutable:join(folder,'python.exe'),workerPath:join(folder,'worker.py'),
    dependencyDirectory:join(folder,'dependencies'),acousticModelDirectory:join(folder,'acoustic'),phoneModelPath:join(folder,'phones.bin')};
  const descriptions=[['python',runtime.pythonExecutable],['worker',runtime.workerPath],['phone-model',runtime.phoneModelPath],
    ['dependency',join(runtime.dependencyDirectory,'pocketsphinx/_pocketsphinx.cp312-win_amd64.pyd')],
    ...['mdef','means','variances','transition_matrices','feat.params'].map(name=>['acoustic',join(runtime.acousticModelDirectory,name)])];
  const files=[];
  for(const [kind,path]of descriptions){await mkdir(resolve(path,'..'),{recursive:true});const bytes=Buffer.from(kind+path);
    await writeFile(path,bytes);files.push({kind,path,sha256:sha(bytes),bytes:bytes.length});}
  const config={version:1,engine:PHONE_ANALYSIS_ENGINE,format:PHONE_ANALYSIS_FORMAT,runtime,
    dependency:{name:'pocketsphinx',version:'5.0.4'},scientific:{numpy:'2.0.0',scipy:'1.0.0'},files};
  const configPath=join(folder,'config.json');await writeFile(configPath,JSON.stringify(config));
  const children=[],states=[];let verifies=0;
  const client=new ResidentPhoneAnalysis(config,{configPath,onState:value=>states.push(value),
    verifyAssets:async value=>{verifies++;if(failVerify)throw Error('qualification failed');return verifyPhoneAnalysisAssets(value);},
    spawnImpl(executable,args,options){
      const child=new EventEmitter();child.pid=9000+children.length;child.stdout=new PassThrough();child.stderr=new PassThrough();
      child.commands=[];child.owner=args[args.indexOf('--owner')+1];child.args=args;child.options=options;child.executable=executable;
      child.send=value=>child.stdout.write(JSON.stringify({version:1,workerOwner:child.owner,engine:PHONE_ANALYSIS_ENGINE,...value})+'\n');
      child.releaseReady=()=>child.send({type:'ready',format:PHONE_ANALYSIS_FORMAT,
        configSha256:sha(Buffer.from(JSON.stringify(config))),device:'cpu',gpuVramBytes:0,defaultModelsDisabled:true,
        runtime:config.runtime,files:config.files,scientific:config.scientific,frontend:PHONE_ANALYSIS_FRONTEND,importsMs:10,decoderInitMs:20});
      child.releaseExit=()=>{child.exitCode=0;child.emit('close',0);};child.kill=()=>{child.releaseExit();return true;};
      child.stdin=new PassThrough();let buffer='';
      child.stdin.on('data',bytes=>{buffer+=bytes.toString();let at;
        while((at=buffer.indexOf('\n'))>=0){const command=JSON.parse(buffer.slice(0,at));buffer=buffer.slice(at+1);child.commands.push(command);
          if(command.command==='packet'){
            if(holdPackets)continue;
            child.send({id:command.id,type:'phones',owner:command.owner,index:command.index,
              receivedFrames:command.offsetFrames+command.frames,audioEndSeconds:(command.offsetFrames+command.frames)/24000,
              pcmSha256:corruptPacket?'0'.repeat(64):sha(Buffer.from(command.pcm,'base64')),decodedFrames:3,analysisMs:1,
              segments:[{phone:'SIL',startFrame:0,endFrame:2}]});
          }else child.send({id:command.id,type:{start:'started',cancel:'cancelled',finish:'finished'}[command.command],owner:command.owner,
            ...(command.command==='finish'?{duration:.08,segments:[]}: {})});
        }});
      child.stdin.on('finish',()=>{child.eof=true;if(!holdExit)queueMicrotask(child.releaseExit);});
      children.push(child);if(!holdReady)queueMicrotask(child.releaseReady);return child;
    }});
  t.after(()=>client.close());
  return{client,config,configPath,children,states,verifies:()=>verifies,folder};
}

test('explicit hashed native assets qualify; relative, escaped, changed and duplicated manifests fail closed',async t=>{
  const h=await fixture(t);await verifyPhoneAnalysisAssets(h.config);
  for(const changed of [{...h.config,runtime:{...h.config.runtime,pythonExecutable:'python'}},
    {...h.config,files:[...h.config.files,h.config.files[0]]},
    {...h.config,files:h.config.files.map(file=>file.kind==='dependency'?{...file,path:join(h.folder,'outside.pyd')}:file)},
    {...h.config,dependency:{name:'pocketsphinx',version:'latest'}}])assert.throws(()=>validatePhoneAnalysisConfig(changed));
  await writeFile(h.config.files[0].path,'changed');await assert.rejects(verifyPhoneAnalysisAssets(h.config),/identity/);
});

test('warm attestation owns one hidden CPU-only analyser and copies original float packet bytes',async t=>{
  const h=await fixture(t);h.client.setWanted(true);await h.client.start();await h.client.start();
  assert.equal(h.children.length,1);const child=h.children[0];assert.equal(child.options.windowsHide,true);
  assert.equal(child.options.env.CUDA_VISIBLE_DEVICES,'-1');assert.equal(child.options.env.HF_TOKEN,undefined);
  const seen=[],errors=[],turn=h.client.beginTurn(owner,{onPhones:frame=>seen.push(frame),onError:error=>errors.push(error)});
  assert.ok(turn);assert.equal(h.client.beginTurn({...owner,entity:'another'}),null);
  const source=packet(),before=source.pcm.slice();turn.push(source);source.pcm.fill(.9);
  await tick();await tick();assert.equal(seen.length,1);assert.equal(errors.length,0);
  const command=child.commands.find(value=>value.command==='packet');
  assert.deepEqual(Buffer.from(command.pcm,'base64'),Buffer.from(before.buffer));
  assert.equal(seen[0].receivedFrames,1920);await turn.finish();await turn.close();assert.equal(h.client.active,null);
  h.client.setWanted(false);await h.client.retiring;assert.equal(child.eof,true);assert.equal(h.client.child,null);
});

test('rapid provider changes during preparation wait for confirmed EOF before replacement',async t=>{
  const h=await fixture(t,{holdReady:true,holdExit:true});h.client.setWanted(true);await until(()=>h.children.length===1);
  assert.equal(h.children.length,1);const first=h.children[0];
  h.client.setWanted(false);h.client.setWanted(true);await tick();assert.equal(first.eof,true);assert.equal(h.children.length,1);
  first.releaseReady();await tick();assert.equal(h.client.loaded,false);
  first.releaseExit();await until(()=>h.children.length===2);assert.equal(h.children.length,2);
  const second=h.children[1];second.releaseReady();await h.client.start();assert.equal(h.client.loaded,true);
  const closing=h.client.close();await tick();second.releaseExit();await closing;assert.equal(h.client.child,null);
});

test('a queued On→Off cancellation after retirement cannot strand the singleton on the next On',async t=>{
  const h=await fixture(t,{holdExit:true});h.client.setWanted(true);await h.client.start();const first=h.children[0];
  h.client.setWanted(false);h.client.setWanted(true);const queued=h.client.start();h.client.setWanted(false);
  first.releaseExit();await assert.rejects(queued,/preparation retired/);
  assert.equal(h.client.starting,null);assert.equal(h.children.length,1);
  h.client.setWanted(true);await until(()=>h.children.length===2);await h.client.start();assert.equal(h.client.loaded,true);
  const closing=h.client.close();await tick();h.children[1].releaseExit();await closing;
});

test('bad packet provenance removes phonetic availability and rejects pending work without retiring audio',async t=>{
  const h=await fixture(t,{corruptPacket:true});h.client.setWanted(true);await h.client.start();
  const errors=[],turn=h.client.beginTurn(owner,{onError:error=>errors.push(error)});turn.push(packet());
  await tick();await tick();assert.equal(errors.length,1);assert.equal(h.client.loaded,false);await turn.close();
  assert.equal(h.client.pending.size,0);assert.equal(h.children[0].eof,true);
});

test('cancel and bounded backlog cannot donate an owned decoder or buffers to another utterance',async t=>{
  const h=await fixture(t,{holdPackets:true});h.client.setWanted(true);await h.client.start();
  const controller=new AbortController(),errors=[];
  const turn=h.client.beginTurn(owner,{signal:controller.signal,onError:error=>errors.push(error)});
  for(let index=0;index<PHONE_ANALYSIS_LIMITS.maxPending+1;index++)turn.push(packet(index+1,index*1920));
  assert.equal(errors.length,1);assert.ok(turn.pending.size<=PHONE_ANALYSIS_LIMITS.maxPending);
  controller.abort();h.client.setWanted(false);await h.client.retiring;await turn.close();
  assert.equal(h.client.active,null);assert.equal(h.client.pending.size,0);
});

test('unavailable preparation is cached until retirement and never begins a reply-time worker',async t=>{
  const h=await fixture(t,{failVerify:true});h.client.setWanted(true);
  await assert.rejects(h.client.prepare(),/qualification/);await assert.rejects(h.client.start(),/qualification/);
  assert.equal(h.verifies(),1);assert.equal(h.children.length,0);assert.equal(h.client.beginTurn(owner),null);
  const controller=new AbortController();controller.abort();await assert.rejects(h.client.prepare({signal:controller.signal}),{name:'AbortError'});
});
