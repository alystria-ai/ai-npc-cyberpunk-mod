// bridge/media-host.mjs driving the real page engine (bridge/media-engine.mjs) on a stand-in audio context: loading in packets, playing, the registry of what plays, ducking under speech,
// stopping by id and by pack, replacing a sound, the idle release and a page that goes away. A real browser page is checked by media-browser.test.mjs where one can run.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {MediaHost, MEDIA_HOST, packetToBase64, panOf} from './media-host.mjs';
import {MediaEngine, base64ToFloat} from './media-engine.mjs';
import {MEDIA} from './media-mix.mjs';
import {FakeAudioContext} from './media-test-context.mjs';

const tone = (count, level = 0.4) => Float32Array.from({length: count}, (_, i) => level * Math.sin(i / 9));
const tick = () => new Promise(done => setImmediate(done));

function world({now = () => Date.now()} = {}) {
  const state = {context: null, engine: null, calls: [], closed: 0, opened: 0, onEvent: null, closeHandlers: []};
  const createPage = async ({onEvent}) => {
    state.opened++; state.onEvent = onEvent;
    state.context = new FakeAudioContext();
    state.engine = new MediaEngine({context: state.context, post: onEvent});
    return {
      evaluate: async (fn, argument) => { state.calls.push(argument.method); globalThis.window = {mediaPcm: state.engine}; return fn(argument); },
      close: async () => { state.closed++; }, on: (name, handler) => { if (name === 'close') state.closeHandlers.push(handler); },
    };
  };
  const host = new MediaHost({createPage, now, log: message => state.calls.push('log:' + message)});
  return {host, state};
}
const playOf = (key, samples, extra = {}) => ({pack: 'panam-sunset-coffee', id: 'bed', key, samples, rate: 48000, ...extra});

test('a sound is sent once in packets of two seconds, then played from the kept copy', async () => {
  const {host, state} = world();
  const samples = tone(MEDIA_HOST.packetFrames * 2 + 5000);
  const result = await host.play(playOf('k', samples, {loop: true, volume: 0.5}));
  assert.equal(result.played, true);
  assert.deepEqual(state.calls, ['begin', 'append', 'append', 'append', 'seal', 'play']);
  assert.equal(state.opened, 1);
  const kept = state.context.buffers[0];
  assert.equal(kept.length, samples.length); assert.ok(Math.abs(kept.data[1234] - samples[1234]) < 1e-3, 'the samples arrived');
  assert.equal(host.isLoaded('k'), true); assert.equal(host.count(), 1); assert.equal(host.busy, true);
  state.calls.length = 0;
  await host.play(playOf('k', undefined, {id: 'second', loop: true}));
  assert.deepEqual(state.calls, ['play'], 'the second play sends no samples');
  assert.equal(state.opened, 1, 'and no second page');
  assert.equal(host.count(), 2);
});

test('load sends a sound without playing it, and a sound that is not loaded and has no samples cannot play', async () => {
  const {host, state} = world();
  await host.load({key: 'door', samples: tone(4000)});
  assert.deepEqual(state.calls, ['begin', 'append', 'seal']);
  assert.equal(host.count(), 0); assert.equal(host.busy, false);
  await host.load({key: 'door', samples: tone(4000)});
  assert.equal(state.calls.length, 3, 'a sound already on the page is not sent again');
  await assert.rejects(host.play(playOf('missing', undefined)), /not loaded/);
  await Promise.all([host.load({key: 'same', samples: tone(500)}), host.load({key: 'same', samples: tone(500)})]);
  assert.equal(state.calls.filter(call => call === 'begin').length, 2, 'two loads of one sound at once send it once');
});

test('the end of a one-shot comes back as an event and clears the list; a loop stays', async () => {
  const {host, state} = world();
  await host.play(playOf('shot', tone(48000), {id: 'shot'}));
  await host.play(playOf('bed', tone(48000), {id: 'rain', loop: true}));
  assert.equal(host.count(), 2);
  state.context.advance(1.2);
  assert.equal(host.count(), 1);
  assert.deepEqual(host.packs(), ['panam-sunset-coffee']);
  host.onEvent({type: 'ended', id: 'never-seen'}); host.onEvent(null); host.onEvent({type: 'other'});
  assert.equal(host.count(), 1, 'events that name nothing known change nothing');
});

test('a sound the page reports as ended after a replacement does not remove the replacement', async () => {
  const {host, state} = world();
  await host.play(playOf('k', tone(48000), {id: 'bed', loop: true}));
  const first = [...host.items.values()][0].pageId;
  await host.play(playOf('k', undefined, {id: 'bed', loop: true}));
  assert.equal(host.count(), 1);
  state.context.advance(0.2);
  host.onEvent({type: 'ended', id: first});
  assert.equal(host.count(), 1, 'the id plays again, its old end changes nothing');
  assert.notEqual([...host.items.values()][0].pageId, first);
});

test('ducking: speech lowers only the sounds that duck, and its end brings them back; with nothing playing the speech path costs no page call', async () => {
  const {host, state} = world();
  host.speech(true); host.speech(false);
  await tick();
  assert.equal(state.opened, 0, 'no page, nothing opened or called for a voice');
  await host.play(playOf('m', tone(48000), {id: 'music', loop: true, duck: true}));
  await host.play(playOf('m', undefined, {id: 'rain', loop: true, duck: false}));
  state.calls.length = 0;
  host.speech(true);
  assert.deepEqual(state.calls, [], 'the speech call itself touches nothing: the command is scheduled off its turn');
  await tick();
  assert.deepEqual(state.calls, ['duck']);
  assert.equal(state.engine.state().ducked, true);
  host.speech(true);
  await tick();
  assert.deepEqual(state.calls, ['duck'], 'a second speaker (V\'s line beside a companion) changes nothing');
  host.speech(false); await tick();
  assert.equal(state.engine.state().ducked, true, 'one voice is still audible');
  host.speech(false); await tick();
  assert.equal(state.engine.state().ducked, false);
  assert.deepEqual(state.calls, ['duck', 'duck']);
  host.speech(false); host.speech(false);
  assert.equal(host.speakers, 0, 'an end without a start never goes below zero');
});

test('a sound that starts while someone is speaking starts ducked', async () => {
  const {host, state} = world();
  await host.load({key: 'm', samples: tone(48000)});
  host.speech(true);
  await host.play(playOf('m', undefined, {id: 'music', loop: true, duck: true}));
  assert.equal(state.engine.state().ducked, true);
});

test('a pack that asks to duck holds the music down until it lets go or its sounds stop', async () => {
  const {host, state} = world();
  await host.play(playOf('m', tone(48000), {id: 'music', loop: true, duck: true}));
  await host.duckHold({pack: 'panam-sunset-coffee', on: true});
  assert.equal(state.engine.state().ducked, true);
  host.speech(true); host.speech(false); await tick();
  assert.equal(state.engine.state().ducked, true, 'speech ending does not release the pack\'s hold');
  await host.duckHold({pack: 'panam-sunset-coffee', on: false});
  assert.equal(state.engine.state().ducked, false);
  await host.duckHold({pack: 'panam-sunset-coffee', on: true});
  await host.stop({pack: 'panam-sunset-coffee', fadeOut: 0.5});
  await tick();
  assert.equal(state.engine.state().ducked, false, 'stopping the pack drops its hold');
});

test('stop: one sound by id, or everything the pack started, with its fade; other packs are not touched', async () => {
  const {host, state} = world();
  await host.play(playOf('m', tone(96000), {id: 'a', loop: true}));
  await host.play(playOf('m', undefined, {id: 'b', loop: true}));
  await host.play(playOf('m', undefined, {pack: 'judy-dinner-dress', id: 'a', loop: true}));
  assert.equal(await host.stop({pack: 'panam-sunset-coffee', id: 'a', fadeOut: 1}), 1);
  assert.equal(host.count(), 2);
  assert.equal(await host.stop({pack: 'panam-sunset-coffee', id: 'a', fadeOut: 1}), 0, 'already stopped');
  assert.equal(await host.stop({pack: 'panam-sunset-coffee', fadeOut: 1}), 1);
  assert.deepEqual(host.packs(), ['judy-dinner-dress']);
  state.context.advance(2);
  assert.equal(state.engine.state().items.length, 1, 'the other pack still plays');
  assert.equal(await host.stop({pack: 'nobody'}), 0);
});

test('a stop that arrives while a sound is still being sent keeps it from sounding', async () => {
  const {host} = world();
  let allowed = true;
  const pending = host.play(playOf('k', tone(MEDIA_HOST.packetFrames * 2), {loop: true, wanted: () => allowed}));
  allowed = false;
  assert.deepEqual(await pending, {played: false});
  assert.equal(host.count(), 0);
});

test('the sound limit: eight at once, a ninth is refused with a sentence', async () => {
  const {host} = world();
  await host.load({key: 'k', samples: tone(4800)});
  for (let i = 0; i < MEDIA_HOST.maxItems; i++) await host.play(playOf('k', undefined, {id: 'x' + i, loop: true}));
  await assert.rejects(host.play(playOf('k', undefined, {id: 'one-more', loop: true})), /Too many sounds/);
  await assert.doesNotReject(host.play(playOf('k', undefined, {id: 'x0', loop: true})), 'replacing one of them is fine');
});

test('fade and pan reach the page; a fade for a sound that is not playing says so', async () => {
  const {host, state} = world();
  await host.play(playOf('k', tone(48000), {id: 'a', loop: true, at: 'copy', pan: 0.8}));
  assert.equal(state.context.sources[0].to.to.pan.value, 0.8, 'a copy takes the pan');
  assert.equal(await host.fade({pack: 'panam-sunset-coffee', id: 'a', volume: 0.1, seconds: 2}), true);
  state.context.advance(2);
  assert.ok(Math.abs(state.context.sources[0].to.gain.value - 0.1) < 1e-6);
  assert.equal(await host.fade({pack: 'panam-sunset-coffee', id: 'nope', volume: 0.1, seconds: 2}), false);
  await host.play(playOf('k', undefined, {id: 'bed', loop: true, at: 'bed', pan: 0.8}));
  assert.equal(state.context.sources[1].to.to.pan.value, 0, 'a bed is centred whatever pan came');
  assert.equal(panOf('v', 0.5), 0); assert.equal(panOf('copy', undefined), 0); assert.equal(panOf('copy', 3), 1);
});

test('the page closes only when nothing plays and it has been quiet for the idle time', async () => {
  let clock = 1000;
  const {host, state} = world({now: () => clock});
  await host.play(playOf('k', tone(48000), {id: 'a', loop: true}));
  clock += 600000;
  assert.equal(await host.releaseIfIdle({idleMs: 30000}), false, 'a loop is playing');
  await host.stop({pack: 'panam-sunset-coffee', fadeOut: 0});
  assert.equal(await host.releaseIfIdle({idleMs: 30000}), false, 'just stopped: not idle yet');
  clock += 31000;
  assert.equal(await host.releaseIfIdle({idleMs: 30000}), true);
  assert.equal(state.closed, 1); assert.equal(host.loaded.size, 0);
  assert.equal(await host.releaseIfIdle({idleMs: 30000}), false, 'nothing open: nothing to close');
  await host.play(playOf('k', tone(48000), {id: 'a'}));
  assert.equal(state.opened, 2, 'the next sound opens a page again, and sends its samples again');
});

test('a one-shot whose end event never came is forgotten a little after its own length', async () => {
  let clock = 0;
  const {host} = world({now: () => clock});
  await host.play(playOf('k', tone(48000), {id: 'shot'}));
  assert.equal(host.busy, true);
  clock = 1000 + 2500;
  assert.equal(host.busy, true);
  clock = 1000 + 3100;
  assert.equal(host.busy, false);
});

test('a page that closes by itself leaves nothing behind, and the next sound opens a new one', async () => {
  const {host, state} = world();
  await host.play(playOf('k', tone(48000), {id: 'a', loop: true}));
  state.closeHandlers.forEach(handler => handler());
  assert.equal(host.count(), 0); assert.equal(host.isLoaded('k'), false);
  await host.play(playOf('k', tone(48000), {id: 'a', loop: true}));
  assert.equal(state.opened, 2);
});

test('close ends everything and refuses new sounds; a page factory that fails is an error, not a hang', async () => {
  const {host, state} = world();
  await host.play(playOf('k', tone(48000), {id: 'a', loop: true}));
  await host.close();
  assert.equal(state.closed, 1);
  await assert.rejects(host.play(playOf('k', tone(48000))), /closed/);
  const broken = new MediaHost({createPage: async () => { throw Error('no browser'); }});
  await assert.rejects(broken.play(playOf('k', tone(4800))), /no browser/);
  assert.throws(() => new MediaHost({}), /page factory/);
});

test('packets are the little endian 16 bit text the page reads back', () => {
  const samples = Float32Array.from([0, 0.25, -0.25, 1, -1, 2]);
  assert.deepEqual([...base64ToFloat(packetToBase64(samples))].map(value => Math.round(value * 100) / 100), [0, 0.25, -0.25, 1, -1, 1]);
  assert.equal(MEDIA_HOST.packetFrames, MEDIA.packetFrames); assert.equal(MEDIA_HOST.rate, MEDIA.rate); assert.equal(MEDIA_HOST.maxItems, MEDIA.maxItems);
});
