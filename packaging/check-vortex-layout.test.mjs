// Vortex's Cyberpunk extension claims any zip that holds a .dll and then fails on a layout it does not know (Discord 2026-10-23, Local AI Standard pack:
// "Red4Ext installer failed to generate any instructions"). packaging/check-vortex-layout.mjs is the check a pack build runs on its zips.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ZipWriter} from './lib/zip.mjs';
import {PLUGIN} from './lib/pack-overlap.mjs';
import {checkPacks, dllPaths, vortexProblems} from './check-vortex-layout.mjs';

const ENGINE = `${PLUGIN}/app/local-ai/llama`;

test('a pack with a .dll at any depth is a problem, in any case; a pack of models, manifests and notices is not', () => {
  const modelsOnly = [`${PLUGIN}/app/local-ai/models/gemma-4-E4B_q4_0-it.gguf`, `${PLUGIN}/app/local-ai/manifest.standard.json`,
    `${PLUGIN}/app/local-ai/LICENSE.txt`, `${PLUGIN}/app/local-ai/llama/llama-server.exe`];
  assert.deepEqual(vortexProblems(modelsOnly), {ok: true, dlls: []});
  assert.deepEqual(vortexProblems([...modelsOnly, `${ENGINE}/ggml-base.dll`, `${ENGINE}/GGML-CPU.DLL`, `${PLUGIN}/app/omni/python/python312.dll`]),
    {ok: false, dlls: [`${ENGINE}/ggml-base.dll`, `${ENGINE}/GGML-CPU.DLL`, `${PLUGIN}/app/omni/python/python312.dll`]});
  // Records as the zip lister returns them work too, and a name that only contains ".dll" is not a DLL.
  assert.deepEqual(dllPaths([{path: 'a/b.dll', size: 1}, {path: 'a/dll.txt', size: 1}, {path: 'a/b.dll.json', size: 1}, 'c.pyd']), ['a/b.dll']);
});

test('the check reads a pack zip and names the DLLs, with nothing written', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vortex layout test '));
  try {
    const build = async (name, entries) => {
      const zip = await ZipWriter.create(join(directory, name));
      for (const path of entries) await zip.add(path, {buffer: Buffer.from('x')});
      await zip.close();
      return join(directory, name);
    };
    const clean = await build('models-only.zip', [`${PLUGIN}/app/local-ai/models/m.gguf`, `${PLUGIN}/app/local-ai/manifest.standard.json`]);
    const bundled = await build('with-engine.zip', [`${PLUGIN}/app/local-ai/models/m.gguf`, `${ENGINE}/llama-server.exe`, `${ENGINE}/ggml-base.dll`, `${ENGINE}/llama.dll`]);
    const lines = [];
    assert.equal(await checkPacks([clean], {log: line => lines.push(line)}), true);
    assert.match(lines.join('\n'), /models-only\.zip: 2 files, no \.dll/);
    lines.length = 0;
    assert.equal(await checkPacks([clean, bundled], {log: line => lines.push(line)}), false);
    const text = lines.join('\n');
    assert.match(text, /with-engine\.zip: 2 \.dll file\(s\) of 4/);
    assert.match(text, /ggml-base\.dll/);
    assert.match(text, /FAILED/);
  } finally { await rm(directory, {recursive: true, force: true}); }
});
