import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {derivedPicks, parseLog, PickStore, readPicks, replayPicks} from './picks.mjs';

test('replay rebuilds candidates, history, kept, rejected, notes and plays', () => {
  const log = [
    {seq: 1, ts: 't1', voice: 'a', set: 'pocket', action: 'reroll', clips: ['a/1', 'a/2'], seconds: 8},
    {seq: 2, ts: 't2', voice: 'a', set: 'pocket', action: 'manual-set', clips: ['a/3'], seconds: 4},
    {seq: 3, ts: 't3', voice: 'a', engine: 'pocket', action: 'keep', clips: ['a/3'], seconds: 4, note: 'good'},
    {seq: 4, ts: 't4', voice: 'a', engine: 'omni', action: 'keep', clips: ['a/1', 'a/2']},
    {seq: 5, ts: 't5', voice: 'a', engine: 'omni', action: 'unkeep', clips: ['a/1', 'a/2']},
    {seq: 6, ts: 't6', voice: 'a', set: 'pocket', action: 'reject', clips: ['a/3'], note: 'no'},
    {seq: 7, ts: 't7', voice: 'a', action: 'note', note: 'hello'},
    {seq: 8, ts: 't8', voice: 'a', action: 'play', what: 'sample', target: 'omni16'},
    {seq: 9, ts: 't9', voice: 'a', action: 'play', what: 'sample', target: 'omni16'},
  ];
  const state = replayPicks(log), row = state.voices.a;
  assert.deepEqual(row.candidate.pocket, ['a/3']);
  assert.equal(row.candidate.omni, null);                         // each engine variant has its own set
  assert.deepEqual(row.history.pocket.map(item => item.clips.join()), ['a/3', 'a/1,a/2']);
  assert.deepEqual(Object.keys(row.kept), ['pocket']);
  assert.equal(row.kept.pocket.note, 'good');
  assert.equal(row.rejected.length, 1);
  assert.equal(row.note, 'hello');
  assert.equal(row.plays['sample:omni16'], 2);
  assert.equal(state.lastSeq, 9);
  assert.equal(derivedPicks(state).voices.a.kept.pocket.clips[0], 'a/3');
});

test('a torn last line does not stop the replay', () => {
  assert.equal(parseLog('{"voice":"a","action":"note","note":"x"}\n{"voice":').length, 1);
});

test('the store appends in order, survives restarts and writes the derived json', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'picks-'));
  const logPath = join(dir, 'p.jsonl'), jsonPath = join(dir, 'p.json');
  const store = new PickStore({logPath, jsonPath});
  await store.load();
  await Promise.all([store.append({voice: 'a', set: 'full', action: 'reroll', clips: ['a/1']}),
    store.append({voice: 'a', engine: 'pocket', action: 'keep', clips: ['a/1']})]);
  const lines = (await readFile(logPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(lines.map(line => line.seq), [1, 2]);
  assert.ok(lines[0].ts && lines[0].voice === 'a' && lines[1].engine === 'pocket');
  assert.deepEqual((await readPicks(logPath)).voices.a.kept.pocket.clips, ['a/1']);
  assert.deepEqual(JSON.parse(await readFile(jsonPath, 'utf8')).voices.a.kept.pocket.clips, ['a/1']);
  const next = new PickStore({logPath, jsonPath});
  await next.load();
  await next.append({voice: 'a', action: 'note', note: 'n'});
  assert.equal(next.state.lastSeq, 3);
});

test('verdicts, undoing a rejection, per-column play counts and old shared-set lines', () => {
  const state = replayPicks([
    {seq: 1, ts: 't1', voice: 'a', action: 'verdict', verdict: 'bad', line: 1},
    {seq: 2, ts: 't2', voice: 'a', set: 'omni', action: 'reject', clips: ['a/1']},
    {seq: 3, ts: 't3', voice: 'a', set: 'omni', action: 'unreject', clips: ['a/1']},
    {seq: 4, ts: 't4', voice: 'a', action: 'play', what: 'sample', target: 'omni16'},
    {seq: 5, ts: 't5', voice: 'a', action: 'play', what: 'sample', target: 'omni16'},
    {seq: 6, ts: 't6', voice: 'a', action: 'play', what: 'research', target: 'omni__s16_g2'},                // old log line: counted, not listed
    {seq: 7, ts: 't7', voice: 'b', set: 'full', action: 'reroll', clips: ['b/1']},                 // older log: one shared set
    {seq: 8, ts: 't8', voice: 'b', action: 'verdict', verdict: 'fine'},
    {seq: 9, ts: 't9', voice: 'b', action: 'verdict', verdict: ''},
  ]);
  assert.equal(state.voices.a.verdict.value, 'bad');
  assert.equal(state.voices.a.rejected.length, 0);
  assert.deepEqual([state.voices.b.candidate.pocket, state.voices.b.candidate.omni], [['b/1'], ['b/1']]);
  assert.equal(state.voices.b.verdict, null);
  const derived = derivedPicks(state);
  assert.deepEqual(derived.voices.a.topColumns, [{column: 'sample:omni16', plays: 2}]);
  assert.equal(derived.columnPlays['sample:omni16'], 2);
  assert.equal(derived.voices.a.verdict.value, 'bad');
});

test('there are exactly three sets, measured by duration (no clip counts)', async () => {
  const {ENGINES, SETS} = await import('./picks.mjs');
  assert.deepEqual(Object.keys(SETS), ['pocket', 'omni-short', 'omni']);
  assert.deepEqual(ENGINES, ['pocket', 'omni-short', 'omni']);
  assert.deepEqual(Object.values(SETS).map(set => set.budget), [30, 10, 18]);
  assert.ok(Object.values(SETS).every(set => !('count' in set)));
});

test('old log lines that name removed sets or the old ids still replay', () => {
  const state = replayPicks([
    {seq: 1, ts: 't1', voice: 'a', engine: 'pocket-short', set: 'pocket-short', action: 'reroll', clips: ['a/1', 'a/2']},     // removed set: ignored
    {seq: 2, ts: 't2', voice: 'a', engine: 'omni-single', set: 'omni-single', action: 'manual-set', clips: ['a/3']},
    {seq: 3, ts: 't3', voice: 'a', engine: 'pocket-single', set: 'pocket-single', action: 'keep', clips: ['a/3']},
    {seq: 4, ts: 't4', voice: 'a', engine: 'omni-single', action: 'unkeep', clips: ['a/3']},
    {seq: 5, ts: 't5', voice: 'a', set: 'pocket-short', action: 'reject', clips: ['a/1']},
    {seq: 6, ts: 't6', voice: 'a', set: 'pocket-short', action: 'unreject', clips: ['a/1']},
    {seq: 7, ts: 't7', voice: 'a', engine: 'omni', set: 'full', action: 'manual-set', clips: ['a/4', 'a/5']},                  // old shared id: Pocket and Omni
    {seq: 8, ts: 't8', voice: 'a', engine: 'omni-short', set: 'short', action: 'keep', clips: ['a/6']},
    {seq: 9, ts: 't9', voice: 'a', engine: 'omni-short', set: 'short', action: 'reroll', clips: ['a/6']},
    {seq: 10, ts: 't10', voice: 'a', engine: 'omni', set: 'full', action: 'keep', clips: ['a/4', 'a/5']},
    {seq: 11, ts: 't11', voice: 'a', action: 'regenerate', slots: ['pocket1', 'omni16one'], sets: {'omni-single': ['a/3']}},
  ]);
  const row = state.voices.a;
  assert.deepEqual(Object.keys(row.candidate), ['pocket', 'omni-short', 'omni']);
  assert.deepEqual([row.candidate.pocket, row.candidate.omni, row.candidate['omni-short']], [['a/4', 'a/5'], ['a/4', 'a/5'], ['a/6']]);
  assert.deepEqual(Object.keys(row.kept).sort(), ['omni', 'omni-short']);
  assert.equal(row.rejected.length, 0);
  assert.equal(state.entries, 11);
});
