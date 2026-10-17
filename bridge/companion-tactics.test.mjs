import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import fengari from 'fengari';
import {companionEngine} from './companion-fixture.mjs';
import {parseTacticOffer} from './companion-actions.mjs';

const tacticsSource = readFileSync(new URL('../mod/companion-tactics.lua', import.meta.url), 'utf8');
const markingSource = readFileSync(new URL('../mod/companion-marking.lua', import.meta.url), 'utf8');
const equipmentSource = readFileSync(new URL('../mod/companion-equipment.lua', import.meta.url), 'utf8');
const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;

function run(code, globals = {}) {
  const state = lauxlib.luaL_newstate(); lualib.luaL_openlibs(state);
  const exported = [];
  lua.lua_pushjsfunction(state, L => { exported.push(to_jsstring(lua.lua_tostring(L, 1))); return 0; });
  lua.lua_setglobal(state, to_luastring('export'));
  const status = lauxlib.luaL_dostring(state, to_luastring(code));
  const error = status === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(state, -1));
  lua.lua_close(state); assert.equal(status, lua.LUA_OK, error);
  return exported;
}

// A small deterministic world: positions, life, combat and mounting are plain
// fields. The fake native layer records every effect so restoration is visible.
const world = `
json={encode=function(value)
  local function enc(v)
    local t=type(v)
    if t=='table' then
      if #v>0 or next(v)==nil and getmetatable(v)=='array' then
        local parts={};for _,item in ipairs(v) do parts[#parts+1]=enc(item) end;return '['..table.concat(parts,',')..']'
      end
      local keys={};for k in pairs(v) do keys[#keys+1]=k end;table.sort(keys)
      local parts={};for _,k in ipairs(keys) do parts[#parts+1]=string.format('%q',k)..':'..enc(v[k]) end
      return '{'..table.concat(parts,',')..'}'
    elseif t=='string' then return string.format('%q',v)
    elseif t=='boolean' then return tostring(v) elseif v==nil then return 'null'
    elseif math.type and math.type(v)=='integer' then return tostring(v)
    else return v%1==0 and string.format('%d',v) or tostring(v) end
  end
  return enc(value)
end}
local function npc(id,x,y,name) return {id=id,pos={x=x,y=y,z=0},alive=true,combat=false,name=name,hostile=false,body='Man',hand=false} end
player={id='1ULL',pos={x=0,y=0,z=0},combat=false,mounted=false}
companion=npc('44ULL',1,0,'Judy')
target=npc('77ULL',20,0,'Tyger Claw'); target.hostile=true
effects,logs={},{}
local function effect(...) effects[#effects+1]=table.concat({...},' ') end
drawError,noPrimary,drawErrorModes=nil,false,nil
reactionError=nil
native={key=function(o) return o.id end,position=function(o) return {x=o.pos.x,y=o.pos.y,z=o.pos.z} end,
  alive=function(o) return o.alive end,inCombat=function(o) return o.combat end,
  playerInCombat=function(p) return p.combat end,playerMounted=function(p) return p.mounted end,
  hostileToPlayer=function(o) return o.hostile end,name=function(o) return o.name end,bodyType=function(o) return o.body end,
  startFight=function(c,t) effect('fight-start',c.id,t.id)
    return {companionToTarget='AIA_Friendly',targetToCompanion='AIA_Hostile',
      reaction={notes={'preset Follower -> Ganger_Aggressive (read back ok)','combat start asked of the reaction component'}}} end,
  stopFight=function(r,c,t) effect('fight-stop',c.id,t.id,r.targetToCompanion) end,
  stopReaction=function(r,c) if reactionError then error(reactionError) end effect('preset-restore',c.id); return 'preset restored to Follower (read back ok)' end,
  weapon=function(c) return c.hand,c.hand and 'Items.Preset_Lexington' or nil end,
  drawWeapon=function(c,mode,item)
    if drawError and (not drawErrorModes or drawErrorModes[mode]) then error(drawError) end
    effect('draw',c.id,mode,item); return {command=effect} end,
  primaryItem=function(c) if not noPrimary then return 'Items.Preset_Malorian' end end,
  cancelDraw=function(h,c) effect('draw-cancel',c.id) end}
ready=true
env={player=function() return player end,
  actor=function(entity) if ready and entity=='44ULL' then return {serial=3,npc=companion,profileKey='judy-alvarez',name='Judy'} end end,
  marked=function() if markedTarget then return markedTarget,{id=markedTarget.id,name=markedTarget.name} end end,
  feedback=function(m) effects[#effects+1]='feedback '..m end,log=function(l) logs[#logs+1]=l end}
markedTarget=target
dofile=function(path) error('unexpected '..path) end
local Tactics=(function() ${tacticsSource} end)()
T=Tactics.new({env=env,native=native})
motion={}
-- One simulated game frame: decision, idealized movement, then the module update.
function frame(dt)
  local decision=T.decide(3,{position=companion.pos,motion=motion,combat=companion.combat},dt or 0.1)
  if decision then
    local op=decision.operation
    if op.kind=='move' and op.goal then companion.pos={x=op.goal.x,y=op.goal.y,z=0} end
  end
  T.update(player,dt or 0.1,true)
  return decision
end
function phase() return T.snapshot().phase end
function logged(pattern) for _,l in ipairs(logs) do if l:find(pattern) then return l end end end
`;

test('the fight offer matches the bridge contract and is the only kind offered', () => {
  const exported = run(world + `
  local offer=T.offer('44ULL')
  export(json.encode(offer))
  assert(T.start('fight',offer,'44ULL'),"start refused")
  assert(not T.start('distract-return',offer,'44ULL'),'there is no other tactic')
  `);
  const offer = JSON.parse(exported[0]);
  assert.deepEqual(parseTacticOffer(offer), offer, 'the Lua offer survives the strict bridge parser unchanged');
  assert.deepEqual(offer.kinds, ['fight']);
});

test('a fight engages immediately, approaches until native combat, and restores a living target', () => run(world + `
  assert(T.start('fight',T.offer('44ULL'),'44ULL'),"start refused")
  assert(effects[1]=='fight-start 44ULL 77ULL' and T.owns(3))
  assert(logged('fight accepted: Tyger Claw 77ULL'),'the start is logged with the target')
  local d=frame(); assert(d.operation.kind=='move' and d.operation.gait=='Run')
  companion.combat=true; d=frame(); assert(d.operation.kind=='release' and phase()=='fighting')
  player.mounted=true; frame()
  assert(not T.owns(3) and effects[#effects]=='fight-stop 44ULL 77ULL AIA_Hostile')
`));

test('a fight on a defeated target needs no attitude restore', () => run(world + `
  assert(T.start('fight',T.offer('44ULL'),'44ULL'),"start refused")
  companion.combat=true; frame(); frame()
  target.alive=false; frame()
  assert(not T.owns(3) and T.snapshot().last.result=='target-down')
  for _,line in ipairs(effects) do assert(not line:find('fight%-stop'),'a dead target needs no attitude restore') end
`));

test('the weapon is drawn when the fight starts and read back; an empty hand gets one more request', () => run(world + `
  assert(T.start('fight',T.offer('44ULL'),'44ULL'),"start refused")
  assert(effects[2]=='draw 44ULL switch' and logged('weapon draw requested %(switch, hand empty%)'),'the switch-to-primary command comes first')
  for _=1,8 do frame() end
  assert(not logged('readback'),'no readback before the command had time to run')
  companion.hand=true
  for _=1,4 do frame() end
  assert(logged('weapon readback: drawn %(Items.Preset_Lexington%)') and T.snapshot().weapon=='drawn')
  local before=#logs; for _=1,40 do frame() end; assert(#logs==before,'nothing more is logged once it is drawn')
`));

test('a hand that stays empty goes switch, explicit equip with the primary item, bare slot equip, then is left to the combat AI', () => run(world + `
  assert(T.start('fight',T.offer('44ULL'),'44ULL'),"start refused")
  for _=1,60 do frame() end
  local draws={}
  for _,e in ipairs(effects) do if e:find('^draw 44ULL') then draws[#draws+1]=e end end
  assert(#draws==3,'three requests, got '..#draws)
  assert(draws[1]=='draw 44ULL switch' and draws[2]=='draw 44ULL equip Items.Preset_Malorian' and draws[3]=='draw 44ULL slot',
    table.concat(draws,' | '))
  assert(logged('hand still empty, draw asked again') and logged('hand still empty, the combat AI decides'))
  assert(T.snapshot().weapon=='empty' and T.owns(3),'the fight itself goes on')
  -- Each stage replaces the one before: the old command is cancelled first.
  local cancels=0; for _,e in ipairs(effects) do if e=='draw-cancel 44ULL' then cancels=cancels+1 end end
  assert(cancels>=2,'the earlier commands were not cancelled: '..cancels)
`));

test('the explicit equip is read back after about a second and skipped when no primary item can be named', () => run(world + `
  noPrimary=true
  assert(T.start('fight',T.offer('44ULL'),'44ULL'),"start refused")
  for _=1,14 do frame() end
  local draws={}
  for _,e in ipairs(effects) do if e:find('^draw 44ULL') then draws[#draws+1]=e end end
  assert(draws[1]=='draw 44ULL switch' and draws[2]=='draw 44ULL slot' and #draws==2,table.concat(draws,' | '))
  assert(logged('weapon draw requested %(slot, hand empty%)'))
`));

test('a missing switch command falls straight through to the explicit equip', () => run(world + `
  drawError='AISwitchToPrimaryWeaponCommand is unavailable'; drawErrorModes={switch=true}
  assert(T.start('fight',T.offer('44ULL'),'44ULL'),"start refused")
  assert(effects[2]=='draw 44ULL equip Items.Preset_Malorian',tostring(effects[2]))
  assert(logged('stage switch refused') and logged('weapon draw requested %(equip, hand empty%)'))
  companion.hand=true
  for _=1,12 do frame() end
  assert(T.snapshot().weapon=='drawn' and T.owns(3))
`));

test('a weapon already in hand is not asked for; an unavailable draw never stops the fight', () => {
  run(world + `
  companion.hand=true
  assert(T.start('fight',T.offer('44ULL'),'44ULL'),"start refused")
  assert(logged('weapon already drawn %(Items.Preset_Lexington%)'))
  for _,e in ipairs(effects) do assert(not e:find('^draw 44ULL'),'no draw request over a drawn weapon') end
  `);
  run(world + `
  drawError='no such command'
  assert(T.start('fight',T.offer('44ULL'),'44ULL'),"start refused")
  assert(logged('weapon draw unavailable: .*no such command') and T.owns(3) and phase()=='fight-approach')
  `);
});

test('a pending draw command is cancelled when the fight ends', () => run(world + `
  assert(T.start('fight',T.offer('44ULL'),'44ULL'),"start refused")
  T.cancel('test')
  local seen=false; for _,e in ipairs(effects) do if e=='draw-cancel 44ULL' then seen=true end end
  assert(seen and effects[#effects]=='fight-stop 44ULL 77ULL AIA_Hostile')
`));

test('V entering a vehicle, the companion disappearing, or the fight timing out each end it cleanly', () => run(world + `
  local function begin()
    effects,logs={}, {}
    companion.pos={x=1,y=0,z=0}; companion.combat=false; target.combat=false; player.combat=false; player.mounted=false; ready=true
    assert(T.start('fight',T.offer('44ULL'),'44ULL'),"start refused")
  end
  begin(); player.mounted=true; frame(); assert(T.snapshot().last.result=='vehicle')
  begin(); ready=false; frame(); assert(T.snapshot().last.result=='companion-unavailable'); ready=true
  begin(); for _=1,260 do frame(0.1) end; assert(T.snapshot().last.result=='no-combat','no native combat in 25 s')
  begin(); companion.combat=true; for _=1,1810 do frame(0.1) end; assert(T.snapshot().last.result=='fight-timeout')
`));

test('offers need a live marked target within 100 m; stale or changed offers are refused', () => run(world + `
  markedTarget=nil; local none=T.offer('44ULL'); assert(none.available==false and none.code=='no-target','the bridge is told no target was found'); markedTarget=target
  assert(T.offer('99ULL').available==false,'only a ready managed companion')
  local offer=T.offer('44ULL'); markedTarget=nil
  local other={id='88ULL',pos={x=5,y=5,z=0},alive=true,name='Other',body='Man'}
  markedTarget=other; T.offer('44ULL')
  assert(not T.start('fight',offer,'44ULL'),'the captured target changed')
  markedTarget=target; offer=T.offer('44ULL'); target.alive=false
  assert(not T.start('fight',offer,'44ULL')); target.alive=true
  target.pos={x=99,y=0,z=0}; assert(T.offer('44ULL').available==true,'a tag at 99 m is in reach')
  target.pos={x=101,y=0,z=0}; assert(T.offer('44ULL').available==false,'beyond the tag radius')
  target.pos={x=20,y=0,z=0}; player.mounted=true; assert(T.offer('44ULL').available==false,'not from a vehicle')
`));

test('a fight that cannot start leaves nothing behind', () => run(world + `
  native.startFight=function() error('threat refused') end
  local ok,message=T.start('fight',T.offer('44ULL'),'44ULL')
  assert(ok==false and message:find('could not engage') and not T.owns(3) and logged('fight start failed: .*threat refused'))
  assert(T.snapshot().last.result=='fight-unavailable')
`));

test('the reaction start is logged with the fight and the preset goes back with the attitudes', () => run(world + `
  assert(T.start('fight',T.offer('44ULL'),'44ULL'),"start refused")
  assert(logged('reaction: preset Follower %-> Ganger_Aggressive %(read back ok%)') and logged('reaction: combat start asked of the reaction component'))
  companion.combat=true; frame(); frame()
  player.mounted=true; frame()
  assert(logged('reaction: preset restored to Follower %(read back ok%)'),'the restore is logged')
  local restore,stop
  for i,e in ipairs(effects) do if e=='preset-restore 44ULL' then restore=i end; if e:find('^fight%-stop') then stop=i end end
  assert(restore and stop and restore<stop,'both are given back, the preset first')
`));

test('a defeated target still gets the companion her preset back; a missing companion gets no native call', () => {
  run(world + `
  assert(T.start('fight',T.offer('44ULL'),'44ULL'),"start refused")
  companion.combat=true; frame(); frame()
  target.alive=false; frame()
  assert(T.snapshot().last.result=='target-down')
  local restored=false
  for _,e in ipairs(effects) do if e=='preset-restore 44ULL' then restored=true end; assert(not e:find('^fight%-stop')) end
  assert(restored,'the preset is restored although there is no target to restore')
  `);
  run(world + `
  assert(T.start('fight',T.offer('44ULL'),'44ULL'),"start refused")
  companion.alive=false; T.cancel('gone')
  for _,e in ipairs(effects) do assert(e~='preset-restore 44ULL','a gone companion is not touched') end
  `);
});

test('a cancelled fight and a failed preset restore never leave the tactic active', () => run(world + `
  assert(T.start('fight',T.offer('44ULL'),'44ULL'),"start refused")
  T.cancel('cancelled')
  assert(not T.owns(3) and effects[#effects]=='fight-stop 44ULL 77ULL AIA_Hostile')
  local restores=0; for _,e in ipairs(effects) do if e=='preset-restore 44ULL' then restores=restores+1 end end
  assert(restores==1,'restored exactly once')
  effects,logs={}, {}
  reactionError='component gone'
  assert(T.start('fight',T.offer('44ULL'),'44ULL'),"start refused")
  T.cancel('cancelled')
  assert(not T.owns(3) and logged('reaction: preset restore failed: .*component gone'),'the failure is logged')
  assert(effects[#effects]=='fight-stop 44ULL 77ULL AIA_Hostile','the attitudes are still given back')
`));

test('world teardown forgets every handle without native calls', () => run(world + `
  assert(T.start('fight',T.offer('44ULL'),'44ULL'),"start refused")
  frame(); frame()
  local before=#effects
  T.abandon()
  assert(not T.owns(3) and #effects==before)
`));

const markingWorld = `
local Marking=(function() ${markingSource} end)()
local function npc(id,x,name,facts) return {id=id,pos={x=x,y=0,z=0},valid=true,name=name,tagged=false,facts=facts or {ganger=true}} end
player={pos={x=0,y=0,z=0}}
judy=npc('44ULL',2,'Judy',{companion=true}); ganger=npc('77ULL',20,'Tyger Claw',{ganger=true,hostile=true}); other=npc('78ULL',25,'Valentino',{ganger=true})
civilian=npc('90ULL',4,'Passerby',{civilian=true}); crowd=npc('91ULL',5,'Crowd',{crowd=true,armed=true})
cop=npc('92ULL',30,'NCPD Officer',{police=true,friendly=true}); guard=npc('93ULL',40,'Arasaka Guard',{armed=true})
ally=npc('94ULL',6,'Rogue',{ganger=true,friendly=true}); scripted=npc('95ULL',7,'Scene Ganger',{ganger=true,story=true})
immortal=npc('96ULL',8,'Boss',{ganger=true,invulnerable=true}); clerk=npc('97ULL',9,'Clerk',{})
drone=npc('98ULL',45,'Security Drone',{machine=true}); far=npc('99ULL',48,'Far Ganger')
world,aimed,logs={judy,ganger,other,civilian,crowd,cop,guard,ally,scripted,immortal,clerk,drone,far},nil,{}
tagReads={}
native={aimed=function() return aimed end,key=function(o) return o.id end,valid=function(o) return o.valid end,
  position=function(o) return o.pos end,name=function(o) return o.name end,
  tagRead=function(o) if o.tagError then error(o.tagError) end tagReads[#tagReads+1]=o.id; return o.tagged,'IsTaggedinFocusMode' end,
  hostile=function(o) return o.facts.hostile==true end,
  nearby=function(_,radius) local r={} for _,o in ipairs(world) do if o.pos.x<=radius then r[#r+1]=o end end return r end,
  facts=function(o) return o.facts end}
function newMarking(extra)
  local options={native=native,owned=function(o) return o==judy end,log=function(l) logs[#logs+1]=l end}
  for k,v in pairs(extra or {}) do options[k]=v end
  return Marking.new(options)
end
K=newMarking()
function logged(pattern) for _,l in ipairs(logs) do if l:find(pattern) then return l end end end
`;

test('target: the verdict needs positive combat evidence and rejects civilians, children, vendors, invulnerable, story, friendly non-police and companions', () => run(`
  local Marking=(function() ${markingSource} end)()
  local V=Marking.verdict
  for _,kind in ipairs({'ganger','police','cyberpsycho','machine','armed'}) do local f={} f[kind]=true; assert(V(f)==true,kind) end
  assert(V({})==false and select(2,V({}))=='not-combat-capable' and V(nil)==false)
  for _,kind in ipairs({'companion','civilian','children','vendor','invulnerable','story'}) do
    local f={ganger=true,armed=true} f[kind]=true; local ok,reason=V(f); assert(ok==false and reason==(kind=='story' and 'story-controlled' or kind),kind)
  end
  assert(V({ganger=true,friendly=true})==false and select(2,V({ganger=true,friendly=true}))=='friendly')
  assert(V({police=true,friendly=true})==true,'friendly-attitude police stay targets')
  local ok,reason=V({crowd=true,ganger=true}); assert(ok==false and reason=='crowd','a crowd NPC is refused unless explicitly aimed at')
  assert(V({crowd=true,ganger=true},true)==true,'an aimed crowd gang member is a target')
  assert(V({crowd=true,armed=true},true)==true and V({crowd=true,hostile=true},true)==true)
  ok,reason=V({crowd=true},true); assert(ok==false and reason=='not-combat-capable','a plain crowd NPC is no target')
  assert(V({hostile=true})==true,'anyone already hostile to V counts as a combatant')
  assert(V({hostile=true,civilian=true})==false,'a hostile civilian is still a civilian when aimed at')
`));

test('target: a tagged NPC needs no combat evidence, but never a companion, child, vendor, invulnerable or friendly NPC', () => run(`
  local Marking=(function() ${markingSource} end)()
  local V=Marking.taggedVerdict
  for _,f in ipairs({{},{civilian=true},{crowd=true},{civilian=true,crowd=true},{police=true,friendly=true},{vendor=false}}) do
    local ok,reason=V(f); assert(ok==true and reason=='tagged',reason) end
  for _,kind in ipairs({'companion','children','vendor','invulnerable'}) do
    local f={civilian=true,hostile=true,combat=true} f[kind]=true; local ok,reason=V(f); assert(ok==false and reason==kind,kind) end
  local ok,reason=V({friendly=true}); assert(ok==false and reason=='friendly')
  -- named or story-controlled: never, whatever they are doing (a fight with one can break a quest)
  ok,reason=V({civilian=true},true); assert(ok==false and reason=='story-character')
  ok,reason=V({story=true}); assert(ok==false and reason=='story-controlled')
  ok,reason=V({story=true,hostile=true,combat=true}); assert(ok==false and reason=='story-controlled','hostile and fighting is no exception')
  ok,reason=V({civilian=true,hostile=true,combat=true},true); assert(ok==false and reason=='story-character','a named hostile fighter')
  assert(V(nil)==true)
  -- the ranking tier: hostile or fighting, then able to fight, then anyone else
  local T=Marking.tier
  local tier,name=T({hostile=true}); assert(tier==1 and name=='hostile')
  assert(T({combat=true})==1 and T({civilian=true,hostile=true})==1,'a hostile civilian still fights back')
  tier,name=T({ganger=true}); assert(tier==2 and name=='fighter')
  for _,kind in ipairs({'police','cyberpsycho','machine','armed'}) do local f={} f[kind]=true; assert(T(f)==2,kind) end
  assert(T({civilian=true,armed=true})==3 and T({})==3 and T(nil)==3,'a civilian or a bystander is the last choice')
`));

test('target: a lone tagged NPC is the target, even a civilian, beyond the crosshair and beyond 50 m, and over nearer enemies', () => run(markingWorld + `
  aimed=ganger; civilian.tagged=true
  local current,info=K.current(player)
  assert(current==civilian and info.source=='tagged' and info.id=='90ULL' and info.distance==4,'a lone tagged civilian is the target')
  assert(info.why=='the only valid tag' and logged('because the only valid tag'),'the reason is logged')
  civilian.tagged=false; other.tagged=true; current,info=K.current(player); assert(current==other and info.source=='tagged' and info.distance==25)
  other.tagged=false; guard.tagged=true; current,info=K.current(player); assert(current==guard and info.source=='tagged')
  guard.tagged=false; cop.tagged=true; current,info=K.current(player); assert(current==cop and info.source=='tagged','a tagged cop counts')
  cop.tagged=false; clerk.tagged=true; current,info=K.current(player); assert(current==clerk and info.source=='tagged','a tagged neutral passer-by with no combat evidence')
  clerk.tagged=false; far.tagged=true; far.pos={x=95,y=0,z=0}; current,info=K.current(player); assert(current==far and info.source=='tagged' and info.distance==95,'a tag at 95 m is seen')
  far.pos={x=101,y=0,z=0}; current,info=K.current(player); assert(current~=far and info.source=='aimed','tags beyond 100 m are ignored')
`));

test('target: a tagged crowd NPC is taken before the crosshair; companions, children, vendors, invulnerable and friendly NPCs are never taken', () => run(markingWorld + `
  crowd.facts={crowd=true}; crowd.tagged=true; aimed=ganger
  local current,info=K.current(player); assert(current==crowd and info.source=='tagged' and info.name=='Crowd','a plain crowd NPC V tagged')
  crowd.tagged=false
  local cases={{judy,'companion'},{ally,'friendly'},{immortal,'invulnerable'}}
  for _,case in ipairs(cases) do
    case[1].tagged=true; current,info=K.current(player)
    assert(current~=case[1] and info.source=='aimed',case[2]); case[1].tagged=false
  end
  civilian.facts={civilian=true,children=true}; civilian.tagged=true; current,info=K.current(player); assert(current~=civilian,'children'); civilian.tagged=false
  civilian.facts={civilian=true,vendor=true}; civilian.tagged=true; current,info=K.current(player); assert(current~=civilian,'vendor')
  assert(logged('tagged Passerby rejected: vendor %[civilian%+vendor%]'),logs[#logs])
`));

test('target: a named, quest-bound or scene-controlled NPC is never tagged-targetable, hostile and fighting or not', () => run(markingWorld + `
  local storyChar=civilian
  K=newMarking({protected=function(o) return o==storyChar end})
  storyChar.tagged=true; scripted.tagged=true; aimed=ganger
  local current,info=K.current(player)
  assert(current==ganger and info.source=='aimed','a protected tagged NPC is skipped: '..tostring(info and info.name))
  assert(logged('tagged Passerby rejected: story%-character') and logged('tagged Scene Ganger rejected: story%-controlled'))
  storyChar.facts={civilian=true,hostile=true}; current=K.current(player); assert(current~=storyChar,'hostile but not fighting')
  storyChar.facts={civilian=true,hostile=true,combat=true}; scripted.facts={ganger=true,story=true,hostile=true,combat=true}
  current,info=K.current(player)
  assert(current~=storyChar and current~=scripted and info.source=='aimed','a story character already fighting V is still no target')
  -- an erroring predicate counts as not protected: targeting still works
  K=newMarking({protected=function() error('native') end}); storyChar.facts={civilian=true}; assert(K.current(player)~=nil)
`));

test('target: an unreadable tag is logged and never stops targeting', () => run(markingWorld + `
  civilian.tagError='no such method'; aimed=other
  local current,info=K.current(player)
  assert(current==other and info.source=='aimed','the aimed NPC is used when a tag cannot be read')
  local line=logged('Tactic candidates'); assert(line,'candidates line')
  assert(line:find('1 tag reads failed %(no such method%)') and line:find('Passerby 4m tag=err'),line)
  civilian.tagError=nil; ganger.tagError='x'; civilian.tagged=true; current=K.current(player); assert(current==civilian,'other tags still count')
  native.tagRead=function() error('all readers fail') end
  current,info=K.current(player); assert(info.source=='aimed' and logged('13 tag reads failed'),'every read failing falls back to aimed')
  native.tagRead=nil; native.tagged=function(o) return o==guard end
  current,info=K.current(player); assert(current==guard and info.source=='tagged','a plain boolean tag reader still works')
  native.tagged=function() return 'yes' end; current,info=K.current(player); assert(info.source=='aimed' and logged('returned string'))
`));

test('target: the candidates line lists the tagged and unreadable NPCs first, then the nearest, with each tag state', () => run(markingWorld + `
  far.tagged=true; far.pos={x=95,y=0,z=0}; ganger.tagError='boom'
  K.current(player)
  local line=assert(logged('Tactic candidates'))
  assert(line:find('^Tactic candidates: 13 NPCs within 100m, 1 tagged, 1 tag reads failed %(boom%), via IsTaggedinFocusMode; '),line)
  assert(line:find('Far Ganger 95m tag=yes') and line:find('Tyger Claw 20m tag=err') and line:find('Judy 2m tag=no'),line)
  local count=0; for _ in line:gmatch('tag=') do count=count+1 end
  assert(count==6,'at most six NPCs are listed, got '..count)
  assert(line:find('Far Ganger') < line:find('Judy'),'the tagged NPC is listed before the nearest ones')
  local one=#logs; K.current(player); local lines=0; for _,l in ipairs(logs) do if l:find('Tactic candidates') then lines=lines+1 end end
  assert(lines==2,'one candidates line per request')
`));

test('target: untagged falls back to an aimed NPC with combat evidence within 30 m, else the closest NPC hostile to V', () => run(markingWorld + `
  aimed=other; local current,info=K.current(player); assert(current==other and info.source=='aimed' and info.name=='Valentino')
  aimed=guard; current,info=K.current(player); assert(current==ganger and info.source=='nearest','aimed beyond 30 m falls to the closest hostile')
  aimed=civilian; current,info=K.current(player); assert(current==ganger and info.source=='nearest','an aimed civilian is skipped')
  aimed=judy; current,info=K.current(player); assert(current==ganger and info.source=='nearest','a companion is never aimed at')
  aimed=nil; guard.facts={armed=true,hostile=true}; ganger.valid=false; current,info=K.current(player)
  assert(current==guard and info.source=='nearest' and info.distance==40,'the next hostile NPC, though not the closest NPC')
  guard.valid=false; current,info=K.current(player); assert(current==nil and info==nil,'armed or gang NPCs that are not hostile are not guessed')
  assert(K.current(nil)==nil)
`));

test('target: the nearest-NPC step needs hostility to V, within 50 m, and skips companions and story characters', () => run(markingWorld + `
  aimed=nil
  ganger.facts={ganger=true}; other.facts={ganger=true}
  local current,info=K.current(player); assert(current==nil,'armed and gang NPCs that are not hostile are not guessed')
  far.facts={ganger=true,hostile=true}; far.pos={x=48,y=0,z=0}; current,info=K.current(player); assert(current==far and info.source=='nearest')
  far.pos={x=51,y=0,z=0}; current,info=K.current(player); assert(current==nil,'hostile but beyond 50 m')
  scripted.facts={ganger=true,hostile=true,story=true}; current=K.current(player); assert(current==nil,'story-controlled hostile')
  K=newMarking({protected=function(o) return o==ganger end}); ganger.facts={ganger=true,hostile=true}
  current=K.current(player); assert(current==nil,'a protected NPC is never the nearest guess')
  crowd.facts={crowd=true,hostile=true}; current,info=K.current(player); assert(current==crowd and info.source=='nearest','a hostile crowd NPC is evidence enough')
  local reads=#tagReads; K.current(player); assert(#tagReads-reads==13,'one tag read per NPC found')
`));

test('target: the choice is logged with what was skipped, and unreadable natives never raise', () => run(markingWorld + `
  civilian.tagged=true; civilian.facts={civilian=true,vendor=true}
  K.current(player); local line=logs[#logs]
  assert(line:find('Tactic target: nearest Tyger Claw 77ULL') and line:find('vendor=1') and line:find('tagged Passerby rejected: vendor'),line)
  native.facts=function() error('native') end; local current,info=K.current(player)
  assert(current==nil and logs[#logs]:find('none') and logs[#logs]:find('unreadable'))
  native.nearby=function() error('native') end; assert(K.current(player)==nil)
  K.abandon()
`));

test('target: a tagged NPC the targeting search never reports is found through the game tagged list (the live failure)', () => run(markingWorld + `
  -- 2026-10-17 live: five requests found only the companion; the tagged gang member was never a candidate.
  native.nearby=function() return {judy} end
  native.taggedList=function() return {ganger} end
  aimed=judy; ganger.tagged=true
  local current,info=K.current(player)
  assert(current==ganger and info.source=='tagged' and info.id=='77ULL' and info.distance==20,'the tagged NPC is the target')
  assert(logged('Tactic candidates: 2 NPCs within 100m, 1 tagged.*tag list 1 %(1 missed by the search, 0 beyond 100m%)'),table.concat(logs,'|'))
  assert(logged('Tyger Claw 20m tag=yes'),'it is listed with its tag state')
  assert(logged('Tactic target: tagged Tyger Claw 77ULL at 20m'))
`));

test('target: with many NPCs about and one tagged, the tag list picks it; stale, far, unreadable and ineligible entries are handled', () => run(markingWorld + `
  local function make(id,x,name,facts) local o=npc(id,x,name,facts); return o end
  native.nearby=function(_,radius) local r={} for _,o in ipairs(world) do if o.pos.x<=radius and o~=ganger then r[#r+1]=o end end return r end
  -- the search reports twelve NPCs but not the tagged ganger, who is only on the tag list
  ganger.tagged=true
  local stale=make('201ULL',30,'Stale Ganger',{ganger=true}); stale.tagged=false
  local beyond=make('202ULL',150,'Distant Ganger',{ganger=true}); beyond.tagged=true
  local unreadable=make('203ULL',35,'Unreadable Tag',{ganger=true}); unreadable.tagError='no such method'
  native.taggedList=function() return {stale,beyond,judy,ganger} end
  aimed=nil
  local current,info=K.current(player)
  assert(current==ganger and info.source=='tagged','the one valid tagged NPC wins: '..tostring(info and info.name))
  assert(logged('tag list 4 %(2 missed by the search, 1 beyond 100m%)'),table.concat(logs,'|'))
  assert(not logged('Stale Ganger.-tag=yes'),'a read that says no outweighs a stale list entry')
  -- take the valid one away: the unreadable entry is trusted from the list, the companion and the stale one never
  logs={}
  ganger.tagged=false
  native.taggedList=function() return {stale,judy,unreadable} end
  current,info=K.current(player)
  assert(current==unreadable and info.source=='tagged','an unreadable tag read is settled by the list')
  -- only a companion and a stale entry are tagged: nothing tagged is valid, the aimed and nearest steps follow
  logs={}
  native.taggedList=function() return {stale,judy} end
  aimed=nil; other.facts.hostile=true; other.pos={x=25,y=0,z=0}
  current,info=K.current(player)
  assert(info and info.source=='nearest','no valid tag, so the nearest hostile follows: '..table.concat(logs,'|'))
`));

test('target: an unreadable tag list is logged and the search alone still works; a companion under the crosshair never blocks an NPC beside her', () => run(markingWorld + `
  native.taggedList=function() error('blackboard unavailable') end
  ganger.tagged=true
  local current,info=K.current(player)
  assert(current==ganger and info.source=='tagged','the search still supplies the tagged NPC')
  assert(logged('tag list unreadable %(.*blackboard unavailable'),table.concat(logs,'|'))
  -- the look-at lands on her; the ganger is a little to the side of the crosshair
  ganger.tagged=false; aimed=judy
  native.crosshair=function() return {x=0,y=0,z=0},{x=0,y=1,z=0} end
  ganger.pos={x=1,y=20,z=-1}
  current,info=K.current(player)
  assert(current==ganger and info.source=='aimed','skipped the companion and aimed along the crosshair')
`));

test('target: when the look-at lands on a companion, the eligible NPC on the crosshair line is chosen', () => run(markingWorld + `
  aimed=judy
  native.crosshair=function() return {x=0,y=0,z=1.7},{x=0,y=1,z=0} end
  ganger.pos={x=3,y=20,z=0}; crowd.facts={crowd=true,ganger=true}; crowd.pos={x=0.1,y=6,z=0}
  native.nearby=function(_,radius) local r={} for _,o in ipairs(world) do if math.abs(o.pos.x)+math.abs(o.pos.y)<=radius then r[#r+1]=o end end return r end
  local current,info=K.current(player); assert(current==crowd and info.source=='aimed','the closest to the line wins, crowd included: '..tostring(info and info.name))
  assert(logged('aimed%-companion=1'))
  crowd.facts={crowd=true,civilian=true}; current,info=K.current(player)
  assert(current==ganger and info.source=='aimed','the crowd civilian is skipped')
  ganger.pos={x=8,y=20,z=0}; current,info=K.current(player)
  assert(info.source=='nearest' or current==nil,'outside the cone nothing is aimed at')
  native.crosshair=function() error('native') end; current,info=K.current(player); assert(current==nil or info.source=='nearest')
  native.crosshair=function() return nil end; current,info=K.current(player); assert(current==nil or info.source=='nearest')
`));

test('target: the native tag reader tries each method and reports which one answered', () => run(`
  local Marking=(function() ${markingSource} end)()
  local N=Marking.nativeAdapter()
  local calls={}
  local first={IsTaggedinFocusMode=function() calls[#calls+1]='a' return true end}
  local value,how=N.tagRead(first); assert(value==true and how=='IsTaggedinFocusMode')
  local second={IsTaggedInFocusMode=function() calls[#calls+1]='b' return false end}
  value,how=N.tagRead(second); assert(value==false and how=='IsTaggedInFocusMode','the second spelling answers when the first does not exist')
  local broken={IsTaggedinFocusMode=function() error('boom') end,IsTaggedInFocusMode=function() return 7 end}
  local ok,err=pcall(N.tagRead,broken); assert(not ok and tostring(err):find('returned number'),tostring(err))
  ok,err=pcall(N.tagRead,{}); assert(not ok and tostring(err):find('attempt to call'),tostring(err))
`));

test('the native tagged list reads the game blackboard once per call and keeps only NPCs', () => run(`
  local Marking=(function() ${markingSource} end)()
  local N=Marking.nativeAdapter()
  local reads=0
  local defs={TaggedObjectsList={taggedObjectsList='taggedObjectsList'}}
  local npcA,npcB={IsNPC=function() return true end},{IsNPC=function() return true end}
  local device={IsNPC=function() return false end}
  local held=nil
  Game={GetAllBlackboardDefs=function() return defs end,
    GetBlackboardSystem=function() return {Get=function(_,board) assert(board==defs.TaggedObjectsList)
      return {GetVariant=function(_,field) assert(field=='taggedObjectsList'); reads=reads+1; return held end} end} end}
  FromVariant=function(v) return v end
  held={npcA,device,npcB}
  local list=N.taggedList()
  assert(#list==2 and list[1]==npcA and list[2]==npcB and reads==1,'NPCs only, one read')
  held=nil; assert(#N.taggedList()==0,'an empty variant is an empty list')
  Game.GetBlackboardSystem=function() error('no blackboard') end
  assert(not pcall(N.taggedList),'an unreadable board raises, so the caller can log it')
`));

test('companions hand exactly one owned copy to the tactic decision and resume following afterwards', () => run(`${companionEngine}
  local npc=spawn(); tick(3)
  local owned,decisions=true,0
  companions.tactics={owns=function(serial) return owned end,
    decide=function(serial,context) decisions=decisions+1
      return {phase='tactic-approach',operation={ticket='tactic-1-1',kind='move',goal={x=0,y=30,z=0},gait='Walk',finish=true},look='none'} end}
  tick(2)
  assert(decisions>0,'the tactic decided for its copy')
  local route=last(npc,'AIMoveToCommand'); assert(route,'the actuator issued the tactic move')
  assert(route.movementTarget.position.y>5,'toward the tactic goal, not the follow slot')
  local actor=companions.readyActor(tostring(npc:GetEntityID().hash))
  assert(actor and actor.npc==npc and actor.serial)
  owned=false; tick(3)
  local count=decisions; tick(2); assert(decisions==count,'released copies return to the follower behavior')
`));

test('the native body type is the plain name, not the CName hash form', () => {
  run(`
    local Tactics=(function() ${tacticsSource} end)()
    local N=Tactics.nativeAdapter()
    local raw='ToCName{ hash_lo = 0x02871D38, hash_hi = 0xA1219CE9 --[[ WomanAverage --]] }'
    local cname=setmetatable({}, {__tostring=function() return raw end})
    NameToString=nil
    assert(N.bodyType({GetBodyType=function() return cname end})=='WomanAverage', 'comment name')
    NameToString=function() return 'ManBig' end
    assert(N.bodyType({GetBodyType=function() return cname end})=='ManBig', 'NameToString')
    assert(N.bodyType({GetBodyType=function() return nil end})=='', 'none')
  `);
});

test('the native weapon draw sends the switch-to-primary command, an explicit equip or the slot equip, and is cancelled only while running', () => run(`
  dofile=function(path) assert(path=='companion-equipment.lua'); return (function() ${equipmentSource} end)() end
  local Tactics=(function() ${tacticsSource} end)()
  local N=Tactics.nativeAdapter()
  local sent,stateText,stopped,classes={},'AICommandState : Executing (2)',{},{}
  NewObject=function(class) classes[#classes+1]=class; return {} end
  TweakDBID={new=function(name) return name end}
  local ai={SendCommand=function(_,c) sent[#sent+1]=c; return true end,GetCommandState=function() return stateText end,
    StopExecutingCommand=function() stopped[#stopped+1]='stop' end,CancelCommand=function() stopped[#stopped+1]='cancel' end}
  local npc={GetAIControllerComponent=function() return ai end}
  -- Default: the game's switch-to-primary command with unequip off.
  local handle=N.drawWeapon(npc)
  assert(classes[1]=='AISwitchToPrimaryWeaponCommand' and sent[1].unEquip==false and sent[1].slotId==nil)
  -- Explicit equip: the item, the right-hand slot and a 1 s duration.
  N.drawWeapon(npc,'equip','Items.Preset_Malorian')
  assert(classes[2]=='AIEquipCommand' and sent[2].itemId=='Items.Preset_Malorian' and sent[2].durationOverride==1
    and sent[2].slotId=='AttachmentSlots.WeaponRight')
  assert(not pcall(N.drawWeapon,npc,'equip'),'an equip with no item raises')
  -- Last resort: the bare right-hand slot equip.
  N.drawWeapon(npc,'slot')
  assert(sent[3].slotId=='AttachmentSlots.WeaponRight' and sent[3].itemId==nil and sent[3].failIfItemNotFound==false)
  sent={}
  N.cancelDraw(handle,npc); assert(stopped[1]=='stop')
  stateText='AICommandState : Enqueued (0)'; N.cancelDraw(handle,npc); assert(stopped[2]=='cancel')
  stateText='AICommandState : Success (3)'; N.cancelDraw(handle,npc); assert(#stopped==2,'a finished command is left alone')
  ai.SendCommand=function() return false end
  assert(not pcall(N.drawWeapon,npc),'a refused command raises')
  NewObject=function() return nil end
  assert(not pcall(N.drawWeapon,npc),'a class the game does not have raises')
  -- primary item: the first real weapon the copy carries
  WeaponObject={IsFists=function(id) return id=='fists' end}
  ItemID={GetTDBID=function(id) return 'Items.'..id end}
  RPGManager={IsItemWeapon=function(id) return id~='shard' end}
  local function data(id) return {GetID=function() return id end} end
  Game={GetTransactionSystem=function() return {GetItemList=function() return true,{data('shard'),data('fists'),data('Malorian'),data('Lexington')} end} end}
  assert(N.primaryItem(npc)=='Items.Malorian')
  Game={GetTransactionSystem=function() return {GetItemList=function() return true,{data('shard')} end} end}
  assert(N.primaryItem(npc)==nil,'no weapon carried: nothing to name')
  -- readback
  ScriptedPuppet={GetWeaponRight=function(n) return n.weapon end}
  WeaponObject={IsFists=function(id) return id=='fists' end}
  ItemID={GetTDBID=function(id) return 'Items.'..id end}
  local function item(id) return {GetItemID=function() return id end} end
  assert(N.weapon({weapon=nil})==false and N.weapon({weapon=item('fists')})==false)
  local drawn,record=N.weapon({weapon=item('Preset_Lexington')}); assert(drawn==true and record=='Items.Preset_Lexington')
`));

// The native adapter's reaction steps against a fake of the game objects they call.
const reactionWorld = `
  local Tactics=(function() ${tacticsSource} end)()
  local N=Tactics.nativeAdapter()
  local order={}
  local function id(name) return {name=name} end
  local presets={}
  local function preset(name,aggressive) local p={name=name,aggressive=aggressive,id=id(name)}
    function p:EnumName() return self.name end; function p:IsAggressive() return self.aggressive end; function p:GetID() return self.id end
    presets[name]=p; presets[p.id]=p; return p end
  preset('Follower',false); preset('Ganger_Aggressive',true)
  TweakDBID={new=function(name) return name end}
  TweakDBInterface={GetReactionPresetRecord=function(key) return presets[key] or presets[(tostring(key):gsub('^ReactionPresets%.',''))] end,
    GetAIThreatPersistenceSourceRecord=function() return nil end}
  TweakDB={GetRecords=function() local all={}; for key,p in pairs(presets) do if type(key)=='string' then all[#all+1]=p end end; return all end}
  NameToString=function(v) return v end
  Enum={new=function(_,v) return v end}
  AIActionHelper={TryStartCombatWithTarget=function(c,t) order[#order+1]='helper'; return helperResult~=false end}
  helperResult=true
  local function agent(name) local a={name=name,attitude='AIA_Friendly'}
    function a:GetAttitudeTowards(o) return self.attitude end
    function a:SetAttitudeTowards(o,v) order[#order+1]=name..'-attitude-'..v; self.attitude=v end
    return a end
  local function component(start) local c={current=presets.Follower}
    function c:GetReactionPreset() return self.current end
    function c:SetReactionPreset(p) order[#order+1]='preset-'..p.name; self.current=p end
    function c:TriggerCombat(t) order[#order+1]='trigger'; if triggerError then error(triggerError) end end
    return c end
  local function puppet(name) local n={name=name,agent=agent(name),reaction=component(),civilian=false}
    function n:GetAttitudeAgent() return self.agent end
    function n:GetStimReactionComponent() return self.reaction end
    function n:IsCharacterCivilian() return self.civilian end
    function n:GetWorldPosition() return {x=0,y=0,z=0} end
    function n:GetTargetTrackerComponent() return {AddThreat=function() order[#order+1]='threat' end,SetThreatPersistence=function() end} end
    return n end
  companion,target=puppet('companion'),puppet('target')
`;

test('the adapter raises an aggressive preset, starts combat last through the reaction component, and restores the preset', () => run(reactionWorld + `
  local receipt=N.startFight(companion,target)
  assert(companion.reaction.current.name=='Ganger_Aggressive')
  assert(order[1]=='preset-Ganger_Aggressive' and order[#order]=='trigger','preset first, the combat start after attitudes and threat: '..table.concat(order,','))
  local joined=table.concat(receipt.reaction.notes,'|')
  assert(joined:find('preset Follower %-> Ganger_Aggressive %(read back ok%)') and joined:find('combat start asked of the reaction component'),joined)
  assert(N.stopReaction(receipt,companion):find('preset restored to Follower %(read back ok%)'))
  assert(companion.reaction.current.name=='Follower','the earlier preset is back')
  N.stopFight(receipt,companion,target)
  assert(companion.agent.attitude=='AIA_Friendly' and target.agent.attitude=='AIA_Friendly','attitudes back as before')
`));

test('the adapter leaves a preset the game changed since, and one it could not raise, alone', () => run(reactionWorld + `
  local receipt=N.startFight(companion,target)
  preset('Sleep',false); companion.reaction.current=presets.Sleep
  local text=N.stopReaction(receipt,companion)
  assert(text:find('left as the game set it %(Sleep%)') and companion.reaction.current.name=='Sleep')
  -- already aggressive: nothing raised, nothing to restore
  companion.reaction.current=presets.Ganger_Aggressive; order={}
  receipt=N.startFight(companion,target)
  assert(table.concat(receipt.reaction.notes,'|'):find('already aggressive') and N.stopReaction(receipt,companion)==nil)
  for _,o in ipairs(order) do assert(not o:find('^preset%-'),'no preset call') end
  -- no aggressive preset in the install: the preset is kept, combat is still asked for
  presets.Ganger_Aggressive=nil; presets[id]=nil
  companion.reaction.current=presets.Follower; order={}
  receipt=N.startFight(companion,target)
  assert(table.concat(receipt.reaction.notes,'|'):find('no aggressive preset found') and companion.reaction.current.name=='Follower' and order[#order]=='trigger')
`));

test('the adapter falls back to an aggressive combat preset by name and skips civilian and police presets', () => run(reactionWorld + `
  presets.Ganger_Aggressive=nil
  preset('Civilian_Aggressive',true); preset('Police_Aggressive',true); preset('Zeta_Aggressive',true); preset('Alpha_Aggressive',true)
  local receipt=N.startFight(companion,target)
  assert(companion.reaction.current.name=='Alpha_Aggressive','the first by name that is not civilian or police: '..companion.reaction.current.name)
  N.stopReaction(receipt,companion); assert(companion.reaction.current.name=='Follower')
`));

test('a failed combat start or preset change is noted and never stops the fight; a civilian record uses the game helper', () => {
  run(reactionWorld + `
  triggerError='no such method'
  local receipt=N.startFight(companion,target)
  assert(table.concat(receipt.reaction.notes,'|'):find('combat start failed: .*no such method'),'noted')
  assert(companion.reaction.current.name=='Ganger_Aggressive','the preset stays set so the receipt can restore it')
  assert(N.stopReaction(receipt,companion):find('restored'))
  triggerError=nil
  companion.reaction.SetReactionPreset=function() error('private') end
  receipt=N.startFight(companion,target)
  assert(table.concat(receipt.reaction.notes,'|'):find('preset change failed: .*private') and order[#order]=='trigger','combat still asked for')
  assert(N.stopReaction(receipt,companion)==nil,'nothing was raised, so nothing is restored')
  companion.GetStimReactionComponent=function() return nil end
  receipt=N.startFight(companion,target)
  assert(table.concat(receipt.reaction.notes,'|'):find('reaction component unavailable'),'attitudes alone remain')
  `);
  run(reactionWorld + `
  companion.civilian=true
  local receipt=N.startFight(companion,target)
  assert(order[#order]=='helper' and not table.concat(order,','):find('trigger'),table.concat(order,','))
  assert(table.concat(receipt.reaction.notes,'|'):find('directly %(civilian record%)'))
  helperResult=false; order={}
  receipt=N.startFight(companion,target)
  assert(table.concat(receipt.reaction.notes,'|'):find('combat start failed: .*refused'))
  `);
});

test('a fight start that fails halfway gives the preset and the attitudes back', () => run(reactionWorld + `
  target.GetTargetTrackerComponent=nil
  companion.GetTargetTrackerComponent=function() error('tracker gone') end
  local ok,err=pcall(N.startFight,companion,target)
  assert(not ok and tostring(err):find('tracker gone'),tostring(err))
  assert(companion.reaction.current.name=='Follower','the preset is back')
  assert(companion.agent.attitude=='AIA_Friendly' and target.agent.attitude=='AIA_Friendly','the attitudes are back')
`));

// ---- Tag-fight fix (2026-10-17): which tag, how combat starts, and the restore afterwards ----

test('target: of several tags the one that fights back is chosen, not the nearest bystander (the live case), and the reason is logged', () => run(markingWorld + `
  -- 2026-10-17 live: a civilian at 20 m and a gang member at 28 m, both tagged; the nearer was taken and never fought.
  civilian.tagged=true; civilian.pos={x=20,y=0,z=0}; ganger.tagged=true; ganger.pos={x=28,y=0,z=0}; aimed=nil
  local current,info=K.current(player)
  assert(current==ganger and info.source=='tagged' and info.distance==28,'the hostile one wins: '..tostring(info and info.name))
  assert(info.why=='hostile over bystander' and logged('because hostile over bystander'),tostring(info.why))
  assert(logged('Tactic tagged choice: Tyger Claw hostile 28m > Passerby bystander 20m'),table.concat(logs,'|'))
  -- a fighter (gang, armed) beats a bystander too, but not a hostile one
  ganger.tagged=false; other.tagged=true; other.pos={x=25,y=0,z=0}
  current,info=K.current(player); assert(current==other and info.why=='fighter over bystander')
  ganger.tagged=true; current,info=K.current(player); assert(current==ganger and info.why=='hostile over fighter')
  -- already in combat counts like hostile
  ganger.tagged=false; other.facts={ganger=true,combat=true}; current,info=K.current(player)
  assert(current==other and info.why=='hostile over bystander')
  -- a hostile civilian is still a hostile
  other.tagged=false; civilian.facts={civilian=true,hostile=true}; clerk.tagged=true; clerk.pos={x=10,y=0,z=0}
  current,info=K.current(player); assert(current==civilian and info.why=='hostile over bystander')
`));

test('target: within a tier the NPC V aims at wins, then the most recent tag, then the nearest', () => run(markingWorld + `
  other.tagged=true; guard.tagged=true      -- both fighters: other at 25 m, guard at 40 m
  aimed=nil
  local current,info=K.current(player)
  assert(current==other and info.why=='nearest','no list, no aim: the nearest')
  aimed=guard; current,info=K.current(player); assert(current==guard and info.why=='aimed at' and logged('Arasaka Guard fighter aimed'))
  -- the look-at lands on a companion: the NPC nearest the crosshair line counts as aimed
  aimed=judy; native.crosshair=function() return {x=0,y=0,z=0},{x=1,y=0,z=0} end
  guard.pos={x=29,y=0.1,z=0}; other.pos={x=25,y=9,z=0}
  current,info=K.current(player); assert(current==guard and info.why=='aimed at','along the crosshair line')
  native.crosshair=nil
  -- the game's tag list holds the newest tag first: recency beats distance
  aimed=nil; guard.pos={x=40,y=0,z=0}; other.pos={x=25,y=0,z=0}
  native.taggedList=function() return {guard,other} end
  current,info=K.current(player); assert(current==guard and info.why=='tagged most recently','guard was tagged last')
  assert(logged('Arasaka Guard fighter tag#1 40m > Valentino fighter tag#2 25m'),table.concat(logs,'|'))
  native.taggedList=function() return {other,guard} end
  current,info=K.current(player); assert(current==other and info.why=='tagged most recently')
  -- aimed outranks recency; tier outranks aim
  aimed=guard; current,info=K.current(player); assert(current==guard and info.why=='aimed at')
  ganger.tagged=true; ganger.pos={x=60,y=0,z=0}; native.taggedList=function() return {other,guard,ganger} end
  current,info=K.current(player); assert(current==ganger and info.why=='hostile over fighter','a hostile tag beats the aimed fighter')
`));

test('target: a companion and a story character are never chosen from several tags', () => run(markingWorld + `
  judy.tagged=true; scripted.tagged=true; civilian.tagged=true; ganger.tagged=true
  K=newMarking({protected=function(o) return o==ganger end})
  local current,info=K.current(player)
  assert(current==civilian and info.source=='tagged','the protected hostile, the companion and the scene NPC are all skipped: '..tostring(info and info.name))
  assert(info.why=='the only valid tag' and logged('rejected: story%-character') and logged('Scene Ganger rejected: story%-controlled'))
`));

// A game with the combat, restore and diagnosis natives, added to the tactic world.
const engageExtras = `
companion.hls,companion.stance,companion.threat='Relaxed','Stand',false
hlsIgnored,stanceIgnored=false,false
native.engage=function(c,t,stage) effect('engage',stage); return 'asked again '..stage end
native.diagnose=function(c,t) return {hls=c.hls,stance=c.stance,threat=true,listed=true,out='AIA_Hostile',back='AIA_Hostile',
  preset='Ganger_Aggressive',civilian=t.civilian==true,crowd=false} end
native.removeThreat=function(c,t) effect('threat-remove',c.id,t.id); return 'threat on the target removed (read back gone)' end
native.hasThreat=function(c) return c.threat end
native.highLevel=function(c) return c.hls end
native.setHighLevel=function(c,name) effect('hls',name); if not hlsIgnored then c.hls=name end; return true end
native.stance=function(c) return c.stance end
native.setStance=function(c,name) effect('stance',name); if not stanceIgnored then c.stance=name end; return true end
native.playerCrouched=function(p) return p.crouched==true end
env.rearm=function(entity) effect('rearm',entity); companion.hand=false; return true end
function count(prefix) local n=0 for _,e in ipairs(effects) do if e:find('^'..prefix) then n=n+1 end end return n end
function index(prefix) for i,e in ipairs(effects) do if e:find('^'..prefix) then return i end end end
`;

test('combat that does not register is asked for again at 1 s and 2 s, then diagnosed in the log', () => run(world + engageExtras + `
  assert(T.start('fight',T.offer('44ULL'),'44ULL'),"start refused")
  for _=1,9 do frame() end
  assert(count('engage')==0 and not logged('engage stage'),'nothing is repeated before the first read-back')
  for _=1,3 do frame() end
  assert(count('engage')==1 and logged('engage stage 2'),table.concat(logs,'|'))
  for _=1,10 do frame() end
  assert(count('engage')==2 and logged('engage stage 3'),'a third ask at 2 s')
  for _=1,12 do frame() end
  assert(count('engage')==2,'that is the last one')
  local line=assert(logged('engage: combat did not register after'),'the diagnosis is logged once')
  assert(line:find('state=Relaxed stance=Stand threat=yes target%-listed=yes attitude=AIA_Hostile/AIA_Hostile preset=Ganger_Aggressive target%-civilian=no'),line)
  local lines=0; for _,l in ipairs(logs) do if l:find('engage: combat did not') then lines=lines+1 end end; assert(lines==1)
`));

test('combat that registers after the second ask stops the asking', () => run(world + engageExtras + `
  assert(T.start('fight',T.offer('44ULL'),'44ULL'),"start refused")
  for _=1,12 do frame() end
  assert(count('engage')==1)
  companion.combat=true; frame()
  assert(phase()=='fighting' and logged('native combat engaged'))
  for _=1,40 do frame() end
  assert(count('engage')==1,'no more asks once she fights')
`));

test('an order that never starts combat gives up once she stands at the target, with the reason in plain words', () => run(world + engageExtras + `
  assert(T.start('fight',T.offer('44ULL'),'44ULL'),"start refused")
  for _=1,150 do frame() end
  assert(T.snapshot().last.result=='no-combat' and not T.owns(3))
  local message
  for _,e in ipairs(effects) do if e:find('^feedback ') then message=e end end
  assert(message=='feedback Judy could not start the fight with Tyger Claw.',tostring(message))
  assert(count('engage')==2,'asked at 1 s and 2 s, then gave up well before the 25 s limit')
`));

test('the notice says the target is not a fighter, or that she could not reach it', () => {
  run(world + engageExtras + `
  target.civilian=true
  assert(T.start('fight',T.offer('44ULL'),'44ULL'),"start refused")
  for _=1,150 do frame() end
  local message; for _,e in ipairs(effects) do if e:find('^feedback ') then message=e end end
  assert(message=="feedback Judy can't attack Tyger Claw: not a fighter.",tostring(message))
  `);
  run(world + engageExtras + `
  assert(T.start('fight',T.offer('44ULL'),'44ULL'),"start refused")
  -- the movement owner never gets her closer: the 25 s limit
  for _=1,280 do T.update(player,0.1,true) end
  assert(T.snapshot().last.result=='no-combat')
  local message; for _,e in ipairs(effects) do if e:find('^feedback ') then message=e end end
  assert(message=='feedback Judy could not reach Tyger Claw.',tostring(message))
  `);
});

test('a finished tactic takes our threat back, stands her up, clears the Stealth state and asks for the holster, each step read back', () => run(world + engageExtras + `
  companion.stance,companion.hls,companion.hand='Crouch','Stealth',true
  assert(T.start('fight',T.offer('44ULL'),'44ULL'),"start refused")
  for _=1,150 do frame() end
  assert(T.snapshot().last.result=='no-combat')
  assert(count('threat%-remove')==1 and logged('restore: threat on the target removed %(read back gone%)'),'her tracker is cleared at once')
  for _=1,200 do frame() end
  local order={}
  for _,pattern in ipairs({'restore: stance Crouch %-> Stand asked %(try 1%)','restore: stance read back Stand %(ok%)',
      'restore: state Stealth %-> Relaxed asked %(try 1%)','restore: state read back Relaxed %(ok%)',
      'restore: stance Stand, state Relaxed, follow resumes','restore: holster asked of the equipment owner %(weapon in hand: Items.Preset_Lexington%)',
      'restore: weapon read back: holstered'}) do
    local at; for i,l in ipairs(logs) do if l:find(pattern) then at=i; break end end
    assert(at,'missing in the log: '..pattern..'\\n'..table.concat(logs,'\\n'))
    assert(not order[#order] or at>order[#order],'out of order: '..pattern); order[#order+1]=at
  end
  assert(index('stance Stand')<index('hls Relaxed') and index('hls Relaxed')<index('rearm'),'the stance first, the state next, the holster last')
  assert(companion.stance=='Stand' and companion.hls=='Relaxed' and not companion.hand)
  local before=#effects; for _=1,50 do frame() end; assert(#effects==before,'nothing more once it is settled')
`));

test('the restore waits for a threat that is not ours, leaves the player own fight alone, and gives up after its limit', () => {
  run(world + engageExtras + `
  companion.stance,companion.hls,companion.hand='Crouch','Stealth',true; companion.threat=true
  assert(T.start('fight',T.offer('44ULL'),'44ULL'),"start refused")
  for _=1,150 do frame() end
  for _=1,100 do frame() end
  assert(logged('restore: waiting, she still tracks a hostile threat') and count('stance')==0 and count('hls')==0,'nothing is changed while she fights someone else: '..table.concat(logs,'|')..' / '..table.concat(effects,'|'))
  for _=1,100 do frame() end
  assert(logged('restore: gave up after 14 s %(stance Crouch, state Stealth%)'),table.concat(logs,'|'))
  `);
  run(world + engageExtras + `
  companion.stance,companion.hls,companion.hand='Crouch','Stealth',true
  assert(T.start('fight',T.offer('44ULL'),'44ULL'),"start refused")
  player.combat=true
  for _=1,180 do frame() end
  assert(logged('restore: V is in combat, her stance and state are left to the game') and count('stance')==0 and count('hls')==0)
  assert(count('rearm')==1,'the holster owner is still armed')
  `);
});

test('V crouching keeps the crouch-with-V module in charge; a refused stand is tried three times and then left to the game', () => {
  run(world + engageExtras + `
  companion.stance,companion.hls,companion.hand='Crouch','Stealth',true; player.crouched=true
  assert(T.start('fight',T.offer('44ULL'),'44ULL'),"start refused")
  for _=1,250 do frame() end
  assert(logged('restore: V is crouched') and count('stance')==0 and count('hls')==0 and count('rearm')==1,table.concat(logs,'|')..' / '..table.concat(effects,'|'))
  `);
  run(world + engageExtras + `
  companion.stance,companion.hls,companion.hand='Crouch','Stealth',true; stanceIgnored,hlsIgnored=true,true
  assert(T.start('fight',T.offer('44ULL'),'44ULL'),"start refused")
  for _=1,300 do frame() end
  assert(count('stance')==3 and count('hls')==3,'three tries each: '..count('stance')..'/'..count('hls'))
  assert(logged('stance still Crouch after 3 tries, left to the game') and logged('state still Stealth after 3 tries, left to the game'))
  assert(count('rearm')==1,'the holster is asked anyway')
  `);
});

test('no restore after leaving for a vehicle, a new tactic ends the old restore, and a dead target is restored too', () => {
  run(world + engageExtras + `
  companion.stance,companion.hls='Crouch','Stealth'
  assert(T.start('fight',T.offer('44ULL'),'44ULL'),"start refused")
  player.mounted=true; frame(); player.mounted=false
  assert(T.snapshot().last.result=='vehicle')
  for _=1,100 do frame() end
  assert(count('stance')==0 and count('hls')==0 and count('rearm')==0,'the vehicle owner has her')
  `);
  run(world + engageExtras + `
  companion.stance,companion.hls,companion.hand='Crouch','Stealth',true
  assert(T.start('fight',T.offer('44ULL'),'44ULL'),"start refused")
  companion.combat=true; frame(); frame()
  target.alive=false; frame()
  assert(T.snapshot().last.result=='target-down')
  companion.combat=false
  for _=1,120 do frame() end
  assert(logged('restore: threat on the target removed') and count('stance Stand')==1 and count('hls Relaxed')==1 and count('rearm')==1,
    'a won fight is restored the same way: '..table.concat(effects,' | '))
  `);
  run(world + engageExtras + `
  companion.stance,companion.hls='Crouch','Stealth'
  assert(T.start('fight',T.offer('44ULL'),'44ULL'),"start refused")
  T.cancel('cancelled'); frame(); frame()
  local offer=T.offer('44ULL'); assert(T.start('fight',offer,'44ULL'),"second start refused")
  local before=count('stance')
  for _=1,20 do frame() end
  assert(count('stance')==before,'a new tactic owns her; no restore runs under it')
  T.abandon(); for _=1,50 do frame() end
  assert(count('stance')==before,'world teardown ends a restore without native calls')
  `);
});

// The native adapter against fakes of the engine objects the new steps call.
const hlsWorld = reactionWorld + `
  NPCPuppet={ChangeHighLevelState=function(n,state) order[#order+1]='hls-'..state; n.hls=state end,
    ChangeStanceState=function(n,s) order[#order+1]='stance-'..s; n.stanceName=s end}
  local listed=true; stillListed=false
  TargetTrackingExtension={HasHostileThreat=function(n) return n.threat==true end,
    IsThreatInThreatList=function(n,t) return listed end}
  local tracker={AddThreat=function() order[#order+1]='threat' end,SetThreatPersistence=function() end,
    ActivateThreat=function() order[#order+1]='activate' end,SetThreatBeliefAccuracy=function(_,_,v) order[#order+1]='belief-'..v end,
    MapThreat=function() return 7 end,RemoveThreat=function(_,id) order[#order+1]='remove-'..id; listed=stillListed end}
  companion.GetTargetTrackerComponent=function() return tracker end
  target.GetTargetTrackerComponent=function() return tracker end
  companion.hls='Stealth'
  companion.GetHighLevelStateFromBlackboard=function(self) return {value=self.hls} end
  function listedAgain() listed=true end
`;

test('the adapter forces the Combat state last, after the attitudes, the threat and the combat start, and remembers the old one', () => run(hlsWorld + `
  local receipt=N.startFight(companion,target)
  assert(order[#order]=='hls-Combat','the forced state is the last step: '..table.concat(order,','))
  assert(receipt.hlsFrom=='Stealth' and companion.hls=='Combat')
  assert(table.concat(receipt.reaction.notes,'|'):find('Combat state asked %(was Stealth%)'))
  NPCPuppet.ChangeHighLevelState=function() error('private') end
  receipt=N.startFight(companion,target)
  assert(table.concat(receipt.reaction.notes,'|'):find('Combat state refused: .*private'),'a refusal is noted and the fight goes on')
`));

test('the adapter asks again with a refreshed threat, the combat start and the Combat state; the diagnosis reads plain facts', () => run(hlsWorld + `
  local receipt=N.startFight(companion,target); order={}
  companion.hls='Stealth'
  local text=N.engage(companion,target,2,receipt)
  assert(order[1]=='activate' and order[2]:find('^belief%-1') and order[3]=='trigger' and order[4]=='hls-Combat',table.concat(order,','))
  assert(text:find('threat activated and believed') and text:find('combat start asked of the reaction component') and text:find('Combat state asked again, reads Combat'),text)
  local tracker=companion:GetTargetTrackerComponent(); tracker.ActivateThreat=function() error('no such thing') end
  text=N.engage(companion,target,3,receipt); assert(text:find('threat refresh failed: .*no such thing') and text:find('Combat state asked again'),text)
  Game={GetAllBlackboardDefs=function() return {PuppetState={Stance='S'}} end}
  companion.GetPuppetStateBlackboard=function() return {GetInt=function() return 2 end} end
  target.IsCrowd=function() return false end; target.civilian=true
  companion.threat=true
  local d=N.diagnose(companion,target)
  assert(d.hls=='Combat' and d.stance=='Crouch' and d.threat==true and d.civilian==true and d.crowd==false and d.out=='AIA_Hostile' and d.preset=='Ganger_Aggressive')
`));

test('the adapter reads and sets the stance and state, removes the threat with a read-back, and reads the player crouch', () => run(hlsWorld + `
  Game={GetAllBlackboardDefs=function() return {PuppetState={Stance='S'},PlayerStateMachine={Locomotion='L'}} end}
  local seen=2
  companion.GetPuppetStateBlackboard=function() return {GetInt=function() return seen end} end
  assert(N.stance(companion)=='Crouch'); seen=3; assert(N.stance(companion)=='Stand'); seen=99; assert(N.stance(companion)==nil)
  assert(N.highLevel(companion)=='Stealth' and N.highLevel({GetHighLevelStateFromBlackboard=function() error('x') end})==nil)
  assert(N.setStance(companion,'Stand')==true and order[#order]=='stance-Stand')
  local ok,err=N.setHighLevel(companion,'Relaxed'); assert(ok==true and order[#order]=='hls-Relaxed' and companion.hls=='Relaxed')
  NPCPuppet.ChangeHighLevelState=function() error('boom') end
  ok,err=N.setHighLevel(companion,'Relaxed'); assert(ok==false and tostring(err):find('boom'))
  local state=11
  local player={GetPlayerStateMachineBlackboard=function() return {GetInt=function() return state end} end}
  assert(N.playerCrouched(player)==true); state=1; assert(N.playerCrouched(player)==true); state=2; assert(N.playerCrouched(player)==false)
  state=0; assert(N.playerCrouched(player)==false); state=4; assert(N.playerCrouched(player)==nil)
  -- threat removal
  companion.threat=true; assert(N.hasThreat(companion)==true and N.threatListed(companion,target)==true)
  order={}
  assert(N.removeThreat(companion,target):find('removed %(read back gone%)') and order[1]=='remove-7')
  assert(N.removeThreat(companion,target):find('no longer on her threat list'),'a threat that is gone is not removed twice')
  listedAgain(); stillListed=true
  assert(N.removeThreat(companion,target):find('STILL LISTED'),'a threat the game keeps is reported')
  companion.GetTargetTrackerComponent=function() return nil end
  assert(not pcall(N.removeThreat,companion,target))
`));
