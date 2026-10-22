import {test} from 'node:test';
import {runSpeech} from './speech-harness.mjs';

// Captions, text-only replies and the idle cost of mod/speech.lua with the real continuous adapter (bridge/speech-harness.mjs).
// The renderer's own states (gaps, pause, mute, unload, broken voice) are covered by bridge/continuous-speech.test.mjs.

test('captions keep the exact copy through playback, mute and a broken voice', () => runSpeech(`
 local function last()return captions.bindings[#captions.bindings]end
 assert(begin());snapshot({position=.2,text='Hello V.'});tick()
 assert(last().kind=='timed' and last().owner==judy and last().entity=='Judy-2' and last().text=='Hello V.')
 -- The player turns the voice off while it plays: the written copy is shown for the same speaker.
 voice=false;tick(.1)
 assert(speech.state=='muted' and last().kind=='show' and last().owner==judy and last().entity=='Judy-2' and last().text=='Hello V.')
 -- The voice breaks after it started: the complete written reply is shown for the same speaker.
 voice=true;assert(begin());snapshot({position=.2,text='Hello V.'});tick()
 snapshot({state='error',error='Worker stopped',position=.2,text='Hello V. And the rest.',textComplete=true});tick()
 assert(speech.state=='playback-failed' and last().kind=='show' and last().owner==judy and last().entity=='Judy-2')
 assert(last().text=='Hello V. And the rest.')
`));

test('text-only replies retain their target and dismissing another copy does not stop the speaker', () => runSpeech(`
 voice=false
 assert(not speech.start(context,{text='Hello V'}))
 assert(captions.bindings[1].owner==judy and captions.bindings[1].entity=='Judy-2' and captions.bindings[1].text=='Hello V')
 voice=true;assert(begin());snapshot();tick()
 speech.clearEntity('Judy-1');assert(speech.requestId=='conversation-1' and speech.target==judy)
 speech.clearEntity('Judy-2')
 assert(not speech.requestId and not speech.target and speech.state=='target-dismissed')
 assert(captions.cleared[#captions.cleared]=='Judy-2' and not control().allow)
`));

test('with nothing playing the speech update makes no game call between its two-second heartbeats', () => runSpeech(`
 players,nativeCalls=0,0
 for _=1,19 do speech.update(.1) end
 assert(players==0 and nativeCalls==0 and state()==nil,'a quiet frame made a game call or wrote the file: '..players)
 speech.update(.1)
 assert(state() and state().continuousAvailable==true and state().state=='idle','the heartbeat publishes the lease')
 assert(players==0 and nativeCalls==0,'the heartbeat itself needs no game call: '..players..' '..nativeCalls)
 local updated=state().updated
 for _=1,10 do speech.update(.1) end
 wall=wall+5
 assert(players==0 and nativeCalls==0 and state().updated==updated,'and nothing again until the next heartbeat')
`));
