import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import fengari from 'fengari';

const source = readFileSync(new URL('../mod/subtitles.lua', import.meta.url), 'utf8');
function run(code) {
  const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;
  const vm = lauxlib.luaL_newstate(); lualib.luaL_openlibs(vm);
  const result = lauxlib.luaL_dostring(vm, to_luastring(code));
  const error = result === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(vm, -1));
  lua.lua_close(vm); assert.equal(result, lua.LUA_OK, error);
}
const setup = `
local world, enabled, overheads, menu, style = true, true, true, false, 'overhead'
local nativeReads, settingsWrites, registrations, overrideRegistrations, clock = 0, 0, 0, 0, 1000
local events, afterHooks, overrides = {}, {}, {}
os.time=function()return clock end
local function native()
 assert(world,'Native access after HUD unload')
 nativeReads=nativeReads+1
end
local function actor(entity)
 return {entity=entity,attached=true,dead=false,
  IsAttached=function(self)native();return self.attached end,
  IsDeadNoStatPool=function(self)native();assert(self.attached);return self.dead end,
  GetEntityID=function(self)native();assert(self.attached);return {hash=self.entity}end}
end
local judy=actor('201ULL')
local judyCopy=actor('202ULL')
local player=actor('101ULL')
player.ConvaiManagerSubtitles=function()native();return enabled end
local currentPlayer=player
local defs={UIGameData={ShowDialogLine='show',HideDialogLine='hide'},UI_System={IsInMenu='menu'}}
local uiBoard={SetVariant=function(_,key,variant,notify)
 native();assert(notify==true)
 assert((key=='show' and variant.kind=='array:scnDialogLineData')
  or (key=='hide' and variant.kind=='array:CRUID'))
 assert(type(variant.value)=='table' and #variant.value==1)
 local value=variant.value[1]
 if key=='show' then
  local copy={};for field,item in pairs(value)do copy[field]=item end
  events[#events+1]={kind='show',line=copy}
 else events[#events+1]={kind='hide',id=value}end
end,GetBool=function(_,field)native();assert(field=='menu');return menu end}
Game={GetPlayer=function()native();return currentPlayer end,
 GetAllBlackboardDefs=function()native();return defs end,
 GetBlackboardSystem=function()native();return {Get=function()native();return uiBoard end}end}
UserSettings={new=function()
 native();return {GetVar=function(_,path,name)
  native();assert(path=='/accessibility/subtitles' and name=='Overheads')
  return {GetValue=function()native();return overheads end,
   SetValue=function()settingsWrites=settingsWrites+1;error('Do not rewrite the native subtitle preference')end}
 end}
end}
scnDialogLineData={new=function()native();return {}end}
scnDialogLineType={OwnerlessRegular='ownerless-regular',OverHead='overhead'}
CRUID=function(value)return 'owned-'..tostring(value)end
ToVariant=function(value,kind)return {value=value,kind=kind}end
Enum={new=function(class,name)
 if class=='scnDialogLineType' then return scnDialogLineType[name]end
 return class..':'..name
end}
ObserveAfter=function(class,method,callback)
 registrations=registrations+1;afterHooks[class..'.'..method]=callback
end
Override=function(class,method,callback)
 overrideRegistrations=overrideRegistrations+1;overrides[class..'.'..method]=callback
end
ObserveBefore=function()error('Render receipt must run after native rendering')end
Observe=function()error('Render receipt must explicitly run after native rendering')end
local function shown()
 local result={};for _,event in ipairs(events)do if event.kind=='show' then result[#result+1]=event.line end end
 return result
end
local function hidden()
 local result={};for _,event in ipairs(events)do if event.kind=='hide' then result[#result+1]=event.id end end
 return result
end
local function countChars(value)
 local count=0;for _ in value:gmatch('[%z\\1-\\127\\194-\\244][\\128-\\191]*')do count=count+1 end;return count
end
local function countWords(value)
 local count=0;for _ in value:gmatch('%S+')do count=count+1 end;return count
end
local function plain(value)
 assert(type(value)~='function' and type(value)~='userdata' and type(value)~='thread')
 if type(value)=='table' then
  assert(getmetatable(value)==nil)
  for key,item in pairs(value)do plain(key);plain(item)end
 end
end
local m=(function()${source}end)()
m.configure({style=function()return style end})
`;

test('overhead phrases preserve UTF-8 and cap both character and word budgets', () => run(setup + `
local words=string.rep('one ',40)..'last'
local pages=m.split(words,'overhead')
assert(#pages>1 and table.concat(pages,' ')==words)
for _,page in ipairs(pages)do assert(countChars(page)<=64 and countWords(page)<=12 and page~='')end
local cjk=string.rep('城市夜光',50)
pages=m.split(cjk,'overhead')
assert(#pages>1 and table.concat(pages,'')==cjk)
for _,page in ipairs(pages)do assert(countChars(page)<=64 and #page%3==0)end
local emoji=string.rep('🙂',90)
pages=m.split(emoji,'overhead')
assert(table.concat(pages,'')==emoji)
for _,page in ipairs(pages)do assert(countChars(page)<=64 and #page%4==0)end
`));

test('overhead wrapping favors a completed clause, while dialogue keeps its larger pages', () => run(setup + `
local text='These streets never seem to sleep. Keep close and watch the next dark corner.'
local overhead=m.split(text,'overhead')
assert(#overhead>=2 and overhead[1]:match('[%.!?]$'),'A short complete sentence should end the first phrase')
assert(table.concat(overhead,' ')==text)
local dialogue=m.split(text,'dialogue')
assert(#dialogue==1 and dialogue[1]==text)
local long=string.rep('界',321)
dialogue=m.split(long,'dialogue')
assert(#dialogue==3 and countChars(dialogue[1])==160 and countChars(dialogue[2])==160)
assert(table.concat(dialogue,'')==long and countChars(dialogue[3])==1)
assert(#m.split('  ','overhead')==0)
`));

test('native overhead captions attach only to the requested living copy', () => run(setup + `
m.show('Judy','A short line.',judy,'201ULL')
local first=shown()[1]
assert(first.type==scnDialogLineType.OverHead and first.speaker==judy and first.speakerName=='Judy')
assert(first.text=='A short line.' and first.id~=nil)
m.show('Judy','The second copy speaks.',judyCopy,'202ULL')
local second=shown()[2]
assert(second.type==scnDialogLineType.OverHead and second.speaker==judyCopy)
assert(second.id~=first.id and #hidden()==1 and hidden()[1]==first.id)
assert(settingsWrites==0)
`));

test('missing, mismatched, dead, detached and unreadable actors fall back to ownerless HUD captions', () => run(setup + `
local cases={
 {nil,'201ULL'},
 {judy,'202ULL'},
 {judy,nil},
 {actor('301ULL'),'301ULL'},
 {actor('401ULL'),'401ULL'},
 {actor('501ULL'),'501ULL'},
 {actor('601ULL'),'601ULL'}
}
cases[4][1].dead=true
cases[5][1].attached=false
cases[6][1].GetEntityID=function()error('Expired actor ID')end
cases[7][1].dead=nil
for _,item in ipairs(cases)do
 m.show('Judy','Readable fallback.',item[1],item[2])
 local lines=shown();local line=lines[#lines]
 assert(line.type==scnDialogLineType.OwnerlessRegular and line.speaker==nil)
 assert(line.text=='Readable fallback.')
end
assert(settingsWrites==0)
`));

test('native overhead preference and selected dialogue style use HUD without changing game settings', () => run(setup + `
overheads=false;m.show('Judy','Native overheads are disabled.',judy,'201ULL')
assert(shown()[1].type==scnDialogLineType.OwnerlessRegular and shown()[1].speaker==nil)
overheads=true;style='dialogue';m.show('Judy','Dialogue style is selected.',judy,'201ULL')
assert(shown()[2].type==scnDialogLineType.OwnerlessRegular and shown()[2].speaker==nil)
style='overhead';m.show('Judy','Overheads can be used again.',judy,'201ULL')
assert(shown()[3].type==scnDialogLineType.OverHead and shown()[3].speaker==judy)
enabled=false;m.show('Judy','Muted captions.',judy,'201ULL')
assert(#shown()==3 and settingsWrites==0)
`));

test('timed phrases advance only with the audio cursor and clear only the prior owned CRUID', () => run(setup + `
local text='These streets never seem to sleep. Keep close and watch the next dark corner.'
m.beginTimed('Judy',text,10,judy,'201ULL')
local first=shown()[1];assert(first and first.type==scnDialogLineType.OverHead)
clock=5000;m.update(120)
assert(#shown()==1 and #hidden()==0,'Elapsed wall time must not advance a voiced phrase')
menu=true;m.update(120);menu=false
assert(#shown()==1 and #hidden()==0)
m.syncTimed(9.99)
local lines=shown();assert(#lines==2 and lines[2].text~=first.text)
assert(lines[2].speaker==judy and lines[2].id~=first.id)
assert(#hidden()==1 and hidden()[1]==first.id)
m.syncTimed(9.99);assert(#shown()==2 and #hidden()==1)
m.clear();assert(#hidden()==2 and hidden()[2]==lines[2].id)
assert(m.line==nil and m.timed==nil)
`));

test('exact-copy clearing cannot clear a different companion and lost actors release their captions', () => run(setup + `
m.beginTimed('Judy','Still speaking.',5,judyCopy,'202ULL')
local id=shown()[1].id
m.clearEntity('201ULL');assert(#hidden()==0 and m.line~=nil)
m.clearEntity('202ULL');assert(#hidden()==1 and hidden()[1]==id and m.line==nil)
m.show('Judy','A caption before departure.',judy,'201ULL');local departure=shown()[2].id
judy.attached=false;m.update(.1)
assert(m.line==nil and hidden()[2]==departure)
judy.attached=true;m.beginTimed('Judy','A timed caption before death.',5,judy,'201ULL')
local death=shown()[3].id;judy.dead=true;m.syncTimed(1)
assert(m.line==nil and hidden()[3]==death)
`));

test('abandon performs no native work and prevents a later cursor or update from reviving old captions', () => run(setup + `
m.beginTimed('Judy','These streets never seem to sleep. Keep close and watch the next dark corner.',10,judy,'201ULL')
local beforeReads,beforeEvents=nativeReads,#events
world=false;m.abandon()
assert(nativeReads==beforeReads and #events==beforeEvents)
assert(m.line==nil and m.timed==nil and m.pages==nil)
assert(m.actor==nil and m.controller==nil and m.entity==nil)
m.syncTimed(9);m.update(100)
assert(nativeReads==beforeReads and #events==beforeEvents)
plain(m.status())
world=true;m.show('Judy','A new session.',judyCopy,'202ULL')
assert(#shown()==2 and shown()[2].speaker==judyCopy)
`));

test('non-voiced pages preserve actor and speaker through owned-line replacement and pause with menus', () => run(setup + `
m.show('Judy','These streets never seem to sleep. Keep close and watch the next dark corner.',judy,'201ULL')
local first=shown()[1]
menu=true;m.update(100);assert(#shown()==1 and #hidden()==0)
menu=false;m.update(100)
local second=shown()[2]
assert(second and second.id~=first.id and second.speaker==judy and second.speakerName=='Judy')
assert(#hidden()==1 and hidden()[1]==first.id)
m.update(100)
assert(#shown()==2 and #hidden()==2 and hidden()[2]==second.id)
assert(m.line==nil and m.actor==nil and m.entity==nil)
`));

test('after-render receipts and bubble changes belong only to the current exact owned controller', () => run(setup + `
assert(registrations==0 and overrideRegistrations==0)
assert(m.install());assert(m.install());assert(registrations==1 and overrideRegistrations==1)
local after=afterHooks['ChatterLineLogicController.SetLineData']
local bubble=overrides['ChatterLineLogicController.IsBubble']
assert(after and bubble)
local function controller(entity)
 return {GetOwnerID=function()native();return {hash=entity}end,
  GetProjection=function()native();return {}end}
end
local own,foreign,new=controller('201ULL'),controller('999ULL'),controller('202ULL')
local delegated,target=0,{}
local function wrapped(value)assert(value==target);delegated=delegated+1;return true end
m.show('Judy','A rendered line.',judy,'201ULL')
local first=shown()[1]
assert(bubble(own,target,wrapped)==true and delegated==1,'No receipt means no controller ownership')
after(foreign,{id='native-foreign',text='An unrelated native subtitle'})
assert(bubble(foreign,target,wrapped)==true and delegated==2)
after(own,first)
local receipt=m.status().rendered
assert(receipt.id==first.id and receipt.entity=='201ULL' and receipt.renderer=='native-overhead')
assert(receipt.text=='A rendered line.' and receipt.projection==true)
assert(bubble(own,target,wrapped)==false and delegated==2)
assert(bubble(foreign,target,wrapped)==true and delegated==3)
m.show('Judy','A new exact copy.',judyCopy,'202ULL')
local second=shown()[2]
after(own,first)
assert(bubble(own,target,wrapped)==true and delegated==4,'A stale phrase cannot reclaim its controller')
after(new,second);assert(bubble(new,target,wrapped)==false and delegated==4)
m.clear();assert(bubble(new,target,wrapped)==true and delegated==5)
assert(m.controller==nil and m.actor==nil)
plain(m.status())
`));

test('recycled, wrong-owner and unreadable render controllers retain native bubble behavior', () => run(setup + `
m.install()
local after=afterHooks['ChatterLineLogicController.SetLineData']
local bubble=overrides['ChatterLineLogicController.IsBubble']
local wrapped=function()return true end
local own={GetOwnerID=function()return {hash='201ULL'}end,GetProjection=function()return {}end}
local wrong={GetOwnerID=function()return {hash='202ULL'}end,GetProjection=function()return {}end}
local stale={GetOwnerID=function()error('Controller detached')end,GetProjection=function()return {}end}
m.show('Judy','Do not lend this line to another copy.',judy,'201ULL')
local current=shown()[1]
after(wrong,current);assert(bubble(wrong,{},wrapped)==true,'Same caption ID alone cannot prove controller ownership')
after(stale,current);assert(bubble(stale,{},wrapped)==true,'A failed receipt cannot acquire bubble ownership')
after(own,current);assert(bubble(own,{},wrapped)==false)
after(own,{id='native-replacement',text='This controller now owns native dialogue'})
assert(bubble(own,{},wrapped)==true,'A controller recycled for native dialogue must return to native behavior')
`));
