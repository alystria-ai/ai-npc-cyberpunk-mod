import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {journalContext} from './quest-context.mjs';
import {worldRulesContext} from './world-rules.mjs';
import {endUserOptions, transportKey, SessionBindings} from './transport-pool.mjs';
import {ConvaiDataAudio} from './convai-data-audio.mjs';
import {AnalysisPcm} from './analysis-pcm.mjs';
import {ConvaiEmotion} from './convai-emotion.mjs';
import {CompanionActionWindow, publishCompanionActionContext, chauffeurActionName} from './companion-actions.mjs';
import {ConvaiVision, visionConnectOptions, visionIdentity, visionWaitCap, VISION_NOTE} from './convai-vision.mjs';

const source = readFileSync(new URL('./realtime-client.mjs', import.meta.url), 'utf8')
  .replace("import {ConvaiClient} from '@convai/web-sdk/vanilla';", '')
  .replace("import {endUserOptions, transportKey, SessionBindings} from './transport-pool.mjs';", '')
  .replace("import {ConvaiDataAudio} from './convai-data-audio.mjs';", '')
  .replace("import {ContinuousPcmPlayer} from './continuous-pcm-player.mjs';", '')
  .replace("import {AnalysisPcm} from './analysis-pcm.mjs';", '')
  .replace("import {ConvaiEmotion} from './convai-emotion.mjs';", '')
  .replace("import {CompanionActionWindow, publishCompanionActionContext, chauffeurActionName} from './companion-actions.mjs';", '')
  .replace("import {ConvaiVision, visionConnectOptions, visionIdentity, visionWaitCap, VISION_NOTE} from './convai-vision.mjs';", '')
  .replace("import {PcmRelay} from './pcm-relay.mjs';", '');
const flush = () => new Promise(done => setImmediate(done));
// Waits for a state to hold. The ceiling is reached only by a hung test (a fixed count of short polls is a wall-clock limit in disguise).
async function until(predicate, label) {
  for (const deadline = Date.now() + 60_000; !predicate();) {
    if (Date.now() > deadline) assert.fail('timed out waiting for ' + label);
    await new Promise(done => setTimeout(done, 10));
  }
}
test('the world rules reach Convai in the dynamic info the turn already sends: after everything else in it, replacing the last one', async () => {
  const {api, events} = fixture();
  await api.warm(config);
  const rules = 'Nobody in Night City knows V’s name unless V tells them.';
  const context = 'CURRENT PERSON\nQuest facts here.\n\n' + worldRulesContext(rules);
  const pending = api.reply({...config, context}); pending.catch(() => {});
  await flush();
  const row = events.find(event => event[0] === 'context')[1];
  assert.equal(row.mode, 'replace'); assert.equal(row.run_llm, 'false');
  assert(row.text.startsWith('You are speaking to V in Night City.'));
  assert(row.text.indexOf('Quest facts here.') < row.text.indexOf('World rules set by the player'));
  assert(row.text.endsWith(rules), 'the player\'s words are the end of the dynamic info');
  await api.close(); await assert.rejects(pending, /cancelled/);
});

function manualTimers() {
  let now = 0, nextId = 0;
  const pending = new Map();
  return {
    pending,
    setTimeout(callback, delay) { const id = ++nextId; pending.set(id, {callback, due: now + delay}); return id; },
    clearTimeout(id) { pending.delete(id); },
    advance(milliseconds) {
      now += milliseconds;
      for (const [id, timer] of [...pending]) if (timer.due <= now) { pending.delete(id); timer.callback(); }
    }
  };
}
function fixture({emitAudio, onCompanionAction, onPublish, allowMic = false, timers, onConnect, onDisconnect, onDisableAudio, botReady = true, player, clock, visionClass = ConvaiVision, events = [], onEnableAudio, relayClass, navigator} = {}) {
  const clients = [];
  class Client {
    constructor(options) {
      this.options = options; this.characterId = options.characterId;
      this.characterSessionId = 'session-' + clients.length; this.handlers = new Map();
      this.chatMessages = []; this.state = {endUserId: options.endUserId || null}; this.blendshapeQueue = {length: 0, getPlaybackFps: () => 30, isConversationEnded: () => false};
      this.peer = {identity: 'convai-bot-' + clients.length, sid: 'different-participant-sid'};
      this.roomHandlers = new Map();
      this.room = {on: (name, callback) => this.roomHandlers.set(name, callback),
        startAudio: async () => { throw Error('Browser playback must not start'); },
        remoteParticipants: new Map([[this.peer.identity, this.peer]]),
        localParticipant: {sid: 'local-participant', publishData: async (bytes, options) => {
          events.push(['publish', JSON.parse(new TextDecoder().decode(bytes)), options]);
          await onPublish?.(this);
        }, audioTrackPublications: new Map(), unpublishTrack: async () => this.room.localParticipant.audioTrackPublications.clear()}};
      this.audioControls = {disableAudio: async () => {
        if (allowMic) events.push('microphone-disable');
        await onDisableAudio?.(this);
      }, enableAudio: async () => {
        events.push('microphone');
        if (onEnableAudio) { await onEnableAudio(this); return; }
        if (allowMic) {
          const track = {readyState: 'live', label: 'fixture microphone', stop() {
            if (this.readyState !== 'ended') events.push('microphone-stop');
            this.readyState = 'ended';
          }};
          this.room.localParticipant.audioTrackPublications.set('mic', {source: 'microphone', isMuted: false,
            track: {mediaStreamTrack: track}});
        }
      }};
      clients.push(this);
    }
    on(name, callback) { this.handlers.set(name, callback); }
    data(message, options = {}) {
      const participant = Object.hasOwn(options, 'participant') ? options.participant : this.peer;
      this.roomHandlers.get('dataReceived')?.(message instanceof Uint8Array ? message
        : new TextEncoder().encode(JSON.stringify(message)), participant, options.kind ?? 0);
    }
    async connect() {
      await onConnect?.(this); this.isBotReady = true;
      if (botReady) this.data({label: 'rtvi-ai', type: 'bot-ready', data: {}});
    }
    async disconnect() {
      this.isBotReady = false;
      if (allowMic) events.push(['disconnect', clients.indexOf(this)]);
      await onDisconnect?.(this);
    }
    sendInterruptMessage() { if (allowMic) events.push(['interrupt', clients.indexOf(this)]); }
    updateContext(config) { events.push(['context', config]); }
    sendUserTextMessage(text) { events.push(['message', text]); }
    sendTriggerMessage(name, text) { events.push(['trigger', name, text]); }
    resetIdleTimer() { events.push('idle-reset'); }
    toggleStt() {}
  }
  class ForbiddenAudio { constructor() { throw Error('Browser audio recapture must not be used'); } }
  const window = {__convaiAudioChunk: emitAudio, __convaiCompanionAction: onCompanionAction};
  runInNewContext(source, {ConvaiClient: Client, AudioContext: ForbiddenAudio, AudioWorkletNode: ForbiddenAudio,
    endUserOptions, transportKey, SessionBindings, ConvaiDataAudio, AnalysisPcm, ConvaiEmotion, TextDecoder, TextEncoder,
    CompanionActionWindow, publishCompanionActionContext, chauffeurActionName,
    ConvaiVision: visionClass, visionConnectOptions, visionIdentity, visionWaitCap, VISION_NOTE,
    ContinuousPcmPlayer: player || ForbiddenAudio, PcmRelay: relayClass, navigator,
    window, performance: clock ?? performance, setTimeout: timers?.setTimeout ?? setTimeout, clearTimeout: timers?.clearTimeout ?? clearTimeout,
    setInterval, clearInterval,
    btoa: data => Buffer.from(data, 'binary').toString('base64')});
  return {api: window.convaiRealtime, clients, events};
}
const config = {key: 'test-key', characterId: 'alex', scope: 'group:alex,panam', text: 'Hello'};
const wire = data => ({label: 'rtvi-ai', type: 'server-message', data});
function audioFixture({seconds = .4, sequence = 1, sampleRate = 8000} = {}) {
  const fps = 60, samples = Buffer.alloc(Math.round(seconds * sampleRate) * 2);
  for (let i = 0; i < samples.length / 2; i++) samples.writeInt16LE([-32768, -1, 0, 1, 32767][i % 5], i * 2);
  const owner = {response_id: 'speech-' + sequence, neurosync_turn_id: sequence, epoch: 1};
  const frameCount = Math.round(seconds * fps);
  return {samples, owner,
    pcm: (bytes = samples) => wire({type: 'audio-data', audio: bytes.toString('base64'), sample_rate: sampleRate,
      channels: 1, includes_wav_header: false}),
    faces: wire({type: 'chunked-neurosync-blendshapes', ...owner, start_frame_index: 0, fps,
      blendshapes: Array.from({length: frameCount}, (_, i) => Array(61).fill(i / frameCount))}),
    stats: wire({type: 'blendshape-turn-stats', ...owner, sequence: 19, stats: {
      total_audio_bytes: samples.length, total_audio_duration_ms: seconds * 1000,
      total_blendshapes: frameCount, fps, was_interrupted: false}}),
    terminal: wire({type: 'bot-turn-completed', ...owner, sequence: 18, was_interrupted: false})};
}
function finalText(client, text = 'Hello V.', id = 'reply') {
  const rows = [...client.chatMessages, {id, type: 'bot-llm-text', content: text, isStreaming: false}];
  client.chatMessages = rows; client.state.isThinking = false;
  client.handlers.get('messagesChange')(rows);
}
function sendAudio(client, audio = audioFixture()) {
  client.data(audio.faces); client.data(audio.pcm()); client.data(audio.stats); client.data(audio.terminal);
  return audio;
}

const chauffeurConfig = (sequence = 1, source = 'private-text') => ({...config, scope: 'private:world:fixture',
  endUserId: 'fixture-user', ttsEnabled: false,
  companionAction: {version: 1, token: 'drive-' + String(sequence).padStart(20, '0'), source,
    expiresAt: Date.now() + 89000}});
const chauffeurAction = request => wire({type: 'action-response',
  actions: [{name: 'Drive To Waypoint', target: request.companionAction.token}]});

test('an empty provider proposal keeps the driving offer and exposes only anonymous action diagnostics', async () => {
  const accepted = [], {api, clients, events} = fixture({onCompanionAction: value => accepted.push(value)});
  const request = chauffeurConfig();
  request.companionAction.carName = 'Porsche'; request.companionAction.destinationName = 'Custom waypoint';
  await api.warm(request);
  const reply = api.reply(request); await flush(); const client = clients[0];
  const context = events.find(row => row[0] === 'publish')[1].data.text;
  assert.match(context, /"Porsche"/); assert.match(context, /"Custom waypoint"/);
  assert.match(context, /do not ask where to go/);
  client.data(wire({type: 'action-response', actions: []}));
  let diagnostic = api.diagnostics().actions;
  assert.equal(diagnostic.windowActive, true); assert.equal(diagnostic.lastProposal.count, 0);
  client.data(chauffeurAction(request)); await flush();
  diagnostic = api.diagnostics().actions;
  assert.equal(accepted.length, 1); assert.equal(diagnostic.lastProposal.targetMatches, true);
  const redacted = JSON.stringify(diagnostic);
  for (const value of [request.key, request.characterId, request.endUserId, request.companionAction.token,
    request.companionAction.carName, request.companionAction.destinationName]) assert.ok(!redacted.includes(value));
  finalText(client); await reply; await api.close();
});

test('targetless wire action needs the advertised request name, reliable pinned provider and exact current window', async () => {
  const accepted = [], {api, clients, events} = fixture({onCompanionAction: value => accepted.push(value)});
  const first = chauffeurConfig(); await api.warm(first);
  const reply = api.reply(first); await flush(); const client = clients[0];
  const proposal = request => wire({type: 'action-response', actions: [{name: chauffeurActionName(request.companionAction)}]});
  client.data(proposal(first), {kind: 1});
  client.data(proposal(first), {participant: {identity: client.peer.identity}});
  client.data(wire({type: 'action-response', actions: [{name: 'Drive To Waypoint'}]}));
  assert.equal(accepted.length, 0);
  client.data(proposal(first)); await flush();
  assert.equal(accepted.length, 1); assert.equal(accepted[0].token, first.companionAction.token);
  assert.equal(api.diagnostics().actions.lastProposal.boundNameMatches, true);
  client.data(proposal(first)); assert.equal(accepted.length, 1);
  finalText(client); await reply;
  const next = chauffeurConfig(2), second = api.reply(next); await flush();
  assert.deepEqual(events.filter(row => row[0] === 'publish').at(-1)[1].data.action_config.actions,
    [chauffeurActionName(next.companionAction)]);
  client.data(proposal(first)); assert.equal(accepted.length, 1);
  client.data(proposal(next)); await flush(); assert.equal(accepted.length, 2);
  finalText(client, 'Next.', 'reply-2'); await second; await api.close();
});

test('private action uses one silent reliable context update and supports late Omni delivery without reconnect or audio delay', async () => {
  const accepted = [], {api, clients, events} = fixture({onCompanionAction: value => accepted.push(value)});
  const request = chauffeurConfig(); await api.warm(request);
  const reply = api.reply(request); await flush();
  const client = clients[0], contextIndex = events.findIndex(row => row[0] === 'publish');
  assert.ok(contextIndex >= 0); assert.ok(contextIndex < events.findIndex(row => row[0] === 'message'));
  assert.equal(events[contextIndex][1].type, 'context-update');
  assert.equal(events[contextIndex][1].data.run_llm, 'false');
  assert.equal(events[contextIndex][2].reliable, true);
  assert.deepEqual(events[contextIndex][1].data.action_config.actions, [chauffeurActionName(request.companionAction)]);
  assert.equal(events.filter(row => row[0] === 'message').length, 1);
  finalText(client, 'Let me check the car.');
  const result = await reply;
  assert.equal(result.text, 'Let me check the car.'); assert.equal(accepted.length, 0);
  // Text-only collection is complete; its one-use target still owns this late
  // independent action event without delaying the user's local speech.
  client.data(chauffeurAction(request)); client.data(chauffeurAction(request));
  await flush();
  assert.equal(accepted.length, 1); assert.equal(accepted[0].token, request.companionAction.token);
  const second = api.reply(chauffeurConfig(2)); await flush();
  assert.equal(clients.length, 1, 'ordinary conversation keeps the warmed connection');
  finalText(client, 'Second reply.', 'reply-2'); await second; await api.close();
});

test('legacy action rejects missing target, unrelated source, malformed batch and old request target', async () => {
  const accepted = [], {api, clients} = fixture({onCompanionAction: value => accepted.push(value)});
  const first = chauffeurConfig(); await api.warm(first);
  const reply = api.reply(first); await flush(); const client = clients[0];
  client.data(wire({type: 'action-response', actions: [{name: 'Drive To Waypoint'}]}));
  client.data(chauffeurAction(first), {kind: 1});
  client.data(chauffeurAction(first), {participant: {identity: client.peer.identity}});
  client.data({...chauffeurAction(first), label: 'unrelated'});
  client.data({type: 'action-response', actions: [{name: 'Drive To Waypoint', target: first.companionAction.token}]});
  client.data(wire({type: 'action-response', actions: [{name: 'Drive To Waypoint', target: first.companionAction.token,
    kind: 'tool_call'}]}));
  client.state.endUserId = 'another-user'; client.data(chauffeurAction(first));
  client.state.endUserId = first.endUserId;
  client.characterId = 'another-character'; client.data(chauffeurAction(first));
  client.characterId = first.characterId;
  assert.equal(accepted.length, 0); assert.equal(client.handlers.has('actionResponse'), false);
  finalText(client); await reply;
  const next = chauffeurConfig(2), second = api.reply(next); await flush();
  client.data(chauffeurAction(first)); assert.equal(accepted.length, 0);
  client.data({label: 'rtvi-ai', type: 'action-response', data: chauffeurAction(next).data});
  await flush();
  assert.equal(accepted.length, 1); assert.equal(accepted[0].token, next.companionAction.token);
  finalText(client, 'Second.', 'reply-2'); await second; await api.close();
});

test('groups, phone, reactions, unpinned Omni and cancelled turns cannot deliver actions', async () => {
  for (const variant of ['group', 'phone', 'reaction', 'unpinned', 'cancel']) {
    const accepted = [], request = chauffeurConfig();
    if (variant === 'group') request.scope = 'group:judy,panam';
    if (variant === 'phone') request.scope = 'phone:world:fixture';
    if (variant === 'reaction') request.reaction = {phase: 'after'};
    const {api, clients} = fixture({botReady: variant !== 'unpinned', onCompanionAction: value => accepted.push(value)});
    await api.warm(request);
    const reply = api.reply(request); await flush(); const client = clients[0];
    if (variant === 'cancel') {
      const rejected = assert.rejects(reply, /cancelled/); await api.close();
      client.data(chauffeurAction(request)); await rejected;
    } else {
      client.data(chauffeurAction(request)); finalText(client); await reply; await api.close();
    }
    assert.equal(accepted.length, 0, variant);
  }
});

test('owned terminal closes late proposal admission and next ordinary turn clears advertised affordances', async () => {
  const accepted = [], {api, clients, events} = fixture({onCompanionAction: value => accepted.push(value)});
  const request = chauffeurConfig(); await api.warm(request);
  const reply = api.reply(request); await flush(); const client = clients[0];
  client.data(wire({type: 'bot-llm-started', response_id: 'owned-response'}));
  client.data(wire({type: 'bot-turn-completed', response_id: 'owned-response', was_interrupted: false}));
  finalText(client); await reply; client.data(chauffeurAction(request)); assert.equal(accepted.length, 0);
  const {companionAction: _, ...ordinary} = request;
  const second = api.reply(ordinary); await flush();
  const last = events.filter(row => row[0] === 'publish').at(-1)[1].data;
  assert.deepEqual(last.action_config.actions, []); assert.deepEqual(last.action_config.objects, []);
  assert.equal(last.current_attention_object, '');
  client.data(chauffeurAction(request)); assert.equal(accepted.length, 0);
  finalText(client, 'Next ordinary turn.', 'reply-2'); await second; await api.close();
});

test('private voice offers are armed only at the verified finish with refreshed native context', async () => {
  const accepted = [], {api, clients, events} = fixture({allowMic: true, onCompanionAction: value => accepted.push(value)});
  const request = chauffeurConfig(1, 'private-voice');
  await api.beginVoice(request); const client = clients[0];
  client.data(chauffeurAction(request)); assert.equal(accepted.length, 0);
  assert.equal(events.some(row => row[0] === 'publish'), false);
  const finished = api.finishVoice(request); await flush();
  assert.ok(events.findIndex(row => row[0] === 'publish') < events.indexOf('microphone-disable'));
  client.data(chauffeurAction(request)); await flush(); assert.equal(accepted.length, 1);
  finalText(client); await finished; await api.close();
});

test('a cancelled pending action-context publication cannot send a user turn to a replacement connection', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const {api, clients, events} = fixture({onPublish: () => gate});
  const request = chauffeurConfig(); await api.warm(request);
  const reply = api.reply(request), rejected = assert.rejects(reply, /context update cancelled/); await flush();
  await api.close();
  await api.warm({...request, characterId: 'replacement'});
  release(); await rejected;
  assert.equal(clients.length, 2); assert.equal(events.some(row => row[0] === 'message'), false);
  await api.close();
});

test('a connection opens with the sign-in backend token when the bridge supplies one, else with the key', async () => {
  const {api, clients} = fixture();
  const {key, ...withoutKey} = config;
  await api.warm({...withoutKey, authToken: 'fixture-token-not-a-secret', ttsEnabled: false});
  assert.equal(clients[0].options.authToken, 'fixture-token-not-a-secret');
  assert.equal(Object.hasOwn(clients[0].options, 'apiKey'), false, 'a token connection carries no API key');
  await api.close();
  await api.warm({...config, ttsEnabled: false});
  assert.equal(clients[1].options.apiKey, 'test-key');
  assert.equal(Object.hasOwn(clients[1].options, 'authToken'), false);
  await api.close();
});

test('emotion detection is enabled without changing the voice route or forcing generation mood',async()=>{
  const {api,clients,events}=fixture();await api.warm({...config,ttsEnabled:false});
  assert.equal(clients[0].options.enableEmotion,true);
  assert.equal(clients[0].options.emotionConfig.provider,'llm');
  assert.equal(clients[0].options.ttsEnabled,false);
  assert.equal(clients[0].options.enableLipsync,false);
  assert.equal(Object.hasOwn(clients[0].options,'stateOfMind'),false);
  assert.equal(events.some(row=>row[0]==='message'),false);await api.close();
});

test('raw reliable owned emotion reaches the native Convai result without leaking transport owner IDs',async()=>{
  const {api,clients}=fixture();await api.warm(config);
  const pending=api.reply(config);await flush();const c=clients[0],data=audioFixture();
  c.data(data.faces);
  c.data({label:'rtvi-ai',type:'bot-emotion',data:{...data.owner,emotion:'Grief',scale:2}});
  c.data(data.pcm());c.data(data.stats);c.data(data.terminal);finalText(c);
  const result=await pending;
  assert.deepEqual(JSON.parse(JSON.stringify(result.expressionSignal)),
    {version:1,correlated:true,sequence:0,emotion:'Grief',scale:2,basis:'response-id'});
  assert.equal(JSON.stringify(result.expressionSignal).includes(data.owner.response_id),false);
  assert.equal(api.diagnostics().wire.acceptedEmotionEvents,1);await api.close();
});

test('stale, foreign, unreliable and malformed emotion cannot delay or fail speech',async()=>{
  const {api,clients}=fixture();await api.warm(config);
  const pending=api.reply(config);await flush();const c=clients[0],data=audioFixture();c.data(data.faces);
  for (const [body,options] of [
    [{...data.owner,response_id:'old-response',emotion:'Joy',scale:3},{}],
    [{...data.owner,emotion:'Joy',scale:3},{kind:1}],
    [{...data.owner,emotion:'Joy',scale:3},{participant:{identity:c.peer.identity}}],
    [{...data.owner,emotion:'Joy',scale:.5},{}],
  ]) c.data({label:'rtvi-ai',type:'bot-emotion',data:body},options);
  c.handlers.get('emotionChange')?.({emotion:'Joy',scale:3});
  c.data(data.pcm());c.data(data.stats);c.data(data.terminal);finalText(c);
  const result=await pending;assert.equal(result.expressionSignal,undefined);
  assert.equal(result.text,'Hello V.');assert.equal(c.isBotReady,true);
  assert.equal(api.diagnostics().wire.skippedEmotionEvents,4);await api.close();
});

// Live Convai (October 5) sends one bot-emotion per voiced turn without any
// response or turn id; the reliable ordered channel ties it to the response
// whose own audio owner has already arrived and whose terminal has not.
test('one id-less emotion between this response owner and its terminal is admitted; others are not',async()=>{
  const {api,clients}=fixture();await api.warm(config);
  let pending=api.reply(config);await flush();let c=clients[0],data=audioFixture({sequence:1});
  c.data({label:'rtvi-ai',type:'bot-emotion',data:{emotion:'Joy',scale:2}});
  c.data(data.faces);c.data(data.pcm());c.data(data.stats);c.data(data.terminal);finalText(c,'Reply 1.','r1');
  assert.equal((await pending).expressionSignal,undefined,'before this response owner or its text is known');
  pending=api.reply(config);await flush();data=audioFixture({sequence:2});
  c.data(data.faces);c.data({label:'rtvi-ai',type:'bot-emotion',data:{emotion:'Grief',scale:2}});
  c.data(data.pcm());c.data(data.stats);c.data(data.terminal);finalText(c,'Reply 2.','r2');
  assert.deepEqual(JSON.parse(JSON.stringify((await pending).expressionSignal)),
    {version:1,correlated:true,sequence:0,emotion:'Grief',scale:2,basis:'ordered'});
  pending=api.reply(config);await flush();data=audioFixture({sequence:3});
  c.data(data.faces);c.data({label:'rtvi-ai',type:'bot-emotion',data:{emotion:'Joy',scale:1}});
  c.data({label:'rtvi-ai',type:'bot-emotion',data:{emotion:'Anger',scale:3}});
  c.data(data.pcm());c.data(data.stats);c.data(data.terminal);finalText(c,'Reply 3.','r3');
  assert.equal((await pending).expressionSignal,undefined,'two id-less events in one response are ambiguous');
  // As observed live: the label follows this turn's reply text, before audio.
  pending=api.reply(config);await flush();data=audioFixture({sequence:9});
  c.chatMessages=[...c.chatMessages,{id:'early',type:'bot-llm-text',content:'Calm down.',isStreaming:true}];
  c.handlers.get('messagesChange')(c.chatMessages);
  c.data({label:'rtvi-ai',type:'bot-emotion',data:{emotion:'Interest',scale:1}});
  c.data(data.faces);c.data(data.pcm());c.data(data.stats);c.data(data.terminal);
  c.chatMessages=c.chatMessages.map(row=>row.id==='early'?{...row,isStreaming:false}:row);c.state.isThinking=false;
  c.handlers.get('messagesChange')(c.chatMessages);
  assert.equal((await pending).expressionSignal?.emotion,'Interest');
  pending=api.reply(config);await flush();data=audioFixture({sequence:4});
  c.data(data.faces);c.data(data.pcm());c.data(data.stats);c.data(data.terminal);
  c.data({label:'rtvi-ai',type:'bot-emotion',data:{emotion:'Joy',scale:1}});finalText(c,'Reply 4.','r4');
  assert.equal((await pending).expressionSignal,undefined,'after the response terminal');
  await api.close();
});

test('Omni text generation admits emotion only after its explicit raw LLM response owner and rejects retired turns',async()=>{
  const {api,clients}=fixture();const cfg={...config,ttsEnabled:false};await api.warm(cfg);
  const first=api.reply(cfg);await flush();const c=clients[0];
  c.data({label:'rtvi-ai',type:'bot-llm-started',data:{response_id:'llm-one',epoch:2}});
  c.data(wire({type:'bot-emotion',response_id:'llm-one',epoch:2,emotion:'Trust',scale:1}));
  finalText(c);assert.equal((await first).expressionSignal.emotion,'Trust');
  const second=api.reply(cfg);await flush();
  c.data({label:'rtvi-ai',type:'bot-llm-started',data:{response_id:'llm-one',epoch:2}});
  c.data(wire({type:'bot-emotion',response_id:'llm-one',epoch:2,emotion:'Joy',scale:3}));
  finalText(c,'Next reply.','next');assert.equal((await second).expressionSignal,undefined);
  const third=api.reply(cfg);await flush();
  c.data({label:'rtvi-ai',type:'bot-llm-started',data:{response_id:'llm-three',epoch:2}});
  c.data(wire({type:'bot-emotion',response_id:'llm-three',epoch:2,emotion:'Unknown mood',scale:1}));
  finalText(c,'Third reply.','third');assert.equal((await third).expressionSignal.emotion,'Unknown mood');
  await api.close();
});

// Live October 8 probe: a text-only (local voice) turn gets its one id-less bot-emotion 0.3-0.6 s after its text is
// complete, after reply() has returned. It is held for that turn until the next reply's LLM starts.
test('a text-only reply returns a late-emotion token; its one id-less emotion before the next reply is readable later',async()=>{
  const {api,clients}=fixture();const cfg={...config,ttsEnabled:false};await api.warm(cfg);
  const late=token=>JSON.parse(JSON.stringify(api.lateEmotion(token)));
  const first=api.reply(cfg);await flush();const c=clients[0];finalText(c,'Some days are easier.','one');
  const done=await first;assert.equal(done.expressionSignal,undefined);assert.ok(Number.isSafeInteger(done.lateEmotionToken));
  assert.deepEqual(late(done.lateEmotionToken),{pending:true});
  c.data({label:'rtvi-ai',type:'bot-emotion',data:{emotion:'Sadness',scale:2}});
  assert.deepEqual(late(done.lateEmotionToken),
    {signal:{version:1,correlated:true,sequence:0,emotion:'Sadness',scale:2,basis:'ordered'}});
  assert.deepEqual(late(done.lateEmotionToken+1),{},'another token reads nothing');
  // A second ownerless event for the same turn is ambiguous: nothing is readable.
  const second=api.reply(cfg);await flush();finalText(c,'Next reply.','two');const next=await second;
  c.data({label:'rtvi-ai',type:'bot-emotion',data:{emotion:'Joy',scale:1}});
  c.data({label:'rtvi-ai',type:'bot-emotion',data:{emotion:'Anger',scale:3}});
  assert.deepEqual(late(next.lateEmotionToken),{});
  assert.deepEqual(late(done.lateEmotionToken),{},'a newer reply retires the older holder');
  // The next reply's LLM start closes the holder: a later event is not given to the finished turn.
  const third=api.reply(cfg);await flush();finalText(c,'Third.','three');const last=await third;
  c.data({label:'rtvi-ai',type:'bot-llm-started',data:{}});
  c.data({label:'rtvi-ai',type:'bot-emotion',data:{emotion:'Fear',scale:1}});
  assert.deepEqual(late(last.lateEmotionToken),{});
  await api.close();
});

test('cancelled connection emotion cannot cross into a replacement copy or turn',async()=>{
  const {api,clients,events}=fixture();await api.warm(config);const first=api.reply(config);first.catch(()=>{});await flush();
  const retired=clients[0],data=audioFixture();retired.data(data.faces);
  await api.close('Owner dismissed');await assert.rejects(first,/Owner dismissed/);
  const next=api.reply(config);await flush();// The replacement turn has begun once it has sent its message (the first turn sent one before it was cancelled).
  await until(()=>events.filter(event=>event[0]==='message').length===2,'the replacement turn to send its message');
  const active=clients[1];assert.ok(active);
  retired.data(wire({type:'bot-emotion',...data.owner,emotion:'Joy',scale:3}));
  sendAudio(active,audioFixture({sequence:2}));finalText(active);
  assert.equal((await next).expressionSignal,undefined);await api.close();
});

test('owned emotion arriving after provider completion is visible while continuous audio drains',async()=>{
  const {Player,instances}=playerFixture();const {api,clients}=fixture({player:Player});await api.warm(config);
  const pending=api.reply({...config,liveSpeechToken:'expression-drain'});await flush();
  const c=clients[0],data=sendAudio(c);finalText(c);await new Promise(done=>setTimeout(done,80));
  assert.equal(api.continuousSnapshot('expression-drain').sourceComplete,true);
  c.data({label:'rtvi-ai',type:'bot-emotion',data:{...data.owner,emotion:'Fear',scale:2}});
  assert.equal(api.continuousSnapshot('expression-drain').expressionSignal.emotion,'Fear');
  assert.equal(instances[0].state.ended,false);
  instances[0].drain();assert.equal((await pending).expressionSignal.emotion,'Fear');
  c.data({label:'rtvi-ai',type:'bot-emotion',data:{...data.owner,emotion:'Joy',scale:3}});
  assert.equal(api.continuousSnapshot('expression-drain').expressionSignal.emotion,'Fear');
  await api.close();
});

test('automatic reactions send a game trigger without inventing a player utterance', async () => {
  const {api, events} = fixture();
  await api.warm({...config, ttsEnabled: false});
  const pending = api.reply({...config, ttsEnabled: false, reaction: {kind: 'battle', phase: 'start'}});
  pending.catch(() => {});
  await flush();
  assert.equal(events.some(row => row[0] === 'message'), false);
  assert.deepEqual(events.find(row => row[0] === 'trigger'), ['trigger', undefined, config.text]);
  await api.close(); await assert.rejects(pending, /cancelled/);
});

test('warm registration reports the actual SDK end-user echo and rejects missing or mismatched registration', async () => {
  const {api, clients} = fixture();
  const identified = {...config, ttsEnabled: false, endUserId: 'save-branch-user'};
  const first = await api.warm(identified);
  assert.equal(first.registration.verified, true);
  assert.equal(first.registration.endUserId, identified.endUserId);
  assert.equal(first.registration.characterId, config.characterId);
  assert.equal((await api.warm(identified)).connectionReused, true);
  clients[0].state.endUserId = null;
  await assert.rejects(api.warm(identified), /provider identity could not be verified/);
  assert.equal(clients[0].isBotReady, false);
  await api.warm(identified);
  clients[1].state.endUserId = 'another-user';
  await assert.rejects(api.warm(identified), /provider identity could not be verified/);
  assert.equal(clients[1].isBotReady, false);
  await api.close();
  assert.equal((await api.warm({...config, ttsEnabled: false})).registration.verified, false);
  await api.close();
});

test('new and reused anonymous connections require explicit SDK null instead of normalizing an invalid identity', async () => {
  for (const reuse of [false, true]) for (const echo of ['foreign-provider-user', '', ' ', 0, false, {}, [], undefined]) {
    const {api, clients, events} = fixture({onConnect: connection => {
      if (!reuse) connection.state.endUserId = echo;
    }});
    const anonymous = {...config, ttsEnabled: false};
    if (reuse) { await api.warm(anonymous); clients[0].state.endUserId = echo; }
    await assert.rejects(api.warm(anonymous), error => error.message === 'Convai provider identity could not be verified');
    assert.equal(clients[0].isBotReady, false); assert.equal(api.readiness().ready, false);
    assert.equal(Object.hasOwn(clients[0].options, 'endUserId'), false);
    assert.deepEqual(events, []);
    await api.close();
  }
});

test('provider identity rejection precedes text, reactions, prepared input and microphone startup', async () => {
  for (const reuse of [false, true]) for (const mode of ['reply', 'reaction', 'prepared', 'beginVoice']) {
    const {api, clients, events} = fixture({allowMic: true, onConnect: connection => {
      if (!reuse) connection.state.endUserId = 'unexpected-user';
    }});
    const anonymous = {...config, ttsEnabled: false};
    if (reuse) { await api.warm(anonymous); clients[0].state.endUserId = 'unexpected-user'; }
    const method = mode === 'beginVoice' ? mode : 'reply';
    const extra = mode === 'reaction' ? {reaction: {kind: 'battle'}} : mode === 'prepared' ? {freshSession: true, sessionId: '-1'} : {};
    await assert.rejects(api[method]({...anonymous, ...extra}), /provider identity could not be verified/);
    assert.equal(events.includes('microphone'), false);
    assert.equal(events.some(row => Array.isArray(row) && ['context', 'message', 'trigger'].includes(row[0])), false);
    assert.equal(clients[0].isBotReady, false);
    await api.close();
  }
});

test('dedicated identified registration requires the exact provider user and character on newly ready connections', async () => {
  for (const change of [connection => { connection.state.endUserId = null; },
    connection => { connection.state.endUserId = 'different-user'; },
    connection => { connection.characterId = 'different-character'; },
    connection => { connection.characterId = undefined; }]) {
    const {api, clients, events} = fixture({onConnect: change});
    await assert.rejects(api.warm({...config, ttsEnabled: false, endUserId: 'approved-registration-user'}),
      error => error.message === 'Convai provider identity could not be verified');
    assert.equal(clients[0].isBotReady, false); assert.deepEqual(events, []);
    await api.close();
  }
  const {api, clients} = fixture();
  await api.warm({...config, ttsEnabled: false});
  clients[0].characterId = 'different-character';
  await assert.rejects(api.warm({...config, ttsEnabled: false}), /provider identity could not be verified/);
  await api.close();
});

test('rejected startup does not record its supplied or returned session as a verified owner', async () => {
  for (const sessionId of ['rejected-supplied-session', 'rejected-returned-session']) {
    let connects = 0;
    const {api, clients} = fixture({onConnect: connection => {
      if (++connects === 1) {
        connection.state.endUserId = 'wrong-user';
        connection.characterSessionId = 'rejected-returned-session';
      }
    }});
    await assert.rejects(api.warm({...config, ttsEnabled: false, sessionId: 'rejected-supplied-session'}), /provider identity/);
    const receipt = await api.warm({...config, ttsEnabled: false, endUserId: 'approved-registration-user', sessionId});
    assert.equal(receipt.registration.verified, true); assert.equal(clients.length, 2);
    await api.close();
  }
});

test('delayed identity rejection closes its exact connection without clearing a later valid owner', async () => {
  let releaseDisconnect;
  const delayed = new Promise(done => { releaseDisconnect = done; });
  const {api, clients} = fixture({onDisconnect: connection => connection === clients[0] ? delayed : undefined});
  const anonymous = {...config, ttsEnabled: false};
  await api.warm(anonymous); clients[0].state.endUserId = 'wrong-user';
  const rejected = api.warm(anonymous); rejected.catch(() => {});
  await flush();
  const current = await api.warm({...anonymous, characterId: 'panam'});
  assert.equal(current.ready, true);
  releaseDisconnect(); await assert.rejects(rejected, /provider identity/);
  assert.equal(clients[1].isBotReady, true); assert.equal(api.readiness().ready, true);
  assert.equal((await api.warm({...anonymous, characterId: 'panam'})).connectionReused, true);
  await api.close();
});

test('microphone finish cancels a provider identity drift before refreshed context or audio submission', async () => {
  const {api, clients, events} = fixture({allowMic: true});
  const anonymous = {...config, ttsEnabled: false, context: 'Recording context.'};
  await api.beginVoice(anonymous);
  clients[0].state.endUserId = 'unexpected-user';
  await assert.rejects(api.finishVoice({...anonymous, context: 'Finish context.'}), /provider identity/);
  assert.equal(events.includes('microphone-disable'), false);
  assert.equal(events.filter(row => Array.isArray(row) && row[0] === 'context').length, 1);
  assert.equal(events.includes('microphone-stop'), true); assert.equal(api.readiness().ready, false);
  await api.close();
});

test('idle readiness never reports or keeps alive a connection whose verified provider identity changed', async () => {
  for (const identified of [false, true]) {
    const {api, clients, events} = fixture();
    await api.warm({...config, ttsEnabled: false, ...(identified ? {endUserId: 'registration-user'} : {})});
    assert.equal(api.readiness(true).ready, true);
    clients[0].state.endUserId = 'changed-provider-user';
    assert.equal(api.readiness(true).ready, false);
    await flush();
    assert.equal(clients[0].isBotReady, false);
    assert.deepEqual(events, ['idle-reset']);
    await api.close();
  }
});

test('reliable source PCM becomes one unchanged WAV before playback duration, after declared tail bytes arrive', async () => {
  const chunks = [];
  const {api, clients} = fixture({emitAudio: async (...chunk) => chunks.push(chunk)});
  await api.warm(config);
  const pending = api.reply({...config, audioStreamToken: 'native-stream-one'}); pending.catch(() => {});
  await flush();
  const client = clients[0], audio = audioFixture({seconds: 3.05});
  client.state.isSpeaking = true; // SDK playback clocks do not own source PCM completion.
  finalText(client, 'Hello V. There is more to say.');
  client.data({label: 'rtvi-ai', type: 'bot-started-speaking', data: {}});
  client.data(audio.faces);
  client.data(audio.pcm(audio.samples.subarray(0, 16000)));
  client.data(audio.stats); client.data(audio.terminal);
  let finished = false; pending.then(() => { finished = true; });
  await new Promise(done => setTimeout(done, 80));
  assert.equal(finished, false, 'matching terminal cannot truncate undeclared PCM tail');
  client.data(audio.pcm(audio.samples.subarray(16000)));
  const result = await pending;
  const wav = Buffer.from(result.audio, 'base64');
  assert.deepEqual(wav.subarray(44), audio.samples);
  assert.equal(wav.readUInt32LE(24), 8000); assert.equal(result.duration, 3.05);
  assert.equal(result.faces.length, 183); assert.equal(result.faces[1].at, 1 / 60);
  assert.equal(result.faces.at(-1).at, 182 / 60); assert.equal(result.stats.fps, 60);
  assert.equal(result.streamed, false); assert.equal(result.stream, undefined); assert.equal(chunks.length, 0);
  assert.equal(client.options.blendshapeConfig.output_fps, 30, 'provider frame clock may differ from request');
  assert.equal(client.roomHandlers.has('trackSubscribed'), false);
  assert.equal(result.timing.audioTransport, 'convai-data'); assert.equal(result.packetCount, 2);
  // Collection did not wait for browser playback: the SDK still reports speaking, and nothing but the source PCM completed the turn
  // (waiting for the playback clock would end only in the 60 s collection timeout, which rejects). No elapsed-time figure is compared.
  assert.equal(client.state.isSpeaking, true, 'collection finished while the SDK still reported playback');
  await api.close();
});

test('microphone stop refreshes context on its original connection before disabling the device', async () => {
  const {api, clients, events} = fixture({allowMic: true});
  const original = {...config, ttsEnabled: false, endUserId: 'one-save', scope: 'private', context: 'Earlier journal.'};
  const opened = await api.beginVoice(original);
  assert.equal(opened.sessionID, clients[0].characterSessionId);
  const pending = api.finishVoice({...original, sessionId: opened.sessionID, context: 'Newly verified objective.'});
  await flush();
  const contexts = events.filter(row => Array.isArray(row) && row[0] === 'context');
  assert.match(contexts.at(-1)[1].text, /Newly verified objective/);
  assert(events.lastIndexOf(contexts.at(-1)) < events.indexOf('microphone-stop'));
  assert.equal(clients.length, 1);
  clients[0].handlers.get('messagesChange')([{id: 'voice-reply', type: 'bot-llm-text', content: 'I know the current objective.', isStreaming: false}]);
  assert.equal((await pending).text, 'I know the current objective.');
  await api.close();
});

test('microphone reply returns the corrected final speech transcript without assistant text or duplicated segments', async () => {
  const {api, clients} = fixture({allowMic: true});
  const request = {...config, ttsEnabled: false};
  await api.beginVoice(request);
  const connection = clients[0], receive = connection.handlers.get('messagesChange');
  const speech = {id: 'recognized-speech', type: 'user-transcription', content: 'Tell me about', isStreaming: true};
  receive([speech]);
  // The SDK grows the same bubble for final STT segments. A partial transcript
  // is never a chat row and must not substitute for these recognized words.
  connection.userTranscription = 'Tell me about the wrong place';
  connection.handlers.get('userTranscriptionChange')?.(connection.userTranscription);
  speech.content = 'Tell me about your time in the war';
  receive([speech]);
  const pending = api.finishVoice(request);
  await flush();
  const answer = {id: 'reply', type: 'bot-llm-text', content: 'Why do you want to know?', isStreaming: false};
  // An intervening bot row causes final-user-transcription to append a new
  // consolidated row; joining all user rows would duplicate the utterance.
  receive([speech, answer, {id: 'consolidated-speech', type: 'user-transcription',
    content: ' Tell me about your time\n in the war. ', isStreaming: false}]);
  const result = await pending;
  assert.equal(result.userText, 'Tell me about your time in the war.');
  assert.equal(result.text, answer.content);
  await api.close();
});

test('recognized final STT segments remain usable when the SDK never emits a consolidated transcription', async () => {
  const {api, clients} = fixture({allowMic: true});
  const request = {...config, ttsEnabled: false};
  await api.beginVoice(request);
  const speech = {id: 'recognized-speech', type: 'user-transcription', content: 'What do you', isStreaming: true};
  clients[0].handlers.get('messagesChange')([speech]);
  speech.content = 'What do you both think?';
  const pending = api.finishVoice(request); await flush();
  clients[0].handlers.get('messagesChange')([speech,
    {id: 'reply', type: 'bot-llm-text', content: 'Let me think.', isStreaming: false}]);
  assert.equal((await pending).userText, 'What do you both think?');
  await api.close();
});

test('partial-only, malformed, and empty microphone transcripts never invent a group utterance', async () => {
  for (const transcript of [undefined, {content: 'Unconfirmed text'}, {content: 42, isStreaming: false},
    {content: ' \n\u0000\t ', isStreaming: false}]) {
    const {api, clients} = fixture({allowMic: true});
    const request = {...config, ttsEnabled: false};
    await api.beginVoice(request);
    clients[0].userTranscription = 'This is only a partial guess';
    clients[0].handlers.get('userTranscriptionChange')?.(clients[0].userTranscription);
    const pending = api.finishVoice(request); await flush();
    clients[0].handlers.get('messagesChange')([
      {id: 'not-stt', type: 'user-llm-text', content: 'Unverified input echo', isStreaming: false},
      ...(transcript ? [{id: 'speech', type: 'user-transcription', ...transcript}] : []),
      {id: 'reply', type: 'bot-llm-text', content: 'The character replies, but that is not V speaking.', isStreaming: false}
    ]);
    assert.equal(Object.hasOwn(await pending, 'userText'), false);
    await api.close();
  }
});

test('microphone transcript payload is bounded without splitting Unicode or exposing control bytes', async () => {
  const {api, clients} = fixture({allowMic: true});
  const request = {...config, ttsEnabled: false};
  await api.beginVoice(request);
  const pending = api.finishVoice(request); await flush();
  clients[0].handlers.get('messagesChange')([
    {id: 'speech', type: 'user-transcription', content: 'Hi\u0000\tthere ' + 'a'.repeat(1190) + '\u{1f30d} more', isStreaming: false},
    {id: 'reply', type: 'bot-llm-text', content: 'I hear you.', isStreaming: false}
  ]);
  const {userText} = await pending;
  assert.equal(userText, 'Hi there ' + 'a'.repeat(1190));
  assert(userText.length <= 1200);
  assert.doesNotMatch(userText, /[\u0000-\u001f\u007f\ud800-\udbff]$/);
  await api.close();
});

test('reused sessions cannot replay a previous microphone transcript into a new voice or text turn', async () => {
  const {api, clients} = fixture({allowMic: true});
  const request = {...config, ttsEnabled: false};
  await api.beginVoice(request);
  let pending = api.finishVoice(request); await flush();
  const connection = clients[0];
  connection.chatMessages = [
    {id: 'first-speech', type: 'user-transcription', content: 'First question.', isStreaming: false},
    {id: 'first-answer', type: 'bot-llm-text', content: 'First answer.', isStreaming: false}
  ];
  connection.handlers.get('messagesChange')(connection.chatMessages);
  assert.equal((await pending).userText, 'First question.');
  await api.beginVoice({...request, sessionId: connection.characterSessionId});
  pending = api.finishVoice(request); await flush();
  connection.chatMessages.push({id: 'second-answer', type: 'bot-llm-text', content: 'Second answer.', isStreaming: false});
  connection.handlers.get('messagesChange')(connection.chatMessages);
  assert.equal(Object.hasOwn(await pending, 'userText'), false);
  pending = api.reply(request); await flush();
  connection.chatMessages.push(
    {id: 'text-echo', type: 'user-transcription', content: 'Should not be a microphone result.', isStreaming: false},
    {id: 'text-answer', type: 'bot-llm-text', content: 'Text answer.', isStreaming: false});
  connection.handlers.get('messagesChange')(connection.chatMessages);
  assert.equal(Object.hasOwn(await pending, 'userText'), false);
  assert.equal(clients.length, 1);
  await api.close();
});

test('cancelled microphone transcripts and late old-connection events cannot reach its replacement', async () => {
  const {api, clients} = fixture({allowMic: true});
  const original = {...config, ttsEnabled: false, endUserId: 'one-user'};
  await api.beginVoice(original);
  const obsolete = clients[0], oldSpeech = {id: 'old-speech', type: 'user-transcription',
    content: 'Cancelled question.', isStreaming: false};
  obsolete.handlers.get('messagesChange')([oldSpeech]);
  const cancelled = api.finishVoice(original); cancelled.catch(() => {}); await flush();
  await api.close();
  await assert.rejects(cancelled, /cancelled/);
  await api.beginVoice(original);
  const pending = api.finishVoice(original); await flush();
  obsolete.handlers.get('messagesChange')([oldSpeech,
    {id: 'late-correction', type: 'user-transcription', content: 'Another cancelled question.', isStreaming: false},
    {id: 'old-reply', type: 'bot-llm-text', content: 'Cancelled reply.', isStreaming: false}]);
  clients[1].handlers.get('messagesChange')([
    {id: 'new-speech', type: 'user-transcription', content: 'The current question.', isStreaming: false},
    {id: 'new-reply', type: 'bot-llm-text', content: 'The current reply.', isStreaming: false}
  ]);
  const result = await pending;
  assert.equal(result.userText, 'The current question.');
  assert.equal(result.text, 'The current reply.');
  await api.close();
});

test('only the game finish submits speech after 30 seconds, with fresh context before disabling audio', async () => {
  const timers = manualTimers(), {api, clients, events} = fixture({allowMic: true, timers});
  const original = {...config, ttsEnabled: false, endUserId: 'one-save', scope: 'private', context: 'Earlier objective.'};
  const opened = await api.beginVoice(original);
  const obsoleteCeiling = [...timers.pending.values()][0].callback;
  timers.advance(30000); await flush();
  timers.advance(2000); await flush();
  assert.equal(events.includes('microphone-disable'), false);
  assert.equal(events.includes('microphone-stop'), false);
  assert.equal(api.readiness().ready, true);
  const pending = api.finishVoice({...original, sessionId: opened.sessionID, context: 'Verified at game finish.'});
  await flush();
  const latestContext = events.findLast(row => Array.isArray(row) && row[0] === 'context');
  assert.match(latestContext[1].text, /Verified at game finish/);
  assert(events.indexOf(latestContext) < events.indexOf('microphone-disable'));
  assert.equal(timers.pending.size, 0);
  // A queued callback can still run after clearTimeout; ownership and recording
  // state must also make it harmless while the reply is being collected.
  obsoleteCeiling(); timers.advance(3000); await flush();
  assert.equal(api.readiness().ready, true);
  assert.equal(events.some(row => Array.isArray(row) && row[0] === 'disconnect'), false);
  await assert.rejects(api.finishVoice(original), /No microphone conversation is recording/);
  clients[0].handlers.get('messagesChange')([{id: 'reply', type: 'bot-llm-text', content: 'Fresh reply.', isStreaming: false}]);
  assert.equal((await pending).text, 'Fresh reply.');
  assert.equal(events.filter(row => row === 'microphone-disable').length, 1);
  await api.close();
});

test('an abandoned microphone cancels at 35 seconds without submitting or collecting its recording', async () => {
  const timers = manualTimers(), {api, clients, events} = fixture({allowMic: true, timers});
  const original = {...config, ttsEnabled: false, endUserId: 'one-save', scope: 'private'};
  await api.beginVoice(original);
  const track = clients[0].room.localParticipant.audioTrackPublications.get('mic').track.mediaStreamTrack;
  timers.advance(34999); await flush();
  assert.equal(track.readyState, 'live');
  timers.advance(1); await flush();
  assert.equal(track.readyState, 'ended');
  assert.equal(api.readiness().ready, false);
  assert.equal(events.includes('microphone-disable'), false);
  const interrupted = events.findIndex(row => Array.isArray(row) && row[0] === 'interrupt');
  const disconnected = events.findIndex(row => Array.isArray(row) && row[0] === 'disconnect');
  assert(interrupted >= 0 && interrupted < disconnected && disconnected < events.indexOf('microphone-stop'));
  assert.equal(events.filter(row => Array.isArray(row) && row[0] === 'context').length, 1);
  clients[0].handlers.get('messagesChange')([{id: 'late', type: 'bot-llm-text', content: 'Unverified reply.', isStreaming: false}]);
  await assert.rejects(api.finishVoice(original), /No microphone conversation is recording/);
  assert.equal(timers.pending.size, 0);
  await api.close();
});

test('late cancellation shutdown and its old timer cannot stop a new recording', async () => {
  let releaseDisconnect;
  const delayed = new Promise(done => { releaseDisconnect = done; });
  const timers = manualTimers(), {api, clients, events} = fixture({allowMic: true, timers,
    onDisconnect: connection => connection === clients[0] ? delayed : undefined});
  const original = {...config, ttsEnabled: false, endUserId: 'one-save', scope: 'private'};
  await api.beginVoice(original);
  const oldCeiling = [...timers.pending.values()][0].callback;
  const oldTrack = clients[0].room.localParticipant.audioTrackPublications.get('mic').track.mediaStreamTrack;
  timers.advance(35000); await flush();
  assert.equal(oldTrack.readyState, 'ended', 'network shutdown cannot delay local microphone stop');
  await api.beginVoice({...original, endUserId: 'another-save'});
  const newTrack = clients[1].room.localParticipant.audioTrackPublications.get('mic').track.mediaStreamTrack;
  releaseDisconnect(); oldCeiling(); await flush();
  assert.equal(newTrack.readyState, 'live');
  assert.equal(api.readiness().ready, true);
  assert.equal(timers.pending.size, 1);
  assert.equal(events.includes('microphone-disable'), false);
  assert.equal(events.filter(row => Array.isArray(row) && row[0] === 'disconnect').length, 1);
  await api.close();
});

test('a cancelled finish cannot collect a new recording after delayed microphone disable', async () => {
  let releaseDisable;
  const delayed = new Promise(done => { releaseDisable = done; });
  const timers = manualTimers(), {api, clients} = fixture({allowMic: true, timers,
    onDisableAudio: connection => connection === clients[0] ? delayed : undefined});
  const original = {...config, ttsEnabled: false, endUserId: 'one-save', scope: 'private'};
  await api.beginVoice(original);
  const finishing = api.finishVoice(original); finishing.catch(() => {});
  await api.close();
  await api.beginVoice({...original, endUserId: 'another-save'});
  releaseDisable();
  await assert.rejects(finishing, /Microphone finish cancelled/);
  assert.equal(clients[1].room.localParticipant.audioTrackPublications.get('mic').track.mediaStreamTrack.readyState, 'live');
  assert.equal(api.readiness().ready, true); assert.equal(timers.pending.size, 1);
  await api.close();
});

test('microphone stop cannot change its character, user, audience, TTS route or session', async () => {
  for (const change of [{characterId: 'panam'}, {endUserId: 'another-save'}, {scope: 'group:judy,panam'},
    {ttsEnabled: true}, {sessionId: 'foreign-session'}, {freshSession: true}]) {
    const {api, clients, events} = fixture({allowMic: true});
    const original = {...config, ttsEnabled: false, endUserId: 'one-save', scope: 'private'};
    await api.beginVoice(original);
    await assert.rejects(api.finishVoice({...original, ...change}), /identity changed|speculative preparation/);
    assert.equal(clients.length, 1);
    assert.equal(events.filter(row => Array.isArray(row) && row[0] === 'context').length, 1);
    await api.close();
  }
});

test('a turn silently replaces journal context before sending the original user message', async () => {
  const {api, events} = fixture();
  await api.warm(config);
  const journal = {version: 1, status: 'active', quest: {id: '1', title: 'Visible quest',
    objectives: [{id: '2', text: 'Meet a friend.', tracked: true}]}};
  const pending = api.reply({...config, context: journalContext(journal)}); pending.catch(() => {});
  await flush();
  const row = events.find(event => event[0] === 'context')[1];
  assert.equal(row.mode, 'replace'); assert.equal(row.run_llm, 'false');
  assert.match(row.text, /Visible quest/); assert.match(row.text, /active, revealed objectives/);
  assert.doesNotMatch(row.text, /No verified quest/);
  assert(events.findIndex(event => event[0] === 'context') < events.findIndex(event => event[0] === 'message'));
  assert.equal(events.find(event => event[0] === 'message')[1], config.text);
  await api.close(); await assert.rejects(pending, /cancelled/);
});

test('warm is silent and an unused anonymous connection can prepare without reconnecting', async () => {
  const {api, clients, events} = fixture();
  await api.warm(config);
  const timing = await api.warm({...config, freshSession: true, sessionId: '-1'});
  assert.equal(clients.length, 1); assert.equal(timing.connectionReused, true);
  assert.deepEqual(events, []); // No prompt, generated reply, browser playback or microphone activation.
  assert.equal(clients[0].options.startWithAudioOn, false);
  assert.equal(clients[0].options.characterSessionId, '-1');
  await api.close();
});

test('an attempted turn makes a page ineligible for isolated preparation even when cancelled', async () => {
  const {api, clients, events} = fixture();
  await api.warm(config);
  const pending = api.reply(config); pending.catch(() => {});
  await flush(); assert.equal(events.some(row => row[0] === 'message'), true);
  await api.warm({...config, freshSession: true, sessionId: '-1'});
  await assert.rejects(pending, /cancelled/);
  assert.equal(clients.length, 2); assert.equal(clients[1].options.characterSessionId, '-1');
  assert.equal(events.includes('microphone'), false);
  const context = events.find(row => row[0] === 'context')[1];
  assert.equal(context.run_llm, 'false');
  await api.close();
});

test('isolated preparation never reuses a supplied persistent session or carries it through close', async () => {
  const {api, clients} = fixture();
  await api.warm({...config, sessionId: 'persistent-session'});
  await api.warm({...config, sessionId: '-1', freshSession: true});
  assert.equal(clients.length, 2); assert.equal(clients[1].options.characterSessionId, '-1');
  await api.close();
  await api.warm(config);
  assert.equal(clients[2].options.characterSessionId, '-1');
  await api.close();
});

test('party keepalive resets only the service idle timer without dialogue or microphone', async () => {
  const {api, events} = fixture(); await api.warm(config);
  assert.equal(api.readiness(true).ready, true);
  assert.deepEqual(events, ['idle-reset']);
  await api.close(); assert.equal(api.readiness(true).ready, false);
  assert.deepEqual(events, ['idle-reset']);
});

// A turn of Convai's cloud voice whose audio arrives at 44.1 kHz in packets that say 24 kHz (2026-10-21 reports, Multilingual on): the declared duration and the byte count agree on the
// real rate. `declared` is what the packets say; `statsMs` is what the final statistics declare.
async function mislabelledTurn(extra, {declared = 24000, statsMs = 2000} = {}) {
  const {api, clients} = fixture();
  await api.warm(config);
  const pending = api.reply({...config, ...extra}); pending.catch(() => {});
  await flush();
  const client = clients[0], real = audioFixture({seconds: 2, sampleRate: 44100});
  finalText(client, 'Hello V.');
  client.data(real.faces);
  client.data(wire({type: 'audio-data', audio: real.samples.toString('base64'), sample_rate: declared, channels: 1, includes_wav_header: false}));
  client.data(wire({type: 'blendshape-turn-stats', ...real.owner, sequence: 19, stats: {total_audio_bytes: real.samples.length, total_audio_duration_ms: statsMs, total_blendshapes: 120, fps: 60, was_interrupted: false}}));
  client.data(real.terminal);
  return {api, client, pending, real};
}

test('Convai audio that arrives at 44.1 kHz in packets labelled 24 kHz is written at its real rate, and the turn is not failed', async () => {
  const {api, pending, real} = await mislabelledTurn({});
  const result = await pending;
  const wav = Buffer.from(result.audio, 'base64');
  assert.equal(wav.readUInt32LE(24), 44100); assert.deepEqual(wav.subarray(44), real.samples);
  assert.equal(result.sampleRate, 44100); assert.equal(result.duration, 2); assert.deepEqual(result.sampleRateCorrected, {declared: 24000, actual: 44100});
  assert.equal(result.text, 'Hello V.');
  await api.close();
});

test('a turn told the character\'s remembered rate (config.audioRate) takes the first packet at 44.1 kHz and the statistics confirm it', async () => {
  const {api, pending, real} = await mislabelledTurn({audioRate: {declared: 24000, actual: 44100}});
  const result = await pending;
  assert.equal(result.sampleRate, 44100); assert.equal(Buffer.from(result.audio, 'base64').readUInt32LE(24), 44100);
  assert.deepEqual(Buffer.from(result.audio, 'base64').subarray(44), real.samples);
  assert.equal(result.sampleRateHinted, true); assert.deepEqual(result.sampleRateCorrected, {declared: 24000, actual: 44100});
  await api.close();
});

test('a Convai audio format fault fails the turn, unless the player\'s own voice is not Convai\'s (audioOptional): then the written reply stands, the audio is dropped and the connection is retired', async () => {
  // 3 s declared for 2 s of audio at 44.1 kHz: no standard rate explains it, so it is a fault.
  const strict = await mislabelledTurn({}, {statsMs: 3000});
  await assert.rejects(strict.pending, /declared duration/);
  await strict.api.close();
  const lenient = await mislabelledTurn({audioOptional: true}, {statsMs: 3000});
  const result = await lenient.pending;
  assert.equal(result.text, 'Hello V.'); assert.equal(result.audio, undefined); assert.equal(result.faces.length, 0);
  assert.match(result.audioError, /showing the written reply/); assert.equal(result.timing.audioFormatFault, true);
  assert.equal(lenient.client.isBotReady, false, 'the connection was retired: nothing of this response can reach another turn');
  // Anything that is not a format fault (the owner of the speech changed) still fails an optional-audio turn.
  const {api, clients} = fixture();
  await api.warm(config);
  const pending = api.reply({...config, audioOptional: true}); pending.catch(() => {});
  await flush();
  const audio = audioFixture(), other = audioFixture({sequence: 2});
  finalText(clients[0], 'Hello V.');
  clients[0].data(audio.faces); clients[0].data(other.stats);
  await assert.rejects(pending, /replaced the active speech owner/);
  await api.close();
});

test('text-only replies finish on LLM completion without audio, lipsync or microphone', async () => {
  const {api, clients, events} = fixture();
  await api.warm({...config, ttsEnabled: false});
  const pending = api.reply({...config, ttsEnabled: false});
  await flush();
  const client = clients[0];
  assert.equal(client.options.ttsEnabled, false);
  assert.equal(client.options.enableLipsync, false);
  client.chatMessages = [{id: 'answer', type: 'bot-llm-text', content: 'Hello V.', isStreaming: true}];
  client.state.isThinking = true;
  client.handlers.get('messagesChange')(client.chatMessages);
  let completed = false; pending.then(() => { completed = true; });
  await new Promise(done => setTimeout(done, 80));
  assert.equal(completed, false);
  client.chatMessages[0].isStreaming = false;
  client.state.isThinking = false;
  client.handlers.get('messagesChange')(client.chatMessages);
  const result = await pending;
  assert.equal(result.text, 'Hello V.'); assert.equal(result.audio, undefined);
  assert.equal(events.includes('audio-capture'), false);
  assert.equal(events.includes('microphone'), false);
  await api.close();
});

test('switching between native Convai voice and local speech reconnects the session with correct TTS flag', async () => {
  const {api, clients} = fixture();
  await api.warm(config);
  await api.warm({...config, ttsEnabled: false});
  assert.equal(clients.length, 2);
  assert.equal(clients[0].isBotReady, false);
  assert.equal(clients[1].options.ttsEnabled, false);
  await api.close();
});

test('spawn warmup supplies verified identity and metadata before connecting, while absent identity stays anonymous', async () => {
  const {api, clients, events} = fixture();
  const identified = {...config, ttsEnabled: false, endUserId: 'opaque-user-a-branch-one',
    endUserMetadata: {app: 'cyberpunk-convai', schema: 'memory-v1'}};
  await api.warm(identified);
  assert.equal(clients[0].options.endUserId, identified.endUserId);
  assert.equal(clients[0].options.endUserMetadata, identified.endUserMetadata);
  assert.equal(clients[0].options.characterSessionId, '-1');
  assert.equal((await api.warm(identified)).connectionReused, true);
  assert.equal(clients.length, 1);
  assert.deepEqual(events, []);
  await api.warm({...config, ttsEnabled: false, endUserMetadata: {ignored: true}});
  assert.equal(clients.length, 2);
  assert.equal(clients[0].isBotReady, false);
  assert.equal(Object.hasOwn(clients[1].options, 'endUserId'), false);
  assert.equal(Object.hasOwn(clients[1].options, 'endUserMetadata'), false);
  await api.close();
});

test('a session cannot move to another user, save branch or audience, while its TTS route may change', async () => {
  const {api, clients} = fixture();
  const identified = {...config, ttsEnabled: false, endUserId: 'opaque-user-a-branch-one'};
  await api.warm(identified);
  const sessionId = clients[0].characterSessionId;
  for (const change of [{endUserId: 'opaque-user-b'}, {endUserId: 'opaque-user-a-branch-two'},
    {endUserId: undefined}, {scope: 'private'}]) {
    await assert.rejects(api.warm({...identified, ...change, sessionId}), /another user or scope/);
  }
  assert.equal(clients.length, 1);
  assert.equal(clients[0].isBotReady, true);
  await api.warm({...identified, sessionId, ttsEnabled: true});
  assert.equal(clients.length, 2);
  assert.equal(clients[1].options.characterSessionId, sessionId);
  assert.equal(clients[1].options.endUserId, identified.endUserId);
  await api.close();
});

test('identified preparation is rejected before connecting or sending speculative dialogue', async () => {
  const {api, clients, events} = fixture();
  const unsafe = {...config, endUserId: 'opaque-user-a', freshSession: true, sessionId: '-1'};
  await assert.rejects(api.warm(unsafe), /cannot use speculative preparation/);
  await assert.rejects(api.reply(unsafe), /cannot use speculative preparation/);
  assert.equal(clients.length, 0); assert.deepEqual(events, []);
});

test('late SDK events from a disconnected user cannot populate or fail the next user conversation', async () => {
  const {api, clients} = fixture();
  const first = {...config, ttsEnabled: false, endUserId: 'opaque-user-a'};
  await api.warm(first);
  const obsolete = api.reply(first); obsolete.catch(() => {});
  await flush();
  const second = {...first, endUserId: 'opaque-user-b'};
  await api.warm(second);
  await assert.rejects(obsolete, /cancelled/);
  const pending = api.reply(second); await flush();
  clients[0].handlers.get('messagesChange')([{id: 'old', type: 'bot-llm-text', content: 'Private to the other user.', isStreaming: false}]);
  for (const event of ['error', 'disconnect', 'llmNoResponse']) clients[0].handlers.get(event)();
  clients[0].data(wire({type: 'bot-turn-completed', response_id: 'old', was_interrupted: false}));
  let finished = false; pending.then(() => { finished = true; });
  await new Promise(done => setTimeout(done, 80));
  assert.equal(finished, false);
  clients[1].handlers.get('messagesChange')([{id: 'new', type: 'bot-llm-text', content: 'Only the current reply.', isStreaming: false}]);
  assert.equal((await pending).text, 'Only the current reply.');
  assert.equal(clients[1].options.characterSessionId, '-1');
  await api.close();
});

test('context permits explicit current-save relationships while keeping unsupplied relationships unknown', async () => {
  const {api, clients, events} = fixture();
  const request = {...config, ttsEnabled: false, context: 'Current-save verified fact: Judy and V are friends.'};
  await api.warm(request);
  const pending = api.reply(request); await flush();
  const context = events.find(row => row[0] === 'context')[1];
  assert.match(context.text, /explicitly supplied current-save facts for quest progress and relationships/);
  assert.match(context.text, /not explicitly supplied is unknown/);
  assert.match(context.text, /Current-save verified fact: Judy and V are friends\./);
  assert.doesNotMatch(context.text, /No verified relationship state is supplied/);
  assert.equal(context.mode, 'replace'); assert.equal(context.run_llm, 'false');
  clients[0].handlers.get('messagesChange')([{id: 'reply', type: 'bot-llm-text', content: 'Hey, friend.', isStreaming: false}]);
  await pending; await api.close();
});

test('complete source audio and indexed faces still require final assistant text', async () => {
  const {api, clients} = fixture();
  await api.warm(config);
  const pending = api.reply(config); await flush();
  const client = clients[0];
  sendAudio(client);
  const text = {id: 'reply', type: 'bot-llm-text', content: 'Hello', isStreaming: true};
  client.handlers.get('messagesChange')([text]);
  let finished = false; pending.then(() => { finished = true; });
  await new Promise(done => setTimeout(done, 80));
  assert.equal(finished, false);
  text.content = 'Hello V.'; text.isStreaming = false;
  client.handlers.get('messagesChange')([text]);
  const result = await pending;
  assert.equal(result.text, 'Hello V.'); assert.equal(result.faces.length, 24);
  await api.close();
});

test('actual mixed wire envelopes finish one source WAV on owned top-level turn completion', async () => {
  const {api, clients} = fixture();
  await api.warm(config);
  const pending = api.reply(config); pending.catch(() => {}); await flush();
  const client = clients[0], audio = audioFixture({seconds: 3.05});
  try {
    finalText(client);
    // The production provider sends PCM/faces/stats inside server-message.
    // Owned start/stop flags are flat RTVI messages; the flat terminal omits
    // label entirely (the one unlabeled packet in the captured response).
    client.data({label: 'rtvi-ai', type: 'bot-started-speaking', ...audio.owner});
    client.data(audio.faces); client.data(audio.pcm()); client.data(audio.stats);
    client.data({label: 'rtvi-ai', type: 'bot-stopped-speaking', ...audio.owner});
    // Missing-label support cannot admit unrelated protocols, ownerless
    // completion or duplicate raw PCM without its server-message wrapper.
    client.data({...audio.terminal.data, label: 'other-protocol'});
    client.data({type: 'bot-turn-completed', was_interrupted: false});
    client.data(audio.pcm().data);
    assert.equal(api.diagnostics().turn.audio.terminalPresent, false);
    assert.equal(api.diagnostics().turn.audio.byteCount, audio.samples.length);
    client.data(audio.terminal.data);
    assert.equal(api.diagnostics().turn.audio.terminalPresent, true);
    assert.equal(api.diagnostics().turn.audio.ready, true);
    const result = await pending;
    assert.deepEqual(Buffer.from(result.audio, 'base64').subarray(44), audio.samples);
    assert.equal(result.faces.length, 183);
    assert.equal(result.faces[182].at, 182 / 60);
    assert.equal(result.streamed, false);
    // The same connection may receive generic UI flags after completion.
    client.data({label: 'rtvi-ai', type: 'bot-stopped-speaking', data: {}});
    client.data(wire({type: 'bot-stopped-speaking'}));
    client.data(audio.terminal.data);
    assert.equal(api.readiness().ready, true);
  } finally { await api.close(); await pending.catch(() => {}); }
});

test('top-level completion preserves participant, reliability and response ownership requirements', async () => {
  for (const failure of ['unowned', 'wrong-owner', 'unverified', 'lossy', 'conflicting-type']) {
    const {api, clients} = fixture(); await api.warm(config);
    const pending = api.reply(config); pending.catch(() => {}); await flush();
    const client = clients[0], audio = audioFixture();
    client.data(audio.faces); client.data(audio.pcm()); client.data(audio.stats); finalText(client);
    const {type, ...data} = audio.terminal.data;
    const options = {};
    if (failure === 'unowned') {
      delete data.response_id; delete data.neurosync_turn_id;
    }
    if (failure === 'wrong-owner') data.response_id = 'another-response';
    if (failure === 'unverified') options.participant = undefined;
    if (failure === 'lossy') options.kind = 1;
    if (failure === 'conflicting-type') data.type = 'bot-stopped-speaking';
    client.data({...(failure === 'unowned' ? {label: 'rtvi-ai'} : {}), type, data}, options);
    try {
      assert.equal(api.readiness().ready, false, failure);
      await assert.rejects(pending, /owner|participant|reliable|conflict|type/i);
      assert.equal(client.isBotReady, false);
    } finally { await api.close(); await pending.catch(() => {}); }
  }
});

test('diagnostic snapshots show stalled gates without revealing messages, credentials or owner IDs', async () => {
  const {api, clients} = fixture();
  const privateConfig = {...config, key: 'private-test-key', characterId: 'private-character-id',
    endUserId: 'private-end-user-id', text: 'private-user-dialogue'};
  await api.warm(privateConfig);
  const pending = api.reply(privateConfig); pending.catch(() => {}); await flush();
  const client = clients[0], audio = audioFixture();
  const owner = {response_id: 'private-response-id', neurosync_turn_id: 1, epoch: 1};
  try {
    client.data({label: 'private-label', type: 'private-type', data: {text: 'private-wire-dialogue'}});
    finalText(client, 'private-assistant-dialogue');
    client.data(wire({...audio.faces.data, ...owner}));
    client.data(audio.pcm());
    client.data(wire({...audio.stats.data, ...owner}));
    const snapshot = api.diagnostics();
    assert.equal(snapshot.participantPinned, true);
    assert.equal(snapshot.participantCurrent, true);
    assert.equal(snapshot.turn.textComplete, true);
    assert.equal(snapshot.turn.textCharacters, 'private-assistant-dialogue'.length);
    assert.equal(snapshot.turn.llmRows, 1);
    assert.equal(snapshot.turn.streamingLlmRows, 0);
    assert.equal(snapshot.turn.audio.byteCount, audio.samples.length);
    assert.equal(snapshot.turn.audio.expectedBytes, audio.samples.length);
    assert.equal(snapshot.turn.audio.terminalPresent, false);
    assert.equal(snapshot.turn.audio.ready, false);
    assert.equal(snapshot.wire.outerTypes.other, 1);
    assert.equal(snapshot.wire.matchingLabel, snapshot.wire.labelPresent - 1);
    const encoded = JSON.stringify(snapshot);
    assert.doesNotMatch(encoded, /private-|speech-1|convai-bot-|different-participant-sid|session-/);
    snapshot.wire.outerTypes.other = 999;
    assert.equal(api.diagnostics().wire.outerTypes.other, 1);
    assert.equal(api.diagnostics().turn.audio.packetCount, 1);
    await api.close('private-cancellation-reason');
    const closed = api.diagnostics();
    assert.equal(closed.activeTurn, false);
    assert.equal(closed.previousTurn.errorCode, 'turn-failed-or-cancelled');
    assert.doesNotMatch(JSON.stringify(closed), /private-|speech-1|convai-bot-|different-participant-sid|session-/);
    await assert.rejects(pending, /private-cancellation-reason/);
  } finally { await api.close(); await pending.catch(() => {}); }
});

test('voiced warmup pins the actual remote bot-ready participant before admitting a turn', async () => {
  for (const ready of [{participant: undefined}, {participant: {identity: 'unknown'}}, {kind: 1}]) {
    const {api, events} = fixture({botReady: false, onConnect: connection => {
      connection.data({label: 'rtvi-ai', type: 'bot-ready', data: {}}, ready);
    }});
    await assert.rejects(api.reply(config), /participant could not be verified/);
    assert.equal(api.readiness().ready, false);
    assert.equal(events.some(event => Array.isArray(event) && event[0] === 'message'), false);
    await api.close();
  }
});

test('only reliable audio from the pinned current room participant can enter the WAV', async () => {
  for (const failure of ['unknown', 'server-ambiguous', 'different-room-peer', 'replaced-peer', 'lossy']) {
    const {api, clients} = fixture();
    await api.warm(config);
    const pending = api.reply(config); pending.catch(() => {}); await flush();
    const client = clients[0], audio = audioFixture(), options = {};
    if (failure === 'unknown') options.participant = {identity: 'outsider'};
    if (failure === 'server-ambiguous') options.participant = undefined;
    if (failure === 'different-room-peer') {
      options.participant = {identity: 'another-room-peer'};
      client.room.remoteParticipants.set(options.participant.identity, options.participant);
    }
    if (failure === 'replaced-peer') client.room.remoteParticipants.set(client.peer.identity, {...client.peer});
    if (failure === 'lossy') options.kind = 1;
    client.data(audio.pcm(), options);
    await assert.rejects(pending, /unverified participant|reliable ordered/);
    assert.equal(client.isBotReady, false); assert.equal(api.readiness().ready, false);
    await api.close();
  }
});

test('malformed source PCM and changed response ownership discard the connection instead of publishing partial audio', async () => {
  for (const failure of ['json', 'pcm', 'response-owner', 'interrupted']) {
    const {api, clients} = fixture(); await api.warm(config);
    const pending = api.reply(config); pending.catch(() => {}); await flush();
    const client = clients[0], audio = audioFixture();
    client.data(audio.faces); client.data(audio.pcm(audio.samples.subarray(0, 3200)));
    if (failure === 'json') client.data(new TextEncoder().encode('{bad json'));
    if (failure === 'pcm') client.data(wire({...audio.pcm().data, audio: 'not base64'}));
    if (failure === 'response-owner') client.data(wire({...audio.terminal.data, response_id: 'different-response'}));
    if (failure === 'interrupted') client.data(wire({...audio.terminal.data, was_interrupted: true}));
    await assert.rejects(pending, /Invalid Convai|active speech owner|interrupted/);
    assert.equal(api.readiness().ready, false);
    // These tail bytes belong to the discarded connection and are never reused.
    client.data(audio.pcm(audio.samples.subarray(3200))); client.data(audio.stats); client.data(audio.terminal);
    await api.warm(config); assert.equal(clients.length, 2);
    await api.close();
  }
});

test('a cancelled or disconnected PCM turn cannot contaminate a replacement connection', async () => {
  for (const reason of ['cancel', 'disconnect']) {
    const {api, clients, events} = fixture(); await api.warm(config);
    const old = api.reply(config); old.catch(() => {}); await flush();
    const obsolete = clients[0], audio = audioFixture();
    obsolete.data(audio.pcm(audio.samples.subarray(0, 3200)));
    if (reason === 'cancel') await api.close();
    else obsolete.handlers.get('disconnect')();
    await assert.rejects(old, /cancelled|closed/);
    const pending = api.reply(config);
    // The replacement turn has begun once it has sent its message (the first turn sent one before it was discarded).
    await until(() => events.filter(event => event[0] === 'message').length === 2, 'the replacement turn to send its message');
    obsolete.data(audio.pcm(audio.samples.subarray(3200))); obsolete.data(audio.stats); obsolete.data(audio.terminal);
    sendAudio(clients[1], audioFixture({sequence: 2})); finalText(clients[1], 'New reply.');
    const result = await pending;
    assert.equal(result.text, 'New reply.'); assert.equal(result.packetCount, 1);
    assert.equal(Buffer.from(result.audio, 'base64').readUInt32LE(40), audio.samples.length);
    await api.close();
  }
});

test('successful PCM turns reuse the pinned warm source and ignore retired owned metadata', async () => {
  const {api, clients} = fixture(); await api.warm(config);
  const client = clients[0], prior = audioFixture();
  let pending = api.reply(config); await flush();
  sendAudio(client, prior); finalText(client, 'First reply.', 'first'); await pending;
  pending = api.reply(config); await flush();
  client.data(prior.stats); client.data(prior.terminal);
  sendAudio(client, audioFixture({sequence: 2})); finalText(client, 'Second reply.', 'second');
  const result = await pending;
  assert.equal(result.text, 'Second reply.'); assert.equal(result.packetCount, 1);
  assert.equal(clients.length, 1); assert.equal(result.timing.connectionReused, true);
  await api.close();
});

test('ownerless PCM outside a submitted turn retires the warm connection', async () => {
  const {api, clients} = fixture(); await api.warm(config);
  const pending = api.reply(config); await flush();
  const audio = sendAudio(clients[0]); finalText(clients[0]); await pending;
  clients[0].data(audio.pcm());
  assert.equal(api.readiness().ready, false);
  await api.warm(config); assert.equal(clients.length, 2);
  await api.close();
});

test('idle readiness retires a warm source whose participant object left or was replaced', async () => {
  for (const replace of [false, true]) {
    const {api, clients, events} = fixture(); await api.warm(config);
    const {room, peer} = clients[0];
    if (replace) room.remoteParticipants.set(peer.identity, {...peer});
    else room.remoteParticipants.delete(peer.identity);
    assert.equal(api.readiness(true).ready, false);
    assert.equal(events.includes('idle-reset'), false);
    await api.close();
  }
});

test('overlapping text or microphone starts are rejected without changing the active collector', async () => {
  const {api, clients, events} = fixture({allowMic: true});
  const first = api.reply(config); first.catch(() => {});
  await assert.rejects(api.reply(config), /already active/);
  await assert.rejects(api.beginVoice(config), /already active/);
  await new Promise(done => setTimeout(done, 80));
  await assert.rejects(api.reply(config), /already active/);
  sendAudio(clients[0]); finalText(clients[0]); await first;
  assert.equal(events.filter(event => Array.isArray(event) && event[0] === 'message').length, 1);
  assert.equal(events.includes('microphone'), false);
  await api.beginVoice(config);
  await assert.rejects(api.beginVoice(config), /already active/);
  await assert.rejects(api.reply(config), /already active/);
  await api.close();
});

test('a microphone reply carries recognized V text alongside one source PCM WAV', async () => {
  const {api, clients} = fixture({allowMic: true});
  await api.beginVoice(config);
  const client = clients[0];
  client.chatMessages = [{id: 'speech', type: 'user-transcription', content: 'What do you both think?', isStreaming: false}];
  client.handlers.get('messagesChange')(client.chatMessages);
  const pending = api.finishVoice(config); await flush();
  sendAudio(client); finalText(client, 'I have an idea.');
  const result = await pending;
  assert.equal(result.userText, 'What do you both think?'); assert.equal(result.text, 'I have an idea.');
  assert.equal(result.streamed, false); assert.equal(result.packetCount, 1);
  assert.equal(client.room.localParticipant.audioTrackPublications.size, 0);
  await api.close();
});

// `instances` lists the players that serve a turn (opened normally, or promoted from
// standby by arm()); `standbys` lists every device opened ahead of its audio.
function playerFixture({appendGate, openError, standbyError} = {}) {
  const instances = [], standbys = [];
  class Player {
    constructor() { this.packets = []; this.controls = []; this.state = {state: 'opening', ended: false}; }
    async open(format) {
      if (format.standby) { if (standbyError) throw Error(standbyError); standbys.push(this); this.standby = true; }
      else { if (openError) throw Error(openError); instances.push(this); }
      this.format = format; this.opened = true;
      this.sampleRate = format.sampleRate; this.channels = format.channels;
      this.state.state = format.standby ? 'standby' : 'awaiting-admission';
    }
    async arm() {
      assert.equal(this.standby, true, 'only a standby player can be armed');
      this.standby = false; this.armed = true; this.state.state = 'awaiting-admission'; instances.push(this);
    }
    async append(bytes, offsetFrames) {
      assert.ok(!this.standby, 'a standby player must be armed before it accepts audio');
      assert.equal(this.inAppend, undefined, 'append acknowledgements must be ordered');
      this.inAppend = true;
      await appendGate?.();
      this.packets.push({bytes: Buffer.from(bytes), offsetFrames});
      this.inAppend = undefined;
    }
    control(control) {
      assert.ok(this.format, 'control must wait for open'); assert.ok(!this.standby, 'a standby player takes no control');
      this.controls.push(control);
    }
    async end(totalFrames) { this.totalFrames = totalFrames; this.state.state = 'draining'; }
    snapshot() { return {...this.state, sampleRate: this.format?.sampleRate, channels: this.format?.channels}; }
    async stop(reason) { this.stopped = reason; this.state.state = 'stopped'; this.state.ended = false; }
    drain() { this.state = {...this.state, state: 'ended', ended: true,
      playedFrames: this.totalFrames, positionSeconds: this.totalFrames / this.format.sampleRate}; }
  }
  return {Player, instances, standbys};
}

test('continuous playback receives owned original PCM before terminal, preserves faces and holds result until audible drain', async () => {
  const {Player, instances, standbys} = playerFixture();
  const {api, clients} = fixture({player: Player});
  await api.warm(config);
  let settled = false;
  const pending = api.reply({...config, liveSpeechToken: 'audible-turn'}).finally(() => { settled = true; });
  pending.catch(() => {}); await flush();
  const c = clients[0], data = audioFixture();
  assert.equal(api.continuousSnapshot('foreign-turn'), null);
  api.continuousControl('audible-turn', {allow: false, paused: false, volume: 1, pan: 0});
  c.data(data.pcm(data.samples.subarray(0, 3200))); await flush();
  assert.equal(instances.length, 0, 'ownerless PCM must wait');
  assert.equal(standbys[0].packets.length, 0); assert.equal(standbys[0].stopped, undefined);
  c.data(data.faces); await flush();
  assert.equal(instances[0].packets.length, 1, 'playback need not wait for source completion');
  assert.equal(instances[0].controls.length, 1);
  c.data(data.pcm(data.samples.subarray(3200))); await flush();
  assert.deepEqual(instances[0].packets.map(p => p.offsetFrames), [0, 1600]);
  assert.deepEqual(Buffer.concat(instances[0].packets.map(p => p.bytes)), data.samples);
  c.data(data.stats); c.data(data.terminal); finalText(c);
  await new Promise(done => setTimeout(done, 80));
  assert.equal(instances[0].totalFrames, 3200); assert.equal(settled, false);
  const progress = api.continuousSnapshot('audible-turn');
  assert.equal(progress.sourceComplete, true); assert.equal(progress.faces.length, 24);
  assert.equal(progress.pcm, undefined, 'analysis PCM is returned only when requested');
  // The bridge's facial model reads an analysis copy by absolute frame offset.
  const analysis = api.continuousSnapshot('audible-turn', 1000).pcm;
  assert.equal(analysis.offsetFrames, 1000); assert.equal(analysis.frames, 2200);
  assert.deepEqual(Buffer.from(analysis.data, 'base64'), data.samples.subarray(2000));
  assert.equal(api.continuousSnapshot('audible-turn', 3200).pcm, undefined);
  assert.equal(progress.text, 'Hello V.'); assert.equal(progress.textComplete, true);
  assert.equal(JSON.stringify(progress).includes('test-key'), false);
  assert.equal(JSON.stringify(progress).includes(data.owner.response_id), false);
  instances[0].drain();
  assert.equal(api.continuousControl('audible-turn', {allow: true}), false, 'drained sink cannot be reopened');
  const result = await pending;
  assert.equal(result.continuous, true); assert.equal(Object.hasOwn(result, 'audio'), false);
  assert.equal(result.faces.length, 24); assert.equal(instances[0].stopped, 'completed');
  assert.equal(standbys[0].stopped, 'Standby replaced', '24 kHz standby cannot carry 8 kHz source PCM');
  assert.equal(api.continuousSnapshot('audible-turn').ended, true);
  assert.equal(api.continuousSnapshot('audible-turn', 3000).pcm.frames, 200, 'the drained turn still serves its tail');
  await api.close();
});

// 2026-10-21 reports (0.2.6, Convai voice, multilingual twins): a live turn whose packets say 24 kHz and carry 44.1 kHz audio is already playing at 24 kHz when the statistics correct the rate, so the
// turn fails ("Invalid continuous speech state"). The page puts what the statistics showed into the snapshot, so the host can remember it for the character even though this turn fails.
test('a live turn with mislabelled packets shows the corrected rate in its snapshot once the statistics arrive', async () => {
  const {Player, instances} = playerFixture();
  const {api, clients} = fixture({player: Player});
  await api.warm(config);
  const pending = api.reply({...config, liveSpeechToken: 'mislabelled-turn'}); pending.catch(() => {}); await flush();
  const c = clients[0], data = audioFixture({seconds: .4, sampleRate: 44100});
  c.data(data.faces); c.data(wire({type: 'audio-data', audio: data.samples.toString('base64'), sample_rate: 24000, channels: 1, includes_wav_header: false})); await flush();
  const early = api.continuousSnapshot('mislabelled-turn');
  assert.equal(early.sampleRate, 24000); assert.equal(Object.hasOwn(early, 'sampleRateCorrected'), false);
  assert.equal(instances[0].format.sampleRate, 24000, 'the player started at the label, as the first turn of a character cannot know better');
  c.data(data.stats); c.data(data.terminal); finalText(c); await new Promise(done => setTimeout(done, 80));
  const late = api.continuousSnapshot('mislabelled-turn');
  assert.equal(late.sampleRateCorrected.declared, 24000); assert.equal(late.sampleRateCorrected.actual, 44100); assert.equal(late.sampleRate, 44100);
  assert.equal(late.openedSampleRate, 24000, 'and the rate the player runs at, which the live checks of the bridge keep using');
  assert.equal(Object.hasOwn(early, 'openedSampleRate'), false, 'nothing to say while the label stands');
  assert.equal(Object.hasOwn(late, 'sampleRateHintMissed'), false);
  instances[0].drain(); await pending; await api.close();
});

test('a live turn told the rate of its character starts at it, and says so in its snapshot when the statistics do not confirm it', async () => {
  const hint = {declared: 24000, actual: 44100};
  const {Player, instances} = playerFixture();
  const {api, clients} = fixture({player: Player});
  await api.warm(config);
  const pending = api.reply({...config, liveSpeechToken: 'hinted-turn', audioRate: hint}); pending.catch(() => {}); await flush();
  const c = clients[0], data = audioFixture({seconds: .4, sampleRate: 24000});
  c.data(data.faces); c.data(data.pcm()); await flush();
  assert.equal(api.continuousSnapshot('hinted-turn').sampleRate, 44100, 'taken at the remembered rate from the first packet');
  // The audio was labelled right this time (24 kHz data under a 24 kHz label): the statistics give way to the label and the snapshot says the hint missed.
  c.data(data.stats); c.data(data.terminal); finalText(c); await new Promise(done => setTimeout(done, 80));
  const late = api.continuousSnapshot('hinted-turn');
  assert.equal(late.sampleRateHintMissed, true); assert.equal(late.sampleRate, 24000); assert.equal(Object.hasOwn(late, 'sampleRateCorrected'), false);
  instances[0].drain(); await pending; await api.close();
});

test('continuous renderer startup failure cancels the provider without returning a duplicate WAV fallback', async () => {
  const {Player, instances} = playerFixture({openError: 'Test audio output unavailable'});
  const {api, clients} = fixture({player: Player}); await api.warm(config);
  const pending = api.reply({...config, liveSpeechToken: 'failed-turn'}); pending.catch(() => {}); await flush();
  sendAudio(clients[0]); finalText(clients[0]);
  await assert.rejects(pending, /Test audio output unavailable/);
  assert.equal(clients[0].isBotReady, false); assert.equal(instances.length, 0);
});

test('continuous clock faults preserve only bounded numeric evidence through append and collection failures', async () => {
  for (const phase of ['append', 'collect']) {
    const {Player} = playerFixture();
    const numbers = {previousStart: .125, previousEnd: .25, previousFrom: 100, previousTo: 200,
      nextStart: .2, nextEnd: .3, nextFrom: 199, nextTo: 300};
    class FaultyPlayer extends Player {
      async append(bytes, offsetFrames) {
        await super.append(bytes, offsetFrames);
        this.state = {...this.state, state: 'error', error: 'Sensitive renderer string must not leak',
          clockDiagnostic: {...numbers, key: 'private-key', endUserId: 'private-id',
            text: 'private-dialogue', unknownNumber: 999,
            ...(phase === 'collect' ? {previousTo: Infinity, nextFrom: Number.MAX_SAFE_INTEGER + 1, nextTo: 'private-string'} : {})}};
        if (phase === 'append') throw Error(this.state.error);
      }
    }
    const {api, clients} = fixture({player: FaultyPlayer}); await api.warm(config);
    const pending = api.reply({...config, liveSpeechToken: 'clock-fault'}); pending.catch(() => {}); await flush();
    sendAudio(clients[0]); finalText(clients[0]); await flush();
    const expected = {...numbers};
    if (phase === 'collect') { delete expected.previousTo; delete expected.nextFrom; delete expected.nextTo; }
    const validate = error => {
      assert.match(error.message, /^Continuous PCM clock failure; clock=/);
      assert.deepEqual(JSON.parse(error.message.split('clock=')[1]), expected);
      assert.doesNotMatch(error.message, /private|Sensitive|unknownNumber/);
      assert.ok(error.message.length < 350);
      return true;
    };
    assert.throws(() => api.continuousSnapshot('clock-fault'), validate);
    await assert.rejects(pending, validate);
    assert.throws(() => api.continuousSnapshot('clock-fault'), validate);
    assert.equal(clients[0].isBotReady, false);
    await api.close();
  }
});

test('continuous cancellation fences pending append acknowledgements and late controls', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const {Player, instances} = playerFixture({appendGate: () => gate});
  const {api, clients} = fixture({player: Player}); await api.warm(config);
  const pending = api.reply({...config, liveSpeechToken: 'cancelled-turn'}); pending.catch(() => {}); await flush();
  const data = audioFixture(); clients[0].data(data.faces);
  clients[0].data(data.pcm(data.samples.subarray(0, 3200)));
  clients[0].data(data.pcm(data.samples.subarray(3200))); await flush();
  await api.close('User cancelled'); release(); await flush();
  await assert.rejects(pending, /User cancelled/);
  assert.equal(instances[0].packets.length, 1, 'a queued later packet cannot start after cancellation');
  assert.equal(api.continuousControl('cancelled-turn', {allow: true}), false);
  assert.equal(instances[0].stopped, 'User cancelled');
});

test('microphone finish attaches continuous playback before end-of-input and reuses its recording owner', async () => {
  const {Player, instances, standbys} = playerFixture();
  const {api, clients} = fixture({player: Player, allowMic: true}); await api.beginVoice(config);
  clients[0].chatMessages = [{id: 'live-stt', type: 'user-transcription', content: '\tWhat do you both\u0000 think?\n', isStreaming: false}];
  clients[0].handlers.get('messagesChange')(clients[0].chatMessages);
  const pending = api.finishVoice({...config, liveSpeechToken: 'microphone-turn'}); pending.catch(() => {}); await flush();
  assert.equal(standbys.length, 1, 'the device opens when the recording finishes');
  sendAudio(clients[0]); finalText(clients[0]);
  await new Promise(done => setTimeout(done, 80));
  assert.equal(instances[0].packets.length, 1); assert.equal(instances[0].totalFrames, 3200);
  assert.equal(clients[0].room.localParticipant.audioTrackPublications.size, 0);
  assert.equal(api.continuousSnapshot('microphone-turn').userText, 'What do you both think?');
  instances[0].drain();
  const result = await pending;
  assert.equal(result.continuous, true); assert.equal(result.userText, 'What do you both think?');
  assert.equal(api.continuousSnapshot('microphone-turn').userText, result.userText);
  await api.close();
});

test('the output device opens on standby at turn start and the first audio promotes it without reopening', async () => {
  const {Player, instances, standbys} = playerFixture();
  const {api, clients} = fixture({player: Player}); await api.warm(config);
  const pending = api.reply({...config, liveSpeechToken: 'standby-turn'}); pending.catch(() => {}); await flush();
  assert.equal(standbys.length, 1, 'the device opens before any audio exists');
  assert.deepEqual(JSON.parse(JSON.stringify(standbys[0].format)),
    {sampleRate: 24000, channels: 1, token: 'standby-turn', standby: true});
  assert.equal(instances.length, 0);
  // The bridge's quiet controls during the provider's thinking wait for the stream.
  assert.equal(api.continuousControl('standby-turn', {allow: false, paused: true, volume: 0, pan: 0}), true);
  assert.equal(standbys[0].controls.length, 0);
  const data = audioFixture({sampleRate: 24000}); sendAudio(clients[0], data); finalText(clients[0]);
  await new Promise(done => setTimeout(done, 80));
  assert.deepEqual(instances, [standbys[0]], 'the standby device itself carries the turn');
  assert.equal(standbys[0].armed, true); assert.equal(standbys.length, 1, 'no second device was opened');
  assert.deepEqual(Buffer.concat(standbys[0].packets.map(p => p.bytes)), data.samples);
  assert.equal(standbys[0].controls.length, 1, 'the control that waited for the device is applied after arming');
  assert.equal(api.continuousControl('standby-turn', {allow: true, paused: false, volume: 1, pan: 0}), true);
  assert.equal(standbys[0].controls.at(-1).allow, true);
  standbys[0].drain();
  const result = await pending;
  assert.equal(result.continuous, true); assert.equal(standbys[0].stopped, 'completed');
  await api.close();
});

test('a different source format discards the standby device and opens one in the ordinary way', async () => {
  const {Player, instances, standbys} = playerFixture();
  const {api, clients} = fixture({player: Player}); await api.warm(config);
  const pending = api.reply({...config, liveSpeechToken: 'other-format'}); pending.catch(() => {}); await flush();
  const data = audioFixture({sampleRate: 16000}); sendAudio(clients[0], data); finalText(clients[0]);
  await new Promise(done => setTimeout(done, 80));
  assert.equal(standbys[0].stopped, 'Standby replaced'); assert.equal(instances.length, 1);
  assert.notEqual(instances[0], standbys[0]); assert.equal(instances[0].format.sampleRate, 16000);
  assert.equal(instances[0].format.standby, undefined);
  instances[0].drain(); await pending; await api.close();
});

test('a standby device that cannot open never fails the turn: the first audio opens one as before', async () => {
  const {Player, instances, standbys} = playerFixture({standbyError: 'Test audio output unavailable'});
  const {api, clients} = fixture({player: Player}); await api.warm(config);
  const pending = api.reply({...config, liveSpeechToken: 'no-standby'}); pending.catch(() => {}); await flush();
  assert.equal(standbys.length, 0); assert.equal(api.diagnostics().activeTurn, true);
  sendAudio(clients[0], audioFixture({sampleRate: 24000})); finalText(clients[0]);
  await new Promise(done => setTimeout(done, 80));
  assert.equal(instances.length, 1); assert.equal(instances[0].format.sampleRate, 24000);
  instances[0].drain(); assert.equal((await pending).continuous, true); await api.close();
});

test('cancelling a turn that is still waiting for its first audio closes the standby device', async () => {
  const {Player, instances, standbys} = playerFixture();
  const {api} = fixture({player: Player}); await api.warm(config);
  const pending = api.reply({...config, liveSpeechToken: 'cancelled-early'}); pending.catch(() => {}); await flush();
  assert.equal(standbys.length, 1); assert.equal(standbys[0].stopped, undefined);
  await api.close('User cancelled');
  await assert.rejects(pending, /User cancelled/);
  assert.equal(standbys[0].stopped, 'User cancelled'); assert.equal(instances.length, 0);
  assert.equal(api.continuousControl('cancelled-early', {allow: true}), false);
});

test('a turn that never receives audio closes the standby device when the reply times out', async () => {
  let offset = 0;
  const clock = {now: () => performance.now() + offset};
  const {Player, instances, standbys} = playerFixture();
  const {api, clients} = fixture({player: Player, clock}); await api.warm(config);
  const pending = api.reply({...config, liveSpeechToken: 'silent-turn'}); pending.catch(() => {}); await flush();
  finalText(clients[0]);
  offset = 61000; // past the 60 s reply ceiling
  await assert.rejects(pending, /did not finish the reply/);
  assert.equal(standbys[0].stopped, 'Convai did not finish the reply'); assert.equal(instances.length, 0);
  assert.equal(clients[0].isBotReady, false);
});

test('a voice recording that produced no transcript and no reply fails as no speech, long before the 60 s ceiling', async () => {
  let offset = 0;
  const clock = {now: () => performance.now() + offset};
  const {api, clients} = fixture({allowMic: true, clock});
  const request = {...config, ttsEnabled: false};
  await api.beginVoice(request);
  const pending = api.finishVoice(request); pending.catch(() => {}); await flush();
  offset = 14000; await new Promise(done => setTimeout(done, 120));
  assert.equal(api.diagnostics().activeTurn, true, 'still waiting inside the recognition window');
  offset = 16000;
  await assert.rejects(pending, error => /No speech was heard/.test(error.message) && !/did not finish/.test(error.message));
  assert.equal(clients[0].isBotReady, false);
  await api.close();
});

test('the no-speech failure never cuts off a recognised or still-thinking voice turn, and the 60 s timeout says what arrived', async () => {
  for (const mode of ['transcript', 'thinking']) {
    let offset = 0;
    const clock = {now: () => performance.now() + offset};
    const {api, clients} = fixture({allowMic: true, clock});
    const request = {...config, ttsEnabled: false};
    await api.beginVoice(request);
    const pending = api.finishVoice(request); pending.catch(() => {}); await flush();
    if (mode === 'thinking') clients[0].state.isThinking = true;
    else clients[0].handlers.get('messagesChange')([{id: 'speech', type: 'user-transcription', content: 'Hello there', isStreaming: false}]);
    offset = 16000; await new Promise(done => setTimeout(done, 120));
    assert.equal(api.diagnostics().activeTurn, true, mode + ' keeps waiting past the no-speech window');
    offset = 61000;
    await assert.rejects(pending, error => /did not finish the reply \(transcript=(true|false) text=false /.test(error.message)
      && error.message.includes(mode === 'transcript' ? 'transcript=true' : 'thinking=true'));
    await api.close();
  }
});

test('a text send that fails before collection releases the standby device', async () => {
  const {Player, standbys} = playerFixture();
  const {api, clients} = fixture({player: Player}); await api.warm(config);
  clients[0].sendUserTextMessage = () => { throw Error('Test send failure'); };
  await assert.rejects(api.reply({...config, liveSpeechToken: 'send-fails'}), /Test send failure/);
  assert.equal(standbys.length, 1); assert.equal(standbys[0].stopped, 'Conversation failed');
  await api.close();
});

test('text-only turns never instantiate a continuous audio player even with an explicit token', async () => {
  const {api, clients} = fixture(); await api.warm({...config, ttsEnabled: false});
  const pending = api.reply({...config, ttsEnabled: false, liveSpeechToken: 'text-only'}); await flush();
  finalText(clients[0]); const result = await pending;
  assert.equal(result.continuous, undefined); assert.equal(api.continuousSnapshot('text-only'), null); await api.close();
});

test('additional source PCM after validation cannot be hidden while continuous playback drains', async () => {
  const {Player, instances} = playerFixture();
  const {api, clients} = fixture({player: Player}); await api.warm(config);
  const pending = api.reply({...config, liveSpeechToken: 'closed-source'}); pending.catch(() => {}); await flush();
  const data = sendAudio(clients[0]); finalText(clients[0]);
  await new Promise(done => setTimeout(done, 80));
  assert.equal(instances[0].state.state, 'draining');
  clients[0].data(data.pcm());
  await assert.rejects(pending, /after its validated source completed/);
  assert.equal(instances[0].state.state, 'stopped'); assert.equal(clients[0].isBotReady, false);
});

test('invalid continuous admission cannot leave an active turn or submit text', async () => {
  const {Player} = playerFixture();
  const {api, clients, events} = fixture({player: Player}); await api.warm(config);
  await assert.rejects(api.reply({...config, liveSpeechToken: '../not-an-owner'}), /Invalid live speech token/);
  assert.equal(api.diagnostics().activeTurn, false);
  assert.equal(events.some(row => row[0] === 'message'), false);
  const pending = api.reply(config); await flush(); sendAudio(clients[0]); finalText(clients[0]);
  assert.equal((await pending).continuous, undefined); await api.close();
});

// Party membership actions (docs/WORLD_COMPANIONS.md): follow in private chat,
// leave in private chat or from a group round's first speaker.
test('a group round arms only its leave offer, and a private offer never arms in a group scope', async () => {
  const accepted = [], {api, clients, events} = fixture({onCompanionAction: value => accepted.push(value)});
  const token = 'drive-' + '7'.padStart(20, '0');
  const group = {...config, scope: 'group:judy-alvarez,panam-palmer', endUserId: 'fixture-user', ttsEnabled: false,
    companionAction: {version: 1, token, source: 'group-text', expiresAt: Date.now() + 89000, drive: false, group: true,
      leave: {members: [{name: 'Judy Alvarez', self: true}, {name: 'Panam Palmer', self: false}]}}};
  await api.warm(group);
  const reply = api.reply(group); await flush(); const client = clients[0];
  const published = events.filter(row => row[0] === 'publish').at(-1)[1].data;
  assert.deepEqual(published.action_config.actions,
    [`Leave V's Party ${token}`, `Panam Palmer Leaves V's Party ${token}`, `Everyone Leaves V's Party ${token}`]);
  assert.match(published.text, /Only the companion V addresses leaves/);
  assert.equal(api.diagnostics().actions.eligibility.groupManual, true);
  client.data(wire({type: 'action-response', actions: [{name: `Panam Palmer Leaves V's Party ${token}`}]})); await flush();
  assert.deepEqual(accepted, [{version: 1, token, leave: 2}]);
  finalText(client); await reply;
  // The same follow offer that private chat would arm is ignored in a group scope.
  const follow = {...group, companionAction: {version: 1, token: 'drive-' + '8'.padStart(20, '0'), source: 'private-text',
    expiresAt: Date.now() + 89000, drive: false, follow: {name: 'Judy Alvarez'}}};
  const second = api.reply(follow); await flush();
  assert.deepEqual(events.filter(row => row[0] === 'publish').at(-1)[1].data.action_config.actions, []);
  assert.equal(api.diagnostics().actions.eligibility.armed, false);
  finalText(client, 'Next.', 'reply-2'); await second; await api.close();
});

test('a private follow offer arms the world character and a group-flagged offer is refused in private chat', async () => {
  const accepted = [], {api, clients, events} = fixture({onCompanionAction: value => accepted.push(value)});
  const request = chauffeurConfig(9);
  request.companionAction = {...request.companionAction, drive: false, follow: {name: 'Judy Alvarez'}};
  await api.warm(request);
  const reply = api.reply(request); await flush(); const client = clients[0];
  const published = events.filter(row => row[0] === 'publish').at(-1)[1].data;
  assert.deepEqual(published.action_config.actions, [`Follow V ${request.companionAction.token}`]);
  assert.match(published.text, /come along with V as a companion/);
  client.data(wire({type: 'action-response', actions: [{name: 'Follow V', target: request.companionAction.token}]})); await flush();
  assert.deepEqual(accepted, [{version: 1, token: request.companionAction.token, follow: true}]);
  finalText(client); await reply;
  const flagged = {...request, companionAction: {...request.companionAction, token: 'drive-' + '10'.padStart(20, '0'),
    source: 'group-text', group: true, follow: undefined, leave: {members: [{name: 'Judy Alvarez', self: true}]}}};
  const second = api.reply(flagged); await flush();
  assert.deepEqual(events.filter(row => row[0] === 'publish').at(-1)[1].data.action_config.actions, []);
  finalText(client, 'Next.', 'reply-2'); await second; await api.close();
});

test('a usage-limit-reached message fails the turn with a quota marker, and a configuration fault does not', async () => {
  for (const [quota, kind] of [['interaction', 'interaction'], ['tts', 'tts'], ['other', 'plan'], [undefined, 'plan']]) {
    const {api, clients} = fixture();
    await api.warm({...config, ttsEnabled: false});
    const reply = api.reply({...config, ttsEnabled: false}); await flush();
    clients[0].data(wire({type: 'usage-limit-reached', quota_type: quota, message: 'Plan limit'}));
    await assert.rejects(reply, error => error.message === `Convai usage limit reached [convai-quota:${kind}]`);
    await api.close();
  }
  const {api, clients} = fixture();
  await api.warm({...config, ttsEnabled: false});
  const reply = api.reply({...config, ttsEnabled: false}); await flush();
  clients[0].data(wire({type: 'usage-limit-reached', quota_type: 'error', message: 'Service fault'}));
  finalText(clients[0]); assert.equal((await reply).text, 'Hello V.');
  await api.close();
});

test('the recognised words of a voice turn are readable while V talks: finalized segments, then the live one, newest words only', async () => {
  const {api, clients} = fixture({allowMic: true});
  const request = {...config, ttsEnabled: false};
  assert.equal(api.heard(), '', 'no turn, nothing heard');
  await api.beginVoice(request);
  const live = clients[0].handlers.get('userTranscriptionChange');
  assert.equal(api.heard(), '');
  live('what do');
  assert.equal(api.heard(), 'what do');
  const speech = {id: 'speech', type: 'user-transcription', content: 'What do you', isStreaming: true};
  clients[0].chatMessages = [speech];
  clients[0].handlers.get('messagesChange')([speech]); live('');
  assert.equal(api.heard(), 'What do you');
  live('think\u0000 of\n\tit');
  assert.equal(api.heard(), 'What do you think of it');
  live('x'.repeat(30) + ' ' + 'word '.repeat(60));
  const tail = api.heard();
  assert(tail.startsWith('\u2026') && [...tail].length <= 101, 'long speech keeps only its newest words');
  assert(tail.endsWith('word'));
  live(42); assert.equal(api.heard(), 'What do you');
  const pending = api.finishVoice(request); await flush();
  clients[0].handlers.get('messagesChange')([{...speech, content: 'What do you think?', isStreaming: false},
    {id: 'reply', type: 'bot-llm-text', content: 'Hm.', isStreaming: false}]);
  assert.equal(api.heard(), 'What do you think?', 'the final transcript replaces the live words before the reply is handed over');
  await pending;
  assert.equal(api.heard(), '', 'nothing is heard once the turn is over');
  await api.close();
});

test('only a microphone turn exposes heard words: a text reply never does', async () => {
  const {api, clients} = fixture({allowMic: true});
  const request = {...config, ttsEnabled: false}; await api.warm(request);
  const pending = api.reply(request); pending.catch(() => {}); await flush();
  clients[0].handlers.get('userTranscriptionChange')?.('should be ignored');
  assert.equal(api.heard(), '');
  finalText(clients[0]); await pending; await api.close();
});

test('vision: the session connects with video on the silent lane, and a picture that cannot be handed over never fails the turn', async () => {
  const {api, clients, events} = fixture();
  const request = {...config, ttsEnabled: false, vision: true, visionImages: [{mime: 'image/jpeg', base64: '/9j/2Q=='}]};
  const pending = api.reply(request);
  await until(() => events.some(event => event[0] === 'message'), 'the text message to be sent');
  const client = clients[0];
  assert.equal(client.options.enableVideo, true);
  assert.equal(client.options.startWithVideoOn, false);
  assert.deepEqual({...client.options.respondModes}, {contextUpdate: 'silent', vision: 'silent'});
  assert.equal(client.options.visionInputConfig.framesPerTurn, 1);
  finalText(client);
  assert.equal((await pending).text, 'Hello V.');
  // The fixture session has no video channel, so the picture is skipped and the context does not mention one.
  assert.doesNotMatch(events.find(event => event[0] === 'context')[1].text, /image of what V sees/);
  assert.deepEqual(events.filter(event => event[0] === 'message'), [['message', 'Hello']]);
  assert.equal(api.diagnostics().vision.skipped, 1);
  assert.equal(api.diagnostics().vision.lastReason, 'no-video-session');
});

test('vision: a picture that is still being published, with a server that never answers or says vision_not_enabled, does not delay the line', async () => {
  class PendingVision extends ConvaiVision {
    async stage() { this.staged = {started: performance.now(), ready: new Promise(() => {}), published: false, attached: false}; return {staged: true}; }
    async retire() { this.staged = null; }
  }
  const {api, clients, events} = fixture({visionClass: PendingVision});
  const request = {...config, ttsEnabled: false, vision: true, visionImages: [{mime: 'image/jpeg', base64: '/9j/2Q=='}]};
  const pending = api.reply(request);
  await until(() => events.some(event => event[0] === 'message'), 'the text message to be sent without waiting for the picture');
  const ready = api.diagnostics().wire.visionReady;
  assert.deepEqual([ready.published, ready.waitedMs], [false, 0], 'the default wait is none');
  assert.match(events.find(event => event[0] === 'context')[1].text, /An image of your surroundings may be attached/);
  finalText(clients[0]);
  assert.equal((await pending).text, 'Hello V.');
});

// 0.2.5 report: "Cannot read properties of null (reading 'updateContext')". reply() waits for the connection and for the picture; close() during either wait leaves no connection.
test('a connection closed while the turn waits for its picture cancels the turn (an AbortError, nothing sent), never a TypeError on the missing connection', async () => {
  let release, entered = false;
  const gate = new Promise(resolve => { release = resolve; });
  class SlowVision extends ConvaiVision {
    async stage(...args) { entered = true; await gate; return super.stage(...args); }
  }
  const {api, events} = fixture({visionClass: SlowVision});
  const request = {...config, ttsEnabled: false, vision: true, visionImages: [{mime: 'image/jpeg', base64: '/9j/2Q=='}]};
  const pending = api.reply(request);
  const rejected = assert.rejects(pending, error => error.name === 'AbortError' && /cancelled/.test(error.message) && !(error instanceof TypeError));
  await until(() => entered, 'the picture to be staged');
  await api.close();
  release();
  await rejected;
  assert.equal(events.some(event => event[0] === 'context' || event[0] === 'message'), false, 'nothing was sent to a connection that is gone');
  // The session works again afterwards: a turn on a new connection is answered.
  const again = api.reply({...config, ttsEnabled: false, text: 'Again'});
  await until(() => events.some(event => event[0] === 'message'), 'the next turn to be sent');
  await api.close(); await assert.rejects(again, /cancelled/);
});

test('vision: without the setting the session connects audio-only, and turning it on reconnects once', async () => {
  const {api, clients, events} = fixture();
  const pending = api.reply({...config, ttsEnabled: false});
  await until(() => events.some(event => event[0] === 'message'), 'the text message to be sent');
  assert.equal(clients[0].options.enableVideo, false);
  assert.equal(clients[0].options.visionInputConfig, undefined);
  assert.deepEqual({...clients[0].options.respondModes}, {contextUpdate: 'silent'});
  finalText(clients[0]);
  await pending;
  assert.equal(api.diagnostics().vision, null);
  const second = api.reply({...config, ttsEnabled: false, vision: true, text: 'Again'});
  await until(() => events.some(event => event[0] === 'message' && event[1] === 'Again'), 'the second text message to be sent');
  assert.equal(clients.length, 2);
  assert.equal(clients[1].options.enableVideo, true);
  finalText(clients[1], 'Hi.', 'second');
  await second;
});

// ---- A text-only reply read while Convai is still writing it (bridge/realtime-host.mjs, textStream) ----------------------------------------

function streamingRows(client, text, {done = false, id = 'reply'} = {}) {
  const rows = [...client.chatMessages.filter(row => row.id !== id), {id, type: 'bot-llm-text', content: text, isStreaming: !done}];
  client.chatMessages = rows; client.state.isThinking = !done;
  client.handlers.get('messagesChange')(rows);
}

test('partialReply gives the text so far of the turn that asked for it, and nothing for any other key, before the turn, or after it', async () => {
  const {api, clients} = fixture();
  const cfg = {...config, ttsEnabled: false, textStreamKey: 'turn-key-1'};
  await api.warm(cfg);
  assert.equal(api.partialReply('turn-key-1'), '', 'no turn yet');
  const pending = api.reply(cfg); await flush();
  const client = clients[0];
  assert.equal(api.partialReply('turn-key-1'), '', 'a turn with no text yet');
  streamingRows(client, 'Sure, V. I can');
  assert.equal(api.partialReply('turn-key-1'), 'Sure, V. I can');
  assert.equal(api.partialReply('another-key'), '', 'another turn never reads this one');
  assert.equal(api.partialReply(), '');
  assert.equal(api.partialReply('bad key!'), '');
  streamingRows(client, 'Sure, V. I can help with that.', {done: true});
  const result = await pending;
  assert.equal(result.text, 'Sure, V. I can help with that.', 'the reply call still returns the whole text');
  assert.equal(api.partialReply('turn-key-1'), '', 'a finished turn is not readable');
  // The next turn has no key of its own unless it asks for one: it never inherits the older reply's text.
  const second = api.reply({...cfg, textStreamKey: undefined}); await flush();
  streamingRows(client, 'Second reply.', {id: 'two'});
  assert.equal(api.partialReply('turn-key-1'), '');
  streamingRows(client, 'Second reply.', {id: 'two', done: true}); await second;
  await api.close();
});

// ---- instant push-to-talk: the microphone comes from a PcmRelay the bridge pushes into ----
function relayFixture({openFails = false, deadTrack = false, enableFailsOnce = false, ...rest} = {}) {
  const events = [], relays = [];
  class FakeRelay {
    constructor() {
      relays.push(this); this.pushed = []; this.closed = 0;
      this.track = {readyState: deadTrack ? 'ended' : 'live', label: 'MediaStreamAudioDestinationNode', stop() { this.readyState = 'ended'; }};
      this.stream = {id: 'relay-stream', getTracks: () => [this.track]};
    }
    async open() { events.push('relay-open'); if (openFails) throw Error('no worklets'); }
    start() { events.push('relay-start'); }
    pushBase64(text) { this.pushed.push(text); return true; }
    async drain(timeoutMs) { events.push(['drain', timeoutMs]); return {drained: true, waitedMs: 3}; }
    close() { this.closed++; events.push('relay-close'); }
  }
  const original = async constraints => ({id: 'native', constraints});
  const navigator = {mediaDevices: {getUserMedia: original}};
  const seen = {streams: [], videoAnswers: [], enableCalls: 0, duringOverride: []};
  let failed = !enableFailsOnce;
  const onEnableAudio = async client => {
    seen.enableCalls++;
    seen.duringOverride.push(navigator.mediaDevices.getUserMedia !== original);
    if (!failed) { failed = true; throw Error('publish failed'); }
    const stream = await navigator.mediaDevices.getUserMedia({audio: {deviceId: 'default'}});
    seen.videoAnswers.push(await navigator.mediaDevices.getUserMedia({video: true}));
    seen.streams.push(stream);
    const track = stream.getTracks ? stream.getTracks()[0]
      : {readyState: 'live', label: 'MediaStreamAudioDestinationNode', stop() { this.readyState = 'ended'; }};
    client.room.localParticipant.audioTrackPublications.set('mic', {source: 'microphone', isMuted: false, track: {mediaStreamTrack: track}});
  };
  const made = fixture({allowMic: true, events, onEnableAudio, relayClass: FakeRelay, navigator, ...rest});
  return {...made, events, relays, navigator, original, seen};
}

test('relay voice: the SDK publishes the relay stream through a getUserMedia override that exists only during enableAudio', async () => {
  const {api, clients, events, relays, navigator, original, seen} = relayFixture();
  const opened = JSON.parse(JSON.stringify(await api.beginVoice(config, {relay: true, device: 'Real Microphone'})));
  assert.deepEqual(opened, {device: 'Real Microphone', sessionID: clients[0].characterSessionId, relay: true});
  assert.equal(relays.length, 1);
  assert.equal(seen.streams[0], relays[0].stream, 'the audio request was answered with the relay stream');
  assert.equal(seen.videoAnswers[0].id, 'native', 'anything but an audio-only request goes to the real device API');
  assert.deepEqual([...seen.duringOverride], [true]);
  assert.equal(navigator.mediaDevices.getUserMedia, original, 'restored right after enableAudio');
  assert.equal(Object.hasOwn(navigator.mediaDevices, 'getUserMedia'), true);
  assert.equal(clients[0].room.localParticipant.audioTrackPublications.get('mic').track.mediaStreamTrack, relays[0].track);
  assert.ok(events.indexOf('relay-open') < events.indexOf('microphone'));
  await api.close();
  assert.equal(relays[0].closed, 1); assert.equal(relays[0].track.readyState, 'ended', 'close() ends the track');
});

test('relay voice: the override is removed again when getUserMedia was only on the prototype', async () => {
  const proto = {getUserMedia: async () => ({id: 'proto'})};
  const {api, navigator, seen} = relayFixture();
  navigator.mediaDevices = Object.create(proto);
  await api.beginVoice(config, {relay: true});
  assert.equal(Object.hasOwn(navigator.mediaDevices, 'getUserMedia'), false);
  assert.equal(navigator.mediaDevices.getUserMedia, proto.getUserMedia);
  assert.equal(seen.streams.length, 1);
  await api.close();
});

test('relay voice: the device name falls back to the track label when the bridge gives none', async () => {
  const {api} = relayFixture();
  const opened = await api.beginVoice(config, {relay: true});
  assert.equal(opened.device, 'MediaStreamAudioDestinationNode'); assert.equal(opened.relay, true);
  await api.close();
});

test('pushAudio forwards to the turn\'s relay, drainAudio asks it to drain, neither does anything without one', async () => {
  const {api, relays} = relayFixture();
  assert.equal(api.pushAudio('AAAA'), false);
  assert.deepEqual({...await api.drainAudio(100)}, {drained: true, waitedMs: 0});
  await api.beginVoice(config, {relay: true});
  assert.equal(api.pushAudio('AAAA'), true); assert.equal(api.pushAudio('BBBB'), true);
  assert.deepEqual([...relays[0].pushed], ['AAAA', 'BBBB'], 'order preserved');
  assert.deepEqual({...await api.drainAudio(321)}, {drained: true, waitedMs: 3});
  await api.close();
  assert.equal(api.pushAudio('CCCC'), false, 'a closed turn takes no more audio');
  assert.deepEqual([...relays[0].pushed], ['AAAA', 'BBBB']);
});

test('audio pushed while the connection is still starting reaches the relay (it is created first)', async () => {
  let release; const gate = new Promise(resolve => { release = resolve; });
  const {api, relays} = relayFixture({onConnect: () => gate});
  const starting = api.beginVoice(config, {relay: true}); await flush();
  assert.equal(relays.length, 1);
  assert.equal(api.pushAudio('EARLY'), true);
  release(); await starting;
  assert.deepEqual([...relays[0].pushed], ['EARLY']);
  await api.close();
});

test('finishing a relay turn drains the relay before the microphone is disabled, then releases it', async () => {
  const {api, clients, events, relays} = relayFixture();
  await api.beginVoice(config, {relay: true}); const client = clients[0];
  const pending = api.finishVoice(config); await flush(); await flush();
  const lastDrain = events.map((event, i) => Array.isArray(event) && event[0] === 'drain' ? i : -1).filter(i => i >= 0).at(-1);
  const disable = events.indexOf('microphone-disable');
  assert.ok(lastDrain >= 0 && disable > lastDrain, 'the last drain is before the track is disabled: ' + JSON.stringify(events));
  assert.equal(relays[0].closed, 1, 'released once the microphone is disabled');
  assert.ok(events.lastIndexOf('relay-close') > disable);
  sendAudio(client); finalText(client); await pending; await api.close();
  assert.equal(relays[0].closed, 1, 'never closed twice');
});

test('a failing disable still releases the relay', async () => {
  const {api, relays} = relayFixture({onDisableAudio: () => { throw Error('disable failed'); }});
  await api.beginVoice(config, {relay: true});
  await assert.rejects(api.finishVoice(config), /disable failed/);
  assert.ok(relays[0].closed >= 1);
  await api.close();
});

test('a relay that cannot open falls back once to the SDK microphone and never touches getUserMedia', async () => {
  const {api, clients, relays, navigator, original, seen} = relayFixture({openFails: true});
  const opened = await api.beginVoice(config, {relay: true, device: 'Real Microphone'});
  assert.equal(opened.relay, false); assert.equal(opened.device, 'MediaStreamAudioDestinationNode');
  assert.equal(seen.enableCalls, 1); assert.deepEqual([...seen.duringOverride], [false]);
  assert.equal(navigator.mediaDevices.getUserMedia, original);
  assert.ok(relays[0].closed >= 1); assert.equal(api.pushAudio('X'), false);
  assert.equal(clients[0].room.localParticipant.audioTrackPublications.size, 1);
  await api.close();
});

test('a failing relay publish restores getUserMedia, closes the relay and falls back to native enableAudio once', async () => {
  const {api, clients, events, relays, navigator, original, seen} = relayFixture({enableFailsOnce: true});
  const opened = await api.beginVoice(config, {relay: true, device: 'Real Microphone'});
  assert.equal(opened.relay, false);
  assert.equal(seen.enableCalls, 2); assert.deepEqual([...seen.duringOverride], [true, false]);
  assert.equal(navigator.mediaDevices.getUserMedia, original);
  assert.equal(relays.length, 1); assert.ok(relays[0].closed >= 1);
  assert.equal(events.filter(event => event === 'microphone').length, 2);
  assert.equal(api.pushAudio('X'), false);
  const pending = api.finishVoice(config); await flush(); sendAudio(clients[0]); finalText(clients[0]); await pending;
  await api.close();
});

test('a relay track that is not live falls back to the SDK microphone', async () => {
  const {api, relays} = relayFixture({deadTrack: true});
  const opened = await api.beginVoice(config, {relay: true});
  assert.equal(opened.relay, false); assert.ok(relays[0].closed >= 1);
  await api.close();
});

test('a startup that fails before the microphone releases the relay', async () => {
  const {api, relays} = relayFixture({onConnect: () => { throw Error('connect failed'); }});
  await assert.rejects(api.beginVoice(config, {relay: true}), /connect failed/);
  assert.equal(relays.length, 1); assert.ok(relays[0].closed >= 1);
  assert.equal(api.pushAudio('X'), false);
});

test('a cancelled relay startup is not retried on the native microphone', async () => {
  let release; const gate = new Promise(resolve => { release = resolve; });
  const {api, events, relays} = relayFixture({onConnect: () => gate});
  const starting = api.beginVoice(config, {relay: true}); starting.catch(() => {}); await flush();
  const closing = api.close(); release(); await closing;
  await assert.rejects(starting);
  assert.equal(events.filter(event => event === 'microphone').length, 0);
  assert.ok(relays[0].closed >= 1);
});

test('without options.relay the microphone path is the old one: no relay, no getUserMedia override', async () => {
  const {api, clients, events, relays, navigator, original} = relayFixture();
  const opened = JSON.parse(JSON.stringify(await api.beginVoice(config)));
  assert.deepEqual(opened, {device: 'MediaStreamAudioDestinationNode', sessionID: clients[0].characterSessionId, relay: false});
  assert.equal(relays.length, 0); assert.equal(navigator.mediaDevices.getUserMedia, original);
  assert.equal(api.pushAudio('X'), false);
  assert.deepEqual({...await api.drainAudio(50)}, {drained: true, waitedMs: 0});
  const pending = api.finishVoice(config); await flush();
  assert.equal(events.some(event => Array.isArray(event) && event[0] === 'drain'), false);
  sendAudio(clients[0]); finalText(clients[0]); await pending; await api.close();
});

test('relay: true is ignored when no PcmRelay class is available', async () => {
  const {api} = fixture({allowMic: true});
  const opened = await api.beginVoice(config, {relay: true});
  assert.equal(opened.relay, false); assert.equal(opened.device, 'fixture microphone');
  await api.close();
});

test('the relay starts playing only once the SDK has published its track, so the pre-roll is not played into a track nobody receives', async () => {
  const {api, events} = relayFixture({onEnableAudio: undefined});
  await api.beginVoice(config, {relay: true});
  assert.ok(events.includes('relay-start'), JSON.stringify(events));
  assert.ok(events.indexOf('relay-start') > events.indexOf('microphone'), 'after the microphone publication: ' + JSON.stringify(events));
  await api.close();
});
