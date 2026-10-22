import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, existsSync} from 'node:fs';
import {mkdtemp, writeFile, readFile, readdir, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {VGMSTREAM_LIMITS, vgmstreamDecoder} from './v-voice-mod-reference.mjs';
import {LiveVoices} from './live-voices.mjs';
import {V_VOICE_KEYS} from './v-voice.mjs';

const bridge = readFileSync(new URL('./convai-bridge.mjs', import.meta.url), 'utf8');

test('at start the bridge only reads what an earlier V voice mod scan built (no scan, no process), before the voice configurations are merged', () => {
  const start = bridge.indexOf('await loadVVoiceReferencesWithMods({...vVoiceLoadOptions, scan: false})'), merged = bridge.indexOf('addonHost.voiceConfigPaths(');
  assert.ok(start > 0 && merged > start, 'the start-up call is scan: false and comes before the merge');
  assert.doesNotMatch(bridge, /ensureVoiceModReferences|detectVoiceMods|listVoiceModArchives/, 'the bridge never runs the archive scan itself');
  assert.match(bridge, /const \{report: initialVVoiceModReport, \.\.\.vVoiceReferences\} = await loadVVoiceReferencesWithMods\(/);
});

test('the scan runs once, in the background a little after start-up, and only while V\'s voice is on; what it changes is installed and applied live', () => {
  const scans = [...bridge.matchAll(/loadVVoiceReferencesWithMods\(\{\.\.\.vVoiceLoadOptions, scan: true, current: vVoiceReferences\.voices\}\)/g)];
  assert.equal(scans.length, 1, 'one scan call in the whole bridge');
  assert.match(bridge, /if \(vVoice\.enabled\) startVVoiceModScan\(\);/, 'asked for only on the settings poll, when V\'s voice is on');
  const starter = bridge.slice(bridge.indexOf('const startVVoiceModScan ='), bridge.indexOf('const startVVoiceModScan =') + 400);
  assert.match(starter, /if \(vModScanStarted\) return;/);
  assert.match(starter, /setTimeout\(\(\) => \{ void scanVVoiceMods\(\); \}, V_MOD_SCAN_DELAY_MS\)\.unref\?\.\(\)/, 'deferred, never awaited');
  const body = bridge.slice(bridge.indexOf('const scanVVoiceMods ='), bridge.indexOf('const startVVoiceModScan ='));
  assert.match(body, /installVVoiceReference\(voice, \[\.\.\.referenceRoots, voiceConfig\.runtime\?\.referenceDirectory\]/);
  assert.match(body, /await liveVoices\?\.refresh\(V_VOICE_KEYS\[gender\]\)/, 'the running voices follow, the player\'s own clip still wins inside refresh');
  assert.ok(!/await scanVVoiceMods|await startVVoiceModScan/.test(bridge), 'nothing waits for the scan');
});

test('the player\'s own clip for V is allowed, and beats the mod-built and the shipped reference (it is merged last, as a player clip)', () => {
  assert.match(bridge, /const playerVoiceAllowed = key => isCustomKey\(key\) \? customCharacters\.has\(key\) : Object\.values\(V_VOICE_KEYS\)\.includes\(key\)/);
  assert.match(bridge, /extra: extraVoices\(vVoiceReferences\)\.concat\(playerVoiceExtras\)/, 'the mod-built or shipped V voice first, the player\'s clips after (they replace a key)');
});

test('LiveVoices gets V\'s mod-built or shipped descriptor as its fallback, so removing V\'s clip needs no restart', async () => {
  assert.match(bridge, /fallback: key => \{\s*const voice = vGenderOfKey\(key\)/);
  const descriptor = {reference: 'runtime/voice-references/addons/v-male.wav', sha256: 'a'.repeat(64), transcript: 'Words.'};
  const applied = [];
  const live = new LiveVoices({voices: {pocket: {'v-male': {reference: 'runtime/player-voices/v-male.wav', sha256: 'b'.repeat(64), transcript: 'Mine.'}, other: {reference: 'x'}}, short: null, long: null},
    players: {extras: async () => []}, allowed: key => Object.values(V_VOICE_KEYS).includes(key), folder: '/x', apply: update => { applied.push(update); return true; },
    fallback: key => key === 'v-male' ? descriptor : null});
  await live.refresh('v-male');
  assert.deepEqual(applied[0].pocket['v-male'], descriptor, 'the clip is gone: V\'s reference, not a missing key');
  assert.deepEqual(applied[0].pocket.other, {reference: 'x'});
});

test('the V line log and the routing line name the reference; the support report carries the mod facts', () => {
  assert.match(bridge, /ref=\$\{JSON\.stringify\(summary\.reference \?\? 'shipped'\)\}/);
  assert.match(bridge, /routingLog\.record\(describeVLine\(\{input, summary\}\)\)/);
  assert.match(bridge, /const vReferenceLabel = gender => playerVoices\.has\(V_VOICE_KEYS\[gender\]\) \? 'manual'/);
  assert.match(bridge, /vVoiceMods: \{\.\.\.vVoiceModReport, references:/);
});

test('the decoder runs one process per line, in a private temporary folder that is removed, and leaves nothing resident', async () => {
  const seen = [];
  const run = (executable, args, options, done) => {
    seen.push({executable, args, options});
    writeFile(args[args.indexOf('-o') + 1], Buffer.from('RIFFwav')).then(() => done(null), done);
  };
  const before = (await readdir(tmpdir())).filter(name => name.startsWith('ainpc-vmod-'));
  const decode = vgmstreamDecoder('C:/app/vgmstream/vgmstream-cli.exe', {run, timeoutMs: 1234});
  assert.equal((await decode(Buffer.from('wem'))).toString(), 'RIFFwav');
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0].args.slice(0, 2), ['-i', '-o'], 'no looping: a loop point never makes the output longer');
  assert.equal(seen[0].options.timeout, 1234); assert.equal(seen[0].options.shell, false); assert.equal(seen[0].options.windowsHide, true);
  assert.ok(!existsSync(seen[0].args[2]), 'the temporary file is gone');
  assert.deepEqual((await readdir(tmpdir())).filter(name => name.startsWith('ainpc-vmod-')), before, 'and so is its folder');
  await assert.rejects(vgmstreamDecoder('x', {run: (e, a, o, done) => done(Error('exit 1'))})(Buffer.from('w')), /exit 1/);
  assert.deepEqual((await readdir(tmpdir())).filter(name => name.startsWith('ainpc-vmod-')), before, 'a failed decode leaves nothing either');
});

test('the decoder stops vgmstream the moment its output passes the size cap, and the folder is removed', async () => {
  const before = (await readdir(tmpdir())).filter(name => name.startsWith('ainpc-vmod-'));
  let killed = 0, finish = null;
  // A crafted file: the decoder keeps writing past the cap and never ends by itself.
  const run = (executable, args, options, done) => {
    finish = done;
    writeFile(args[args.indexOf('-o') + 1], Buffer.alloc(2048)).catch(() => {});
    return {kill() { killed += 1; done(Object.assign(Error('killed'), {killed: true, signal: 'SIGTERM'})); }};
  };
  const decode = vgmstreamDecoder('C:/app/vgmstream/vgmstream-cli.exe', {run, maxOutputBytes: 1024, pollMs: 5, timeoutMs: 60_000});
  await assert.rejects(decode(Buffer.from('wem')), error => error.code === 'too-large' && /passed/.test(error.message));
  assert.equal(killed, 1, 'vgmstream was stopped, once');
  assert.deepEqual((await readdir(tmpdir())).filter(name => name.startsWith('ainpc-vmod-')), before, 'nothing is left behind');
  assert.equal(typeof finish, 'function');
});

test('a decoder that finishes with an output over the cap is refused too, and the time cap says so', async () => {
  const big = (executable, args, options, done) => { writeFile(args[args.indexOf('-o') + 1], Buffer.alloc(4096)).then(() => done(null), done); };
  await assert.rejects(vgmstreamDecoder('x', {run: big, maxOutputBytes: 1024, pollMs: 100_000})(Buffer.from('w')), error => error.code === 'too-large');
  const slow = (executable, args, options, done) => { done(Object.assign(Error('Command failed'), {killed: true, signal: 'SIGTERM'})); };
  await assert.rejects(vgmstreamDecoder('x', {run: slow, timeoutMs: 3000})(Buffer.from('w')), error => error.code === 'timeout' && /3 s/.test(error.message));
  // The defaults: a short line is far below them, and the time cap is no longer 30 s.
  assert.deepEqual({...VGMSTREAM_LIMITS}, {timeoutMs: 10_000, maxOutputBytes: 16 * 1024 * 1024, pollMs: 100});
  const small = (executable, args, options, done) => { assert.equal(options.timeout, 10_000); writeFile(args[args.indexOf('-o') + 1], Buffer.alloc(100_000)).then(() => done(null), done); };
  assert.equal((await vgmstreamDecoder('x', {run: small})(Buffer.from('w'))).length, 100_000);
});
