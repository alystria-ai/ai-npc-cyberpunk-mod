import {test} from 'node:test';
import assert from 'node:assert/strict';
import fengari from 'fengari';
import {companionEngine} from './companion-fixture.mjs';

const {lua,lauxlib,lualib,to_luastring,to_jsstring}=fengari;
function run(code) {
  const state=lauxlib.luaL_newstate(); lualib.luaL_openlibs(state);
  const status=lauxlib.luaL_dostring(state,to_luastring(companionEngine+fixture+code));
  const error=status===lua.LUA_OK?'':to_jsstring(lua.lua_tostring(state,-1));
  lua.lua_close(state); assert.equal(status,lua.LUA_OK,error);
}
const fixture=`
  local records={
    ['Character.Silverhand']={abilities={'sprint'},entityTemplatePath='johnny.ent'},
    ['Character.Judy']={abilities={'sprint','shoot','rightHand'},archetypeData='ranged',
      primaryEquipment='chaoPool',secondaryEquipment='secondary'},
    ['Character.Grayson']={primaryEquipment='malorianPool'},
    ranged={},malorianPool={},secondary={}
  }
  local clones,writes=0,0
  function TweakDB:GetRecord(id)
    if records[id] then return {IsA=function() return true end} end
  end
  function TweakDB:GetFlat(path)
    local record,field=path:match('^(.*)%.([^%.]+)$')
    return records[record] and records[record][field]
  end
  function TweakDB:CloneRecord(target,source)
    assert(target=='CyberpunkConvai.JohnnyCompanion')
    assert(not records[target]); records[target]={}
    for key,value in pairs(records[source]) do records[target][key]=value end
    clones=clones+1; return true
  end
  function TweakDB:SetFlats(target,values)
    assert(target=='CyberpunkConvai.JohnnyCompanion','mutated a game record')
    writes=writes+1
    for key,value in pairs(values) do records[target][key]=value end
    return true
  end
  companions.registerDefinition('johnny-silverhand',{
    id='Character.Silverhand',name='Johnny',profileKey='johnny-silverhand'})
`;

test('Johnny spawns with private combat data; Judy and quest records remain unchanged',()=>run(`
  local johnny=spawn('johnny-silverhand')
  assert(johnny.spec.recordID=='CyberpunkConvai.JohnnyCompanion')
  local clone=records[johnny.spec.recordID]
  assert(clone.entityTemplatePath=='johnny.ent')
  assert(clone.primaryEquipment=='malorianPool' and clone.archetypeData=='ranged')
  assert(#clone.abilities==3 and clone.abilities~=records['Character.Judy'].abilities)
  assert(#records['Character.Silverhand'].abilities==1)
  assert(not records['Character.Silverhand'].primaryEquipment)
  assert(records['Character.Judy'].primaryEquipment=='chaoPool')
  local judy=spawn('judy-alvarez'); assert(judy.spec.recordID=='Character.Judy')
  local second=spawn('johnny-silverhand'); assert(second.spec.recordID==johnny.spec.recordID)
  assert(clones==1 and writes==1)
  johnny.combat=true; tick(2)
  assert(companions.list()[1].behavior=='combat')
  assert(#active(johnny)==0,'social movement must yield to native combat')
`));

test('record routing follows the selected model, not an assigned conversation profile',()=>run(`
  companions.registerDefinition('browser-alias',{recordID='Character.Silverhand',name='Johnny model'})
  local model=spawn('browser-alias')
  assert(model.spec.recordID=='CyberpunkConvai.JohnnyCompanion')
  companions.registerDefinition('judy-with-johnny-profile',{
    id='Character.Judy',name='Judy',profileKey='johnny-silverhand'})
  assert(spawn('judy-with-johnny-profile').spec.recordID=='Character.Judy')
`));

test('missing combat donor prevents an incomplete spawn and does not touch shared records',()=>run(`
  records.malorianPool=nil
  local serial,err=companions.spawn('johnny-silverhand')
  assert(not serial and err:find('combat preparation failed'))
  assert(#companions.list()==0 and clones==0 and writes==0)
  assert(#records['Character.Silverhand'].abilities==1)
`));

test('failed native write or mismatched readback prevents a spawn and allows a clean retry',()=>run(`
  local apply=TweakDB.SetFlats
  TweakDB.SetFlats=function() return false end
  local serial,err=companions.spawn('johnny-silverhand')
  assert(not serial and err and #companions.list()==0)
  TweakDB.SetFlats=function() return true end
  serial,err=companions.spawn('johnny-silverhand')
  assert(not serial and err and #companions.list()==0)
  TweakDB.SetFlats=apply
  assert(spawn('johnny-silverhand').spec.recordID=='CyberpunkConvai.JohnnyCompanion')
  assert(clones==1 and writes==1)
`));
