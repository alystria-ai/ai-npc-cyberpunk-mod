import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import fengari from 'fengari';
const {lua,lauxlib,lualib,to_luastring,to_jsstring}=fengari;
const source=readFileSync(new URL('../mod/companion-chauffeur-native.lua',import.meta.url),'utf8');
function run(body) {
  const state=lauxlib.luaL_newstate(); lualib.luaL_openlibs(state);
  const program=fixture+'local native=(function() '+source+' end)()\n'+body;
  const status=lauxlib.luaL_dostring(state,to_luastring(program));
  const error=status===lua.LUA_OK?'':to_jsstring(lua.lua_tostring(state,-1));
  lua.lua_close(state); assert.equal(status,lua.LUA_OK,error);
}
const fixture=`
CName={new=function(s) return s end}; NameToString=function(value)
  assert(type(value)=='string','Display names must use localization');return value
end
Enum={new=function(_,s) return s end}; EntityID={new=function() return {hash='0ULL'} end}
NewObject=function(kind)
  if kind=='DriveToPointAutonomousUpdate' then return nil end
  return {kind=kind,id=4294967295,state='NotExecuting',
    GetClassName=function()return kind end,Copy=function(self)return self end}
end
Vector3={new=function(x,y,z)return {x=x,y=y,z=z}end}
Vector4={new=function(x,y,z,w)return {x=x,y=y,z=z,w=w}end}
local values={owned=true,tagged=true,managed=true,attached=true,playerState='Default',
  summonState=4,waypoint=true,pinId='3001ULL',destinationId='3001ULL',
  destinationType='PlayerTracked',available=true,enabled=false,queued={},brakes=0}
local player={GetEntityID=function() return {hash='1ULL'} end,IsInCombat=function() return values.combat end,
  GetWorldPosition=function()return {x=0,y=0,z=3}end}
TSQ_ALL=function()return {}end
TS_TargetPartInfo={GetComponent=function(part)return {GetEntity=function()return part end}end}
PlayerPuppet={GetCurrentVehicleState=function() return values.playerState end}
NPCPuppet={IsInCombat=function() return values.npcCombat end}
local npc={IsAttached=function() return values.attached end,IsDeadNoStatPool=function() return values.dead end,
  GetEntityID=function() return {hash='1001ULL'} end}
local owner={IsReady=function() return true end,IsManaged=function(_,id) return values.managed and id.hash=='1001ULL' end,
  IsTagged=function(_,id,tag) return values.tagged and id.hash=='1001ULL' and tag=='CyberpunkConvaiCompanion' end}
local entry={serial=1,key='judy-alvarez',profileKey='panam-palmer',entityID={hash='1001ULL'},npc=npc,system=owner}
local carEntity={IsAttached=function() return not values.detached end,IsVehicle=function() return true end,
  IsPlayerVehicle=function() return values.owned end,IsDestroyed=function() return values.destroyed end,
  IsPlayerDriver=function() return values.playerState=='Driving' end,
  IsPerformingSceneAnimation=function() return values.scene end,
  GetEntityID=function() return {hash='2001ULL'} end,GetRecordID=function() return values.record or 'Vehicle.test' end,
  GetRecord=function() return {DisplayName=function() return {key='vehicle-name'} end,
    Type=function() return {Type=function() return 'Car' end} end} end,
  ForceBrakesUntilStoppedOrFor=function(_,seconds) assert(seconds==3); values.brakes=values.brakes+1 end}
local car={id='2001ULL',entityID={hash='2001ULL'},entity=carEntity,owned=false}
local foreign={GetEntityID=function() return {hash='9001ULL'} end}
local foreignCommand={id=9001,GetClassName=function()return 'AIVehicleFollowCommand'end,state='Executing'}
local function active()
  local command=values.command
  if command and (command.state=='Executing' or command.state=='Enqueued' or command.state=='NotExecuting') then return command end
end
local ai={GetReservedSeatsCount=function()return values.reservations or 0 end,
  GetInitCmd=function()return values.initialCommand end,
  GetEnqueuedOrExecutingCommand=function(_,name,inherit)
    if name=='AIVehicleCommand' and inherit and values.foreignCommand then return foreignCommand end
    if name=='AIVehicleCommand' or name=='AIVehicleDriveToPointAutonomousCommand' then return active() end
  end,
  IsCommandActive=function(_,id)return active() and active().id==id or false end,
  GetCommandState=function(_,command)
    if values.stateError then error('Native command state unavailable') end
    return command.state
  end,
  SendCommand=function(_,command)
    values.sent=(values.sent or 0)+1
    assert(command.id==4294967295,'Identity was captured before native submission')
    if values.refused then return false end
    command.id=1800+values.sent;command.state='Executing';values.command=command
    if values.sendThrows then error('Submission exception after side effect') end
    return true
  end,
  SetDriveToPointAutonomousUpdate=function(_,update)
    values.updates=(values.updates or 0)+1;values.update=update
    assert(update.kind=='AIDriveToPointAutonomousUpdate','Incorrect script-alias constructor')
  end,
  StopExecutingCommand=function(_,command,success)
    assert(command==values.command and success==false,'Foreign command or fabricated arrival')
    values.stops=(values.stops or 0)+1
    if values.stopThrowsBefore then error('Stop exception before side effect') end
    if values.stopRefused then return false end
    if not values.cancelBlocked then command.state='Cancelled' end
    if values.stopThrowsAfter then error('Stop exception after side effect') end
    return true
  end,
  CancelCommand=function(_,command)
    assert(command==values.command);values.stops=(values.stops or 0)+1
    if not values.cancelBlocked then command.state='Cancelled' end
    return true
  end}
function carEntity:GetAIComponent()return ai end
function carEntity:IsExecutingAnyCommand()return active()~=nil or values.foreignCommand==true end
function carEntity:IsAutoDriveModeEnabled()return values.enabled end
function carEntity:CommandsFromDriverEnabled()return not values.driverCommandsDisabled end
function carEntity:GetWorldPosition()return values.carPosition or {x=0,y=0,z=3}end
function carEntity:GetCurrentSlotLocalPathLength()return 100 end
function carEntity:GetCurrentSlotLocalPathProgression()return 10 end
local auto={GetAutodriveEnabled=function() return values.enabled end,
  GetAutodriveIsDelamain=function() return values.delamain end,
  GetAutodriveVehicle=function() return values.foreign and foreign or values.enabled and carEntity or nil end,
  GetAutodriveAvailable=function() return values.available end,
  CheckCurrentLaneValidity=function() return values.lane or 'OnValidLane' end,
  GetAutodriveDestinationMappinID=function() return {value=values.destinationId} end,
  GetAutodriveDestination=function() return values.routePosition or {x=10,y=20,z=3} end,
  GetAutodriveDestinationType=function() return values.destinationType end,
  GetFreeRoamEnabled=function() return false end,GetDistanceToCurrentDestination=function() return 99 end,
  QueueRequest=function(_,request) values.queued[#values.queued+1]=request end}
GetAllBlackboardDefs=function() error('Use the proven Game.GetAllBlackboardDefs binding') end
GetLocalizedText=function(key)
  assert(key=='LocKey#36647')
  if values.waypointLocalizationError then error('Waypoint localization unavailable') end
  return 'Selected quest title'
end
Game={GetDynamicEntitySystem=function() return owner end,
  GetPlayer=function()return player end,
  GetAllBlackboardDefs=function() return {VehicleSummonData={SummonedVehicleEntityID='id',SummonState='state'}} end,
  GetLocalizedTextByKey=function(key)
    assert(key.key=='vehicle-name'); if values.localizationError then error('Localization unavailable') end
    return values.localizedName or 'Test vehicle'
  end,
  GetMappinSystem=function() return {GetManuallyTrackedMappinID=function() return {value=values.waypoint and values.pinId or '0ULL'} end,
    GetMappin=function(_,id)
      assert(id.value==values.destinationId,'Selected native destination was not used')
      if values.missingDestination then return nil end
      return {GetWorldPosition=function() return values.markerPosition or {x=10,y=20,z=4.2} end,
        GetDisplayName=function() return values.waypointName or 'Waypoint' end}
    end} end,
  GetBlackboardSystem=function() return {Get=function() return {
    GetEntityID=function() return {hash=values.summoned or '2001ULL'} end,
    GetUint=function() return values.summonState end} end} end,
  FindEntityByID=function(id) return id.hash=='2001ULL' and not values.missing and carEntity or values.extraEntities and values.extraEntities[id.hash] end,
  GetTargetingSystem=function()return {GetTargetParts=function(_,who,query)
    assert(who==player and query.testedSet=='Complete' and query.maxDistance==20
      and query.filterObjectByDistance and query.includeSecondaryTargets and query.ignoreInstigator)
    values.queries=(values.queries or 0)+1;return true,values.nearby or {}
  end}end,
  GetVehicleSystem=function()return {GetActivePlayerVehicle=function(_,kind)
    assert(kind=='Car');return {recordID=values.activeRecord or 'Vehicle.test'}
  end}end,
  GetScriptableSystemsContainer=function() return {Get=function(_,name) assert(name=='AutoDriveSystem'); return auto end} end,
  GetMountingFacility=function() return {Mount=function(_,request) values.mountRequest=request end,
    GetMountingInfoSingleWithIds=function(_,child,parent,slot)
      assert(child.hash=='0ULL' and parent.hash=='2001ULL')
      if slot.id=='seat_front_left' then
        return {childId={hash=values.otherDriver or values.driverMount and '1001ULL' or '0ULL'}}
      end
      assert(slot.id=='seat_front_right');return {childId={hash=values.playerMount and '1ULL' or '0ULL'}}
    end} end}
local api={mounting=function(value)
    return value.npc==player and values.playerMount or value.npc==npc and values.driverMount or nil
  end,
  inspect=function() return {ready=not values.detached,invalid=values.destroyed,speed=values.speed or 0,
    playerGap=3,scene=values.scene,seats={{name='seat_front_left',occupant=values.driverMount and '1001ULL'},
      {name='seat_front_right',occupant=values.passengerOccupied,reserved=values.passengerReserved}}} end}
local function driver() values.driverMount={vehicle=car.id,seat='seat_front_left'} end
local function passenger() values.playerMount={vehicle=car.id,seat='seat_front_right'}; values.playerState='Passenger' end
local pin={id='3001ULL',position={x=10,y=20,z=3},destinationType='PlayerTracked',
  markerPosition={x=10,y=20,z=4.2}}
`;

test('native reads summoned entity and selected native destination without starting or modifying anything',()=>run(`
local sample=native.sample(player,entry,nil,api)
assert(sample.actorValid and sample.actor.key=='panam-palmer' and sample.car.id=='2001ULL')
assert(not sample.car.owned and sample.waypoint.id=='3001ULL' and sample.auto.playerTracked)
assert(sample.waypoint.destinationType=='PlayerTracked' and sample.waypoint.markerPosition.z==4.2)
assert(sample.car.name=='Test vehicle')
assert(#values.queued==0 and values.brakes==0 and not values.mountRequest)
values.summonState=1; assert(native.sample(player,entry,nil,api).summonEnRoute)
values.owned=false; assert(not native.sample(player,entry,nil,api).carValid)
values.tagged=false; assert(not native.sample(player,entry,nil,api).actorValid)
`));
test('restored owned car is found without summon and remains a borrowed exact lease',()=>run(`
values.summoned='0ULL';values.summonState=0;values.nearby={carEntity,carEntity}
local sample=native.sample(player,entry,nil,api)
assert(sample.carValid and sample.car.id=='2001ULL' and sample.carSource=='nearby-owned')
assert(sample.summonedId==nil and not sample.car.owned and values.queries==1)
local restored=sample.car;restored.summonBaseline={id=sample.summonedId,state=sample.summonState}
driver();passenger();values.activeRecord='Vehicle.other'
assert(native.start(player,entry,restored,pin,'seat_front_right',api) and values.queries==1)
values.summoned='9001ULL';assert(not native.start(player,entry,restored,pin,'seat_front_right',api))
values.summoned='0ULL';values.summonState=1
assert(not native.start(player,entry,restored,pin,'seat_front_right',api))
values.summonState=0;values.record='Vehicle.replaced'
assert(not native.sample(player,entry,restored,api).carValid and values.queries==1)
`));
test('seated drive: the car is the exact owned vehicle V sits in, never a summon or nearby substitute',()=>run(`
values.summoned='9001ULL';values.nearby={}
values.playerMount={vehicle='2001ULL',parent={hash='2001ULL'},seat='seat_front_left'};values.playerState='Driver'
local sample=native.sample(player,entry,nil,api)
assert(sample.carValid and sample.car.id=='2001ULL' and sample.carSource=='mounted' and values.queries==nil)
-- V sits in a vehicle that is not one of their own cars: no car at all, so no offer can name another one
values.playerMount={vehicle='7ULL',parent={hash='7ULL'},seat='seat_front_right'}
values.extraEntities={['7ULL']={IsAttached=function()return true end,IsVehicle=function()return true end,
  IsPlayerVehicle=function()return false end,IsDestroyed=function()return false end}}
sample=native.sample(player,entry,nil,api)
assert(sample.car==nil and values.queries==nil and #values.queued==0 and not values.mountRequest)
`));
test('nearby discovery filters traffic, distant cars and duplicate parts and rejects ambiguous owned cars',()=>run(`
values.summoned='0ULL'
local function clone(id,record,x,owned)
 local e={};for k,v in pairs(carEntity)do e[k]=v end
 e.GetEntityID=function()return {hash=id}end;e.GetRecordID=function()return record end
 e.GetWorldPosition=function()return {x=x,y=0,z=3}end;e.IsPlayerVehicle=function()return owned end
 return e
end
local traffic=clone('3001ULL','Vehicle.traffic',2,false)
local far=clone('4001ULL','Vehicle.far',25,true)
local other=clone('5001ULL','Vehicle.other',4,true)
values.nearby={traffic,far,carEntity,carEntity}
assert(native.sample(player,entry,nil,api).car.id=='2001ULL')
values.nearby={carEntity,other};values.activeRecord='Vehicle.other'
assert(native.sample(player,entry,nil,api).car.id=='5001ULL')
values.activeRecord='Vehicle.unspawned'
local ambiguous=native.sample(player,entry,nil,api)
assert(not ambiguous.car and ambiguous.carSelectionError=='ambiguous')
values.nearby={traffic,far}
assert(not native.sample(player,entry,nil,api).car)
values.summoned='2001ULL';values.nearby={other};values.activeRecord='Vehicle.other'
local queries=values.queries
assert(native.sample(player,entry,nil,api).car.id=='2001ULL' and values.queries==queries)
`));
test('cosmetic localization failure preserves the exact car identity and sample availability',()=>run(`
values.localizationError=true
local sample=native.sample(player,entry,nil,api)
assert(sample.actorValid and sample.carValid and sample.car.id=='2001ULL' and sample.car.name=='Vehicle.test')
values.localizationError=false; values.localizedName=''
assert(native.sample(player,entry,nil,api).car.name=='Vehicle.test')
assert(#values.queued==0 and not values.mountRequest)
`));
test('Quest destination works with zero manual tracker and uses the actual native route point',()=>run(`
values.waypoint=false; values.destinationType='Quest'; values.waypointName='LocKey#36647'
assert(Game.GetMappinSystem():GetManuallyTrackedMappinID().value=='0ULL')
local sample=native.sample(player,entry,nil,api)
assert(sample.auto.questTracked and not sample.auto.playerTracked and sample.waypoint.id=='3001ULL')
assert(sample.waypoint.position.z==3 and sample.waypoint.name=='Selected quest title')
assert(sample.waypoint.destinationType=='Quest' and sample.waypoint.markerPosition.z==4.2)
pin=sample.waypoint
driver(); passenger(); assert(native.start(player,entry,car,pin,'seat_front_right',api))
assert(values.sent==1 and #values.queued==0)
values.routePosition={x=10,y=20,z=4}; assert(not native.start(player,entry,car,pin,'seat_front_right',api))
assert(values.sent==1,'changed native endpoint was accepted')
`));
test('native departure uses a fresh road endpoint for the same Quest and retains its logical binding',()=>run(`
values.destinationType='Quest'; pin=native.sample(player,entry,nil,api).waypoint
driver(); passenger()
values.routePosition={x=-1691.3070068359,y=-603.80609130859,z=7.6229648590088}
values.markerPosition={x=10.28,y=20,z=4.2}
assert(not native.start(player,entry,car,pin,'seat_front_right',api),'stale road endpoint reached native enable')
pin.position=native.sample(player,entry,car,api).waypoint.position
assert(native.start(player,entry,car,pin,'seat_front_right',api) and values.sent==1)
values.destinationType='PlayerTracked'
assert(not native.start(player,entry,car,pin,'seat_front_right',api),'changed destination type was accepted')
values.destinationType='Quest';values.destinationId='different'
assert(not native.start(player,entry,car,pin,'seat_front_right',api) and values.sent==1)
`));
test('manual markers stay fixed while their road projection may change; incomplete identity fails closed',()=>run(`
driver(); passenger()
values.routePosition={x=100,y=200,z=8}; pin.position=values.routePosition
assert(native.start(player,entry,car,pin,'seat_front_right',api))
values.markerPosition={x=11,y=20,z=4.2}
assert(not native.start(player,entry,car,pin,'seat_front_right',api),'same-ID manual marker move was accepted')
values.markerPosition=nil;pin.destinationType=nil
assert(not native.start(player,entry,car,pin,'seat_front_right',api) and values.sent==1)
`));
test('None, missing native mappin and invalid route points cannot become Free Roam offers',()=>run(`
values.destinationType='None'; assert(not native.sample(player,entry,nil,api).waypoint)
driver(); passenger(); assert(not native.start(player,entry,car,pin,'seat_front_right',api))
values.destinationType='Quest'; values.missingDestination=true
assert(not native.sample(player,entry,nil,api).waypoint)
values.missingDestination=false; values.routePosition={x=0/0,y=20,z=3}
assert(not native.sample(player,entry,nil,api).waypoint and #values.queued==0)
`));
test('quest destination cosmetic label failure uses a friendly fallback without losing route identity',()=>run(`
values.destinationType='Quest'; values.waypointName='LocKey#36647'; values.waypointLocalizationError=true
local sample=native.sample(player,entry,nil,api)
assert(sample.waypoint.id=='3001ULL' and sample.waypoint.name=='Selected quest destination')
`));
test('native boundary observes manual boarding and has no player mounting operation',()=>run(`
assert(native.mountPlayer==nil)
driver(); assert(not native.start(player,entry,car,pin,'seat_front_right',api))
assert(not values.mountRequest and #values.queued==0)
passenger(); values.playerState='Transition'
assert(not native.start(player,entry,car,pin,'seat_front_right',api) and #values.queued==0)
values.playerState='Passenger'; assert(native.start(player,entry,car,pin,'seat_front_right',api))
assert(not values.mountRequest and values.sent==1 and #values.queued==0)
`));
test('native departure submits one physical NPC vehicle command with the actual post-send ID and explicit settings',()=>run(`
driver(); passenger()
local operation=assert(native.start(player,entry,car,pin,'seat_front_right',api))
assert(values.sent==1 and #values.queued==0 and not values.enabled)
assert(native.driveReceipt(operation).id==1801 and operation.carId==car.id)
assert(values.command.kind=='AIVehicleDriveToPointAutonomousCommand' and values.command.needDriver)
assert(not values.command.useKinematic and not values.command.clearTrafficOnPath and not values.command.driveDownTheRoadIndefinitely)
assert(values.command.maxSpeed==8 and values.command.minSpeed==-1 and values.command.forcedStartSpeed==-1)
assert(values.command.minimumDistanceToTarget==5 and values.command.targetPosition.x==10)
values.destinationId='changed'; assert(not native.start(player,entry,car,pin,'seat_front_right',api))
values.destinationId='3001ULL'; values.lane='NotOnRoad'; assert(not native.start(player,entry,car,pin,'seat_front_right',api))
values.lane='OnValidLane'; values.summoned='different'; assert(not native.start(player,entry,car,pin,'seat_front_right',api))
assert(values.sent==1 and #values.queued==0)
`));
test('constructor sentinel cannot become a receipt and send exceptions preserve an assigned native command',()=>run(`
assert(native.driveReceipt({handle=NewObject('AIVehicleDriveToPointAutonomousCommand')})==nil)
driver();passenger();values.sendThrows=true
local operation,why=native.start(player,entry,car,pin,'seat_front_right',api)
assert(operation and why and native.driveReceipt(operation).id==1801 and values.sent==1)
assert(native.stop(operation,car) and values.stops==1)
`));
test('refused native submission has no command lease or AutoDrive side effect',()=>run(`
driver();passenger();values.refused=true
assert(native.start(player,entry,car,pin,'seat_front_right',api)==nil)
assert(values.sent==1 and not values.command and #values.queued==0 and values.brakes==0)
`));
test('retarget uses the measured AIDrive RTTI class only while the exact owned command remains current',()=>run(`
driver();passenger();local operation=assert(native.start(player,entry,car,pin,'seat_front_right',api))
local changed={id='different',position={x=200,y=400,z=3}}
assert(native.retarget(operation,car,changed) and values.updates==1)
assert(values.update.targetPosition.x==200 and values.update.targetPosition.w==1)
assert(values.update.maxSpeed==8 and values.update.minSpeed==-1 and values.update.minimumDistanceToTarget==5)
assert(not values.update.clearTrafficOnPath and not values.update.driveDownTheRoadIndefinitely)
values.playerMount=nil;assert(not native.retarget(operation,car,changed) and values.updates==1)
passenger()
values.foreignCommand=true
assert(not native.retarget(operation,car,changed) and values.updates==1)
values.foreignCommand=false;operation.handle.state='Interrupted'
local replacement=NewObject('AIVehicleDriveToPointAutonomousCommand');replacement.id=9000;replacement.state='Executing';values.command=replacement
assert(not native.retarget(operation,car,changed) and values.updates==1)
assert(native.stop(operation,car) and not values.stops,'A replacement command was cancelled')
assert(not native.brake(car,operation) and values.brakes==0)
`));

test('a cleared arrival marker retains distance to the owned applied command target',()=>run(`
driver();passenger();local operation=assert(native.start(player,entry,car,pin,'seat_front_right',api))
operation.handle.state='Success';values.waypoint=false;values.destinationType='None'
local sample=assert(native.sample(player,entry,car,api,operation))
assert(sample.waypoint==nil and sample.drive.state=='Success')
assert(type(sample.drive.distance)=='number' and sample.drive.distance>=0)
local unknown=assert(native.sample(player,entry,car,api,nil))
assert(unknown.drive.distance==nil,'a missing native operation invented a remembered destination')
`));
test('exact cancellation is sent once, never fabricates Success, and terminal commands retain guarded brake authority',()=>run(`
driver();passenger();local operation=assert(native.start(player,entry,car,pin,'seat_front_right',api))
values.cancelBlocked=true;assert(not native.stop(operation,car))
for i=1,5 do assert(not native.stop(operation,car)) end
assert(values.stops==1 and operation.cancelRequested)
operation.handle.state='Interrupted';assert(native.stop(operation,car))
assert(native.brake(car,operation) and values.brakes==1)
values.otherDriver='4001ULL';assert(not native.brake(car,operation) and values.brakes==1)
values.otherDriver=nil;values.playerState='Driving';assert(not native.brake(car,operation))
values.playerState='Passenger';values.scene=true;assert(not native.brake(car,operation))
`));
test('native driver-command permissions and unsettled reservations block departure without sending',()=>run(`
driver();passenger();values.driverCommandsDisabled=true
assert(not native.start(player,entry,car,pin,'seat_front_right',api))
values.driverCommandsDisabled=false;values.reservations=1
assert(not native.start(player,entry,car,pin,'seat_front_right',api))
assert(not values.sent and #values.queued==0)
`));
test('optional traffic telemetry cannot prevent retiring an otherwise verified command',()=>run(`
driver();passenger();local operation=assert(native.start(player,entry,car,pin,'seat_front_right',api))
carEntity.GetCurrentSlotLocalPathLength=function()error('Optional path telemetry unavailable')end
assert(native.inspectDrive(car,operation).known)
assert(native.stop(operation,car) and values.stops==1)
`));
test('retirement retries a pre-side-effect exception or explicit refusal without losing the exact command',()=>run(`
driver();passenger();local operation=assert(native.start(player,entry,car,pin,'seat_front_right',api))
values.stopThrowsBefore=true;assert(not native.stop(operation,car) and values.stops==1)
values.stopThrowsBefore=false;values.stopRefused=true;assert(not native.stop(operation,car) and values.stops==2)
values.stopRefused=false;assert(native.stop(operation,car) and values.stops==3)
assert(operation.handle==values.command and native.driveReceipt(operation).stopSubmissions==3)
`));
test('a post-side-effect exception is reconciled from terminal evidence and persistent refusals are bounded',()=>run(`
driver();passenger();local operation=assert(native.start(player,entry,car,pin,'seat_front_right',api))
values.stopThrowsAfter=true;assert(native.stop(operation,car) and values.stops==1)
assert(native.stop(operation,car) and values.stops==1)
values.stopThrowsAfter=false;values.command=nil
operation=assert(native.start(player,entry,car,pin,'seat_front_right',api));values.stopRefused=true
for i=1,8 do assert(not native.stop(operation,car)) end
assert(values.stops==4 and native.driveReceipt(operation).stopSubmissions==3)
`));
test('native disable rejects a foreign or Delamain trip and guards a pending request with V mounting',()=>run(`
values.enabled=true; values.foreign=true
assert(not native.disable(player,car,false,api) and #values.queued==0)
values.foreign=false; values.delamain=true
assert(not native.disable(player,car,false,api) and #values.queued==0)
values.delamain=false; assert(native.disable(player,car,false,api))
assert(values.queued[1].kind=='DisableAutoDriveRequest')
values.enabled=false
assert(not native.disable(player,car,true,api) and #values.queued==1)
passenger(); assert(native.disable(player,car,true,api) and #values.queued==2)
`));
test('borrowed car braking rejects V takeover, scenes, missing entities, and lost player ownership',()=>run(`
values.playerState='Driving'; assert(not native.brake(car))
values.playerState='Passenger'; values.scene=true; assert(not native.brake(car))
values.scene=false; values.owned=false; assert(not native.brake(car))
values.owned=true; values.missing=true; assert(not native.brake(car))
values.missing=false; assert(native.brake(car) and values.brakes==1)
`));
test('the Delamain cab is never chosen as an owned car, summoned or nearby',()=>run(`
TweakDBID={new=function(value) return value end}
values.nearby={carEntity}
assert(native.sample(player,entry,nil,api).car.id=='2001ULL')
for _,record in ipairs({'Vehicle.v_standard2_villefort_cortes_delamain_player','Vehicle.v_delamain_taxi'}) do
  values.record=record
  local sample=native.sample(player,entry,nil,api)
  assert(not sample.car,record)
end
values.record='Vehicle.test'
assert(native.sample(player,entry,nil,api).car.id=='2001ULL')
`));

// Her car (docs/IMMERSIVE_INVITATIONS.md): a car the mod made for an invited companion, not one V owns. Only while the immersive-invitation glue
// has set the two hooks, only when V has no car of V's own to use, and the lease keeps the flag so every later read accepts it.
test('her car: with no car of V\'s own and the hooks set, the companion drives the car she arrived in; without them nothing changes', () => run(`
values.owned=false;values.summoned='0ULL';values.nearby={}
assert(native.sample(player,entry,nil,api).car==nil,'a car that is not V\\'s own is not offered')
local asked
rawset(_G,'convaiCompanionCar',function(profileKey) asked=profileKey; return carEntity end)
rawset(_G,'convaiCompanionCarIs',function(entity) return entity==carEntity end)
local sample=native.sample(player,entry,nil,api)
assert(asked=='panam-palmer','the hook is asked for her profile')
assert(sample.car,'car'); assert(sample.carValid,'valid'); assert(sample.carSource=='companion','source '..tostring(sample.carSource)); assert(sample.car.companionCar==true,'flag'); assert(not sample.car.owned)
-- the lease keeps the flag: later samples of the trip still accept the car
local lease=sample.car
local again=native.sample(player,entry,lease,api)
assert(again.car,'lease car'); assert(again.carValid,'lease valid'); assert(again.car.companionCar==true)
-- a car that is not one of hers is refused
rawset(_G,'convaiCompanionCarIs',function() return false end)
assert(not native.sample(player,entry,lease,api).carValid,'refused')
-- V's own car wins when there is one
rawset(_G,'convaiCompanionCarIs',function(entity) return entity==carEntity end)
values.owned=true;values.nearby={carEntity}
local own=native.sample(player,entry,nil,api); assert(own.carSource=='nearby-owned' and own.car.companionCar==nil,'v own wins '..tostring(own.carSource))
values.nearby={}
-- the hooks removed: back to the old rules
rawset(_G,'convaiCompanionCar',nil);rawset(_G,'convaiCompanionCarIs',nil)
values.owned=false
assert(native.sample(player,entry,nil,api).car==nil,'hooks removed')
`));
