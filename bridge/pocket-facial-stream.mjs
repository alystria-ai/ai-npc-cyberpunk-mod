import {buildFacialTimeline, SPEECH_TRACKS} from './facial-timeline.mjs';
import {PHONETIC_ARTICULATION} from './phonetic-poses.mjs';
import {throwIfCancelled} from './transport-pool.mjs';

const RATE = 24000, MAX_FRAMES = RATE * 120;
const zero = () => SPEECH_TRACKS.map(() => 0);

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
// clock. Rhubarb runs beside playback; PCM admission never awaits analysis.
export class PocketFacialStream {
  constructor({input, lipsync, signal, expressionSignal, onAnalysis = () => {}}) {
    if (typeof input?.requestId !== 'string' || typeof input.entity !== 'string' || !Number.isSafeInteger(input.generation))
      throw Error('Pocket facial stream needs an owned utterance');
    Object.assign(this,{input,lipsync,signal,expressionSignal,onAnalysis});
    this.controller = new AbortController(); this.cancel = () => this.close();
    signal?.addEventListener('abort',this.cancel,{once:true});
    this.pcm = new Float32Array(MAX_FRAMES); this.frames = 0; this.packet = 0;
    this.anchors = []; this.pending = new Set(); this.analysisCursor = 0; this.analysisIndex = 0;
    this.revision = 0; this.phonetic = false; this.complete = false;
    if (signal?.aborted) this.close();
  }
  assertActive() { throwIfCancelled(this.signal); throwIfCancelled(this.controller.signal); }
  segment(index,start,last=false) {
    // This is an analysis-window marker, not a native file-slot index. Pocket
    // can yield more than 128 packets in a long continuous utterance.
    return {version:1,index:start===0?1:Math.max(2,Math.min(128,index)),startSeconds:start,first:start===0,last};
  }
  line(pcm,index,start,last=false,extra={}) {
    return buildFacialTimeline({audio:pocketAnalysisWav(pcm),speechSegment:this.segment(index,start,last),
      expressionSignal:this.expressionSignal,...extra},this.input);
  }
  merge(line,start,end) {
    if (!line || this.closed) return;
    this.anchors = this.anchors.filter(frame=>frame[0]<start-1e-7 || frame[0]>end+1e-7);
    this.anchors.push(...line.frames.map(frame=>[start+frame[0],...frame.slice(1)]));
    this.anchors.sort((a,b)=>a[0]-b[0]); this.revision++; this.cached = null;
  }
  push(packet) {
    this.assertActive();
    if (this.complete || packet.sampleRate !== RATE || packet.channels !== 1 || packet.offsetFrames !== this.frames
        || packet.index !== this.packet+1 || !(packet.pcm instanceof Float32Array) || packet.frames !== packet.pcm.length
        || !packet.frames || this.frames+packet.frames>MAX_FRAMES || !packet.pcm.every(Number.isFinite))
      throw Error('Pocket facial PCM is out of order');
    const start = this.frames/RATE; this.pcm.set(packet.pcm,this.frames); this.frames += packet.frames; this.packet++;
    // Real Pocket decoder chunks are 80 ms. Ignore only a shorter final piece
    // here; it remains in the source PCM and is included in final analysis.
    if (packet.frames>=RATE*.05) this.merge(this.line(packet.pcm,packet.index,start),start,this.frames/RATE);
    this.schedule(false);
  }
  schedule(final) {
    for (;;) {
      const size = Math.round((this.analysisIndex ? 1.6 : .8)*RATE), remaining = this.frames-this.analysisCursor;
      if (remaining<size && !final) return;
      if (remaining<RATE*.05) return;
      const count = Math.min(size,remaining), first=this.analysisCursor, start=first/RATE, end=(first+count)/RATE;
      const window=this.pcm.slice(first,first+count); this.analysisCursor += count; this.analysisIndex++;
      if (!this.lipsync || this.pending.size>=8) continue; // bounded explicit envelope fallback
      const index=this.analysisIndex, audio=pocketAnalysisWav(window), began=performance.now();
      const job=Promise.resolve().then(()=>this.lipsync.analyse(audio,{signal:this.controller.signal})).then(result=>{
        if (this.closed || this.controller.signal.aborted) return;
        const line=this.line(window,index,start,final&&end===this.frames/RATE,result);
        if (line?.source==='local-phonetic') { this.phonetic=true;this.merge(line,start,end); }
        this.onAnalysis({lipEngine:result.timing?.lipEngine,lipAnalysisMs:performance.now()-began,startSeconds:start,endSeconds:end});
      }).catch(()=>{}).finally(()=>this.pending.delete(job));
      this.pending.add(job);
    }
  }
  finish() {
    this.assertActive(); this.complete=true; this.schedule(true); this.revision++; this.cached=null;
  }
  snapshot(receivedFrames=this.frames, sourceComplete=this.complete) {
    if (this.closed || !receivedFrames || !this.anchors.length) return undefined;
    if (!Number.isSafeInteger(receivedFrames) || receivedFrames<0 || receivedFrames>this.frames
        || typeof sourceComplete!=='boolean' || (sourceComplete&&(!this.complete||receivedFrames!==this.frames)))
      throw Error('Pocket facial prefix exceeds accepted source samples');
    const key=`${this.revision}:${receivedFrames}:${sourceComplete}`;
    if (this.cached?.key===key) return this.cached.face;
    const duration=receivedFrames/RATE, frames=[];let at=0;
    const pose=seconds=>{
      while(at+1<this.anchors.length && this.anchors[at+1][0]<=seconds)at++;
      const left=this.anchors[at],right=this.anchors[at+1];
      if (seconds<left[0]) return zero();
      const mix=right?Math.max(0,Math.min(1,(seconds-left[0])/(right[0]-left[0]||1))):0;
      const edge=sourceComplete?Math.max(0,Math.min(1,(duration-seconds)/.04)):1;
      return left.slice(1).map((value,index)=>Math.round((value+((right?.[index+1]??value)-value)*mix)*edge*10000)/10000);
    };
    for(let index=0;index/60<duration;index++)frames.push([index/60,...pose(index/60)]);
    frames.push([duration,...pose(duration)]);
    const face={version:1,requestId:this.input.requestId,entity:this.input.entity,generation:this.input.generation,
      continuous:true,complete:sourceComplete,duration,revision:this.revision,tracks:[...SPEECH_TRACKS],frames,
      source:this.phonetic?'local-phonetic':'audio-envelope',...(this.phonetic?{articulation:PHONETIC_ARTICULATION}:{} )};
    this.cached={key,face};return face;
  }
  close() {
    if (this.closed) return; this.closed=true;this.controller.abort();this.signal?.removeEventListener('abort',this.cancel);
    this.pcm=null;this.anchors=[];this.cached=null;
  }
}

export function ownedPocketFace(snapshot, owner) {
  const face=snapshot?.face;
  if (!face) return undefined;
  if (face.version!==1 || face.requestId!==owner.requestId || face.entity!==owner.entity || face.generation!==owner.generation
      || face.continuous!==true || face.complete!==snapshot.sourceComplete || !Number.isFinite(face.duration)
      || Math.abs(face.duration-snapshot.duration)>1/24000 || !Array.isArray(face.tracks)
      || face.tracks.length!==SPEECH_TRACKS.length || face.tracks.some((name,index)=>name!==SPEECH_TRACKS[index])
      || !Array.isArray(face.frames) || !face.frames.length || face.frames.length>7202)
    throw Error('Pocket facial timeline owner or source clock changed');
  let previous=-1;
  for(const frame of face.frames) {
    if (!Array.isArray(frame) || frame.length!==SPEECH_TRACKS.length+1 || !frame.every(Number.isFinite)
        || frame[0]<0 || frame[0]<=previous || frame[0]>face.duration+1e-7)
      throw Error('Invalid Pocket facial timeline');
    previous=frame[0];
  }
  return face;
}
