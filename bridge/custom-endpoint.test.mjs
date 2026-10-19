// The custom (OpenAI-compatible) provider's settings: what the player may enter, how it is kept, the settings page's commands and the connection
// test (bridge/custom-endpoint.mjs). No real network: the only server is the loopback mock (bridge/openai-mock-server.mjs).
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, writeFile, rm, stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {CUSTOM_FILE, COMMANDS, CustomControl, CustomEndpoint, OPENROUTER_HEADERS, describeFailure, formatCustomFile, parseCustomCommand, parseCustomFile,
  parseCustomKey, parseEndpointUrl, parseModelId, testConnection} from './custom-endpoint.mjs';
import {MistralProvider} from './mistral-key.mjs';
import {MistralError} from './mistral-client.mjs';
import {startOpenAiMock} from './openai-mock-server.mjs';

// Fake keys built at run time: nothing here looks like a real key.
const KEY = 'test' + 'x'.repeat(28);
const SHORT = 'tinykey8';
const OTHER = 'test' + 'y'.repeat(28);

test('an address: the base URL of any OpenAI-style endpoint, checked before it is saved', () => {
  assert.deepEqual(parseEndpointUrl('https://openrouter.ai/api/v1'),
    {endpoint: 'https://openrouter.ai/api/v1', origin: 'https://openrouter.ai', host: 'openrouter.ai', hostname: 'openrouter.ai', kind: 'remote', secure: true});
  assert.equal(parseEndpointUrl('https://nano-gpt.com/api/v1').host, 'nano-gpt.com');
  // Trailing slashes, a pasted full chat address, spaces around it, quotes and a label are all tolerated.
  assert.equal(parseEndpointUrl('  https://openrouter.ai/api/v1/\n').endpoint, 'https://openrouter.ai/api/v1');
  assert.equal(parseEndpointUrl('https://openrouter.ai/api/v1/chat/completions').endpoint, 'https://openrouter.ai/api/v1');
  assert.equal(parseEndpointUrl('"https://openrouter.ai/api/v1"').endpoint, 'https://openrouter.ai/api/v1');
  assert.equal(parseEndpointUrl('endpoint=https://openrouter.ai/api/v1').endpoint, 'https://openrouter.ai/api/v1');
  assert.equal(parseEndpointUrl('﻿https://openrouter.ai/api/v1').endpoint, 'https://openrouter.ai/api/v1');
  // A server on this computer or the home network may use http://, with its port; no path means /v1.
  const ollama = parseEndpointUrl('http://localhost:11434/v1');
  assert.deepEqual([ollama.endpoint, ollama.host, ollama.kind, ollama.secure], ['http://localhost:11434/v1', 'localhost:11434', 'loopback', false]);
  assert.equal(parseEndpointUrl('http://localhost:1234/v1').host, 'localhost:1234');
  assert.equal(parseEndpointUrl('http://localhost:11434').endpoint, 'http://localhost:11434/v1');
  assert.equal(parseEndpointUrl('http://127.0.0.1:8080/v1').kind, 'loopback');
  assert.equal(parseEndpointUrl('http://192.168.1.20:8080/v1').kind, 'lan');
  assert.equal(parseEndpointUrl('http://gaming-pc.local:8000/v1').kind, 'lan');
  // What is refused, and why.
  assert.equal(parseEndpointUrl('').reason, 'empty');
  assert.equal(parseEndpointUrl('   ').reason, 'empty');
  assert.equal(parseEndpointUrl(undefined).reason, 'empty');
  assert.equal(parseEndpointUrl('openrouter.ai/api/v1').reason, 'scheme');
  assert.equal(parseEndpointUrl('ftp://openrouter.ai/api/v1').reason, 'scheme');
  assert.equal(parseEndpointUrl('http://openrouter.ai/api/v1').reason, 'insecure', 'a remote host needs https:// so the key is not sent in the clear');
  assert.equal(parseEndpointUrl('https://user:pw@openrouter.ai/api/v1').reason, 'extras');
  assert.equal(parseEndpointUrl('https://openrouter.ai/api/v1?key=abc').reason, 'extras');
  assert.equal(parseEndpointUrl('https://openrouter.ai/api/v1#frag').reason, 'extras');
  assert.equal(parseEndpointUrl('two words').reason, 'not-a-url');
  assert.equal(parseEndpointUrl('https://exa mple.com').reason, 'not-a-url');
  assert.equal(parseEndpointUrl('https://example.com/' + 'a'.repeat(400)).reason, 'long');
  assert.equal(parseEndpointUrl('http://127.0.0.1.example.com/v1').reason, 'insecure', 'a name that only contains an address is a remote host');
});

test('a key: one run of printable characters; a sentence, an address or a short word is not one', () => {
  assert.equal(parseCustomKey(KEY), KEY);
  assert.equal(parseCustomKey(`  ${KEY}\r\n`), KEY);
  assert.equal(parseCustomKey(`api-key=${KEY}`), KEY);
  assert.equal(parseCustomKey(`Bearer ${KEY}`), KEY);
  assert.equal(parseCustomKey(`"${KEY}"`), KEY);
  assert.equal(parseCustomKey('sk-' + 'a1_B2.c3/d4+e5='.repeat(3)), 'sk-' + 'a1_B2.c3/d4+e5='.repeat(3), 'the punctuation real keys use');
  assert.equal(parseCustomKey(SHORT), SHORT);
  for (const bad of ['', '   ', 'short', 'two words here', 'https://openrouter.ai/api/v1', 'a'.repeat(600), `key with "quote" ${KEY}`, undefined, 42]) {
    assert.equal(parseCustomKey(bad), null, String(bad).slice(0, 30));
  }
});

test('a model id: letters, digits and . _ : / @ + -', () => {
  for (const id of ['meta-llama/llama-3.1-8b-instruct', 'llama3.2', 'llama3.2:3b', 'mistralai/mistral-7b-instruct:free', 'Qwen/Qwen2.5-7B-Instruct',
    'anthropic/claude-3.5-sonnet', 'gpt-4o-mini', 'lmstudio-community/gemma-2-9b-it-GGUF', 'gemma@q4_k_m']) assert.equal(parseModelId(id), id, id);
  assert.equal(parseModelId('model=llama3.2'), 'llama3.2');
  assert.equal(parseModelId(' "llama3.2" \n'), 'llama3.2');
  for (const bad of ['', 'two words', 'https://openrouter.ai', '-leading', 'a'.repeat(130), 'with;semicolon', 'a<b', undefined]) assert.equal(parseModelId(bad), null, String(bad).slice(0, 30));
});

test('a model id may start with @ (Cloudflare), and an API key is never taken for one: it would be shown, logged and published as the model', () => {
  for (const id of ['@cf/meta/llama-3.1-8b-instruct', '@hf/thebloke/zephyr-7b-beta-awq', 'hf.co/bartowski/Llama-3.2-3B-Instruct-GGUF:Q4_K_M',
    'skyfall-36b-v2', 'deepseek/deepseek-r1-0528:free', 'accounts/fireworks/models/llama-v3p1-8b-instruct']) assert.equal(parseModelId(id), id, id);
  // Key shapes built at run time: a known prefix, or a long run of letters and digits (a Mistral key, OpenRouter's hex tail).
  for (const key of [KEY, 'sk-or-v1-' + '0123456789abcdef'.repeat(4), 'sk-proj-' + 'Ab_1-'.repeat(8), 'gsk_' + 'Ab1'.repeat(18), 'xai-' + 'Zz9'.repeat(10),
    'Ab12'.repeat(8)]) {
    assert.equal(parseModelId(key), null, key.slice(0, 12));
    assert.equal(parseModelId(`model=${key}`), null);
    assert.deepEqual(parseCustomFile(`model=${key}\n`).problems, ['model'], 'a key in the model line is left out and only its name reported');
  }
});

test('a paste in curly quotes (a web page, a chat app) is read like one in straight quotes', () => {
  assert.equal(parseEndpointUrl('“https://openrouter.ai/api/v1”').endpoint, 'https://openrouter.ai/api/v1');
  assert.equal(parseModelId('‘llama3.2’'), 'llama3.2');
  assert.equal(parseCustomKey(`“${KEY}”`), KEY);
  assert.equal(parseCustomKey(`“${KEY} more”`), null);
});

test('the file: a # after a space ends a line\'s value, as the doc says; a # inside a value stays', () => {
  const parsed = parseCustomFile(`endpoint=http://localhost:11434/v1   # Ollama\r\nmodel=llama3.2:3b\t# the small one\r\napi-key=${KEY} # mine\r\n`);
  assert.deepEqual([parsed.endpoint?.host, parsed.model, parsed.key, parsed.problems], ['localhost:11434', 'llama3.2:3b', KEY, []]);
  const hashed = 'ab#' + 'c'.repeat(12);
  assert.equal(parseCustomFile(`api-key=${hashed}\n`).key, hashed);
  assert.equal(parseCustomFile(`api-key = ${hashed}\n`).key, hashed);
});

test('the file: three lines in any order, comments allowed, a bad line is left out and only its name is reported', () => {
  const text = `# my setup\n\nmodel = meta-llama/llama-3.1-8b-instruct\napi-key=${KEY}\nendpoint=https://openrouter.ai/api/v1\nunknown=1\n`;
  const parsed = parseCustomFile(text);
  assert.equal(parsed.endpoint.host, 'openrouter.ai');
  assert.equal(parsed.model, 'meta-llama/llama-3.1-8b-instruct');
  assert.equal(parsed.key, KEY);
  assert.deepEqual(parsed.problems, []);
  assert.equal(parseCustomFile('url: http://localhost:11434/v1\nmodel: llama3.2\n').key, null, 'the key line is optional');
  assert.equal(parseCustomFile('BASE_URL=http://localhost:11434/v1').endpoint.host, 'localhost:11434');
  const bad = parseCustomFile(`endpoint=http://openrouter.ai/v1\nmodel=has space\napi-key=short\n`);
  assert.deepEqual([bad.endpoint, bad.model, bad.key], [null, null, null]);
  assert.deepEqual(bad.problems, ['endpoint (insecure)', 'model', 'api-key']);
  assert.ok(!JSON.stringify(bad).includes('has space'), 'a refused value is never repeated');
  assert.deepEqual(parseCustomFile(undefined), {endpoint: null, model: null, key: null, problems: []});
  assert.deepEqual(parseCustomFile('x'.repeat(20000)).problems, []);
  // What is written reads back the same.
  const written = formatCustomFile({endpoint: 'https://openrouter.ai/api/v1', model: 'a/b:free', key: KEY});
  const again = parseCustomFile(written);
  assert.deepEqual([again.endpoint.endpoint, again.model, again.key], ['https://openrouter.ai/api/v1', 'a/b:free', KEY]);
  assert.doesNotMatch(formatCustomFile({endpoint: 'http://localhost:11434/v1', model: 'llama3.2'}), /api-key/);
});

function store(initial = null) {
  const calls = {writes: [], removed: 0};
  let text = initial;
  const endpoint = new CustomEndpoint({path: 'p.txt', readText: async () => { if (text === null) throw Object.assign(Error('missing'), {code: 'ENOENT'}); return text; },
    writeText: async (_path, value) => { calls.writes.push(value); text = value; }, removeFile: async () => { calls.removed++; text = null; }});
  return {endpoint, calls, get text() { return text; }, set text(value) { text = value; }};
}

test('the saved settings: ready with an address and a model id, the key optional, saved whole in one file, shown without the key', async () => {
  const s = store();
  await s.endpoint.load();
  assert.equal(s.endpoint.ready, false);
  assert.equal(s.endpoint.chatUrl, null);
  let changed = 0;
  s.endpoint.onChange(() => { changed++; });
  await s.endpoint.setUrl(parseEndpointUrl('http://localhost:11434/v1'));
  assert.equal(s.endpoint.ready, false, 'a model id is needed too');
  await s.endpoint.setModel('llama3.2');
  assert.equal(s.endpoint.ready, true);
  assert.equal(s.endpoint.chatUrl, 'http://localhost:11434/v1/chat/completions');
  assert.equal(s.endpoint.origin, 'http://localhost:11434');
  assert.equal(s.endpoint.host, 'localhost:11434');
  assert.equal(s.endpoint.local, true);
  assert.equal(s.endpoint.warmOrigin, null, 'a server on this computer has no TLS to warm');
  assert.equal(s.endpoint.key, null);
  assert.deepEqual(s.endpoint.secrets(), []);
  assert.equal(changed, 2);
  assert.match(s.text, /^endpoint=http:\/\/localhost:11434\/v1$/m);
  assert.match(s.text, /^model=llama3\.2$/m);
  assert.doesNotMatch(s.text, /api-key/);
  // A key of 16 or more characters shows its last four; a short one shows none.
  await s.endpoint.setKey(KEY);
  assert.equal(s.endpoint.tail, KEY.slice(-4));
  assert.deepEqual(s.endpoint.secrets(), [KEY]);
  assert.match(s.text, new RegExp(`^api-key=${KEY}$`, 'm'));
  await s.endpoint.setKey(SHORT);
  assert.equal(s.endpoint.tail, null);
  // A restart reads the same back.
  const reopened = new CustomEndpoint({path: 'p.txt', readText: async () => s.text});
  await reopened.load();
  assert.deepEqual([reopened.host, reopened.model, reopened.key, reopened.ready], ['localhost:11434', 'llama3.2', SHORT, true]);
  // Removing every part removes the file.
  await s.endpoint.clearKey(); await s.endpoint.clearModel();
  assert.equal(s.endpoint.ready, false);
  assert.equal(s.calls.removed, 0);
  await s.endpoint.clearUrl();
  assert.equal(s.calls.removed, 1);
  assert.equal(s.text, null);
});

test('a cloud address warms its https origin; OpenRouter alone gets its two optional headers', async () => {
  const s = store(`endpoint=https://openrouter.ai/api/v1\nmodel=a/b\n`);
  await s.endpoint.load();
  assert.equal(s.endpoint.warmOrigin, 'https://openrouter.ai');
  assert.equal(s.endpoint.local, false);
  assert.deepEqual(s.endpoint.extraHeaders, OPENROUTER_HEADERS);
  assert.deepEqual(Object.keys(OPENROUTER_HEADERS).sort(), ['HTTP-Referer', 'X-Title']);
  for (const url of ['https://nano-gpt.com/api/v1', 'https://api.openai.com/v1', 'https://openrouter.ai.example.com/v1', 'https://notopenrouter.ai/v1', 'https://api.openrouter.ai/v1', 'http://localhost:11434/v1']) {
    const other = store(`endpoint=${url}\nmodel=a/b\n`);
    await other.endpoint.load();
    assert.equal(other.endpoint.extraHeaders, undefined, url);
  }
});

test('a file with a bad field keeps the good ones, and a disk that fails keeps what was there', async () => {
  const logs = [];
  const bad = new CustomEndpoint({path: 'p', readText: async () => `endpoint=https://openrouter.ai/api/v1\nmodel=has space\napi-key=${KEY}\n`, log: line => logs.push(line)});
  await bad.load();
  assert.deepEqual([bad.host, bad.model, bad.key], ['openrouter.ai', null, KEY]);
  assert.deepEqual(logs, ['player-custom-endpoint.txt: ignored model']);
  assert.ok(!logs.join('\n').includes(KEY));
  const failing = new CustomEndpoint({path: 'p', readText: async () => 'model=a', writeText: async () => { throw Error('disk full'); }});
  await failing.load();
  await assert.rejects(failing.setModel('b'), /disk full/);
  assert.equal(failing.model, 'a');
  // No file at all: nothing is saved.
  const none = new CustomEndpoint({path: 'p', readText: async () => { throw Object.assign(Error('gone'), {code: 'ENOENT'}); }});
  await none.load();
  assert.equal(none.ready, false);
});

test('a file that exists but cannot be read for a moment (locked, no permission) keeps what was saved, and no paste writes it over', async () => {
  let text = `endpoint=http://localhost:11434/v1\nmodel=llama3.2\napi-key=${KEY}\n`, locked = null;
  const writes = [], logs = [];
  const endpoint = new CustomEndpoint({path: 'p', log: line => logs.push(line),
    readText: async () => { if (locked) throw Object.assign(Error('locked'), {code: locked}); return text; },
    writeText: async (_path, value) => { writes.push(value); text = value; }});
  await endpoint.load();
  assert.equal(endpoint.ready, true);
  let changed = 0;
  endpoint.onChange(() => { changed++; });
  // Test connection and choosing the provider read the file again: a lock does not wipe the settings.
  locked = 'EBUSY';
  await endpoint.load();
  assert.deepEqual([endpoint.host, endpoint.model, endpoint.key, changed], ['localhost:11434', 'llama3.2', KEY, 0]);
  assert.match(logs.join('\n'), /could not be read \(EBUSY\)/);
  assert.ok(!logs.join('\n').includes(KEY));
  // A paste while it is still locked is refused: writing now would drop what the file holds.
  locked = 'EPERM';
  await assert.rejects(endpoint.setModel('qwen2.5'), /not written over/);
  assert.deepEqual([writes.length, endpoint.model], [0, 'llama3.2']);
  // Readable again (and edited by hand meanwhile): the paste reads it first and keeps every other line.
  locked = null; text = `endpoint=http://localhost:1234/v1\nmodel=llama3.2\napi-key=${KEY}\n`;
  await endpoint.setModel('qwen2.5');
  assert.equal(writes.length, 1);
  assert.deepEqual([parseCustomFile(text).endpoint.host, parseCustomFile(text).model, parseCustomFile(text).key], ['localhost:1234', 'qwen2.5', KEY]);
});

test('the real file is written with the key in it, nowhere else, and is read back by a new process', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'custom-endpoint-'));
  try {
    const path = join(directory, CUSTOM_FILE);
    const first = await new CustomEndpoint({path}).load();
    await first.setUrl(parseEndpointUrl('https://openrouter.ai/api/v1'));
    await first.setModel('meta-llama/llama-3.1-8b-instruct');
    await first.setKey(KEY);
    assert.equal(await readFile(path, 'utf8').then(text => text.includes(`api-key=${KEY}`)), true);
    if (process.platform !== 'win32') assert.equal((await stat(path)).mode & 0o777, 0o600);
    const second = await new CustomEndpoint({path}).load();
    assert.deepEqual([second.host, second.model, second.key], ['openrouter.ai', 'meta-llama/llama-3.1-8b-instruct', KEY]);
    // Written by hand while the game runs: load() picks it up (Test connection and choosing the provider do this).
    await writeFile(path, `model=llama3.2\nendpoint=http://localhost:11434/v1\n`);
    await second.load();
    assert.deepEqual([second.host, second.model, second.key], ['localhost:11434', 'llama3.2', null]);
  } finally { await rm(directory, {recursive: true, force: true}); }
});

const command = (id, action, issuedAt = 1_000_000) => JSON.stringify({version: 1, id, action, issuedAt});

test('commands: only the seven known actions, a well-formed id and a recent time are accepted', () => {
  assert.deepEqual(COMMANDS, ['paste-url', 'paste-key', 'paste-model', 'clear-url', 'clear-key', 'clear-model', 'test']);
  for (const action of COMMANDS) assert.deepEqual(parseCustomCommand(command('s:cust:1', action), 1_000_100), {id: 's:cust:1', action});
  assert.equal(parseCustomCommand(command('s:cust:1', 'paste'), 1_000_100), null);
  assert.equal(parseCustomCommand(command('bad id', 'test'), 1_000_100), null);
  assert.equal(parseCustomCommand(command('s:cust:1', 'test', 2_000_000), 1_000_100), null, 'a time from the future');
  assert.equal(parseCustomCommand('{"version":1', 1_000_100), null);
  assert.equal(parseCustomCommand('', 1_000_100), null);
  assert.equal(parseCustomCommand(JSON.stringify({version: 2, id: 'a', action: 'test', issuedAt: 1}), 1_000_100), null);
  assert.equal(parseCustomCommand('x'.repeat(5000), 1_000_100), null);
});

async function control(options = {}) {
  const s = store(options.file ?? null);
  await s.endpoint.load();
  const provider = new MistralProvider({keyPath: 'm', readText: async () => { throw Error('none'); }, writeText: async () => {}, custom: s.endpoint});
  await provider.load();
  const published = [];
  let now = 2_000_000, raw = options.raw ?? '', clipboard = async () => KEY;
  const instance = new CustomControl({custom: s.endpoint, provider, commandPath: 'c.json', now: () => now, read: async () => raw,
    publish: async value => { published.push(JSON.parse(JSON.stringify(value))); }, readClipboard: () => clipboard(), test: options.test, log: line => published.logs?.push(line)});
  await instance.open();
  let sequence = 0;
  return {s, provider, instance, published,
    clipboard: fn => { clipboard = fn; },
    async send(action) {
      raw = command(`s:cust:${++sequence}`, action, now);
      now += 10;
      await instance.poll();
      return published.at(-1);
    }};
}

test('the settings page: three pastes, each checked and saved, and the status it reads never holds the key', async () => {
  const c = await control();
  assert.deepEqual({...c.published[0], updated: 0}, {version: 1, updated: 0, ready: false, host: null, secure: false, local: false, model: null, keySaved: false, tail: null, limit: null});
  c.clipboard(async () => 'https://openrouter.ai/api/v1\n');
  let status = await c.send('paste-url');
  assert.deepEqual([status.result.field, status.result.state, status.host, status.secure, status.ready], ['url', 'saved', 'openrouter.ai', true, false]);
  c.clipboard(async () => 'meta-llama/llama-3.1-8b-instruct');
  status = await c.send('paste-model');
  assert.deepEqual([status.result.field, status.result.state, status.model, status.ready], ['model', 'saved', 'meta-llama/llama-3.1-8b-instruct', true]);
  c.clipboard(async () => KEY);
  status = await c.send('paste-key');
  assert.deepEqual([status.result.field, status.result.state, status.keySaved, status.tail], ['key', 'saved', true, KEY.slice(-4)]);
  assert.equal(c.provider.requested, 'convai', 'the setting is still the default: saving settings does not choose the provider');
  assert.ok(!JSON.stringify(c.published).includes(KEY), 'no status ever holds the key');
  assert.match(c.s.text, new RegExp(KEY), 'the key is in the one private file');
  // Every refusal says which field and why, and saves nothing.
  c.clipboard(async () => 'ftp://example.com'); status = await c.send('paste-url');
  assert.deepEqual([status.result.state, status.result.reason, status.host], ['invalid', 'scheme', 'openrouter.ai']);
  c.clipboard(async () => 'http://example.com/v1'); assert.equal((await c.send('paste-url')).result.reason, 'insecure');
  c.clipboard(async () => 'https://example.com/v1?key=1'); assert.equal((await c.send('paste-url')).result.reason, 'extras');
  c.clipboard(async () => 'not a key at all'); status = await c.send('paste-key');
  assert.deepEqual([status.result.field, status.result.state, status.result.reason, status.tail], ['key', 'invalid', 'not-a-key', KEY.slice(-4)]);
  c.clipboard(async () => 'bad model'); status = await c.send('paste-model');
  assert.deepEqual([status.result.state, status.result.reason, status.model], ['invalid', 'not-a-model', 'meta-llama/llama-3.1-8b-instruct']);
  // The key still on the clipboard and "Paste model ID" pressed: refused, so the key is never shown, published or logged as the model.
  c.clipboard(async () => `${KEY}\r\n`); status = await c.send('paste-model');
  assert.deepEqual([status.result.state, status.result.reason, status.model], ['invalid', 'not-a-model', 'meta-llama/llama-3.1-8b-instruct']);
  assert.ok(!JSON.stringify(c.published).includes(KEY));
  c.clipboard(async () => '   '); assert.equal((await c.send('paste-key')).result.reason, 'empty');
  c.clipboard(async () => { throw Error('no clipboard'); }); assert.equal((await c.send('paste-key')).result.state, 'unreadable');
  // Each part is removed on its own.
  assert.equal((await c.send('clear-key')).keySaved, false);
  assert.equal((await c.send('clear-model')).model, null);
  status = await c.send('clear-url');
  assert.deepEqual([status.result.state, status.host, status.ready], ['cleared', null, false]);
  assert.equal(c.s.text, null, 'nothing left: the file is gone');
  assert.ok(!JSON.stringify(c.published).includes(KEY));
});

test('the settings page: an empty placeholder, garbage, an old command and a repeated one start nothing; a command left from the last session is ignored', async () => {
  const c = await control({raw: command('old:cust:1', 'paste-key', 1_999_999)});
  const count = c.published.length;
  c.clipboard(async () => { assert.fail('the clipboard must not be read'); });
  await c.instance.poll();   // the file still holds the old command: it was seen at the start and is not run
  for (const raw of ['', '{"version":1', 'null', '[]', command('bad id', 'test'), command('s:cust:9', 'paste', 2_000_000)]) {
    const instance = c.instance; instance.read = async () => raw;
    await instance.poll();
  }
  assert.equal(c.published.length, count);
  assert.equal(c.s.endpoint.key, null);
});

test('Test connection runs in the background: "testing" is published at once, the answer when the request ends; one at a time', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let runs = 0;
  const c = await control({file: 'endpoint=http://localhost:11434/v1\nmodel=llama3.2\n', test: async () => { runs++; await gate; return {state: 'ok', ms: 12}; }});
  const status = await c.send('test');
  assert.deepEqual([status.test.state, status.test.id], ['testing', 's:cust:1']);
  // A second press while one runs (the page stops showing "Testing..." before a 90 s test of a server on this computer ends) sends no second
  // request, but the running test answers to it: the page shows only the answer to its latest command.
  const again = await c.send('test');
  assert.equal(runs, 1, 'a second press while one runs sends nothing');
  assert.deepEqual([again.test.state, again.test.id], ['testing', 's:cust:2']);
  release();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(c.published.at(-1).test, {id: 's:cust:2', state: 'ok', ms: 12});
  // A change of the settings drops the old result: it says nothing about the new ones.
  c.clipboard(async () => 'https://example.com/v1');
  assert.equal((await c.send('paste-url')).test, undefined);
});

test('the connection test: one request, OK or the failure in the words the page has a sentence for, the server\'s own words, and never the key', async () => {
  const mock = await startOpenAiMock();
  try {
    const config = key => ({ready: true, key, model: 'test-model', chatUrl: mock.url + '/chat/completions', origin: mock.origin, local: true, extraHeaders: undefined});
    // OK: the request is tiny, asks for the saved model and carries the key as a Bearer token.
    let outcome = await testConnection(config(KEY));
    assert.equal(outcome.state, 'ok');
    assert.equal(mock.requests.length, 1);
    const [{headers, body}] = mock.requests;
    assert.equal(headers.authorization, `Bearer ${KEY}`);
    assert.equal(body.model, 'test-model');
    assert.equal(body.stream, true);
    assert.ok(body.max_tokens <= 24);
    assert.equal(body.messages.length, 2);
    // No key saved: no Authorization header at all.
    mock.requests.length = 0;
    assert.equal((await testConnection(config(null))).state, 'ok');
    assert.equal(mock.requests[0].headers.authorization, undefined);
    // Nothing set up: no request.
    mock.requests.length = 0;
    assert.deepEqual(await testConnection({ready: false}), {state: 'failed', code: 'no-setup', ms: 0});
    assert.equal(mock.requests.length, 0);

    const fails = async (plan, expected) => {
      mock.behave(() => plan);
      mock.requests.length = 0;
      outcome = await testConnection(config(KEY));
      assert.equal(outcome.state, 'failed', JSON.stringify(plan));
      for (const [name, value] of Object.entries(expected)) assert.deepEqual(outcome[name], value, `${name} for ${JSON.stringify(plan).slice(0, 60)}`);
      assert.equal(mock.requests.length, 1, 'one tiny request, no retry');
      assert.ok(!JSON.stringify(outcome).includes(KEY));
      return outcome;
    };
    await fails({status: 401, body: {error: {message: 'Invalid API key'}}}, {code: 'key', status: 401, detail: 'Invalid API key'});
    await fails({status: 402, body: {error: {message: 'Insufficient credits. Add more using https://openrouter.ai/credits'}}}, {code: 'credits', status: 402});
    await fails({status: 404, body: {error: {message: 'No endpoints found for nothing/here.'}}}, {code: 'model', status: 404, detail: 'No endpoints found for nothing/here.'});
    await fails({status: 429, headers: {'retry-after': '12'}, body: {error: {message: 'Rate limit exceeded'}}}, {code: 'limit', status: 429, waitS: 12});
    await fails({status: 503, body: 'Service Unavailable'}, {code: 'server', status: 503});
    await fails({status: 502, body: '<html><body><h1>502 Bad Gateway</h1></body></html>'}, {code: 'server', detail: '502 Bad Gateway'});
    await fails({status: 400, body: {error: {message: 'messages: too long'}}}, {code: 'request', status: 400, detail: 'messages: too long'});
    await fails({redirect: 'http://example.invalid/v1/chat/completions'}, {code: 'redirect'});
    await fails({sse: ['']}, {code: 'empty'});
    // The server echoing the key back in its error text does not put it into the result.
    await fails({status: 401, body: {error: {message: `Incorrect API key provided: ${KEY}`}}}, {code: 'key'});
    assert.match(outcome.detail, /Incorrect API key provided: \[key\]/);
  } finally { await mock.close(); }
});

test('an unreachable server and a timeout are told apart', async () => {
  const refused = await startOpenAiMock();
  const url = refused.url, origin = refused.origin;
  await refused.close();
  const config = {ready: true, key: null, model: 'm', chatUrl: url + '/chat/completions', origin, local: true};
  const outcome = await testConnection(config);
  assert.deepEqual([outcome.state, outcome.code], ['failed', 'unreachable']);
  assert.match(outcome.detail, /could not be reached/);
  assert.deepEqual(describeFailure(new MistralError('network', 'did not answer in time', {provider: 'custom', slow: true})).code, 'timeout');
  assert.deepEqual(describeFailure(new MistralError('network', 'went quiet before the reply was finished', {provider: 'custom'})).code, 'timeout');
  assert.deepEqual(describeFailure(Error('boom')).code, 'unreachable');
  assert.equal(describeFailure(new MistralError('limit', 'x', {provider: 'custom', status: 429, retryAfterMs: 1500})).waitS, 2);
});
