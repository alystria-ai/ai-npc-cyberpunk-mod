import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import fengari from 'fengari';

const source = readFileSync(new URL('../mod/microphone.lua', import.meta.url), 'utf8');
const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;
const fixture = `
local function copy(value)
 if type(value)~='table'then return value end
 local result={};for key,item in pairs(value)do result[key]=copy(item)end;return result
end
local files,encoded,commands,feedback,cancellations={},{},{},{},{}
local serial,now,paused,available,enabled,world=0,100,false,true,true,1
json={encode=function(value)serial=serial+1;encoded[tostring(serial)]=copy(value);return tostring(serial)end,
 decode=function(raw)return copy(assert(encoded[raw]))end}
io={open=function(path,mode)
 if not available then return nil end
 if mode=='rb'then
  if not files[path]then return nil end
  return {read=function()return files[path]end,close=function()return true end}
 end
 return {write=function(_,raw)
  files[path]=raw
  if path=='runtime/microphone-command.json'then commands[#commands+1]=json.decode(raw)end
  return true
 end,close=function()return true end}
end}
os.time=function()return now end
local player={ConvaiPhoneFeedback=function(_,value)feedback[#feedback+1]=value end}
Game={GetAllBlackboardDefs=function()return {UI_System={IsInMenu='menu'}}end,
 GetBlackboardSystem=function()return {Get=function()return {GetBool=function()return paused end}end}end}
local mic=(function()${source}end)()
local function owner()return {session=world,generation=world,worldToken='world-'..world}end
mic.captureKnowledge=function(context)return {owner=owner(),worldKnowledge={at=now,group=context.group~=nil},journalHistory={at=now}}end
mic.currentKnowledgeOwner=owner
mic.captureJournal=function()return {at=now}end
mic.captureBattle=function()return {at=now}end
mic.captureFollowUpQuestions=function()return enabled end
mic.onCancelled=function(context,reason)cancellations[#cancellations+1]={id=context.requestId,reason=reason}end
local function input(group)
 return {requestId='voice-1',generation=1,entity='1ULL',profileKey='judy',name='Judy',text='[Microphone]',
  group=group and {id='group-1',index=1,total=2,audience={'judy','panam'},heard={}}or nil}
end
local function state(value,id)
 files['runtime/microphone-state.json']=json.encode({requestId=id or 'voice-1',state=value})
end
`;
function check(body) {
  const vm = lauxlib.luaL_newstate(); lualib.luaL_openlibs(vm);
  try {
    const program = fixture + '\n' + body;
    const result = lauxlib.luaL_dostring(vm, to_luastring(program));
    const error = result === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(vm, -1));
    const line = Number(/\]:(\d+):/.exec(error)?.[1]);
    assert.equal(result, lua.LUA_OK, error + (line ? '\n' + program.split('\n')[line - 1] : ''));
  } finally { lua.lua_close(vm); }
}

test('microphone keeps mode and frozen follow-up preference while refreshing finish context', () => check(`
 local context=input(true);context.followUpQuestions=false
 assert(mic.begin(context)and #commands==1 and commands[1].action=='start')
 assert(commands[1].input.followUpQuestions==false)
 state('recording');mic.update(player)
 assert(mic.state=='recording'and feedback[1]=='Listening - press F9 again to finish')
 local previous=files['runtime/microphone-command.json']
 assert(mic.finish('private')==nil and files['runtime/microphone-command.json']==previous)
 now=103;assert(mic.finish('group')==context)
 local sent=commands[#commands]
 assert(sent.action=='finish'and sent.input.requestId=='voice-1'and sent.input.group.index==1)
 assert(sent.input.followUpQuestions==false and sent.input.worldKnowledge.at==103)
 assert(sent.input.journal.at==103 and sent.input.battle.at==103 and sent.input.journalHistory.at==103)
 assert(mic.finish('group')==nil and #commands==2)
 assert(not mic.received('stale')and mic.context==context)
 assert(mic.received('voice-1')and not mic.context and not mic.targetValid and #commands==2)
 assert(#cancellations==0)
 context=input(false);assert(mic.begin(context));state('recording');mic.update(player)
 assert(feedback[#feedback]=='Listening - press F7 again to finish')
`));

test('stale state files cannot start capture and the owned microphone auto-finishes exactly once', () => check(`
 local context=input(true);assert(mic.begin(context))
 state('recording','another-request');mic.update(player);assert(mic.state=='starting'and #feedback==0)
 state('recording');mic.update(player)
 now=130;assert(mic.update(player)==context and commands[#commands].action=='finish')
 assert(mic.update(player)==nil and #commands==2 and mic.state=='reply')
`));

test('menu, lost target, changed world and device errors retire capture without later callbacks', () => check(`
 local valid=true
 for _,failure in ipairs({'menu','target','world','device'})do
  paused=false;valid=true
  local context=input(true);assert(mic.begin(context,function()return valid end))
  if failure=='menu'then paused=true
  elseif failure=='target'then valid=false
  elseif failure=='world'then world=world+1
  else state('error')end
  assert(mic.update(player)==nil and not mic.context and not mic.targetValid)
  assert(commands[#commands].action=='cancel'and cancellations[#cancellations].id=='voice-1')
  state('recording');assert(mic.update(player)==nil and not mic.context)
  assert(mic.finish('group')==nil)
 end
`));

test('failed writes and opening timeout cannot leave a recording owner alive', () => check(`
 available=false;assert(not mic.begin(input(true))and not mic.context)
 available=true;assert(mic.begin(input(true)))
 available=false;assert(mic.finish('group')==nil and not mic.context and not mic.knowledgeOwner)
 available=true;assert(mic.begin(input(false)))
 now=136;mic.update(player)
 assert(not mic.context and commands[#commands].action=='cancel')
 assert(feedback[#feedback]:find('timed out',1,true))
`));
