// A Custom endpoint model id with a slash (OpenRouter's "vendor/name", a player report of 31 Oct with sao10k/l3-euryale-70b), end to end: the id the player pastes, the settings
// file, the status the game reads (mod/custom-provider.lua), the Lua row, the request body, the prompt profile, and a whole turn whose reply is narration in plain prose.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import fengari from 'fengari';
import {uiLocaleBootstrap} from './ui-locale-fixture.mjs';
import {CUSTOM_FILE, CustomControl, CustomEndpoint, formatCustomFile, parseCustomFile, parseEndpointUrl, parseModelId} from './custom-endpoint.mjs';
import {MistralProvider} from './mistral-key.mjs';
import {MistralMemory} from './mistral-memory.mjs';
import {PersonaBook} from './mistral-prompt.mjs';
import {TextProviderHost, customRoute} from './text-provider-host.mjs';
import {streamChat} from './mistral-client.mjs';
import {customProfileId, isCustomProfileId, familyOf, defaultProfile} from './prompt-profiles.mjs';
import {startOpenAiMock} from './openai-mock-server.mjs';

const KEY = 'test' + 'x'.repeat(28);
const IDS = ['sao10k/l3-euryale-70b', 'meta-llama/llama-3.1-8b-instruct', 'meta-llama/llama-3.3-70b-instruct:free', 'sao10k/l3.3-euryale-70b', 'nousresearch/hermes-3-llama-3.1-405b'];
const roster = JSON.parse(await readFile(new URL('../characters/roster.json', import.meta.url), 'utf8'));

test('the id is accepted as pasted, with a label, quotes or spaces, and from an OpenRouter page address', () => {
  for (const id of IDS) {
    assert.equal(parseModelId(id), id, id);
    assert.equal(parseModelId(`  ${id}\r\n`), id, 'spaces and a line break around it');
    assert.equal(parseModelId(`model=${id}`), id);
    assert.equal(parseModelId(`"${id}"`), id);
    assert.equal(parseEndpointUrl(`https://openrouter.ai/${id}`).modelId, id, 'a pasted model page of OpenRouter');
  }
  assert.equal(parseModelId('sao10k/l3-euryale-70b/'), 'sao10k/l3-euryale-70b', 'a trailing slash from a pasted page address is not part of an id');
});

test('the saved file keeps the slash, and a new process reads it back', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'custom-slash-'));
  try {
    const path = join(directory, CUSTOM_FILE);
    const first = await new CustomEndpoint({path}).load();
    await first.setUrl(parseEndpointUrl('https://openrouter.ai/api/v1'));
    await first.setModel('sao10k/l3-euryale-70b'); await first.setKey(KEY);
    assert.match(await readFile(path, 'utf8'), /^model=sao10k\/l3-euryale-70b$/m);
    const second = await new CustomEndpoint({path}).load();
    assert.deepEqual([second.model, second.ready, second.chatUrl], ['sao10k/l3-euryale-70b', true, 'https://openrouter.ai/api/v1/chat/completions']);
    const text = formatCustomFile({endpoint: 'https://openrouter.ai/api/v1', model: 'meta-llama/llama-3.1-8b-instruct'});
    assert.equal(parseCustomFile(text).model, 'meta-llama/llama-3.1-8b-instruct');
  } finally { await rm(directory, {recursive: true, force: true}); }
});

test('the settings page command: Paste model ID saves the id and publishes it for the game', async () => {
  const files = {text: null};
  const endpoint = new CustomEndpoint({path: 'p.txt', readText: async () => { if (files.text === null) throw Object.assign(Error('missing'), {code: 'ENOENT'}); return files.text; },
    writeText: async (_path, value) => { files.text = value; }, removeFile: async () => { files.text = null; }});
  await endpoint.load();
  const provider = new MistralProvider({keyPath: 'm', readText: async () => { throw Error('none'); }, writeText: async () => {}, custom: endpoint});
  await provider.load();
  const published = [];
  let now = 2_000_000, raw = '', clipboard = '';
  const control = new CustomControl({custom: endpoint, provider, commandPath: 'c.json', now: () => now, read: async () => raw, publish: async value => { published.push(JSON.parse(JSON.stringify(value))); },
    readClipboard: async () => clipboard});
  await control.open();
  let sequence = 0;
  const send = async action => { raw = JSON.stringify({version: 1, id: `s:cust:${++sequence}`, action, issuedAt: now}); now += 10; await control.poll(); return published.at(-1); };
  for (const id of IDS) {
    clipboard = id;
    const status = await send('paste-model');
    assert.deepEqual([status.result.field, status.result.state, status.model], ['model', 'saved', id], id);
  }
  assert.match(files.text, new RegExp(`model=${IDS.at(-1).replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}`));
});

test('mod/custom-provider.lua reads the id from the status file and shows it on the Custom model ID row', () => {
  const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;
  const source = readFileSync(new URL('../mod/custom-provider.lua', import.meta.url), 'utf8');
  const state = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(state);
  const code = `${uiLocaleBootstrap}
    local ui = convaiUiLocale
    local factory = (function() ${source} end)()
    local ids = {${IDS.map(id => `'${id}'`).join(', ')}}
    for _, id in ipairs(ids) do
      local provider = factory.new({ui = ui, clock = function() return 1000 end,
        readJSON = function() return {version = 1, updated = 1, ready = true, host = 'openrouter.ai', secure = true, ['local'] = false, model = id, keySaved = true, tail = 'abcd'} end,
        writeCommand = function() return true end, session = function() return 'sess-1' end})
      local state = provider.state()
      assert(state.model == id, 'state.model ' .. tostring(state.model) .. ' for ' .. id)
      assert(state.ready == true, 'ready for ' .. id)
      local row
      for _, item in ipairs(provider.rows()) do if item.id == 'custom-model' then row = item end end
      assert(row and row.value == ui.t('Remove') and row.action == 'clear-model', 'row for ' .. id)
      assert(row.help:find(id, 1, true), 'the help text names ' .. id)
    end`;
  const status = lauxlib.luaL_dostring(state, to_luastring(code));
  const error = status === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(state, -1));
  lua.lua_close(state);
  assert.equal(status, lua.LUA_OK, error);
});

test('the request body carries the id exactly as saved, once, and the prompt profile is a Custom profile of the Llama family or the generic one', async () => {
  const mock = await startOpenAiMock();
  try {
    for (const id of IDS) {
      mock.requests.length = 0;
      mock.behave(() => ({sse: ['Ok.']}));
      await streamChat({provider: 'custom', apiKey: KEY, model: id, endpoint: mock.url + '/chat/completions', trustedOrigin: mock.origin, messages: [{role: 'user', content: 'Hi.'}]});
      assert.equal(mock.requests[0].url, '/v1/chat/completions', 'the id is never part of the address');
      assert.equal(mock.requests[0].body.model, id);
      assert.equal(JSON.stringify(mock.requests[0].body).split(id).length - 1, 1, 'the id appears once');
      const profile = customProfileId('https://openrouter.ai', id);
      assert.ok(isCustomProfileId(profile), profile);
      assert.ok(profile.length <= 80);
      assert.ok(defaultProfile(profile, {family: familyOf(id)}), 'a default profile for it');
    }
    assert.equal(familyOf('meta-llama/llama-3.1-8b-instruct'), 'llama');
    assert.equal(familyOf('sao10k/l3-euryale-70b'), 'generic');
  } finally { await mock.close(); }
});

test('a whole turn on sao10k/l3-euryale-70b: the reply that was read aloud arrives without its narration, and the request names the model', async () => {
  const mock = await startOpenAiMock();
  const custom = new CustomEndpoint({path: null});
  await custom.setUrl(parseEndpointUrl(mock.url)); await custom.setModel('sao10k/l3-euryale-70b'); await custom.setKey(KEY);
  const provider = new MistralProvider({keyPath: 'k', readText: async () => { throw Error('none'); }, writeText: async () => {}, custom});
  await provider.load();
  provider.setPreference('custom'); provider.apply();
  const route = customRoute({provider, custom, chat: options => streamChat({...options, firstByteMs: 400, retryFirstByteMs: 400, totalMs: 1500, retries: 1, backoffMs: [5]})});
  const host = new TextProviderHost({provider, memory: await MistralMemory.open({path: null}), personas: new PersonaBook(roster), routes: {custom: route}, log: () => {}});
  try {
    const turn = text => ({text, context: 'CURRENT PERSON\nA holocall.', sessionId: 'session-1', local: {profileKey: 'jackie-welles', name: 'Jackie Welles', channel: 'phone'}});
    mock.behave(() => ({sse: ["Jackie's voice over the phone, ", 'concerned, hey are you okay?']}));
    const result = await host.reply(turn("Jackie, it is me."));
    assert.equal(result.text, 'Hey are you okay?');
    assert.equal(mock.requests[0].body.model, 'sao10k/l3-euryale-70b');
    assert.match(mock.requests[0].body.messages[0].content, /No narration in plain words/);
    // Speech that only looks like narration is kept whole.
    mock.requests.length = 0;
    mock.behave(() => ({sse: ["Jackie's gonna love this. My voice is shot, though."]}));
    assert.equal((await host.reply(turn('Look what I got.'))).text, "Jackie's gonna love this. My voice is shot, though.");
    // A reply of narration alone is empty, and the turn asks once more.
    mock.requests.length = 0;
    let calls = 0;
    mock.behave(() => ({sse: [++calls === 1 ? 'Her voice crackles through the line.' : 'Hey V, still there?']}));
    assert.equal((await host.reply(turn('Hello?'))).text, 'Hey V, still there?');
    assert.equal(mock.requests.length, 2);
  } finally { host.close(); await mock.close(); }
});
