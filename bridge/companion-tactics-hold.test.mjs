// The hold-position flag of companion tactics (mod/companion-tactics.lua T.fightFrom), which lets a quest post fight from where the copy stands: an aggressive
// reaction preset, a hold decision for a copy the party loop moves, no walking to a target, all of it given back when the flag goes. Run on fake native objects.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import fengari from 'fengari';

const tacticsSource = readFileSync(new URL('../mod/companion-tactics.lua', import.meta.url), 'utf8');
const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;

function run(code) {
  const state = lauxlib.luaL_newstate(); lualib.luaL_openlibs(state);
  const status = lauxlib.luaL_dostring(state, to_luastring(code));
  const error = status === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(state, -1));
  lua.lua_close(state); assert.equal(status, lua.LUA_OK, error);
}

// A fake native layer that records every effect, and a tactic built on it.
const world = `
local Tactics=(function() ${tacticsSource} end)()
effects,logs={},{}
local function effect(...) effects[#effects+1]=table.concat({...},' ') end
local function npc(id) return {id=id,alive=true,pos={x=0,y=0,z=0},combat=false} end
copyA,copyB=npc('A'),npc('B')
player={id='P',mounted=false,pos={x=0,y=0,z=0}}
armError=nil
native={key=function(o) return o.id end,position=function(o) return o.pos end,alive=function(o) return o.alive end,inCombat=function(o) return o.combat end,
  playerInCombat=function() return false end,playerMounted=function(p) return p.mounted end,hostileToPlayer=function() return true end,name=function(o) return o.id end,
  bodyType=function() return 'Man' end,
  armPost=function(c) if armError then error(armError) end effect('arm',c.id); return {reaction={notes={'preset Follower -> Ganger_Aggressive (read back ok)'}}} end,
  stopReaction=function(r,c) effect('restore',c.id); return 'preset restored to Follower (read back ok)' end,
  startFight=function(c,t) effect('fight-start',c.id,t.id); return {reaction={notes={}}} end,
  stopFight=function() end,weapon=function(c) return false end,drawWeapon=function() return {command=effect} end,primaryItem=function() return 'Items.X' end,cancelDraw=function() end}
target=npc('T'); target.pos={x=20,y=0,z=0}
env={player=function() return player end,
  actor=function(entity) if entity=='A' then return {serial=3,npc=copyA,profileKey='judy-alvarez',name='Judy'} end end,
  marked=function() return target,{id='T',name='Tyger'} end,
  feedback=function() end,log=function(l) logs[#logs+1]=l end}
local function logged(text) for _,l in ipairs(logs) do if l:find(text,1,true) then return true end end return false end
function wasLogged(text) return logged(text) end
T=Tactics.new({env=env,native=native})
`;

test('fightFrom: on arms her reaction preset once, off gives it back, the flag shows in owns and as a hold decision, nothing else is asked of her', () => run(world + `
assert(T.owns(7) == false and T.decide(7, {position = copyA.pos}, 0.1) == nil, 'no flag, no decision')
assert(T.fightFrom(7, true, copyA) == true)
assert(effects[1] == 'arm A' and #effects == 1)
assert(T.owns(7) == true)
local d = T.decide(7, {position = copyA.pos}, 0.1)
assert(d.phase == 'tactic-hold' and d.operation.kind == 'hold' and d.look == 'none', 'a hold, no walk')
local again = T.decide(7, {position = {x = 5, y = 5, z = 0}}, 0.1)
assert(again.operation.ticket == d.operation.ticket, 'the same operation, so the actuator is not asked again')
assert(T.fightFrom(7, true, copyA) == true and #effects == 1, 'asked twice, armed once')
assert(wasLogged('post 7: preset Follower -> Ganger_Aggressive'), 'the reaction notes are logged')
assert(T.owns(8) == false and T.decide(8, {position = copyA.pos}, 0.1) == nil, 'another copy is untouched')
assert(T.fightFrom(7, false, copyA) == true)
assert(effects[2] == 'restore A' and #effects == 2)
assert(T.owns(7) == false and T.decide(7, {position = copyA.pos}, 0.1) == nil)
assert(T.fightFrom(7, false, copyA) == true and #effects == 2, 'off again asks for nothing')
local snap = T.snapshot(); assert(snap.active == false)
`));

test('fightFrom: guarded, a copy that is not there or an arming that fails says false and leaves no flag, a copy that died is only forgotten', () => run(world + `
assert(T.fightFrom('x', true, copyA) == false and T.fightFrom(nil, true, copyA) == false, 'no serial')
assert(T.fightFrom(7, true, nil) == false and T.owns(7) == false, 'no npc')
copyA.alive = false
assert(T.fightFrom(7, true, copyA) == false, 'a dead one')
copyA.alive = true
armError = 'no reaction component'
assert(T.fightFrom(7, true, copyA) == false and T.owns(7) == false and wasLogged('could not be armed'), 'arming raised')
armError = nil
assert(T.fightFrom(7, true, copyA) == true)
copyA.alive = false
assert(T.fightFrom(7, false, copyA) == true and T.owns(7) == false and wasLogged('not reachable'), 'forgotten without a native call')
for _, e in ipairs(effects) do assert(e ~= 'restore A', 'nothing restored on a dead copy') end
assert(T.fightFrom(7, false, nil) == true)
-- Eight at most.
copyA.alive = true
for serial = 20, 27 do assert(T.fightFrom(serial, true, copyA) == true) end
assert(T.fightFrom(28, true, copyA) == false, 'the ninth is refused')
assert(T.fightFrom(20, true, copyA) == true, 'one already held is still true')
`));

test('fightFrom: a fight order owns the copy it names and wins over the flag, the flag of another copy goes on holding, abandon forgets every flag', () => run(world + `
-- The order on copy A (serial 3) is accepted first.
local offer = T.offer('A')
assert(offer.available == true)
assert(T.start('fight', offer, 'A') == true)
assert(T.fightFrom(3, true, copyA) == false, 'a fight order is running on this copy')
assert(T.fightFrom(7, true, copyB) == true)
assert(T.owns(3) == true and T.owns(7) == true)
local fightDecision = T.decide(3, {position = {x = 0, y = 0, z = 0}, motion = {}}, 0.1)
assert(fightDecision.phase ~= 'tactic-hold', 'her own order decides: ' .. tostring(fightDecision.phase))
local held = T.decide(7, {position = copyB.pos}, 0.1)
assert(held.phase == 'tactic-hold', 'the other copy holds while the order runs')
T.update(player, 0.5, true)
assert(T.owns(7) == true, 'an update does not drop the flag')
T.cancel('test')
assert(T.owns(3) == false and T.owns(7) == true)
T.abandon()
assert(T.owns(7) == false and T.snapshot().active == false, 'a world teardown forgets the flags without native calls')
-- A copy with the flag set is not held back from a fight order of its own once the flag is off.
assert(T.fightFrom(3, true, copyA) == true)
assert(T.fightFrom(3, false, copyA) == true)
T.offer('A'); assert(T.start('fight', T.offer('A'), 'A') == true)
`));

// The adapter against fake game objects: the preset alone, no combat start, no attitude change.
const adapterWorld = `
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
TweakDBInterface={GetReactionPresetRecord=function(key) return presets[key] or presets[(tostring(key):gsub('^ReactionPresets%.',''))] end}
TweakDB={GetRecords=function() local all={}; for key,p in pairs(presets) do if type(key)=='string' then all[#all+1]=p end end; return all end}
NameToString=function(v) return v end
local component={current=presets.Follower}
function component:GetReactionPreset() return self.current end
function component:SetReactionPreset(p) order[#order+1]='preset-'..p.name; self.current=p end
function component:TriggerCombat() order[#order+1]='trigger' end
copy={}
function copy:GetStimReactionComponent() return component end
function copy:GetAttitudeAgent() order[#order+1]='attitude'; return {} end
function copy:GetTargetTrackerComponent() order[#order+1]='tracker'; return {} end
`;

test('the adapter arms a post with the aggressive preset only and gives the earlier one back', () => run(adapterWorld + `
local receipt=N.armPost(copy)
assert(component.current.name=='Ganger_Aggressive')
assert(#order==1 and order[1]=='preset-Ganger_Aggressive', 'only the preset: '..table.concat(order,','))
assert(table.concat(receipt.reaction.notes,'|'):find('preset Follower %-> Ganger_Aggressive %(read back ok%)'))
assert(N.stopReaction(receipt,copy):find('preset restored to Follower %(read back ok%)') and component.current.name=='Follower')
-- already aggressive: nothing raised and nothing to restore
component.current=presets.Ganger_Aggressive; order={}
receipt=N.armPost(copy)
assert(N.stopReaction(receipt,copy)==nil and #order==0)
-- no reaction component: noted, nothing raised
function copy:GetStimReactionComponent() return nil end
receipt=N.armPost(copy)
assert(table.concat(receipt.reaction.notes,'|'):find('reaction component unavailable'))
assert(N.stopReaction(receipt,copy)==nil)
`));
