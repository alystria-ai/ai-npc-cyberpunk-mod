import {normaliseSpeechEnvelope, SPEECH_TRACKS} from './facial-timeline.mjs';
import {PHONETIC_ARTICULATION, phoneticPose} from './phonetic-poses.mjs';
import {validateMouthCues} from './mouth-cues.mjs';
import {ConfirmedPhoneTimeline} from './phone-poses.mjs';
import {PHONE_ANALYSIS_ENGINE,PHONE_ANALYSIS_FORMAT,PHONE_ANALYSIS_FRONTEND} from './phone-analysis-config.mjs';
import {throwIfCancelled} from './transport-pool.mjs';
import {JALI_TIMELINE_TRACKS, JALI_SOURCE, JALI_ARTICULATION, JALI_LEAD_SECONDS, jaliPose, jaliUpperRow} from './jali-face.mjs';

const RATE = 24000, MAX_FRAMES = RATE * 120, ENERGY_FRAMES = RATE / 30;
const zero = () => SPEECH_TRACKS.map(() => 0);
const clamp = value => Math.max(0,Math.min(1,value));
const rounded = value => Math.round(value*10000)/10000;

// An analysis container only. These copied float samples are never returned
// to playback: the renderer receives the original Pocket PCM independently.
export function pocketAnalysisWav(pcm) {
  if (!(pcm instanceof Float32Array) || pcm.length < RATE * .05 || pcm.length > MAX_FRAMES || !pcm.every(Number.isFinite))
    throw Error('Invalid Pocket facial audio window');
  const bytes = Buffer.alloc(44 + pcm.length * 4);
  bytes.write('RIFF',0); bytes.writeUInt32LE(bytes.length-8,4); bytes.write('WAVEfmt ',8);
  bytes.writeUInt32LE(16,16); bytes.writeUInt16LE(3,20); bytes.writeUInt16LE(1,22);
  bytes.writeUInt32LE(RATE,24); bytes.writeUInt32LE(RATE*4,28); bytes.writeUInt16LE(4,32); bytes.writeUInt16LE(32,34);
  bytes.write('data',36); bytes.writeUInt32LE(pcm.length*4,40);
  pcm.forEach((value,index)=>bytes.writeFloatLE(value,44+index*4));
  return bytes.toString('base64');
}

// Same native phonetic mapping as local WAV replies, on one audio-seconds
// clock. An injected analyser runs beside playback; PCM admission never awaits analysis.
// Only the part of a result that is still ahead of the device cursor can be
// admitted. Completed work is not evidence of phonetic coverage at playback.
export class PocketFacialStream {
  constructor({input, lipsync, phoneAnalysis, jaliFace, signal, expressionSignal, text, textComplete = true, onAnalysis = () => {}}) {
    if (typeof input?.requestId !== 'string' || typeof input.entity !== 'string' || !Number.isSafeInteger(input.generation))
      throw Error('Pocket facial stream needs an owned utterance');
    Object.assign(this,{input,lipsync,signal,expressionSignal,onAnalysis});
    this.controller = new AbortController(); this.cancel = () => this.close();
    signal?.addEventListener('abort',this.cancel,{once:true});
    this.pcm = new Float32Array(MAX_FRAMES); this.frames = 0; this.packet = 0;
    this.energies = []; this.energySquares = 0; this.energySamples = 0;
    this.intervals = []; this.pending = new Set(); this.analysisCursor = 0; this.analysisIndex = 0;
    this.revision = 0; this.publicationRevision = 0; this.audiblePosition = 0; this.complete = false;
    if(jaliFace){
      // Game-trained model on a worker thread: it follows the same copied PCM
      // and supersedes the phone paths. Failure leaves the envelope.
      try{
        // The whole reply text is known before the first packet: the text path aligns it as the PCM streams.
        this.model=jaliFace.begin(RATE,typeof text==='string'?{text,textComplete}:{});this.lipsync=undefined;phoneAnalysis=undefined;
        this.model.onUpdate=()=>{if(this.closed)return;this.revision++;this.cached=this.geometry=null;};
      }catch{this.model=null;}
    }
    if(phoneAnalysis!==undefined){
      // A ready resident helper is a side channel. Reply onset never starts or
      // waits for a recognizer, and unavailable analysis stays envelope-only.
      this.lipsync=undefined;this.phoneTimeline=new ConfirmedPhoneTimeline(input);
      try{this.phoneSession=phoneAnalysis?.beginTurn(input,{signal,onPhones:result=>{
        if(this.closed)return;
        const receipt=this.phoneTimeline.accept(result,this.audiblePosition,this.frames);
        this.intervals=this.phoneTimeline.intervals();this.recognition=this.phoneTimeline.recognition();
        this.revision++;this.cached=this.geometry=null;this.measure(receipt);
      },onError:()=>{
        if(this.closed)return;this.phoneTimeline.clear();this.intervals=[];this.recognition=undefined;
        this.revision++;this.cached=this.geometry=null;this.measure({type:'phones',status:'envelope-fallback'});
      }});}catch{this.phoneSession=null;}
    }
    if (signal?.aborted) this.close();
  }
  // A reply voiced while it is still being written (bridge/reply-stream.mjs): the text grows from its first sentence to the whole
  // reply, and `complete` says it is final. Only the text-aligned face model uses the words.
  setText(text,complete=true){if(!this.closed)this.model?.setText?.(text,complete);}
  assertActive() { throwIfCancelled(this.signal); throwIfCancelled(this.controller.signal); }
  measure(event) {
    try { Promise.resolve(this.onAnalysis(event)).catch(()=>{}); }
    catch { /* Diagnostics cannot interrupt voice. */ }
  }
  push(packet) {
    this.assertActive();
    if (this.complete || packet.sampleRate !== RATE || packet.channels !== 1 || packet.offsetFrames !== this.frames
        || packet.index !== this.packet+1 || !(packet.pcm instanceof Float32Array) || packet.frames !== packet.pcm.length
        || !packet.frames || this.frames+packet.frames>MAX_FRAMES || !packet.pcm.every(Number.isFinite))
      throw Error('Pocket facial PCM is out of order');
    this.pcm.set(packet.pcm,this.frames); this.frames += packet.frames; this.packet++;
    // Fixed audio-clock bins carry across all decoder packets, including short
    // final pieces. Match whole-WAV RMS clamping without modifying source PCM.
    for(const sample of packet.pcm) {
      const value=Math.max(-1,Math.min(1,sample));this.energySquares+=value*value;this.energySamples++;
      if(this.energySamples===ENERGY_FRAMES) {
        this.energies.push(Math.sqrt(this.energySquares/ENERGY_FRAMES));
        this.energySquares=0;this.energySamples=0;
      }
    }
    this.revision++;this.cached=null;this.geometry=null;
    this.model?.push(packet.pcm);this.phoneSession?.push(packet);this.schedule();
  }
  schedule() {
    if(this.closed || !this.lipsync || this.pending.size) return;
    // One job, no analyser backlog. If playback overtakes a window, skip those
    // samples and spend CPU on the still-unheard prefix. Left context helps a
    // fresh window recognize its first sound; context is never re-admitted.
    const first=Math.max(this.analysisCursor,Math.ceil(this.audiblePosition*RATE)),remaining=this.frames-first;
    // Recognition needs context, not 800 ms entirely ahead of playback. With
    // near-real-time generation that requirement starved analysis until late
    // in a line. Permit 400 ms of already-heard acoustic context, while still
    // qualifying only unheard output. Very short future tails remain fallback.
    const contextFirst=Math.max(0,first-Math.round(RATE*.4));
    if(remaining<(this.complete?RATE*.05:RATE*.12)
        || (!this.complete && this.frames-contextFirst<RATE*.8)) return;
    const count=Math.min(this.analysisIndex?RATE*1.6:RATE*.8,remaining);
    const start=first/RATE,end=(first+count)/RATE,analysisStart=contextFirst/RATE;
    const window=this.pcm.slice(contextFirst,first+count),duration=window.length/RATE;
    this.analysisCursor=first+count;const index=++this.analysisIndex,began=performance.now();
    const controller=new AbortController(),cancel=()=>controller.abort();
    this.controller.signal.addEventListener('abort',cancel,{once:true});
    const state={index,start,end,analysisStart,controller,obsolete:false};this.analysisJob=state;
    const receipt={type:'analysis',index,startSeconds:start,endSeconds:end,analysisStartSeconds:analysisStart,
      receivedSecondsAtStart:this.frames/RATE,audiblePositionSecondsAtStart:this.audiblePosition};
    const job=Promise.resolve().then(()=>this.lipsync.analyse(pocketAnalysisWav(window),{signal:controller.signal})).then(result=>{
      if(this.closed || this.controller.signal.aborted) return;
      const usableStart=Math.max(start,this.audiblePosition),usableSeconds=Math.max(0,end-usableStart);
      let status='late-discarded';
      if(!controller.signal.aborted && usableSeconds>1/RATE) {
        let cues;
        if(result?.mouthCuesFormat==='rhubarb-phonetic-v1')try {
          cues=validateMouthCues({metadata:{duration},mouthCues:result.mouthCues},duration);
        }catch { /* Invalid recognition falls back, not voice playback. */ }
        if(cues) {
          this.intervals.push({index,start:usableStart,end,analysisStart,cues,
            easeIn:usableStart>start+1e-7});
          this.revision++;this.cached=null;this.geometry=null;status='qualified';
        }else status='invalid-fallback';
      }
      this.measure({...receipt,lipEngine:result?.timing?.lipEngine,lipAnalysisMs:performance.now()-began,status,
        receivedSecondsAtFinish:this.frames/RATE,audiblePositionSecondsAtFinish:this.audiblePosition,
        usableStartSeconds:Math.min(end,usableStart),usableSeconds:status==='qualified'?usableSeconds:0});
    }).catch(()=>{
      if(!this.closed)this.measure({...receipt,lipAnalysisMs:performance.now()-began,
        status:state.obsolete?'late-discarded':'analysis-failed',usableSeconds:0,
        receivedSecondsAtFinish:this.frames/RATE,audiblePositionSecondsAtFinish:this.audiblePosition});
    }).finally(()=>{
      this.controller.signal.removeEventListener('abort',cancel);controller.abort();this.pending.delete(job);
      if(this.analysisJob===state)this.analysisJob=null;
      this.schedule();
    });
    this.pending.add(job);
  }
  finish() {
    this.assertActive(); this.complete=true;this.model?.finish();this.phoneSession?.finish();this.schedule();
    this.revision++;this.cached=null;this.geometry=null;
  }
  envelope(receivedFrames,sourceComplete) {
    const count=Math.floor(receivedFrames/ENERGY_FRAMES),energies=this.energies.slice(0,count);
    if(receivedFrames%ENERGY_FRAMES) {
      let squares=0;
      for(let at=count*ENERGY_FRAMES;at<receivedFrames;at++) {
        const value=Math.max(-1,Math.min(1,this.pcm[at]));squares+=value*value;
      }
      energies.push(Math.sqrt(squares/(receivedFrames-count*ENERGY_FRAMES)));
    }
    return normaliseSpeechEnvelope(energies,{first:true,last:sourceComplete});
  }
  snapshot(receivedFrames=this.frames, sourceComplete=this.complete, audiblePositionSeconds=0) {
    if (this.closed || !receivedFrames) return undefined;
    if (!Number.isSafeInteger(receivedFrames) || receivedFrames<0 || receivedFrames>this.frames
        || typeof sourceComplete!=='boolean' || (sourceComplete&&(!this.complete||receivedFrames!==this.frames)))
      throw Error('Pocket facial prefix exceeds accepted source samples');
    const duration=receivedFrames/RATE;
    if(!Number.isFinite(audiblePositionSeconds) || audiblePositionSeconds<0 || audiblePositionSeconds>duration+.025
        || audiblePositionSeconds+1/RATE<this.audiblePosition)throw Error('Invalid Pocket facial audible cursor');
    this.audiblePosition=Math.max(this.audiblePosition,Math.min(duration,audiblePositionSeconds));
    if(this.analysisJob && this.analysisJob.end<=this.audiblePosition+1/RATE) {
      this.analysisJob.obsolete=true;this.analysisJob.controller.abort();
    }
    this.schedule();
    if(this.model)return this.jaliSnapshot(receivedFrames,sourceComplete);
    const geometryKey=`${this.revision}:${receivedFrames}:${sourceComplete}`;
    const key=`${geometryKey}:${this.audiblePosition}`;
    if (this.cached?.key===key) return this.cached.face;
    const intervals=this.intervals.filter(interval=>interval.start<duration);
    let frames=this.geometry?.key===geometryKey?this.geometry.frames:undefined;
    if(!frames) {
      const envelope=this.envelope(receivedFrames,sourceComplete);frames=[];let intervalIndex=0;
      const pose=seconds=>{
        const energyAt=sourceComplete?seconds:Math.min(seconds,Math.max(0,duration-1/RATE));
        const energyFrame=energyAt*30,energyIndex=Math.floor(energyFrame),mix=energyFrame-energyIndex;
        const level=(envelope[energyIndex]||0)*(1-mix)
          +(envelope[energyIndex+1]??(sourceComplete?0:envelope[energyIndex]||0))*mix;
        const fallback=zero();fallback[0]=.35*level;fallback[1]=.12*level;fallback[2]=.16*level;
        while(intervalIndex+1<intervals.length && intervals[intervalIndex].end<=seconds)intervalIndex++;
        const interval=intervals[intervalIndex];let values=fallback;
        if(interval && seconds>=interval.start && seconds<interval.end) {
          const phonetic=phoneticPose(interval.cues,seconds-interval.analysisStart,level,SPEECH_TRACKS);
          const blend=interval.easeIn?clamp((seconds-interval.start)/.04):1;
          values=phonetic.map((value,index)=>fallback[index]+(value-fallback[index])*blend);
        }
        const edge=clamp(Math.min(seconds/.04,sourceComplete?(duration-seconds)/.04:1));
        return values.map(value=>rounded(value*edge));
      };
      for(let index=0;index/60<duration;index++)frames.push([index/60,...pose(index/60)]);
      frames.push([duration,...pose(duration)]);this.geometry={key:geometryKey,frames};
    }
    const phonetic=intervals.some(interval=>this.audiblePosition>=interval.start
      && this.audiblePosition<Math.min(duration,interval.end));
    const coverage={version:1,audiblePositionSeconds:this.audiblePosition,
      phoneticIntervals:intervals.map(interval=>[interval.start,Math.min(duration,interval.end)]),
      receivedSeconds:duration,pendingAnalyses:this.pending.size};
    const face={version:1,requestId:this.input.requestId,entity:this.input.entity,generation:this.input.generation,
      continuous:true,complete:sourceComplete,duration,revision:++this.publicationRevision,tracks:[...SPEECH_TRACKS],frames,
      motion:'local-phonetic-smooth-v1',
      source:phonetic?'local-phonetic':'audio-envelope',...(phonetic?{articulation:PHONETIC_ARTICULATION}:{}),coverage,
      ...(this.recognition?{recognition:this.recognition}:{})};
    this.cached={key,face};return face;
  }
  // Model-driven prefix: native controls from the game-trained model where its
  // rows cover the audio, otherwise the shared envelope fallback. The first
  // covered position is fixed once heard audio reaches it and blends in over
  // 60 ms, so a late model start never snaps an already-moving mouth.
  jaliSnapshot(receivedFrames,sourceComplete) {
    const duration=receivedFrames/RATE,frames=this.model.frames,failed=Boolean(this.model.failed);
    const covered=Math.min(duration,frames.coveredSeconds());
    if(this.modelStart===undefined&&covered>this.audiblePosition+JALI_LEAD_SECONDS){
      this.modelStart=this.audiblePosition;
      this.measure({type:'model',engine:JALI_ARTICULATION,startSeconds:this.modelStart,coveredSeconds:covered,receivedSeconds:duration});
    }
    const start=this.modelStart??Infinity;
    const geometryKey=`jali:${this.revision}:${receivedFrames}:${sourceComplete}:${start}`;
    const key=`${geometryKey}:${this.audiblePosition}`;
    if(this.cached?.key===key)return this.cached.face;
    let rows=this.geometry?.key===geometryKey?this.geometry.frames:undefined;
    let upper=this.geometry?.key===geometryKey?this.geometry.upper:undefined;
    if(!rows){upper=frames.upper?[]:undefined;
      const envelope=this.envelope(receivedFrames,sourceComplete),apartUp=JALI_TIMELINE_TRACKS.indexOf('lips_apart_up');
      const pose=seconds=>{
        const energyAt=sourceComplete?seconds:Math.min(seconds,Math.max(0,duration-1/RATE));
        const energyFrame=energyAt*30,energyIndex=Math.floor(energyFrame),mix=energyFrame-energyIndex;
        const level=(envelope[energyIndex]||0)*(1-mix)
          +(envelope[energyIndex+1]??(sourceComplete?0:envelope[energyIndex]||0))*mix;
        const fallback=JALI_TIMELINE_TRACKS.map(()=>0);
        fallback[0]=.35*level;fallback[apartUp]=.12*level;fallback[apartUp+1]=.16*level;
        let values=fallback;const ahead=Math.min(duration,seconds+JALI_LEAD_SECONDS);
        const modelled=seconds>=start&&(ahead<=covered||(frames.finished&&!failed));
        if(upper)upper.push(jaliUpperRow(frames,seconds,ahead,modelled));
        if(modelled){
          const blend=clamp((seconds-start)/.06),model=jaliPose(frames,ahead);
          values=model.map((value,index)=>fallback[index]+(value-fallback[index])*blend);
        }
        const edge=clamp(Math.min(seconds/.04,sourceComplete?(duration-seconds)/.04:1));
        return values.map(value=>rounded(value*edge));
      };
      rows=[];for(let index=0;index/60<duration;index++)rows.push([index/60,...pose(index/60)]);
      rows.push([duration,...pose(duration)]);this.geometry={key:geometryKey,frames:rows,upper};
    }
    const modelled=this.audiblePosition>=start&&this.audiblePosition<Math.max(start,covered);
    const coverage={version:1,audiblePositionSeconds:this.audiblePosition,
      phoneticIntervals:Number.isFinite(start)&&covered>start?[[start,covered]]:[],
      receivedSeconds:duration,pendingAnalyses:0};
    const face={version:1,requestId:this.input.requestId,entity:this.input.entity,generation:this.input.generation,
      continuous:true,complete:sourceComplete,duration,revision:++this.publicationRevision,tracks:[...JALI_TIMELINE_TRACKS],
      frames:rows,source:modelled?JALI_SOURCE:'audio-envelope',...(modelled?{articulation:JALI_ARTICULATION}:{}),coverage,
      ...(upper?.length===rows.length?{modelExpressions:{version:1,format:'jali-upper-v1',frames:upper}}:{})};
    this.cached={key,face};return face;
  }
  close() {
    if (this.closed) return this.closing; this.closed=true;this.controller.abort();this.signal?.removeEventListener('abort',this.cancel);
    this.model?.close();
    this.closing=Promise.resolve(this.phoneSession?.close()).catch(()=>{});
    this.pcm=null;this.energies=[];this.intervals=[];this.cached=null;this.geometry=null;
    this.phoneTimeline?.clear();return this.closing;
  }
}

function ownedJaliFace(snapshot, owner, face) {
  if (face.version!==1 || face.requestId!==owner.requestId || face.entity!==owner.entity || face.generation!==owner.generation
      || face.continuous!==true || face.complete!==snapshot.sourceComplete || !Number.isFinite(face.duration)
      || Math.abs(face.duration-snapshot.duration)>1/24000 || face.motion!==undefined
      || !['audio-envelope',JALI_SOURCE].includes(face.source)
      || (face.source===JALI_SOURCE)!==(face.articulation===JALI_ARTICULATION)
      || !Array.isArray(face.tracks) || face.tracks.length!==JALI_TIMELINE_TRACKS.length
      || face.tracks.some((name,index)=>name!==JALI_TIMELINE_TRACKS[index])
      || !Array.isArray(face.frames) || !face.frames.length || face.frames.length>7202)
    throw Error('Pocket facial timeline owner or source clock changed');
  const coverage=face.coverage;
  if(!coverage || coverage.version!==1 || !Number.isFinite(coverage.audiblePositionSeconds)
      || coverage.audiblePositionSeconds<0 || coverage.audiblePositionSeconds>face.duration
      || (snapshot.positionSeconds!==undefined && Math.abs(coverage.audiblePositionSeconds-snapshot.positionSeconds)>.025+1e-7)
      || !Array.isArray(coverage.phoneticIntervals) || coverage.phoneticIntervals.length>1)
    throw Error('Pocket facial coverage clock changed');
  const [interval]=coverage.phoneticIntervals;
  if(interval&&(!Array.isArray(interval)||interval.length!==2||!interval.every(Number.isFinite)||interval[0]<0
      ||interval[1]<=interval[0]||interval[1]>face.duration+1e-7))throw Error('Invalid Pocket model interval');
  const modelled=Boolean(interval)&&coverage.audiblePositionSeconds>=interval[0]&&coverage.audiblePositionSeconds<interval[1];
  if((face.source===JALI_SOURCE)!==modelled)throw Error('Pocket facial source is not covered at the audible cursor');
  let previous=-1;
  for(const frame of face.frames) {
    if (!Array.isArray(frame) || frame.length!==JALI_TIMELINE_TRACKS.length+1 || !frame.every(Number.isFinite)
        || frame[0]<0 || frame[0]<=previous || frame[0]>face.duration+1e-7)
      throw Error('Invalid Pocket facial timeline');
    previous=frame[0];
  }
  return face;
}

export function ownedPocketFace(snapshot, owner) {
  const face=snapshot?.face;
  if (!face) return undefined;
  if (face.motion===undefined && face.tracks?.length===JALI_TIMELINE_TRACKS.length) return ownedJaliFace(snapshot, owner, face);
  if (face.version!==1 || face.requestId!==owner.requestId || face.entity!==owner.entity || face.generation!==owner.generation
      || face.continuous!==true || face.complete!==snapshot.sourceComplete || !Number.isFinite(face.duration)
      || face.motion!=='local-phonetic-smooth-v1'
      || !['audio-envelope','local-phonetic'].includes(face.source)
      || (face.source==='local-phonetic'&&face.articulation!==PHONETIC_ARTICULATION)
      || (face.source==='audio-envelope'&&face.articulation!==undefined)
      || Math.abs(face.duration-snapshot.duration)>1/24000 || !Array.isArray(face.tracks)
      || face.tracks.length!==SPEECH_TRACKS.length || face.tracks.some((name,index)=>name!==SPEECH_TRACKS[index])
      || !Array.isArray(face.frames) || !face.frames.length || face.frames.length>7202)
    throw Error('Pocket facial timeline owner or source clock changed');
  const coverage=face.coverage;
  if(!coverage || coverage.version!==1 || !Number.isFinite(coverage.audiblePositionSeconds)
      || coverage.audiblePositionSeconds<0 || coverage.audiblePositionSeconds>face.duration
      || !Number.isFinite(coverage.receivedSeconds) || Math.abs(coverage.receivedSeconds-face.duration)>1/24000
      || (snapshot.positionSeconds!==undefined && Math.abs(coverage.audiblePositionSeconds-snapshot.positionSeconds)>.025+1e-7)
      || !Number.isInteger(coverage.pendingAnalyses) || coverage.pendingAnalyses<0 || coverage.pendingAnalyses>1
      || !Array.isArray(coverage.phoneticIntervals) || coverage.phoneticIntervals.length>2400)
    throw Error('Pocket facial coverage clock changed');
  let end=0;
  for(const interval of coverage.phoneticIntervals) {
    if(!Array.isArray(interval) || interval.length!==2 || !interval.every(Number.isFinite)
        || interval[0]<end || interval[0]<0 || interval[1]<=interval[0] || interval[1]>face.duration+1e-7)
      throw Error('Invalid Pocket phonetic interval');
    end=interval[1];
  }
  const phonetic=coverage.phoneticIntervals.some(([start,end])=>coverage.audiblePositionSeconds>=start
    && coverage.audiblePositionSeconds<end);
  if((face.source==='local-phonetic')!==phonetic)throw Error('Pocket facial source is not covered at the audible cursor');
  if(face.recognition!==undefined){
    const recognition=face.recognition;
    if(!recognition||recognition.version!==1||recognition.format!==PHONE_ANALYSIS_FORMAT
        ||recognition.engine!==PHONE_ANALYSIS_ENGINE||recognition.timebase!=='original-audio-seconds'
        ||Object.entries(PHONE_ANALYSIS_FRONTEND).some(([key,value])=>recognition[key]!==value))
      throw Error('Pocket acoustic source format changed');
  }
  let previous=-1;
  for(const frame of face.frames) {
    if (!Array.isArray(frame) || frame.length!==SPEECH_TRACKS.length+1 || !frame.every(Number.isFinite)
        || frame[0]<0 || frame[0]<=previous || frame[0]>face.duration+1e-7)
      throw Error('Invalid Pocket facial timeline');
    previous=frame[0];
  }
  return face;
}
