import {PHONE_ANALYSIS_ENGINE,PHONE_ANALYSIS_FORMAT,PHONE_ANALYSIS_FRONTEND} from './phone-analysis-config.mjs';
const DELAY=PHONE_ANALYSIS_FRONTEND.resamplerDelaySeconds;
const sameOwner=(a,b)=>a?.requestId===b?.requestId&&a?.entity===b?.entity&&a?.generation===b?.generation;

// Acoustic phone categories use the same calibrated Cyberpunk trajectories.
// Diphthong and filler rules follow Rhubarb's published phone/shape rules;
// unknown symbols are unavailable data, never an invented mouth sequence.
export function acousticPhoneShapes(phone,start,end){
  const duration=end-start,single=value=>[{start,end,value}],dip=(first,last)=>[
    {start,end:start+duration*.6,value:first},{start:start+duration*.6,end,value:last}];
  if(['SIL','<sil>','SPN','+NSN+','<s>','</s>'].includes(phone))return single('X');
  if(['+BREATH+','+COUGH+','+SMACK+'].includes(phone))return single('C');
  if(['+NOISE+','+UH+','+UM+'].includes(phone))return single('B');
  if(['P','B','M'].includes(phone))return single('A');
  if(['F','V'].includes(phone))return single('G');
  if(['UW','UH','W'].includes(phone))return single('F');
  if(['AO','ER'].includes(phone))return single('E');
  if(phone==='AA')return single('D');
  if(phone==='AH')return single(duration<.2?'C':'D');
  if(['AE','EH'].includes(phone))return single('C');
  if(phone==='L')return single(duration<.2?'B':'H');
  if(phone==='EY')return dip('C','B');
  if(phone==='AY')return dip(duration<.2?'C':'D','B');
  if(phone==='OW')return dip('E','F');
  if(phone==='AW')return dip(duration<.3?'C':'D','E');
  if(phone==='OY')return dip('E','B');
  if(['IY','IH','T','D','K','G','CH','JH','TH','DH','S','Z','SH','ZH','HH','N','NG','R','Y'].includes(phone))return single('B');
  throw Error('Unsupported acoustic phone');
}

export class ConfirmedPhoneTimeline {
  constructor(owner){this.owner=owner;this.previousKeys=new Set();this.cues=[];this.frames=0;}
  accept(result,audiblePosition,sourceFrames){
    if(!sameOwner(result?.owner,this.owner)||!['phones','finished'].includes(result.type)
        ||!Number.isSafeInteger(result.receivedFrames)||result.receivedFrames<this.frames||result.receivedFrames>sourceFrames
        ||!Number.isFinite(audiblePosition)||audiblePosition<0||audiblePosition>sourceFrames/24000
        ||!Array.isArray(result.segments)||result.segments.length>12000)
      throw Error('Acoustic phones changed their utterance owner or source clock');
    const duration=result.receivedFrames/24000,final=result.type==='finished',keys=new Set(),stable=[];
    if(final&&(!Number.isFinite(result.duration)||Math.abs(result.duration-duration)>1/24000))throw Error('Final acoustic duration changed');
    let previousEnd=-1;
    for(const segment of result.segments){
      if(!Number.isInteger(segment.startFrame)||!Number.isInteger(segment.endFrame)||segment.startFrame<0
          ||segment.endFrame<segment.startFrame||segment.startFrame<=previousEnd
          ||segment.endFrame>Math.ceil(duration*100)+3||typeof segment.phone!=='string'||segment.phone.length>32)
        throw Error('Invalid acoustic phone segmentation');
      previousEnd=segment.endFrame;
      const start=Math.max(0,segment.startFrame/100-DELAY),end=Math.min(duration,(segment.endFrame+1)/100-DELAY);
      const key=JSON.stringify([segment.phone,segment.startFrame,segment.endFrame]);keys.add(key);
      if(end>start&&(final||this.previousKeys.has(key))&&(final||end<=duration-PHONE_ANALYSIS_FRONTEND.stableTailSeconds))
        stable.push({phone:segment.phone,start,end});
    }
    const past=this.cues.filter(cue=>cue.start<audiblePosition).map(cue=>({...cue,end:Math.min(cue.end,audiblePosition)}));
    const future=[];let late=0;
    for(const phone of stable)for(const cue of acousticPhoneShapes(phone.phone,phone.start,phone.end)){
      if(cue.end<=audiblePosition){late++;continue;}
      future.push({...cue,start:Math.max(cue.start,audiblePosition),originalStart:cue.start,phone:phone.phone});
    }
    this.cues=[...past,...future];this.previousKeys=keys;this.frames=result.receivedFrames;
    return {type:'phones',engine:PHONE_ANALYSIS_ENGINE,format:PHONE_ANALYSIS_FORMAT,
      index:result.index,receivedSeconds:duration,audiblePositionSeconds:audiblePosition,
      analysisMs:result.analysisMs,stablePhones:stable.length,lateDiscarded:late,
      usableSeconds:future.reduce((total,cue)=>total+cue.end-cue.start,0)};
  }
  intervals(){
    const cues=[],spans=[];let cursor=0;
    for(const cue of this.cues){
      if(cue.start>cursor)cues.push({start:cursor,end:cue.start,value:'X'});
      cues.push(cue);cursor=cue.end;
      const previous=spans.at(-1);
      if(previous&&Math.abs(previous[1]-cue.start)<1e-7)previous[1]=cue.end;
      else spans.push([cue.start,cue.end]);
    }
    if(cursor<this.frames/24000)cues.push({start:cursor,end:this.frames/24000,value:'X'});
    return spans.map(([start,end],index)=>({index:index+1,start,end,analysisStart:0,cues,easeIn:false}));
  }
  recognition(){return {version:1,format:PHONE_ANALYSIS_FORMAT,engine:PHONE_ANALYSIS_ENGINE,
    timebase:'original-audio-seconds',...PHONE_ANALYSIS_FRONTEND};}
  clear(){this.cues=[];this.previousKeys.clear();this.frames=0;}
}
