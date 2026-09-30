import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import fengari from 'fengari';
const {lua,lauxlib,lualib,to_luastring,to_jsstring}=fengari;
const catalog=JSON.parse(readFileSync(new URL('../localization/en.json',import.meta.url),'utf8')).strings;
const codes=['zh-cn','zh-tw','es','pt-br','fr','de','ru','ja','ko'];
const tokens=text=>[...text.matchAll(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g)].map(m=>m[1]).sort();
for(const code of codes)test(`${code} executes as Lua with exact UI keys and literal parameter coverage`,()=>{
 const source=readFileSync(new URL(`../mod/locales/${code}.lua`,import.meta.url),'utf8');
 const vm=lauxlib.luaL_newstate();lualib.luaL_openlibs(vm);
 const result=lauxlib.luaL_dostring(vm,to_luastring(source));
 assert.equal(result,lua.LUA_OK,result===lua.LUA_OK?'':to_jsstring(lua.lua_tostring(vm,-1)));
 assert.equal(lua.lua_type(vm,-1),lua.LUA_TTABLE);
 const rows={};lua.lua_pushnil(vm);
 while(lua.lua_next(vm,-2)!==0){
  assert.equal(lua.lua_type(vm,-2),lua.LUA_TSTRING);assert.equal(lua.lua_type(vm,-1),lua.LUA_TSTRING);
  rows[to_jsstring(lua.lua_tostring(vm,-2))]=to_jsstring(lua.lua_tostring(vm,-1));lua.lua_pop(vm,1);
 }
 lua.lua_close(vm);
 assert.deepEqual(Object.keys(rows).sort(),Object.keys(catalog).sort());
 for(const [key,value]of Object.entries(rows)){
  assert(value.trim()&&!/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value),`${code}: ${key}`);
  assert.deepEqual(tokens(value),tokens(key),`${code}: placeholders in ${key}`);
  assert.equal((value.match(/\n/g)||[]).length,(key.match(/\n/g)||[]).length,`${code}: newlines in ${key}`);
 }
});
