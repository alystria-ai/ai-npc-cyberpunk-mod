import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import fengari from 'fengari';

const source = readFileSync(new URL('../mod/phone-chat-style.lua', import.meta.url), 'utf8');
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
  function w:Reparent(parent) table.insert(parent.children,self) end
  function w:IsVisible() return self.visible end
  function w:SetVisible(value) self.visible=value end
  function w:SetSize(value) self.size=value end
  function w:SetAffectsLayoutWhenHidden(value) self.affectsLayout=value end
  function w:GetController() return self.controller end
  function w:GetText() return self.text end
  return w
end
inkCanvas={new=function() return widget('new') end}
local observers, overrides = {}, {}
ObserveAfter=function(class,method,fn) observers[class..'.'..method]=fn end
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
