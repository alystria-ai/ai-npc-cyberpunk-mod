import {spawn} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {randomUUID,createHash} from 'node:crypto';
import {absoluteRuntimeOverride} from './runtime-paths.mjs';
import {abortable,cancelled,throwIfCancelled} from './transport-pool.mjs';
import {validatePhoneAnalysisConfig,verifyPhoneAnalysisAssets,PHONE_ANALYSIS_ENGINE,PHONE_ANALYSIS_FORMAT,
  PHONE_ANALYSIS_FRONTEND} from './phone-analysis-config.mjs';

export const PHONE_ANALYSIS_LIMITS=Object.freeze({startupMs:20000,commandMs:5000,exitMs:5000,
  maxPending:32,maxFrames:24000*120,maxPacketFrames:96000,maxLineBytes:1_000_000});
const object=value=>value&&typeof value==='object'&&!Array.isArray(value);
const sameOwner=(a,b)=>a?.requestId===b?.requestId&&a?.entity===b?.entity&&a?.generation===b?.generation;
const ownerFor=input=>{
  if(!input||!['requestId','entity'].every(key=>typeof input[key]==='string'&&input[key].length>0
      &&input[key].length<=128&&!/[\x00-\x1f\x7f]/.test(input[key]))||!Number.isSafeInteger(input.generation)
      ||input.generation<0||input.generation>2147483647)throw Error('Phone analysis requires an owned utterance');
  return Object.freeze({requestId:input.requestId,entity:input.entity,generation:input.generation});
};

// Optional local analysis has its own resident process. Failed preparation
// keeps speech available; no TTS worker, provider route or audio clock is owned
// here. Provider retirement remains reusable after confirmed physical EOF.
export class ResidentPhoneAnalysis {
  constructor(config={}, {configPath,spawnImpl=spawn,onState=()=>{},onLog=()=>{},
    verifyAssets=verifyPhoneAnalysisAssets,now=()=>performance.now()}={}){
    this.config=Object.keys(config).length?validatePhoneAnalysisConfig(config):null;
    this.configPath=absoluteRuntimeOverride(configPath,'Phone-analysis configuration path');
    if(this.config&&!this.configPath)throw Error('Phone analysis requires its explicit configuration path');
    Object.assign(this,{spawnImpl,onState,onLog,verifyAssets,now});
    this.pending=new Map();this.retiring=Promise.resolve();this.epoch=0;this.sequence=0;
    this.wanted=false;this.loaded=false;this.state=this.config?'stopped':'disabled';
  }
  publish(state=this.state,extra={}){
    this.state=state;
    try{Promise.resolve(this.onState({version:1,state,engine:PHONE_ANALYSIS_ENGINE,format:PHONE_ANALYSIS_FORMAT,
      resident:this.loaded,wanted:this.wanted,workerPid:this.child?.pid,device:'cpu',gpuVramBytes:0,
      updated:Date.now(),...extra})).catch(()=>{});}catch{}
  }
  setWanted(value){
    if(typeof value!=='boolean')throw Error('Invalid phone-analysis residency choice');
    this.wanted=value&&!this.closed;
    if(this.wanted)void this.start().catch(()=>{});else void this.retire().catch(()=>{});
  }
  start(){
    if(this.closed)return Promise.reject(cancelled('Phone analysis is closed'));
    if(!this.wanted||!this.config){this.publish(this.config?'stopped':'disabled');return Promise.resolve();}
    if(this.failure)return Promise.reject(this.failure);
    if(this.starting)return this.starting;
    if(this.loaded)return Promise.resolve();
    const epoch=++this.epoch;this.publish('loading');
    const starting=this.retiring.then(async()=>{
      await this.verifyAssets(this.config);
      const bytes=await readFile(this.configPath),raw=JSON.parse(bytes);
      if(JSON.stringify(validatePhoneAnalysisConfig(raw))!==JSON.stringify(this.config))throw Error('Phone-analysis configuration changed before startup');
      if(this.closed||!this.wanted||this.epoch!==epoch)throw cancelled('Phone-analysis preparation retired');
      this.configSha256=createHash('sha256').update(bytes).digest('hex');
      await this.launch(epoch);
    }).catch(error=>{
      if(this.epoch===epoch&&!this.closed&&this.wanted){this.failure=error;this.publish('unavailable');}
      throw error;
    });
    this.starting=starting;
    // A queued start can be cancelled while an older physical process exits.
    // Only that operation may release its slot; never clear a newer owner or
    // the retirement failure that must keep replacements blocked.
    starting.then(()=>{if(this.starting===starting&&!this.loaded)this.starting=null;},
      ()=>{if(this.starting===starting)this.starting=null;});
    starting.catch(()=>{});return starting;
  }
  launch(epoch){
    this.workerOwner=randomUUID().replaceAll('-','');this.sequence=0;
    const env={...process.env,PYTHONUTF8:'1',PYTHONDONTWRITEBYTECODE:'1',CUDA_VISIBLE_DEVICES:'-1',
      OMP_NUM_THREADS:'1',MKL_NUM_THREADS:'1',OPENBLAS_NUM_THREADS:'1',HF_HUB_OFFLINE:'1',TRANSFORMERS_OFFLINE:'1'};
    for(const key of ['HF_TOKEN','HUGGING_FACE_HUB_TOKEN','KAGGLE_API_TOKEN','CONVAI_API_KEY'])delete env[key];
    const child=this.child=this.spawnImpl(this.config.runtime.pythonExecutable,
      ['-B',this.config.runtime.workerPath,'--config',this.configPath,'--owner',this.workerOwner,'--parent-pid',String(process.pid)],
      {windowsHide:true,stdio:['pipe','pipe','pipe'],env});
    const ready=new Promise((done,fail)=>{this.readyDone=done;this.readyFail=fail;});ready.catch(()=>{});
    const timer=setTimeout(()=>this.fail(Error('Phone-analysis preparation timed out')),PHONE_ANALYSIS_LIMITS.startupMs);timer.unref?.();
    this.startTimer=timer;
    let buffer='';child.stdout.setEncoding('utf8');
    child.stdout.on('data',part=>{
      buffer+=part;if(Buffer.byteLength(buffer,'utf8')>PHONE_ANALYSIS_LIMITS.maxLineBytes)return this.fail(Error('Oversized phone-analysis response'));
      let index;
      while((index=buffer.indexOf('\n'))>=0){
        const line=buffer.slice(0,index);buffer=buffer.slice(index+1);
        try{this.receive(JSON.parse(line),epoch);}catch(error){this.fail(error);}
      }
    });
    child.stderr.on('data',bytes=>{try{this.onLog(bytes.toString('utf8').slice(0,2000));}catch{}});
    child.stdin.on('error',error=>this.fail(error));child.on('error',error=>this.fail(error));
    this.exited=new Promise((done,reject)=>{this.rejectExited=reject;child.once('close',code=>{
      clearTimeout(this.startTimer);clearTimeout(this.exitTimer);clearTimeout(this.confirmTimer);
      this.startTimer=this.exitTimer=this.confirmTimer=null;
      if(this.child===child)this.child=null;this.loaded=false;
      const error=this.failure||cancelled('Phone-analysis worker exited');this.readyFail?.(error);
      for(const job of this.pending.values()){clearTimeout(job.timer);job.fail(error);}this.pending.clear();
      this.active?.lost(error);this.active=null;
      if(this.epoch===epoch&&!this.closingProcess){this.failure||=error;this.publish('unavailable');}
      done({code});
    });});this.exited.catch(()=>{});
    return ready;
  }
  receive(frame,epoch){
    if(!object(frame)||frame.version!==1||frame.workerOwner!==this.workerOwner||frame.engine!==PHONE_ANALYSIS_ENGINE)
      throw Error('Phone-analysis process owner or engine changed');
    if(frame.type==='fatal')throw Error('Resident phone analysis is unavailable');
    if(frame.type==='ready'){
      if(this.loaded||frame.format!==PHONE_ANALYSIS_FORMAT||frame.configSha256!==this.configSha256
          ||frame.device!=='cpu'||frame.gpuVramBytes!==0||frame.defaultModelsDisabled!==true
          ||JSON.stringify(frame.runtime)!==JSON.stringify(this.config.runtime)
          ||JSON.stringify(frame.files)!==JSON.stringify(this.config.files)
          ||JSON.stringify(frame.scientific)!==JSON.stringify(this.config.scientific)
          ||!['importsMs','decoderInitMs'].every(name=>Number.isFinite(frame[name])&&frame[name]>=0)
          ||Object.entries(PHONE_ANALYSIS_FRONTEND).some(([key,value])=>!['confirmationPackets','stableTailSeconds'].includes(key)
            &&frame.frontend?.[key]!==value))throw Error('Phone-analysis worker did not attest its prepared assets');
      if(this.epoch!==epoch||this.closingProcess||!this.wanted)return;
      this.loaded=true;this.details=frame;clearTimeout(this.startTimer);this.startTimer=null;
      this.publish('ready',{importsMs:frame.importsMs,decoderInitMs:frame.decoderInitMs});this.readyDone();return;
    }
    const job=this.pending.get(frame.id);if(!job)throw Error('Unexpected phone-analysis response');
    if(frame.type==='error'){this.pending.delete(frame.id);clearTimeout(job.timer);job.fail(Error('Owned phone-analysis command failed'));return;}
    if(frame.type!==job.expected||(!sameOwner(frame.owner,job.owner)&&job.owner))throw Error('Phone-analysis utterance owner changed');
    if(job.packet){
      const packet=job.packet;
      if(frame.index!==packet.index||frame.receivedFrames!==packet.offsetFrames+packet.frames
          ||frame.audioEndSeconds!==frame.receivedFrames/24000||frame.pcmSha256!==packet.sha256
          ||!Number.isSafeInteger(frame.decodedFrames)||frame.decodedFrames<0
          ||frame.decodedFrames>Math.ceil(frame.receivedFrames/24000*100)+3||!Number.isFinite(frame.analysisMs)
          ||frame.analysisMs<0||!Array.isArray(frame.segments)||frame.segments.length>12000)
        throw Error('Phone-analysis packet identity or source clock changed');
    }
    this.pending.delete(frame.id);clearTimeout(job.timer);job.done(frame);
  }
  command(command,owner,extra={},packet){
    if(!this.loaded||!this.child||this.closingProcess)return Promise.reject(Error('Phone analysis is unavailable'));
    if(this.pending.size>=PHONE_ANALYSIS_LIMITS.maxPending)return Promise.reject(Error('Phone-analysis queue exceeded its bound'));
    const id=++this.sequence,expected={start:'started',packet:'phones',finish:'finished',cancel:'cancelled'}[command];
    return new Promise((done,fail)=>{
      const timer=setTimeout(()=>{this.pending.delete(id);fail(Error('Phone-analysis command timed out'));this.fail(Error('Phone-analysis command timed out'));},PHONE_ANALYSIS_LIMITS.commandMs);timer.unref?.();
      this.pending.set(id,{done,fail,timer,expected,owner,packet});
      this.child.stdin.write(JSON.stringify({version:1,workerOwner:this.workerOwner,id,command,owner,...extra})+'\n',error=>{if(error)this.fail(error);});
    });
  }
  async prepare({signal}={}){
    throwIfCancelled(signal);await abortable(this.start(),signal);throwIfCancelled(signal);
    return {ready:this.loaded&&!this.failure,engine:PHONE_ANALYSIS_ENGINE};
  }
  beginTurn(input,{signal,onPhones=()=>{},onError=()=>{}}={}){
    throwIfCancelled(signal);const owner=ownerFor(input);
    if(!this.loaded||this.failure||this.closingProcess||!this.wanted||this.active)return null;
    const turn=this.active=new PhoneAnalysisTurn(this,owner,{signal,onPhones,onError});return turn;
  }
  fail(error){
    this.failure||=error;this.loaded=false;this.readyFail?.(this.failure);this.active?.lost(this.failure);
    for(const job of this.pending.values()){clearTimeout(job.timer);job.fail(this.failure);}this.pending.clear();
    this.publish('unavailable');void this.retire({clearFailure:false}).catch(()=>{});
  }
  retire({clearFailure=true}={}){
    if(clearFailure)this.clearFailureOnExit=true;
    if(this.closingProcess)return this.retiring;
    const child=this.child;++this.epoch;this.loaded=false;this.starting=null;
    if(!child){if(clearFailure)this.failure=null;this.publish(this.config?'stopped':'disabled');return this.retiring;}
    this.closingProcess=true;this.active?.lost(cancelled('Phone-analysis preparation retired'));
    this.publish('releasing');
    // EOF is sent during startup too. The old process must physically exit
    // before rapid provider toggles can allocate a replacement.
    child.stdin.end();
    this.exitTimer=setTimeout(()=>{
      if(this.child!==child)return;child.kill();
      this.confirmTimer=setTimeout(()=>{
        if(this.child===child)this.rejectExited(Error('Could not confirm phone-analysis worker exit'));
      },2000);this.confirmTimer.unref?.();
    },PHONE_ANALYSIS_LIMITS.exitMs);this.exitTimer.unref?.();
    const exited=this.exited;
    this.retiring=this.retiring.then(()=>exited).then(()=>{
      this.closingProcess=false;this.active=null;
      if(clearFailure||this.clearFailureOnExit)this.failure=null;this.clearFailureOnExit=false;this.details=null;
      this.publish(this.closed?'stopped':this.config?'stopped':'disabled');
    });this.retiring.catch(()=>{});return this.retiring;
  }
  close(){this.closed=true;this.wanted=false;return this.retire();}
}

class PhoneAnalysisTurn {
  constructor(client,owner,{signal,onPhones,onError}){
    Object.assign(this,{client,owner,signal,onPhones,onError});this.frames=0;this.index=0;this.pending=new Set();
    this.abort=()=>{void this.close().catch(()=>{});};signal?.addEventListener('abort',this.abort,{once:true});
    this.ready=client.command('start',owner);this.ready.catch(error=>this.lost(error));
  }
  notify(callback,value){try{Promise.resolve(callback(value)).catch(error=>this.lost(error));}catch(error){this.lost(error);}}
  lost(error){
    if(this.failure||this.closed)return;this.failure=error;this.notifyError(error);
  }
  notifyError(error){try{Promise.resolve(this.onError(error)).catch(()=>{});}catch{}}
  push(packet){
    if(this.closed||this.failure||this.sealed)return;
    if(this.pending.size>=PHONE_ANALYSIS_LIMITS.maxPending){this.lost(Error('Phone-analysis turn queue exceeded its bound'));return;}
    if(packet.sampleRate!==24000||packet.channels!==1||packet.index!==this.index+1||packet.offsetFrames!==this.frames
        ||!Number.isSafeInteger(packet.frames)||packet.frames<1||packet.frames>PHONE_ANALYSIS_LIMITS.maxPacketFrames
        ||!(packet.pcm instanceof Float32Array)||packet.pcm.length!==packet.frames||!packet.pcm.every(Number.isFinite)
        ||this.frames+packet.frames>PHONE_ANALYSIS_LIMITS.maxFrames){this.lost(Error('Invalid owned phone-analysis PCM'));return;}
    // Own the analysis copy now; the caller/renderer retains its untouched PCM.
    const bytes=Buffer.from(Buffer.from(packet.pcm.buffer,packet.pcm.byteOffset,packet.pcm.byteLength));
    const expected={index:packet.index,offsetFrames:packet.offsetFrames,frames:packet.frames,
      sha256:createHash('sha256').update(bytes).digest('hex')};this.frames+=packet.frames;this.index++;
    const job=this.ready.then(()=>{
      if(this.closed||this.failure)return;
      return this.client.command('packet',this.owner,{index:expected.index,offsetFrames:expected.offsetFrames,
        frames:expected.frames,pcm:bytes.toString('base64')},expected);
    }).then(result=>{if(result&&!this.closed&&!this.failure)this.notify(this.onPhones,result);})
      .catch(error=>this.lost(error)).finally(()=>this.pending.delete(job));this.pending.add(job);
  }
  finish(){
    if(this.finished)return this.finished;this.sealed=true;
    this.finished=Promise.all([...this.pending]).then(async()=>{
      if(this.closed||this.failure)return;
      const result=await this.client.command('finish',this.owner);
      if(!this.closed&&!this.failure){this.finalAcked=true;this.notify(this.onPhones,{...result,receivedFrames:this.frames});}
    }).catch(error=>this.lost(error));return this.finished;
  }
  close(){
    if(this.closing)return this.closing;this.closed=true;this.signal?.removeEventListener('abort',this.abort);
    this.closing=(async()=>{
      await this.ready.catch(()=>{});await Promise.allSettled([...this.pending,this.finished]);
      if(!this.finalAcked&&this.client.loaded&&!this.client.closingProcess)
        await this.client.command('cancel',this.owner).catch(()=>{});
      if(this.client.active===this)this.client.active=null;
    })();return this.closing;
  }
}
