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
