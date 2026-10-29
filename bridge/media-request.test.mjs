// bridge/media-request.mjs: the strict parsing of the game's media requests and the resolution of a named file to a file inside the running pack.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve, sep} from 'node:path';
import {BondPacks} from './bond-pack-runner.mjs';
import {shippedPacks, validatePack} from './bond-packs.mjs';
import {MEDIA_OPS, declaredMedia, packIsLive, parseMediaCommandFile, parseMediaReaction, resolveMediaFile} from './media-request.mjs';

const roster = new Set(JSON.parse(readFileSync(new URL('../characters/roster.json', import.meta.url), 'utf8')).map(row => row.key));
const play = {kind: 'media', op: 'play', pack: 'panam-sunset-coffee', id: 'bed1', file: 'music/sunset.ogg'};

test('a play request gets its defaults: music ducks, sfx does not, everything else is the plain bed at full volume', () => {
  assert.deepEqual(parseMediaReaction(play), {kind: 'media', op: 'play', pack: 'panam-sunset-coffee', id: 'bed1', file: 'music/sunset.ogg', loop: false, volume: 1, fadeIn: 0, fadeOut: 0,
    duck: true, at: 'bed', pan: 0});
  assert.equal(parseMediaReaction({...play, file: 'sfx/door.wav'}).duck, false);
  assert.deepEqual(parseMediaReaction({...play, loop: true, volume: 0.4, fadeIn: 2, fadeOut: 3, duck: false, at: 'copy', pan: -0.6}),
    {kind: 'media', op: 'play', pack: 'panam-sunset-coffee', id: 'bed1', file: 'music/sunset.ogg', loop: true, volume: 0.4, fadeIn: 2, fadeOut: 3, duck: false, at: 'copy', pan: -0.6});
  for (const at of ['v', 'bed', 'copy', 'place:lookout']) assert.equal(parseMediaReaction({...play, at}).at, at);
});

test('every other op parses to its own fields', () => {
  assert.deepEqual(parseMediaReaction({kind: 'media', op: 'load', pack: 'panam-sunset-coffee', file: 'sfx/door.ogg'}), {kind: 'media', op: 'load', pack: 'panam-sunset-coffee', file: 'sfx/door.ogg'});
  assert.deepEqual(parseMediaReaction({kind: 'media', op: 'stop', pack: 'panam-sunset-coffee'}), {kind: 'media', op: 'stop', pack: 'panam-sunset-coffee', fadeOut: 0.3});
  assert.deepEqual(parseMediaReaction({kind: 'media', op: 'stop', pack: 'panam-sunset-coffee', id: 'bed1', fadeOut: 2}), {kind: 'media', op: 'stop', pack: 'panam-sunset-coffee', id: 'bed1', fadeOut: 2});
  assert.deepEqual(parseMediaReaction({kind: 'media', op: 'fade', pack: 'panam-sunset-coffee', id: 'bed1', volume: 0.2}), {kind: 'media', op: 'fade', pack: 'panam-sunset-coffee', id: 'bed1', volume: 0.2, seconds: 1});
  assert.deepEqual(parseMediaReaction({kind: 'media', op: 'fade', pack: 'panam-sunset-coffee', id: 'bed1', pan: -1, seconds: 0.25}), {kind: 'media', op: 'fade', pack: 'panam-sunset-coffee', id: 'bed1', pan: -1, seconds: 0.25});
  assert.deepEqual(parseMediaReaction({kind: 'media', op: 'duck', pack: 'panam-sunset-coffee', on: true}), {kind: 'media', op: 'duck', pack: 'panam-sunset-coffee', on: true});
  assert.deepEqual([...MEDIA_OPS], ['play', 'load', 'stop', 'fade', 'duck']);
});

test('anything wrong fails closed: wrong kind, op, pack, id, file, types, ranges, extra fields', () => {
  const bad = [
    null, undefined, 'play', [], 5, {}, {...play, kind: 'scripted'}, {...play, op: 'seek'}, {...play, op: undefined},
    {...play, pack: 'Panam'}, {...play, pack: 'x'}, {...play, pack: undefined}, {...play, pack: '../etc'},
    {...play, id: ''}, {...play, id: 'a b'}, {...play, id: 'x'.repeat(65)}, {...play, id: undefined}, {...play, id: 5},
    {...play, file: 'audio/line.wav'}, {...play, file: 'music/../../secret.ogg'}, {...play, file: '/music/a.ogg'}, {...play, file: 'music/a.mp3'}, {...play, file: 'C:\\x.ogg'},
    {...play, file: 'music/' + 'a'.repeat(90) + '.ogg'}, {...play, file: undefined},
    {...play, loop: 'yes'}, {...play, duck: 1}, {...play, volume: 1.1}, {...play, volume: -0.1}, {...play, volume: '0.5'}, {...play, volume: NaN}, {...play, fadeIn: 11}, {...play, fadeOut: -1},
    {...play, pan: 2}, {...play, at: 'nowhere'}, {...play, at: 'place:'}, {...play, at: 5},
    {...play, path: 'C:/evil.ogg'}, {...play, extra: true}, {...play, seconds: 1},
    {kind: 'media', op: 'load', pack: 'panam-sunset-coffee'}, {kind: 'media', op: 'load', pack: 'panam-sunset-coffee', file: 'music/a.ogg', id: 'x'},
    {kind: 'media', op: 'stop', pack: 'panam-sunset-coffee', id: 'a b'}, {kind: 'media', op: 'stop', pack: 'panam-sunset-coffee', fadeOut: 99},
    {kind: 'media', op: 'fade', pack: 'panam-sunset-coffee', id: 'a'}, {kind: 'media', op: 'fade', pack: 'panam-sunset-coffee', volume: 0.5},
    {kind: 'media', op: 'fade', pack: 'panam-sunset-coffee', id: 'a', volume: 2}, {kind: 'media', op: 'fade', pack: 'panam-sunset-coffee', id: 'a', volume: 0.5, seconds: 11},
    {kind: 'media', op: 'duck', pack: 'panam-sunset-coffee'}, {kind: 'media', op: 'duck', pack: 'panam-sunset-coffee', on: 'true'}, {kind: 'media', op: 'duck', pack: 'panam-sunset-coffee', on: true, id: 'a'},
  ];
  for (const value of bad) assert.equal(parseMediaReaction(value), null, JSON.stringify(value)?.slice(0, 120));
  // A prototype trick or an inherited field is not a field.
  assert.equal(parseMediaReaction(JSON.parse('{"kind":"media","op":"duck","pack":"panam-sunset-coffee","on":true,"__proto__":{"x":1}}')), null);
});

test('the command file: version, session, sequence and at most eight commands; a bad command is left out, a bad file is refused', () => {
  const file = (extra = {}) => JSON.stringify({version: 1, session: 'k3j2h1g0', seq: 12, commands: [play, {kind: 'media', op: 'stop', pack: 'panam-sunset-coffee'}], ...extra});
  const parsed = parseMediaCommandFile(file());
  assert.equal(parsed.session, 'k3j2h1g0'); assert.equal(parsed.seq, 12); assert.equal(parsed.rejected, 0);
  assert.deepEqual(parsed.commands.map(command => command.op), ['play', 'stop']);
  const mixed = parseMediaCommandFile(file({commands: [play, {kind: 'media', op: 'play'}, 'nope', {kind: 'media', op: 'duck', pack: 'panam-sunset-coffee', on: false}]}));
  assert.deepEqual(mixed.commands.map(command => command.op), ['play', 'duck']); assert.equal(mixed.rejected, 2);
  assert.equal(parseMediaCommandFile(file({commands: []})).commands.length, 0);
  for (const raw of ['', '{', 'null', '[]', file({version: 2}), file({session: ''}), file({session: 'a b'}), file({session: 5}), file({seq: -1}), file({seq: 1.5}), file({seq: '3'}),
    file({commands: 'x'}), file({commands: new Array(9).fill(play)}), file({commands: undefined})]) {
    assert.equal(parseMediaCommandFile(raw), null, raw.slice(0, 60));
  }
  assert.equal(parseMediaCommandFile(file({commands: new Array(8).fill(play)})).commands.length, 8);
});

// ---- the pack: a real validated pack with music and sound effects in a stage, run by the real runner ----
function packWithSounds() {
  const pilot = shippedPacks().map(row => row.pack).find(pack => pack.id === 'panam-sunset-coffee');
  const pack = JSON.parse(JSON.stringify(pilot));
  const stage = pack.stages.find(item => item.id === 'walk');
  stage.music = [{source: 'file:music/sunset.ogg', start: 'stage:enter', fadeIn: 2, fadeOut: 2, volume: 0.6, duck: true}, {source: 'radio:Pacific Dreams', start: 'stage:enter'}];
  stage.sfx = [{source: 'file:sfx/rain.ogg', at: 'bed', loop: true, start: 'stage:enter'}, {source: 'game:ui_jingle_quest_new', start: 'stage:enter'}];
  return pack;
}
function runnerOf(pack, {active = true, exists = () => true} = {}) {
  const runner = new BondPacks({packs: [pack], characters: roster, packFolder: resolve('C:/packs'), exists, write: async () => {}, debounceMs: 0});
  if (active) runner.entries.set(pack.id, {status: 'active', trail: [{stage: 'invite', at: 0}]});
  return runner;
}

test('the test pack is valid (so the declared sounds are ones the validator accepts)', () => {
  const result = validatePack(packWithSounds(), {characters: roster});
  assert.equal(result.ok, true, result.errors?.join('; '));
});

test('only the pack\'s own file: sources are declared sounds; radio and game sources are the game\'s and are not listed', () => {
  assert.deepEqual([...declaredMedia(packWithSounds())], [['music/sunset.ogg', 'music'], ['sfx/rain.ogg', 'sfx']]);
  assert.equal(declaredMedia({}).size, 0); assert.equal(declaredMedia(null).size, 0);
  assert.equal(declaredMedia({stages: [{sfx: [{source: 'file:music/sunset.ogg'}]}]}).size, 0, 'a music file named as an sfx is not a declared sfx');
  assert.equal(declaredMedia({stages: [{music: [{source: 'file:music/../x.ogg'}]}]}).size, 0);
});

test('a file resolves to the pack\'s own folder when the pack runs and names it', () => {
  const pack = packWithSounds(), runner = runnerOf(pack);
  const found = resolveMediaFile(runner, pack.id, 'music/sunset.ogg');
  assert.equal(found.kind, 'music'); assert.equal(found.key, 'panam-sunset-coffee/music/sunset.ogg');
  assert.ok(found.path.startsWith(resolve('C:/packs', pack.id) + sep), found.path);
  assert.equal(found.path, resolve('C:/packs', pack.id, 'music', 'sunset.ogg'));
  assert.equal(resolveMediaFile(runner, pack.id, 'sfx/rain.ogg').kind, 'sfx');
});

test('and to nothing otherwise: undeclared file, file not on disk, unknown or stopped pack, a request that tries to leave the folder', () => {
  const pack = packWithSounds();
  assert.equal(resolveMediaFile(runnerOf(pack), pack.id, 'music/other.ogg'), null, 'a real path the pack does not declare');
  assert.equal(resolveMediaFile(runnerOf(pack), pack.id, 'sfx/sunset.ogg'), null, 'declared as music, asked as sfx');
  assert.equal(resolveMediaFile(runnerOf(pack, {exists: () => false}), pack.id, 'music/sunset.ogg'), null);
  assert.equal(resolveMediaFile(runnerOf(pack), 'not-a-pack', 'music/sunset.ogg'), null);
  assert.equal(resolveMediaFile(runnerOf(pack, {active: false}), pack.id, 'music/sunset.ogg'), null, 'a pack that is not running plays nothing');
  for (const file of ['music/../../x.ogg', '../music/sunset.ogg', 'C:\\x.ogg', '', undefined, null, 5]) assert.equal(resolveMediaFile(runnerOf(pack), pack.id, file), null, String(file));
  const checked = [];
  resolveMediaFile(runnerOf(pack, {exists: path => { checked.push(path); return true; }}), pack.id, 'music/sunset.ogg');
  assert.deepEqual(checked, [resolve('C:/packs', pack.id, 'music', 'sunset.ogg')], 'the only path ever looked at is the one built from the pack folder');
});

test('a pack that ended a moment ago still plays its ending sounds (the closing rows), then no longer', () => {
  const pack = packWithSounds(), runner = runnerOf(pack, {active: false});
  assert.equal(packIsLive(runner, pack.id), false);
  runner.closing.push({pack: pack.id});
  assert.equal(packIsLive(runner, pack.id), true);
  assert.equal(resolveMediaFile(runner, pack.id, 'music/sunset.ogg')?.kind, 'music');
  assert.equal(packIsLive(null, pack.id), false); assert.equal(packIsLive({}, pack.id), false);
});
