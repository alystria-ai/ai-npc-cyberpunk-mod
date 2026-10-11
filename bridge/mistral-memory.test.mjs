import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {MistralMemory, MEMORY_LIMITS} from './mistral-memory.mjs';

const fresh = (options = {}) => MistralMemory.open({path: null, ...options});
const exchange = (memory, key, count, extra = {}) => { for (let i = 0; i < count; i++) memory.record({profileKey: key, v: `question ${i}`, r: `answer ${i}`, ...extra}); };

test('the history keeps the last turns per character and channel; the rest rolls into the overflow', async () => {
  const memory = await fresh();
  exchange(memory, 'judy-alvarez', 12);
  exchange(memory, 'judy-alvarez', 3, {channel: 'phone'});
  const recalled = memory.recall({profileKey: 'judy-alvarez', channel: 'private'});
  assert.equal(recalled.turns.length, MEMORY_LIMITS.turns);
  assert.equal(recalled.turns[0].v, 'question 4');
  assert.equal(recalled.turns.at(-1).r, 'answer 11');
  assert.equal(memory.recall({profileKey: 'judy-alvarez', channel: 'phone'}).turns.length, 3);
  assert.equal(memory.recall({profileKey: 'panam-palmer'}).turns.length, 0);
  assert.equal(memory.pendingSummary('judy-alvarez'), null, 'only 4 exchanges rolled out; a batch is 8');
});

test('lines are cleaned and capped, and an empty side is not recorded', async () => {
  const memory = await fresh();
  assert.equal(memory.record({profileKey: 'judy-alvarez', v: '  hi\u0000\n there  ', r: 'x'.repeat(2000)}), true);
  const [turn] = memory.recall({profileKey: 'judy-alvarez'}).turns;
  assert.equal(turn.v, 'hi there');
  assert(turn.r.length <= MEMORY_LIMITS.line);
  assert.equal(memory.record({profileKey: 'judy-alvarez', v: '', r: 'answer'}), false);
  assert.equal(memory.record({profileKey: 'Bad Key!', v: 'a', r: 'b'}), false);
  assert.equal(memory.record({profileKey: 'judy-alvarez', channel: 'nowhere', v: 'a', r: 'b'}), false);
});

test('older exchanges are folded into a summary in batches by the same model, and the summary is returned for private and phone, not group', async () => {
  const memory = await fresh();
  exchange(memory, 'panam-palmer', MEMORY_LIMITS.turns + MEMORY_LIMITS.batch);
  const batch = memory.pendingSummary('panam-palmer');
  assert.equal(batch.turns.length, MEMORY_LIMITS.batch);
  assert.equal(batch.turns[0].v, 'question 0');
  memory.beginSummary('panam-palmer');
  assert.equal(memory.pendingSummary('panam-palmer'), null, 'a second request does not start while one runs');
  assert.equal(memory.applySummary('panam-palmer', 'I told V about the Aldecaldos.', batch), true);
  assert.equal(memory.recall({profileKey: 'panam-palmer'}).summary, 'I told V about the Aldecaldos.');
  assert.equal(memory.recall({profileKey: 'panam-palmer', channel: 'phone'}).summary, 'I told V about the Aldecaldos.');
  assert.equal(memory.recall({profileKey: 'panam-palmer', channel: 'group'}).summary, '');
  assert.equal(memory.pendingSummary('panam-palmer'), null, 'the folded exchanges left the overflow');
});

test('a failed summary leaves the exchanges for a later try', async () => {
  const memory = await fresh();
  exchange(memory, 'panam-palmer', MEMORY_LIMITS.turns + MEMORY_LIMITS.batch);
  memory.beginSummary('panam-palmer');
  memory.failSummary('panam-palmer');
  assert.equal(memory.pendingSummary('panam-palmer').turns.length, MEMORY_LIMITS.batch);
});

test('the overflow is bounded; a group conversation never feeds the summary', async () => {
  const memory = await fresh();
  exchange(memory, 'jackie-welles', MEMORY_LIMITS.turns + MEMORY_LIMITS.overflow + 30);
  const batch = memory.pendingSummary('jackie-welles');
  assert.equal(batch.turns[0].v, 'question 30', 'the oldest exchanges beyond the overflow cap are dropped');
  const group = await fresh();
  exchange(group, 'jackie-welles', 40, {channel: 'group'});
  assert.equal(group.recall({profileKey: 'jackie-welles', channel: 'group'}).turns.length, MEMORY_LIMITS.turns);
  assert.equal(group.pendingSummary('jackie-welles'), null);
});

test('ordinary NPC conversations are remembered only in memory, bounded, and never written', async () => {
  const writes = [];
  const memory = await fresh({write: async (path, text) => writes.push([path, text])});
  exchange(memory, 'npc-food-vendor-male', 12, {ambientKey: 'vendor-1'});
  const recalled = memory.recall({profileKey: 'npc-food-vendor-male', ambientKey: 'vendor-1'});
  assert.equal(recalled.turns.length, MEMORY_LIMITS.turns);
  assert.equal(recalled.summary, '');
  assert.equal(memory.recall({profileKey: 'npc-food-vendor-male', ambientKey: 'vendor-2'}).turns.length, 0);
  for (let i = 0; i < MEMORY_LIMITS.ambient + 10; i++) memory.record({profileKey: 'npc-x', ambientKey: `npc-${i}`, v: 'a', r: 'b'});
  assert(memory.ambient.size <= MEMORY_LIMITS.ambient);
  await memory.flush();
  assert.equal(writes.length, 0);
  assert.equal(memory.size, 0);
});

test('forget clears one character or everything, and a summary requested before it is not applied after it', async () => {
  const memory = await fresh();
  exchange(memory, 'judy-alvarez', MEMORY_LIMITS.turns + MEMORY_LIMITS.batch);
  exchange(memory, 'panam-palmer', 3);
  exchange(memory, 'npc-x', 2, {ambientKey: 'a'});
  const batch = memory.pendingSummary('judy-alvarez');
  memory.beginSummary('judy-alvarez');
  assert.equal(memory.forget({profileKeys: ['judy-alvarez']}), 1);
  assert.equal(memory.applySummary('judy-alvarez', 'late summary', batch), false);
  assert.equal(memory.recall({profileKey: 'judy-alvarez'}).summary, '');
  assert.equal(memory.recall({profileKey: 'judy-alvarez'}).turns.length, 0);
  assert.equal(memory.recall({profileKey: 'panam-palmer'}).turns.length, 3);
  assert.equal(memory.recall({profileKey: 'npc-x', ambientKey: 'a'}).turns.length, 0, 'ordinary NPC conversations are cleared too');
  assert.equal(memory.forget({all: true}), 1);
  assert.equal(memory.size, 0);
});

test('the memory is saved to its file after a short delay, reloaded, and a forget is written at once', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'orm-'));
  try {
    const path = join(dir, 'mistral-memory.json');
    const memory = await MistralMemory.open({path});
    exchange(memory, 'judy-alvarez', 3);
    await memory.flush();
    const saved = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(saved.version, 1);
    assert.equal(saved.characters['judy-alvarez'].channels.private.length, 3);
    const again = await MistralMemory.open({path});
    assert.equal(again.recall({profileKey: 'judy-alvarez'}).turns[2].r, 'answer 2');
    again.forget({all: true});
    await again.flush();
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')).characters, {});
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test('a damaged, oversized or foreign memory file starts empty and rows with bad keys are skipped', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'orm-'));
  try {
    const path = join(dir, 'm.json');
    for (const text of ['not json', '[]', '{"version":2,"characters":{}}', '{"version":1}', JSON.stringify({version: 1, characters: {'Bad Key': {channels: {}}, ok: {summary: 's', channels: {private: [{v: 'a', r: 'b'}, {v: '', r: 'x'}]}}}})]) {
      await writeFile(path, text);
      const memory = await MistralMemory.open({path});
      if (text.includes('"ok"')) { assert.equal(memory.size, 1); assert.equal(memory.recall({profileKey: 'ok'}).turns.length, 1); }
      else assert.equal(memory.size, 0, text);
    }
    await writeFile(path, JSON.stringify({version: 1, characters: {ok: {summary: 'x'.repeat(MEMORY_LIMITS.fileBytes), channels: {}}}}));
    assert.equal((await MistralMemory.open({path})).size, 0);
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test('the number of remembered characters is bounded; the least recently talked-to go first', async () => {
  let clock = 0;
  const memory = await fresh({now: () => ++clock, limits: {...MEMORY_LIMITS, characters: 3}});
  for (const key of ['a1', 'b1', 'c1', 'd1']) exchange(memory, key, 1);
  assert.equal(memory.size, 3);
  assert.equal(memory.recall({profileKey: 'a1'}).turns.length, 0);
  assert.equal(memory.recall({profileKey: 'd1'}).turns.length, 1);
});
