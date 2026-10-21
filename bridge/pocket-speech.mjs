import {PocketFacialStream} from './pocket-facial-stream.mjs';
import {throwIfCancelled} from './transport-pool.mjs';
import {BufferedPcm} from './group-lookahead.mjs';
import {markStage} from './turn-clock.mjs';
import {Utterance} from './voice-utterance.mjs';

// Dialogue/memory stays with the original Convai turn. Only its complete text
// is sent once to the local student; an independent PCM renderer starts from
// the prefix and owns the one device clock for face and subtitles.
// prefetched: optional BufferedPcm already synthesizing this exact text while the
// previous speaker was audible; its buffered packets are replayed in order first.
// voiceKey: the voice that speaks (a variant of an ambient profile, bridge/voice-variants.mjs); defaults to the profile's own.
// stream: optional ReplyStream (bridge/reply-stream.mjs). The reply is still being written: `result.text` is its first sentence
// (the head), which is voiced at once. When the reply is finished its rest (the tail) is voiced as the same utterance: it is
// synthesized as soon as it is known, buffered, and its packets continue the head's numbering under the head's identity. The
// subtitles and the face follow the text as it grows (snapshot text, PocketFacialStream.setText).
// One reply, one voice: the head's call decides the engine (an `Utterance`, bridge/voice-utterance.mjs) and the tail is spoken by
// that engine only. If the head was heard in the cloud voice and the tail cannot be had from it (after its second ask), the reply
// ends after the head (`voiceTailFailed`); it is never finished by Pocket.
export async function deliverPocketSpeech({input,profile,voiceKey=profile.key,result,current,signal,voice,host,speech,lipsync,phoneAnalysis,jaliFace,onAnalysis,prefetched,stream,language,capture}) {
  // The reply's language when it is not English (a voice language pack's clip for the Mistral voice; Pocket ignores it).
  const languageOption=language&&language!=='en'?{language}:{};
  const facial=new PocketFacialStream({input,lipsync,phoneAnalysis,jaliFace,signal,expressionSignal:result.expressionSignal,text:result.text,textComplete:!stream,onAnalysis});
  try {
    const generated=await host.playLocalPcm({token:speech.token,text:result.text,
      expressionSignal:result.expressionSignal,userText:result.userText},async(emit,{signal:localSignal})=>{
      let first=true,last=null;
      const feed=packet=>{
        if(first){first=false;markStage('firstPcm');}
        last={owner:packet.owner,id:packet.id,profile:packet.profile,modelSha256:packet.modelSha256,index:packet.index,
          offsetFrames:packet.offsetFrames,frames:packet.frames};
        // Developer mode only: the caller hands a capture, which keeps the last reply's audio (bridge/last-reply-capture.mjs). Nothing is held otherwise.
        capture?.push(packet);
        facial.push(packet);return emit(packet);
      };
      // The tail is synthesized (into memory) while the head is still being voiced or played.
      const utterance=new Utterance();
      const tail=stream?stream.finished.then(()=>stream.tail,()=>'').then(text=>{
        if(!text||localSignal.aborted)return null;
        // The feelings in force where the tail begins are marked for the voice (Expressive emotions; carried with the request, no current voice reads them).
        const full=stream.text,from=Math.max(0,full.indexOf(text,stream.head?.length??0));
        const emotion={marks:stream.meta?.emotionMarks,sounds:stream.meta?.voiceMarks,from};
        const buffered=new BufferedPcm({signal:localSignal,synthesize:(onPcm,options)=>voice.synthesizeStream(voiceKey,text,{...options,onPcm,utterance,role:'tail',emotion,...languageOption})});
        buffered.start();return buffered;
      }):null;
      tail?.catch(()=>{});
      markStage('ttsSent');
      let response;
      try{
        response=prefetched?await prefetched.drain(feed,{signal:localSignal})
          :await voice.synthesizeStream(voiceKey,result.text,{signal:localSignal,onPcm:feed,utterance,role:'head',emotion:{marks:result.emotionMarks,sounds:result.voiceMarks},...languageOption});
      }catch(error){utterance.decide('pocket');throw error;}
      utterance.settle(response);
      if(tail){
        const buffered=await tail;
        if(buffered&&response.truncated){
          // The first sentence's audio was cut: the rest would follow a gap in the sentence. The reply ends there.
          buffered.discard();
          response={...response,timing:{...response.timing,voiceTailSkipped:true}};
        }else if(buffered){
          if(!last)throw Error('The first sentence produced no audio');
          const base={...last};
          const continued=packet=>feed({...packet,owner:base.owner,id:base.id,profile:base.profile,modelSha256:base.modelSha256,
            index:base.index+packet.index,offsetFrames:base.offsetFrames+base.frames+packet.offsetFrames,
            startSeconds:(base.offsetFrames+base.frames+packet.offsetFrames)/24000});
          try{
            const rest=await buffered.drain(continued,{signal:localSignal});
            const frames=(response.frames??0)+(rest?.frames??0);
            response={...rest,...response,frames,chunks:(response.chunks??0)+(rest?.chunks??0),duration:frames/24000,
              timing:{...rest?.timing,...response.timing,voiceTailChars:stream.tail.length}};
          }catch(error){
            throwIfCancelled(localSignal);throwIfCancelled(signal);
            // The rest of the reply could not be voiced: what was spoken stands (the written reply is complete).
            buffered.discard();
            try{console.error(`[Voice] the rest of the reply could not be voiced (${String(error?.message??error).slice(0,120)}); it ends after the first sentence, the voice is not switched`);}catch{}
            response={...response,truncated:true,timing:{...response.timing,voiceTailFailed:true}};
          }
        }
      }
      facial.finish();return response;
    },{signal,current,onFrame:snapshot=>speech.frame(snapshot),
      // The game's lease wakes the clock poll (speech.options.wake, bridge/convai-continuous-speech.mjs).
      ...(typeof speech.options?.wake==='function'?{wake:()=>speech.options.wake()}:{}),
      ...(stream?{liveText:()=>({text:stream.text,complete:stream.complete})}:{}),
      getFace:snapshot=>{
        if(stream)facial.setText(snapshot.text,snapshot.textComplete);
        return facial.snapshot(snapshot.receivedFrames,snapshot.sourceComplete,snapshot.positionSeconds);
      }});
    throwIfCancelled(signal);
    return {...result,continuous:true,transport:'realtime',timing:{...result.timing,...generated.timing},
      liveDelivery:{published:speech.published,ended:speech.ended,generated:speech.generated,id:speech.token}};
  } catch(error) {
    await speech.fail().catch(()=>{});throwIfCancelled(signal);
    if (speech.published) throw error;
    return {...result,audio:undefined,faces:[],captions:[],audioError:'Local voice is unavailable; showing the written reply.'};
  } finally {await facial.close();capture?.finish();}
}
