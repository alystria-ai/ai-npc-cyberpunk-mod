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
 nativeReads=nativeReads+1
 assert(world,'Native access after HUD unload')
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
CName={new=function(value)return {value=value}end}
NameToString=function(value)return type(value)=='table' and value.value or value end
Vector4={new=function(x,y,z,w)return {x=x,y=y,z=z,w=w}end}
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
local function surface(entity,name)
 return {entity=entity,projection=true,root={name=name or 'native-chatter-root'},
  offset={x=0,y=0,z=.3,w=0},heightAttempts=0,heightWrites=0}
end
-- CET can materialize a different Lua wrapper at each callback. The native
-- widget's data persists, but neither the controller nor root wrapper compares
-- equal to one returned by an earlier call.
local function wrapController(state)
 return {GetOwnerID=function()
  native();assert(not state.brokenOwner,'Native owner expired');return {hash=state.entity}
 end,GetProjection=function()
  native();if state.projection then
   return {SetFixedWorldOffset=function(_,offset)
    native();state.heightAttempts=state.heightAttempts+1
    assert(not state.brokenPlacement,'Projection does not support placement')
    state.heightWrites=state.heightWrites+1
    state.offset={x=offset.x,y=offset.y,z=offset.z,w=offset.w}
   end,GetFixedWorldOffset=function()native();return state.offset end}
  end
 end,GetRootWidget=function()
  native();assert(not state.brokenRoot,'Native widget expired')
  return {GetName=function()native();return CName.new(state.root.name)end,
   SetName=function(_,value)native();state.root.name=NameToString(value)end}
 end}
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

test('optional overhead captions preserve UTF-8 within 120 characters without an artificial word cap', () => run(setup + `
local words=string.rep('one ',40)..'last'
local pages=m.split(words,'overhead')
assert(#pages>1 and table.concat(pages,' ')==words)
assert(countWords(pages[1])>12,'A readable phrase must not be split merely because it has twelve words')
for _,page in ipairs(pages)do assert(countChars(page)<=120 and page~='')end
local cjk=string.rep('城市夜光',50)
pages=m.split(cjk,'overhead')
assert(#pages>1 and table.concat(pages,'')==cjk)
for _,page in ipairs(pages)do assert(countChars(page)<=120 and #page%3==0)end
local emoji=string.rep('🙂',90)
pages=m.split(emoji,'overhead')
assert(table.concat(pages,'')==emoji)
for _,page in ipairs(pages)do assert(countChars(page)<=120 and #page%4==0)end
`));

test('complete sentences stay together and only overlong overhead text seeks a late natural boundary', () => run(setup + `
local sentence='Night City always looks different from up here, with all those lights stretching out beyond the skyline.'
assert(countChars(sentence)>90 and countChars(sentence)<=120)
local overhead=m.split(sentence,'overhead')
assert(#overhead==1 and overhead[1]==sentence,'An ordinary complete sentence should stay on screen as one caption')
local adjacent="Looks quiet. Stay close. We will take the next turn together."
overhead=m.split(adjacent,'overhead')
assert(#overhead==1 and overhead[1]==adjacent,'Short adjacent sentences must not be split eagerly')
local text=sentence..' Keep close and watch the next dark corner.'
overhead=m.split(text,'overhead')
assert(#overhead==2 and overhead[1]==sentence,'Overlong text should use the late completed sentence boundary')
assert(table.concat(overhead,' ')==text)
for _,page in ipairs(overhead)do assert(countChars(page)<=120)end
local dialogue=m.split(text,'dialogue')
assert(#dialogue==1 and dialogue[1]==text)
local long=string.rep('界',321)
dialogue=m.split(long,'dialogue')
assert(#dialogue==3 and countChars(dialogue[1])==160 and countChars(dialogue[2])==160)
assert(table.concat(dialogue,'')==long and countChars(dialogue[3])==1)
assert(#m.split('  ','overhead')==0)
`));

test('missing, invalid and failing style settings preserve the original dialogue HUD default', () => run(setup + `
for _,options in ipairs({{}, {style=function()return nil end}, {style=function()return 'unknown' end},
 {style=function()error('Settings not loaded')end}})do
 m.configure(options)
 m.show('Judy','Keep the original dialogue HUD.',judy,'201ULL')
 local lines=shown();local line=lines[#lines]
 assert(line.type==scnDialogLineType.OwnerlessRegular and line.speaker==nil)
 assert(m.status().mode=='dialogue')
end
m.configure(nil);m.show('Judy','No settings provider.',judy,'201ULL')
assert(shown()[5].type==scnDialogLineType.OwnerlessRegular)
m.configure({style=function()return 'overhead'end});m.show('Judy','Explicit overhead choice.',judy,'201ULL')
assert(shown()[6].type==scnDialogLineType.OverHead and shown()[6].speaker==judy)
assert(settingsWrites==0)
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

test('dialogue HUD retains its original reading duration and minimum display time', () => run(setup + `
style='dialogue'
m.show('Judy','One two three four five six seven eight nine ten eleven twelve.',judy,'201ULL')
local line=shown()[1]
assert(line.duration>5.4 and line.duration<5.5,'The original twelve-word HUD reading time is about 5.49 seconds')
m.update(5.4);assert(m.line~=nil)
m.update(.1);assert(m.line==nil and hidden()[1]==line.id)
m.show('Judy','Hi.',judy,'201ULL')
assert(shown()[2].duration==3.5)
m.update(3.4);assert(m.line~=nil)
m.update(.2);assert(m.line==nil)
`));

test('timed phrases advance only with the audio cursor and clear only the prior owned CRUID', () => run(setup + `
local text='Night City always looks different from up here, with all those lights stretching out beyond the skyline. Keep close and watch the next dark corner.'
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
m.beginTimed('Judy','Night City always looks different from up here, with all those lights stretching out beyond the skyline. Keep close and watch the next dark corner.',10,judy,'201ULL')
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
m.show('Judy','Night City always looks different from up here, with all those lights stretching out beyond the skyline. Keep close and watch the next dark corner.',judy,'201ULL')
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

test('native root ownership survives distinct controller and widget wrappers without affecting foreign captions', () => run(setup + `
assert(registrations==0 and overrideRegistrations==0)
assert(m.install());assert(m.install());assert(registrations==1 and overrideRegistrations==1)
local after=afterHooks['ChatterLineLogicController.SetLineData']
local bubble=overrides['ChatterLineLogicController.IsBubble']
assert(after and bubble)
local own,foreign,new=surface('201ULL'),surface('999ULL'),surface('202ULL')
local delegated,target=0,{}
local function wrapped(value)assert(value==target);delegated=delegated+1;return true end
m.show('Judy','A rendered line.',judy,'201ULL')
local first=shown()[1]
assert(bubble(wrapController(own),target,wrapped)==true and delegated==1,'No receipt means no controller ownership')
after(wrapController(foreign),{id='native-foreign',text='An unrelated native subtitle'})
assert(bubble(wrapController(foreign),target,wrapped)==true and delegated==2)
assert(foreign.root.name=='native-chatter-root','A foreign root must not be renamed')
local renderer=wrapController(own)
after(renderer,first)
local firstToken=own.root.name
assert(firstToken~='native-chatter-root','The exact verified root needs a persistent native identity')
local receipt=m.status().rendered
assert(receipt.id==first.id and receipt.entity=='201ULL' and receipt.renderer=='native-overhead')
assert(receipt.text=='A rendered line.' and receipt.projection==true)
assert(receipt.worldOffsetZ==.15 and own.offset.z==.15 and own.heightWrites==1)
assert(own.offset.x==0 and own.offset.y==0 and own.offset.w==0)
local projectionCallback=wrapController(own)
assert(renderer~=projectionCallback and renderer:GetRootWidget()~=projectionCallback:GetRootWidget())
assert(bubble(projectionCallback,target,wrapped)==false and delegated==2)
assert(m.status().bubbleOverrides>0)
assert(bubble(wrapController(foreign),target,wrapped)==true and delegated==3)
assert(foreign.heightAttempts==0 and foreign.offset.z==.3)
m.show('Judy','A new exact copy.',judyCopy,'202ULL')
local second=shown()[2]
after(wrapController(own),first)
assert(bubble(wrapController(own),target,wrapped)==true and delegated==4,'A stale phrase cannot reclaim its root')
after(wrapController(new),second)
assert(new.root.name~=firstToken,'Every owned phrase has its own native root identity')
assert(bubble(wrapController(new),target,wrapped)==false and delegated==4)
m.clear();assert(bubble(wrapController(new),target,wrapped)==true and delegated==5)
assert(m.controller==nil and m.actor==nil)
plain(m.status())
`));

test('reused roots, wrong actor owners and failed native receipts cannot borrow the bubble override', () => run(setup + `
m.install()
local after=afterHooks['ChatterLineLogicController.SetLineData']
local bubble=overrides['ChatterLineLogicController.IsBubble']
local wrapped=function()return true end
local own,wrong,stale,unprojected=surface('201ULL'),surface('202ULL'),surface('201ULL'),surface('201ULL')
stale.brokenOwner=true;unprojected.projection=false
m.show('Judy','Do not lend this line to another copy.',judy,'201ULL')
local current=shown()[1]
after(wrapController(wrong),current)
assert(bubble(wrapController(wrong),{},wrapped)==true,'Same caption ID alone cannot prove root ownership')
assert(wrong.root.name=='native-chatter-root')
assert(wrong.heightAttempts==0 and wrong.offset.z==.3)
after(wrapController(stale),current)
assert(bubble(wrapController(stale),{},wrapped)==true,'A failed receipt cannot acquire bubble ownership')
assert(stale.root.name=='native-chatter-root')
assert(stale.heightAttempts==0)
after(wrapController(unprojected),current)
assert(bubble(wrapController(unprojected),{},wrapped)==true,'An unprojected caption has no verified overhead owner')
assert(unprojected.heightAttempts==0)
after(wrapController(own),current);assert(bubble(wrapController(own),{},wrapped)==false)
after(wrapController(own),{id='native-replacement',text='This root now owns native dialogue'})
assert(bubble(wrapController(own),{},wrapped)==true,'A root recycled for native dialogue must return to native behavior')
local replacement=surface('201ULL')
after(wrapController(replacement),current)
assert(bubble(wrapController(replacement),{},wrapped)==false)
assert(bubble(wrapController(own),{},wrapped)==true,'A later receipt of the same owned line must not reactivate a retired native root')
after(wrapController(own),current);assert(bubble(wrapController(own),{},wrapped)==false)
own.entity='202ULL';after(wrapController(own),current)
assert(bubble(wrapController(own),{},wrapped)==true,'A rebound root must lose ownership if its actor no longer matches')
`));

test('a root tag cannot survive caption replacement, dismissal, or native-free abandon as active ownership', () => run(setup + `
m.install()
local after=afterHooks['ChatterLineLogicController.SetLineData']
local bubble=overrides['ChatterLineLogicController.IsBubble']
local wrapped=function()return true end
local firstRoot,secondRoot=surface('201ULL'),surface('201ULL')
m.show('Judy','A first caption.',judy,'201ULL');local first=shown()[1]
after(wrapController(firstRoot),first)
local firstToken=firstRoot.root.name
assert(bubble(wrapController(firstRoot),{},wrapped)==false)
m.show('Judy','A second caption.',judy,'201ULL');local second=shown()[2]
assert(bubble(wrapController(firstRoot),{},wrapped)==true)
after(wrapController(secondRoot),second)
assert(secondRoot.root.name~=firstToken and bubble(wrapController(secondRoot),{},wrapped)==false)
m.clearEntity('201ULL')
assert(bubble(wrapController(firstRoot),{},wrapped)==true and bubble(wrapController(secondRoot),{},wrapped)==true)
m.show('Judy','Caption before unload.',judy,'201ULL');after(wrapController(firstRoot),shown()[3])
assert(bubble(wrapController(firstRoot),{},wrapped)==false)
assert(m.placement~=nil and firstRoot.offset.z==.15)
local reads,writes=nativeReads,firstRoot.heightWrites;world=false;m.abandon()
assert(nativeReads==reads and firstRoot.heightWrites==writes)
assert(bubble(wrapController(firstRoot),{},wrapped)==true and nativeReads==reads)
assert(m.controller==nil and m.actor==nil and m.placement==nil)
`));

test('caption cleanup and root reuse restore the original projection vector from scalar ownership state', () => run(setup + `
m.install()
local after=afterHooks['ChatterLineLogicController.SetLineData']
local firstRoot,secondRoot=surface('201ULL'),surface('201ULL')
firstRoot.offset={x=.12,y=-.25,z=.4,w=1}
local function originalRestored()
 assert(firstRoot.offset.x==.12 and firstRoot.offset.y==-.25 and firstRoot.offset.z==.4 and firstRoot.offset.w==1)
end
m.show('Judy','A caption before clear.',judy,'201ULL')
local nativeVector=firstRoot.offset
after(wrapController(firstRoot),shown()[1])
assert(firstRoot.offset.z==.15 and firstRoot.heightWrites==1)
-- A native return value may be a wrapper backed by reusable storage. Restoration
-- needs the captured scalars, not a later view through that original wrapper.
nativeVector.x=99;nativeVector.z=99
m.clear();originalRestored()
assert(firstRoot.heightWrites==2 and m.placement==nil)
m.show('Judy','A caption before root reuse.',judy,'201ULL')
after(wrapController(firstRoot),shown()[2]);assert(firstRoot.offset.z==.15)
after(wrapController(firstRoot),{id='native-dialogue',text='A native replacement on the same root'})
originalRestored();assert(firstRoot.heightWrites==4 and m.placement==nil)
m.clear();assert(firstRoot.heightWrites==4,'A retired placement must not be restored twice')
m.show('Judy','A caption rendered on another root.',judy,'201ULL')
local line=shown()[3]
after(wrapController(firstRoot),line);assert(firstRoot.offset.z==.15)
after(wrapController(secondRoot),line)
originalRestored();assert(firstRoot.heightWrites==6 and secondRoot.offset.z==.15)
m.clear();assert(secondRoot.offset.z==.3 and secondRoot.heightWrites==2 and m.placement==nil)
`));

test('unsupported overhead height adjustment preserves the native caption without touching other projections', () => run(setup + `
m.install()
local after=afterHooks['ChatterLineLogicController.SetLineData']
local bubble=overrides['ChatterLineLogicController.IsBubble']
local owned,foreign=surface('201ULL'),surface('999ULL')
owned.brokenPlacement=true
m.show('Judy','Native height remains a usable fallback.',judy,'201ULL')
local current=shown()[1]
assert(pcall(after,wrapController(owned),current))
local status=m.status()
assert(status.active and status.rendered.id==current.id and status.rendered.entity=='201ULL')
assert(status.rendered.worldOffsetZ==nil and type(status.rendered.placementError)=='string')
assert(owned.heightAttempts==1 and owned.heightWrites==0 and owned.offset.z==.3)
assert(#shown()==1 and #hidden()==0 and bubble(wrapController(owned),{},function()return true end)==false)
after(wrapController(foreign),{id='native-line',text='A native caption'})
assert(foreign.heightAttempts==0 and foreign.offset.z==.3)
`));
