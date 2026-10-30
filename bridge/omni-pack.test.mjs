import {test} from 'node:test';
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {detectOmniPack, missingOmniClips, missingOmniClipsLine} from './omni-pack.mjs';

test('the optional OmniVoice pack is installed only with its worker Python, model weights and adapter', () => {
  const project = resolve('project-fixture');
  const config = {model: 'vendor/voice-models/hub/models--k2-fsa--OmniVoice/snapshots/abc'};
  const all = [resolve(project, 'vendor/reference-voicestudio/.venv/Scripts/python.exe'),
    resolve(project, config.model, 'model.safetensors'), resolve(project, 'vendor/reference-voicestudio/backend/services/tts_backend.py'),
    resolve(project, 'bridge/resident-voice-worker.py')];
  const detect = files => detectOmniPack({project, config, environment: {}, exists: path => files.includes(path)});
  assert.deepEqual(detect(all), {installed: true, missing: [], python: all[0], model: resolve(project, config.model)});
  assert.deepEqual(detect(all.slice(1)).missing, ['python']);
  assert.deepEqual(detect([all[0], all[2], all[3]]).missing, ['model']);
  assert.deepEqual(detect([all[0], all[1], all[3]]).missing, ['adapter']);
  assert.deepEqual(detect([]).missing, ['python', 'model', 'adapter', 'worker']);
  assert.equal(detect([]).installed, false);
  // A model path that escapes the project is never trusted.
  assert.ok(detectOmniPack({project, config: {model: '../outside'}, environment: {}, exists: () => true}).missing.includes('model'));
  // The portable layout overrides, as the worker reads them.
  const portable = {CYBERPUNK_CONVAI_PYTHON: resolve('pack/python.exe'), CYBERPUNK_CONVAI_OMNI_MODEL: resolve('pack/model'),
    CYBERPUNK_CONVAI_OMNI_ADAPTER: resolve('pack/adapter')};
  const files = [portable.CYBERPUNK_CONVAI_PYTHON, resolve('pack/model/model.safetensors'),
    resolve('pack/adapter/services/tts_backend.py'), all[3]];
  assert.equal(detectOmniPack({project, config: {}, environment: portable, exists: path => files.includes(path)}).installed, true);
});

test('an installed pack that lacks reference clips is reported with the characters it cannot voice', () => {
  const referenceDirectory = resolve('refs-fixture');
  const config = {voices: {
    'johnny-silverhand': {reference: 'runtime/voice-references/picked/autobest/omni-long/johnny-silverhand.wav'},
    'judy-alvarez': {reference: 'runtime/voice-references/picked/autobest/omni-long/judy-alvarez.wav'},
    'brick': {reference: 'runtime/voice-references/picked/autobest/omni-long/brick.wav'},
    'player': {reference: 'player-voices/player.wav'},
    'sneaky': {reference: 'runtime/voice-references/../../outside.wav'}}};
  const present = [resolve(referenceDirectory, 'picked/autobest/omni-long/brick.wav')];
  const check = missingOmniClips({config, referenceDirectory, exists: path => present.includes(path)});
  assert.equal(check.total, 3);
  assert.deepEqual(check.missing, ['picked/autobest/omni-long/johnny-silverhand.wav', 'picked/autobest/omni-long/judy-alvarez.wav']);
  const line = missingOmniClipsLine(check, 'long');
  assert.match(line, /2 of 3 long reference clips are missing \(for example johnny-silverhand, judy-alvarez\)/);
  assert.match(line, /Extract the OmniVoice pack again/);
  // Nothing missing: no line. No folder to look in: nothing is claimed missing.
  assert.equal(missingOmniClipsLine(missingOmniClips({config, referenceDirectory, exists: () => true})), null);
  assert.deepEqual(missingOmniClips({config, referenceDirectory: undefined}).missing, []);
  assert.deepEqual(missingOmniClips({config: {}, referenceDirectory}), {total: 0, missing: []});
});

test('characters whose clips are built on the player\'s PC are not counted as missing: with the clips left out of the packages the line never lists the cast', () => {
  const referenceDirectory = resolve('refs-fixture');
  const voices = {};
  for (let index = 0; index < 400; index++) voices[`built-${index}`] = {reference: `runtime/voice-references/picked/autobest/omni-long/built-${index}.wav`};
  voices.lucy = {reference: 'runtime/voice-references/picked/autobest/omni-long/lucy.wav'};
  const config = {voices};
  const except = Object.keys(voices).filter(key => key.startsWith('built-'));
  const nothing = missingOmniClips({config, referenceDirectory, exists: () => false, except});
  assert.deepEqual(nothing, {total: 1, missing: ['picked/autobest/omni-long/lucy.wav']}, 'only the clip that is shipped and gone is named');
  assert.match(missingOmniClipsLine(nothing, 'long'), /1 of 1 long reference clips are missing \(for example lucy\)/);
  assert.equal(missingOmniClipsLine(missingOmniClips({config, referenceDirectory, exists: path => path.endsWith('lucy.wav'), except})), null);
  assert.equal(missingOmniClips({config, referenceDirectory, exists: () => false}).missing.length, 401, 'without the list every clip is counted, as before');
});
