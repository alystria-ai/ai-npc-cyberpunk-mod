import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import fengari from 'fengari';

const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;
const fontsSource = readFileSync(new URL('../mod/ui-fonts.lua', import.meta.url), 'utf8');
const source = readFileSync(new URL('../mod/mcm-fonts.lua', import.meta.url), 'utf8');
const fixture = `
  local inNative, nextKey, rootReads, fontWrites = false, 0, 0, 0
  local code, revision, ownActive = 'ja', 1, true
  local hooks = {}
  local function guard() assert(not inNative, 'reflected ink work inside a native observer') end
  CName = {new = function(value) return value end}
  NameToString = function(value)
    guard()
    -- The native name cache can omit renderer names. Font styles resolve.
    if value == 'Regular' or value == 'Medium' or value == 'Semi-Bold' or value == 'Bold' then return value end
    return ''
  end
  CalcSeed = function(value) guard(); return value and value.key end
  ResRef = {ToString = function(value) guard(); return value.path end}
  local function widget(name, text, children)
    nextKey = nextKey + 1
    local w = {key = nextKey, name = name, text = text, children = children or {}, style = 'Regular', lock = false,
      fontFamily = {path = 'base/fonts/original.inkfontfamily', hash = 'original-' .. nextKey}, writes = 0}
    function w:GetName() guard(); return self.name end
    function w:IsA(class) guard(); return self.text ~= nil and class == 'inkTextWidget' end
    function w:GetText() guard(); return self.text end
    function w:GetFontStyle() guard(); return self.style end
    function w:GetLockFontInGame() guard(); return self.lock end
    function w:SetLockFontInGame(value) guard(); self.lock = value end
    function w:SetFontFamily(path, style)
      guard(); self.fontFamily = {path = path, hash = 'applied-' .. path}; self.style = style
      self.writes, fontWrites = self.writes + 1, fontWrites + 1
    end
    function w:GetNumChildren() guard(); return #self.children end
    function w:GetWidgetByIndex(index) guard(); return self.children[index + 1] end
    return w
  end
  local controller = {key = 900001}
  local root
  function controller:GetRootWidget() guard(); rootReads = rootReads + 1; return root end
  local function reference(identity)
    return setmetatable({key = identity or controller.key}, {__index = controller})
  end
  local function observe(class, method, callback)
    local id = class .. '.' .. method
    hooks[id] = hooks[id] or {}
    hooks[id][#hooks[id] + 1] = callback
  end
  Observe, ObserveAfter = observe, observe
  local function emit(method, ...)
    inNative = true
    for _, callback in ipairs(hooks['SettingsMainGameController.' .. method] or {}) do callback(...) end
    inNative = false
  end
  local function emitSelect()
    inNative = true
    for _, callback in ipairs(hooks['SettingsSelectorControllerListString.McmUiFinishSelect'] or {}) do callback({}) end
    inNative = false
  end
  local ui = {current = function() return code end, revision = function() return revision end,
    t = function(text) return text == 'Companion Manager' and (code == 'ja' and 'コンパニオン管理' or 'Companion Manager') or text end}
  local library = (function() ${fontsSource} end)()
  local adapter = (function() ${source} end)().new({ui = ui, fonts = library,
    label = function() return ui.t('Companion Manager') end,
    active = function() guard(); return ownActive end})
  adapter.install()
  local page
  local function render(owned, finish)
    ownActive = owned
    local title = widget('content_title', owned and ui.t('Companion Manager') or 'Other mod')
    local status = widget('status', owned and 'Preparing voices' or 'Other status')
    local header = widget('framework_header', 'Mod Configuration Menu')
    local description = widget('description_text', owned and 'Our description' or 'Foreign description')
    local rowLabel = widget('setting_managed_label', 'Interface language')
    local option = widget('option', 'Automatic (game language)')
    local category = widget('label', 'Interface')
    local content = widget('mcm_content_scroll_content', nil,
      {widget('settingsCategory', nil, {category}), rowLabel, widget('selector', nil, {option})})
    local ourLabel = widget('label', ui.t('Companion Manager'))
    local animated = widget('sidebar_animated', ui.t('Companion Manager'))
    local ownSidebar = widget('mcm_action_ours', nil, {ourLabel, animated})
    local foreignLabel = widget('label', 'Foreign mod')
    local foreignSidebar = widget('mcm_action_foreign', nil, {foreignLabel})
    local sidebar = widget('mcm_sidebar_scroll_content', nil, {ownSidebar, foreignSidebar})
    local renderRoot = widget('MCMRenderRoot', nil, {header, title, status, content, sidebar,
      widget('mcm_description_panel', nil, {widget('mcm_description_content', nil, {description})})})
    root = widget('root', nil, {widget('native_settings', nil, {renderRoot})})
    page = {title = title, status = status, header = header, description = description,
      category = category, label = rowLabel, option = option, content = content,
      ourLabel = ourLabel, animated = animated, ownSidebar = ownSidebar, foreignLabel = foreignLabel,
      sidebar = sidebar, render = renderRoot}
    emit('McmUiBegin', reference())
    emit('McmUiAddSidebarItem', reference(), 'ours', 'CONVAI', ui.t('Companion Manager'))
    emit('McmUiAddSidebarItem', reference(), 'foreign', 'OTHER', 'Foreign mod')
    emit('McmUiBeginSelect', reference(), 'our-setting')
    emit('McmUiEndSelect', reference())
    emit('McmUiSetDescription', reference())
    if finish ~= false then emit('McmUiSetContentTitle', reference(), title.text) end
    return page
  end
  local function frame()
    assert(adapter.update(), adapter.inspect().error)
  end
  local function assigned(w, language) return w.fontFamily.path == library.family(language or code) end
  local function original(w) return w.fontFamily.path == 'base/fonts/original.inkfontfamily' and w.lock == false end
`;

function run(body) {
  const vm = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(vm);
  const status = lauxlib.luaL_dostring(vm, to_luastring(fixture + body));
  const error = status === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(vm, -1));
  lua.lua_close(vm);
  assert.equal(status, lua.LUA_OK, error);
}

test('native observers defer font identities, traversal and setters until update', () => run(`
  local p = render(true)
  assert(fontWrites == 0 and rootReads == 0 and adapter.inspect().queued > 0)
  frame()
  assert(assigned(p.title) and assigned(p.status) and assigned(p.description))
  assert(assigned(p.category) and assigned(p.label) and assigned(p.option))
  assert(assigned(p.ourLabel) and assigned(p.animated))
  assert(original(p.header) and original(p.foreignLabel), 'framework or other mod text was modified')
  assert(not adapter.inspect().pending and adapter.inspect().error == '')
`));

test('ownership waits for the final title and exact CNames work with an empty name cache', () => run(`
  local p = render(true, false)
  frame()
  assert(original(p.title) and original(p.label) and original(p.description))
  assert(assigned(p.ourLabel), 'our sidebar ownership must work before page selection')
  emit('McmUiSetContentTitle', reference(), ui.t('Companion Manager'))
  assert(original(p.title))
  frame(); assert(assigned(p.title) and assigned(p.label))
`));

test('an unsaved autonym follows its native script before Apply and restores for a Latin choice', () => run(`
  code, revision = 'en', 2
  local p = render(true); p.option.text = '日本語'
  frame(); assert(assigned(p.option, 'ja') and original(p.label) and code == 'en')
  p.option.text = '한국어'; emitSelect()
  assert(assigned(p.option, 'ja'), 'native draft callback changed a font synchronously')
  frame(); assert(assigned(p.option, 'ko') and code == 'en')
  p.option.text = 'Русский'; emitSelect(); frame(); assert(assigned(p.option, 'ru') and p.option.style == 'Semi-Bold')
  p.option.text = 'Українська'; emitSelect(); frame(); assert(assigned(p.option, 'ru') and p.option.style == 'Semi-Bold')
  for _, native in ipairs({'Italiano', 'Polski', 'Čeština', 'Magyar', 'Türkçe'}) do
    p.option.text = native; emitSelect(); frame(); assert(original(p.option), native .. ' must keep the game Latin font')
  end
  p.option.text = 'English'; emitSelect(); frame(); assert(original(p.option))
`));

test('foreign hover restores only the shared description then hover-out restores our ownership', () => run(`
  local p = render(true); frame()
  p.description.text = 'Foreign description'
  emit('McmUiUpdateDescription', reference())
  emit('McmUiEmitHover', reference(), 'foreign', '', true)
  frame()
  assert(original(p.description) and assigned(p.title) and assigned(p.label) and assigned(p.ourLabel))
  p.description.text = 'Our description'
  emit('McmUiUpdateDescription', reference())
  -- The framework returns to the base description on every hover-out.
  emit('McmUiEmitHover', reference(), 'another-foreign', '', false)
  frame(); assert(assigned(p.description))
`));

test('our sidebar description remains readable on another mod page without changing its content', () => run(`
  local p = render(false); frame()
  assert(original(p.title) and original(p.label) and original(p.description))
  assert(assigned(p.ourLabel) and assigned(p.animated) and original(p.foreignLabel))
  p.description.text = 'Our description'
  emit('McmUiEmitHover', reference(), 'ours', '', true)
  emit('McmUiUpdateDescription', reference()); frame()
  assert(assigned(p.description) and original(p.title) and original(p.label))
  emit('McmUiEmitHover', reference(), 'foreign', '', true)
  emit('McmUiUpdateDescription', reference()); frame()
  assert(original(p.description))
`));

test('replacing a description preserves the current hover owner and fonts new rich text', () => run(`
  local p = render(false); frame()
  emit('McmUiEmitHover', reference(), 'ours', '', true)
  p.description = widget('description_text', 'Our replaced description')
  p.render.children[6] = widget('mcm_description_panel', nil, {p.description})
  emit('McmUiSetDescription', reference()); frame()
  assert(assigned(p.description), 'description creation discarded the explicit hovered owner')
`));

test('late animated sidebar labels and committed language changes are refreshed outside native callbacks', () => run(`
  local p = render(true); frame()
  local late = widget('loop_label', ui.t('Companion Manager'))
  p.ownSidebar.children[#p.ownSidebar.children + 1] = late
  emit('McmUiOnSidebarTextMeasureTick', reference()); assert(original(late))
  frame(); assert(assigned(late))
  code, revision = 'zh-tw', revision + 1
  frame(); assert(assigned(p.label, 'zh-tw') and p.label.style == 'Semi-Bold' and assigned(late, 'zh-tw'))
  code, revision = 'en', revision + 1
  frame(); assert(original(p.label) and original(late) and original(p.title))
`));

test('native detach ignores unrelated controllers and clears ownership without using a stale wrapper', () => run(`
  render(true); frame()
  emit('OnUninitialize', reference(55555)); frame(); assert(adapter.inspect().active)
  local reads = rootReads
  emit('OnUninitialize', reference()); root = nil
  frame(); assert(not adapter.inspect().active and rootReads == reads)
  assert(adapter.inspect().queued == 0)
`));

test('shutdown restores the current live owned fonts and reset avoids native teardown access', () => run(`
  local p = render(true); frame()
  assert(adapter.restoreNow())
  assert(original(p.title) and original(p.label) and original(p.ourLabel) and original(p.description))
  assert(not adapter.inspect().active)
  p = render(true); frame()
  local reads, writes = rootReads, fontWrites
  inNative = true; adapter.reset(); inNative = false
  root = nil; frame()
  assert(rootReads == reads and fontWrites == writes and not adapter.inspect().active)
`));

test('a missed render-begin fails closed instead of applying old ownership to a new foreign tree', () => run(`
  render(true); frame()
  local foreignLabel = widget('setting_managed_label', 'Foreign setting')
  local foreignRender = widget('MCMRenderRoot', nil, {widget('content_title', 'Foreign'),
    widget('mcm_content_scroll_content', nil, {foreignLabel})})
  root = widget('root', nil, {foreignRender})
  emit('McmUiUpdateDescription', reference()); frame()
  assert(original(foreignLabel) and not adapter.inspect().active)
`));

test('queue overflow restores the known live tree then waits for a complete new render', () => run(`
  local p = render(true); frame()
  for index = 1, 2050 do emit('McmUiUpdateDescription', reference()) end
  frame(); assert(original(p.label) and original(p.description) and not adapter.inspect().active)
  p = render(true); frame(); assert(assigned(p.label))
`));

test('large content pages finish in bounded batches and do not abandon later owned controls', () => run(`
  local p = render(true)
  for index = 1, 1500 do p.content.children[#p.content.children + 1] = widget('row-' .. index, 'Owned') end
  frame(); assert(adapter.inspect().pending)
  for index = 1, 20 do if adapter.inspect().pending then frame() end end
  assert(not adapter.inspect().pending and assigned(p.content.children[#p.content.children]))
  assert(adapter.restoreNow() and original(p.content.children[#p.content.children]))
`));

test('a hover or description update repaints only the description and keeps the row font records', () => run(`
  local p = render(true); frame()
  local reads = 0
  local getText = p.option.GetText
  function p.option:GetText() reads = reads + 1; return getText(self) end
  p.description.text = 'Foreign description'
  emit('McmUiUpdateDescription', reference())
  emit('McmUiEmitHover', reference(), 'foreign', '', true)
  frame()
  assert(reads == 0, 'a hover walked the content rows')
  assert(original(p.description) and assigned(p.option) and assigned(p.label))
  -- The row records survive the partial paint: a language change still restores them.
  code, revision = 'en', revision + 1
  frame(); assert(original(p.option) and original(p.label))
`));

test('a hover keeps the cached chrome while a replaced description is found again', () => run(`
  local p = render(true); frame()
  local reads = rootReads
  emit('McmUiEmitHover', reference(), 'ours', '', true); frame()
  assert(rootReads == reads + 1, 'one root read for the identity check only')
  -- The mock widgets expose no parent, so a description update looks stale and is searched again.
  p.description = widget('description_text', 'Our replaced description')
  p.render.children[6] = widget('mcm_description_panel', nil, {p.description})
  emit('McmUiUpdateDescription', reference()); frame()
  assert(assigned(p.description))
`));

test('a Latin locale skips the content rows unless the page can show native language names', () => run(`
  code, revision = 'en', 5
  local mayNeed = false
  local gated = (function() ${source} end)().new({ui = ui, fonts = library,
    label = function() return ui.t('Companion Manager') end,
    active = function() guard(); return ownActive end,
    contentMayNeedFonts = function() return mayNeed end})
  gated.install()
  local p = render(true); p.option.text = '日本語'
  local reads = 0
  local getText = p.option.GetText
  function p.option:GetText() reads = reads + 1; return getText(self) end
  assert(gated.update())
  assert(reads == 0 and original(p.option) and assigned(p.ourLabel, 'ja') == false)
  -- The page that lists languages asks for the walk.
  mayNeed = true
  emit('McmUiEndSelect', reference())
  assert(gated.update())
  assert(reads > 0 and assigned(p.option, 'ja'))
  -- Once a font is applied the rows are walked again to restore it, even without the hint.
  mayNeed = false
  p.option.text = 'English'
  emit('McmUiEndSelect', reference())
  assert(gated.update())
  assert(original(p.option))
`));

test('an idle adapter makes no native call per update', () => run(`
  local p = render(true); frame()
  local reads = rootReads
  for index = 1, 100 do frame() end
  assert(rootReads == reads)
`));

test('busy says whether a repaint that can change fonts is queued or under way, so a page is not shown half-fonted', () => run(`
  assert(adapter.busy() == false, 'busy with no page')
  local p = render(true)
  for index = 1, 700 do p.content.children[#p.content.children + 1] = widget('row-' .. index, 'Owned') end
  assert(adapter.busy() == true, 'a render is queued')
  local frames = 0
  repeat frame(); frames = frames + 1 until not adapter.busy() or frames > 30
  assert(frames > 1 and frames <= 30, 'a large page finishes over several frames: ' .. frames)
  assert(assigned(p.content.children[#p.content.children]) and not adapter.inspect().pending)
  -- A hover is a description-only repaint: it never needs the rows hidden, and it ends at once.
  emit('McmUiEmitHover', reference(), 'ours', '', true)
  frame(); assert(adapter.busy() == false)
`));

test('busy is false on a Latin page that shows no native language names', () => run(`
  code, revision = 'en', 9
  local gated = (function() ${source} end)().new({ui = ui, fonts = library,
    label = function() return ui.t('Companion Manager') end,
    active = function() guard(); return ownActive end,
    contentMayNeedFonts = function() return false end})
  gated.install()
  render(true)
  assert(gated.busy() == false, 'a page with nothing to restyle was held back')
  assert(gated.update())
`));
