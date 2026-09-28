import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import fengari from 'fengari';
const {lua,lauxlib,lualib,to_luastring,to_jsstring}=fengari;
test('named identities take priority over rig and crowd classification',()=>{
  const source=readFileSync(new URL('../mod/character-catalog.lua',import.meta.url),'utf8');
  const state=lauxlib.luaL_newstate();lualib.luaL_openlibs(state);
  const code=`local api=(function() ${source} end)()
    local catalog=api.build({
      {key='alex',name='Alex',aliases={'Alena Xenakis'},records={'Character.alex'}},
      {key='8ug8ear',name='8ug8ear'},
      {key='resident-female',name='Night City Resident Female'}
    })
    assert(api.resolve(catalog,{managedKey='8ug8ear',name='Unknown',bodyType='WomanAverage',crowd=true})=='8ug8ear')
    assert(api.resolve(catalog,{name=' ALENA XENAKIS ',bodyType='WomanAverage'})=='alex')
    assert(api.resolve(catalog,{name='Localized Name',record='Character.alex',bodyType='WomanAverage'})=='alex')
    assert(api.resolve(catalog,{name='Unknown Quest NPC',bodyType='WomanAverage',crowd=false})==nil)
    assert(api.resolve(catalog,{name='NC Resident',bodyType='WomanAverage',crowd=true})=='resident-female')
    assert(api.resolve(catalog,{managedKey='not-provisioned',name='Unknown',crowd=true})=='not-provisioned')
  `;
  const result=lauxlib.luaL_dostring(state,to_luastring(code));
  const error=result===lua.LUA_OK?'':to_jsstring(lua.lua_tostring(state,-1));
  lua.lua_close(state);assert.equal(result,lua.LUA_OK,error);
});
