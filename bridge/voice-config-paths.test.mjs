import {test} from 'node:test';
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {resolveVoiceConfigPaths, DEFAULT_VOICE_CONFIG_MANIFEST, BASE_VOICE_CONFIGS} from './voice-config-paths.mjs';

const state = resolve('state-fixture');

test('the manifest names the live voice configuration files, each falling back to its base file', () => {
  const present = new Set(Object.values(DEFAULT_VOICE_CONFIG_MANIFEST.omni).concat(DEFAULT_VOICE_CONFIG_MANIFEST.pocket)
    .map(name => resolve(state, name)));
  const found = resolveVoiceConfigPaths(state, {manifest: DEFAULT_VOICE_CONFIG_MANIFEST, exists: path => present.has(path)});
  assert.equal(found.pocket, resolve(state, 'pocket-voices.autobest.json'));
  assert.equal(found.omni.short, resolve(state, 'local-voices.autobest-short.json'));
  assert.equal(found.omni.long, resolve(state, 'local-voices.autobest-long.json'));
  assert.deepEqual(found.warnings, []);
  // Regenerated files dropped over the same names are all a new search needs: nothing else is consulted.
  const missing = resolveVoiceConfigPaths(state, {manifest: DEFAULT_VOICE_CONFIG_MANIFEST, exists: () => false});
  assert.equal(missing.pocket, resolve(state, BASE_VOICE_CONFIGS.pocket));
  assert.equal(missing.omni.short, resolve(state, BASE_VOICE_CONFIGS.omni));
  assert.equal(missing.warnings.length, 3);
  const none = resolveVoiceConfigPaths(state, {manifest: {}, exists: () => true});
  assert.equal(none.pocket, resolve(state, BASE_VOICE_CONFIGS.pocket));
  assert.deepEqual(none.warnings, []);
});

test('manifest entries must be plain file names inside the state directory', () => {
  for (const bad of ['../outside.json', 'sub/dir.json', 'C:\\x.json', '..\\x.json', 'voices.txt', 7, '']) {
    const found = resolveVoiceConfigPaths(state, {manifest: {pocket: bad, omni: {short: bad, long: bad}}, exists: () => true});
    assert.equal(found.pocket, resolve(state, BASE_VOICE_CONFIGS.pocket), String(bad));
    assert.equal(found.omni.long, resolve(state, BASE_VOICE_CONFIGS.omni));
    assert.equal(found.warnings.length, 3);
  }
});
