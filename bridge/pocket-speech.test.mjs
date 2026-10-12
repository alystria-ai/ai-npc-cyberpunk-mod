import {test} from 'node:test';
import assert from 'node:assert/strict';
import {deliverPocketSpeech} from './pocket-speech.mjs';
import {ownedPocketFace} from './pocket-facial-stream.mjs';
import {ConvaiContinuousSpeech} from './convai-continuous-speech.mjs';

const input={requestId:'pocket-turn',entity:'17ULL',generation:3,profileKey:'johnny-silverhand'};
const result={text:'One sentence. Another complete sentence.',sessionID:'one-original-session',timing:{dialogueMs:100}};
const profile={key:input.profileKey};
const packet=(index,offsetFrames)=>({index,offsetFrames,frames:9600,sampleRate:24000,channels:1,
  pcm:Float32Array.from({length:9600},(_,at)=>.15*Math.sin((offsetFrames+at)*.043))});

test('whole-text Pocket production starts genuine prefix admission and shares device clock with native lips',async()=>{
  const documents=[],replies=[],spoken=[],generated=[];let sequence=0;
  const current=async()=>true,currentSync=()=>true;current.sync=currentSync;
  const speech=new ConvaiContinuousSpeech({input,profile,current,token:'pocket-test-token',faceBuilder:ownedPocketFace,
    writeState:async value=>{documents.push(value);return true;},writeReply:async value=>{replies.push(value);return true;},
    readControl:async()=>JSON.stringify({version:1,id:'pocket-test-token',requestId:input.requestId,entity:input.entity,
      generation:input.generation,sequence:++sequence,updated:Date.now(),allow:true,paused:false,volume:1,pan:0}),
    onGenerated:async text=>generated.push(text)});
  const host={async playLocalPcm(config,produce,options){
    assert.equal(config.text,result.text);assert.equal(config.token,speech.token);let receivedFrames=0;
    const controller=new AbortController();
    const produced=await produce(async value=>{
      receivedFrames+=value.frames;
      const snapshot={version:1,token:config.token,sampleRate:24000,channels:1,receivedFrames,
        positionSeconds:receivedFrames===9600?0:.05,text:config.text,textComplete:true,sourceComplete:false,
        ended:false,underruns:0,state:'playing'};
      snapshot.face=options.getFace(snapshot);
      assert.equal(snapshot.face.coverage.audiblePositionSeconds,snapshot.positionSeconds,
        'production facial source must use the device cursor, not a default zero');
      const control=await options.onFrame(snapshot);
      assert.equal(control.allow,true);
      spoken.push(value);
      if(spoken.length===1)assert.equal(replies.length,1,'first prefix is admitted before source completion');
    },{signal:controller.signal});
    const final={version:1,token:config.token,sampleRate:24000,channels:1,receivedFrames,positionSeconds:receivedFrames/24000,
      text:config.text,textComplete:true,sourceComplete:true,ended:true,underruns:0,state:'draining'};
    final.face=options.getFace(final);assert.equal(final.face.coverage.audiblePositionSeconds,final.positionSeconds);
    await options.onFrame(final);return {...produced,timing:{voiceProvider:'pocket',firstPcmMs:140}};
  }};
  let calls=0;
  const voice={async synthesizeStream(key,text,{onPcm}){calls++;assert.equal(key,profile.key);assert.equal(text,result.text);
    await onPcm(packet(1,0));await onPcm(packet(2,9600));return {frames:19200};}};
  const reply=await deliverPocketSpeech({input,profile,result,current,voice,host,speech});
  assert.equal(calls,1);assert.equal(reply.continuous,true);assert.equal(reply.sessionID,result.sessionID);
  assert.deepEqual(generated,[result.text]);assert.equal(replies.length,1);
  assert.equal(reply.liveDelivery.ended,true);assert.equal(documents.at(-1).face.complete,true);
  assert.equal(documents.at(-1).position,.8);assert.equal(documents.at(-1).face.duration,.8);
  assert.ok(documents.at(-1).face.frames.at(-1).slice(1).every(value=>value===0));
});

test('pre-admission failure preserves the original text/session; partial admitted speech cannot replay as a new reply',async()=>{
  for(const published of [false,true]) {
    let failures=0;
    const speech={token:'owned-token',published,fail:async()=>{failures++;}};
    const host={playLocalPcm:async()=>{throw Error('renderer owner retired');}};
    const operation=deliverPocketSpeech({input,profile,result,current:async()=>true,voice:{},host,speech});
    if(published)await assert.rejects(operation,/owner retired/);
    else{const reply=await operation;assert.equal(reply.text,result.text);assert.equal(reply.sessionID,result.sessionID);
      assert.equal(reply.audio,undefined);assert.ok(reply.audioError);assert.equal(reply.continuous,undefined);}
    assert.equal(failures,1);
  }
});

test('actual Pocket delivery wires the ready resident analyser while admitting original PCM before analysis completion',async()=>{
  const phones=[];let beginCalls=0,closed=0,finishCalls=0,voiceCalls=0;
  const phoneAnalysis={beginTurn(owner,{onPhones}){
    beginCalls++;assert.equal(owner,input);
    return{push(value){phones.push(value);onPhones({type:'phones',owner:input,receivedFrames:value.offsetFrames+value.frames,
      segments:[{phone:'AA',startFrame:0,endFrame:19},{phone:'OW',startFrame:20,endFrame:29}]});},
      finish(){finishCalls++;},close(){closed++;}};
  },start(){throw Error('first PCM cannot wait on recognizer warm-up');}};
  const seen=[],speech={token:'resident-delivery-seam',published:true,ended:true,generated:true,
    frame:async value=>seen.push(value),fail:async()=>{throw Error('unexpected audio failure');}};
  const host={async playLocalPcm(config,produce,options){
    let frames=0;
    const produced=await produce(async value=>{
      frames+=value.frames;const state={receivedFrames:frames,sourceComplete:false,positionSeconds:.05};
      state.face=options.getFace(state);await options.onFrame(state);
      assert.equal(value.pcm[10],packet(value.index,value.offsetFrames).pcm[10]);
      return{receivedFrames:frames};
    },{signal:new AbortController().signal});
    const final={receivedFrames:frames,sourceComplete:true,positionSeconds:frames/24000};
    final.face=options.getFace(final);await options.onFrame(final);return produced;
  }};
  const voice={async synthesizeStream(key,text,{onPcm}){
    voiceCalls++;assert.equal(text,result.text);assert.equal(key,profile.key);
    await onPcm(packet(1,0));await onPcm(packet(2,9600));return{frames:19200};
  }};
  const response=await deliverPocketSpeech({input,profile,result,current:async()=>true,voice,host,speech,phoneAnalysis});
  assert.equal(beginCalls,1);assert.equal(voiceCalls,1);assert.equal(phones.length,2);assert.equal(finishCalls,1);assert.equal(closed,1);
  assert.equal(seen[0].face.source,'audio-envelope');assert.equal(seen[1].face.source,'local-phonetic');
  assert.equal(seen[1].face.recognition.format,'pocketsphinx-allphone-live-v1');
  assert.equal(response.sessionID,result.sessionID);assert.equal(response.liveDelivery.ended,true);
});

test('a prefetched Pocket turn replays its buffered PCM in order into the renderer and never synthesizes twice',async()=>{
  const {BufferedPcm}=await import('./group-lookahead.mjs');
  let calls=0;const emitted=[],pushed=[];
  const synth=new BufferedPcm({synthesize:async onPcm=>{
    calls++;await onPcm(packet(1,0));await onPcm(packet(2,9600));return {frames:19200};}});
  synth.start();await new Promise(done=>setImmediate(done));
  assert.equal(synth.packets.length,2,'both packets were produced before the renderer was owned');
  const speech={token:'owned-token',published:true,ended:true,generated:true,fail:async()=>{}};
  const host={async playLocalPcm(config,produce){
    assert.equal(config.text,result.text);
    const produced=await produce(async value=>{emitted.push(value.index);},{signal:new AbortController().signal});
    return {...produced,timing:{voiceProvider:'pocket'}};
  }};
  const voice={synthesizeStream:async()=>{throw Error('must not synthesize again');}};
  const reply=await deliverPocketSpeech({input,profile,result,current:async()=>true,voice,host,speech,prefetched:synth,
    jaliFace:null,phoneAnalysis:undefined});
  assert.equal(calls,1);assert.deepEqual(emitted,[1,2]);assert.equal(reply.continuous,true);void pushed;
});

test('the picked voice variant speaks while the profile stays the character; without one the profile key speaks',async()=>{
  for(const [voiceKey,expected] of [[undefined,profile.key],['johnny-silverhand-v3','johnny-silverhand-v3']]){
    const keys=[];
    const host={async playLocalPcm(config,produce){await produce(async()=>{},{signal:new AbortController().signal});return{timing:{voiceProvider:'pocket'}};}};
    const speech={token:'t',published:true,ended:true,generated:true,frame(){},async fail(){}};
    const voice={async synthesizeStream(key,text,{onPcm}){keys.push(key);await onPcm(packet(1,0));return{frames:9600};}};
    const reply=await deliverPocketSpeech({input,profile,...(voiceKey?{voiceKey}:{}),result,current:async()=>true,voice,host,speech});
    assert.deepEqual(keys,[expected]);assert.equal(reply.continuous,true);
  }
});

test('a streamed reply voices its first sentence at once and its rest as the same utterance, with the text growing under it',async()=>{
  const {ReplyStream}=await import('./reply-stream.mjs');
  const {TurnClock,withClock}=await import('./turn-clock.mjs');
  const full='Hey V, good to see you here again. What can I do for you tonight?';
  const stream=new ReplyStream({name:'Johnny'});
  stream.update('Hey V, good to see you here again. What can');
  const head=stream.head;assert.equal(head,'Hey V, good to see you here again.');
  const emitted=[],calls=[],faceTexts=[];
  const pk=(owner,id,index,offsetFrames)=>({...packet(index,offsetFrames),owner,id,profile:'johnny',modelSha256:'a'.repeat(64)});
  const voice={async synthesizeStream(key,text,{onPcm}){
    calls.push(text);
    if(text===head){await onPcm(pk('1'.repeat(32),1,1,0));await onPcm(pk('1'.repeat(32),1,2,9600));return{frames:19200,chunks:2};}
    await onPcm(pk('2'.repeat(32),9,1,0));await onPcm(pk('2'.repeat(32),9,2,9600));return{frames:19200,chunks:2};
  }};
  const speech={token:'streamed-token',published:true,ended:true,generated:true,frame(){},async fail(){}};
  let early,late;
  const host={async playLocalPcm(config,produce,options){
    assert.equal(config.text,head,'the renderer starts with the first sentence only');
    early=options.liveText();
    const produced=produce(async value=>{emitted.push(value);},{signal:new AbortController().signal});
    await new Promise(done=>setTimeout(done,15));
    assert.equal(emitted.length,2,'the first sentence is voiced before the reply is finished');
    stream.finish(full);
    const result=await produced;
    late=options.liveText();
    faceTexts.push(options.getFace({text:late.text,textComplete:late.complete,receivedFrames:38400,sourceComplete:true,positionSeconds:1.6}) ?? null);
    return{...result,timing:{voiceProvider:'pocket'}};
  }};
  const clock=new TurnClock({origin:0});
  const reply=await withClock(clock,()=>deliverPocketSpeech({input,profile,result:{...result,text:head},current:async()=>true,voice,host,speech,stream}));
  assert.deepEqual(calls,[head,'What can I do for you tonight?']);
  assert.deepEqual(emitted.map(value=>value.index),[1,2,3,4]);
  assert.deepEqual(emitted.map(value=>value.offsetFrames),[0,9600,19200,28800],'the rest continues the first sentence\'s numbering');
  assert.ok(emitted.every(value=>value.owner==='1'.repeat(32)&&value.id===1),'one utterance identity');
  assert.deepEqual(early,{text:head,complete:false});
  assert.deepEqual(late,{text:full,complete:true});
  assert.equal(reply.continuous,true);
  assert.ok(clock.has('ttsSent')&&clock.has('firstPcm'));
});

test('a streamed reply gives both parts one reply-voice lock and the emotion marks, the tail with where it begins in the reply',async()=>{
  const {ReplyStream}=await import('./reply-stream.mjs');
  const {ReplyVoice}=await import('./cloud-reply-voice.mjs');
  const full='Get away from her right now, you hear me. Touch her again and I swear I will end you.';
  const stream=new ReplyStream({name:'Johnny'});
  stream.update('Get away from her right now, you hear me. Touch her again and I');
  const head=stream.head;assert.equal(head,'Get away from her right now, you hear me.');
  const marks=[{at:0,name:'anger',strength:'strong'},{at:full.indexOf('swear'),name:'fear',strength:'subtle'}];
  const seen=[];
  const pk=(index,offsetFrames)=>({...packet(index,offsetFrames),owner:'1'.repeat(32),id:1,profile:'johnny',modelSha256:'a'.repeat(64)});
  const voice={async synthesizeStream(key,text,{onPcm,reply,emotion}){seen.push({text,reply,emotion});await onPcm(pk(1,0));return{frames:9600};}};
  const speech={token:'t',published:true,ended:true,generated:true,frame(){},async fail(){}};
  const host={async playLocalPcm(config,produce){
    const run=produce(async()=>{},{signal:new AbortController().signal});
    await new Promise(done=>setTimeout(done,10));
    stream.finish(full,{emotionMarks:marks});
    const produced=await run;return{...produced,timing:{}};
  }};
  await deliverPocketSpeech({input,profile,result:{...result,text:head,emotionMarks:marks},current:async()=>true,voice,host,speech,stream});
  assert.equal(seen.length,2);
  assert.ok(seen[0].reply instanceof ReplyVoice&&seen[0].reply===seen[1].reply,'one lock for the reply');
  assert.deepEqual(seen[0].emotion,{marks});
  assert.equal(seen[1].text,'Touch her again and I swear I will end you.');
  assert.deepEqual(seen[1].emotion,{marks,from:full.indexOf('Touch')});
});

test('a streamed reply whose model fails after the first sentence ends with that sentence',async()=>{
  const {ReplyStream}=await import('./reply-stream.mjs');
  const stream=new ReplyStream({name:'Johnny'});
  stream.update('Hey V, good to see you here again. What can');
  const head=stream.head,emitted=[],calls=[];
  const voice={async synthesizeStream(key,text,{onPcm}){calls.push(text);await onPcm({...packet(1,0),owner:'1'.repeat(32),id:1,profile:'j',modelSha256:'a'.repeat(64)});return{frames:9600};}};
  const speech={token:'t',published:true,ended:true,generated:true,frame(){},async fail(){}};
  let late;
  const host={async playLocalPcm(config,produce,options){
    const run=produce(async value=>{emitted.push(value);},{signal:new AbortController().signal});
    await new Promise(done=>setTimeout(done,10));stream.fail(Error('network'));
    const produced=await run;late=options.liveText();return{...produced,timing:{}};
  }};
  const reply=await deliverPocketSpeech({input,profile,result:{...result,text:head},current:async()=>true,voice,host,speech,stream});
  assert.deepEqual(calls,[head]);assert.equal(emitted.length,1);assert.deepEqual(late,{text:head,complete:true});assert.equal(reply.continuous,true);
});
