// Two things from the live test of 31 Oct 2026 (docs/STORY_PACKS_INACTIVE.md):
//   1. the development fast switch: runtime/story-packs-dev-fast.flag (bridge/story-packs-gate.mjs storyPacksFast), which only works while the story packs switch is on, and what it does to
//      the runner (no quiet days, no daily rolls, a start chance of 1, said once in the log);
//   2. a pack brought on over the phone or a holocall with her beside V or far away has no clock at all (owner decision 1 Nov 2026): the stage that used to run out in 2 game
//      hours unseen stays open for as long as V takes.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, writeFileSync, rmSync, readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {configureStoryPacksGate, resetStoryPacksGate, storyPacksAvailable, storyPacksFast, STORY_PACKS_ENV, STORY_PACKS_FLAG, STORY_PACKS_FAST_ENV, STORY_PACKS_FAST_FLAG} from './story-packs-gate.mjs';
import {BondPacks, DAILY_ROLLS, COOLDOWN_DAYS} from './bond-pack-runner.mjs';
import {shippedPacks} from './bond-packs.mjs';
import {parseJournalHistory} from './journal-history.mjs';

const DAY = 86400, HOUR = 3600;
const read = file => readFileSync(new URL(file, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const roster = new Set(JSON.parse(read('../characters/roster.json')).map(row => row.key));
const school = shippedPacks().map(({pack}) => pack).find(pack => pack.id === 'panam-driving-school');
const T0 = 40 * DAY;

test('the fast switch is off by default, needs the story packs switch, and each of the flag file and the environment variable turns it on (found once)', () => {
  const folder = mkdtempSync(path.join(tmpdir(), 'story-fast-'));
  try {
    delete process.env[STORY_PACKS_ENV]; delete process.env[STORY_PACKS_FAST_ENV];
    resetStoryPacksGate();
    assert.equal(storyPacksFast(), false, 'nothing configured');
    configureStoryPacksGate({runtime: folder, env: {}});
    writeFileSync(path.join(folder, STORY_PACKS_FAST_FLAG), '');
    assert.equal(storyPacksFast(), false, 'the fast file alone does nothing: the story packs switch is off');
    configureStoryPacksGate({runtime: folder, env: {[STORY_PACKS_FAST_ENV]: '1'}});
    assert.equal(storyPacksFast(), false, 'the fast variable alone does nothing either');
    writeFileSync(path.join(folder, STORY_PACKS_FLAG), '');
    configureStoryPacksGate({runtime: folder, env: {}});
    assert.equal(storyPacksAvailable(), true);
    assert.equal(storyPacksFast(), true, 'both files');
    rmSync(path.join(folder, STORY_PACKS_FAST_FLAG));
    assert.equal(storyPacksFast(), true, 'the answer is found once and kept: no polling');
    configureStoryPacksGate({runtime: folder, env: {}});
    assert.equal(storyPacksFast(), false, 'the dev flag without the fast file');
    configureStoryPacksGate({runtime: folder, env: {[STORY_PACKS_FAST_ENV]: '1'}});
    assert.equal(storyPacksFast(), true, 'the dev flag and the fast variable');
    configureStoryPacksGate({runtime: folder, env: {[STORY_PACKS_FAST_ENV]: '0'}});
    assert.equal(storyPacksFast(), false, 'only 1 turns it on');
  } finally {
    rmSync(folder, {recursive: true, force: true});
    resetStoryPacksGate();
  }
});

const coverage = {status: 'complete', ageSeconds: 1, windowSeconds: 30, observed: 1, omitted: 0, unstable: false};
const journal = () => parseJournalHistory({version: 1, status: 'ready', generation: 1, capturedAtMs: 2000, worldToken: 'w1', tracked: {status: 'untracked'},
  coverage: {active: coverage, history: coverage},
  quests: [{id: '100', nativeId: 'sq004_riders_on_the_storm', nativePath: 'quests/side_quest/sq004_riders_on_the_storm', title: 'Quest', state: 'succeeded', lane: 'history',
    observedAtMs: 1000, objectivesComplete: true, objectives: []}]});
let counter = 0;
const holocall = {version: 1, contact: 'panam-palmer', mode: 'audio'};
const turn = (how, gameSeconds, text = 'hey') => ({requestId: `f-${++counter}`, profileKey: 'panam-palmer', name: 'Panam', text, entity: 'e1', turnContext: {gameTime: gameSeconds},
  journalHistory: journal(), ...(how === 'holocall' ? {holocall} : how === 'phone' ? {channel: 'phone'} : {}),
  bonds: {on: true, copy: how === 'own' ? 'party' : null, packs: true, invitations: true}});
const make = (options = {}) => {
  const lines = [], files = new Map();
  const runner = new BondPacks({packs: [school], characters: roster, random: () => 0.99, log: line => lines.push(line), write: async (file, text) => { files.set(file, text); },
    read: async file => { if (!files.has(file)) throw new Error('none'); return files.get(file); }, path: 'packs.json', effectsPath: 'effects.json', debounceMs: 0, ...options});
  runner.on = true;
  return {runner, lines, files};
};
const talk = (runner, input, facts = {level: 6}) => { const decision = runner.forTurn(input, facts); runner.afterTurn(input, undefined); return decision; };
const entryOf = runner => runner.entries.get('panam-driving-school');
const stateWith = meta => JSON.stringify({version: 1, entries: {}, meta: {'panam-palmer': meta}, settings: {packs: true, reach: true}, reach: {triggers: {}, fired: []}});

test('a start chance that fails the dice never starts a pack without fast, and starts it on the very next eligible turn with it', () => {
  const normal = make();
  talk(normal.runner, turn('holocall', T0));
  assert.equal(entryOf(normal.runner), undefined, 'the dice said no (random 0.99 against 0.35)');
  assert.equal(normal.lines.some(line => /dev fast mode/.test(line)), false);
  const fast = make({fast: true});
  talk(fast.runner, turn('holocall', T0));
  assert.equal(entryOf(fast.runner)?.status, 'active', 'fast: chance 1');
  assert.equal(fast.lines.filter(line => /dev fast mode/.test(line)).length, 1, 'said once, at the start');
  talk(fast.runner, turn('holocall', T0 + 60));
  assert.equal(fast.lines.filter(line => /dev fast mode/.test(line)).length, 1, 'not on every turn');
});

test('fast skips the quiet days after a quest and the rolls of the day used up; without it both hold', async () => {
  const meta = {rolled: Math.floor(T0 / DAY), rolls: DAILY_ROLLS, idle: 0, endedAt: T0 - HOUR, talkedAt: T0 - 60};
  for (const fast of [false, true]) {
    const {runner, files} = make({fast});
    files.set('packs.json', stateWith(meta));
    await runner.load();
    talk(runner, turn('holocall', T0));
    if (fast) assert.equal(entryOf(runner)?.status, 'active', `the ${COOLDOWN_DAYS} quiet days and the ${DAILY_ROLLS} rolls are skipped`);
    else assert.equal(entryOf(runner), undefined, 'the quiet days hold');
  }
  // Only the rolls used up (no quest ended): the rolls hold without fast.
  const rolls = make();
  rolls.files.set('packs.json', stateWith({...meta, endedAt: null}));
  await rolls.runner.load();
  talk(rolls.runner, turn('holocall', T0));
  assert.equal(entryOf(rolls.runner), undefined);
});

test('fast keeps the gate: a pack whose requirements are not met still waits', () => {
  const {runner} = make({fast: true});
  talk(runner, turn('holocall', T0), {level: 1});
  assert.equal(entryOf(runner), undefined, 'bond level 1 is below the pack\'s bond 5');
});

test('begun on a holocall with her beside V or far away: no clock, no wait, no travel allowance, the stage stays open for as long as V takes, and the state has none to keep', async () => {
  const {runner, files} = make({random: () => 0});
  talk(runner, turn('holocall', T0), {level: 6, near: true});
  const step = entryOf(runner).trail.at(-1);
  assert.deepEqual(Object.keys(step).sort(), ['at', 'stage'], 'a trail step has no grace, wait or clock fields');
  const dare = runner.playState().quests[0];
  assert.deepEqual(dare.do.map(spec => spec.p), ['pin'], 'nothing is added to bring her to V');
  assert.equal(dare.timeoutAt, undefined, 'and the game is told no timeout');
  for (const hours of [3, 12, 24 * 30]) {
    talk(runner, turn('holocall', T0 + hours * HOUR, 'one moment'), {level: 6, near: true});
    assert.equal(entryOf(runner).trail.at(-1).stage, 'dare', `still open after ${hours} game hours`);
  }
  await runner.flush();
  const again = make({random: () => 0, read: async file => files.get(file)}).runner;
  await again.load();
  assert.equal(again.entries.get('panam-driving-school').trail.at(-1).stage, 'dare', 'kept across a restart of the bridge');
  assert.equal(entryOf(runner).status, 'active');
});

test('a phone chat with her beside V, in person and far away all start the same way, none with a clock', () => {
  for (const [how, facts] of [['phone', {level: 6, near: true}], ['own', {level: 6, near: true}], ['holocall', {level: 6}]]) {
    const one = make({random: () => 0});
    talk(one.runner, turn(how, T0), facts);
    const keys = Object.keys(entryOf(one.runner).trail.at(-1));
    for (const field of ['grace', 'wait', 'unshown', 'shownAt']) assert.equal(keys.includes(field), false, `${how}: no ${field}`);
    assert.equal(one.runner.playState().quests[0].timeoutAt, undefined, how);
  }
});
