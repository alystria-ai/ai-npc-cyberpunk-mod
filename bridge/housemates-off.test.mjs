import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {lua} from './housemate-fixture.mjs';

// Settings > Companion behavior > Housemates (docs/HOUSEMATES.md, "The settings page"). mod/init.lua is too large to run in a test, so the housemate block of
// it (from `convaiHousemates = nil` to the speech tick) runs here against fake game globals, with the real housemate modules behind a counting `dofile`.
const init = readFileSync(new URL('../mod/init.lua', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const start = init.indexOf('convaiHousemates = nil');
const block = init.slice(start, init.indexOf('function convaiHouseTick(')) + '\nend\n';

const PRELUDE = `
  local real = dofile
  loads = {}
  dofile = function(name) loads[#loads + 1] = name; return real(name) end
  gameCalls, hooks, hookFns, dismissed, sets = 0, 0, {}, {}, 0
  facts = {}
  local quests = {GetFactStr = function(_, name) return facts[name] or 0 end, SetFactStr = function(_, name, value) sets = sets + 1; facts[name] = value end}
  Game = setmetatable({}, {__index = function(_, key)
    return function() gameCalls = gameCalls + 1; if key == 'GetQuestsSystem' then return quests end return nil end
  end})
  ObserveAfter = function(class, name, fn) hooks = hooks + 1; hookFns[#hookFns + 1] = fn end
  options = {enabled = false, chat = true}
  manager = {housemates = function() return options end, developerMode = function() return false end}
  bodies = {}
  companions = {
    visitors = function() return bodies end, list = function() return {} end, definition = function(key) return {id = 'Character.' .. key, name = key} end,
    partyMember = function() return nil end, partyMemberOf = function() return nil end, joinVisitor = function() return true end,
    releaseToHome = function() return true end, residentNpc = function() return nil end, phoneContactKey = function(contact) return contact end,
    dismissVisitor = function(serial) dismissed[#dismissed + 1] = serial
      for index, body in ipairs(bodies) do if body.serial == serial then table.remove(bodies, index); break end end
    end,
    residentVisible = function() end}
  managerUi = {party = function() return nil end}
  phoneChat = {}
  profiles = {{key = 'judy-alvarez'}, {key = 'panam-palmer'}}
  supportedProfiles = {}
  ui = {t = function(text, vars) return text end}
  log = function() end
  convaiLogOnce = function() end
  currentDistrict = function() return nil end
  convaiGestures = {catalog = {}}
  convaiSeating = {native = {}}
  convaiNotices = {send = function() end}
  convaiHolocall = nil
  battleSample = nil
  active, pending, automatic = nil, nil, nil
  groupChat = {}
  speech, subtitles, microphone = {}, {ownsUtterance = function() return false end}, {}
  cancelAutomatic = function() end
  json = {encode = function() return '{}' end, decode = function() return {} end}
  io = {open = function() return nil end}
  GameTime = {}
  ${block}
  registry = dofile('housemate-registry.lua')
  loads = {}
`;

test('with the setting Off a tick and every entry point return at once: no housemate module is loaded, no game call is made, no hook is installed', () => lua(`
  assert(convaiHousemates == nil)
  for _ = 1, 100 do convaiHousemateTick(0.1) end
  local offer = {available = true, members = {}}
  assert(convaiHousemateOffer('1', {profileKey = 'judy-alvarez'}) == nil)
  assert(convaiHousemateGroupOffer('1', {profileKey = 'judy-alvarez'}) == nil)
  local ok, why = convaiHousemateQueue({op = 'stay'}, {}, '1', 'r', nil)
  assert(ok == false and why == 'That action is not available.')
  assert(convaiHousemateLeaveOffer(offer) == offer)
  local passed = false
  local result = convaiHousemateQueueLeave('all', offer, '1', 'r', nil, function() passed = true; return 'adopted' end)
  assert(passed and result == 'adopted', 'the old leave path runs')
  local snapshot = {place = 'x'}
  assert(convaiHousemateTurn(snapshot, 'judy-alvarez') == snapshot)
  convaiHousemateTalk('1'); convaiHousemateLearn({x = 0, y = 0, z = 0}, {x = 0, y = 1, z = 0}, 'seat')
  assert(#convaiHousemateRows() == 0)
  assert(convaiHousemateMoveOut('judy-alvarez') == false)
  convaiHousemateWake()
  convaiHousemateReset('world-ended', false); convaiHousemateReset('fast-travel', true)
  assert(phoneChat.captureHomeOffer('judy-alvarez', 'judy-alvarez') == nil)
  phoneChat.onHomeAction('judy-alvarez', {token = 'home-1'})
  assert(convaiResidentNpc({GetEntityID = function() return {hash = 1} end}) == false)
  assert(companions.housematesOn() == false)
  assert(#loads == 0, 'loaded: ' .. table.concat(loads, ', '))
  assert(gameCalls == 0, 'game calls: ' .. gameCalls)
  assert(hooks == 0 and sets == 0 and convaiHousemates == nil)
`, {prelude: PRELUDE}));

test('a resident body is not dressed by the outfit hook while the setting is Off', () => {
  const source = readFileSync(new URL('../mod/companions.lua', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  assert.match(source, /entry\.state=='visiting' and entry\.owner=='housemates' and \(M\.housematesOn==nil or M\.housematesOn\(\)==true\)/);
});

const people = `
  facts[registry.factName('judy-alvarez')] = 2
  facts[registry.factName('panam-palmer')] = 2
  sets = 0
`;

test('On builds the service on the next tick and installs the district hook once; Off removes the bodies, keeps the saved flats and ignores the hook; On brings them back', () => lua(`
  ${people}
  options = {enabled = true, chat = true}
  convaiHousemateTick(0.1)
  assert(convaiHousemates and convaiHousemates.controller, 'the controller exists after the first tick')
  local first = convaiHousemates
  local homes = convaiHousemates.controller.homes()
  assert(homes['judy-alvarez'] == 'corpo' and homes['panam-palmer'] == 'corpo')
  assert(hooks == 1, 'one district hook: ' .. hooks)
  assert(companions.housematesOn() == true)
  local names = table.concat(loads, ',')
  assert(names:find('housemate-service.lua', 1, true) and names:find('housemates.lua', 1, true) and names:find('housemate-chat.lua', 1, true), names)
  -- two bodies of ours and one that is not
  bodies[1] = {serial = 11, owner = 'housemates', profileKey = 'judy-alvarez', state = 'visiting'}
  bodies[2] = {serial = 12, owner = 'housemates', profileKey = 'panam-palmer', state = 'visiting'}
  bodies[3] = {serial = 13, owner = nil, profileKey = 'rogue', state = 'visiting'}
  options = {enabled = false, chat = true}
  assert(convaiHousemateOffer('1', {profileKey = 'judy-alvarez'}) == nil, 'Off at once, before the tick')
  assert(#convaiHousemateRows() == 0)
  convaiHousemateTick(0.1)
  assert(convaiHousemates == nil, 'the glue is dropped')
  local out = table.concat(dismissed, ',')
  assert(out == '11,12' or out == '12,11', 'only the housemates bodies were removed: ' .. out)
  assert(#bodies == 1 and bodies[1].serial == 13)
  assert(sets == 0, 'the saved flats were not written')
  assert(facts[registry.factName('judy-alvarez')] == 2 and facts[registry.factName('panam-palmer')] == 2, 'the saved flats are kept')
  -- the hook cannot be removed: it does nothing now
  for _, fn in ipairs(hookFns) do fn() end
  local before = #loads
  for _ = 1, 20 do convaiHousemateTick(0.1) end
  assert(#loads == before and convaiHousemates == nil, 'Off again builds nothing')
  -- On again: the next tick builds the service and the flats come back
  options = {enabled = true, chat = true}
  convaiHousemateTick(0.1)
  assert(convaiHousemates and convaiHousemates ~= first and convaiHousemates.controller)
  assert(convaiHousemates.controller.homes()['judy-alvarez'] == 'corpo' and convaiHousemates.controller.homes()['panam-palmer'] == 'corpo')
  assert(hooks == 1, 'the hook is installed only on the first On: ' .. hooks)
`, {prelude: PRELUDE}));

test('Housemates talk to each other Off: the pair chat module is not loaded, and loads when it is turned On', () => lua(`
  ${people}
  options = {enabled = true, chat = false}
  convaiHousemateTick(0.1)
  assert(convaiHousemates and convaiHousemates.controller)
  local names = table.concat(loads, ',')
  assert(not names:find('housemate-chat.lua', 1, true), names)
  assert(convaiHousemates.controller.chatActive() == false)
  options = {enabled = true, chat = true}
  convaiHousemateTick(0.1)
  assert(table.concat(loads, ','):find('housemate-chat.lua', 1, true), 'loaded once it is wanted')
  options = {enabled = true, chat = false}
  convaiHousemateTick(0.1)
  assert(convaiHousemates.controller.chatActive() == false)
`, {prelude: PRELUDE}));

test('init.lua: the tick returns before any module when the setting is Off, and the module is never loaded at start', () => {
  const tick = block.slice(block.indexOf('function convaiHousemateTick(delta)'), block.indexOf('function convaiHousemateReset'));
  const early = tick.slice(0, tick.indexOf('local glue = convaiHousemates or service()'));
  assert.match(early, /if not on\(\) then/);
  assert.match(early, /return\s+end/);
  assert.doesNotMatch(early, /Game\.|dofile|pcall/);
  assert.doesNotMatch(init.replace(block, ''), /dofile\('housemate-[a-z-]+\.lua'\)/);
  assert.match(block, /pcall\(dofile, 'housemate-service\.lua'\)/);
  // the district hook is installed by the glue's build, which only runs while the setting is On
  assert.equal((init.match(/ObserveAfter\('PreventionSystem', 'OnDistrictAreaEntered'/g) || []).length, 1);
  assert.match(block, /local function service\(\)\n\s+if not on\(\) then return nil end/);
});
