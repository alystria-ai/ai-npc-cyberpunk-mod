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
CName={new=function(s) return s end}; NameToString=function() error('Display names must use localization') end
Enum={new=function(_,s) return s end}; EntityID={new=function() return {hash='0ULL'} end}
NewObject=function(kind) return {kind=kind} end
local values={owned=true,tagged=true,managed=true,attached=true,playerState='Default',
  summonState=4,waypoint=true,pinId='3001ULL',destinationId='3001ULL',
  destinationType='PlayerTracked',available=true,enabled=false,queued={},brakes=0}
local player={GetEntityID=function() return {hash='1ULL'} end,IsInCombat=function() return values.combat end}
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
  GetEntityID=function() return {hash='2001ULL'} end,GetRecordID=function() return 'Vehicle.test' end,
  GetRecord=function() return {DisplayName=function() return {key='vehicle-name'} end,
    Type=function() return {Type=function() return 'Car' end} end} end,
  ForceBrakesUntilStoppedOrFor=function(_,seconds) assert(seconds==10); values.brakes=values.brakes+1 end}
local car={id='2001ULL',entityID={hash='2001ULL'},entity=carEntity,owned=false}
local foreign={GetEntityID=function() return {hash='9001ULL'} end}
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
  FindEntityByID=function(id) return id.hash=='2001ULL' and not values.missing and carEntity or nil end,
  GetScriptableSystemsContainer=function() return {Get=function(_,name) assert(name=='AutoDriveSystem'); return auto end} end,
  GetMountingFacility=function() return {Mount=function(_,request) values.mountRequest=request end} end}
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
driver(); passenger(); assert(native.enable(player,entry,car,pin,'seat_front_right',api))
assert(#values.queued==1 and values.queued[1].kind=='EnableAutoDriveRequest')
values.routePosition={x=10,y=20,z=4}; assert(not native.enable(player,entry,car,pin,'seat_front_right',api))
assert(#values.queued==1,'changed native endpoint was accepted')
`));
test('native departure uses a fresh road endpoint for the same Quest and retains its logical binding',()=>run(`
values.destinationType='Quest'; pin=native.sample(player,entry,nil,api).waypoint
driver(); passenger()
values.routePosition={x=-1691.3070068359,y=-603.80609130859,z=7.6229648590088}
values.markerPosition={x=10.28,y=20,z=4.2}
assert(not native.enable(player,entry,car,pin,'seat_front_right',api),'stale road endpoint reached native enable')
pin.position=native.sample(player,entry,car,api).waypoint.position
assert(native.enable(player,entry,car,pin,'seat_front_right',api) and #values.queued==1)
values.destinationType='PlayerTracked'
assert(not native.enable(player,entry,car,pin,'seat_front_right',api),'changed destination type was accepted')
values.destinationType='Quest';values.destinationId='different'
assert(not native.enable(player,entry,car,pin,'seat_front_right',api) and #values.queued==1)
`));
test('manual markers stay fixed while their road projection may change; incomplete identity fails closed',()=>run(`
driver(); passenger()
values.routePosition={x=100,y=200,z=8}; pin.position=values.routePosition
assert(native.enable(player,entry,car,pin,'seat_front_right',api))
values.markerPosition={x=11,y=20,z=4.2}
assert(not native.enable(player,entry,car,pin,'seat_front_right',api),'same-ID manual marker move was accepted')
values.markerPosition=nil;pin.destinationType=nil
assert(not native.enable(player,entry,car,pin,'seat_front_right',api) and #values.queued==1)
`));
test('None, missing native mappin and invalid route points cannot become Free Roam offers',()=>run(`
values.destinationType='None'; assert(not native.sample(player,entry,nil,api).waypoint)
driver(); passenger(); assert(not native.enable(player,entry,car,pin,'seat_front_right',api))
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
driver(); assert(not native.enable(player,entry,car,pin,'seat_front_right',api))
assert(not values.mountRequest and #values.queued==0)
passenger(); values.playerState='Transition'
assert(not native.enable(player,entry,car,pin,'seat_front_right',api) and #values.queued==0)
values.playerState='Passenger'; assert(native.enable(player,entry,car,pin,'seat_front_right',api))
assert(not values.mountRequest and #values.queued==1)
`));
test('native enable submits the ordinary guarded request only for the exact seated pair and destination',()=>run(`
driver(); passenger()
assert(native.enable(player,entry,car,pin,'seat_front_right',api))
assert(#values.queued==1 and values.queued[1].kind=='EnableAutoDriveRequest' and values.queued[1].isDelamain==false)
values.destinationId='changed'; assert(not native.enable(player,entry,car,pin,'seat_front_right',api))
values.destinationId='3001ULL'; values.available=false; assert(not native.enable(player,entry,car,pin,'seat_front_right',api))
values.available=true; values.summoned='different'; assert(not native.enable(player,entry,car,pin,'seat_front_right',api))
assert(#values.queued==1)
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
