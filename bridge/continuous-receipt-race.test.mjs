import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

// Execute the production cancellation and receipt helpers. The file boundary,
// clock and knowledge guard are fakes; no bridge startup, provider, game or
// microphone side effect is reachable from this fixture.
const source = readFileSync(new URL('./convai-bridge.mjs', import.meta.url), 'utf8');
const section = (start, end) => {
  const a = source.indexOf(start), b = source.indexOf(end, a);
  assert.ok(a >= 0 && b > a, `Missing production helper section: ${start}`);
  return source.slice(a, b);
};
const code = section('const knowledgeTurns =', 'async function cancelMicrophone(')
  + section('const deliveredReceipts =', 'async function pollKnowledge(');
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return {promise, resolve};
};
const flush = () => new Promise(done => setImmediate(done));
function fixture() {
  const f = {now: 100000, current: true, calls: [], readCount: 0, cancelled: new Set()};
  f.prepared = {route: {channel: 'group'}, input: {requestId: 'group-turn-1', entity: '13ULL', generation: 9, profileKey: 'judy-alvarez'}};
  f.receipt = {version: 1, id: 'speech-test-1', sequence: 1, source: 'continuous-playback',
    state: 'completed', backend: 'browser-pcm', partial: false, cancelled: false, ...f.prepared.input,
    completedAt: f.now, totalChunks: 1, completedChunks: 1};
  f.state = {updated: f.now, lastDelivery: f.receipt};
  const sandbox = {Date: {now: () => f.now},
    readSpeechState: async () => { f.readCount++; await f.onRead?.(); return f.state; },
    knowledgeRouter: {activity: async (prepared, kind, receipt) => {
      f.calls.push({prepared, kind, receipt});
      if (kind === 'cancelled-turn') { f.cancelled.add(prepared); return {status: 'cancelled'}; }
      await f.onActivity?.(prepared, kind, receipt);
      return f.current && !f.cancelled.has(prepared) ? {status: 'current'} : {status: 'unavailable'};
    }}};
  runInNewContext(code + ';globalThis.api={rememberKnowledgeTurn,stagedKnowledgeTurn,cancelKnowledgeTurn,recordDelivery,knowledgeTurns,deliveredReceipts,pendingDeliveryReceipts};', sandbox);
  f.api = sandbox.api;
  f.api.rememberKnowledgeTurn(f.prepared); f.api.stagedKnowledgeTurn(f.prepared);
  f.entry = f.api.knowledgeTurns.get(f.prepared.input.requestId);
  return f;
}

test('next group input after audible end preserves the exact delivered reply before cancellation', async () => {
  const f = fixture();
  await f.api.cancelKnowledgeTurn(f.prepared);
  assert.equal(f.entry.delivered, true); assert.equal(f.entry.cancelled, undefined);
  assert.deepEqual(f.calls.map(call => call.kind), ['delivered-reply']);
  assert.equal(f.calls[0].prepared, f.prepared); assert.equal(f.calls[0].receipt, f.receipt);
  await f.api.recordDelivery(f.receipt); await f.api.cancelKnowledgeTurn(f.prepared);
  assert.equal(f.calls.length, 1); assert.equal(f.api.deliveredReceipts.size, 1);
});

test('an ungenerated request cannot promote an otherwise matching game receipt', async () => {
  const f = fixture(); f.entry.generated = false;
  await f.api.cancelKnowledgeTurn(f.prepared);
  assert.equal(f.readCount, 0); assert.equal(f.entry.delivered, undefined); assert.equal(f.entry.cancelled, true);
  assert.deepEqual(f.calls.map(call => call.kind), ['cancelled-turn']);
});

test('foreign actor, generation and request receipts cannot save a replaced request', async () => {
  for (const change of [{entity: '14ULL'}, {generation: 10}, {requestId: 'other-turn'},
    {source: 'phone-ui', profileKey: 'panam-palmer'}, {source: 'unknown-backend'}]) {
    const f = fixture(); f.state.lastDelivery = {...f.receipt, ...change};
    await f.api.cancelKnowledgeTurn(f.prepared);
    assert.equal(f.entry.delivered, undefined, JSON.stringify(change)); assert.equal(f.entry.cancelled, true);
    assert.deepEqual(f.calls.map(call => call.kind), ['cancelled-turn']);
  }
});

test('stale, future and missing speech-state timestamps cannot count a delivery', async () => {
  for (const updated of [94999, 101501, undefined, null, '100000']) {
    const f = fixture(); f.state.updated = updated;
    await f.api.cancelKnowledgeTurn(f.prepared);
    assert.equal(f.entry.delivered, undefined, String(updated)); assert.equal(f.entry.cancelled, true);
    assert.deepEqual(f.calls.map(call => call.kind), ['cancelled-turn']);
  }
});

test('pending, partial and cancelled receipts cannot be promoted to completed playback', async () => {
  for (const change of [{state: 'playing'}, {partial: true}, {cancelled: true},
    {completedChunks: 0}, {version: 2}]) {
    const f = fixture(); f.state.lastDelivery = {...f.receipt, ...change};
    await f.api.cancelKnowledgeTurn(f.prepared);
    assert.equal(f.entry.delivered, undefined, JSON.stringify(change)); assert.equal(f.entry.cancelled, true);
    assert.deepEqual(f.calls.map(call => call.kind), ['cancelled-turn']);
  }
});

test('a world or memory guard rejection still cancels even with a matching completed receipt', async () => {
  const f = fixture(); f.current = false;
  await f.api.cancelKnowledgeTurn(f.prepared);
  assert.equal(f.entry.delivered, undefined); assert.equal(f.entry.cancelled, true);
  assert.deepEqual(f.calls.map(call => call.kind), ['delivered-reply', 'cancelled-turn']);
  assert.equal(f.api.deliveredReceipts.size, 0); assert.equal(f.api.pendingDeliveryReceipts.size, 0);
});

test('valid ordinary native and phone completion receipts keep their own delivery contracts', async () => {
  for (const mode of ['native', 'phone']) {
    const f = fixture();
    const receipt = {...f.receipt, source: mode === 'phone' ? 'phone-ui' : 'native-playback',
      state: mode === 'phone' ? 'accepted' : 'completed'};
    delete receipt.backend;
    if (mode === 'phone') {
      f.prepared.route.channel = 'phone';
      delete receipt.totalChunks; delete receipt.completedChunks;
    }
    await f.api.recordDelivery(receipt);
    assert.equal(f.entry.delivered, true, mode); assert.equal(f.entry.cancelled, undefined);
    assert.deepEqual(f.calls.map(call => call.kind), ['delivered-reply']);
  }
});

test('concurrent delivery poll and cancellation coalesce their identical completion receipt', async () => {
  const f = fixture(), gate = deferred(); f.onActivity = () => gate.promise;
  const poll = f.api.recordDelivery(f.receipt), cancel = f.api.cancelKnowledgeTurn(f.prepared);
  await flush();
  assert.deepEqual(f.calls.map(call => call.kind), ['delivered-reply']);
  assert.equal(f.api.pendingDeliveryReceipts.size, 1); assert.equal(f.entry.cancelled, undefined);
  gate.resolve(); await Promise.all([poll, cancel]);
  assert.equal(f.entry.delivered, true); assert.equal(f.entry.cancelled, undefined);
  assert.equal(f.api.deliveredReceipts.size, 1); assert.equal(f.api.pendingDeliveryReceipts.size, 0);
});

test('a reset during the concurrent delivery await cannot revive the cancelled request', async () => {
  const f = fixture(), gate = deferred(); f.onActivity = () => gate.promise;
  const poll = f.api.recordDelivery(f.receipt), cancel = f.api.cancelKnowledgeTurn(f.prepared);
  await flush(); f.current = false; gate.resolve(); await Promise.all([poll, cancel]);
  assert.equal(f.entry.delivered, undefined); assert.equal(f.entry.cancelled, true);
  assert.deepEqual(f.calls.map(call => call.kind), ['delivered-reply', 'cancelled-turn']);
  assert.equal(f.api.pendingDeliveryReceipts.size, 0); assert.equal(f.api.deliveredReceipts.size, 0);
});
