// The roster fields init.lua drops after decoding conversation-characters.json (the bridge's research text, about 1 MB of Lua
// tables no game-side code reads; deliverables/perf/LUA_HEAP.md).
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import fengari from 'fengari';

const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;
const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const initSource = read('mod/init.lua');

function run(code) {
  const state = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(state);
  const status = lauxlib.luaL_dostring(state, to_luastring(code));
  const error = status === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(state, -1));
  lua.lua_close(state);
  assert.equal(status, lua.LUA_OK, error);
}

// The roster block of init.lua as written (from `local supportedProfiles = {}` to the end of its do block), over a stubbed file
// and decoder.
function rosterBlock() {
  const start = initSource.indexOf('local supportedProfiles = {}');
  const marker = '-- Generic NPC archetypes';
  const end = initSource.indexOf(marker, start);
  assert(start > 0 && end > start, 'the roster block was not found in init.lua');
  return initSource.slice(start, end);
}

test('init.lua drops the bridge-only roster fields after decoding and keeps every field the game side reads', () => run(`
  local decoded = {
    {key = 'judy-alvarez', name = 'Judy Alvarez', kind = 'named', gender = 'FEMALE', records = {'Character.Judy'}, model = 'judy',
     aliases = {'Judy'}, voice = 'v1', voiceName = 'Judy', invite = true, summary = 'Braindance editor.', researchPath = 'r/judy.md',
     backstory = string.rep('b', 5000), sources = {{url = 'x'}}, speakingStyleDescription = 's', speakingStyleSampleDialogues = {'a'},
     uncertainty = {'u'}, nativeIntrinsic = {facts = {}}},
    {key = 'panam-palmer', name = 'Panam Palmer', backstory = 'b'},
  }
  io = {open = function(path, mode)
    assert(path == 'conversation-characters.json' and mode == 'rb', path)
    return {read = function() return '[...]' end, close = function() end}
  end}
  json = {decode = function(text) assert(text == '[...]'); return decoded end}
  ${rosterBlock()}
  assert(profiles == decoded and supportedProfiles['judy-alvarez'] and supportedProfiles['panam-palmer'])
  local judy = profiles[1]
  for _, field in ipairs({'backstory', 'sources', 'speakingStyleDescription', 'speakingStyleSampleDialogues', 'uncertainty', 'nativeIntrinsic'}) do
    assert(judy[field] == nil and profiles[2][field] == nil, field .. ' was kept')
  end
  assert(judy.key == 'judy-alvarez' and judy.name == 'Judy Alvarez' and judy.kind == 'named' and judy.gender == 'FEMALE')
  assert(judy.records[1] == 'Character.Judy' and judy.model == 'judy' and judy.aliases[1] == 'Judy' and judy.voice == 'v1')
  assert(judy.voiceName == 'Judy' and judy.invite == true and judy.summary == 'Braindance editor.' and judy.researchPath == 'r/judy.md')
`));

test('no game-side Lua reads a roster field init.lua drops', () => {
  const dropped = ['backstory', 'sources', 'speakingStyleDescription', 'speakingStyleSampleDialogues', 'uncertainty', 'nativeIntrinsic'];
  const files = readFileSync(new URL('../scripts/development-files.json', import.meta.url), 'utf8');
  const lua = [...files.matchAll(/"source": "(mod\/[^"]+\.lua)"/g)].map(match => match[1]).filter(rel => rel !== 'mod/diagnostics.lua');
  assert(lua.length > 80);
  const reads = [];
  for (const rel of lua) {
    const text = read(rel).replace(/--[^\n]*/g, '');
    for (const field of dropped) {
      if (new RegExp(`\\.${field}\\b|\\[['"]${field}['"]\\]`).test(text)) reads.push(`${rel}: ${field}`);
    }
  }
  assert.deepEqual(reads, []);
});
