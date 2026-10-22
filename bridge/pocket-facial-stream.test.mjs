import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PocketFacialStream, pocketAnalysisWav, ownedPocketFace} from './pocket-facial-stream.mjs';
import {readPcmWav} from './speech-audio.mjs';
import {buildFacialTimeline} from './facial-timeline.mjs';

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

test('owned Pocket prefixes cannot claim remote or unqualified articulation sources',()=>{
  const stream=new PocketFacialStream({input});stream.push(packet(1,0));const prefix=stream.snapshot();
  for(const change of [{source:'convai-arkit61'},{source:'unknown-local'},{articulation:'coarticulated-v5'},
    {source:'local-phonetic',articulation:'unknown'},{source:'local-phonetic',articulation:undefined}])
    assert.throws(()=>ownedPocketFace({face:{...prefix,...change},duration:prefix.duration,sourceComplete:false},input),/owner or source clock/);
  stream.close();
});

test('quiet syllables keep whole-utterance effort instead of rescaling every 80 ms packet',()=>{
  const pcm=Float32Array.from({length:48000},(_,index)=>(index<24000?.2:.04)*Math.sin(index*.041));
  const before=pcm.slice(),whole=buildFacialTimeline({audio:pocketAnalysisWav(pcm)},input);
  const stream=new PocketFacialStream({input});
  for(let offset=0,index=1;offset<pcm.length;offset+=1920,index++)stream.push({index,offsetFrames:offset,
    frames:1920,sampleRate:24000,channels:1,pcm:pcm.slice(offset,offset+1920)});
  stream.finish();const streamed=stream.snapshot(pcm.length,true,1.5);
  const at=(face,seconds)=>face.frames.reduce((left,right)=>Math.abs(left[0]-seconds)<Math.abs(right[0]-seconds)?left:right);
  assert.ok(Math.abs(at(streamed,1.5)[1]-at(whole,1.5)[1])<.0002,
    `quiet jaw changed from ${at(whole,1.5)[1]} to ${at(streamed,1.5)[1]} at packet boundaries`);
  assert.deepEqual(pcm,before);stream.close();
});

test('packet boundaries and sub-50 ms chunks do not change the continuous fallback trajectory',()=>{
  const pcm=Float32Array.from({length:48000},(_,index)=>(index<24000?.2:.04)*Math.sin(index*.041));
  const render=sizes=>{
    const stream=new PocketFacialStream({input});let offset=0,index=0;
    while(offset<pcm.length){const frames=Math.min(sizes[index%sizes.length],pcm.length-offset);
      stream.push({index:++index,offsetFrames:offset,frames,sampleRate:24000,channels:1,pcm:pcm.slice(offset,offset+frames)});
      offset+=frames;}
    stream.finish();const face=stream.snapshot(pcm.length,true);stream.close();return face.frames;
  };
  assert.ok(JSON.stringify(render([1920]))===JSON.stringify(render([360,1440,260])),
    'short, irregular packets changed the mouth trajectory');
  assert.ok(JSON.stringify(render([1920]))===JSON.stringify(render([48000])),
    'a single source packet changed the mouth trajectory');
});

test('past analysis cannot claim phonetic coverage at the audible cursor or queue obsolete windows',async()=>{
  const jobs=[],events=[];
  const lipsync={analyse:(audio,{signal})=>new Promise(resolve=>jobs.push({audio,signal,resolve}))};
  const stream=new PocketFacialStream({input,lipsync,onAnalysis:event=>events.push(event)});
  for(let index=0;index<30;index++)stream.push(packet(index+1,index*1920,1920));
  await tick();assert.equal(jobs.length,1,'one active analysis, not a queue of already-obsolete windows');
  stream.snapshot(57600,false,2.1);
  jobs[0].resolve({mouthCuesFormat:'rhubarb-phonetic-v1',mouthCues:[{start:0,end:.8,value:'E'}]});
  await tick();const face=stream.snapshot(57600,false,2.1);
  assert.equal(face.source,'audio-envelope');assert.equal(face.articulation,undefined);
  assert.deepEqual(face.coverage.phoneticIntervals,[]);
  assert.equal(face.coverage.audiblePositionSeconds,2.1);
  assert.ok(events.some(event=>event.status==='late-discarded'&&event.usableSeconds===0));
  assert.equal(jobs.length,1,'the remaining tail is too short for a new contextual recognition window');
  stream.close();
});

test('delayed analysis qualifies only the unheard interval, and source follows the actual audible point',async()=>{
  let resolveAnalysis;const events=[];
  const lipsync={analyse:()=>new Promise(done=>{resolveAnalysis=done;})};
  const stream=new PocketFacialStream({input,lipsync,onAnalysis:event=>events.push(event)});
  stream.push(packet(1,0,19200));await tick();stream.snapshot(19200,false,.4);
  resolveAnalysis({mouthCuesFormat:'rhubarb-phonetic-v1',mouthCues:[{start:0,end:.8,value:'E'}]});
  await tick();const face=stream.snapshot(19200,false,.6);
  assert.equal(face.source,'local-phonetic');assert.equal(face.articulation,'coarticulated-v5');
  assert.deepEqual(face.coverage.phoneticIntervals,[[.4,.8]]);
  const funnel=face.tracks.indexOf('lips_l_funnel')+1;
  assert.equal(face.frames.find(frame=>frame[0]===.2)[funnel],0,'past samples retain fallback; no retroactive phoneme claim');
  assert.ok(face.frames.find(frame=>frame[0]===.6)[funnel]>0);
  assert.equal(stream.snapshot(19200,false,.8).source,'audio-envelope');
  assert.ok(events.some(event=>event.status==='qualified'&&Math.abs(event.usableSeconds-.4)<1e-9));
  assert.throws(()=>stream.snapshot(19200,false,.9),/audible cursor/);
  stream.close();
});

test('after an obsolete job, the next analysis targets available unheard samples with bounded left context',async()=>{
  const jobs=[],events=[];
  const lipsync={analyse:(audio,{signal})=>new Promise(resolve=>jobs.push({audio,signal,resolve}))};
  const stream=new PocketFacialStream({input,lipsync,onAnalysis:event=>events.push(event)});
  for(let index=0;index<50;index++)stream.push(packet(index+1,index*1920,1920));
  await tick();stream.snapshot(96000,false,2.1);
  jobs[0].resolve({mouthCuesFormat:'rhubarb-phonetic-v1',mouthCues:[{start:0,end:.8,value:'E'}]});
  await tick();assert.equal(jobs.length,2);
  const analysis=readPcmWav(Buffer.from(jobs[1].audio,'base64'));
  assert.ok(Math.abs(analysis.duration-2)<1e-8,'400 ms context accompanies 1.6 seconds of future samples');
  stream.snapshot(96000,false,2.5);
  jobs[1].resolve({mouthCuesFormat:'rhubarb-phonetic-v1',mouthCues:[{start:0,end:2,value:'F'}]});
  await tick();const face=stream.snapshot(96000,false,2.6);
  assert.equal(face.source,'local-phonetic');assert.deepEqual(face.coverage.phoneticIntervals,[[2.5,3.7]]);
  const receipt=events.find(event=>event.status==='qualified');
  assert.equal(receipt.startSeconds,2.1);assert.equal(receipt.analysisStartSeconds,1.7);
  assert.equal(receipt.audiblePositionSecondsAtFinish,2.5);
  assert.ok(Math.abs(receipt.usableSeconds-1.2)<1e-9);stream.close();
});

test('owned coverage rejects a false source, malformed interval, or another audible clock',()=>{
  const stream=new PocketFacialStream({input});stream.push(packet(1,0,9600));
  const face=stream.snapshot(9600,false,.2),snapshot={face,duration:.4,sourceComplete:false,positionSeconds:.2};
  assert.equal(ownedPocketFace(snapshot,input),face);
  for(const coverage of [{...face.coverage,receivedSeconds:NaN},{...face.coverage,audiblePositionSeconds:.3},
    {...face.coverage,phoneticIntervals:[[.1,.3]]},{...face.coverage,phoneticIntervals:[[.1,.5]]},
    {...face.coverage,pendingAnalyses:2}]) {
    assert.throws(()=>ownedPocketFace({...snapshot,face:{...face,coverage}},input),/coverage|interval|source/);
  }
  assert.throws(()=>ownedPocketFace({...snapshot,face:{...face,source:'local-phonetic',articulation:'coarticulated-v5'}},input),/not covered/);
  assert.throws(()=>stream.snapshot(9600,false,.1),/audible cursor/);stream.close();
});

test('a rejected asynchronous diagnostic write cannot reject the facial stream or become unhandled',async()=>{
  const stream=new PocketFacialStream({input,
    onAnalysis:()=>Promise.reject(Error('diagnostic disk unavailable')),
    lipsync:{analyse:async()=>({mouthCuesFormat:'rhubarb-phonetic-v1',mouthCues:[{start:0,end:.8,value:'E'}]})}});
  stream.push(packet(1,0,19200));await tick();await tick();
  assert.equal(stream.snapshot(19200,false,.4).source,'local-phonetic');stream.close();
});

test('a generated-ahead phonetic interval is clipped to the accepted prefix at a caught-up audible cursor',async()=>{
  const stream=new PocketFacialStream({input,lipsync:{analyse:async()=>({mouthCuesFormat:'rhubarb-phonetic-v1',
    mouthCues:[{start:0,end:.8,value:'E'}]})}});
  stream.push(packet(1,0,19200));await tick();
  const face=stream.snapshot(9600,false,.4);
  assert.equal(face.source,'audio-envelope');assert.deepEqual(face.coverage.phoneticIntervals,[[0,.4]]);
  assert.equal(ownedPocketFace({face,duration:.4,sourceComplete:false,positionSeconds:.4},input),face);
  stream.close();
});

test('resident acoustic packets use stable future phones and their truthful format without a batch analyser',async()=>{
  let deliver,error,closed=0,batchCalls=0;
  const phoneAnalysis={beginTurn(owner,{onPhones,onError}){deliver=onPhones;error=onError;
    assert.deepEqual(owner,input);return{push(){},finish(){},close(){closed++;}};}};
  const stream=new PocketFacialStream({input,phoneAnalysis,lipsync:{analyse(){batchCalls++;throw Error('must not batch');}}});
  stream.push(packet(1,0,9600));
  const response=frames=>({type:'phones',owner:input,receivedFrames:frames,
    segments:[{phone:'AA',startFrame:0,endFrame:19},{phone:'OW',startFrame:20,endFrame:29}]});
  deliver(response(9600));assert.equal(stream.snapshot(9600,false,.1).source,'audio-envelope');
  stream.push(packet(2,9600,9600));deliver(response(19200));
  const face=stream.snapshot(19200,false,.25);
  assert.equal(face.source,'local-phonetic');assert.equal(face.recognition.format,'pocketsphinx-allphone-live-v1');
  assert.equal(face.recognition.engine,'pocketsphinx-5.0.4-allphone-live');assert.equal(batchCalls,0);
  const rounding=face.tracks.indexOf('lips_l_purse')+1;assert.ok(face.frames.find(frame=>frame[0]===.25)[rounding]>0);
  assert.equal(ownedPocketFace({face,duration:.8,sourceComplete:false,positionSeconds:.25},input),face);
  for(const recognition of [{...face.recognition,format:'rhubarb-phonetic-v1'},
    {...face.recognition,analysisSampleRate:24000},{...face.recognition,timebase:'decoder-frame-guesses'}])
    assert.throws(()=>ownedPocketFace({face:{...face,recognition},duration:.8,sourceComplete:false,positionSeconds:.25},input),/format/);
  error(Error('recognizer unavailable'));assert.equal(stream.snapshot(19200,false,.26).source,'audio-envelope');
  stream.finish();await stream.close();await stream.close();assert.equal(closed,1);
});

test('an unavailable resident helper retains immediate original PCM and explicit envelope fallback',async()=>{
  let batches=0,starts=0;
  const phoneAnalysis={beginTurn(){starts++;return null;},start(){throw Error('reply onset cannot start a helper');}};
  const stream=new PocketFacialStream({input,phoneAnalysis,lipsync:{analyse(){batches++;}}});
  const source=packet(1,0,19200),before=source.pcm.slice();stream.push(source);await tick();
  assert.deepEqual(source.pcm,before);assert.equal(stream.snapshot(19200,false,.3).source,'audio-envelope');
  assert.equal(starts,1);assert.equal(batches,0);await stream.close();
});

// ---- A poll that only moved the audible cursor is the same timeline (perf review 2026-10-22) ------------------------------------------------

test('the audible cursor moving is not a new timeline: same revision, same row array, only the coverage moves; a packet, a finish or a source change is a new one', async()=>{
  let resolveAnalysis;
  const lipsync={analyse:async()=>new Promise(done=>{resolveAnalysis=done;})};
  const face=new PocketFacialStream({input,lipsync});
  for(let index=0;index<8;index++)face.push(packet(index+1,index*2400));
  await tick();
  const first=face.snapshot(19200,false,0),second=face.snapshot(19200,false,.08),third=face.snapshot(19200,false,.16);
  assert.equal(second.revision,first.revision);assert.equal(third.revision,first.revision);
  assert.equal(second.frames,first.frames,'the very same row array, not a rebuilt one');assert.equal(third.rows,first.rows);
  assert.equal(first.coverage.audiblePositionSeconds,0);assert.equal(third.coverage.audiblePositionSeconds,.16);
  assert.equal(ownedPocketFace({face:third,duration:.8,sourceComplete:false,positionSeconds:.16},input),third);
  // New audio is a new timeline.
  face.push(packet(9,19200));
  const grown=face.snapshot(21600,false,.16);
  assert.ok(grown.revision>first.revision);assert.notEqual(grown.frames,first.frames);
  // Analysis that qualifies the unheard interval is one too, and the source flips with the cursor.
  resolveAnalysis({mouthCuesFormat:'rhubarb-phonetic-v1',mouthCues:['A','B','D','F','G','H','E','C']
    .map((value,index)=>({start:index*.1,end:(index+1)*.1,value})),timing:{lipEngine:'fixture-phonetic'}});
  await tick();
  const phonetic=face.snapshot(21600,false,.2);
  assert.ok(phonetic.revision>grown.revision);assert.equal(phonetic.source,'local-phonetic');
  const later=face.snapshot(21600,false,.21);
  assert.equal(later.revision,phonetic.revision,'inside the same interval nothing changed');
  face.finish();
  const ended=face.snapshot(21600,true,.21);
  assert.ok(ended.revision>later.revision);
  assert.equal(face.snapshot(21600,true,.3).revision,ended.revision,'a finished line stays one timeline to its end');
  face.close();
});

test('over a line the revision (and with it the face file rewrite) follows the audio and not the clock: polls every 40 ms over 10 s of buffered audio make a handful of revisions',()=>{
  const face=new PocketFacialStream({input});
  for(let index=0;index<100;index++)face.push(packet(index+1,index*2400));   // 10 s, all received
  face.finish();
  const revisions=new Set();
  for(let poll=0;poll<250;poll++)revisions.add(face.snapshot(240000,true,Math.min(10,poll*.04)).revision);
  assert.equal(revisions.size,1,'250 polls of a finished line are one revision');
  face.close();
});
