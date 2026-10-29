// Custom TweakDB records made at runtime with Cyber Engine Tweaks (mod/quest-tweak.lua, no TweakXL), and the neutral chase car that the drive natives
// (mod/quest-world-drive.lua) spawn from it. Run on a fake TweakDB and a fake dynamic entity system. Nothing here starts the game.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {run, load, source, base} from './quest-lua-fixture.mjs';

const harness = `
${base}
local Tweak = ${load('quest-tweak.lua')}
local db = {records = {['Vehicle.v_base'] = true, ['Vehicle.v_police'] = true, ['Vehicle.v_standard2_archer_hella_player'] = true}, flats = {}, calls = {}, cloneError = nil,
  cloneRefuses = false, cloneIsLost = false, setError = nil, setRefuses = false, updateError = nil}
local function note(kind, ...) db.calls[#db.calls + 1] = kind end
local function count(kind) local n = 0 for _, k in ipairs(db.calls) do if k == kind then n = n + 1 end end return n end
function db:GetRecord(name) note('get'); local key = type(name) == 'table' and name.id or name; return self.records[key] and {name = key} or nil end
function db:CloneRecord(newName, baseName)
  note('clone'); if self.cloneError then error(self.cloneError) end
  if self.cloneRefuses then return false end
  if not self.cloneIsLost then self.records[newName] = baseName end
  return true
end
function db:SetFlat(flat, value)
  note('set'); if self.setError then error(self.setError) end
  if self.setRefuses then return false end
  self.flats[flat] = value; return true
end
function db:GetFlat(flat) return self.flats[flat] end
function db:Update(name) note('update'); if self.updateError then error(self.updateError) end return true end
local function make(extra)
  local deps = {tweakdb = db, id = function(t) return {id = t} end, cname = function(t) return {cname = t} end, log = log}
  for k, v in pairs(extra or {}) do deps[k] = v end
  return Tweak.new(deps)
end
local flats = {{'affiliation', {tdbid = 'Affiliation.Unaffiliated'}}, {'Vehicle.QuestOne.note', {cname = 'Plain'}}, {'count', 4}}
`;
const withTweak = code => run(`${harness}\n${code}`);

test('ensure: the record is cloned once, its flats are set (relative names get the record prefix, ids and names are converted), the record is updated and the read-back is logged', () => withTweak(`
local T = make()
local ok, why = T.ensure('Vehicle.QuestOne', 'Vehicle.v_base', flats)
assert(ok == true and why == nil, tostring(why))
assert(db.records['Vehicle.QuestOne'] == 'Vehicle.v_base', 'cloned from the base')
assert(count('clone') == 1 and count('set') == 3 and count('update') == 1)
local a = db.flats['Vehicle.QuestOne.affiliation']
assert(type(a) == 'table' and a.id == 'Affiliation.Unaffiliated', 'a TweakDBID')
local n = db.flats['Vehicle.QuestOne.note']
assert(type(n) == 'table' and n.cname == 'Plain', 'a flat that already carries the prefix keeps it, and a CName')
assert(db.flats['Vehicle.QuestOne.count'] == 4, 'a plain value stays plain')
assert(logged('Vehicle.QuestOne cloned from Vehicle.v_base') and logged('Vehicle.QuestOne ready') and logged('Vehicle.QuestOne.count read back 4'), table.concat(logs, ' | '))
local known = T.known(); assert(#known == 1 and known[1] == 'Vehicle.QuestOne')
`));

test('ensure: idempotent, a second ask on the same instance or another one of the same module does nothing at all', () => withTweak(`
local T = make()
assert(T.ensure('Vehicle.QuestOne', 'Vehicle.v_base', flats) == true)
local calls = #db.calls
assert(T.ensure('Vehicle.QuestOne', 'Vehicle.v_base', flats) == true and #db.calls == calls, 'no native call the second time')
local other = make()
assert(other.ensure('Vehicle.QuestOne', 'Vehicle.v_base', flats) == true and #db.calls == calls, 'the done-set belongs to the module')
`));

test('ensure: after a script reload the file runs again, finds the clone in the TweakDB, does not clone it twice and sets the flats again', () => withTweak(`
local first = make()
assert(first.ensure('Vehicle.QuestOne', 'Vehicle.v_base', flats) == true)
assert(count('clone') == 1)
Tweak = ${load('quest-tweak.lua')}
local reloaded = make()
assert(reloaded.ensure('Vehicle.QuestOne', 'Vehicle.v_base', flats) == true)
assert(count('clone') == 1, 'the record was there: ' .. count('clone'))
assert(count('set') == 6, 'the flats are set again, which is harmless: ' .. count('set'))
assert(logged('already in the TweakDB'))
`));

test('ensure: guarded, every failure is false and a reason, nothing raises, and a failure is not tried again', () => withTweak(`
local function fails(label, setup, name, baseName, list)
  db.records = {['Vehicle.v_base'] = true}; db.calls = {}; db.flats = {}
  db.cloneError, db.cloneRefuses, db.cloneIsLost, db.setError, db.setRefuses, db.updateError = nil, false, false, nil, false, nil
  if setup then setup() end
  Tweak = ${load('quest-tweak.lua')}
  local T = make()
  local ok, a, b = pcall(T.ensure, name or 'Vehicle.QuestBad', baseName or 'Vehicle.v_base', list or flats)
  assert(ok, label .. ' raised: ' .. tostring(a))
  assert(a == false and type(b) == 'string' and #b > 0, label .. ' gave ' .. tostring(a) .. ' ' .. tostring(b))
  local before = #db.calls
  local again, why = T.ensure(name or 'Vehicle.QuestBad', baseName or 'Vehicle.v_base', list or flats)
  assert(again == false and why == b and #db.calls == before, label .. ': not tried again')
  return b
end
assert(fails('clone raises', function() db.cloneError = 'boom' end):find('CloneRecord raised', 1, true))
assert(fails('clone refused', function() db.cloneRefuses = true end):find('refused', 1, true))
assert(fails('clone lost', function() db.cloneIsLost = true end):find('not in the TweakDB', 1, true))
assert(fails('no base', nil, nil, 'Vehicle.v_missing'):find('does not exist', 1, true))
assert(fails('set raises', function() db.setError = 'flat' end):find('SetFlat', 1, true))
assert(fails('set refused', function() db.setRefuses = true end):find('refused', 1, true))
assert(fails('bad name', nil, 'no spaces allowed'):find('bad record name', 1, true))
assert(fails('bad base', nil, nil, 'bad base'):find('bad base', 1, true))
assert(fails('malformed flat', nil, nil, nil, {'affiliation'}):find('malformed', 1, true))
assert(fails('no flats', nil, nil, nil, 'x'):find('no flats', 1, true))
-- No TweakDB at all.
TweakDB = nil
Tweak = ${load('quest-tweak.lua')}
local T = Tweak.new({log = log})
local ok, why = T.ensure('Vehicle.QuestNone', 'Vehicle.v_base', flats)
assert(ok == false and why:find('not reachable', 1, true))
-- An Update that raises does not undo the record.
db.records = {['Vehicle.v_base'] = true}; db.updateError = 'late'
Tweak = ${load('quest-tweak.lua')}
local U = make()
assert(U.ensure('Vehicle.QuestUp', 'Vehicle.v_base', flats) == true and logged('Update raised'))
`));

test('neutralVehicle: the clone of the record when it can be made, the vanilla record itself when it cannot, the default car for nil, never an error', () => withTweak(`
local T = make()
local name = T.neutralVehicle('Vehicle.v_police')
assert(name == 'Vehicle.QuestNeutral_v_police', name)
assert(db.records[name] == 'Vehicle.v_police', 'a clone of the police car')
local a = db.flats[name .. '.affiliation']
assert(a.id == 'Affiliation.Unaffiliated', 'neutral affiliation')
assert(db.flats[name .. '.visualTags'] ~= nil, 'the police visual tag is cleared')
local calls = #db.calls
assert(T.neutralVehicle('Vehicle.v_police') == name and #db.calls == calls, 'cheap the second time')
assert(T.neutralVehicle(nil) == 'Vehicle.QuestNeutral_v_standard2_archer_hella_player' and T.neutralVehicle() == 'Vehicle.QuestNeutral_v_standard2_archer_hella_player')
assert(T.neutralVehicle('Vehicle.v_missing') == 'Vehicle.v_missing', 'the base record is not there: the record as asked')
db.records['Vehicle.v_other'] = true; db.cloneError = 'boom'
assert(T.neutralVehicle('Vehicle.v_other') == 'Vehicle.v_other', 'the clone cannot be made: the vanilla record')
assert(T.neutralVehicle('not a record') == 'Vehicle.v_standard2_archer_hella_player', 'junk gets the default base')
assert(T.neutralVehicle(12) == 'Vehicle.v_standard2_archer_hella_player')
TweakDB = nil
Tweak = ${load('quest-tweak.lua')}
local none = Tweak.new({})
assert(none.neutralVehicle('Vehicle.v_police') == 'Vehicle.v_police', 'no TweakDB at all')
`));

test('the clone specs are data at the top of the file', () => withTweak(`
local spec = Tweak.CLONES['neutral-vehicle']
assert(type(spec) == 'table' and #spec.flats >= 1)
for _, row in ipairs(spec.flats) do assert(type(row[1]) == 'string') end
assert(Tweak.DEFAULT_BASE == 'Vehicle.v_standard2_archer_hella_player')
`));

// ---- the drive natives spawn the neutral car -----------------------------------------------------------------------------------------------------------------------

const spawnHarness = `
${base}
local Tweak = ${load('quest-tweak.lua')}
local Drive = ${load('quest-world-drive.lua')}
local made = {}
local records = {['Vehicle.v_police'] = true, ['Vehicle.v_standard2_archer_hella_player'] = true, ['Character.driver'] = true, ['Character.walker'] = true}
TweakDB = {GetRecord = function(_, id) local key = type(id) == 'table' and id.id or id; return records[key] and {name = key} or nil end,
  CloneRecord = function(_, newName, baseName) if records[baseName] then records[newName] = true; return true end return false end,
  SetFlat = function() return true end, GetFlat = function() return 1 end, Update = function() return true end}
TweakDBID = {new = function(t) return {id = t} end}
CName = {new = function(t) return {cname = t} end}
Vector4 = {new = function(x, y, z) return {x = x, y = y, z = z} end}
EulerAngles = {new = function() return {} end, ToQuat = function() return {} end}
NewObject = function() return {} end
local nextId = 100
local system = {IsReady = function() return true end, CreateEntity = function(_, spec)
  nextId = nextId + 1
  made[#made + 1] = {record = spec.recordID.id, tags = spec.tags, id = nextId}
  return {hash = nextId}
end}
Game = {GetDynamicEntitySystem = function() return system end}
local function spawner(deps) return Drive.new(deps or {log = log}) end
`;
const withSpawn = code => run(`${spawnHarness}\n${code}`);

test('driveSpawn: a request that asks for a neutral car gets the clone for the car and the plain record for the driver, one that does not gets what it asked for', () => withSpawn(`
local W = spawner({log = log, tweak = Tweak.new({tweakdb = TweakDB, id = TweakDBID.new, cname = CName.new, log = log})})
local h = W.driveSpawn({kind = 'car', vehicle = 'Vehicle.v_police', driver = 'Character.driver', neutral = true, x = 1, y = 2, z = 3, yaw = 90, tag = 'q'})
assert(h and #made == 2, tostring(#made))
assert(made[1].record == 'Vehicle.QuestNeutral_v_police', 'the car is the clone: ' .. made[1].record)
assert(made[2].record == 'Character.driver', 'the driver is not touched')
local plain = W.driveSpawn({kind = 'car', vehicle = 'Vehicle.v_police', x = 1, y = 2, z = 3})
assert(plain and made[3].record == 'Vehicle.v_police', 'no neutral flag: the record as it is')
local default = W.driveSpawn({kind = 'car', neutral = true, x = 1, y = 2, z = 3})
assert(default and made[4].record == 'Vehicle.QuestNeutral_v_standard2_archer_hella_player', 'no record: the clone of the default car')
local foot = W.driveSpawn({kind = 'foot', driver = 'Character.walker', neutral = true, x = 1, y = 2, z = 3})
assert(foot and made[5].record == 'Character.walker', 'a pedestrian has no car to clone')
`));

test('driveSpawn: when the clone cannot be made the vanilla record is spawned, and a missing tweak module changes nothing', () => withSpawn(`
TweakDB.CloneRecord = function() error('no cloning here') end
local W = spawner({log = log, tweak = Tweak.new({tweakdb = TweakDB, id = TweakDBID.new, cname = CName.new, log = log})})
local h = W.driveSpawn({kind = 'car', vehicle = 'Vehicle.v_police', neutral = true, x = 1, y = 2, z = 3})
assert(h and made[1].record == 'Vehicle.v_police', 'fell back to the base record: ' .. tostring(made[1] and made[1].record))
-- The module file cannot be loaded at all.
dofile = function() error('missing file') end
local W2 = spawner({log = log})
local h2 = W2.driveSpawn({kind = 'car', vehicle = 'Vehicle.v_police', neutral = true, x = 1, y = 2, z = 3})
assert(h2 and made[2].record == 'Vehicle.v_police')
-- A module that is there is loaded by the natives themselves, once.
local loads = 0
dofile = function(name) loads = loads + 1; assert(name == 'quest-tweak.lua'); return Tweak end
TweakDB.CloneRecord = function(_, newName, baseName) records[newName] = true; return true end
local W3 = spawner({log = log})
W3.driveSpawn({kind = 'car', vehicle = 'Vehicle.v_police', neutral = true, x = 1, y = 2, z = 3})
W3.driveSpawn({kind = 'car', vehicle = 'Vehicle.v_police', neutral = true, x = 1, y = 2, z = 3})
assert(loads == 1 and made[3].record == 'Vehicle.QuestNeutral_v_police' and made[4].record == 'Vehicle.QuestNeutral_v_police', 'loaded once: ' .. loads)
`));

test('the tweak module is plain Lua 5.1 with no semicolon or dash in a comment and never names the library the owner dropped as a requirement', () => {
  const text = source('quest-tweak.lua');
  assert.ok(!/\bgoto\b|table\.unpack|bit32|\/\/|~=\s*nil\s*\?/.test(text.replace(/--.*$/gm, '')), 'a newer Lua form');
  for (const line of text.split('\n')) {
    const at = line.indexOf('--');
    if (at >= 0) {
      const comment = line.slice(at + 2);
      assert.ok(!comment.includes(';') && !/(^|[^-])--([^-]|$)/.test(comment), 'no semicolon or double hyphen in a comment: ' + line);
    }
    assert.ok(!/[–—]/.test(line), 'no en or em dash: ' + line);
  }
  assert.ok(!/\bAMM\b|reference-amm|Night City Allies|codeware/i.test(text), 'names another mod');
  assert.ok(!/onUpdate|GameSession|\bonDraw\b/.test(text), 'no per-frame hook');
  // The only place TweakXL may be named is the sentence that says it is not used.
  const mentions = text.split('\n').filter(line => /TweakXL/.test(line));
  assert.ok(mentions.every(line => /no TweakXL/.test(line)), 'TweakXL is named only to say it is not used');
});
