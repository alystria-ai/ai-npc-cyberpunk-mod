import {test} from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {RealtimeHost,continuousSnapshotForHost} from './realtime-host.mjs';

// Exercise the installed host/browser seam without SDK/provider calls, audio,
// microphone access or GPU work. The reply uses a large valid public facial
// snapshot and cannot finish before the host has authorized three frames.
test('real GPU-disabled browser transports a large facial timeline through the actual host and final drain',
  {timeout:180000},async()=>{
    const browser=await chromium.launch({channel:'msedge',headless:true,
      args:['--disable-gpu','--mute-audio','--disable-background-timer-throttling']});
    try{
      const page=await browser.newPage();await page.goto('about:blank');
      await page.route('**/*',route=>route.abort());
      await page.evaluate(()=>{
        const faces=Array.from({length:481},(_,index)=>({at:index/60,
          values:Array.from({length:61},(_,column)=>(column+index)%101/200)}));
        window.offline={controls:0,token:null,finished:false,faces};
        window.convaiRealtime={
          reply:config=>{window.offline.token=config.liveSpeechToken;
            return new Promise(resolve=>{window.offline.complete=resolve;});},
          continuousSnapshot:token=>{
            const state=window.offline;if(token!==state.token)return null;
            return {version:1,token,positionSeconds:state.finished?8:state.controls/10,
              sampleRate:24000,channels:1,receivedFrames:192000,state:state.finished?'ended':'playing',
              ended:state.finished,sourceComplete:true,textComplete:true,text:'Offline',underruns:0,error:null,
              faces:state.faces,facesFormat:'arkit61',facesTimebase:'audio-seconds'};
          },
          continuousControl:(token,control)=>{
            if(token!==window.offline.token||control.allow!==true)throw Error('Wrong offline admission');
            window.offline.controls++;
            if(window.offline.controls>=3){window.offline.finished=true;window.offline.complete({streamed:true});}
            return true;
          },
        };
      });
      assert.equal(await continuousSnapshotForHost(page,'not-present'),null);
      const expected=Array.from({length:481},(_,index)=>({at:index/60,
        values:Array.from({length:61},(_,column)=>(column+index)%101/200)}));
      const host=new RealtimeHost();let frames=0,last;
      const result=await host.evaluateSpeech(page,'reply',{ttsEnabled:true},{liveSpeech:{token:'offline-owned',
        onFrame:async value=>{
          frames++;last=value;
          assert.equal(value.token,'offline-owned');assert.deepEqual(value.faces,expected);
          return {allow:true,paused:false,volume:1,pan:0};
        }}});
      assert.equal(result.streamed,true);assert.ok(frames>=4);
      assert.equal(last.ended,true);assert.equal(last.positionSeconds,8);
      assert.equal(await page.evaluate(()=>window.offline.controls),3);

      // Cancel the actual browser seam while its frame callback is suspended.
      await page.evaluate(()=>{window.offline.controls=0;window.offline.finished=false;});
      let release,entered;
      const gate=new Promise(resolve=>{release=resolve;});
      const ready=new Promise(resolve=>{entered=resolve;});
      const abort=new AbortController();
      const pending=host.evaluateSpeech(page,'reply',{ttsEnabled:true},{signal:abort.signal,
        liveSpeech:{token:'offline-cancelled',onFrame:async()=>{entered();await gate;
          return {allow:true,paused:false,volume:1,pan:0};}}});
      pending.catch(()=>{});await ready;abort.abort();
      await assert.rejects(pending,{name:'AbortError'});release();
      await new Promise(resolve=>setTimeout(resolve,60));
      assert.equal(await page.evaluate(()=>window.offline.controls),0,'cancelled callback sent late admission');
      await page.evaluate(()=>window.offline.complete({cancelled:true}));
    }finally{await browser.close();}
  });
