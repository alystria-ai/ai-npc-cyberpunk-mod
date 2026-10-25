import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import fengari from 'fengari';

// The home half of the seating controller (docs/COMPANION_SETTLE.md): a companion claims a place from the home, walks there with AI move commands,
// sits (the same workspot, exit and step-out as beside V) or stands, and follows again when the home ends. A fake native layer, driven through the same
// tick/steer/observe contract the companions loop uses.
const seatingSource = readFileSync(new URL('../mod/companion-seating.lua', import.meta.url), 'utf8');
function run(code) {
  const {lua: L, lauxlib, lualib, to_luastring, to_jsstring} = fengari;
  const vm = lauxlib.luaL_newstate(); lualib.luaL_openlibs(vm);
  const result = lauxlib.luaL_dostring(vm, to_luastring(fixture + code));
  const error = result === L.LUA_OK ? '' : to_jsstring(L.lua_tostring(vm, -1));
  L.lua_close(vm); assert.equal(result, L.LUA_OK, error);
}
const fixture = `
dofile=function(path)
  if path=='gesture-workspot.lua' then return {} end
  error('unexpected dofile '..path)
end
local m=(load([==[${seatingSource.replace(/\r\n/g, '\n')}]==]))()
local calls,logs={}, {}
local function count(name) local n=0;for _,c in ipairs(calls) do if c.name==name then n=n+1 end end;return n end
local function last(name) for i=#calls,1,-1 do if calls[i].name==name then return calls[i] end end end
local function lastLog(kind) for i=#logs,1,-1 do if logs[i].kind==kind then return logs[i] end end end
local function countLog(kind) local n=0;for _,l in ipairs(logs) do if l.kind==kind then n=n+1 end end;return n end
local seat={inside=false}
local native={}
local devices={}
function native.playerSeat(player,detail)
  calls[#calls+1]={name='playerSeat'}
  local out={inside=seat.inside,combat=seat.combat}
  if not seat.inside then return out end
  out.position={x=0,y=0,z=0};out.forward={x=0,y=1}
  out.entering,out.exiting,out.psmWorkspot=seat.entering,seat.exiting,seat.psm
  if detail then out.orientation={quat=true};out.path=seat.path;out.anim=seat.anim end
  return out
end
local boxes={}
function native.surface(x,y,top,bottom)
  calls[#calls+1]={name='surface'}
  local best=0
  for _,b in ipairs(boxes) do if x>=b.x1 and x<=b.x2 and y>=b.y1 and y<=b.y2 and b.h>best then best=b.h end end
  return best
end
function native.blocked(from,to) calls[#calls+1]={name='blocked'};return false end
function native.people() calls[#calls+1]={name='people'};return {} end
function native.spawnDevice(position,orientation,template) calls[#calls+1]={name='spawn',x=position.x,y=position.y,orientation=orientation};local id={hash=#calls};devices[id]={x=position.x,y=position.y};return true,id end
function native.deviceEntity(id) return {device=id} end
function native.deleteDevice(id) calls[#calls+1]={name='delete'};return true end
function native.sweep() return true end
local playOk=true
function native.play(device,npc,component,slide) calls[#calls+1]={name='play',component=component,npc=npc};if not playOk then return false,'refused' end;npc.entering=true;npc.seatAt=devices[device.device];return true end
function native.inWorkspot(npc) calls[#calls+1]={name='inWorkspot'};return npc.inside end
function native.exit(npc,instant) calls[#calls+1]={name='exit',instant=instant==true,npc=npc};npc.leaving=true;return true end
function native.stopInDevice(npc) return true end
function native.look(entry,style) calls[#calls+1]={name='look',style=style};return true end
function native.orientation(yaw) return {quat=true,yaw=yaw} end
function native.navPoint(point) return {x=point.x,y=point.y,z=point.z} end
function native.lineClear() return true end
function native.workspotBusy() return false end
function native.openness() return 4 end
function native.stepOut(entry,spot) calls[#calls+1]={name='stepOut'};entry.position={x=spot.x,y=spot.y,z=0};return true end
function native.teleport(entry,spot) calls[#calls+1]={name='teleport'};entry.position={x=spot.x,y=spot.y,z=0};return true end
function native.bodyClear() return true end
function native.lookingAt() return false end
function native.hiddenFrom() return true end
local catalog={device='dev.ent',seatComponents={couch='convai_sit_couch',chair='convai_sit_chair',bar='convai_sit_bar',stool='convai_sit_stool'}}
local c=m.new({catalog=catalog,native=native,log=function(kind,fields) logs[#logs+1]={kind=kind,fields=fields} end})
local player={GetWorldPosition=function() return {x=0,y=0,z=0} end}
local function companion(serial,x,y)
  local npc={inside=false,serial=serial}
  return {serial=serial,entityID={hash=tostring(70+serial)},npc=npc,position={x=x,y=y,z=0},speed=0,playerGap=math.sqrt(x*x+y*y),
  motor={kind='hold',ticket='h',feedback={}}}
end
local party={companion(1,1.5,1.5)}
local decisions,held={}, {}
local combat,selected=false,false
local clockNow=0
local function step(seconds)
  for i=1,math.max(1,math.floor(seconds/.1+.5)) do
    local rows={}
    for _,e in ipairs(party) do rows[#rows+1]={entry=e,transport=e.transport==true} end
    clockNow=clockNow+.1
    c.tick(player,.1,rows)
    for _,e in ipairs(party) do
      local npc=e.npc
      if npc.entering then npc.entering=nil;npc.inside=true;if npc.seatAt then e.position={x=npc.seatAt.x,y=npc.seatAt.y,z=0} end end
      if npc.leaving then npc.leaving=nil;npc.inside=false end
      local d=c.steer(e,{combat=combat,motion=e.motor.feedback,selected=selected,facingError=90,frame={position={x=0,y=0,z=0}}})
      decisions[e.serial]=d
      if d and d.operation then
        local op=d.operation
        e.motor.ticket,e.motor.kind=op.ticket,op.kind
        if op.kind=='move' then
          e.position={x=op.goal.x,y=op.goal.y,z=0}
          e.motor.feedback={ticket=op.ticket,complete=true}
        else e.motor.feedback={ticket=op.ticket} end
      end
      held[e.serial]=c.observe(e,{combat=combat,selected=selected})
    end
  end
end
-- A home that hands out the places of a list, in order, and writes down what comes back.
local claims,freed={}, {}
local function home(places)
  local index=0
  return c.setHome({
    claim=function(entry) claims[#claims+1]=entry.serial;index=index+1;return places[index] end,
    freed=function(place,bad,reason,serial) freed[#freed+1]={id=place.id,bad=bad,reason=reason,serial=serial} end})
end
local stand={id='stand1',kind='stand',x=3,y=3,z=0,yaw=90}
local sofa={id='sofa1',kind='couch',x=2,y=0.2,z=0,yaw=0,approach={x=2,y=1.2,z=0}}
`;

test('away from home the controller does nothing for a companion: no native call at all', () => run(`
  step(3)
  for _,call in ipairs(calls) do assert(call.name=='playerSeat', 'unexpected native call '..call.name) end
  assert(decisions[1]==nil and held[1]==false)
  assert(c.snapshot().home==nil)
`));

test('a standing place: she walks there, turns, stays, and follows again when the home ends', () => run(`
  home({stand})
  step(.1)
  assert(decisions[1] and decisions[1].operation.kind=='move', 'a walk to the place')
  assert(math.abs(party[1].position.x-3)<.01 and math.abs(party[1].position.y-3)<.01, 'walked there')
  step(.1)
  assert(decisions[1].operation.kind=='turn', 'then turns')
  step(3)
  assert(decisions[1].operation.kind=='hold' and decisions[1].phase=='home-post', 'then stays')
  assert(held[1]==false, 'no workspot owns her body: gestures and talk work as for a standing companion')
  assert(count('spawn')==0 and count('play')==0, 'no seat device for a standing place')
  assert(c.owns(party[1])==true and c.holds(party[1])==false)
  assert(#claims==1, 'one claim only')
  selected=true;step(.2)
  assert(decisions[1].look=='full', 'looks at V while V talks to her')
  selected=false
  c.clearHome('V left')
  step(.3)
  assert(decisions[1]==nil, 'following resumes')
  assert(#freed==0, 'the home that ended is not told')
`));

test('a seat: device at the root, the sofa workspot, held while seated, native exit when the home ends, then she follows', () => run(`
  home({sofa})
  step(3)
  local spawn=last('spawn')
  assert(spawn and spawn.x==2 and spawn.y==0.2 and spawn.orientation.yaw==0, 'device on the seat root, turned to the place\\'s facing')
  assert(count('play')==1 and last('play').component=='convai_sit_couch')
  assert(held[1]==true and lastLog('seat-seated'), 'seated')
  selected=true;step(.2);selected=false
  assert(last('look').style=='full', 'looks at V when V talks to her')
  local before=count('inWorkspot')
  step(5)
  assert(count('exit')==0, 'she stays as long as the home does')
  c.clearHome('V left')
  step(.3)
  assert(count('exit')==1 and not last('exit').instant, 'the native fast exit')
  step(3)
  assert(held[1]==false and decisions[1]==nil, 'following resumes')
  assert(count('delete')>=1, 'device removed')
  assert(c.snapshot().companions[1].phase=='off')
`));

test('a fight stands her up at once, and a scene or a car (the home ends) with the normal exit', () => run(`
  home({sofa})
  step(3)
  assert(held[1]==true)
  combat=true;step(.2)
  assert(count('exit')==1 and last('exit').instant==true, 'instant exit in combat')
  step(2);combat=false
  assert(decisions[1]==nil, 'following')
`));

test('two companions never take the same place: the home hands out one place per claim', () => run(`
  party={companion(1,1.5,1.5),companion(2,-1.5,1.5)}
  home({sofa,stand})
  step(3)
  assert(#claims==2 and claims[1]~=claims[2])
  local spawns=count('spawn')
  assert(spawns==1, 'one seat device, one standing place')
  assert(c.snapshot().companions[1].place~=c.snapshot().companions[2].place)
  local heldList=c.homeHeld()
  assert(#heldList==2)
`));

test('V sits on the very place she holds: she gets up and takes another', () => run(`
  local other={id='sofa2',kind='couch',x=5,y=5,z=0,yaw=0,approach={x=5,y=6,z=0}}
  home({{id='under-v',kind='couch',x=0.1,y=0,z=0,yaw=0,approach={x=0.1,y=1,z=0}},other})
  step(3)
  assert(held[1]==true, 'seated on the place that is V\\'s own')
  seat.inside,seat.entering=true,true
  seat.path,seat.anim='base\\\\workspots\\\\player\\\\couch\\\\player__sit_couch_lean_back__sit_around__01.workspot','sit_couch_lean180__rh_on_couch__01'
  step(.3);seat.entering=false
  step(2)
  assert(count('exit')>=1, 'she stands up')
  step(4)
  assert(#claims>=2, 'asks for another place')
  assert(c.snapshot().companions[1].place=='sofa2' or c.snapshot().companions[1].phase~='off', 'on her way to the other place')
`));

test('dismissed (or taken by transport): the place goes back to the home', () => run(`
  home({stand})
  step(3)
  c.release(party[1],'dismissed')
  assert(#freed==1 and freed[1].id=='stand1' and freed[1].bad==false)
`));

test('a seat that never plays is reported as bad, so nobody is sent there again', () => run(`
  playOk=false
  home({sofa})
  step(3)
  assert(#freed==1 and freed[1].id=='sofa1' and freed[1].bad==true and freed[1].reason=='play failed', 'bad place reported')
  assert(count('delete')>=1)
`));

test('one companion is told to follow: she stands up and takes no other place in this home', () => run(`
  party={companion(1,1.5,1.5),companion(2,-1.5,1.5)}
  home({stand,{id='stand2',kind='stand',x=-3,y=3,z=0,yaw=0},{id='stand3',kind='stand',x=-4,y=4,z=0,yaw=0}})
  step(3)
  assert(#claims==2)
  assert(c.homeRelease(1,'follow',false)==true)
  step(1)
  assert(decisions[1]==nil, 'following')
  assert(decisions[2] and decisions[2].operation.kind=='hold', 'the other stays')
  step(5)
  assert(#claims==2, 'no new claim for her')
  assert(#freed==1 and freed[1].bad==false)
`));

test('a change of clothes: the seated companion stands up, takes no place during the hold, then the home gives her one again', () => run(`
  local again={id='sofa2',kind='couch',x=5,y=5,z=0,yaw=0,approach={x=5,y=6,z=0}}
  home({sofa,again})
  step(3)
  assert(held[1]==true and #claims==1, 'seated on the first place')
  assert(c.homeStandUp(99,40)==nil, 'nobody of that serial')
  assert(c.homeStandUp(1,40)=='released', 'released')
  step(.3)
  assert(count('exit')==1 and not last('exit').instant, 'the native exit, not an instant one')
  assert(c.homeStandUp(1,40)~=nil)
  step(3)
  assert(held[1]==false and c.snapshot().companions[1].phase=='off', 'standing, free')
  assert(#freed==1 and freed[1].id=='sofa1' and freed[1].bad==false and freed[1].reason=='outfit', 'the home is told, the place is fine')
  step(30)
  assert(#claims==1 and held[1]==false, 'no claim while the hold lasts')
  step(12)
  assert(#claims==2 and c.snapshot().companions[1].place=='sofa2', 'the home gives her a place afterwards')
`));

test('a change of clothes: a standing post is let go at once, and a copy with no home place has nothing to release', () => run(`
  party={companion(1,1.5,1.5),companion(2,-1.5,1.5)}
  home({stand,{id='stand2',kind='stand',x=-3,y=3,z=0,yaw=0}})
  step(3)
  assert(c.homeStandUp(1,20)=='released' and count('exit')==0, 'a post has no workspot to leave')
  step(.3)
  assert(c.snapshot().companions[1].phase=='off' and decisions[2].operation.kind=='hold', 'the other stays')
  c.clearHome('V left')
  assert(c.homeStandUp(2,20)==nil, 'no home, nothing to release')
`));

test('a companion far from V gets no place; a new home starts over', () => run(`
  party[1].playerGap=40
  home({stand})
  step(3)
  assert(#claims==0)
  party[1].playerGap=2
  step(1.5)
  assert(#claims==1)
`));

test('a companion without a place asks at most once a second', () => run(`
  home({})
  step(10)
  assert(#claims<=10 and #claims>=8, 'claims: '..#claims)
`));

test('V sitting beside her: the seat beside V wins over a home place, the rest go home', () => run(`
  boxes[#boxes+1]={x1=-.35,x2=1.7,y1=-.6,y2=.1,h=.42}
  party={companion(1,1.2,1.5),companion(2,10,10)}
  seat.inside,seat.entering=true,true
  seat.path,seat.anim='base\\\\workspots\\\\player\\\\couch\\\\player__sit_couch_lean_back__sit_around__01.workspot','sit_couch_lean180__rh_on_couch__01'
  step(.3);seat.entering=false
  home({stand,{id='stand2',kind='stand',x=-3,y=3,z=0,yaw=0}})
  step(4)
  local beside
  for _,row in ipairs(c.snapshot().companions) do if row.serial==1 then beside=row end end
  assert(beside and beside.home~=true, 'companion 1 sits beside V, not at a home place: '..tostring(beside and beside.phase))
  assert(#claims>=1 and claims[1]==2, 'only the far companion asked the home')
`));

test('the home API: ending a home that was replaced, and the learned seat of V', () => run(`
  local first=home({stand})
  step(1)
  local second=c.setHome({claim=function() return nil end})
  assert(second~=first)
  step(.3)
  assert(decisions[1]==nil, 'the first home ended with the second')
  assert(c.vSeat()==nil and c.sitting()==false and c.canSit()==true and c.homeActive()==true)
  c.abandon()
  assert(c.homeActive()==false)
`));

test('the first party tick of a world asks the home once (onWorld), and again after the world was abandoned', () => run(`
  local asked=0
  local c2=m.new({catalog=catalog,native=native,onWorld=function() asked=asked+1 end})
  local rows={{entry=party[1]}}
  c2.tick(player,.1,rows);c2.tick(player,.1,rows);c2.tick(player,.1,rows)
  assert(asked==1,'once: '..asked)
  c2.abandon()
  c2.tick(player,.1,rows)
  assert(asked==2,'again in the next world: '..asked)
  local c3=m.new({catalog=catalog,native=native,onWorld=function() error('boom') end})
  c3.tick(player,.1,rows)
`));
