import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import fengari from 'fengari';
import {companionEngine} from './companion-fixture.mjs';
import {uiLocaleBootstrap} from './ui-locale-fixture.mjs';

const partySource = readFileSync(new URL('../mod/manager-party.lua', import.meta.url), 'utf8');
const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;
const setup = `
local reads,paused=0,false
local point={id='4001ULL',name='Selected waypoint',position={x=12,y=34,z=0}}
local car={id='3001ULL',entityID={hash='3001ULL'},name='Summoned owned car',record='Vehicle.Test',owned=false}
local carInfo={ready=true,speed=0,playerGap=3,seats={{name='seat_front_left'},{name='seat_front_right'}}}
companionChauffeurAdapter=function(api)
 api.sample=function(player,entry)
  assert(not paused,'native sample from a paused menu action');reads=reads+1
  return {actor={serial=entry.serial,id=tostring(entry.entityID.hash),key=entry.profileKey},
   actorValid=entry.system:IsManaged(entry.entityID) and entry.system:IsTagged(entry.entityID,'CyberpunkConvaiCompanion'),
   actorCalm=true,playerCombat=false,car=car,carValid=true,info=carInfo,summonedId=car.id,
   waypoint=point,auto={enabled=false}}
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

test('manager drive and stop callbacks retain only Lua intent until flush, and the active driver remains protected', () => run(`
spawn();local member=companions.list()[1]
local queue=(function() ${partySource} end)().new(companions)
queue.bind('world-one')
paused=true;local before=reads
assert(queue.drive('live:'..member.serial))
assert(queue.chauffeur().pending and not companions.chauffeurSnapshot().active and reads==before)
assert(queue.cancelDrive() and not queue.chauffeur().pending and reads==before)
assert(queue.drive('live:'..member.serial));paused=false;queue.flush()
assert(companions.chauffeurSnapshot().active and reads==before+1)
paused=true;assert(not queue.dismiss('live:'..member.serial))
assert(queue.cancelDrive() and queue.chauffeur().stopPending)
assert(companions.chauffeurSnapshot().phase=='releasing')
paused=false;queue.flush()
assert(companions.chauffeurSnapshot().phase=='stopping' and not queue.chauffeur().stopPending)
`));

test('manager world reset, dismissal and a changed waypoint failure cannot replay a deferred trip', () => run(`
spawn();local member=companions.list()[1]
local queue=(function() ${partySource} end)().new(companions)
queue.bind('world-one');assert(queue.drive('live:'..member.serial))
queue.bind(nil);queue.bind('world-two');queue.flush()
assert(reads==0 and not companions.chauffeurSnapshot().active)
assert(queue.drive('live:'..member.serial));point=nil;queue.flush();queue.flush()
assert(reads==1 and not companions.chauffeurSnapshot().active)
local notices=queue.takeNotices();assert(#notices==1 and notices[1].failed and notices[1].message:find('destination',1,true))
assert(queue.drive('live:'..member.serial));assert(queue.dismiss('live:'..member.serial));queue.flush()
assert(reads==1 and #companions.list()==0)
`));
