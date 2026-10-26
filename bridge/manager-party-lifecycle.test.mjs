import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import fengari from 'fengari';
import {uiLocaleBootstrap} from './ui-locale-fixture.mjs';

const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;
const source = readFileSync(new URL('../mod/manager-party.lua', import.meta.url), 'utf8');

test('spatial budget deferral keeps a prepared invitation pending without failure or duplicate preparation', () => {
  const code = `
    local api=(function() ${source} end)()
    local members,attempts,prepares,cancels,spawned={},0,0,0,0
    local companions={definition=function()return {name='Judy',id='Character.Judy',profileKey='judy-alvarez'}end,
      list=function()return members end,spawn=function(key)
        attempts=attempts+1;if attempts<4 then return nil,nil,true end
        members[1]={serial=1,key=key,name='Judy',state='spawning'};return 1
      end,setProfile=function()return true end}
    local readiness={bind=function()return false end,status=function()return {state='ready'}end,
      prepare=function()prepares=prepares+1;return true end,
      cancel=function()cancels=cancels+1 end,spawned=function()spawned=spawned+1 end}
    local queue=api.new(companions,readiness);queue.bind('world')
    assert(queue.invite('judy-alvarez'))
    for _=1,3 do
      queue.flush();assert(queue.count()==1 and #members==0)
      assert(queue.list()[1].state=='ready-to-join' and #queue.takeNotices()==0)
    end
    queue.flush();assert(#members==1 and prepares==1 and cancels==0 and spawned==1)
    queue.flush();assert(attempts==4 and spawned==1)
  `;
  const state=lauxlib.luaL_newstate();lualib.luaL_openlibs(state);
  const status=lauxlib.luaL_dostring(state,to_luastring(uiLocaleBootstrap+code));
  const error=status===lua.LUA_OK?'':to_jsstring(lua.lua_tostring(state,-1));
  lua.lua_close(state);assert.equal(status,lua.LUA_OK,error);
});

test('death before attachment confirmation retires only that invitation and reports it once', () => {
  const code = `
    local api=(function() ${source} end)()
    local members,pending,retired={},{},{}
    local companions={definition=function() return {name='Judy',id='Character.Judy',profileKey='judy-alvarez'} end,
      list=function() return members end,
      spawn=function(key)
        local serial=#members+1;members[serial]={serial=serial,key=key,name='Judy',state='spawning'};return serial
      end,setProfile=function() return true end}
    local readiness={bind=function() return false end,status=function() return {state='ready'} end,
      prepare=function(job) pending[job.id]=true;return true end,spawned=function() end,
      cancel=function(job) pending[job.id]=nil;retired[#retired+1]=job.id end,
      finish=function() error('dead character reported as joined') end}
    local queue=api.new(companions,readiness);queue.bind('world')
    assert(queue.invite('judy-alvarez'));assert(queue.invite('judy-alvarez'));queue.flush()
    members[1].state='dead'
    for i=1,100 do queue.flush() end
    assert(pending['queued:1']==nil and pending['queued:2']==true,'another copy lost its reservation')
    assert(#retired==1 and retired[1]=='queued:1')
    assert(#members==2 and members[1].state=='dead','cleanup unexpectedly deleted a native actor')
    local notices=queue.takeNotices()
    assert(#notices==1 and notices[1].failed and notices[1].message:find('died before joining',1,true))
    queue.flush();assert(#queue.takeNotices()==0)
  `;
  const state = lauxlib.luaL_newstate(); lualib.luaL_openlibs(state);
  const status = lauxlib.luaL_dostring(state, to_luastring(uiLocaleBootstrap + code));
  const error = status === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(state, -1));
  lua.lua_close(state); assert.equal(status, lua.LUA_OK, error);
});

// Performance: flush runs four times a second; companions.list() builds a row of about seventy fields per copy, so it is asked only when a copy is
// attaching or leaving.
test('a flush with nobody attaching or leaving does not build the companion list', () => {
  const code = `
    local api=(function() ${source} end)()
    local members,reads={},0
    members[1]={serial=1,key='judy-alvarez',name='Judy',state='ready'}
    local companions={definition=function() return {name='Judy',id='Character.Judy',profileKey='judy-alvarez'} end,
      list=function() reads=reads+1;return members end,
      spawn=function(key) members[#members+1]={serial=#members+1,key=key,name='Judy',state='spawning'};return #members end,
      setProfile=function() return true end,dismiss=function() return true end}
    local readiness={bind=function() return false end,status=function() return {state='ready'} end,
      prepare=function() return true end,spawned=function() end,cancel=function() end,finish=function() end}
    local queue=api.new(companions,readiness);queue.bind('world')
    for _=1,40 do queue.flush() end
    assert(reads==0,'the list was built '..reads..' times with nothing to do')
    -- A copy that is attaching: the list is read (to see it arrive)
    assert(queue.invite('judy-alvarez'));queue.flush();queue.flush()
    local atAttach=reads
    assert(atAttach>=1,'an attaching copy was not looked at')
    members[#members].state='ready';queue.flush()
    assert(queue.takeNotices()[1].message:find('joined',1,true))
    local settled=reads
    for _=1,10 do queue.flush() end
    assert(reads==settled,'the list was built again with nothing attaching: '..(reads-settled))
    -- A copy that leaves: the list is read to find it, and the copy is dismissed
    local dismissed=0
    companions.dismiss=function(serial) dismissed=dismissed+1;return true end
    local row=queue.list()[1]
    assert(queue.dismiss(row.id))
    local before=reads
    queue.flush()
    assert(dismissed==1 and reads>before,'a leaving copy was not dismissed')
  `;
  const state = lauxlib.luaL_newstate(); lualib.luaL_openlibs(state);
  const status = lauxlib.luaL_dostring(state, to_luastring(uiLocaleBootstrap + code));
  const error = status === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(state, -1));
  lua.lua_close(state); assert.equal(status, lua.LUA_OK, error);
});
