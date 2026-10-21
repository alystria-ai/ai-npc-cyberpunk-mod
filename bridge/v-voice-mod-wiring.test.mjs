import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, existsSync} from 'node:fs';
import {mkdtemp, writeFile, readFile, readdir, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {vgmstreamDecoder} from './v-voice-mod-reference.mjs';
import {LiveVoices} from './live-voices.mjs';
import {V_VOICE_KEYS} from './v-voice.mjs';

const bridge = readFileSync(new URL('./convai-bridge.mjs', import.meta.url), 'utf8');

test('the bridge looks for a V voice mod once, before the voice configurations are merged, and not at any other time', () => {
  const calls = [...bridge.matchAll(/loadVVoiceReferencesWithMods\(/g)];
  assert.equal(calls.length, 1, 'one call in the whole bridge');
  const at = calls[0].index, merged = bridge.indexOf('addonHost.voiceConfigPaths(');
  assert.ok(at > 0 && merged > at, 'before the merge of the voice configurations');
  assert.doesNotMatch(bridge, /ensureVoiceModReferences|detectVoiceMods|listVoiceModArchives/, 'the bridge never runs the scan itself (no timer, no poll, no reply)');
  assert.match(bridge, /const \{report: vVoiceModReport, \.\.\.vVoiceReferences\} = await loadVVoiceReferencesWithMods\(/);
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
    writeFile(args[1], Buffer.from('RIFFwav')).then(() => done(null), done);
  };
  const before = (await readdir(tmpdir())).filter(name => name.startsWith('ainpc-vmod-'));
  const decode = vgmstreamDecoder('C:/app/vgmstream/vgmstream-cli.exe', {run, timeoutMs: 1234});
  assert.equal((await decode(Buffer.from('wem'))).toString(), 'RIFFwav');
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0].args.slice(0, 1), ['-o']);
  assert.equal(seen[0].options.timeout, 1234); assert.equal(seen[0].options.shell, false); assert.equal(seen[0].options.windowsHide, true);
  assert.ok(!existsSync(seen[0].args[1]), 'the temporary file is gone');
  assert.deepEqual((await readdir(tmpdir())).filter(name => name.startsWith('ainpc-vmod-')), before, 'and so is its folder');
  await assert.rejects(vgmstreamDecoder('x', {run: (e, a, o, done) => done(Error('exit 1'))})(Buffer.from('w')), /exit 1/);
  assert.deepEqual((await readdir(tmpdir())).filter(name => name.startsWith('ainpc-vmod-')), before, 'a failed decode leaves nothing either');
});
