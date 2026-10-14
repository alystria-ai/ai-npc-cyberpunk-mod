import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
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
local uninternedRootNames=false
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
local parents={}
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
 GetMountingFacility=function()native();return {GetMountingInfoSingleWithObjects=function(_,object)
  native();return {parentId={hash=object.vehicle or '0ULL'}}
 end}end,
 FindEntityByID=function(id)native();return parents[id.hash]end,
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
local cnameValue={__eq=function(a,b)return a.value==b.value end}
CName={new=function(value)return setmetatable({value=value},cnameValue)end}
NameToString=function(value)
 local text=type(value)=='table' and value.value or value
 if uninternedRootNames and type(text)=='string' and text:match('^convai_subtitle_')then return ''end
 return text
end
Vector4={new=function(x,y,z,w)return {x=x,y=y,z=z,w=w}end}
inkWidgetRef={IsValid=function(ref)native();return type(ref)=='table' and ref.valid~=false end,
 SetVisible=function(ref,value)native();assert(ref and ref.valid~=false);ref.visible=value end}
inkTextRef={SetText=function(ref,text)native();assert(ref and ref.valid~=false);ref.text=text end}
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
 return {entity=entity,projection=true,root={name=name or 'native-chatter-root',visible=true,visibilityWrites={}},
  offset={x=0,y=0,z=.3,w=0},heightAttempts=0,heightWrites=0,
  slots={component='UI_Slots',slot='UI_Interaction',fallback='UI_Subtitles'},slotWrites=0,
  point={X=600,Y=300},inScreen=true,nameplateVisible=true,
  refs={normal={visible=true},wide={visible=false},normalContainer={visible=true},wideContainer={visible=false},
    textContainer={visible=false},speechBubble={visible=true}}}
end
-- CET can materialize a different Lua wrapper at each callback. The native
-- widget's data persists, but neither the controller nor root wrapper compares
-- equal to one returned by an earlier call.
local function wrapController(state)
 return {m_text_normal=state.refs.normal,m_text_wide=state.refs.wide,
  m_container_normal=state.refs.normalContainer,m_container_wide=state.refs.wideContainer,
  m_TextContainer=state.refs.textContainer,m_speachBubble=state.refs.speechBubble,
  IsVisible=function()native();return state.nativeVisible~=false end,
  SetNameplateVisibility=function(_,visible)native();state.nameplateVisible=visible end,
  GetOwnerID=function()
  native();assert(not state.brokenOwner,'Native owner expired');return {hash=state.entity}
 end,GetProjection=function()
  native();if state.projection then
   return {currentPosition=state.point,IsInScreen=function()native();return state.inScreen end,
    GetSlotComponentName=function()native();return CName.new(state.slots.component)end,
    GetSlotName=function()native();return CName.new(state.slots.slot)end,
    GetSlotFallbackName=function()native();return CName.new(state.slots.fallback)end,
    SetSlotComponentName=function(_,value)native();state.slotWrites=state.slotWrites+1;state.slots.component=NameToString(value)end,
    SetSlotName=function(_,value)native();assert(not state.brokenSlots);state.slotWrites=state.slotWrites+1;state.slots.slot=NameToString(value)end,
    SetSlotFallbackName=function(_,value)native();state.slotWrites=state.slotWrites+1;state.slots.fallback=NameToString(value)end,
    SetFixedWorldOffset=function(_,offset)
    native();state.heightAttempts=state.heightAttempts+1
    assert(not state.brokenPlacement,'Projection does not support placement')
    state.heightWrites=state.heightWrites+1
    state.offset={x=offset.x,y=offset.y,z=offset.z,w=offset.w}
   end,GetFixedWorldOffset=function()native();return state.offset end}
  end
 end,GetRootWidget=function()
  native();assert(not state.brokenRoot,'Native widget expired')
  return {GetName=function()native();return CName.new(state.root.name)end,
   SetName=function(_,value)native();state.root.name=type(value)=='table' and value.value or value end,
   IsVisible=function()native();return state.root.visible end,
   SetVisible=function(_,visible)
    native();state.root.visible=visible
    state.root.visibilityWrites[#state.root.visibilityWrites+1]={visible=visible,z=state.offset.z}
   end}
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

test('vehicle conversations use the dialogue HUD without changing the overhead preference', () => run(setup + `
parents['car']={IsAttached=function()return true end,IsVehicle=function()return true end}
player.vehicle='car';judy.vehicle='car'
assert(m.show('Judy','We can talk while we drive.',judy,'201ULL'))
assert(m.status().mode=='dialogue' and m.status().fallback=='vehicle-interior')
assert(m.status().requestedStyle=='overhead' and style=='overhead' and settingsWrites==0)
assert(shown()[1].type=='ownerless-regular' and shown()[1].speaker==judy,'The exact speaker owns the HUD line')
m.clear();player.vehicle=nil
assert(m.show('Judy','I am still in the passenger seat.',judy,'201ULL'))
assert(m.status().mode=='dialogue','A seated speaker should not have a floating cabin caption')
m.clear();judy.vehicle=nil
assert(m.show('Judy','Back on foot.',judy,'201ULL') and m.status().mode=='overhead')
`));

test('an add-on speaker\'s own caption carries the mark of the main mod, and V\'s live words and every other speaker never do', () => run(setup + `
m.configure({mark=function(profile,name) if profile=='addon-cab-voice' then return name..' (AI)' end return name end})
m.voiceOnly=true;m.voiceProfile='addon-cab-voice'
assert(m.show('Delamain','Welcome aboard.',nil,nil))
assert(shown()[#shown()].speakerName=='Delamain (AI)',tostring(shown()[#shown()].speakerName))
m.clear()
m.voiceProfile='judy-alvarez'
assert(m.show('Judy','Plain.',nil,nil))
assert(shown()[#shown()].speakerName=='Judy')
m.clear()
m.voiceProfile='addon-cab-voice'
assert(m.showLive('V','Hello there.'))
assert(shown()[#shown()].speakerName=='V',tostring(shown()[#shown()].speakerName))
m.clear()
m.voiceOnly=false
assert(m.show('Judy','Not voice only.',judy,'201ULL'))
assert(shown()[#shown()].speakerName=='Judy')
m.configure({mark=function() error('boom') end})
m.voiceOnly=true;m.voiceProfile='addon-cab-voice';m.clear()
assert(m.show('Delamain','A failing mark keeps the name.',nil,nil))
assert(shown()[#shown()].speakerName=='Delamain')
`));

test('boarding during timed speech retires the displayed page and preserves the remaining caption cursor', () => run(setup + `
parents['car']={IsAttached=function()return true end,IsVehicle=function()return true end}
local text=string.rep('A',120)..string.rep('B',120)..string.rep('C',100)
assert(m.beginTimed('Judy',text,12,judy,'201ULL'))
m.syncTimed(7)
local before=m.status();local old=shown()[#shown()]
assert(before.page==2 and before.position==7)
local count=#shown()
player.vehicle='car';m.update(.1)
local now=m.status()
assert(now.mode=='dialogue' and now.page==before.page and now.position==7)
assert(#shown()==count and m.line==nil,'Mounting must not display the same on-foot page again in the HUD')
assert(m.ownsUtterance(),'Retiring the projected root does not release the reply')
assert(hidden()[#hidden()]==old.id)
assert(m.reviseTimed(text,12,7))
assert(#shown()==count and m.line==nil,'An unchanged transcript cannot revive the retired page')
assert(m.status().page==before.page and m.status().position==7)
m.syncTimed(11.5)
local continuation=shown()[#shown()]
assert(#shown()==count+1 and continuation.text==string.rep('C',100) and continuation.type=='ownerless-regular')
count=#shown();player.vehicle=nil;m.update(.1)
assert(m.status().mode=='dialogue' and #shown()==count,'Do not swap renderer repeatedly mid-reply')
assert(settingsWrites==0)
m.clear();assert(not m.ownsUtterance())
`));

test('a completed on-foot caption cannot reappear on boarding but a new car reply displays normally', () => run(setup + `
parents['car']={IsAttached=function()return true end,IsVehicle=function()return true end}
assert(m.beginTimed('Judy','Sure. I will drive.',5,judy,'201ULL'))
local old=shown()[1]
m.syncTimed(5)
judy.vehicle='car';m.update(.1)
assert(#shown()==1 and hidden()[1]==old.id and m.line==nil)
assert(m.reviseTimed('Sure. I will drive.',5,5) and #shown()==1)
assert(m.beginTimed('Judy','We are taking the next left.',4,judy,'201ULL'))
assert(#shown()==2 and shown()[2].text=='We are taking the next left.' and shown()[2].type=='ownerless-regular')
assert(m.status().position==0 and settingsWrites==0)
assert(m.beginTimed('Judy','Sure. I will drive.',5,judy,'201ULL'))
assert(#shown()==3 and shown()[3].text==old.text,'An identical sentence in a new utterance is not a replay of the old reply')
`));

test('non-voiced boarding preserves its reading countdown and displays only the unread next page', () => run(setup + `
parents['car']={IsAttached=function()return true end,IsVehicle=function()return true end}
local text=string.rep('A',120)..string.rep('B',20)
assert(m.show('Judy',text,judy,'201ULL'))
m.update(1)
local remaining=m.remaining
player.vehicle='car';m.update(.25)
assert(#shown()==1 and m.line==nil and m.remaining==remaining-.25)
assert(m.ownsUtterance())
m.update(m.remaining+.01)
assert(#shown()==2 and shown()[2].text==string.rep('B',20) and shown()[2].type=='ownerless-regular')
m.update(m.remaining+.01);assert(m.pages==nil and m.line==nil)
assert(not m.ownsUtterance())
`));

test('a growing car transcript displays new text without repeating characters shifted by repagination', () => run(setup + `
parents['car']={IsAttached=function()return true end,IsVehicle=function()return true end}
local prefix=string.rep('word ',18)..string.rep('A',25)
assert(m.beginTimed('Judy',prefix,5,judy,'201ULL'))
m.syncTimed(1)
player.vehicle='car';m.update(.1)
assert(#shown()==1 and m.line==nil)
assert(m.reviseTimed(prefix..string.rep('B',30),6,2))
assert(#shown()==1 and m.line==nil)
m.syncTimed(4)
assert(#shown()==2 and shown()[2].text==string.rep('B',30),'The old suffix moved to page two but was already displayed on foot')
m.clear();player.vehicle=nil
local cjk=string.rep('界',100)
assert(m.beginTimed('Judy',cjk,5,judy,'201ULL'))
m.syncTimed(1);player.vehicle='car';m.update(.1)
local count=#shown()
assert(m.reviseTimed(cjk..string.rep('新',40),10,2))
assert(#shown()==count+1 and shown()[#shown()].text==string.rep('新',20),'The handoff cursor must count Unicode characters, not UTF-8 bytes')
`));

test('zero mounting IDs and nonvehicle props do not suppress on-foot overhead captions', () => run(setup + `
assert(m.show('Judy','On foot.',judy,'201ULL') and m.status().mode=='overhead')
m.clear()
parents['chair']={IsAttached=function()return true end,IsVehicle=function()return false end}
player.vehicle='chair'
assert(m.show('Judy','Sitting outside.',judy,'201ULL') and m.status().mode=='overhead')
m.clear();player.vehicle='missing'
assert(m.show('Judy','A stale parent is not a car.',judy,'201ULL') and m.status().mode=='overhead')
`));

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
 assert(line.type==scnDialogLineType.OwnerlessRegular and line.speaker==judy)
 assert(m.status().mode=='dialogue')
end
m.configure(nil);m.show('Judy','No settings provider.',judy,'201ULL')
assert(shown()[5].type==scnDialogLineType.OwnerlessRegular)
m.configure({style=function()return 'overhead'end});m.show('Judy','Explicit overhead choice.',judy,'201ULL')
assert(shown()[6].type==scnDialogLineType.OverHead and shown()[6].speaker==judy)
assert(settingsWrites==0)
`));

test('a growing timed transcript revises the current page without flashing or replaying page one', () => run(setup + `
style='dialogue'
local first=string.rep('A',160);local second=string.rep('B',160);local third=string.rep('C',80)
m.beginTimed('Judy',first..second,8,judy,'201ULL');m.syncTimed(5);m.update(.3)
assert(m.page==2 and shown()[#shown()].text==second)
local count=#shown();local old=shown()[count].id
assert(m.reviseTimed(first..second..third,12,5))
assert(#shown()==count and shown()[#shown()].text==second and m.page==2)
assert(#hidden()==count-1 and m.line.id==old,'Duration-only changes must not replay the native caption')
m.syncTimed(5.1);assert(m.page==2 and #shown()==count)
assert(m.reviseTimed(first..second..third,12,5.2));assert(#shown()==count)
m.syncTimed(11);assert(m.page==3 and shown()[#shown()].text==third)
assert(m.status().mode=='dialogue' and m.entity=='201ULL' and settingsWrites==0)
`));

test('caption revisions retain whole short sentences, reject invalid updates and respect actor/settings lifecycle', () => run(setup + `
local initial='Night City looks different up here.'
m.beginTimed('Judy',initial,8,judy,'201ULL')
local text=initial..' The lights stretch out beyond the skyline.'
assert(m.reviseTimed(text,10,2))
assert(m.page==1 and #m.pages==1 and m.line.text==text and #shown()==1)
local count=#shown();local old=shown()[count].id
for _,args in ipairs({{'',10,2},{text,0,2},{text,121,2},{text,10,-1}})do
 assert(not m.reviseTimed(args[1],args[2],args[3]))
end
assert(#shown()==count and shown()[count].id==old)
judy.dead=true;assert(not m.reviseTimed(text,10,2)and not m.line)
judy.dead=false;m.beginTimed('Judy',text,10,judy,'201ULL')
enabled=false;assert(not m.reviseTimed(text,10,2)and not m.line)
enabled=true;m.beginTimed('Judy',text,10,judy,'201ULL')
currentPlayer=actor('different-player');local count=#hidden()
assert(not m.reviseTimed(text,10,2)and not m.line and #hidden()==count)
m.abandon();assert(not m.reviseTimed(text,10,2))
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
assert(shown()[1].type==scnDialogLineType.OwnerlessRegular and shown()[1].speaker==judy)
overheads=true;style='dialogue';m.show('Judy','Dialogue style is selected.',judy,'201ULL')
assert(shown()[2].type==scnDialogLineType.OwnerlessRegular and shown()[2].speaker==judy)
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

test('timed overhead pages advance only with the cursor and retain one CRUID until cleanup', () => run(setup + `
local text='Night City always looks different from up here, with all those lights stretching out beyond the skyline. Keep close and watch the next dark corner.'
m.beginTimed('Judy',text,10,judy,'201ULL')
local first=shown()[1];assert(first and first.type==scnDialogLineType.OverHead)
clock=5000;m.update(120)
assert(#shown()==1 and #hidden()==0,'Elapsed wall time must not advance a voiced phrase')
menu=true;m.update(120);menu=false
assert(#shown()==1 and #hidden()==0)
m.syncTimed(9.99)
assert(#shown()==1 and m.line.text~=first.text and m.page==2)
assert(m.line.speaker==judy and m.line.id==first.id)
assert(#hidden()==0)
m.syncTimed(9.99);assert(#shown()==1 and #hidden()==0)
m.clear();assert(#hidden()==1 and hidden()[1]==first.id)
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
assert(not m.ownsUtterance() and nativeReads==beforeReads,'Ownership inspection performs no native reads after unload')
assert(m.line==nil and m.timed==nil and m.pages==nil)
assert(m.actor==nil and m.controller==nil and m.entity==nil)
m.syncTimed(9);m.update(100)
assert(nativeReads==beforeReads and #events==beforeEvents)
plain(m.status())
world=true;m.show('Judy','A new session.',judyCopy,'202ULL')
assert(#shown()==2 and shown()[2].speaker==judyCopy)
`));

test('non-voiced overhead paging preserves one actor and owned line and pauses with menus', () => run(setup + `
m.show('Judy','Night City always looks different from up here, with all those lights stretching out beyond the skyline. Keep close and watch the next dark corner.',judy,'201ULL')
local first=shown()[1]
menu=true;m.update(100);assert(#shown()==1 and #hidden()==0)
menu=false;m.update(100)
assert(m.line.text~=first.text and m.line.id==first.id and m.line.speaker==judy and m.line.speakerName=='Judy')
assert(#shown()==1 and #hidden()==0)
m.update(100)
assert(#shown()==1 and #hidden()==1 and hidden()[1]==first.id)
assert(m.line==nil and m.actor==nil and m.entity==nil)
`));

test('native root ownership survives distinct controller and widget wrappers without affecting foreign captions', () => run(setup + `
assert(registrations==0 and overrideRegistrations==0)
assert(m.install());assert(m.install());assert(registrations==4 and overrideRegistrations==2)
assert(afterHooks["SubtitlesGameController.OnHideLineByData"] and afterHooks["SubtitlesGameController.OnHideLine"],"Native removals must be observed")
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

test('overhead transcript growth and paging update one projected root without resetting placement or visibility', () => run(setup + `
m.install()
local after=afterHooks['ChatterLineLogicController.SetLineData']
local root=surface('201ULL')
m.beginTimed('Judy','A short initial sentence.',8,judy,'201ULL')
local id=m.line.id
after(wrapController(root),shown()[1])
local token,writes=root.root.name,root.heightWrites
root.root.visible=true;m.projectionReady=true;m.pendingProjection=nil
local visibleWrites=#root.root.visibilityWrites
local text='Night City always looks different from up here, with all those lights stretching out beyond the skyline. Keep close and watch the next dark corner.'
assert(m.reviseTimed(text,12,2))
assert(#shown()==1 and #hidden()==0 and m.line.id==id and m.page==1)
assert(root.refs.normal.text==m.pages[1] and root.refs.wide.text==m.pages[1])
assert(root.root.name==token and root.heightWrites==writes and #root.root.visibilityWrites==visibleWrites)
assert(root.root.visible and m.projectionReady and not m.pendingProjection)
m.syncTimed(11.9)
assert(m.page==2 and root.refs.normal.text==m.pages[2] and m.line.id==id)
assert(#shown()==1 and #hidden()==0 and root.heightWrites==writes)
local updates=m.textUpdates
assert(m.reviseTimed(text,13,11.9))
assert(m.textUpdates==updates and root.heightWrites==writes,'A final duration cannot re-render the same text')
m.clear()
assert(#hidden()==1 and hidden()[1]==id and not root.root.visible)
`));

test('a transcript revised before async spawn completes reconciles its newest page on the first receipt', () => run(setup + `
m.install()
local after=afterHooks['ChatterLineLogicController.SetLineData']
local root=surface('201ULL')
m.beginTimed('Judy','An early transcript.',8,judy,'201ULL')
local original=shown()[1]
assert(m.reviseTimed('An early transcript. Now its complete sentence has arrived.',10,2))
assert(#shown()==1 and #hidden()==0 and m.line.id==original.id)
after(wrapController(root),original)
assert(root.refs.normal.text==m.line.text and root.refs.normal.text~=original.text)
assert(m.status().rendered.text==m.line.text and m.textUpdates==1)
local writes,token=root.heightWrites,root.root.name
after(wrapController(root),m.line)
assert(root.heightWrites==writes and root.root.name==token,'Duplicate receipt must not replace an owned projection')
`));

test('cleanup conceals the exact root before restoring its native offset and delayed blackboard removal', () => run(setup + `
m.install()
local own,foreign=surface('201ULL'),surface('999ULL')
m.show('Judy','A caption that is about to end.',judy,'201ULL')
afterHooks['ChatterLineLogicController.SetLineData'](wrapController(own),m.line)
own.root.visible=true
local id=m.line.id
m.clear()
assert(not own.root.visible and own.offset.z==.3)
local conceal=own.root.visibilityWrites[#own.root.visibilityWrites]
assert(conceal.visible==false and conceal.z==.15,'The old anchor must be hidden before it moves back up')
assert(hidden()[1]==id and foreign.root.visible and foreign.heightWrites==0)
`));

test('the first cached projection stays hidden and nameplate transitions cannot shift an owned caption', () => run(setup + `
m.install()
local after=afterHooks['ChatterLineLogicController.SetLineData']
local project=overrides['ChatterLineLogicController.UpdateProjection']
local own,foreign=surface('201ULL'),surface('999ULL')
local calls=0
local function projectNative(state)
 return function(target,owner)
  assert(target=='target' and owner=='game-controller')
  calls=calls+1
  state.marginTop=state.point.Y-(state.nameplateVisible and 30 or 0)
  return 'native-result'
 end
end
assert(project(wrapController(foreign),'target','game-controller',projectNative(foreign))=='native-result')
assert(foreign.marginTop==270 and foreign.root.visible and foreign.nameplateVisible)
m.show('Judy','A stable projected caption.',judy,'201ULL')
after(wrapController(own),m.line)
assert(not own.root.visible and not m.projectionReady)
project(wrapController(own),'target','game-controller',projectNative(own))
assert(not own.root.visible and not m.projectionReady,'Initial cached UI slot must never flash near the head')
own.point.Y=220
m.update(.016)
assert(not own.root.visible and not m.projectionReady,'Callback and Lua update in one frame cannot skip the guard')
m.update(.016)
project(wrapController(own),'target','game-controller',projectNative(own))
assert(own.root.visible and m.projectionReady and own.marginTop==220)
for _,visible in ipairs({true,false,true,false})do
 own.nameplateVisible=visible
 project(wrapController(own),'target','game-controller',projectNative(own))
 assert(own.marginTop==220 and own.root.visible,'Nameplate visibility must not add a 30-pixel jump')
end
own.point={x=600,y=220}
project(wrapController(own),'target','game-controller',function(target,owner)
 assert(target=='target' and owner=='game-controller')
 calls=calls+1;own.marginTop=own.point.y
end)
assert(own.root.visible and own.marginTop==220,'Native lowercase vector wrappers must be accepted')
own.point={X=600,Y=220}
local before=calls
own.point.Y=0/0;project(wrapController(own),'target','game-controller',function()calls=calls+1 end)
assert(own.root.visible and not own.refs.textContainer.visible and calls==before+1,'Invalid coordinates hide owned text without blocking native projection')
own.point.Y=220;own.inScreen=false
project(wrapController(own),'target','game-controller',projectNative(own))
assert(own.root.visible and not own.refs.textContainer.visible and calls==before+2)
own.inScreen=true;project(wrapController(own),'target','game-controller',projectNative(own))
assert(own.root.visible and own.marginTop==220)
`));

test('standing and seated head slots use native animated projection and restore the full original slot binding', () => run(setup + `
m.install()
local foundCalls=0
for _,height in ipairs({1.6,.669})do
 judy.GetSlotComponent=function()
  native();return {GetSlotTransform=function(_,slot,...)
   native();assert(NameToString(slot)=='Head' and select('#',...)==0,'CET takes exactly one input')
   foundCalls=foundCalls+1;return true,{headZ=height}
  end,GetName=function()native();return CName.new('Item_Attachment_Slot')end}
 end
 local root=surface('201ULL')
 m.show('Judy','Same clearance in either pose.',judy,'201ULL')
 afterHooks['ChatterLineLogicController.SetLineData'](wrapController(root),m.line)
 assert(root.slots.component=='Item_Attachment_Slot' and root.slots.slot=='Head' and root.slots.fallback=='Head')
 assert(root.offset.z==.25 and m.status().rendered.anchor=='head')
 m.clear()
 assert(root.slots.component=='UI_Slots' and root.slots.slot=='UI_Interaction' and root.slots.fallback=='UI_Subtitles')
 assert(root.offset.z==.3 and not root.root.visible)
end
assert(foundCalls==2 and settingsWrites==0)
judy.GetSlotComponent=function()return {GetSlotTransform=function()return false,nil end}end
local fallback=surface('201ULL')
m.show('Judy','A rig with no Head slot retains native anchoring.',judy,'201ULL')
afterHooks['ChatterLineLogicController.SetLineData'](wrapController(fallback),m.line)
assert(fallback.slots.component=='UI_Slots' and fallback.slotWrites==0 and fallback.offset.z==.15)
assert(m.status().rendered.anchor=='native-ui-slot')
`));

test('foreign root reuse restores native visibility and failed owned text bindings safely replace only the caption', () => run(setup + `
m.install()
local after=afterHooks['ChatterLineLogicController.SetLineData']
local root=surface('201ULL')
m.beginTimed('Judy','A first sentence.',8,judy,'201ULL')
after(wrapController(root),m.line)
assert(not root.root.visible)
after(wrapController(root),{id='native-dialogue',text='Native chatter on the reused widget'})
assert(root.root.visible and root.offset.z==.3 and m.controller==nil)
assert(overrides['ChatterLineLogicController.UpdateProjection'](wrapController(root),1,2,function(a,b)
 assert(a==1 and b==2);return 'foreign'
end)=='foreign')
m.clear()
local broken=surface('201ULL')
m.beginTimed('Judy','A new sentence.',8,judy,'201ULL')
local id=m.line.id
after(wrapController(broken),m.line)
broken.refs.wide.valid=false
assert(m.reviseTimed('A new sentence with more text.',10,2))
assert(m.line.id~=id and #shown()==3 and hidden()[#hidden()]==id)
assert(m.renderUpdateError:find('unavailable') and not broken.root.visible and broken.offset.z==.3)
`));

test('a missing projection override API still reveals the admitted caption through the regular frame path', () => run(setup + `
Override=nil
assert(m.install() and registrations==4 and overrideRegistrations==0)
local root=surface('201ULL')
m.show('Judy','Native placement remains usable.',judy,'201ULL')
afterHooks['ChatterLineLogicController.SetLineData'](wrapController(root),m.line)
assert(not root.root.visible and root.offset.z==.15 and m.widgetToken~=nil and m.pendingProjection)
m.update(.016);assert(not root.root.visible)
m.update(.016);assert(root.root.visible and not m.pendingProjection and m.projectionReady)
assert(root.refs.textContainer.visible and not root.refs.speechBubble.visible)
m.clear();assert(not root.root.visible and root.offset.z==.3)
`));

test('dynamic native names retain exact ownership even when NameToString has no interned text', () => run(setup + `
uninternedRootNames=true
m.install()
local own,foreign=surface('201ULL'),surface('201ULL','convai_subtitle_other_root')
m.beginTimed('Judy','A reply in progress.',8,judy,'201ULL')
local id=m.line.id
afterHooks['ChatterLineLogicController.SetLineData'](wrapController(own),m.line)
local nativeName=wrapController(own):GetRootWidget():GetName()
assert(NameToString(nativeName)=='' and NameToString(CName.new(m.widgetToken))=='')
assert(nativeName==CName.new(m.widgetToken),'Native value identity must survive absent text lookup')
assert(own.root.name==m.widgetToken and not own.root.visible)
local bubble=overrides['ChatterLineLogicController.IsBubble']
assert(bubble(wrapController(own),{},function()return true end)==false)
assert(bubble(wrapController(foreign),{},function()return true end)==true,'Two unresolved names are not the same native value')
assert(foreign.root.visible and foreign.heightWrites==0)
m.update(.016);m.update(.016)
assert(own.root.visible and m.projectionReady and own.refs.textContainer.visible and not own.refs.speechBubble.visible)
assert(m.reviseTimed('A reply in progress. More of the same utterance arrives.',10,2))
assert(#shown()==1 and #hidden()==0 and m.line.id==id and own.refs.normal.text==m.line.text)
m.clear()
assert(not own.root.visible and own.offset.z==.3 and hidden()[1]==id)
assert(foreign.root.visible and foreign.heightWrites==0)
`));

test('regular frames reveal and clip timed captions even when registered native projection hooks never run', () => run(setup + `
m.install()
local own=surface('201ULL')
m.beginTimed('Judy','The live utterance keeps its own projected text.',8,judy,'201ULL')
afterHooks['ChatterLineLogicController.SetLineData'](wrapController(own),m.line)
assert(overrides['ChatterLineLogicController.UpdateProjection']~=nil and not own.root.visible)
-- API registration alone does not prove that a native call will reach it.
-- Exercise only the real regular update path, including its timed early return.
m.update(.016);assert(not own.root.visible and m.pendingProjection)
m.update(.016);assert(own.root.visible and m.projectionReady and not m.pendingProjection)
assert(m.projectionFrames==2 and not m.projectionCallbacks and not m.bubbleOverrides)
assert(own.refs.textContainer.visible and not own.refs.speechBubble.visible)
local id=m.line.id
own.inScreen=false;m.update(.016);assert(own.root.visible and not own.refs.textContainer.visible)
own.inScreen=true;own.nativeVisible=false;m.update(.016);assert(own.root.visible and not own.refs.textContainer.visible,'Native distance visibility still applies')
own.nativeVisible=true;m.update(.016);assert(own.root.visible)
assert(m.line.id==id and #shown()==1 and #hidden()==0)
local beforeReads,beforeWrites=nativeReads,#own.root.visibilityWrites
world=false;m.abandon();m.update(.016)
assert(nativeReads==beforeReads and #own.root.visibilityWrites==beforeWrites,'Unload cannot reveal an old root')
`));

test('same-frame projection callbacks cannot shorten settling and an unretained name cannot hide a foreign root', () => run(setup + `
m.install()
local own=surface('201ULL')
m.beginTimed('Judy','A stable first projected frame.',8,judy,'201ULL')
afterHooks['ChatterLineLogicController.SetLineData'](wrapController(own),m.line)
local project=overrides['ChatterLineLogicController.UpdateProjection']
local function wrapped()return true end
for _=1,8 do project(wrapController(own),{}, {},wrapped)end
assert(not own.root.visible and m.pendingProjection)
m.update(.016)
for _=1,8 do project(wrapController(own),{}, {},wrapped)end
assert(not own.root.visible and m.pendingProjection,'Repeated callbacks in frame one cannot expose cached placement')
m.update(.016);assert(own.root.visible and not m.pendingProjection)
m.clear()
local foreign=surface('201ULL')
local controller=wrapController(foreign)
controller.GetRootWidget=function()
 local root=wrapController(foreign):GetRootWidget()
 root.SetName=function()native()end -- a silent binding failure does not retain the name
 return root
end
m.show('Judy','Native fallback after failed name ownership.',judy,'201ULL')
afterHooks['ChatterLineLogicController.SetLineData'](controller,m.line)
assert(foreign.root.visible and foreign.heightWrites==0 and m.controller==nil)
assert(m.status().rendered.ownershipError:find('did not retain'))
m.update(.016);m.update(.016)
assert(foreign.root.visible and foreign.heightWrites==0,'The frame fallback needs exact native root ownership')
`));

test('initial readiness cannot deadlock a hidden root and owned full text stays clipped outside native visibility', () => run(setup + `
m.install()
local own=surface('201ULL')
own.inScreen=false;own.point={X=0,Y=768}
m.beginTimed('Judy','The native projection can initialize while its text is hidden.',8,judy,'201ULL')
afterHooks['ChatterLineLogicController.SetLineData'](wrapController(own),m.line)
assert(not own.root.visible and m.pendingProjection)
m.update(.016);assert(not own.root.visible)
m.update(.016)
assert(own.root.visible and not m.pendingProjection and not m.projectionReady,'Guard must release even without projection readiness')
assert(not own.refs.textContainer.visible and not own.refs.speechBubble.visible,'Offscreen text cannot expand at the viewport edge')
own.inScreen=true;own.point={X=400,Y=250}
m.update(.016)
assert(own.root.visible and m.projectionReady and own.refs.textContainer.visible and not own.refs.speechBubble.visible)
own.point={};m.update(.016)
assert(own.root.visible and not own.refs.textContainer.visible and not m.projectionReady)
m.clear();assert(not own.root.visible)
`));

test('installed 2.31 native sources support animated head projection and owned plain-text update refs', {
  skip: process.env.CYBERPUNK_NATIVE_SOURCE_CHECK !== '1',
}, () => {
  const root = process.env.CYBERPUNK_GAME_ROOT ?? 'E:\\SteamLibrary\\steamapps\\common\\Cyberpunk 2077';
  const base = join(root, 'tools', 'redmod', 'scripts');
  const chatter = readFileSync(join(base, 'cyberpunk', 'UI', 'subtitles', 'chattersControllers.script'), 'utf8');
  const subtitles = readFileSync(join(base, 'cyberpunk', 'UI', 'subtitles', 'baseSubtitlesControllers.script'), 'utf8');
  const sample = readFileSync(join(base, 'samples', 'ink', 'sampleUIControllers.script'), 'utf8');
  const projection = readFileSync(join(base, 'core', 'ui', 'screenProjection.script'), 'utf8');
  assert.match(sample, /slotComponentName\s*=\s*'Item_Attachment_Slot'/);
  assert.match(sample, /slotName\s*=\s*'Head'/);
  for (const property of ['m_text_normal', 'm_text_wide', 'm_container_normal', 'm_container_wide']) {
    assert.match(chatter, new RegExp(`private editable var ${property}\\s*:`));
  }
  assert.match(chatter, /inkTextRef\.SetText\( m_text_normal, lineData\.text \)/);
  assert.match(chatter, /inkTextRef\.SetText\( m_text_wide, lineData\.text \)/);
  assert.match(chatter, /m_projection\.SetEntity\( lineData\.speaker \)/);
  assert.match(chatter, /inkWidgetRef\.SetVisible\( m_TextContainer, false \)/);
  assert.match(chatter, /margin\.top -= 30\.0/);
  assert.match(chatter, /public function SetNameplateVisibility\( isVisible : Bool \)/);
  assert.match(subtitles, /RegisterDelayedListenerVariant\( GetAllBlackboardDefs\(\)\.UIGameData\.HideDialogLine/);
  for (const method of ['GetSlotComponentName', 'SetSlotComponentName', 'GetSlotName', 'SetSlotName', 'GetSlotFallbackName', 'SetSlotFallbackName']) {
    assert.match(projection, new RegExp(`function ${method}\\(`));
  }
});

// ---- Audio-timed captions (October 8): cues aligned to the heard audio ----
// The user saw a cinematic subtitle vanish while Judy (Pocket) was still saying
// it. Pages were split at 160 characters regardless of sentences and advanced
// by character share of a duration estimate. Cues from bridge/caption-cues.mjs
// carry the audio second each sentence starts; pages change only there.
import {captionCues, cueSignature} from './caption-cues.mjs';
import {displayText} from './natural-speech.mjs';

const speechSource = readFileSync(new URL('../mod/speech.lua', import.meta.url), 'utf8');
// Five sentences as Pocket Judy spoke them on October 8 (live mouth-timeline
// pauses), with clause pauses inside sentences two, three and five.
const SENTENCES = [
  {text: 'I just like them.', voiced: [[.2, 1]]},
  {text: "They're a way of marking who I am, you know?", voiced: [[2.18, 3.3], [3.45, 4.02]]},
  {text: 'Plus, in a city where everything is synthetic and corporate,', voiced: [[4.43, 4.75], [4.95, 7.4]]},
  {text: 'having something permanent on your own skin feels...', voiced: [[7.85, 10.33]]},
  {text: "I don't know, real.", voiced: [[11.7, 12.37], [12.67, 12.98]]},
];
const TOTAL = 13.12;
const TEXT = SENTENCES.map(sentence => sentence.text).join(' ');
function mouth(sentences, until, total = TOTAL) {
  const frames = [];
  for (let i = 0; i * .01 <= Math.min(until, total) + 1e-9; i++) {
    const t = Math.round(i * 1000) / 100000;
    const voiced = sentences.some(sentence => sentence.voiced.some(([a, b]) => t >= a && t <= b));
    frames.push([t, voiced ? .3 : 0]);
  }
  return {version: 1, tracks: ['jaw_mid_open'], frames, duration: Math.min(until, total), complete: until >= total};
}
function lua(value) {
  if (value === null || value === undefined) return 'nil';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return '{' + value.map(lua).join(',') + '}';
  return '{' + Object.entries(value).filter(([, item]) => item !== undefined && item !== null)
    .map(([key, item]) => `[${JSON.stringify(key)}]=${lua(item)}`).join(',') + '}';
}

test('caption cues follow the audio: real pauses, not text share, and nothing before it is heard', () => {
  const complete = captionCues(TEXT, {face: mouth(SENTENCES, TOTAL), duration: TOTAL, complete: true});
  assert.equal(complete.cues.map(cue => cue.text).join(''), TEXT, 'Cue texts reassemble the displayed reply');
  assert.deepEqual(complete.cues.map(cue => cue.start), [0, 2.18, 4.43, 7.85, 11.7]);
  // A cue ends at its last voiced frame (within one 10 ms mouth frame).
  [1, 4.02, 7.4, 10.33, 12.98].forEach((end, i) => assert.ok(Math.abs(complete.cues[i].finish - end) <= .0101, `cue ${i} end`));
  assert.ok(complete.cues.every(cue => cue.anchored));
  // Streaming: the mouth timeline grows with the buffered audio. A boundary is
  // published only once speech has resumed after its pause, and never early.
  for (let buffered = .05; buffered < TOTAL; buffered += .05) {
    const partial = captionCues(TEXT, {face: mouth(SENTENCES, buffered), duration: buffered, complete: false});
    partial.cues.forEach((cue, index) => {
      if (cue.start === null) {
        assert.ok(partial.cues.slice(index).every(later => later.start === null), 'Unknown boundaries stay ordered');
        return;
      }
      assert.ok(cue.start >= complete.cues[index].start - 1e-6, `cue ${index} published early at ${buffered.toFixed(2)} s`);
      assert.ok(Math.abs(cue.start - complete.cues[index].start) < 1e-6, `cue ${index} misplaced at ${buffered.toFixed(2)} s`);
    });
    for (const [index, sentence] of SENTENCES.entries())
      if (buffered >= sentence.voiced[0][0] + .02) assert.notEqual(partial.cues[index].start, null, `cue ${index} known by ${buffered.toFixed(2)} s`);
  }
  // A pause still in progress at the end of the analysed audio is not evidence that no pause is coming.
  const midPause = captionCues(TEXT, {face: mouth(SENTENCES, 9.9 + 1.5), duration: 11.4, complete: false});
  assert.equal(midPause.cues[4].start, null);
  // Without a mouth timeline the final duration still yields monotonic estimates.
  const estimated = captionCues(TEXT, {duration: TOTAL, complete: true});
  assert.ok(estimated.cues.every((cue, i) => i === 0 || cue.start > estimated.cues[i - 1].start));
  assert.equal(captionCues(TEXT, {duration: 1.2, complete: false}).cues[1].start, null, 'No estimate before the buffered audio passes it');
  // Natural-speech tags never reach a cue and leave no gap.
  const tagged = displayText('Hey [laughter] V. {joy} Good to see you.');
  const cues = captionCues(tagged, {duration: 3, complete: true}).cues;
  assert.equal(cues.map(cue => cue.text).join(''), tagged);
  assert.ok(!cues.some(cue => /\[|\{/.test(cue.text)));
  assert.equal(cueSignature(complete), cueSignature(captionCues(TEXT, {face: mouth(SENTENCES, TOTAL), duration: TOTAL, complete: true})));
});

test('cue pages keep whole sentences and change only when the next sentence is heard', () => run(setup + `
style='dialogue'
local captions=${lua(captionCues(TEXT, {face: mouth(SENTENCES, TOTAL), duration: TOTAL, complete: true}))}
local text=${lua(TEXT)}
assert(m.beginTimed('Judy',text,${TOTAL},judy,'201ULL',captions))
assert(m.status().cueTimed and #m.pages==2)
assert(m.pages[1]=="I just like them. They're a way of marking who I am, you know? Plus, in a city where everything is synthetic and corporate,")
assert(m.pages[2]=="having something permanent on your own skin feels... I don't know, real.")
local t=0
while t<=${TOTAL} do
 m.syncTimed(t);m.update(.05)
 assert(m.line and m.page==(t>=7.85 and 2 or 1),'page '..tostring(m.page)..' at '..t)
 t=t+.05
end
assert(#shown()==2 and #hidden()==1,'Each page is presented once')
-- Audio finished: a short reading hold that owns nothing.
assert(m.linger(.6) and m.line and not m.ownsUtterance())
m.update(.5);assert(m.line~=nil)
m.update(.2);assert(m.line==nil and #hidden()==2)
`));

test('a slow stream and a stall hold the heard page; a late boundary advances without replaying', () => run(setup + `
style='dialogue'
local text=${lua(TEXT)}
local early=${lua(captionCues(TEXT, {face: mouth(SENTENCES, 7.6), duration: 7.6, complete: false}))}
local later=${lua(captionCues(TEXT, {face: mouth(SENTENCES, 8.4), duration: 8.4, complete: false}))}
local final=${lua(captionCues(TEXT, {face: mouth(SENTENCES, TOTAL), duration: TOTAL, complete: true}))}
assert(early.cues[4].start==nil and later.cues[4].start==7.85)
assert(m.beginTimed('Judy',text,14.1,judy,'201ULL',early))
-- The old estimate put page two at 12.2 s of a 14.1 s guess, the final 13.12 s
-- at 11.4 s: neither is where the voice is. An unknown boundary waits.
for _,t in ipairs({1,4,7.6,8.4,9.5})do m.syncTimed(t);assert(m.page==1)end
-- Stalled renderer: the cursor stops, wall time passes, nothing advances or clears.
for _=1,40 do m.syncTimed(9.5);m.update(.25)end
assert(m.line and m.page==1 and #shown()==1 and #hidden()==0)
assert(m.reviseTimed(text,14.1,9.5,later))
assert(m.page==2 and #shown()==2,'The resolved boundary shows the page being heard')
local count=#shown()
assert(m.reviseTimed(text,${TOTAL},10,final) and #shown()==count,'Timing-only revisions do not redisplay')
m.syncTimed(12.9);assert(m.page==2 and #shown()==count)
`));

test('a sentence longer than a page splits within its own audio span, and tags never show', () => run(setup + `
style='dialogue'
local long=string.rep('word ',49)..'end of a very long sentence without any break at all.'
local captions={version=1,cues={{text='Hey [laughter] V. ',start=0,finish=.8},{text=long,start=1,finish=16}}}
assert(m.beginTimed('Judy','Hey [laughter] V. '..long,16,judy,'201ULL',captions))
assert(m.pages[1]=='Hey V.' and #m.pages>=3)
for _,page in ipairs(m.pages)do assert(countChars(page)<=160 and not page:find('%['))end
local chars=countChars(m.cues(captions)[2].text:match('^%s*(.-)%s*$'))
local second=m.pageRanges[3].start-m.pageRanges[2].start
local at=1+15*second/chars
m.syncTimed(.9);assert(m.page==1)
m.syncTimed(1);assert(m.page==2)
m.syncTimed(at-.05);assert(m.page==2,'The second part waits for its share of the sentence audio')
m.syncTimed(at+.01);assert(m.page==3)
-- Unknown end and no later cue: a slow reading rate, never a guess ahead.
m.clear()
local open={version=1,cues={{text=long,start=0}}}
assert(m.beginTimed('Judy',long,30,judy,'201ULL',open))
local part=(m.pageRanges[2].start-1)/15
m.syncTimed(part-.05);assert(m.page==1)
m.syncTimed(part+.05);assert(m.page==2)
-- Malformed cues fall back to the duration share.
m.clear()
assert(m.beginTimed('Judy',long,16,judy,'201ULL',{version=1,cues={{text='a',start=0},{text='b',start=5},{text='c',start=2}}}))
assert(not m.status().cueTimed)
`));

test('overhead captions follow cues on one projected root', () => run(setup + `
style='overhead'
local captions=${lua(captionCues(TEXT, {face: mouth(SENTENCES, TOTAL), duration: TOTAL, complete: true}))}
assert(m.beginTimed('Judy',${lua(TEXT)},${TOTAL},judy,'201ULL',captions))
assert(m.status().mode=='overhead' and m.status().cueTimed)
for _,page in ipairs(m.pages)do assert(countChars(page)<=120)end
local first=m.line.id
local t,pages=0,{}
while t<=${TOTAL} do
 m.syncTimed(t);pages[m.page]=pages[m.page] or t;t=t+.05
end
assert(#shown()==1 and m.line.id==first,'Overhead pages update one owned line')
for page=2,#m.pages do
 local at=m.timed.starts[page]
 assert(at==2.18 or at==4.43 or at==7.85 or at==11.7,'Overhead pages also change only at heard sentence starts')
 assert(pages[page]>=at-1e-9)
end
`));

test('a reading hold never blocks the next speaker or phrase, and expires on its own', () => run(setup + `
style='dialogue'
assert(m.beginTimed('Judy','First phrase.',1.5,judy,'201ULL'))
m.syncTimed(1.5);assert(m.linger(3))
local held=m.line.id
m.update(1);assert(m.line and m.line.id==held and not m.ownsUtterance())
-- Next Omni phrase (or group speaker) is heard: it replaces the held line at once.
assert(m.beginTimed('Panam','Second voice now.',2,judyCopy,'202ULL'))
assert(hidden()[#hidden()]==held and m.line.text=='Second voice now.' and m.entity=='202ULL')
assert(m.ownsUtterance())
m.syncTimed(2);assert(m.linger(.6))
menu=true;m.update(5);assert(m.line~=nil,'A menu pauses the hold');menu=false
m.update(.7);assert(m.line==nil and not m.ownsUtterance())
assert(not m.linger(.6),'Nothing to hold')
`));

test('native removal by data presents the heard dialogue page again', () => run(setup + `
style='dialogue'
assert(m.install())
local removed=afterHooks['SubtitlesGameController.OnHideLineByData']
assert(m.beginTimed('Judy','Still talking here.',4,judy,'201ULL'))
local first=m.line
removed(nil,{id='someone-else'});m.update(.05);assert(#shown()==1)
removed(nil,{id=first.id});m.update(.05)
assert(#shown()==2 and shown()[2].text==first.text and shown()[2].id~=first.id)
assert(m.status().restores==1 and m.status().nativeRemovals==1)
m.syncTimed(3);assert(m.page==1 and #shown()==2)
m.clear()
style='overhead'
assert(m.beginTimed('Judy','Overhead is not affected.',4,judy,'201ULL'))
removed(nil,{id=m.line.id});m.update(.05);assert(#shown()==3 and m.status().restores==0)
`));

// End to end: the real bridge cue builder feeds speech.lua and subtitles.lua
// through simulated heard playback. Whenever a sentence is audible, the HUD
// shows the page containing it: never replaced early, never left blank.
function playback({lead, stall}) {
  const states = [];
  let heard = 0, wall = 0, revision = 0, signature = '';
  while (heard < TOTAL - 1e-9) {
    wall += .05;
    const stalled = stall && wall >= stall[0] && wall < stall[1];
    if (!stalled) heard = Math.min(TOTAL, heard + .05);
    const buffered = Math.min(TOTAL, heard + lead), complete = buffered >= TOTAL;
    const captions = captionCues(TEXT, {face: mouth(SENTENCES, buffered), duration: buffered, complete});
    if (cueSignature(captions) !== signature) { signature = cueSignature(captions); revision++; }
    states.push({position: Math.round(heard * 1000) / 1000, bufferedDuration: buffered, complete, textComplete: true,
      text: TEXT, state: stalled ? 'buffering' : 'playing', ended: false, captions: {...captions, revision}});
  }
  states.push({...states.at(-1), state: 'ended', ended: true});
  return states;
}
const speechHarness = states => `
style='dialogue'
player.ConvaiManagerVoice=function()return true end
json={encode=function()return '' end}
io={open=function()return {write=function()return true end,read=function()return nil end,close=function()return true end}end}
local adapter={version=1,available=true,current=nil}
function adapter.start()return true end
function adapter.update()return adapter.current end
function adapter.stop()end
function adapter.pause()return true end
function adapter.status()return {}end
local face=setmetatable({},{__index=function()return function()end end})
dofile=function(path)
 if path=='subtitles.lua' then return m end
 if path=='facial-playback.lua' then return face end
 if path=='continuous-speech.lua' then return adapter end
 error('Unexpected module '..path)
end
local speech=(function()${speechSource}
end)()
local sentences=${lua(SENTENCES)}
local states=${lua(states)}
speech.target=judy
assert(speech.start({requestId='r1',entity='201ULL',generation=1,name='Judy'},{text=states[1].text,continuous={version=1,id='c1'}}))
local reported={}
for index,state in ipairs(states)do
 adapter.current=state
 speech.update(.05);m.update(.05)
 if state.ended then break end
 for number,sentence in ipairs(sentences)do
  for _,span in ipairs(sentence.voiced)do
   if state.position>=span[1] and state.position<=span[2] then
    local line=m.line and m.line.text or ''
    if not line:find(sentence.text,1,true) and not reported[number] then
     reported[number]=true
     error('Sentence '..number..' audible at '..state.position..' s but the HUD shows: '..line)
    end
   end
  end
 end
end
assert(m.line and not m.ownsUtterance(),'Finished speech holds its last page briefly')
m.update(.7);assert(m.line==nil)
`;

test('heard playback keeps each audible sentence on screen through a slow stream and a stall', () => {
  run(setup + speechHarness(playback({lead: 3})));
  run(setup + speechHarness(playback({lead: .05})));
  run(setup + speechHarness(playback({lead: .05, stall: [8.4, 10.4]})));
});

// October 8 regression: after a CET reload no voiced caption appeared. Each
// load restarted CRUIDs at 1; an ID the HUD once removed by data stays in its
// pending-hide list, so the next line spawned with that ID vanished at once.
test('caption IDs never repeat across CET reloads, and a native removal on spawn is re-shown', () => run(setup + `
style='dialogue'
local firstLoad=m.serial
assert(firstLoad>=100000,'IDs start from the load clock, not 1')
assert(m.show('Judy','First load.',judy,'201ULL'))
local used=m.serial
m.clear()
clock=clock+1
local reloaded=(function()convaiSubtitles=nil;return (function()${source}end)()end)()
assert(reloaded~=m and reloaded.serial>used,'A reload must not reuse an earlier load ID')
reloaded.configure({style=function()return style end})
assert(reloaded.install())
assert(reloaded.beginTimed('Judy','Second load, still talking.',4,judy,'201ULL'))
local line=reloaded.line
assert(line.id~=shown()[1].id)
-- The HUD removes the freshly spawned line (stale pending hide, or by data).
afterHooks['SubtitlesGameController.OnHideLine'](nil,{id=line.id});reloaded.update(.05)
assert(#shown()==3 and shown()[3].text==line.text and shown()[3].id~=line.id)
assert(reloaded.status().restores==1)
-- Our own hide arrives after M.line has moved on: never mistaken for a removal.
local current=reloaded.line
reloaded.syncTimed(4);reloaded.clear()
afterHooks['SubtitlesGameController.OnHideLine'](nil,{id=current.id});reloaded.update(.05)
assert(#shown()==3 and reloaded.line==nil)
`));

// October 8, second in-game report: the Cinematic line blinked as Judy ended
// a sentence on the same page. One native line per page: sentence revisions
// never repost it, a page change shows the new line before hiding the old one,
// and the line has an owner so the HUD's removal by data cannot take it.
const SAME_PAGE = ["Don't do that. ", "Don't start with the 'what ifs.' ", 'We did everything we could, V. ', 'We really did.'];
const SAME_PAGE_SENTENCES = [{text: SAME_PAGE[0].trim(), voiced: [[.1, .917]]}, {text: SAME_PAGE[1].trim(), voiced: [[1.7, 3]]},
  {text: SAME_PAGE[2].trim(), voiced: [[4.317, 5.967]]}, {text: SAME_PAGE[3].trim(), voiced: [[6.683, 7.617]]}];
test('sentence boundaries on one page never repost or hide the HUD line', () => {
  const text = SAME_PAGE.join('');
  const revisions = [];
  for (let buffered = .5; buffered < 7.76; buffered += .25)
    revisions.push({at: Math.max(.04, buffered - .3), captions: captionCues(text, {face: mouth(SAME_PAGE_SENTENCES, buffered, 7.76), duration: buffered, complete: false})});
  revisions.push({at: 7.7, captions: captionCues(text, {face: mouth(SAME_PAGE_SENTENCES, 7.76, 7.76), duration: 7.76, complete: true})});
  run(setup + `
style='dialogue'
assert(m.install())
local text=${lua(text)}
local revisions=${lua(revisions)}
assert(m.beginTimed('Judy',text,8.5,judy,'201ULL',revisions[1].captions))
local line=m.line
assert(line.speaker==judy and #m.pages==1)
for index,revision in ipairs(revisions)do
 assert(m.reviseTimed(text,index==#revisions and 7.76 or 8.5,revision.at,revision.captions))
 m.syncTimed(revision.at);m.update(.25)
 assert(m.line==line and #shown()==1 and #hidden()==0,'Sentence '..index..' reposted the line')
end
`);
});

test('a page change shows the next line first and hides the old one once it renders', () => run(setup + `
style='dialogue'
assert(m.install())
local receipt=afterHooks['SubtitleLineLogicController.SetLineData']
local captions={version=1,cues={{text=string.rep('a ',70)..'end. ',start=0,finish=4},{text=string.rep('b ',60)..'done.',start=4.5,finish=8}}}
assert(m.beginTimed('Judy',captions.cues[1].text..captions.cues[2].text,8,judy,'201ULL',captions))
local first=m.line
assert(#m.pages==2)
m.syncTimed(4.5)
local second=m.line
assert(second~=first and #shown()==2 and #hidden()==0,'The old page stays until the new one renders')
assert(events[#events].kind=='show' and m.status().retiring)
receipt(nil,{id='unrelated'});assert(#hidden()==0)
receipt(nil,{id=second.id});assert(#hidden()==1 and hidden()[1]==first.id and not m.status().retiring)
-- Without a receipt the old page goes after a quarter second.
m.clear()
assert(m.beginTimed('Judy',captions.cues[1].text..captions.cues[2].text,8,judy,'201ULL',captions))
local a=m.line;m.syncTimed(4.6);local b=m.line
m.update(.2);assert(not hidden()[3] or hidden()[3]~=a.id)
local before=#hidden();m.update(.1);assert(#hidden()==before+1 and hidden()[#hidden()]==a.id)
-- Cleanup takes both the current page and one still being replaced.
m.clear()
assert(m.beginTimed('Judy',captions.cues[1].text..captions.cues[2].text,8,judy,'201ULL',captions))
local c=m.line;m.syncTimed(4.6);local d=m.line
before=#hidden();m.clear()
assert(#hidden()==before+2 and m.line==nil and not m.status().retiring)
`));

test('V\'s live words are one dialogue line swapped in place as they grow, owned by no reply, replaced by the next caption', () => run(setup + `
 scnDialogLineData.new=function()return setmetatable({},{__newindex=function(t,k,v)assert(not(k=='speaker' and v==nil),'a nil speaker must never be assigned to the native line');rawset(t,k,v)end})end
 assert(m.showLive('V','what do'))
 assert(m.status().mode=='dialogue' and m.status().fallback==nil,'the cinematic dialogue HUD, not an overhead caption')
 local first=shown()[1]
 assert(first.speakerName=='V' and first.text=='what do' and first.speaker==player and first.type==scnDialogLineType.OwnerlessRegular)
 assert(not m.ownsUtterance(),'live words are not a reply')
 assert(m.showLive('V','what do you think'))
 local lines=shown()
 assert(#lines==2 and lines[2].text=='what do you think' and lines[2].id~=lines[1].id)
 assert(#hidden()==0,'the old line is hidden only after the new one rendered')
 m.update(.3);assert(#hidden()==1 and hidden()[1]==lines[1].id,'the swap retires exactly the previous line')
 assert(m.showLive('V','  what   do you think?  '))
 assert(shown()[3].text=='what do you think?')
 assert(not m.showLive('V','   ') and not m.showLive('V',nil) and not m.showLive('V',42))
 enabled=false;assert(not m.showLive('V','subtitles are off'),'caller falls back to a notice');enabled=true
 local count=#shown()
 m.show('Judy','The reply takes over.',judy,'201ULL')
 assert(#shown()==count+1 and shown()[count+1].speakerName=='Judy' and m.ownsUtterance(),'a reply caption replaces V and owns the utterance')
 assert(m.showLive('V','a second voice message') and not m.ownsUtterance())
 m.clear();assert(not m.live and not m.ownsUtterance())
 for _=1,30 do m.update(1) end
 assert(m.showLive('V','x'..string.rep('long ',60)))
 local last=shown()[#shown()];assert(#last.text<=200 and last.text:find('long$'),'only the newest page of long speech shows')
 for _=1,12 do m.update(1) end
 assert(not m.live and not m.ownsUtterance(),'with no update the caption expires like any other')
`));

test('V\'s live words are never a holocall or voice-only line, even right after a reply that was', () => run(setup + `
 scnDialogLineType.Holocall='holocall'
 m.voiceOnly,m.holocall,m.voiceProfile=true,true,'addon-skippy-gun'   -- what speech.lua leaves behind after such a reply
 assert(m.showLive('V','what do you think'))
 local line=shown()[1]
 assert(line.type==scnDialogLineType.OwnerlessRegular and line.speakerName=='V','plain dialogue line, no add-on tag')
 assert(m.status().fallback==nil and m.holocall==false and m.voiceOnly==false)
`));

const FONTS = `
local calls={}
local function walks()local r={};for _,c in ipairs(calls)do if type(c)=='table' then r[#r+1]=c end end;return r end
convaiUiFonts={version=2,
 replyCode=function(text)for i=1,#text do if text:byte(i)>=0xE3 then return 'ja' end end return false end,
 new=function()
  local count=0
  return {begin=function()calls[#calls+1]='begin' end,
   walk=function(root,code,budget)assert(root:GetName()~=nil and type(budget)=='table');count=count+1;calls[#calls+1]={'walk',code};return 1 end,
   count=function()return count end,clear=function()count=0;calls[#calls+1]='clear' end}
 end}
`;

test('a reply in Japanese styles its owned overhead caption once per render and puts the font back when it ends; a Latin reply touches nothing', () => run(setup + `${FONTS}
assert(m.install())
local after=afterHooks['ChatterLineLogicController.SetLineData']
local own=surface('201ULL')
assert(m.show('Judy','Hello, I am still here.',judy,'201ULL'))
assert(m.fontCode==nil)
after(wrapController(own),shown()[1])
assert(#walks()==0,'a Latin caption costs no font work')
m.clear()
assert(#walks()==0 and m.fontCode==nil)
calls={}
assert(m.show('Judy','こんにちは、V。',judy,'201ULL'))
assert(m.fontCode=='ja')
local line=shown()[2]
after(wrapController(own),line)
assert(#walks()==1 and walks()[1][2]=='reply','the game drew the caption: each of its texts gets its own family')
assert(m.status().rendered.text=='こんにちは、V。')
plain(m.status())
m.clear()
assert(#walks()==2 and walks()[2][2]==false,'the caption widgets are restored when the reply ends')
assert(calls[#calls]=='clear' and m.fontCode==nil and m.fontController==nil)
-- A death or detach clears without any native call.
calls={}
assert(m.show('Judy','こんにちは、V。',judy,'201ULL'));after(wrapController(own),shown()[3])
local before=nativeReads
m.abandon()
assert(nativeReads==before and m.fontCode==nil and m.fontController==nil and calls[#calls]=='clear')
`));

test('in the dialogue HUD only the exact line of a Japanese reply is styled, and a revision that turns Japanese is noticed once', () => run(setup + `${FONTS}
style='dialogue'
assert(m.install())
local receipt=afterHooks['SubtitleLineLogicController.SetLineData']
assert(m.show('Judy','こんにちは、V。',judy,'201ULL'))
local mine=m.line
local controller=wrapController(surface('201ULL'))
receipt(controller,{id='unrelated'})
assert(#walks()==0,'a native line is never touched')
receipt(controller,{id=mine.id})
assert(#walks()==1 and walks()[1][2]=='reply')
m.clear()
calls={}
assert(m.beginTimed('Judy','Sure, I will drive.',5,judy,'201ULL'))
assert(m.fontCode==nil)
receipt(controller,{id=m.line.id})
assert(#walks()==0)
assert(m.reviseTimed('Sure, I will drive. 了解です。',5,1))
assert(m.fontCode=='ja','the script is re-decided when the text of a reply grows')
`));


test('a timed page whose driver went away is cleared by the safety timer; a driver that keeps syncing, and a menu, never lose it', () => run(setup + `
style='dialogue'
assert(m.beginTimed('Judy','A reply that is still being heard.',6,judy,'201ULL'))
local first=m.line.id
-- A live driver: a sync every 40 ms for far longer than the limit keeps the page.
for _=1,400 do m.syncTimed(1);m.update(.04) end
assert(m.line and m.line.id==first and m.timed,'a driver that keeps syncing keeps its page')
-- A menu reports no time and, at the limit, only holds the page.
menu=true;for _=1,40 do m.update(.25) end;assert(m.line and m.timed,'a menu holds the page');menu=false
m.update(120);assert(m.line and m.timed,'one long hitch is not a dead driver');m.syncTimed(1)
-- The driver goes away (speech abandoned, state lost): nothing syncs any more.
for _=1,30 do m.update(.25) end;assert(m.line and m.timed,'not yet at the limit')
for _=1,3 do m.update(.25) end
assert(m.line==nil and not m.timed and not m.ownsUtterance(),'the page is removed')
assert(hidden()[#hidden()]==first,'the native line is hidden')
assert(m.stalledClears==1)
-- A new utterance starts its own timer.
assert(m.beginTimed('Judy','Next reply.',2,judy,'201ULL'))
for _=1,28 do m.update(.25) end;assert(m.line,'the timer restarted with the new utterance')
`));
