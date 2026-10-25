import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, readdirSync} from 'node:fs';
import fengari from 'fengari';

// The title screen ("press space to continue") must stay free of our work. Pinned on the
// sources, since init.lua is too large to run in a test: what the title frames do, which redscript key handlers exist before a save is loaded, and
// the start-up lines that let a live run prove it.
const init = readFileSync(new URL('../mod/init.lua', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const scripts = new URL('../r6/scripts/CyberpunkConvai/', import.meta.url);

test('init.lua still compiles with the start-up clock added', () => {
  const {lua, lauxlib, lualib, to_luastring} = fengari;
  const L = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(L);
  const source = to_luastring(init);
  const status = lauxlib.luaL_loadbuffer(L, source, source.length, to_luastring('=init.lua'));
  assert.equal(status, lua.LUA_OK, status === lua.LUA_OK ? '' : fengari.to_jsstring(lua.lua_tostring(L, -1)));
});

test('the start-up lines: file load, onInit, and the title frames with the first world frame', () => {
  assert.match(init, /^-- Start-up clock[^\n]*\npcall\(function\(\) convaiBoot = \{t0 = os\.clock\(\)/);
  assert.match(init, /Start-up: init\.lua loaded in/);
  assert.match(init, /Start-up: onInit ran in/);
  assert.match(init, /Start-up: first world frame/);
  // the title branch only times the manager's slow tick; the report waits for the first world frame and is written once
  const title = init.slice(init.indexOf('local titleStart = os.clock()'), init.indexOf("log('Manager update failed without a world: '"));
  assert.match(title, /pcall\(managerUi\.update, nil, false\)/);
  assert.doesNotMatch(title, /dofile|io\.open|json\./);
  assert.match(init, /if boot and not boot\.reported then\n        boot\.reported = true/);
});

test('onInit registers hooks only: no file is read or decoded, no catalogue built', () => {
  const body = init.slice(init.indexOf("registerForEvent('onInit', function()"), init.indexOf('convaiFastTravelExpired = function()'));
  assert.doesNotMatch(body, /json\.decode|readJSON|dir\(/);
  // the one file read is the one-shot diagnostic request marker
  assert.equal((body.match(/io\.open\(/g) || []).length, 1);
});

test('no redscript key handler listens before a session: Input/Key is registered only by a popup, the phone, and the player-bound list', () => {
  const owners = [];
  for (const name of readdirSync(scripts)) {
    if (!name.endsWith('.reds')) continue;
    const text = readFileSync(new URL(name, scripts), 'utf8').replace(/\r\n/g, '\n');
    if (/RegisterCallback\(n"Input\/Key"/.test(text)) owners.push(name);
  }
  assert.deepEqual(owners.sort(), ['KeyBinds.reds', 'Manager.reds', 'PhoneChat.reds', 'PhoneContacts.reds']);
  // the player-bound list is configured by Lua from a PlayerPuppet method, i.e. once a player exists, never from a system's OnLoad/OnAttach
  const binds = readFileSync(new URL('KeyBinds.reds', scripts), 'utf8').replace(/\r\n/g, '\n');
  assert.match(binds, /@addMethod\(PlayerPuppet\)\npublic final func ConvaiKeyBindsConfigure\(list: String\)/);
  // every other registered Session callback is a lifecycle event, none is an input one
  for (const name of readdirSync(scripts)) {
    if (!name.endsWith('.reds') || ['KeyBinds.reds', 'Manager.reds', 'PhoneChat.reds', 'PhoneContacts.reds'].includes(name)) continue;
    assert.doesNotMatch(readFileSync(new URL(name, scripts), 'utf8'), /Input\/Key|Input\/Axis|Input\/Action/);
  }
});
