import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import fengari from 'fengari';
import {companionEngine} from './companion-fixture.mjs';
import {parseTacticOffer} from './companion-actions.mjs';

const tacticsSource = readFileSync(new URL('../mod/companion-tactics.lua', import.meta.url), 'utf8');
const markingSource = readFileSync(new URL('../mod/companion-marking.lua', import.meta.url), 'utf8');
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
drawError=nil
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
  drawWeapon=function(c) if drawError then error(drawError) end effect('draw',c.id); return {command=effect} end,
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
  assert(effects[2]=='draw 44ULL' and logged('weapon draw requested'),'draw asked at the start')
  for _=1,10 do frame() end
  assert(not logged('readback'),'no readback before the command had time to run')
  companion.hand=true
  for _=1,7 do frame() end
  assert(logged('weapon readback: drawn %(Items.Preset_Lexington%)') and T.snapshot().weapon=='drawn')
  local before=#logs; for _=1,40 do frame() end; assert(#logs==before,'nothing more is logged once it is drawn')
`));

test('a hand that stays empty is asked twice, read back twice, then left to the combat AI', () => run(world + `
  assert(T.start('fight',T.offer('44ULL'),'44ULL'),"start refused")
  for _=1,60 do frame() end
  local draws=0; for _,e in ipairs(effects) do if e=='draw 44ULL' then draws=draws+1 end end
  assert(draws==2,'one request and one more, got '..draws)
  assert(logged('hand still empty, draw asked again') and logged('hand still empty, the combat AI decides'))
  assert(T.snapshot().weapon=='empty' and T.owns(3),'the fight itself goes on')
`));

test('a weapon already in hand is not asked for; an unavailable draw never stops the fight', () => {
  run(world + `
  companion.hand=true
  assert(T.start('fight',T.offer('44ULL'),'44ULL'),"start refused")
  assert(logged('weapon already drawn %(Items.Preset_Lexington%)'))
  for _,e in ipairs(effects) do assert(e~='draw 44ULL','no draw request over a drawn weapon') end
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
  -- named or story-controlled: only when already hostile to V and in combat
  ok,reason=V({civilian=true},true); assert(ok==false and reason=='story-character')
  ok,reason=V({story=true}); assert(ok==false and reason=='story-controlled')
  ok,reason=V({story=true,hostile=true}); assert(ok==false,'hostile but not fighting')
  ok,reason=V({story=true,combat=true}); assert(ok==false,'fighting but not hostile to V')
  ok,reason=V({story=true,hostile=true,combat=true}); assert(ok==true and reason=='hostile-in-combat')
  ok,reason=V({civilian=true,hostile=true,combat=true},true); assert(ok==true,'a named hostile fighter')
  assert(V(nil)==true)
`));

test('target: the closest tagged NPC wins, even a civilian, beyond the crosshair, beyond 50 m, and over nearer enemies', () => run(markingWorld + `
  aimed=ganger; civilian.tagged=true; guard.tagged=true; other.tagged=true
  local current,info=K.current(player)
  assert(current==civilian and info.source=='tagged' and info.id=='90ULL' and info.distance==4,'a tagged civilian is the target')
  civilian.tagged=false; current,info=K.current(player); assert(current==other and info.source=='tagged' and info.distance==25)
  other.tagged=false; current,info=K.current(player); assert(current==guard and info.source=='tagged')
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

test('target: a named, quest-bound or scene-controlled NPC is tagged-targetable only when already hostile and in combat', () => run(markingWorld + `
  local storyChar=civilian
  K=newMarking({protected=function(o) return o==storyChar end})
  storyChar.tagged=true; scripted.tagged=true; aimed=ganger
  local current,info=K.current(player)
  assert(current==ganger and info.source=='aimed','a protected tagged NPC is skipped: '..tostring(info and info.name))
  assert(logged('tagged Passerby rejected: story%-character') and logged('tagged Scene Ganger rejected: story%-controlled'))
  storyChar.facts={civilian=true,hostile=true}; current=K.current(player); assert(current~=storyChar,'hostile but not fighting')
  storyChar.facts={civilian=true,hostile=true,combat=true}; current,info=K.current(player)
  assert(current==storyChar and info.source=='tagged','a named NPC already fighting V')
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

test('the native weapon draw uses the right-hand slot and is cancelled only while it is running', () => run(`
  local Tactics=(function() ${tacticsSource} end)()
  local N=Tactics.nativeAdapter()
  local sent,stateText,stopped={},'AICommandState : Executing (2)',{}
  NewObject=function(class) assert(class=='AIEquipCommand'); return {} end
  TweakDBID={new=function(name) return name end}
  local ai={SendCommand=function(_,c) sent[#sent+1]=c; return true end,GetCommandState=function() return stateText end,
    StopExecutingCommand=function() stopped[#stopped+1]='stop' end,CancelCommand=function() stopped[#stopped+1]='cancel' end}
  local npc={GetAIControllerComponent=function() return ai end}
  local handle=N.drawWeapon(npc)
  assert(#sent==1 and sent[1].slotId=='AttachmentSlots.WeaponRight' and sent[1].failIfItemNotFound==false)
  N.cancelDraw(handle,npc); assert(stopped[1]=='stop')
  stateText='AICommandState : Enqueued (0)'; N.cancelDraw(handle,npc); assert(stopped[2]=='cancel')
  stateText='AICommandState : Success (3)'; N.cancelDraw(handle,npc); assert(#stopped==2,'a finished command is left alone')
  ai.SendCommand=function() return false end
  assert(not pcall(N.drawWeapon,npc),'a refused command raises')
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
