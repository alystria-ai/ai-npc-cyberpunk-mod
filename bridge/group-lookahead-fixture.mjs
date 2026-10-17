// Runs the real convai-bridge.mjs against a simulated game and a simulated
// Convai speech provider (bridge/fixtures/*), in a throwaway state directory.
// The game side reproduces mod/group-chat.lua's contract: it submits speaker 1,
// admits each reply (continuous-control.json), publishes the prediction for the
// next speaker once the reply text is complete (group-prefetch.json), and
// submits that speaker only after the current one finished playing. Nothing
// here contacts Convai, the real game or the player's runtime folder.
import {spawn} from 'node:child_process';
import {mkdtemp, mkdir, readFile, writeFile, rm, realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {basename, dirname, join} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {setTimeout as sleep} from 'node:timers/promises';
import {atomicFile} from './guarded-file.mjs';

const bridge = fileURLToPath(new URL('./convai-bridge.mjs', import.meta.url));
const register = pathToFileURL(fileURLToPath(new URL('./fixtures/register-fakes.mjs', import.meta.url))).href;
const prefix = 'cyberpunk-group-lookahead-';
export const SPEAKERS = [
  {key: 'judy-alvarez', name: 'Judy', entity: '101ULL', characterId: '11111111-1111-4111-8111-111111111111'},
  {key: 'panam-palmer', name: 'Panam', entity: '102ULL', characterId: '22222222-2222-4222-8222-222222222222'},
  {key: 'alex', name: 'Alex', entity: '103ULL', characterId: '33333333-3333-4333-8333-333333333333'},
];
// The bridge reads these files while the simulated game replaces them; on Windows
// that can fail the rename for a moment. The real game tolerates it, so does this.
const SHARING = new Set(['EPERM', 'EACCES', 'EBUSY']);
async function write(path, value) {
  for (let attempt = 0; ; attempt++) {
    try { return await atomicFile(path, value); }
    catch (error) {
      if (!SHARING.has(error?.code) || attempt >= 40) throw error;
      await sleep(15);
    }
  }
}
const readJson = async path => { try { return JSON.parse(await readFile(path, 'utf8')); } catch { return null; } };
const readLog = async path => (await readFile(path, 'utf8').catch(() => '')).split('\n').filter(Boolean).map(line => JSON.parse(line));

// Provider timing, by speaker (ms after the request is sent). Defaults follow the
// latency review: first text ~1.1 s, complete text ~0.3 s later, first audio
// ~1.5 s, all audio ~2.6 s, then several seconds of playback.
export const DEFAULT_TIMINGS = {
  'judy-alvarez': {firstTextMs: 1100, textCompleteMs: 1400, firstPcmMs: 1500, pcmCompleteMs: 2600, audioSeconds: 5, text: 'Hey V, good to see you both here.'},
  'panam-palmer': {firstTextMs: 1100, textCompleteMs: 1400, firstPcmMs: 1500, pcmCompleteMs: 2600, audioSeconds: 5, text: 'Yeah, about time we all got together.'},
  alex: {firstTextMs: 1100, textCompleteMs: 1400, firstPcmMs: 1500, pcmCompleteMs: 2600, audioSeconds: 4, text: 'I could use a drink after all this.'},
};

// What the stage clock of a live round on the player's own Convai key and the Voxtral voice showed (2026-10-17): a fresh connection
// for every speaker (3.0-4.3 s), the reply text 2.4-2.6 s after that, the first audio 1.1 s after the text, a reply of about 5 s. The
// simulated Convai speech path folds the text and the voice into the delays of one provider request; the connection is its own cost
// (connectMs), paid by a speaker whose page was not opened ahead of time. A speaker that is not prepared at all takes about 7 s from
// its request to its first audio, as it did live.
const liveShaped = text => ({connectMs: 3500, firstTextMs: 2100, textCompleteMs: 2600, firstPcmMs: 3500, pcmCompleteMs: 4500, audioSeconds: 5, text});
export const LIVE_TIMINGS = {
  'judy-alvarez': liveShaped('Hey V, good to see you both here.'),
  'panam-palmer': liveShaped('Yeah, about time we all got together.'),
  alex: liveShaped('I could use a drink after all this.'),
};

export class GroupScenario {
  // mode: 'lookahead' publishes predictions as the game does; 'serial' never
  // does (the bridge then behaves as before this feature). luaMs models how
  // often the game's update loop reads and writes files.
  // playerKey: null for the shared key (the default), or {connections} for a player's own Convai key whose plan allows that many
  // conversation connections at once (1: free or unread plan, 6: confirmed paid Gamer plan). The plan is never read from Convai.
  constructor({mode = 'lookahead', timings = DEFAULT_TIMINGS, luaMs = 50, speakers = 3, hooks = {}, playerKey = null} = {}) {
    Object.assign(this, {mode, timings, luaMs, speakers, hooks, playerKey});
    this.round = 0; this.requests = []; this.sequence = 0; this.controlSequence = 0;
    this.replyIds = new Set(); this.replyErrors = [];
  }

  async start() {
    this.folder = await mkdtemp(join(tmpdir(), prefix));
    const state = this.state = join(this.folder, 'state'), game = join(this.folder, 'game');
    this.runtime = join(game, 'bin', 'x64', 'plugins', 'cyber_engine_tweaks', 'mods', 'AiNpcCyberpunkMod', 'runtime');
    await mkdir(state, {recursive: true}); await mkdir(this.runtime, {recursive: true});
    this.hostLog = join(this.folder, 'host.jsonl');
    const ids = Object.fromEntries(SPEAKERS.map(speaker => [speaker.key, speaker.characterId]));
    const byId = Object.fromEntries(SPEAKERS.map(speaker => [speaker.characterId, this.timings[speaker.key]]));
    await Promise.all([
      writeFile(join(state, 'convai-key.txt'), 'api-key=isolated-test-key-not-a-real-credential\n'),
      writeFile(join(state, 'characters.json'), JSON.stringify(ids)),
      writeFile(join(state, 'local-voices.json'), '{}'),
      writeFile(join(this.runtime, 'settings.json'), JSON.stringify({voiceProvider: 'convai', ...(this.playerKey ? {useOwnConvaiKey: true} : {})})),
      ...(this.playerKey ? [writeFile(join(state, 'player-convai-key.txt'), 'api-key=isolated-test-player-key-not-a-real-credential\n')] : []),
      writeFile(join(this.folder, 'timings.json'), JSON.stringify(byId)),
    ]);
    this.timingsPath = join(this.folder, 'timings.json');
    const env = {...process.env, CYBERPUNK_CONVAI_STATE: state, CYBERPUNK_CONVAI_GAME: game,
      CYBERPUNK_CONVAI_KEY_FILE: join(state, 'convai-key.txt'), CYBERPUNK_CONVAI_MUTE_BROWSER: '1', FAKE_HOST_LOG: this.hostLog, FAKE_HOST_TIMINGS: this.timingsPath,
      FAKE_PAID_CONNECTIONS: String(this.playerKey?.connections ?? 1)};
    delete env.NODE_OPTIONS; delete env.NODE_PATH;
    this.output = '';
    this.child = spawn(process.execPath, ['--import', register, bridge], {cwd: this.folder, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']});
    this.child.stdout.on('data', data => { this.output = (this.output + data).slice(-20000); });
    this.child.stderr.on('data', data => { this.output = (this.output + data).slice(-20000); });
    this.closed = null; this.child.once('close', (code, signal) => { this.closed = {code, signal}; });
    this.beat();
    this.heartbeat = setInterval(() => void this.beat().catch(() => {}), 400);
    for (let at = 0; at < 600; at++) {
      if (this.closed) throw Error('bridge exited during startup\n' + this.output);
      // A player's key takes over at the bridge's first idle boundary; the round must not begin before it has.
      if ((await readJson(join(this.runtime, 'bridge-status.json')))?.state === 'waiting'
          && (!this.playerKey || (await readJson(join(this.runtime, 'own-key-state.json')))?.active === 'player')) return;
      await sleep(100);
    }
    throw Error('bridge did not reach waiting\n' + this.output);
  }

  async beat() {
    const now = Date.now();
    await write(join(this.runtime, 'world-session.json'), JSON.stringify({version: 1, updated: now, token: 'fixture-world', generation: 1, ready: true}));
    await this.writeSpeechState();
  }
  async writeSpeechState() {
    await write(join(this.runtime, 'speech-state.json'), JSON.stringify({available: true, continuousAvailable: true,
      updated: Date.now(), state: 'idle', ...(this.lastDelivery ? {lastDelivery: this.lastDelivery} : {})}));
  }

  inputFor(index, heard, {requestId} = {}) {
    const speaker = SPEAKERS[index - 1], generation = ++this.sequence;
    return {requestId: requestId ?? `${Date.now()}-${generation}-${speaker.entity}`, generation, entity: speaker.entity,
      name: speaker.name, bodyType: 'female', profileKey: speaker.key, text: this.text ?? 'What do you think?',
      group: {id: this.groupId, index, total: this.speakers,
        audience: SPEAKERS.slice(0, this.speakers).map(item => item.key), heard}};
  }
  async submit(input) {
    this.pending = {input, sentAt: Date.now(), admitted: false};
    this.requests.push({requestId: input.requestId, profile: input.profileKey, sentAt: this.pending.sentAt});
    await write(join(this.runtime, 'last-input.json'), JSON.stringify({...input, sentAt: Date.now()}));
  }
  async publishPrediction(input, sourceRequestId) {
    await write(join(this.runtime, 'group-prefetch.json'), JSON.stringify(input ? {sourceRequestId, input} : {}));
  }

  // One new group round: speaker 1 is submitted, then the rest follow in order.
  async begin(text = 'What do you both think about this?') {
    this.groupId = 'group-' + (++this.round); this.text = text; this.heard = []; this.predicted = null; this.index = 1;
    await this.publishPrediction(null);
    await this.submit(this.inputFor(1, []));
    this.loop ??= this.run();
  }

  async run() {
    this.running = true;
    while (this.running) {
      await sleep(this.luaMs);
      try { await this.step(); } catch (error) { this.error = error; }
    }
  }

  // The game rewrites its playback control continuously; the bridge stops a
  // speaker whose control file goes stale.
  renewLease(pending) {
    return write(join(this.runtime, 'continuous-control.json'), JSON.stringify({version: 1, id: pending.continuous.id,
      requestId: pending.input.requestId, generation: pending.input.generation, entity: pending.input.entity,
      sequence: ++this.controlSequence, updated: Date.now(), allow: true, paused: false, volume: 1, pan: 0}));
  }

  // For a hook that must wait inside the game loop: keep the current speaker's
  // control fresh while the condition is pending.
  waitHolding(pending, predicate, label, timeoutMs = 30000) {
    return this.waitFor(async () => { await this.renewLease(pending); return predicate(); }, label, timeoutMs);
  }

  async step() {
    const pending = this.pending;
    if (!pending) return;
    const reply = await readJson(join(this.runtime, 'reply.json'));
    if (!pending.admitted && reply?.requestId === pending.input.requestId && reply.continuous) {
      pending.admitted = true; pending.continuous = reply.continuous; pending.text = reply.text; pending.admittedAt = Date.now();
      this.seen = {requestId: reply.requestId, at: pending.admittedAt};
    }
    if (reply?.requestId) this.replyIds.add(reply.requestId);
    if (reply?.error && !this.replyErrors.some(row => row.requestId === reply.requestId)) this.replyErrors.push(reply);
    if (!pending.admitted) return;
    await this.renewLease(pending);
    const state = await readJson(join(this.runtime, 'continuous-speech.json'));
    if (state?.requestId !== pending.input.requestId || state.id !== pending.continuous.id) return;
    pending.text = state.text;
    const next = pending.input.group.index + 1;
    if (state.textComplete && this.mode === 'lookahead' && !pending.predicted && next <= this.speakers && !this.hooks.noPrediction) {
      pending.predicted = true;
      const heard = [...this.heard, {speaker: pending.input.name, text: state.text}];
      const input = this.hooks.prediction ? this.hooks.prediction(this.inputFor(next, heard.slice(-2)), pending) : this.inputFor(next, heard.slice(-2));
      this.nextInput = input; pending.predictedAt = Date.now();
      await this.publishPrediction(input, pending.input.requestId);
      await this.hooks.afterPrediction?.(this, pending);
    }
    if (state.ended && !pending.finished) {
      pending.finished = true; pending.finishedAt = Date.now();
      this.sequenceReceipt = (this.sequenceReceipt || 0) + 1;
      this.lastDelivery = {version: 1, id: 'speech-fixture-' + this.sequenceReceipt, sequence: this.sequenceReceipt,
        completedAt: Date.now(), source: 'continuous-playback', backend: 'browser-pcm', state: 'completed', partial: false,
        cancelled: false, requestId: pending.input.requestId, entity: pending.input.entity, generation: pending.input.generation,
        conversationGeneration: pending.input.generation, totalChunks: 1, completedChunks: 1};
      await this.writeSpeechState();
      this.heard.push({speaker: pending.input.name, text: state.text});
      this.pending = null;
      await this.hooks.afterSpeaker?.(this, pending);
      if (next <= this.speakers && !this.hooks.stopAfterSpeaker?.(pending)) {
        // mod/group-chat.lua: the prepared turn is reused when its context is unchanged.
        const input = this.mode === 'lookahead' && this.nextInput && !this.hooks.freshInput ? this.nextInput
          : this.inputFor(next, this.heard.slice(-2));
        this.nextInput = null; this.index = next;
        await this.submit(input);
      } else this.done = true;
    }
  }

  async waitFor(predicate, label, timeoutMs = 60000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.error) throw this.error;
      if (this.closed) throw Error('bridge exited\n' + this.output);
      if (await predicate()) return;
      await sleep(50);
    }
    throw Error('timed out waiting for ' + label + '\n' + this.output);
  }

  async events() { return readLog(this.hostLog); }

  // Silence between one speaker's last audio and the next speaker's first audio.
  async gaps() {
    const events = await this.events(), at = (event, key) => events.find(row => row.event === event && row.characterId === key)?.t;
    const result = [];
    for (let i = 0; i + 1 < SPEAKERS.length; i++) {
      const end = at('play-end', SPEAKERS[i].characterId), begin = at('play-start', SPEAKERS[i + 1].characterId);
      if (end !== undefined && begin !== undefined) result.push({from: SPEAKERS[i].key, to: SPEAKERS[i + 1].key, gapMs: begin - end});
    }
    return result;
  }

  async stop() {
    this.running = false; clearInterval(this.heartbeat);
    await this.loop?.catch(() => {});
    if (this.child && this.closed === null) {
      await atomicFile(join(this.state, 'bridge-control.json'), JSON.stringify({action: 'shutdown', pid: this.child.pid})).catch(() => {});
      for (let at = 0; at < 60 && this.closed === null; at++) await sleep(100);
      if (this.closed === null) this.child.kill();
      for (let at = 0; at < 30 && this.closed === null; at++) await sleep(100);
    }
    if (this.folder) {
      const resolved = await realpath(this.folder);
      if (dirname(resolved).toLowerCase() === (await realpath(tmpdir())).toLowerCase() && basename(resolved).startsWith(prefix)) {
        // Windows can hold the folder for a moment after the bridge exits (EBUSY under load): retry before giving up.
        await rm(resolved, {recursive: true, force: true, maxRetries: 30, retryDelay: 100});
      }
    }
  }
}

export async function measureRound(options) {
  const scenario = new GroupScenario(options);
  try {
    await scenario.start();
    await scenario.begin();
    await scenario.waitFor(() => scenario.done, 'the round to finish', 90000);
    const events = await scenario.events();
    return {gaps: await scenario.gaps(), events, latency: await readJson(join(scenario.runtime, 'bridge-latency.json')),
      output: scenario.output};
  } finally { await scenario.stop(); }
}
