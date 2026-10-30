import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import fengari from 'fengari';
import {uiLocaleBootstrap} from './ui-locale-fixture.mjs';
import {nsuiHarness} from './manager-fixture.mjs';

// The game side of the Custom (OpenAI-compatible) conversation provider: mod/custom-provider.lua on its own (state cleaning, the four rows,
// the commands, the notice texts) and inside the real manager.lua, manager-ui.lua and nsui.lua over a fake Native Settings UI (the fifth selector entry, the rows
// under the Mistral key row, the provider notes, the Mature content rules, the settings validation, the reply notices). The conversation
// service is played by the test: it writes the state file the bridge would publish. Nothing here reaches a network or a game.
const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;
const read = name => readFileSync(new URL(`../mod/${name}`, import.meta.url), 'utf8');
const customSource = read('custom-provider.lua');
const initSource = read('init.lua');

function run(code) {
  const state = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(state);
  const status = lauxlib.luaL_dostring(state, to_luastring(uiLocaleBootstrap + code));
  let error = status === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(state, -1));
  // Name the failing Lua line: the message only carries its number in the generated chunk.
  const failedLine = /^\[string [^\]]*\]:(\d+):/.exec(error);
  if (failedLine) error += '\n>> ' + (uiLocaleBootstrap + code).split('\n')[Number(failedLine[1]) - 1].trim().slice(0, 300);
  lua.lua_close(state);
  assert.equal(status, lua.LUA_OK, error);
}

// The nine notices and the failed-turn texts, as the contract fixed them (the daily limit's is the sentence without a reset time; with one it ends "It resets at {time}.").
const NOTICES = {
  'custom-key': 'The custom provider did not accept your key. Check it in Settings > Conversation provider.',
  'custom-credits': 'The custom provider says your account is out of credits. Add credits there, then try again.',
  'custom-model': 'The custom provider does not know that model ID. Check it in Settings.',
  'custom-limit': 'The custom provider is rate limiting you. Try again in a moment.',
  'custom-daily': 'The free daily limit for this model was reached. Try again after it resets.',
  'custom-reasoning': 'This model spends its reply on thinking. Choose a non-reasoning model in Settings.',
  'custom-unreachable': 'The custom provider did not answer. Check its address in Settings, or try again.',
  'custom-no-setup': 'The custom provider is not set up, so Convai is used. Add its URL and model ID in Settings.',
  'custom-voice': 'Custom provider replies are spoken by a local voice instead of the Convai cloud voice.',
};
// The Google Gemini failures (their own wording, not the Custom provider's); gemini-daily is the sentence without a reset time.
const GEMINI_NOTICES = {
  'gemini-key': 'Google did not accept your Gemini key. Check it in Google AI Studio and add it again.',
  'gemini-daily': 'Your free Gemini allowance for today is used up. It resets tomorrow. Use Convai or Local AI.',
  'gemini-limit': 'Google Gemini is rate limiting you. Wait a minute, then try again.',
  'gemini-region': 'Google Gemini is not available in your region. Use Convai or Local AI.',
  'gemini-server': 'Google Gemini is busy or had an error. Wait a minute, then try again.',
  'gemini-unreachable': 'Google Gemini could not be reached. Check your internet connection, then try again.',
  'gemini-model': 'The Gemini model is not available right now. Try again later or use Local AI.',
};

// ---------------------------------------------------------------------------------------------------------------------------------
// mod/custom-provider.lua on its own
// ---------------------------------------------------------------------------------------------------------------------------------

const moduleFixture = `
  local ui = convaiUiLocale
  local factory = (function() ${customSource} end)()
  local clock, written, failWrite, shown = 1000, {}, false, nil
  local reads = 0
  local function make(extra)
    local options = {ui = ui, clock = function() return clock end,
      readJSON = function(path) assert(path == 'runtime/custom-provider-state.json', path); reads = reads + 1; return shown end,
      writeCommand = function(path, value)
        assert(path == 'runtime/custom-provider-command.json', path)
        if failWrite then return false end
        written[#written + 1] = value; return true
      end,
      session = function() return 'sess-1' end}
    for key, value in pairs(extra or {}) do options[key] = value end
    return factory.new(options)
  end
  local function publish(value) shown = value; clock = clock + 2 end
  local function rowsOf(provider) local list = {}; for _, item in ipairs(provider.rows()) do list[item.id] = item end; return list end
  local function first(text) return text:match('^(.-)\\n\\n') or text end
  local function lastCommand() return written[#written] end
  local OK_BASE = {version = 1, updated = 1, ready = true, host = 'openrouter.ai', secure = true, ['local'] = false,
    model = 'meta-llama/llama-3.1-8b-instruct', keySaved = true, tail = 'abcd'}
  -- A state that is OK_BASE with changes; NONE removes a field (a nil in the changes cannot, a table constructor drops it).
  local NONE = {}
  local function base(extra)
    local value = {}
    for key, item in pairs(OK_BASE) do value[key] = item end
    for key, item in pairs(extra or {}) do if item == NONE then value[key] = nil else value[key] = item end end
    return value
  end
`;

test('nothing published yet: four rows to paste into, a Test row that waits for the service, and no state is invented', () => run(`${moduleFixture}
  local provider = make()
  local state = provider.state()
  assert(state.available == false and state.ready == false and state.host == nil and state.model == nil and state.keySaved == false
    and state.tail == nil and state.result == nil and state.test == nil and state.limit == nil and state.action == nil)
  local items = provider.rows()
  assert(#items == 5 and items[1].id == 'custom-preset-mistral' and items[2].id == 'custom-url'
    and items[3].id == 'custom-key' and items[4].id == 'custom-model' and items[5].id == 'custom-test')
  local rows = rowsOf(provider)
  assert(rows['custom-url'].label == 'Custom endpoint URL' and rows['custom-url'].value == 'Paste endpoint URL' and rows['custom-url'].action == 'paste-url'
    and rows['custom-url'].enabled == true and rows['custom-url'].field == 'url')
  assert(rows['custom-key'].label == 'Custom API key' and rows['custom-key'].value == 'Paste API key' and rows['custom-key'].action == 'paste-key' and rows['custom-key'].enabled == true)
  assert(rows['custom-model'].label == 'Custom model ID' and rows['custom-model'].value == 'Paste model ID' and rows['custom-model'].action == 'paste-model' and rows['custom-model'].enabled == true)
  assert(rows['custom-test'].label == 'Test connection' and rows['custom-test'].value == 'Test' and rows['custom-test'].action == 'test')
  assert(rows['custom-test'].enabled == false, 'no state file: the bridge cannot be reached, so nothing can be tested')
  assert(first(rows['custom-test'].help) == 'The conversation service is not running, so nothing can be tested. Restart the game.', rows['custom-test'].help)
  -- The URL help says what to copy, where it is read, what http:// may reach, the file, and that nothing is sent yet.
  local help = rows['custom-url'].help
  for _, part in ipairs({'https://openrouter.ai/api/v1', 'https://nano-gpt.com/api/v1', 'http://localhost:11434/v1', 'Ollama', 'read from the clipboard once',
    'saved on this computer', 'home network', 'http://', 'endpoint=', 'model=', 'api-key=', 'player-custom-endpoint.txt', 'conversation service folder',
    'Nothing is sent until you choose this provider or press Test connection.'}) do
    assert(help:find(part, 1, true), 'URL help lacks: ' .. part)
  end
  assert(rows['custom-key'].help:find('read from the clipboard once', 1, true) and rows['custom-key'].help:find('saved on this computer only', 1, true)
    and rows['custom-key'].help:find('Ollama', 1, true) and rows['custom-key'].help:find('no key', 1, true))
  assert(rows['custom-model'].help:find('meta-llama/llama-3.1-8b-instruct', 1, true) and rows['custom-model'].help:find('llama3.2', 1, true) and rows['custom-model'].help:find('Ollama', 1, true))
  for _, item in pairs(rows) do assert(not item.help:lower():find('recommend', 1, true) and not item.label:lower():find('recommend', 1, true), item.id) end
  assert(provider.lastCommand() == nil)
`));

test('the Mistral preset comes first: one press sends its command, the service says it is saved, and a failed save is told on its row', () => run(`${moduleFixture}
  local provider = make()
  local rows = rowsOf(provider)
  assert(rows['custom-preset-mistral'].label == 'Mistral' and rows['custom-preset-mistral'].value == 'Add' and rows['custom-preset-mistral'].action == 'preset-mistral'
    and rows['custom-preset-mistral'].enabled == true and rows['custom-preset-mistral'].field == 'preset')
  -- The help says the key is copied first, that Add saves it from the clipboard, that the same key powers the Voxtral voice, and that new accounts may have no free key.
  for _, part in ipairs({'Copy your Mistral API key first', 'press Add', 'saves your key from the clipboard', 'Voxtral', 'may not get a free API key'}) do
    assert(rows['custom-preset-mistral'].help:find(part, 1, true), 'Mistral help lacks: ' .. part)
  end
  assert(rows['custom-preset-gemini'] == nil and rows['custom-preset-groq'] == nil, 'no Gemini or Groq row on the Custom page')
  assert(not rows['custom-preset-mistral'].help:lower():find('recommend', 1, true) and not rows['custom-preset-mistral'].label:lower():find('recommend', 1, true))
  -- Pressing one writes its command; nothing else changes until the service answers.
  local ok, message = provider.request('preset-mistral')
  assert(ok == true and lastCommand().action == 'preset-mistral' and provider.lastCommand().action == 'preset-mistral', tostring(message))
  assert(provider.request('preset-groq') == false, 'the Groq setup is gone: its command is not sent')
  assert(provider.request('preset-nothing') == false, 'an unknown setup is not sent')
  -- The service names the saved preset (only a known name counts); its button turns into Remove and sends the clear command.
  publish(base({host = 'api.mistral.ai', model = 'ministral-8b-latest', preset = 'mistral', keySaved = false, tail = NONE}))
  rows = rowsOf(provider)
  assert(rows['custom-preset-mistral'].value == 'Remove' and rows['custom-preset-mistral'].action == 'clear-preset-mistral' and rows['custom-preset-mistral'].label == 'Mistral')
  assert(first(rows['custom-preset-mistral'].help) == 'Deletes this free setup: the endpoint URL, the model ID and the API key saved with it.', rows['custom-preset-mistral'].help)
  assert(provider.request('clear-preset-mistral') and lastCommand().action == 'clear-preset-mistral')
  assert(provider.request('clear-preset-groq') == false, 'the Groq command is gone')
  assert(provider.state().preset == 'mistral')
  for _, bad in ipairs({'other', '', 7, true, {}, 'groq'}) do
    publish(base({preset = bad}))
    assert(provider.state().preset == nil, tostring(bad))
    assert(rowsOf(provider)['custom-preset-mistral'].value == 'Add')
  end
  local before = (publish(base({preset = NONE})) or provider.signature())
  local after = (publish(base({preset = 'mistral'})) or provider.signature())
  assert(before ~= after, 'a new saved preset redraws the page')
  -- The answer to the latest press: failed puts its sentence first on the preset row.
  assert(provider.request('preset-mistral'))
  publish(base({result = {id = lastCommand().id, field = 'preset', state = 'saved'}}))
  assert(provider.state().result.field == 'preset' and provider.state().result.state == 'saved')
  publish(base({result = {id = lastCommand().id, field = 'preset', state = 'invalid', reason = 'not-a-key'}}))
  assert(first(rowsOf(provider)['custom-preset-mistral'].help) == 'The clipboard does not hold an API key.', rowsOf(provider)['custom-preset-mistral'].help)
  publish(base({result = {id = lastCommand().id, field = 'preset', state = 'failed'}}))
  assert(first(rowsOf(provider)['custom-preset-mistral'].help) == 'It could not be saved.', rowsOf(provider)['custom-preset-mistral'].help)
  -- An answer that belongs to an older press is not shown.
  publish(base({result = {id = 'sess-1:cust:999', field = 'preset', state = 'failed'}}))
  assert(provider.state().result == nil)
`));

test('the Google Gemini page (second instance, kind gemini): its own channel, one key row with Add and Remove and no Test row, and the notes and notices of the provider', () => run(`${moduleFixture}
  local sentTo
  local gemini = factory.new({ui = ui, kind = 'gemini', clock = function() return clock end, session = function() return 'sess-1' end,
    readJSON = function(path) assert(path == 'runtime/gemini-provider-state.json', path); return nil end,
    writeCommand = function(path, value) sentTo = path; written[#written + 1] = value; return true end})
  local GEMINI_NOTICES = {${Object.keys(GEMINI_NOTICES).map(id => `['${id}'] = ${JSON.stringify(GEMINI_NOTICES[id])}`).join(', ')}}
  local rows = {}
  for _, item in ipairs(gemini.rows()) do rows[item.id] = item end
  assert(#gemini.rows() == 1 and gemini.rows()[1].id == 'gemini-key' and rows['gemini-test'] == nil, 'the key row only: Test connection is gone')
  assert(rows['gemini-key'].label == 'Google Gemini API key' and rows['gemini-key'].value == 'Add' and rows['gemini-key'].action == 'preset-gemini')
  for _, part in ipairs({'Google AI Studio', 'aistudio.google.com/apikey', 'no card', 'read from the clipboard once', 'about 500 replies', 'not offered in every country', 'improve its products'}) do
    assert(rows['gemini-key'].help:find(part, 1, true), 'Gemini help lacks: ' .. part)
  end
  assert(not rows['gemini-key'].help:lower():find('recommend', 1, true))
  local ok = gemini.request('preset-gemini')
  assert(ok == true and lastCommand().action == 'preset-gemini' and sentTo == 'runtime/gemini-provider-command.json', tostring(sentTo))
  -- A page that cannot test: the Test command is refused and nothing is written for it.
  local before = #written
  assert(gemini.request('test') == false and #written == before)
  assert(gemini.geminiNoteFor('rate') == 'Google Gemini: rate limited for a minute' and gemini.geminiNoteFor('daily') == 'Google Gemini: free allowance used up for today'
    and gemini.geminiNoteFor('invalid') == 'Google Gemini: key not accepted' and gemini.geminiNoteFor('region') == 'Google Gemini: not available in your region'
    and gemini.geminiNoteFor('model') == 'Google Gemini: model unavailable' and gemini.geminiNoteFor('credits') == nil and gemini.geminiNoteFor(nil) == nil)
  assert(gemini.notice('gemini-no-key') == 'Google Gemini has no key yet, so Convai is used. Add your key in Settings > Conversation provider.')
  assert(gemini.notice('gemini-voice') == 'Google Gemini replies are spoken by a local voice instead of the Convai cloud voice.')
  assert(#factory.GEMINI_NOTICE_IDS == 9)
  for id, text in pairs(GEMINI_NOTICES) do assert(gemini.notice(id) == text, id .. ': ' .. tostring(gemini.notice(id))) end
  assert(gemini.notice('gemini-daily', '02:30') == 'Your free Gemini allowance for today is used up. It resets at 02:30. Use Convai or Local AI.')
  assert(gemini.notice('gemini-daily', 'soon') == GEMINI_NOTICES['gemini-daily'])
  -- Not the Custom wording: none of the Gemini failures says "custom provider".
  for id, text in pairs(GEMINI_NOTICES) do assert(not text:lower():find('custom', 1, true), id) end
`));

test('the key just added is tried once: the row says checking, then what Google answered, from the answer to the latest Add only', () => run(`${moduleFixture}
  local shown
  local gemini = factory.new({ui = ui, kind = 'gemini', clock = function() return clock end, session = function() return 'sess-1' end,
    readJSON = function() return shown end, writeCommand = function(_, value) written[#written + 1] = value; return true end})
  local function gstate(extra)
    local value = {version = 1, updated = 1, ready = true, host = 'generativelanguage.googleapis.com', secure = true, ['local'] = false,
      model = 'gemini-flash-lite-latest', keySaved = true, tail = 'wxyz', preset = 'gemini'}
    for key, item in pairs(extra or {}) do value[key] = item end
    return value
  end
  local function key() return gemini.rows()[1] end
  -- Nothing was added in this session: a check in the file is not shown (it belongs to no command of this page).
  shown = gstate({check = {id = 'sess-1:cust:1', state = 'failed', code = 'key'}}); clock = clock + 2
  assert(gemini.state(true).check == nil and key().label == 'Google Gemini API key (…wxyz)' and key().value == 'Remove')
  assert(gemini.request('preset-gemini') == true)
  local id = written[#written].id
  -- Checking: the label says so and there is no sentence yet.
  shown = gstate({check = {id = id, state = 'checking'}}); clock = clock + 2
  assert(gemini.state(true).check.state == 'checking' and key().label == 'Google Gemini API key (Checking…)')
  -- An answer for an older Add is not shown.
  shown = gstate({check = {id = 'sess-1:cust:999', state = 'ok'}}); clock = clock + 2
  assert(gemini.state(true).check == nil)
  -- Accepted.
  shown = gstate({check = {id = id, state = 'ok'}}); clock = clock + 2
  assert(first(key().help) == 'Google accepted the key.' and key().label == 'Google Gemini API key (…wxyz)', key().help)
  -- Refused: what to do.
  shown = gstate({check = {id = id, state = 'failed', code = 'key', status = 400}}); clock = clock + 2
  assert(first(key().help) == 'Google did not accept this key. Check it in Google AI Studio, then Remove it and Add the right one.', key().help)
  assert(key().value == 'Remove', 'the key stays saved: it can be removed')
  shown = gstate({check = {id = id, state = 'failed', code = 'daily'}}); clock = clock + 2
  assert(first(key().help) == 'Google accepted the key, but the free allowance is used up for now.', key().help)
  shown = gstate({check = {id = id, state = 'failed', code = 'limit'}}); clock = clock + 2
  assert(first(key().help) == 'Google accepted the key, but the free allowance is used up for now.', key().help)
  shown = gstate({check = {id = id, state = 'failed', code = 'region'}}); clock = clock + 2
  assert(first(key().help) == 'The key is saved, but Google Gemini is not available in your region.', key().help)
  shown = gstate({check = {id = id, state = 'failed', code = 'unreachable'}}); clock = clock + 2
  assert(first(key().help) == 'The key is saved, but Google could not be reached to check it.', key().help)
  shown = gstate({check = {id = id, state = 'failed', code = 'server', status = 503}}); clock = clock + 2
  assert(first(key().help) == 'The key is saved, but Google could not be reached to check it.', key().help)
  -- The signature changes with the check, so the page redraws.
  shown = gstate({check = {id = id, state = 'checking'}}); clock = clock + 2
  local one = gemini.signature()
  shown = gstate({check = {id = id, state = 'ok'}}); clock = clock + 2
  assert(gemini.signature() ~= one)
  -- A stale check (the service stopped under it) is no longer shown as running.
  shown = gstate({check = {id = id, state = 'checking'}}); clock = clock + 300
  assert(gemini.state(true).check == nil)
`));

test('saved values: the host, the last four characters or Added, the model; an unencrypted address says so; Test is enabled', () => run(`${moduleFixture}
  local provider = make()
  publish(base())
  local rows = rowsOf(provider)
  assert(rows['custom-url'].label == 'Custom endpoint URL (openrouter.ai)' and rows['custom-url'].value == 'Remove' and rows['custom-url'].action == 'clear-url')
  assert(rows['custom-url'].help:find('Deletes the saved endpoint URL', 1, true) and not rows['custom-url'].help:find('not encrypted', 1, true))
  assert(rows['custom-key'].label == 'Custom API key (…abcd)' and rows['custom-key'].value == 'Remove' and rows['custom-key'].action == 'clear-key')
  assert(rows['custom-key'].help:find('Deletes the saved key', 1, true) and rows['custom-key'].help:find('last four characters', 1, true))
  assert(not rows['custom-key'].help:find('abcd', 1, true), 'the help never repeats the tail')
  -- A model id too long for a label is cut there and given in full in the help.
  assert(rows['custom-model'].label == 'Custom model ID (meta-llama/llama-3.1-8b-i…)' and rows['custom-model'].value == 'Remove' and rows['custom-model'].action == 'clear-model', rows['custom-model'].label)
  assert(first(rows['custom-model'].help) == 'Model ID: meta-llama/llama-3.1-8b-instruct', first(rows['custom-model'].help))
  assert(rows['custom-test'].enabled == true and rows['custom-test'].label == 'Test connection' and rows['custom-test'].help:find('one tiny message', 1, true))
  -- A short key (a local server) has no tail: Added.
  publish(base({tail = NONE}))
  assert(rowsOf(provider)['custom-key'].label == 'Custom API key (Added)')
  -- A tail that is not a plausible tail (too long, spaces, not text) is dropped.
  for _, bad in ipairs({'abcdefghi', 'ab cd', '', 7, true, {}}) do
    publish(base({tail = bad}))
    assert(rowsOf(provider)['custom-key'].label == 'Custom API key (Added)', tostring(bad))
  end
  -- Home-network address: http://, this computer.
  publish(base({host = 'localhost:11434', secure = false, ['local'] = true, model = 'llama3.2', keySaved = false, tail = NONE}))
  rows = rowsOf(provider)
  assert(rows['custom-url'].label == 'Custom endpoint URL (localhost:11434)' and rows['custom-url'].help:find('not encrypted', 1, true) and rows['custom-url'].help:find('home network', 1, true))
  assert(rows['custom-key'].label == 'Custom API key' and rows['custom-key'].value == 'Paste API key')
  assert(rows['custom-model'].label == 'Custom model ID (llama3.2)' and first(rows['custom-model'].help) == 'Model ID: llama3.2')
  -- A very long host is cut in the label.
  publish(base({host = string.rep('a', 60) .. '.example.com'}))
  assert(#rowsOf(provider)['custom-url'].label < 70)
  assert(provider.state().ready == true and provider.state().secure == true and provider.state().isLocal == false)
`));

test('malformed state never throws and never invents a value: every field and every kind of garbage, before and after a command', () => run(`${moduleFixture}
  local garbage = {'', 'x', string.rep('a', 10000), 0, -1, 1e308, 0/0, math.huge, -math.huge, true, false, {}, {{}}, {a = 1}, '\\0', '<b>x</b>', '../../x',
    'a b', string.char(255, 254), 'meta llama', string.rep('m', 121), string.rep('h', 256)}
  local fields = {'version', 'updated', 'ready', 'host', 'secure', 'local', 'model', 'keySaved', 'tail', 'result', 'test', 'limit'}
  local provider = make()
  local function check(label)
    local ok, err = pcall(provider.state); assert(ok, label .. ' state: ' .. tostring(err))
    ok, err = pcall(provider.rows); assert(ok, label .. ' rows: ' .. tostring(err))
    ok, err = pcall(provider.signature); assert(ok, label .. ' signature: ' .. tostring(err))
    assert(#provider.rows() == 5 and type(provider.signature()) == 'string', label)
  end
  for round = 1, 2 do
    if round == 2 then
      assert(provider.request('paste-url')); assert(provider.request('test'))
    end
    publish(base()); check('base')
    for _, field in ipairs(fields) do
      for index, value in ipairs(garbage) do
        publish(base({[field] = value}))
        check(field .. '#' .. index)
        local state = provider.state()
        if field == 'host' then assert(state.host == nil or #state.host <= 255) end
        if field == 'model' then assert(state.model == nil or #state.model <= 120) end
        if field == 'tail' then assert(state.tail == nil or #state.tail <= 8) end
        if field == 'version' then assert(state.available == (value == 1)) end
        if field == 'limit' then assert(state.limit == nil) end
      end
    end
    -- result and test tables with garbage in each of their own fields (ids that match the command just sent, so they get past the id check)
    local id = lastCommand() and lastCommand().id or 'none'
    for _, field in ipairs({'id', 'field', 'state', 'reason', 'code', 'status', 'waitS', 'detail', 'ms'}) do
      for index, value in ipairs(garbage) do
        local result, test = {id = id, field = 'url', state = 'invalid', reason = 'empty'}, {id = id, state = 'failed', code = 'limit', status = 429, waitS = 3, detail = 'x', ms = 5}
        result[field], test[field] = value, value
        publish(base({result = result, test = test})); check('result/test ' .. field .. '#' .. index)
      end
    end
  end
  -- Not a table at all: the file held a number or a string, or nothing.
  for _, whole in ipairs({7, 'text', true}) do shown = whole; clock = clock + 2; check('whole ' .. tostring(whole)); assert(provider.state().available == false) end
  shown = nil; clock = clock + 2; check('nothing')
  -- A reader that raises is the same as no file.
  local broken = make({readJSON = function() error('disk') end})
  assert(broken.state().available == false and #broken.rows() == 5)
`));

test('a failed paste puts its reason first in the help of its own row; an answer for another row, an older command or an unknown state is not shown', () => run(`${moduleFixture}
  local provider = make()
  publish(base({host = NONE, model = NONE, keySaved = false, tail = NONE, ready = false}))
  local REASONS = {
    {'url', 'paste-url', 'empty', 'The clipboard is empty. Copy it first.'},
    {'url', 'paste-url', 'not-a-url', 'The clipboard does not hold a web address.'},
    {'url', 'paste-url', 'scheme', 'The address must start with https:// or http://.'},
    {'url', 'paste-url', 'insecure', 'Only https:// works outside this computer and your home network.'},
    {'url', 'paste-url', 'extras', 'Use the base URL only: no password, query or #.'},
    {'url', 'paste-url', 'long', 'That is too long.'},
    {'url', 'paste-url', 'whatever', 'That was not accepted.'},
    {'key', 'paste-key', 'empty', 'The clipboard is empty. Copy it first.'},
    {'key', 'paste-key', 'not-a-key', 'The clipboard does not hold an API key.'},
    {'key', 'paste-key', 'long', 'That is too long.'},
    {'model', 'paste-model', 'empty', 'The clipboard is empty. Copy it first.'},
    {'model', 'paste-model', 'not-a-model', 'The clipboard does not hold a model ID.'},
    {'model', 'paste-model', 'long', 'That is too long.'},
  }
  local LABEL = {url = 'custom-url', key = 'custom-key', model = 'custom-model'}
  local NAME = {url = 'Custom endpoint URL', key = 'Custom API key', model = 'Custom model ID'}
  for _, case in ipairs(REASONS) do
    local field, action, reason, text = case[1], case[2], case[3], case[4]
    assert(provider.request(action))
    publish(base({host = NONE, model = NONE, keySaved = false, tail = NONE, result = {id = lastCommand().id, field = field, state = 'invalid', reason = reason}}))
    local rows = rowsOf(provider)
    assert(first(rows[LABEL[field]].help) == text, field .. '/' .. reason .. ': ' .. first(rows[LABEL[field]].help))
    assert(rows[LABEL[field]].label == NAME[field] .. ' (Not added)' and rows[LABEL[field]].value:find('^Paste'), rows[LABEL[field]].label)
    for other, id in pairs(LABEL) do
      if other ~= field then assert(rows[id].label == NAME[other] and first(rows[id].help) ~= text and not rows[id].help:find(text, 1, true), 'the message leaked to ' .. id) end
    end
  end
  -- The clipboard could not be read, the value could not be saved.
  assert(provider.request('paste-key'))
  publish(base({keySaved = false, tail = NONE, result = {id = lastCommand().id, field = 'key', state = 'unreadable'}}))
  assert(first(rowsOf(provider)['custom-key'].help) == 'The clipboard could not be read.')
  publish(base({keySaved = false, tail = NONE, result = {id = lastCommand().id, field = 'key', state = 'failed'}}))
  assert(first(rowsOf(provider)['custom-key'].help) == 'It could not be saved.')
  -- Saved and cleared are the row itself: no message, no Not added.
  for _, done in ipairs({'saved', 'cleared'}) do
    publish(base({result = {id = lastCommand().id, field = 'key', state = done}}))
    assert(rowsOf(provider)['custom-key'].label == 'Custom API key (…abcd)' and not rowsOf(provider)['custom-key'].help:find('clipboard', 1, true))
  end
  -- An answer for an older command id is ignored.
  assert(provider.request('paste-url'))
  local old = lastCommand().id
  assert(provider.request('paste-model'))
  publish(base({host = NONE, model = NONE, result = {id = old, field = 'url', state = 'invalid', reason = 'not-a-url'}}))
  assert(rowsOf(provider)['custom-url'].label == 'Custom endpoint URL' and provider.state().result == nil, 'an old answer was shown')
  publish(base({host = NONE, model = NONE, result = {id = 'sess-1:cust:999', field = 'model', state = 'invalid', reason = 'empty'}}))
  assert(provider.state().result == nil)
  -- The right id, but for another row than the command changed: not shown.
  publish(base({host = NONE, model = NONE, result = {id = lastCommand().id, field = 'url', state = 'invalid', reason = 'empty'}}))
  assert(provider.state().result == nil)
  -- The right id and field with a state or reason that is not one of the contract's: no state, no reason.
  publish(base({host = NONE, model = NONE, result = {id = lastCommand().id, field = 'model', state = 'exploded'}}))
  assert(provider.state().result == nil)
  publish(base({host = NONE, model = NONE, result = {id = lastCommand().id, field = 'model', state = 'invalid', reason = 'secret-reason'}}))
  assert(provider.state().result.reason == nil and first(rowsOf(provider)['custom-model'].help) == 'That was not accepted.')
  -- A test command has no paste result: nothing from "result" shows for it.
  assert(provider.request('test'))
  publish(base({result = {id = lastCommand().id, field = 'url', state = 'invalid', reason = 'empty'}}))
  assert(provider.state().result == nil)
`));

test('the key row says to paste the key again after an address on another host was saved, until a key is saved', () => run(`${moduleFixture}
  local provider = make()
  publish(base({keySaved = false, tail = NONE, keyForgotten = true}))
  local row = rowsOf(provider)['custom-key']
  assert(row.label == 'Custom API key (Not added)' and row.value == 'Paste API key' and row.action == 'paste-key', row.label)
  assert(first(row.help) == 'New address saved. Paste your API key again for it.', first(row.help))
  assert(provider.state().keyForgotten == true)
  -- A saved key ends it: the service stops sending the flag, and a stale one is not trusted.
  publish(base({keyForgotten = true}))
  assert(provider.state().keyForgotten == false and not rowsOf(provider)['custom-key'].help:find('New address saved', 1, true))
  -- Only true counts.
  for _, bad in ipairs({false, 'yes', 1, {}}) do
    publish(base({keySaved = false, tail = NONE, keyForgotten = bad}))
    assert(provider.state().keyForgotten == false and rowsOf(provider)['custom-key'].label == 'Custom API key', tostring(bad))
  end
  -- It changes what the page shows, so the redraw check changes too.
  publish(base({keySaved = false, tail = NONE}))
  local quiet = provider.signature()
  publish(base({keySaved = false, tail = NONE, keyForgotten = true}))
  assert(provider.signature() ~= quiet)
`));

test('the Test row: testing, ok, and a plain sentence for every failure code with the provider’s own words after it', () => run(`${moduleFixture}
  local provider = make()
  publish(base())
  local ok, message = provider.request('test')
  assert(ok == true and message == 'Testing the connection…', tostring(message))
  local id = lastCommand().id
  publish(base({test = {id = id, state = 'testing'}}))
  local row = rowsOf(provider)['custom-test']
  assert(row.label == 'Test connection (Testing…)' and row.enabled == false and first(row.help) == 'Waiting for the endpoint to answer…', row.label .. ' | ' .. row.help)
  publish(base({test = {id = id, state = 'ok', ms = 842}}))
  row = rowsOf(provider)['custom-test']
  assert(row.label == 'Test connection (OK)' and row.enabled == true, row.label)
  assert(first(row.help) == 'The connection works. The endpoint accepted your model and key. It answered in 842 ms.', first(row.help))
  publish(base({test = {id = id, state = 'ok'}}))
  assert(first(rowsOf(provider)['custom-test'].help) == 'The connection works. The endpoint accepted your model and key.')
  local SENTENCES = {
    ['no-setup'] = 'Add an endpoint URL and a model ID first.',
    ['no-key'] = 'No API key is saved yet. Copy your key from your provider, press Paste API key, then test again.',
    key = 'The endpoint did not accept your API key.',
    credits = 'The account is out of credits. Add credits with your provider.',
    model = 'The endpoint does not know that model ID.',
    limit = 'The endpoint is rate limiting you. Try again in a moment.',
    daily = 'The free daily limit for this model was reached. Try again after it resets.',
    reasoning = 'This model spends its reply on thinking. Choose a non-reasoning model in Settings.',
    unreachable = 'The endpoint did not answer. Check its address.',
    timeout = 'The endpoint took too long to answer.',
    server = 'The endpoint reported an error on its side. Try again in a moment.',
    empty = 'The endpoint answered with no text. Check the model ID.',
    request = 'The endpoint refused the request. Check the model ID and the address.',
    redirect = 'The address sends you somewhere else. Use the final address from your provider.',
    webpage = 'That address is a web page, not the API. Use the API address from your provider.',
    ['webpage-openrouter'] = 'That address is a web page, not the API. For OpenRouter use https://openrouter.ai/api/v1.',
  }
  for code, sentence in pairs(SENTENCES) do
    publish(base({test = {id = id, state = 'failed', code = code, status = 400}}))
    row = rowsOf(provider)['custom-test']
    assert(row.label == 'Test connection (Failed)' and row.enabled == true, code)
    assert(first(row.help) == sentence, code .. ': ' .. first(row.help))
    assert(not row.help:find('The provider said', 1, true), 'no detail, no provider paragraph')
    publish(base({test = {id = id, state = 'failed', code = code, detail = 'Insufficient credits. Add more at example.com/credits'}}))
    row = rowsOf(provider)['custom-test']
    local list = {}
    for paragraph in (row.help .. '\\n\\n'):gmatch('(.-)\\n\\n') do list[#list + 1] = paragraph end
    assert(list[1] == sentence and list[2] == 'The provider said: Insufficient credits. Add more at example.com/credits', code .. ': ' .. row.help)
  end
  -- The wait the provider asked for is named when it is given.
  publish(base({test = {id = id, state = 'failed', code = 'limit', waitS = 12}}))
  assert(first(rowsOf(provider)['custom-test'].help) == 'The endpoint is rate limiting you. Wait about 12 seconds, then try again.')
  publish(base({test = {id = id, state = 'failed', code = 'limit', waitS = 0.4}}))
  assert(first(rowsOf(provider)['custom-test'].help):find('about 1 seconds', 1, true))
  for _, wait in ipairs({0, -3, 1e9, 'soon', 0/0}) do
    publish(base({test = {id = id, state = 'failed', code = 'limit', waitS = wait}}))
    assert(first(rowsOf(provider)['custom-test'].help) == SENTENCES.limit, tostring(wait))
  end
  -- A daily limit says when it resets, on the computer's clock ("HH:MM", from the service), when it is given; anything else reads as not given.
  publish(base({test = {id = id, state = 'failed', code = 'daily', status = 429, resetTime = '02:30'}}))
  assert(first(rowsOf(provider)['custom-test'].help) == 'The free daily limit for this model was reached. It resets at 02:30.', first(rowsOf(provider)['custom-test'].help))
  assert(provider.state().test.resetTime == '02:30')
  for _, bad in ipairs({'soon', '2:30', '02:30:00', '', 7, true, {}}) do
    publish(base({test = {id = id, state = 'failed', code = 'daily', resetTime = bad}}))
    assert(first(rowsOf(provider)['custom-test'].help) == SENTENCES.daily and provider.state().test.resetTime == nil, tostring(bad))
  end
  -- A code that is not the contract's still reads as a failure, with a sentence that names no cause.
  for _, code in ipairs({'weird', 7, true}) do
    publish(base({test = {id = id, state = 'failed', code = code}}))
    assert(first(rowsOf(provider)['custom-test'].help) == 'The connection test failed.', tostring(code))
  end
  -- The provider's words: one line, no control characters, at most 160 bytes, never a half character.
  publish(base({test = {id = id, state = 'failed', code = 'server', detail = '  Line one\\nline two\\ttabbed\\0nul   and   spaces  '}}))
  assert(rowsOf(provider)['custom-test'].help:find('The provider said: Line one line two tabbed nul and spaces', 1, true))
  publish(base({test = {id = id, state = 'failed', code = 'server', detail = string.rep('\\195\\169', 100)}}))
  local detail = provider.state().test.detail
  assert(#detail <= 160 and #detail % 2 == 0 and detail:match('^[\\195\\169]+$'), #detail)
  publish(base({test = {id = id, state = 'failed', code = 'server', detail = string.rep('x', 400)}}))
  assert(#provider.state().test.detail == 160)
  for _, bad in ipairs({'', '   ', 7, true, {}}) do
    publish(base({test = {id = id, state = 'failed', code = 'server', detail = bad}}))
    assert(provider.state().test.detail == nil, tostring(bad))
  end
  -- A state that is not testing, ok or failed shows nothing.
  publish(base({test = {id = id, state = 'maybe'}}))
  assert(provider.state().test == nil and rowsOf(provider)['custom-test'].label == 'Test connection')
`));

test('a result is only for the latest command: an older test id, a test after another command, and a test the service never finished are not claimed', () => run(`${moduleFixture}
  local provider = make()
  publish(base())
  assert(provider.request('test')); local first = lastCommand().id
  assert(provider.request('test')); local second = lastCommand().id
  assert(first ~= second)
  publish(base({test = {id = first, state = 'ok'}}))
  assert(provider.state().test == nil and rowsOf(provider)['custom-test'].label == 'Test connection', 'the older test answered')
  publish(base({test = {id = second, state = 'ok'}}))
  assert(provider.state().test.state == 'ok')
  -- Another command (a paste) changes the settings: the test's answer is old now.
  assert(provider.request('paste-model'))
  publish(base({test = {id = second, state = 'ok'}}))
  assert(provider.state().test == nil)
  -- No command sent in this session: an answer left in the file from an earlier session is never shown.
  local fresh = make()
  publish(base({test = {id = 'other-session:cust:1', state = 'ok'}, result = {id = 'other-session:cust:1', field = 'url', state = 'invalid', reason = 'empty'}}))
  assert(fresh.state().test == nil and fresh.state().result == nil)
  -- A test that is still "testing" after its longest real run (the service stopped, the game was reloaded under it) is dropped, so Test can be
  -- pressed again; a 90 s test of a server on this computer is still shown as running.
  assert(provider.request('test')); local running = lastCommand().id
  publish(base({test = {id = running, state = 'testing'}}))
  assert(provider.state().test.state == 'testing' and rowsOf(provider)['custom-test'].enabled == false)
  clock = clock + 30; publish(base({test = {id = running, state = 'testing'}}))
  assert(provider.state().test and provider.state().test.state == 'testing')
  clock = clock + 60; publish(base({test = {id = running, state = 'testing'}}))
  assert(provider.state().test and provider.state().test.state == 'testing', 'a 90 s test is still running')
  clock = clock + 110; publish(base({test = {id = running, state = 'testing'}}))
  assert(provider.state().test == nil and rowsOf(provider)['custom-test'].enabled == true and rowsOf(provider)['custom-test'].label == 'Test connection')
  -- A finished answer is never aged out.
  publish(base({test = {id = running, state = 'ok'}}))
  assert(provider.state().test.state == 'ok')
`));

test('commands: the seven actions, one file each time, ids that are unique and well formed, and a failed write says so and changes nothing', () => run(`${moduleFixture}
  local provider = make()
  local ACTIONS = {'paste-url', 'paste-key', 'paste-model', 'clear-url', 'clear-key', 'clear-model', 'test'}
  local MESSAGES = {['paste-url'] = 'Checking…', ['paste-key'] = 'Checking…', ['paste-model'] = 'Checking…', ['clear-url'] = 'The endpoint URL was removed.',
    ['clear-key'] = 'Your key was removed.', ['clear-model'] = 'The model ID was removed.', test = 'Testing the connection…'}
  local seen = {}
  for round = 1, 3 do
    for index, action in ipairs(ACTIONS) do
      local ok, message = provider.request(action)
      assert(ok == true and message == MESSAGES[action], action .. ': ' .. tostring(message))
      local sent = lastCommand()
      assert(sent.version == 1 and sent.action == action and type(sent.issuedAt) == 'number' and sent.issuedAt == os.time() * 1000.0)
      assert(#sent.id <= 160 and sent.id:match('^[A-Za-z0-9][A-Za-z0-9_.:%-]*$'), sent.id)
      assert(sent.id == 'sess-1:cust:' .. ((round - 1) * #ACTIONS + index), sent.id)
      assert(not seen[sent.id], 'a repeated id'); seen[sent.id] = true
      assert(provider.lastCommand().id == sent.id and provider.lastCommand().action == action)
    end
  end
  assert(#written == 21)
  -- Anything that is not one of the seven writes nothing.
  local count = #written
  for _, bad in ipairs({'', 'paste', 'clear', 'paste-keys', 7, true, {}, 'TEST'}) do
    local ok, message = provider.request(bad)
    assert(ok == false and message == 'The request could not be sent. Try again.', tostring(bad))
  end
  assert(#written == count)
  -- A write that fails: false and a sentence; the latest command and its answer stay as they were.
  assert(provider.request('paste-url')); local before = provider.lastCommand().id
  publish(base({host = NONE, result = {id = before, field = 'url', state = 'invalid', reason = 'empty'}}))
  assert(provider.state().result.reason == 'empty')
  failWrite = true
  local ok, message = provider.request('test')
  assert(ok == false and message == 'The request could not be sent. Try again.', tostring(message))
  assert(provider.lastCommand().id == before and provider.state().result.reason == 'empty', 'a failed write replaced the latest command')
  failWrite = false
  -- A writer that raises counts as failed too.
  local raising = make({writeCommand = function() error('disk full') end})
  ok, message = raising.request('test')
  assert(ok == false and message == 'The request could not be sent. Try again.')
  assert(raising.lastCommand() == nil)
  -- The session id comes from the manager: anything that is not a plausible id is replaced by one of the module's own that is.
  for _, session in ipairs({'', '../x', 'a b', string.rep('s', 200), 7, true, {}}) do
    local custom = make({session = function() return session end})
    assert(custom.request('paste-key'))
    local id = lastCommand().id
    assert(#id <= 160 and id:match('^[A-Za-z0-9][A-Za-z0-9_.:%-]*$') and id:find(':cust:1', 1, true), tostring(session) .. ' -> ' .. id)
  end
  local noSession = make({session = function() error('no session') end})
  assert(noSession.request('paste-key') and lastCommand().id:match('^[A-Za-z0-9][A-Za-z0-9_.:%-]*:cust:1$'))
  -- Two providers in one session (a reload of the module) never reuse an id of the same session... they differ by their counter start only
  -- when the session id differs; the manager's id is per game session, so a new module instance keeps counting its own commands.
  local a, b = make(), make({session = function() return 'sess-2' end})
  assert(a.request('test')); local idA = lastCommand().id
  assert(b.request('test')); local idB = lastCommand().id
  assert(idA ~= idB)
`));

test('the state file is read on demand, at most every 1.5 s, and at once after a command', () => run(`${moduleFixture}
  local provider = make()
  publish(base()); reads = 0
  for _ = 1, 50 do provider.state(); provider.rows(); provider.signature() end
  assert(reads == 1, 'reads: ' .. reads)
  clock = clock + 1.4; provider.state(); assert(reads == 1)
  clock = clock + 0.2; provider.state(); assert(reads == 2, 'reads: ' .. reads)
  provider.state(true); assert(reads == 3, 'a forced read: ' .. reads)
  assert(provider.request('paste-url')); provider.state(); assert(reads == 4, 'a command is answered by a fresh read: ' .. reads)
  -- The clock going backwards (a restarted game clock) reads again instead of waiting for ever.
  clock = clock - 500; provider.state(); assert(reads == 5)
  -- Nothing is read at all until a page asks: building the module reads nothing.
  reads = 0; local another = make(); assert(reads == 0)
`));

test('the signature changes exactly when something a row shows changes', () => run(`${moduleFixture}
  local provider = make()
  publish(base())
  local a = provider.signature()
  publish(base()); assert(provider.signature() == a, 'same state, same signature')
  publish(base({updated = 99})); assert(provider.signature() == a, 'the update time is not shown')
  for _, change in ipairs({{host = 'other.example'}, {model = 'llama3.2'}, {keySaved = false}, {tail = 'wxyz'}, {limit = 'rate'}, {secure = false}, {ready = false}, {version = 2}}) do
    publish(base(change)); assert(provider.signature() ~= a, next(change))
  end
  assert(provider.request('test')); local id = lastCommand().id
  publish(base()); local before = provider.signature()
  publish(base({test = {id = id, state = 'testing'}})); local testing = provider.signature()
  publish(base({test = {id = id, state = 'ok'}})); local ok = provider.signature()
  publish(base({test = {id = id, state = 'failed', code = 'key'}})); local failed = provider.signature()
  publish(base({test = {id = id, state = 'failed', code = 'key', detail = 'x'}})); local detailed = provider.signature()
  local all = {before, testing, ok, failed, detailed}
  for i = 1, #all do for j = i + 1, #all do assert(all[i] ~= all[j], i .. ' = ' .. j) end end
`));

test('the default reader and writer: a byte-order mark, a damaged file and a missing file; the command goes in place over its file', () => run(`
  local ui = convaiUiLocale
  local factory = (function() ${customSource} end)()
  local files, opened = {}, {}
  io = {open = function(path, mode)
    opened[#opened + 1] = path .. ':' .. mode
    if mode == 'rb' then
      if files[path] == nil then return nil end
      return {read = function() return files[path] end, close = function() return true end}
    end
    return {write = function(_, value) files[path] = value; return true end, close = function() return true end}
  end}
  json = {decode = function(raw) if raw == 'GOOD' then return {version = 1, ready = true, host = 'a.example', model = 'm', keySaved = false} end error('bad json') end,
    encode = function(value) return 'ENCODED:' .. value.action .. ':' .. value.id end}
  local clock = 10
  local provider = factory.new({ui = ui, clock = function() return clock end, session = function() return 'sess' end})
  assert(provider.state().available == false, 'no file')
  files['runtime/custom-provider-state.json'] = '\\239\\187\\191GOOD'; clock = clock + 2
  assert(provider.state().available == true and provider.state().host == 'a.example', 'a byte-order mark is skipped')
  files['runtime/custom-provider-state.json'] = '{broken'; clock = clock + 2
  assert(provider.state().available == false, 'a damaged file is no file')
  files['runtime/custom-provider-state.json'] = 12; clock = clock + 2
  assert(provider.state().available == false)
  assert(provider.request('test') == true)
  assert(files['runtime/custom-provider-command.json'] == 'ENCODED:test:sess:cust:1', tostring(files['runtime/custom-provider-command.json']))
  assert(opened[#opened] == 'runtime/custom-provider-command.json:wb')
  -- No json codec at all (a broken environment): the write fails with a sentence instead of an error.
  json = nil
  local ok, message = provider.request('test')
  assert(ok == false and message == 'The request could not be sent. Try again.')
  -- No io at all: the same.
  io = nil
  ok, message = provider.request('test')
  assert(ok == false and message == 'The request could not be sent. Try again.')
`));

// The failures of a turn V asked for: the notices a reply's error code selects (the other two are one-time notices on a first reply).
const FAILED_TURN = ['custom-key', 'custom-credits', 'custom-model', 'custom-limit', 'custom-daily', 'custom-reasoning', 'custom-unreachable'];
// Google Gemini's seven failures of a turn (their own sentences; the daily one ends "It resets at {time}." when the service sent a time).
const GEMINI_FAILED_TURN = Object.keys(GEMINI_NOTICES);

test('the notices: nine ids with the contract’s sentences, the same ones the game and Phone Chat show', () => {
  const ids = Object.keys(NOTICES);
  run(`${moduleFixture}
    local provider = make()
    assert(#factory.NOTICE_IDS == 9)
    local expected = {${ids.map(id => `['${id}'] = ${JSON.stringify(NOTICES[id])}`).join(', ')}}
    local expected_daily = expected['custom-daily']
    for _, id in ipairs(factory.NOTICE_IDS) do
      assert(provider.notice(id) == expected[id], id)
      expected[id] = nil
    end
    assert(next(expected) == nil, 'a notice id is missing from NOTICE_IDS')
    assert(provider.notice('mistral-key') == nil and provider.notice('') == nil and provider.notice(nil) == nil and provider.notice(7) == nil)
    assert(provider.noteFor('rate') == 'Custom: rate limited for now' and provider.noteFor('invalid') == 'Custom: key not accepted'
      and provider.noteFor('model') == 'Custom: model unavailable' and provider.noteFor('credits') == 'Custom: out of credits'
      and provider.noteFor('daily') == 'Custom: free daily limit reached')
    -- The daily limit's notice names the reset time when it is given (the service sends "HH:MM"), and says nothing of time otherwise.
    assert(provider.notice('custom-daily', '02:30') == 'The free daily limit for this model was reached. It resets at 02:30.')
    for _, bad in ipairs({'', 'soon', '2:30', 7, true, {}}) do assert(provider.notice('custom-daily', bad) == expected_daily, tostring(bad)) end
    for _, other in ipairs({'sometimes', '', 7, true, {}}) do assert(provider.noteFor(other) == nil, tostring(other)) end
    assert(provider.noteFor(nil) == nil)
    assert(provider.notSetUpNote() == 'Convai: the custom provider is not set up yet')
  `);
  // Game notices (init.lua), Phone Chat statuses, the catalogue of notices and the document agree with the module.
  const init = initSource.replace(/\r\n/g, '\n');
  const fromInit = Object.fromEntries([...init.matchAll(/return '(custom-[a-z-]+)', ui\.t\('((?:[^'\\]|\\.)*)'\)/g)].map(m => [m[1], m[2]]));
  assert.deepEqual(fromInit, NOTICES, 'init.lua words the notices differently from the module');
  const chat = read('phone-chat.lua').replace(/\r\n/g, '\n');
  const statuses = Object.fromEntries([...chat.matchAll(/\['(custom-[a-z-]+)'\] = '((?:[^'\\]|\\.)*)',/g)].map(m => [m[1], m[2]]));
  for (const id of FAILED_TURN) assert.equal(statuses[id], NOTICES[id], id);
  assert.deepEqual(Object.keys(statuses).sort(), [...FAILED_TURN].sort(), 'Phone Chat has no status for the one-time notices');
  const geminiStatuses = Object.fromEntries([...chat.matchAll(/\['(gemini-[a-z-]+)'\] = '((?:[^'\\]|\\.)*)',/g)].map(m => [m[1], m[2]]));
  assert.deepEqual(geminiStatuses, GEMINI_NOTICES, 'Phone Chat words the Gemini failures differently');
  const fromInitGemini = Object.fromEntries([...init.matchAll(/return '(gemini-[a-z-]+)', ui\.t\('((?:[^'\\]|\\.)*)'\)/g)].map(m => [m[1], m[2]]));
  delete fromInitGemini['gemini-no-key']; delete fromInitGemini['gemini-voice'];   // the one-time notices
  assert.deepEqual(fromInitGemini, GEMINI_NOTICES, 'init.lua words the Gemini failures differently from the module');
  const style = read('phone-chat-style.lua');
  for (const id of FAILED_TURN) assert(style.includes(`['${NOTICES[id]}'] = true`), `phone-chat-style.lua does not translate ${id}`);
  for (const id of GEMINI_FAILED_TURN) assert(style.includes(`['${GEMINI_NOTICES[id]}'] = true`), `phone-chat-style.lua does not translate ${id}`);
  const catalogue = read('notices.lua');
  const REPEAT = {'custom-key': 60, 'custom-credits': 60, 'custom-model': 60, 'custom-limit': 60, 'custom-daily': 60, 'custom-reasoning': 60, 'custom-unreachable': 60, 'custom-no-setup': 86400, 'custom-voice': 86400};
  for (const [id, seconds] of Object.entries(REPEAT)) {
    assert(new RegExp(`\\['${id}'\\] = \\{class = PLAYER, repeatS = ${seconds}\\}`).test(catalogue), `${id}: class or window`);
    assert(readFileSync(new URL('../docs/NOTIFICATIONS.md', import.meta.url), 'utf8').includes(`| \`${id}\` | Player | ${NOTICES[id]} |`), `${id}: not in docs/NOTIFICATIONS.md`);
  }
  const GEMINI_REPEAT = Object.fromEntries(GEMINI_FAILED_TURN.map(id => [id, 60]));
  for (const [id, seconds] of Object.entries(GEMINI_REPEAT)) {
    assert(new RegExp(`\\['${id}'\\] = \\{class = PLAYER, repeatS = ${seconds}\\}`).test(catalogue), `${id}: class or window`);
    assert(readFileSync(new URL('../docs/NOTIFICATIONS.md', import.meta.url), 'utf8').includes(`| \`${id}\` | Player | ${GEMINI_NOTICES[id]} |`), `${id}: not in docs/NOTIFICATIONS.md`);
  }
  // The same mapping as Mistral's: a failed turn V asked for shows the notice, an automatic reaction (battle, loot) just stops.
  for (const id of [...FAILED_TURN, ...GEMINI_FAILED_TURN]) {
    assert(new RegExp(`keyId == '${id}' then\\s+if not pending\\.reaction then convaiNotices\\.send\\(player, '${id}', keyText\\) end`).test(init), `${id}: not skipped for an automatic reaction`);
  }
});

test('the reply notices of init.lua: seven failed-turn codes and two one-time notices, sent through the gate under their own ids', () => {
  const init = initSource.replace(/\r\n/g, '\n');
  const start = init.indexOf('local function keyNoticeText'), end = init.indexOf('local function reactionCanDeliver');
  assert(start > 0 && end > start, 'the key notice functions moved');
  run(`
    local ui = {t = function(text, params) if params then text = text:gsub('{(%w+)}', function(key) return tostring(params[key]) end) end return text end}
    local sent = {}
    convaiNotices = {send = function(_, id, text) sent[#sent + 1] = id .. '=' .. text; return true end}
    ${init.slice(start, end)}
    local function notice(reply) local id, text = keyReplyNotice(reply); return id, text end
    local expected = {${Object.keys(NOTICES).map(id => `['${id}'] = ${JSON.stringify(NOTICES[id])}`).join(', ')}}
    for _, code in ipairs({${FAILED_TURN.map(id => JSON.stringify(id).replace(/"/g, "'")).join(', ')}}) do
      local id, text = notice({errorCode = code, error = 'x'})
      assert(id == code and text == expected[code], code .. ': ' .. tostring(text))
      -- A failed turn carries no key notice of the same name, and a first reply carries no error code of it.
      assert(notice({keyNotice = code, text = 'Hello'}) == nil, code .. ' as a key notice')
    end
    -- Google Gemini's seven failures have their own sentences; the daily one names the reset time when the service sent one.
    local geminiExpected = {${GEMINI_FAILED_TURN.map(id => `['${id}'] = ${JSON.stringify(GEMINI_NOTICES[id])}`).join(', ')}}
    for code, expectedText in pairs(geminiExpected) do
      local id, text = notice({errorCode = code, error = 'x'})
      assert(id == code and text == expectedText, code .. ': ' .. tostring(text))
      assert(notice({keyNotice = code, text = 'Hello'}) == nil, code .. ' as a key notice')
    end
    local gid, gtext = notice({errorCode = 'gemini-daily', errorResetTime = '02:30', error = 'x'})
    assert(gid == 'gemini-daily' and gtext == 'Your free Gemini allowance for today is used up. It resets at 02:30. Use Convai or Local AI.', tostring(gtext))
    for _, bad in ipairs({'', 'soon', '2:30', 7, true, {}}) do
      local _, bt = notice({errorCode = 'gemini-daily', errorResetTime = bad, error = 'x'})
      assert(bt == geminiExpected['gemini-daily'], tostring(bad))
    end
    -- The daily limit says when it resets, on this computer's clock, when the service sent a time ("HH:MM"); anything else is the sentence without one.
    local id, text = notice({errorCode = 'custom-daily', errorResetTime = '02:30', error = 'x'})
    assert(id == 'custom-daily' and text == 'The free daily limit for this model was reached. It resets at 02:30.', tostring(text))
    for _, bad in ipairs({'', 'soon', '2:30', '02:30:10', 7, true, {}}) do
      local id2, text2 = notice({errorCode = 'custom-daily', errorResetTime = bad, error = 'x'})
      assert(id2 == 'custom-daily' and text2 == expected['custom-daily'], tostring(bad))
    end
    for _, code in ipairs({'custom-no-setup', 'custom-voice'}) do
      local id, text = notice({keyNotice = code, text = 'Hello'})
      assert(id == code and text == expected[code], code .. ': ' .. tostring(text))
      assert(notice({errorCode = code, error = 'x'}) == nil, code .. ' as an error code')
    end
    -- Nothing changes for an ordinary reply or another provider's codes.
    assert(notice({text = 'Hello'}) == nil and notice({errorCode = 'custom-other', error = 'x'}) == nil and notice({errorCode = 'custom', error = 'x'}) == nil)
    local id = notice({errorCode = 'mistral-key', error = 'x'}); assert(id == 'mistral-key')
    sendProviderNotice({}, 'custom-no-setup', 'a'); sendProviderNotice({}, 'custom-voice', 'b'); sendProviderNotice({}, 'custom-key', 'c')
    assert(#sent == 2 and sent[1] == 'custom-no-setup=a' and sent[2] == 'custom-voice=b', table.concat(sent, ';'))
  `);
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Inside the real manager.lua, manager-ui.lua and nsui.lua
// ---------------------------------------------------------------------------------------------------------------------------------

// withCustom: whether the module can be loaded (false: its file is absent, as in an install that lost it); `custom` replaces the module
// source, for a module that misbehaves. The harness is the shared one (bridge/manager-fixture.mjs).
const pageFixture = (withCustom = true, custom = customSource) => nsuiHarness({
  modules: withCustom ? {'custom-provider.lua': custom} : {},
  absent: withCustom ? [] : ['custom-provider.lua'],
}) + `
  convaiNotices.configure(function() return manager.developerMode() end)
  local function providerIds()
    local order = {}
    for _, category in ipairs(loaded.categories) do
      if category.id == 'conversation-provider' then for _, item in ipairs(category.settings) do order[#order + 1] = item.id end end
    end
    return table.concat(order, ',')
  end
  local function paragraphs(text) local list = {}; for part in (text .. '\\n\\n'):gmatch('(.-)\\n\\n') do list[#list + 1] = part end; return list end
  local function firstParagraph(text) return paragraphs(text)[1] end
  local function lastParagraph(text) local list = paragraphs(text); return list[#list] end
`;

const stateFixture = `
  local clock = 1000
  os.clock = function() return clock end
  os.time = function() return clock end
  local function file(path, tag, value) jsonFixtures[tag] = value; files[path] = tag end
  -- The conversation service publishes its state; the page reads it at most every 1.5 s, so each publish moves the clock on.
  local function service(tag, value) file('runtime/custom-provider-state.json', 'custom-' .. tag, value); clock = clock + 2; manager.snapshot(player); loaded = registered.loadMod('manager') end
  local function bridge(tag, value) file('runtime/mistral-state.json', 'mistral-' .. tag, value); clock = clock + 2; manager.snapshot(player); loaded = registered.loadMod('manager') end
  local function command() return jsonFixtures[files['runtime/custom-provider-command.json']] end
`;

test('the selector has five entries, Custom (OpenAI-compatible) fifth; one Custom endpoint button sits right under the Google Gemini key row and opens a page with the four rows', () => run(`${pageFixture()}${stateFixture}
  assert(invoke('tab:settings').ok)
  local provider = row('conversationProvider')
  assert(provider.type == 'select' and #provider.elements == 5 and provider.elements[1] == 'Convai free tier' and provider.elements[2] == 'Convai API key'
    and provider.elements[3] == 'Google Gemini (free plan)' and provider.elements[4] == 'Local AI' and provider.elements[5] == 'Custom (OpenAI-compatible)')
  assert(provider.value == 1 and provider.defaultValue == 1)
  assert(providerIds() == 'conversationProvider,matureContent,localModel,localOffload,gemini-key,custom-endpoint,own-key', providerIds())
  for _, id in ipairs({'custom-url', 'custom-key', 'custom-model', 'custom-test'}) do assert(row(id) == nil, id .. ' is not on the Settings page any more') end
  assert(row('custom-endpoint').type == 'action' and row('custom-endpoint').value == 'Open' and row('custom-endpoint').label == 'Custom endpoint')
  assert(not (row('custom-endpoint').description .. row('custom-endpoint').label):lower():find('recommend', 1, true))
  -- The page: a way back first, then the four rows, and the way back returns to the AI provider page.
  assert(invoke('custom-endpoint').ok and managerUi.inspect().view == 'custom-endpoint')
  assert(loaded.categories[1].settings[1].id == 'custom-endpoint:back' and loaded.categories[1].settings[1].label == 'Back to settings')
  local pageIds = {}
  for _, category in ipairs(loaded.categories) do
    if category.id == 'custom-endpoint' then for _, item in ipairs(category.settings) do pageIds[#pageIds + 1] = item.id end end
  end
  assert(table.concat(pageIds, ',') == 'custom-preset-mistral,custom-url,custom-key,custom-model,custom-test', table.concat(pageIds, ','))
  for _, id in ipairs({'custom-preset-mistral', 'custom-url', 'custom-key', 'custom-model', 'custom-test'}) do
    assert(row(id).type == 'action', id)
    assert(not (row(id).description .. row(id).label .. row(id).value):lower():find('recommend', 1, true), id)
  end
  assert(row('custom-url').label == 'Custom endpoint URL' and row('custom-url').value == 'Paste endpoint URL')
  assert(row('custom-test').disabled == true, 'no state file: the test cannot run')
  assert(invoke('custom-endpoint:back').ok and managerUi.inspect().view == 'settings-provider' and row('custom-endpoint') and not row('custom-url'))
  -- The help of the provider row names Custom only where it would otherwise be wrong (the description area holds only so much): Custom too
  -- replaces Convai's cloud voice with a local one (2026-10-20 settings audit; bridge/description-fit.test.mjs keeps it within the area).
  local _, customs = provider.description:gsub('Custom', '')
  assert(customs == 1 and provider.description:find('With Google Gemini, Local AI or Custom, Convai’s cloud voice', 1, true), provider.description)
  -- The existing elements keep their numbers.
  for _, case in ipairs({{1, 'convai', false}, {2, 'convai', true}, {3, 'gemini'}, {4, 'local'}, {5, 'custom'}}) do
    assert(registered.applyBatch('manager', {{id = 'conversationProvider', value = case[1]}}).ok, tostring(case[1]))
    assert(manager.snapshot(player).settings.conversationProvider == case[2], tostring(case[1]))
    if case[3] ~= nil then assert(manager.snapshot(player).settings.useOwnConvaiKey == case[3]) end
    loaded = registered.loadMod('manager')
    assert(row('conversationProvider').value == case[1], 'the saved choice reads back as entry ' .. case[1])
  end
  assert(saved.conversationProvider == 'custom')
  assert(not registered.applyBatch('manager', {{id = 'conversationProvider', value = 6}}).ok)
  assert(manager.snapshot(player).settings.conversationProvider == 'custom', 'a refused value changes nothing')
`));

test('without the module file (or with a module that fails) the page still shows every other row and the fifth entry, and no Custom endpoint button', () => {
  run(`${pageFixture(false)}${stateFixture}
    assert(invoke('tab:settings').ok)
    assert(#row('conversationProvider').elements == 5)
    assert(providerIds() == 'conversationProvider,matureContent,localModel,localOffload,own-key', providerIds())
    assert(row('custom-endpoint') == nil and not invoke('custom-endpoint').ok, 'the page is not offered without the module')
    assert(registered.applyBatch('manager', {{id = 'conversationProvider', value = 5}}).ok)
    -- No module, no custom notes: the provider row is the same as with no limit at all.
    local plain = row('conversationProvider').description
    bridge('a', {provider = 'custom', effective = 'custom', limit = 'rate'})
    assert(row('conversationProvider').description == plain)
    bridge('b', {provider = 'custom', effective = 'convai'})
    assert(row('conversationProvider').value == 5 and row('conversationProvider').description == plain)
  `);
  // A module whose rows raise: the page is built without them.
  const raising = customSource.replace('function self.rows()', 'function self.rows() error("boom") end\n    function self.unusedRows()');
  run(`${pageFixture(true, raising)}${stateFixture}
    assert(invoke('tab:settings').ok and invoke('settings:provider').ok)
    assert(providerIds() == 'conversationProvider,matureContent,localModel,localOffload,gemini-key,custom-endpoint,own-key', providerIds())
    assert(invoke('custom-endpoint').ok and managerUi.inspect().view == 'custom-endpoint')
    assert(row('custom-url') == nil and row('custom-test') == nil and row('custom-endpoint:back'), 'the page opens without rows, with its way back')
    assert(invoke('custom-endpoint:back').ok and managerUi.inspect().view == 'settings-provider')
  `);
  // A module that raises while it is made.
  const broken = customSource.replace('function M.new(options)', 'function M.new(options) error("no instance")');
  run(`${pageFixture(true, broken)}${stateFixture}
    assert(invoke('tab:settings').ok and invoke('settings:provider').ok)
    assert(providerIds() == 'conversationProvider,matureContent,localModel,localOffload,own-key', providerIds())
  `);
});

test('the rows send their commands on their own channel, in place, with ids of this game session; a failed write is refused with a sentence', () => run(`${pageFixture()}${stateFixture}
  files['runtime/custom-provider-command.json'] = ''
  assert(invoke('tab:settings').ok and invoke('settings:provider').ok and invoke('custom-endpoint').ok)
  local removed, renamed = {}, {}
  local remove, rename = os.remove, os.rename
  os.remove = function(path) removed[#removed + 1] = path; return remove(path) end
  os.rename = function(from, to) renamed[#renamed + 1] = from; return rename(from, to) end
  local ids, seen = {}, {}
  local function press(id, expected)
    local result = invoke(id)
    assert(result.ok, id .. ': ' .. tostring(result.error))
    local sent = command()
    assert(sent.version == 1 and sent.action == expected and type(sent.issuedAt) == 'number', id)
    assert(#sent.id <= 160 and sent.id:match('^[A-Za-z0-9][A-Za-z0-9_.:%-]*$') and sent.id:find(':cust:', 1, true), sent.id)
    assert(not seen[sent.id], 'an id was reused'); seen[sent.id] = true
    return sent
  end
  local url = press('custom-url', 'paste-url')
  press('custom-key', 'paste-key')
  press('custom-model', 'paste-model')
  -- The service answers: everything is saved. Then the same rows remove.
  service('saved', {version = 1, updated = 1, ready = true, host = 'openrouter.ai', secure = true, ['local'] = false, model = 'llama3.2', keySaved = true, tail = 'wxyz'})
  assert(row('custom-url').value == 'Remove' and row('custom-key').value == 'Remove' and row('custom-model').value == 'Remove' and row('custom-test').disabled == false)
  press('custom-url', 'clear-url'); press('custom-key', 'clear-key'); press('custom-model', 'clear-model'); press('custom-test', 'test')
  assert(files['runtime/memory-command.json'] == nil and files['runtime/mistral-key-command.json'] == nil and files['runtime/own-key-command.json'] == nil,
    'another channel was used')
  assert(#removed == 0 and #renamed == 0, 'a command file was removed or renamed')
  for _, write in ipairs(fileWrites) do
    if write.path:find('custom', 1, true) then assert(write.path == 'runtime/custom-provider-command.json', write.path) end
  end
  -- The session part is the manager's (the same one the memory commands carry).
  local session = url.id:match('^(.-):cust:1$')
  assert(session and #session == 36, tostring(session))
  -- A command that cannot be written is refused, with the page's usual sentence.
  failSave = true
  local result = invoke('custom-url')
  assert(result.ok == false and result.error == 'The request could not be sent. Try again.', tostring(result.error))
  failSave = false
`));

test('the page follows the service: answers show up, an unchanged state does not redraw, an old answer is never shown, a test runs to its end', () => run(`${pageFixture()}${stateFixture}
  assert(invoke('tab:settings').ok and invoke('settings:provider').ok and invoke('custom-endpoint').ok)
  -- The page is drawn again when what it shows changes: the calls into Native Settings UI say whether it was.
  local function pump(times)
    for _ = 1, times or 3 do clock = clock + 2; managerUi.update(player, false) end
    loaded = registered.loadMod('manager')
  end
  pump(3)
  ns.resetCalls()
  pump(4)
  assert(#ns.calls == 0, 'nothing changed, nothing was drawn again: ' .. #ns.calls)
  -- The service starts: its state appears, the page is drawn again with it.
  file('runtime/custom-provider-state.json', 'custom-a', {version = 1, updated = 1, ready = false, host = nil, secure = false, ['local'] = false, model = nil, keySaved = false})
  pump(3)
  assert(#ns.calls > 0 and row('custom-test').disabled == false, 'the service state did not reach the page')
  ns.resetCalls()
  pump(4)
  assert(#ns.calls == 0, 'a state that did not change redrew the page')
  -- Paste the URL: the service refuses it.
  assert(invoke('custom-url').ok)
  local id = command().id
  file('runtime/custom-provider-state.json', 'custom-b', {version = 1, updated = 2, ready = false, secure = false, ['local'] = false, keySaved = false,
    result = {id = id, field = 'url', state = 'invalid', reason = 'scheme'}})
  ns.resetCalls()
  pump(3)
  assert(#ns.calls > 0)
  assert(row('custom-url').label == 'Custom endpoint URL (Not added)' and firstParagraph(row('custom-url').description) == 'The address must start with https:// or http://.', row('custom-url').label)
  -- Saved: the row now says the host, with Remove.
  assert(invoke('custom-url').ok); id = command().id
  file('runtime/custom-provider-state.json', 'custom-c', {version = 1, updated = 3, ready = false, host = 'localhost:11434', secure = false, ['local'] = true, keySaved = false,
    result = {id = id, field = 'url', state = 'saved'}})
  pump(3)
  assert(row('custom-url').label == 'Custom endpoint URL (localhost:11434)' and row('custom-url').value == 'Remove')
  -- Test: running, then the answer.
  assert(invoke('custom-test').ok); id = command().id
  file('runtime/custom-provider-state.json', 'custom-d', {version = 1, updated = 4, ready = true, host = 'localhost:11434', secure = false, ['local'] = true, model = 'llama3.2', keySaved = false,
    test = {id = id, state = 'testing'}})
  pump(3)
  assert(row('custom-test').label == 'Test connection (Testing…)' and row('custom-test').disabled == true)
  file('runtime/custom-provider-state.json', 'custom-e', {version = 1, updated = 5, ready = true, host = 'localhost:11434', secure = false, ['local'] = true, model = 'llama3.2', keySaved = false,
    test = {id = id, state = 'failed', code = 'model', detail = 'model "llama3.2" not found, try pulling it first'}})
  pump(3)
  assert(row('custom-test').label == 'Test connection (Failed)' and row('custom-test').disabled == false)
  assert(firstParagraph(row('custom-test').description) == 'The endpoint does not know that model ID.')
  assert(row('custom-test').description:find('The provider said: model "llama3.2" not found, try pulling it first', 1, true))
  -- An answer for an older test id: not shown.
  file('runtime/custom-provider-state.json', 'custom-f', {version = 1, updated = 6, ready = true, host = 'localhost:11434', secure = false, ['local'] = true, model = 'llama3.2', keySaved = false,
    test = {id = 'old:cust:1', state = 'ok'}})
  pump(3)
  assert(row('custom-test').label == 'Test connection' and row('custom-test').disabled == false)
`));

test('the provider row starts with the note of the custom provider: its limits, waiting, and "not set up" while Custom is chosen but Convai answers', () => run(`${pageFixture()}${stateFixture}
  assert(invoke('tab:settings').ok)
  local base = row('conversationProvider').description
  assert(registered.applyBatch('manager', {{id = 'conversationProvider', value = 5}}).ok)
  loaded = registered.loadMod('manager')
  -- Custom is chosen but the bridge has not applied it (or has no setup): Convai answers, and the note says why.
  bridge('fallback', {provider = 'custom', effective = 'convai'})
  assert(firstParagraph(row('conversationProvider').description) == 'Convai: the custom provider is not set up yet', firstParagraph(row('conversationProvider').description))
  -- Custom answers with a limit.
  for limit, text in pairs({rate = 'Custom: rate limited for now', daily = 'Custom: free daily limit reached', invalid = 'Custom: key not accepted', model = 'Custom: model unavailable', credits = 'Custom: out of credits'}) do
    bridge('limit-' .. limit, {provider = 'custom', effective = 'custom', limit = limit})
    assert(firstParagraph(row('conversationProvider').description) == text, limit .. ': ' .. firstParagraph(row('conversationProvider').description))
    assert(manager.mistral().provider == 'custom' and manager.mistral().effective == 'custom' and manager.mistral().limit == limit)
  end
  -- Custom answering with no problem needs no note; a limit that is not Custom's own says nothing either.
  bridge('fine', {provider = 'custom', effective = 'custom'})
  assert(row('conversationProvider').description == base)
  for _, limit in ipairs({'sometimes', 7}) do
    bridge('odd-' .. tostring(limit), {provider = 'custom', effective = 'custom', limit = limit})
    assert(row('conversationProvider').description == base, tostring(limit))
  end
  -- Waiting for the conversation to end comes first.
  bridge('pending', {provider = 'custom', effective = 'convai', pending = true})
  assert(firstParagraph(row('conversationProvider').description) == 'Waiting for the conversation to end')
  -- The other providers keep their notes; Convai selected with Custom in the state file adds nothing.
  assert(registered.applyBatch('manager', {{id = 'conversationProvider', value = 3}}).ok); loaded = registered.loadMod('manager')
  bridge('mistral-limit', {provider = 'mistral', effective = 'mistral', saved = true, limit = 'rate'})
  assert(firstParagraph(row('conversationProvider').description) == 'Mistral: limit reached for now')
  bridge('mistral-credits', {provider = 'mistral', effective = 'mistral', saved = true, limit = 'credits'})
  assert(row('conversationProvider').description == base, 'a credits limit is only a note for Custom')
  assert(registered.applyBatch('manager', {{id = 'conversationProvider', value = 1}}).ok); loaded = registered.loadMod('manager')
  bridge('convai', {provider = 'convai', effective = 'convai'})
  assert(not row('conversationProvider').description:find('custom', 1, true))
`));

test('manager settings: custom is a stored provider, survives a reload, is refused when misspelled, and keeps Mature content on (it works with Custom)', () => run(`${pageFixture()}${stateFixture}
  local function reload(values)
    seed = {version = 2, voice = true, subtitles = true, subtitleStyle = 'dialogue', voiceProvider = 'pocket', battleReactions = false, lootReactions = false, enabledByKey = {}}
    for key, value in pairs(values) do seed[key] = value end
    for _, profile in ipairs(profiles) do seed.enabledByKey[profile.key] = true end
    files['runtime/settings.json'], saved = 'seed', nil
    manager.configure(api, profiles); manager.prepare(player)
    return manager.snapshot(player).settings
  end
  assert(reload({conversationProvider = 'custom'}).conversationProvider == 'custom' and (saved == nil or saved.conversationProvider == 'custom'), 'a saved custom provider was changed')
  assert(reload({conversationProvider = 'Custom'}).conversationProvider == 'convai' and saved.conversationProvider == 'convai', 'a misspelt provider reads as Convai')
  assert(reload({conversationProvider = 'openai'}).conversationProvider == 'convai')
  -- Mature content stands beside Custom (since 2026-10-20), in a saved file and in Apply; Convai is the one it never stands beside.
  local settings = reload({conversationProvider = 'custom', matureContent = true})
  assert(settings.conversationProvider == 'custom' and settings.matureContent == true and saved.matureContent == true, 'a saved pairing of Custom and Mature content was dropped')
  assert(reload({conversationProvider = 'local', matureContent = true}).matureContent == true, 'Local keeps Mature content')
  assert(reload({conversationProvider = 'convai', matureContent = true}).matureContent == false, 'Convai does not')
  assert(manager.applySettings(player, {matureContent = true, conversationProvider = 'local'}) and saved.matureContent == true)
  local ok, _, _, reloaded = manager.applySettings(player, {conversationProvider = 'custom'})
  assert(ok and saved.conversationProvider == 'custom' and saved.matureContent == true and reloaded ~= true, 'choosing Custom turned Mature content off')
  assert(manager.applySettings(player, {matureContent = true, conversationProvider = 'custom'}) and saved.matureContent == true)
  assert(not manager.applySettings(player, {conversationProvider = 'customs'}) and manager.snapshot(player).settings.conversationProvider == 'custom')
  -- A way back that names Custom is kept; one that names something else is dropped.
  settings = reload({conversationProvider = 'local', matureContent = true, matureRestore = {conversationProvider = {before = 'custom', set = 'local'}}})
  assert(settings.matureRestore and settings.matureRestore.conversationProvider.before == 'custom' and settings.matureRestore.conversationProvider.set == 'local')
  settings = reload({conversationProvider = 'local', matureContent = true, matureRestore = {conversationProvider = {before = 'openai', set = 'local'}}})
  assert(settings.matureRestore == nil)
`));

test('the bridge status may name custom as the provider and credits as the limit; anything else still reads as Convai and no limit', () => run(`${pageFixture()}${stateFixture}
  for _, case in ipairs({{'custom', 'custom'}, {'mistral', 'mistral'}, {'local', 'local'}, {'convai', 'convai'}, {'Custom', 'convai'}, {'openai', 'convai'}, {7, 'convai'}, {true, 'convai'}}) do
    bridge('p' .. tostring(case[1]), {provider = case[1], effective = case[1]})
    assert(manager.mistral().provider == case[2] and manager.mistral().effective == case[2], tostring(case[1]))
  end
  for _, case in ipairs({{'credits', 'credits'}, {'rate', 'rate'}, {'daily', 'daily'}, {'invalid', 'invalid'}, {'model', 'model'}, {'nope', false}, {7, false}}) do
    bridge('l' .. tostring(case[1]), {provider = 'custom', effective = 'custom', limit = case[1]})
    assert((manager.mistral().limit or false) == case[2], tostring(case[1]))
  end
`));

test('the voice key waits for Convai with Custom exactly as with Mistral: only while Custom is in use and this computer cannot recognise speech', () => run(`${pageFixture()}${stateFixture}
  local function choose(index) assert(registered.applyBatch('manager', {{id = 'conversationProvider', value = index}}).ok) end
  bridge('a', {provider = 'custom', effective = 'custom', stt = false})
  assert(manager.voiceNeedsConvai() == false, 'the setting is still Convai')
  choose(5)
  assert(manager.voiceNeedsConvai() == true, 'Custom in use without local speech recognition')
  bridge('b', {provider = 'custom', effective = 'custom', stt = true})
  assert(manager.voiceNeedsConvai() == false, 'local speech recognition makes the voice key work')
  bridge('c', {provider = 'custom', effective = 'convai', stt = false})
  assert(manager.voiceNeedsConvai() == false, 'Custom is not set up: Convai answers, so the voice key works')
  bridge('d', {provider = 'custom', effective = 'custom'})
  assert(manager.voiceNeedsConvai() == true, 'a status without stt means no local speech recognition')
  choose(2)
  assert(manager.voiceNeedsConvai() == false)
`));

// Mature content turned on or off with Custom chosen: one change is applied with what Mature content needs (manager-ui.lua stageMature).
// Local AI is installed, with a standard model and an uncensored one; the companion voice is Pocket (a local voice).
const matureFixture = `
  local function apply(changes)
    clock = clock + 2
    local result = core.apply(changes)
    loaded = registered.loadMod('manager')
    return result
  end
  local function startFromCustom()
    bridge('ready', {provider = 'custom', effective = 'custom', localAi = 'ready',
      localModels = {{id = 'standard', name = 'Gemma', sizeMiB = 5000}, {id = 'mature:unc', name = 'Gemma uncensored', sizeMiB = 5200}, {id = 'lite', name = 'Qwen', sizeMiB = 1300}},
      localModelDefault = 'standard', localModelMatureDefault = 'mature:unc'})
    clock = clock + 20
    jsonFixtures['voice-state'] = {state = 'ready', provider = 'pocket', omniPack = {installed = true, missing = {}}, updated = clock * 1000}
    files['runtime/local-voice-state.json'] = 'voice-state'
    manager.snapshot(player)
    assert(invoke('tab:settings').ok)
    loaded = registered.loadMod('manager')
    assert(apply({{id = 'conversationProvider', value = 5}, {id = 'localModel', value = 2}, {id = 'voiceProvider', value = 1}}).ok)
    assert(saved.conversationProvider == 'custom' and saved.localModel == 'standard' and not saved.matureContent)
  end
`;

test('Mature content turned on while Custom is chosen just turns on: provider, model and voice stay and no way back is kept; turning it off changes nothing else', () => run(`${pageFixture()}${stateFixture}${matureFixture}
  startFromCustom()
  local result = apply({{id = 'matureContent', value = true}})
  assert(result.ok and #result.names == 0, table.concat(result.names, ','))
  assert(saved.matureContent == true and saved.conversationProvider == 'custom' and saved.localModel == 'standard' and saved.voiceProvider == 'pocket')
  assert(saved.matureRestore == nil, 'nothing was changed, so nothing is kept to put back')
  assert(row('conversationProvider').value == 5 and row('localModel').value == 2, 'the rows read what was saved')
  result = apply({{id = 'matureContent', value = false}})
  assert(result.ok and #result.names == 0, table.concat(result.names, ','))
  assert(saved.matureContent == false and saved.conversationProvider == 'custom' and saved.localModel == 'standard')
  -- On and off in one batch leaves nothing behind.
  assert(apply({{id = 'matureContent', value = true}, {id = 'matureContent', value = false}}).ok == true)
  assert(saved.matureContent == false and saved.conversationProvider == 'custom')
`));

test('choosing Custom while Mature content is on keeps it on in the same save; Local keeps it too and Convai turns it off', () => run(`${pageFixture()}${stateFixture}${matureFixture}
  startFromCustom()
  assert(apply({{id = 'matureContent', value = true}}).ok)
  assert(saved.matureContent == true and saved.conversationProvider == 'custom')
  -- Picking Local while it is on leaves it on, and so does picking Custom again.
  assert(apply({{id = 'conversationProvider', value = 4}}).ok and saved.matureContent == true, 'local kept it')
  local picked = apply({{id = 'conversationProvider', value = 5}})
  assert(picked.ok, tostring(picked.error))
  assert(saved.conversationProvider == 'custom' and saved.matureContent == true and row('matureContent').value == true, tostring(saved.conversationProvider) .. tostring(saved.matureContent))
  -- Convai turns it off, and picking Custom again does not turn it back on by itself.
  assert(apply({{id = 'conversationProvider', value = 1}}).ok and saved.conversationProvider == 'convai' and saved.matureContent == false)
  assert(apply({{id = 'conversationProvider', value = 5}}).ok and saved.matureContent == false)
  -- Custom and Mature content on in one batch is saved with Mature content on.
  assert(apply({{id = 'conversationProvider', value = 5}, {id = 'matureContent', value = true}}).ok)
  assert(saved.conversationProvider == 'custom' and saved.matureContent == true)
  -- The Mature content help names Local AI and Custom, and that Convai or Mistral turns it off.
  assert(row('matureContent').description:find('Choosing Convai or Google Gemini turns it off.', 1, true))
  assert(row('matureContent').description:find('Needs Local AI or Custom.', 1, true))
`));

test('release plumbing: the module ships like the paid tier one, the catalogue reads it, and the notices catalogue lists the seven ids', () => {
  const plan = JSON.parse(readFileSync(new URL('../packaging/release-plan.json', import.meta.url), 'utf8'));
  const sources = value => JSON.stringify(value);
  assert(sources(plan).includes('"source":"mod/custom-provider.lua"'), 'packaging/release-plan.json does not ship mod/custom-provider.lua');
  assert(sources(plan).includes('AiNpcCyberpunkMod/custom-provider.lua'));
  const development = JSON.parse(readFileSync(new URL('../scripts/development-files.json', import.meta.url), 'utf8'));
  assert(development.files.some(file => file.source === 'mod/custom-provider.lua' && file.target.endsWith('AiNpcCyberpunkMod/custom-provider.lua')));
  assert(development.files.some(file => file.source === 'mod/convai-paid-tier.lua'), 'the model the entry follows');
  assert(readFileSync(new URL('../scripts/Extract-UiCatalog.mjs', import.meta.url), 'utf8').includes("'mod/custom-provider.lua'"));
  const catalogue = JSON.parse(readFileSync(new URL('../localization/en.json', import.meta.url), 'utf8'));
  assert(catalogue.scope.files.includes('mod/custom-provider.lua'));
  for (const text of ['Custom (OpenAI-compatible)', 'Custom endpoint URL', 'Custom API key', 'Custom model ID', 'Test connection', ...Object.values(NOTICES), ...Object.values(GEMINI_NOTICES)]) {
    assert(text in catalogue.strings, `not in localization/en.json: ${text}`);
  }
  // The strings of the module are all catalogued: every literal given to ui.t in it.
  const source = customSource.replace(/\r\n/g, '\n');
  for (const match of source.matchAll(/ui\.t\('((?:[^'\\]|\\.)*)'/g)) {
    const text = match[1].replace(/\\n/g, '\n');
    assert(text in catalogue.strings, `a string of mod/custom-provider.lua is not in localization/en.json: ${text.slice(0, 60)}`);
  }
});
