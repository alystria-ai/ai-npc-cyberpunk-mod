import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import fengari from 'fengari';
import {companionEngine} from './companion-fixture.mjs';
import {curatedBases, applyLooks, withoutLook, render} from '../scripts/cast-sweep/spawn-looks.mjs';
import {LEAN_FIELDS} from '../scripts/Build-GameRoster.mjs';

// Discord reports of 31 Oct 2026: an invited named character came as a random look of the same record. The spawn now names the character's own look
// (mod/companions.lua ownLook): the roster row's appearanceName, then the curated base look, then the look the last copy of that record was seen in.
const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;
const read = path => readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const roster = JSON.parse(read('../characters/roster.json'));
const game = JSON.parse(read('../characters/game-roster.json'));
const outfitData = read('../mod/companion-outfits-data.lua');

function run(code) {
  const vm = lauxlib.luaL_newstate(); lualib.luaL_openlibs(vm);
  const status = lauxlib.luaL_dostring(vm, to_luastring(companionEngine + fixture + code));
  const error = status === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(vm, -1));
  lua.lua_close(vm); assert.equal(status, lua.LUA_OK, error);
}

// The game picks a random look when the spawn names none; a stand-in makes that visible. runtime/spawn-looks.json is an in-memory file.
const fixture = `
  local stash={}
  json={encode=function(value) stash[#stash+1]=value; return 'J'..#stash end,
    decode=function(text) return stash[tonumber(text:sub(2))] end}
  files,logLines,randomLook={},{},0
  local plainDofile=dofile
  curated=nil
  dofile=function(name)
    if name=='companion-outfits-data.lua' and curated then return curated end
    return plainDofile(name)
  end
  io.open=function(path,mode)
    if path=='runtime/spawn-looks.json' then
      if mode=='wb' then
        local parts={}
        return {write=function(_,text) parts[#parts+1]=text end,close=function() files[path]=table.concat(parts) end}
      end
      if files[path] then return {read=function() return files[path] end,close=function() end} end
    end
    return nil
  end
  companions.developerMode=function() return devMode==true end
  local system=Game.GetDynamicEntitySystem()
  local create=system.CreateEntity
  function system:CreateEntity(spec)
    local id=create(self,spec)
    local npc=self:GetEntity(id)
    randomLook=randomLook+1
    local shown=spec.appearanceName or ('random_look_'..randomLook)
    function npc:GetCurrentAppearanceName() return shown end
    return id
  end
  companions.registerDefinition('side-person',{id='Character.sts_side_person',name='Side Person',profileKey='side-person'})
  companions.registerDefinition('named-person',{id='Character.sts_named_person',name='Named Person',profileKey='named-person',
    appearance='named_person_look_2'})
`;

test('a roster appearanceName is asked for at the spawn, every time', () => run(`
  for round=1,3 do
    local npc=spawn('named-person')
    assert(npc.spec.appearanceName=='named_person_look_2','round '..round..': '..tostring(npc.spec.appearanceName))
    companions.dismiss(companions.list()[1].serial)
    tick(4)
  end
  assert(files['runtime/spawn-looks.json']==nil,'a look that was asked for is not learned again')
`));

test('the curated base look pins a character whatever the outfit setting says', () => run(`
  curated={characters={['Character.sts_side_person']={base='side_person_default',outfits={{'side_person_default','any'}}}}}
  local npc=spawn('side-person')
  assert(npc.spec.appearanceName=='side_person_default',tostring(npc.spec.appearanceName))
`));

test('a record with no known look gets the look the game gave its first copy, in the next invitation and after a fast travel', () => run(`
  local first=spawn('side-person')
  assert(first.spec.appearanceName==nil,'nothing is known yet, the game picks')
  local given=first:GetCurrentAppearanceName()
  assert(given:find('random_look_'))
  assert(stash[1].looks['Character.sts_side_person']==given,'the look is kept for the record')
  -- the same copy comes back after a fast travel in the same look
  local serial=companions.list()[1].serial
  assert(companions.beginFastTravel())
  entities[tonumber(first.id.hash)]=nil
  assert(companions.fastTravel())
  tick(8)
  local replacement=entities[sequence]
  assert(replacement and replacement~=first,'fast travel did not recreate the copy')
  assert(replacement.spec.appearanceName==given,'recreated as '..tostring(replacement.spec.appearanceName))
  assert(companions.list()[1].serial==serial)
  -- a later invitation (also after a reload that forgot the session) is the same person
  companions.dismissAll(); tick(6)
  local second=spawn('side-person')
  assert(second.spec.appearanceName==given,'second invitation: '..tostring(second.spec.appearanceName))
  assert(second:GetCurrentAppearanceName()==given)
`));

test('a saved look is read from runtime/spawn-looks.json once and a bad file asks for nothing', () => run(`
  files['runtime/spawn-looks.json']='J1'
  stash[1]={version=1,looks={['Character.sts_side_person']='saved_look',['Character.bad']=5}}
  local npc=spawn('side-person')
  assert(npc.spec.appearanceName=='saved_look')
  companions.dismissAll(); tick(6)
  files['runtime/spawn-looks.json']=nil
  stash[2]='not a table'
  json.decode=function() error('bad file') end
  companions.registerDefinition('other-person',{id='Character.sts_other',name='Other',profileKey='other-person'})
  local other=spawn('other-person')
  assert(other.spec.appearanceName==nil)
`));

test('Developer mode logs the record, the look asked for and where it came from, in main\'s one spawn line, and nothing with it off', () => run(`
  spawnRecords_probe = {}
  local plainOpen = io.open
  io.open = function(path, mode)
    if path == 'runtime/probe.log' then return {write = function(_, ...) spawnRecords_probe[#spawnRecords_probe + 1] = table.concat({...}) end, close = function() end} end
    return plainOpen(path, mode)
  end
  local function spawnLine()
    for _, text in ipairs(spawnRecords_probe) do if text:find('Companion spawn:', 1, true) then return text end end
  end
  spawn('named-person')
  assert(spawnLine() == nil, 'Developer mode is off, nothing is logged')
  companions.dismissAll(); tick(6)
  devMode = true
  spawn('named-person')
  assert(spawnLine():find('look asked for named_person_look_2 (roster)', 1, true), spawnLine())
  companions.dismissAll(); tick(6)
  spawnRecords_probe = {}
  spawn('side-person')
  assert(spawnLine():find('look asked for none (the template default) (the game picks)', 1, true), spawnLine())
  local learned
  for _, text in ipairs(spawnRecords_probe) do if text:find('Companion look:', 1, true) then learned = text end end
  assert(learned and learned:find('Character.sts_side_person was given', 1, true), 'the learned look is logged once, at attach')
`));

test('the body check works with the look that is asked for: a repaired look replaces the kept one, a record with no body keeps none, and the roster look is only for its own record', () => run(`
  local function mesh(on) return {IsA = function(_, kind) return kind == 'entSkinnedMeshComponent' end, IsEnabled = function() return on end} end
  files['runtime/spawn-looks.json'] = 'J1'; stash[1] = {looks = {['Character.sts_side_person'] = 'old_look'}}
  -- a bodyless copy of a record that names its own look: that look is tried, and when it works it is the record's look from then on
  local flatRecord = TweakDB.GetFlat
  function TweakDB:GetFlat(path) if path == 'Character.sts_side_person.appearanceName' then return 'repair_look' end return flatRecord(self, path) end
  local npc = spawn('side-person')
  assert(npc.spec.appearanceName == 'old_look', 'the kept look is asked for: ' .. tostring(npc.spec.appearanceName))
  local other = {IsA = function() return false end}
  npc.components = {other, other}
  function npc:ScheduleAppearanceChange(name) npc.shown = name; npc.components = {other, mesh(true)} end
  for _ = 1, 40 do companions.update(player, 0.5) end
  assert(npc.shown == 'repair_look', 'the own look of the record was tried: ' .. tostring(npc.shown))
  assert(stash[#stash].looks['Character.sts_side_person'] == 'repair_look', 'and it replaces the kept look')
  assert(companions.list()[1].state == 'ready')
`));

test('a record with no visible body keeps no look, and the roster look is not given to another record of the profile', () => run(`
  -- a copy that comes out with no body: the look the game gave it is not kept for the record
  local ghost = spawn('side-person')
  assert(stash[#stash].looks['Character.sts_side_person'] == ghost:GetCurrentAppearanceName(), 'learned at attach')
  local blank = {IsA = function() return false end}
  ghost.components = {blank, blank}
  for _ = 1, 40 do companions.update(player, 0.5) end
  assert(stash[#stash].looks['Character.sts_side_person'] == nil, 'forgotten when the record gave no visible body')
  companions.dismissAll(); tick(6)
  companions.registerDefinition('two-records', {id = 'Character.sts_first', records = {'Character.sts_first', 'Character.sts_second'}, name = 'Two', profileKey = 'two-records', appearance = 'first_look'})
  local first = spawn('two-records')
  assert(first.spec.appearanceName == 'first_look')
  local definition = companions.definition('two-records')
  assert(definition.appearanceRecord == 'Character.sts_first' and definition.appearance == 'first_look')
  -- the look belongs to the first record only
  local other = {}
  for field, value in pairs(definition) do other[field] = value end
  other.id = 'Character.sts_second'
  companions.dismissAll(); tick(6)
  companions.registerDefinition('only-second', {id = 'Character.sts_second', name = 'Second', profileKey = 'only-second'})
  assert(spawn('only-second').spec.appearanceName == nil, 'another record is not given the look of the first')
`));

test('Kerry keeps the look his spawn record asks for, ahead of any roster or remembered look', () => run(`
  companions.registerDefinition('kerry-eurodyne',{id='Character.Kerry',name='Kerry',profileKey='kerry-eurodyne'})
  files['runtime/spawn-looks.json']='J1'; stash[1]={looks={['Character.Kerry']='remembered_kerry'}}
  local kerry=spawn('kerry-eurodyne')
  assert(kerry.spec.appearanceName=='kerry_eurodyne_kerry_eurodyne_old_no_sunglasses',tostring(kerry.spec.appearanceName))
`));

// ---- the data ----
test('the curated base looks are in the roster rows and the game roster, and match the outfit table', () => {
  const bases = curatedBases(outfitData);
  assert(Object.keys(bases).length >= 19, JSON.stringify(Object.keys(bases)));
  for (const row of roster) {
    const base = bases[row.records?.[0]];
    if (base) assert.equal(row.appearanceName, base, `${row.key} names its curated look`);
    else assert.equal(row.appearanceName, undefined, `${row.key} has a look the repo cannot prove`);
  }
  for (const [index, row] of game.entries()) assert.equal(row.appearanceName, roster[index].appearanceName, `${row.key}: game roster`);
  assert(LEAN_FIELDS.includes('appearanceName'));
});

test('the spawn-looks script is idempotent, keeps the file as it is and counts the rows without a look', () => {
  const text = read('../characters/roster.json');
  const bases = curatedBases(outfitData);
  const again = applyLooks(roster, bases);
  assert.equal(render(again, text), text, 'running it again changes nothing');
  const missing = withoutLook(again);
  assert.equal(missing.length + again.filter(row => row.appearanceName).length + again.filter(row => row.invite === false || !row.records?.length).length, again.length);
  assert(missing.every(row => row.invite !== false));
  // nothing is invented: a row without a proven look stays without one
  const changed = applyLooks([{key: 'x', records: ['Character.nobody']}, {key: 'y', records: ['Character.Judy'], appearanceName: 'mine'}], bases);
  assert.equal(changed[0].appearanceName, undefined);
  assert.equal(changed[1].appearanceName, 'mine');
});

test('the manager passes the roster look to the definition and the spawn path uses it before the outfit rows', () => {
  const manager = read('../mod/manager.lua');
  assert.match(manager, /appearance = look/);
  assert.match(manager, /record ~= \(type\(profile\.records\) == 'table' and profile\.records\[1\] or nil\) then look = nil/);
  const companions = read('../mod/companions.lua');
  assert.match(companions, /appearance, lookSource = ownLook\(definition\)/);
  const outfitAt = companions.indexOf('M.spawnOutfit,definition.id');
  const knownAt = companions.indexOf('spawnRecords.knownLook(definition.id');
  const ownAt = companions.indexOf('appearance, lookSource = ownLook(definition)');
  assert(outfitAt > 0 && outfitAt < knownAt && knownAt < ownAt, 'the outfit module decides first, then the look that made a body show, then the character\'s own look');
});
