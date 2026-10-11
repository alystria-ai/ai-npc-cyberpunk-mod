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
    ['Character.Judy']={abilities={'sprint','Ability.CanShootWhileMoving','rightHand'},archetypeData='ranged',
      primaryEquipment='chaoPool',secondaryEquipment='secondary'},
    ['Character.Grayson']={primaryEquipment='malorianPool'},
    ['Character.Kerry']={entityTemplatePath='base\\\\quest\\\\tertiary_characters\\\\kerry.ent',
      defaultAppearance='kerry_eurodyne__q203__shower'},
    ['Character.alex']={abilities={'Ability.CanCrouch','sprint'},entityTemplatePath='alex.ent'},
    ['Character.Panam']={abilities={'Ability.CanCrouch','Ability.CanCloseCombat'},entityTemplatePath='panam.ent'},
    ranged={},malorianPool={},secondary={},chaoPool={}
  }
  TDBID={ToStringDEBUG=function(id) return id end}
  TweakDBInterface={GetGameplayAbilityRecord=function(id) return {name=id} end}
  local clones,writes=0,0
  function TweakDB:GetRecord(id)
    if records[id] then return {IsA=function() return true end,
      AbilitiesContains=function(_,ability)
        for _,have in ipairs(records[id].abilities or {}) do if have==ability.name then return true end end
        return false
      end} end
  end
  function TweakDB:GetFlat(path)
    local record,field=path:match('^(.*)%.([^%.]+)$')
    return records[record] and records[record][field]
  end
  function TweakDB:CloneRecord(target,source)
    assert(target:find('^CyberpunkConvai%.'),'cloned into a game record')
    assert(not records[target]); records[target]={}
    for key,value in pairs(records[source]) do records[target][key]=value end
    clones=clones+1; return true
  end
  function TweakDB:SetFlats(target,values)
    assert(target:find('^CyberpunkConvai%.'),'mutated a game record')
    writes=writes+1
    for key,value in pairs(values) do records[target][key]=value end
    return true
  end
  companions.registerDefinition('johnny-silverhand',{
    id='Character.Silverhand',name='Johnny',profileKey='johnny-silverhand'})
  companions.registerDefinition('alex',{id='Character.alex',name='Alex',profileKey='alex'})
  companions.registerDefinition('panam-palmer',{id='Character.Panam',name='Panam',profileKey='panam-palmer'})
  companions.registerDefinition('kerry-eurodyne',{
    id='Character.Kerry',name='Kerry',profileKey='kerry-eurodyne'})
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
  assert(model.spec.appearanceName=='silverhand_riot__not_blendable')
  companions.registerDefinition('judy-with-johnny-profile',{
    id='Character.Judy',name='Judy',profileKey='johnny-silverhand'})
  local judy=spawn('judy-with-johnny-profile')
  assert(judy.spec.recordID=='Character.Judy' and judy.spec.appearanceName==nil)
`));

test('Johnny is created solid so attachment does not replace his initialized face graph',()=>run(`
  companions.spawn('johnny-silverhand')
  local johnny=entities[sequence]
  assert(johnny.spec.appearanceName=='silverhand_riot__not_blendable',
    'the solid appearance must be part of the initial native spawn request')
  local ghost={enabled=true,params={blendableAppearanceMatches={
    {blendable='silverhand_default',notBlendable='silverhand_riot__not_blendable'}}},
    IsA=function(_,kind) return kind=='gamePhantomEntityComponent' end,
    Toggle=function(self,on) self.enabled=on end,IsEnabled=function(self) return self.enabled end}
  johnny.components={ghost}
  johnny.GetCurrentAppearanceName=function() return johnny.spec.appearanceName end
  johnny.ScheduleAppearanceChange=function() error('attachment replaced the initialized face') end
  tick()
  assert(not ghost.enabled and companions.list()[1].state=='ready')
  local second=spawn('johnny-silverhand')
  assert(second.spec.appearanceName==johnny.spec.appearanceName,'cached private records lost the appearance')
  local judy=spawn('judy-alvarez')
  assert(judy.spec.appearanceName==nil,'an ordinary companion received the Silverhand appearance')
`));

test('Johnny recreation after fast travel keeps his initial solid appearance',()=>run(`
  local johnny=spawn('johnny-silverhand')
  local serial=companions.list()[1].serial
  assert(companions.beginFastTravel())
  entities[tonumber(johnny.id.hash)]=nil
  assert(companions.fastTravel())
  tick(8)
  local replacement=entities[sequence]
  assert(replacement and replacement~=johnny,'fast travel did not recreate the missing copy')
  assert(replacement.spec.recordID=='CyberpunkConvai.JohnnyCompanion','fast travel lost private record routing')
  assert(replacement.spec.appearanceName=='silverhand_riot__not_blendable','fast travel lost the initial solid appearance')
  local row=companions.list()[1]
  assert(row.serial==serial and row.state=='ready')
`));

test('Kerry is created in his native clothed appearance without rewriting the quest record or rebuilding his face',()=>run(`
  companions.spawn('kerry-eurodyne')
  local kerry=entities[sequence]
  assert(kerry.spec.recordID=='Character.Kerry','Kerry received another character record')
  assert(kerry.spec.appearanceName=='kerry_eurodyne_kerry_eurodyne_old_no_sunglasses',
    'Kerry inherited the native shower default instead of his clothed appearance')
  kerry.ScheduleAppearanceChange=function() error('attachment rebuilt the initialized face graph') end
  tick()
  assert(companions.list()[1].state=='ready')
  assert(records['Character.Kerry'].defaultAppearance=='kerry_eurodyne__q203__shower',
    'the shared story template was rewritten')
  assert(clones==0 and writes==0,'clothing selection mutated TweakDB')
`));

test('Kerry clothing is selected by the model record, including browser copies, rather than the voice profile',()=>run(`
  companions.registerDefinition('kerry-browser-copy',{recordID='Character.Kerry',name='Kerry model'})
  local kerry=spawn('kerry-browser-copy')
  assert(kerry.spec.appearanceName=='kerry_eurodyne_kerry_eurodyne_old_no_sunglasses',
    'the browser copy inherited the shower outfit')
  companions.registerDefinition('judy-with-kerry-profile',{
    id='Character.Judy',name='Judy',profileKey='kerry-eurodyne'})
  local judy=spawn('judy-with-kerry-profile')
  assert(judy.spec.recordID=='Character.Judy' and judy.spec.appearanceName==nil,
    'a conversation identity replaced the selected model outfit')
  assert(clones==0 and writes==0)
`));

test('Kerry recreation after fast travel retains the initial clothed appearance and exact companion identity',()=>run(`
  local kerry=spawn('kerry-eurodyne')
  local serial=companions.list()[1].serial
  assert(companions.beginFastTravel())
  entities[tonumber(kerry.id.hash)]=nil
  assert(companions.fastTravel())
  tick(8)
  local replacement=entities[sequence]
  assert(replacement and replacement~=kerry,'fast travel did not recreate the missing copy')
  assert(replacement.spec.recordID=='Character.Kerry')
  assert(replacement.spec.appearanceName=='kerry_eurodyne_kerry_eurodyne_old_no_sunglasses',
    'the recreated copy reverted to the shower default')
  local row=companions.list()[1]
  assert(row.serial==serial and row.state=='ready')
  assert(clones==0 and writes==0)
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

test('dismissal releases exact-copy presentation before deleting its live entity',()=>run(`
  local first=spawn('judy-alvarez')
  local second=spawn('judy-alvarez')
  local rows=companions.list()
  local released={}
  companions.onBeforeRemove=function(entity)
    assert(entities[tonumber(entity)]~=nil,'presentation cleanup ran after entity removal')
    released[#released+1]=entity
  end
  assert(companions.dismiss(rows[1].serial))
  assert(#released==1 and released[1]~=tostring(second:GetEntityID().hash))
  assert(#companions.list()==1)
`));

test('a quest-base record without shooting abilities (Alex) spawns from a private armed clone and stays in combat',()=>run(`
  local alex=spawn('alex')
  assert(alex.spec.recordID=='CyberpunkConvai.Armed_Character_alex' or alex.spec.recordID:find('^CyberpunkConvai%.Armed_'),tostring(alex.spec.recordID))
  local clone=records[alex.spec.recordID]
  assert(clone.entityTemplatePath=='alex.ent','the clone keeps her template and identity')
  local have={} for _,a in ipairs(clone.abilities) do have[a]=true end
  assert(have['Ability.CanCrouch'] and have['sprint'],'own abilities are kept')
  assert(have['Ability.CanShootWhileMoving'] and have['rightHand'],'the working ranged set is added')
  assert(#clone.abilities==4,'a shared ability is not duplicated')
  assert(clone.primaryEquipment=='chaoPool' and clone.secondaryEquipment=='secondary' and clone.archetypeData=='ranged')
  assert(#records['Character.alex'].abilities==2 and not records['Character.alex'].primaryEquipment,'the game record is untouched')
  assert(#records['Character.Judy'].abilities==3)
  local second=spawn('alex'); assert(second.spec.recordID==alex.spec.recordID and clones==1 and writes==1,'one clone is reused')
  alex.combat=true; tick(2)
  assert(#active(alex)==0,'social movement still yields to native combat')
`));

test('records that already fight, or cannot be read, are never cloned; a failed clone still spawns the original',()=>run(`
  local judy=spawn('judy-alvarez'); assert(judy.spec.recordID=='Character.Judy')
  local panam=spawn('panam-palmer'); assert(panam.spec.recordID=='Character.Panam','a melee-capable record is left alone')
  assert(clones==0 and writes==0)
  local get=TweakDB.GetRecord
  function TweakDB:GetRecord(id) if id=='Character.alex' then return {IsA=function() return true end} end return get(self,id) end
  assert(spawn('alex').spec.recordID=='Character.alex','an unreadable record adapts nothing')
  assert(clones==0 and writes==0)
  TweakDB.GetRecord=get
  companions.registerDefinition('alex-two',{id='Character.alex',name='Alex',profileKey='alex'})
  local apply=TweakDB.SetFlats; TweakDB.SetFlats=function() return false end
  assert(spawn('alex-two').spec.recordID=='Character.alex','a failed write falls back to the original record')
  TweakDB.SetFlats=apply
`));
