import {readFile, stat, mkdir} from 'node:fs/promises';
import {resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseInput, profileFor} from './protocol.mjs';
import {audioReady} from './speech-audio.mjs';
import {buildFacialTimeline} from './facial-timeline.mjs';
import {ConvaiContinuousSpeech} from './convai-continuous-speech.mjs';
import {PhoneticLipsync} from './phonetic-lipsync.mjs';
import {SpeechSlots, SpeechStream, splitSpeechText} from './speech-stream.mjs';
import {RealtimeHost} from './realtime-host.mjs';
import {MicrophoneSession} from './microphone-session.mjs';
import {randomUUID} from 'node:crypto';
import {conversationScope} from './group-context.mjs';
import {conversationContext} from './quest-context.mjs';
import {battleTrigger, reactionLeaseValid} from './battle-context.mjs';
import {GroupPrefetch, inputIdentity, validatePrefetch, parsePrewarm} from './group-prefetch.mjs';
import {throwIfCancelled} from './transport-pool.mjs';
import {PartyConnections, parsePartyConnections} from './party-connections.mjs';
import {CompanionInvitations} from './companion-invitations.mjs';
import {LOCAL_VOICE_KEYS} from './resident-voice.mjs';
import {VoiceSelection} from './voice-selection.mjs';
import {PhoneChat, parsePhoneState} from './phone-chat.mjs';
import {GameLaunchIdentity, identifyGameLaunch} from './game-launch.mjs';
import {PlayerMemory} from './player-memory.mjs';
import {PlayerMemoryApi} from './player-memory-api.mjs';
import {PlayerMemoryControl} from './player-memory-control.mjs';
import {PlayerKnowledge} from './player-knowledge.mjs';
import {PlayerPhoneKnowledge, playerPhoneGeneration} from './player-phone-knowledge.mjs';
import {atomicFile as atomic} from './guarded-file.mjs';
import {readWorldSession} from './world-session.mjs';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const stateDirectory = resolve(process.env.CYBERPUNK_CONVAI_STATE || resolve(project, 'runtime'));
const game = process.env.CYBERPUNK_CONVAI_GAME || 'E:\\SteamLibrary\\steamapps\\common\\Cyberpunk 2077';
const runtime = resolve(game, 'bin/x64/plugins/cyber_engine_tweaks/mods/CyberpunkConvai/runtime');
const keyFile = process.env.CYBERPUNK_CONVAI_KEY_FILE || resolve(stateDirectory, 'convai-key.txt');
const roster = JSON.parse(await readFile(resolve(project, 'characters/roster.json'), 'utf8'));
const ids = JSON.parse(await readFile(resolve(stateDirectory, 'characters.json'), 'utf8'));
const localVoiceConfigPath = resolve(stateDirectory, 'local-voices.json');
const voiceConfig = JSON.parse(await readFile(localVoiceConfigPath, 'utf8').catch(error => {
  if (error.code === 'ENOENT') return '{}';
  throw error;
}));
let voiceMetricsWriting = Promise.resolve();
const localVoice = new VoiceSelection(voiceConfig, {project, configPath: localVoiceConfigPath,
  onState: state => {
    voiceMetricsWriting = voiceMetricsWriting.catch(() => {}).then(() => atomic(resolve(runtime, 'local-voice-state.json'), JSON.stringify(state)));
    return voiceMetricsWriting;
  },
  onLog: message => process.stderr.write('[LocalVoice] ' + message),
});
const keyLine = (await readFile(keyFile, 'utf8')).trim();
const key = /^api-key\s*=\s*(\S+)\s*$/i.exec(keyLine)?.[1];
if (!key) throw Error('Local Convai key file must contain api-key=...');
await mkdir(runtime, {recursive: true});

const knowledgePack = JSON.parse(await readFile(resolve(project, 'characters/world-knowledge.json'), 'utf8'));
const questCatalog = JSON.parse(await readFile(resolve(project, 'research/cyberpunk/generated/quest-catalog.json'), 'utf8'));
// One local player ID is shared across all characters and saves. No save facts,
// branch IDs, manual memory archive or provider-ID pool participates in routing.
let worldSession = null, knowledgePolling = false, memoryQuiescing = 0;
const currentBoundary = () => worldSession?.ready === true
  && Date.now() - worldSession.updated < 5000
  ? {worldToken: worldSession.token, generation: worldSession.generation} : null;
const worldCurrent = boundary => {
  const current = currentBoundary();
  return !!current && current.worldToken === boundary.worldToken && current.generation === boundary.generation;
};
const playerMemory = await PlayerMemory.open({path: resolve(stateDirectory, 'player-memory.json'),
  characterIds: ids, provider: new PlayerMemoryApi({key, characterIds: ids}), quiesce: quiescePlayerMemory});
const knowledgeRouter = new PlayerKnowledge({playerMemory, pack: knowledgePack, questCatalog,
  isWorldCurrent: worldCurrent, getBoundary: currentBoundary});
const phoneKnowledge = new PlayerPhoneKnowledge({router: knowledgeRouter, getBoundary: currentBoundary});
const phoneRealtime = new RealtimeHost();
const knowledgeTurns = new Map();
function rememberKnowledgeTurn(prepared) {
  const requestId = prepared.input.requestId || prepared.input.id;
  knowledgeTurns.set(requestId, {prepared, createdAt: Date.now()});
  for (const [id, item] of knowledgeTurns) if (Date.now() - item.createdAt > 180000 || knowledgeTurns.size > 64) knowledgeTurns.delete(id);
}
function stagedKnowledgeTurn(prepared) {
  const entry = knowledgeTurns.get(prepared.input.requestId || prepared.input.id);
  if (entry?.prepared === prepared) entry.generated = true;
}
async function cancelKnowledgeTurn(prepared) {
  if (!prepared) return;
  const entry = knowledgeTurns.get(prepared.input.requestId || prepared.input.id);
  if (entry?.delivered || entry?.cancelled) return;
  // Lua can finish audible playback and submit the next group speaker in one
  // tick, before the slower delivery poll. Preserve that already-heard reply
  // using the exact game receipt before retiring its request. World/memory
  // validation remains inside recordDelivery/knowledgeRouter.activity.
  if (entry?.generated) {
    const state = await readSpeechState();
    const age = Date.now() - state.updated;
    if (Number.isFinite(state.updated) && Number.isFinite(age) && age >= -1500 && age <= 5000
      && state.lastDelivery?.requestId === prepared.input.requestId) {
      await recordDelivery(state.lastDelivery);
    }
    if (entry.delivered || entry.cancelled) return;
  }
  if (entry) entry.cancelled = true;
  await knowledgeRouter.activity(prepared, 'cancelled-turn').catch(() => {});
}
async function cancelMicrophone() {
  const current = mic.current;
  if (current) await cancelKnowledgeTurn(microphoneKnowledge.get(current.requestId));
  await mic.cancel();
  microphoneKnowledge.clear();
  microphoneSpeech.clear();
}

const phoneInput = resolve(runtime, 'phone-chat-input.json');
const phoneOutput = resolve(runtime, 'phone-chat-output.json');
const phoneSessionPath = resolve(stateDirectory, 'phone-sessions.json');
let phoneSessions = {};
try { phoneSessions = JSON.parse(await readFile(phoneSessionPath, 'utf8')) || {}; } catch {}
const phone = new PhoneChat({
  contacts: JSON.parse(await readFile(resolve(project, 'characters/phone-contacts.json'), 'utf8')), ids,
  contextFor: options => phoneKnowledge.prepareContext(options),
  contextCurrent: context => phoneKnowledge.current(context),
  contextCurrentSync: context => phoneKnowledge.currentSync(context),
  reply: async options => {
    const prepared = await phoneKnowledge.preparedFor(options);
    if (!await knowledgeRouter.current(prepared)) throw Error('Phone world changed');
    const remote = prepared.remoteConfig || {};
    if (options.characterId !== prepared.guard.characterId
        || options.endUserId !== remote.endUserId || options.scope !== prepared.scope
        || options.sessionKey !== prepared.sessionKey
        || options.remoteGeneration !== playerPhoneGeneration(prepared.guard)) throw Error('Phone memory binding changed');
    const admitted = await admitPlayerConversation(prepared, {signal: options.signal});
    await knowledgeRouter.submitted(prepared);
    throwIfCancelled(options.signal);
    if (!await knowledgeRouter.current(prepared)) throw Error('Phone world changed');
    rememberKnowledgeTurn(prepared);
    const result = await phoneRealtime.reply({key, characterId: options.characterId,
      sessionId: admitted.reconnectRequired ? undefined : options.sessionId,
      scope: prepared.scope, ...remote,
      context: conversationContext(prepared.input),
      text: options.input.text, ttsEnabled: false}, {signal: options.signal});
    if (!await knowledgeRouter.current(prepared)) throw Error('Phone world changed');
    await knowledgeRouter.activity(prepared, 'generated-reply', {replyText: result.text});
    stagedKnowledgeTurn(prepared);
    return result;
  },
  publish: (value, options) => atomic(phoneOutput, JSON.stringify(value), options),
  sessions: phoneSessions, saveSessions: value => atomic(phoneSessionPath, JSON.stringify(value)),
});
let phonePolling = false;
const phoneLaunch = new GameLaunchIdentity({identify: () => identifyGameLaunch(game),
  publish: value => atomic(resolve(runtime, 'phone-game-launch.json'), JSON.stringify(value))});
async function pollPhone() {
  if (phonePolling || stopped) return;
  phonePolling = true;
  try {
    const state = parsePhoneState(await readFile(phoneInput, 'utf8').catch(() => ''));
    await phoneLaunch.update(state).catch(() => {});
    if (stopped) return;
    if (state?.request) {
      // A service restart must not replay a reply already published to the mod.
      let prior; try { prior = JSON.parse(await readFile(phoneOutput, 'utf8')); } catch {}
      if (prior?.world === state.world && prior.id === state.request.id && ['reply', 'error'].includes(prior.state)) {
        state.request = undefined;
      }
    }
    await phone.accept(state);
  } finally { phonePolling = false; }
}

const inputPath = resolve(runtime, 'last-input.json');
const replyPath = resolve(runtime, 'reply.json');
const statusPath = resolve(runtime, 'bridge-status.json');
const prefetchPath = resolve(runtime, 'group-prefetch.json');
const prewarmPath = resolve(runtime, 'conversation-prewarm.json');
const partyPath = resolve(runtime, 'party-connections.json');
const sessions = new Map();
const realtimeSessions = new Map();
const audioDepot = resolve(game, 'r6/audioware/CyberpunkConvai');
const lipsync = new PhoneticLipsync({project});
const readSpeechState = async () => {
  try { return JSON.parse(await readFile(resolve(runtime, 'speech-state.json'), 'utf8')); } catch { return {}; }
};
const slots = new SpeechSlots({depot: audioDepot, readState: readSpeechState});
let streamWriting = Promise.resolve(), streaming = 0;
function writeStreamManifest(document, current) {
  const job = streamWriting.catch(() => {}).then(async () => {
    if (await current()) await atomic(resolve(runtime, 'speech-stream.json'), JSON.stringify(document), {isCurrent: current, isCurrentSync: current.sync});
  });
  streamWriting = job; return job;
}
const realtime = new RealtimeHost();
let observed = '';
let lastAcceptedIdentity = '';
let polling = false, active = null, stopped = false;
let prefetchPolling = false, prefetchObserved = '', partyObserved = '', partyWasFresh = false;
let prewarmObserved = await readFile(prewarmPath, 'utf8').catch(() => '');
const latency = new Map();
let metricsWriting = Promise.resolve();
let connectionMetricsWriting = Promise.resolve();

const preparedInputs = new WeakMap();
const boundaryFor = input => ({entity: input?.entity,
  worldToken: input?.worldKnowledge?.worldToken || worldSession?.token,
  generation: input?.worldKnowledge?.generation || worldSession?.generation});
const routeFor = input => preparedInputs.get(input)
  || knowledgeRouter.configFor(input.profileKey, conversationScope(input), boundaryFor(input));
const sessionKey = input => routeFor(input)?.sessionKey || JSON.stringify(['unavailable', input.profileKey, input.requestId]);
const completeContext = input => JSON.stringify([conversationContext(input), ids[input.profileKey], realtimeSessions.get(sessionKey(input)) || null,
  localVoice.usesProfile(input.profileKey) ? localVoice.steps : 'convai']);
const realtimeConfig = input => ({key, characterId: ids[input.profileKey], sessionId: realtimeSessions.get(sessionKey(input)),
  scope: routeFor(input)?.scope || conversationScope(input), ...(routeFor(input)?.remoteConfig || {}),
  context: conversationContext(input), text: battleTrigger(input), reaction: input.reaction,
  ttsEnabled: !localVoice.usesProfile(input.profileKey)});
const warmRoute = (profile, scope) => memoryQuiescing ? null : knowledgeRouter.configFor(profile, scope,
  {worldToken: worldSession?.token, generation: worldSession?.generation});
const connections = new PartyConnections({host: realtime,
  canWarm: () => !stopped && !memoryQuiescing && !active && !mic.current && !micPolling,
  isKnown: profile => Object.hasOwn(ids, profile) && !!warmRoute(profile, 'private'),
  configFor: (profile, scope) => {
    const route = warmRoute(profile, scope);
    if (!route) throw Error('No current world for conversation warmup');
    return {key, characterId: ids[profile], scope: route.scope, ...(route.remoteConfig || {}),
      sessionId: realtimeSessions.get(route.sessionKey), ttsEnabled: !localVoice.usesProfile(profile)};
  },
  onState: state => {
    connectionMetricsWriting = connectionMetricsWriting.catch(() => {}).then(() => atomic(resolve(runtime, 'party-connection-state.json'), JSON.stringify(state)));
    return connectionMetricsWriting;
  },
});
const invitations = new CompanionInvitations({memory: playerMemory, connections,
  currentWorld: currentBoundary,
  isKnown: profile => Object.hasOwn(ids, profile),
  isCurrentGuard: guard => playerMemory.isCurrent(guard),
  publish: (value, options) => atomic(resolve(runtime, 'companion-invitations-state.json'), JSON.stringify(value), options),
});

function measure(input, values) {
  const previous = latency.get(input.requestId) || {requestId: input.requestId, profile: input.profileKey, groupIndex: input.group?.index};
  latency.set(input.requestId, {...previous, ...values});
  while (latency.size > 24) latency.delete(latency.keys().next().value);
  // No dialogue, API keys or character session IDs are written to metrics.
  metricsWriting = metricsWriting.catch(() => {}).then(() => atomic(resolve(runtime, 'bridge-latency.json'), JSON.stringify({
    version: 1, updated: Date.now(), turns: [...latency.values()],
  })));
  return metricsWriting;
}

const prefetch = new GroupPrefetch({prepare: async (input, {signal}) => {
  // The SDK has no session fork/rollback. Existing sessions are warm-only so
  // cancelled predictions cannot alter memory or erase conversation history.
  if (realtimeConfig(input).endUserId || realtimeSessions.has(sessionKey(input))) throw Error('Identified or existing character session is warm-only');
  return synthesizeReply(input, {...await realtime.prepare(realtimeConfig(input), {signal}), transport: 'realtime'}, signal);
}});

async function synthesizeReply(input, result, signal) {
  if (!localVoice.usesProfile(input.profileKey)) return {...result, timing: {...result.timing, voiceProvider: 'convai'}};
  throwIfCancelled(signal);
  try {
    const phrases = splitSpeechText(result.text), steps = localVoice.steps;
    const generated = await synthesizePhrase(input.profileKey, phrases[0], {signal, steps});
    return {...result, ...generated, text: result.text, timing: {...result.timing, ...generated.timing},
      streamPlan: phrases.length > 1 ? {phrases, steps} : undefined};
  } catch (error) {
    throwIfCancelled(signal);
    console.error('[CyberpunkConvai] Local speech:', error.message);
    // Preserve a successful dialogue turn if a local model is unavailable.
    // Do not substitute a different character's voice or turn Convai TTS on.
    return {...result, audio: undefined, faces: [], captions: [],
      audioError: 'Local voice is unavailable; showing the written reply.'};
  }
}

async function synthesizePhrase(profile, text, options) {
  const generated = await localVoice.synthesize(profile, text, options);
  try {
    const facial = await lipsync.analyse(generated.audio, options);
    return {...generated, ...facial, timing: {...generated.timing, ...facial.timing}};
  } catch (error) {
    throwIfCancelled(options?.signal);
    console.error('[CyberpunkConvai] Local lip-sync fallback:', error.message);
    return generated;
  }
}

async function status(state, detail = '') {
  await atomic(statusPath, JSON.stringify({state, detail: detail.slice(0, 200), updated: Date.now()}));
}

function continuousSpeech(input, profile, current, signal, receiptPrepared = preparedInputs.get(input)) {
  const options = {signal, isCurrent: current, isCurrentSync: current.sync};
  return new ConvaiContinuousSpeech({input, profile, current, signal,
    readControl: () => readFile(resolve(runtime, 'continuous-control.json'), 'utf8'),
    writeState: value => atomic(resolve(runtime, 'continuous-speech.json'), JSON.stringify(value), options),
    writeReply: value => atomic(replyPath, JSON.stringify(value), options),
    onPublished: timing => measure(input, {...timing, stream: {mode: 'convai-continuous'}, nativePlaybackObserved: false}),
    onStarted: timing => measure(input, {...timing, continuousPlaybackObserved: true}),
    onGenerated: async text => {
      // Microphone context refresh creates a new projection at finish. Its
      // generated/delivered receipts still belong to the original submitted
      // turn, shared by every channel of this conversation.
      if (!receiptPrepared || !await current()) throw Error('Conversation receipt owner changed');
      await knowledgeRouter.activity(receiptPrepared, 'generated-reply', {replyText: text});
      stagedKnowledgeTurn(receiptPrepared);
    },
  });
}

// Original remote PCM has a continuous renderer. It never enters Omni's text
// splitter, local TTS worker or per-phrase Audioware file queue.
async function convaiReply(input, profile, current, signal) {
  const state = await readSpeechState();
  // Retain the complete-file adapter until this game session advertises the
  // new Lua admission controller; installing files alone does not load them.
  if (state.continuousAvailable !== true) {
    return {...await realtime.reply(realtimeConfig(input), {signal}), transport: 'realtime'};
  }
  const speech = continuousSpeech(input, profile, current, signal);
  try {
    const result = await realtime.reply(realtimeConfig(input), {signal, liveSpeech: speech.options});
    return {...result, transport: 'realtime', liveDelivery: {published: speech.published,
      ended: speech.ended, generated: speech.generated, id: speech.token}};
  } catch (error) { await speech.fail().catch(() => {}); throw error; }
}

async function respond(input, profile, {signal, prepared, current} = {}) {
  if (await audioReady(runtime)) {
    if (prepared) {
      try { return await prepared; }
      catch { throwIfCancelled(signal); /* Failed speculation falls back to the submitted turn. */ }
    }
    throwIfCancelled(signal);
    if (!localVoice.usesProfile(input.profileKey)) return convaiReply(input, profile, current, signal);
    return synthesizeReply(input, {...await realtime.reply(realtimeConfig(input), {signal}), transport: 'realtime'}, signal);
  }
  prefetch.invalidate(); prepared?.cancel();
  throwIfCancelled(signal);
  // Text-only replies keep the same identified transport when native playback
  // is unavailable; legacy HTTP does not document the player-memory binding.
  return {...await realtime.reply({...realtimeConfig(input), ttsEnabled: false}, {signal}), transport: 'realtime'};
}

async function publishResult(input, profile, result, current = async () => true, signal) {
  if (!await current()) return false;
  if (result.continuous) {
    if (!result.liveDelivery?.published || !result.liveDelivery.ended) throw Error('Continuous speech did not finish');
    // The game already received admission, live text and the consumed-sample
    // clock. Publishing a second ordinary reply would replay or replace it.
    realtimeSessions.set(sessionKey(input), result.sessionID);
    connections.used(input, result.timing); prefetch.published(input, result.text); prefetchObserved = '';
    await measure(input, {transport: 'realtime', timing: result.timing,
      stream: {id: result.liveDelivery.id, mode: 'convai-continuous', complete: true},
      continuousPlaybackCompleteAt: Date.now()});
    await status('ready', profile.name);
    return true;
  }
  const preparationStartedAt = Date.now();
  let audio, face, stream, audioError = result.audioError;
  if (result.audio) {
    try {
      if (result.streamPlan) {
        stream = new SpeechStream({input, ...result.streamPlan, slots, readState: readSpeechState, current, signal,
          writeManifest: document => writeStreamManifest(document, current),
          synthesize: (text, options) => synthesizePhrase(profile.key, text, options)});
        const first = await stream.begin(result);
        audio = first.audio; face = first.face;
      } else {
        const id = randomUUID();
        await slots.begin(id, current);
        audio = await slots.write(id, 1, result.audio, current);
      }
      if (!await current()) return false;
      try { face ??= buildFacialTimeline(result, input); }
      catch (error) { console.error('[CyberpunkConvai] Facial timing unavailable:', error.message); }
      await atomic(resolve(runtime, 'last-speech-timing.json'), JSON.stringify({
        requestId: input.requestId, faces: result.faces, facesFormat: result.facesFormat,
        captions: result.captions, duration: audio.duration, face,
      }), {signal, isCurrent: current, isCurrentSync: current.sync});
    } catch (error) {
      audio = undefined; face = undefined; stream = undefined;
      audioError = 'Voice could not be prepared; showing the written reply.';
      console.error('[CyberpunkConvai] Voice preparation failed:', error.message);
    }
  }
  if (!await current()) return false;
  const committed = await atomic(replyPath, JSON.stringify({requestId: input.requestId, generation: input.generation,
    entity: input.entity, profile: profile.key, text: result.text, userText: result.userText, audio, face, audioError,
    stream: stream?.descriptor(), updated: Date.now()}), {signal, isCurrent: current, isCurrentSync: current.sync});
  if (!committed || !await current()) return false;
  (result.transport === 'realtime' ? realtimeSessions : sessions).set(sessionKey(input), result.sessionID);
  if (result.transport === 'realtime') connections.used(input, result.timing);
  prefetch.published(input, result.text);
  // Reconsider the prediction file after a source reply becomes valid.
  prefetchObserved = '';
  await measure(input, {transport: result.transport || 'rest', timing: result.timing, preparation: result.preparation,
    audioStoreMs: Date.now() - preparationStartedAt, publishedAt: Date.now(), audioDurationSeconds: audio?.duration,
    stream: stream ? {id: stream.manifest.streamId, chunks: stream.phrases.length, mode: 'local-phrases'} : undefined,
    nativePlaybackObserved: false});
  await status('ready', profile.name);
  if (stream) {
    streaming++;
    try {
      await stream.finish();
      if (await current()) await measure(input, {stream: {id: stream.manifest.streamId, mode: 'local-phrases',
        chunks: stream.manifest.chunks.length, complete: stream.manifest.complete, error: stream.error,
        productionMs: Date.now() - stream.started, audioDurationSeconds: stream.totalDuration,
        timings: stream.manifest.chunks.map(chunk => ({index: chunk.index, readyAt: chunk.readyAt,
          duration: chunk.audio.duration, ...chunk.timing}))}});
    } finally { streaming--; prefetchObserved = ''; }
  }
  return true;
}

const micPath = resolve(runtime, 'microphone-command.json');
const microphoneKnowledge = new Map();
const microphoneSpeech = new Map();
let micObserved = await readFile(micPath, 'utf8').catch(() => '');
let micPolling = false;
const mic = new MicrophoneSession({hostFactory: () => realtime.voiceChannel(),
  onState: (state, input) => atomic(resolve(runtime, 'microphone-state.json'), JSON.stringify({state, requestId: input.requestId, updated: Date.now()})),
  prepareReply: async (input, signal) => {
    if (localVoice.usesProfile(input.profileKey) || (await readSpeechState()).continuousAvailable !== true) return;
    const prepared = microphoneKnowledge.get(input.requestId);
    const current = async () => {
      if (stopped || signal.aborted || mic.current?.requestId !== input.requestId || !prepared) return false;
      let command; try { command = JSON.parse(await readFile(micPath, 'utf8')); } catch { return false; }
      return command.input?.requestId === input.requestId && command.action === 'finish'
        && await knowledgeRouter.current(prepared);
    };
    current.sync = () => !stopped && !signal.aborted && mic.current?.requestId === input.requestId
      && prepared && knowledgeRouter.currentSync(prepared);
    const speech = continuousSpeech(input, profileFor(input, roster), current, signal, prepared);
    microphoneSpeech.set(input.requestId, speech);
    return {liveSpeech: speech.options};
  },
  onReply: async (input, result, signal) => {
    if (stopped) return;
    const prepared = microphoneKnowledge.get(input.requestId);
    if (!prepared || !await knowledgeRouter.current(prepared)) return;
    const command = JSON.parse(await readFile(micPath, 'utf8'));
    if (command.input?.requestId !== input.requestId || command.action === 'cancel') return;
    const speech = microphoneSpeech.get(input.requestId);
    const spoken = await synthesizeReply(input, {...result, transport: 'realtime',
      ...(speech ? {liveDelivery: {published: speech.published, ended: speech.ended,
        generated: speech.generated, id: speech.token}} : {})}, signal);
    if (!speech?.generated) {
      await knowledgeRouter.activity(prepared, 'generated-reply', {replyText: result.text});
      stagedKnowledgeTurn(prepared);
    }
    const current = async () => {
      if (stopped || signal?.aborted) return false;
      const latest = JSON.parse(await readFile(micPath, 'utf8').catch(() => '{}'));
      return latest.input?.requestId === input.requestId && latest.action !== 'cancel' && await knowledgeRouter.current(prepared);
    };
    current.sync = () => !stopped && !signal?.aborted && knowledgeRouter.currentSync(prepared);
    await publishResult(input, profileFor(input, roster), spoken, current, signal);
    microphoneSpeech.delete(input.requestId);
  },
  onError: async (input, error) => {
    await microphoneSpeech.get(input.requestId)?.fail().catch(() => {});
    microphoneSpeech.delete(input.requestId);
    console.error('[CyberpunkConvai] Microphone:', error.message);
    const prepared = microphoneKnowledge.get(input.requestId);
    const current = async () => {
      if (stopped || (prepared && !await knowledgeRouter.current(prepared))) return false;
      let latest; try { latest = JSON.parse(await readFile(micPath, 'utf8')); } catch { return false; }
      return latest.input?.requestId === input.requestId && latest.action !== 'cancel';
    };
    current.sync = () => !stopped && (!prepared || knowledgeRouter.currentSync(prepared));
    if (!await current()) return;
    await atomic(resolve(runtime, 'microphone-state.json'), JSON.stringify({state: 'error', requestId: input.requestId, updated: Date.now()}), {isCurrent: current, isCurrentSync: current.sync});
    await atomic(replyPath, JSON.stringify({requestId: input.requestId, generation: input.generation,
      entity: input.entity, error: 'Voice conversation failed. Check your microphone and try again.'}), {isCurrent: current, isCurrentSync: current.sync});
  },
});

async function resetLiveRoutes({cancelTurns = true} = {}) {
  // Clearing cloud memory must retire injected provider context and session
  // history too. No native/save data or persistent player identity is changed.
  if (cancelTurns) {
    active?.controller.abort();
    phone.close(); phoneKnowledge.clear();
    await cancelMicrophone();
  }
  prefetch.invalidate();
  await invitations.clear('world-or-memory-reset');
  await Promise.allSettled([realtime.close(), phoneRealtime.close()]);
  await connections.clear();
  sessions.clear(); realtimeSessions.clear(); knowledgeTurns.clear();
  partyObserved = ''; prewarmObserved = ''; prefetchObserved = '';
}

async function quiescePlayerMemory({signal} = {}) {
  throwIfCancelled(signal);
  memoryQuiescing++;
  try {
    await resetLiveRoutes();
    throwIfCancelled(signal);
    return {quiesced: true};
  } finally { memoryQuiescing--; }
}

async function admitPlayerConversation(prepared, {signal} = {}) {
  throwIfCancelled(signal);
  if (!prepared?.sendAllowed || !await knowledgeRouter.current(prepared)) throw Error('Conversation world changed');
  // An actually admitted battle/loot reply can enter natural provider memory.
  // Register its Forget target locally without enabling or seeding anything.
  if (prepared.input.reaction) {
    await playerMemory.recordAutomaticConversation({profileKey: prepared.route.profileKey,
      guard: prepared.guard, channel: prepared.route.channel,
      requestId: prepared.input.requestId || prepared.input.id, signal});
    throwIfCancelled(signal);
    if (!await knowledgeRouter.current(prepared)) throw Error('Conversation memory changed');
    return {reconnectRequired: false};
  }
  await playerMemory.beginConversation({profileKey: prepared.route.profileKey,
    guard: prepared.guard, source: 'player',
    channel: prepared.route.transport === 'microphone' ? 'microphone' : prepared.route.channel,
    requestId: prepared.input.requestId || prepared.input.id, signal});
  throwIfCancelled(signal);
  if (!await knowledgeRouter.current(prepared)) throw Error('Conversation memory changed');
  const refresh = {profileKey: prepared.route.profileKey, guard: prepared.guard};
  const reconnectRequired = playerMemory.connectionRefreshRequired(refresh)
    || connections.needsRetirement(prepared.route.profileKey);
  if (reconnectRequired) {
    // Invited companions completed this before spawning. A first conversation
    // with an existing world NPC still prepares on demand, retiring only that
    // character's pre-enable routes rather than everyone else's warm pages.
    await connections.retireInvitation(prepared.route.profileKey, {signal});
    const host = prepared.route.channel === 'phone' ? phoneRealtime : realtime;
    const config = {...realtimeConfig(prepared.input), ttsEnabled: prepared.route.channel === 'phone'
      ? false : !localVoice.usesProfile(prepared.route.profileKey)};
    if (!await host.refreshIdle(config)) throw Error('The character connection is still releasing. Please try again.');
    throwIfCancelled(signal);
    if (!await knowledgeRouter.current(prepared)) throw Error('Conversation world changed');
    playerMemory.acknowledgeConnectionRefresh(refresh);
  }
  return {reconnectRequired};
}

async function pollMicrophone() {
  if (micPolling || stopped) return;
  micPolling = true;
  try {
    const raw = await readFile(micPath, 'utf8').catch(() => '');
    if (raw && raw !== micObserved) {
      let command;
      try { command = JSON.parse(raw); } catch { return; }
      const input = parseInput(JSON.stringify(command.input));
      if (!input || !['start', 'finish', 'cancel'].includes(command.action)) return;
      micObserved = raw;
      if (command.action === 'cancel') {
        if (mic.current?.requestId === input.requestId) await cancelMicrophone();
      }
      else if (command.action === 'finish') {
        const prior = microphoneKnowledge.get(input.requestId);
        if (!prior || !await knowledgeRouter.current(prior)) { await cancelMicrophone(); return; }
        const refreshed = await knowledgeRouter.prepare({...input, source: 'microphone'},
          {worldToken: worldSession?.token, generation: worldSession?.generation});
        if (!await knowledgeRouter.current(prior) || !await knowledgeRouter.current(refreshed)
            || refreshed.sessionKey !== prior.sessionKey) { await cancelMicrophone(); return; }
        // The same submitted turn retains its receipt owner; only the context
        // snapshot and native input data refresh at microphone completion.
        preparedInputs.set(refreshed.input, refreshed);
        void mic.finish(input.requestId, {input: refreshed.input, config: realtimeConfig(refreshed.input)})
          .catch(error => console.error(error.message));
      }
      else {
        const profile = profileFor(input, roster);
        if (!profile || !ids[profile.key] || !await audioReady(runtime)) {
          await mic.onError(input, Error('Voice service or character is unavailable')); return;
        }
        // A new microphone turn supersedes a pending text reply.
        active?.controller.abort(); prefetch.invalidate();
        await cancelMicrophone();
        const prepared = await knowledgeRouter.prepare({...input, source: 'microphone'},
          {worldToken: worldSession?.token, generation: worldSession?.generation});
        try { await admitPlayerConversation(prepared); }
        catch (error) { await mic.onError(input, error); return; }
        await knowledgeRouter.submitted(prepared);
        preparedInputs.set(prepared.input, prepared); microphoneKnowledge.clear();
        microphoneKnowledge.set(input.requestId, prepared); rememberKnowledgeTurn(prepared);
        await connections.setRequest(prepared.input, realtimeConfig(prepared.input));
        const latest = JSON.parse(await readFile(micPath, 'utf8').catch(() => '{}'));
        if (microphoneKnowledge.get(input.requestId) !== prepared || !await knowledgeRouter.current(prepared)
            || latest.input?.requestId !== input.requestId || latest.action === 'cancel') {
          await cancelKnowledgeTurn(prepared); return;
        }
        void mic.start(prepared.input, realtimeConfig(prepared.input)).catch(error => console.error(error.message));
      }
    }
    const recording = mic.current;
    if (recording) {
      const owner = microphoneKnowledge.get(recording.requestId);
      if (!owner || !await knowledgeRouter.current(owner) || !await audioReady(runtime)) await cancelMicrophone();
      // Lua's 30-second finish captures fresh native context. Never let the
      // bridge timeout submit the old start snapshot first. Allow its command
      // two seconds to arrive; a missing command cancels the recording.
      else if (recording.opened && Date.now() - recording.opened >= 32000 && recording.intent !== 'finish') {
        await cancelMicrophone();
      }
    }
  } finally { micPolling = false; }
}

async function reactionCurrent(input) {
  if (!input.reaction) return true;
  // CET replaces the heartbeat by removing then renaming its file. Retry
  // that brief gap, but never retry an explicit cancellation or stale lease.
  for (let attempt = 0; attempt < 3; attempt++) {
    let lease;
    try { lease = JSON.parse(await readFile(resolve(runtime, 'reaction-lease.json'), 'utf8')); }
    catch (error) {
      if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) return false;
      if (attempt === 2) return null; // Unreadable, rather than a cancelled request.
      await new Promise(done => setTimeout(done, 15));
      continue;
    }
    return reactionLeaseValid(input, lease);
  }
}

async function tick() {
  if (polling || stopped) return;
  polling = true;
  try {
    const reactionRequest = active;
    if (reactionRequest?.input.reaction && !await reactionCurrent(reactionRequest.input)
        && active === reactionRequest) reactionRequest.controller.abort();
    const stamp = await stat(inputPath).catch(() => null);
    if (!stamp) return;
    const raw = await readFile(inputPath, 'utf8');
    const signature = `${stamp.mtimeMs}:${stamp.size}:${raw}`;
    if (signature === observed) return;
    const input = parseInput(raw);
    if (!input) {
      observed = signature;
      prefetch.invalidate();
      // Lua replaces this small file in place. A transient partial write is
      // not a new target and must not cancel an otherwise valid active turn.
      if (!active) await status('invalid-input', 'Could not parse the game request');
      return;
    }
    const identity = inputIdentity(input);
    if (identity === lastAcceptedIdentity) { observed = signature; return; }
    const lease = await reactionCurrent(input);
    // A missing/partial heartbeat has not accepted or rejected new input.
    // Leave its signature unseen so the next poll can retry the same file.
    if (lease === null) return;
    observed = signature;
    if (!lease) return;
    lastAcceptedIdentity = identity;
    active?.controller.abort();
    const controller = new AbortController();
    const request = active = {input, raw, controller, receivedAt: Date.now()};
    // Native decision/history context is projected at actual submission. A
    // raw prediction cannot be substituted for that verified context.
    void processInput(request);
  } catch (error) { console.error('[CyberpunkConvai] Input poll:', error.message); }
  finally { polling = false; }
}

async function processInput(request, prepared) {
  let input = request.input;
  const {controller} = request;
  const preparationStarted = performance.now();
  const stages = {};
  let knowledgeTurn;
  const current = async () => {
    if (controller.signal.aborted || active !== request || stopped) return false;
    // The complete request was validated once at admission. Comparing its
    // exact bytes detects any replacement, including changed context under the
    // same request ID, without repeatedly reparsing/hashing the large journal.
    const submitted = await readFile(inputPath, 'utf8').catch(() => null);
    return submitted !== null && submitted === request.raw && await reactionCurrent(input)
      && (!knowledgeTurn || await knowledgeRouter.current(knowledgeTurn));
  };
  current.sync = () => !controller.signal.aborted && active === request && !stopped
    && (!knowledgeTurn || knowledgeRouter.currentSync(knowledgeTurn));
  try {
    await cancelMicrophone();
    stages.cancelMicrophoneMs = performance.now() - preparationStarted;
    throwIfCancelled(controller.signal);
    const profile = profileFor(input, roster);
    if (!profile || !ids[profile.key]) {
      await status('unmatched-npc', `No verified profile for ${input.name} (${input.bodyType})`);
      await atomic(replyPath, JSON.stringify({...input, text: undefined,
        error: `${input.name} does not have a conversation profile configured yet.`}), {signal: controller.signal, isCurrent: current, isCurrentSync: current.sync});
      return;
    }
    knowledgeTurn = await knowledgeRouter.prepare(input, {worldToken: worldSession?.token, generation: worldSession?.generation});
    stages.knowledgePreparedMs = performance.now() - preparationStarted;
    input = knowledgeTurn.input; request.input = input; preparedInputs.set(input, knowledgeTurn);
    if (!await current()) return;
    // No speculative user turn may enter identified character memory.
    if (knowledgeTurn.remoteConfig?.endUserId) { prepared?.cancel(); prepared = undefined; }
    const memoryStarted = performance.now();
    await admitPlayerConversation(knowledgeTurn, {signal: controller.signal});
    stages.memoryAdmissionMs = performance.now() - memoryStarted;
    await knowledgeRouter.submitted(knowledgeTurn);
    stages.submissionRecordedMs = performance.now() - preparationStarted;
    if (!await current()) return;
    rememberKnowledgeTurn(knowledgeTurn);
    await measure(input, {receivedAt: request.receivedAt, preparation: {mode: prepared ? 'claimed' : 'none'},
      journalStatus: input.journal?.status || 'not-supplied', journalObjectives: input.journal?.quest?.objectives.length || 0,
      battleStatus: input.battle?.status || 'not-supplied', reaction: input.reaction?.phase});
    await status('thinking', profile.name);
    const canWarm = await audioReady(runtime);
    throwIfCancelled(controller.signal);
    if (canWarm) await connections.setRequest(input, realtimeConfig(input));
    throwIfCancelled(controller.signal);
    await measure(input, {transportRequestedAt: Date.now(),
      submissionStages: {...stages, beforeTransportMs: performance.now() - preparationStarted}});
    const result = await respond(input, profile, {signal: controller.signal, prepared, current});
    // Do not show a late reply to a different target or a newer turn.
    if (!await current()) return;
    if (!result.liveDelivery?.generated) {
      await knowledgeRouter.activity(knowledgeTurn, 'generated-reply', {replyText: result.text});
      stagedKnowledgeTurn(knowledgeTurn);
    }
    await measure(input, {resultReadyAt: Date.now(), requestToResultMs: Date.now() - request.receivedAt});
    await publishResult(input, profile, result, current, controller.signal);
  } catch (error) {
    if (!await current()) return;
    await status('error', error.message).catch(() => {});
    if (input) await atomic(replyPath, JSON.stringify({requestId: input.requestId,
      generation: input.generation, entity: input.entity,
      error: 'The conversation service could not reply. Please try again.'}), {signal: controller.signal, isCurrent: current, isCurrentSync: current.sync}).catch(() => {});
    console.error('[CyberpunkConvai] Bridge request failed:', error.message);
  } finally {
    if (knowledgeTurn && (controller.signal.aborted || !await current())) await cancelKnowledgeTurn(knowledgeTurn);
    if (active === request) active = null;
  }
}

let lastAudioHeartbeat = 0;
async function pollPrefetch() {
  if (prefetchPolling || stopped || memoryQuiescing) return;
  prefetchPolling = true;
  try {
    prefetch.prune();
    // Lua publishes party membership before releasing an attached invitation.
    // Read its reservation first, then the later membership publication so the
    // prepared private page survives the ownership handoff in this poll.
    let invitationRequest;
    try { invitationRequest = JSON.parse(await readFile(resolve(runtime, 'companion-invitations.json'), 'utf8')); } catch {}
    const partyRaw = await readFile(partyPath, 'utf8').catch(() => '');
    let partySnapshot; try { partySnapshot = JSON.parse(partyRaw); } catch {}
    if (partyRaw && partyRaw !== partyObserved) {
      const change = connections.ingest(partySnapshot);
      if (change) {
        partyObserved = partyRaw;
        if (change.removed.includes(active?.input.profileKey)) active.controller.abort();
        if (change.removed.length) prefetch.invalidate();
      }
    }
    // A Windows replace can briefly leave a file absent. Preserve the last
    // fresh reservation on that frame; expiry/world guards still fail closed.
    if (parsePartyConnections(partySnapshot)) invitations.ingest(invitationRequest);
    await invitations.poll();
    await connections.maintain();
    if (partyWasFresh && connections.stale) {
      prefetch.invalidate(); active?.controller.abort(); await mic.cancel(); await realtime.close();
    }
    partyWasFresh = !connections.stale;
    const speech = await readSpeechState();
    if (speech.available && Date.now() - speech.updated < 5000) lastAudioHeartbeat = Date.now();
    else if (lastAudioHeartbeat && Date.now() - lastAudioHeartbeat > 5000) {
      lastAudioHeartbeat = 0; prefetch.invalidate();
      active?.controller.abort(); await connections.clear(); await realtime.close();
    }
    const row = latency.get(speech.requestId);
    if (row && speech.state === 'playing' && speech.position > 0 && !row.nativePlaybackObserved) {
      await measure({requestId: speech.requestId, profileKey: row.profile}, {nativePlaybackObserved: true,
        nativePlaybackFirstObservedAt: Date.now(), nativePlaybackPositionSeconds: speech.position,
        nativePlaybackStartEstimateAt: Date.now() - speech.position * 1000});
    }
    // A composer hint only opens connections. It contains no text and cannot
    // generate a response, touch persistent dialogue or enable the microphone.
    const hintRaw = await readFile(prewarmPath, 'utf8').catch(() => '');
    if (hintRaw !== prewarmObserved && !active && !mic.current && !micPolling) {
      prewarmObserved = hintRaw;
      let hint; try { hint = parsePrewarm(JSON.parse(hintRaw), ids); } catch {}
      if (!hint) await connections.setComposer(null);
      else if (await audioReady(runtime)) {
        if (mic.current || micPolling || stopped) { prewarmObserved = ''; return; }
        await connections.setComposer(hint);
      }
    }
    // Feed the current speaker before speculating on another local TTS job.
    // Connection maintenance above continues while this utterance streams.
    if (streaming) return;
    const raw = await readFile(prefetchPath, 'utf8').catch(() => '');
    if (raw === prefetchObserved) return;
    prefetchObserved = raw;
    let command;
    try { command = JSON.parse(raw); } catch { prefetch.invalidate(); return; }
    const predicted = validatePrefetch(command, prefetch.source);
    const submitted = parseInput(await readFile(inputPath, 'utf8').catch(() => ''));
    if (!predicted || !submitted || inputIdentity(submitted) !== inputIdentity(prefetch.source.input)
        || !Object.hasOwn(ids, predicted.profileKey) || !profileFor(predicted, roster) || !await audioReady(runtime) || mic.current) {
      prefetch.invalidate(); return;
    }
    prefetch.invalidate();
    // Open the next connection, but don't invent a user turn before its
    // submitted audience and current-save context are known.
    await connections.setRequest(predicted, realtimeConfig(predicted));
  } finally { prefetchPolling = false; }
}

const deliveredReceipts = new Set();
const pendingDeliveryReceipts = new Map();
async function recordDelivery(receipt) {
  if (!receipt || receipt.version !== 1 || typeof receipt.requestId !== 'string') return;
  const entry = knowledgeTurns.get(receipt.requestId);
  if (!entry?.generated || entry.cancelled || receipt.partial !== false || receipt.cancelled !== false) return;
  const input = entry.prepared.input;
  const phoneReceipt = entry.prepared.route?.channel === 'phone';
  if (phoneReceipt ? receipt.source !== 'phone-ui' || receipt.state !== 'accepted'
    : !['native-playback', 'continuous-playback'].includes(receipt.source) || receipt.state !== 'completed'
      || !Number.isSafeInteger(receipt.totalChunks) || receipt.totalChunks < 1 || receipt.totalChunks > 10000
      || receipt.completedChunks !== receipt.totalChunks) return;
  if (receipt.source === 'continuous-playback'
    && (receipt.backend !== 'browser-pcm' || receipt.totalChunks !== 1)) return;
  if (['native-playback', 'continuous-playback'].includes(receipt.source)
      && (receipt.entity !== input.entity || receipt.generation !== input.generation)) return;
  if (receipt.source === 'phone-ui' && receipt.profileKey !== input.profileKey) return;
  const id = JSON.stringify([receipt.source, receipt.requestId, receipt.id || receipt.sequence]);
  if (deliveredReceipts.has(id)) return;
  if (pendingDeliveryReceipts.has(id)) return pendingDeliveryReceipts.get(id);
  const task = (async () => {
    const result = await knowledgeRouter.activity(entry.prepared, 'delivered-reply', receipt);
    if (result?.status === 'unavailable') return;
    entry.delivered = true;
    deliveredReceipts.add(id);
    while (deliveredReceipts.size > 128) deliveredReceipts.delete(deliveredReceipts.values().next().value);
  })();
  pendingDeliveryReceipts.set(id, task);
  try { return await task; }
  finally { if (pendingDeliveryReceipts.get(id) === task) pendingDeliveryReceipts.delete(id); }
}
async function pollKnowledge() {
  if (knowledgePolling || stopped) return;
  knowledgePolling = true;
  try {
    const session = await readWorldSession(resolve(runtime, 'world-session.json'));
    const priorWorld = worldSession?.ready ? JSON.stringify([worldSession.token, worldSession.generation]) : null;
    worldSession = session;
    const nextWorld = worldSession?.ready ? JSON.stringify([worldSession.token, worldSession.generation]) : null;
    if (priorWorld && priorWorld !== nextWorld) {
      memoryQuiescing++;
      try { await resetLiveRoutes(); }
      finally { memoryQuiescing--; }
    }
    const speech = await readSpeechState();
    if (Number.isFinite(speech.updated) && Date.now() - speech.updated < 5000) await recordDelivery(speech.lastDelivery);
    let phoneDelivery;
    try { phoneDelivery = JSON.parse(await readFile(resolve(runtime, 'knowledge-phone-delivery.json'), 'utf8')); } catch {}
    if (phoneDelivery?.version === 1 && Number.isFinite(phoneDelivery.updated) && Date.now() - phoneDelivery.updated < 5000
      && Array.isArray(phoneDelivery.receipts) && phoneDelivery.receipts.length <= 16) {
      for (const receipt of phoneDelivery.receipts) await recordDelivery(receipt);
    }
    await atomic(resolve(runtime, 'knowledge-status.json'), JSON.stringify({version: 1, updated: Date.now(),
      reason: nextWorld ? 'current-world' : 'world-unavailable',
      bound: playerMemory.status().available === true, identifiedMemory: true,
      memoryMode: 'natural-conversations', providerIdLimit: 1,
      rules: knowledgePack.rules.filter(rule => rule.reviewed && /verified$/.test(rule.status)).length,
      worldGeneration: worldSession?.generation, currentWorld: !!nextWorld}));
  } finally { knowledgePolling = false; }
}

// An existing request belongs to an earlier game/mod session; process only new input.
const initial = await stat(inputPath).catch(() => null);
if (initial) {
  const raw = await readFile(inputPath, 'utf8');
  observed = `${initial.mtimeMs}:${initial.size}:${raw}`;
  const input = parseInput(raw); if (input) lastAcceptedIdentity = inputIdentity(input);
}
const controlPath = resolve(stateDirectory, 'bridge-control.json');
let controlsObserved = await readFile(controlPath, 'utf8').catch(() => '');
let settingsPolling = false, lastVoiceHeartbeat = 0;
async function pollSettings(checkShutdown = true) {
  if (settingsPolling || stopped) return;
  settingsPolling = true;
  try {
    // A transient rename/partial settings write must not reset the selected quality.
    const raw = await readFile(resolve(runtime, 'settings.json'), 'utf8').catch(() => '');
    let settings; try { settings = JSON.parse(raw); } catch {}
    localVoice.request(settings);
    const previousProvider = localVoice.provider;
    // Every phrase of an accepted turn keeps its original provider and quality.
    // Microphone startup and input polling also own a boundary before `active`.
    if (localVoice.applyWhenIdle(active || streaming || polling || micPolling || mic.current || prefetchPolling)) {
      prefetch.invalidate(); prefetchObserved = '';
      if (localVoice.provider !== previousProvider) await connections.reconfigure(LOCAL_VOICE_KEYS);
    }
    if (Date.now() - lastVoiceHeartbeat >= 5000) {
      lastVoiceHeartbeat = Date.now(); localVoice.publish(localVoice.state);
    }
    const control = await readFile(controlPath, 'utf8').catch(() => '');
    if (control !== controlsObserved) {
      controlsObserved = control;
      let command; try { command = JSON.parse(control); } catch {}
      if (checkShutdown && command?.action === 'shutdown' && command.pid === process.pid) void shutdown();
    }
  } finally { settingsPolling = false; }
}
const memoryControl = await PlayerMemoryControl.open({memory: playerMemory,
  commandPath: resolve(runtime, 'memory-command.json'),
  publish: value => atomic(resolve(runtime, 'memory-status.json'), JSON.stringify(value))});
await status('waiting');
await pollSettings(false);
await pollKnowledge();
void localVoice.start().catch(error => console.error('[CyberpunkConvai] Local voice startup:', error.message));
console.log('[CyberpunkConvai] Convai conversation bridge ready');
const timer = setInterval(tick, 150);
const micTimer = setInterval(() => { void pollMicrophone().catch(error => console.error('[CyberpunkConvai] Microphone poll:', error.message)); }, 150);
const prefetchTimer = setInterval(() => { void pollPrefetch().catch(error => console.error('[CyberpunkConvai] Preparation poll:', error.message)); }, 150);
const settingsTimer = setInterval(() => { void pollSettings().catch(error => console.error('[CyberpunkConvai] Settings poll:', error.message)); }, 500);
const phoneTimer = setInterval(() => { void pollPhone().catch(error => console.error('[CyberpunkConvai] Phone poll:', error.message)); }, 150);
const knowledgeTimer = setInterval(() => { void pollKnowledge().catch(error => console.error('[CyberpunkConvai] Knowledge poll:', error.message)); }, 500);
const memoryTimer = setInterval(() => { void memoryControl.poll().catch(error => console.error('[CyberpunkConvai] Memory control:', error.message)); }, 500);
async function shutdown() {
  if (stopped) return;
  stopped = true; active?.controller.abort(); prefetch.invalidate();
  phone.close(); clearInterval(phoneTimer);
  phoneKnowledge.clear();
  clearInterval(knowledgeTimer);
  clearInterval(memoryTimer);
  clearInterval(timer); clearInterval(micTimer); clearInterval(prefetchTimer); clearInterval(settingsTimer);
  await invitations.clear('service-stopped');
  await Promise.allSettled([localVoice.close(), mic.cancel(), connections.clear()]);
  await Promise.allSettled([realtime.close(), phoneRealtime.close()]);
  await memoryControl.close(); await playerMemory.close();
  await Promise.allSettled([metricsWriting, connectionMetricsWriting, voiceMetricsWriting]);
  await status('stopped'); process.exit(0);
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, shutdown);
