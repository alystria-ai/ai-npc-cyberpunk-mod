import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
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
  probeLines,armedOff={},false
  io.open=function(path)
    if path=='runtime/probe.log' then
      return {write=function(_,...) probeLines[#probeLines+1]=table.concat({...}) end,close=function() end}
    end
    if path=='runtime/armed-clones-off' and armedOff then return {close=function() end} end
    return nil
  end
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

test('a second fast travel during the first recovery takes over: the pending copy keeps its receipt and still returns',()=>run(`
  local johnny=spawn('johnny-silverhand')
  local serial=companions.list()[1].serial
  assert(companions.beginFastTravel())
  entities[tonumber(johnny.id.hash)]=nil
  assert(companions.fastTravel())
  tick(1)
  local mid=companions.list()[1]
  assert(mid.state=='transit' or mid.state=='spawning', 'the copy is still on its way back: '..tostring(mid.state))
  assert(companions.beginFastTravel(), 'the second travel is not refused while the first recovery runs')
  local again=companions.list()
  assert(#again==1 and again[1].serial==serial, 'the pending copy was dropped')
  assert(companions.fastTravel())
  tick(10)
  local row=companions.list()[1]
  assert(row and row.serial==serial and row.state=='ready', 'the copy never returned: '..tostring(row and row.state))
  assert(companions.beginFastTravel() and companions.fastTravel(), 'an ordinary travel afterwards still works')
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

test('every spawn logs which record it used; a clone that cannot be created falls back to the original record',()=>run(`
  local function has(text) for _,l in ipairs(probeLines) do if l:find(text,1,true) then return true end end return false end
  spawn('judy-alvarez'); assert(has('Companion spawn record: original (already combat-capable)'),'capable original logged')
  local alex=spawn('alex'); assert(has('Companion spawn record: CyberpunkConvai.Armed_'),'clone logged')
  local sys=Game.GetDynamicEntitySystem(); local create=sys.CreateEntity
  function sys:CreateEntity(spec) if tostring(spec.recordID):find('Armed_',1,true) then error('invalid record') end return create(self,spec) end
  companions.registerDefinition('alex-three',{id='Character.alex',name='Alex',profileKey='alex'})
  local third=spawn('alex-three')
  assert(third.spec.recordID=='Character.alex','creation failure fell back to the original record')
  assert(has('the armed clone could not be created; using the original record'))
`));

test('a failed clone is logged with its reason, and runtime/armed-clones-off disables the clone without a code change',()=>run(`
  local function has(text) for _,l in ipairs(probeLines) do if l:find(text,1,true) then return true end end return false end
  armedOff=true
  assert(spawn('alex').spec.recordID=='Character.alex' and clones==0 and writes==0,'switched off: no clone is attempted')
  assert(not has('armed clone'))
  armedOff=false
  local apply=TweakDB.SetFlats; TweakDB.SetFlats=function() return false end
  companions.registerDefinition('alex-two',{id='Character.alex',name='Alex',profileKey='alex'})
  assert(spawn('alex-two').spec.recordID=='Character.alex'); assert(has('armed clone failed'),'failure logged'); assert(has('using the original record'))
  TweakDB.SetFlats=apply
`));

// Alt Cunningham's copy: a quest-base record (no abilities, no tags) gets the generic armed clone and the game's own
// invulnerable protection, asked once at attach and given back before deletion. Only her model is protected.
const altWorld = `
  records['Character.Alt']={abilities={'Ability.CanCrouch','Ability.CanSprint'},entityTemplatePath='alt.ent'}
  local god={granted={},released={},fail=false,silent=false}
  function god:AddGodMode(id,mode,source) if self.fail then error('native refused') end
    self.granted[#self.granted+1]={id=tostring(id.hash),mode=mode,source=source} end
  function god:HasGodMode(id,mode) if self.silent then return false end
    for _,g in ipairs(self.granted) do if g.id==tostring(id.hash) and g.mode==mode then return true end end return false end
  function god:RemoveGodMode(id,mode,source) self.released[#self.released+1]={id=tostring(id.hash),mode=mode,source=source} end
  Game.GetGodModeSystem=function() return god end
  companions.registerDefinition('alt-cunningham',{id='Character.Alt',name='Alt Cunningham',profileKey='alt-cunningham'})
  local function has(text) for _,l in ipairs(probeLines) do if l:find(text,1,true) then return true end end return false end
`;

test('Alt Cunningham spawns from the generic armed clone and is invulnerable once attached; the game record is untouched', () => run(altWorld + `
  local alt=spawn('alt-cunningham')
  assert(alt.spec.recordID:find('^CyberpunkConvai%.Armed_'),tostring(alt.spec.recordID))
  local clone=records[alt.spec.recordID]
  assert(clone.entityTemplatePath=='alt.ent' and clone.primaryEquipment=='chaoPool' and clone.archetypeData=='ranged')
  assert(#records['Character.Alt'].abilities==2 and not records['Character.Alt'].primaryEquipment,'the game record is untouched')
  assert(companions.list()[1].state=='ready')
  assert(#god.granted==1,'granted once, not per tick: '..#god.granted)
  assert(god.granted[1].id==tostring(alt:GetEntityID().hash) and god.granted[1].mode=='Invulnerable')
  assert(god.granted[1].source=='CyberpunkConvaiProtection')
  tick(30); assert(#god.granted==1,'no repeated calls while she follows')
  assert(has('Companion protection: invulnerable granted'))
`));

test('Alt Cunningham gives the protection back once, before her copy is deleted', () => run(altWorld + `
  local alt=spawn('alt-cunningham')
  local order={}
  companions.onBeforeRemove=function() order[#order+1]='before-remove:'..tostring(#god.released) end
  assert(companions.dismiss(companions.list()[1].serial))
  assert(#god.released==1 and god.released[1].id==tostring(alt:GetEntityID().hash) and god.released[1].mode=='Invulnerable')
  assert(order[1]=='before-remove:1','released while the entity still existed: '..tostring(order[1]))
  assert(#companions.list()==0)
`));

test('invulnerability follows the selected model, not the chat profile, and no other character gets it', () => run(altWorld + `
  local judy=spawn('judy-alvarez'); local johnny=spawn('johnny-silverhand'); local alex=spawn('alex')
  companions.registerDefinition('judy-with-alt-profile',{id='Character.Judy',name='Judy',profileKey='alt-cunningham'})
  spawn('judy-with-alt-profile')
  assert(#god.granted==0,'only the Alt model is protected: '..#god.granted)
  companions.registerDefinition('alt-browser-copy',{recordID='Character.Alt',name='Alt model',profileKey='judy-alvarez'})
  local copy=spawn('alt-browser-copy')
  assert(#god.granted==1 and god.granted[1].id==tostring(copy:GetEntityID().hash),'the Alt model is protected under any profile')
  assert(not has('Companion protection: release'))
`));

test('a refused or unconfirmed protection is logged and never stops the copy from joining', () => run(altWorld + `
  god.fail=true
  local alt=spawn('alt-cunningham')
  assert(companions.list()[1].state=='ready','she still joins')
  assert(has('Companion protection: invulnerable not granted (') and has('native refused'))
  god.fail=false; god.silent=true
  local second=spawn('alt-cunningham')
  assert(has('readback is false'),'an unconfirmed grant is reported')
  Game.GetGodModeSystem=function() return nil end
  local third=spawn('alt-cunningham')
  assert(has('no god mode system') and #companions.list()==3)
  -- Releasing is best effort: a missing system never blocks dismissal.
  assert(companions.dismiss(companions.list()[3].serial) and #companions.list()==2)
`));

test('Alt Cunningham keeps the protection after fast travel recreates her copy', () => run(altWorld + `
  local alt=spawn('alt-cunningham')
  assert(companions.beginFastTravel())
  entities[tonumber(alt.id.hash)]=nil
  assert(companions.fastTravel())
  tick(8)
  local replacement=entities[sequence]
  assert(replacement and replacement~=alt and companions.list()[1].state=='ready')
  assert(#god.granted==2 and god.granted[2].id==tostring(replacement:GetEntityID().hash),'the new copy is protected too')
`));

// Combat readiness at attach: level scaling to V and the attitude read-back (item 5 of
// docs/COMPANION_IMPROVEMENTS_2026-10-17.md).
const recordsSource = readFileSync(new URL('../mod/companion-records.lua', import.meta.url), 'utf8');
function runReadiness(code) {
  const state = lauxlib.luaL_newstate(); lualib.luaL_openlibs(state);
  const world = `
  local Records=(function() ${recordsSource} end)()
  lines={}; Records.log=function(line) lines[#lines+1]=line end
  local function logged(pattern) for _,l in ipairs(lines) do if l:find(pattern) then return l end end end
  fileExists={}
  io.open=function(path) if fileExists[path] then return {close=function() end} end end
  Enum={new=function(kind,value) return kind..'.'..value end}
  CName={new=function(v) return v end}
  NameToString=function(v) return v end
  local stats={values={},calls={}}
  function stats:GetStatValue(id,stat) self.calls[#self.calls+1]='get '..id.hash..' '..stat; return (self.values[id.hash] or {})[stat] or 0 end
  function stats:RemoveAllModifiers(id,stat) self.calls[#self.calls+1]='remove '..id.hash..' '..stat; self.values[id.hash]=self.values[id.hash] or {}; self.values[id.hash][stat]=0 end
  function stats:AddModifier(id,mod) self.calls[#self.calls+1]='add '..id.hash..' '..mod.stat..' '..mod.value
    local v=self.values[id.hash]; v[mod.stat]=(v[mod.stat] or 0)+mod.value end
  Game={GetStatsSystem=function() return stats end}
  RPGManager={CreateStatModifier=function(stat,kind,value) return {stat=stat,kind=kind,value=value} end}
  local function agent(group,towards) return {GetAttitudeGroup=function() return group end,GetAttitudeTowards=function() return towards end} end
  player={GetEntityID=function() return {hash='player'} end,GetAttitudeAgent=function() return agent('player',nil) end}
  stats.values.player={['gamedataStatType.Level']=30,['gamedataStatType.PowerLevel']=28}
  scaleCalls=0
  local function copy(opts) opts=opts or {}
    local n={GetEntityID=function() return {hash='copy'} end,
      GetAttitudeAgent=function() return agent(opts.group or 'player',opts.towards or 'EAIAttitude : AIA_Friendly (2)') end}
    if opts.manager~=false then
      n.m_NPCManager={ScaleToPlayer=function()
        scaleCalls=scaleCalls+1
        if opts.managerError then error(opts.managerError) end
        stats.values.copy={['gamedataStatType.Level']=30,['gamedataStatType.PowerLevel']=28}
      end}
    end
    stats.values.copy=stats.values.copy or {['gamedataStatType.Level']=opts.level or 7}
    return n end
  tagged=true
  system={IsTagged=function(_,id,tag) return tagged and tag=='CyberpunkConvaiCompanion' end}
  `;
  const status = lauxlib.luaL_dostring(state, to_luastring(world + code));
  const error = status === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(state, -1));
  lua.lua_close(state); assert.equal(status, lua.LUA_OK, error);
}

test('readiness: the game scales our copy to V through its NPC manager, with the level before and after logged', () => runReadiness(`
  local report=Records.prepare(system,'e1',copy(),player,'Judy')
  assert(report.scaled and report.method=='npc-manager' and report.before==7 and report.after==30,'report')
  assert(scaleCalls==1,'scaled once')
  assert(logged('Companion readiness: Judy level 7 %-> 30 %(V 30%) via npc%-manager'),table.concat(lines,'|'))
  for _,c in ipairs(stats.calls) do assert(not c:find('^add') and not c:find('^remove'),'the manager route changes no stat itself') end
`));

test('readiness: without a reachable manager the same stat calls are made directly, once', () => runReadiness(`
  local report=Records.prepare(system,'e1',copy({manager=false}),player,'Judy')
  assert(report.method=='stats' and report.after==7+30,'additive on the copy, like the game call: '..tostring(report.after))
  local adds,removes=0,0
  for _,c in ipairs(stats.calls) do if c:find('^add') then adds=adds+1 elseif c:find('^remove') then removes=removes+1 end end
  assert(adds==2 and removes==1,'PowerLevel cleared, then PowerLevel and Level added')
  assert(logged('via stats'))
  -- a manager that raises falls back the same way
  lines={}; stats.calls={}
  report=Records.prepare(system,'e1',copy({managerError='boom'}),player,'Judy')
  assert(report.method=='stats' and logged('via stats'))
`));

test('readiness: only a copy that carries our own tag is touched, and the file switch turns scaling off', () => runReadiness(`
  tagged=false
  assert(Records.prepare(system,'e1',copy(),player,'Ordinary')==nil,'not our copy: nothing')
  assert(scaleCalls==0 and #stats.calls==0 and #lines==0,'no read, no write, no log for a character that is not ours')
  tagged=true
  system.IsTagged=function() error('unreadable') end
  assert(Records.prepare(system,'e1',copy(),player,'Ordinary')==nil and scaleCalls==0,'an unreadable tag is not ours')
  system.IsTagged=function(_,id,tag) return true end
  fileExists['runtime/companion-scaling-off']=true
  local report=Records.prepare(system,'e1',copy(),player,'Judy')
  assert(scaleCalls==0 and not report.scaled and logged('scaling is switched off') and report.attitude=='ok','scaling off, the read-back still happens')
  fileExists['runtime/companion-scaling-off']=nil
  Records.scaling=false
  Records.prepare(system,'e1',copy(),player,'Judy'); assert(scaleCalls==0,'the module switch')
`));

test('readiness: the attitude read-back logs agreement, a difference once, and an unreadable answer', () => runReadiness(`
  local report=Records.prepare(system,'e1',copy(),player,'Judy')
  assert(report.attitude=='ok' and logged('attitude ok, group player %(V: player%), towards V AIA_Friendly'),table.concat(lines,'|'))
  lines={}
  report=Records.prepare(system,'e1',copy({group='Gang'}),player,'Judy')
  assert(report.attitude=='mismatch' and logged('attitude differs at attach, group Gang %(V: player%)'),table.concat(lines,'|'))
  lines={}
  report=Records.prepare(system,'e1',copy({towards='EAIAttitude : AIA_Neutral (1)'}),player,'Judy')
  assert(report.attitude=='mismatch' and logged('towards V AIA_Neutral'))
  lines={}
  local broken=copy(); broken.GetAttitudeAgent=function() error('no agent') end
  report=Records.prepare(system,'e1',broken,player,'Judy')
  assert(report.attitude=='unreadable' and logged('attitude unreadable %(.*no agent'))
  -- the one re-read
  lines={}
  assert(Records.attitudeRecheck(copy(),player,'Judy')==true and logged('attitude ok on re%-read'))
  assert(Records.attitudeRecheck(copy({group='Gang'}),player,'Judy')==false and logged('attitude MISMATCH, group Gang'))
  assert(Records.attitudeRecheck(broken,player,'Judy')==false and logged('unreadable on re%-read'))
`));

test('readiness: a failing scale is logged and never stops the attach', () => runReadiness(`
  Game.GetStatsSystem=function() error('no stats') end
  local report=Records.prepare(system,'e1',copy({manager=false}),player,'Judy')
  assert(report and not report.scaled and logged('level scaling failed %(.*no stats'),table.concat(lines,'|'))
  assert(report.attitude=='ok','the attitude is still read back')
`));

test('readiness: companions scale a copy at attach once and re-read a differing attitude once, not per frame', () => run(`
  local lines,reads,scales={}, {group=0},0
  io.open=function(path)
    if path=='runtime/probe.log' then return {write=function(_,...) lines[#lines+1]=table.concat({...}) end,close=function() end} end
    return nil
  end
  local levels={player=30,copy=7}
  Game.GetStatsSystem=function() return {GetStatValue=function(_,id) return levels[id.hash=='player' and 'player' or 'copy'] end} end
  player.GetAttitudeAgent=function() return {GetAttitudeGroup=function() return 'player' end} end
  companions.registerDefinition('readiness-judy',{id='Character.Judy',name='Judy',profileKey='judy-alvarez'})
  companions.spawn('readiness-judy')
  local npc=entities[sequence]
  npc.m_NPCManager={ScaleToPlayer=function() scales=scales+1; levels.copy=30 end}
  local group='Gang'
  function npc:GetAttitudeAgent() return {GetAttitudeGroup=function() reads.group=reads.group+1; return group end,
    GetAttitudeTowards=function() return 'EAIAttitude : AIA_Friendly (2)' end} end
  tick(1)
  assert(companions.list()[1].state=='ready','attached')
  assert(scales==1 and reads.group==1,'scaled once and read once at attach')
  local function has(pattern) for _,l in ipairs(lines) do if l:find(pattern) then return true end end end
  assert(has('Companion readiness: Judy level 7 %-> 30 %(V 30%) via npc%-manager'),table.concat(lines,'|'))
  assert(has('attitude differs at attach'))
  group='player'
  tick(1); assert(reads.group==1,'not yet: the re-read waits a second')
  tick(2); assert(reads.group==2 and has('attitude ok on re%-read'),'one re-read: '..reads.group)
  tick(40); assert(reads.group==2 and scales==1,'nothing more is read or scaled afterwards')
`));
