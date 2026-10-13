import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import fengari from 'fengari';
const {lua,lauxlib,lualib,to_luastring,to_jsstring}=fengari;
const source=readFileSync(new URL('../mod/ui-fonts.lua',import.meta.url),'utf8');
function run(body){
 const vm=lauxlib.luaL_newstate();lualib.luaL_openlibs(vm);
 const result=lauxlib.luaL_dostring(vm,to_luastring(`
 CName={new=function(v)return v end};NameToString=function(v)return v end
 ResRef={ToString=function(v)return v.path end};CalcSeed=function(v)return v.key end
 convaiUiLocale={current=function()return 'ja'end}
 local nextKey=0
 local function widget(text,style)
   nextKey=nextKey+1
   local w={key=nextKey,text=text or '',style=style or 'Regular',lock=false,
     fontFamily={path='base/fonts/original.inkfontfamily',hash='18446744073709551600ULL'},children={},sets=0}
   function w:IsA(name)return name=='inkTextWidget'end
   function w:GetText()return self.text end
   function w:GetFontStyle()return self.style end
   function w:GetLockFontInGame()return self.lock end
   function w:SetLockFontInGame(v)self.lock=v end
   function w:SetFontFamily(path,style)self.fontFamily={path=path,hash='hash:'..path};self.style=style;self.sets=self.sets+1 end
   function w:GetNumChildren()return #self.children end
   function w:GetWidgetByIndex(i)return self.children[i+1]end
   return w
 end
 local fonts=(function()${source}end)()
 ${body}`));
 const error=result===lua.LUA_OK?'':to_jsstring(lua.lua_tostring(vm,-1));lua.lua_close(vm);assert.equal(result,lua.LUA_OK,error);
}
test('localized font/style selection restores the actual original through the native setter',()=>run(`
 local scope=fonts.new();local w=widget('日本語','Medium')
 scope.begin();assert(scope.apply(w,'ja'));scope.finish()
 assert(w.fontFamily.path==fonts.family('ja') and w.style=='Medium' and w.lock)
 assert(not scope.apply(w,'ja') and w.sets==1)
 assert(scope.apply(w,false));assert(w.fontFamily.path=='base/fonts/original.inkfontfamily')
 assert(w.style=='Medium' and w.lock==false and scope.count()==0 and w.sets==2)
`));
test('every native language uses an existing style and selector autonyms work before Apply',()=>run(`
 local scope=fonts.new()
 for _,code in ipairs({'zh-cn','zh-tw','ja','ko','ru'})do
  local w=widget('owned text','Regular');scope.apply(w,code)
  assert(w.fontFamily.path==fonts.family(code))
  assert(w.style==((code=='ru'or code=='zh-tw')and'Semi-Bold'or'Regular'))
 end
 local choice=widget('한국어');scope.apply(choice,'en');assert(choice.fontFamily.path==fonts.family('ko'))
 local input=widget('한국어');scope.apply(input,'en','');assert(input.sets==0)
`));
test('Ukrainian shares the Cyrillic family while Latin Extended languages keep the original font',()=>run(`
 local scope=fonts.new()
 assert(fonts.family('uk')==fonts.family('ru') and fonts.family('uk'):find('russian',1,true))
 local w=widget('Налаштування ї є ґ і','Regular');scope.apply(w,'uk')
 assert(w.fontFamily.path==fonts.family('uk') and w.style=='Semi-Bold' and w.lock)
 for _,code in ipairs({'it','pl','cs','hu','tr'})do
  assert(fonts.family(code)==nil,code..' must use the game default Latin family')
  local latin=widget('Zażółć gęślą jaźń ő ű ğ ş ı İ ř ů','Regular')
  assert(not scope.apply(latin,code) and latin.sets==0 and latin.fontFamily.path=='base/fonts/original.inkfontfamily' and not latin.lock)
 end
 local autonyms={Italiano='it',Polski='pl',['Čeština']='cs',Magyar='hu',['Türkçe']='tr',['Українська']='uk',['English']='en'}
 for text,code in pairs(autonyms)do
  assert(fonts.codeForText(text,'ja')==code,text)
  local choice=widget(text,'Regular');scope.apply(choice,'en')
  if code=='uk' then assert(choice.fontFamily.path==fonts.family('uk'))
  else assert(choice.sets==0,text..' autonym must stay in the original font') end
 end
 -- A Cyrillic autonym is restored when its draft candidate becomes Latin.
 local option=widget('Українська','Regular');scope.apply(option,'en')
 option.text='Polski';scope.apply(option,'en');assert(option.fontFamily.path=='base/fonts/original.inkfontfamily' and not option.lock)
`));
test('restoration does not overwrite a later independent font, style or lock change',()=>run(`
 local scope=fonts.new();local w=widget('owned');scope.apply(w,'ja')
 w:SetFontFamily('other/mod.inkfontfamily','Bold')
 assert(not scope.restore(w) and w.fontFamily.path=='other/mod.inkfontfamily' and w.style=='Bold')
 scope.apply(w,'ru');w.style='Medium';w.lock=false
 scope.restore(w);assert(w.fontFamily.path=='other/mod.inkfontfamily' and w.style=='Medium' and not w.lock)
`));
test('bounded live-tree traversal and pruning retain no widget handles',()=>run(`
 local scope=fonts.new();local root=widget('root');root.IsA=function()return false end
 for i=1,10 do root.children[i]=widget('row '..i)end
 scope.begin();assert(scope.walk(root,'ja',{left=4})==3);scope.finish();assert(scope.count()==3)
 assert(root.sets==0 and root.children[4].sets==0)
 scope.begin();scope.touch(root.children[1]);scope.finish();assert(scope.count()==1)
 assert(scope.contains(root.children[1]) and not scope.contains(root.children[2]))
 scope.clear();assert(scope.count()==0)
`));
test('unresolvable original resources fail closed and non-Latin rich text inherits handling',()=>run(`
 local scope=fonts.new();local w=widget('bad');w.fontFamily.path='unknown hash'
 assert(not scope.apply(w,'ja') and w.sets==0 and scope.count()==0)
 local rich=widget('rich');rich.IsA=function(_,name)return name=='inkTextWidget' or name=='inkRichTextBoxWidget'end
 assert(scope.apply(rich,'zh-cn') and rich.lock)
`));
test('a reply script picks the family: kana Japanese, Hangul Korean, Han Chinese, Cyrillic Russian, everything else the game font',()=>run(`
 local cases={['こんにちは、V。']='ja',['ひらがなと漢字']='ja',['Hello, ジュディ here']='ja',['안녕하세요, V']='ko',['你好，世界']='zh-cn',['Hello, 世界']='zh-cn',
  ['Привет, V']='ru',['Привіт, ї є ґ']='ru',['Привет 你好']='zh-cn',['𠀀 extension']='zh-cn'}
 for text,code in pairs(cases)do assert(fonts.scriptCode(text)==code,text..' -> '..tostring(fonts.scriptCode(text)))end
 for _,text in ipairs({'','hello there','Zażółć gęślą jaźń ő ű ğ ş ı İ ř ů','Γειά σου','Բարեւ','emoji '..string.char(240,159,152,128)..' only',string.char(255,254)..' broken'})do
  assert(fonts.scriptCode(text)==nil,text)
 end
 assert(fonts.scriptCode(nil)==nil and fonts.scriptCode(42)==nil)
 assert(fonts.replyCode('Hello V')==false and fonts.replyCode('こんにちは')=='ja' and fonts.replyCode(nil)==false)
 assert(fonts.replyCode('你好')=='zh-cn')
 convaiUiLocale={current=function()return 'zh-tw'end}
 assert(fonts.replyCode('你好，世界')=='zh-tw','a Traditional Chinese interface keeps Traditional glyphs')
 assert(fonts.replyCode('こんにちは')=='ja' and fonts.replyCode('Привет')=='ru')
 for i=1,200 do assert(fonts.replyCode('line '..i..' 日本です')=='ja')end
 assert(fonts.replyCode('line 1 日本です')=='ja')
`));
test('a widget walk with the reply code gives each text its own family, leaves Latin ones alone and restores one that turned Latin',()=>run(`
 local scope=fonts.new()
 local root=widget('root');root.IsA=function()return false end
 local name,body,mixed=widget('Judy Alvarez','Semi-Bold'),widget('こんにちは、V。','Medium'),widget('Привет, V','Medium')
 root.children={name,body,mixed}
 assert(scope.walk(root,'reply')==2)
 assert(name.sets==0 and name.fontFamily.path=='base/fonts/original.inkfontfamily' and not name.lock)
 assert(body.fontFamily.path==fonts.family('ja') and body.style=='Medium' and body.lock)
 assert(mixed.fontFamily.path==fonts.family('ru') and mixed.style=='Medium' and mixed.lock)
 assert(scope.walk(root,'reply')==0 and body.sets==1 and mixed.sets==1,'a second walk of the same texts changes nothing')
 -- A recycled widget that now holds Latin text goes back to the font it had.
 body.text='See you soon';assert(scope.walk(root,'reply')==1,'the restore counts as a change')
 assert(body.fontFamily.path=='base/fonts/original.inkfontfamily' and not body.lock and scope.count()==1)
 assert(scope.canApply(widget('안녕'),'reply') and scope.canApply(widget('plain'),'reply'))
 -- A non-reply code is unchanged: the interface language still decides.
 local label=widget('Settings');scope.apply(label,'ko');assert(label.fontFamily.path==fonts.family('ko'))
`));
