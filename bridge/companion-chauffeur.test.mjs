import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import fengari from 'fengari';
const {lua,lauxlib,lualib,to_luastring,to_jsstring}=fengari;
const read=name=>readFileSync(new URL('../mod/'+name,import.meta.url),'utf8');
const controller=read('companion-vehicles.lua');
const coordinator=read('companion-chauffeur.lua');
const catalog=read('companion-vehicle-catalog.lua');
function run(body) {
  const state=lauxlib.luaL_newstate(); lualib.luaL_openlibs(state);
  const program=fixture+body;
  const status=lauxlib.luaL_dostring(state,to_luastring(program));
  const error=status===lua.LUA_OK?'':to_jsstring(lua.lua_tostring(state,-1));
  const line=Number(/\]:(\d+):/.exec(error)?.[1]);
  lua.lua_close(state); assert.equal(status,lua.LUA_OK,error+(line?'\n'+program.split('\n')[line-1]:''));
}
const fixture=`
local catalog=(function() ${catalog} end)()
local chauffeur
dofile=function(name)
  if name=='companion-chauffeur.lua' then return chauffeur end
  if name=='companion-vehicle-catalog.lua' then return catalog end
  error('Unexpected module '..name)
end
chauffeur=(function() ${coordinator} end)()
local transport=(function() ${controller} end)()
local player={}
local entry={serial=1,key='judy-alvarez',profileKey='judy-alvarez',entityID={hash='1001ULL'},npc={}}
local other={serial=2,key='panam-palmer',entityID={hash='1002ULL'},npc={}}
local entries={entry}
local car={id='2001ULL',entityID={hash='2001ULL'},record='Vehicle.test',name='Test car',owned=false}
local world={valid=true,calm=true,carValid=true,summoned=car.id,mounts={},commands={},events={},
  waypoint={id='3001ULL',name='Map pin',position={x=100,y=50,z=0}},
  destinationType='PlayerTracked',markerPosition={x=100,y=50,z=1.2},
  auto={enabled=false,available=true,playerTracked=true,destinationId='3001ULL',remaining=100,freeRoam=false},
  mountsRequested=0,playerMounts=0,enables=0,disables=0,brakes=0,unmounts=0,resumes=0,releases=0,deleted=0}
world.cars={[car.id]=car}; world.spawned={}; world.follows=0
car.info={ready=true,speed=0,playerGap=3,seats={{name='seat_front_left'},{name='seat_front_right'},
  {name='seat_back_left'},{name='seat_back_right'}}}
local function actual(who,seat,targetCar)
  targetCar=targetCar or car
  local key=who=='player' and 'player' or who.serial
  local id=who=='player' and '1ULL' or who.entityID.hash
  for _,vehicle in pairs(world.cars) do
    for _,row in ipairs(vehicle.info.seats) do if row.occupant==id then row.occupant=nil end end
  end
  world.mounts[key]=seat and {vehicle=targetCar.id,seat=seat} or nil
  if seat then for _,row in ipairs(targetCar.info.seats) do if row.name==seat then row.occupant=id end end end
  car.info.playerMounted=world.mounts.player~=nil
end
local api={}
function api.player() return world.mounts.player and car or nil end
function api.inspect(vehicle) return vehicle.info end
function api.mounting(value) return world.mounts[value.serial or 'player'] end
function api.canBoard() return world.calm end
function api.mount(value,vehicle,seat,exit)
  local command={entry=value,car=vehicle,seat=seat,state='Executing',exit=exit}
  world.commands[#world.commands+1]=command
  if exit then world.unmounts=world.unmounts+1 else world.mountsRequested=world.mountsRequested+1 end
  if not world.delayDriver then actual(value,not exit and seat or nil,vehicle); command.state='Success' end
  return command
end
function api.commandState(command) world.commandReads=(world.commandReads or 0)+1; return command.state end
function api.cancel(command)
  command.cancels=(command.cancels or 0)+1
  if world.cancelBlocked then return false end
  command.state='Cancelled'; return true
end
function api.commandReceipt(command) return command and {id=command.id or 1,
  class=command.drive and 'AIVehicleDriveToPointAutonomousCommand' or 'AIMountCommand'} end
function api.retiredCommand() return nil end
function api.rebindVehicle(receipt) return world.cars[receipt.id] end
function api.destroy(vehicle)
  assert(vehicle.owned,'Borrowed car deletion')
  for _,row in ipairs(vehicle.info.seats) do assert(not row.occupant,'Occupied car deletion') end
  world.deleted=world.deleted+1; world.cars[vehicle.id]=nil; return true
end
function api.spawn(choice)
  local value={id=tostring(4000+#world.spawned)..'ULL',owned=true,record=choice.record,name=choice.name,
    info={ready=true,speed=0,playerGap=5,seats={{name='seat_front_left'},{name='seat_front_right'},
      {name='seat_back_left'},{name='seat_back_right'}}}}
  value.entityID={hash=value.id}; world.cars[value.id]=value; world.spawned[#world.spawned+1]=value; return value
end
function api.follow(vehicle)
  assert(vehicle.owned,'Borrowed car received convoy command')
  world.follows=world.follows+1
  local command={state='Executing',car=vehicle,follow=true}; world.commands[#world.commands+1]=command; return command
end
function api.brake(vehicle)
  assert(vehicle.owned,'Borrowed car used ordinary brake permission')
  vehicle.info.speed=0; return true
end
function api.recover() return true end
local native={}
function native.sample(_,value,_,_,operation)
  if world.readError then error('World unavailable') end
  local waypoint=world.waypoint and {id=world.waypoint.id,name=world.waypoint.name,position=world.waypoint.position,
    destinationType=world.destinationType,markerPosition=world.markerPosition}
  return {actor={id=value.entityID.hash,serial=value.serial,key=value.profileKey},actorValid=world.valid,actorCalm=world.calm,
    actorAttached=not world.actorDetached,actorDead=world.actorDead,
    playerId='1ULL',playerMount=world.mounts.player,playerPassenger=world.mounts.player and not world.playerTransition
      and world.mounts.player.seat~='seat_front_left',driverMount=world.mounts[value.serial],
    playerCombat=world.combat,car=not world.detached and car or nil,carValid=world.carValid,
    info=world.detached and {ready=false} or car.info,summonedId=world.summoned,summonEnRoute=world.enRoute,
    summonState=world.summonState or (world.enRoute and 1 or 0),carSelectionError=world.carSelectionError,
    waypoint=waypoint,auto=world.auto,drive={known=not world.driveUnknown,ready=not world.driveUnavailable,
      reservations=world.reservations or 0,busy=world.foreignDrive or world.driveCommand
        and (world.driveCommand.state=='Executing' or world.driveCommand.state=='NotExecuting'),
      foreign=world.foreignDrive==true or world.auto.enabled==true,
      state=operation and operation.state,ownedActive=operation and operation==world.driveCommand
        and (operation.state=='Executing' or operation.state=='Enqueued'),
      commandId=operation and operation.id,remaining=world.auto.remaining,
      distance=world.routeDistance or 100}}
end
function native.mountPlayer()
  world.playerMounts=world.playerMounts+1
  error('The mod must never mount V')
end
function native.start(_,_,_,pin,seat)
  assert(world.mounts[1] and world.mounts.player and world.mounts.player.seat~='seat_front_left')
  assert(world.mounts.player.seat==seat,'Departure used a stale passenger seat')
  assert(pin.id==world.waypoint.id and pin.destinationType==world.destinationType,'Departure lost logical destination binding')
  for _,key in ipairs({'x','y','z'}) do
    assert(pin.position[key]==world.waypoint.position[key],'Departure used the frozen road endpoint')
  end
  world.enablePoint={x=pin.position.x,y=pin.position.y,z=pin.position.z}
  world.enableSeat=seat
  if world.auto.destinationId~=pin.id or not (world.auto.playerTracked or world.auto.questTracked) then
    return nil,'Stale native destination'
  end
  world.enables=world.enables+1
  if world.rejectEnable then return nil,'Rejected' end
  local command={id=100+world.enables,drive=true,carId=car.id,
    state=world.delayEnable and 'NotExecuting' or 'Executing'}
  world.driveCommand=command
  return command
end
function native.driveReceipt(command)
  return command and {id=command.id,class='AIVehicleDriveToPointAutonomousCommand',cancelRequested=command.cancelRequested==true}
end
function native.retarget(command,_,pin)
  assert(command==world.driveCommand,'Foreign driving command was retargeted')
  world.retargets=(world.retargets or 0)+1
  world.enablePoint={x=pin.position.x,y=pin.position.y,z=pin.position.z}
  return true
end
function native.stop(command,vehicle)
  assert(command==world.driveCommand and vehicle==car,'Foreign driving command was cancelled')
  if command.state=='Success' or command.state=='Failure' or command.state=='Cancelled' or command.state=='Interrupted' then return true end
  if command.cancelRequested then return false,'Still retiring' end
  world.disables=world.disables+1
  command.cancelRequested=true
  if world.disableBlocked then return false,'Still running' end
  command.state='Cancelled'; return true
end
function native.brake()
  if world.auto.enabled or world.foreignDrive or car.info.scene
      or world.mounts.player and world.mounts.player.seat=='seat_front_left' then return false,'Foreign control' end
  world.brakes=world.brakes+1
  if not world.brakeBlocked then car.info.speed=0 end
  return true
end
local hooks={release=function() world.releases=world.releases+1; return not world.releaseBlocked end,
  resumed=function() world.resumes=world.resumes+1 end}
local fleet=transport.new(api,native)
world.auto.laneValid=true
local function tick(count,step)
  for _=1,count or 1 do transport.update(fleet,player,entries,step or 0.1,hooks) end
end
local function queue(expected) return transport.queueChauffeur(fleet,player,entry,expected) end
local function phase() return transport.chauffeurSnapshot(fleet).phase end
local function boardManually(seat) actual('player',seat or 'seat_front_right'); tick(8) end
local function driving()
  assert(queue()); tick(12); assert(phase()=='waiting-for-player',phase())
  boardManually(); assert(phase()=='driving',phase()); assert(world.playerMounts==0)
end
`;

test('offer is read-only, carries exact identities, and stale map intents are rejected',()=>run(`
local offer=transport.chauffeurOffer(fleet,player,entry)
assert(offer.available and offer.actor.id=='1001ULL' and offer.car.id=='2001ULL' and offer.waypoint.id=='3001ULL')
assert(offer.passengerSeat=='seat_front_right' and not offer.car.entity and world.mountsRequested==0)
local fields=0;for key in pairs(offer.waypoint) do
  fields=fields+1;assert(key=='id' or key=='position' or key=='name','native-only route metadata leaked into bridge offer')
end
assert(fields==3)
offer.waypoint.position.x=-55
assert(world.waypoint.position.x==100,'offer mutated native sample')
assert(not queue(offer) and not fleet.chauffeur and world.enables==0)
`));
test('V is asked to step out of the driver seat and an existing AutoDrive trip is rejected',()=>run(`
actual('player','seat_front_left')
local offer=transport.chauffeurOffer(fleet,player,entry)
assert(not offer.available and offer.code=='player-driving' and not queue())
assert(world.unmounts==0 and world.playerMounts==0)
actual('player',nil); world.auto.enabled=true
assert(not queue() and world.disables==0 and world.brakes==0)
`));
test('restored owned car admits nil or stale summon baseline and new summon cancels the exact trip',()=>run(`
world.summoned=nil
assert(queue());assert(fleet.primary==car and not car.owned and next(fleet.cars)==nil)
assert(car.summonBaseline.id==nil and car.summonBaseline.state==0)
tick(12);boardManually();assert(phase()=='driving')
world.summonState=4;tick(2);assert(phase()=='driving','idle/arrival state alone cancelled the car lease')
world.summoned='different-car';tick(4)
assert(world.disables==1 and world.deleted==0 and phase()=='waiting-for-player-exit')
`));
test('unchanged stale summon identity is allowed but an en-route transition cancels preparation',()=>run(`
world.summoned='old-detached-car';assert(queue());tick(12)
assert(phase()=='waiting-for-player' and car.summonBaseline.id=='old-detached-car')
world.enRoute=true;tick(6)
assert(not fleet.chauffeur or phase()=='cancelled' or phase()=='exiting-driver')
assert(world.enables==0 and world.deleted==0)
`));
test('ambiguous nearby owned cars reject the offer before movement',()=>run(`
world.carSelectionError='ambiguous'
local offered=transport.chauffeurOffer(fleet,player,entry)
assert(not offered.available and offered.code=='ambiguous-owned-car' and not queue())
assert(world.releases==0 and world.mountsRequested==0 and world.deleted==0)
`));
test('a retained pre-update summoned lease keeps its original identity rule',()=>run(`
assert(queue());car.summonBaseline=nil;tick(12);boardManually()
assert(phase()=='driving')
world.summoned='different-car';tick(4)
assert(world.disables==1 and world.deleted==0)
`));
test('driver command and actual seat must complete before waiting for V to board manually',()=>run(`
world.delayDriver=true; assert(queue()); tick(5)
assert(world.mountsRequested==1 and world.playerMounts==0 and transport.owns(fleet,1))
actual(entry,'seat_front_left'); tick(5)
assert(world.playerMounts==0,'mount relation was treated as completed animation')
world.commands[1].state='Success'; tick(3)
assert(world.playerMounts==0 and not world.mounts.player and phase()=='waiting-for-player')
assert(not transport.owns(fleet,2) and not world.mounts[2])
boardManually(); assert(phase()=='driving' and world.enables==1)
`));
test('fleet snapshots expose cached native mount state and age without making native reads',()=>run(`
world.delayDriver=true; assert(queue()); tick(5); actual(entry,'seat_front_left'); tick(5)
local reads=world.commandReads
local row=transport.snapshot(fleet,1).people[1]
assert(row.mountedSeat=='seat_front_left' and row.commandState=='Executing' and row.commandActive and row.commandAge>0)
assert(world.commandReads==reads,'snapshot queried native command state')
world.commands[1].state='Success'; tick(3); reads=world.commandReads
row=transport.snapshot(fleet,1).people[1]
assert(row.commandState=='Success' and not row.commandActive and row.commandAge>0)
assert(world.commandReads==reads and phase()=='waiting-for-player')
`));
test('passenger PSM transition prevents departure and native activation must be observed',()=>run(`
world.playerTransition=true; assert(queue()); tick(10)
actual('player','seat_front_right'); tick(5)
assert(world.playerMounts==0 and world.enables==0 and phase()=='waiting-for-player')
world.playerTransition=false; world.delayEnable=true; tick(5)
assert(world.enables==1 and phase()=='starting')
  world.driveCommand.state='Executing'; tick()
  assert(phase()=='driving' and transport.chauffeurSnapshot(fleet).vehicleCommand.id==world.driveCommand.id)
`));
test('waypoint changes during preparation update the same trip without moving V or replacing a map pin',()=>run(`
assert(queue()); tick(1)
local generation=fleet.generation
world.waypoint={id='changed',name='Other pin',position={x=8,y=8,z=0}};world.auto.destinationId='changed';tick(15)
assert(world.enables==0 and phase()=='waiting-for-player' and fleet.generation==generation and world.deleted==0)
boardManually();assert(phase()=='driving' and world.enablePoint.x==8 and world.playerMounts==0)
`));
test('no waypoint, en-route car, occupied driver, and missing passenger seats fail before movement',()=>run(`
local pin=world.waypoint; world.waypoint=nil; assert(not queue()); world.waypoint=pin
world.enRoute=true; assert(not queue()); world.enRoute=false
car.info.seats[1].occupant='foreign'; assert(not queue()); car.info.seats[1].occupant=nil
for i=2,4 do car.info.seats[i].reserved=true end
assert(not queue() and world.mountsRequested==0 and world.enables==0)
`));
test('a stale native destination cannot silently start a different route or Free Roam',()=>run(`
world.auto.playerTracked=false; world.auto.destinationId='quest-pin'
assert(queue()); tick(12); boardManually()
assert(world.enables==0 and phase()=='waiting-for-player-exit')
actual('player',nil); tick(10)
assert(not fleet.chauffeur and world.deleted==0)
`));
test('Quest road projection changes and a new selected destination retarget the same owned command',()=>run(`
world.auto.playerTracked=false; world.auto.questTracked=true;world.destinationType='Quest'
world.waypoint.position={x=-1623.8048095703,y=-386.49038696289,z=-13.099999427795}
world.markerPosition={x=-1624.0823974609,y=-386.62854003906,z=-12.003639221191}
local offered=transport.chauffeurOffer(fleet,player,entry)
assert(offered.available and queue(offered)); tick(12)
world.waypoint.position={x=-1691.3070068359,y=-603.80609130859,z=7.6229648590088}
world.markerPosition.x=world.markerPosition.x+0.28
boardManually()
assert(phase()=='driving' and world.enables==1)
assert(world.enablePoint.x==world.waypoint.position.x and world.enablePoint.z==world.waypoint.position.z)
assert(fleet.chauffeur.offer.waypoint.position.x==offered.waypoint.position.x,'immutable bridge offer was rewritten')
world.waypoint.position.z=world.waypoint.position.z+6;world.markerPosition.y=world.markerPosition.y+200;tick(4)
assert(phase()=='driving' and world.disables==0 and world.enables==1)
local operation=fleet.chauffeur.operation
world.waypoint.id='different';world.auto.destinationId='different';tick(4)
assert(phase()=='driving' and world.disables==0 and world.enables==1 and fleet.chauffeur.operation==operation)
assert(world.retargets>=2 and fleet.chauffeur.driveRevision==fleet.chauffeur.destinationRevision)
`));
test('manual marker moves and fresh native road projections both retarget without another start',()=>run(`
assert(queue());tick(12)
world.waypoint.position={x=101,y=55,z=8};boardManually()
assert(phase()=='driving' and world.enables==1 and world.enablePoint.z==8)
world.waypoint.position={x=130,y=155,z=28};tick(4)
assert(phase()=='driving' and world.disables==0)
world.markerPosition.x=101;tick(4)
assert(phase()=='driving' and world.disables==0 and world.enables==1 and world.retargets==2)
`));
test('gradual marker movement is measured from the last revision rather than losing accumulated drift',()=>run(`
driving()
world.markerPosition.x=100.1;tick();world.markerPosition.x=100.2;tick()
assert(phase()=='driving')
world.markerPosition.x=100.3;tick(4)
assert(phase()=='driving' and world.disables==0 and world.retargets==1)
assert(fleet.chauffeur.offer.waypoint.position.x==100,'immutable initial offer was rewritten')
`));
test('switching destination type under the same mappin ID advances the destination revision',()=>run(`
driving();world.destinationType='Quest';world.auto.playerTracked=false;world.auto.questTracked=true;tick(4)
assert(phase()=='driving' and world.disables==0 and world.enables==1 and world.retargets==1)
`));
test('cancel brakes and disables once, waits for stopped evidence and V exit, then resumes only Judy',()=>run(`
driving(); car.info.speed=8; world.brakeBlocked=true
assert(transport.cancelChauffeur(fleet,'Stop here')); tick(5)
assert(phase()=='stopping' and world.disables==1 and world.unmounts==0 and world.resumes==0)
car.info.speed=0; tick(3)
assert(phase()=='waiting-for-player-exit' and world.unmounts==0)
actual('player',nil); tick(8)
assert(phase()=='cancelled' and world.unmounts==1 and world.resumes==1 and world.deleted==0)
assert(not transport.owns(fleet,1) and not fleet.primary)
`));
test('blocked native shutdown has bounded submissions and retains ownership',()=>run(`
driving(); world.disableBlocked=true; car.info.speed=5
transport.cancelChauffeur(fleet); tick(60,1)
assert(world.disables==1 and world.brakes==3 and world.unmounts==0 and transport.owns(fleet,1))
assert(phase()=='stopping' and transport.chauffeurSnapshot(fleet).error)
`));
test('foreign AutoDrive is never disabled or braked while this trip retires only its own NPC command',()=>run(`
driving(); world.auto.enabled=true;world.auto.vehicleId='foreign-car'; tick(10)
assert(world.auto.enabled and world.disables==1 and world.brakes==0 and phase()=='stopping' and world.unmounts==0)
`));
test('native interruption is stopped without restart and a subsequent user trip is not claimed',()=>run(`
driving(); world.driveCommand.state='Interrupted'; tick()
world.auto.enabled=true; world.auto.vehicleId=car.id; tick(8)
assert(world.enables==1 and world.disables==0 and world.unmounts==0)
`));
test('manual waiting allows several minutes without moving V and cancellation releases the driver',()=>run(`
assert(queue()); tick(12); tick(120,1)
assert(world.playerMounts==0 and world.enables==0 and not world.mounts.player)
assert(phase()=='waiting-for-player' and transport.owns(fleet,1) and world.unmounts==0)
transport.cancelChauffeur(fleet); tick(8)
assert(not fleet.chauffeur and world.unmounts==1 and world.playerMounts==0)
`));
test('timed out departure cancels the pending native request without retrying enable',()=>run(`
world.delayEnable=true; assert(queue()); tick(12); boardManually()
assert(world.driveCommand.state=='NotExecuting' and phase()=='starting')
tick(12,1)
assert(world.driveCommand.state=='Cancelled' and world.enables==1 and world.disables==1 and phase()=='waiting-for-player-exit')
`));
test('ordinary transport activity blocks chauffeur admission',()=>run(`
fleet.phase='boarding'
assert(not queue() and not fleet.chauffeur and world.mountsRequested==0)
`));
test('save or death abandonment performs no native actions and discards all trip intent',()=>run(`
driving(); local before=world.disables+world.brakes+world.unmounts
transport.abandon(fleet)
assert(not fleet.chauffeur and not transport.owns(fleet,1) and phase()=='idle')
assert(world.disables+world.brakes+world.unmounts==before)
`));
test('fast travel stops a live trip before suspension and never serializes chauffeur intent',()=>run(`
driving(); local receipt=transport.suspend(fleet)
assert(world.disables==1 and world.brakes==1 and not fleet.chauffeur)
assert(not receipt.chauffeur and not receipt.primary.owned and receipt.people[1])
transport.resume(fleet,receipt,{entry},{})
assert(not fleet.chauffeur and phase()=='idle' and world.enables==1)
`));
test('a blocked route stops after a bounded progress timeout without route retry',()=>run(`
driving(); tick(40,1)
assert(world.enables==1 and world.disables==1 and phase()=='waiting-for-player-exit')
assert(transport.chauffeurSnapshot(fleet).outcome=='failed')
`));
test('route distance may initialize at zero or reset upward while actual driving continues',()=>run(`
world.auto.remaining=0; driving(); car.info.speed=10
for i=1,50 do world.auto.remaining=1000-i*5; tick(1,1) end
assert(phase()=='driving' and world.disables==0)
`));
test('a failed waypoint or UI read still attempts bounded guarded native shutdown',()=>run(`
driving(); world.readError=true; tick(40,1)
assert(not world.auto.enabled and world.disables==1 and world.brakes==3)
assert(transport.owns(fleet,1) and world.unmounts==0)
world.readError=false; tick(3); assert(phase()=='waiting-for-player-exit')
`));
test('native off-on edges between samples cannot transfer ownership to a new journey',()=>run(`
driving(); transport.chauffeurAutodriveToggled(fleet,false)
transport.chauffeurAutodriveToggled(fleet,true); world.auto.enabled=true; tick(5)
assert(world.disables==1 and world.brakes==0 and world.unmounts==0 and phase()=='stopping')
`));
test('only owned command Success plus a stopped car near the current destination qualifies arrival',()=>run(`
driving(); transport.chauffeurArrived(fleet,'wrong-car')
assert(not fleet.chauffeur.arrivalObserved)
transport.chauffeurArrived(fleet,car.id);tick();assert(phase()=='driving')
world.driveCommand.state='Success';world.routeDistance=4; tick(3)
assert(phase()=='waiting-for-player-exit' and transport.chauffeurSnapshot(fleet).outcome=='completed')
actual('player',nil); tick(8); assert(phase()=='completed')
`));
test('automatic marker clearing at a stopped native arrival preserves completion',()=>run(`
driving();world.driveCommand.state='Success';world.routeDistance=4;world.waypoint=nil;tick(3)
assert(phase()=='waiting-for-player-exit' and transport.chauffeurSnapshot(fleet).outcome=='completed')
actual('player',nil);tick(8);assert(phase()=='completed')
`));
test('clearing a marker while driving or away from its completed endpoint remains cancellation',()=>run(`
driving();world.routeDistance=4;world.waypoint=nil;tick(3)
assert(transport.chauffeurSnapshot(fleet).outcome=='cancelled')
`));
test('a disappeared marker cannot qualify completion far from the owned endpoint',()=>run(`
driving();world.driveCommand.state='Success';world.routeDistance=90;world.waypoint=nil;tick(3)
assert(transport.chauffeurSnapshot(fleet).outcome=='cancelled')
`));
test('exiting uses a fresh attempt budget after a third boarding attempt succeeds',()=>run(`
driving(); fleet.people[1].attempts=3
transport.cancelChauffeur(fleet); tick(3); actual('player',nil); tick(8)
assert(world.unmounts==1 and not transport.owns(fleet,1))
`));
test('offer follows the assigned conversation profile and profile changes invalidate queued intent',()=>run(`
entry.profileKey='panam-palmer'; local value=transport.chauffeurOffer(fleet,player,entry)
assert(value.actor.key=='panam-palmer' and value.available)
entry.profileKey='judy-alvarez'; assert(not queue(value))
assert(queue()); entry.profileKey='panam-palmer'; tick(15)
assert(world.enables==0 and not fleet.chauffeur)
`));
test('driver dismissal and mod shutdown preserve the seated driver and expose cleanup identity',()=>run(`
driving(); assert(not transport.canDismissChauffeurDriver(fleet,1))
assert(transport.canDismissChauffeurDriver(fleet,2))
local safe,reason,receipt=transport.prepareChauffeurShutdown(fleet)
assert(not safe and reason and receipt.actor.id=='1001ULL' and receipt.car.id=='2001ULL')
assert(receipt.nativeStopRequested and world.disables==1 and world.brakes==1)
assert(transport.owns(fleet,1) and world.unmounts==0 and world.deleted==0)
tick(3); actual('player',nil); tick(8)
assert(transport.canDismissChauffeurDriver(fleet,1) and transport.prepareChauffeurShutdown(fleet))
`));
test('lost companion ownership stops driving without resuming or mutating the foreign actor',()=>run(`
driving(); world.valid=false; tick(4); actual('player',nil); tick(10)
assert(not world.auto.enabled and world.unmounts==0 and world.resumes==0 and transport.owns(fleet,1))
transport.remove(fleet,1); tick(4)
assert(not fleet.chauffeur and world.resumes==0)
`));
test('only Judy is acquired while V waits; all eight copies carpool with two overflow cars after V boards',()=>run(`
for i=2,8 do entries[i]={serial=i,key='person-'..i,profileKey='person-'..i,entityID={hash=tostring(1000+i)..'ULL'},npc={}} end
assert(queue()); tick(12); tick(120,1)
assert(phase()=='waiting-for-player' and not car.info.seats[2].occupant and world.playerMounts==0)
assert(world.mountsRequested==1 and world.releases==1 and #world.spawned==0 and #fleet.cars==0)
for i=2,8 do assert(not transport.owns(fleet,i) and not world.mounts[i]) end
boardManually(); tick(80)
assert(phase()=='driving' and world.enables==1 and #world.spawned==2 and world.follows==2)
assert(car.info.seats[1].occupant=='1001ULL' and car.info.seats[2].occupant=='1ULL')
assert(car.info.seats[3].occupant=='1002ULL' and car.info.seats[4].occupant=='1003ULL')
assert(world.mountsRequested==8 and #fleet.cars==2 and not car.owned)
for i=1,8 do assert(transport.owns(fleet,i) and world.mounts[i]) end
`));
test('lead departure waits for every assigned passenger and overflow driver to finish boarding',()=>run(`
for i=2,4 do entries[i]={serial=i,key='person-'..i,profileKey='person-'..i,entityID={hash=tostring(1000+i)..'ULL'},npc={}} end
world.delayDriver=true; assert(queue()); tick(15)
for _,cmd in ipairs(world.commands) do
  if cmd.entry.serial~=4 then actual(cmd.entry,cmd.seat,cmd.car); cmd.state='Success' end
end
tick(10)
assert(phase()=='waiting-for-player' and world.playerMounts==0 and world.enables==0 and world.follows==0)
boardManually(); assert(phase()=='waiting-for-party' and world.enables==0)
for _,cmd in ipairs(world.commands) do
  if cmd.entry.serial~=4 then actual(cmd.entry,cmd.seat,cmd.car); cmd.state='Success' end
end
tick(3); assert(phase()=='waiting-for-party' and world.enables==0)
for _,cmd in ipairs(world.commands) do
  if cmd.entry.serial==4 then actual(cmd.entry,cmd.seat,cmd.car); cmd.state='Success' end
end
tick(8); assert(phase()=='driving' and world.enables==1 and world.follows==1)
`));
test('cancelling a chauffeured group retires convoy commands, dismounts the party, and deletes only overflow cars',()=>run(`
for i=2,8 do entries[i]={serial=i,key='person-'..i,profileKey='person-'..i,entityID={hash=tostring(1000+i)..'ULL'},npc={}} end
assert(queue()); tick(80); boardManually(); tick(80); assert(world.follows==2)
world.cancelBlocked=true; transport.cancelChauffeur(fleet); tick(6)
assert(world.unmounts==0 and world.deleted==0)
actual('player',nil); tick(5)
assert(#fleet.cars==2 and fleet.chauffeur,'unretired convoy was dropped')
world.cancelBlocked=false; tick(30)
assert(not fleet.chauffeur and world.unmounts==8 and world.resumes==8)
assert(world.deleted==2 and world.cars[car.id]==car and not fleet.primary and #fleet.cars==0)
for i=1,8 do assert(not transport.owns(fleet,i)) end
`));
test('manual waiting times out after five minutes and cancels when V walks away',()=>run(`
assert(queue()); tick(12); tick(301,1); tick(8)
assert(not fleet.chauffeur and world.enables==0 and world.playerMounts==0 and world.unmounts==1)
assert(queue()); tick(12); car.info.playerGap=41; tick(8)
assert(not fleet.chauffeur and world.enables==0 and world.playerMounts==0 and world.unmounts==2)
`));
test('V may choose another available passenger seat without changing the frozen action offer',()=>run(`
local offer=transport.chauffeurOffer(fleet,player,entry)
assert(queue(offer)); tick(12); boardManually('seat_back_left')
assert(phase()=='driving' and world.enableSeat=='seat_back_left' and world.playerMounts==0)
local snap=transport.chauffeurSnapshot(fleet)
assert(snap.passengerSeat=='seat_back_left' and snap.offer.passengerSeat=='seat_front_right')
`));
test('an alternate manual seat retires an NPC reservation before reallocating that companion',()=>run(`
entries[2]=other; other.profileKey=other.key; world.delayDriver=true
assert(queue()); tick(10)
for _,cmd in ipairs(world.commands) do
  if cmd.entry.serial==1 then actual(entry,cmd.seat,cmd.car); cmd.state='Success' end
end
tick(3); actual('player','seat_front_right'); tick(3)
assert(phase()=='waiting-for-party' and world.mountsRequested==2)
world.cancelBlocked=true; actual('player','seat_back_left'); tick(3)
assert(world.enables==0 and phase()=='waiting-for-party' and fleet.chauffeur.passengerYieldPending)
world.cancelBlocked=false; world.delayDriver=false; tick(12)
assert(phase()=='driving' and world.enableSeat=='seat_back_left')
assert(world.mounts[2].seat=='seat_front_right' and world.playerMounts==0)
`));
test('V choosing the driver seat cancels the chauffeur and yields without braking, reseating or ejecting V',()=>run(`
assert(queue()); tick(12); actual(entry,nil); actual('player','seat_front_left'); car.info.speed=10
tick()
assert(not fleet.chauffeur and phase()=='taken-over' and world.enables==0 and world.disables==0 and world.brakes==0)
assert(world.mounts.player.seat=='seat_front_left' and world.playerMounts==0 and world.unmounts==0)
assert(world.resumes==1 and transport.canDismissChauffeurDriver(fleet,1))
`));
test('a stopped accidental player driver-seat entry before approach preserves the request and resumes after V vacates',()=>run(`
local offer=transport.chauffeurOffer(fleet,player,entry)
assert(queue(offer)); local generation=fleet.generation
actual('player','seat_front_left'); tick(20)
assert(phase()=='waiting-for-driver-seat' and transport.owns(fleet,1))
assert(world.releases==1 and world.mountsRequested==0 and world.enables==0)
assert(not transport.allowsSeatedAttention(fleet,1))
assert(world.brakes==0 and world.disables==0 and world.playerMounts==0 and world.unmounts==0)
actual('player',nil); tick(10)
assert(phase()=='waiting-for-player' and world.mounts[1].seat=='seat_front_left')
assert(fleet.generation==generation and fleet.chauffeur.offer.passengerSeat==offer.passengerSeat)
assert(world.mountsRequested==1 and transport.allowsSeatedAttention(fleet,1))
boardManually(); assert(phase()=='driving' and world.enables==1 and world.playerMounts==0)
`));
test('player driver-seat grace cancels only the in-flight NPC mount and waits for confirmed retirement before resubmission',()=>run(`
world.delayDriver=true; assert(queue()); tick(5)
local first=world.commands[1]; assert(first and first.state=='Executing')
assert(not transport.allowsSeatedAttention(fleet,1))
world.cancelBlocked=true; actual('player','seat_front_left'); tick(4)
assert(phase()=='waiting-for-driver-seat' and fleet.people[1].command==first)
assert(world.mountsRequested==1 and not world.mounts[1] and world.enables==0)
actual('player','seat_front_right'); tick(4)
assert(phase()=='waiting-for-driver-seat' and world.mountsRequested==1)
world.cancelBlocked=false; world.delayDriver=false; tick(15)
assert(first.state=='Cancelled' and world.mountsRequested==2 and fleet.people[1].attempts==1)
assert(phase()=='driving' and world.enables==1 and world.playerMounts==0)
assert(world.brakes==0 and world.disables==0 and world.unmounts==0)
`));
test('native driver reservation must disappear after cancellation before a fresh direct mount is sent',()=>run(`
world.delayDriver=true; assert(queue()); tick(5)
local first=world.commands[1]
actual('player','seat_front_left'); tick(3)
assert(first.state=='Cancelled' and world.mountsRequested==1)
actual('player',nil); car.info.seats[1].reserved=true; tick(15)
assert(phase()=='waiting-for-driver-seat' and world.mountsRequested==1)
car.info.seats[1].reserved=false; world.delayDriver=false; tick(10)
assert(phase()=='waiting-for-player' and world.mountsRequested==2)
assert(world.brakes==0 and world.enables==0 and world.playerMounts==0)
`));
test('an alternate passenger seat entered during driver-seat grace is preserved while the original driver intent resumes',()=>run(`
world.delayDriver=true; assert(queue()); tick(5)
actual('player','seat_front_left'); tick(3)
actual('player','seat_back_left'); world.delayDriver=false; tick(15)
assert(phase()=='driving' and world.enableSeat=='seat_back_left' and world.mountsRequested==2)
assert(fleet.chauffeur.offer.passengerSeat=='seat_front_right' and fleet.chauffeur.passengerSeat=='seat_back_left')
assert(world.playerMounts==0 and world.brakes==0 and world.disables==0 and world.unmounts==0)
`));
test('driver-seat grace has one cumulative budget across repeated accidental entries and never moves V',()=>run(`
world.delayDriver=true; assert(queue()); tick(5)
local generation=fleet.generation
actual('player','seat_front_left'); tick(25,1)
assert(phase()=='waiting-for-driver-seat')
local remaining=transport.chauffeurSnapshot(fleet).driverSeatWaitRemaining
assert(remaining>19 and remaining<22)
actual('player',nil); tick(3)
assert(phase()=='boarding-driver' and world.mountsRequested==2)
actual('player','seat_front_left'); tick(25,1)
assert(phase()=='waiting-for-player-exit')
assert(world.mountsRequested==2 and world.enables==0 and world.brakes==0 and world.disables==0)
assert(world.mounts.player.seat=='seat_front_left' and world.playerMounts==0 and fleet.generation==generation)
actual('player',nil); tick(12)
assert(not fleet.chauffeur and world.resumes==1 and world.unmounts==0)
`));
test('starting to drive during preparation yields the exact request without braking or restoring intent',()=>run(`
world.delayDriver=true; assert(queue()); tick(5)
local first=world.commands[1]
actual('player','seat_front_left'); tick(3)
assert(phase()=='waiting-for-driver-seat' and first.state=='Cancelled')
car.info.speed=10; tick()
assert(not fleet.chauffeur and phase()=='taken-over')
assert(world.brakes==0 and world.disables==0 and world.enables==0 and world.playerMounts==0)
assert(world.mounts.player.seat=='seat_front_left' and world.unmounts==0 and world.resumes==1)
`));
test('foreign AutoDrive during driver-seat grace is yielded without cancelling, braking or replacing it',()=>run(`
world.delayDriver=true; assert(queue()); tick(5)
local first=world.commands[1]
actual('player','seat_front_left'); tick(3)
world.auto.enabled=true; world.auto.vehicleId=car.id; tick()
assert(not fleet.chauffeur and phase()=='taken-over' and first.state=='Cancelled')
assert(world.auto.enabled and world.brakes==0 and world.disables==0 and world.enables==0)
assert(world.mounts.player.seat=='seat_front_left' and world.playerMounts==0 and world.unmounts==0)
`));
test('foreign AutoDrive after V leaves the driver seat retires the pending approach without resubmitting a mount',()=>run(`
world.delayDriver=true; assert(queue()); tick(5)
local first=world.commands[1]
actual('player','seat_front_left'); tick(3)
actual('player','seat_front_right'); world.auto.enabled=true; world.auto.vehicleId=car.id; tick(3)
assert(phase()=='stopping' and first.state=='Cancelled' and world.mountsRequested==1)
assert(world.auto.enabled and world.brakes==0 and world.disables==0 and world.enables==0)
assert(world.playerMounts==0 and world.unmounts==0)
`));
test('a new route during driver-seat grace is retained for the same trip after V releases the driver slot',()=>run(`
world.delayDriver=true; assert(queue()); tick(5)
actual('player','seat_front_left'); tick(3)
world.waypoint.id='new-route';world.auto.destinationId='new-route';tick(6)
assert(phase()=='waiting-for-driver-seat' and world.enables==0 and world.mountsRequested==1)
world.delayDriver=false;actual('player',nil); tick(10)
assert(phase()=='waiting-for-player' and world.brakes==0 and world.disables==0 and world.resumes==0)
boardManually();assert(phase()=='driving' and fleet.chauffeur.waypoint.id=='new-route')
`));
test('a route or seat race before the first preparation update still releases the exact foot owner',()=>run(`
assert(queue()); actual('player','seat_front_left'); world.waypoint.id='new-route'; tick()
assert(world.releases==1 and world.mountsRequested==0 and world.enables==0)
assert(phase()=='waiting-for-driver-seat' and transport.owns(fleet,1))
assert(world.brakes==0 and world.disables==0 and world.playerMounts==0 and world.unmounts==0)
actual('player',nil); tick(10)
assert(phase()=='waiting-for-player' and world.resumes==0)
transport.cancelChauffeur(fleet);tick(8);assert(not fleet.chauffeur and world.resumes==1)
`));
test('V taking the driver seat during owned AutoDrive disables that trip without braking against V',()=>run(`
driving(); actual(entry,nil); actual('player','seat_front_left'); car.info.speed=10
tick(3)
assert(not fleet.chauffeur and phase()=='taken-over' and world.disables==1 and world.brakes==0)
assert(world.mounts.player.seat=='seat_front_left' and world.playerMounts==0 and world.enables==1)
`));
test('a destination change while waiting for manual boarding preserves the waiting driver without moving V',()=>run(`
assert(queue()); tick(12); assert(phase()=='waiting-for-player')
world.waypoint.id='different-destination';world.auto.destinationId=world.waypoint.id;tick(8)
assert(phase()=='waiting-for-player' and world.enables==0 and world.playerMounts==0 and not world.mounts.player)
assert(world.unmounts==0 and world.mountsRequested==1)
boardManually();assert(phase()=='driving' and fleet.chauffeur.waypoint.id=='different-destination')
`));
test('a driver who gets out while waiting is released without an automatic reseat or departure',()=>run(`
assert(queue()); tick(12); actual(entry,nil); tick(8)
assert(not fleet.chauffeur and world.enables==0 and world.playerMounts==0)
assert(world.mountsRequested==1 and not world.mounts[1] and world.resumes==1)
`));
test('an already interrupted command still stops a coasting car without recreating the route',()=>run(`
driving();world.driveCommand.state='Interrupted';car.info.speed=4;tick(3)
assert(world.brakes==1 and world.enables==1 and world.disables==0 and car.info.speed==0)
assert(phase()=='waiting-for-player-exit' and fleet.chauffeur.stopObligation)
`));
test('changing the map as the old command completes restarts only the new revision after stopped evidence',()=>run(`
driving();local first=fleet.chauffeur.operation;local generation=fleet.generation
world.driveCommand.state='Success';world.waypoint.id='new-road';world.auto.destinationId='new-road'
world.waypoint.position={x=250,y=350,z=0};car.info.speed=2;tick(8)
assert(phase()=='driving' and world.enables==2 and fleet.chauffeur.operation~=first)
assert(fleet.generation==generation and world.enablePoint.x==250 and world.playerMounts==0)
`));
test('Success far from the current destination and manual stop racing Success never become arrival',()=>run(`
driving();world.driveCommand.state='Success';world.routeDistance=90;tick(3)
assert(transport.chauffeurSnapshot(fleet).outcome=='failed')
actual('player',nil);tick(8);actual(entry,nil);world.driveCommand=nil
driving();world.driveCommand.state='Success';world.routeDistance=1
assert(transport.cancelChauffeur(fleet));tick(3)
assert(transport.chauffeurSnapshot(fleet).outcome=='cancelled')
`));
test('a foreign same-car AI owner prevents braking until it releases, without consuming the stop allowance',()=>run(`
driving();world.foreignDrive=true;car.info.speed=5;tick(90,.1)
assert(phase()=='stopping' and world.brakes==0 and fleet.chauffeur.brakeAttempts==0)
assert(world.disables==1 and world.enables==1 and world.unmounts==0)
world.foreignDrive=false;tick(50,.1)
assert(world.brakes==1 and phase()=='waiting-for-player-exit')
`));

test('a passenger-only companion (Alt Cunningham, a digital ghost) is never offered the wheel, under any chat profile',()=>run(`
entry.key='alt-cunningham'; entry.record='Character.Alt'
local offer=transport.chauffeurOffer(fleet,player,entry)
assert(not offer.available and offer.code=='does-not-drive',tostring(offer.code))
assert(not queue() and not fleet.chauffeur and world.mountsRequested==0 and world.enables==0)
-- The model decides: her copy under another profile is still refused, another model under her profile is not.
entry.key='alt-model-copy'; entry.profileKey='judy-alvarez'
assert(transport.chauffeurOffer(fleet,player,entry).code=='does-not-drive')
entry.key='judy-alvarez'; entry.record='Character.Judy'; entry.profileKey='alt-cunningham'
assert(transport.chauffeurOffer(fleet,player,entry).available,'Judy under her profile can still drive')
`));
