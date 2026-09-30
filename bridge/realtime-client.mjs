import {ConvaiClient} from '@convai/web-sdk/vanilla';
import {drainBlendshapes} from './blendshape-capture.mjs';
import {endUserOptions, transportKey, SessionBindings} from './transport-pool.mjs';
import {PcmChunkStream} from './convai-audio-stream.mjs';

let client, identity, context, source, capture, prime, remote, turn, micTimer, verifiedProvider;
let initialSession, submitted = false, epoch = 0, ttsEnabled = true;
const sessions = new SessionBindings();
// The game owns its 30-second recording finish and supplies fresh context.
// This later ceiling is cancellation only if that finish never reaches us.
const MICROPHONE_CANCEL_AFTER_MS = 35000;
const waitFor = (condition, timeout, message) => new Promise((resolve, reject) => {
  const start = performance.now();
  const timer = setInterval(() => {
    try {
      if (condition()) { clearInterval(timer); resolve(); }
      else if (performance.now() - start > timeout) { clearInterval(timer); reject(Error(message)); }
    } catch (error) { clearInterval(timer); reject(error); }
  }, 50);
});

async function close(reason = 'Conversation cancelled') {
  const previous = {client, context, source, capture, prime, remote, turn};
  const microphones = previous.client ? [...previous.client.room.localParticipant.audioTrackPublications.values()]
    .filter(pub => pub.source === 'microphone' && pub.track) : [];
  ++epoch;
  clearTimeout(micTimer);
  micTimer = null;
  if (previous.turn) { previous.turn.error = reason; previous.turn.stream?.abort(); }
  client = context = source = capture = prime = remote = identity = turn = verifiedProvider = null;
  initialSession = null; submitted = false;
  // Closing is cancellation, never an implicit microphone submission. Start
  // transport shutdown before stopping hardware; do not call disableAudio,
  // whose normal end-of-input path is reserved for a verified game finish.
  if (previous.turn) { try { previous.client?.sendInterruptMessage(); } catch {} }
  let disconnected;
  try { disconnected = Promise.resolve(previous.client?.disconnect()).catch(() => {}); }
  catch { disconnected = Promise.resolve(); }
  for (const pub of microphones) { try { pub.track.mediaStreamTrack.stop(); } catch {} }
  previous.source?.disconnect(); previous.capture?.disconnect();
  if (previous.prime) {
    previous.remote?.detach(previous.prime); previous.prime.pause(); previous.prime.srcObject = null; previous.prime.remove();
  }
  // Captured references make delayed teardown unable to erase a new owner.
  await Promise.allSettled([disconnected, previous.context?.close()]);
}

async function connect(config) {
  const started = performance.now();
  const desired = transportKey(config);
  sessions.check(config);
  const sessionMatches = !config.sessionId || config.sessionId === initialSession || config.sessionId === client?.characterSessionId;
  // Preparation can reuse a warmed *unused* anonymous connection. It can
  // never append speculative dialogue to a previously used character session.
  if (identity === desired && client?.isBotReady && sessionMatches
      && (!config.freshSession || (initialSession === '-1' && !submitted))) {
    const connection = client, receipt = await verifyProviderIdentity(config, connection);
    if (client !== connection) throw Error('Conversation startup cancelled');
    sessions.accept(config);
    return {connectionMs: performance.now() - started, connectionReused: true, ...receipt};
  }
  await close();
  const connectionEpoch = epoch;
  identity = desired;
  ttsEnabled = config.ttsEnabled !== false;
  initialSession = config.freshSession ? '-1' : config.sessionId || '-1';
  const connection = client = new ConvaiClient({apiKey: config.key, characterId: config.characterId,
    ...endUserOptions(config),
    characterSessionId: initialSession, transport: 'livekit', startWithAudioOn: false,
    enableVideo: false, enableLipsync: ttsEnabled, ttsEnabled, logRtviMessages: false,
    respondModes: {contextUpdate: 'silent'},
    blendshapeConfig: {format: 'arkit', output_fps: 30}});
  const currentConnection = () => epoch === connectionEpoch && client === connection;
  if (ttsEnabled) {
  context = new AudioContext({sampleRate: 48000});
  await context.audioWorklet.addModule('/capture.js');
  await context.resume();
  capture = new AudioWorkletNode(context, 'convai-capture');
  capture.connect(context.destination); // Processor emits silence, only captures remote NPC audio.
  capture.port.onmessage = ({data}) => {
    if (!currentConnection() || !turn || turn.captureDone) return;
    if (data.pcm.some(x => Math.abs(x) > 0.00015)) {
      turn.lastSignal = performance.now();
      turn.firstAudioMs ??= turn.lastSignal - turn.started;
    }
    if (turn.origin === null) {
      if (!turn.lastSignal) return;
      turn.origin = data.at;
    }
    if (data.at - turn.origin > 120) { turn.error = 'Voice exceeded two minutes'; return; }
    if (turn.stream) {
      try { turn.stream.push(data.pcm); } catch (error) { turn.error = error.message; }
    } else turn.chunks.push(data);
  };
  }
  const attach = track => {
    if (!currentConnection() || !ttsEnabled || track.kind !== 'audio' || source) return;
    remote = track;
    prime = document.createElement('audio'); prime.autoplay = true;
    track.attach(prime); prime.muted = true; prime.volume = 0; document.body.append(prime);
    void prime.play().catch(() => { if (currentConnection() && turn) turn.error = 'Remote audio decoder could not start'; });
    source = context.createMediaStreamSource(new MediaStream([track.mediaStreamTrack]));
    source.connect(capture);
  };
  connection.room.on('trackSubscribed', attach);
  connection.on('error', () => { if (currentConnection() && turn) turn.error = 'Convai realtime connection failed'; });
  connection.on('disconnect', () => { if (currentConnection() && turn) turn.error = 'Convai realtime connection closed'; });
  connection.on('messagesChange', messages => {
    if (!currentConnection() || !turn) return;
    const fresh = messages.filter(m => !turn.before.has(m.id));
    const llm = fresh.filter(m => ['bot-llm-text', 'convai'].includes(m.type) && m.content?.trim());
    const rows = llm.length ? llm : fresh.filter(m => m.type === 'bot-output' && m.content?.trim());
    turn.text = rows.map(m => m.content).join(' ').trim();
    // The SDK marks the LLM message complete on bot-llm-stopped, separately
    // from TTS. Never infer completion from a pause between text tokens.
    turn.textComplete = llm.length > 0 && llm.every(m => m.isStreaming === false);
  });
  connection.on('llmNoResponse', () => { if (currentConnection() && turn) turn.error = 'Convai returned no dialogue'; });
  connection.on('botOutput', data => {
    if (currentConnection() && turn && context && data.text && (data.spoken || ['in-progress', 'completed'].includes(data.spokenStatus))) {
      turn.captions.push({at: context.currentTime, text: data.text});
    }
  });
  await connection.connect();
  await waitFor(() => {
    if (!currentConnection()) throw Error('Conversation startup cancelled');
    return connection.isBotReady;
  }, 20000, 'Convai character did not become ready');
  await verifyProviderIdentity(config, connection);
  if (!currentConnection()) throw Error('Conversation startup cancelled');
  if (ttsEnabled) await connection.room.startAudio();
  if (prime) { prime.muted = true; prime.volume = 0; }
  connection.room.remoteParticipants.forEach(p => p.audioTrackPublications.forEach(pub => { if (pub.track) attach(pub.track); }));
  const receipt = await verifyProviderIdentity(config, connection);
  if (!currentConnection()) throw Error('Conversation startup cancelled');
  sessions.accept(config);
  sessions.bind(config, connection.characterSessionId);
  return {connectionMs: performance.now() - started, connectionReused: false, ...receipt};
}

async function verifyProviderIdentity(config, connection) {
  const ready = connection?.isBotReady === true;
  const endUserId = connection?.state?.endUserId;
  const characterId = connection?.characterId;
  const anonymous = config.endUserId === undefined || config.endUserId === null;
  // endUserId is the server response exposed by SDK state. characterId is the
  // public getter for the connected SDK configuration, not an invented echo.
  // This SDK reports anonymous ready connections as explicit null. Never turn
  // malformed, absent, or unexpected identities into a trustworthy null.
  if (!ready || typeof characterId !== 'string' || characterId !== config.characterId
      || (anonymous ? endUserId !== null : endUserId !== config.endUserId)) {
    const reason = 'Convai provider identity could not be verified';
    // Verification can overlap a later startup. Only clear the globals when
    // this exact connection still owns them; never close its replacement.
    if (client === connection) await close(reason);
    else { try { await connection?.disconnect(); } catch {} }
    throw Error(reason);
  }
  if (client === connection) verifiedProvider = {connection, characterId, endUserId};
  return {ready: true, registration: {verified: !anonymous, endUserId, characterId}};
}

function encodeWav(chunks, rate) {
  const length = chunks.reduce((sum, c) => sum + c.pcm.length, 0);
  const bytes = new Uint8Array(44 + length * 2), view = new DataView(bytes.buffer);
  const label = (at, value) => [...value].forEach((c, i) => { bytes[at + i] = c.charCodeAt(0); });
  label(0, 'RIFF'); view.setUint32(4, bytes.length - 8, true); label(8, 'WAVEfmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true); label(36, 'data'); view.setUint32(40, length * 2, true);
  let at = 44;
  for (const chunk of chunks) for (const sample of chunk.pcm) { view.setInt16(at, Math.round(Math.max(-1, Math.min(1, sample)) * 32767), true); at += 2; }
  let binary = '';
  for (let at = 0; at < bytes.length; at += 16384) binary += String.fromCharCode(...bytes.subarray(at, at + 16384));
  return btoa(binary);
}

function beginTurn(timing = {}, config = {}) {
  submitted = true;
  const {ready: _ready, registration: _registration, ...connectionTiming} = timing;
  const current = turn = {before: new Set(client.chatMessages.map(m => m.id)), chunks: [], faces: [], captions: [], text: '', origin: null, lastSignal: 0,
    started: performance.now(), epoch, timing: connectionTiming, ttsEnabled, textComplete: false,
    providerIdentity: {characterId: config.characterId, endUserId: config.endUserId ?? null}};
  if (ttsEnabled && config.audioStreamToken) {
    if (typeof config.audioStreamToken !== 'string' || config.audioStreamToken.length > 80
        || typeof window.__convaiAudioChunk !== 'function') throw Error('Native audio stream sink is unavailable');
    current.stream = new PcmChunkStream({sampleRate: context.sampleRate, emit: async chunk => {
      if (turn !== current || current.epoch !== epoch || current.error) throw Error('Conversation cancelled');
      await window.__convaiAudioChunk(config.audioStreamToken, chunk);
      if (turn !== current || current.epoch !== epoch || current.error) throw Error('Conversation cancelled');
    }});
  }
  return current;
}

function streamMetadata(current) {
  return {text: current.text, textComplete: current.textComplete, faces: current.faces,
    sessionID: client.characterSessionId,
    captions: current.captions.map(c => ({at: Math.max(0, c.at - (current.origin ?? c.at)), text: c.text})),
    timing: {...current.timing, firstAudioMs: current.firstAudioMs}};
}

async function collect(current) {
  const started = performance.now();
  try {
    await waitFor(() => {
      if (current.error) throw Error(current.error);
      if (current.epoch !== epoch) throw Error('Conversation cancelled');
      if (!current.ttsEnabled) return current.text && current.textComplete && !client.state.isThinking;
      const now = performance.now(), q = client.blendshapeQueue;
      if (current.stream && current.firstAudioMs == null && now - started > 60000) throw Error('Convai did not start the voice reply');
      if (current.stream && q.length && Number.isFinite(current.faceCursor)
          && q.getFramesConsumed() < current.faceCursor) throw Error('Convai replaced the active speech timeline');
      drainBlendshapes(q, current.faces);
      current.faceCursor = q.getFramesConsumed?.();
      if (current.stream) {
        current.stream.update(streamMetadata(current));
        void current.stream.pump().catch(error => { current.error = error.message; });
      }
      return current.text && (current.stream?.receivedSamples || current.chunks.length) && q.isConversationEnded() && !q.length
        && !client.state.isSpeaking && !client.state.isThinking && now - current.lastSignal > 450;
    }, current.stream ? 135000 : 60000, 'Convai did not finish the reply');
    current.captureDone = true;
    const collectedAt = performance.now();
    const stream = current.stream ? await current.stream.finish(streamMetadata(current)) : undefined;
    if (current.epoch !== epoch || turn !== current || current.error) throw Error(current.error || 'Conversation cancelled');
    const audio = current.ttsEnabled && !stream ? encodeWav(current.chunks, context.sampleRate) : undefined;
    const result = {text: current.text, sessionID: client.characterSessionId,
      audio, timing: {...current.timing, firstAudioMs: current.firstAudioMs,
        collectionMs: collectedAt - started, audioEncodeMs: stream?.audioEncodeMs ?? performance.now() - collectedAt,
        ...(stream ? {firstChunkMs: stream.firstChunkMs, streamSinkWaitMs: stream.sinkWaitMs,
          streamDrainMs: performance.now() - collectedAt} : {})},
      streamed: !!stream, stream,
      faces: stream ? [] : current.faces, facesFormat: 'arkit61', facesTimebase: 'audio-seconds',
      captions: stream ? [] : current.captions.map(c => ({at: Math.max(0, c.at - (current.origin ?? c.at)), text: c.text}))};
    return result;
  } catch (error) { current.stream?.abort(error); throw error; }
  finally { if (turn === current) turn = null; }
}

async function reply(config) {
  const timing = await connect(config);
  updateContext(config);
  const current = beginTurn(timing, config);
  if (config.reaction) client.sendTriggerMessage(undefined, config.text);
  else client.sendUserTextMessage(config.text);
  return collect(current);
}

async function disableMic() {
  clearTimeout(micTimer);
  micTimer = null;
  const connection = client;
  if (!connection) return;
  const pubs = [...connection.room.localParticipant.audioTrackPublications.values()];
  try { await connection.audioControls.disableAudio(); }
  finally {
    for (const pub of pubs) if (pub.source === 'microphone' && pub.track) {
      pub.track.mediaStreamTrack.stop();
      await connection.room.localParticipant.unpublishTrack(pub.track, true).catch(() => {});
    }
  }
}

async function beginVoice(config) {
  const timing = await connect(config);
  updateContext(config);
  const current = beginTurn(timing, config), connection = client;
  current.recording = true;
  client.toggleStt(true);
  try {
    await client.audioControls.enableAudio();
    const pub = [...client.room.localParticipant.audioTrackPublications.values()].find(p => p.source === 'microphone');
    if (!pub?.track || pub.isMuted || pub.track.mediaStreamTrack.readyState !== 'live') throw Error('No live microphone track');
    micTimer = setTimeout(() => {
      if (turn !== current || client !== connection || current.epoch !== epoch || !current.recording) return;
      void close('Microphone recording expired without a current game finish').catch(() => {});
    }, MICROPHONE_CANCEL_AFTER_MS);
    return {device: pub.track.mediaStreamTrack.label, sessionID: client.characterSessionId};
  } catch (error) { if (turn === current) await close('Microphone startup failed'); throw error; }
}

function updateContext(config) {
  client.updateContext({mode: 'replace', run_llm: 'false',
    text: 'You are speaking to V in Night City. Reply briefly without stage directions. '
      + 'Use only explicitly supplied current-save facts for quest progress and relationships. '
      + 'Any relationship state not explicitly supplied is unknown; do not infer it from character presence or past sessions. '
      + (config.context || 'This is a private conversation with V.')});
}

async function finishVoice(config) {
  const current = turn;
  if (!current?.recording) throw Error('No microphone conversation is recording');
  if (config !== undefined) {
    if (config.freshSession || transportKey(config) !== identity
        || (config.sessionId && config.sessionId !== initialSession && config.sessionId !== client.characterSessionId)) {
      await close('Microphone reply identity changed'); throw Error('Microphone reply identity changed');
    }
  }
  await verifyProviderIdentity(current.providerIdentity, client);
  if (turn !== current || current.epoch !== epoch || !current.recording) throw Error('Microphone finish cancelled');
  // Same leased connection, new verified context. Updating before mute keeps
  // the fresh facts ahead of the end-of-input notification to the service.
  if (config !== undefined) updateContext(config);
  current.recording = false;
  await disableMic();
  if (turn !== current || current.epoch !== epoch) throw Error('Microphone finish cancelled');
  return collect(current);
}

function readiness(keepAlive = false) {
  let ready = client?.isBotReady === true && verifiedProvider?.connection === client;
  if (ready && (client.characterId !== verifiedProvider.characterId || client.state?.endUserId !== verifiedProvider.endUserId)) {
    ready = false;
    void close('Convai provider identity could not be verified').catch(() => {});
  }
  if (ready && keepAlive) client.resetIdleTimer();
  return {ready};
}

window.convaiRealtime = {reply, warm: connect, readiness, beginVoice, finishVoice, close};
