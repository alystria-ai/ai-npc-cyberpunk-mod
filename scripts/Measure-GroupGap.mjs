// Measures the silence between one group speaker's last audio and the next
// speaker's first audio, serial versus look-ahead.
//
//   node scripts/Measure-GroupGap.mjs --fixture [--key shared|player-paid|player-free] [--live-timings] [--speakers 2|3] [--rounds N]
//                                                       offline: the real bridge, a simulated game and provider
//   node scripts/Measure-GroupGap.mjs --live [--rounds 1]  Convai speech via the real RealtimeHost (a few calls)
//   node scripts/Measure-GroupGap.mjs --follow [--what speakup|talk|scene] [--route convai|text] [--key shared|player-paid|player-free] [--live-timings] [--rounds N]
//                                                       offline: Johnny's follow-on to a line that is playing (speakup: after a companion's speak-up, talk: after a
//                                                       reply to V), or a companion's after-scene line (scene), serial versus prepared ahead (docs/COMPANION_SPEAK_UP.md).
//                                                       SIMULATED providers (bridge/speak-up-fixture.mjs): these are not live measurements.
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

if (flag('follow')) {
  const {SpeakUpScenario, JUDY, JOHNNY, SPEAK_TIMINGS, LIVE_SPEAK_TIMINGS, startChatServer, gapBetween} = await import(pathToFileURL(resolve(project, 'bridge/speak-up-fixture.mjs')).href);
  const word = (name, fallback) => args.includes('--' + name) ? args[args.indexOf('--' + name) + 1] : fallback;
  const what = word('what', 'speakup'), route = word('route', 'convai'), keyName = word('key', 'shared');
  if (!['speakup', 'talk', 'scene'].includes(what) || !['convai', 'text'].includes(route)) throw Error('--what speakup|talk|scene, --route convai|text');
  const playerKey = keyName === 'player-paid' ? {connections: 6} : keyName === 'player-free' ? {connections: 1} : null;
  const firstTokenMs = option('first-token-ms', 700);
  const label = `follow-${what}-${route}-${keyName}${flag('live-timings') ? '-live-timings' : ''}`;
  // One round: the silence between the end of the line that plays (the source, or the scene) and the first audio of the line that follows it. The text route has no voice
  // in this fixture, so there the figure is the time until the game has the line (its text published): the voice's own start-up is not modelled.
  async function round(prepare) {
    const chat = route === 'text' ? await startChatServer({firstTokenMs}) : null;
    const scenario = new SpeakUpScenario({prepare, provider: route === 'text' ? 'custom' : 'convai', chat, playerKey, speakers: 1,
      timings: flag('live-timings') ? LIVE_SPEAK_TIMINGS : SPEAK_TIMINGS, playMs: 5000});
    try {
      await scenario.start();
      if (what === 'scene') await scenario.scene({sceneMs: 7000}); else await scenario.source({kind: what === 'talk' ? 'talk' : 'speakup', follow: what === 'talk' ? 'talk' : 'companion'});
      await scenario.waitFor(() => scenario.done, 'the round to finish', 600000);
      const events = await scenario.events(), trail = scenario.trail;
      if (route === 'text') {
        const ended = what === 'scene' ? scenario.sceneEndedAt : trail.find(row => row.event === 'ended')?.t;
        const wanted = what === 'scene' ? JUDY.key : JOHNNY.key;
        return trail.find(row => row.event === 'admitted' && row.profile === wanted && row.t >= ended)?.t - ended;
      }
      return what === 'scene' ? events.find(row => row.event === 'play-start' && row.characterId === JUDY.characterId).t - scenario.sceneEndedAt : gapBetween(events, JUDY, JOHNNY);
    } finally { await scenario.stop(); }
  }
  const rounds = option('rounds', 2), results = {serial: [], prepared: []};
  for (let at = 0; at < rounds; at++) for (const mode of ['serial', 'prepared']) results[mode].push(await round(mode === 'prepared'));
  for (const mode of ['serial', 'prepared']) summarize(`fixture-${label}-${mode}`, results[mode]);
  console.log(JSON.stringify({note: 'SIMULATED provider timings (bridge/speak-up-fixture.mjs), not a live measurement'
    + (route === 'text' ? '; text route: the figure is the time until the line is published to the game, the voice start-up is not modelled' : '')}));
} else if (flag('fixture')) {
  const {measureRound, LIVE_TIMINGS} = await import(pathToFileURL(resolve(project, 'bridge/group-lookahead-fixture.mjs')).href);
  // --key shared (default) | player-paid | player-free: which key the simulated bridge runs on (the plan is never read from Convai).
  // --live-timings: provider delays shaped like the 2026-10-17 live round on a player's key (about 7 s per speaker that is not prepared).
  const keyName = args.includes('--key') ? args[args.indexOf('--key') + 1] : 'shared';
  const playerKey = keyName === 'player-paid' ? {connections: 6} : keyName === 'player-free' ? {connections: 1} : null;
  const options = {playerKey, speakers: option('speakers', 3), ...(flag('live-timings') ? {timings: LIVE_TIMINGS} : {})};
  const rounds = option('rounds', 2), results = {serial: [], lookahead: []};
  for (let at = 0; at < rounds; at++) for (const mode of ['serial', 'lookahead']) {
    results[mode].push(...(await measureRound({...options, mode})).gaps.map(row => row.gapMs));
  }
  for (const mode of ['serial', 'lookahead']) summarize(`fixture-${keyName}-${mode}`, results[mode]);
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
