import {readFile, writeFile, rename, stat, mkdir} from 'node:fs/promises';
import {resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseInput, profileFor} from './protocol.mjs';
import {requestReply} from './convai-client.mjs';
import {audioReady} from './speech-audio.mjs';
import {buildFacialTimeline} from './facial-timeline.mjs';
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
import {PartyConnections} from './party-connections.mjs';
import {LOCAL_VOICE_KEYS} from './resident-voice.mjs';
import {VoiceSelection} from './voice-selection.mjs';
import {PhoneChat, parsePhoneState} from './phone-chat.mjs';
import {GameLaunchIdentity, identifyGameLaunch} from './game-launch.mjs';
import {KnowledgeService} from './knowledge-service.mjs';
import {KnowledgeRouter} from './conversation-knowledge.mjs';
import {ConvaiAudioStream} from './convai-audio-stream.mjs';
import {PhoneKnowledge} from './phone-knowledge.mjs';
import {KnowledgeCloud} from './knowledge-cloud.mjs';

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
const knowledgePolicy = JSON.parse(await readFile(resolve(stateDirectory, 'knowledge-policy.json'), 'utf8').catch(() => '{}'));
// Live conversations stay anonymous. A bounded, shared provider ID may only
// archive explicit REST memories after save restoration and the API qualify.
// Loading a save or changing a party must never allocate a provider identity.
const restArchiveEnabled = knowledgePolicy.version === 1 && knowledgePolicy.nativeQualified === true
  && knowledgePolicy.providerQualified === true && knowledgePolicy.remoteSlotsQualified === true
  && knowledgePolicy.mode === 'explicit-rest-anonymous-live-v1'
  && knowledgePolicy.enabled === true;
const knowledge = await KnowledgeService.open({runtimeDir: runtime,
  ledgerPath: resolve(stateDirectory, 'quest-memory.json'), pack: knowledgePack,
  cloudQualified: restArchiveEnabled, restMemoryEnabled: restArchiveEnabled,
  factIdentityEnabled: knowledgePolicy.nativeQualified === true && knowledgePolicy.nativeStorage === 'quest-facts-v1'});
let worldSession = null, knowledgePolling = false, memoryBinding = '';
const worldCurrent = boundary => {
  const current = knowledge.saveIdentity;
  if (current.status === 'verified') return current.worldGeneration === boundary.generation && current.worldToken === boundary.worldToken;
  return worldSession?.ready === true && Date.now() - worldSession.updated < 5000
    && worldSession.token === boundary.worldToken && worldSession.generation === boundary.generation;
};
const knowledgeRouter = new KnowledgeRouter({service: knowledge, questCatalog,
  identifiedEnabled: false, isWorldCurrent: worldCurrent});
const phoneKnowledge = new PhoneKnowledge({router: knowledgeRouter, service: knowledge,
  getBoundary: () => worldSession?.ready && Date.now() - worldSession.updated < 5000
    ? {worldToken: worldSession.token, generation: worldSession.generation} : null});
const knowledgeCloud = new KnowledgeCloud({coordinator: knowledge, key, ids, policy: knowledgePolicy,
  qualificationPath: resolve(stateDirectory, 'memory-qualification/receipt.json')});
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
  if (entry) entry.cancelled = true;
  await knowledgeRouter.activity(prepared, 'cancelled-turn').catch(() => {});
}
async function cancelMicrophone() {
  const current = mic.current;
  if (current) await cancelKnowledgeTurn(microphoneKnowledge.get(current.requestId));
  await mic.cancel();
  microphoneKnowledge.clear();
}

const phoneInput = resolve(runtime, 'phone-chat-input.json');
const phoneOutput = resolve(runtime, 'phone-chat-output.json');
const phoneSessionPath = resolve(stateDirectory, 'phone-sessions.json');
let phoneSessions = {};
try { phoneSessions = JSON.parse(await readFile(phoneSessionPath, 'utf8')) || {}; } catch {}
const phone = new PhoneChat({
  contacts: JSON.parse(await readFile(resolve(project, 'characters/phone-contacts.json'), 'utf8')), ids,
  contextFor: options => phoneKnowledge.prepareContext(options),
  reply: async options => {
    const prepared = await phoneKnowledge.preparedFor(options);
    if (!await knowledgeRouter.current(prepared)) throw Error('Phone world changed');
    const remote = prepared.remoteConfig || {};
    if ((options.endUserId || null) !== (remote.endUserId || null)) throw Error('Phone memory binding changed');
    await knowledgeRouter.submitted(prepared);
    throwIfCancelled(options.signal);
    if (!await knowledgeRouter.current(prepared)) throw Error('Phone world changed');
    rememberKnowledgeTurn(prepared);
    const result = await phoneRealtime.reply({key, characterId: options.characterId, sessionId: options.sessionId,
      scope: prepared.scope || 'phone', ...remote, context: conversationContext(prepared.input),
      text: options.input.text, ttsEnabled: false}, {signal: options.signal});
    if (!await knowledgeRouter.current(prepared)) throw Error('Phone world changed');
    await knowledgeRouter.activity(prepared, 'generated-reply', {replyText: result.text});
    stagedKnowledgeTurn(prepared);
    return result;
  },
  publish: value => atomic(phoneOutput, JSON.stringify(value)),
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
    if (await current()) await atomic(resolve(runtime, 'speech-stream.json'), JSON.stringify(document));
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
const warmRoute = (profile, scope) => knowledgeRouter.configFor(profile, scope,
  {worldToken: worldSession?.token, generation: worldSession?.generation});
const connections = new PartyConnections({host: realtime,
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

async function atomic(path, data) {
  const temp = path + '.' + randomUUID() + '.tmp';
  await writeFile(temp, data);
  for (let attempt = 0; ; attempt++) {
    try { await rename(temp, path); return; }
    catch (error) {
      if (attempt >= 4 || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) throw error;
      await new Promise(done => setTimeout(done, 20));
    }
  }
}

async function status(state, detail = '') {
  await atomic(statusPath, JSON.stringify({state, detail: detail.slice(0, 200), updated: Date.now()}));
}

const livePublished = new WeakSet();
async function streamConvaiReply(input, profile, current, signal) {
  const stream = new ConvaiAudioStream({input, streamId: randomUUID(), slots, readState: readSpeechState,
    writeManifest: document => writeStreamManifest(document, current), current, signal, buildFace: buildFacialTimeline});
  streaming++;
  try {
    const result = await realtime.reply(realtimeConfig(input), {signal, onAudioChunk: async chunk => {
      const chunkReceivedAt = Date.now();
      const row = await stream.append(chunk);
      if (chunk.index !== 1) return;
      if (!await current()) throw Error('Conversation changed before playback');
      await atomic(replyPath, JSON.stringify({requestId: input.requestId, generation: input.generation,
        entity: input.entity, profile: profile.key, text: chunk.text, audio: row.audio, face: row.face,
        stream: stream.descriptor(), updated: Date.now()}));
      livePublished.add(input);
      await measure(input, {transport: 'realtime', publishedAt: Date.now(),
        firstChunkReceivedAt: chunkReceivedAt, firstChunkNativePreparationMs: Date.now() - chunkReceivedAt,
        firstChunkTiming: chunk.timing,
        firstStreamChunkDuration: row.audio.duration, stream: {id: stream.manifest.streamId, mode: 'convai-live'}, nativePlaybackObserved: false});
      await status('ready', profile.name);
    }});
    if (result.streamed) await stream.finish(result);
    return {...result, transport: 'realtime', alreadyPublished: livePublished.has(input)};
  } catch (error) {
    await stream.fail(error).catch(() => {});
    throw error;
  } finally { streaming--; prefetchObserved = ''; }
}

async function respond(input, profile, {signal, prepared, current} = {}) {
  const scopedSession = sessionKey(input);
  const context = conversationContext(input);
  if (await audioReady(runtime)) {
    if (prepared) {
      try { return await prepared; }
      catch { throwIfCancelled(signal); /* Failed speculation falls back to the submitted turn. */ }
    }
    throwIfCancelled(signal);
    if (!localVoice.usesProfile(input.profileKey) && current) return streamConvaiReply(input, profile, current, signal);
    return synthesizeReply(input, {...await realtime.reply(realtimeConfig(input), {signal}), transport: 'realtime'}, signal);
  }
  prefetch.invalidate(); prepared?.cancel();
  throwIfCancelled(signal);
  return requestReply({key, characterId: ids[profile.key], text: context ? context
      + (input.reaction ? '\nAutomatic game event: ' : '\nV says: ') + battleTrigger(input) : battleTrigger(input),
    sessionId: sessions.get(scopedSession) || '-1', voice: false, signal});
}

async function publishResult(input, profile, result, current = async () => true, signal) {
  if (!await current()) return false;
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
      }));
    } catch (error) {
      audio = undefined; face = undefined; stream = undefined;
      audioError = 'Voice could not be prepared; showing the written reply.';
      console.error('[CyberpunkConvai] Voice preparation failed:', error.message);
    }
  }
  if (!await current()) return false;
  await atomic(replyPath, JSON.stringify({requestId: input.requestId, generation: input.generation,
    entity: input.entity, profile: profile.key, text: result.text, audio, face, audioError,
    stream: stream?.descriptor(), updated: Date.now()}));
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
let micObserved = await readFile(micPath, 'utf8').catch(() => '');
let micPolling = false;
const mic = new MicrophoneSession({hostFactory: () => realtime.voiceChannel(),
  onState: (state, input) => atomic(resolve(runtime, 'microphone-state.json'), JSON.stringify({state, requestId: input.requestId, updated: Date.now()})),
  onReply: async (input, result, signal) => {
    if (stopped) return;
    const prepared = microphoneKnowledge.get(input.requestId);
    if (!prepared || !await knowledgeRouter.current(prepared)) return;
    const command = JSON.parse(await readFile(micPath, 'utf8'));
    if (command.input?.requestId !== input.requestId || command.action === 'cancel') return;
    const spoken = await synthesizeReply(input, {...result, transport: 'realtime'}, signal);
    await knowledgeRouter.activity(prepared, 'generated-reply', {replyText: result.text});
    stagedKnowledgeTurn(prepared);
    await publishResult(input, profileFor(input, roster), spoken, async () => {
      if (stopped || signal?.aborted) return false;
      const latest = JSON.parse(await readFile(micPath, 'utf8').catch(() => '{}'));
      return latest.input?.requestId === input.requestId && latest.action !== 'cancel' && await knowledgeRouter.current(prepared);
    }, signal);
  },
  onError: async (input, error) => {
    console.error('[CyberpunkConvai] Microphone:', error.message);
    const prepared = microphoneKnowledge.get(input.requestId);
    if (prepared && !await knowledgeRouter.current(prepared)) return;
    await atomic(resolve(runtime, 'microphone-state.json'), JSON.stringify({state: 'error', requestId: input.requestId, updated: Date.now()}));
    await atomic(replyPath, JSON.stringify({requestId: input.requestId, generation: input.generation,
      entity: input.entity, error: 'Voice conversation failed. Check your microphone and try again.'}));
  },
});

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
        await knowledgeRouter.submitted(prepared);
        preparedInputs.set(prepared.input, prepared); microphoneKnowledge.clear();
        microphoneKnowledge.set(input.requestId, prepared); rememberKnowledgeTurn(prepared);
        await connections.setRequest(prepared.input);
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
  try {
    await cancelMicrophone();
    stages.cancelMicrophoneMs = performance.now() - preparationStarted;
    throwIfCancelled(controller.signal);
    const profile = profileFor(input, roster);
    if (!profile || !ids[profile.key]) {
      await status('unmatched-npc', `No verified profile for ${input.name} (${input.bodyType})`);
      await atomic(replyPath, JSON.stringify({...input, text: undefined,
        error: `${input.name} does not have a conversation profile configured yet.`}));
      return;
    }
    knowledgeTurn = await knowledgeRouter.prepare(input, {worldToken: worldSession?.token, generation: worldSession?.generation});
    stages.knowledgePreparedMs = performance.now() - preparationStarted;
    input = knowledgeTurn.input; request.input = input; preparedInputs.set(input, knowledgeTurn);
    if (!await current()) return;
    // No speculative user turn may enter identified character memory.
    if (knowledgeTurn.remoteConfig?.endUserId) { prepared?.cancel(); prepared = undefined; }
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
    if (canWarm) await connections.setRequest(input);
    throwIfCancelled(controller.signal);
    await measure(input, {transportRequestedAt: Date.now(),
      submissionStages: {...stages, beforeTransportMs: performance.now() - preparationStarted}});
    const result = await respond(input, profile, {signal: controller.signal, prepared, current});
    // Do not show a late reply to a different target or a newer turn.
    if (!await current()) return;
    await knowledgeRouter.activity(knowledgeTurn, 'generated-reply', {replyText: result.text});
    stagedKnowledgeTurn(knowledgeTurn);
    await measure(input, {resultReadyAt: Date.now(), requestToResultMs: Date.now() - request.receivedAt});
    if (result.alreadyPublished) {
      realtimeSessions.set(sessionKey(input), result.sessionID);
      connections.used(input, result.timing); prefetch.published(input, result.text);
      await measure(input, {timing: result.timing, stream: result.stream, fullReplyReadyAt: Date.now()});
    } else await publishResult(input, profile, result, current, controller.signal);
  } catch (error) {
    if (!await current()) return;
    if (livePublished.has(input)) {
      await measure(input, {streamInterrupted: true});
      return; // The native stream owns partial-playback/error presentation.
    }
    await status('error', error.message).catch(() => {});
    if (input) await atomic(replyPath, JSON.stringify({requestId: input.requestId,
      generation: input.generation, entity: input.entity,
      error: 'The conversation service could not reply. Please try again.'})).catch(() => {});
    console.error('[CyberpunkConvai] Bridge request failed:', error.message);
  } finally {
    if (knowledgeTurn && (controller.signal.aborted || !await current())) await cancelKnowledgeTurn(knowledgeTurn);
    if (active === request) active = null;
  }
}

let lastAudioHeartbeat = 0;
async function pollPrefetch() {
  if (prefetchPolling || stopped) return;
  prefetchPolling = true;
  try {
    prefetch.prune();
    const partyRaw = await readFile(partyPath, 'utf8').catch(() => '');
    if (partyRaw && partyRaw !== partyObserved) {
      let snapshot; try { snapshot = JSON.parse(partyRaw); } catch {}
      const change = connections.ingest(snapshot);
      if (change) {
        partyObserved = partyRaw;
        if (change.removed.includes(active?.input.profileKey)) active.controller.abort();
        if (change.removed.length) prefetch.invalidate();
      }
    }
    await connections.maintain();
    if (partyWasFresh && connections.stale) {
      prefetch.invalidate(); active?.controller.abort(); await mic.cancel(); await realtime.close();
    }
    partyWasFresh = !connections.stale;
    const speech = JSON.parse(await readFile(resolve(runtime, 'speech-state.json'), 'utf8').catch(() => '{}'));
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
    await connections.setRequest(predicted);
  } finally { prefetchPolling = false; }
}

const deliveredReceipts = new Set();
let cloudPolling = false;
async function pollCloud() {
  if (cloudPolling || stopped || !restArchiveEnabled || active || streaming || mic.current || micPolling || polling || phone.active) return;
  cloudPolling = true;
  try {
    const result = await knowledgeCloud.pump();
    // Do not reconnect speech with an archive ID for automatic recall. Only
    // locally verified current-save records are supplied in dynamic context.
    await atomic(resolve(runtime, 'knowledge-cloud-status.json'), JSON.stringify({version: 1, updated: Date.now(),
      status: result.status, processed: result.processed || 0, acknowledged: result.acknowledged || 0,
      reasons: result.reasons || [], archiveOnly: true, providerIdLimit: 3}));
  } finally { cloudPolling = false; }
}
async function recordDelivery(receipt) {
  if (!receipt || typeof receipt.requestId !== 'string') return;
  const entry = knowledgeTurns.get(receipt.requestId);
  if (!entry?.generated) return;
  const input = entry.prepared.input;
  if (receipt.source === 'native-playback' && (receipt.entity !== input.entity || receipt.generation !== input.generation)) return;
  if (receipt.source === 'phone-ui' && receipt.profileKey !== input.profileKey) return;
  const id = JSON.stringify([receipt.source, receipt.requestId, receipt.id || receipt.sequence]);
  if (deliveredReceipts.has(id)) return;
  const result = await knowledgeRouter.activity(entry.prepared, 'delivered-reply', receipt);
  if (result?.status === 'unavailable') return;
  entry.delivered = true;
  deliveredReceipts.add(id);
  while (deliveredReceipts.size > 128) deliveredReceipts.delete(deliveredReceipts.values().next().value);
}
async function pollKnowledge() {
  if (knowledgePolling || stopped) return;
  knowledgePolling = true;
  try {
    let session;
    try { session = JSON.parse(await readFile(resolve(runtime, 'world-session.json'), 'utf8')); } catch {}
    const valid = session?.version === 1 && typeof session.token === 'string' && session.token.length <= 200
      && Number.isSafeInteger(session.generation) && session.generation > 0 && typeof session.ready === 'boolean'
      && Number.isFinite(session.updated) && session.updated <= Date.now() + 1000 && Date.now() - session.updated < 5000;
    const priorWorld = worldSession?.ready ? worldSession.token : null;
    worldSession = valid ? session : null;
    const nextWorld = worldSession?.ready ? worldSession.token : null;
    await knowledge.refresh();
    const owner = knowledge.saveIdentity;
    // A short autosave/read interval cannot adopt a new identity. The original
    // turn guards remain mandatory; native/world changes invalidate all routes.
    const nextBinding = owner.status === 'verified'
      ? JSON.stringify([owner.userId, owner.campaignId, owner.branchId, owner.activationId, owner.generation]) : memoryBinding;
    if ((priorWorld && priorWorld !== nextWorld) || (memoryBinding && nextBinding !== memoryBinding)) {
      knowledgeCloud.cancel();
      phoneKnowledge.clear();
      active?.controller.abort(); prefetch.invalidate(); phone.close();
      await Promise.allSettled([mic.cancel(), connections.clear(), realtime.close(), phoneRealtime.close()]);
      sessions.clear(); realtimeSessions.clear(); knowledgeTurns.clear();
      partyObserved = ''; prewarmObserved = ''; prefetchObserved = '';
    }
    memoryBinding = nextBinding;
    const speech = await readSpeechState();
    if (Number.isFinite(speech.updated) && Date.now() - speech.updated < 5000) await recordDelivery(speech.lastDelivery);
    let phoneDelivery;
    try { phoneDelivery = JSON.parse(await readFile(resolve(runtime, 'knowledge-phone-delivery.json'), 'utf8')); } catch {}
    if (phoneDelivery?.version === 1 && Number.isFinite(phoneDelivery.updated) && Date.now() - phoneDelivery.updated < 5000
      && Array.isArray(phoneDelivery.receipts) && phoneDelivery.receipts.length <= 16) {
      for (const receipt of phoneDelivery.receipts) await recordDelivery(receipt);
    }
    await atomic(resolve(runtime, 'knowledge-status.json'), JSON.stringify({version: 1, updated: Date.now(),
      reason: knowledge.status().reason, bound: owner.status === 'verified', identifiedMemory: false,
      restArchiveEnabled, providerIdLimit: 3, restPool: knowledge.restPoolStatus(),
      rules: knowledgePack.rules.filter(rule => rule.reviewed && /verified$/.test(rule.status)).length,
      nativeGeneration: owner.generation, currentWorld: !!nextWorld}));
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
const cloudTimer = setInterval(() => { void pollCloud().catch(error => console.error('[CyberpunkConvai] Memory sync:', error.message)); }, 5000);
async function shutdown() {
  if (stopped) return;
  stopped = true; active?.controller.abort(); prefetch.invalidate();
  phone.close(); clearInterval(phoneTimer);
  phoneKnowledge.clear();
  clearInterval(knowledgeTimer);
  clearInterval(cloudTimer);
  clearInterval(timer); clearInterval(micTimer); clearInterval(prefetchTimer); clearInterval(settingsTimer);
  await Promise.allSettled([localVoice.close(), mic.cancel(), connections.clear()]);
  await Promise.allSettled([realtime.close(), phoneRealtime.close()]);
  await knowledgeCloud.close(); await knowledge.close();
  await Promise.allSettled([metricsWriting, connectionMetricsWriting, voiceMetricsWriting]);
  await status('stopped'); process.exit(0);
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, shutdown);
