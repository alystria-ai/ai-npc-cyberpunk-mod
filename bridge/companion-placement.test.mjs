import {test} from 'node:test';
import assert from 'node:assert/strict';
import fengari from 'fengari';
import {companionEngine} from './companion-fixture.mjs';

const {lua,lauxlib,lualib,to_luastring,to_jsstring}=fengari;
function run(code) {
  const state=lauxlib.luaL_newstate(); lualib.luaL_openlibs(state);
  const result=lauxlib.luaL_dostring(state,to_luastring(code));
  const error=result===lua.LUA_OK?'':to_jsstring(lua.lua_tostring(state,-1));
  lua.lua_close(state); assert.equal(result,lua.LUA_OK,error);
}

// A world model independent of candidate order and body dimensions: native
// overlap boxes intersect axis-aligned solid props with 2D separating axes.
const world=`
  local solids,queries={},{}
  local function intersects(half,p,rotation,box)
    local center={x=(box.x1+box.x2)/2,y=(box.y1+box.y2)/2,z=(box.z1+box.z2)/2}
    local hx,hy,hz=(box.x2-box.x1)/2,(box.y2-box.y1)/2,(box.z2-box.z1)/2
    if math.abs(p.z-center.z)>=half.z+hz then return false end
    local angle=math.rad(rotation.yaw or 0)
    local co,si=math.cos(angle),math.sin(angle)
    local x,y=p.x-center.x,p.y-center.y
    if math.abs(x)>=hx+math.abs(co)*half.x+math.abs(si)*half.y then return false end
    if math.abs(y)>=hy+math.abs(si)*half.x+math.abs(co)*half.y then return false end
    if math.abs(x*co+y*si)>=half.x+math.abs(co)*hx+math.abs(si)*hy then return false end
    if math.abs(-x*si+y*co)>=half.y+math.abs(si)*hx+math.abs(co)*hy then return false end
    return true
  end
  local spatial={}
  function spatial:Overlap(half,p,rotation,group)
    queries[#queries+1]={half=half,position=p,rotation=rotation,group=group}
    for _,box in ipairs(solids) do
      if box.group==group and intersects(half,p,rotation,box) then return true,nil end
    end
    return false,{position={x=123,y=456,z=789}}
  end
  Game.GetSpatialQueriesSystem=function() return spatial end
  local function blocked(point,radius,height)
    for _,box in ipairs(solids) do
      if intersects({x=radius or .4,y=radius or .4,z=(height or 2.1)/2},
        {x=point.x,y=point.y,z=point.z+(height or 2.1)/2+.1},{yaw=0},box) then return true end
    end
    return false
  end
`;

test('a parked car on valid navmesh forces a clear alternative on the same floor',()=>run(`${companionEngine}
  ${world}
  solids={{group='Vehicle',x1=.5,x2=3,y1=-1.3,y2=1.3,z1=0,z2=2}}
  local id,reason=companions.spawn('judy-alvarez')
  assert(id,reason)
  assert(not blocked(entities[1].pos),'the navmesh spawn overlaps the parked car')
  assert(math.abs(entities[1].pos.z-.1)<.001,'alternative changed floor')
`));

test('a fully blocked floor refuses creation with a bounded search',()=>run(`${companionEngine}
  ${world}
  solids={{group='Static',x1=-20,x2=20,y1=-20,y2=20,z1=.2,z2=3}}
  local id,reason=companions.spawn('judy-alvarez')
  assert(not id and sequence==0,'created a companion inside solid geometry')
  assert(reason and reason:find('clear'),'missing useful clearance feedback')
  assert(#queries>0 and #queries<=200,'unbounded or missing body query')
`));

for (const group of ['Static','Dynamic','Vehicle','Terrain','Collider','Destructible']) {
  test(`body clearance rejects ${group} at feet and head height despite an open navmesh`,()=>run(`${companionEngine}
    ${world}
    local clearance=dofile('companion-clearance.lua')
    for _,z in ipairs({.15,1.9}) do
      solids={{group='${group}',x1=1.85,x2=2.2,y1=-.1,y2=.1,z1=z,z2=z+.15}}
      -- The center point is outside this thin object, but the right shoulder
      -- or foot volume intersects it. A point or center ray cannot catch it.
      local clear,reason=clearance.body(Vector4.new(1.5,0,0))
      assert(not clear and reason:find('blocking'),'missed the edge of the body')
    end
  `));
}

test('overlap uses world feet plus half height, zero W and the boolean hit contract',()=>run(`${companionEngine}
  ${world}
  local clearance=dofile('companion-clearance.lua')
  assert(clearance.body(Vector4.new(10,20,30),{radius=.7,height=2.6}))
  assert(#queries==6)
  local q=queries[1]
  assert(q.half.x==.7 and q.half.y==.7 and q.half.z==1.3 and q.half.w==0)
  assert(q.position.x==10 and q.position.y==20 and math.abs(q.position.z-31.4)<.001)
  assert(q.rotation.roll==0 and q.rotation.pitch==0 and q.rotation.yaw==0)
  -- Actual native receipt: even successful hits may expose infinity position
  -- and normal fields. Collision classification only uses the native Boolean.
  spatial.Overlap=function() return true,{position={x=math.huge,y=math.huge,z=math.huge}} end
  assert(not clearance.body(Vector4.new(0,0,0)))
  spatial.Overlap=function() return false,{position={x=math.huge,y=math.huge,z=math.huge}} end
  assert(clearance.body(Vector4.new(0,0,0)))
`));

for (const answer of ['return nil','return {}','return "false"','error("unavailable")']) {
  test(`unverified spatial response (${answer}) cannot create a copy`,()=>run(`${companionEngine}
    Game.GetSpatialQueriesSystem=function() return {Overlap=function() ${answer} end} end
    local id,reason=companions.spawn('judy-alvarez')
    assert(not id and sequence==0 and reason:find('could not verify'))
  `));
}

test('an unavailable spatial system refuses safely without creating an actor',()=>run(`${companionEngine}
  Game.GetSpatialQueriesSystem=function() return nil end
  local id,reason=companions.spawn('judy-alvarez')
  assert(not id and reason:find('could not verify') and sequence==0)
`));

test('a car arriving during attachment removes the copy before follower ownership',()=>run(`${companionEngine}
  ${world}
  assert(companions.spawn('judy-alvarez'))
  local npc=entities[1]; local at=npc.pos
  solids={{group='Vehicle',x1=at.x-.8,x2=at.x+.8,y1=at.y-1,y2=at.y+1,z1=0,z2=2}}
  companions.update(player,.5)
  assert(entities[1]==nil and companions.list()[1].state=='failed')
  assert(npc.ai.role.kind~='AIFollowerRole','blocked copy acquired follower control')
`));

test('an engine shift into a prop within the old two metre tolerance is rejected',()=>run(`${companionEngine}
  ${world}
  assert(companions.spawn('judy-alvarez'))
  local npc=entities[1]
  npc.pos=Vector4.new(npc.pos.x+1.1,npc.pos.y,npc.pos.z)
  solids={{group='Static',x1=npc.pos.x-.2,x2=npc.pos.x+.2,y1=-.3,y2=.3,z1=.3,z2=1.7}}
  companions.update(player,.5)
  assert(entities[1]==nil and companions.list()[1].state=='failed')
`));

test('a fresh copy is created on the floor when a ray finds it 30 cm under the navmesh point',()=>run(`${companionEngine}
  local rays,navZ=0,nil
  Game.GetSpatialQueriesSystem=function() return {Overlap=function() return false,{} end,
    SyncRaycastByCollisionGroup=function(_,from,to,group)
      rays=rays+1
      assert(group=='Static' and from.z>to.z and from.x==to.x,'one Static ray straight down')
      navZ=navZ or from.z-.6
      return true,{position=Vector4.new(from.x,from.y,from.z-.6-.3,1)}
    end} end
  assert(companions.spawn('judy-alvarez'))
  local npc=entities[1]
  assert(navZ and math.abs(npc.spec.position.z-(navZ-.3))<1e-6,'created 30 cm below the navmesh point, on the floor: '..tostring(npc.spec.position.z))
`));

test('a fresh copy is created on the floor when the navmesh stands 30 cm over it (the spot is the navmesh point plus 10 cm)',()=>run(`${companionEngine}
  local navZ
  Game.GetSpatialQueriesSystem=function() return {Overlap=function() return false,{} end,
    SyncRaycastByCollisionGroup=function(_,from,to,group)
      navZ=navZ or from.z-.6
      return true,{position=Vector4.new(from.x,from.y,from.z-.6-.4,1)}
    end} end
  assert(companions.spawn('judy-alvarez'))
  assert(math.abs(entities[1].spec.position.z-(navZ-.4))<1e-6,'created 40 cm under the spot, on the floor: '..tostring(entities[1].spec.position.z))
`));

test('a floor more than 45 cm under the spot is not the floor: the copy is created at the spot',()=>run(`${companionEngine}
  local spotZ
  Game.GetSpatialQueriesSystem=function() return {Overlap=function() return false,{} end,
    SyncRaycastByCollisionGroup=function(_,from)
      spotZ=spotZ or from.z-.6
      return true,{position=Vector4.new(from.x,from.y,from.z-.6-.5,1)}
    end} end
  assert(companions.spawn('judy-alvarez'))
  assert(math.abs(entities[1].spec.position.z-spotZ)<1e-6,'left at the spot: '..tostring(entities[1].spec.position.z))
`));

test('a copy the engine puts back on the navmesh is lowered by an owned AI teleport, held for it, and re-checked once',()=>run(`${companionEngine}
  assert(companions.spawn('judy-alvarez'))
  local npc=entities[1]
  local floor=npc.pos.z
  npc.pos=Vector4.new(npc.pos.x,npc.pos.y,floor+.3)
  local rays,teleports,facility=0,{},0
  Game.GetSpatialQueriesSystem=function() return {Overlap=function() return false,{} end,
    SyncRaycastByCollisionGroup=function(_,from,to,group)
      rays=rays+1
      assert(group=='Static' and from.z>to.z and from.x==to.x,'one Static ray straight down')
      return true,{position=Vector4.new(from.x,from.y,floor,1)}
    end} end
  Game.GetTeleportationFacility=function() return {Teleport=function() facility=facility+1 end} end
  npc.ai.onSend=function(cmd)
    if cmd.kind=='AITeleportCommand' then teleports[#teleports+1]=cmd.position; npc.pos=cmd.position; cmd.state='Success' end
  end
  companions.update(player,.5)
  assert(companions.list()[1].state=='ready','still attached')
  assert(#teleports==0,'nothing inside attachFollower: the AI setup that follows would undo it')
  companions.update(player,.5)
  assert(#teleports==1 and math.abs(teleports[1].z-floor)<1e-6,'lowered by an AI teleport after attach: '..#teleports)
  assert(facility==0,'never a transform teleport: the AI undoes it')
  -- the engine puts her back on the navmesh once: a second lowering, then it stops
  npc.pos=Vector4.new(npc.pos.x,npc.pos.y,floor+.3)
  companions.update(player,.5); companions.update(player,.5); companions.update(player,.5)
  assert(#teleports==2,'one re-check lowers her again: '..#teleports)
  npc.pos=Vector4.new(npc.pos.x,npc.pos.y,floor+.3)
  for i=1,8 do companions.update(player,.5) end
  assert(#teleports==2 and companions.list()[1].loweredBy~=nil,'at most two lowerings: '..#teleports)
`));

test('a copy that holds on the floor after the first lowering is not touched again',()=>run(`${companionEngine}
  assert(companions.spawn('judy-alvarez'))
  local npc=entities[1]
  local floor=npc.pos.z
  npc.pos=Vector4.new(npc.pos.x,npc.pos.y,floor+.3)
  local rays,moves=0,0
  Game.GetSpatialQueriesSystem=function() return {Overlap=function() return false,{} end,
    SyncRaycastByCollisionGroup=function(_,from)
      rays=rays+1
      return true,{position=Vector4.new(from.x,from.y,floor,1)}
    end} end
  npc.ai.onSend=function(cmd)
    if cmd.kind=='AITeleportCommand' then moves=moves+1; npc.pos=cmd.position; cmd.state='Success' end
  end
  for i=1,10 do companions.update(player,.5) end
  assert(moves==1,'one lowering: '..moves)
`));

test('a fresh copy already on the floor, or with no floor found, is left where it is',()=>run(`${companionEngine}
  assert(companions.spawn('judy-alvarez'))
  local npc=entities[1]
  local floor=npc.pos.z
  local moves=0
  Game.GetTeleportationFacility=function() return {Teleport=function() moves=moves+1 end} end
  Game.GetSpatialQueriesSystem=function() return {Overlap=function() return false,{} end,
    SyncRaycastByCollisionGroup=function(_,from) return true,{position=Vector4.new(from.x,from.y,floor-.01,1)} end} end
  companions.update(player,.5)
  assert(companions.list()[1].state=='ready' and moves==0,'1 cm is not a float')
`));

test('an engine shift into empty air inside the old height tolerance still requires nearby ground',()=>run(`${companionEngine}
  assert(companions.spawn('judy-alvarez'))
  local npc=entities[1]
  npc.pos=Vector4.new(npc.pos.x,npc.pos.y,.85)
  local nav=Game.GetAINavigationSystem()
  nav.FindPointInSphereForCharacter=function(_,p) return {status='OK',point=Vector4.new(p.x,p.y,0)} end
  Game.GetAINavigationSystem=function() return nav end
  companions.update(player,.5)
  assert(entities[1]==nil and companions.list()[1].error:find('verified ground'))
`));

test('pending copies reserve body footprints and displaced attachments cannot overlap companions',()=>run(`${companionEngine}
  assert(companions.spawn('judy-alvarez'))
  assert(companions.spawn('panam-palmer'))
  assert(companions.spawn('judy-alvarez'))
  local first,third=entities[1],entities[3]
  assert(dofile('companion-space.lua').ground(first.pos,third.pos)>=.9)
  third.pos=Vector4.new(first.pos.x+.3,first.pos.y,first.pos.z)
  companions.update(player,.5)
  assert(entities[3]==nil and companions.list()[3].state=='failed')
`));

test('large and unrecognized models reserve larger bodies independently of assigned conversation',()=>run(`${companionEngine}
  ${world}
  local clearance=dofile('companion-clearance.lua')
  for _,definition in ipairs({
    {id='Character.Smasher',profileKey='adam-smasher'},
    {id='Character.fixture_smasher_variant',profileKey='fixture-profile'},
    {recordID='fixture-unrecognized-model'},
  }) do
    local shape=clearance.profile(definition)
    assert(shape.radius==.9 and shape.height==3)
  end
  companions.registerDefinition('large',{id='Character.Smasher',name='Adam Smasher',profileKey='adam-smasher'})
  assert(companions.spawn('large',{profileKey='judy-alvarez'}))
  local large=entities[1]
  assert(queries[1].half.x==.9 and queries[1].half.z==1.5)
  assert(companions.spawn('judy-alvarez'))
  assert(dofile('companion-space.lua').ground(large.pos,entities[2].pos)>=1.4)
  assert(not large.spec.persistState and not large.spec.persistSpawn)
`));

test('larger model cannot fit under a low ceiling that admits a humanoid',()=>run(`${companionEngine}
  ${world}
  solids={{group='Static',x1=-10,x2=10,y1=-10,y2=10,z1=2.4,z2=2.8}}
  assert(companions.spawn('judy-alvarez'))
  companions.registerDefinition('large',{id='Character.Smasher',profileKey='adam-smasher'})
  local id,reason=companions.spawn('large')
  assert(not id and sequence==1 and reason:find('clear'))
`));

test('broader alternatives retain floor and route checks rather than snapping to a lower road',()=>run(`${companionEngine}
  ${world}
  local placement=dofile('companion-placement.lua')
  local nav=Game.GetAINavigationSystem()
  local original=nav.FindPointInSphereForCharacter
  nav.FindPointInSphereForCharacter=function(self,p,radius,owner)
    if radius==.7 then return original(self,p) end
    return {status='OK',point=Vector4.new(p.x,p.y,p.z-3)}
  end
  Game.GetAINavigationSystem=function() return nav end
  local destination,reason=placement.find(player,Vector4.new(1.5,0,0),{})
  assert(not destination and reason:find('this floor'))
`));

test('vehicle recovery uses the same body clearance and retains large profile reservations',()=>run(`${companionEngine}
  ${world}
  local teleports=0
  Game.GetTeleportationFacility=function() return {Teleport=function() teleports=teleports+1 end} end
  local native=dofile('companion-vehicle-native.lua')
  local npc=spawn(); local entry={npc=npc,slot=1,clearance={radius=.9,height=3}}
  solids={{group='Vehicle',x1=-20,x2=20,y1=-20,y2=20,z1=.2,z2=2}}
  local occupied={}
  local done,reason=native.recover(entry,player,occupied)
  assert(not done and reason:find('clear') and teleports==0 and #occupied==0)
  solids={}
  assert(native.recover(entry,player,occupied))
  assert(teleports==1 and occupied[1].clearance.radius==.9)
`));

test('a body-sized pocket with no walkable exit toward V is not a spawn point',()=>run(`${companionEngine}
  ${world}
  local placement=dofile('companion-placement.lua')
  local clearance=dofile('companion-clearance.lua')
  player.pos=Vector4.new(0,0,0)
  -- Recorded Blue Moon pocket: the standing box is clear, but a counter-height
  -- solid sits just beyond it on the native route back toward V.
  solids={{group='Static',x1=1.2,x2=1.5,y1=-1,y2=1,z1=.6,z2=2}}
  assert(clearance.body(Vector4.new(2,0,0)),'fixture pocket must fit a standing body')
  local spot,reason=placement.find(player,Vector4.new(2,0,0),{})
  assert(spot,reason)
  assert(math.abs(spot.x-2)>.05 or math.abs(spot.y)>.05,'accepted the pocket V cannot be followed out of')
  local feet=Vector4.new(spot.x,spot.y,spot.z-.1)
  local length=math.sqrt(feet.x^2+feet.y^2)
  local exit=Vector4.new(feet.x-feet.x/length*1.5,feet.y-feet.y/length*1.5,0)
  assert(clearance.segment(feet,exit),'chosen spot has no clear first step toward V')
  solids={}
  spot=placement.find(player,Vector4.new(2,0,0),{})
  assert(spot and math.abs(spot.x-2)<.001 and math.abs(spot.y)<.001,'open ground no longer uses the preferred spot')
`));
