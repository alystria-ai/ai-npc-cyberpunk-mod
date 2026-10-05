import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import fengari from 'fengari';
import {companionEngine} from './companion-fixture.mjs';
import {parseTacticOffer} from './companion-actions.mjs';
import {parseDistraction} from './distraction-context.mjs';

const tacticsSource = readFileSync(new URL('../mod/companion-tactics.lua', import.meta.url), 'utf8');
const perceptionSource = readFileSync(new URL('../mod/tactic-perception.lua', import.meta.url), 'utf8');
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
local function npc(id,x,y,name) return {id=id,pos={x=x,y=y,z=0},alive=true,combat=false,name=name,hostile=false,body='Man'} end
player={id='1ULL',pos={x=0,y=0,z=0},combat=false,mounted=false}
companion=npc('44ULL',1,0,'Judy')
target=npc('77ULL',20,0,'Tyger Claw'); target.hostile=true
effects={}
local function effect(...) effects[#effects+1]=table.concat({...},' ') end
native={key=function(o) return o.id end,position=function(o) return {x=o.pos.x,y=o.pos.y,z=o.pos.z} end,
  alive=function(o) return o.alive end,inCombat=function(o) return o.combat end,
  playerInCombat=function(p) return p.combat end,playerMounted=function(p) return p.mounted end,
  hostileToPlayer=function(o) return o.hostile end,name=function(o) return o.name end,bodyType=function(o) return o.body end,
  startFight=function(c,t) effect('fight-start',c.id,t.id); return {companionToTarget='AIA_Friendly',targetToCompanion='AIA_Hostile'} end,
  stopFight=function(r,c,t) effect('fight-stop',c.id,t.id,r.targetToCompanion) end,
  engage=function(t,c) effect('engage',t.id,c.id); return {look=true} end,
  release=function(h,t) effect('release',t.id) end}
perceptionLog={}
perception={begin=function(t,p,c) perceptionLog[#perceptionLog+1]='begin '..t.id..' '..c.id; return 1 end,
  update=function() end,restore=function() perceptionLog[#perceptionLog+1]='restore'; return 1 end,
  active=function() return perceptionLog[#perceptionLog] and perceptionLog[#perceptionLog]:sub(1,5)=='begin' end,
  abandon=function() perceptionLog[#perceptionLog+1]='abandon' end,snapshot=function() return {} end}
sent,leases,stopped,feedbacks={}, {}, {}, {}
pending,speakingId,generation,targetVoice=nil,nil,10,'resident-male'
ready=true
env={player=function() return player end,
  actor=function(entity) if ready and entity=='44ULL' then return {serial=3,npc=companion,profileKey='judy-alvarez',name='Judy'} end end,
  marked=function() if markedTarget then return markedTarget,{id=markedTarget.id,name=markedTarget.name} end end,
  identify=function(o) return targetVoice,o.name,'Man' end,converses=function(key) return key~=nil end,
  nextGeneration=function() generation=generation+1; return generation end,
  idle=function() return pending==nil and speakingId==nil end,
  send=function(context,actor) sent[#sent+1]={context=context,actor=actor}; pending=context; return true end,
  pendingId=function() return pending and pending.requestId end,
  speaking=function(id) return speakingId==id end,
  transcript=function() return nil end,
  stopTurn=function(id) stopped[#stopped+1]=id; if pending and pending.requestId==id then pending=nil end end,
  writeLease=function(id,valid) leases[#leases+1]={id=id,valid=valid} end,
  now=function() return 1000000 end,feedback=function(m) feedbacks[#feedbacks+1]=m end,log=function() end}
markedTarget=target
dofile=function(path) error('unexpected '..path) end
local Tactics=(function() ${tacticsSource} end)()
T=Tactics.new({env=env,native=native,perception=perception})
motion={}
-- One simulated game frame: decision, idealized movement, then the module update.
function frame(dt)
  local decision=T.decide(3,{position=companion.pos,motion=motion,combat=companion.combat},dt or 0.1)
  if decision then
    local op=decision.operation
    if op.kind=='move' and op.goal then companion.pos={x=op.goal.x,y=op.goal.y,z=0} end
    if op.kind=='turn' then motion={ticket=op.ticket,complete=true} end
  end
  T.update(player,dt or 0.1,true)
  return decision
end
-- The bridge answers the pending turn; playback then lasts two frames.
function answer(text,fail)
  local request=assert(pending,'no pending turn')
  assert(T.canDeliver(request),'turn was not deliverable')
  if fail then pending=nil; return request end
  assert(T.received(request.requestId,{text=text}),"received refused in phase "..tostring(phase()))
  pending=nil; speakingId=request.requestId
  frame(); frame(); speakingId=nil; frame()
  return request
end
function phase() return T.snapshot().phase end
`;

test('a clear distraction offer matches the bridge contract and runs exactly five alternating lines', () => {
  const exported = run(world + `
  local offer=T.offer('44ULL')
  export(json.encode(offer))
  assert(T.start('distract-return',offer,'44ULL'),"start refused")
  assert(T.owns(3) and T.busy() and phase()=='approach')
  player.pos={x=40,y=0,z=0} -- V slips past while Judy talks
  assert(perceptionLog[1]=='begin 77ULL 44ULL','perception must cover the target from the start')
  local first=frame(); assert(first.operation.kind=='move' and first.operation.gait=='Walk')
  assert(math.abs(first.operation.goal.x-(20-1.7))<0.01,'talks from just in front of the target')
  frame(); assert(phase()=='face','expected face, got '..tostring(phase())); frame(); frame(); assert(phase()=='talk','expected talk, got '..tostring(phase()))
  assert(effects[1]=='engage 77ULL 44ULL')
  for turn=1,5 do
    frame()
    local request=answer('line '..turn)
    export(json.encode(request.reaction))
    assert(request.entity==(turn%2==1 and '44ULL' or '77ULL'))
    assert(request.profileKey==(turn%2==1 and 'judy-alvarez' or 'resident-male'))
    assert(sent[turn].actor==(turn%2==1 and companion or target))
  end
  assert(#sent==5,'exactly five lines')
  assert(phase()=='returning' and perceptionLog[#perceptionLog]=='restore' and effects[2]=='release 77ULL')
  local back=frame(); assert(back.operation.kind=='move' and back.operation.goal.x==1)
  frame(); assert(phase()=='waiting')
  player.pos={x=3,y=0,z=0}; frame()
  assert(not T.owns(3) and T.snapshot().last.result=='completed' and T.snapshot().last.lines==5)
  for _,lease in ipairs(leases) do assert(lease.id) end
  assert(leases[#leases].valid==false,'the last lease is released')
  `);
  const offer = JSON.parse(exported[0]);
  assert.deepEqual(parseTacticOffer(offer), offer, 'the Lua offer survives the strict bridge parser unchanged');
  assert.deepEqual(offer.kinds, ['fight', 'distract-return', 'distract-fight', 'distract-rejoin']);
  const reactions = exported.slice(1).map(raw => JSON.parse(raw));
  reactions.forEach((reaction, index) => {
    assert.equal(reaction.turn, index + 1);
    assert.equal(reaction.lines?.length ?? 0, index);
    // Lua encodes an empty lines table as an object; the game adapter's CET
    // encoder emits [] for the empty list, so normalize like the bridge input would.
    const parsed = parseDistraction({...reaction, lines: reaction.lines?.length ? reaction.lines : []});
    assert.ok(parsed, 'turn ' + (index + 1) + ' must pass the bridge parser');
  });
  assert.equal(reactions[4].role, 'companion'); assert.equal(reactions[3].lines[2].text, 'line 3');
});

test('fight ending attacks after the fifth line and needs no restoration once the target is down', () => run(world + `
  assert(T.start('distract-fight',T.offer('44ULL'),'44ULL'),"start refused")
  frame(); frame(); frame(); frame()
  for turn=1,5 do frame(); answer('line '..turn) end
  assert(phase()=='fight-approach' and effects[#effects]=='fight-start 44ULL 77ULL')
  assert(not T.busy(),'automatic reactions may resume once the fight begins')
  T.interrupt('manual-text'); assert(T.owns(3),'talking to V does not call off a fight')
  companion.combat=true; local d=frame(); assert(d.operation.kind=='release' and phase()=='fighting')
  target.alive=false; frame()
  assert(not T.owns(3) and T.snapshot().last.result=='target-down')
  for _,line in ipairs(effects) do assert(not line:find('fight%-stop'),'a dead target needs no attitude restore') end
`));

test('rejoin ending hands the companion straight back to following', () => run(world + `
  assert(T.start('distract-rejoin',T.offer('44ULL'),'44ULL'),"start refused")
  frame(); frame(); frame(); frame()
  for turn=1,5 do frame(); answer('line '..turn) end
  assert(not T.owns(3) and T.snapshot().last.result=='completed')
`));

test('vehicle, combat and V interrupting each cancel cleanly and restore what was changed', () => run(world + `
  local function begin()
    effects,perceptionLog,stopped,pending,speakingId={}, {}, {}, nil, nil
    companion.pos={x=1,y=0,z=0}; companion.combat=false; target.combat=false; player.combat=false; player.mounted=false
    assert(T.start('distract-return',T.offer('44ULL'),'44ULL'),"start refused")
  end
  begin(); player.mounted=true; frame()
  assert(not T.owns(3) and T.snapshot().last.result=='vehicle' and perceptionLog[#perceptionLog]=='restore')
  begin(); frame(); frame(); frame(); frame(); frame()
  local request=assert(pending); target.combat=true; frame()
  assert(not T.owns(3) and T.snapshot().last.result=='combat')
  assert(stopped[1]==request.requestId and pending==nil,'the in-flight line is retired')
  assert(effects[#effects]=='release 77ULL' and leases[#leases].valid==false)
  begin(); frame(); frame(); frame(); frame(); frame(); answer('line 1')
  T.interrupt('manual-text')
  assert(not T.owns(3) and T.snapshot().last.result=='manual-text' and perceptionLog[#perceptionLog]=='restore')
  begin(); ready=false; frame(); assert(T.snapshot().last.result=='companion-unavailable'); ready=true
  begin(); target.alive=false; frame(); assert(T.snapshot().last.result=='target-lost')
`));

test('a fight-only action engages immediately, approaches until native combat, and restores a living target', () => run(world + `
  assert(T.start('fight',T.offer('44ULL'),'44ULL'),"start refused")
  assert(effects[1]=='fight-start 44ULL 77ULL' and not T.busy())
  local d=frame(); assert(d.operation.kind=='move' and d.operation.gait=='Run')
  companion.combat=true; d=frame(); assert(d.operation.kind=='release' and phase()=='fighting')
  player.mounted=true; frame()
  assert(not T.owns(3) and effects[#effects]=='fight-stop 44ULL 77ULL AIA_Hostile')
`));

test('a failed line is retried once, then the ending proceeds without inventing lines', () => run(world + `
  assert(T.start('distract-rejoin',T.offer('44ULL'),'44ULL'),"start refused")
  frame(); frame(); frame(); frame()
  frame(); answer('line 1')
  frame(); answer(nil,true); frame()
  assert(T.snapshot().turn==1 and T.owns(3),'first failure retries the same turn')
  frame(); answer(nil,true); frame()
  assert(not T.owns(3) and T.snapshot().last.lines==1)
`));

test('offers need a live marked target; distraction needs a voice and no combat; stale offers are refused', () => run(world + `
  markedTarget=nil; assert(T.offer('44ULL').available==false); markedTarget=target
  assert(T.offer('99ULL').available==false,'only a ready managed companion')
  targetVoice=nil; local offer=T.offer('44ULL'); assert(#offer.kinds==1 and offer.kinds[1]=='fight')
  assert(not T.start('distract-return',offer,'44ULL'),'an unoffered kind is refused'); targetVoice='resident-male'
  player.combat=true; offer=T.offer('44ULL'); assert(#offer.kinds==1); player.combat=false
  offer=T.offer('44ULL'); markedTarget=npc and nil
  local other={id='88ULL',pos={x=5,y=5,z=0},alive=true,name='Other',body='Man'}
  markedTarget=other; T.offer('44ULL')
  assert(not T.start('fight',offer,'44ULL'),'the captured target changed')
  markedTarget=target; offer=T.offer('44ULL'); target.alive=false
  assert(not T.start('fight',offer,'44ULL')); target.alive=true
  target.pos={x=200,y=0,z=0}; assert(T.offer('44ULL').available==false,'too far away')
`));

test('world teardown forgets every handle without native calls', () => run(world + `
  assert(T.start('distract-return',T.offer('44ULL'),'44ULL'),"start refused")
  frame(); frame(); frame(); frame(); frame()
  local before=#effects
  T.abandon()
  assert(not T.owns(3) and #effects==before and perceptionLog[#perceptionLog]=='abandon')
`));

const perceptionWorld = `
local Perception=(function() ${perceptionSource} end)()
calls={}
local function call(...) calls[#calls+1]=table.concat({...},' ') end
local function npc(id,x,meter) return {id=id,pos={x=x,y=0,z=0},valid=true,combat=false,mult=1.0,meter=meter or 0,att={}} end
player={id='1ULL',pos={x=0,y=0,z=0}}
companion=npc('44ULL',15)
target=npc('77ULL',20,30); target.att['44ULL']='AIA_Hostile'
guard=npc('78ULL',22,50); guard.mult=2.0
fighter=npc('79ULL',23,40); fighter.combat=true
companion.att['77ULL']='AIA_Hostile'
nearby={target,guard,fighter,companion,player}
native={key=function(o) return o.id end,valid=function(o) return o.valid end,
  position=function(o) return o.pos end,inCombat=function(o) return o.combat end,
  near=function() return nearby end,
  getMultiplier=function(o) return o.mult end,
  setMultiplier=function(o,_,v) o.mult=v; call('mult',o.id,tostring(v)) end,
  detection=function(o) return o.meter end,resetDetection=function(o) o.meter=0; call('reset',o.id) end,
  attitude=function(a,b) return a.att[b.id] or 'AIA_Neutral' end,
  setAttitude=function(a,b,name) a.att[b.id]=name; call('att',a.id,b.id,name) end}
P=Perception.new({native=native})
`;

test('perception: nearby NPCs barely notice V, hostility to the companion is paused, and both are restored', () => run(perceptionWorld + `
  assert(P.begin(target,player,companion)==3,'target and two neighbours; never the companion or V')
  assert(target.mult==0.15 and guard.mult==0.15 and fighter.mult==0.15)
  assert(target.att['44ULL']=='AIA_Neutral' and companion.att['77ULL']=='AIA_Neutral')
  assert(target.meter==0 and guard.meter==0,'far NPCs lose their detection buildup')
  assert(fighter.meter==40,'an NPC already fighting keeps the game decision')
  guard.mult=1.0; guard.meter=20; P.update(0.3)
  assert(guard.mult==0.15 and guard.meter==0,'vanilla visibility refresh is re-asserted')
  player.pos={x=21,y=0,z=0}; guard.meter=20; P.update(0.3)
  assert(guard.meter==20,'up close the slowed meter is left to the game')
  guard.meter=100; player.pos={x=0,y=0,z=0}; P.update(0.3)
  assert(guard.meter==100,'a full detection is never undone')
  fighter.valid=false
  assert(P.restore()==2)
  assert(target.mult==1.0 and guard.mult==2.0,'original multipliers come back')
  assert(target.att['44ULL']=='AIA_Hostile' and companion.att['77ULL']=='AIA_Hostile')
  assert(not P.active())
  local count=#calls; P.begin(target,player,companion); P.abandon(); assert(not P.active())
  assert(P.restore()==0)
`));

const markingWorld = `
local Marking=(function() ${markingSource} end)()
local function npc(id,x,name) return {id=id,pos={x=x,y=0,z=0},valid=true,name=name,tagged=false} end
player={pos={x=0,y=0,z=0}}
judy=npc('44ULL',2,'Judy'); ganger=npc('77ULL',20,'Tyger Claw'); other=npc('78ULL',25,'Valentino')
aimed,taggedNear=nil,{}
native={aimed=function() return aimed end,key=function(o) return o.id end,valid=function(o) return o.valid end,
  position=function(o) return o.pos end,name=function(o) return o.name end,tagged=function(o) return o.tagged end,
  tag=function(o) o.tagged=true end,untag=function(o) o.tagged=false end,nearbyTagged=function() return taggedNear end}
K=Marking.new({native=native,owned=function(o) return o==judy end})
`;

test('marking: aim and press marks with the native tag, again clears, companions and dead NPCs are never marked', () => run(markingWorld + `
  aimed=judy; assert(not K.mark(player),'a managed companion is not a target')
  aimed=ganger; local ok,message=K.mark(player); assert(ok and message:find('Tyger Claw') and ganger.tagged)
  local current,info=K.current(player); assert(current==ganger and info.source=='marked')
  ok,message=K.mark(player); assert(ok and message:find('cleared') and not ganger.tagged)
  other.tagged=true; aimed=other; K.mark(player); K.clear(); assert(other.tagged,'a tag V placed stays')
  aimed=ganger; K.mark(player); ganger.valid=false; assert(K.current(player)==nil and not ganger.tagged)
  ganger.valid=true; K.mark(player); ganger.pos={x=200,y=0,z=0}; assert(K.current(player)==nil); ganger.pos={x=20,y=0,z=0}
  taggedNear={other}; current,info=K.current(player); assert(current==other and info.source=='tagged')
  taggedNear={other,ganger}; current,info=K.current(player); assert(current==nil and info.ambiguous)
  taggedNear={judy}; assert(K.current(player)==nil)
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
