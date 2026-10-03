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
      snapshot.face=options.getFace(snapshot);const control=await options.onFrame(snapshot);
      assert.equal(control.allow,true);
      spoken.push(value);
      if(spoken.length===1)assert.equal(replies.length,1,'first prefix is admitted before source completion');
    },{signal:controller.signal});
    const final={version:1,token:config.token,sampleRate:24000,channels:1,receivedFrames,positionSeconds:receivedFrames/24000,
      text:config.text,textComplete:true,sourceComplete:true,ended:true,underruns:0,state:'draining'};
    final.face=options.getFace(final);await options.onFrame(final);return {...produced,timing:{voiceProvider:'pocket',firstPcmMs:140}};
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
