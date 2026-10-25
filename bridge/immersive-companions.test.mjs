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
