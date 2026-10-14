import {ConvaiClient} from '@convai/web-sdk/vanilla';
import {endUserOptions, transportKey, SessionBindings} from './transport-pool.mjs';
import {ConvaiDataAudio} from './convai-data-audio.mjs';
import {ContinuousPcmPlayer} from './continuous-pcm-player.mjs';
import {AnalysisPcm} from './analysis-pcm.mjs';
import {ConvaiEmotion} from './convai-emotion.mjs';
import {CompanionActionWindow, publishCompanionActionContext, chauffeurActionName} from './companion-actions.mjs';
import {ConvaiVision, visionConnectOptions, visionIdentity, VISION_NOTE} from './convai-vision.mjs';

let client, identity, turn, micTimer, verifiedProvider, audioParticipant, admitting;
// "Companions can see" (docs/COMPANION_VISION.md): the current connection's picture handler, null without vision.
let vision = null;
// How long a turn waits for its picture to be buffered by Convai before it is sent anyway (bridge/convai-vision.mjs).
const VISION_READY_MS = 350;
const PRESTAGE_TTL_MS = 60000;
let initialSession, submitted = false, epoch = 0, ttsEnabled = true;
let retiredAudioOwners = [];
let retiredExpressionOwners = [];
// Text-only turns (local voices): Convai's LLM emotion arrives about 0.5 s after the reply's text is complete
// (live probe October 8: 460-520 ms after bot-llm-stopped), so after collect() has returned. The one event on the
// pinned provider's reliable, ordered channel between that turn's end and the next bot-llm-started belongs to it.
let lateEmotion = null, lateEmotionSequence = 0;
const LATE_EMOTION_MS = 4000;
let observed = {}, previousTurnDiagnostics = null;
let previousContinuous = null, previousAnalysis = null;
const sessions = new SessionBindings();
const companionActions = new CompanionActionWindow();
let actionContextConfigured = false;
// The game owns its 30-second recording finish and supplies fresh context.
// This later ceiling is cancellation only if that finish never reaches us.
const MICROPHONE_CANCEL_AFTER_MS = 35000;
// After the player finishes a recording, Convai's speech recognition normally answers within a few seconds. When no
// transcript and no reply text exist this long after the finish (and the character is not working on one), the
// recording held no speech: fail at once with a clear reason instead of waiting out the 60 s reply ceiling.
const NO_SPEECH_AFTER_MS = 15000;
const NO_SPEECH_ERROR = 'No speech was heard';
const COLLECT_TIMEOUT_ERROR = 'Convai did not finish the reply';
const USER_TRANSCRIPT_LIMIT = 1200;
// Convai's source PCM is 24 kHz mono. The output device is opened on standby at
// turn start in this format so its start-up (about 20-190 ms of context, worklet
// and device warm-up) overlaps the provider's thinking time instead of following
// the first audio packet. A different actual format discards the standby player
// and opens one in the ordinary way.
const STANDBY_FORMAT = Object.freeze({sampleRate: 24000, channels: 1});
const AUDIO_DATA_TYPES = new Set(['audio-data', 'chunked-neurosync-blendshapes',
  'blendshape-turn-stats', 'bot-started-speaking', 'bot-stopped-speaking',
  'bot-turn-completed', 'neurosync-blendshapes-cancel']);
const AUDIO_LIFECYCLE_TYPES = new Set(['bot-started-speaking', 'bot-stopped-speaking',
  'bot-turn-completed', 'neurosync-blendshapes-cancel']);
const DIAGNOSTIC_TYPES = new Set([...AUDIO_DATA_TYPES, 'server-message', 'bot-ready',
  'bot-llm-started', 'bot-llm-text', 'bot-llm-stopped', 'bot-output', 'bot-transcription',
  'bot-emotion', 'bot-tts-started', 'bot-tts-stopped', 'user-transcription',
  'final-user-transcription', 'user-llm-text', 'user-started-speaking',
  'user-stopped-speaking', 'server-response', 'interaction-created', 'llm-no-response', 'action-response']);
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

// What Convai's speech recognition has heard of the microphone turn so far, for the game to show while V talks:
// the finalized segments (turn.userText) plus the segment still being recognised (turn.interim). Short, single-line,
// and the newest words only; never anything but V's own recognised speech.
const HEARD_LIMIT = 100;
function heardText(current) {
  if (!current?.microphone) return '';
  const text = [current.userText, current.interim].filter(part => typeof part === 'string' && part).join(' ')
    .replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  const points = [...text];
  if (points.length <= HEARD_LIMIT) return text;
  const tail = points.slice(-HEARD_LIMIT).join('');
  const space = tail.indexOf(' ');
  return '\u2026' + (space > 0 && space < 24 ? tail.slice(space + 1) : tail);
}

// Convai ends a session whose plan quota is used up with one server message just before it closes the room
// (usage-limit-reached; quota_type interaction or tts). 'error' is a service configuration fault, not a used-up plan.
// The returned kind travels in the failure text so the bridge can tell this from an ordinary disconnect.
function usageLimitKind(message) {
  if (!message || (message.label !== undefined && message.label !== 'rtvi-ai')) return null;
  const data = message.type === 'server-message' ? message.data : message;
  if (data?.type !== 'usage-limit-reached' || data.quota_type === 'error') return null;
  return data.quota_type === 'tts' ? 'tts' : data.quota_type === 'interaction' ? 'interaction' : 'plan';
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
    expression: {ownerPresent: !!current.emotion?.owner, admitted: !!current.emotion?.signal,
      ambiguous: current.emotion?.ambiguous === true},
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
    actions: {contextConfigured: actionContextConfigured,
      windowActive: !!companionActions.pending && companionActions.pending.expiresAt > Date.now(),
      offered: observed.actionsOffered ?? 0, published: observed.actionContextsPublished ?? 0,
      accepted: observed.actionsAccepted ?? 0, skipped: observed.actionsSkipped ?? 0,
      unlabelled: observed.unlabelledActions ?? 0, contextFailures: observed.actionContextFailures ?? 0,
      contextAck: observed.actionContextAck ?? null, eligibility: observed.actionEligibility ?? null,
      lastSkip: observed.actionSkipReason ?? null, lastProposal: observed.actionProposal ?? null},
    isThinking: client?.state?.isThinking === true, isSpeaking: client?.state?.isSpeaking === true,
    wire: {...observed, outerTypes: {...observed.outerTypes}, innerTypes: {...observed.innerTypes}},
    turn: turnDiagnostics(turn), previousTurn: previousTurnDiagnostics,
    vision: vision && client && vision.connection === client ? vision.diagnostics() : null};
}

async function close(reason = 'Conversation cancelled') {
  companionActions.clear(); actionContextConfigured = false;
  const previous = {client, turn};
  const microphones = previous.client ? [...previous.client.room.localParticipant.audioTrackPublications.values()]
    .filter(pub => pub.source === 'microphone' && pub.track) : [];
  ++epoch;
  clearTimeout(micTimer);
  micTimer = null;
  if (previous.turn) {
    previous.turn.error = reason;
    previous.turn.emotion?.clear();
    previous.turn.dataAudio?.abort(reason);
    // Retire audible output immediately, before waiting for SDK shutdown.
    if (previous.turn.live) {
      retireStandby(previous.turn.live, reason);
      void previous.turn.live.player.stop(reason).catch(() => {});
      previousContinuous = continuousView(previous.turn);
      previousAnalysis = {token: previous.turn.live.token, analysis: previous.turn.live.analysis};
    }
  }
  if (previous.turn) previousTurnDiagnostics = turnDiagnostics(previous.turn);
  vision?.close(); vision = null;
  client = identity = turn = verifiedProvider = audioParticipant = lateEmotion = null;
  retiredAudioOwners = [];
  retiredExpressionOwners = [];
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
  const desired = visionIdentity(transportKey(config), config);
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
    acceptedEmotionEvents: 0, skippedEmotionEvents: 0,
    emotionSkipReasons: {}, lastEmotion: null,
    errorCode: null, outerTypes: {}, innerTypes: {}};
  previousTurnDiagnostics = null;
  initialSession = config.freshSession ? '-1' : config.sessionId || '-1';
  // The sign-in backend's short-lived token when the bridge supplies one, else the key (a player's own, or the embedded fallback).
  const credential = typeof config.authToken === 'string' && config.authToken ? {authToken: config.authToken} : {apiKey: config.key};
  const connection = client = new ConvaiClient({...credential, characterId: config.characterId,
    ...endUserOptions(config),
    characterSessionId: initialSession, transport: 'livekit', startWithAudioOn: false,
    enableVideo: false, enableLipsync: ttsEnabled, ttsEnabled, logRtviMessages: false,
    enableEmotion: true, emotionConfig: {provider: 'llm'},
    // Vision (when on) arrives on the silent lane: a picture never makes the character speak by itself.
    respondModes: {contextUpdate: 'silent', ...(config.vision === true ? {vision: 'silent'} : {})},
    ...visionConnectOptions(config),
    blendshapeConfig: {format: 'arkit', output_fps: 30}});
  vision = config.vision === true ? new ConvaiVision(connection, {transport: config.visionTransport}) : null;
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
    const limitKind = usageLimitKind(message);
    if (limitKind) {
      observed.errorCode = 'usage-limit';
      rejectTransport(`Convai usage limit reached [convai-quota:${limitKind}]`);
      return;
    }
    if (message?.label !== undefined) observed.labelPresent++;
    if (message?.label === 'rtvi-ai') observed.matchingLabel++;
    countDiagnosticType(observed.outerTypes, message?.type);
    if (message?.type === 'server-message') countDiagnosticType(observed.innerTypes, message?.data?.type);
    if (!message || (message.label !== undefined && message.label !== 'rtvi-ai')) return;
    const data = message.type === 'server-message' ? message.data : message.data ?? message;
    const type = message.type === 'server-message' ? data?.type : message.type;
    const noteEmotion = reason => {
      // Shape evidence only: never persist labels, dialogue, identities or the
      // raw envelope. This distinguishes late events from absent correlation.
      observed.lastEmotion = {reason, ttsEnabled, activeTurn: !!turn,
        responseIdPresent: typeof data?.response_id === 'string',
        turnIdPresent: data?.neurosync_turn_id !== undefined || data?.turn_id !== undefined,
        epochPresent: data?.epoch !== undefined,
        outerResponseIdPresent: typeof message?.response_id === 'string',
        outerTurnIdPresent: message?.neurosync_turn_id !== undefined || message?.turn_id !== undefined,
        responseOwnerEstablished: !!turn?.emotion?.owner,
        audioPacketsBefore: turn?.dataAudio?.packetCount ?? 0, textCharactersBefore: turn?.text?.length ?? 0,
        terminalBefore: !!turn?.dataAudio?.terminal,
        reliable: kind === 0, pinnedParticipant: participant === audioParticipant};
      if (reason !== 'accepted') {
        observed.skippedEmotionEvents++;
        observed.emotionSkipReasons[reason] = (observed.emotionSkipReasons[reason] ?? 0) + 1;
      }
    };
    const ownerPresent = data?.response_id !== undefined || data?.neurosync_turn_id !== undefined
      || data?.turn_id !== undefined;
    // The provider's flat bot-turn-completed omits the RTVI label. Admit only
    // known owned lifecycle in that shape; participant, reliability and owner
    // matching remain mandatory below. Other unlabelled traffic is unrelated.
    if (message.label === undefined && (!AUDIO_LIFECYCLE_TYPES.has(message.type) || !ownerPresent)) {
      if (type === 'bot-emotion') noteEmotion('missing-transport-label');
      if (type === 'action-response') observed.unlabelledActions = (observed.unlabelledActions ?? 0) + 1;
      return;
    }
    if (message.type === 'bot-ready') {
      if (kind !== 0 || !currentParticipant(connection, participant)
          || (audioParticipant && participant !== audioParticipant)) {
        if (ttsEnabled) rejectTransport('Convai audio participant could not be verified');
        return;
      }
      audioParticipant = participant;
      return;
    }
    const actionProvider = kind === 0 && participant === audioParticipant
      && currentParticipant(connection, participant) && verifiedProvider?.connection === connection
      && connection.characterId === verifiedProvider.characterId && connection.state?.endUserId === verifiedProvider.endUserId;
    if (actionProvider && type === 'server-response' && data?.event_type === 'context-update') {
      observed.actionContextAck = ['success', 'error', 'processing', 'pending'].includes(data.status) ? data.status : 'unknown';
    }
    if (type === 'action-response') {
      // SDK actionResponse omits the participant and turn identity. Only this
      // source-checked wire proposal with the current one-use target can pass.
      const pending = companionActions.current(), candidate = Array.isArray(data?.actions) && data.actions[0];
      observed.actionProposal = {windowPresent: !!pending,
        count: Array.isArray(data?.actions) ? Math.min(data.actions.length, 1000) : null,
        nameMatches: candidate?.name === 'Drive To Waypoint' || (!!pending && candidate?.name === chauffeurActionName(pending)),
        boundNameMatches: !!pending && candidate?.name === chauffeurActionName(pending),
        targetPresent: typeof candidate?.target === 'string' && candidate.target.length > 0,
        targetMatches: !!pending && candidate?.target === pending.token,
        exactActionShape: !!candidate && typeof candidate === 'object' && !Array.isArray(candidate)
          && Object.hasOwn(candidate, 'name') && Object.keys(candidate).every(key => ['name', 'target'].includes(key))};
      const accepted = actionProvider && companionActions.accept(data);
      if (accepted) observed.actionsAccepted = (observed.actionsAccepted ?? 0) + 1;
      else {
        observed.actionsSkipped = (observed.actionsSkipped ?? 0) + 1;
        observed.actionSkipReason = actionProvider ? 'target-or-window' : 'provider';
      }
      if (accepted && typeof window.__convaiCompanionAction === 'function')
        void Promise.resolve().then(() => currentConnection() && verifiedProvider?.connection === connection
          ? window.__convaiCompanionAction(accepted) : false).catch(() => {});
      return;
    }
    if (actionProvider && turn && !turn.error && type === 'bot-llm-started' && !retiredAudioEvent(data))
      companionActions.observeOwner(data);
    if (actionProvider && type === 'bot-turn-completed') companionActions.terminal(data);
    if (type === 'bot-llm-started' && lateEmotion && turn !== lateEmotion.turn) lateEmotion.closed = true;
    if (type === 'bot-emotion' && !ttsEnabled && lateEmotion && !lateEmotion.closed && (!turn || (turn !== lateEmotion.turn
        && turn.text.length === 0)) && kind === 0 && participant === audioParticipant && currentParticipant(connection, participant)
        && verifiedProvider?.connection === connection && lateEmotion.connection === connection
        && performance.now() - lateEmotion.at < LATE_EMOTION_MS) {
      // A second ownerless event before the next reply makes the holder ambiguous (ConvaiEmotion drops it).
      if (lateEmotion.emotion.acceptOrdered(data, {textStarted: true})) { observed.acceptedEmotionEvents++; noteEmotion('accepted'); }
      else noteEmotion(lateEmotion.emotion.lastReason ?? 'unqualified-emotion');
      return;
    }
    if (type === 'bot-emotion') {
      // Never borrow the active request for an ownerless SDK callback. Late
      // owned metadata may affect an already draining continuous utterance,
      // but missing/ambiguous emotion cannot block or fail audible playback.
      const valid = kind === 0 && participant === audioParticipant && currentParticipant(connection, participant)
        && verifiedProvider?.connection === connection && turn?.epoch === connectionEpoch && !turn.error;
      if (valid && turn.dataAudio?.owner) turn.emotion.observeOwner(turn.dataAudio.owner);
      if (valid && turn.emotion.acceptOrdered(data, {terminal: !!turn.dataAudio?.terminal, textStarted: turn.text.length > 0})) {
        observed.acceptedEmotionEvents++; noteEmotion('accepted');
      }
      else noteEmotion(!turn ? 'no-active-response' : turn.error ? 'failed-response'
        : kind !== 0 ? 'unreliable-packet' : participant !== audioParticipant ? 'foreign-participant'
        : !currentParticipant(connection, participant) ? 'retired-participant'
        : verifiedProvider?.connection !== connection ? 'unverified-connection'
        : turn.epoch !== connectionEpoch ? 'retired-connection'
        : turn.emotion.lastReason ?? 'unqualified-emotion');
      return;
    }
    // TTS-disabled Omni replies have no audio owner. Only an explicitly owned
    // LLM-start event from this same provider can establish their response.
    if (type === 'bot-llm-started' && !ttsEnabled && turn && !turn.error && kind === 0
        && participant === audioParticipant && currentParticipant(connection, participant)
        && verifiedProvider?.connection === connection) turn.emotion.observeOwner(data);
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
    if (turn.dataAudio.sealed) {
      if (type !== 'audio-data' && data && retiredAudioEvent(data)) return;
      rejectTransport('Convai audio arrived after its validated source completed'); return;
    }
    try {
      if (turn.dataAudio.accept(message, {kind, atMs: performance.now() - turn.started})) {
        if (turn.dataAudio.owner) companionActions.observeOwner(turn.dataAudio.owner);
        observed.acceptedAudioEvents++;
        queueContinuous(turn);
      }
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
  connection.on('userTranscriptionChange', text => {
    if (currentConnection() && turn?.microphone) turn.interim = typeof text === 'string' ? text : '';
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
  const current = {before: new Set(client.chatMessages.map(m => m.id)), text: '',
    started: performance.now(), epoch, timing: connectionTiming, ttsEnabled, textComplete: false,
    providerIdentity: {characterId: config.characterId, endUserId: config.endUserId ?? null}};
  current.emotion = new ConvaiEmotion({retiredOwners: retiredExpressionOwners});
  if (ttsEnabled) current.dataAudio = new ConvaiDataAudio({retiredOwners: retiredAudioOwners});
  attachContinuous(current, config.liveSpeechToken);
  turn = current;
  return current;
}

function attachContinuous(current, token) {
  if (token === undefined || !current.ttsEnabled) return;
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(token)) throw Error('Invalid live speech token');
  if (current.live) {
    if (current.live.token !== token) throw Error('Live speech owner changed');
    return;
  }
  previousContinuous = null; previousAnalysis = null;
  current.live = {token, player: new ContinuousPcmPlayer(), chain: Promise.resolve(), opened: false};
  startStandby(current.live);
  queueContinuous(current);
}

// Open the output device now, silently and without a game lease. A failure here
// is not a turn failure: the first audio packet opens a player as it always did.
function startStandby(live) {
  const player = new ContinuousPcmPlayer();
  live.standby = player;
  live.standbyOpen = player.open({...STANDBY_FORMAT, token: live.token, standby: true}).catch(() => {});
}

// Stop a standby player that never became the turn's player. Idempotent.
function retireStandby(live, reason = 'Conversation cancelled') {
  const player = live?.standby;
  if (player) void player.stop(reason).catch(() => {});
}

// Hand the turn the standby player if it is still healthy and has the real format.
// Anything else (failed open, device change, other format) discards it.
async function takeStandby(live, sampleRate, channels) {
  const player = live.standby;
  if (!player) return null;
  await live.standbyOpen;
  if (player.sampleRate === sampleRate && player.channels === channels && player.opened && !player.stopped) {
    try { await player.arm(); return player; } catch { /* fall through: open normally */ }
  }
  retireStandby(live, 'Standby replaced');
  return null;
}

function clockDiagnostic(playback) {
  const source = playback?.clockDiagnostic;
  if (!source || typeof source !== 'object') return null;
  const result = {};
  for (const key of ['previousStart', 'previousEnd', 'previousFrom', 'previousTo',
    'nextStart', 'nextEnd', 'nextFrom', 'nextTo']) {
    const value = source[key];
    if (typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER)
      result[key] = value;
  }
  return Object.keys(result).length ? result : null;
}

const clockError = diagnostic => Error('Continuous PCM clock failure; clock=' + JSON.stringify(diagnostic));
function rendererError(current, error) {
  const diagnostic = clockDiagnostic(current.live?.player.snapshot());
  return diagnostic ? clockError(diagnostic) : error;
}

function queueContinuous(current) {
  const live = current.live;
  if (!live || current.error || turn !== current || current.epoch !== epoch) return;
  const packets = current.dataAudio.drainPcm();
  if (!packets.length) return;
  const {sampleRate, channels} = current.dataAudio;
  // Read-only analysis copy for the bridge's facial model, taken before the
  // renderer may transfer these buffers. A fault only removes model coverage.
  if (!live.analysisFailed) {
    try {
      live.analysis ??= new AnalysisPcm(channels);
      for (const packet of packets) live.analysis.append(packet.bytes, packet.offsetFrames);
    } catch { live.analysis = null; live.analysisFailed = true; }
  }
  live.chain = live.chain.then(async () => {
    const owned = () => !current.error && turn === current && current.epoch === epoch;
    if (!owned()) return;
    if (!live.opened) {
      const standby = await takeStandby(live, sampleRate, channels);
      if (standby) live.player = standby;
      else await live.player.open({sampleRate, channels, token: live.token});
      live.standby = null;
      live.opened = true;
      if (owned() && live.pendingControl) live.player.control(live.pendingControl);
    }
    for (const packet of packets) {
      if (!owned()) return;
      await live.player.append(packet.bytes, packet.offsetFrames);
    }
  }).catch(error => {
    if (turn === current && current.epoch === epoch) {
      current.error = rendererError(current, error).message || 'Continuous speech playback failed';
      void close(current.error).catch(() => {});
    }
  });
}

function continuousView(current, pcmFrom) {
  if (!current?.live) return null;
  const pcm = pcmFrom === undefined ? undefined : current.live.analysis?.slice(pcmFrom);
  const source = current.dataAudio.progress(), playback = current.live.player.snapshot();
  const diagnostic = clockDiagnostic(playback);
  // Explicit public shape: never expose SDK configuration or remote identities.
  return {version: 1, token: current.live.token, text: current.text,
    ...(current.emotion?.snapshot() ? {expressionSignal: current.emotion.snapshot()} : {}),
    ...(current.userText ? {userText: current.userText} : {}),
    textComplete: current.textComplete, sampleRate: source.sampleRate, channels: source.channels,
    receivedFrames: source.receivedFrames, receivedDuration: source.sampleRate ? source.receivedFrames / source.sampleRate : 0,
    positionSeconds: playback.positionSeconds ?? 0, playedFrames: playback.playedFrames ?? 0,
    bufferedFrames: playback.bufferedFrames ?? 0, state: playback.state,
    ended: playback.ended === true, error: current.error || playback.error || null,
    ...(diagnostic ? {clockDiagnostic: diagnostic} : {}),
    underruns: playback.underruns ?? 0, faces: source.faces,
    facesFormat: source.facesFormat, facesTimebase: source.facesTimebase,
    sourceComplete: source.sourceComplete, ...(pcm ? {pcm} : {})};
}

function continuousSnapshot(token, pcmFrom) {
  const tail = previousAnalysis?.token === token && pcmFrom !== undefined ? previousAnalysis.analysis?.slice(pcmFrom) : undefined;
  const snapshot = turn?.live?.token === token ? continuousView(turn, pcmFrom)
    : previousContinuous?.token === token ? (tail ? {...previousContinuous, pcm: tail} : previousContinuous) : null;
  // A clock fault may reach this poll before collect's next tick. Throw the
  // same bounded diagnostic here so a generic publication error cannot erase
  // the evidence before the host disposes this page.
  if (snapshot?.error && snapshot.clockDiagnostic) throw clockError(snapshot.clockDiagnostic);
  return snapshot;
}

function continuousControl(token, control) {
  if (!turn?.live || turn.live.token !== token || turn.epoch !== epoch || turn.error) return false;
  const live = turn.live;
  if (live.player.snapshot().ended) return false;
  if (live.opened) live.player.control(control);
  else live.pendingControl = control;
  return true;
}

async function collect(current) {
  const started = performance.now();
  try {
    await waitFor(() => {
      if (current.error) throw Error(current.error);
      if (current.epoch !== epoch || turn !== current) throw Error('Conversation cancelled');
      if (current.dataAudio?.error) throw current.dataAudio.error;
      if (current.microphone && !current.userText && !current.text && !client.state.isThinking
          && performance.now() - started > NO_SPEECH_AFTER_MS) throw Error(NO_SPEECH_ERROR);
      if (current.live) {
        const state = current.live.player.snapshot();
        if (state.error || state.state === 'stopped') throw Error(state.error || 'Continuous speech stopped before completion');
      }
      // Source bytes can arrive faster than their playback duration. Wait for
      // exact PCM + owned clean terminal + final text, never a browser clock.
      return current.text && current.textComplete && !client.state.isThinking
        && (!current.ttsEnabled || current.dataAudio.ready);
    }, 60000, COLLECT_TIMEOUT_ERROR);
    const collectedAt = performance.now();
    if (current.epoch !== epoch || turn !== current || current.error) throw Error(current.error || 'Conversation cancelled');
    // All source samples were accepted and owned before publication. Drain any
    // queued append acknowledgements before sealing the collector or EOF.
    if (current.live) await current.live.chain;
    if (current.error || turn !== current || current.epoch !== epoch) throw Error(current.error || 'Conversation cancelled');
    const collected = current.dataAudio?.finish({includeAudio: !current.live});
    const encodedAt = performance.now();
    if (current.dataAudio?.owner) {
      retiredAudioOwners.push(current.dataAudio.owner);
      if (retiredAudioOwners.length > 32) retiredAudioOwners.shift();
    }
    if (current.live) {
      await current.live.player.end(current.dataAudio.byteCount / (collected.channels * 2));
      await waitFor(() => {
        if (current.error || turn !== current || current.epoch !== epoch) throw Error(current.error || 'Conversation cancelled');
        const state = current.live.player.snapshot();
        if (state.error || state.state === 'stopped') throw Error(state.error || 'Continuous speech stopped before completion');
        return state.ended === true;
      }, Infinity, 'Continuous speech did not drain');
      previousContinuous = continuousView(current);
      previousAnalysis = {token: current.live.token, analysis: current.live.analysis};
      await current.live.player.stop('completed');
    }
    // A text-only reply's own emotion usually arrives after this return; lateEmotionToken reads it later.
    if (!current.ttsEnabled && !current.emotion.snapshot()) {
      lateEmotion = {token: ++lateEmotionSequence, turn: current, connection: client, at: performance.now(), closed: false,
        emotion: new ConvaiEmotion({retiredOwners: retiredExpressionOwners})};
    }
    return {...collected, text: current.text, sessionID: client.characterSessionId,
      ...(current.emotion.snapshot() ? {expressionSignal: current.emotion.snapshot()} : {}),
      ...(lateEmotion?.turn === current ? {lateEmotionToken: lateEmotion.token} : {}),
      ...(current.userText ? {userText: current.userText} : {}),
      ...(current.live ? {continuous: true, liveSpeechToken: current.live.token} : {audio: collected?.audio}),
      timing: {...current.timing, ...collected?.timing, collectionMs: collectedAt - started,
        audioEncodeMs: encodedAt - collectedAt,
        ...(collected ? {audioTransport: 'convai-data', audioPacketCount: collected.packetCount} : {})},
      streamed: !!current.live, faces: collected?.faces ?? [], facesFormat: 'arkit61', facesTimebase: 'audio-seconds', captions: []};
  } catch (error) {
    const failure = rendererError(current, error);
    // The close reason stays the bare message; the thrown error also says what had arrived, so a stuck reply can be diagnosed.
    const detail = failure === error && error?.message === COLLECT_TIMEOUT_ERROR
      ? ` (transcript=${current.userText ? 'yes' : 'no'} text=${current.text ? 'yes' : 'no'} complete=${current.textComplete}`
        + ` thinking=${client?.state?.isThinking === true} audio=${current.dataAudio ? current.dataAudio.ready === true : 'off'})` : '';
    current.dataAudio?.abort(failure.message);
    if (turn === current && current.epoch === epoch) await close(failure.message || 'Conversation failed');
    if (detail) failure.message += detail;
    throw failure;
  }
  finally {
    if (turn === current) {
      companionActions.finish();
      if (current.emotion.owner) {
        retiredExpressionOwners.push({...current.emotion.owner});
        if (retiredExpressionOwners.length > 32) retiredExpressionOwners.shift();
      }
      turn = null;
    }
  }
}

async function reply(config) {
  if (turn || admitting) throw Error('A conversation turn is already active');
  const admission = admitting = {};
  try {
    const timing = await connect(config);
    // The picture is usually on the session already (staged while V typed); then this costs nothing. Otherwise the wait for
    // Convai to buffer it runs beside the context update and is capped (visionWaitMs).
    const seen = config.reaction ? false : await stageTurnVision(config);
    const buffered = seen ? awaitTurnVision(config) : null;
    await updateContext(config, true, seen);
    if (buffered) await buffered;
    const current = beginTurn(timing, config);
    // collect() owns every later failure path. Until it runs, a failed send must
    // not leave the standby output device open.
    try {
      if (config.reaction) client.sendTriggerMessage(undefined, config.text);
      else client.sendUserTextMessage(config.text);
    } catch (error) { retireStandby(current.live, 'Conversation failed'); throw error; }
    return await collect(current);
  } finally { if (admitting === admission) admitting = null; await retireVision(); }
}

// "Companions can see": puts this turn's picture (config.visionImages) on the session, unless the same picture was staged ahead
// (prestageVision while V typed, stageVision while V talked). True when a picture is on the session for this turn.
async function stageTurnVision(config) {
  const own = vision;
  if (!own) return false;
  if (Array.isArray(config?.visionImages) && config.visionImages.length) await own.stage(config.visionImages);
  else own.claim();
  return own === vision && !!own.staged && !own.notEnabled;
}
// Waits until Convai has buffered the staged picture, at most visionWaitMs (default VISION_READY_MS). A picture staged ahead is
// usually buffered already, so this returns at once. Out of time, the line goes anyway and the picture stays published for the
// turn, so the server may still take it before the model answers.
async function awaitTurnVision(config) {
  const own = vision;
  if (!own?.staged) return false;
  const cap = Number.isFinite(config?.visionWaitMs) ? Math.max(0, Math.min(900, config.visionWaitMs)) : VISION_READY_MS;
  const result = await own.ready(performance.now() + cap);
  observed.visionReady = {attached: result.attached, outcome: result.outcome, ms: Math.round(result.ms), waitedMs: Math.round(result.waitedMs ?? 0)};
  return result.attached;
}

// After a turn, its picture is withdrawn (track unpublished), so it can never ride along into a later turn.
async function retireVision() { try { await vision?.retire(); } catch {} }

// Starts handing pictures to the running microphone turn while V is still talking (the bridge calls it right after the talk key),
// so the picture is buffered before V finishes. Returns {staged, reason?}; never throws.
async function stageVision(images) {
  if (!vision || !turn?.recording) return {staged: false, reason: vision ? 'no-recording' : 'vision-off'};
  const result = await vision.stage(images);
  if (result.staged) void vision.ready(performance.now() + 5000).catch(() => {});
  return result;
}
// Publishes a picture on this idle page ahead of its turn (the composer is open), withdrawn after PRESTAGE_TTL_MS unless a turn
// takes it. Returns {staged, reason?}; never throws.
async function prestageVision(images) {
  if (!vision) return {staged: false, reason: client ? 'vision-off' : 'no-page'};
  if (turn || admitting) return {staged: false, reason: 'busy'};
  try {
    const result = await vision.stage(images, {ttlMs: PRESTAGE_TTL_MS});
    if (result.staged) void vision.ready(performance.now() + 5000).catch(() => {});
    return result;
  } catch { return {staged: false, reason: 'failed'}; }
}
async function unstageVision() { if (!turn && !admitting) await retireVision(); }

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
    await updateContext(config, false);
    const connection = client;
    current = beginTurn(timing, config);
    current.recording = true; current.microphone = true; current.contextConfig = config;
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

async function updateContext(config, allowActions = false, seen = false) {
  const connection = client, contextEpoch = epoch;
  const context = {mode: 'replace', run_llm: 'false',
    text: 'You are speaking to V in Night City. Reply briefly without stage directions. '
      + 'Use only explicitly supplied current-save facts for quest progress and relationships. '
      + 'Any relationship state not explicitly supplied is unknown; do not infer it from character presence or past sessions. '
      + (config.context || 'This is a private conversation with V.') + (seen ? VISION_NOTE : '')};
  const baseContext = context.text;
  const manual = allowActions && !config.reaction && !config.freshSession && typeof config.endUserId === 'string';
  const privateManual = manual && /^private(?::|$)/.test(config.scope || '');
  // A group round's first speaker may carry a leave-only offer (docs/WORLD_COMPANIONS.md).
  const groupManual = manual && /^group:/.test(config.scope || '');
  const offered = config.companionAction && ((privateManual && config.companionAction.group !== true)
    || (groupManual && config.companionAction.group === true)) ? config.companionAction : null;
  const verified = verifiedProvider?.connection === client && currentParticipant(client, audioParticipant);
  companionActions.clear();
  const armed = verified && offered && companionActions.open(offered);
  observed.actionEligibility = {allowed: allowActions, privateManual: !!privateManual, groupManual: !!groupManual,
    hasOffer: !!config.companionAction, verified: !!verified, armed: !!armed};
  if (armed) observed.actionsOffered = (observed.actionsOffered ?? 0) + 1;
  // Driving, marked-target and party prompt material lives beside its strict parser.
  if (armed) context.text += CompanionActionWindow.contextText(offered);
  if (armed || actionContextConfigured) {
    try {
      await publishCompanionActionContext(connection, context, armed ? offered : null);
      if (client !== connection || epoch !== contextEpoch) throw Error('Conversation context update cancelled');
      actionContextConfigured = true;
      observed.actionContextsPublished = (observed.actionContextsPublished ?? 0) + 1;
      return;
    } catch {
      if (client !== connection || epoch !== contextEpoch) throw Error('Conversation context update cancelled');
      // An unavailable action adapter cannot break ordinary conversation or
      // authorize an unconfigured proposal. Its old one-use target is revoked.
      companionActions.clear();
      observed.actionContextFailures = (observed.actionContextFailures ?? 0) + 1;
      context.text = baseContext + CompanionActionWindow.unavailableText(armed ? offered : null);
    }
  }
  connection.updateContext(context);
}

async function finishVoice(config) {
  const current = turn;
  if (!current?.recording) throw Error('No microphone conversation is recording');
  if (config !== undefined) {
    if (config.freshSession || visionIdentity(transportKey(config), config) !== identity
        || (config.sessionId && config.sessionId !== initialSession && config.sessionId !== client.characterSessionId)) {
      await close('Microphone reply identity changed'); throw Error('Microphone reply identity changed');
    }
  }
  await verifyProviderIdentity(current.providerIdentity, client);
  if (turn !== current || current.epoch !== epoch || !current.recording) throw Error('Microphone finish cancelled');
  // The picture staged while V talked is normally buffered already; one handed over only now waits at most visionWaitMs.
  const seen = await stageTurnVision(config);
  if (seen) await awaitTurnVision(config);
  if (turn !== current || current.epoch !== epoch || !current.recording) throw Error('Microphone finish cancelled');
  // Same leased connection, new verified context. Updating before mute keeps
  // the fresh facts ahead of the end-of-input notification to the service.
  if (config !== undefined) await updateContext(config, true, seen);
  else if (seen) await updateContext(current.contextConfig ?? {}, false, true);
  try { attachContinuous(current, config?.liveSpeechToken); }
  catch (error) { await close('Microphone playback admission failed'); throw error; }
  current.recording = false;
  try {
    await disableMic();
    if (turn !== current || current.epoch !== epoch) throw Error('Microphone finish cancelled');
  } catch (error) { retireStandby(current.live, 'Microphone finish failed'); throw error; }
  try { return await collect(current); } finally { await retireVision(); }
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

// The late emotion of the text-only reply that returned `token`: {signal} once admitted, {pending} while it can still
// arrive, {} when it cannot (expired, ambiguous, a newer reply started, or the connection closed).
function readLateEmotion(token) {
  const held = lateEmotion;
  if (!held || held.token !== token) return {};
  const signal = held.emotion.snapshot();
  if (signal) return {signal};
  return !held.closed && !held.emotion.ambiguous && performance.now() - held.at < LATE_EMOTION_MS ? {pending: true} : {};
}

window.convaiRealtime = {reply, warm: connect, readiness, beginVoice, finishVoice, close, diagnostics, stageVision, prestageVision, unstageVision,
  heard: () => heardText(turn),
  continuousSnapshot, continuousControl, lateEmotion: readLateEmotion};
