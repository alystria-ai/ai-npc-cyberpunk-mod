// Runs the real convai-bridge.mjs against a simulated game for the lines nobody asked for (docs/COMPANION_SPEAK_UP.md): a companion that speaks up, and
// Johnny's follow-on to a line that is playing. Built on bridge/group-lookahead-fixture.mjs (the same throwaway state folder, the same simulated Convai speech
// provider, the same stage log); the game side here reproduces what mod/init.lua is meant to do:
//   - a source line is submitted as a private turn (a speak-up reaction with its lease, or a normal reply to V);
//   - when the source's complete text is known, the game publishes Johnny's follow-on in runtime/group-prefetch.json
//     ({kind: 'follow', sourceRequestId, input}) and does NOT withdraw it;
//   - when the source has been heard (its playback ended), it submits the very same table as a request, with the lease, after `submitDelayMs`.
// An after-scene line is the same without a source turn of ours: {kind: 'ahead', input} is published while the scene's last line plays, and submitted when
// the scene is over. Nothing here contacts Convai, the real game or the player's runtime folder.
//
// Two routes: Convai (the simulated provider, voice and all; the stage log has play-start / play-end per character), and a text provider (provider: 'custom', a
// simulated OpenAI-compatible server on this computer: the line is written, not voiced, and the game plays it for `playMs` after the reply is published).
import {createServer} from 'node:http';
import {join} from 'node:path';
import {readFile} from 'node:fs/promises';
import {setTimeout as sleep} from 'node:timers/promises';
import {atomicFile} from './guarded-file.mjs';
import {GroupScenario, SPEAKERS, DEFAULT_TIMINGS, LIVE_TIMINGS} from './group-lookahead-fixture.mjs';

export const [JUDY, PANAM] = SPEAKERS;
// Johnny speaks as V's head: his turn is on V's entity.
export const JOHNNY = {key: 'johnny-silverhand', name: 'Johnny Silverhand', entity: '104ULL', characterId: '44444444-4444-4444-8444-444444444444'};
export const CAST = [...SPEAKERS, JOHNNY];

const johnny = {firstTextMs: 1100, textCompleteMs: 1400, firstPcmMs: 1500, pcmCompleteMs: 2600, audioSeconds: 3, text: 'Cute. She never learns when to stop talking.'};
// Judy's line is long enough (7 s) that Johnny's follow-on can be ready behind it.
export const SPEAK_TIMINGS = {...DEFAULT_TIMINGS,
  'judy-alvarez': {...DEFAULT_TIMINGS['judy-alvarez'], audioSeconds: 7, text: 'Quiet night, V. I could get used to this.'},
  'johnny-silverhand': johnny};
// The provider delays of the 2026-10-17 live round (LIVE_TIMINGS), for Judy's line and for Johnny's: a fresh connection (3.5 s), the text 2.6 s after it, the
// first audio 3.5 s after the request. A SIMULATED provider: these are not measurements of a live follow-on.
export const LIVE_SPEAK_TIMINGS = {...LIVE_TIMINGS,
  'judy-alvarez': {...LIVE_TIMINGS['judy-alvarez'], audioSeconds: 7, text: 'Quiet night, V. I could get used to this.'},
  'johnny-silverhand': {...LIVE_TIMINGS['judy-alvarez'], audioSeconds: 3, text: johnny.text}};

const SHARING = new Set(['EPERM', 'EACCES', 'EBUSY']);
async function write(path, value) {
  for (let attempt = 0; ; attempt++) {
    try { return await atomicFile(path, value); } catch (error) {
      if (!SHARING.has(error?.code) || attempt >= 40) throw error;
      await sleep(15);
    }
  }
}
const readJson = async path => { try { return JSON.parse(await readFile(path, 'utf8')); } catch { return null; } };

export const JOURNAL = {version: 1, status: 'active', quest: {id: '1234', title: 'Playing for Time', objectives: [{id: '1', text: 'Meet Judy at the clinic', tracked: true}]}};
export const TURN_CONTEXT = {version: 1, status: 'ready', hour: 23, minute: 10, weather: 'clear', district: 'Watson',
  party: [{key: 'judy-alvarez', name: 'Judy', activity: 'standing'}]};
export const HEAD = {version: 1, stage: 'wary', milestones: []};
export const SCENE = {version: 1, status: 'ready', lines: [
  {id: 'l1', age: 12, kind: 'line', channel: 'scene', speaker: 'npc', name: 'Regina Jones', entity: '777ULL', text: 'The job pays double if you finish by dawn.', present: ['judy-alvarez']},
  {id: 'l2', age: 6, kind: 'line', channel: 'scene', speaker: 'v', text: 'Consider it done.', present: ['judy-alvarez']}]};

/**
 * A simulated OpenAI-compatible chat server for the Custom provider. `reply(body)` -> the text for a request (default: by the name in the prompt); the request is
 * answered as a stream after `firstTokenMs`, a word every `tokenMs`. `requests` records each request: when it came, its messages, and whether the client went away
 * before the answer was finished (`aborted`, which is what an aborted generation looks like to a model server).
 */
export async function startChatServer({firstTokenMs = 300, tokenMs = 20, reply = body => (/Johnny/.test(JSON.stringify(body.messages?.[0])) ? johnny.text : SPEAK_TIMINGS['judy-alvarez'].text)} = {}) {
  const requests = [];
  const server = createServer((request, response) => {
    let text = '';
    request.on('data', chunk => { text += chunk; });
    request.on('end', () => {
      if (request.url.includes('/models')) { response.writeHead(200, {'content-type': 'application/json'}); response.end(JSON.stringify({data: [{id: 'fake'}]})); return; }
      let body = {}; try { body = JSON.parse(text); } catch { /* not JSON */ }
      const entry = {t: Date.now(), messages: body.messages ?? [], stream: body.stream === true, aborted: false, endedAt: null};
      requests.push(entry);
      response.on('close', () => { entry.closedAt = Date.now(); if (!response.writableFinished) entry.aborted = true; });
      const words = String(reply(body)).split(/(?<= )/);
      if (!body.stream) {
        setTimeout(() => { if (response.destroyed) return; response.writeHead(200, {'content-type': 'application/json'});
          response.end(JSON.stringify({choices: [{index: 0, message: {role: 'assistant', content: words.join('')}, finish_reason: 'stop'}], usage: {prompt_tokens: 10, completion_tokens: words.length}})); entry.endedAt = Date.now(); }, firstTokenMs);
        return;
      }
      response.writeHead(200, {'content-type': 'text/event-stream'});
      const send = chunk => { if (!response.destroyed && !response.writableEnded) response.write('data: ' + JSON.stringify(chunk) + '\n\n'); };
      let at = 0;
      const timer = setTimeout(function next() {
        if (response.destroyed || response.writableEnded) return;
        if (at === 0) send({choices: [{index: 0, delta: {role: 'assistant', content: ''}, finish_reason: null}]});
        if (at < words.length) { send({choices: [{index: 0, delta: {content: words[at++]}, finish_reason: null}]}); setTimeout(next, tokenMs); return; }
        send({choices: [{index: 0, delta: {}, finish_reason: 'stop'}]});
        send({choices: [], usage: {prompt_tokens: 10, completion_tokens: words.length}});
        response.end('data: [DONE]\n\n'); entry.endedAt = Date.now();
      }, firstTokenMs);
      response.on('close', () => clearTimeout(timer));
    });
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const port = server.address().port;
  return {url: `http://127.0.0.1:${port}/v1`, requests, port,
    close: () => new Promise(done => { server.closeAllConnections?.(); server.close(() => done()); })};
}

export class SpeakUpScenario extends GroupScenario {
  // prepare: the game publishes the follow-on / after-scene line ahead (false: the serial game, as before this feature).
  // submitDelayMs: how long after the source has been heard the game submits the follow-on (its own tick and its pause before Johnny speaks).
  // playMs: how long the game plays a written reply (the text route has no audio in this fixture).
  // provider 'custom': the text route, `chat` is the simulated server from startChatServer.
  constructor({prepare = true, submitDelayMs = 150, playMs = 4000, timings = SPEAK_TIMINGS, provider = 'convai', chat = null, hooks = {}, ...options} = {}) {
    const custom = provider === 'custom';
    super({cast: CAST, speakers: 1, timings, hooks, mode: 'lookahead',
      settings: custom ? {conversationProvider: 'custom', voice: false} : {},
      stateFiles: custom ? {'player-custom-endpoint.txt': `endpoint=${chat.url}\nmodel=fake\n`} : {}, ...options});
    Object.assign(this, {prepare, submitDelayMs, playMs, provider, chat, trail: [], heard: [], followFor: null});
  }

  note(event, extra = {}) { this.trail.push({t: Date.now(), event, ...extra}); }
  at(event, filter = () => true) { return this.trail.find(row => row.event === event && filter(row))?.t; }

  baseTurn(person, extra = {}) {
    const generation = ++this.sequence;
    return {requestId: `${Date.now()}-${generation}-${person.entity}`, generation, entity: person.entity, name: person.name, bodyType: 'female', profileKey: person.key, ...extra};
  }
  speakUpInput(event = 'calm', person = JUDY, expiresInMs = 180000) {
    return this.baseTurn(person, {text: 'Speak up on your own.', journal: JOURNAL, turnContext: TURN_CONTEXT, ...(event === 'scene' ? {gameDialogue: SCENE} : {}),
      reaction: {kind: 'speakup', event, facts: {}, expiresAt: Date.now() + expiresInMs}});
  }
  talkInput(person = JUDY, text = 'Hey, how are you holding up?') { return this.baseTurn(person, {text, journal: JOURNAL, turnContext: TURN_CONTEXT}); }
  followInput(source, line, via, expiresInMs = 180000) {
    return this.baseTurn(JOHNNY, {text: 'Johnny follows.', head: HEAD, turnContext: TURN_CONTEXT, voiceOnly: true,
      reaction: {kind: 'head', event: 'follow', expiresAt: Date.now() + expiresInMs, facts: {who: source.name, line, via}}});
  }

  writeLease(input) { return write(join(this.runtime, 'reaction-lease.json'), JSON.stringify({version: 1, requestId: input.requestId, valid: true, updated: Date.now()})); }
  withdrawLease(input) { return write(join(this.runtime, 'reaction-lease.json'), JSON.stringify({version: 1, requestId: input.requestId, valid: false, updated: Date.now()})); }
  command(value) { return write(join(this.runtime, 'group-prefetch.json'), JSON.stringify(value ?? {})); }
  // V presses the talk key: the text box (or the recording) opens and the game says whom V is about to talk to (runtime/conversation-prewarm.json).
  openComposer(person = JUDY) {
    this.note('composer-open');
    return write(join(this.runtime, 'conversation-prewarm.json'), JSON.stringify({nonce: `composer-${Date.now()}-${this.sequence}`, audience: [person.key], group: false, entity: person.entity}));
  }
  closeComposer() { return write(join(this.runtime, 'conversation-prewarm.json'), '{}'); }

  // Submits a turn as the game does: the lease first (a reaction), then the request.
  async submit(input, plan = {}) {
    if (input.reaction) await this.writeLease(input);
    this.pending = {input, plan, sentAt: Date.now(), admitted: false};
    this.requests.push({requestId: input.requestId, profile: input.profileKey, sentAt: this.pending.sentAt});
    this.note('submit', {requestId: input.requestId, profile: input.profileKey, kind: plan.kind ?? 'turn'});
    await write(join(this.runtime, 'last-input.json'), JSON.stringify({...input, sentAt: Date.now()}));
    this.loop ??= this.run();
  }

  // A companion speaks up (a reaction turn) or answers V (a normal turn). follow: 'companion' / 'talk' = Johnny follows its line (decided by the game before the
  // line is written, as mod/speak-up.lua's followOn is); the follow-on's table is made when the line's complete text is known.
  async source({kind = 'speakup', event = 'calm', person = JUDY, follow = null, playMs} = {}) {
    this.done = false;
    const input = kind === 'speakup' ? this.speakUpInput(event, person) : this.talkInput(person);
    await this.submit(input, {kind: 'source', follow, ...(playMs ? {playMs} : {})});
    return input;
  }
  // An after-scene line: the game prepares it while the scene's last line plays and submits it `sceneMs` later. The scene is game audio, not a turn of ours.
  async scene({sceneMs = 5000, person = JUDY, prepared = this.prepare, follow = null} = {}) {
    this.done = false;
    const input = this.speakUpInput('scene', person);
    this.sceneInput = input;
    this.note('scene-start');
    if (prepared) { await this.command({kind: 'ahead', input}); this.note('prepared-command', {requestId: input.requestId}); }
    await sleep(sceneMs);
    this.sceneEndedAt = Date.now(); this.note('scene-end');
    await sleep(this.submitDelayMs);
    await this.submit(input, {kind: 'after-scene', follow});
    return input;
  }

  async step() {
    const pending = this.pending;
    if (!pending) return;
    this.ticks = (this.ticks ?? 0) + 1;   // how often the game has looked at the bridge's answer (a count a test can wait on, unlike a pause)
    // The lease: the game's word, refreshed on every tick, that it is playing this reaction. A test withdraws it with `pending.leaseDropped`.
    if (pending.input.reaction) await (pending.leaseDropped ? this.withdrawLease(pending.input) : this.writeLease(pending.input));
    const reply = await readJson(join(this.runtime, 'reply.json'));
    if (reply?.requestId) this.replyIds.add(reply.requestId);
    if (reply?.error && !this.replyErrors.some(row => row.requestId === reply.requestId)) this.replyErrors.push(reply);
    const mine = reply?.requestId === pending.input.requestId && !reply.error;
    if (!pending.admitted && mine && (reply.continuous || typeof reply.text === 'string')) {
      pending.admitted = true; pending.continuous = reply.continuous; pending.admittedAt = Date.now();
      this.note('admitted', {requestId: pending.input.requestId, profile: pending.input.profileKey});
    }
    if (!pending.admitted) return;
    let text, complete, ended;
    if (pending.continuous) {
      await this.renewLease(pending);
      const state = await readJson(join(this.runtime, 'continuous-speech.json'));
      if (state?.requestId !== pending.input.requestId || state.id !== pending.continuous.id) return;
      text = state.text; complete = state.textComplete === true; ended = state.ended === true;
    } else {
      text = reply.text; complete = true; pending.playStart ??= Date.now();
      ended = Date.now() - pending.playStart >= (pending.plan.playMs ?? this.playMs);
    }
    pending.text = text;
    if (complete && !pending.textAt && text) {
      pending.textAt = Date.now(); this.note('text-complete', {requestId: pending.input.requestId, profile: pending.input.profileKey});
      await this.onText(pending);
    }
    if (ended && !pending.finished) await this.finish(pending);
  }

  // The source's complete text is known: the game decides the follow-on is wanted, builds its table (once) and, when preparing, publishes it.
  async onText(pending) {
    const follow = pending.plan.follow;
    if (!follow) return;
    const table = this.hooks.followTable ? this.hooks.followTable(this.followInput(pending.input, pending.text, follow), pending) : this.followInput(pending.input, pending.text, follow);
    this.followFor = {source: pending.input, table};
    if (this.prepare) { await this.command({kind: 'follow', sourceRequestId: pending.input.requestId, input: table}); this.note('prepared-command', {requestId: table.requestId}); }
    this.detach(this.hooks.afterPrediction?.(this, pending));
  }

  // A hook that waits runs beside the game's loop, which keeps renewing the leases; a failure of it fails the test that waits.
  detach(promise) { Promise.resolve(promise).catch(error => { this.error ??= error; }); }

  async finish(pending) {
    pending.finished = true; pending.finishedAt = Date.now();
    if (pending.continuous) {
      this.sequenceReceipt = (this.sequenceReceipt || 0) + 1;
      this.lastDelivery = {version: 1, id: 'speech-fixture-' + this.sequenceReceipt, sequence: this.sequenceReceipt, completedAt: Date.now(), source: 'continuous-playback',
        backend: 'browser-pcm', state: 'completed', partial: false, cancelled: false, requestId: pending.input.requestId, entity: pending.input.entity,
        generation: pending.input.generation, conversationGeneration: pending.input.generation, totalChunks: 1, completedChunks: 1};
      await this.writeSpeechState();
    }
    this.heard.push({speaker: pending.input.name, text: pending.text});
    this.pending = null;
    this.note('ended', {requestId: pending.input.requestId, profile: pending.input.profileKey, kind: pending.plan.kind});
    this.detach(this.hooks.afterTurn?.(this, pending));
    if (pending.plan.follow && this.followFor?.source === pending.input && !this.hooks.noFollowSubmit) {
      // The source has been heard: the game submits Johnny's follow-on after its own tick (the prepared table when preparing, a fresh one otherwise).
      await sleep(this.submitDelayMs);
      if (this.hooks.beforeFollowSubmit) await this.hooks.beforeFollowSubmit(this, pending);
      if (!this.pending) await this.submit(this.followFor.table, {kind: 'follow'});
    } else if (!this.pending) this.done = true;
  }

  async stop() {
    await super.stop();
    await this.chat?.close?.();
  }
}

export const gapBetween = (events, from, to) => {
  const end = events.findLast(row => row.event === 'play-end' && row.characterId === from.characterId)?.t;
  const begin = events.find(row => row.event === 'play-start' && row.characterId === to.characterId)?.t;
  return end !== undefined && begin !== undefined ? begin - end : undefined;
};
