import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import fengari from 'fengari';

const source = readFileSync(new URL('../mod/ui-locale.lua', import.meta.url), 'utf8');
const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;

function run(body) {
  const state = lauxlib.luaL_newstate(); lualib.luaL_openlibs(state);
  const result = lauxlib.luaL_dostring(state, to_luastring(`${fixture}\n${body}`));
  const error = result === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(state, -1));
  lua.lua_close(state); assert.equal(result, lua.LUA_OK, error);
}

const fixture = `
local clock, nativeCallback, reads, fileReads = 1000, false, 0, 0
local gameCode, failNative = 'en-us', false
local catalogs, requested = {}, {}
os.time = function() return clock end
local function outsideCallback()
    assert(not nativeCallback, 'native or filesystem work inside a UI callback')
end
CName = {new = function(value) outsideCallback(); return value end}
NameToString = function(value) outsideCallback(); return value.value end
Game = {GetSettingsSystem = function()
    outsideCallback(); reads = reads + 1
    if failNative then error('settings service unavailable') end
    return {GetVar = function(_, group, variable)
        assert(group == '/language' and variable == 'OnScreen', 'read subtitle/voice language instead of interface')
        return {GetValue = function() return {value = gameCode} end}
    end}
end}
dofile = function(path)
    outsideCallback(); fileReads = fileReads + 1; requested[#requested + 1] = path
    if catalogs[path] == 'error' then error('malformed catalog') end
    if catalogs[path] == nil then error('catalog not installed') end
    return catalogs[path]
end
local function module() ${source} end
local ui = module()
local function tick(delta) return ui.update(delta == nil and 0.1 or delta) end
`;

test('one shared singleton starts in English without native reads or filesystem IO', () => run(`
  assert(ui == module())
  assert(ui.current() == 'en' and ui.selection() == 'auto' and ui.revision() == 0)
  assert(ui.t('Companion Manager') == 'Companion Manager')
  assert(reads == 0 and fileReads == 0)
  assert(not tick() and reads == 1 and fileReads == 0)
  assert(ui == module() and reads == 1)
`));

test('manual selection is queued, pure in callbacks, and independent of the native voice language', () => run(`
  catalogs['locales/fr.lua'] = {['Companion Manager'] = 'Gestion des compagnons',
      ['Automatic (game interface language)'] = 'Automatique (langue du jeu)'}
  nativeCallback = true
  assert(ui.configure('fr'))
  assert(ui.current() == 'en' and ui.selection() == 'fr' and ui.revision() == 0)
  ui.t('Companion Manager'); ui.choices(); ui.supported(); ui.inspect()
  assert(reads == 0 and fileReads == 0)
  nativeCallback = false
  assert(tick() and ui.current() == 'fr' and ui.revision() == 1)
  assert(reads == 0 and fileReads == 1)
  nativeCallback = true
  assert(ui.t('Companion Manager') == 'Gestion des compagnons')
  assert(ui.choices()[1].label == 'Automatique (langue du jeu)')
  nativeCallback = false
  for i = 1, 100 do tick() end
  assert(reads == 0 and fileReads == 1)
  assert(not tick() and ui.revision() == 1)
`));

test('Auto reads OnScreen on a bounded cadence and reports only displayed language changes', () => run(`
  catalogs['locales/de.lua'] = {['Settings'] = 'Einstellungen'}
  catalogs['locales/ja.lua'] = {['Settings'] = '設定'}
  gameCode = 'de-de'
  assert(tick() and ui.current() == 'de' and ui.t('Settings') == 'Einstellungen')
  local generation = ui.revision()
  gameCode = 'ja-jp'
  for i = 1, 19 do assert(not tick()) end
  assert(reads == 1 and ui.current() == 'de')
  assert(tick() and reads == 2 and ui.current() == 'ja')
  assert(ui.revision() == generation + 1 and ui.t('Settings') == '設定')
  assert(not tick(30) and reads == 3, 'a long frame caused several native reads')
  for i = 1, 15 do assert(not tick(0.01)) end
  assert(reads == 3)
`));

test('native locale aliases resolve the ten offered languages including the Korean game code', () => run(`
  for _, pair in ipairs({{'en-us','en'},{'EN_gb','en'},{'zh-cn','zh-cn'},{'zh-tw','zh-tw'},
      {'zh-Hans','zh-cn'},{'zh-Hant-TW','zh-tw'},{'es-mx','es'},{'pt-br','pt-br'},
      {'fr-fr','fr'},{'de-de','de'},{'ru-ru','ru'},{'ja-jp','ja'},{'kr-kr','ko'},{'ko-kr','ko'},
      {'  fr-FR  ','fr'},{'pl-pl','en'}}) do
      gameCode = pair[1]; tick(2)
      assert(ui.current() == pair[2], 'incorrect locale: ' .. pair[1])
  end
  local offered = ui.supported()
  assert(#offered == 10 and offered[1] == 'en' and offered[10] == 'ko')
  local choices = ui.choices()
  assert(#choices == 11 and choices[1].value == 'auto')
  assert(choices[3].label == '简体中文' and choices[4].label == '繁體中文')
  offered[1], choices[3].label, choices[3].value = 'bad', 'bad', 'bad'
  assert(ui.supported()[1] == 'en' and ui.choices()[3].label == '简体中文')
`));

test('unavailable native state retains the last valid Auto language and later recovers', () => run(`
  catalogs['locales/es.lua'] = {['Settings'] = 'Ajustes'}
  gameCode = 'es-es'; assert(tick())
  failNative = true
  assert(not tick(2) and ui.current() == 'es' and ui.t('Settings') == 'Ajustes')
  for i = 1, 10 do tick(0.01) end
  assert(reads == 2, 'failure retried every frame')
  failNative, gameCode = false, nil
  assert(not tick(2) and ui.current() == 'es')
  gameCode = ''; assert(not tick(2) and ui.current() == 'es')
  gameCode = 'en-us'; assert(tick(2) and ui.current() == 'en')
  assert(ui.t('Settings') == 'Settings')
`));

test('missing or malformed catalogs and unsafe selections fall back without arbitrary file access', () => run(`
  assert(ui.configure('fr')); assert(tick())
  assert(ui.t('Settings') == 'Settings' and not ui.inspect().catalogAvailable)
  assert(requested[1] == 'locales/fr.lua')
  local previous = ui.selection()
  for _, invalid in ipairs({'../private','FR','en-us','',{},12}) do
      assert(not ui.configure(invalid) and ui.selection() == previous)
  end
  assert(not ui.configure(nil) and not ui.configure(false))
  catalogs['locales/ja.lua'] = 'error'; assert(ui.configure('ja')); assert(tick())
  assert(ui.t('Settings') == 'Settings')
  catalogs['locales/ko.lua'] = 123; assert(ui.configure('ko')); assert(tick())
  assert(ui.t('Settings') == 'Settings')
  assert(ui.configure('fr')); assert(tick())
  assert(fileReads == 3, 'catalog fallback was repeatedly read instead of cached')
`));

test('exact source lookup and literal named arguments never translate dialogue or character names', () => run(`
  catalogs['locales/fr.lua'] = {['Invite {name}'] = 'Inviter {name}', ['Settings'] = 'Paramètres',
      ['{name}: {count} / {limit}'] = '{count} / {limit} : {name}', ['Enabled: {state}'] = 'Activé : {state}'}
  ui.configure('fr'); tick()
  nativeCallback = true
  assert(ui.t('Invite {name}', {name = 'Judy 100% {count}'}) == 'Inviter Judy 100% {count}')
  assert(ui.t('{name}: {count} / {limit}', {name = 'ジョニー', count = 0, limit = 8}) == '0 / 8 : ジョニー')
  assert(ui.t('Enabled: {state}', {state = false}) == 'Activé : false')
  assert(ui.t('Invite {name}', {}) == 'Inviter {name}')
  assert(ui.t('Invite {name}', {name = {}}) == 'Inviter {name}')
  assert(ui.t('My new dialogue about Settings') == 'My new dialogue about Settings')
  assert(ui.t('Judy Alvarez') == 'Judy Alvarez' and ui.t('settings') == 'settings')
  assert(ui.t('Unknown {name}', {name = 'Panam'}) == 'Unknown Panam')
  nativeCallback = false
  assert(reads == 0 and fileReads == 1)
`));

test('invalid translated entries cannot lose or introduce interpolation fields', () => run(`
  catalogs['locales/ru.lua'] = {['Invite {name}'] = 'Пригласить', ['Party: {count}'] = 'Группа: {unknown}',
      ['Settings'] = false, ['Empty'] = '', ['Safe'] = 'Безопасно', ['Bad'] = 'bad' .. string.char(0),
      [12] = 'numeric key', ['Literal %'] = '100% буквально'}
  ui.configure('ru'); tick()
  assert(ui.t('Invite {name}', {name = 'Judy'}) == 'Invite Judy')
  assert(ui.t('Party: {count}', {count = 2}) == 'Party: 2')
  assert(ui.t('Settings') == 'Settings' and ui.t('Empty') == 'Empty' and ui.t('Bad') == 'Bad')
  assert(ui.t('Safe') == 'Безопасно' and ui.t('Literal %') == '100% буквально')
`));

test('returning to Auto uses its interface choice without repeated reload or callback work', () => run(`
  catalogs['locales/fr.lua'] = {['Settings'] = 'Paramètres'}
  catalogs['locales/de.lua'] = {['Settings'] = 'Einstellungen'}
  gameCode = 'fr-fr'; tick(); assert(ui.current() == 'fr')
  ui.configure('de'); tick(); assert(ui.current() == 'de')
  nativeCallback = true
  assert(ui.configure('auto') and ui.current() == 'de')
  nativeCallback = false
  assert(tick() and ui.current() == 'fr')
  assert(reads == 2 and fileReads == 2)
  ui.configure('fr'); assert(not tick() and ui.revision() == 3)
  ui.configure('auto'); assert(not tick() and ui.revision() == 3)
  assert(fileReads == 2)
`));

test('callers without delta use a bounded wall-clock poll and recover a backwards clock', () => run(`
  ui.update(); assert(reads == 1)
  for i = 1, 30 do ui.update() end
  assert(reads == 1)
  clock = clock + 1; ui.update(); assert(reads == 1)
  clock = clock + 1; ui.update(); assert(reads == 2)
  clock = clock - 5; ui.update(); assert(reads == 2)
  ui.update(); assert(reads == 2)
  clock = clock + 2; ui.update(0/0); assert(reads == 3)
`));

test('paused zero-delta menu frames still detect interface changes without double-counting clocks',()=>run(`
  catalogs['locales/fr.lua']={['Settings']='Paramètres'}
  ui.update(0);assert(reads==1)
  gameCode='fr-fr';clock=clock+1
  for i=1,60 do ui.update(0) end
  assert(reads==1 and ui.current()=='en')
  clock=clock+1;assert(ui.update(0) and ui.current()=='fr' and reads==2)
  clock=clock+1;ui.update(1);assert(reads==2)
  for i=1,20 do ui.update(0) end
  assert(reads==2)
`));
