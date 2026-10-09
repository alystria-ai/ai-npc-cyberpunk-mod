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
  out.entering,out.exiting,out.psmWorkspot=seat.entering,seat.exiting,seat.psm
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
local devices={}
function native.spawnDevice(position,orientation,template) calls[#calls+1]={name='spawn',x=position.x,y=position.y,template=template};local id={hash=#calls};devices[id]={x=position.x,y=position.y,z=0};return spawnOk,id end
function native.deviceEntity(id) return {device=id} end
function native.deleteDevice(id) calls[#calls+1]={name='delete'};return true end
function native.sweep() calls[#calls+1]={name='sweep'};return true end
function native.play(device,npc,component,slide) calls[#calls+1]={name='play',component=component,npc=npc,slide=slide};npc.entering=true;npc.seatAt=devices[device.device];return true end
function native.inWorkspot(npc) return npc.inside end
function native.exit(npc,instant) calls[#calls+1]={name='exit',instant=instant==true,npc=npc};npc.leaving=true;exitClock[npc]=clockNow;return true end
function native.stopInDevice(npc) calls[#calls+1]={name='stopInDevice'};return true end
function native.look(entry,style) calls[#calls+1]={name='look',style=style};return true end
local watching=false
-- Walk-up pre-check: the navmesh covers the floor except world.noNav spots; a
-- straight line is blocked by any box at least as tall as the ray height.
world.noNav={}
function native.navPoint(point,npc) calls[#calls+1]={name='navPoint'}
  for _,n in ipairs(world.noNav) do if math.abs(point.x-n.x)<.3 and math.abs(point.y-n.y)<.3 then return nil end end
  return {x=point.x,y=point.y,z=point.z} end
function native.lineClear(from,to,heights) calls[#calls+1]={name='lineClear'}
  if world.noLine then return false end
  for i=0,20 do local x,y=from.x+(to.x-from.x)*i/20,from.y+(to.y-from.y)*i/20
    for _,b in ipairs(world.boxes) do if x>=b.x1 and x<=b.x2 and y>=b.y1 and y<=b.y2 and b.h>=heights[1] then return false end end end
  return true end
-- The stand-up clip: workspot activity lasts busyFor seconds after the exit.
busyFor,clockNow,exitClock=0,0,{}
function native.workspotBusy(npc) calls[#calls+1]={name='busy'}
  return exitClock[npc] ~= nil and clockNow-exitClock[npc] < busyFor end
-- Openness: 4 unless the spot is listed in world.enclosed.
world.enclosed={}
function native.openness(spot,toward,forward,reach,heights) calls[#calls+1]={name='openness'}
  for _,e in ipairs(world.enclosed) do if math.abs(spot.x-e.x)<.3 and math.abs(spot.y-e.y)<.3 then return 1 end end
  return 4 end
-- Standing up: the step out walks her there unless stepStuck; a teleport always lands.
local stepStuck=false
world.noRoom={}
function native.stepOut(entry,spot) calls[#calls+1]={name='stepOut',serial=entry.serial,x=spot.x,y=spot.y}
  if not stepStuck then entry.position={x=spot.x,y=spot.y,z=0} end;return true end
function native.teleport(entry,spot,yaw) calls[#calls+1]={name='teleport',serial=entry.serial,x=spot.x,y=spot.y,yaw=yaw}
  entry.position={x=spot.x,y=spot.y,z=0};return true end
function native.bodyClear(spot,shape) calls[#calls+1]={name='bodyClear'}
  if world.roomFilter then return world.roomFilter(spot) end
  for _,b in ipairs(world.boxes) do if spot.x>=b.x1-.3 and spot.x<=b.x2+.3 and spot.y>=b.y1-.3 and spot.y<=b.y2+.3 then return false end end
  for _,n in ipairs(world.noRoom) do if math.abs(spot.x-n.x)<.3 and math.abs(spot.y-n.y)<.3 then return false end end
  return true end
function native.lookingAt(player,point,cone) calls[#calls+1]={name='lookingAt'};return watching end
-- V's camera (V at the origin): cameraDir, a cone; watching=true means V looks
-- straight at her whatever the angle.
cameraDir={x=0,y=1}
function native.hiddenFrom(player,point,cone) calls[#calls+1]={name='hiddenFrom'}
  if watching then return false end
  local l=math.sqrt(point.x^2+point.y^2); if l<1e-3 then return false end
  local cos=(point.x*cameraDir.x+point.y*cameraDir.y)/l
  return cos<math.cos(math.rad(cone)) end
local catalog={device='dev.ent',seatComponents={couch='convai_sit_couch',chair='convai_sit_chair',bar='convai_sit_bar',stool='convai_sit_stool'}}
local c
local function build(options)
  options=options or {}
  c=m.new({catalog=options.catalog or catalog,native=native,
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
    clockNow=clockNow+.1
    c.tick(player,.1,rows)
    for _,e in ipairs(party) do
      local npc=e.npc
      if npc.entering then npc.entering=nil;npc.inside=true;if npc.seatAt then e.position={x=npc.seatAt.x,y=npc.seatAt.y,z=0} end end
      if npc.leaving and not npc.stuck then npc.leaving=nil;npc.inside=false end
      if options.observe~=false then
        local d=c.steer(e,{combat=combat,motion=e.motor.feedback})
        decisions[e.serial]=d
        -- Her normal following (behavior.decide) when seating has no decision:
        -- 0.4 m a step toward her place 1.2 m in front of V.
        if not d and options.follow and not held[e.serial] then
          local tx,ty=options.follow.x,options.follow.y
          local dx,dy=tx-e.position.x,ty-e.position.y
          local len=math.sqrt(dx*dx+dy*dy)
          if len>.05 then local k=math.min(1,.4/len);e.position={x=e.position.x+dx*k,y=e.position.y+dy*k,z=0} end
        end
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
  step(2)
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

test('vehicles and unsupported workspots keep companions standing; a couch after them always seats', () => run(`
  couch(-.35,1.7)
  seat.mounted=true;sitV();step(2)
  assert(count('spawn')==0,'mounted V is a vehicle')
  seat.mounted=false;seat.inside=false;step(.5)
  sitV('base\\\\workspots\\\\player\\\\car\\\\player__sit_car_passenger_seat__sit_around__01.workspot','sit_car')
  step(2);assert(count('spawn')==0,'car workspot')
  assert(lastLog('player-workspot').fields.kind=='unsupported')
  seat.inside=false;step(.5);sitV();step(2)
  assert(count('play')==1,'no setting: a couch after them seats her')
  assert(c.snapshot().enabled==nil,'there is no user switch')
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
  party={companion(1,1.3,-.3)}
  sitV();step(.6)
  step(3,{walk=false,refuse=true})
  assert(count('play')==1,'slid from 0.7 m')
  assert(last('play').slide>=.5,'short slide')
  seat.inside=false;step(2.5);step(.5)
  party={companion(2,4,4)}
  sitV();step(.6);step(6,{walk=false,refuse=true})
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

// V's apartment couch, as measured by the October 8 probe: V's sit is a scene
// (no workspot instance), the cushion is 0.44-0.45 m up with its front edge
// 0.0-0.2 m behind V's root, it ends ~1.1 m to V's left at a higher armrest or
// side unit (0.50-0.59 m), and to V's right there is only floor.
test('apartment couch from the probe: unnamed scene sit, classified by the furniture, one seat on the left', () => run(`
  world.boxes={{x1=-1.1,x2=.3,y1=-.75,y2=-.15,h=.45},{x1=-1.1,x2=.3,y1=-.95,y2=-.75,h=.63},
    {x1=-2.2,x2=-1.1,y1=-.75,y2=.6,h=.58}}
  party={companion(1,-.46,1.15)}
  seat.inside,seat.psm=true,0;step(.6)
  assert(lastLog('player-sat') and lastLog('player-sat').fields.basis=='furniture','scene sit starts a furniture session')
  assert(count('surface')==0,'no rays while V is still sitting down (PSM 0)')
  seat.psm=1;step(2)
  local cls=lastLog('seat-classified')
  assert(cls and cls.fields.kind=='couch','classified as couch: '..tostring(cls and cls.fields.kind))
  assert(math.abs(cls.fields.h0-.45)<.01)
  local found=lastLog('seats-found');assert(found and found.fields.count==1,'one seat: '..tostring(found and found.fields.count))
  local spawn=last('spawn');assert(spawn and math.abs(spawn.x+.66)<.01 and math.abs(spawn.y)<.01,'seat 0.66 m to the left on the root line')
  assert(count('play')==1 and last('play').component=='convai_sit_couch')
  seat.psm=0;step(.3)
  assert(count('exit')==1,'PSM 1 to 0 while still in the workspot: V is getting up')
`));

test('a named workspot that is not a seat never starts a session; an unnamed one with no seat behind V does nothing', () => run(`
  couch(-.35,1.7)
  sitV('base\\\\workspots\\\\devices\\\\vending_machine\\\\player__use_vending.workspot','use_device')
  step(2);assert(not lastLog('player-sat'),'device workspot ignored')
  seat.inside=false;step(.5);world.boxes={}
  seat.inside,seat.path,seat.anim,seat.psm=true,nil,nil,1;step(2)
  assert(lastLog('seat-classified').fields.kind=='unsupported' and count('spawn')==0)
`));

test('a seat walk the actuator never takes counts as refused and slides when close', () => run(`
  couch(-.35,1.7);party={companion(1,1.0,1.5)}
  sitV();step(.6)
  -- The actuator keeps reporting its own old ticket (a blocked motor).
  for i=1,80 do
    local rows={{entry=party[1],transport=false}}
    c.tick(player,.1,rows)
    local e=party[1]
    if e.npc.entering then e.npc.entering=nil;e.npc.inside=true end
    e.motor.feedback={ticket='old',failed=true}
    c.steer(e,{combat=false,motion=e.motor.feedback})
    c.observe(e,{combat=false})
  end
  assert(count('play')==1,'slid in after the walk was never taken')
`));

// October 8 live run: the apartment couch read as a bench (backrest 0.63 over a
// 0.44 cushion) and Judy, 2.0 m from the seat, had her one walk-up point
// refused by the destination clearance check, so she gave up after 3 s.
test('apartment live run: the walk-up refused 2 m from the seat; one refusal within 2.5 m goes to the slide, after V looks away', () => run(`
  world.boxes={{x1=-1.1,x2=.3,y1=-.75,y2=-.15,h=.44},{x1=-1.1,x2=.3,y1=-.95,y2=-.75,h=.63},
    {x1=-2.2,x2=-1.1,y1=-.75,y2=.6,h=.58}}
  party={companion(1,-1.2,1.85)}
  watching=true
  seat.inside,seat.psm=true,0;step(.6);seat.psm=1;step(1.5,{walk=false,refuse=true})
  assert(lastLog('seat-classified').fields.kind=='couch','couch, not bench')
  step(2.5,{walk=false,refuse=true})
  local walks=0;for _,l in ipairs(logs) do if l.kind=='seat-walk' then walks=walks+1 end end
  assert(walks==1,'no stop-start retries within 2.5 m: '..walks)
  assert(count('play')==0,'no glide while V looks at her')
  assert(count('lookingAt')>0)
  assert(lastLog('seat-walk-refused'),'refusals logged')
  watching=false;step(1.5,{walk=false,refuse=true})
  assert(count('play')==1 and last('play').component=='convai_sit_couch','slid in once V looked away')
  assert(last('play').slide>.8 and last('play').slide<=1.4,'long slide '..last('play').slide)
`));

test('a long slide never waits more than blendWait for V to look away', () => run(`
  couch(-.35,1.7);party={companion(1,2.2,1.6)};watching=true
  sitV();step(.6);step(9,{walk=false,refuse=true})
  assert(count('play')==1,'slid after the wait even while watched')
`));

// October 8 live run 20:24Z: after the fast exit her root stayed on the seat
// root against the couch and every follow route was refused (Static, 'path').
test('standing up: she steps out to the spot she arrived from, on clear floor, before following resumes', () => run(`
  couch(-.35,1.7);party={companion(1,1.5,1.5)}
  sitV();step(2)
  assert(held[1]==true)
  local seatX=party[1].position.x
  assert(math.abs(party[1].position.y)<.01,'root on the seat root while seated')
  seat.inside=false;step(.3)
  assert(count('exit')==1 and count('stepOut')==0,'no step during the stand-up clip')
  step(1.5)
  local out=last('stepOut');assert(out,'steps out after the exit')
  assert(out.y>.5,'to floor in front of the couch, not the seat root: '..out.y)
  step(.3)
  local stood=lastLog('seat-stood');assert(stood and stood.fields.from=='arrival','her own arrival spot')
  assert(held[1]==false and decisions[1]==nil,'following resumes after the step')
  assert(party[1].position.y>.5)
`));

test('a step out that does not move her ends in a teleport to the checked spot', () => run(`
  couch(-.35,1.7);party={companion(1,1.5,1.5)}
  sitV();step(2);stepStuck=true
  seat.inside=false;step(3)
  assert(held[1]==true and count('teleport')==0,'still stepping')
  step(1.5)
  assert(count('teleport')==1,'teleport after the deadline')
  local t=last('teleport');assert(t.y>.5 and math.abs(t.yaw)<1,'in front, facing forward')
  step(1.2)
  assert(lastLog('seat-stood').fields.teleported==true and held[1]==false)
`));

test('a stand spot without room is skipped for the next checked floor spot', () => run(`
  couch(-.35,1.7);party={companion(1,1.5,1.5)}
  sitV();step(2)
  local arrival=lastLog('seat-walk').fields.goal
  world.noRoom={{x=party[1].position.x+0,y=.75},{x=arrival.x,y=arrival.y}}
  seat.inside=false;step(2.2)
  local rejected=lastLog('seat-stand-rejected');assert(rejected and rejected.fields.reason=='no room')
  assert(lastLog('seat-stood'),'stood elsewhere')
`));

test('three companions on a two-seat couch: two sit on their own seats, the third stands; both seated ones exit and step out cleanly', () => run(`
  couch(-.9,1.0)
  party={companion(1,1.4,1.3),companion(2,-1.4,1.3),companion(3,.2,2.2)}
  sitV();step(3)
  local spawns={}
  for _,call in ipairs(calls) do if call.name=='spawn' then spawns[#spawns+1]=call.x end end
  assert(#spawns==2 and math.abs(spawns[1]+spawns[2])<.01 and math.abs(spawns[1])>.6,'one seat each side of V')
  local seated=0;for i=1,3 do if held[i] then seated=seated+1 end end
  assert(seated==2,'two seated: '..seated)
  local none=0;for _,l in ipairs(logs) do if l.kind=='seat-none' then none=none+1 end end
  assert(none>=1,'the third has no seat and keeps standing')
  seat.inside=false;step(2.5)
  assert(count('exit')==2,'both stand up')
  local outs={};for _,call in ipairs(calls) do if call.name=='stepOut' then outs[#outs+1]=call end end
  assert(#outs==2 and math.abs(outs[1].x-outs[2].x)>.5,'each to her own spot')
  local stood=0;for _,l in ipairs(logs) do if l.kind=='seat-stood' then stood=stood+1 end end
  assert(stood==2 and not held[1] and not held[2] and not held[3],'all follow again')
`));

// October 8 20:33Z: four walk-up points refused ("No clear local walking
// route") before the fifth worked: a stop and a new walk each time.
test('walk-up points are pre-checked before she moves: she starts on one that has room, with no refusals', () => run(`
  couch(-.35,1.7)
  world.boxes[#world.boxes+1]={x1=-.2,x2=1.3,y1=.55,y2=.95,h=.45} -- a coffee table in front
  party={companion(1,2.6,1.6)}
  sitV();step(2.5)
  local checked=lastLog('seat-walk-checked');assert(checked and checked.fields.good>=1 and checked.fields.rejected>=1,'some points rejected before walking')
  local walk=lastLog('seat-walk');assert(walk.fields.try==1,'first walk is the one taken')
  local g=walk.fields.goal
  assert(not (g.x>=-.5 and g.x<=1.6 and g.y>=.25 and g.y<=1.25),'not beside the table')
  assert(not lastLog('seat-walk-refused') and count('play')==1,'no refusal, she sits')
  assert(count('navPoint')>0 and count('bodyClear')>0)
`));

test('a refused walk far from the seat switches straight to the next walk-up point, with no hold in between', () => run(`
  couch(-.35,1.7);party={companion(1,3.4,2.8)}
  sitV();step(1.5,{observe=false})
  local e=party[1]
  local refusedTicket,next
  for i=1,40 do
    c.tick(player,.1,{{entry=e,transport=false}})
    local d=c.steer(e,{combat=false,motion=e.motor.feedback})
    if d and d.operation then
      if not refusedTicket and d.operation.kind=='move' then refusedTicket=d.operation.ticket end
      if refusedTicket and d.operation.ticket~=refusedTicket then next=d.operation; break end
      e.motor.ticket,e.motor.kind=d.operation.ticket,d.operation.kind
      e.motor.feedback={ticket=d.operation.ticket,failed=d.operation.ticket==refusedTicket}
    end
    c.observe(e,{combat=false})
  end
  assert(next and next.kind=='move','the next walk-up goal follows the refusal directly: '..tostring(next and next.kind))
`));

// October 8 20:47Z regression: 3.94 m out, the pre-check left 1 good point and
// 9 'no room', the movement code refused the one walk and she gave up.
test('replay 20:47Z: 3.9 m out, 1 good / 9 no room, every walk refused: fallbacks, then she follows in and slides, and sits', () => run(`
  world.boxes={{x1=-1.1,x2=.3,y1=-.75,y2=-.15,h=.44},{x1=-1.1,x2=.3,y1=-.95,y2=-.75,h=.63},
    {x1=-2.2,x2=-1.1,y1=-.75,y2=.6,h=.58}}
  local granted=false
  world.roomFilter=function(spot) if granted then return false end; granted=true; return true end
  world.noLine=true -- live: straight=false
  party={companion(1,1.34,3.4)}
  local seatRoot={x=-.66,y=0}
  local d0=math.sqrt((1.34+.66)^2+3.4^2);assert(math.abs(d0-3.94)<.01)
  seat.inside,seat.psm=true,0;step(.6);seat.psm=1
  -- Live: she stood still while the walks were refused.
  step(5,{walk=false,refuse=true})
  local checked=lastLog('seat-walk-checked')
  assert(checked and checked.fields.good>=3 and checked.fields.fallbacks>=2,'rejected-for-room points kept as fallbacks: good='..tostring(checked and checked.fields.good))
  local walks=0;for _,l in ipairs(logs) do if l.kind=='seat-walk' then walks=walks+1 end end
  assert(walks>=2,'the fallback walk-ups were tried too: '..walks)
  assert(not lastLog('seat-abandoned'),'never gave up')
  assert(lastLog('seat-closing'),'out of walk-ups 3.9 m out: close in by following V')
  -- Her normal following brings her toward V.
  step(8,{walk=false,refuse=true,follow={x=.4,y=1.6}})
  world.roomFilter=nil
  assert(count('play')==1 and held[1]==true,'seated in the end')
  assert(not lastLog('seat-abandoned'))
`));

test('closing in that makes no progress places her out of view; with V seated she never gives up', () => run(`
  couch(-.35,1.7);party={companion(1,3.8,3.8)};watching=true
  sitV();step(1.5,{walk=false,refuse=true})
  step(8,{walk=false,refuse=true})
  assert(lastLog('seat-closing') and lastLog('seat-placing'),'stall goes to placement')
  step(20,{walk=false,refuse=true})
  assert(not lastLog('seat-abandoned') and count('play')==0 and count('teleport')==0,'4.9 m out and watched: keeps waiting, no slide, no give-up')
  assert(count('hiddenFrom')<=2*33+4,'the look check runs at 2 Hz at most: '..count('hiddenFrom'))
`));

// October 8 20:54Z: IsActorInWorkspot went false as the exit started; the step
// walked her during the stand-up clip, her shins twisted at the next turn, and
// following was refused from the spot she reached.
test('stand-up: no step while the workspot is still busy; the step waits for full release', () => run(`
  couch(-.35,1.7);party={companion(1,1.5,1.5)};busyFor=2.5
  sitV();step(2)
  seat.inside=false;step(2)
  assert(count('stepOut')==0 and held[1]==true,'still standing up: no step, body held')
  step(1.2)
  assert(count('stepOut')==1,'steps once the workspot is released')
  local left=lastLog('seat-left');assert(left and left.fields.quiet==true and left.fields.after>=2.5)
  step(.5);assert(lastLog('seat-stood') and held[1]==false)
`));

test('stand-up: the most open checked spot wins over an enclosed arrival spot', () => run(`
  couch(-.35,1.7);party={companion(1,1.5,1.5)}
  sitV();step(2)
  local arrival=lastLog('seat-walk').fields.goal
  world.enclosed={{x=arrival.x,y=arrival.y}}
  seat.inside=false;step(2.2)
  local out=lastLog('seat-step-out');assert(out and out.fields.open==4 and out.fields.from~='arrival','open spot: '..tostring(out and out.fields.from))
  assert(lastLog('seat-stood'))
`));

test('a fight stands her up and out of the seat at once', () => run(`
  couch(-.35,1.7);party={companion(1,1.5,1.5)}
  sitV();step(2)
  combat=true;step(.6)
  assert(count('exit')==1 and last('exit').instant and count('stepOut')==1,'out within half a second')
`));

// October 8 21:02Z: 4.37 m out, walk tries 1-3 refused, closing in (from
// 21:02:35) made no progress in the dead zone, seat-abandoned at 21:02:47.
test('replay 21:02Z: 4.37 m, three refusals, no progress closing in; placed once V looks away, then seated', () => run(`
  world.boxes={{x1=-1.1,x2=.3,y1=-.75,y2=-.15,h=.44},{x1=-1.1,x2=.3,y1=-.95,y2=-.75,h=.63},
    {x1=-2.2,x2=-1.1,y1=-.75,y2=.6,h=.58}}
  party={companion(1,1.82,3.6)}
  local d0=math.sqrt((1.82+.66)^2+3.6^2);assert(math.abs(d0-4.37)<.05,d0)
  watching=true
  seat.inside,seat.psm=true,0;step(.6);seat.psm=1
  step(9,{walk=false,refuse=true})
  local refused=0;for _,l in ipairs(logs) do if l.kind=='seat-walk-refused' then refused=refused+1 end end
  assert(refused>=1 and lastLog('seat-closing') and lastLog('seat-placing'),'refusals, closing, then placement')
  assert(count('teleport')==0,'not while V looks')
  watching=false;cameraDir={x=-1,y=0};step(3,{walk=false,refuse=true})
  local placed=lastLog('seat-placed');assert(placed,'placed once out of view')
  local t=last('teleport');assert(t and math.sqrt((t.x+.66)^2+t.y^2)<1.5,'on a walk-up point by the seat')
  step(2.5,{walk=false,refuse=true})
  assert(count('play')==1 and held[1]==true and last('play').component=='convai_sit_couch','seated')
  assert(not lastLog('seat-abandoned'))
`));

test('placement waited 10 s while V looked: the short slide from within 3 m', () => run(`
  couch(-.35,1.7);party={companion(1,1.9,2.3)};watching=true
  sitV();step(1.5,{walk=false,refuse=true})
  step(18,{walk=false,refuse=true})
  assert(count('teleport')==0 and count('play')==1 and lastLog('seat-placing-slide'),'slid after the long wait')
`));

// October 8 21:09Z: V seated looking forward, Judy 4.3 m away to the side; the
// walk-up spots are beside V, in V's view, so placement never happened.
test('replay 21:09Z: V looks ahead, Judy 4.3 m to the side, walk-up spots near V: placed within seconds while she is out of view', () => run(`
  world.boxes={{x1=-1.1,x2=.3,y1=-.75,y2=-.15,h=.44},{x1=-1.1,x2=.3,y1=-.95,y2=-.75,h=.63},
    {x1=-2.2,x2=-1.1,y1=-.75,y2=.6,h=.58}}
  party={companion(1,3.4,-.5)}
  local d0=math.sqrt((3.4+.66)^2+.5^2);assert(d0>4.0 and d0<4.5,d0)
  seat.inside,seat.psm=true,0;step(.6);seat.psm=1
  step(8,{walk=false,refuse=true})
  assert(lastLog('seat-placing'),'placement starts after closing in stalls')
  local startAt=#logs
  step(4.5,{walk=false,refuse=true})
  local placed=lastLog('seat-placed');assert(placed,'placed within a few seconds while she is out of view')
  step(2.5,{walk=false,refuse=true})
  assert(count('play')==1 and held[1]==true,'seated')
`));

test('placement never happens while V looks at her, and prefers a spot V cannot see', () => run(`
  couch(-.35,1.7);party={companion(1,-3.4,2.6)}
  cameraDir={x=-.8,y=.6}
  sitV();step(12,{walk=false,refuse=true})
  assert(count('teleport')==0,'she is in view (straight ahead of the camera): no placement')
  cameraDir={x=.6,y=-.8}
  step(1,{walk=false,refuse=true})
  local placed=lastLog('seat-placed');assert(placed and placed.fields.spotUnseen==true,'the spot is out of view too')
`));

// October 8 21:14Z: Judy stood stuck 7.1 m from V (follow blocked since the
// CET reload), beyond the old 6 m search radius: no seat was assigned.
test('a companion 7.1 m away is seated; one beyond 8 m is logged once and keeps following', () => run(`
  couch(-.35,1.7);party={companion(1,-4.6,5.4),companion(2,6.5,5.5)}
  sitV();step(2.5)
  local assigned={};for _,l in ipairs(logs) do if l.kind=='seat-assigned' then assigned[l.fields.serial]=true end end
  assert(assigned[1] and not assigned[2],'7.1 m seated, 8.5 m not')
  local far=0;for _,l in ipairs(logs) do if l.kind=='seat-too-far' then far=far+1 end end
  assert(far==1,'logged once: '..far)
`));

test('seating owns her for recovery from the walk to the seat until she stands clear; not while closing in', () => run(`
  couch(-.35,1.7);party={companion(1,1.5,1.5)}
  assert(not c.owns(party[1]),'no session: not owned')
  sitV();step(1.3)
  local seen={}
  for i=1,40 do
    step(.1)
    local st=c.snapshot().companions[1]
    if st then seen[st.phase]=c.owns(party[1]) end
  end
  assert(seen.seated==true,'owned while seated')
  seat.inside=false
  for i=1,30 do step(.1);local st=c.snapshot().companions[1];if st then seen[st.phase]=c.owns(party[1]) end end
  assert(seen.leaving==true or seen.standing==true,'owned while standing up')
  step(1);assert(not c.owns(party[1]),'released after she stood clear')
`));

// October 9 live runs: five sessions logged "No clear local walking route" and
// nothing else, so the stage that refused (path, destination, ...) is logged now.
test('a refused seat walk logs the actuator rejection stage and where she stood', () => run(`
  couch(-.35,1.7);party={companion(1,3.5,1.5)}
  sitV();step(.6)
  for i=1,60 do
    local rows={{entry=party[1],transport=false}}
    c.tick(player,.1,rows)
    local e=party[1]
    e.motor.feedback={ticket=e.motor.ticket,failed=true,error='No clear local walking route',
      rejection={stage='destination',group='Static',boxes=1,center={x=1,y=2,z=3}}}
    c.steer(e,{combat=false,motion=e.motor.feedback})
    c.observe(e,{combat=false})
  end
  local refused=lastLog('seat-walk-refused')
  assert(refused,'refusal logged')
  assert(refused.fields.stage=='destination' and refused.fields.group=='Static' and refused.fields.boxes==1,'stage logged')
  assert(refused.fields.at and refused.fields.at.x and refused.fields.playerGap,'her position logged')
  assert(refused.fields.center==nil,'no raw geometry in the log line')
`));

test('V in a mounted workspot starts no session and says so once', () => run(`
  seat.mounted=true
  sitV('base\\\\workspots\\\\vehicles\\\\player__sit_bench__sit_around__01.workspot','sit_bench')
  step(3)
  assert(not lastLog('player-sat'),'mounted workspot never seats anyone')
  local n=0;for _,l in ipairs(logs) do if l.kind=='player-workspot-skipped' then n=n+1 end end
  assert(n==1,'logged once, not every update: '..n)
`));
