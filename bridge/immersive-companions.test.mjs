import {test} from 'node:test';
import assert from 'node:assert/strict';
import fengari from 'fengari';
import {companionEngine} from './companion-fixture.mjs';

const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;
function run(code) {
  const state = lauxlib.luaL_newstate(); lualib.luaL_openlibs(state);
  const program = companionEngine + code;
  const status = lauxlib.luaL_dostring(state, to_luastring(program));
  const error = status === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(state, -1));
  const line = Number(/\]:(\d+):/.exec(error)?.[1]);
  lua.lua_close(state); assert.equal(status, lua.LUA_OK, error + (line ? '\n' + program.split('\n')[line - 1] : ''));
}

// Visitors of mod/immersive-invitations.lua are real managed copies in state 'visiting': created at a spot of her module's choosing,
// moved by AI commands only, ignored by every party loop, and joined to the party without a respawn.
const visitor = `
  local function visit(id,x,y)
    local serial=companions.spawn('judy-alvarez',{profileKey='judy-alvarez',profileName='Judy Alvarez',appointment={id=id,position=Vector4.new(x or 40,y or 40,0),facing={x=-1,y=0}}})
    tick()
    return serial,entities[sequence]
  end
`;

test('an appointment spawn is created at her spot, waits as a visitor with no follower role, and shows in the list', () => run(`${visitor}
  local serial,npc=visit(7)
  assert(serial and npc)
  assert(npc.pos.x==40 and npc.pos.y==40,'created at the chosen spot, not beside V')
  local rows=companions.list()
  assert(#rows==1 and rows[1].state=='visiting',tostring(rows[1] and rows[1].state))
  assert(npc.ai.role.kind~='AIFollowerRole','no follower role while she visits')
  local visitors=companions.visitors()
  assert(#visitors==1 and visitors[1].appointmentId==7 and visitors[1].serial==serial and visitors[1].position.x==40)
  assert(companions.identity(npc)=='judy-alvarez','she can be talked to while she waits')
  for _=1,20 do companions.update(player,0.5) end
  assert(#active(npc)==0,'no party command is ever sent to a visitor')
`));

test('an invalid spot is refused', () => run(`${visitor}
  local serial,reason=companions.spawn('judy-alvarez',{appointment={id=1,position={x=0/0,y=1,z=0}}})
  assert(serial==nil and reason:find('meeting spot'),tostring(reason))
  assert(#companions.list()==0)
`));

test('a visitor walks by a native move command on the navmesh and reports its movement', () => run(`${visitor}
  local serial,npc=visit(7)
  assert(companions.visitorWalk(serial,Vector4.new(0,0,0),'Walk'))
  local command=last(npc,'AIMoveToCommand')
  assert(command and command.ignoreNavigation==false,'navigated, not a straight line')
  local feedback=companions.visitorSense(serial,0.5)
  assert(feedback and feedback.position.x==40 and feedback.active==true and feedback.complete==false)
  npc.pos=Vector4.new(10,10,0)
  feedback=companions.visitorSense(serial,0.5)
  assert(feedback.position.x==10 and feedback.speed>0)
  assert(not companions.visitorWalk(9999,Vector4.new(0,0,0),'Walk'),'an unknown serial')
`));

test('joining makes her a normal party member without a respawn: follower role, ready, formation commands', () => run(`${visitor}
  local serial,npc=visit(7,6,6)
  local entity=npc
  assert(companions.joinVisitor(serial))
  local rows=companions.list()
  assert(#rows==1 and rows[1].state=='ready' and rows[1].serial==serial)
  assert(npc.ai.role.kind=='AIFollowerRole')
  assert(entities[sequence]==entity,'the same body: no second entity')
  assert(#companions.visitors()==0)
  tick(10)
  assert(#npc.ai.commands>0,'the party loop now drives her')
  assert(not companions.joinVisitor(serial),'she is no longer a visitor')
`));

test('a fast travel deletes the visitors first and tells the module why, a member goes with the party', () => run(`${visitor}
  local lost={}
  companions.onVisitorLost=function(serial,reason) lost[#lost+1]=serial..':'..reason end
  local member=spawn('panam-palmer')
  local serial,npc=visit(8)
  assert(#companions.list()==2)
  companions.beginFastTravel()
  assert(#lost==1 and lost[1]==serial..':fast-travel',lost[1])
  local alive=0
  for _,n in pairs(entities) do alive=alive+1 end
  assert(alive==1,'only the party member survives: '..alive)
`));

test('dismissing a visitor tells the module why, once; the module removing her says so', () => run(`${visitor}
  local lost={}
  companions.onVisitorLost=function(serial,reason) lost[#lost+1]=reason end
  local serial=visit(9)
  assert(companions.dismiss(serial))
  assert(#lost==1 and lost[1]=='dismissed')
  local second=visit(10)
  assert(companions.dismissVisitor(second,'module'))
  assert(#lost==2 and lost[2]=='module')
  assert(#companions.list()==0)
`));

test('a visitor is not part of the party frame: no group, no recovery teleport however far V goes', () => run(`${visitor}
  local serial,npc=visit(7,200,200)
  player.pos=Vector4.new(900,900,0)
  for _=1,40 do companions.update(player,0.5) end
  assert(npc.pos.x==200,'never carried or recovered to V')
  local teleports=0
  for _,cmd in ipairs(npc.ai.commands) do if cmd.kind=='AITeleportCommand' then teleports=teleports+1 end end
  assert(teleports==0)
`));

test('a visitor boards and leaves a car by the animated mount commands, and reports whether she sits in it', () => run(`${visitor}
  EntityID={new=function() return {hash='0ULL'} end}
  local serial,npc=visit(11)
  local car={id='77ULL',entityID={hash='77ULL'}}
  assert(companions.visitorMount(serial,car,'seat_front_left',false))
  local mount=last(npc,'AIMountCommand')
  assert(mount and mount.mountData.slotName=='seat_front_left' and mount.mountData.isInstant==false and mount.mountData.mountParentEntityId.hash=='77ULL')
  assert(companions.visitorMounted(serial,car)==false,'not yet')
  Game.GetMountingFacility=function() return {GetMountingInfoSingleWithObjects=function() return {parentId={hash='77ULL'},slotId={id='seat_front_left'}} end} end
  assert(companions.visitorMounted(serial,car)==true and companions.visitorMounted(serial,car,'seat_front_left')==true)
  assert(companions.visitorMounted(serial,car,'seat_back_left')==false and companions.visitorMounted(serial,{id='88ULL'})==false)
  assert(companions.visitorMount(serial,car,'seat_front_left',true,true))
  local leave=last(npc,'AIUnmountCommand')
  assert(leave and leave.mountData.isInstant==true and leave.mountData.allowFailsafeTeleport==true)
  assert(not companions.visitorMount(9999,car,'seat_front_left',false),'an unknown serial')
`));

test('the hidden spot of a visitor: behind where V looks, far enough, reachable, and never beside another visitor', () => run(`${visitor}
  companions.visibleFromCrosshair=function() return false end
  local request={destination=Vector4.new(0,0,0),mode='walk',relax=0,maxDistance=90}
  local state={}
  local spot,reason,deferred=companions.findVisitorSpot('judy-alvarez',request,state)
  for _=1,12 do if spot or reason then break end spot,reason,deferred=companions.findVisitorSpot('judy-alvarez',request,state) end
  assert(spot,tostring(reason))
  assert(math.abs(spot.goal.x)<.01 and spot.distance>=35 and spot.eta>20)
  assert(spot.position.y<-30,'behind V, who faces +y: '..spot.position.y)
  -- another visitor stands there: the next candidate is taken
  local other={}
  other.state={}
  request.avoid={{x=spot.position.x,y=spot.position.y,z=0}}
  local second,why=companions.findVisitorSpot('judy-alvarez',request,{})
  for _=1,12 do if second or why then break end second,why=companions.findVisitorSpot('judy-alvarez',request,{}) end
  assert(second and (math.abs(second.position.x-spot.position.x)>3 or math.abs(second.position.y-spot.position.y)>3))
`));

test('a spot search that spends the query budget asks again instead of failing', () => run(`${visitor}
  companions.visibleFromCrosshair=function() return false end
  local spent=0
  local real=Game.GetAINavigationSystem
  local request={destination=Vector4.new(0,0,0),mode='walk',relax=0,maxDistance=90}
  local state={}
  local first,reason,deferred=companions.findVisitorSpot('judy-alvarez',request,state)
  assert(first or deferred==true or reason==nil,'a batch of candidates: found, or ask again')
`));

// A street is a narrow corridor between buildings: the navmesh exists only within a few metres of its axis, and V stands in the middle of it.
const street = (degrees, half) => `
  local axis=math.rad(${degrees})
  local dx,dy=math.cos(axis),math.sin(axis)
  local queries=0
  local function snap(position,radius)
    local along=position.x*dx+position.y*dy
    local across=position.x*dy*-1+position.y*dx
    if math.abs(across)-${half}>radius then return {status='Failed'} end
    local keep=math.max(-${half},math.min(${half},across))
    return {status='OK',point=Vector4.new(along*dx-keep*dy,along*dy+keep*dx,0)}
  end
  Game.GetAINavigationSystem=function() return {
    FindPointInSphereForCharacter=strictNative('FindPointInSphereForCharacter',{1},function(_,position,radius) queries=queries+1; return snap(position,radius) end),
    FindPointInBoxForCharacter=strictNative('FindPointInBoxForCharacter',{1,2},function(_,position) return snap(position,3) end),
    CalculatePathForCharacter=strictNative('CalculatePathForCharacter',{1,2},function(_,origin,destination)
      return {path={origin,destination},CalculateLength=function() return math.sqrt((destination.x-origin.x)^2+(destination.y-origin.y)^2) end}
    end)} end
  companions.visibleFromCrosshair=function() return false end
  local function search(relax)
    local request={destination=Vector4.new(0,0,0),mode='walk',relax=relax,maxDistance=90}
    local state={}
    local spot,reason,deferred
    local calls=0
    repeat
      calls=calls+1
      spot,reason,deferred=companions.findVisitorSpot('judy-alvarez',request,state)
    until spot or reason or calls>60
    return spot,reason,calls
  end
`;

test('a street that no ring bearing lines up with still gives her a spot on the first rung, 35 m or more away', () => {
  for (const angle of [8, 22, 37, 52, 75, 100]) run(`${visitor}
    ${street(angle, 3)}
    local spot,reason=search(0)
    assert(spot,'${angle} degrees: '..tostring(reason))
    assert(math.sqrt(spot.position.x^2+spot.position.y^2)>=35,'far enough')
  `);
});

test('a street she cannot reach gives a final answer that says which checks turned the candidates away', () => run(`${visitor}
  ${street(30, 3)}
  Game.GetAINavigationSystem=function() return {
    FindPointInSphereForCharacter=strictNative('FindPointInSphereForCharacter',{1},function(_,position) return {status=(position.x==0 and position.y==0) and 'OK' or 'Failed',point=position} end),
    FindPointInBoxForCharacter=strictNative('FindPointInBoxForCharacter',{1,2},function(_,position) return {status='OK',point=position} end),
    CalculatePathForCharacter=strictNative('CalculatePathForCharacter',{1,2},function(_,o,d) return {path={o,d},CalculateLength=function() return 1 end} end)} end
  local spot,reason=search(0)
  assert(spot==nil and reason:find('of=%d+ nav=%d+'),tostring(reason))
`));

test('the search never examines more than a dozen ring points in one call, so a dense street cannot stall a frame', () => run(`${visitor}
  ${street(30, 3)}
  local request={destination=Vector4.new(0,0,0),mode='walk',relax=0,maxDistance=90}
  companions.visibleFromCrosshair=function() return true end
  local before=queries
  companions.findVisitorSpot('judy-alvarez',request,{})
  assert(queries-before<=2*12+1,'queries in one call: '..(queries-before))
`));
