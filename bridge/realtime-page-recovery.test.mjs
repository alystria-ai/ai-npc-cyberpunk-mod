import {test} from 'node:test';
import assert from 'node:assert/strict';
import {RealtimeHost, pageGone} from './realtime-host.mjs';
import {TransportPool} from './transport-pool.mjs';
import {PartyConnections} from './party-connections.mjs';

// 2026-10-20 report 94bc8efa4ebda288 ("convai: page.evaluate: Target page, context or browser has been closed"): two turns in a row, each about
// two seconds in, to two residents of the same profile. These tests run the real host and pool (and, for the first, the real party plan) against
// pages that do no network or browser work.
const flush = () => new Promise(done => setImmediate(done));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return {promise, resolve}; };
const GONE = 'page.evaluate: Target page, context or browser has been closed';

function fixture({onReply} = {}) {
  const logs = [];
  const host = new RealtimeHost({log: line => logs.push(line)}), pages = [];
  host.start = async () => {};
  host.pool = new TransportPool({limit: 11, create: async key => {
    const page = {key, closed: false, calls: [], index: pages.length,
      isClosed() { return this.closed; },
      context: () => ({grantPermissions: async () => {}, clearPermissions: async () => {}}),
      url: () => 'http://127.0.0.1:4321/',
      async evaluate(_fn, payload) {
        this.calls.push(payload);
        if (payload?.method === 'reply' || payload?.method === 'warm') {
          const result = await onReply?.(this, payload);
          if (this.closed) throw Error(GONE);
          return result ?? {text: 'Reply', sessionID: 'session-' + this.index, timing: {}};
        }
        return {ready: true};
      }};
    pages.push(page); return page;
  }, dispose: async page => { if (page) page.closed = true; }});
  return {host, pages, logs};
}

const route = (user, extra = {}) => ({characterId: 'npc-sixth-street-male', endUserId: user, scope: 'private', ttsEnabled: false, ...extra});

test('the party plan does not close the page of a turn it does not list (two residents of one profile, audio not ready)', async () => {
  const gate = deferred();
  const {host, pages} = fixture({onReply: () => gate.promise});
  let time = 100000;
  const connections = new PartyConnections({host, now: () => time, canWarm: () => false, isKnown: () => false,
    configFor: () => { throw Error('no named route'); }});
  connections.ingest({updated: time, profiles: []});
  // The game lists the resident V talked to before as the partner: that one route is in the plan, the other resident's is not.
  await connections.setAmbient({partners: ['npc-sixth-street-male'], routes: {'npc-sixth-street-male': route('resident-a')}});
  const turn = host.reply(route('resident-b'));
  await flush(); await flush();
  assert.equal(pages.length, 1);
  for (let poll = 0; poll < 3; poll++) { time += 150; await connections.maintain(); await flush(); }
  assert.equal(pages[0].closed, false, 'the page the turn is running on is still open');
  gate.resolve();
  assert.equal((await turn).text, 'Reply');
  assert.equal(pages.length, 1, 'no second page was needed');
  // After the turn the plan sweeps what it does not list, as before.
  await connections.maintain(); await flush();
  assert.equal(pages[0].closed, true);
  await host.close();
});

test('a pinned page is kept for a microphone turn too, and the sweep takes it once the turn is over', async () => {
  const {host, pages} = fixture();
  const config = route('resident-b');
  await host.beginVoice(config);
  await host.retain([], {protect: true});
  assert.equal(pages[0].closed, false);
  await host.finishVoice(undefined, undefined).catch(() => {});
  await host.retain([], {protect: true});
  assert.equal(pages[0].closed, true);
  await host.close();
});

test('a page that closed while idle is replaced instead of reused', async () => {
  const {host, pages} = fixture();
  const config = route('resident-a');
  assert.equal((await host.reply(config)).timing.pageReused, false);
  pages[0].closed = true;                                   // the renderer crashed or the browser was killed while the page sat idle
  const second = await host.reply(config);
  assert.equal(second.text, 'Reply');
  assert.equal(second.timing.pageReused, false);
  assert.equal(pages.length, 2);
  await host.close();
});

test('a page lost during a turn is opened again and the turn is asked once more; a second loss fails the turn', async () => {
  let losses = 0;
  const {host, pages, logs} = fixture({onReply: async page => { if (losses > 0 && page.index < losses) { losses--; page.closed = true; } }});
  losses = 1;
  const turn = await host.reply(route('resident-a'));
  assert.equal(turn.text, 'Reply');
  assert.equal(pages.length, 2); assert.equal(pages[0].closed, true); assert.equal(pages[1].closed, false);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /closed during a turn/);
  assert.doesNotMatch(logs[0], /resident|npc|sixth/i, 'a log line names no character or player');
  // Lost again on the second page: not asked a third time.
  const again = fixture({onReply: async page => { page.closed = true; }});
  await assert.rejects(again.host.reply(route('resident-a')), /has been closed/);
  assert.equal(again.pages.length, 2);
  await again.host.close(); await host.close();
});

test('a warm-up is asked again after a lost page, and a cancelled turn or a deliberate close is never asked again', async () => {
  const lost = fixture({onReply: async page => { if (page.index === 0) page.closed = true; }});
  assert.ok(await lost.host.warm(route('resident-a')));
  assert.equal(lost.pages.length, 2);
  await lost.host.close();
  const controller = new AbortController();
  const aborted = fixture({onReply: async page => { page.closed = true; await flush(); controller.abort(); }});
  await assert.rejects(aborted.host.reply(route('resident-a'), {signal: controller.signal}), {name: 'AbortError'});
  assert.equal(aborted.pages.length, 1);
  await aborted.host.close();
  // The host's own close (a world reset, a key change) ends a turn in flight as a cancellation, not as a failure to report.
  const gate = deferred();
  const closing = fixture({onReply: async () => { await gate.promise; }});
  const turn = closing.host.reply(route('resident-a'));
  await flush(); await flush();
  const closed = closing.host.close();
  gate.resolve();
  await assert.rejects(turn, {name: 'AbortError'});
  await closed;
  assert.equal(closing.pages.length, 1);
});

test('which errors mean the page or browser is gone', () => {
  for (const message of [GONE, 'Target closed', 'browserType.launch: Target closed', 'Page crashed', 'Target crashed',
    'page.evaluate: Execution context was destroyed, most likely because of a navigation', 'Browser has been closed']) {
    assert.equal(pageGone(Error(message)), true, message);
  }
  for (const message of ['Concurrency limit reached', 'Conversation cancelled', 'Invalid owned connect request', 'timeout', '']) {
    assert.equal(pageGone(Error(message)), false, message);
  }
  assert.equal(pageGone(undefined), false);
});
