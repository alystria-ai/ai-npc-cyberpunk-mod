// bridge/media-link.mjs: the game's media request file read and carried out against a fake media host, a fake decoder and a real pack runner.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {BondPacks} from './bond-pack-runner.mjs';
import {shippedPacks} from './bond-packs.mjs';
import {MEDIA_LINK, MediaLink} from './media-link.mjs';

const roster = new Set(JSON.parse(readFileSync(new URL('../characters/roster.json', import.meta.url), 'utf8')).map(row => row.key));
const PACK = 'panam-sunset-coffee';

function packWithSounds() {
  const pack = JSON.parse(JSON.stringify(shippedPacks().map(row => row.pack).find(item => item.id === PACK)));
  const stage = pack.stages.find(item => item.id === 'walk');
  stage.music = [{source: 'file:music/sunset.ogg', start: 'stage:enter', fadeIn: 2, duck: true}];
  stage.sfx = [{source: 'file:sfx/rain.ogg', at: 'bed', loop: true, start: 'stage:enter'}];
  return pack;
}
const command = (extra = {}) => ({kind: 'media', op: 'play', pack: PACK, id: 'bed', file: 'music/sunset.ogg', ...extra});
const fileOf = (seq, commands, session = 's1') => JSON.stringify({version: 1, session, seq, commands});

function world({active = true, decode, host = undefined} = {}) {
  const pack = packWithSounds();
  const runner = new BondPacks({packs: [pack], characters: roster, packFolder: resolve('C:/packs'), exists: () => true, write: async () => {}, debounceMs: 0});
  if (active) runner.entries.set(PACK, {status: 'active', trail: [{stage: 'walk', at: 0}]});
  const state = {file: null, mtime: 1, stats: 0, reads: 0, logs: [], calls: [], decodes: [], bytes: []};
  const fs = {
    stat: async () => { state.stats++; if (state.file === null) throw Error('ENOENT'); return {mtimeMs: state.mtime, size: state.file.length}; },
    readFile: async () => { state.reads++; return state.file; },
  };
  const loaded = new Set();
  const fakeHost = host ?? {
    isLoaded: key => loaded.has(key),
    load: async args => { state.calls.push(['load', args.key, args.samples?.length]); loaded.add(args.key); },
    play: async args => { state.calls.push(['play', args.pack, args.id, args.key, args.samples?.length, args.loop, args.volume, args.fadeIn, args.fadeOut, args.duck, args.at, args.pan, args.wanted()]); loaded.add(args.key); return {played: true}; },
    stop: async args => { state.calls.push(['stop', args.pack, args.id, args.fadeOut]); return 1; },
    fade: async args => { state.calls.push(['fade', args.pack, args.id, args.volume, args.pan, args.seconds]); return true; },
    duckHold: args => { state.calls.push(['duck', args.pack, args.on]); },
    packs: () => state.hostPacks ?? [],
  };
  let clock = 1000, hostStarts = 0;
  const link = new MediaLink({path: 'runtime/media-command.json', bondPacks: runner, fs, now: () => clock, log: message => state.logs.push(message),
    audio: {decode: decode ?? (async (bytes, options) => { state.decodes.push(options); return new Float32Array(Math.round(options.maxSeconds / 100 * options.rate)); })},
    readFile: async path => { state.bytes.push(path); return Buffer.from('file'); },
    host: async () => { hostStarts++; return fakeHost; }, peek: () => state.noHost ? null : fakeHost, wanted: () => state.wanted !== false});
  return {link, runner, state, tickClock: ms => { clock += ms; }, hostStarts: () => hostStarts};
}
const settle = async link => { for (let i = 0; i < 20; i++) await new Promise(done => setImmediate(done)); await link.chain; };

test('a play request: the file is found in the pack, decoded at 48 kHz for music, and given to the host with everything the game asked', async () => {
  const {link, state} = world();
  state.file = fileOf(1, [command({loop: true, volume: 0.6, fadeIn: 2, fadeOut: 3, at: 'copy', pan: -0.4})]);
  assert.equal(await link.poll(), 1);
  await settle(link);
  assert.deepEqual(state.bytes, [resolve('C:/packs', PACK, 'music', 'sunset.ogg')]);
  assert.deepEqual(state.decodes, [{rate: 48000, maxSeconds: MEDIA_LINK.musicSeconds}]);
  assert.deepEqual(state.calls, [['play', PACK, 'bed', `${PACK}/music/sunset.ogg`, 144000, true, 0.6, 2, 3, true, 'copy', -0.4, true]]);
  assert.deepEqual(state.logs, []);
});

test('a sound effect is cut off at thirty seconds; a sound already on the page is not read or decoded again', async () => {
  const {link, state} = world();
  state.file = fileOf(1, [{kind: 'media', op: 'play', pack: PACK, id: 'rain', file: 'sfx/rain.ogg', loop: true}]);
  await link.poll(); await settle(link);
  assert.deepEqual(state.decodes, [{rate: 48000, maxSeconds: MEDIA_LINK.sfxSeconds}]);
  assert.equal(state.calls[0][9], false, 'a sound effect does not duck unless it says so');
  state.file = fileOf(2, [{kind: 'media', op: 'play', pack: PACK, id: 'rain2', file: 'sfx/rain.ogg'}]); state.mtime = 2;
  await link.poll(); await settle(link);
  assert.equal(state.decodes.length, 1); assert.equal(state.bytes.length, 1);
  assert.equal(state.calls[1][4], undefined, 'no samples travel: the page has the sound');
});

test('load decodes and hands over without playing', async () => {
  const {link, state} = world();
  state.file = fileOf(1, [{kind: 'media', op: 'load', pack: PACK, file: 'sfx/rain.ogg'}]);
  await link.poll(); await settle(link);
  assert.deepEqual(state.calls, [['load', `${PACK}/sfx/rain.ogg`, 14400]]);
});

test('stop, fade and duck reach the host at once, without starting the browser', async () => {
  const {link, state, hostStarts} = world();
  state.file = fileOf(1, [{kind: 'media', op: 'stop', pack: PACK, id: 'bed', fadeOut: 2}, {kind: 'media', op: 'fade', pack: PACK, id: 'bed', volume: 0.3}, {kind: 'media', op: 'duck', pack: PACK, on: true},
    {kind: 'media', op: 'stop', pack: PACK}]);
  await link.poll(); await settle(link);
  assert.deepEqual(state.calls, [['stop', PACK, 'bed', 2], ['fade', PACK, 'bed', 0.3, undefined, 1], ['duck', PACK, true], ['stop', PACK, undefined, 0.3]]);
  assert.equal(hostStarts(), 0, 'nothing started the browser');
  state.noHost = true; state.calls.length = 0; state.mtime = 2;
  state.file = fileOf(2, [{kind: 'media', op: 'stop', pack: PACK}]);
  await link.poll(); await settle(link);
  assert.deepEqual(state.calls, [], 'with no media page there is nothing to stop');
});

test('a stop that comes while a sound is still being decoded cancels it; a later play of the same id is not affected', async () => {
  let release;
  const gate = new Promise(done => { release = done; });
  const {link, state} = world({decode: async (bytes, options) => { await gate; return new Float32Array(4800); }});
  state.file = fileOf(1, [command(), {kind: 'media', op: 'stop', pack: PACK, id: 'bed'}]);
  await link.poll();
  release(); await settle(link);
  assert.deepEqual(state.calls.map(call => call[0]), ['stop'], 'the stop ran at once, and the sound that was being decoded never reached the host');
  state.mtime = 2; state.file = fileOf(2, [command({id: 'bed'})]);
  await link.poll(); await settle(link);
  assert.equal(state.calls.at(-1).at(-1), true, 'a new play after the stop is wanted');
});

test('a stop of the whole pack cancels every sound of it that is still being decoded', async () => {
  let release;
  const gate = new Promise(done => { release = done; });
  const {link, state} = world({decode: async () => { await gate; return new Float32Array(480); }});
  state.file = fileOf(1, [command({id: 'a'}), command({id: 'b', file: 'music/sunset.ogg'})]);
  await link.poll();
  state.file = fileOf(2, [{kind: 'media', op: 'stop', pack: PACK}]); state.mtime = 2;
  await link.poll();
  release(); await settle(link);
  assert.deepEqual(state.calls.filter(call => call[0] === 'play'), [], 'neither sound that was being decoded reached the host');
  assert.deepEqual(state.calls.map(call => call[0]), ['stop']);
});

test('plays are carried out one after the other, in the order they came', async () => {
  const order = [];
  const {link, state} = world({decode: async (bytes, options) => { order.push('decode'); await new Promise(done => setImmediate(done)); return new Float32Array(100); }});
  state.file = fileOf(1, [command({id: 'a'}), command({id: 'b'}), command({id: 'c'})]);
  await link.poll(); await settle(link);
  assert.deepEqual(state.calls.filter(call => call[0] === 'play').map(call => call[2]), ['a', 'b', 'c']);
});

test('an unchanged file is not read again, a request already handled is ignored, a new session starts over', async () => {
  const {link, state} = world();
  state.file = fileOf(5, [command()]);
  assert.equal(await link.poll(), 1);
  assert.equal(state.reads, 1);
  assert.equal(await link.poll(), 0); assert.equal(state.reads, 1, 'same identity: not even read');
  state.mtime = 2;
  assert.equal(await link.poll(), 0); assert.equal(state.reads, 2, 'rewritten with the same request number: read, ignored');
  state.mtime = 3; state.file = fileOf(4, [command({id: 'old'})]);
  assert.equal(await link.poll(), 0, 'an earlier request number of the same session is a stale write');
  state.mtime = 4; state.file = fileOf(6, [command({id: 'next'})]);
  assert.equal(await link.poll(), 1);
  state.mtime = 5; state.file = fileOf(1, [command({id: 'again'})], 'a-new-game-session');
  assert.equal(await link.poll(), 1, 'a new game session counts from the start');
  await settle(link);
  assert.deepEqual(state.calls.map(call => call[2]), ['bed', 'next', 'again']);
});

test('a file that is being written (not valid yet) is read again as soon as it is finished', async () => {
  const {link, state} = world();
  state.file = '{"version":1,"session":"s1","seq":1,"commands":[{"kind":"med';
  assert.equal(await link.poll(), 0);
  state.file = fileOf(1, [command()]);
  assert.equal(await link.poll(), 1, 'same identity numbers would have hidden it if the partial one had been remembered');
});

test('a file left by an earlier run is noted at start and not replayed', async () => {
  const {link, state} = world();
  state.file = fileOf(9, [command()]);
  await link.open();
  assert.equal(await link.poll(), 0); assert.equal(state.reads, 0);
  state.mtime = 2; state.file = fileOf(10, [command()]);
  assert.equal(await link.poll(), 1);
});

test('what cannot be played is one ERROR line with the pack, the sound and the reason, once, and nothing sounds', async () => {
  const {link, state} = world();
  const unknown = command({id: 'ghost', file: 'music/not-declared.ogg'});
  for (let seq = 1; seq <= 3; seq++) { state.mtime = seq; state.file = fileOf(seq, [unknown]); await link.poll(); await settle(link); }
  assert.deepEqual(state.calls, []);
  assert.equal(state.logs.length, 1);
  assert.match(state.logs[0], /^ERROR pack=panam-sunset-coffee play music\/not-declared\.ogg: .*does not name this file/);
  const stopped = world({active: false});
  stopped.state.file = fileOf(1, [command()]); await stopped.link.poll(); await settle(stopped.link);
  assert.deepEqual(stopped.state.calls, [], 'a pack that does not run plays nothing');
  assert.match(stopped.state.logs[0], /the pack is not running/);
  const broken = world({decode: async () => { throw Error('needs ffmpeg on this computer or the Runtime Python with the soundfile package, otherwise the pack must ship WAV'); }});
  broken.state.file = fileOf(1, [command()]); await broken.link.poll(); await settle(broken.link);
  assert.deepEqual(broken.state.calls, []);
  assert.match(broken.state.logs[0], /ERROR pack=panam-sunset-coffee play music\/sunset\.ogg: needs ffmpeg.*the sound is skipped/);
  const partly = world();
  partly.state.file = fileOf(1, [command(), {kind: 'media', op: 'play'}]); await partly.link.poll();
  assert.match(partly.state.logs[0], /1 command\(s\) of request 1 were not valid/);
});

test('polling: only while something is worth looking at, at most every 200 ms, one poll at a time, and a throwing check is harmless', async () => {
  const {link, state, tickClock} = world();
  state.wanted = false;
  tickClock(1000);
  assert.equal(link.maybePoll(), false); assert.equal(state.stats, 0, 'a quest-free bridge never touches the file');
  state.wanted = true;
  assert.equal(link.maybePoll(), true);
  assert.equal(link.maybePoll(), false, 'one at a time');
  await settle(link);
  assert.equal(state.stats, 1);
  tickClock(100);
  assert.equal(link.maybePoll(), false, 'not within 200 ms');
  tickClock(150);
  assert.equal(link.maybePoll(), true);
  await settle(link);
  const throwing = new MediaLink({path: 'x', fs: {stat: async () => null}, wanted: () => { throw Error('boom'); }, now: () => 1e9});
  assert.equal(throwing.maybePoll(), false);
  const failing = new MediaLink({path: 'x', fs: {stat: async () => { throw Error('disk'); }}, wanted: () => true, now: () => 1e9, log: message => state.logs.push(message)});
  assert.equal(failing.maybePoll(), true);
});

test('reconcile stops the sounds of a pack that is no longer running, and nothing else', async () => {
  const {link, runner, state} = world();
  state.hostPacks = [PACK, 'some-other-pack'];
  assert.equal(await link.reconcile(), 1, 'the other pack is not known to the runner: stopped; the running one plays on');
  assert.deepEqual(state.calls, [['stop', 'some-other-pack', undefined, 2]]);
  state.calls.length = 0;
  runner.entries.get(PACK).status = 'ended';
  assert.equal(await link.reconcile(), 2);
  assert.deepEqual(state.calls.map(call => call[1]).sort(), ['panam-sunset-coffee', 'some-other-pack']);
  state.noHost = true;
  assert.equal(await link.reconcile(), 0);
});
