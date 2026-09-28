import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import fengari from 'fengari';
import {groupContext, parseGroup, conversationScope} from './group-context.mjs';
const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;
const source = readFileSync(new URL('../mod/group-chat.lua', import.meta.url), 'utf8');
function check(body) {
  const state = lauxlib.luaL_newstate(); lualib.luaL_openlibs(state);
  const setup = `local group = (function() ${source} end)()
    local function p(key,id) return {profileKey=key, entity=id..'ULL', name=key, bodyType='test', npc=id} end
    local judy, panam, alex = p('judy',1), p('panam',2), p('alex',3)
    local live = {['1ULL']=true,['2ULL']=true,['3ULL']=true}`;
  const result = lauxlib.luaL_dostring(state, to_luastring(setup + '\n' + body));
  const error = result === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(state, -1));
  lua.lua_close(state); assert.equal(result, lua.LUA_OK, error);
}
test('addressed speaker first, duplicate copies count once, maximum three supported identities', () => check(`
  local chosen = group.choose(alex,{judy,p('judy',4),panam,p('unknown',5)},{judy=true,panam=true,alex=true})
  assert(#chosen==3 and chosen[1]==alex and chosen[2]==judy and chosen[3]==panam)
`));
test('an unconfigured addressed companion is never replaced by a different speaker', () => check(`
  local chosen, reason = group.choose(p('8ug8ear',4),{alex},{alex=true})
  assert(#chosen==0 and reason=='unsupported-primary')
  local nearby = group.choose(nil,{alex},{alex=true})
  assert(#nearby==1 and nearby[1]==alex)
`));
test('next speaker cannot start before playback completes; duplicate completions are harmless', () => check(`
  group.start('round',{judy,panam,alex},'Hello friends')
  local first = group.next(1,100,live)
  assert(first.profileKey=='judy' and first.group.index==1)
  assert(group.next(2,100,live)==nil)
  assert(group.received(first.requestId,'Hello V',false,{'judy','panam'}))
  assert(group.next(2,100,live)==nil)
  assert(not group.completed('stale',true))
  assert(group.completed(first.requestId,true))
  assert(not group.completed(first.requestId,true))
  local second = group.next(2,101,live)
  assert(second.profileKey=='panam' and #second.group.heard==1)
  group.received(second.requestId,'Hey',false,{'judy','panam'})
  group.completed(second.requestId,true)
  local third = group.next(3,102,live)
  assert(third.profileKey=='alex' and #third.group.heard==0)
`));
test('departed speakers are skipped, cancelled rounds and failed replies cannot advance stale work', () => check(`
  group.start('round',{judy,panam,alex},'Hello')
  live['1ULL']=nil
  local second = group.next(2,101,live)
  assert(second.profileKey=='panam')
  group.received(second.requestId,'unheard',true,{})
  local third = group.next(3,102,live)
  assert(#third.group.heard==0 and third.group.index==third.group.total)
  group.cancel()
  assert(not group.received(third.requestId,'late',false,{}))
  assert(group.next(4,103,live)==nil)
`));
test('validate group metadata and isolate private and group session scopes', () => {
  const group = {id: 'round-1', index: 1, total: 3, audience: ['judy', 'panam'], heard: []};
  assert.ok(parseGroup(group));
  assert.equal(parseGroup({...group, total: 4}), null);
  assert.equal(parseGroup({...group, heard: Array(3).fill({speaker:'x',text:'y'})}), null);
  assert.notEqual(conversationScope({}), conversationScope({group}));
  assert.equal(conversationScope({group}), conversationScope({group:{...group,audience:['panam','judy']}}));
  assert.match(groupContext({group}), /Do not ask V a question/);
  assert.match(groupContext({group:{...group,index:3}}), /final speaker/);
});
