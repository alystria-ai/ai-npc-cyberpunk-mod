import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {journalContext} from './quest-context.mjs';
import {endUserOptions, transportKey, SessionBindings} from './transport-pool.mjs';
import {ConvaiDataAudio} from './convai-data-audio.mjs';

const source = readFileSync(new URL('./realtime-client.mjs', import.meta.url), 'utf8')
  .replace("import {ConvaiClient} from '@convai/web-sdk/vanilla';", '')
  .replace("import {endUserOptions, transportKey, SessionBindings} from './transport-pool.mjs';", '')
  .replace("import {ConvaiDataAudio} from './convai-data-audio.mjs';", '');
const flush = () => new Promise(done => setImmediate(done));
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
function fixture({emitAudio, allowMic = false, timers, onConnect, onDisconnect, onDisableAudio, botReady = true} = {}) {
  const clients = [], events = [];
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
        localParticipant: {audioTrackPublications: new Map(), unpublishTrack: async () => this.room.localParticipant.audioTrackPublications.clear()}};
      this.audioControls = {disableAudio: async () => {
        if (allowMic) events.push('microphone-disable');
        await onDisableAudio?.(this);
      }, enableAudio: async () => {
        events.push('microphone');
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
  const window = {__convaiAudioChunk: emitAudio};
  runInNewContext(source, {ConvaiClient: Client, AudioContext: ForbiddenAudio, AudioWorkletNode: ForbiddenAudio,
    endUserOptions, transportKey, SessionBindings, ConvaiDataAudio, TextDecoder,
    window, performance, setTimeout: timers?.setTimeout ?? setTimeout, clearTimeout: timers?.clearTimeout ?? clearTimeout,
    setInterval, clearInterval,
    btoa: data => Buffer.from(data, 'binary').toString('base64')});
  return {api: window.convaiRealtime, clients, events};
}
const config = {key: 'test-key', characterId: 'alex', scope: 'group:alex,panam', text: 'Hello'};
const wire = data => ({label: 'rtvi-ai', type: 'server-message', data});
function audioFixture({seconds = .4, sequence = 1} = {}) {
  const sampleRate = 8000, fps = 60, samples = Buffer.alloc(Math.round(seconds * sampleRate) * 2);
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
  const client = clients[0], audio = audioFixture({seconds: 3.05}), started = performance.now();
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
  assert(performance.now() - started < 2000, 'collection must not wait 3.05 seconds for browser playback');
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
    const {api, clients} = fixture(); await api.warm(config);
    const old = api.reply(config); old.catch(() => {}); await flush();
    const obsolete = clients[0], audio = audioFixture();
    obsolete.data(audio.pcm(audio.samples.subarray(0, 3200)));
    if (reason === 'cancel') await api.close();
    else obsolete.handlers.get('disconnect')();
    await assert.rejects(old, /cancelled|closed/);
    const pending = api.reply(config); await new Promise(done => setTimeout(done, 80));
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
