import {readFile, writeFile, rename, stat, mkdir} from 'node:fs/promises';
import {resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseInput, profileFor} from './protocol.mjs';
import {requestReply} from './convai-client.mjs';
import {audioReady, storeSpeech, SLOT_COUNT} from './speech-audio.mjs';
import {RealtimeHost} from './realtime-host.mjs';
import {MicrophoneSession} from './microphone-session.mjs';
import {randomUUID} from 'node:crypto';
import {groupContext, conversationScope} from './group-context.mjs';
import {GroupPrefetch, inputIdentity, validatePrefetch, parsePrewarm} from './group-prefetch.mjs';
import {throwIfCancelled} from './transport-pool.mjs';
import {PartyConnections} from './party-connections.mjs';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const game = process.env.CYBERPUNK_CONVAI_GAME || 'E:\\SteamLibrary\\steamapps\\common\\Cyberpunk 2077';
const runtime = resolve(game, 'bin/x64/plugins/cyber_engine_tweaks/mods/CyberpunkConvai/runtime');
const keyFile = process.env.CYBERPUNK_CONVAI_KEY_FILE || resolve(project, 'runtime/convai-key.txt');
const roster = JSON.parse(await readFile(resolve(project, 'characters/roster.json'), 'utf8'));
const ids = JSON.parse(await readFile(resolve(project, 'runtime/characters.json'), 'utf8'));
const keyLine = (await readFile(keyFile, 'utf8')).trim();
const key = /^api-key\s*=\s*(\S+)\s*$/i.exec(keyLine)?.[1];
if (!key) throw Error('Local Convai key file must contain api-key=...');
await mkdir(runtime, {recursive: true});

const inputPath = resolve(runtime, 'last-input.json');
const replyPath = resolve(runtime, 'reply.json');
const statusPath = resolve(runtime, 'bridge-status.json');
const prefetchPath = resolve(runtime, 'group-prefetch.json');
const prewarmPath = resolve(runtime, 'conversation-prewarm.json');
const partyPath = resolve(runtime, 'party-connections.json');
const sessions = new Map();
const realtimeSessions = new Map();
const audioDepot = resolve(game, 'r6/audioware/CyberpunkConvai');
let nextSlot = 0;
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
const completeContext = input => JSON.stringify([groupContext(input), ids[input.profileKey], realtimeSessions.get(sessionKey(input)) || null]);
const realtimeConfig = input => ({key, characterId: ids[input.profileKey], sessionId: realtimeSessions.get(sessionKey(input)),
  scope: conversationScope(input), context: groupContext(input), text: input.text});
const connections = new PartyConnections({host: realtime, isKnown: profile => Object.hasOwn(ids, profile),
  configFor: (profile, scope) => ({key, characterId: ids[profile], scope, sessionId: realtimeSessions.get(profile + ':' + scope)}),
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
  return {...await realtime.prepare(realtimeConfig(input), {signal}), transport: 'realtime'};
}});

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
    return {...await realtime.reply(realtimeConfig(input), {signal}), transport: 'realtime'};
  }
  prefetch.invalidate(); prepared?.cancel();
  throwIfCancelled(signal);
  return requestReply({key, characterId: ids[profile.key], text: context ? context + '\nV says: ' + input.text : input.text,
    sessionId: sessions.get(scopedSession) || '-1', voice: false});
}

async function publishResult(input, profile, result, current = async () => true) {
  if (!await current()) return false;
  const preparationStartedAt = Date.now();
  let audio, audioError;
  if (result.audio) {
    try {
      const playing = JSON.parse(await readFile(resolve(runtime, 'speech-state.json'), 'utf8').catch(() => '{}'));
      if (nextSlot === playing.slot) nextSlot = (nextSlot + 1) % SLOT_COUNT;
      const slot = nextSlot; nextSlot = (nextSlot + 1) % SLOT_COUNT;
      audio = await storeSpeech(result.audio, audioDepot, slot);
      if (!await current()) return false;
      await atomic(resolve(runtime, 'last-speech-timing.json'), JSON.stringify({
        requestId: input.requestId, faces: result.faces, captions: result.captions, duration: audio.duration,
      }));
    } catch (error) {
      audioError = 'Voice could not be prepared; showing the written reply.';
      console.error('[CyberpunkConvai] Voice preparation failed:', error.message);
    }
  }
  if (!await current()) return false;
  await atomic(replyPath, JSON.stringify({requestId: input.requestId, generation: input.generation,
    entity: input.entity, profile: profile.key, text: result.text, audio, audioError, updated: Date.now()}));
  (result.transport === 'realtime' ? realtimeSessions : sessions).set(sessionKey(input), result.sessionID);
  if (result.transport === 'realtime') connections.used(input, result.timing);
  prefetch.published(input, result.text);
  // Reconsider the prediction file after a source reply becomes valid.
  prefetchObserved = '';
  await measure(input, {transport: result.transport || 'rest', timing: result.timing, preparation: result.preparation,
    audioStoreMs: Date.now() - preparationStartedAt, publishedAt: Date.now(), audioDurationSeconds: audio?.duration,
    nativePlaybackObserved: false});
  await status('ready', profile.name);
  return true;
}

const micPath = resolve(runtime, 'microphone-command.json');
let micObserved = await readFile(micPath, 'utf8').catch(() => '');
let micPolling = false;
const mic = new MicrophoneSession({hostFactory: () => realtime.voiceChannel(),
  onState: (state, input) => atomic(resolve(runtime, 'microphone-state.json'), JSON.stringify({state, requestId: input.requestId, updated: Date.now()})),
  onReply: async (input, result) => {
    const command = JSON.parse(await readFile(micPath, 'utf8'));
    if (command.input?.requestId !== input.requestId || command.action === 'cancel') return;
    await publishResult(input, profileFor(input, roster), {...result, transport: 'realtime'}, async () => {
      const latest = JSON.parse(await readFile(micPath, 'utf8').catch(() => '{}'));
      return latest.input?.requestId === input.requestId && latest.action !== 'cancel';
    });
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
        void mic.start(input, {key, characterId: ids[profile.key], scope: 'private', sessionId: realtimeSessions.get(input.profileKey + ':private')}).catch(error => console.error(error.message));
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
    await publishResult(input, profile, result, current);
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
await status('waiting');
console.log('[CyberpunkConvai] Convai conversation bridge ready');
const timer = setInterval(tick, 150);
const micTimer = setInterval(() => { void pollMicrophone().catch(error => console.error('[CyberpunkConvai] Microphone poll:', error.message)); }, 150);
const prefetchTimer = setInterval(() => { void pollPrefetch().catch(error => console.error('[CyberpunkConvai] Preparation poll:', error.message)); }, 150);
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => {
  stopped = true; active?.controller.abort(); prefetch.invalidate();
  clearInterval(timer); clearInterval(micTimer); clearInterval(prefetchTimer);
  await mic.cancel(); await connections.clear(); await realtime.close();
  await Promise.allSettled([metricsWriting, connectionMetricsWriting]); process.exit(0);
});
