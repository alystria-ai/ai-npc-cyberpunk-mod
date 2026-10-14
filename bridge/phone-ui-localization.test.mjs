import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import fengari from 'fengari';

const phone = readFileSync(new URL('../mod/phone-chat-style.lua', import.meta.url), 'utf8');
const composer = readFileSync(new URL('../mod/composer-input.lua', import.meta.url), 'utf8');
const fonts = readFileSync(new URL('../mod/ui-fonts.lua', import.meta.url), 'utf8');

function runLua(program) {
  const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;
  const vm = lauxlib.luaL_newstate(); lualib.luaL_openlibs(vm);
  const result = lauxlib.luaL_dostring(vm, to_luastring(program));
  const error = result === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(vm, -1));
  lua.lua_close(vm); assert.equal(result, lua.LUA_OK, error);
}

const setup = `
local language, generation, calls = 'fr', 1, {}
local translations = {
  fr={['TALK TO {character}']='PARLER À {character}',
    ['Type your message to the character.']='Écrivez votre message au personnage.',
    ['CHAT']='DISCUSSION',['Chat']='Discuter',
    ['Press Enter to write  /  Esc to stop typing']='Entrée : écrire / Échap : arrêter',
    ['Write a message...  /  Enter to send  /  Esc to stop typing']='Écrire... / Entrée : envoyer / Échap : arrêter',
    ['Message sent. Waiting for reply.']='Message envoyé. En attente de réponse.',
    ['Type a message first.']='Écrivez un message.',
    ['INVITE QUEUED - CLOSE PHONE']='INVITATION EN ATTENTE - FERMEZ LE TÉLÉPHONE',
    ['DISMISS QUEUED - CLOSE PHONE']='DÉPART EN ATTENTE - FERMEZ LE TÉLÉPHONE',
    ['CLOSE PHONE TO CONTINUE']='FERMEZ LE TÉLÉPHONE POUR CONTINUER',
    ['COMPANION UNAVAILABLE']='COMPAGNON INDISPONIBLE',
    ['This contact has no companion mapping yet.']='Aucun compagnon associé à ce contact.',
    ['Close the phone to finish the pending companion requests.']='Fermez le téléphone pour terminer les demandes.',
    ['{name}: invite queued.']='{name} : invitation en attente.',
    ['{name}: dismiss queued.']='{name} : départ en attente.'},
  ja={['TALK TO {character}']='{character}と話す',
    ['Type your message to the character.']='キャラクターへのメッセージを入力してください。',
    ['CHAT']='チャット',['Chat']='チャットする',
    ['Press Enter to write  /  Esc to stop typing']='Enterで入力 / Escで終了',
    ['Write a message...  /  Enter to send  /  Esc to stop typing']='メッセージ… / Enterで送信 / Escで終了',
    ['Message sent. Waiting for reply.']='送信済み。返信を待っています。',
    ['Type a message first.']='メッセージを入力してください。',
    ['{name}: invite queued.']='{name}：招待待機中。',
    ['{name}: dismiss queued.']='{name}：解散待機中。'},
}
local ui={revision=function()return generation end,current=function()return language end}
function ui.t(source,args)
  calls[#calls+1]=source
  local value=(translations[language] or {})[source] or source
  return (value:gsub('{([%w_]+)}',function(key)return args and args[key] or '{'..key..'}'end))
end
dofile=function(path)assert(path=='ui-locale.lua');return ui end
local names={}
CName={new=function(value)if not names[value]then names[value]={source=value}end;return names[value]end}
NameToString=function(value)return value.source end
textLetterCase={OriginalCase=3}
Vector2={new=function(value)return value end}
inkMargin={new=function(value)return value end}
inkEHorizontalAlign={Left=1};inkEVerticalAlign={Top=1}
local widgetId=0
local textNames={title=true,message=true,text=true,shadow=true,txtValue=true,
  convaiPhoneComposerHint=true,convaiActionFeedback=true,acceptLabel=true,label=true,convaiChatTabLabel=true}
local function widget(name)
  widgetId=widgetId+1
  local w={id=widgetId,name=CName.new(name),children={},visible=true,text='',state=CName.new('Default'),tint={Red=1,Green=0,Blue=0},
    fontText=textNames[name]==true,fontFamily={path='native-original.inkfontfamily',hash='original'},fontStyle=CName.new('Regular'),fontLock=false,fontWrites=0,fontStyleWrites=0,fontSizeWrites=0}
  function w:GetName()return self.name end
  function w:SetName(value)self.name=value end
  function w:GetParentWidget()return self.parent end
  function w:GetNumChildren()return #self.children end
  function w:GetWidgetByIndex(index)return self.children[index+1]end
  function w:Reparent(parent)
    if self.parent then for i,child in ipairs(self.parent.children)do if child==self then table.remove(self.parent.children,i);break end end end
    self.parent=parent;parent.children[#parent.children+1]=self
  end
  function w:GetController()return self.controller end
  function w:IsA(class)return self.fontText and class=='inkTextWidget'end
  function w:GetState()return self.state end
  function w:SetState(value)self.state=value end
  function w:GetText()return self.text end
  function w:SetText(value)self.text=value end
  function w:GetTintColor()return self.tint end
  function w:SetTintColor(value)self.tint=value end
  function w:SetOpacity(value)self.opacity=value end
  function w:IsVisible()return self.visible end
  function w:SetVisible(value)self.visible=value end
  function w:SetSize(value)self.size=value end
  function w:SetMargin(value)self.margin=value;self.marginWrites=(self.marginWrites or 0)+1 end
  function w:GetMargin()local m=self.margin or {};return {left=m.left or 0,top=m.top or 0,right=m.right or 0,bottom=m.bottom or 0}end
  function w:SetFitToContent(value)self.fit=value end
  function w:SetHAlign(value)self.hAlign=value end
  function w:SetVAlign(value)self.vAlign=value end
  function w:SetFontStyle(value)self.fontStyle=value;self.fontStyleWrites=self.fontStyleWrites+1 end
  function w:GetFontStyle()return self.fontStyle end
  function w:SetFontSize(value)self.fontSize=value;self.fontSizeWrites=self.fontSizeWrites+1 end
  function w:SetFontFamily(value,style)
    if self.failFont then error('Setter failed')end
    self.fontWrites=self.fontWrites+1;self.fontFamily={path=value,hash=value};self.fontStyle=style
  end
  function w:GetLockFontInGame()return self.fontLock end
  function w:SetLockFontInGame(value)self.fontLock=value end
  function w:SetAffectsLayoutWhenHidden(value)self.affectsLayout=value end
  return w
end
inkCanvas={new=function()return widget('new')end}
inkRectangle={new=function()local w=widget('new');function w:SetInteractive(value)self.interactive=value end;return w end}
inkTextRef={SetText=function(ref,value)ref:SetText(value)end}
inkWidgetRef={Get=function(ref)return ref end}
local observers,overrides={},{}
ObserveAfter=function(class,method,fn)observers[class..'.'..method]=fn end
ObserveBefore=function()end
Override=function(class,method,fn)overrides[class..'.'..method]=fn end
local function input(owner)
  local root=widget('input');if owner then root:Reparent(owner)end
  local c={focused=false,draft='Hey Judy, mixed Case 日本語',case=1,placeholder=''}
  function c:GetRootWidget()return root end
  function c:GetText()return self.draft end
  function c:IsFocused()return self.focused end
  function c:SetDefaultText(value)self.placeholder=value end
  function c:GetDefaultText()return self.placeholder end
  function c:SetLetterCase(value)self.case=value end
  function c:GetLetterCase()return self.case end
  function c:SetText()error('localization changed the draft')end
  root.controller=c;return c,root
end
local function notification(data)
  local c,root=input()
  local title,message=widget('title'),widget('message')
  function root:GetUserData(class)assert(class=='GenericMessageNotificationData');return data end
  local n={m_textInput=c,m_message=message}
  function n:GetRootWidget()return root end
  function n:GetChildWidgetByPath(path)
    if path==CName.new('notification/main/inkVerticalPanelWidget18/message')then return message end
    assert(path==CName.new('notification/main/inkVerticalPanelWidget18/title'));return title
  end
  function n:IsA(class)return class=='GenericMessageNotification'end
  return n,c,title,message
end
local function popup(contact)
  local root,panel,hint=widget('popup'),widget('convaiPhoneComposer'),widget('convaiPhoneComposerHint')
  panel:Reparent(root);hint:Reparent(panel)
  hint.text='ENTER  Write / Send   /   ESC  Stop typing'
  local c=input(panel)
  local path=widget('messagesPath');path:Reparent(root)
  local label=widget('txtValue');label.text='CHAT';label:Reparent(path)
  local n={contact=contact,m_messagesPath=path}
  function n:GetRootWidget()return root end
  function n:ConvaiChatContact()return self.contact end
  function n:GetClassName()return CName.new('PhoneMessagePopupGameController')end
  return n,c,hint,label,panel
end
local function measuredInput(c)
  local root=c:GetRootWidget()
  local viewport=widget('viewport');viewport:Reparent(root)
  local visible=widget('text');visible:Reparent(viewport)
  visible.controller={GetRootWidget=function()return visible end,IsEmpty=function()return c.draft==''end}
  local shadow=widget('shadow');shadow:SetVisible(false);shadow:Reparent(root)
  local measurer={measuring=false,target='',length=0}
  function measurer:IsMeasuring()return self.measuring end
  function measurer:GetTargetText()return self.target end
  function measurer:GetTargetLength()return self.length end
  shadow.controller=measurer
  return visible,shadow,measurer
end
local function selector()
  local root,parent=widget('selectorRoot'),widget('tabs');parent:Reparent(root)
  local messages,contacts,arrow,thread,tab=widget('messagesTab'),widget('callsTab'),widget('arrow'),widget('thread'),widget('convaiChatTab')
  for _,w in ipairs({messages,contacts,arrow,thread,tab})do w:Reparent(parent)end
  local base=widget('line');base:Reparent(contacts)
  local activePanel,active=widget('linePanel'),widget('line');activePanel:Reparent(root);active:Reparent(activePanel)
  active.tint={Red=0,Green=1,Blue=1}
  local icon,label=widget('glyph'),widget('label');icon:Reparent(tab);label:Reparent(tab)
  local c={GetRootWidget=function()return root end,
    GetClassName=function()return CName.new('PhoneDialerSelectionController')end,
    ScrollTo=function()error('Localization navigated the phone')end}
  root.controller=c
  return root,c,label
end
local function enableNativeFonts()
  convaiUiLocale=ui
  CalcSeed=function(w)return w.id end
  ResRef={ToString=function(ref)return ref.path end}
  convaiUiFonts=(function()${fonts}end)()
end
`;

test('world composer localizes presentation without changing ownership, name, draft or letter case', () => runLua(setup + `
local m=(function()${composer}end)()
local data={title='TALK TO Judy {A}',message='Type your message to the character.'}
local n,c,title,message=notification(data)
m.apply(n)
assert(title.text=='PARLER À Judy {A}' and c.placeholder=='')
assert(message.text=='' and message.visible==false and message.affectsLayout==false and c.case==textLetterCase.OriginalCase)
assert(data.title=='TALK TO Judy {A}' and data.message=='Type your message to the character.')
assert(c.draft=='Hey Judy, mixed Case 日本語')
assert(title.margin.bottom==44 and title.margin.left==0 and title.margin.top==0,'title keeps a gap above the box')
language='ja';generation=2;m.apply(n)
assert(title.text=='Judy {A}と話す' and c.placeholder=='' and message.text=='' and message.visible==false)
for _,key in ipairs(calls)do assert(key~='Judy {A}' and key~=c.draft)end
assert(title.margin.bottom==44 and title.marginWrites==1,'re-applying does not stack the gap')
assert(m.lastError==nil,m.lastError)
`));

test('world composer pads the typed text from the box edge once and never lowers a larger native margin',()=>runLua(setup+`
local m=(function()${composer}end)()
local data={title='TALK TO Judy',message='Type your message to the character.'}
local n,c,title=notification(data)
local visible=measuredInput(c)
local holder=visible:GetParentWidget()
assert(holder.margin==nil)
m.apply(n);m.apply(n)
assert(holder.margin.left==20 and holder.margin.top==0 and holder.marginWrites==1,'text padded once')
assert(c:GetRootWidget().margin==nil,'the box itself is not moved')
holder.margin={left=60,top=3,right=0,bottom=0};holder.marginWrites=0;m.apply(n)
assert(holder.margin.left==60 and holder.marginWrites==0,'a larger native padding stays')
title.margin={left=0,top=0,right=0,bottom=90};title.marginWrites=0;m.apply(n)
assert(title.margin.bottom==90 and title.marginWrites==0)
assert(m.lastError==nil,m.lastError)
`));

test('world message uses its inspected native path when the compiled text ref is private',()=>runLua(setup+`
enableNativeFonts();language='ja'
local m=(function()${composer}end)()
local data={title='TALK TO Judy',message='Type your message to the character.'}
local n,c,title,message=notification(data);n.m_message=nil
m.apply(n);m.applyFonts(n)
assert(message.text=='' and message.visible==false and message.fontFamily.path==convaiUiFonts.family('ja'))
assert(data.message=='Type your message to the character.' and c.draft=='Hey Judy, mixed Case 日本語')
`));

test('unresolved native message path returning the root canvas cannot suppress its actual text child',()=>runLua(setup+`
enableNativeFonts();language='ja'
local m=(function()${composer}end)()
local data={title='TALK TO Judy',message='Type your message to the character.'}
local n,c,title,message=notification(data);n.m_message=nil
message:Reparent(n:GetRootWidget())
function n:GetChildWidgetByPath(path)
  if path==CName.new('notification/main/inkVerticalPanelWidget18/title')then return title end
  return self:GetRootWidget()
end
m.apply(n);m.applyFonts(n)
assert(message.text=='' and message.visible==false and message.fontFamily.path==convaiUiFonts.family('ja'))
assert(c.draft=='Hey Judy, mixed Case 日本語' and m.lastError==nil,m.lastError)
`));

test('world localization rejects unrelated notifications and malformed titles before touching native widgets', () => runLua(setup + `
local m=(function()${composer}end)()
for _,data in ipairs({{title='Other mod',message='Type your message to the character.'},
  {title='TALK TO Somebody',message='Unrelated dialog'},
  {title=false,message='Type your message to the character.'},{message='Type your message to the character.'}})do
  local n,c,title,message=notification(data);m.apply(n)
  assert(c.case==1 and c.placeholder=='' and title.text=='' and message.text=='')
end
assert(#calls==0)
`));

test('world refresh updates only current owned composers with a bounded controller scan', () => runLua(setup + `
local m=(function()${composer}end)()
local data={title='TALK TO Johnny Silverhand',message='Type your message to the character.'}
local n,c,title=notification(data)
local checked=0
local unrelated={IsA=function()checked=checked+1;return false end}
local controllers={n};for i=2,540 do controllers[i]=unrelated end
Game={GetInkSystem=function()return{GetLayers=function()return{{GetGameControllers=function()return controllers end}}end}end}
m.refresh();assert(title.text=='PARLER À Johnny Silverhand' and checked==511)
language='ja';generation=2;m.refresh();assert(title.text=='Johnny Silverhandと話す')
assert(data.title=='TALK TO Johnny Silverhand' and c.draft=='Hey Judy, mixed Case 日本語')
`));

test('world composer hides the full-screen backdrop and blur but keeps the dialog and input', () => runLua(setup + `
local m=(function()${composer}end)()
local data={title='TALK TO Judy',message='Type your message to the character.'}
local n,c=notification(data)
local root=n:GetRootWidget()
local shadow,gradient,fader,dialog=widget('Shadow'),widget('bg1'),widget('fader'),widget('notification')
for _,w in ipairs({dialog,shadow,gradient,fader})do w:Reparent(root)end
local nested=widget('bg1');nested:Reparent(dialog)
local blur={}
PopupStateUtils={SetBackgroundBlur=function(controller,on)blur[#blur+1]={controller,on}end}
m.apply(n)
assert(not shadow.visible and not gradient.visible and not fader.visible,'backdrop widgets stay visible')
assert(dialog.visible and nested.visible and c:GetRootWidget().visible,'dialog widgets must not be hidden')
assert(#blur==1 and blur[1][1]==n and blur[1][2]==false and m.lastBlurRelease=='ok')
assert(c.draft=='Hey Judy, mixed Case 日本語' and m.lastBackdropError==nil)
-- The native intro can show a widget again after OnInitialize; update() re-hides
-- it for a short window only.
local scans=0
Game={GetInkSystem=function()scans=scans+1;return{GetLayers=function()return{{GetGameControllers=function()return{n}end}}end}end}
m.update();scans=0;m.backdropAge=0;shadow:SetVisible(true)   -- first frame performs the queued font refresh
for _=1,19 do m.update()end
assert(scans==0 and shadow.visible,'idle frames must not traverse native controllers')
m.update()
assert(scans==1 and not shadow.visible,'update did not re-hide the backdrop')
shadow:SetVisible(true)
for _=1,200 do m.update()end
assert(scans==2 and not shadow.visible and m.backdropAge==nil,'re-assertion window must end after two scans')
shadow:SetVisible(true);m.update()
assert(shadow.visible and scans==2)
`));

test('world composer docks the dialog as a bottom chat bar from the live root height', () => runLua(setup + `
local m=(function()${composer}end)()
inkEAnchor={BottomCenter='BottomCenter'}
function Vector2.new(v)return v end
local data={title='TALK TO Judy',message='Type your message to the character.'}
local n,c=notification(data)
local root=n:GetRootWidget()
local dialog=widget('notification');dialog:Reparent(root)
function dialog:SetAnchor(v)self.anchor=v end
function dialog:SetAnchorPoint(v)self.anchorPoint=v end
local inner=widget('notification');inner:Reparent(dialog)
for _,height in ipairs({1080,1440,2160,2880})do
  root.size={X=height*16/9,Y=height}
  function root:GetSize()return self.size end
  m.apply(n)
  assert(dialog.anchor=='BottomCenter' and dialog.anchorPoint.X==.5 and dialog.anchorPoint.Y==1)
  local gap=dialog.margin.bottom
  assert(math.abs(gap/height-.14)<.001 and dialog.margin.top==0 and dialog.margin.left==0,gap)
  assert(m.lastPlacement.height==height)
end
assert(inner.anchor==nil and inner.margin==nil,'only the dialog root is re-anchored')
-- An ultrawide root changes width only; the vertical placement stays proportional.
root.size={X=5120,Y=1440};m.apply(n);assert(dialog.margin.bottom==202)
-- An unreadable size falls back to the 2160 reference instead of failing.
function root:GetSize()error('no size')end
m.apply(n);assert(dialog.margin.bottom==302 and m.lastPlacementError==nil,m.lastPlacementError)
assert(c.draft=='Hey Judy, mixed Case 日本語' and not c.focusChanged)
`));

test('world composer backdrop handling skips unrelated notifications and survives a missing blur API', () => runLua(setup + `
local m=(function()${composer}end)()
local n=notification({title='Other mod',message='Type your message to the character.'})
local fader=widget('fader');fader:Reparent(n:GetRootWidget())
m.apply(n);assert(fader.visible and m.backdropAge==nil)
local own=notification({title='TALK TO Judy',message='Type your message to the character.'})
local ownFader=widget('fader');ownFader:Reparent(own:GetRootWidget())
PopupStateUtils=nil
m.apply(own)
assert(not ownFader.visible and m.lastBlurRelease~='ok' and m.lastError==nil,m.lastError)
`));

test('phone placeholders use the selected UI language and retain cyan style and actual text', () => runLua(setup + `
local m=(function()${phone}end)()
local n,c,hint,label,panel=popup('judy')
local focus=widget('focus');focus.tint={Red=0,Green=1,Blue=1};focus:Reparent(panel)
local glyph=widget('text');glyph:Reparent(c:GetRootWidget())
glyph.controller={GetRootWidget=function()return glyph end,IsEmpty=function()return true end}
m.composer(n)
m.composerFonts(n)
assert(c.placeholder==translations.fr['Press Enter to write  /  Esc to stop typing'])
assert(glyph.tint==focus.tint and glyph.opacity==.75 and not hint.visible)
c.focused=true;m.input(c)
assert(c.placeholder==translations.fr['Write a message...  /  Enter to send  /  Esc to stop typing'])
language='ja';generation=2;m.input(c)
assert(c.placeholder==translations.ja['Write a message...  /  Enter to send  /  Esc to stop typing'])
assert(c.draft=='Hey Judy, mixed Case 日本語' and label.text=='DISCUSSION')
-- Inherited Codeware callbacks must leave unrelated inputs alone.
local other=input();other.placeholder='Other UI';m.input(other);assert(other.placeholder=='Other UI')
`));

test('phone translates only the authored status allowlist and can repaint it after a language change', () => runLua(setup + `
local m=(function()${phone}end)()
local n,c,hint=popup('judy')
local status='Message sent. Waiting for reply.'
m.composer(n,status)
assert(hint.text==translations.fr[status] and hint.visible)
language='ja';generation=2;m.composer(n)
assert(hint.text==translations.ja[status] and hint.visible)
assert(m.statusSource==status and c.draft=='Hey Judy, mixed Case 日本語')
local external='Provider detail / do not translate / Judy'
hint.text=external;m.composer(n,external)
assert(hint.text==external and hint.visible and m.statusSource==nil)
for _,key in ipairs(calls)do assert(key~=external and key~=c.draft and key~='judy')end
local before=#calls;n.contact='';m.composer(n,status)
assert(#calls==before and hint.text==external)
`));

test('Chat action and breadcrumb translation are gated by native ownership and restore through the game', () => runLua(setup + `
local m=(function()${phone}end)();m.install()
local action={m_acceptButtonLabel=widget('acceptLabel')}
action.m_acceptButtonLabel.text='Native call'
local hook=observers['PhoneDialerLogicController.RefreshInputHints']
hook(action,{convaiChat=false});assert(action.m_acceptButtonLabel.text=='Native call')
hook(action,{convaiChat=true});assert(action.m_acceptButtonLabel.text=='Native call')
m.action(action,{convaiChat=true},true);assert(action.m_acceptButtonLabel.text=='Discuter')
-- On returning to Contacts, native RefreshInputHints has restored its own label.
action.m_acceptButtonLabel.text='Native call';hook(action,{convaiChat=false})
assert(action.m_acceptButtonLabel.text=='Native call')
local n,_,_,label=popup('judy')
local pathHook=observers['PhoneMessagePopupGameController.ConvaiChatPath']
pathHook(n,true);assert(label.text=='CHAT')
m.path(n,true,true);assert(label.text=='DISCUSSION')
label.text='Native messages';pathHook(n,false);assert(label.text=='Native messages')
assert(m.lastError==nil,m.lastError)
`));

test('Chat tab changes only its owned label while preserving IDs, selection and adjacent native tabs', () => runLua(setup + `
local m=(function()${phone}end)()
local root,parent=widget('selectorRoot'),widget('tabs');parent:Reparent(root)
local messages,contacts,arrow,thread,tab=widget('messagesTab'),widget('callsTab'),widget('arrow'),widget('thread'),widget('convaiChatTab')
for _,w in ipairs({messages,contacts,arrow,thread,tab})do w:Reparent(parent)end
messages.text='Native messages';contacts.text='Native contacts'
local base=widget('line');base:Reparent(contacts)
local activePanel,active=widget('linePanel'),widget('line');activePanel:Reparent(root);active:Reparent(activePanel)
active.tint={Red=0,Green=1,Blue=1}
local icon,label=widget('glyph'),widget('label');icon:Reparent(tab);label:Reparent(tab)
local c={GetRootWidget=function()return root end,ScrollTo=function()error('Localization navigated the phone')end}
m.header(c,0)
assert(label.text=='DISCUSSION' and label.name==CName.new('convaiChatTabLabel'))
assert(tab.name==CName.new('convaiChatTab') and messages.text=='Native messages' and contacts.text=='Native contacts')
language='ja';generation=2;m.header(c,0)
assert(label.text=='チャット' and m.headerIndex==0 and #tab.children==1)
`));

test('already-open phone refreshes on locale revision only and does not translate its conversation', () => runLua(setup + `
local m=(function()${phone}end)()
local n,c,hint,label=popup('judy')
m.composer(n,'Type a message first.')
local scans=0
local system={GetLayers=function()scans=scans+1;return{{GetGameControllers=function()return{n}end}}end}
Game={GetPlayer=function()return{ConvaiPhoneIsOpen=function()return true end}end,GetInkSystem=function()return system end,
  GetSettingsSystem=function()error('UI language changed game settings')end}
m.refresh();assert(scans==1 and label.text=='DISCUSSION')
m.refresh();assert(scans==1)
language='ja';generation=2;m.refresh()
assert(scans==2 and label.text=='チャット' and hint.text==translations.ja['Type a message first.'])
assert(c.draft=='Hey Judy, mixed Case 日本語')
m.refresh();assert(scans==2)
`));

test('live-shaped phone popup after stock HUD controllers resolves its private breadcrumb from the native tree', () => runLua(setup + `
enableNativeFonts();language='ja'
local composerModule=(function()${composer}end)()
local m=(function()${phone}end)()
local n,c,hint,breadcrumb=popup('aaron');n.m_messagesPath=nil;c.draft=''
local visible,shadow=measuredInput(c)
local unrelated={GetClassName=function()return CName.new('StockHudController')end}
local controllers={};for i=1,131 do controllers[i]=unrelated end;controllers[132]=n
Game={GetPlayer=function()return{ConvaiPhoneIsOpen=function()return true end}end,
  GetInkSystem=function()return{GetLayers=function()return{{GetGameControllers=function()return controllers end}}end}end}
m.refresh()
assert(breadcrumb.text=='チャット' and breadcrumb.fontFamily.path==convaiUiFonts.family('ja'))
assert(visible.fontFamily.path==convaiUiFonts.family('ja') and shadow.fontFamily.path==visible.fontFamily.path)
assert(c.draft=='' and m.lastError==nil,m.lastError)
`));

test('staged installs without the locale module retain English and named-character interpolation', () => runLua(setup + `
dofile=function()error('Locale not staged yet')end
local m=(function()${composer}end)()
local data={title='TALK TO Judy',message='Type your message to the character.'}
local n,c,title=notification(data);m.apply(n)
assert(title.text==data.title and c.placeholder=='' and c.case==textLetterCase.OriginalCase)
local p=(function()${phone}end)()
local _,phoneInput=popup('judy');p.input(phoneInput)
assert(phoneInput.placeholder=='Press Enter to write  /  Esc to stop typing')
`));

test('native phone feedback localizes exact owned messages without native queries or content translation', () => runLua(setup + `
local m=(function()${phone}end)();m.install()
local host=setmetatable({},{__index=function()error('Feedback queried its native owner')end})
Game=setmetatable({},{__index=function()error('Feedback queried game state')end})
local forwarded,forwards
local function native(value)forwarded=value;forwards=(forwards or 0)+1;return 'native result'end
local hud=overrides['PlayerPuppet.ConvaiPhoneFeedback']
local row=overrides['PhoneContactItemVirtualController.ConvaiShowActionFeedback']
local queue=overrides['PlayerPuppet.ConvaiPhoneQueue']
local function queued(message)
  return queue(host,'judy',true,function(key,join)
    assert(key=='judy' and join==true)
    return hud(host,message,native)
  end)
end
for _,source in ipairs({'INVITE QUEUED - CLOSE PHONE','DISMISS QUEUED - CLOSE PHONE',
  'CLOSE PHONE TO CONTINUE','COMPANION UNAVAILABLE','This contact has no companion mapping yet.',
  'Close the phone to finish the pending companion requests.'})do
  assert(row(host,source,native)=='native result' and forwarded==translations.fr[source])
end
-- The native queue's own acknowledgements repeat the row text and surface after the phone closes:
-- they are never shown (notices.lua, class removed), in any language.
forwarded=nil
assert(queued('Judy {name}%: invite queued.')==nil and forwarded==nil)
assert(queued('Johnny Silverhand: dismiss queued.')==nil and forwarded==nil)
language='ja';generation=2;queued('ジュディ: invite queued.')
assert(forwarded==nil)
assert(forwards==6)
for _,key in ipairs(calls)do assert(key~='Judy {name}%' and key~='Johnny Silverhand' and key~='ジュディ')end
-- A refusal from the same native call still shows (once per window, decided by the notice gate).
convaiNotices={visible=function()return false end,permit=function()return true end}
language='fr';generation=3;forwarded=nil
assert(queued('This contact has no companion mapping yet.')=='native result')
assert(forwarded==translations.fr['This contact has no companion mapping yet.'])
convaiNotices={visible=function()return false end,permit=function()return false end}
forwarded=nil
assert(queued('This contact has no companion mapping yet.')==nil and forwarded==nil)
`));

test('phone feedback preserves unknown errors, translated messages, thought suppression and malformed suffixes', () => runLua(setup + `
local m=(function()${phone}end)();m.install()
local raw={'Provider unavailable (custom detail)','Judy is thinking...',
  'Judy: invite queued. extra',': invite queued.','Judy\\n: invite queued.',
  string.rep('x',161)..': dismiss queued.','Judy : invitation en attente.',
  'AI response: I want to invite Judy.', 'draft: hello, Judy', ''}
for _,value in ipairs(raw)do
  assert(m.feedback(value)==value)
end
assert(#calls==0)
local count=0
local suppress=function(message)if message:sub(-15)==' is thinking...'then return end;count=count+1 end
overrides['PlayerPuppet.ConvaiPhoneFeedback']({},'Judy is thinking...',suppress)
assert(count==0,'Localization bypassed the existing thinking-message filter')
local hud,row=overrides['PlayerPuppet.ConvaiPhoneFeedback'],overrides['PhoneContactItemVirtualController.ConvaiShowActionFeedback']
m.install()
assert(overrides['PlayerPuppet.ConvaiPhoneFeedback']==hud and overrides['PhoneContactItemVirtualController.ConvaiShowActionFeedback']==row)
`));

test('fresh world input gets paired native fonts only during a queued top-level update', () => runLua(setup + `
enableNativeFonts();language='ja'
local m=(function()${composer}end)();m.install()
local data={title='TALK TO Judy',message='Type your message to the character.'}
local n,c,title,hint=notification(data);c.draft=''
local visible,shadow=measuredInput(c)
local scans=0
Game={GetInkSystem=function()scans=scans+1;return{GetLayers=function()return{{GetGameControllers=function()return{n}end}}end}end}
observers['GenericMessageNotification.OnInitialize'](n)
assert(scans==0 and visible.fontWrites==0 and shadow.fontWrites==0 and title.fontWrites==0)
m.update()
local family=convaiUiFonts.family('ja')
assert(scans==1 and visible.fontFamily.path==family and shadow.fontFamily.path==family)
assert(title.fontFamily.path==family and hint.fontFamily.path==family)
assert(c.draft=='' and c.case==textLetterCase.OriginalCase)
assert(m.fontScope.count()==4 and not m.fontDirty)
m.update();assert(scans==1,'Idle frame repeated native font traversal')
-- Changing UI language restores static labels but freezes this input lifetime.
language='en';generation=2;m.update()
assert(title.fontFamily.path=='native-original.inkfontfamily' and hint.fontFamily.path=='native-original.inkfontfamily')
assert(visible.fontFamily.path==family and shadow.fontFamily.path==family)
assert(m.fontScope.count()==2,'Frozen input font snapshots were pruned')
`));

test('typed, cached and measuring inputs defer fonts until recreation, even if subsequently emptied', () => runLua(setup + `
enableNativeFonts();language='ja'
local m=(function()${composer}end)()
for _,state in ipairs({'typed','cached','measuring'})do
  local c=input();local visible,shadow,measure=measuredInput(c)
  if state~='typed'then c.draft=''end
  if state=='cached'then measure.target='a';measure.length=1 end
  if state=='measuring'then measure.measuring=true end
  assert(not m.fontInput(c,m.fontScope))
  c.draft='';measure.target='';measure.length=0;measure.measuring=false
  assert(not m.fontInput(c,m.fontScope),'Used input changed family after being emptied')
  assert(visible.fontWrites==0 and shadow.fontWrites==0)
end
local fresh=input();fresh.draft='';local visible,shadow=measuredInput(fresh)
assert(m.fontInput(fresh,m.fontScope))
assert(visible.fontFamily.path==convaiUiFonts.family('ja') and shadow.fontFamily.path==visible.fontFamily.path)
`));

test('input font preflight and rollback never leave display and measurement families mismatched', () => runLua(setup + `
enableNativeFonts();language='ja'
local m=(function()${composer}end)()
local c=input();c.draft='';local visible,shadow=measuredInput(c)
shadow.fontFamily.path='not-a-native-font'
assert(not m.fontInput(c,m.fontScope))
assert(visible.fontWrites==0 and shadow.fontWrites==0)
local c2=input();c2.draft='';local visible2,shadow2=measuredInput(c2)
visible2.failFont=true
assert(not m.fontInput(c2,m.fontScope))
assert(visible2.fontFamily.path=='native-original.inkfontfamily' and shadow2.fontFamily.path=='native-original.inkfontfamily')
assert(c2.draft=='' and shadow2.fontLock==false)
local c3=input();c3.draft='';local visible3,shadow3=measuredInput(c3)
shadow3.failFont=true
assert(not m.fontInput(c3,m.fontScope))
assert(visible3.fontWrites==0 and visible3.fontFamily.path=='native-original.inkfontfamily')
assert(shadow3.fontFamily.path=='native-original.inkfontfamily' and c3.draft=='')
`));

test('Russian input display and measurement share the fallback style and stay frozen across later focus or language changes', () => runLua(setup + `
enableNativeFonts();language='ru'
local m=(function()${composer}end)()
local c=input();c.draft='';local visible,shadow,measure=measuredInput(c)
assert(m.fontInput(c,m.fontScope))
assert(visible.fontStyle==CName.new('Semi-Bold') and shadow.fontStyle==visible.fontStyle)
c.draft='Привет, Judy';measure.target=c.draft;measure.length=12
local writes=visible.fontWrites+shadow.fontWrites
language='ja';generation=2
assert(m.fontInput(c,m.fontScope))
assert(visible.fontFamily.path==convaiUiFonts.family('ru') and shadow.fontFamily.path==visible.fontFamily.path)
assert(visible.fontWrites+shadow.fontWrites==writes and c.draft=='Привет, Judy')
`));

test('Chat tab font resources and fallback style change only in the top-level refresh', () => runLua(setup + `
enableNativeFonts();language='ru'
local m=(function()${phone}end)();m.install()
local root,c,label=selector()
local host={GetRootWidget=function()return root end,GetClassName=function()return CName.new('NewHudPhoneGameController')end}
local scans=0
Game={GetPlayer=function()return{ConvaiPhoneIsOpen=function()return true end}end,
  GetInkSystem=function()scans=scans+1;return{GetLayers=function()return{{GetGameControllers=function()return{host}end}}end}end}
observers['PhoneDialerSelectionController.UpdateHightlight'](c,0)
assert(scans==0 and label.fontWrites==0 and label.fontStyleWrites==0 and label.fontSizeWrites==0)
m.refresh()
assert(label.fontFamily.path==convaiUiFonts.family('ru') and label.fontStyle==CName.new('Semi-Bold') and label.fontSize==50)
local writes=label.fontWrites
observers['PhoneDialerSelectionController.UpdateHightlight'](c,0)
assert(label.fontWrites==writes and label.fontStyle==CName.new('Semi-Bold'))
m.refresh();assert(label.fontWrites==writes,'Highlight repaint repeatedly rebound the native font')
language='en';generation=2;m.refresh()
assert(label.fontFamily.path=='native-original.inkfontfamily' and label.fontStyle==CName.new('Regular') and not label.fontLock)
`));

test('reused Chat action restores the native contact font and styles only the owned queue feedback', () => runLua(setup + `
enableNativeFonts();language='ja'
local m=(function()${phone}end)();m.install()
local root=widget('dialer')
local label=widget('acceptLabel');label:Reparent(root)
local feedback=widget('convaiActionFeedback');feedback:Reparent(root)
local contactName=widget('text');contactName.text='Judy';contactName:Reparent(root)
local dialer={contact={convaiChat=true},m_acceptButtonLabel=label,
  GetRootWidget=function()return root end,GetClassName=function()return CName.new('PhoneDialerLogicController')end}
function dialer:GetSelectedContactData()return self.contact end
root.controller=dialer
local host={GetRootWidget=function()return root end,GetClassName=function()return CName.new('NewHudPhoneGameController')end}
Game={GetPlayer=function()return{ConvaiPhoneIsOpen=function()return true end}end,
  GetInkSystem=function()return{GetLayers=function()return{{GetGameControllers=function()return{host}end}}end}end}
observers['PhoneDialerLogicController.RefreshInputHints'](dialer,dialer.contact)
assert(label.fontWrites==0 and feedback.fontWrites==0)
m.refresh()
assert(label.fontFamily.path==convaiUiFonts.family('ja') and feedback.fontFamily.path==convaiUiFonts.family('ja'))
assert(contactName.fontWrites==0 and contactName.text=='Judy')
dialer.contact={convaiChat=false};label.text='Native call'
observers['PhoneDialerLogicController.RefreshInputHints'](dialer,dialer.contact)
assert(label.fontFamily.path==convaiUiFonts.family('ja'))
m.refresh()
assert(label.fontFamily.path=='native-original.inkfontfamily' and label.text=='Native call')
assert(contactName.fontWrites==0 and contactName.text=='Judy')
`));

test('compiled private accept hint resolves only its observed right-side subtree from top-level presentation',()=>runLua(setup+`
enableNativeFonts();language='ja'
local m=(function()${phone}end)();m.install()
local root=widget('Root');local hints=widget('inputHintsPanel');hints:Reparent(root)
local left=widget('leftInputHints');left:Reparent(hints)
local right=widget('rightInputHints');right:Reparent(hints)
local leftAccept,rightAccept=widget('inputAccept'),widget('inputAccept')
leftAccept:Reparent(left);rightAccept:Reparent(right)
local leftLabel,rightLabel=widget('text'),widget('text')
leftLabel:Reparent(leftAccept);rightLabel:Reparent(rightAccept)
leftLabel.text='Other native hint';rightLabel.text='CHAT'
local nested=true
local controller={GetRootWidget=function()assert(not nested,'Nested native tree lookup');return root end}
observers['PhoneDialerLogicController.RefreshInputHints'](controller,{convaiChat=true})
assert(rightLabel.text=='CHAT' and leftLabel.text=='Other native hint')
nested=false;m.action(controller,{convaiChat=true},true)
assert(rightLabel.text=='チャットする' and leftLabel.text=='Other native hint')
`));

test('owned phone fonts repaint from top-level refresh and restore the reused story breadcrumb', () => runLua(setup + `
enableNativeFonts();language='ja'
local composerModule=(function()${composer}end)()
local m=(function()${phone}end)();m.install()
local n,c,hint,breadcrumb=popup('judy');c.draft=''
local visible,shadow=measuredInput(c)
local story=widget('text');story.text='Native story message';story:Reparent(n:GetRootWidget())
local scans=0
Game={GetPlayer=function()return{ConvaiPhoneIsOpen=function()return true end}end,
  GetInkSystem=function()scans=scans+1;return{GetLayers=function()return{{GetGameControllers=function()return{n}end}}end}end}
observers['PhoneMessagePopupGameController.ConvaiChatPresent'](n,{},'Message sent. Waiting for reply.')
assert(scans==0 and visible.fontWrites==0 and shadow.fontWrites==0 and hint.fontWrites==0)
m.refresh()
local family=convaiUiFonts.family('ja')
assert(visible.fontFamily.path==family and shadow.fontFamily.path==family)
assert(hint.fontFamily.path==family and breadcrumb.fontFamily.path==family)
assert(story.fontWrites==0 and story.text=='Native story message' and c.draft=='')
local before=scans;m.refresh();assert(scans==before)
n.contact='';breadcrumb.text='Native Messages'
observers['PhoneMessagePopupGameController.ConvaiChatPath'](n,false)
assert(breadcrumb.fontFamily.path==family,'A nested native callback changed fonts')
m.refresh()
assert(breadcrumb.fontFamily.path=='native-original.inkfontfamily' and breadcrumb.text=='Native Messages')
assert(story.fontWrites==0)
`));

test('shared HUD errors stay literal even when they collide with authored phone queue text', () => runLua(setup + `
local m=(function()${phone}end)();m.install()
local hud=overrides['PlayerPuppet.ConvaiPhoneFeedback']
local queue=overrides['PlayerPuppet.ConvaiPhoneQueue']
local received
local function native(message)received=message;return false end
for _,message in ipairs({'Provider failed: invite queued.','INVITE QUEUED - CLOSE PHONE',
  'Close the phone to finish the pending companion requests.'})do
  assert(hud({},message,native)==false and received==message)
end
assert(#calls==0)
local ok=pcall(function()queue({},'judy',false,function()error('native queue failure')end)end)
assert(not ok and m.feedbackQueueDepth==0)
hud({},'Provider failed: dismiss queued.',native)
assert(received=='Provider failed: dismiss queued.' and #calls==0)
received=nil
assert(queue({},'judy',false,function()
  hud({},'Judy: dismiss queued.',native);return true
end)==true)
assert(received==nil and m.feedbackQueueDepth==0, 'the native queue acknowledgement was shown')
`));

test('chat messages in a script the game font lacks get their family in three timed passes after a present, and a recycled Latin row is restored', () => runLua(setup + `
enableNativeFonts();language='en'
local m=(function()${phone}end)()
local n,c,hint,label=popup('judy');c.draft=''
local path=n.m_messagesPath
local area=widget('MessagesScrollArea');area:Reparent(path)
local function row(text)local w=widget('text');w.text=text;w:Reparent(area);return w end
local jp,latin,ru=row('了解です。'),row('Fine by me.'),row('Привет, V')
local original=jp.fontFamily.path
local clock,scans,open=0,0,true
os.clock=function()return clock end
Game={GetPlayer=function()return{ConvaiPhoneIsOpen=function()return open end}end,
  GetInkSystem=function()scans=scans+1;return{GetLayers=function()return{{GetGameControllers=function()return{n}end}}end}end}
m.refresh()
local base=scans
-- A list with Latin text only, and nothing styled before: no pass is scheduled and no row is touched.
m.linesPresented({{text='Fine by me.'}})
assert(m.replyFontAt==nil)
clock=5;m.refresh();assert(scans==base and jp.fontWrites==0,'idle refreshes stay idle')
-- A list with a Japanese message schedules three passes; nothing happens before the first is due.
m.linesPresented({{text='Fine by me.'},{text='了解です。'}})
assert(#m.replyFontAt==3)
m.refresh();assert(scans==base and jp.fontWrites==0)
clock=5.2;m.refresh()
assert(scans==base+1 and #m.replyFontAt==2)
assert(jp.fontFamily.path==convaiUiFonts.family('ja') and jp.fontLock and ru.fontFamily.path==convaiUiFonts.family('ru'))
assert(latin.fontWrites==0 and latin.fontFamily.path==original,'a Latin message keeps the game font')
local writes=jp.fontWrites
clock=5.8;m.refresh();assert(scans==base+2 and jp.fontWrites==writes and #m.replyFontAt==1,'the second pass finds nothing to change')
clock=7;m.refresh();assert(scans==base+3 and #m.replyFontAt==0)
clock=9;m.refresh();assert(scans==base+3,'no pass without a present: nothing per frame')
-- The list controller recycles a row for new Latin text: the next present restores the font it had.
jp.text='Sure, see you there.'
m.linesPresented({{text='Sure, see you there.'}})
assert(#m.replyFontAt==3,'a font was changed earlier, so this list is checked too')
clock=9.2;m.refresh()
assert(jp.fontFamily.path==original and not jp.fontLock and ru.fontFamily.path==convaiUiFonts.family('ru'))
-- Closing the phone forgets the rows (plain Lua) and schedules nothing.
open=false;m.refresh()
assert(m.messageScope.count()==0 and m.replyFontAt==nil)
assert(m.lastError==nil,m.lastError)
`));
