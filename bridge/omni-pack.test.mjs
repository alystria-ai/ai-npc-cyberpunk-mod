import {test} from 'node:test';
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {detectOmniPack} from './omni-pack.mjs';

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
