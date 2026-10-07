import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import fengari from 'fengari';
const {lua,lauxlib,lualib,to_luastring,to_jsstring}=fengari;
const catalog=JSON.parse(readFileSync(new URL('../localization/en.json',import.meta.url),'utf8')).strings;
const codes=['zh-cn','zh-tw','es','pt-br','fr','de','it','pl','cs','hu','tr','ru','uk','ja','ko'];
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

// Glyph coverage. The game's own Latin family covers Basic Latin, Latin-1 and
// Latin Extended-A (U+0100-017F: ł ą ę ő ű ğ ş ı İ ř ů ...), and the Russian
// family covers Cyrillic (U+0400-04FF: Ukrainian ї є ґ і). A dictionary must not
// use a letter outside the range its language is rendered with.
const punctuation=/[‐-‧‰-⁞·«»°×]/u;
const latin=ch=>/[ -~ -ÿĀ-ſ]/u.test(ch);
const cyrillic=ch=>/[Ѐ-ӿ]/u.test(ch);
const coverage={
 it:{ok:latin,letters:'àèéìòù'},
 pl:{ok:latin,letters:'ąćęłńóśźż'},
 cs:{ok:latin,letters:'áčďéěíňóřšťúůýž'},
 hu:{ok:latin,letters:'áéíóöőúüű'},
 tr:{ok:latin,letters:'çğıöşü'},
 uk:{ok:cyrillic,letters:'їєі'},
 ru:{ok:cyrillic,letters:'ёыэ'},
};
for(const [code,{ok,letters}]of Object.entries(coverage))test(`${code} uses only glyphs its game font family renders`,()=>{
 const text=readFileSync(new URL(`../mod/locales/${code}.lua`,import.meta.url),'utf8');
 const stray=new Set();
 for(const ch of text)if(!/[\s]/u.test(ch)&&!ok(ch)&&!latin(ch)&&!punctuation.test(ch))stray.add(`${ch} U+${ch.codePointAt(0).toString(16)}`);
 assert.deepEqual([...stray],[],`${code} has glyphs outside its font coverage`);
 if(code==='uk'||code==='ru')for(const ch of text)if(/[Ā-ɏ]/u.test(ch))assert.fail(`${code} mixes a Latin Extended letter ${ch}`);
 const used=new Set(text);
 const missing=[...letters].filter(ch=>!used.has(ch)&&!used.has(ch.toUpperCase()));
 assert.deepEqual(missing,[],`${code} never uses its characteristic letters, so it is probably not really translated`);
});
for(const code of ['pl','cs','hu','tr','it','uk'])test(`${code} is translated, not copied from English`,()=>{
 const text=readFileSync(new URL(`../mod/locales/${code}.lua`,import.meta.url),'utf8');
 const rows=[...text.matchAll(/^\s*\["(.*)"\] = "(.*)",$/gmu)];
 assert.equal(rows.length,Object.keys(catalog).length);
 const same=rows.filter(([,k,v])=>k===v).length;
 assert(same<rows.length*0.2,`${code}: ${same} strings are still identical to English`);
});
