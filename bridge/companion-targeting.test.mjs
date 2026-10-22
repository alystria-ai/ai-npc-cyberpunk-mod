import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import fengari from 'fengari';
import {companionEngine} from './companion-fixture.mjs';

const {lua,lauxlib,lualib,to_luastring,to_jsstring}=fengari;
const init=readFileSync(new URL('../mod/init.lua',import.meta.url),'utf8');
const targeting=init.slice(init.indexOf('convaiEntityKey = function'),init.indexOf('local function resetGaze()'));
const fixture=`${companionEngine}
  assert(companions.registerDefinition('johnny-silverhand',
    {id='Character.JohnnyCompanion',name='Johnny Silverhand',profileKey='johnny-silverhand'}))
  local johnny=spawn('johnny-silverhand')
  function johnny:IsNPC() return true end
  johnny.pos=Vector4.new(1.31,0,0)
  johnny.head=Vector4.new(1.31,0,1.7)
  function johnny:GetSlotComponent() return {GetSlotTransform=function(_,slot,...)
    assert(slot=='Head' and select('#',...)==0,'CET returns the out transform')
    return johnny.head~=nil,johnny.head and {position=johnny.head}
  end} end
  WorldTransform={GetWorldPosition=function(t) return t.position end}
  WorldPosition.ToVector4=function(p) return p end
  local mount={parentId={hash='0ULL'}}
  Game.GetMountingFacility=function() return {GetMountingInfoSingleWithObjects=function(_,npc)
    assert(npc==johnny); return mount
  end} end
  local rays,blocked,answer=0,nil,false
  Game.GetSpatialQueriesSystem=function() return {SyncRaycastByCollisionGroup=function(_,from,to,group,...)
    assert(select('#',...)==2,'CET out trace must be returned, not supplied')
    local staticOnly,dynamicOnly=...
    assert(staticOnly==false and dynamicOnly==false)
    assert(from.w==1 and to.w==1)
    rays=rays+1
    if group==blocked then return true,{position=Vector4.new(.5,0,1.3)} end
    return answer,nil
  end} end
  local origin,forward=Vector4.new(0,0,1.3),Vector4.new(1,0,0,0)
  local parts,nearest,looked={}
  TargetSearchQuery={new=function()return {}end}
  TS_TargetPartInfo={GetComponent=function(part)return {GetEntity=function()return part.entity end}end}
  Game['TSF_NPC;']=function()return {}end
  Game.GetTargetingSystem=function()return {
    GetTargetParts=function()return true,parts end,GetObjectClosestToCrosshair=function()return nearest end,
    GetLookAtObject=function()return looked end,GetCrosshairData=function()return origin,forward end}
  end
  companions.beginSpatialFrame()
  ${targeting}
`;
function run(body) {
  const state=lauxlib.luaL_newstate(); lualib.luaL_openlibs(state);
  const status=lauxlib.luaL_dostring(state,to_luastring(fixture+body));
  const error=status===lua.LUA_OK?'':to_jsstring(lua.lua_tostring(state,-1));
  lua.lua_close(state); assert.equal(status,lua.LUA_OK,error);
}

test('omitted managed Johnny can be addressed using the accepted standing torso point',()=>run(`
  johnny.head=nil
  assert(targetAtCrosshair()==johnny,'Native target-parts omission made a nearby managed Johnny untalkable')
  assert(rays>0 and companions.spatialQueryUsage().used==rays)
`));
test('the captured live Johnny and camera coordinates remain addressable without native target parts',()=>run(`
  johnny.pos=Vector4.new(-1661.27734,-484.35278,9.27640)
  johnny.head=Vector4.new(-1661.2959,-484.3494,10.65665)
  origin=Vector4.new(-1660.06104,-484.01816,10.61004)
  forward=Vector4.new(-.96586,-.07108,-.24911,0)
  assert(targetAtCrosshair()==johnny and rays>0)
`));
test('unavailable or malformed Head geometry keeps verified standing torso aim usable',()=>run(`
  johnny.head={x=1.31}
  assert(targetAtCrosshair()==johnny)
  johnny.GetSlotComponent=function()error('Head slot unavailable')end
  companions.beginSpatialFrame(); assert(targetAtCrosshair()==johnny)
`));
test('actual Head-slot geometry also accepts close face aim without weakening distance or angle bounds',()=>run(`
  johnny.pos=Vector4.new(.35,0,0); johnny.head=Vector4.new(.35,0,1.7); origin.z=1.7
  assert(targetAtCrosshair()==johnny,'Close face aim missed because the torso is below the cone')
  forward=Vector4.new(-1,0,0,0); local before=rays
  assert(targetAtCrosshair()==nil and rays==before,'A companion behind the camera acquired fallback focus')
  forward=Vector4.new(1,0,0,0); johnny.pos.x=8.01; johnny.head.x=8.01
  assert(targetAtCrosshair()==nil and rays==before,'A distant companion acquired fallback focus')
`));
test('on-foot fallback excludes unknown mounts, mounted actors and lost native ownership',()=>run(`
  mount=nil; assert(targetAtCrosshair()==nil and rays==0)
  mount={}; assert(targetAtCrosshair()==nil and rays==0)
  mount={parentId={hash='100ULL'}}; assert(targetAtCrosshair()==nil and rays==0)
  mount={parentId={hash='0ULL'}}; system.IsTagged=function()return false end
  assert(targetAtCrosshair()==nil and rays==0)
`));
test('walls and vehicles occlude fallback aim, and unavailable ray geometry is rejected',()=>run(`
  blocked='Static'; assert(targetAtCrosshair()==nil)
  companions.beginSpatialFrame(); blocked='Vehicle'; assert(targetAtCrosshair()==nil)
  companions.beginSpatialFrame(); blocked=nil; answer=nil; assert(targetAtCrosshair()==nil)
  Game.GetSpatialQueriesSystem=function()error('Geometry unavailable')end
  companions.beginSpatialFrame(); assert(targetAtCrosshair()==nil)
`));
test('fallback cannot exceed the shared frame query budget or interfere with ordinary native targets',()=>run(`
  local budget=companions.beginSpatialFrame(); budget.used=budget.limit
  assert(targetAtCrosshair()==nil and rays==0,'Fallback escaped the frame budget')
  parts={{entity=johnny}}; johnny.head=nil; blocked='Static'
  assert(targetAtCrosshair()==johnny and rays==0,'Managed fallback changed existing native standing selection')
`));
test('dead and detached copies never enter the fallback roster',()=>run(`
  johnny.IsDeadNoStatPool=function()return true end
  assert(targetAtCrosshair()==nil and rays==0)
  johnny.IsDeadNoStatPool=function()return false end
  johnny.IsAttached=function()return false end
  assert(targetAtCrosshair()==nil and rays==0)
`));
