// The final entry guard of every package (packaging/lib/package-guards.mjs): which red4ext/ files may install a RED4ext plugin.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {BASE_MARKER, forbiddenEntry} from './lib/package-guards.mjs';
import {CODE_FOLDER} from './lib/code-payload.mjs';

const project = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const {layout} = JSON.parse(await readFile(resolve(project, 'packaging/release.config.json'), 'utf8'));
const PLUGIN = layout.pluginDirectory;

test('the Runtime\'s app/ tree may hold DLLs and .ini files (Python, llama.cpp, vgmstream, torch): they are not RED4ext plugins', () => {
  for (const name of [`${PLUGIN}/app/python/python312.dll`, `${PLUGIN}/app/llama-cpp/ggml.dll`, `${PLUGIN}/app/vgmstream/libvorbis.dll`,
    `${PLUGIN}/app/python/Lib/site-packages/torchgen/packaged/ATen/templates/RegisterDispatchDefinitions.ini`, `${PLUGIN}/app/local-ai/llama/llama.dll`]) {
    assert.equal(forbiddenEntry(name, layout), null, name);
  }
});

test('only the Scripts\' code folder and the base\'s marker install a RED4ext plugin DLL', () => {
  assert.equal(forbiddenEntry(`${CODE_FOLDER}/CyberpunkConvai.dll`, layout), null);
  assert.equal(forbiddenEntry(`${CODE_FOLDER}/CyberpunkConvaiNative.dll`, layout), null);
  assert.equal(forbiddenEntry(`${PLUGIN}/${BASE_MARKER}`, layout), null);
  // An old Runtime's launcher DLL, its launcher.ini, the old native folder, a DLL in a new plugin folder, and the development launcher stay refused.
  for (const name of [`${PLUGIN}/${layout.pluginDll}`, `${PLUGIN}/launcher.ini`, `${layout.nativeDirectory}/${layout.nativeDll}`, 'red4ext/plugins/Other/Other.dll',
    'red4ext/plugins/CyberpunkConvaiLauncher/CyberpunkConvaiLauncher.dll']) {
    assert.notEqual(forbiddenEntry(name, layout), null, name);
  }
  assert.match(forbiddenEntry('misc/notes.txt', layout), /developer-only/);
});
