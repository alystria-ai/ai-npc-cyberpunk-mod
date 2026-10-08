import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import fengari from 'fengari';

// Seating controller fixture (docs/COMPANION_SEATING.md): a fake native layer
// with a scripted V seat and a small world of seat surfaces, driven through the
// same tick/steer/observe contract the companions loop uses.
const controller = readFileSync(new URL('../mod/companion-seating.lua', import.meta.url), 'utf8');
function run(code) {
  const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;
  const vm = lauxlib.luaL_newstate(); lualib.luaL_openlibs(vm);
  const result = lauxlib.luaL_dostring(vm, to_luastring(fixture + code));
  const error = result === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(vm, -1));
  lua.lua_close(vm); assert.equal(result, lua.LUA_OK, error);
}
const fixture = `
dofile=function(path)
  if path=='gesture-workspot.lua' then return {} end
  error('unexpected dofile '..path)
end
local m=(load([==[${controller}]==]))()
local calls,logs={}, {}
local function count(name) local n=0;for _,c in ipairs(calls) do if c.name==name then n=n+1 end end;return n end
local function last(name) for i=#calls,1,-1 do if calls[i].name==name then return calls[i] end end end
local function lastLog(kind) for i=#logs,1,-1 do if logs[i].kind==kind then return logs[i] end end end
-- World: V sits at the origin facing +y (right = +x). Surfaces are boxes
-- {x1,x2,y1,y2,h}; the floor is z=0 everywhere. Walls block the seat line.
local world={boxes={},walls={},people={}}
local function couch(x1,x2) world.boxes[#world.boxes+1]={x1=x1,x2=x2,y1=-.6,y2=.1,h=.42} end
local function stool(x) world.boxes[#world.boxes+1]={x1=x-.17,x2=x+.17,y1=-.17,y2=.17,h=.75} end
local seat={inside=false}
local native={}
function native.playerSeat(player,detail)
  calls[#calls+1]={name='playerSeat',detail=detail}
  local out={inside=seat.inside,combat=seat.combat}
  if not seat.inside then return out end
  out.position={x=seat.x or 0,y=seat.y or 0,z=0};out.forward={x=0,y=1}
  out.entering,out.exiting=seat.entering,seat.exiting
  if detail then out.orientation={quat=true};out.mounted=seat.mounted;out.path=seat.path;out.anim=seat.anim end
  return out
end
function native.surface(x,y,top,bottom)
  calls[#calls+1]={name='surface'}
  local best=0
  for _,b in ipairs(world.boxes) do if x>=b.x1 and x<=b.x2 and y>=b.y1 and y<=b.y2 and b.h>best then best=b.h end end
  for _,t in ipairs(world.tables or {}) do if x>=t.x1 and x<=t.x2 and y>=t.y1 and y<=t.y2 then best=math.max(best,t.h) end end
  return best
end
function native.blocked(from,to)
  calls[#calls+1]={name='blocked'}
  for _,w in ipairs(world.walls) do if (from.x-w)*(to.x-w)<0 then return true end end
  return false
end
function native.people(player,radius,exclude) calls[#calls+1]={name='people'};return world.people end
local spawnOk=true
function native.spawnDevice(position,orientation,template) calls[#calls+1]={name='spawn',x=position.x,y=position.y,template=template};return spawnOk,{hash=#calls} end
function native.deviceEntity(id) return {device=id} end
function native.deleteDevice(id) calls[#calls+1]={name='delete'};return true end
function native.sweep() calls[#calls+1]={name='sweep'};return true end
function native.play(device,npc,component,slide) calls[#calls+1]={name='play',component=component,npc=npc,slide=slide};npc.entering=true;return true end
function native.inWorkspot(npc) return npc.inside end
function native.exit(npc,instant) calls[#calls+1]={name='exit',instant=instant==true,npc=npc};npc.leaving=true;return true end
function native.stopInDevice(npc) calls[#calls+1]={name='stopInDevice'};return true end
function native.look(entry,style) calls[#calls+1]={name='look',style=style};return true end
local enabled=true
local catalog={device='dev.ent',seatComponents={couch='convai_sit_couch',chair='convai_sit_chair',bar='convai_sit_bar',stool='convai_sit_stool'}}
local c
local function build(options)
  options=options or {}
  c=m.new({catalog=options.catalog or catalog,native=native,enabled=function() return enabled end,
    log=function(kind,fields) logs[#logs+1]={kind=kind,fields=fields} end})
end
build()
local player={}
local function companion(serial,x,y)
  local npc={inside=false,serial=serial}
  return {serial=serial,entityID={hash=tostring(70+serial)},npc=npc,position={x=x,y=y,z=0},speed=0,playerGap=math.sqrt(x*x+y*y),
    motor={kind='hold',ticket='h',feedback={}}}
end
local party={companion(1,1.5,1.5)}
local decisions,held={}, {}
local combat=false
local selected=false
-- One companions update: tick, then per member steer (before behavior) and observe.
local function step(seconds,options)
  options=options or {}
  for i=1,math.max(1,math.floor(seconds/.1+.5)) do
    local rows={}
    for _,e in ipairs(party) do rows[#rows+1]={entry=e,transport=e.transport==true} end
    c.tick(player,.1,rows)
    for _,e in ipairs(party) do
      local npc=e.npc
      if npc.entering then npc.entering=nil;npc.inside=true end
      if npc.leaving and not npc.stuck then npc.leaving=nil;npc.inside=false end
      if options.observe~=false then
        local d=c.steer(e,{combat=combat,motion=e.motor.feedback})
        decisions[e.serial]=d
        if d and d.operation then
          -- The actuator: walks a move to its goal in one update, holds a hold.
          local op=d.operation
          if not held[e.serial] then
            e.motor.ticket,e.motor.kind=op.ticket,op.kind
            if op.kind=='move' and options.walk~=false then
              e.position={x=op.goal.x,y=op.goal.y,z=0}
              e.motor.feedback={ticket=op.ticket,complete=true}
            elseif op.kind=='move' then e.motor.feedback={ticket=op.ticket,failed=options.refuse==true}
            else e.motor.feedback={ticket=op.ticket} end
          end
        end
        held[e.serial]=c.observe(e,{combat=combat,selected=selected})
      end
    end
  end
end
local function sitV(path,anim)
  seat.inside,seat.entering,seat.path,seat.anim=true,true,path or 'base\\\\workspots\\\\player\\\\couch\\\\player__sit_couch_lean_back__sit_around__01.workspot',anim or 'sit_couch_lean180__rh_on_couch__01'
  step(.3);seat.entering=false
end
`;

test('classifies V seats from the workspot path and animation', () => run(`
  assert(m.classify('base\\\\workspots\\\\player\\\\couch\\\\player__sit_couch_lean_back__sit_around__01.workspot','')=='couch')
  assert(m.classify('','sit_barstool_bar_lean0__2h_on_bar__01')=='bar')
  assert(m.classify('base\\\\workspots\\\\player\\\\barstool\\\\player__sit_barstool__sit_around__01.workspot','')=='stool')
  assert(m.classify('','sit_chair__2h_on_lap__01')=='chair')
  assert(m.classify('','sit_chair_table_lean0__2h_on_table__01')=='table')
  assert(m.classify('','sit_bench_lean180__2h_on_lap__01')=='bench')
  assert(m.classify('base\\\\workspots\\\\player\\\\car\\\\player__sit_car_lean_back_idle_01.workspot','')==nil,'vehicles are excluded')
  assert(m.classify('','sit_ground__2h_elbow_on_knees__01')==nil,'the ground is not a seat')
  assert(m.classify('','stand__lean_rail__01')==nil,'not sitting')
  assert(m.classify(nil,nil)==nil)
`));

test('finds seats along a couch and separate stools, nearest first', () => run(`
  local samples={[1]={},[-1]={}}
  for i=0,16 do local o=.45+i*.1
    samples[1][#samples[1]+1]={offset=o,h=(o<=1.7) and .42 or 0}
    samples[-1][#samples[-1]+1]={offset=o,h=(o<=.5) and .42 or 0}
  end
  local seats=m.findSeats(samples,m.kinds.couch,.42)
  assert(#seats==2,'two seats on the long side: '..#seats)
  assert(math.abs(seats[1].offset-.66)<.01 and math.abs(seats[2].offset-1.32)<.01,'pitch spacing')
  -- Armrest (too high against V's cushion) and floor are never seats.
  samples[-1]={}
  for i=0,16 do local o=.45+i*.1; samples[-1][#samples[-1]+1]={offset=o,h=(o<=1.0) and .65 or 0} end
  seats=m.findSeats(samples,m.kinds.couch,.42)
  for _,s in ipairs(seats) do assert(s.offset>0,'armrest side has no seat') end
  -- Stools at 0.7 m on both sides.
  local st={[1]={},[-1]={}}
  for i=0,11 do local o=.45+i*.1; local h=(o>=.53 and o<=.87) and .75 or 0
    st[1][#st[1]+1]={offset=o,h=h}; st[-1][#st[-1]+1]={offset=o,h=h} end
  seats=m.findSeats(st,m.kinds.stool,.75)
  assert(#seats==2,'one stool each side: '..#seats)
  assert(math.abs(math.abs(seats[1].offset)-.7)<.06,'stool centre '..seats[1].offset)
  assert(seats[1].offset*seats[2].offset<0,'both sides')
`));

test('V sits on a couch: the companion walks to the free seat, sits, and stands when V does', () => run(`
  couch(-.35,1.7)
  step(1)
  assert(count('surface')==0,'no raycasts while V stands')
  sitV()
  step(2)
  assert(lastLog('seats-found'),'seats searched once V settled')
  assert(count('surface')<=80,'bounded search rays: '..count('surface'))
  local spawn=last('spawn')
  assert(spawn and math.abs(spawn.x-.66)<.01 and math.abs(spawn.y)<.01,'device at the seat beside V')
  assert(count('play')==1 and last('play').component=='convai_sit_couch','couch sit workspot')
  assert(held[1]==true,'movement waits while seated')
  assert(lastLog('seat-seated'),'seated')
  assert(last('look') and last('look').style=='side','looks at V while seated')
  selected=true;step(.2)
  assert(last('look').style=='full','full attention when V talks to them')
  local surfaces=count('surface');step(3)
  assert(count('surface')==surfaces,'no further searches while seated')
  seat.inside=false;step(.5)
  assert(count('exit')==1 and not last('exit').instant,'native fast exit when V stands')
  step(.3)
  assert(held[1]==false and decisions[1]==nil,'following resumes')
  assert(count('delete')>=1,'device removed')
`));

test('V getting up (workspot exiting) stands the companion up at once', () => run(`
  couch(-.35,1.7);sitV();step(1.5)
  assert(held[1]==true)
  seat.exiting=true;step(.3)
  assert(count('exit')==1,'exit on V exiting')
`));

test('combat stands up instantly; a new sit after it can seat again', () => run(`
  couch(-.35,1.7);sitV();step(1.5)
  assert(held[1]==true)
  combat=true;step(.2)
  assert(count('exit')==1 and last('exit').instant,'instant exit in combat')
  step(.5);combat=false
  seat.inside=false;step(.5);sitV();step(1.5)
  assert(count('play')==2,'seated again on the next sit')
`));

test('several companions take different seats', () => run(`
  couch(-1.5,1.7)
  party={companion(1,1.2,1.5),companion(2,-1.2,1.5)}
  sitV();step(2)
  local spawns={}
  for _,call in ipairs(calls) do if call.name=='spawn' then spawns[#spawns+1]=call.x end end
  assert(#spawns==2,'two seats: '..#spawns)
  assert(math.abs(spawns[1]-spawns[2])>.6,'different seats')
  assert(count('play')==2 and held[1] and held[2])
`));

test('no free seat: the companion keeps standing near V', () => run(`
  couch(-.35,.4)
  sitV();step(2)
  assert(count('spawn')==0 and count('play')==0 and decisions[1]==nil,'no seat')
  assert(lastLog('seat-none'),'logged')
`));

test('walls, occupied seats and a missing walk-up floor reject a seat', () => run(`
  couch(-1.5,1.7);world.walls={.3}
  world.people={{x=-.66,y=0,z=0}}
  sitV();step(2)
  assert(count('play')==0,'wall on the right, person on the left')
  local rejected={}
  for _,l in ipairs(logs) do if l.kind=='seat-rejected' then rejected[l.fields.reason]=true end end
  assert(rejected['wall between'] and rejected['occupied'],'both reasons logged')
`));

test('a table in front moves the walk-up point; no floor at all rejects', () => run(`
  couch(-.35,1.7);world.tables={{x1=-2,x2=3,y1=.6,y2=.9,h=.45}}
  sitV();step(2)
  assert(count('play')==1,'walk-up beyond the table')
  local spawn=last('spawn');assert(spawn)
`));

test('vehicles, unsupported workspots and the setting keep companions standing', () => run(`
  couch(-.35,1.7)
  seat.mounted=true;sitV();step(2)
  assert(count('spawn')==0,'mounted V is a vehicle')
  seat.mounted=false;seat.inside=false;step(.5)
  sitV('base\\\\workspots\\\\player\\\\car\\\\player__sit_car_passenger_seat__sit_around__01.workspot','sit_car')
  step(2);assert(count('spawn')==0,'car workspot')
  assert(lastLog('player-workspot').fields.kind=='unsupported')
  seat.inside=false;step(.5);enabled=false;sitV();step(2)
  assert(count('spawn')==0,'setting off')
  enabled=true;seat.inside=false;step(.5);sitV();step(2)
  assert(count('play')==1,'setting on again')
  enabled=false;step(.3)
  assert(count('exit')==1,'turning the setting off stands them up')
`));

test('an old archive without seat workspots never takes the body', () => run(`
  build({catalog={device='dev.ent'}})
  couch(-.35,1.7);sitV();step(2)
  assert(count('spawn')==0 and count('play')==0 and decisions[1]==nil)
  assert(c.snapshot().disabled)
`));

test('a new catalog with the old archive (device without sit components) disables seating', () => run(`
  native.hasComponent=function(device,component) calls[#calls+1]={name='has',component=component};return false end
  couch(-.35,1.7);sitV();step(3)
  assert(count('has')==1 and count('play')==0,'never plays a missing component')
  assert(c.snapshot().disabled and lastLog('seat-disabled'))
  seat.inside=false;step(.5);sitV();step(3)
  assert(count('has')==1 and count('spawn')==1,'stays disabled for the session')
`));

test('a refused walk near the seat slides the rest; far away it gives up', () => run(`
  couch(-.35,1.7)
  party={companion(1,.9,1.2)}
  sitV();step(.6)
  step(3,{walk=false,refuse=true})
  assert(count('play')==1,'slid from 1.2 m')
  assert(last('play').slide>.5,'longer slide')
  seat.inside=false;step(1);step(.5)
  party={companion(2,4,4)}
  sitV();step(.6);step(4,{walk=false,refuse=true})
  assert(count('play')==1,'no slide from far away')
  assert(lastLog('seat-abandoned') or lastLog('seat-finished'))
`));

test('a copy taken by transport or not observed stands up at once', () => run(`
  couch(-.35,1.7);sitV();step(1.5)
  assert(held[1]==true)
  step(.1,{observe=false});step(.1,{observe=false})
  assert(count('exit')==1 and last('exit').instant,'unobserved copy released instantly')
`));

test('V standing costs one cheap native read at most four times a second', () => run(`
  step(4)
  local n=count('playerSeat')
  assert(n>=14 and n<=18,'reads in 4 s: '..n)
  for _,call in ipairs(calls) do if call.name=='playerSeat' then assert(call.detail==true,'detail only matters once seated') end end
  assert(count('surface')==0 and count('people')==0)
`));
