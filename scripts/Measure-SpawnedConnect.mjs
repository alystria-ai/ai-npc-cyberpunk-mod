// Measures the first talk to a character another mod or a spawner created (docs/SPAWNED_CHARACTERS.md): the time from V's line to the
// first audio, with and without the connection having been opened ahead when the game first listed the character near V.
//
//   node scripts/Measure-SpawnedConnect.mjs [--rounds N]
//
// Offline only: the real convai-bridge.mjs against a simulated game and provider (bridge/group-lookahead-fixture.mjs), provider delays
// shaped like the 2026-10-17 live round (a fresh connection 3.5 s, then the reply). It contacts nothing and prints timings only.
import {fileURLToPath, pathToFileURL} from 'node:url';
import {dirname, resolve} from 'node:path';

process.env.CYBERPUNK_CONVAI_TEST_LEASE_MS ??= '60000';
const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const rounds = args.includes('--rounds') ? Number(args[args.indexOf('--rounds') + 1]) : 1;
const {measureTalk, LIVE_TIMINGS} = await import(pathToFileURL(resolve(project, 'bridge/group-lookahead-fixture.mjs')).href);
const JUDY = 'judy-alvarez', PANAM = 'panam-palmer', ALEX = 'alex';
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

const cases = [
  ['own key, paid plan, listed ahead', {playerKey: {connections: 6}, spawned: [JUDY], expectWarms: 1}],
  ['own key, paid plan, no hint (before)', {playerKey: {connections: 6}}],
  ['own key, free plan, listed (nothing opens)', {playerKey: {connections: 1}, spawned: [JUDY]}],
  ['shared key, listed ahead', {spawned: [JUDY], expectWarms: 1}],
  ['shared key, no hint (before)', {}],
  ['own key, paid plan, party Judy also spawned', {playerKey: {connections: 6}, party: [JUDY], spawned: [JUDY, PANAM], expectWarms: 2}],
  ['own key, paid plan, three spawned', {playerKey: {connections: 6}, spawned: [JUDY, PANAM, ALEX], expectWarms: 3}],
  ['own key, plan of 2, three spawned', {playerKey: {connections: 2}, spawned: [JUDY, PANAM, ALEX], expectWarms: 1}],
];
const results = await Promise.all(cases.map(async ([label, options]) => {
  const runs = [];
  for (let at = 0; at < rounds; at++) runs.push(await measureTalk({timings: LIVE_TIMINGS, ...options}));
  return {label, opened: runs[0].opened, connectedWarm: runs[0].connectedWarm,
    firstAudioMs: runs.map(row => Math.round(row.firstAudioMs)), medianMs: Math.round(median(runs.map(row => row.firstAudioMs)))};
}));
for (const row of results) console.log(JSON.stringify(row));
