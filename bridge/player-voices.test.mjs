import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, readdir, rm, writeFile, mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {CLIP, checkSpeech, checkTranscript, convertWithFfmpeg, decodeWav, encodeWav, prepareClip, prepareUpload, sniffAudio} from './custom-voice-clip.mjs';
import {PLAYER_PREPARED_FOLDER, PLAYER_VOICES_FILE, PLAYER_VOICES_FOLDER, PlayerVoices, isVoiceKey, readEntry, readPlayerVoiceSummary, releasePreparedSlots} from './player-voices.mjs';
import {findFfmpeg} from './voxtral-reference.mjs';
import {speechWav} from './voice-clip-fixture.mjs';

const WORDS = 'Hello there, this is me talking.';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

// ---- the clip

test('a clean speech clip is kept in one canonical form: mono, 16-bit, its own rate, a plain header', () => {
  const given = speechWav({seconds: 12, rate: 48000, channels: 2, bits: 24});
  const clip = prepareClip(given);
  assert.equal(clip.ok, true, JSON.stringify(clip));
  assert.equal(clip.rate, 48000);
  assert.equal(clip.seconds, 12);
  assert.deepEqual(clip.notes, []);
  assert.equal(clip.sha256, sha(clip.wav));
  const back = decodeWav(clip.wav);
  assert.equal(back.ok && back.channels === 1 && back.bits === 16 && back.codec === 1, true);
  assert.equal(clip.wav.length, 44 + 12 * 48000 * 2, 'a 44-byte header and nothing else');
  assert.equal(clip.wav.readUInt32LE(4) + 8, clip.wav.length, 'an exact RIFF size, which Pocket demands');
  for (const options of [{bits: 16}, {bits: 32}, {float: true}, {extensible: true, bits: 24}, {extensible: true, float: true}, {rate: 16000}, {rate: 96000, seconds: 6}])
    assert.equal(prepareClip(speechWav(options)).ok, true, JSON.stringify(options));
  assert.deepEqual(prepareClip(speechWav({seconds: 7})).notes, ['short']);
  assert.deepEqual(prepareClip(speechWav({seconds: 19.5})).notes, ['long']);
});

test('a clip that the voices could not use or copy is refused with a reason', () => {
  const why = bytes => { const clip = prepareClip(bytes); assert.equal(clip.ok, false); return clip.code; };
  assert.equal(why(Buffer.from('not a wav at all, just some text that is long enough to pass a size check....')), 'clip-format');
  assert.equal(why(Buffer.alloc(10)), 'clip-format');
  assert.equal(why(speechWav({seconds: 12, rate: 8000})), 'clip-rate');
  assert.equal(why(speechWav({seconds: 3})), 'clip-short');
  assert.equal(why(speechWav({seconds: 4.9})), 'clip-short', 'at least 5 seconds');
  assert.equal(why(speechWav({seconds: 21})), 'clip-long');
  assert.equal(why(speechWav({seconds: 20.5})), 'clip-long', 'at most the 20 seconds OmniVoice accepts with the words the player typed');
  assert.equal(why(speechWav({clip: true})), 'clip-clipped');
  assert.equal(why(speechWav({level: 0.004})), 'clip-quiet');
  assert.equal(why(speechWav({silent: true})), 'clip-silent');
  const truncated = speechWav({seconds: 12}).subarray(0, 24000);   // a recorder that stopped early: what is there is used, and it is too short
  assert.equal(why(truncated), 'clip-short');
  const odd = speechWav({seconds: 12}); odd.writeUInt16LE(7, 20);
  assert.equal(why(odd), 'clip-format', 'a format the workers do not read');
  assert.equal(why(Buffer.alloc(CLIP.maxUploadBytes + 1)), 'clip-big');
});

test('a streamed WAV (ffmpeg writing to a pipe) claims no size: its data runs to the end of the file', () => {
  const wav = speechWav({seconds: 6});
  for (const claim of [0xFFFFFFFF, 0]) {
    const streamed = Buffer.from(wav); streamed.writeUInt32LE(0xFFFFFFFF, 4); streamed.writeUInt32LE(claim, 40);
    const decoded = decodeWav(streamed);
    assert.equal(decoded.ok, true, String(claim));
    assert.equal(Math.round(decoded.seconds * 10) / 10, 6);
    assert.equal(prepareClip(streamed).ok, true);
  }
});

test('the words said in the clip are checked and tidied', () => {
  assert.deepEqual(checkTranscript('  Hello   there,\nchoom. '), {ok: true, text: 'Hello there, choom.'});
  assert.equal(checkTranscript('hi').code, 'voice-text-short');
  assert.equal(checkTranscript('w'.repeat(CLIP.transcript + 1)).code, 'voice-text-long');
  assert.equal(checkSpeech(new Float32Array(48000).fill(0), 24000).code, 'clip-silent');
  assert.deepEqual(encodeWav(new Float32Array([0, 1, -1]), 24000).subarray(44).toJSON().data, [0, 0, 255, 127, 1, 128]);
});

// ---- formats

test('the kind of file is read from its first bytes, never from its name or claimed type', () => {
  const pad = head => Buffer.concat([Buffer.from(head, 'latin1'), Buffer.alloc(16)]);
  assert.equal(sniffAudio(speechWav({seconds: 1})), 'wav');
  assert.equal(sniffAudio(pad('fLaC')), 'flac');
  assert.equal(sniffAudio(pad('OggS')), 'ogg');
  assert.equal(sniffAudio(pad('ID3\x04')), 'mp3');
  assert.equal(sniffAudio(Buffer.concat([Buffer.from([0xFF, 0xFB, 0x90, 0x64]), Buffer.alloc(16)])), 'mp3', 'an MPEG-1 layer III frame');
  assert.equal(sniffAudio(Buffer.concat([Buffer.from([0xFF, 0xF1, 0x50, 0x80]), Buffer.alloc(16)])), null, 'AAC in ADTS is not MP3');
  assert.equal(sniffAudio(pad('RIFF\0\0\0\0AVI ')), null);
  assert.equal(sniffAudio(pad('<!DOCTYPE html>')), null);
  assert.equal(sniffAudio(Buffer.from('fLaC')), null, 'too short to be anything');
  assert.equal(sniffAudio('fLaC....'), null);
});

test('a WAV needs no tool; MP3, OGG and FLAC go through ffmpeg when the computer has it, and ask for a WAV when it has not', async () => {
  const wav = speechWav({seconds: 8});
  const noTool = async () => null;
  const plain = await prepareUpload(wav, {ffmpeg: noTool});
  assert.equal(plain.ok, true);
  assert.equal(plain.format, 'wav');
  const mp3 = Buffer.concat([Buffer.from('ID3\x04\0\0\0\0\0\0', 'latin1'), Buffer.alloc(2000, 7)]);
  assert.deepEqual(await prepareUpload(mp3, {ffmpeg: noTool}), {ok: false, code: 'clip-needs-wav', format: 'mp3'});
  assert.deepEqual(await prepareUpload(mp3, {ffmpeg: async () => { throw Error('probe failed'); }}), {ok: false, code: 'clip-needs-wav', format: 'mp3'});
  // With a tool: what it was asked to do, and that its answer is checked like any WAV.
  const calls = [];
  const fakeRun = answer => (command, args, options, done) => {
    calls.push({command, args, options});
    const child = {on() {}, stdin: {on() {}, end: bytes => setImmediate(() => answer instanceof Error ? done(answer) : done(null, answer, Buffer.alloc(0)))}};
    return child;
  };
  const converted = await prepareUpload(mp3, {ffmpeg: 'ffmpeg-here', run: fakeRun(prepareClip(speechWav({seconds: 9, rate: 24000})).wav)});
  assert.equal(converted.ok, true);
  assert.equal(converted.format, 'mp3');
  assert.equal(converted.rate, 24000);
  const {command, args, options} = calls[0];
  assert.equal(command, 'ffmpeg-here');
  assert.deepEqual(args.slice(args.indexOf('-format_whitelist'), args.indexOf('-format_whitelist') + 2), ['-format_whitelist', 'wav,flac,ogg,mp3'], 'only the four demuxers may read the file');
  assert.equal(args[args.indexOf('-i') + 1], 'pipe:0', 'through a pipe: no temporary file');
  assert.equal(args[args.indexOf('-t') + 1], String(CLIP.maxSeconds + 1), 'never more than a second past the limit is decoded');
  assert.equal(args[args.indexOf('-ar') + 1], '24000');
  assert.equal(args[args.indexOf('-ac') + 1], '1');
  assert.equal(options.windowsHide, true);
  assert(options.timeout > 0 && options.timeout <= 30000 && options.maxBuffer <= 16 * 1024 * 1024);
  assert.deepEqual(await prepareUpload(mp3, {ffmpeg: 'ffmpeg-here', run: fakeRun(Error('exit 1'))}), {ok: false, code: 'clip-format'});
  assert.deepEqual(await prepareUpload(mp3, {ffmpeg: 'ffmpeg-here', run: fakeRun(Buffer.from('garbage that is not a wav'))}), {ok: false, code: 'clip-format'});
  assert.equal((await prepareUpload(mp3, {ffmpeg: 'ffmpeg-here', run: fakeRun(speechWav({level: 0.002}))})).code, 'clip-quiet');
  assert.deepEqual(await prepareUpload(Buffer.from('text, not audio, long enough to be sniffed'), {ffmpeg: noTool}), {ok: false, code: 'clip-format'});
  assert.deepEqual(await prepareUpload(Buffer.alloc(CLIP.maxUploadBytes + 1, 1)), {ok: false, code: 'clip-big'});
  assert.deepEqual(await prepareUpload(Buffer.alloc(0)), {ok: false, code: 'clip-format'});
  assert.equal(await convertWithFfmpeg(mp3, null), null);
});

test('with the real ffmpeg (when this computer has it), tiny FLAC, OGG and MP3 clips become canonical 24 kHz mono WAVs', async t => {
  const ffmpeg = await findFfmpeg();
  if (!ffmpeg) { t.skip('ffmpeg is not on this computer'); return; }
  const dir = await mkdtemp(join(tmpdir(), 'player-voice-formats-'));
  try {
    const source = join(dir, 'source.wav');
    await writeFile(source, speechWav({seconds: 6, rate: 44100, channels: 2}));
    for (const [format, codec] of [['flac', 'flac'], ['ogg', 'libvorbis'], ['mp3', 'libmp3lame']]) {
      const target = join(dir, 'clip.' + format);
      const made = await new Promise(resolve => execFile(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', source, '-c:a', codec, target], {windowsHide: true, timeout: 20000}, error => resolve(!error)));
      if (!made) { t.diagnostic(`${format}: this ffmpeg cannot encode it, skipped`); continue; }
      const bytes = await readFile(target);
      assert.equal(sniffAudio(bytes), format);
      const clip = await prepareUpload(bytes, {ffmpeg});
      assert.equal(clip.ok, true, `${format}: ${JSON.stringify(clip)}`);
      assert.equal(clip.format, format);
      assert.equal(clip.rate, 24000);
      assert(Math.abs(clip.seconds - 6) <= 0.2, `${format}: ${clip.seconds} s`);
      const back = decodeWav(clip.wav);
      assert.equal(back.channels, 1);
      assert.equal(clip.wav.readUInt32LE(4) + 8, clip.wav.length);
    }
    // A long file is cut a second past the limit by ffmpeg and then refused, without decoding all of it.
    const long = join(dir, 'long.flac');
    await writeFile(join(dir, 'long.wav'), speechWav({seconds: 40, rate: 16000}));
    await new Promise(resolve => execFile(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', join(dir, 'long.wav'), long], {windowsHide: true, timeout: 20000}, () => resolve()));
    assert.equal((await prepareUpload(await readFile(long), {ffmpeg})).code, 'clip-long');
  } finally { await rm(dir, {recursive: true, force: true}); }
});

// ---- the store

const slash = path => path.replaceAll('\\', '/');
const memoryIo = (initial = {}) => {
  const files = new Map(Object.entries(initial)), log = {writes: [], removes: [], moves: [], failIndex: false, failClip: false};
  const missing = () => Object.assign(Error('ENOENT'), {code: 'ENOENT'});
  return {files, log, io: {
    read: async path => { if (!files.has(slash(path))) throw missing(); return String(files.get(slash(path))); },
    readBytes: async path => { if (!files.has(slash(path))) throw missing(); return Buffer.from(files.get(slash(path))); },
    write: async (path, data) => {
      log.writes.push(slash(path));
      if ((log.failIndex && slash(path).endsWith('.json')) || (log.failClip && slash(path).endsWith('.wav'))) throw Object.assign(Error('disk full'), {code: 'ENOSPC'});
      files.set(slash(path), Buffer.isBuffer(data) ? Buffer.from(data) : data); return true;
    },
    listDir: async dir => { const prefix = slash(dir) + '/'; const names = [...files.keys()].filter(name => name.startsWith(prefix) && !name.slice(prefix.length).includes('/')).map(name => name.slice(prefix.length));
      if (!names.length) throw missing(); return names.map(name => ({name, isFile: () => true, isSymbolicLink: () => false})); },
    remove: async path => { log.removes.push(slash(path)); files.delete(slash(path)); },
    move: async (from, to) => { log.moves.push([slash(from), slash(to)]); if (!files.has(slash(from))) throw missing(); files.set(slash(to), files.get(slash(from))); files.delete(slash(from)); },
  }};
};
const openStore = async (initial = {}, options = {}) => { const bench = memoryIo(initial); const store = await PlayerVoices.open({dir: 'state', now: () => 5000, ...bench.io, ...options}); return {...bench, store}; };

test('a key names a file only when every key check of the bridge and the workers would accept it', () => {
  for (const key of ['judy-alvarez', 'custom-rebecca-abcd', 'a', 'x'.repeat(80)]) assert.equal(isVoiceKey(key), true, key);
  for (const key of ['', 'Judy', '../judy', 'judy/alvarez', 'judy.alvarez', '-judy', 'x'.repeat(81), '__proto__', 'constructor', null, 7]) assert.equal(isVoiceKey(key), false, String(key));
});

test('a clip is checked, kept as player-voices/<key>.wav with its words in the index beside the folder, and offered to the voices', async () => {
  const {store, files} = await openStore();
  await assert.rejects(store.set('judy-alvarez', speechWav()), {code: 'voice-text-short'}, 'the words are needed with the first clip');
  await assert.rejects(store.set('../judy', speechWav(), WORDS), {code: 'bad-key'});
  await assert.rejects(store.set('judy-alvarez', Buffer.from('a long enough text that is not a recording at all, sorry'), WORDS), {code: 'clip-format'});
  await assert.rejects(store.set('judy-alvarez', speechWav({seconds: 3}), WORDS), error => error.code === 'clip-short' && error.min === CLIP.minSeconds);
  assert.equal(files.size, 0, 'nothing is written for a refused clip');
  const done = await store.set('judy-alvarez', speechWav({seconds: 11, rate: 48000, channels: 2}), `  ${WORDS}  `);
  assert.deepEqual(done.clip, {seconds: 11, rate: 48000, notes: [], format: 'wav'});
  const kept = files.get('state/player-voices/judy-alvarez.wav');
  assert.equal(sha(kept), done.entry.sha256);
  const index = JSON.parse(files.get('state/player-voices.json'));
  assert.deepEqual(index.voices['judy-alvarez'], {sha256: done.entry.sha256, seconds: 11, rate: 48000, transcript: WORDS, format: 'wav', updated: 5000});
  assert.deepEqual(store.get('judy-alvarez').transcript, WORDS);
  assert.deepEqual(store.list(), [{key: 'judy-alvarez', seconds: 11, rate: 48000, updated: 5000}], 'the list carries no words');
  assert.deepEqual((await store.extras()).map(item => ({...item, reference: slash(item.reference)})),
    [{key: 'judy-alvarez', reference: 'state/player-voices/judy-alvarez.wav', sha256: done.entry.sha256, transcript: WORDS, player: true}]);
  assert.deepEqual(await store.extras(key => key !== 'judy-alvarez'), [], 'a key the bridge no longer accepts is not offered');
  assert.deepEqual(await store.audio('judy-alvarez'), kept);
  assert.equal(await store.audio('panam-palmer'), null);
  // A new clip without words keeps the words; new words alone keep the clip.
  const again = await store.set('judy-alvarez', speechWav({seconds: 8}));
  assert.equal(again.entry.transcript, WORDS);
  assert.deepEqual(again.clip.notes, ['short']);
  const words = await store.setTranscript('judy-alvarez', 'Other words, said in the same clip.');
  assert.equal(words.sha256, again.entry.sha256);
  await assert.rejects(store.setTranscript('judy-alvarez', 'no'), {code: 'voice-text-short'});
  await assert.rejects(store.setTranscript('panam-palmer', WORDS), {code: 'not-found'});
  // A damaged or replaced file is never used, played or offered.
  files.set('state/player-voices/judy-alvarez.wav', Buffer.from('changed'));
  const logged = [];
  store.log = message => logged.push(message);
  assert.deepEqual(await store.extras(), []);
  assert.equal(await store.audio('judy-alvarez'), null);
  assert.match(logged.join('\n'), /judy-alvarez is not used: the clip does not match/);
  assert.equal(logged.join('\n').includes('Other words'), false, 'the words never reach a log');
});

test('removing a clip removes the file and the entry and tells the bridge; a removed clip is no longer offered, so the shipped voice is back', async () => {
  const removed = [];
  const {store, files} = await openStore({}, {onRemoved: key => { removed.push(key); if (removed.length === 2) throw Error('hook failed'); }});
  await store.set('judy-alvarez', speechWav(), WORDS);
  await store.set('custom-rebecca-abcd', speechWav(), WORDS);
  assert.equal(await store.clear('judy-alvarez'), true);
  assert.equal(files.has('state/player-voices/judy-alvarez.wav'), false);
  assert.equal(JSON.parse(files.get('state/player-voices.json')).voices['judy-alvarez'], undefined);
  assert.deepEqual((await store.extras()).map(item => item.key), ['custom-rebecca-abcd']);
  assert.deepEqual(removed, ['judy-alvarez']);
  assert.equal(await store.clear('judy-alvarez'), false);
  assert.deepEqual(removed, ['judy-alvarez'], 'nothing to tell for a clip that was not there');
  assert.equal(await store.clear('custom-rebecca-abcd'), true, 'a throwing hook is not an error of the removal');
  assert.equal(store.size, 0);
  // prune: the clips of characters that are gone.
  await store.set('custom-gone-aaaa', speechWav(), WORDS);
  await store.set('judy-alvarez', speechWav(), WORDS);
  assert.equal(await store.prune(key => !key.startsWith('custom-')), 1);
  assert.deepEqual(store.list().map(clip => clip.key), ['judy-alvarez']);
});

test('a failed save leaves the previous clip and its entry as they were', async () => {
  const {store, files, log} = await openStore();
  const first = await store.set('judy-alvarez', speechWav({seconds: 12}), WORDS);
  const before = Buffer.from(files.get('state/player-voices/judy-alvarez.wav'));
  log.failIndex = true;
  await assert.rejects(store.set('judy-alvarez', speechWav({seconds: 9}), WORDS), {code: 'ENOSPC'});
  assert.deepEqual(files.get('state/player-voices/judy-alvarez.wav'), before, 'the old clip is put back');
  assert.equal(store.get('judy-alvarez').sha256, first.entry.sha256);
  await assert.rejects(store.set('panam-palmer', speechWav(), WORDS), {code: 'ENOSPC'});
  assert.equal(files.has('state/player-voices/panam-palmer.wav'), false, 'a new clip whose entry was not saved is removed');
  log.failIndex = false; log.failClip = true;
  await assert.rejects(store.set('judy-alvarez', speechWav({seconds: 9}), WORDS), {code: 'ENOSPC'});
  assert.equal(store.get('judy-alvarez').sha256, first.entry.sha256);
  assert.equal(sha(files.get('state/player-voices/judy-alvarez.wav')), first.entry.sha256);
});

test('writes happen one at a time, a limit keeps the folder bounded, and a damaged index is kept as .corrupt before the first save', async () => {
  const {store, files} = await openStore({}, {limits: {clips: 2}});
  const results = await Promise.all([store.set('a-one', speechWav(), WORDS), store.set('b-two', speechWav(), WORDS), store.set('c-three', speechWav(), WORDS).catch(error => error)]);
  assert.equal(results[2].code, 'clips-full');
  assert.equal(results[2].max, 2);
  assert.deepEqual(Object.keys(JSON.parse(files.get('state/player-voices.json')).voices), ['a-one', 'b-two']);
  const damaged = await openStore({'state/player-voices.json': '{"version":1,"voices":', 'state/player-voices/judy-alvarez.wav': speechWav()});
  assert.equal(damaged.store.size, 0);
  assert.equal(damaged.files.has('state/player-voices/judy-alvarez.wav'), false, 'a clip no entry names is swept at start');
  assert.equal(damaged.files.get('state/player-voices.json'), '{"version":1,"voices":', 'left alone until a save');
  await damaged.store.set('panam-palmer', speechWav(), WORDS);
  assert.equal(damaged.files.get('state/player-voices.json.corrupt'), '{"version":1,"voices":');
  // A hand-edited entry is read within the limits or dropped.
  assert.equal(readEntry({sha256: 'a'.repeat(64), seconds: 12, rate: 24000, transcript: WORDS}).format, 'wav');
  for (const bad of [null, {sha256: 'x', seconds: 12, rate: 24000, transcript: WORDS}, {sha256: 'a'.repeat(64), seconds: 99, rate: 24000, transcript: WORDS},
    {sha256: 'a'.repeat(64), seconds: 12, rate: 8000, transcript: WORDS}, {sha256: 'a'.repeat(64), seconds: 12, rate: 24000, transcript: 'no'}]) assert.equal(readEntry(bad), null, JSON.stringify(bad));
});

test('on a real disk: the folder holds the clips and nothing else, the index sits beside it, and everything survives a restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'player-voices-'));
  try {
    const first = await PlayerVoices.open({dir});
    await first.set('judy-alvarez', speechWav(), WORDS);
    await first.set('custom-rebecca-abcd', speechWav({seconds: 15}), WORDS);
    assert.deepEqual((await readdir(dir)).sort(), [PLAYER_VOICES_FOLDER, PLAYER_VOICES_FILE].sort());
    assert.deepEqual((await readdir(join(dir, PLAYER_VOICES_FOLDER))).sort(), ['custom-rebecca-abcd.wav', 'judy-alvarez.wav']);
    assert.equal(first.folder, join(dir, PLAYER_VOICES_FOLDER));
    const second = await PlayerVoices.open({dir});
    assert.equal(second.get('custom-rebecca-abcd').seconds, 15);
    assert.equal((await second.extras()).length, 2);
    // Leftovers of a save that stopped half way go at the next start; a folder or another file name is never touched.
    await writeFile(join(dir, PLAYER_VOICES_FOLDER, 'panam-palmer.wav'), 'half');
    await writeFile(join(dir, PLAYER_VOICES_FOLDER, 'notes.txt'), 'mine');
    await mkdir(join(dir, PLAYER_VOICES_FOLDER, 'kerry.wav'));
    await second.clear('judy-alvarez');
    await PlayerVoices.open({dir});
    assert.deepEqual((await readdir(join(dir, PLAYER_VOICES_FOLDER))).sort(), ['custom-rebecca-abcd.wav', 'kerry.wav', 'notes.txt']);
  } finally { await rm(dir, {recursive: true, force: true}); }
});

// ---- what a report may say, and what Voxtral prepared

test('a support report learns how many clips there are and how long each is, never the words, the audio or a custom name', async () => {
  const {store, files} = await openStore();
  await store.set('judy-alvarez', speechWav({seconds: 12}), 'Secret words only the player should ever see.');
  await store.set('custom-rebecca-abcd', speechWav({seconds: 9}), 'More secret words for the custom one.');
  const summary = await readPlayerVoiceSummary('state', {read: async path => String(files.get(slash(path)))});
  assert.deepEqual(summary, {count: 2, clips: [{character: 'custom', seconds: 9}, {character: 'judy-alvarez', seconds: 12}]});
  const text = JSON.stringify(summary);
  for (const secret of ['Secret words', 'More secret', 'rebecca', 'player-voices', '.wav', store.get('judy-alvarez').sha256]) assert.equal(text.includes(secret), false, secret);
  assert.deepEqual(await readPlayerVoiceSummary('nowhere', {read: async () => { throw Object.assign(Error('ENOENT'), {code: 'ENOENT'}); }}), {count: 0, clips: []});
  assert.deepEqual(await readPlayerVoiceSummary('x', {read: async () => '{broken'}), {count: 0, clips: []});
});

test('Voxtral\'s prepared slots of a removed clip go with it, and only files with exactly a slot\'s name', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'player-prepared-'));
  try {
    const folder = join(dir, PLAYER_PREPARED_FOLDER);
    await mkdir(folder);
    for (const name of ['judy-alvarez.json', 'judy-alvarez.ogg', 'judy-alvarez.ogg.tmp', 'panam-palmer.json', 'panam-palmer.mp3', 'judy-alvarez.txt', 'notes.md'])
      await writeFile(join(folder, name), 'x');
    await mkdir(join(folder, 'kerry.json'));
    assert.equal(await releasePreparedSlots({folder, key: 'judy-alvarez'}), 3);
    assert.deepEqual((await readdir(folder)).sort(), ['judy-alvarez.txt', 'kerry.json', 'notes.md', 'panam-palmer.json', 'panam-palmer.mp3']);
    assert.equal(await releasePreparedSlots({folder, keep: new Set(['panam-palmer'])}), 0);
    assert.equal(await releasePreparedSlots({folder, keep: new Set()}), 2);
    assert.equal(await releasePreparedSlots({folder: join(dir, 'nowhere'), key: 'x'}), 0);
    assert.equal(await releasePreparedSlots({folder: null}), 0);
  } finally { await rm(dir, {recursive: true, force: true}); }
});
