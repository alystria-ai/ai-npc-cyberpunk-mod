import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {derivedPicks, parseLog, PickStore, readPicks, replayPicks} from './picks.mjs';

test('replay rebuilds candidates, history, kept, rejected, notes and plays', () => {
  const log = [
    {seq: 1, ts: 't1', voice: 'a', set: 'full', action: 'reroll', clips: ['a/1', 'a/2'], seconds: 8},
    {seq: 2, ts: 't2', voice: 'a', set: 'full', action: 'manual-set', clips: ['a/3'], seconds: 4},
    {seq: 3, ts: 't3', voice: 'a', engine: 'pocket', action: 'keep', clips: ['a/3'], seconds: 4, note: 'good'},
    {seq: 4, ts: 't4', voice: 'a', engine: 'omni', action: 'keep', clips: ['a/1', 'a/2']},
    {seq: 5, ts: 't5', voice: 'a', engine: 'omni', action: 'unkeep', clips: ['a/1', 'a/2']},
    {seq: 6, ts: 't6', voice: 'a', set: 'full', action: 'reject', clips: ['a/3'], note: 'no'},
    {seq: 7, ts: 't7', voice: 'a', action: 'note', note: 'hello'},
    {seq: 8, ts: 't8', voice: 'a', action: 'play', what: 'sample', target: 'omni16'},
    {seq: 9, ts: 't9', voice: 'a', action: 'play', what: 'sample', target: 'omni16'},
  ];
  const state = replayPicks(log), row = state.voices.a;
  assert.deepEqual(row.candidate.full, ['a/3']);
  assert.deepEqual(row.history.full.map(item => item.clips.join()), ['a/3', 'a/1,a/2']);
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
