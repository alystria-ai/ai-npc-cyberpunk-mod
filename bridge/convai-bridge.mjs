import {readFile, writeFile, rename, stat, mkdir} from 'node:fs/promises';
import {resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseInput, profileFor} from './protocol.mjs';

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
let observed = '';
let busy = false;

async function atomic(path, data) {
  const temp = path + '.tmp';
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
  const body = new URLSearchParams({
    userText: input.text,
    charID: ids[profile.key],
    sessionID: sessions.get(input.entity) || '-1',
    voiceResponse: 'False',
  });
  const response = await fetch('https://api.convai.com/character/getResponse', {
    method: 'POST', headers: {'CONVAI-API-KEY': key}, body,
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw Error(`Convai returned HTTP ${response.status}`);
  const result = await response.json();
  if (typeof result.text !== 'string' || !result.text.trim() || typeof result.sessionID !== 'string') {
    throw Error('Convai reply was missing text or a session ID');
  }
  return {text: result.text.trim().slice(0, 1200), sessionID: result.sessionID};
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
    sessions.set(input.entity, result.sessionID);
    await atomic(replyPath, JSON.stringify({
      requestId: input.requestId, generation: input.generation,
      entity: input.entity, profile: profile.key, text: result.text,
      updated: Date.now(),
    }));
    await status('ready', profile.name);
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
console.log('[CyberpunkConvai] Convai text bridge ready');
setInterval(tick, 150);
