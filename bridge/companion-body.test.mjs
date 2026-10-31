import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import fengari from 'fengari';
import {companionEngine} from './companion-fixture.mjs';
import {run as runManager, managerFixture} from './manager-fixture.mjs';

// A record that gives no body V can see (live test 2026-10-31: Aiko Harada, records Character.q307_fia_reception then Character.q307_nurse, two
// Phantom Liberty quest records, came out with no visible body). docs/SIDE_CHARACTERS.md, "A record with no visible body". The game decides
// whether a record shows a body, so these tests drive a fake one: what the code must do is name the record and look in the log (Developer mode),
// look once after attach, try the record's own look, set the record aside for the session, and invite the character again with the next record.
const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;
function run(code) {
  const state = lauxlib.luaL_newstate(); lualib.luaL_openlibs(state);
  const program = companionEngine + harness + code;
  const status = lauxlib.luaL_dostring(state, to_luastring(program));
  const error = status === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(state, -1));
  const line = Number(/\]:(\d+):/.exec(error)?.[1]);
  lua.lua_close(state);
  assert.equal(status, lua.LUA_OK, error + (line ? '\n' + program.split('\n')[line - 1] : ''));
}

const harness = `
  probeLines = {}
  io.open = function(path)
    if path == 'runtime/probe.log' then return {write = function(_, ...) probeLines[#probeLines + 1] = table.concat({...}) end, close = function() end} end
    return nil
  end
  local flats = {}
  local known = {['Character.q307_fia_reception'] = true, ['Character.q307_nurse'] = true, ['Character.Judy'] = true, ['Character.one'] = true}
  function TweakDB:GetRecord(id) if known[id] then return {IsA = function() return true end} end end
  function TweakDB:GetFlat(path) return flats[path] end
  TDBID = {ToStringDEBUG = function(id) return id end}
  TweakDBInterface = {GetGameplayAbilityRecord = function(id) return {name = id} end}
  local developer = true
  companions.developerMode = function() return developer end
  -- A body: mesh components, shown or hidden. A bodyless copy has components (an AI controller, a slot) and no mesh.
  local function mesh(on) return {IsA = function(_, kind) return kind == 'entSkinnedMeshComponent' end, IsEnabled = function() return on end} end
  local other = {IsA = function() return false end}
  local function showBody(npc) npc.components = {other, mesh(true), mesh(true)} end
  local function noBody(npc) npc.components = {other, other} end
  local function joined(text) return table.concat(probeLines, '\\n'):find(text, 1, true) ~= nil end
  local function register(key, ids)
    assert(companions.registerDefinition(key, {id = ids[1], records = ids, name = 'Aiko Harada', profileKey = key, profileName = 'Aiko Harada'}))
  end
  local function recordOf(npc) return tostring(npc.spec.recordID) end
  local function run(seconds) for _ = 1, math.floor(seconds / 0.5) do companions.update(player, 0.5) end end
`;

test('the spawn names the record and the look in the log in Developer mode, and says nothing otherwise', () => run(`
  flats['Character.q307_fia_reception.appearanceName'] = 'nurse_q307'
  register('aiko-harada', {'Character.q307_fia_reception', 'Character.q307_nurse'})
  assert(companions.spawn('aiko-harada'))
  local line
  for _, text in ipairs(probeLines) do if text:find('Companion spawn:', 1, true) then line = text end end
  assert(line, table.concat(probeLines, ' | '))
  assert(line:find('Aiko Harada (aiko-harada) record Character.q307_fia_reception (1 of 2)', 1, true), line)
  assert(line:find('look asked for none (the template default)', 1, true) and line:find('the record names nurse_q307', 1, true), line)
  developer = false
  probeLines = {}
  register('aiko-two', {'Character.q307_fia_reception', 'Character.q307_nurse'})
  assert(companions.spawn('aiko-two'))
  assert(#probeLines == 0, 'no Developer mode, no line: ' .. table.concat(probeLines, ' | '))
`));

test('a copy with a mesh shown is looked at once, kept, and nothing is set aside', () => run(`
  register('aiko-harada', {'Character.q307_fia_reception', 'Character.q307_nurse'})
  companions.spawn('aiko-harada'); run(0.5)
  local npc = entities[sequence]; showBody(npc)
  local invited = 0
  companions.onBodyMissing = function() invited = invited + 1 end
  run(4)
  assert(joined('Companion body: Aiko Harada record Character.q307_fia_reception (appearance'), table.concat(probeLines, ' | '))
  assert(joined(': shown'), table.concat(probeLines, ' | '))
  assert(invited == 0 and #companions.list() == 1 and companions.list()[1].state == 'ready')
  assert(recordOf(npc) == 'Character.q307_fia_reception')
`));

test('a copy with no mesh shown: the record is set aside, the copy goes, and the character is invited again with the next record', () => run(`
  register('aiko-harada', {'Character.q307_fia_reception', 'Character.q307_nurse'})
  companions.spawn('aiko-harada'); run(0.5)
  local first = entities[sequence]; noBody(first)
  local asked
  companions.onBodyMissing = function(info) asked = info end
  run(12)
  assert(asked, 'asked for her again: ' .. table.concat(probeLines, ' | '))
  assert(asked.key == 'aiko-harada' and asked.record == 'Character.q307_fia_reception' and asked.nextRecord == 'Character.q307_nurse', asked.nextRecord)
  assert(joined('NO VISIBLE BODY, the record is set aside and she is invited again with Character.q307_nurse'), table.concat(probeLines, ' | '))
  run(3)
  assert(#companions.list() == 0, 'the bodyless copy was dismissed')
  -- The invitation again takes the next record.
  assert(companions.spawn('aiko-harada'))
  local second = entities[sequence]
  assert(recordOf(second) == 'Character.q307_nurse', recordOf(second))
  assert(joined('record Character.q307_nurse (2 of 2)'), table.concat(probeLines, ' | '))
  showBody(second); run(5)
  assert(companions.list()[1].record == 'Character.q307_nurse' and companions.list()[1].state == 'ready')
`));

test('before giving the record up, the look the record names is tried once, and a look that works is asked for by the next copy', () => run(`
  flats['Character.q307_fia_reception.appearanceName'] = 'nurse_q307'
  register('aiko-harada', {'Character.q307_fia_reception', 'Character.q307_nurse'})
  companions.spawn('aiko-harada'); run(0.5)
  local npc = entities[sequence]; noBody(npc)
  local changes = {}
  function npc:ScheduleAppearanceChange(name) changes[#changes + 1] = name; showBody(self) end
  function npc:GetCurrentAppearanceName() return 'default' end
  local asked = false
  companions.onBodyMissing = function() asked = true end
  run(12)
  assert(#changes == 1 and changes[1] == 'nurse_q307', 'one try with the record\\'s own look')
  assert(joined('trying the look the record names, nurse_q307') and joined('shown after the look nurse_q307'), table.concat(probeLines, ' | '))
  assert(not asked and #companions.list() == 1 and companions.list()[1].state == 'ready', 'the repair worked, nobody was sent away')
  -- The next copy of the record asks for that look from the start.
  assert(companions.spawn('aiko-harada'))
  assert(entities[sequence].spec.appearanceName == 'nurse_q307', tostring(entities[sequence].spec.appearanceName))
`));

test('a copy with no mesh and no other record to try stays where she is, and the log says there is none', () => run(`
  companions.registerDefinition('lone-two', {id = 'Character.one', name = 'Lone'})
  companions.spawn('lone-two'); run(0.5)
  noBody(entities[sequence])
  local asked = false
  companions.onBodyMissing = function() asked = true end
  run(12)
  assert(not asked and #companions.list() == 1 and companions.list()[1].state == 'ready', 'a character is never sent away with no other record')
  assert(joined('NO VISIBLE BODY, the record is set aside, no other record to try'), table.concat(probeLines, ' | '))
`));

test('nothing is judged when the game lists no components at all, and a hidden mesh counts as no body', () => run(`
  register('aiko-harada', {'Character.q307_fia_reception', 'Character.q307_nurse'})
  companions.spawn('aiko-harada'); run(0.5)
  local asked = false
  companions.onBodyMissing = function() asked = true end
  run(12)
  assert(not asked and joined('nothing to judge by'), table.concat(probeLines, ' | '))
  companions.dismiss(companions.list()[1].serial); run(1)
  companions.spawn('aiko-harada'); run(0.5)
  entities[sequence].components = {other, mesh(false), mesh(false)}
  run(12)
  assert(asked, 'meshes that are all disabled show no body')
`));

test('a visiting copy (immersive invitations) is looked at and its record set aside, but she is not sent away; she is judged again when she joins V', () => run(`
  register('aiko-harada', {'Character.q307_fia_reception', 'Character.q307_nurse'})
  local serial = companions.spawn('aiko-harada', {profileKey = 'aiko-harada', profileName = 'Aiko Harada',
    appointment = {id = 5, position = Vector4.new(40, 40, 0), facing = {x = -1, y = 0}}})
  run(0.5)
  local npc = entities[sequence]; noBody(npc)
  assert(companions.list()[1].state == 'visiting')
  local asked
  companions.onBodyMissing = function(info) asked = info end
  run(12)
  assert(joined('NO VISIBLE BODY, the record is set aside, the next invitation takes Character.q307_nurse'), table.concat(probeLines, ' | '))
  assert(asked == nil and companions.list()[1].state == 'visiting', 'a visitor is not sent away while she walks')
  -- She reaches V: now she is judged, the record is already set aside, and she is invited again.
  assert(companions.joinVisitor(serial))
  run(12)
  assert(asked and asked.nextRecord == 'Character.q307_nurse', 'sent away once she is joined: ' .. table.concat(probeLines, ' | '))
`));

test('a record the game does not have is skipped for the next one, and the first record is used when it is fine', () => run(`
  register('aiko-harada', {'Character.q307_nurse', 'Character.q307_fia_reception'})
  companions.spawn('aiko-harada')
  assert(recordOf(entities[sequence]) == 'Character.q307_nurse')
  register('aiko-missing', {'Character.not_there', 'Character.q307_nurse'})
  companions.spawn('aiko-missing')
  assert(recordOf(entities[sequence]) == 'Character.q307_nurse', recordOf(entities[sequence]))
`));

test('the manager registers every record of a profile in order, and a record the roster marks in badRecords goes last (the first stays when all are marked)', () => runManager(`${managerFixture}
  manager.configure(api, {
    {key = 'aiko-harada', name = 'Aiko Harada', minor = true, invite = true, records = {'Character.q307_fia_reception', 'Character.q307_nurse'}},
    {key = 'aiko-marked', name = 'Aiko Marked', minor = true, invite = true, records = {'Character.q307_fia_reception', 'Character.q307_nurse'}, badRecords = {'Character.q307_fia_reception'}},
    {key = 'aiko-all', name = 'Aiko All', minor = true, invite = true, records = {'Character.a', 'Character.b'}, badRecords = {'Character.a', 'Character.b'}},
    {key = 'single', name = 'Single', minor = true, invite = true, records = {'Character.s'}},
  })
  local function order(key) return table.concat(api.definition(key).records or {}, ',') end
  assert(order('aiko-harada') == 'Character.q307_fia_reception,Character.q307_nurse' and api.definition('aiko-harada').id == 'Character.q307_fia_reception')
  assert(order('aiko-marked') == 'Character.q307_nurse,Character.q307_fia_reception' and api.definition('aiko-marked').id == 'Character.q307_nurse', order('aiko-marked'))
  assert(order('aiko-all') == 'Character.a,Character.b' and api.definition('aiko-all').id == 'Character.a', 'a character with every record marked still has one to try')
  assert(api.definition('single').id == 'Character.s')
`));

test('init.lua invites the character again through the phone\'s doors when a body is missing: the appointment first, else the party queue', () => {
  const init = readFileSync(new URL('../mod/init.lua', import.meta.url), 'utf8');
  const hook = init.slice(init.indexOf('companions.onBodyMissing = function(info)'), init.indexOf('companions.canSpawn = function'));
  assert.ok(hook.length > 100, 'the hook is in init.lua');
  assert.match(hook, /immersive\.requestInvite\(info\.key\)/);
  assert.match(hook, /queue\.invite\(info\.key\)/);
  assert.ok(hook.indexOf('immersive.requestInvite') < hook.indexOf('queue.invite'), 'the appointment is asked first');
  assert.doesNotMatch(hook, /[^.\w]log\(/, 'a bare log is an undefined global at that point of init.lua (convaiLogLine is used)');
});
