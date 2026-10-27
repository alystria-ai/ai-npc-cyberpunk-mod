import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {buildServerFolder, importClosure, parseArguments, SERVER_ENTRY, WORKER_FILES, TEMPLATE_FILES} from './build-omni-server.mjs';
import {BRIDGE_MODULES, BRIDGE_AUXILIARY_FILES} from './runtime-layout.mjs';
import {missingParts, serverLayout} from '../bridge/omni-server-main.mjs';

const bridge = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', 'bridge');

test('the server needs only a small, closed part of the bridge, and the Runtime ships every file of it', async () => {
  const closure = await importClosure(bridge);
  assert.ok(closure.includes(SERVER_ENTRY) && closure.includes('omni-server.mjs') && closure.includes('resident-voice.mjs') && closure.includes('omni-remote.mjs'));
  assert.ok(closure.length < 40, `the closure is ${closure.length} files`);
  // nothing of the game's conversation service, the browser renderer or the Lua side is dragged in
  for (const name of ['convai-bridge.mjs', 'voice-selection.mjs', 'remote-voice.mjs', 'manager.mjs']) assert.ok(!closure.includes(name), name);
  const shipped = new Set([...BRIDGE_MODULES, ...BRIDGE_AUXILIARY_FILES].map(path => path.replace(/^bridge\//, '')));
  for (const name of [...closure, ...WORKER_FILES]) assert.ok(shipped.has(name), `${name} is not in the Runtime's file lists`);
});

test('the start files say their options in plain words and default to this PC only', () => {
  const start = readFileSync(join(bridge, '..', 'packaging', 'omni-server', 'Start OmniVoice server.cmd'), 'utf8');
  for (const line of ['set LISTEN=127.0.0.1', 'set PORT=8765', 'set GPU=0', 'set QUALITY=16', 'set MOD_FOLDER=']) assert.ok(start.includes(line), line);
  for (const word of ['0.0.0.0', 'first card', 'There is no password', 'Close the window to stop']) assert.ok(start.includes(word), word);
  assert.ok(!/api[-_ ]?key|password\s*=/i.test(start.replace('There is no password', '')), 'no key option');
  assert.ok(start.includes('--root "%ROOT%" --data "%~dp0server-data"'), 'the data folder is next to the start file');
  assert.ok(!/%~dp0"/.test(start), 'a path ending in a backslash before a quote');
});

test('arguments', () => {
  assert.match(parseArguments([]).error, /--to/);
  assert.match(parseArguments(['--to', 'x']).error, /--from/);
  assert.equal(parseArguments(['--to', 'x', '--launcher-only']).launcherOnly, true);
  assert.equal(parseArguments(['--to', 'x', '--from', 'y', '--no-voices']).voices, false);
  assert.match(parseArguments(['--bogus']).error, /Unknown option/);
});

test('a built folder is a server root: every part the server looks for is there, only the needed bridge files, and no cache folders', async () => {
  const root = mkdtempSync(join(tmpdir(), 'omni-build-'));
  try {
    const from = join(root, 'mod'), to = join(root, 'server');
    for (const path of ['app/node/node.exe', 'app/omni/python/python.exe', 'app/omni/python/Lib/__pycache__/x.pyc', 'app/omni/model/model.safetensors', 'app/omni/voicestudio/backend/services/tts_backend.py',
      'app/omni/omni-pack.json', 'app/defaults/local-voices.autobest-long.json', 'app/defaults/characters.json', 'app/release.json', 'app/local-ai/huge.gguf',
      'voices/picked/a.wav', 'voices/archetypes/b.wav', 'voices/multilingual/c.wav']) {
      mkdirSync(join(from, path, '..'), {recursive: true});
      writeFileSync(join(from, path), path === 'app/release.json' ? JSON.stringify({version: '1.2.3'}) : 'x');
    }
    const result = await buildServerFolder({from, to, bridge});
    assert.ok(result.folders.includes('app/omni') && result.folders.includes('voices/picked') && result.folders.includes('voices/archetypes'));
    assert.equal(missingParts(serverLayout(to, join(to, 'data'))), null);
    for (const name of TEMPLATE_FILES) assert.ok(existsSync(join(to, name)), name);
    assert.ok(existsSync(join(to, 'app/bridge/omni-server-main.mjs')) && existsSync(join(to, 'app/bridge/resident-voice-worker.py')) && existsSync(join(to, 'app/bridge/voice-cuda-graph.py')));
    assert.ok(!existsSync(join(to, 'app/bridge/convai-bridge.mjs')), 'the conversation service is not part of the server');
    assert.ok(!existsSync(join(to, 'app/omni/python/Lib/__pycache__')), 'no cache folders');
    assert.ok(!existsSync(join(to, 'app/local-ai')) && !existsSync(join(to, 'voices/multilingual')), 'only what the server needs');
    assert.ok(readFileSync(join(to, 'server-folder.txt'), 'utf8').includes('1.2.3'));
    // every import of the copied files is in the folder
    for (const name of readdirSync(join(to, 'app/bridge')).filter(name => name.endsWith('.mjs'))) {
      for (const match of readFileSync(join(to, 'app/bridge', name), 'utf8').matchAll(/(?:from|import)\s*\(?\s*['"]\.\/([^'"]+\.mjs)['"]/g)) assert.ok(existsSync(join(to, 'app/bridge', match[1])), `${name} imports ${match[1]}`);
    }
    // without the voices
    const lean = join(root, 'lean');
    const again = await buildServerFolder({from, to: lean, bridge, voices: false});
    assert.ok(!again.folders.some(folder => folder.startsWith('voices')));
    // a mod without the OmniVoice pack is refused in words
    rmSync(join(from, 'app/omni/python/python.exe'));
    await assert.rejects(buildServerFolder({from, to: join(root, 'x'), bridge}), /lacks app\/omni\/python\/python\.exe/);
    // the launcher-only folder is three small files
    const small = join(root, 'small');
    await buildServerFolder({to: small, launcherOnly: true});
    assert.deepEqual(readdirSync(small).sort(), [...TEMPLATE_FILES].sort());
  } finally { rmSync(root, {recursive: true, force: true}); }
});
