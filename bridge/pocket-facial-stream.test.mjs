import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PocketFacialStream, pocketAnalysisWav, ownedPocketFace} from './pocket-facial-stream.mjs';
import {readPcmWav} from './speech-audio.mjs';

const input={requestId:'pocket-owned-turn',entity:'17ULL',generation:3};
const tick=()=>new Promise(done=>setImmediate(done));
function packet(index,offsetFrames,frames=2400) {
  return {index,offsetFrames,frames,sampleRate:24000,channels:1,
    pcm:Float32Array.from({length:frames},(_,at)=>.2*Math.sin((offsetFrames+at)*.041))};
}

test('analysis preserves original float PCM; mouth timeline uses the exact accepted prefix, not generated-ahead samples',()=>{
  const face=new PocketFacialStream({input}),source=packet(1,0,9600),original=source.pcm.slice();
  face.push(source);assert.deepEqual(source.pcm,original);
  const wave=readPcmWav(Buffer.from(pocketAnalysisWav(source.pcm),'base64'));
  assert.equal(wave.codec,3);assert.equal(wave.sampleRate,24000);
  for(let index=0;index<source.frames;index++)assert.equal(wave.data.readFloatLE(index*4),source.pcm[index]);
  face.push(packet(2,9600,9600));const prefix=face.snapshot(9600,false);
  assert.equal(prefix.duration,.4);assert.equal(prefix.complete,false);assert.equal(prefix.generation,input.generation);
  assert.equal(prefix.frames.at(-1)[0],.4);assert.equal(ownedPocketFace({face:prefix,duration:.4,sourceComplete:false},input),prefix);
  assert.throws(()=>ownedPocketFace({face:face.snapshot(),duration:.4,sourceComplete:false},input),/source clock/);
  assert.throws(()=>ownedPocketFace({face:prefix,duration:.4,sourceComplete:false},{...input,entity:'other'}),/owner/);
  face.close();
});

test('slow phonetic analysis never blocks PCM or neutralizes each packet boundary',async()=>{
  let resolveAnalysis,analysisSignal,calls=0;
  const lipsync={analyse:async(audio,{signal})=>{calls++;analysisSignal=signal;
    return new Promise(done=>{resolveAnalysis=done;});}};
  const face=new PocketFacialStream({input,lipsync});
  for(let index=0;index<8;index++)face.push(packet(index+1,index*2400));
  await tick();assert.equal(calls,1);const fallback=face.snapshot();
  assert.equal(fallback.source,'audio-envelope');assert.ok(fallback.frames.at(-1).slice(1).some(value=>value>0),
    'a growing prefix does not invent a silent tail');
  resolveAnalysis({mouthCuesFormat:'rhubarb-phonetic-v1',mouthCues:['A','B','D','F','G','H','E','C']
    .map((value,index)=>({start:index*.1,end:(index+1)*.1,value})),timing:{lipEngine:'fixture-phonetic'}});
  await tick();const phonetic=face.snapshot();assert.equal(phonetic.source,'local-phonetic');
  const shape=phonetic.tracks.indexOf('lips_l_funnel')+1;
  assert.ok(phonetic.frames.some(frame=>frame[shape]>0),'real cues reach the accepted native lip-shape mapping');
  face.finish();const ended=face.snapshot(19200,true);
  assert.equal(ended.complete,true);assert.ok(ended.frames.at(-1).slice(1).every(value=>value===0));
  face.close();assert.equal(analysisSignal.aborted,true);assert.equal(face.snapshot(),undefined);
});

test('more than 128 PCM packets remains one bounded continuous facial timeline',()=>{
  const face=new PocketFacialStream({input});
  for(let index=0;index<150;index++)face.push(packet(index+1,index*1920,1920));
  face.finish();const line=face.snapshot();assert.equal(line.duration,12);
  assert.equal(line.frames.length,721);assert.equal(line.continuous,true);
  assert.equal(ownedPocketFace({face:line,duration:12,sourceComplete:true},input),line);face.close();
});

test('cancelled owners and wrong source offsets cannot append or revive facial state',()=>{
  const controller=new AbortController(),face=new PocketFacialStream({input,signal:controller.signal});
  assert.throws(()=>face.push(packet(1,10)),/out of order/);face.push(packet(1,0));
  assert.throws(()=>face.snapshot(4800,false),/accepted source samples/);
  assert.throws(()=>face.snapshot(2400,true),/accepted source samples/);
  controller.abort();assert.equal(face.snapshot(),undefined);
  assert.throws(()=>face.push(packet(2,2400)),{name:'AbortError'});
});
