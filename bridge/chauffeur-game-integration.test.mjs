import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import fengari from 'fengari';
import {companionEngine} from './companion-fixture.mjs';
import {uiLocaleBootstrap} from './ui-locale-fixture.mjs';

const partySource = readFileSync(new URL('../mod/manager-party.lua', import.meta.url), 'utf8');
const companionSource = readFileSync(new URL('../mod/companions.lua', import.meta.url), 'utf8');
const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;
const setup = `
local reads,paused=0,false
local point={id='4001ULL',name='Selected waypoint',position={x=12,y=34,z=0},
 destinationType='PlayerTracked',markerPosition={x=12,y=34,z=1.2}}
local car={id='3001ULL',entityID={hash='3001ULL'},name='Summoned owned car',record='Vehicle.Test',owned=false}
local carInfo={ready=true,speed=0,playerGap=3,seats={{name='seat_front_left'},{name='seat_front_right'}}}
companionChauffeurAdapter=function(api)
 api.inspectDrive=function()return {known=true,ready=true,foreign=false,busy=false,reservations=0}end
 api.sample=function(player,entry)
  assert(not paused,'native sample from a paused menu action');reads=reads+1
  return {actor={serial=entry.serial,id=tostring(entry.entityID.hash),key=entry.profileKey},
   actorValid=entry.system:IsManaged(entry.entityID) and entry.system:IsTagged(entry.entityID,'CyberpunkConvaiCompanion'),
   actorCalm=true,playerCombat=false,car=car,carValid=true,info=carInfo,summonedId=car.id,
    waypoint=point,auto={enabled=false},drive={known=true,ready=true,busy=false,foreign=false,reservations=0}}
 end
 return api
end
`;

function run(body) {
  const vm = lauxlib.luaL_newstate(); lualib.luaL_openlibs(vm);
  const program = uiLocaleBootstrap + setup + companionEngine + body;
  const status = lauxlib.luaL_dostring(vm, to_luastring(program));
  const error = status === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(vm, -1));
  const line = Number(/\]:(\d+):/.exec(error)?.[1]);
  lua.lua_close(vm);
  assert.equal(status, lua.LUA_OK, error + (line ? '\n' + program.split('\n')[line - 1] : ''));
}

test('real companion wrappers select the ready owned entity and assigned personality, rejecting stale actor and waypoint bindings', () => run(`
local first=spawn();local firstRow=companions.list()[1]
local second=spawn();local secondRow=companions.list()[2]
assert(companions.setProfile(firstRow.serial,'panam-palmer','Panam'))
local offer=companions.chauffeurOffer(firstRow.entityID)
assert(offer.available and offer.actor.key=='panam-palmer' and firstRow.key=='judy-alvarez')
assert(not companions.chauffeurOffer('quest-actor').available)
local before=reads
assert(not companions.queueChauffeur(secondRow.serial,offer,firstRow.entityID))
assert(not companions.queueChauffeur(nil,offer,firstRow.entityID))
assert(reads==before,'mismatched serial/entity reached native admission')
point.position.x=90
assert(not companions.queueChauffeur(firstRow.serial,offer,firstRow.entityID))
point.position.x=12
first.spec.tags={}
assert(not companions.chauffeurOffer(firstRow.entityID).available,'unowned actor received a capability')
first.spec.tags={'CyberpunkConvaiCompanion'}
assert(companions.queueChauffeur(firstRow.serial,offer,firstRow.entityID))
local trip=companions.chauffeurSnapshot();assert(trip.active and trip.offer.actor.serial==firstRow.serial)
`));

test('driver dismissal is blocked before native ownership, equipment or role access and abandon performs no cleanup reads', () => run(`
local actor=spawn();local member=companions.list()[1]
assert(companions.queueChauffeur(member.serial,nil,member.entityID))
local role=actor.ai.role
system.IsReady=function()error('native ownership read during protected driver dismissal')end
actor.ai.SetAIRole=function()error('protected driver role cleared')end
system.DeleteEntity=function()error('protected driver removed')end
local ok,reason=companions.dismiss(member.serial)
assert(not ok and reason:find('Stop the trip',1,true) and actor.ai.role==role)
assert(not companions.prepareChauffeurShutdown('test shutdown'))
assert(not companions.dismissAll())
local before=reads
companions.abandon();assert(#companions.list()==0 and not companions.chauffeurSnapshot().active and reads==before)
`));

test('explicit legacy cleanup handoff removes only a proved old driver without restoring the party or changing V seats',()=>run(`
local actor=spawn();local beforeSequence=sequence
companions.abandon();assert(#companions.list()==0)
function actor:GetRecordID()return 'Character.Test' end
function player:GetEntityID()return {hash='1000ULL'}end
function player:IsDeadNoStatPool()return false end
function player:IsInCombat()return false end
function system:IsTagged(entity,tag)
 local value=entities[tonumber(entity.hash)]
 if not value then return false end
 for _,actual in ipairs(value.spec.tags)do if actual==tag then return true end end
 return false
end
function system:AssignTag(entity,tag)table.insert(entities[tonumber(entity.hash)].spec.tags,tag)end
function system:GetTaggedIDs(tag)
 local out={};for _,value in pairs(entities)do if self:IsTagged(value.id,tag)then out[#out+1]=value.id end end
 return out
end
local actorMounted,playerAboard=true,true
local carEntity={IsAttached=function()return true end,IsVehicle=function()return true end,
 IsPlayerVehicle=function()return true end,GetEntityID=function()return {hash='3001ULL'}end,
 GetRecordID=function()return 'Vehicle.Test' end,IsPlayerDriver=function()return false end,
 IsDestroyed=function()return false end,GetRecord=function()return {Type=function()return {Type=function()return 'Car' end}end}end}
Game.FindEntityByID=function(native)assert(native.hash=='3001ULL');return carEntity end
Game.GetWorkspotSystem=function()return {IsActorInWorkspot=function()return actorMounted end}end
Game.GetSceneSystem=function()return {GetScriptInterface=function()return {
 IsEntityInScene=function()return false end,IsEntityInDialogue=function()return false end}end}end
Game.GetScriptableSystemsContainer=function()return {Get=function()return {
 GetAutodriveVehicle=function()return nil end,GetAutodriveEnabled=function()return false end}end}end
local unmounts,removed=0,0
companionVehicleAdapter=function(api)
 api.mounting=function(entry)
  if entry.npc==actor and actorMounted then return {vehicle='3001ULL',parent={hash='3001ULL'},seat='seat_front_left'}end
  if entry.npc==player and playerAboard then return {vehicle='3001ULL',parent={hash='3001ULL'},seat='seat_front_right'}end
 end
 api.inspect=function()return {ready=true,speed=0,playerMounted=playerAboard,seats={}}end
 api.mount=function(entry,car,seat,exit)
  assert(entry.npc==actor and car.id=='3001ULL' and seat=='seat_front_left' and exit)
  unmounts=unmounts+1;actorMounted=false
  local command=NewObject('AIUnmountCommand');entry.npc.ai:SendCommand(command);command.state='Success'
  return {handle=command,owner=entry.npc,ai=entry.npc.ai}
 end
 return api
end
-- Create the new module instance, representing the party-empty CET instance.
local files,values,nextJson={},{},0
local function clone(value)
 if type(value)~='table' then return value end
 local out={};for k,c in pairs(value)do out[k]=clone(c)end;return out
end
json={encode=function(v)nextJson=nextJson+1;local text='cleanup-'..nextJson;values[text]=clone(v);return text end,
 decode=function(raw)return clone(assert(values[raw]))end}
io={open=function(path,mode)
 if mode=='rb' then if not files[path]then return nil end
  return {read=function(_,count)return files[path]:sub(1,count)end,close=function()return true end}
 end
 return {write=function(_,v)files[path]=v;return true end,close=function()return true end}
end}
os.rename=function(a,b)files[b]=files[a];files[a]=nil;return true end
os.remove=function(path)files[path]=nil;return true end
companions=(function() ${companionSource} end)()
companions.onBeforeRemove=function(entity)assert(entity==tostring(actor.id.hash));removed=removed+1 end
companions.initReloadCleanup()
assert(companions.captureInterruptedDriver(actor))
assert(companions.reloadCleanupSnapshot().active and #companions.list()==0)
companions.update(player,.5);companions.update(player,.5)
assert(actorMounted and unmounts==0 and removed==0 and playerAboard)
playerAboard=false
companions.update(player,.5);assert(unmounts==1 and removed==0)
companions.update(player,.5)
assert(removed==1 and not system:IsManaged(actor.id) and #companions.list()==0)
assert(sequence==beforeSequence and companions.reloadCleanupSnapshot().phase=='complete')
assert(not companions.vehicleSnapshot().reloadCleanup.active and not companions.chauffeurSnapshot().active)
`));

test('manager exposes only an active-trip stop intent, defers cancellation until flush, and protects the driver', () => run(`
spawn();local member=companions.list()[1]
local queue=(function() ${partySource} end)().new(companions)
queue.bind('world-one')
assert(queue.drive==nil and queue.cancelDrive==nil,'obsolete manager initiation API survived')
assert(not queue.stopTrip());queue.flush();assert(reads==0 and not companions.chauffeurSnapshot().active)
assert(companions.queueChauffeur(member.serial,nil,member.entityID))
local before=reads
paused=true;assert(not queue.dismiss('live:'..member.serial))
assert(queue.stopTrip() and queue.chauffeur().stopPending)
assert(companions.chauffeurSnapshot().phase=='releasing' and reads==before)
paused=false;queue.flush()
assert(companions.chauffeurSnapshot().phase=='stopping' and not queue.chauffeur().stopPending)
`));

test('manager world reset drops a pending stop without retaining any trip initiation', () => run(`
spawn();local member=companions.list()[1]
local queue=(function() ${partySource} end)().new(companions)
queue.bind('world-one');assert(companions.queueChauffeur(member.serial,nil,member.entityID))
assert(queue.stopTrip());local before=reads
queue.bind(nil);queue.bind('world-two');queue.flush()
assert(reads==before and companions.chauffeurSnapshot().phase=='releasing' and not queue.chauffeur().stopPending)
companions.abandon();queue.flush()
assert(not companions.chauffeurSnapshot().active and reads==before)
`));

test('manager reports the manual passenger boarding phase once without starting or advancing the trip', () => run(`
spawn();local member=companions.list()[1]
local queue=(function() ${partySource} end)().new(companions)
queue.bind('world-one')
companions.chauffeurSnapshot=function()return {active=true,phase='waiting-for-player',offer={actor={serial=member.serial}}}end
companions.queueChauffeur=function()error('manager initiated a trip')end
queue.flush();queue.flush()
local notices=queue.takeNotices()
assert(#notices==1 and notices[1].message=='Your companion is ready. Get in the passenger seat to start the trip.')
assert(not notices[1].failed and reads==0 and queue.chauffeur().phase=='waiting-for-player')
`));

test('trip errors are shown once across repeated native-state changes; later instructions and new trips remain visible', () => run(`
spawn();local member=companions.list()[1]
local queue=(function() ${partySource} end)().new(companions)
queue.bind('world-one')
local trip={active=true,generation=17,phase='stopping',reason='The map destination changed.',outcome='cancelled'}
companions.chauffeurSnapshot=function()
 local state={};for key,value in pairs(trip)do state[key]=value end;return state
end
for cycle=1,8 do
 trip.error=nil;trip.phase='stopping';queue.flush()
 trip.error='Waiting for confirmed AutoDrive shutdown and a stopped car.';queue.flush()
 trip.phase='waiting-for-player-exit';queue.flush()
 trip.error=nil;trip.phase='exiting-driver';queue.flush()
end
local notices=queue.takeNotices();local messages={}
for _,notice in ipairs(notices)do messages[notice.message]=(messages[notice.message]or 0)+1 end
assert(#notices==3 and messages['The map destination changed.']==1)
assert(messages['Waiting for confirmed AutoDrive shutdown and a stopped car.']==1)
assert(messages['The car has stopped. Step out so your companion can leave the driver seat.']==1)
trip.error='The borrowed car is in use.';queue.flush()
notices=queue.takeNotices();assert(#notices==1 and notices[1].message=='The borrowed car is in use.' and notices[1].failed)
trip.error=nil;trip.phase='stopping';trip.generation=18;queue.flush();queue.flush()
notices=queue.takeNotices();assert(#notices==1 and notices[1].message=='The map destination changed.')
assert(reads==0,'notification updates submitted native driving requests')
`));
