// bridge/media-engine.mjs on a stand-in audio context (bridge/media-test-context.mjs): loading, the playing graph, loops, fades, ducking, pan, the sound limit and the cleanup.
// No browser: the real page is checked by the media browser test, when this machine can run one.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {MediaEngine, base64ToFloat} from './media-engine.mjs';
import {MEDIA} from './media-mix.mjs';
import {FakeAudioContext} from './media-test-context.mjs';

const b64 = samples => { const out = Buffer.alloc(samples.length * 2); samples.forEach((value, i) => out.writeInt16LE(Math.round(value * 32767), i * 2)); return out.toString('base64'); };
const tone = (count, level = 0.5) => Float32Array.from({length: count}, (_, i) => level * Math.sin(i / 7));
const near = (a, b, message, tolerance = 1e-6) => assert.ok(Math.abs(a - b) <= tolerance, `${message}: ${a} is not ${b}`);

function setup(options = {}) {
  const context = new FakeAudioContext(), events = [];
  const engine = new MediaEngine({context, post: event => events.push(event), ...options});
  const load = (key, seconds = 2, rate = 48000) => {
    const frames = Math.round(seconds * rate), data = tone(frames);
    engine.run('begin', {key, rate, frames});
    for (let at = 0; at < frames; at += MEDIA.packetFrames) engine.run('append', {key, offsetFrames: at, pcm: b64(data.subarray(at, Math.min(frames, at + MEDIA.packetFrames)))});
    return engine.run('seal', {key});
  };
  return {context, engine, events, load};
}

test('base64 packets are 16 bit little endian mono samples', () => {
  const out = base64ToFloat(b64(Float32Array.from([0, 0.5, -0.5, 1, -1])));
  assert.deepEqual([...out].map(value => Math.round(value * 1000) / 1000), [0, 0.5, -0.5, 1, -1]);
  assert.throws(() => base64ToFloat(''), /Empty/); assert.throws(() => base64ToFloat(Buffer.from([1, 2, 3]).toString('base64')), /Malformed/); assert.throws(() => base64ToFloat(5), /Empty/);
});

test('a sound arrives in packets, in order, and is kept whole', () => {
  const {context, engine, load} = setup();
  const sealed = load('p/music/theme.ogg', 5);
  assert.equal(sealed.frames, 240000); assert.deepEqual(sealed.evicted, []);
  const buffer = context.buffers[0];
  assert.equal(buffer.sampleRate, 48000); assert.equal(buffer.duration, 5); assert.equal(buffer.data.length, 240000);
  near(buffer.data[1000], Math.round(0.5 * Math.sin(1000 / 7) * 32767) / 32768, 'the samples are the ones sent', 1e-4);
  assert.equal(engine.state().buffers, 1);
  assert.equal(engine.state().bytes, 240000 * 4);
});

test('loading refuses what is out of order, incomplete or malformed', () => {
  const {engine} = setup();
  assert.throws(() => engine.run('begin', {key: 'bad key!', rate: 48000, frames: 10}), /Invalid media sound/);
  assert.throws(() => engine.run('begin', {key: 'a', rate: 100, frames: 10}), /Invalid media sound/);
  assert.throws(() => engine.run('begin', {key: 'a', rate: 48000, frames: MEDIA.maxFrames + 1}), /Invalid media sound/);
  assert.throws(() => engine.run('begin', {key: 'a', rate: 48000, frames: 0}), /Invalid media sound/);
  assert.throws(() => engine.run('append', {key: 'a', offsetFrames: 0, pcm: b64(tone(10))}), /No such media sound/);
  engine.run('begin', {key: 'a', rate: 48000, frames: 20});
  assert.throws(() => engine.run('append', {key: 'a', offsetFrames: 5, pcm: b64(tone(10))}), /out of order/);
  assert.throws(() => engine.run('append', {key: 'a', offsetFrames: 0, pcm: b64(tone(30))}), /out of order/, 'more than the sound holds');
  engine.run('append', {key: 'a', offsetFrames: 0, pcm: b64(tone(10))});
  assert.throws(() => engine.run('seal', {key: 'a'}), /not complete/);
  assert.throws(() => engine.run('play', {id: 'x', key: 'a'}), /not loaded/);
  assert.throws(() => engine.run('nope', {}), /Unknown media command/);
  assert.throws(() => engine.run('play', {id: 'bad id', key: 'a'}), /Invalid media id/);
});

test('a loop plays on a looping source through its own gain and panner to the plain bus; it never ends by itself', () => {
  const {context, engine, events, load} = setup();
  load('k', 2);
  const played = engine.run('play', {id: 'bed', key: 'k', loop: true, volume: 0.5});
  assert.deepEqual(played, {id: 'bed', duration: null});
  const source = context.sources[0];
  assert.equal(source.loop, true); assert.equal(source.startedAt, 0);
  assert.equal(source.to.to.to, engine.bus, 'source, gain, panner, then the plain bus');
  near(source.to.gain.value, 0.5, 'the volume');
  context.advance(600);
  assert.deepEqual(events, [], 'ten minutes later it still plays');
  assert.equal(engine.state().items.length, 1);
});

test('a one-shot ends by itself, posts the end once and lets go of its nodes', () => {
  const {context, engine, events, load} = setup();
  load('k', 2);
  engine.run('play', {id: 'shot', key: 'k'});
  context.advance(1.9); assert.deepEqual(events, []);
  context.advance(0.2);
  assert.deepEqual(events, [{type: 'ended', id: 'shot'}]);
  assert.equal(engine.state().items.length, 0);
  assert.equal(context.sources[0].disconnected, true, 'the source was let go of');
});

test('a fade in and a fade out follow the envelope on the real gain value', () => {
  const {context, engine, load} = setup();
  load('k', 10);
  engine.run('play', {id: 'a', key: 'k', volume: 1, fadeIn: 2, fadeOut: 2});
  const gain = context.sources[0].to.gain;
  near(gain.value, 0, 'silent at the start'); context.advance(1); near(gain.value, 0.5, 'half way up', 1e-6);
  context.advance(1); near(gain.value, 1, 'up'); context.advance(6); near(gain.value, 1, 'steady');
  context.advance(1); near(gain.value, 0.5, 'half way down'); context.advance(1.01);
});

test('a stop fades out and then stops the source; stopping twice does nothing', () => {
  const {context, engine, events, load} = setup();
  load('k', 20);
  engine.run('play', {id: 'a', key: 'k', loop: true, volume: 0.8});
  context.advance(3);
  assert.equal(engine.run('stop', {id: 'a', fadeOut: 2}), true);
  const source = context.sources[0];
  assert.equal(source.stopAt, 5);
  context.advance(1); near(source.to.gain.value, 0.4, 'half way down');
  assert.equal(engine.run('stop', {id: 'a', fadeOut: 0}), false, 'already stopping');
  context.advance(1.1);
  assert.deepEqual(events, [{type: 'ended', id: 'a'}]);
  assert.equal(engine.run('stop', {id: 'nothing'}), false);
});

test('stopAll fades everything that plays', () => {
  const {context, engine, events, load} = setup();
  load('k', 20);
  for (const id of ['a', 'b', 'c']) engine.run('play', {id, key: 'k', loop: true});
  assert.equal(engine.run('stopAll', {fadeOut: 0.5}), 3);
  context.advance(1);
  assert.deepEqual(events.map(event => event.id).sort(), ['a', 'b', 'c']);
  assert.equal(engine.run('stopAll', {}), 0);
});

test('a fade changes the level over the time asked, and a pan moves a positional sound', () => {
  const {context, engine, load} = setup();
  load('k', 20);
  engine.run('play', {id: 'a', key: 'k', loop: true, volume: 1, pan: 0.5});
  const source = context.sources[0], gain = source.to.gain, pan = source.to.to.pan;
  near(pan.value, 0.5, 'the starting pan');
  context.advance(1);
  assert.equal(engine.run('fade', {id: 'a', volume: 0.2, seconds: 4}), true);
  context.advance(2); near(gain.value, 0.6, 'half way to the new level'); context.advance(2); near(gain.value, 0.2, 'at it');
  engine.run('fade', {id: 'a', pan: -1, seconds: 1});
  context.advance(0.5); near(pan.value, -0.25, 'half way across', 1e-6); context.advance(0.6); near(pan.value, -1, 'across');
  assert.equal(engine.run('fade', {id: 'unknown', volume: 0}), false);
});

test('ducking: only the sounds that duck go through the bus that is lowered under speech', () => {
  const {context, engine, load} = setup();
  load('k', 30);
  engine.run('play', {id: 'music', key: 'k', loop: true, duck: true});
  engine.run('play', {id: 'rain', key: 'k', loop: true, duck: false});
  const [music, rain] = context.sources;
  assert.equal(music.to.to.to, engine.duckBus); assert.equal(rain.to.to.to, engine.bus);
  near(engine.duckBus.gain.value, 1, 'not ducked');
  assert.equal(engine.run('duck', {on: true}), true);
  assert.equal(engine.run('duck', {on: true}), false, 'already ducked: nothing is scheduled again');
  context.advance(MEDIA.duckAttack);
  assert.ok(engine.duckBus.gain.value < MEDIA.duckGain + 0.06, `ducked after the attack time: ${engine.duckBus.gain.value}`);
  near(engine.bus.gain.value, 1, 'the plain bus is untouched');
  engine.run('duck', {on: false});
  context.advance(MEDIA.duckRelease);
  assert.ok(engine.duckBus.gain.value > 0.95, `back up after the release time: ${engine.duckBus.gain.value}`);
  assert.equal(engine.state().ducked, false);
});

test('playing the same id again replaces the old sound with a short fade, and the sound limit is enforced', () => {
  const {context, engine, events, load} = setup();
  load('k', 20);
  engine.run('play', {id: 'a', key: 'k', loop: true});
  engine.run('play', {id: 'a', key: 'k', loop: true});
  assert.equal(context.sources.length, 2); assert.equal(context.sources[0].stopAt, 0.1);
  context.advance(0.2);
  assert.deepEqual(events, [], 'the old one ended quietly: the id still plays, the bridge is not told it ended');
  assert.equal(context.sources[0].disconnected, true, 'and its nodes were let go of');
  assert.equal(engine.state().items.length, 1); assert.equal(context.sources[1].disconnected, false);
  for (let i = 0; i < MEDIA.maxItems - 1; i++) engine.run('play', {id: 'x' + i, key: 'k', loop: true});
  assert.throws(() => engine.run('play', {id: 'one-too-many', key: 'k', loop: true}), /Too many sounds/);
  assert.doesNotThrow(() => engine.run('play', {id: 'a', key: 'k', loop: true}), 'replacing one of the eight is allowed');
});

test('kept buffers are bounded: the least recently used sound that nothing plays is dropped', () => {
  const {engine, load} = setup({maxBytes: 48000 * 4 * 5});
  load('one', 2); load('two', 2);
  engine.run('play', {id: 'p', key: 'one', loop: true});
  const sealed = load('three', 2);
  assert.deepEqual(sealed.evicted, ['two'], 'one is playing, three is new: two goes');
  assert.throws(() => engine.run('play', {id: 'q', key: 'two'}), /not loaded/);
  assert.equal(engine.state().buffers, 2);
});

test('a suspended context is asked to resume, and close lets go of everything', async () => {
  const {context, engine, events, load} = setup();
  load('k', 5);
  context.state = 'suspended';
  engine.run('play', {id: 'a', key: 'k', loop: true});
  await Promise.resolve();
  assert.equal(context.state, 'running');
  await engine.close();
  assert.equal(context.closed, true);
  assert.equal(engine.state().items.length, 0);
  assert.deepEqual(events, [], 'a closed page posts nothing');
  assert.throws(() => new MediaEngine({}), /audio context/);
});
