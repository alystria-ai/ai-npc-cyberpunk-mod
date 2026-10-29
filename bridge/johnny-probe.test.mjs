import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import fengari from 'fengari';

// The Johnny probes' dispatcher (mod/johnny-probe.lua): Developer mode only, from init.lua's existing mailbox poll, one feature file per
// probe, a plain JSON report in runtime/johnny-probe.json, and a tick on the 0.5 s battle sample only while a probe asks for it.
const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;
const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const probeSource = read('../mod/johnny-probe.lua');
const remarksSource = read('../mod/johnny-remarks.lua');
const init = read('../mod/init.lua');
function run(code) {
  const state = lauxlib.luaL_newstate(); lualib.luaL_openlibs(state);
  const result = lauxlib.luaL_dostring(state, to_luastring(code));
  const error = result === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(state, -1));
  lua.lua_close(state); assert.equal(result, lua.LUA_OK, error);
}
// A world with a fake mailbox: json.encode keeps the last body, io.open records what was written where.
const world = (code, setup = '') => run(`
  local developer, written, logged, loads = true, {}, {}, {}
  manager = {developerMode = function() return developer end, johnnyInHead = function() return true end,
    johnnyRemarks = function() return 'normal' end}
  json = {encode = function(value) lastBody = value; return 'encoded' end}
  io.open = function(path, mode) return {write = function(_, text) written[path] = text end, close = function() end} end
  convaiLogLine = function(line) logged[#logged + 1] = line end
  Game = {GetPlayer = function() return {} end, NameToString = function(value) return value end,
    GetScriptableSystemsContainer = function() return {Get = function() return {GetCurrentDistrict = function()
      return {GetDistrictID = function() return 'id' end} end} end} end}
  local chain = {'Coastview', 'Pacifica'}
  local function record(index) if not chain[index] then return nil end
    return {EnumName = function() return chain[index] end, ParentDistrict = function() return record(index + 1) end} end
  TweakDBInterface = {GetDistrictRecord = function() return record(1) end}
  local fake = {calls = {}, ticks = 0, keep = 2}
  function fake.run(action, env) fake.calls[#fake.calls + 1] = action; assert(env.player and env.now and env.log); return {seen = action} end
  function fake.tick(env) fake.ticks = fake.ticks + 1; fake.keep = fake.keep - 1; return fake.keep > 0 end
  ${setup}
  local P = (function() ${probeSource} end)()
  function dofile(path) loads[#loads + 1] = path; return fake end
${code}`);

test('parse: johnny-probe:<feature>:<action...>:<stamp>; anything else is malformed', () => world(`
  local feature, action = P.parse('johnny-probe:feats:spawn:A:20261019120000000')
  assert(feature == 'feats' and action == 'spawn:A')
  feature, action = P.parse('johnny-probe:relic:start:1')
  assert(feature == 'relic' and action == 'start')
  assert(P.parse('johnny-probe:relic:1') == nil, 'no action')
  assert(P.parse('notice:daily-limit:1') == nil)
  assert(P.parse('johnny-probe:Relic:start:1') == nil)
  assert(P.parse('johnny-probe:relic:st art:1') == nil)
  assert(P.parse(('x'):rep(300)) == nil)
`));

test('run: Developer mode only; a feature file is loaded once and answers; the report goes to runtime/johnny-probe.json', () => world(`
  developer = false
  assert(P.run('johnny-probe:relic:start:1') == false and #loads == 0 and next(written) == nil, 'a player: read and dropped')
  developer = true
  assert(P.run('johnny-probe:relic:start:2'))
  assert(loads[1] == 'johnny-relic-probe.lua' and fake.calls[1] == 'start')
  assert(written['runtime/johnny-probe.json'] == 'encoded')
  assert(lastBody.nonce == 'johnny-probe:relic:start:2' and lastBody.feature == 'relic' and lastBody.action == 'start' and lastBody.ok == true)
  assert(lastBody.report.seen == 'start')
  P.run('johnny-probe:relic:status:3')
  assert(#loads == 1, 'kept for the next request')
  assert(P.run('johnny-probe:nope:status:4') == false and lastBody.ok == false and lastBody.error:find('unknown feature'))
  assert(P.run('garbage') == false and lastBody.error == 'malformed request')
  assert(logged[1] == 'Johnny probe: relic start')
`));

test('tick: only while a probe asks for it, then the global is gone', () => world(`
  assert(convaiJohnnyProbeTick == nil)
  P.run('johnny-probe:feats:spawn:A:5')
  assert(type(convaiJohnnyProbeTick) == 'function')
  convaiJohnnyProbeTick()
  assert(fake.ticks == 1 and convaiJohnnyProbeTick ~= nil)
  convaiJohnnyProbeTick()
  assert(fake.ticks == 2 and convaiJohnnyProbeTick == nil, 'it returned false: no more ticks')
`));

test('place: what the sample reads now, and a test arrival queued with its cooldown cleared', () => world(`
  convaiJohnnyRemarksModule = (function() ${remarksSource} end)()
  convaiJohnnyRemarks = convaiJohnnyRemarksModule.new({level = function() return 'normal' end})
  local noted = {}
  function convaiJohnnyRemarkNote(kind, row)
    local subject, facts, cooldown = convaiJohnnyRemarksModule.placeEvent(row)
    noted[#noted + 1] = subject
    convaiJohnnyRemarks:note(kind, subject, facts, os.time(), cooldown)
  end
  convaiJohnnyHeadService = function() return {refusal = function() return nil end} end
  assert(P.run('johnny-probe:place:read:6'))
  local report = lastBody.report
  assert(report.chain[1] == 'Coastview' and report.chain[2] == 'Pacifica' and report.place == 'pacifica' and report.refusal == 'none')
  assert(#loads == 0, 'no feature file for places')
  convaiJohnnyRemarks.subjects['place:afterlife'] = os.time()
  assert(P.run('johnny-probe:place:note:afterlife:7'))
  assert(lastBody.report.noted == true and noted[1] == 'place:afterlife' and lastBody.report.queue[1].subject == 'place:afterlife')
  assert(P.run('johnny-probe:place:note:nowhere:8') and lastBody.report.noted == false)
`));

test('wiring: the mailbox runs it in Developer mode only; the tick rides the 0.5 s battle sample; nothing per frame', () => {
  assert.match(init, /if nonce:find\('\^notice:'\) then dispatched, problem = pcall\(speech\.devNotice, nonce\)\s+elseif nonce:find\('\^johnny%-probe:'\) then dispatched, problem = pcall\(convaiJohnnyProbeRun, nonce\)\s+else captureDiagnostic\(\) end\s+if not dispatched then log\('Developer request failed: ' \.\. tostring\(problem\)\) end/);
  assert.match(init, /function convaiJohnnyProbeRun\(request\)\s+if not manager\.developerMode\(\) then return false end\s+local ok, probe = pcall\(dofile, 'johnny-probe\.lua'\)/);
  assert.match(init, /if convaiJohnnyPlaceSample then convaiJohnnyGuarded\('place sample'[^\n]*\s+if convaiJohnnyFight then[^\n]*\s+-- [^\n]*\s+if convaiJohnnyProbeTick then pcall\(convaiJohnnyProbeTick\) end/);
  assert.doesNotMatch(probeSource, /registerForEvent|onUpdate|Observe|Override/, 'no hook of its own');
  for (const plan of ['../packaging/release-plan.json', '../scripts/development-files.json']) {
    assert.match(read(plan), /"source": "mod\/johnny-probe\.lua"/, plan);
  }
  const script = read('../scripts/Send-JohnnyProbe.ps1');
  assert.match(script, /"johnny-probe:\$\{Feature\}:\$\{Action\}:"/);
  assert.match(script, /diagnostic-request\.txt/);
  assert.doesNotMatch(script, /SendKeys|keybd_event|SendInput|PostMessage/i, 'never game input');
});

test('the probe script can send the quest feature and its actions (status, capture, event, line, reap, gifts, reach), ids with dots included', () => {
  const script = read('../scripts/Send-JohnnyProbe.ps1');
  assert.match(script, /ValidateSet\([^)]*'quest'/);
  assert.match(script, /\$Action -notmatch '\^\[A-Za-z0-9_:\.-\]\+\$'/, 'a line id such as P1.walk.02 passes the action check');
  for (const action of ['status', 'capture:<place>', 'event:<name>', 'line:<pack>:<line>', 'reap', 'gifts', 'reach']) assert.ok(script.includes(action), action);
  // Every action the script lists is one the probe module answers.
  const questProbe = read('../mod/quest-probe.lua');
  for (const action of ['status', 'capture', 'event', 'line', 'reap', 'gifts', 'reach']) assert.match(questProbe, new RegExp(`${action} = true`), action);
  assert.match(script, /"johnny-probe:\$\{Feature\}:\$\{Action\}:"/);
});

// 30 Oct live test: the probe never answered in the game. init.lua's `manager` is a local of that file, so a file it dofile's saw no `manager`, johnny-probe.lua failed on its first
// line, the mailbox's pcall dropped the error and nothing was written or logged. The tests above gave the files a global `manager`, which the game does not.
test('run: in the game shape (no global manager, the settings handed over as convaiSettings) the probe answers and writes johnny-probe.json', () => world(`
  assert.ok(manager == nil, 'the game has no global manager')
  assert(P.run('johnny-probe:relic:start:2'))
  assert(written['runtime/johnny-probe.json'] == 'encoded' and lastBody.ok == true and lastBody.report.seen == 'start')
  assert(logged[1] == 'Johnny probe: relic start')
`.replace("assert.ok(manager == nil, 'the game has no global manager')", "assert(manager == nil, 'the game has no global manager')"),
`convaiSettings = manager; manager = nil`));

test('run: without the hand-over the probe would fail on its first line (what the game did), so the hand-over is what makes it answer', () => {
  assert.throws(() => world(`P.run('johnny-probe:relic:start:2')`, `manager = nil`), /manager/);
});

test('place: the district probe reads the settings through the hand-over too', () => world(`
  convaiJohnnyHeadService = function() return nil end
  assert(P.run('johnny-probe:place:read:6'))
  assert(lastBody.report.johnnyInHead == true and lastBody.report.johnnyRemarks == 'normal')
`, `convaiSettings = manager; manager = nil`));

test('wiring: init.lua hands the settings manager to the files it dofile\'s before the mailbox can run, and every probe that reads settings takes it from there', () => {
  const lf = text => text.split(String.fromCharCode(13)).join('');
  const startup = lf(init);
  assert.match(startup, /\nconvaiSettings = manager\n/);
  assert.ok(startup.indexOf('\nconvaiSettings = manager\n') < startup.indexOf("io.open('runtime/diagnostic-request.txt', 'rb')"), 'set during start-up, before the mailbox poll');
  for (const file of ['../mod/johnny-probe.lua', '../mod/johnny-relic-probe.lua']) {
    const source = lf(read(file));
    assert.match(source, /\nlocal manager = convaiSettings or manager\n/, file);
    assert.ok(source.indexOf('local manager = convaiSettings or manager') < source.indexOf('manager.'), `${file}: the hand-over comes before the first use`);
  }
  // No other developer probe reads init.lua's local `manager` as a global.
  for (const file of ['phone-image-probe', 'quest-probe', 'media-probe', 'combat-feats-probe', 'face-probe', 'gesture-probe', 'loot-probe', 'knowledge-probe', 'lua-heap-probe',
    'fact-identity-probe', 'save-identity-probe', 'speech-cadence-probe']) {
    assert.doesNotMatch(read(`../mod/${file}.lua`).replace(/^\s*--.*$/gm, ''), /\bmanager\./, file);
  }
});
