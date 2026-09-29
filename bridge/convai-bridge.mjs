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
import {groupContext, conversationScope} from './group-context.mjs';
import {GroupPrefetch, inputIdentity, validatePrefetch, parsePrewarm} from './group-prefetch.mjs';
import {throwIfCancelled} from './transport-pool.mjs';
import {PartyConnections} from './party-connections.mjs';
import {ResidentVoice, voiceSteps} from './resident-voice.mjs';
import {PhoneChat, parsePhoneState} from './phone-chat.mjs';
import {GameLaunchIdentity, identifyGameLaunch} from './game-launch.mjs';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const game = process.env.CYBERPUNK_CONVAI_GAME || 'E:\\SteamLibrary\\steamapps\\common\\Cyberpunk 2077';
const runtime = resolve(game, 'bin/x64/plugins/cyber_engine_tweaks/mods/CyberpunkConvai/runtime');
const keyFile = process.env.CYBERPUNK_CONVAI_KEY_FILE || resolve(project, 'runtime/convai-key.txt');
const roster = JSON.parse(await readFile(resolve(project, 'characters/roster.json'), 'utf8'));
const ids = JSON.parse(await readFile(resolve(project, 'runtime/characters.json'), 'utf8'));
const localVoiceConfigPath = resolve(project, 'runtime/local-voices.json');
const voiceConfig = JSON.parse(await readFile(localVoiceConfigPath, 'utf8').catch(error => {
  if (error.code === 'ENOENT') return '{}';
  throw error;
}));
let voiceMetricsWriting = Promise.resolve();
const localVoice = new ResidentVoice(voiceConfig, {project, configPath: localVoiceConfigPath,
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

const phoneInput = resolve(runtime, 'phone-chat-input.json');
const phoneOutput = resolve(runtime, 'phone-chat-output.json');
const phoneSessionPath = resolve(project, 'runtime/phone-sessions.json');
let phoneSessions = {};
try { phoneSessions = JSON.parse(await readFile(phoneSessionPath, 'utf8')) || {}; } catch {}
const phone = new PhoneChat({
  contacts: JSON.parse(await readFile(resolve(project, 'characters/phone-contacts.json'), 'utf8')), ids,
  reply: options => requestReply({key, ...options}),
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

const sessionKey = input => input.profileKey + ':' + conversationScope(input);
const completeContext = input => JSON.stringify([groupContext(input), ids[input.profileKey], realtimeSessions.get(sessionKey(input)) || null,
  localVoice.usesProfile(input.profileKey) ? localVoice.steps : 'convai']);
const realtimeConfig = input => ({key, characterId: ids[input.profileKey], sessionId: realtimeSessions.get(sessionKey(input)),
  scope: conversationScope(input), context: groupContext(input), text: input.text, ttsEnabled: !localVoice.usesProfile(input.profileKey)});
const connections = new PartyConnections({host: realtime, isKnown: profile => Object.hasOwn(ids, profile),
  configFor: (profile, scope) => ({key, characterId: ids[profile], scope, sessionId: realtimeSessions.get(profile + ':' + scope), ttsEnabled: !localVoice.usesProfile(profile)}),
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
  if (realtimeSessions.has(sessionKey(input))) throw Error('Existing character session is warm-only');
  return synthesizeReply(input, {...await realtime.prepare(realtimeConfig(input), {signal}), transport: 'realtime'}, signal);
}});

async function synthesizeReply(input, result, signal) {
  if (!localVoice.usesProfile(input.profileKey)) return result;
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

async function respond(input, profile, {signal, prepared} = {}) {
  const scopedSession = sessionKey(input);
  const context = groupContext(input);
  if (await audioReady(runtime)) {
    if (prepared) {
      try { return await prepared; }
      catch { throwIfCancelled(signal); /* Failed speculation falls back to the submitted turn. */ }
    }
    throwIfCancelled(signal);
    return synthesizeReply(input, {...await realtime.reply(realtimeConfig(input), {signal}), transport: 'realtime'}, signal);
  }
  prefetch.invalidate(); prepared?.cancel();
  throwIfCancelled(signal);
  return requestReply({key, characterId: ids[profile.key], text: context ? context + '\nV says: ' + input.text : input.text,
    sessionId: sessions.get(scopedSession) || '-1', voice: false});
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
let micObserved = await readFile(micPath, 'utf8').catch(() => '');
let micPolling = false;
const mic = new MicrophoneSession({hostFactory: () => realtime.voiceChannel(),
  onState: (state, input) => atomic(resolve(runtime, 'microphone-state.json'), JSON.stringify({state, requestId: input.requestId, updated: Date.now()})),
  onReply: async (input, result, signal) => {
    if (stopped) return;
    const command = JSON.parse(await readFile(micPath, 'utf8'));
    if (command.input?.requestId !== input.requestId || command.action === 'cancel') return;
    const spoken = await synthesizeReply(input, {...result, transport: 'realtime'}, signal);
    await publishResult(input, profileFor(input, roster), spoken, async () => {
      if (stopped || signal?.aborted) return false;
      const latest = JSON.parse(await readFile(micPath, 'utf8').catch(() => '{}'));
      return latest.input?.requestId === input.requestId && latest.action !== 'cancel';
    }, signal);
  },
  onError: async (input, error) => {
    console.error('[CyberpunkConvai] Microphone:', error.message);
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
      if (command.action === 'cancel') await mic.cancel();
      else if (command.action === 'finish') void mic.finish(input.requestId).catch(error => console.error(error.message));
      else {
        const profile = profileFor(input, roster);
        if (!profile || !ids[profile.key] || !await audioReady(runtime)) {
          await mic.onError(input, Error('Voice service or character is unavailable')); return;
        }
        // A new microphone turn supersedes a pending text reply.
        active?.controller.abort(); prefetch.invalidate();
        await connections.setRequest({...input, group: undefined});
        void mic.start(input, {key, characterId: ids[profile.key], scope: 'private', sessionId: realtimeSessions.get(input.profileKey + ':private'), ttsEnabled: !localVoice.usesProfile(input.profileKey)}).catch(error => console.error(error.message));
      }
    }
    void mic.tick(await audioReady(runtime)).catch(error => console.error(error.message));
  } finally { micPolling = false; }
}

async function tick() {
  if (polling || stopped) return;
  polling = true;
  try {
    const stamp = await stat(inputPath).catch(() => null);
    if (!stamp) return;
    const raw = await readFile(inputPath, 'utf8');
    const signature = `${stamp.mtimeMs}:${stamp.size}:${raw}`;
    if (signature === observed) return;
    observed = signature;
    const input = parseInput(raw);
    if (!input) {
      prefetch.invalidate();
      // Lua replaces this small file in place. A transient partial write is
      // not a new target and must not cancel an otherwise valid active turn.
      if (!active) await status('invalid-input', 'Could not parse the game request');
      return;
    }
    const identity = inputIdentity(input);
    if (identity === lastAcceptedIdentity) return;
    lastAcceptedIdentity = identity;
    active?.controller.abort();
    const controller = new AbortController();
    const prepared = prefetch.claim(input, completeContext(input), {signal: controller.signal});
    prepared?.catch(() => {});
    const request = active = {input, controller, receivedAt: Date.now()};
    void processInput(request, prepared);
  } catch (error) { console.error('[CyberpunkConvai] Input poll:', error.message); }
  finally { polling = false; }
}

async function processInput(request, prepared) {
  const {input, controller} = request;
  const current = async () => {
    if (controller.signal.aborted || active !== request || stopped) return false;
    const submitted = parseInput(await readFile(inputPath, 'utf8').catch(() => ''));
    return !!submitted && inputIdentity(submitted) === inputIdentity(input);
  };
  try {
    await mic.cancel();
    throwIfCancelled(controller.signal);
    const profile = profileFor(input, roster);
    if (!profile || !ids[profile.key]) {
      await status('unmatched-npc', `No verified profile for ${input.name} (${input.bodyType})`);
      await atomic(replyPath, JSON.stringify({...input, text: undefined,
        error: `${input.name} does not have a conversation profile configured yet.`}));
      return;
    }
    await measure(input, {receivedAt: request.receivedAt, preparation: {mode: prepared ? 'claimed' : 'none'}});
    await status('thinking', profile.name);
    const canWarm = await audioReady(runtime);
    throwIfCancelled(controller.signal);
    if (canWarm) await connections.setRequest(input);
    throwIfCancelled(controller.signal);
    const result = await respond(input, profile, {signal: controller.signal, prepared});
    // Do not show a late reply to a different target or a newer turn.
    if (!await current()) return;
    await measure(input, {resultReadyAt: Date.now(), requestToResultMs: Date.now() - request.receivedAt});
    await publishResult(input, profile, result, current, controller.signal);
  } catch (error) {
    if (!await current()) return;
    await status('error', error.message).catch(() => {});
    if (input) await atomic(replyPath, JSON.stringify({requestId: input.requestId,
      generation: input.generation, entity: input.entity,
      error: 'The conversation service could not reply. Please try again.'})).catch(() => {});
    console.error('[CyberpunkConvai] Bridge request failed:', error.message);
  } finally { if (active === request) active = null; }
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
    if (realtimeSessions.has(sessionKey(predicted))) {
      prefetch.invalidate();
      // Warming sends no user message and is safe for a committed session.
      await connections.setRequest(predicted);
    } else prefetch.offer(command, completeContext(predicted));
  } finally { prefetchPolling = false; }
}

// An existing request belongs to an earlier game/mod session; process only new input.
const initial = await stat(inputPath).catch(() => null);
if (initial) {
  const raw = await readFile(inputPath, 'utf8');
  observed = `${initial.mtimeMs}:${initial.size}:${raw}`;
  const input = parseInput(raw); if (input) lastAcceptedIdentity = inputIdentity(input);
}
const controlPath = resolve(project, 'runtime/bridge-control.json');
let controlsObserved = await readFile(controlPath, 'utf8').catch(() => '');
let settingsPolling = false, lastVoiceHeartbeat = 0;
async function pollSettings(checkShutdown = true) {
  if (settingsPolling || stopped) return;
  settingsPolling = true;
  try {
    // A transient rename/partial settings write must not reset the selected quality.
    const raw = await readFile(resolve(runtime, 'settings.json'), 'utf8').catch(() => '');
    let settings; try { settings = JSON.parse(raw); } catch {}
    if (settings && [16, 32].includes(settings.omniSteps) && localVoice.setSteps(voiceSteps(settings.omniSteps))) {
      prefetch.invalidate(); prefetchObserved = '';
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
void localVoice.start().catch(error => console.error('[CyberpunkConvai] Local voice startup:', error.message));
console.log('[CyberpunkConvai] Convai conversation bridge ready');
const timer = setInterval(tick, 150);
const micTimer = setInterval(() => { void pollMicrophone().catch(error => console.error('[CyberpunkConvai] Microphone poll:', error.message)); }, 150);
const prefetchTimer = setInterval(() => { void pollPrefetch().catch(error => console.error('[CyberpunkConvai] Preparation poll:', error.message)); }, 150);
const settingsTimer = setInterval(() => { void pollSettings().catch(error => console.error('[CyberpunkConvai] Settings poll:', error.message)); }, 500);
const phoneTimer = setInterval(() => { void pollPhone().catch(error => console.error('[CyberpunkConvai] Phone poll:', error.message)); }, 150);
async function shutdown() {
  if (stopped) return;
  stopped = true; active?.controller.abort(); prefetch.invalidate();
  phone.close(); clearInterval(phoneTimer);
  clearInterval(timer); clearInterval(micTimer); clearInterval(prefetchTimer); clearInterval(settingsTimer);
  await Promise.allSettled([localVoice.close(), mic.cancel(), connections.clear()]);
  await realtime.close();
  await Promise.allSettled([metricsWriting, connectionMetricsWriting, voiceMetricsWriting]);
  await status('stopped'); process.exit(0);
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, shutdown);
