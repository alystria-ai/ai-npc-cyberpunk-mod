// The runtime/ exchange files under Mod Organizer 2 (packaging/lib/runtime-exchange.mjs, docs/PACKAGING.md "Mod Organizer 2").
// Every runtime/ file the shipped Lua or the bridge names must be classified in packaging/runtime-exchange.json, so a new one cannot
// appear without a decision (ship it as a placeholder, or say why not). The shipped Lua must not delete or rename-over the exchange
// files, and the bridge must not delete them: under USVFS a deleted file that is written again is a new file in Overwrite.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile, readdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {checkRuntimeExchange, loadRuntimeExchange} from './lib/runtime-exchange.mjs';
import {importClosure} from './lib/closure.mjs';

const project = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const config = JSON.parse(await readFile(resolve(project, 'packaging/release.config.json'), 'utf8'));
const manifest = await loadRuntimeExchange(project);
const classified = new Map();
for (const section of ['exchange', 'state', 'optional', 'elsewhere']) for (const name of manifest[section]) classified.set(name, section);

// Shipped Lua files that keep os.remove/os.rename/.tmp on purpose: they also write the player's own state files (class "state":
// settings.json, phone-history.json, addon-settings.json), whose temp-file and backup protection stays. The exchange files they
// write are in place (their tests assert it: exchange-files-in-place.test.mjs, phone-chat.test.mjs, addons-lua.test.mjs).
const STATE_WRITERS = new Set(['manager.lua', 'phone-chat.lua', 'addons.lua']);
const shippedLua = (await readdir(resolve(project, 'mod'))).filter(name => name.endsWith('.lua') && !config.devOnlyLua.includes(name)).sort();
const luaText = new Map();
for (const name of shippedLua) luaText.set(name, await readFile(resolve(project, 'mod', name), 'utf8'));
const bridgeFiles = (await importClosure(project, config.bridgeEntries)).filter(rel => rel.endsWith('.mjs'));
const bridgeText = new Map();
for (const rel of bridgeFiles) bridgeText.set(rel, await readFile(resolve(project, rel), 'utf8'));

// The file names the sources use under runtime/: 'runtime/<name>' in Lua and Node, join(runtime, '<name>') and friends in Node.
function runtimeNames(text) {
  const names = new Set();
  for (const match of text.matchAll(/runtime[\/\\]+([A-Za-z0-9][A-Za-z0-9_.-]*\.[A-Za-z0-9]+)/g)) names.add(match[1]);
  for (const match of text.matchAll(/\b(?:runtime|runtimeDir|runtimePath|runtimeFolder)\w*\s*,\s*['"`]([A-Za-z0-9][A-Za-z0-9_.-]*\.[A-Za-z0-9]+)['"`]/g)) names.add(match[1]);
  return names;
}

test('the manifest is well formed and lists every file once', () => {
  assert.doesNotThrow(() => checkRuntimeExchange(manifest));
  assert.throws(() => checkRuntimeExchange({exchange: ['a.json'], state: ['a.json'], optional: [], elsewhere: []}), /listed in/);
  assert.throws(() => checkRuntimeExchange({exchange: ['a.json.tmp'], state: [], optional: [], elsewhere: []}), /bad file name/);
  assert.throws(() => checkRuntimeExchange({exchange: ['../a.json'], state: [], optional: [], elsewhere: []}), /bad file name/);
  assert(manifest.exchange.length > 20, 'the exchange list is not empty');
});

test('every runtime/ file the shipped Lua or the bridge names is classified', () => {
  const unknown = [];
  for (const [file, text] of [...[...luaText].map(([name, body]) => [`mod/${name}`, body]), ...bridgeText]) {
    for (const name of runtimeNames(text)) {
      const bare = name.replace(/\.(?:tmp|previous)$/, '');
      if (!classified.has(name) && !classified.has(bare)) unknown.push(`${file}: runtime/${name}`);
    }
  }
  assert.deepEqual(unknown, [], 'classify these in packaging/runtime-exchange.json (exchange: ship an empty placeholder; state; optional; elsewhere)');
});

test('the shipped Lua never deletes or renames an exchange file, and never names a .tmp of one', () => {
  const found = [];
  for (const [name, text] of luaText) {
    if (STATE_WRITERS.has(name)) continue;
    const mentions = [...runtimeNames(text)].some(file => classified.get(file) === 'exchange');
    if (!mentions) continue;
    text.split(/\r?\n/).forEach((line, index) => {
      const code = line.replace(/--.*$/, '');
      if (/\bos\.(?:remove|rename)\b/.test(code) || /['"]\.tmp['"]|\.tmp['"]/.test(code)) found.push(`mod/${name}:${index + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(found, []);
});

test('the bridge never deletes an exchange file', () => {
  const exchange = new Set(manifest.exchange);
  const found = [];
  for (const [rel, text] of bridgeText) {
    text.split('\n').forEach((line, index) => {
      if (!/\b(?:rm|rmSync|unlink|unlinkSync)\s*\(/.test(line)) return;
      for (const name of runtimeNames(line)) if (exchange.has(name)) found.push(`${rel}:${index + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(found, []);
});

