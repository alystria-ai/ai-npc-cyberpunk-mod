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
  companions.devLog=function(line) logLines[#logLines+1]=line end
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

test('Developer mode logs the record and the appearance of every spawn, and nothing with it off', () => run(`
  spawn('named-person')
  assert(#logLines==0,'Developer mode is off, nothing is logged')
  companions.dismissAll(); tick(6)
  devMode=true
  spawn('named-person')
  assert(logLines[1]=='Companion look: record Character.sts_named_person, appearance named_person_look_2 (roster)',logLines[1])
  companions.dismissAll(); tick(6)
  spawn('side-person')
  assert(logLines[2]=='Companion look: record Character.sts_side_person, appearance none (the game picks one) (none)',logLines[2])
  assert(logLines[3] and logLines[3]:find('learned',1,true),'the learned look is logged once, at attach')
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
  assert.match(manager, /appearance = type\(profile\.appearanceName\) == 'string'/);
  const companions = read('../mod/companions.lua');
  assert.match(companions, /appearance, lookSource = ownLook\(definition\)/);
  const outfitAt = companions.indexOf('M.spawnOutfit,definition.id');
  assert(outfitAt > 0 && outfitAt < companions.indexOf('appearance, lookSource = ownLook(definition)'), 'the outfit module still decides first');
});
