import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import fengari from 'fengari';

const source = readFileSync(new URL('../mod/phone-chat-style.lua', import.meta.url), 'utf8');
const composerSource = readFileSync(new URL('../mod/composer-input.lua', import.meta.url), 'utf8');
function runLua(program) {
  const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;
  const vm = lauxlib.luaL_newstate(); lualib.luaL_openlibs(vm);
  const result = lauxlib.luaL_dostring(vm, to_luastring(program));
  const error = result === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(vm, -1));
  lua.lua_close(vm); assert.equal(result, lua.LUA_OK, error);
}
const setup = `
-- CET CNames are opaque hashes; Lua-created names need not have a reverse string.
local names = {}
CName = {new=function(s) if not names[s] then names[s]={} end; return names[s] end}
NameToString = function() return '' end
Vector2 = {new=function(value) assert(type(value)=='table'); return value end}
inkMargin = {new=function(value) assert(type(value)=='table'); return value end}
local function widget(name)
  local w={name=CName.new(name),visible=true,children={},state=CName.new('Default')}
  function w:GetName() return self.name end
  function w:SetName(value) self.name=value end
  function w:GetState() return self.state end
  function w:SetState(value) self.state=value end
  function w:GetNumChildren() return #self.children end
  function w:GetWidgetByIndex(i) return self.children[i+1] end
  function w:Reparent(parent) self.parent=parent; table.insert(parent.children,self) end
  function w:GetParentWidget() return self.parent end
  function w:IsVisible() return self.visible end
  function w:SetVisible(value) self.visible=value end
  function w:SetSize(value) self.size=value end
  function w:SetAffectsLayoutWhenHidden(value) self.affectsLayout=value end
  function w:GetController() return self.controller end
  function w:GetText() return self.text end
  return w
end
inkCanvas={new=function() return widget('new') end}
local observers, beforeObservers, overrides = {}, {}, {}
ObserveAfter=function(class,method,fn) observers[class..'.'..method]=fn end
ObserveBefore=function(class,method,fn) beforeObservers[class..'.'..method]=fn end
Override=function(class,method,fn) overrides[class..'.'..method]=fn end
local m=(function() ${source} end)()
m.install()
local root, options = widget('dialog'), widget('ReplyOptions')
options:Reparent(root)
-- Logical reply arrays can be empty while recycled renderer children survive.
widget('questReply1'):Reparent(options); widget('questReply2'):Reparent(options)
local dialog={GetRootWidget=function() return root end}
local mode=observers['MessengerDialogViewController.ConvaiChatMode']
local activate=overrides['MessengerDialogViewController.ActivateReply']
local activated=0
local function nativeReply() activated=activated+1 end
`;

test('Chat hides stale quest choices and blocks queued activation; Messages restores its own choices', () => runLua(setup + `
mode(dialog,false); activate(dialog,{},nativeReply)
assert(options.visible and activated==1)
mode(dialog,true)
assert(not options.visible and options.affectsLayout==false and #options.children==2)
activate(dialog,{},nativeReply); assert(activated==1)
-- A late recycled-list callback must not bring the quest choices back.
options.visible=true
observers['MessengerDialogViewController.UpdateData'](dialog)
assert(not options.visible)
mode(dialog,false); assert(options.visible)
activate(dialog,{},nativeReply); assert(activated==2)
-- Once native mode owns the panel again, an extra callback cannot unhide it.
options.visible=false; mode(dialog,false); assert(not options.visible)
`));

test('mode restoration preserves an originally hidden quest panel across repeated Chat paints', () => runLua(setup + `
options.visible=false
mode(dialog,true); mode(dialog,true)
assert(m.isChat(dialog))
mode(dialog,false)
assert(not options.visible and not m.isChat(dialog))
`));

test('empty Chat data flushes recycled rows while populated history and native Messages keep their data', () => runLua(setup + `
local messages,choices=widget('MessagesList'),widget('ChoicesList')
messages:Reparent(root);choices:Reparent(options)
local function list(owner)
  local c={data={},refreshes=0}
  function c:Size()return #self.data end
  function c:Clear(immediate)
    if immediate then self.data={};self:Refresh() else self.pendingClear=true end
  end
  function c:Refresh()self.refreshes=self.refreshes+1;owner.children={}
    for _,row in ipairs(self.data)do widget(row):Reparent(owner)end
  end
  owner.controller=c;return c
end
local messageList,choiceList=list(messages),list(choices)
messageList.data={'Native incoming SMS'};choiceList.data={'Native reply'}
widget('Native incoming SMS'):Reparent(messages);widget('Native reply'):Reparent(choices)
mode(dialog,true)
assert(#messages.children==0 and #choices.children==0,'Empty AI history retained another conversation')
beforeObservers['MessengerDialogViewController.UpdateData'](dialog)
messageList.data={'Current AI message'};messageList:Refresh()
observers['MessengerDialogViewController.UpdateData'](dialog)
assert(#messages.children==1 and messageList.data[1]=='Current AI message')
-- Native deferred list operations remain entirely under the game's control.
mode(dialog,false);messageList.data={};widget('Native preview'):Reparent(messages)
local before=messageList.refreshes
beforeObservers['MessengerDialogViewController.UpdateData'](dialog)
observers['MessengerDialogViewController.UpdateData'](dialog)
assert(messageList.refreshes==before and #messages.children==2)
`));

test('queued native journal and typing events cannot update Chat and still reach native Messages', () => runLua(setup + `
local calls=0
local function original(...)calls=calls+1;return 'forwarded'end
local routes={
  function()return overrides['MessengerDialogViewController.OnJournalUpdate'](dialog,1,'Message',2,3,original)end,
  function()return overrides['MessengerDialogViewController.OnJournalUpdateDelayed'](dialog,1,'Message',2,3,.4,original)end,
  function()return overrides['MessengerDialogViewController.OnDelayedJournalUpdate'](dialog,{},original)end}
local popupRoot=widget('popup');root:SetName(CName.new('wrapper'));root:Reparent(popupRoot);root.controller=dialog
local popup={GetRootWidget=function()return popupRoot end}
routes[#routes+1]=function()return overrides['PhoneMessagePopupGameController.OnDelayedDotsAnimation'](popup,{},original)end
mode(dialog,true)
for _,route in ipairs(routes)do assert(route()==false)end
assert(calls==0)
mode(dialog,false)
for _,route in ipairs(routes)do assert(route()=='forwarded')end
assert(calls==4)
`));

test('composer moves only the idle hint into the placeholder and preserves drafts and error status', () => runLua(setup + `
local panel=widget('convaiPhoneComposer'); panel:Reparent(root)
local input=widget('input'); input:Reparent(panel)
local hint=widget('convaiPhoneComposerHint'); hint:Reparent(panel)
hint.text='ENTER  Write / Send   /   ESC  Stop typing'
local focused, contact = false, 'judy'
input.controller={IsFocused=function() return focused end, GetRootWidget=function() return input end,
  SetDefaultText=function(_,value) input.placeholder=value end,
  SetText=function() error('A style change must not replace the draft') end}
local popup={GetRootWidget=function() return root end, ConvaiChatContact=function() return contact end}
m.composer(popup)
assert(input.placeholder=='Press Enter to write  /  Esc to stop typing' and not hint.visible)
focused=true; m.composer(popup,'Unable to connect. Try again.')
assert(input.placeholder:find('Enter to send') and hint.visible)
contact=''; hint.visible=true; m.composer(popup,'')
assert(hint.visible) -- Native Messages isn't our composer.
`));

test('inherited focus hooks leave world chat, manager search and detached inputs untouched', () => runLua(setup + `
for _, name in ipairs({'TextInput', 'managerSearch', 'input'}) do
  local input=widget(name)
  if name~='input' then input:Reparent(root) end
  local original='Original prompt for '..name
  input.placeholder=original
  input.controller={IsFocused=function() return true end, GetRootWidget=function() return input end,
    SetDefaultText=function(_,value) input.placeholder=value end,
    SetText=function() error('A style hook must not replace the draft') end}
  for _, method in ipairs({'OnFocusReceived','OnFocusLost'}) do
    observers['CyberpunkConvai.ConvaiPhoneChatInput.'..method](input.controller)
    assert(input.placeholder==original, name..' inherited the phone hint')
    assert(m.lastError==nil, m.lastError)
  end
end
-- The same inherited callback still updates the owned phone composer.
local panel=widget('convaiPhoneComposer'); panel:Reparent(root)
local input=widget('input'); input:Reparent(panel)
local focused=true
input.controller={IsFocused=function() return focused end, GetRootWidget=function() return input end,
  SetDefaultText=function(_,value) input.placeholder=value end}
observers['CyberpunkConvai.ConvaiPhoneChatInput.OnFocusReceived'](input.controller)
assert(input.placeholder:find('Enter to send'))
focused=false
observers['CyberpunkConvai.ConvaiPhoneChatInput.OnFocusLost'](input.controller)
assert(input.placeholder=='Press Enter to write  /  Esc to stop typing')
assert(m.lastError==nil, m.lastError)
`));

test('world composer restores its own prompt without editing drafts or other notifications', () => runLua(setup + `
textLetterCase={OriginalCase=3}
local data={title='TALK TO JUDY',message='Type your message to the character.'}
local placeholder='Press Enter to write  /  Esc to stop typing'
local letterCase=1
local input={SetDefaultText=function(_,value) placeholder=value end,
  GetDefaultText=function() return placeholder end,
  SetLetterCase=function(_,value) letterCase=value end, GetLetterCase=function() return letterCase end,
  SetText=function() error('Do not replace the draft') end}
local notification={m_textInput=input,GetRootWidget=function() return {
  GetUserData=function() return data end} end}
local fix=(function() ${composerSource} end)()
fix.apply(notification)
assert(placeholder==data.message and letterCase==textLetterCase.OriginalCase)
assert(fix.lastPlaceholder==data.message)
data={title='Other mod',message='Type your message to the character.'}
placeholder='Other prompt'; letterCase=1
fix.apply(notification)
assert(placeholder=='Other prompt' and letterCase==1)
data={title='TALK TO SOMEBODY',message='Unrelated dialog'}
fix.apply(notification)
assert(placeholder=='Other prompt' and letterCase==1)
`));
