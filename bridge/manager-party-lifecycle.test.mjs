import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import fengari from 'fengari';
import {uiLocaleBootstrap} from './ui-locale-fixture.mjs';

const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;
const source = readFileSync(new URL('../mod/manager-party.lua', import.meta.url), 'utf8');

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
