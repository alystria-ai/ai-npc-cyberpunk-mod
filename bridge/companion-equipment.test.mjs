import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import fengari from 'fengari';
import {companionEngine} from './companion-fixture.mjs';

const source = readFileSync(new URL('../mod/companion-equipment.lua', import.meta.url), 'utf8');
function runLua(code) {
  const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;
  const vm = lauxlib.luaL_newstate(); lualib.luaL_openlibs(vm);
  const result = lauxlib.luaL_dostring(vm, to_luastring(code));
  const error = result === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(vm, -1));
  lua.lua_close(vm); assert.equal(result, lua.LUA_OK, error);
}
function run(code) { runLua(fixture + code); }
const fixture = `
local right,left='AttachmentSlots.WeaponRight','AttachmentSlots.WeaponLeft'
Enum={new=function(kind,value) if kind=='gamedataNPCUpperBodyState' and value==6 then return 'Normal' end;return value end}
TweakDBID={new=function(value)return value end}
ItemID={IsValid=function(id)return id~=nil end,GetCombinedHash=function(id)return id.hash end,
 GetTDBID=function(id)return id.record end}
WeaponObject={IsFists=function(id)return id.fists==true end}
local function gun(hash,fists)
 local id={hash=hash,record='Items.Chao',fists=fists}
 return {GetItemID=function()return id end,IsA=function()return false end}
end
local function actor(id)
 return {id=id,attached=true,dead=false,combat=false,autonomous=true,level='Relaxed',upper=6,
  scene=false,dialogue=false,threat=false,tier=1,
  GetEntityID=function(self)return self end,IsAttached=function(self)return self.attached end,
  IsDeadNoStatPool=function(self)return self.dead end,IsInCombat=function(self)return self.combat end,
  IsOnAutonomousAI=function(self)return self.autonomous end,
  GetHighLevelStateFromBlackboard=function(self)return self.level end,
  GetPuppetStateBlackboard=function(self)return {GetInt=function()return self.upper end}end}
end
local player,npc=actor('player'),actor('Judy')
npc.hands={[right]=gun('weapon1')}
ScriptedPuppet={GetWeaponRight=function(n)return n.hands[right] end,GetWeaponLeft=function(n)return n.hands[left] end}
NPCPuppet={IsInCombat=function(n)return n.combat end}
PlayerPuppet={GetSceneTier=function(p)return p.tier end}
TargetTrackingExtension={HasHostileThreat=function(n,onlyVisible,onlyEntities)
 if n==player and n.locationThreat and not onlyEntities then return true end
 return n.threat
end}
local scene={IsEntityInDialogue=function(_,id)return id.dialogue end,IsEntityInScene=function(_,id)return id.scene end}
Game={GetSceneSystem=function()return {GetScriptInterface=function()return scene end}end,
 GetAllBlackboardDefs=function()return {PuppetState={UpperBody='UpperBody'}}end}
local ai={commands={},cancelled={},stopped={}}
function ai:GetCommandState(c)return c.state end
function ai:SendCommand(c)
 c.id=#self.commands+1;c.state=self.nextState or 'Executing';self.commands[#self.commands+1]=c
 return self.accept~=false
end
function ai:CancelCommand(c) self.cancelled[#self.cancelled+1]=c;if self.refuseCancel then return false end;c.state='Cancelled' end
function ai:StopExecutingCommand(c) self.stopped[#self.stopped+1]=c;if self.refuseCancel then return false end;c.state='Interrupted' end
function npc:GetAIControllerComponent()return ai end
NewObject=function(kind)assert(kind=='AIUnequipCommand');return {kind=kind}end
local m=(function()${source}end)()
local s=m.new(npc)
local handoff=function()return true end
local function tick(seconds,idle)
 if idle==nil then idle=true end
 for i=1,math.ceil(seconds/.25)do m.update(s,player,.25,idle,handoff)end
end
local movement={state='Executing',id=999,kind='AIHoldPositionCommand'}
`;

test('fresh calm managed copy holsters naturally once and verifies the hand cleared', () => run(`
 tick(2.5);assert(#ai.commands==0)
 tick(.25);assert(#ai.commands==1 and s.command.slotId==right)
 assert(s.command.durationOverride==nil,'must retain the native animation default')
 assert(movement.state=='Executing' and #ai.stopped==0 and #ai.cancelled==0)
 npc.upper='Equip';tick(.5);assert(s.command and #ai.stopped==0,'native equip animation must finish')
 npc.hands[right]=nil;s.command.state='Success';npc.upper=6;tick(.5)
 assert(m.snapshot(s).phase=='complete' and not m.snapshot(s).active)
 npc.hands[right]=gun('redraw');tick(20)
 assert(#ai.commands==1,'must not fight native equipment by holstering every update')
`));

test('empty hands and native fists are left alone', () => run(`
 npc.hands[right]=gun('fists',true);tick(10)
 assert(#ai.commands==0 and m.snapshot(s).phase=='complete')
`));

test('delayed spawn equipment is checked before accepting an empty-hand baseline', () => run(`
 npc.hands[right]=nil;tick(1);assert(m.snapshot(s).armed)
 npc.hands[right]=gun('late-spawn');tick(2)
 assert(#ai.commands==1 and s.command.slotId==right)
`));

test('player/NPC combat, threats, story control and unknown reads cannot admit a holster', () => {
  for (const block of [
    'player.combat=true', 'npc.combat=true', 'player.threat=true', 'npc.threat=true',
    'npc.autonomous=false', "npc.level='Combat'", 'npc.scene=true', 'npc.dialogue=true',
    'player.dialogue=true', 'player.tier=3', "npc.upper='Reload'", 'npc.threat=nil',
    'Game.GetSceneSystem=function()error("unavailable")end',
  ]) run(`${block};tick(12);assert(#ai.commands==0,'unsafe holster: ${block.replaceAll("'", '')}')`);
  run('tick(10,false);assert(#ai.commands==0)');
});

test('an engine that still calls the calm companion Alerted holsters only after a longer calm', () => run(`
 npc.level='Alerted';tick(5.75);assert(#ai.commands==0,'alerted must wait out the longer calm')
 tick(1.5);assert(#ai.commands==1,'alerted after six calm seconds is treated as relaxed')
`));

test('a drawn weapon asks the mover to stand still after a calm delay, not at once, and not while others own her', () => run(`
 tick(2.5,false);assert(not m.wantsStop(s),'must not stop her the moment combat ends')
 tick(.75,false);assert(m.wantsStop(s) and #ai.commands==0)
 assert(m.snapshot(s).stopWanted and m.snapshot(s).phase=='waiting')
 player.threat=true;tick(.25,false);assert(not m.wantsStop(s),'a hostile entity withdraws the request')
 player.threat=false;tick(2.5,false);assert(not m.wantsStop(s),'calm starts over after a threat')
 tick(.75,false);assert(m.wantsStop(s))
 npc.hands[right]=nil;tick(.5,false);assert(not m.wantsStop(s),'nothing drawn: nothing to stop for')
 npc.hands[right]=gun('again');tick(.5,false);assert(m.wantsStop(s),'a redrawn weapon asks again')
`));

test('after combat the holster follows the stand-still although V keeps moving', () => run(`
 player.combat=true;tick(.5,false);assert(not m.wantsStop(s))
 player.combat=false;tick(3.25,false);assert(m.wantsStop(s) and #ai.commands==0)
 -- Her own feet are still (the mover obeyed) while V walks on: idle is her own.
 tick(.75);assert(#ai.commands==0,'the feet need a second to settle')
 tick(.5);assert(#ai.commands==1 and s.command.slotId==right and m.wantsStop(s))
 npc.hands[right]=nil;s.command.state='Success';tick(.5)
 assert(m.snapshot(s).phase=='complete' and not m.wantsStop(s))
`));

test('a stand-still that never reaches the holster is abandoned, then asked again after a cooldown', () => run(`
 tick(3.25,false);assert(m.wantsStop(s))
 tick(7.75,false);assert(m.wantsStop(s),'still within the stop limit')
 tick(.5,false);assert(not m.wantsStop(s),'a stop is bounded')
 tick(15,false);assert(not m.wantsStop(s),'cooling down')
 tick(6,false);assert(m.wantsStop(s),'asked again once the cooldown ends')
 assert(#ai.commands==0)
`));

test('new combat rearms cleanup only after a second stable calm interval', () => run(`
 npc.hands[right]=nil;tick(3);assert(m.snapshot(s).phase=='complete')
 player.combat=true;npc.hands[right]=gun('combat-weapon');tick(2)
 assert(#ai.commands==0)
 player.combat=false;tick(2.5);assert(#ai.commands==0)
 tick(.25);assert(#ai.commands==1 and m.snapshot(s).episode==2)
`));

test('vehicle-impact location memory cannot leave a calm follower permanently armed', () => run(`
 player.combat=true;tick(.5)
 player.combat=false;player.locationThreat=true
 assert(TargetTrackingExtension.HasHostileThreat(player)==true)
 assert(TargetTrackingExtension.HasHostileThreat(player,false,true)==false)
 tick(2.5);assert(#ai.commands==0)
 tick(.25);assert(#ai.commands==1 and m.snapshot(s).episode==2)
 npc.hands[right]=nil;s.command.state='Success';tick(.25)
 assert(m.snapshot(s).phase=='complete' and not m.holdsMovement(s))
`));

test('location memory permits holstering but a returning hostile entity cancels it', () => run(`
 tick(3);local owned=s.command;player.locationThreat=true;tick(.5)
 assert(s.command==owned and #ai.stopped==0)
 player.threat=true;tick(.25)
 assert(not s.command and ai.stopped[1]==owned and not m.holdsMovement(s))
`));

test('native scene or renewed combat cancels only the equipment command', () => {
  for (const block of ['npc.scene=true', 'npc.combat=true', 'player.threat=true', 'npc.autonomous=false']) {
    run(`tick(3);local owned=s.command;${block};tick(.25)
      assert(not s.command and ai.stopped[1]==owned and #ai.stopped==1)
      assert(movement.state=='Executing' and movement.id==999)`);
  }
  run(`ai.nextState='Enqueued';tick(3);local owned=s.command;player.combat=true;tick(.25)
    assert(ai.cancelled[1]==owned and #ai.stopped==0)`);
});

test('a stalled native holster gets at most two attempts per hand per episode', () => run(`
 tick(40)
 assert(#ai.commands==2 and #ai.stopped==2)
 assert(m.snapshot(s).phase=='failed' and not m.snapshot(s).active)
 assert(npc.hands[right]~=nil,'never forcibly remove the item as fallback')
 tick(40);assert(#ai.commands==2)
`));

test('reported command success without actual slot clearance is not a successful cleanup', () => run(`
 ai.nextState='Success';tick(20)
 assert(#ai.commands==2 and m.snapshot(s).phase=='failed')
 assert(m.snapshot(s).hands[right].present)
`));

test('two hand weapons are handled sequentially with independent command IDs', () => run(`
 npc.hands[left]=gun('left-weapon');tick(3)
 local first=s.command;assert(first.slotId==right)
 npc.hands[right]=nil;first.state='Success';tick(3.5)
 local second=s.command;assert(second and second~=first and second.slotId==left)
 npc.hands[left]=nil;second.state='Success';tick(1)
 assert(m.snapshot(s).phase=='complete' and #ai.commands==2)
`));

test('dismiss cancels the owned command; world teardown touches no native objects', () => run(`
 tick(3);local owned=s.command;m.release(s)
 assert(ai.stopped[1]==owned and m.snapshot(s).phase=='released')
 s=m.new(npc);tick(3)
 npc.IsAttached=function()error('native actor already torn down')end
 npc.GetAIControllerComponent=function()error('native AI already torn down')end
 m.abandon(s);m.update(s,player,1,true);m.release(s)
 assert(not m.snapshot(s).active and #ai.stopped==1)
`));

test('rejected cancellation retains ownership and prevents further commands', () => run(`
 tick(3);local owned=s.command;ai.refuseCancel=true;npc.scene=true;tick(.25)
 assert(s.command==owned and m.snapshot(s).cancellationFailed)
 npc.scene=false;tick(30)
 assert(#ai.commands==1 and #ai.stopped==1)
 assert(not m.holdsMovement(s),'failed cancellation must not suspend locomotion forever')
 owned.state='Success';tick(.25);assert(not m.snapshot(s).active)
 m.abandon(s);assert(not m.snapshot(s).active)
`));

const nativeStateText = `
 local enum={NotExecuting=0,Enqueued=1,Executing=2,Cancelled=3,Interrupted=4,Success=5,Failure=6}
 function ai:GetCommandState(command)
  return 'AICommandState : '..command.state..' ('..enum[command.state]..')'
 end
`;

for (const pendingState of ['NotExecuting', 'Enqueued', 'Executing']) {
  test(`native ${pendingState} holster cancellation retains ownership until confirmed terminal`, () => run(`
    ${nativeStateText}
    ai.nextState='${pendingState}';tick(3);local owned=s.command;assert(owned)
    local requests=0
    ai.CancelCommand=function(_,command)
      assert('${pendingState}'~='Executing' and command==owned);requests=requests+1;return true
    end
    ai.StopExecutingCommand=function(_,command)
      assert('${pendingState}'=='Executing' and command==owned);requests=requests+1;return true
    end
    npc.scene=true;tick(.25)
    assert(s.command==owned and requests==1 and not m.holdsMovement(s))
    npc.scene=false;tick(8)
    assert(s.command==owned and #ai.commands==1 and requests==1,'pending cancellation was forgotten/repeated')
    owned.state='Cancelled';tick(3)
    assert(s.command~=owned and #ai.commands==2,'terminal cancellation did not allow later settled cleanup')
  `));
}

for (const terminalState of ['Cancelled', 'Interrupted', 'Success', 'Failure']) {
  test(`failed equipment cancellation recognizes native ${terminalState}, never NotExecuting, as terminal`, () => run(`
    ${nativeStateText}
    tick(3);local owned=s.command;ai.refuseCancel=true;npc.scene=true;tick(.25)
    assert(s.command==owned and m.snapshot(s).cancellationFailed)
    owned.state='NotExecuting';npc.scene=false;tick(5)
    assert(s.command==owned and #ai.commands==1 and #ai.stopped==1 and #ai.cancelled==0)
    owned.state='${terminalState}';tick(.25)
    assert(not s.command and #ai.commands==1,'verified terminal command handle was retained')
  `));
}

test('dismiss and world abandonment retain then drop asynchronous holster cancellation safely', () => run(`
  ${nativeStateText}
  tick(3);local owned=s.command;local stops=0
  ai.StopExecutingCommand=function()stops=stops+1;return true end
  m.release(s);assert(s.command==owned and stops==1 and not m.holdsMovement(s))
  tick(3);assert(s.command==owned and stops==1 and #ai.commands==1)
  npc.IsAttached=function()error('native actor already torn down')end
  npc.GetAIControllerComponent=function()error('native AI already torn down')end
  m.abandon(s);m.update(s,player,1,true);assert(not m.snapshot(s).active)
`));

test('equipment waits for confirmed owned-hold release and bounds a failed handoff', () => run(`
 local requests=0;handoff=function()requests=requests+1;return false,'Still stopping'end
 tick(3);assert(m.holdsMovement(s) and #ai.commands==0)
 tick(3);assert(not m.holdsMovement(s) and m.snapshot(s).phase=='failed')
 local count=requests;tick(10);assert(requests==count and #ai.commands==0)
`));

test('an unavailable handoff cannot enqueue a weapon operation or repeatedly stop a hold', () => run(`
 local requests=0;handoff=function()requests=requests+1;error('Hold release rejected')end
 tick(30);assert(requests==1 and #ai.commands==0)
 assert(not m.holdsMovement(s) and m.snapshot(s).phase=='failed')
`));

test('leaving idle cancels equipment before the next polling deadline', () => run(`
 tick(3);local owned=s.command
 m.update(s,player,.01,false,handoff)
 assert(ai.stopped[1]==owned and not m.holdsMovement(s))
`));

test('diagnostic snapshots are detached plain data', () => run(`
 tick(3);local report=m.snapshot(s)
 local function plain(value)
  assert(type(value)~='function' and type(value)~='userdata')
  if type(value)=='table' then for _,v in pairs(value)do plain(v)end end
 end
 plain(report);report.hands[right].present=false;report.attempts[right]=100
 local current=m.snapshot(s)
 assert(current.hands[right].present and current.attempts[right]==1)
`));

// Real companion/actuator integration with the observed engine behavior: an
// unequip request queues behind the currently executing idle hold.
const integration = `${companionEngine}
local npc=spawn();tick(3)
local right='AttachmentSlots.WeaponRight'
local weapon={GetItemID=function()return {hash='Chao',record='Items.Chao'}end}
npc.weapon=weapon
function player:IsAttached()return true end
function player:IsDeadNoStatPool()return false end
function player:IsInCombat()return self.combat==true end
function player:GetEntityID()return self end
function npc:IsOnAutonomousAI()return true end
function npc:GetHighLevelStateFromBlackboard()return 'Relaxed' end
function npc:GetPuppetStateBlackboard()return {GetInt=function()return 'Normal'end}end
ItemID={IsValid=function(id)return id~=nil end,GetCombinedHash=function(id)return id.hash end,GetTDBID=function(id)return id.record end}
WeaponObject={IsFists=function()return false end}
ScriptedPuppet={GetWeaponRight=function(n)return n.weapon end,GetWeaponLeft=function()return nil end}
PlayerPuppet={GetSceneTier=function()return 1 end}
TargetTrackingExtension={HasHostileThreat=function()return false end}
Game.GetAllBlackboardDefs=function()return {PuppetState={UpperBody='UpperBody'}}end
Game.GetSceneSystem=function()return {GetScriptInterface=function()return {
 IsEntityInScene=function()return false end,IsEntityInDialogue=function()return false end}end}end
local events={}
local send=npc.ai.SendCommand
function npc.ai:SendCommand(command)
 local blocked=false
 for _,c in ipairs(self.commands)do
  if c.kind=='AIHoldPositionCommand' and c.state=='Executing' then blocked=true end
 end
 send(self,command)
 if command.kind=='AIUnequipCommand' and blocked then command.state='Enqueued' end
 if command.kind=='AIHoldPositionCommand' then command.stance={x=npc.pos.x,y=npc.pos.y}end
 events[#events+1]={kind='send',command=command}
 return true
end
function npc.ai:StopExecutingCommand(command)
 events[#events+1]={kind='stop',command=command}
 if self.rejectHold and command.kind=='AIHoldPositionCommand' then return false end
 if not(self.delayHold and command.kind=='AIHoldPositionCommand')then command.state='Success'end
 return true
end
local function row()return companions.list()[1]end
local originalHold=last(npc,'AIHoldPositionCommand')
local originalTicket=row().operation.ticket
local function tick(seconds)
 for i=1,math.ceil(seconds/.1)do companions.update(player,.1)end
 assert(not row().error,row().error)
end
`;

test('idle hold hands off to holster, then resumes at actual stance without replanning', () => runLua(integration + `
 tick(3.2)
 local unequip=last(npc,'AIUnequipCommand')
 assert(unequip and unequip.state=='Executing','holster queued behind the old idle hold')
 assert(originalHold.state=='Success' and row().equipment.movementSuspended)
 assert(row().behavior=='settled' and row().operation.ticket==originalTicket)
 local count=#npc.ai.commands;tick(1)
 assert(#npc.ai.commands==count,'idle hold was reissued during holster')
 npc.pos.x=npc.pos.x+.06;npc.weapon=nil;unequip.state='Success';tick(.7)
 local restored=last(npc,'AIHoldPositionCommand')
 assert(restored~=originalHold and restored.stance.x==npc.pos.x,'hold did not resume at actual stance')
 assert(row().equipment.phase=='complete' and row().operation.ticket==originalTicket,
  'cleanup='..row().equipment.phase..' ticket='..tostring(row().operation.ticket))
 assert(row().behavior=='settled' and #active(npc,'AIMoveToCommand')==0,'handoff caused a reposition')
`));

test('V walking on after a fight: she stands still, holsters, then follows again', () => runLua(integration + `
 -- Standing calm is not what is under test: V is walking when the fight ends.
 local function walk(seconds)
  for i=1,math.ceil(seconds/.1)do player.pos.y=player.pos.y+.35;companions.update(player,.1)end
  assert(not row().error,row().error)
 end
 player.combat=true;walk(.6);player.combat=false
 walk(1.5);assert(not last(npc,'AIUnequipCommand'),'no stop before the calm delay')
 walk(2.5)
 assert(row().equipment.stopWanted,'equipment='..tostring(row().equipment.phase)..'/'..tostring(row().equipment.reason))
 assert(last(npc,'AIHoldPositionCommand').state=='Executing' or last(npc,'AIUnequipCommand'),'she stood still')
 walk(3)
 local unequip=last(npc,'AIUnequipCommand')
 assert(unequip,'holster not sent while V kept walking: '..tostring(row().equipment.phase)..'/'..tostring(row().equipment.reason))
 npc.weapon=nil;unequip.state='Success';walk(1)
 assert(row().equipment.phase=='complete' and not row().equipment.stopWanted)
 walk(1)
 assert(not row().equipment.stopWanted,'she follows again once the weapon is away')
`));

test('player departure cancels holster before applying the current movement decision', () => runLua(integration + `
 tick(3.2);local unequip=last(npc,'AIUnequipCommand');assert(unequip)
 player.pos.y=3;tick(.6)
 assert(not row().equipment.movementSuspended)
 local stopped,travel
 for i,event in ipairs(events)do
  if event.kind=='stop' and event.command==unequip then stopped=i end
  if event.kind=='send' and (event.command.kind=='AIMoveToCommand' or event.command.kind=='AIFollowTargetCommand')then travel=i end
 end
 assert(stopped and travel and stopped<travel,'new travel did not retain priority')
 assert(row().operation.ticket~=originalTicket)
`));

test('combat cancels holster and restores native authority without an intermediate idle hold', () => runLua(integration + `
 tick(3.2);local count=#npc.ai.commands
 npc.combat=true;tick(.6)
 assert(row().behavior=='combat' and not row().equipment.movementSuspended)
 assert(#active(npc)==0 and #npc.ai.commands==count)
`));

test('failed native holster restores the idle hold without changing the travel ticket', () => runLua(integration + `
 tick(40)
 assert(row().equipment.phase=='failed' and not row().equipment.movementSuspended)
 assert(row().operation.ticket==originalTicket and row().behavior=='settled')
 assert(last(npc,'AIHoldPositionCommand').state=='Executing')
 assert(npc.weapon==weapon and #active(npc,'AIMoveToCommand')==0)
`));

test('asynchronous hold release is confirmed before any weapon command is sent', () => runLua(integration + `
 npc.ai.delayHold=true;tick(3.2)
 assert(not last(npc,'AIUnequipCommand') and row().equipment.movementSuspended)
 assert(row().behavior=='settled' and not row().operation.failed)
 originalHold.state='Success';tick(.6)
 assert(last(npc,'AIUnequipCommand').state=='Executing')
`));

test('refused hold release preserves that exact hold and stops retrying', () => runLua(integration + `
 npc.ai.rejectHold=true;tick(15)
 assert(not last(npc,'AIUnequipCommand') and row().equipment.phase=='failed')
 assert(last(npc,'AIHoldPositionCommand')==originalHold and originalHold.state=='Executing')
 local stopped=0;for _,e in ipairs(events)do if e.kind=='stop'then stopped=stopped+1 end end
 assert(stopped==1 and not row().equipment.movementSuspended)
`));

test('world teardown abandons suspended movement and equipment without native access', () => runLua(integration + `
 tick(3.2);assert(row().equipment.movementSuspended)
 npc.IsAttached=function()error('native actor destroyed')end
 npc.GetAIControllerComponent=function()error('native AI destroyed')end
 companions.abandon();assert(#companions.list()==0)
`));

// Combat-start weapon draw (M.draw, beginDraw and followDraw in mod/companion-equipment.lua): the game's
// switch-to-primary command once when combat begins with an empty hand, then an explicit equip if the hand is
// still empty a second later. Event-driven on the combat edge, never polled.
const drawing = `
 local classes,reports,stopped={},{},0
 NewObject=function(kind)classes[#classes+1]=kind;return {kind=kind}end
 RPGManager={IsItemWeapon=function()return true end}
 local carried={{GetID=function()return {record='Items.Malorian',hash='m'}end}}
 Game.GetTransactionSystem=function()return {GetItemList=function()return true,carried end}end
 m.report=function(kind,fields)reports[#reports+1]={kind=kind,fields=fields}end
 local function sent(kind)local n=0;for _,c in ipairs(ai.commands)do if c.kind==kind then n=n+1 end end;return n end
 function ai:StopExecutingCommand(c)stopped=stopped+1;c.state='Interrupted' end
 npc.hands[right]=nil
`;

test('combat starting with an empty hand sends the switch-to-primary command once, with unequip off', () => run(drawing + `
 tick(1);assert(#ai.commands==0,'no draw while calm')
 npc.combat=true;tick(.25)
 assert(sent('AISwitchToPrimaryWeaponCommand')==1 and ai.commands[1].unEquip==false,'one switch command')
 assert(m.snapshot(s).draw=='switch' and m.snapshot(s).lastDraw.result=='sent')
 npc.hands[right]=gun('drawn');tick(3)
 assert(#ai.commands==1,'no second draw once the hand holds a weapon')
 assert(stopped==0,'a command that produced a weapon is not interrupted')
 assert(m.snapshot(s).lastDraw.result=='drawn' and m.snapshot(s).draw==nil)
 assert(reports[#reports].kind=='weapon-draw' and reports[#reports].fields.result=='drawn')
`));

test('a hand still empty after a second gets one explicit equip of the primary item with a short duration', () => run(drawing + `
 npc.combat=true;tick(.75);assert(#ai.commands==1)
 tick(.5)
 assert(#ai.commands==2 and sent('AIEquipCommand')==1,'the explicit equip follows')
 local equip=ai.commands[2]
 assert(equip.itemId=='Items.Malorian' and equip.slotId==right and equip.durationOverride==1)
 assert(stopped==1,'the unfinished switch command is replaced, not stacked')
 tick(20);assert(#ai.commands==2,'no more than the switch and one explicit equip')
 assert(m.snapshot(s).lastDraw.result=='empty' and m.snapshot(s).draw==nil)
`));

test('with no primary item to name the explicit equip becomes the bare right-hand slot equip', () => run(drawing + `
 carried[1]=nil
 npc.combat=true;tick(1.5)
 local equip=ai.commands[2]
 assert(equip and equip.kind=='AIEquipCommand' and equip.slotId==right and equip.itemId==nil)
`));

test('a missing switch command goes straight to the explicit equip', () => run(drawing + `
 NewObject=function(kind)
  if kind=='AISwitchToPrimaryWeaponCommand' then return nil end
  classes[#classes+1]=kind;return {kind=kind}
 end
 npc.combat=true;tick(.25)
 assert(#ai.commands==1 and ai.commands[1].kind=='AIEquipCommand' and ai.commands[1].itemId=='Items.Malorian')
 assert(reports[1].fields.result=='refused' and reports[2].fields.result=='sent')
`));

test('no draw when a weapon is already in hand, for the tactic, or for a world the game will not read', () => {
  run(drawing + `npc.hands[right]=gun('ready');npc.combat=true;tick(3);assert(#ai.commands==0)`);
  run(drawing + `npc.hands[right]=gun('fists',true);npc.combat=true;tick(.25);assert(sent('AISwitchToPrimaryWeaponCommand')==1)`);
  run(drawing + `s.noDraw=true;npc.combat=true;tick(3);assert(#ai.commands==0,'the tactic draws for itself')`);
  run(drawing + `ScriptedPuppet.GetWeaponRight=function()error('unreadable')end;npc.combat=true;tick(.25)
   assert(sent('AISwitchToPrimaryWeaponCommand')==1,'an unreadable hand is treated as empty: one draw')`);
});

test('V entering combat draws for a companion that is not in combat herself, once per fight', () => run(drawing + `
 player.combat=true;tick(.25);assert(sent('AISwitchToPrimaryWeaponCommand')==1)
 npc.hands[right]=gun('drawn');tick(5)
 player.combat=false;npc.combat=false;npc.hands[right]=nil;tick(1)
 player.combat=true;tick(.25);assert(sent('AISwitchToPrimaryWeaponCommand')==2,'a new fight draws again')
 tick(.75);assert(sent('AISwitchToPrimaryWeaponCommand')==2,'the same fight does not draw twice')
`));

test('a draw still pending when combat ends is cancelled, and dismissal or teardown forgets it', () => {
  run(drawing + `
   npc.combat=true;tick(.25);assert(#ai.commands==1 and ai.commands[1].state=='Executing')
   npc.combat=false;tick(.25)
   assert(stopped==1 and m.snapshot(s).draw==nil,'the unfinished draw is stopped when the fight ends')
  `);
  run(drawing + `
   npc.combat=true;tick(.25);m.release(s);assert(stopped==1 and m.snapshot(s).draw==nil)
  `);
  run(drawing + `
   npc.combat=true;tick(.25)
   npc.GetAIControllerComponent=function()error('native AI destroyed')end
   m.abandon(s);assert(m.snapshot(s).draw==nil and stopped==0,'teardown touches no native object')
  `);
});

test('the shared draw calls refuse a rejecting AI and stop only running commands', () => run(drawing + `
 ai.accept=false
 assert(not pcall(m.draw.send,npc,'switch'),'a rejected command raises')
 ai.accept=true
 local handle=m.draw.send(npc,'switch')
 handle.command.state='AICommandState : Success (3)';m.draw.cancel(handle,npc);assert(stopped==0)
 handle.command.state='AICommandState : Executing (2)';m.draw.cancel(handle,npc);assert(stopped==1)
`));

test('rearm lets a copy that never reached the combat edge holster after a tactic, and never resets a failed cancellation', () => run(`
 npc.hands[right]=nil;tick(10);assert(m.snapshot(s).phase=='complete' and not m.snapshot(s).armed)
 npc.hands[right]=gun('tactic-draw');tick(20);assert(#ai.commands==0,'not armed: nothing is holstered')
 assert(m.rearm(s)==true and m.snapshot(s).armed)
 tick(6);assert(#ai.commands==1 and s.command.slotId==right,'the holster flow runs again')
 local failed=m.new(npc);failed.cancelFailed=true;assert(m.rearm(failed)==false)
 local gone=m.new(npc);m.abandon(gone);assert(m.rearm(gone)==false and m.rearm(nil)==false)
`));
