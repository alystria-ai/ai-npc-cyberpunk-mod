import {PocketFacialStream} from './pocket-facial-stream.mjs';
import {throwIfCancelled} from './transport-pool.mjs';

// Dialogue/memory stays with the original Convai turn. Only its complete text
// is sent once to the local student; an independent PCM renderer starts from
// the prefix and owns the one device clock for face and subtitles.
export async function deliverPocketSpeech({input,profile,result,current,signal,voice,host,speech,lipsync,onAnalysis}) {
  const facial=new PocketFacialStream({input,lipsync,signal,expressionSignal:result.expressionSignal,onAnalysis});
  try {
    const generated=await host.playLocalPcm({token:speech.token,text:result.text,
      expressionSignal:result.expressionSignal,userText:result.userText},async(emit,{signal:localSignal})=>{
      const response=await voice.synthesizeStream(profile.key,result.text,{signal:localSignal,onPcm:packet=>{
        facial.push(packet);return emit(packet);
      }});
      facial.finish();return response;
    },{signal,current,onFrame:snapshot=>speech.frame(snapshot),
      getFace:snapshot=>facial.snapshot(snapshot.receivedFrames,snapshot.sourceComplete,snapshot.positionSeconds)});
    throwIfCancelled(signal);
    return {...result,continuous:true,transport:'realtime',timing:{...result.timing,...generated.timing},
      liveDelivery:{published:speech.published,ended:speech.ended,generated:speech.generated,id:speech.token}};
  } catch(error) {
    await speech.fail().catch(()=>{});throwIfCancelled(signal);
    if (speech.published) throw error;
    return {...result,audio:undefined,faces:[],captions:[],audioError:'Local voice is unavailable; showing the written reply.'};
  } finally {facial.close();}
}
