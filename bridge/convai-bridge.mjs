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
const sessions = new Map();
const realtimeSessions = new Map();
const audioDepot = resolve(game, 'r6/audioware/CyberpunkConvai');
let nextSlot = 0;
const realtime = new RealtimeHost();
let observed = '';
let busy = false;

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

async function respond(input, profile) {
  const scope = conversationScope(input), sessionKey = input.profileKey + ':' + scope;
  const context = groupContext(input);
  if (await audioReady(runtime)) return {...await realtime.reply({key, characterId: ids[profile.key],
    sessionId: realtimeSessions.get(sessionKey), scope, context, text: input.text}), transport: 'realtime'};
  return requestReply({key, characterId: ids[profile.key], text: context ? context + '\nV says: ' + input.text : input.text,
    sessionId: sessions.get(sessionKey) || '-1', voice: false});
}

async function publishResult(input, profile, result) {
  (result.transport === 'realtime' ? realtimeSessions : sessions).set(input.profileKey + ':' + conversationScope(input), result.sessionID);
  let audio, audioError;
  if (result.audio) {
    try {
      const playing = JSON.parse(await readFile(resolve(runtime, 'speech-state.json'), 'utf8').catch(() => '{}'));
      if (nextSlot === playing.slot) nextSlot = (nextSlot + 1) % SLOT_COUNT;
      const slot = nextSlot; nextSlot = (nextSlot + 1) % SLOT_COUNT;
      audio = await storeSpeech(result.audio, audioDepot, slot);
      await atomic(resolve(runtime, 'last-speech-timing.json'), JSON.stringify({
        requestId: input.requestId, faces: result.faces, captions: result.captions, duration: audio.duration,
      }));
    } catch (error) {
      audioError = 'Voice could not be prepared; showing the written reply.';
      console.error('[CyberpunkConvai] Voice preparation failed:', error.message);
    }
  }
  await atomic(replyPath, JSON.stringify({requestId: input.requestId, generation: input.generation,
    entity: input.entity, profile: profile.key, text: result.text, audio, audioError, updated: Date.now()}));
  await status('ready', profile.name);
}

const micPath = resolve(runtime, 'microphone-command.json');
let micObserved = await readFile(micPath, 'utf8').catch(() => '');
let micPolling = false;
const mic = new MicrophoneSession({hostFactory: () => new RealtimeHost(),
  onState: (state, input) => atomic(resolve(runtime, 'microphone-state.json'), JSON.stringify({state, requestId: input.requestId, updated: Date.now()})),
  onReply: async (input, result) => {
    const command = JSON.parse(await readFile(micPath, 'utf8'));
    if (command.input?.requestId !== input.requestId || command.action === 'cancel') return;
    await publishResult(input, profileFor(input, roster), {...result, transport: 'realtime'});
  },
  onError: async (input, error) => {
    console.error('[CyberpunkConvai] Microphone:', error.message);
    await atomic(resolve(runtime, 'microphone-state.json'), JSON.stringify({state: 'error', requestId: input.requestId, updated: Date.now()}));
    await atomic(replyPath, JSON.stringify({requestId: input.requestId, generation: input.generation,
      entity: input.entity, error: 'Voice conversation failed. Check your microphone and try again.'}));
  },
});

async function pollMicrophone() {
  if (micPolling) return;
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
        await realtime.close();
        void mic.start(input, {key, characterId: ids[profile.key], scope: 'private', sessionId: realtimeSessions.get(input.profileKey + ':private')}).catch(error => console.error(error.message));
      }
    }
    void mic.tick(await audioReady(runtime)).catch(error => console.error(error.message));
  } finally { micPolling = false; }
}

async function tick() {
  if (busy) return;
  busy = true;
  let input;
  try {
    const stamp = await stat(inputPath).catch(() => null);
    if (!stamp) return;
    const raw = await readFile(inputPath, 'utf8');
    const signature = `${stamp.mtimeMs}:${stamp.size}:${raw}`;
    if (signature === observed) return;
    observed = signature;
    input = parseInput(raw);
    if (!input) { await status('invalid-input', 'Could not parse the game request'); return; }
    await mic.cancel();
    const profile = profileFor(input, roster);
    if (!profile || !ids[profile.key]) {
      await status('unmatched-npc', `No verified profile for ${input.name} (${input.bodyType})`);
      await atomic(replyPath, JSON.stringify({...input, text: undefined,
        error: `${input.name} does not have a conversation profile configured yet.`}));
      return;
    }
    await status('thinking', profile.name);
    const result = await respond(input, profile);
    // Do not show a late reply to a different target or a newer turn.
    const current = parseInput(await readFile(inputPath, 'utf8'));
    if (!current || current.requestId !== input.requestId) {
      await status('superseded', 'A newer request replaced this one');
      return;
    }
    await publishResult(input, profile, result);
  } catch (error) {
    await status('error', error.message).catch(() => {});
    if (input) await atomic(replyPath, JSON.stringify({requestId: input.requestId,
      generation: input.generation, entity: input.entity,
      error: 'The conversation service could not reply. Please try again.'})).catch(() => {});
    console.error('[CyberpunkConvai] Bridge request failed:', error.message);
  } finally { busy = false; }
}

// An existing request belongs to an earlier game/mod session; process only new input.
const initial = await stat(inputPath).catch(() => null);
if (initial) {
  const raw = await readFile(inputPath, 'utf8');
  observed = `${initial.mtimeMs}:${initial.size}:${raw}`;
}
await status('waiting');
console.log('[CyberpunkConvai] Convai conversation bridge ready');
const timer = setInterval(tick, 150);
const micTimer = setInterval(() => { void pollMicrophone().catch(error => console.error('[CyberpunkConvai] Microphone poll:', error.message)); }, 150);
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => {
  clearInterval(timer); clearInterval(micTimer); await mic.cancel(); await realtime.close(); process.exit(0);
});
