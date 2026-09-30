import {ConvaiClient} from '@convai/web-sdk/vanilla';
import {endUserOptions, transportKey, SessionBindings} from './transport-pool.mjs';
import {ConvaiDataAudio} from './convai-data-audio.mjs';

let client, identity, turn, micTimer, verifiedProvider, audioParticipant, admitting;
let initialSession, submitted = false, epoch = 0, ttsEnabled = true;
let retiredAudioOwners = [];
let observed = {}, previousTurnDiagnostics = null;
const sessions = new SessionBindings();
// The game owns its 30-second recording finish and supplies fresh context.
// This later ceiling is cancellation only if that finish never reaches us.
const MICROPHONE_CANCEL_AFTER_MS = 35000;
const USER_TRANSCRIPT_LIMIT = 1200;
const AUDIO_DATA_TYPES = new Set(['audio-data', 'chunked-neurosync-blendshapes',
  'blendshape-turn-stats', 'bot-started-speaking', 'bot-stopped-speaking',
  'bot-turn-completed', 'neurosync-blendshapes-cancel']);
const AUDIO_LIFECYCLE_TYPES = new Set(['bot-started-speaking', 'bot-stopped-speaking',
  'bot-turn-completed', 'neurosync-blendshapes-cancel']);
const DIAGNOSTIC_TYPES = new Set([...AUDIO_DATA_TYPES, 'server-message', 'bot-ready',
  'bot-llm-started', 'bot-llm-text', 'bot-llm-stopped', 'bot-output', 'bot-transcription',
  'bot-emotion', 'bot-tts-started', 'bot-tts-stopped', 'user-transcription',
  'final-user-transcription', 'user-llm-text', 'user-started-speaking',
  'user-stopped-speaking', 'server-response', 'interaction-created', 'llm-no-response']);
const waitFor = (condition, timeout, message) => new Promise((resolve, reject) => {
  const start = performance.now();
  const timer = setInterval(() => {
    try {
      if (condition()) { clearInterval(timer); resolve(); }
      else if (performance.now() - start > timeout) { clearInterval(timer); reject(Error(message)); }
    } catch (error) { clearInterval(timer); reject(error); }
  }, 50);
});

function microphoneTranscript(messages) {
  // SDK 1.7: interim STT lives only in userTranscriptionChange. These chat
  // rows contain finalized STT segments, even while isStreaming=true means
  // "still accumulating". final-user-transcription replaces that aggregate
  // with isStreaming=false, or appends its correction after another row.
  const rows = messages.filter(message => message.type === 'user-transcription'
    && typeof message.content === 'string' && typeof message.isStreaming === 'boolean');
  if (!rows.length) return undefined;
  const consolidated = rows.findLast(message => message.isStreaming === false);
  const recognized = consolidated ? consolidated.content : rows.map(message => message.content).join(' ');
  const text = recognized.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  // Do not split a UTF-16 surrogate pair at the payload ceiling.
  return text.slice(0, USER_TRANSCRIPT_LIMIT).replace(/[\ud800-\udbff]$/, '').trim() || undefined;
}

function currentParticipant(connection, participant) {
  return !!participant && typeof participant.identity === 'string'
    && connection.room.remoteParticipants.get(participant.identity) === participant;
}

function retiredAudioEvent(data) {
  return retiredAudioOwners.some(owner => {
    let common = false;
    for (const key of ['response_id', 'neurosync_turn_id', 'epoch']) {
      const value = key === 'neurosync_turn_id' ? data.neurosync_turn_id ?? data.turn_id : data[key];
      if (owner[key] !== undefined && value !== undefined) {
        if (owner[key] !== value) return false;
        if (key !== 'epoch') common = true;
      }
    }
    return common;
  });
}

function countDiagnosticType(counts, type) {
  const key = DIAGNOSTIC_TYPES.has(type) ? type : 'other';
  counts[key] = (counts[key] || 0) + 1;
}

function turnDiagnostics(current) {
  if (!current) return null;
  const audio = current.dataAudio;
  return {ageMs: Math.max(0, performance.now() - current.started),
    microphone: current.microphone === true, recording: current.recording === true,
    textCharacters: current.text.length, textComplete: current.textComplete === true,
    userTextCharacters: current.userText?.length ?? 0,
    messageEvents: current.messageEvents ?? 0, llmRows: current.llmRows ?? 0,
    streamingLlmRows: current.streamingLlmRows ?? 0, unknownLlmRows: current.unknownLlmRows ?? 0,
    outputRows: current.outputRows ?? 0, lastMessageAtMs: current.lastMessageAtMs ?? null,
    errorCode: current.error ? 'turn-failed-or-cancelled' : audio?.error ? 'audio-collection-failed' : null,
    audio: audio ? {byteCount: audio.byteCount, packetCount: audio.packetCount,
      frameCount: audio.frames.size, sampleRate: audio.sampleRate, channels: audio.channels,
      fps: audio.fps, ownerPresent: !!audio.owner, statsPresent: !!audio.stats,
      expectedBytes: audio.stats?.total_audio_bytes ?? null,
      expectedFrames: audio.stats?.total_blendshapes ?? null, statsFps: audio.stats?.fps ?? null,
      terminalPresent: !!audio.terminal, ready: audio.ready, sealed: audio.sealed,
      facialDiagnosticPresent: !!audio.facialDiagnostic,
      firstAudioMs: audio.timing.firstAudioMs ?? null,
      completeAudioMs: audio.timing.completeAudioMs ?? null,
      collectionCompleteMs: audio.timing.collectionCompleteMs ?? null} : null};
}

function diagnostics() {
  // Diagnostic values are deliberately enumerated. Never return SDK state,
  // config, message objects, owner IDs, participant IDs or dialogue strings.
  return {version: 1, connected: client?.isBotReady === true,
    providerVerified: !!client && verifiedProvider?.connection === client,
    participantPinned: !!audioParticipant,
    participantCurrent: !!client && currentParticipant(client, audioParticipant),
    remoteParticipants: client?.room.remoteParticipants.size ?? 0,
    ttsEnabled, admitting: !!admitting, activeTurn: !!turn,
    isThinking: client?.state?.isThinking === true, isSpeaking: client?.state?.isSpeaking === true,
    wire: {...observed, outerTypes: {...observed.outerTypes}, innerTypes: {...observed.innerTypes}},
    turn: turnDiagnostics(turn), previousTurn: previousTurnDiagnostics};
}

async function close(reason = 'Conversation cancelled') {
  const previous = {client, turn};
  const microphones = previous.client ? [...previous.client.room.localParticipant.audioTrackPublications.values()]
    .filter(pub => pub.source === 'microphone' && pub.track) : [];
  ++epoch;
  clearTimeout(micTimer);
  micTimer = null;
  if (previous.turn) { previous.turn.error = reason; previous.turn.dataAudio?.abort(reason); }
  if (previous.turn) previousTurnDiagnostics = turnDiagnostics(previous.turn);
  client = identity = turn = verifiedProvider = audioParticipant = null;
  retiredAudioOwners = [];
  initialSession = null; submitted = false;
  // Closing is cancellation, never an implicit microphone submission. Start
  // transport shutdown before stopping hardware; do not call disableAudio,
  // whose normal end-of-input path is reserved for a verified game finish.
  if (previous.turn) { try { previous.client?.sendInterruptMessage(); } catch {} }
  let disconnected;
  try { disconnected = Promise.resolve(previous.client?.disconnect()).catch(() => {}); }
  catch { disconnected = Promise.resolve(); }
  for (const pub of microphones) { try { pub.track.mediaStreamTrack.stop(); } catch {} }
  // Captured references make delayed teardown unable to erase a new owner.
  await disconnected;
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
    if (ttsEnabled && !currentParticipant(connection, audioParticipant)) {
      await close('Convai audio participant is no longer verified');
      throw Error('Convai audio participant is no longer verified');
    }
    sessions.accept(config);
    return {connectionMs: performance.now() - started, connectionReused: true, ...receipt};
  }
  await close();
  const connectionEpoch = epoch;
  identity = desired;
  ttsEnabled = config.ttsEnabled !== false;
  observed = {packets: 0, bytes: 0, validJson: 0, malformed: 0, labelPresent: 0,
    matchingLabel: 0, pinnedParticipantPackets: 0, acceptedAudioEvents: 0,
    errorCode: null, outerTypes: {}, innerTypes: {}};
  previousTurnDiagnostics = null;
  initialSession = config.freshSession ? '-1' : config.sessionId || '-1';
  const connection = client = new ConvaiClient({apiKey: config.key, characterId: config.characterId,
    ...endUserOptions(config),
    characterSessionId: initialSession, transport: 'livekit', startWithAudioOn: false,
    enableVideo: false, enableLipsync: ttsEnabled, ttsEnabled, logRtviMessages: false,
    respondModes: {contextUpdate: 'silent'},
    blendshapeConfig: {format: 'arkit', output_fps: 30}});
  const currentConnection = () => epoch === connectionEpoch && client === connection;
  let transportError;
  const rejectTransport = reason => {
    if (!currentConnection()) return;
    transportError = reason;
    observed.errorCode = 'transport-rejected';
    // PCM has no response ID. A malformed or ambiguous turn retires its whole
    // connection so a later request cannot inherit an ownerless audio tail.
    void close(reason).catch(() => {});
  };
  // Register before connect: bot-ready is the source witness for this exact
  // room. LiveKit maps participants by identity, not participant SID. Missing
  // participants are ambiguous (server-origin and unknown sender look alike).
  connection.room.on('dataReceived', (payload, participant, kind) => {
    if (!currentConnection()) return;
    observed.packets++;
    if (ArrayBuffer.isView(payload)) observed.bytes += payload.byteLength;
    if (participant === audioParticipant && currentParticipant(connection, participant)) observed.pinnedParticipantPackets++;
    let message;
    try {
      if (!ArrayBuffer.isView(payload) || payload.byteLength > 1048576)
        throw Error('Invalid Convai data message');
      message = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(payload));
    } catch {
      observed.malformed++;
      if (ttsEnabled && participant === audioParticipant) rejectTransport('Invalid Convai data message');
      return;
    }
    observed.validJson++;
    if (message?.label !== undefined) observed.labelPresent++;
    if (message?.label === 'rtvi-ai') observed.matchingLabel++;
    countDiagnosticType(observed.outerTypes, message?.type);
    if (message?.type === 'server-message') countDiagnosticType(observed.innerTypes, message?.data?.type);
    if (!message || (message.label !== undefined && message.label !== 'rtvi-ai')) return;
    const data = message.type === 'server-message' ? message.data : message.data ?? message;
    const type = message.type === 'server-message' ? data?.type : message.type;
    const ownerPresent = data?.response_id !== undefined || data?.neurosync_turn_id !== undefined
      || data?.turn_id !== undefined;
    // The provider's flat bot-turn-completed omits the RTVI label. Admit only
    // known owned lifecycle in that shape; participant, reliability and owner
    // matching remain mandatory below. Other unlabelled traffic is unrelated.
    if (message.label === undefined && (!AUDIO_LIFECYCLE_TYPES.has(message.type) || !ownerPresent)) return;
    if (message.type === 'bot-ready') {
      if (kind !== 0 || !currentParticipant(connection, participant)
          || (audioParticipant && participant !== audioParticipant)) {
        if (ttsEnabled) rejectTransport('Convai audio participant could not be verified');
        return;
      }
      audioParticipant = participant;
      return;
    }
    // PCM/faces/stats are server-message payloads, while owned lifecycle may
    // be flat or use an outer type with its response metadata in data.
    // Pass the original envelope to the collector, which validates both.
    if (!AUDIO_DATA_TYPES.has(type) || !ttsEnabled) return;
    // Generic SDK speaking flags are UI-only and can arrive after collection.
    // Neither they nor an epoch alone prove a response's identity.
    if (['bot-started-speaking', 'bot-stopped-speaking'].includes(type) && !ownerPresent) return;
    if (participant !== audioParticipant || !currentParticipant(connection, participant)) {
      rejectTransport('Convai audio arrived from an unverified participant'); return;
    }
    if (!turn?.dataAudio) {
      if (type !== 'audio-data' && data && retiredAudioEvent(data)) return;
      rejectTransport('Convai audio arrived outside its submitted turn'); return;
    }
    try {
      if (turn.dataAudio.accept(message, {kind, atMs: performance.now() - turn.started})) observed.acceptedAudioEvents++;
    }
    catch (error) { rejectTransport(error.message || 'Invalid Convai speech data'); }
  });
  connection.on('error', () => rejectTransport('Convai realtime connection failed'));
  connection.on('disconnect', () => rejectTransport('Convai realtime connection closed'));
  connection.on('messagesChange', messages => {
    if (!currentConnection() || !turn) return;
    const fresh = messages.filter(m => !turn.before.has(m.id));
    if (turn.microphone && fresh.some(message => message.type === 'user-transcription'))
      turn.userText = microphoneTranscript(fresh);
    const llm = fresh.filter(m => ['bot-llm-text', 'convai'].includes(m.type) && m.content?.trim());
    const rows = llm.length ? llm : fresh.filter(m => m.type === 'bot-output' && m.content?.trim());
    turn.messageEvents = (turn.messageEvents || 0) + 1;
    turn.llmRows = llm.length;
    turn.streamingLlmRows = llm.filter(m => m.isStreaming === true).length;
    turn.unknownLlmRows = llm.filter(m => typeof m.isStreaming !== 'boolean').length;
    turn.outputRows = fresh.filter(m => m.type === 'bot-output' && m.content?.trim()).length;
    turn.lastMessageAtMs = performance.now() - turn.started;
    turn.text = rows.map(m => m.content).join(' ').trim();
    // The SDK marks the LLM message complete on bot-llm-stopped, separately
    // from TTS. Never infer completion from a pause between text tokens.
    turn.textComplete = llm.length > 0 && llm.every(m => m.isStreaming === false);
  });
  connection.on('llmNoResponse', () => { if (currentConnection() && turn) turn.error = 'Convai returned no dialogue'; });
  await connection.connect();
  await waitFor(() => {
    if (transportError) throw Error(transportError);
    if (!currentConnection()) throw Error('Conversation startup cancelled');
    return connection.isBotReady && (!ttsEnabled || currentParticipant(connection, audioParticipant));
  }, 20000, 'Convai character did not become ready');
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

function beginTurn(timing = {}, config = {}) {
  if (turn) throw Error('A conversation turn is already active');
  submitted = true;
  const {ready: _ready, registration: _registration, ...connectionTiming} = timing;
  const current = turn = {before: new Set(client.chatMessages.map(m => m.id)), text: '',
    started: performance.now(), epoch, timing: connectionTiming, ttsEnabled, textComplete: false,
    providerIdentity: {characterId: config.characterId, endUserId: config.endUserId ?? null}};
  if (ttsEnabled) current.dataAudio = new ConvaiDataAudio({retiredOwners: retiredAudioOwners});
  return current;
}

async function collect(current) {
  const started = performance.now();
  try {
    await waitFor(() => {
      if (current.error) throw Error(current.error);
      if (current.epoch !== epoch || turn !== current) throw Error('Conversation cancelled');
      if (current.dataAudio?.error) throw current.dataAudio.error;
      // Source bytes can arrive faster than their playback duration. Wait for
      // exact PCM + owned clean terminal + final text, never a browser clock.
      return current.text && current.textComplete && !client.state.isThinking
        && (!current.ttsEnabled || current.dataAudio.ready);
    }, 60000, 'Convai did not finish the reply');
    const collectedAt = performance.now();
    if (current.epoch !== epoch || turn !== current || current.error) throw Error(current.error || 'Conversation cancelled');
    const collected = current.dataAudio?.finish();
    if (current.dataAudio?.owner) {
      retiredAudioOwners.push(current.dataAudio.owner);
      if (retiredAudioOwners.length > 32) retiredAudioOwners.shift();
    }
    return {...collected, text: current.text, sessionID: client.characterSessionId,
      ...(current.userText ? {userText: current.userText} : {}),
      audio: collected?.audio,
      timing: {...current.timing, ...collected?.timing, collectionMs: collectedAt - started,
        audioEncodeMs: performance.now() - collectedAt,
        ...(collected ? {audioTransport: 'convai-data', audioPacketCount: collected.packetCount} : {})},
      streamed: false, faces: collected?.faces ?? [], facesFormat: 'arkit61', facesTimebase: 'audio-seconds', captions: []};
  } catch (error) {
    current.dataAudio?.abort(error.message);
    if (turn === current && current.epoch === epoch) await close(error.message || 'Conversation failed');
    throw error;
  }
  finally { if (turn === current) turn = null; }
}

async function reply(config) {
  if (turn || admitting) throw Error('A conversation turn is already active');
  const admission = admitting = {};
  try {
    const timing = await connect(config);
    updateContext(config);
    const current = beginTurn(timing, config);
    if (config.reaction) client.sendTriggerMessage(undefined, config.text);
    else client.sendUserTextMessage(config.text);
    return await collect(current);
  } finally { if (admitting === admission) admitting = null; }
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
  if (turn || admitting) throw Error('A conversation turn is already active');
  const admission = admitting = {};
  let current;
  try {
    const timing = await connect(config);
    updateContext(config);
    const connection = client;
    current = beginTurn(timing, config);
    current.recording = true; current.microphone = true;
    client.toggleStt(true);
    await client.audioControls.enableAudio();
    if (turn !== current || current.epoch !== epoch || client !== connection) throw Error('Microphone startup cancelled');
    const pub = [...client.room.localParticipant.audioTrackPublications.values()].find(p => p.source === 'microphone');
    if (!pub?.track || pub.isMuted || pub.track.mediaStreamTrack.readyState !== 'live') throw Error('No live microphone track');
    micTimer = setTimeout(() => {
      if (turn !== current || client !== connection || current.epoch !== epoch || !current.recording) return;
      void close('Microphone recording expired without a current game finish').catch(() => {});
    }, MICROPHONE_CANCEL_AFTER_MS);
    return {device: pub.track.mediaStreamTrack.label, sessionID: client.characterSessionId};
  } catch (error) { if (current && turn === current) await close('Microphone startup failed'); throw error; }
  finally { if (admitting === admission) admitting = null; }
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
  if (ready && ttsEnabled && !currentParticipant(client, audioParticipant)) {
    ready = false;
    void close('Convai audio participant is no longer verified').catch(() => {});
  }
  if (ready && keepAlive) client.resetIdleTimer();
  return {ready};
}

window.convaiRealtime = {reply, warm: connect, readiness, beginVoice, finishVoice, close, diagnostics};
