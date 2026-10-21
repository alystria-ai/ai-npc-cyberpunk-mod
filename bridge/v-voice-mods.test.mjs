import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, rm, utimes, readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {readFileSync, existsSync} from 'node:fs';
import {depotHash, openArchive, EMPTY_SHA1} from './rdar.mjs';
import {parseModLines, detectVoiceMods, inspectArchive, linesHeld, ensureVoiceModReferences, findVgmstream, GENDERS} from './v-voice-mods.mjs';
import {resamplePoly, trimSilence, gatedRmsDb, chooseClips, joinClips, buildModReference, prepareClip, monoOf} from './v-voice-mod-reference.mjs';
import {encodeWav16} from './voxtral-reference.mjs';

// ---- helpers: a synthetic RDAR archive and WAVs (nothing here reads a game file) -------------------------------------------------------

/** files: [{path, bytes, storedSize?: number (a claimed stored size differing from the decoded one: "compressed"), sha1?: 'real'|'empty'|hex}] */
function makeArchive(files, {version = 12, indexOffsetShift = 0} = {}) {
  const header = Buffer.alloc(40);
  const bodies = files.map(file => file.bytes);
  let offset = 4096;
  const placed = bodies.map(bytes => { const at = offset; offset += Math.ceil(bytes.length / 16) * 16; return at; });
  const body = Buffer.alloc(offset - 4096);
  bodies.forEach((bytes, i) => bytes.copy(body, placed[i] - 4096));
  const count = files.length, indexSize = 28 + count * 56 + count * 16;
  const index = Buffer.alloc(indexSize);
  index.writeUInt32LE(8, 0); index.writeUInt32LE(indexSize - 8, 4);
  index.writeUInt32LE(count, 16); index.writeUInt32LE(count, 20); index.writeUInt32LE(0, 24);
  files.forEach((file, i) => {
    const at = 28 + i * 56;
    index.writeBigUInt64LE(BigInt('0x' + depotHash(file.path)), at);
    index.writeUInt32LE(i, at + 20); index.writeUInt32LE(i + 1, at + 24);
    const sha = file.sha1 === 'real' ? createHash('sha1').update(file.bytes).digest() : Buffer.from(file.sha1 && file.sha1 !== 'empty' ? file.sha1 : EMPTY_SHA1, 'hex');
    sha.copy(index, at + 36);
    const seg = 28 + count * 56 + i * 16;
    index.writeBigUInt64LE(BigInt(placed[i]), seg); index.writeUInt32LE(file.storedSize ?? file.bytes.length, seg + 8); index.writeUInt32LE(file.bytes.length, seg + 12);
  });
  const indexAt = offset + indexOffsetShift;
  header.write('RDAR', 0, 'latin1'); header.writeUInt32LE(version, 4); header.writeBigUInt64LE(BigInt(indexAt), 8); header.writeUInt32LE(indexSize, 16);
  header.writeBigUInt64LE(BigInt(indexAt + indexSize), 32);
  return Buffer.concat([header, Buffer.alloc(4096 - 40), body, index]);
}

function sine({seconds = 1, rate = 24000, hz = 220, level = 0.25, lead = 0, tail = 0} = {}) {
  const frames = Math.round(seconds * rate), out = new Float32Array(frames + Math.round((lead + tail) * rate));
  for (let i = 0; i < frames; i++) out[Math.round(lead * rate) + i] = level * Math.sin(2 * Math.PI * hz * i / rate);
  return out;
}
const wavOf = (samples, rate) => encodeWav16(samples, rate);

const PATHS = {
  male: ['ep1\\localization\\en-us\\vo\\v_mq301_m_2a9de24f93453000.wem', 'base\\localization\\en-us\\vo\\v_mq017_m_1aaea6c1fb44d000.wem', 'base\\localization\\en-us\\vo\\v_mq017_m_1aae98a2d244d000.wem', 'base\\localization\\en-us\\vo\\v_sq024_m_19c2dfcd2e521000.wem'],
  female: ['ep1\\localization\\en-us\\vo\\v_q306_f_2e4600ff1551400c.wem', 'ep1\\localization\\en-us\\vo\\v_q306_f_2c7d0480eb46a000.wem', 'ep1\\localization\\en-us\\vo\\v_q306_f_2cdb3ac08e51800c.wem', 'base\\localization\\en-us\\vo\\v_sq006_f_1927b4dc8c2d2000.wem'],
};
const PROBES = {
  male: Array.from({length: 20}, (_, i) => `base\\localization\\en-us\\vo\\v_q101_m_${(0x1000 + i).toString(16).padStart(16, '0')}.wem`),
  female: Array.from({length: 20}, (_, i) => `base\\localization\\en-us\\vo\\v_q101_f_${(0x2000 + i).toString(16).padStart(16, '0')}.wem`),
};
function linesText() {
  const genders = {};
  for (const gender of GENDERS) genders[gender] = {pool: 100, lines: PATHS[gender].map((path, i) => ({path, stringId: `${gender}${i}`, transcript: `Line ${i} of ${gender}.`, ...(i < 3 ? {pick: true} : {})})), probe: PROBES[gender].map(depotHash)};
  return JSON.stringify({version: 1, locale: 'en-us', genders});
}
const modLines = parseModLines(linesText());

async function withFolder(fn) {
  const folder = await mkdtemp(join(tmpdir(), 'vmods-test-'));
  try { return await fn(folder); } finally { await rm(folder, {recursive: true, force: true}); }
}
const wem = (seed = 1) => Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(60, seed)]);

// ---- the hash and the reader -----------------------------------------------------------------------------------------------------------

test('depotHash is FNV-1a 64 of the lower-case path (published test vectors)', () => {
  assert.equal(depotHash('a'), 'af63dc4c8601ec8c');
  assert.equal(depotHash('foobar'), '85944171f73967e8');
  assert.equal(depotHash('FooBar'), depotHash('foobar'));
});

test('the reader finds, reads and checks files of an archive', async () => {
  await withFolder(async folder => {
    const a = wem(1), b = wem(2);
    await writeFile(join(folder, 'x.archive'), makeArchive([{path: PATHS.male[0], bytes: a}, {path: PATHS.male[1], bytes: b, sha1: 'real'}]));
    const archive = await openArchive(join(folder, 'x.archive'));
    try {
      assert.equal(archive.entries, 2);
      const found = archive.scan([depotHash(PATHS.male[1]), depotHash(PATHS.female[0])]);
      assert.deepEqual([...found.keys()], [depotHash(PATHS.male[1])]);
      assert.ok((await archive.read(depotHash(PATHS.male[0]))).equals(a), 'an entry holding the SHA-1 of nothing (WolvenKit) is read without the check');
      assert.ok((await archive.read(depotHash(PATHS.male[1]))).equals(b), 'a real SHA-1 is checked');
      await assert.rejects(archive.read(depotHash(PATHS.female[0])), {code: 'missing'});
    } finally { await archive.close(); }
  });
});

test('a wrong SHA-1, a compressed file and a broken archive are refused, never read past their bounds', async () => {
  await withFolder(async folder => {
    await writeFile(join(folder, 'x.archive'), makeArchive([{path: PATHS.male[0], bytes: wem(1), sha1: '00'.repeat(20)}, {path: PATHS.male[1], bytes: wem(2), storedSize: 30}]));
    const archive = await openArchive(join(folder, 'x.archive'));
    await assert.rejects(archive.read(depotHash(PATHS.male[0])), {code: 'bad-hash'});
    await assert.rejects(archive.read(depotHash(PATHS.male[1])), {code: 'compressed'});
    await archive.close();
    await writeFile(join(folder, 'notrdar.archive'), Buffer.alloc(100, 1));
    await assert.rejects(openArchive(join(folder, 'notrdar.archive')), {code: 'not-rdar'});
    await writeFile(join(folder, 'v13.archive'), makeArchive([{path: PATHS.male[0], bytes: wem(1)}], {version: 13}));
    await assert.rejects(openArchive(join(folder, 'v13.archive')), {code: 'not-rdar'});
    await writeFile(join(folder, 'outside.archive'), makeArchive([{path: PATHS.male[0], bytes: wem(1)}], {indexOffsetShift: 100000}));
    await assert.rejects(openArchive(join(folder, 'outside.archive')), {code: 'bad-index'});
    await writeFile(join(folder, 'short.archive'), Buffer.from('RDAR'));
    await assert.rejects(openArchive(join(folder, 'short.archive')), {code: 'not-rdar'});
  });
});

// ---- the line list --------------------------------------------------------------------------------------------------------------------

test('the shipped line list is valid, holds the English picks first, and every hash is a hash of its path', () => {
  const shipped = parseModLines(readFileSync(new URL('../assets/v-voice/v-mod-lines.json', import.meta.url), 'utf8'));
  const english = JSON.parse(readFileSync(new URL('../assets/v-voice/v-voice.json', import.meta.url), 'utf8')).voices;
  for (const gender of GENDERS) {
    const {lines, probe} = shipped.genders[gender];
    assert.equal(probe.length, 300);
    assert.deepEqual(lines.slice(0, 3).map(line => line.stringId), english[gender].clips.map(clip => clip.stringId), 'the three clips of the shipped reference, in order');
    assert.equal(lines.slice(0, 3).map(line => line.transcript).join(' '), english[gender].transcript, 'their words are the shipped reference\'s words');
    assert.ok(lines.slice(0, 3).every(line => line.pick) && lines.slice(3).every(line => !line.pick));
    for (const line of lines) assert.equal(line.hash, depotHash(line.path));
  }
  assert.throws(() => parseModLines(JSON.stringify({version: 1, locale: 'en-us', genders: {male: {lines: [{path: 'x', transcript: 'a'}], probe: []}, female: {lines: [], probe: []}}})), /bad path/);
});

// ---- detection -------------------------------------------------------------------------------------------------------------------------

test('an archive that holds a gender\'s lines and most of its sample is a V voice mod for that gender; others are not', async () => {
  await withFolder(async folder => {
    await writeFile(join(folder, 'voice_f.archive'), makeArchive([...PATHS.female, ...PROBES.female.slice(0, 15)].map((path, i) => ({path, bytes: wem(i)}))));
    await writeFile(join(folder, 'body.archive'), makeArchive([{path: 'base\\characters\\something.mesh', bytes: Buffer.alloc(64)}]));
    await writeFile(join(folder, 'few.archive'), makeArchive([...PATHS.male.slice(0, 3), ...PROBES.male.slice(0, 2)].map((path, i) => ({path, bytes: wem(i)}))));
    const result = await detectVoiceMods({folder, modLines});
    assert.equal(result.stats.total, 3);
    assert.equal(result.winners.female.relative, 'voice_f.archive');
    assert.equal(result.winners.male, null, 'three lines of ours but 10 % of the sample: not a V voice mod');
    const female = result.archives.find(a => a.relative === 'voice_f.archive').female;
    assert.equal(female.probeHits, 15); assert.equal(female.lineHits.length, 4);
    assert.deepEqual(linesHeld(modLines, 'female', result.archives.find(a => a.relative === 'voice_f.archive')).map(line => line.stringId), ['female0', 'female1', 'female2', 'female3']);
  });
});

test('with two V voice mods the later one in alphabetical order wins; subfolders are looked into', async () => {
  await withFolder(async folder => {
    const files = [...PATHS.male, ...PROBES.male].map((path, i) => ({path, bytes: wem(i)}));
    await writeFile(join(folder, 'aaa.archive'), makeArchive(files));
    await rm(join(folder, 'sub'), {recursive: true, force: true});
    await (await import('node:fs/promises')).mkdir(join(folder, 'sub'));
    await writeFile(join(folder, 'sub', 'ZZZ.ARCHIVE'), makeArchive(files));
    const result = await detectVoiceMods({folder, modLines});
    assert.deepEqual(result.archives.map(a => a.relative), ['aaa.archive', 'sub/ZZZ.ARCHIVE']);
    assert.equal(result.winners.male.relative, 'sub/ZZZ.ARCHIVE');
  });
});

test('the cache is keyed by path, size and time: an unchanged archive is not opened again, a changed one is', async () => {
  await withFolder(async folder => {
    const cachePath = join(folder, 'cache.json'), mods = join(folder, 'mods');
    await (await import('node:fs/promises')).mkdir(mods);
    await writeFile(join(mods, 'a.archive'), makeArchive([...PATHS.female, ...PROBES.female].map((path, i) => ({path, bytes: wem(i)}))));
    let opened = 0;
    const inspect = (file, lines) => { opened++; return inspectArchive(file, lines); };
    const first = await detectVoiceMods({folder: mods, modLines, cachePath, inspect});
    assert.equal(opened, 1); assert.equal(first.stats.inspected, 1);
    const second = await detectVoiceMods({folder: mods, modLines, cachePath, inspect});
    assert.equal(opened, 1, 'cached'); assert.equal(second.stats.cached, 1); assert.equal(second.winners.female.relative, 'a.archive'); assert.equal(second.archives[0].cached, true);
    await utimes(join(mods, 'a.archive'), new Date(), new Date(Date.now() + 5000));
    await detectVoiceMods({folder: mods, modLines, cachePath, inspect});
    assert.equal(opened, 2, 'a changed time means a new look');
    const other = parseModLines(JSON.stringify({...JSON.parse(linesText()), about: 'changed list'}));
    await detectVoiceMods({folder: mods, modLines: other, cachePath, inspect});
    assert.equal(opened, 3, 'a changed line list means a new look');
    await writeFile(cachePath, '{not json');
    await detectVoiceMods({folder: mods, modLines, cachePath, inspect});
    assert.equal(opened, 4, 'a damaged cache is rebuilt, not an error');
  });
});

test('an unreadable or foreign archive never throws and is remembered as failed; a missing folder is an empty result', async () => {
  await withFolder(async folder => {
    await writeFile(join(folder, 'junk.archive'), Buffer.alloc(500, 7));
    const cachePath = join(folder, 'cache.json');
    const result = await detectVoiceMods({folder, modLines, cachePath});
    assert.equal(result.stats.failed, 1); assert.equal(result.archives[0].error, 'not-rdar'); assert.equal(result.winners.male, null);
    const again = await detectVoiceMods({folder, modLines, cachePath});
    assert.equal(again.stats.cached, 1, 'a failure is cached too (not retried at every start)');
    const none = await detectVoiceMods({folder: join(folder, 'missing'), modLines});
    assert.deepEqual(none.archives, []);
  });
});

test('scanning a large index costs a few milliseconds and no per-entry allocation', async () => {
  await withFolder(async folder => {
    const files = Array.from({length: 60000}, (_, i) => ({path: `base\\other\\file_${i}.bin`, bytes: Buffer.alloc(16)})).concat(PATHS.male.map(path => ({path, bytes: wem(1)})));
    await writeFile(join(folder, 'big.archive'), makeArchive(files));
    const started = performance.now();
    const archive = await openArchive(join(folder, 'big.archive'));
    const found = archive.scan([...PROBES.male, ...PATHS.male].map(depotHash));
    await archive.close();
    assert.equal(found.size, 4);
    assert.ok(performance.now() - started < 1500, 'a 60 000 entry index is scanned well inside a second');
  });
});

// ---- the reference --------------------------------------------------------------------------------------------------------------------

test('resamplePoly keeps a tone\'s pitch and level and gives ceil(n * up / down) samples', () => {
  const tone = sine({seconds: 1, rate: 40000, hz: 440, level: 0.5});
  const out = resamplePoly(tone, 40000, 24000);
  assert.equal(out.length, 24000);
  let crossings = 0;
  for (let i = 1; i < out.length; i++) if (out[i - 1] < 0 && out[i] >= 0) crossings++;
  assert.ok(Math.abs(crossings - 440) <= 1, `440 Hz kept (${crossings})`);
  const peak = out.slice(2000, 22000).reduce((m, v) => Math.max(m, Math.abs(v)), 0);
  assert.ok(Math.abs(peak - 0.5) < 0.01, `level kept (${peak})`);
  assert.deepEqual([...resamplePoly(Float32Array.from([0.1, 0.2]), 24000, 24000)], [Float32Array.from([0.1, 0.2])[0], Float32Array.from([0.1, 0.2])[1]]);
});

test('resamplePoly removes what a lower rate cannot hold (no folding back)', () => {
  const tone = sine({seconds: 0.5, rate: 40000, hz: 15000, level: 0.5});
  const out = resamplePoly(tone, 40000, 24000);
  assert.ok(out.slice(1000, 11000).reduce((m, v) => Math.max(m, Math.abs(v)), 0) < 0.01, '15 kHz is above the new Nyquist and is filtered out');
});

test('trimSilence cuts below -45 dBFS keeping 80 ms; gatedRmsDb measures only the speaking frames', () => {
  const clip = sine({seconds: 1, rate: 24000, level: 0.2, lead: 1, tail: 1});
  const trimmed = trimSilence(clip);
  assert.ok(Math.abs(trimmed.length / 24000 - 1.16) < 0.03, `1 s of tone plus 2 x 80 ms (${trimmed.length / 24000})`);
  assert.equal(trimSilence(new Float32Array(24000)).length, 24000, 'no speech: unchanged');
  assert.ok(Math.abs(gatedRmsDb(clip) - (20 * Math.log10(0.2 / Math.SQRT2))) < 0.3);
  assert.equal(gatedRmsDb(new Float32Array(24000)), null);
});

test('chooseClips keeps the set within 2 dB and 8 to 20 s, skipping a clip that breaks the spread', () => {
  const make = (seconds, gatedRmsDb) => ({seconds, gatedRmsDb});
  assert.deepEqual(chooseClips([make(4, -20), make(4, -21), make(4, -20.5)]), [0, 1, 2]);
  assert.deepEqual(chooseClips([make(4, -20), make(4, -26), make(4, -21), make(4, -20.5)]), [0, 2, 3], 'the quiet clip is skipped, a spare takes its place');
  assert.deepEqual(chooseClips([make(4, -20), make(3, -20)]), [], 'under 8 s: no set');
  assert.deepEqual(chooseClips([make(9, -20), make(9, -20), make(9, -20)]).length, 2, 'never over 20 s');
  assert.deepEqual(chooseClips([make(5, null), make(5, -20), make(5, -20)]), [1, 2], 'a clip with no speech is left out');
});

test('buildModReference reads the held lines in order, decodes them, joins them with 0.4 s gaps and writes the shipped reference\'s fields', async () => {
  await withFolder(async folder => {
    const files = PATHS.male.map((path, i) => ({path, bytes: Buffer.concat([Buffer.from('RIFF'), Buffer.from([i])])}));
    await writeFile(join(folder, 'm.archive'), makeArchive(files));
    const decodes = [];
    const decode = async bytes => { decodes.push(bytes[4]); return wavOf(sine({seconds: 3.5, rate: 40000, level: 0.2, lead: 0.3, tail: 0.3}), 40000); };
    const made = await buildModReference({archive: join(folder, 'm.archive'), lines: modLines.genders.male.lines, decode, file: 'v-male.wav'});
    assert.deepEqual(decodes, [0, 1, 2], 'the picks first, and only as many as the target length needs');
    const wav = monoOf(made.wav);
    assert.equal(wav.rate, 24000);
    assert.ok(Math.abs(made.entry.seconds - (3 * 3.66 + 0.8)) < 0.1, `three trimmed clips and two gaps (${made.entry.seconds})`);
    assert.equal(made.entry.transcript, 'Line 0 of male. Line 1 of male. Line 2 of male.');
    assert.equal(made.entry.sha256, createHash('sha256').update(made.wav).digest('hex'));
    assert.equal(made.entry.file, 'v-male.wav'); assert.equal(made.entry.sampleRate, 24000);
    assert.deepEqual(made.entry.clips.map(clip => clip.stringId), ['male0', 'male1', 'male2']);
    // the gap is silent
    const clip = prepareClip(wavOf(sine({seconds: 3.5, rate: 40000, level: 0.2, lead: 0.3, tail: 0.3}), 40000));
    const first = Math.round(clip.seconds * 24000);
    assert.ok(wav.samples.slice(first + 100, first + 9000).every(v => Math.abs(v) < 1e-4), 'silence between the clips');
  });
});

test('buildModReference says why it could not: no lines, a failing decoder, no fitting set', async () => {
  await withFolder(async folder => {
    await writeFile(join(folder, 'none.archive'), makeArchive([{path: 'base\\other\\x.bin', bytes: Buffer.alloc(8)}]));
    await assert.rejects(buildModReference({archive: join(folder, 'none.archive'), lines: modLines.genders.male.lines, decode: async () => wavOf(sine(), 24000)}), {code: 'no-lines'});
    await writeFile(join(folder, 'm.archive'), makeArchive(PATHS.male.map((path, i) => ({path, bytes: wem(i)}))));
    await assert.rejects(buildModReference({archive: join(folder, 'm.archive'), lines: modLines.genders.male.lines, decode: async () => { throw Error('boom'); }}), {code: 'decoder'});
    await assert.rejects(buildModReference({archive: join(folder, 'm.archive'), lines: modLines.genders.male.lines, decode: async () => wavOf(sine({seconds: 1}), 24000)}), {code: 'no-set'});
    await writeFile(join(folder, 'c.archive'), makeArchive(PATHS.male.map((path, i) => ({path, bytes: wem(i), storedSize: 20}))));
    await assert.rejects(buildModReference({archive: join(folder, 'c.archive'), lines: modLines.genders.male.lines, decode: async () => wavOf(sine(), 24000)}), {code: 'no-set'}, 'compressed lines are skipped, nothing left to build from');
  });
});

// ---- keeping the references current ----------------------------------------------------------------------------------------------------

test('ensureVoiceModReferences builds from the winning archive, keeps the result while the archive is unchanged, rebuilds when it changes and removes it when the mod is gone', async () => {
  await withFolder(async folder => {
    const mods = join(folder, 'mods'), out = join(folder, 'v-voice-mod'), cachePath = join(folder, 'cache.json');
    await (await import('node:fs/promises')).mkdir(mods);
    await writeFile(join(mods, 'jc.archive'), makeArchive([...PATHS.male.slice(0, 3), ...PROBES.male].map((path, i) => ({path, bytes: wem(i)}))));
    let decodes = 0;
    const decode = async () => { decodes++; return wavOf(sine({seconds: 3.5, rate: 40000, level: 0.2, lead: 0.2, tail: 0.2}), 40000); };
    const logs = [];
    const first = await ensureVoiceModReferences({modFolder: mods, outFolder: out, modLines, decode, cachePath, log: line => logs.push(line)});
    assert.deepEqual(first.voices, {male: 'built'});
    assert.match(logs.join(' '), /male reference was built from jc\.archive /);
    assert.equal(first.directory, out);
    const manifest = JSON.parse(await readFile(join(out, 'v-voice.json'), 'utf8'));
    assert.equal(manifest.voices.male.file, 'v-male.wav'); assert.equal(manifest.voices.male.source.archive, 'jc.archive');
    assert.equal(createHash('sha256').update(await readFile(join(out, 'v-male.wav'))).digest('hex'), manifest.voices.male.sha256, 'the manifest is the one loadVVoiceReferences checks');
    const before = decodes;
    const second = await ensureVoiceModReferences({modFolder: mods, outFolder: out, modLines, decode, cachePath});
    assert.deepEqual(second.voices, {male: 'kept'}); assert.equal(decodes, before, 'nothing decoded again');
    await utimes(join(mods, 'jc.archive'), new Date(), new Date(Date.now() + 9000));
    assert.deepEqual((await ensureVoiceModReferences({modFolder: mods, outFolder: out, modLines, decode, cachePath})).voices, {male: 'built'}, 'a changed archive is built again');
    await writeFile(join(out, 'v-male.wav'), Buffer.from('damaged'));
    assert.deepEqual((await ensureVoiceModReferences({modFolder: mods, outFolder: out, modLines, decode, cachePath})).voices, {male: 'built'}, 'a damaged reference is built again');
    await rm(join(mods, 'jc.archive'));
    const gone = await ensureVoiceModReferences({modFolder: mods, outFolder: out, modLines, decode, cachePath});
    assert.deepEqual(gone.voices, {male: 'removed'}); assert.equal(gone.directory, null);
    assert.equal(existsSync(join(out, 'v-male.wav')), false);
  });
});

test('ensureVoiceModReferences without a decoder builds nothing and says so; a failing build is reported, not thrown', async () => {
  await withFolder(async folder => {
    const mods = join(folder, 'mods'), out = join(folder, 'out');
    await (await import('node:fs/promises')).mkdir(mods);
    await writeFile(join(mods, 'ariana.archive'), makeArchive([...PATHS.female, ...PROBES.female].map((path, i) => ({path, bytes: wem(i)}))));
    const none = await ensureVoiceModReferences({modFolder: mods, outFolder: out, modLines});
    assert.deepEqual(none.voices, {female: 'needs-decoder'}); assert.equal(none.directory, null); assert.equal(existsSync(out), false, 'nothing written');
    const failed = await ensureVoiceModReferences({modFolder: mods, outFolder: out, modLines, decode: async () => { throw Error('no tool'); }});
    assert.deepEqual(failed.voices, {female: 'failed:decoder'});
  });
});

test('findVgmstream takes an explicit path, then the environment, then the candidates', async () => {
  const exists = async path => path.startsWith('/there');
  assert.equal(await findVgmstream({explicit: '/there/a', env: {}, exists}), '/there/a');
  assert.equal(await findVgmstream({explicit: '/missing', env: {CYBERPUNK_CONVAI_VGMSTREAM: '/there/b'}, exists}), '/there/b');
  assert.equal(await findVgmstream({env: {}, candidates: ['/missing/c', '/there/c'], exists}), '/there/c');
  assert.equal(await findVgmstream({env: {}, candidates: ['/missing/c'], exists}), null);
});

// ---- REDmod, load order, compressed lines ------------------------------------------------------------------------------------------------

test('listVoiceModArchives lists archive/pc/mod, then REDmod\'s mods/<name>/archives, mods alphabetically', async () => {
  await withFolder(async game => {
    const {mkdir} = await import('node:fs/promises');
    const {listVoiceModArchives} = await import('./v-voice-mods.mjs');
    const junk = makeArchive([{path: 'base/x.bin', bytes: Buffer.alloc(8)}]);
    for (const dir of ['archive/pc/mod', 'mods/Beta/archives', 'mods/alpha/archives', 'mods/NoArchives']) await mkdir(join(game, dir), {recursive: true});
    await writeFile(join(game, 'archive/pc/mod/zz.archive'), junk); await writeFile(join(game, 'archive/pc/mod/aa.archive'), junk); await writeFile(join(game, 'archive/pc/mod/readme.txt'), 'x');
    await writeFile(join(game, 'mods/Beta/archives/b.archive'), junk); await writeFile(join(game, 'mods/alpha/archives/a.archive'), junk);
    assert.deepEqual((await listVoiceModArchives({game})).map(row => row.relative), ['aa.archive', 'zz.archive', 'redmod/alpha/a.archive', 'redmod/Beta/b.archive']);
    assert.deepEqual(await listVoiceModArchives({game: join(game, 'missing')}), [], 'no game folder: nothing');
  });
});

test('with two V voice mods the winner is logged; a REDmod mod loads after archive/pc/mod', async () => {
  await withFolder(async game => {
    const {mkdir} = await import('node:fs/promises');
    const {listVoiceModArchives} = await import('./v-voice-mods.mjs');
    const files = [...PATHS.female, ...PROBES.female].map((path, i) => ({path, bytes: wem(i)}));
    await mkdir(join(game, 'archive/pc/mod'), {recursive: true}); await mkdir(join(game, 'mods/Voice/archives'), {recursive: true});
    await writeFile(join(game, 'archive/pc/mod/zzz_first.archive'), makeArchive(files)); await writeFile(join(game, 'mods/Voice/archives/Voice.archive'), makeArchive(files));
    const logs = [];
    const result = await detectVoiceMods({list: () => listVoiceModArchives({game}), modLines, log: line => logs.push(line)});
    assert.equal(result.winners.female.relative, 'redmod/Voice/Voice.archive');
    assert.equal(logs.length, 1);
    assert.match(logs[0], /2 mods replace V's female voice \(zzz_first\.archive, Voice\.archive\); the last in load order wins: Voice\.archive/);
    assert.doesNotMatch(logs[0], /[\/]/, 'file names only');
  });
});

test('compressed lines are skipped with one log line; a mod of only compressed lines builds nothing', async () => {
  await withFolder(async folder => {
    const logs = [];
    const decode = async () => wavOf(sine({seconds: 3.5, rate: 40000, level: 0.2, lead: 0.2, tail: 0.2}), 40000);
    const mixed = PATHS.male.map((path, i) => ({path, bytes: wem(i), ...(i === 0 ? {storedSize: 20} : {})}));
    await writeFile(join(folder, 'mixed.archive'), makeArchive(mixed));
    const made = await buildModReference({archive: join(folder, 'mixed.archive'), lines: modLines.genders.male.lines, decode, log: line => logs.push(line)});
    assert.deepEqual(made.entry.clips.map(c => c.stringId), ['male1', 'male2', 'male3'], 'the compressed pick is skipped, a spare line takes its place');
    assert.deepEqual(logs, ['1 line(s) of the mod are stored compressed, which is not supported; they were skipped']);
    logs.length = 0;
    await writeFile(join(folder, 'all.archive'), makeArchive(PATHS.male.map((path, i) => ({path, bytes: wem(i), storedSize: 20}))));
    await assert.rejects(buildModReference({archive: join(folder, 'all.archive'), lines: modLines.genders.male.lines, decode, log: line => logs.push(line)}), {code: 'no-set'});
    assert.equal(logs.length, 1);
  });
});
