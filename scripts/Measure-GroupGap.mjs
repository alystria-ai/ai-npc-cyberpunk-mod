// Measures the silence between one group speaker's last audio and the next
// speaker's first audio, serial versus look-ahead.
//
//   node scripts/Measure-GroupGap.mjs --fixture          offline: the real bridge, a simulated game and provider
//   node scripts/Measure-GroupGap.mjs --live [--rounds 1]  Convai speech via the real RealtimeHost (a few calls)
//
// --live uses the Convai test user recorded in runtime/convai-latency-test-user.json (never the player's ID),
// warm pages like the bridge's composer warm-up, and a silent renderer (volume 0). It prints timings only:
// no credentials, user IDs, session IDs or dialogue text. The game's file round trips are modelled by
// the constants below; the provider timing is real.
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {dirname, resolve} from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = name => args.includes('--' + name);
const option = (name, fallback) => { const at = args.indexOf('--' + name); return at >= 0 ? Number(args[at + 1]) : fallback; };
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const summarize = (label, gaps) => console.log(JSON.stringify({label, gapsMs: gaps.map(Math.round),
  medianMs: Math.round(median(gaps)), minMs: Math.round(Math.min(...gaps)), maxMs: Math.round(Math.max(...gaps))}));

if (flag('fixture')) {
  const {measureRound} = await import(pathToFileURL(resolve(project, 'bridge/group-lookahead-fixture.mjs')).href);
  const rounds = option('rounds', 2), results = {serial: [], lookahead: []};
  for (let at = 0; at < rounds; at++) for (const mode of ['serial', 'lookahead']) {
    results[mode].push(...(await measureRound({mode})).gaps.map(row => row.gapMs));
  }
  for (const mode of ['serial', 'lookahead']) summarize('fixture-' + mode, results[mode]);
} else if (flag('live')) {
  const {RealtimeHost} = await import(pathToFileURL(resolve(project, 'bridge/realtime-host.mjs')).href);
  const {ConvaiContinuousSpeech} = await import(pathToFileURL(resolve(project, 'bridge/convai-continuous-speech.mjs')).href);
  const {groupContext, conversationScope} = await import(pathToFileURL(resolve(project, 'bridge/group-context.mjs')).href);
  const keyLine = (await readFile(resolve(project, 'runtime/convai-key.txt'), 'utf8')).trim();
  const key = /^api-key\s*=\s*(\S+)\s*$/i.exec(keyLine)?.[1];
  if (!key) throw Error('Local Convai key is unavailable');
  const ids = JSON.parse(await readFile(resolve(project, 'runtime/characters.json'), 'utf8'));
  const testUser = JSON.parse(await readFile(resolve(project, 'runtime/convai-latency-test-user.json'), 'utf8')).endUserId;
  if (typeof testUser !== 'string' || !testUser) throw Error('The Convai test user is unavailable');
  // Model of the game's side of a speaker change (mod/init.lua + mod/speech.lua):
  // see the end of a reply, submit the next turn, read the admission, grant playback.
  const LUA_SUBMIT_MS = option('submit-ms', 150), LUA_ADMIT_MS = option('admit-ms', 120);
  const speakers = [{key: 'alex', name: 'Alex'}, {key: 'judy-alvarez', name: 'Judy'}];
  const audience = speakers.map(speaker => speaker.key);
  const turn = (index, heard) => ({requestId: `${Date.now()}-${index}-${100 + index}ULL`, generation: index, entity: `${100 + index}ULL`,
    name: speakers[index - 1].name, profileKey: speakers[index - 1].key, text: 'Welcome V to the group in one short sentence.',
    group: {id: 'gap-measure', index, total: 2, audience, heard}});
  const config = input => ({key, characterId: ids[input.profileKey], endUserId: testUser, scope: conversationScope(input),
    context: groupContext(input), text: input.text, ttsEnabled: true});
  const host = new RealtimeHost();
  // A turn whose game-side behaviour is simulated. held: buffer only, publish nothing.
  const play = (input, {held = false, onText} = {}) => {
    const controller = new AbortController(), token = randomUUID().replace(/-/g, ''), t = {input, controller, held};
    let admitAt = Infinity, sequence = 0;
    t.speech = new ConvaiContinuousSpeech({input, profile: {key: input.profileKey}, token, signal: controller.signal,
      current: async () => !controller.signal.aborted,
      hold: () => t.held,
      onHeld: (seconds, complete) => { if (!t.readyAt && seconds >= .4 && complete) t.readyAt = Date.now(); },
      onText: text => { t.textAt = Date.now(); t.text = text; onText?.(text); },
      readControl: async () => Date.now() < admitAt ? '{}' : JSON.stringify({version: 1, id: token, requestId: input.requestId,
        entity: input.entity, generation: input.generation, sequence: ++sequence, updated: Date.now(), allow: true, paused: false, volume: 0, pan: 0}),
      writeState: async () => true,
      writeReply: async () => { t.publishedAt = Date.now(); admitAt = t.publishedAt + LUA_ADMIT_MS; return true; },
      onStarted: async () => { t.startedAt = Date.now(); },
    });
    const live = t.speech.options, onFrame = live.onFrame;
    t.sentAt = Date.now();
    t.done = host.reply(config(input), {signal: controller.signal, liveSpeech: {...live, onFrame: async snapshot => {
      if (snapshot.ended && !t.endedAt) t.endedAt = Date.now();
      return onFrame(snapshot);
    }}}).then(result => { t.finishedAt = Date.now(); return result; });
    t.done.catch(() => {});
    t.release = () => { t.releasedAt = Date.now(); t.held = false; t.speech.wakeUp(); };
    return t;
  };
  const rounds = option('rounds', 1), results = {serial: [], lookahead: []};
  try {
    // Warm both characters' pages once, as the bridge's composer warm-up does.
    await Promise.all(speakers.map(speaker => host.warm(config({profileKey: speaker.key, text: 'x', group: {audience}}))));
    for (let at = 0; at < rounds; at++) for (const mode of ['serial', 'lookahead']) {
      const first = turn(1, []);
      let second;
      const a = play(first, {onText: text => {
        if (mode !== 'lookahead') return;
        // The game publishes the next speaker's turn once this text is complete.
        second = play(turn(2, [{speaker: 'Alex', text}]), {held: true});
      }});
      await a.done;
      const aEnd = a.endedAt;
      await sleep(LUA_SUBMIT_MS);             // the game notices the end and submits the next speaker
      if (mode === 'lookahead') second.release();
      else second = play(turn(2, [{speaker: 'Alex', text: a.text}]));
      await second.done;
      const gap = second.startedAt - aEnd;
      results[mode].push(gap);
      console.log(JSON.stringify({round: at + 1, mode, gapMs: Math.round(gap),
        firstAudioFromSendMs: Math.round(a.startedAt - a.sentAt), textCompleteFromSendMs: Math.round(a.textAt - a.sentAt),
        publishedToAudioMs: Math.round(second.startedAt - second.publishedAt),
        ...(mode === 'lookahead' ? {nextSpeakerReadyBeforeSubmitMs: Math.round(aEnd + LUA_SUBMIT_MS - second.readyAt),
          nextSpeakerRequestedDuringPreviousMs: Math.round(aEnd - second.sentAt),
          releaseToPublishedMs: Math.round(second.publishedAt - second.releasedAt)} : {})}));
      await sleep(1500);
    }
    for (const mode of ['serial', 'lookahead']) if (results[mode].length) summarize('live-' + mode, results[mode]);
  } finally { await host.close(); }
} else {
  console.error('Usage: node scripts/Measure-GroupGap.mjs --fixture | --live [--rounds N] [--submit-ms 150] [--admit-ms 120]');
  process.exitCode = 2;
}
