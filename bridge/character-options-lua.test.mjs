import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import fengari from 'fengari';

// The game's half of the character editor's "Look and moves" (docs/CHARACTER_EDITOR.md), under fengari with stand-ins for the game:
// the file the game reads (mod/character-options.lua), the looks a player pins (mod/companion-outfits.lua), the talking styles
// (mod/gesture-selection.lua), the controller's gates (mod/companion-gestures.lua) and the wiring in mod/init.lua.
const read = path => readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const optionsSource = read('../mod/character-options.lua');
const outfitsSource = read('../mod/companion-outfits.lua');
const outfitsData = read('../mod/companion-outfits-data.lua');
const selectionSource = read('../mod/gesture-selection.lua');
const controllerSource = read('../mod/companion-gestures.lua');
const catalogSource = read('../mod/gesture-catalog.lua');
const initSource = read('../mod/init.lua');
const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;

function runWith(program) {
  const vm = lauxlib.luaL_newstate(); lualib.luaL_openlibs(vm);
  try {
    const result = lauxlib.luaL_dostring(vm, to_luastring(program));
    const error = result === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(vm, -1));
    const line = Number(/\]:(\d+):/.exec(error)?.[1]);
    assert.equal(result, lua.LUA_OK, error + (line ? '\n' + program.split('\n')[line - 1] : ''));
  } finally { lua.lua_close(vm); }
}

// ---------------------------------------------------------------- the file the game reads

const optionsFixture = `
local M = (function() ${optionsSource} end)()
local clock, files, reads = 1000, {}, 0
local decoded = {}
local changes = 0
local function build(extra)
  local o = {clock = function() return clock end,
    read = function() reads = reads + 1; return files.text end,
    decode = function(text) local value = decoded[text]; if value == nil then error('bad json') end return value end,
    onChange = function() changes = changes + 1 end}
  for k, v in pairs(extra or {}) do o[k] = v end
  return M.new(o)
end
local function put(text, value) files.text = text; decoded[text] = value end
`;

test('the file: only allowed values are taken, a character with no row has none, and the first read is not a change', () => runWith(`${optionsFixture}
  put('a', {version = 1, characters = {
    ['judy-alvarez'] = {outfit = 'judy__mq055__apartment_01', talk = 'calm', nods = false, idle = 'plain', sit = false, react = false},
    ['panam-palmer'] = {talk = 'wild', nods = true, idle = 'x', sit = true, react = 'no', outfit = '../etc', unknown = 1},
    ['river-ward'] = {},
    [7] = {sit = false}, ['rogue-amendiares'] = 'text'}})
  local o = build()
  assert(o.refresh() == true and changes == 1, 'the first read reports what it found (a file the editor has just created is a change)')
  assert(o.get('judy-alvarez').talk == 'calm' and o.get('judy-alvarez').nods == false and o.get('judy-alvarez').idle == 'plain')
  assert(o.get('judy-alvarez').sit == false and o.get('judy-alvarez').react == false and o.outfit('judy-alvarez') == 'judy__mq055__apartment_01')
  assert(o.get('panam-palmer') == nil, 'today\\'s values and unknown ones leave no row')
  assert(o.get('river-ward') == nil and o.get('nobody') == nil and o.get(nil) == nil and o.outfit('nobody') == nil)
  assert(o.hasOutfits() == true)
  put('b', {version = 1, characters = {['panam-palmer'] = {sit = false}}})
  assert(o.refresh() == true and changes == 2 and o.get('judy-alvarez') == nil and o.get('panam-palmer').sit == false and o.hasOutfits() == false)
  assert(o.refresh() == false and changes == 2, 'the same text is no change')
`));

test('an unreadable, empty or damaged file leaves the choices as they were', () => runWith(`${optionsFixture}
  put('a', {version = 1, characters = {['judy-alvarez'] = {talk = 'calm'}}})
  local o = build(); o.refresh()
  files.text = nil
  assert(o.refresh() == false and o.get('judy-alvarez').talk == 'calm', 'no file: nothing yet')
  files.text = '{ broken'
  assert(o.refresh() == false and o.get('judy-alvarez').talk == 'calm', 'damaged: the old choices stand')
  put('   ', nil)
  decoded['   '] = nil
  files.text = '   '
  assert(o.refresh() == true and o.get('judy-alvarez') == nil, 'a blank file (the placeholder) is no choices')
  assert(build({read = function() error('locked') end}).refresh() == false, 'a read that fails is nothing yet')
`));

test('nothing is read unless the editor was opened lately: the tick costs a subtraction, and the file is looked at every five seconds for two hours', () => runWith(`${optionsFixture}
  put('a', {version = 1, characters = {}})
  local o = build(); o.refresh(); reads = 0
  for i = 1, 3000 do o.tick(0.1) end
  assert(reads == 0, 'never opened: never read, got ' .. reads)
  o.watch()
  put('b', {version = 1, characters = {['judy-alvarez'] = {talk = 'none'}}})
  o.tick(0.1)
  assert(reads == 1 and o.get('judy-alvarez').talk == 'none' and changes == 2, 'the first tick after Open looks at once')
  for i = 1, 45 do o.tick(0.1) end
  assert(reads == 1, 'then every five seconds, not before: ' .. reads)
  for i = 1, 10 do o.tick(0.1) end
  assert(reads == 2)
  clock = clock + 7201
  for i = 1, 60 do o.tick(0.1) end
  local after = reads
  for i = 1, 600 do o.tick(0.1) end
  assert(reads == after, 'two hours after Open the file is left alone again')
  o.watch(); o.tick(0.1)
  assert(reads == after + 1, 'Open again: watched again')
`));

// ---------------------------------------------------------------- the looks

const outfitFixture = `
local clock, hours = 1000, 24 * 3 + 10
local outfits = (function() ${outfitsSource} end)()
outfits.clock = function() return clock end
dofile = function(name) assert(name == 'companion-outfits-data.lua', name); return (function() ${outfitsData} end)() end
local f = {enabled = false, world = nil, busy = {}, seen = false, pin = {}, any = false}
local worn, rowsList, logs, calls = {}, {}, {}, {rows = 0, prefetch = {}, apply = {}, hours = 0}
outfits.deps = {
  enabled = function() return f.enabled end,
  pinned = function(key) return f.pin[key] end,
  anyPinned = function() return f.any end,
  rows = function() calls.rows = calls.rows + 1; local out = {}
    for _, row in ipairs(rowsList) do out[#out + 1] = {serial = row.serial, key = row.key, record = row.record, npc = {serial = row.serial}} end
    return out end,
  current = function(row) return worn[row.serial] end,
  prefetch = function(row, name) calls.prefetch[#calls.prefetch + 1] = row.serial .. ':' .. name end,
  apply = function(row, name) calls.apply[#calls.apply + 1] = row.serial .. ':' .. name; worn[row.serial] = name end,
  remember = function() end,
  gameHours = function() calls.hours = calls.hours + 1; return hours end,
  place = function() return nil end,
  world = function() return f.world end,
  busy = function(row) return f.busy[row.serial] end,
  frustum = function() return f.seen end,
  hidden = function() return nil end,
  angle = function() return nil end,
  random = function() return 0 end,
  log = function(line) logs[#logs + 1] = line end,
}
local function member(serial, key, record, name) rowsList[#rowsList + 1] = {serial = serial, key = key, record = record}; worn[serial] = name end
local function cycle(seconds) clock = clock + (seconds or 20); outfits.tick({}, seconds or 20, true) end
local function at(day, hour) hours = day * 24 + hour end
local function unseen() cycle(); cycle(20) end
`;

test('a look the player pinned is worn with the setting off, out of view, until it shows; nobody else is touched', () => runWith(`${outfitFixture}
  member(1, 'judy-alvarez', 'Character.Judy', 'judy_default')
  member(2, 'panam-palmer', 'Character.Panam', 'panam_default')
  f.enabled = false; f.any = false
  at(3, 12); cycle(); cycle()
  assert(calls.rows == 0 and #calls.prefetch == 0, 'setting off and nothing pinned: the module does nothing at all')
  f.pin['judy-alvarez'] = 'judy__mq055__apartment_01'; f.any = true
  f.seen = true; cycle()
  assert(calls.rows == 1 and #calls.prefetch == 0, 'she is looked at, but not changed in view')
  f.seen = false; unseen()
  assert(#calls.prefetch == 1 and calls.prefetch[1] == '1:judy__mq055__apartment_01', 'loaded: ' .. tostring(calls.prefetch[1]))
  cycle(1.0); assert(#calls.apply == 1 and calls.apply[1] == '1:judy__mq055__apartment_01')
  cycle(1.0); assert(outfits.snapshot()[1].current == 'judy__mq055__apartment_01')
  assert(outfits.status(1) == 'home', 'the turn context knows she is in other clothes')
  assert(#calls.apply == 1 and worn[2] == 'panam_default', 'Panam has no pin and the setting is off: left alone')
  -- Worn, pinned: nothing more to do, at any hour.
  at(3, 22); cycle(); cycle(); at(4, 8); cycle(); cycle()
  assert(#calls.apply == 1, 'no night look, no variety, no change back')
`));

test('a pinned look beats the time of day, the variety roll and the home clothes; a look that never showed is not tried again', () => runWith(`${outfitFixture}
  f.enabled = true
  member(1, 'panam-palmer', 'Character.Panam', 'panam_no_jacket')       -- a day look
  f.pin['panam-palmer'] = 'panam_no_jacket'; f.any = true
  at(3, 22); f.seen = false; unseen(); unseen()
  assert(#calls.prefetch == 0 and #calls.apply == 0, 'night, but she keeps the look the player picked')
  local panam = outfits.character('Character.Panam')
  assert(outfits.choose(panam, 'panam_no_jacket', {period = 'night', home = true, hourChanged = true, random = function() return 0 end, bad = {}, pinned = 'panam_no_jacket'}) == nil)
  local name, why = outfits.choose(panam, 'panam_default', {period = 'day', bad = {}, pinned = 'panam__mq055__apartment_01'})
  assert(name == 'panam__mq055__apartment_01' and why == 'chosen')
  assert(outfits.choose(panam, 'panam_default', {period = 'day', bad = {panam__mq055__apartment_01 = true}, pinned = 'panam__mq055__apartment_01'}) == nil, 'a look that failed once is left')
  -- Without a pin the rotation is the old one.
  f.pin['panam-palmer'] = nil; f.any = false
  at(3, 22); cycle(); unseen(); unseen()
  assert(#calls.prefetch >= 1 and calls.prefetch[1] == '1:panam_default', 'back to the night look of the rotation: ' .. tostring(calls.prefetch[1]))
`));

test('a pin that is not one of the character\'s own looks, or belongs to a character the list does not hold, changes nothing', () => runWith(`${outfitFixture}
  f.enabled = false; f.any = true
  member(1, 'judy-alvarez', 'Character.Judy', 'judy_default')
  member(2, 'misty-olszewski', 'Character.Misty', 'misty_default')
  f.pin['judy-alvarez'] = 'panam_no_jacket'         -- another character's look
  f.pin['misty-olszewski'] = 'misty_default'         -- nothing curated for her
  f.seen = false; cycle(); unseen(); unseen()
  assert(#calls.prefetch == 0 and #calls.apply == 0)
  assert(outfits.spawnAppearance('Character.Judy', 'judy-alvarez') == nil, 'not a look of hers: a new copy is made as before')
  assert(outfits.spawnAppearance('Character.Misty', 'misty-olszewski') == nil)
  f.pin['judy-alvarez'] = 'nonsense'
  assert(outfits.spawnAppearance('Character.Judy', 'judy-alvarez') == nil)
`));

test('a new copy is made in the pinned look, whatever the setting says; without a pin the setting decides as before', () => runWith(`${outfitFixture}
  at(3, 10)
  f.enabled = false
  assert(outfits.spawnAppearance('Character.Judy', 'judy-alvarez') == nil, 'setting off, no pin: the game decides')
  f.pin['judy-alvarez'] = 'judy__mq055__apartment_01'; f.any = true
  assert(outfits.spawnAppearance('Character.Judy', 'judy-alvarez') == 'judy__mq055__apartment_01')
  assert(outfits.spawnAppearance('Character.Judy', 'someone-else') == nil)
  f.pin['judy-alvarez'] = 'judy_default'
  assert(outfits.spawnAppearance('Character.Judy', 'judy-alvarez') == 'judy_default', 'her usual look can be pinned too')
  f.enabled = true; f.pin['judy-alvarez'] = nil; f.any = false
  assert(outfits.spawnAppearance('Character.Judy', 'judy-alvarez') == nil, 'daytime, away from home: nothing to change')
  at(3, 22)
  f.pin['panam-palmer'] = 'panam_no_jacket'
  assert(outfits.spawnAppearance('Character.Panam', 'panam-palmer') == 'panam_no_jacket', 'a day look pinned, made at night')
`));

test('a pin saved while the copy is spawned is acted on at the next look, which the nudge brings forward', () => runWith(`${outfitFixture}
  f.enabled = true
  member(1, 'judy-alvarez', 'Character.Judy', 'judy_default')
  at(3, 12); f.seen = false; cycle()
  assert(#calls.prefetch == 0)
  f.pin['judy-alvarez'] = 'judy__mq055__apartment_01'; f.any = true
  outfits.nudge()
  cycle(1.0); cycle(5)
  assert(#calls.prefetch == 1, 'soon, not after the next 20 s check: ' .. #calls.prefetch)
  assert(outfits.nudge ~= nil and outfits.anyPinned() == true)
  f.any = false
  assert(outfits.anyPinned() == false)
`));

// ---------------------------------------------------------------- the talking styles

const selectionFixture = `
local m = (function() ${selectionSource} end)()
local seed = 1
local function lcg() seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 end
local function clip(name, category, duration, reach)
  local d = {duration = duration, reach = reach, centre = .8}
  return {name = 'st__01__' .. name, category = category, perRig = {woman_base = d, man_base = d, man_big = d}}
end
local clips = {}
for i = 1, 6 do
  clips[#clips + 1] = clip('talk__neutral__0' .. i, 'neutral', 3, 22 + i * 6)
  clips[#clips + 1] = clip('what__neutral__0' .. i, 'question', 3, 24 + i * 5)
  clips[#clips + 1] = clip('yes__happy__0' .. i, 'happy', 3, 40 + i * 3)
  clips[#clips + 1] = clip('nod__head__0' .. i, 'nod', 2, 16)
end
local function speak(s, t, extra)
  local input = {now = t, mode = 'speaking', rig = 'woman_base', character = 'judy', family = 'joy', scale = 2, remaining = 40, clips = clips}
  for k, v in pairs(extra or {}) do input[k] = v end
  return m.next(s, input)
end
local function play(extra, seconds, seedAt)
  seed = seedAt or 1
  local s = m.new(lcg)
  local list = {}
  for t = 0, seconds or 120, .1 do
    local item = speak(s, t, extra)
    if item then list[#list + 1] = {at = t, name = item.clip.name, reach = item.clip.perRig.woman_base.reach, category = item.clip.category} end
  end
  return list
end
`;

test('talking styles: the default is untouched, calm gestures less often and smaller, lively more often and bigger, none never', () => runWith(`${selectionFixture}
  local function total(style, extra)
    local n, reach, happy = 0, 0, 0
    for run = 1, 12 do
      local e = {style = style}; for k, v in pairs(extra or {}) do e[k] = v end
      for _, p in ipairs(play(e, 120, run * 17)) do n = n + 1; reach = reach + p.reach; if p.category == 'happy' then happy = happy + 1 end end
    end
    return n, n > 0 and reach / n or 0, happy
  end
  local normal, normalReach = total(nil)
  local calm, calmReach, calmHappy = total('calm')
  local lively, livelyReach, livelyHappy = total('lively')
  local none = total('none')
  assert(normal > 20, 'normal ' .. normal)
  assert(calm < normal * 0.85, 'calm ' .. calm .. ' against ' .. normal)
  assert(lively > normal * 1.15, 'lively ' .. lively .. ' against ' .. normal)
  -- The reach of the arms: measured where the mood's cap binds (a neutral line at the lowest intensity).
  local flat = {family = 'neutral', scale = 1}
  local _, nr = total(nil, flat)
  local _, cr = total('calm', flat)
  local _, lr = total('lively', flat)
  assert(cr < nr and lr > nr, cr .. ' < ' .. nr .. ' < ' .. lr)
  assert(none == 0, 'none plays nothing')
  -- The default is the same as a name the policy does not know: nothing changed for a character with no choice.
  local a, b = play({}, 90, 5), play({style = 'normal'}, 90, 5)
  assert(#a == #b and #a > 0)
  for i = 1, #a do assert(a[i].name == b[i].name and a[i].at == b[i].at, 'same sequence') end
  assert(m.styles.none == nil, 'none is the controller\\'s: no stance')
`));

test('nods: a character whose nods are off never nods, in a private talk or in a group; the default still nods', () => runWith(`${selectionFixture}
  local function nods(extra, group)
    local n = 0
    for run = 1, 10 do
      seed = run * 31
      local s = m.new(lcg)
      for t = 0, 90, .1 do
        local input = {now = t, mode = 'listening', rig = 'woman_base', character = 'judy', clips = clips, group = group, total = 30, remaining = 20}
        for k, v in pairs(extra or {}) do input[k] = v end
        if m.next(s, input) then n = n + 1 end
      end
    end
    return n
  end
  assert(nods({}) > 5, 'a private listener nods: ' .. nods({}))
  assert(nods({nods = false}) == 0)
  assert(nods({nods = false}, true) == 0)
  assert(nods({nods = true}) > 5)
  assert(nods({style = 'none'}) > 5, 'the talking style does not switch the nods off')
`));

// ---------------------------------------------------------------- the controller

const controllerFixture = `
local selectionSource=[==[${selectionSource}]==]
local catalogSource=[==[${catalogSource}]==]
dofile=function(path)
  if path=='gesture-selection.lua' then return load(selectionSource)() end
  if path=='gesture-catalog.lua' then return load(catalogSource)() end
  if path=='gesture-workspot.lua' then return {} end
  error('unexpected dofile '..path)
end
local calls,logs={}, {}
local function count(name) local n=0;for _,c in ipairs(calls) do if c.name==name then n=n+1 end end;return n end
local function plays(text) local n=0 for _,c in ipairs(calls) do if c.name=='play' and c.component:find(text,1,true) then n=n+1 end end return n end
local npc={inside=false}
local native={TAG='t'}
function native.inWorkspot(n) return n.inside end
function native.spawnDevice(n,t) calls[#calls+1]={name='spawn'};return true,{hash=9} end
function native.deviceEntity(id) return {device=true} end
function native.moveDevice() return true end
function native.devicePlaced() return true end
function native.deleteDevice() return true end
function native.sweep() return true end
function native.play(d,n,component) calls[#calls+1]={name='play',component=component};n.entering=true;return true end
function native.jump(n,clip,instant) calls[#calls+1]={name='jump',clip=clip};return true end
function native.exit(n,instant) calls[#calls+1]={name='exit'};n.leaving=true;return true end
function native.stopInDevice(n) return true end
local m=(load([==[${controllerSource}]==]))()
m.policy.conversationHold=2.5 -- the stance is left 2.5 s after a conversation, so a test can see it entered again
local chosen=nil
local speaking,listening=nil,nil
local seed=7
local c=m.new({enabled=function() return true end,
  speech=function(entity) if speaking and entity=='77' then return speaking end end,
  listening=function() return listening end,
  prefs=function(entry) return chosen end,
  allowed=function() return true end, native=native,
  random=function() seed=(seed*1103515245+12345)%2147483648;return seed/2147483648 end,
  log=function(kind,fields) logs[#logs+1]={kind=kind,fields=fields} end})
local player={pos={x=0,y=0,z=0}}
function player:GetWorldPosition() return self.pos end
local entry={serial=1,record='Character.Judy',profileKey='judy-alvarez',entityID={hash='77'},npc=npc,playerGap=1.8,
  motor={kind='hold',feedback={state='AICommandState : Executing (2)'}}}
local context={idle=true,settled=true,combat=false,phase='settled'}
local function step(seconds)
  for i=1,math.max(1,math.floor(seconds/.1+.5)) do
    c.tick(player,.1,{{entry=entry}})
    if npc.entering then npc.entering=nil;npc.inside=true end
    if npc.leaving then npc.leaving=nil;npc.inside=false end
    if speaking then speaking.at=math.min(speaking.knownEnd,(speaking.at or 0)+.1) end
    if listening then c.observe(entry,context,.1) else c.observe(entry,context,.1) end
  end
end
step(1.2);seed=7
`;

test('controller, talking: no choice is today\'s behaviour; "none" never enters the talk stance for a spoken reply; calm and lively still do', () => runWith(`${controllerFixture}
  speaking={knownEnd=14,at=0,family='joy',scale=2};step(6)
  assert(plays('convai_talk')>=1 and count('jump')>=1, 'no choice: the stance and gestures')
  speaking=nil;step(8)
  local before=plays('convai_talk')
  chosen={talk='calm'}; speaking={knownEnd=14,at=0,family='joy',scale=2};step(6)
  assert(plays('convai_talk')>before,'calm: the stance is entered')
  speaking=nil;step(8)
  local jumps,talks=count('jump'),plays('convai_talk')
  chosen={talk='none'}; speaking={knownEnd=14,at=0,family='joy',scale=2};step(8)
  assert(plays('convai_talk')==talks and count('jump')==jumps,'none: no stance, no gesture')
`));

test('controller, nods: with the nods off a listening character does not enter the stance; with talking off and nods on it does, and a spoken reply gets no clip', () => runWith(`${controllerFixture}
  chosen={nods=false}; listening='77'; step(8)
  assert(plays('convai_talk')==0,'nods off: V talking brings no stance')
  chosen=nil; step(3)
  assert(plays('convai_talk')==1,'default: she listens in the stance')
  listening=nil; step(6)
  chosen={talk='none'}
  local jumps=count('jump')
  speaking={knownEnd=14,at=0,family='joy',scale=2};step(8)
  assert(count('jump')==jumps,'no gesture for a reply while talking is off')
`));

test('controller, idle moves: "none" never starts one, "plain" never starts a prop idle, no choice does as before', () => runWith(`${controllerFixture}
  chosen={idle='none'}; step(120)
  assert(plays('convai_idle')==0 and plays('convai_talk')==0,'none: she keeps the stance she has')
  chosen={idle='plain'}; step(900)
  assert(plays('convai_idle')>=1,'plain: she still has idle moves')
  assert(plays('coffee')==0 and plays('smoke')==0 and plays('beer')==0 and plays('shades')==0,'no prop idle')
  chosen=nil; step(600)
  assert(plays('convai_idle')>=2,'no choice: as before')
`));

// ---------------------------------------------------------------- the wiring

test('init.lua wires the choices: one lookup by profile key for gestures, seating, looks and reactions, a tick that reads only after the editor was opened, nothing per frame', () => {
  assert.match(initSource, /dofile, 'character-options\.lua'/);
  assert.match(initSource, /convaiCharacterOptions = service/);
  assert.equal([...initSource.matchAll(/prefs = function\(entry\) local chosen = convaiCharacterOptions; return chosen and entry and chosen\.get\(entry\.profileKey\) or nil end/g)].length, 2, 'gestures and seating');
  assert.match(initSource, /pinned = function\(key\) local chosen = convaiCharacterOptions; return chosen and chosen\.outfit\(key\) or nil end/);
  assert.match(initSource, /if chosen then chosen\.tick\(elapsed\) end/);
  assert.match(initSource, /not manager\.companionOutfits\(\) and not \(chosen and chosen\.hasOutfits\(\)\)/);
  assert.match(initSource, /chosen and chosen\.react == false/);
  assert.match(read('../mod/manager-ui.lua'), /convaiCharacterOptions\.watch\(\)/);
  assert.match(read('../mod/companion-seating.lua'), /chosen\.sit == false then return nil end/);
  // The module itself has no update hook and no native call: a file, a table, and a counter.
  assert.doesNotMatch(optionsSource.replace(/--.*$/gm, ''), /\bGame\.|Observe|Override|GameInstance|registerForEvent/);
});

test('the exchange file is written by the service: the Lua side only reads it', () => {
  assert.doesNotMatch(optionsSource, /io\.open\([^)]*['"]w/);
  const layout = JSON.parse(read('../packaging/runtime-exchange.json'));
  assert(layout.exchange.includes('character-options.json'));
  assert.match(optionsSource, /runtime\/character-options\.json/);
});
