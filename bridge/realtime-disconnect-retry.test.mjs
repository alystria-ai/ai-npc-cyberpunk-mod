import {test} from 'node:test';
import assert from 'node:assert/strict';
import {RealtimeHost, arrivedNothing, connectionLost} from './realtime-host.mjs';
import {TransportPool} from './transport-pool.mjs';

// 2026-10-22 report 92f464e9 (4th sighting of "Convai realtime connection closed", 3 installs, 3 versions): Convai closed the connection under a text turn before any of the reply had
// arrived and the turn failed. Owner decision: ask once more on a fresh connection when nothing had arrived; never after partial text or audio (nothing is spoken or written twice);
// never an extra look or wait on a normal turn. These tests run the real host and pool against pages that do no network or browser work.
const CLOSED = 'page.evaluate: Error: Convai realtime connection closed';
const NOTHING = {version: 1, activeTurn: false, turn: null, previousTurn: {textCharacters: 0, llmRows: 0, outputRows: 0, messageEvents: 1, userTextCharacters: 0,
  audio: {byteCount: 0, packetCount: 0, frameCount: 0}}};
const PARTIAL_TEXT = {...NOTHING, previousTurn: {...NOTHING.previousTurn, textCharacters: 14, llmRows: 1}};
const PARTIAL_AUDIO = {...NOTHING, previousTurn: {...NOTHING.previousTurn, audio: {byteCount: 9600, packetCount: 2, frameCount: 4}}};

function fixture({replies = [], diagnostics = () => NOTHING} = {}) {
  const logs = [], looks = [], admissions = [];
  const host = new RealtimeHost({log: line => logs.push(line)}), pages = [];
  host.start = async () => {};
  host.guard = {check() {}, consume(config) { admissions.push(config.endUserId); }};
  host.pool = new TransportPool({limit: 11, create: async key => {
    const page = {key, closed: false, replies: 0, index: pages.length,
      isClosed() { return this.closed; },
      context: () => ({grantPermissions: async () => {}, clearPermissions: async () => {}}),
      url: () => 'http://127.0.0.1:4321/',
      async evaluate(_fn, payload) {
        if (payload?.method === 'reply' || payload?.method === 'warm' || payload?.method === 'beginVoice') {
          this.replies++;
          const next = replies.shift();
          if (next === 'closed') throw Error(CLOSED);
          if (next === 'failed') throw Error('page.evaluate: Error: Convai realtime connection failed');
          if (typeof next === 'string') throw Error(next);
          return {text: 'Reply', sessionID: 'session-' + this.index, timing: {}};
        }
        // The page's diagnostics (window.convaiRealtime.diagnostics()), asked for only after a closed connection.
        looks.push(this.index);
        return await diagnostics(this);
      }};
    pages.push(page); return page;
  }, dispose: async page => { if (page) page.closed = true; }});
  return {host, pages, logs, looks, admissions};
}
const route = (user, extra = {}) => ({characterId: 'npc-sixth-street-male', endUserId: user, scope: 'private', ttsEnabled: false, ...extra});

test('a connection Convai closed before any of the reply arrived is opened again and the turn is asked once more, with one admission', async () => {
  const {host, pages, logs, looks, admissions} = fixture({replies: ['closed']});
  const turn = await host.reply(route('resident-a'));
  assert.equal(turn.text, 'Reply');
  assert.equal(pages.length, 2, 'a fresh page and connection for the second try');
  assert.equal(pages[0].closed, true, 'the page whose connection was closed is discarded');
  assert.deepEqual(admissions, ['resident-a'], 'the budget (one admission per turn) is not charged twice');
  assert.deepEqual(looks, [0], 'one look at the failed page');
  assert.equal(logs.length, 1); assert.match(logs[0], /closed the connection before the reply began/);
  assert.doesNotMatch(logs[0], /resident|npc|sixth/i, 'a log line names no character or player');
  await host.close();
  // "failed" (the connection's error event) is the same.
  const failed = fixture({replies: ['failed']});
  assert.equal((await failed.host.reply(route('resident-a'))).text, 'Reply');
  assert.equal(failed.pages.length, 2);
  await failed.host.close();
});

test('only once: a second closed connection fails the turn as before', async () => {
  const {host, pages} = fixture({replies: ['closed', 'closed', 'closed']});
  await assert.rejects(host.reply(route('resident-a')), /Convai realtime connection closed/);
  assert.equal(pages.length, 2, 'two connections in all, never a third');
  await host.close();
});

test('never after part of the reply arrived: partial text or partial audio fails the turn at once, so nothing is spoken twice', async () => {
  for (const partial of [PARTIAL_TEXT, PARTIAL_AUDIO]) {
    const {host, pages, logs} = fixture({replies: ['closed'], diagnostics: () => partial});
    await assert.rejects(host.reply(route('resident-a')), /Convai realtime connection closed/);
    assert.equal(pages.length, 1, 'no second connection'); assert.equal(logs.length, 0);
    await host.close();
  }
});

test('when the page cannot say (it is gone, slow or has no diagnostics) the turn is not asked again', async () => {
  for (const diagnostics of [() => { throw Error('page.evaluate: Target closed'); }, () => undefined, () => new Promise(() => {})]) {
    const {host, pages} = fixture({replies: ['closed'], diagnostics});
    const started = Date.now();
    await assert.rejects(host.reply(route('resident-a')), /Convai realtime connection closed/);
    assert.equal(pages.length, 1);
    assert.ok(Date.now() - started < 3000, 'the look is capped at a second');
    await host.close();
  }
});

test('a normal turn costs no look at the page and no wait; other failures, aborts, warm-ups, speculative turns and the microphone are not asked again', async () => {
  const normal = fixture();
  assert.equal((await normal.host.reply(route('resident-a'))).text, 'Reply');
  assert.deepEqual(normal.looks, [], 'diagnostics are never read on the way to a reply');
  assert.equal(normal.pages.length, 1); assert.equal(normal.logs.length, 0);
  await normal.host.close();
  // Another failure of the page call: not this rule's business.
  const other = fixture({replies: ['Convai audio arrived from an unverified participant']});
  await assert.rejects(other.host.reply(route('resident-a')), /unverified participant/);
  assert.equal(other.pages.length, 1); assert.deepEqual(other.looks, []);
  await other.host.close();
  // A warm-up has nothing to ask again and a speculative turn (prepare, discarded) has nobody waiting. A microphone turn (beginVoice/finishVoice) never goes through run(): the speech cannot be sent again.
  for (const call of [host => host.warm(route('resident-a')), host => host.prepare({characterId: 'npc-sixth-street-male', ttsEnabled: false})]) {
    const f = fixture({replies: ['closed']});
    await assert.rejects(call(f.host), /Convai realtime connection closed/);
    assert.equal(f.pages.length, 1); assert.deepEqual(f.looks, []);
    await f.host.close();
  }
  // A cancelled turn is never asked again.
  const controller = new AbortController();
  const aborted = fixture({replies: ['closed'], diagnostics: async () => { controller.abort(); return NOTHING; }});
  await assert.rejects(aborted.host.reply(route('resident-a'), {signal: controller.signal}));
  assert.equal(aborted.pages.length, 1);
  await aborted.host.close();
});

test('arrivedNothing and connectionLost: which diagnostics and which errors count', () => {
  assert.equal(arrivedNothing(NOTHING), true);
  assert.equal(arrivedNothing({turn: null, previousTurn: null}), true, 'lost while connecting: no turn yet');
  assert.equal(arrivedNothing({turn: {textCharacters: 0, llmRows: 0, outputRows: 0, audio: null}}), true);
  assert.equal(arrivedNothing(PARTIAL_TEXT), false);
  assert.equal(arrivedNothing(PARTIAL_AUDIO), false);
  assert.equal(arrivedNothing({...NOTHING, previousTurn: {...NOTHING.previousTurn, outputRows: 1}}), false);
  assert.equal(arrivedNothing({...NOTHING, previousTurn: {...NOTHING.previousTurn, llmRows: 1}}), false);
  assert.equal(arrivedNothing({...NOTHING, wire: {acceptedAudioEvents: 12}}), true, 'audio of an EARLIER turn on a reused connection says nothing about this one');
  for (const unknown of [undefined, null, 'x', 0]) assert.equal(arrivedNothing(unknown), false);
  for (const message of [CLOSED, 'Convai realtime connection closed', 'Convai realtime connection failed']) assert.equal(connectionLost(Error(message)), true, message);
  for (const message of ['Conversation cancelled', 'Convai character did not become ready', 'Convai usage limit reached [convai-quota:daily]', '']) assert.equal(connectionLost(Error(message)), false, message);
  assert.equal(connectionLost(undefined), false);
});
