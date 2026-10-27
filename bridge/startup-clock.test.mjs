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

test('the title-frame stall probe: frame gaps against its own onUpdate, once at 45 s and once with the first world frame', () => {
  // the frame's start is stamped in onUpdate right after the native re-detect, with no local and only until the report; the title branch closes it
  assert.match(init, /pcall\(convaiNative\.redetect, 'onUpdate'\) end\n    -- Start-up probe:[^\n]*\n    if convaiBoot and not convaiBoot\.reported then convaiBoot\.top = os\.clock\(\) end/);
  assert.match(init, /convaiBootFrame\(boot, finished\)/);
  assert.match(init, /Start-up: title screen 45 s after onInit, %d frames; %s/);
  assert.match(init, /%d title frames, the mod used %.1f ms in them, worst %.2f ms at %.1f s; %s/);
  // the tail names the gaps over 100 ms, the stalls over 250 ms with their time, its whole title onUpdate, and the first freeze of 3 s (a save loading)
  const at = init.indexOf('convaiBootGaps = function(boot)');
  const tail = init.slice(at, init.indexOf('end)', at));
  for (const part of ['frame gaps over 100 ms', 'over 250 ms at', 'whole title onUpdate', 'no freeze of 3 s or more yet']) assert.ok(tail.includes(part), part);
  const frame = init.slice(init.indexOf('convaiBootFrame = function(boot, finished)'), at);
  assert.doesNotMatch(frame, /dofile|io\.open|json\.|print\(|log\(/);
});

test('the V helper voice (a Python process importing torch) waits for the first world of the game, or ten minutes, and its start line carries the time', () => {
  const bridge = readFileSync(new URL('./convai-bridge.mjs', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const voice = readFileSync(new URL('./voice-selection.mjs', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const helper = readFileSync(new URL('./v-helper-voice.mjs', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  assert.match(bridge, /const TITLE_HOLD_MAX_MS = 600_000;/);
  assert.match(bridge, /new VoiceSelection\(voiceConfig, \{project, configPath: localVoiceConfigPath, startHold: helperHolds,/);
  assert.match(bridge, /if \(worldSession\?\.ready === true\) endTitle\('the game has a world'\);\n  else if \(process\.uptime\(\) \* 1000 >= TITLE_HOLD_MAX_MS\) endTitle\('the title hold ran out'\);/);
  // the first world heartbeat releases it at once
  assert.match(bridge, /if \(nextWorld && endTitle\('the game has a world'\)\) \{[^\n]*localVoice\.tickVHelper\(\); \}/);
  // only the first load waits: a running helper is not held
  assert.match(voice, /if\(!this\.vHelper\.running&&this\.startHold\(\)\)return false;/);
  assert.match(helper, /loading starts at/);
});

test('the title screen has no High priority: the service starts at normal, takes High when the game has a world (or a turn arrives, or the hold runs out), and says when', () => {
  const bridge = readFileSync(new URL('./convai-bridge.mjs', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const supervisor = readFileSync(new URL('./bridge-supervisor.mjs', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  // the gate closes before anything is spawned, and the service raises itself through it
  assert.match(bridge, /priorityGate\.log = line => process\.stderr\.write\(line \+ '\\n'\);\nif \(turnPriority === 'high'\) \{\n  priorityGate\.close\(\);\n  priorityGate\.whenOpen\(\(\) => \{\n    const done = setProcessPriority\(process\.pid, 'high'\);/);
  assert.ok(bridge.indexOf('priorityGate.close();') < bridge.indexOf('new VoiceSelection('), 'closed before the voice service can spawn a worker');
  // three ways to end the title: the world, a turn, the long wait
  assert.match(bridge, /function endTitle\(reason\) \{\n  if \(titleHoldOver\) return false;\n  titleHoldOver = true;\n  timeline\([^\n]*\);\n  priorityGate\.open\(reason\);/);
  assert.match(bridge, /endTitle\('a turn arrived'\);/);
  assert.match(bridge, /setTimeout\(\(\) => \{ endTitle\('the title hold ran out'\); \}, TITLE_HOLD_MAX_MS\)/);
  // the supervisor no longer raises the bridge at its start
  assert.doesNotMatch(supervisor, /setProcessPriority\(pid, 'high'/);
  assert.match(supervisor, /The bridge starts at normal priority and takes high priority itself once the game has a world\./);
  // the start-up timeline: wall-clock lines for the few events a freeze can be lined up with
  assert.match(bridge, /\[Timeline\] \$\{new Date\(\)\.toISOString\(\)\} \+\$\{process\.uptime\(\)\.toFixed\(1\)\} s \$\{event\}/);
  for (const event of ['the service began (modules loaded)', 'the settings were read for the first time', 'V voice mod scan starts', 'V voice mod scan done', 'a save is loading']) assert.ok(bridge.includes(`timeline('${event}')`), event);
});

test('the V voice mod scan waits for the world (27 Oct 2026: its cache write fell inside the title\'s 2.4 s freeze), then its 20 s delay', () => {
  const bridge = readFileSync(new URL('./convai-bridge.mjs', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const block = bridge.slice(bridge.indexOf('const startVVoiceModScan = () => {'), bridge.indexOf('// Which reference V speaks from'));
  assert.match(block, /const wait = \(\) => \{ if \(titleHolds\(\)\) setTimeout\(wait, 5000\)\.unref\?\.\(\); else setTimeout\(run, V_MOD_SCAN_DELAY_MS\)\.unref\?\.\(\); \};/);
  assert.doesNotMatch(block, /setTimeout\(\(\) => \{ void scanVVoiceMods\(\); \}, V_MOD_SCAN_DELAY_MS\)/, 'no timer that starts it at the title');
});

test('V\'s helper voice starts when a save is loading (the game\'s lease says so), not only when the world exists, with its own Python bytecode cache', () => {
  const bridge = readFileSync(new URL('./convai-bridge.mjs', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  assert.match(bridge, /function helperHolds\(\) \{ return titleHolds\(\) && !loadBegun; \}/);
  assert.match(bridge, /if \(session\?\.loading === true && !loadBegun && !titleHoldOver\) \{ loadBegun = true; timeline\('a save is loading'\);/);
  assert.match(bridge, /pythonCacheDirectory: resolve\(stateDirectory, 'python-cache'\)/);
  // the game side: the lease carries `loading` from the PlayerPuppet OnDetach of a load, cleared by the first ready write; set just before the session is abandoned, whose forced write carries it
  const lease = init.slice(init.indexOf('local function publishWorldSession('), init.indexOf('local function refreshKnowledgeFrame()'));
  assert.match(lease, /loading = ready ~= true and convaiHeartbeat\.loading or nil\}/);
  assert.match(lease, /if ready == true then convaiHeartbeat\.loading = nil end/);
  assert.match(init, /convaiHeartbeat\.restoreWait, convaiHeartbeat\.restoreAttached = os\.clock\(\), nil\n            convaiHeartbeat\.loading = true\n            abandonSession\('player detached', false, true\)/);
  assert.doesNotMatch(init, /convaiPublishLoading/, 'no extra write: the detach already publishes the lease once, with the flag');
});

test('the title-frame probe names the wall-clock second a stall began (UTC), so it lines up with the service\'s [Timeline] lines', () => {
  assert.match(init, /string\.format\('%\.1f\+%\.0f@%s', top - boot\.t0, gap \* 1000, os\.date\('!%H:%M:%S', began\)\)/);
  assert.match(init, /worst %\.0f ms at %\.1f s \(began %s UTC\), over 250 ms at \[%s\]/);
  assert.match(init, /first freeze of 3 s or more: %\.0f ms at %\.1f s \(began %s UTC\)/);
  const frame = init.slice(init.indexOf('convaiBootFrame = function(boot, finished)'), init.indexOf('convaiBootGaps = function(boot)'));
  assert.doesNotMatch(frame, /dofile|io\.open|json\.|print\(|log\(/);
});
