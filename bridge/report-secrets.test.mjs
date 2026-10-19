import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {packKey} from './key-codec.mjs';
import {dataFolderSecrets, pluginVersions} from './report-secrets.mjs';

const RED4EXT_LOG = [
  '[2026-10-19 04:31:33.208] [info    ] [ 26456] [RED4ext] RED4ext (v1.30.0) is initializing...',
  '[2026-10-19 04:31:33.209] [info    ] [ 26456] [RED4ext] Product version: 2.31',
  '[2026-10-19 04:31:35.397] [info    ] [ 26456] [RED4ext] ArchiveXL (version: 1.27.4, author(s): psiberx) has been loaded',
  '[2026-10-19 04:31:35.946] [info    ] [ 26456] [RED4ext] audioware (version: 1.9.9-rc.0, author(s): Roms1383) has been loaded',
  '[2026-10-19 04:31:36.737] [info    ] [ 26456] [RED4ext] Codeware (version: 1.20.5, author(s): psiberx) has been loaded',
  '[2026-10-19 04:31:36.897] [info    ] [ 26456] [RED4ext] TweakXL (version: 1.11.4, author(s): psiberx) has been loaded', ''].join('\n');

test('plugin versions are read from the RED4ext log lines and from nothing else', () => {
  const found = pluginVersions(RED4EXT_LOG + '[info] [RED4ext] Somebody (version: 9.9.9, author(s): x) mentioned\nCodeware (version: 0.0.1) outside the tag\n');
  assert.equal(found.red4ext, '1.30.0');
  assert.equal(found.plugins.get('codeware'), '1.20.5');
  assert.equal(found.plugins.get('tweakxl'), '1.11.4');
  assert.equal(found.plugins.get('audioware'), '1.9.9-rc.0');
  assert.equal(pluginVersions('').plugins.size, 0);
});

test("the custom provider's key (player-custom-endpoint.txt) is scrubbed by value, and its address and model ID are not taken for secrets", async () => {
  const data = await mkdtemp(join(tmpdir(), 'report-secrets-custom-'));
  try {
    // A key no pattern catches (32 letters, no digit): only its value can scrub it.
    const custom = 'test' + 'v'.repeat(28);
    await writeFile(join(data, 'player-custom-endpoint.txt'), `﻿# AI NPC Cyberpunk Mod: Custom (OpenAI-compatible) provider.\r\nendpoint=https://openrouter.ai/api/v1\r\n`
      + `model=meta-llama/llama-3.1-8b-instruct\r\napi-key = "${custom}" # mine\r\n`);
    const secrets = await dataFolderSecrets({stateDirectory: data, project: null});
    assert.ok(secrets.includes(custom), 'the key value is a secret');
    assert.ok(!secrets.some(value => /openrouter|meta-llama|Cyberpunk/.test(value)), 'the address, the model ID and the comment are not');
  } finally { await rm(data, {recursive: true, force: true}); }
});

test('every key file of the data folder, the sign-in secret, the packed key and the environment secret are returned for scrubbing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'report-secrets-all-'));
  try {
    const data = join(root, 'data'), project = join(root, 'app');
    const player = 'test' + 'x'.repeat(28), mistral = 'test' + 'y'.repeat(28), shared = 'test' + 'z'.repeat(28), auth = 'test' + 'w'.repeat(28);
    const signing = 'test' + 'u'.repeat(28), shipped = 'test' + 't'.repeat(28);
    await mkdir(data, {recursive: true});
    await mkdir(join(project, 'defaults'), {recursive: true});
    await writeFile(join(data, 'player-convai-key.txt'), `api-key=${player}\n`);
    await writeFile(join(data, 'player-mistral-key.txt'), `api-key=${mistral}\n`);
    await writeFile(join(data, 'convai-auth.json'), JSON.stringify({enabled: true, url: 'https://example.invalid', secret: auth}));
    await writeFile(join(project, 'defaults', 'service.txt'), packKey(shared));
    await writeFile(join(project, 'defaults', 'error-reports.json'), JSON.stringify({version: 1, url: 'https://example.invalid/', secret: shipped}));
    const secrets = await dataFolderSecrets({stateDirectory: data, project, env: {CYBERPUNK_CONVAI_AUTH_SECRET: signing}});
    for (const value of [player, mistral, auth, shared, shipped, signing]) assert.ok(secrets.includes(value), `${value.slice(0, 5)}... is returned`);
    assert.ok(!secrets.some(value => /example\.invalid/.test(value)), 'an address is not a secret');
    assert.deepEqual(await dataFolderSecrets({stateDirectory: join(root, 'missing'), project: null}), [], 'nothing found is an empty list, not an error');
  } finally { await rm(root, {recursive: true, force: true}); }
});
