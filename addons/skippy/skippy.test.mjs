import {test} from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, readFileSync} from 'node:fs';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {WORLD, runLua} from '../../bridge/addon-lua-harness.mjs';
import {ADDON_MANIFEST, AddonHost, inspectReference, validateManifest} from '../../bridge/addons.mjs';
import {parseInput} from '../../bridge/protocol.mjs';
import {buildAddon} from '../../packaging/build-addon.mjs';
import {describeVictim, momentBlock, remember, speakerBlocks} from './bridge.mjs';

// Skippy end to end with no game, no network and no sound: the fight engine on its own (plain Lua in fengari), the game hooks
// against the real mod/addons.lua with a fake world, the manifest and the voice reference, the bridge hooks, and the package.
const dir = fileURLToPath(new URL('.', import.meta.url));
const engineLua = readFileSync(new URL('./engine.lua', import.meta.url), 'utf8');
const initLua = readFileSync(new URL('./init.lua', import.meta.url), 'utf8');
// The voice clip is game audio, kept out of git (.gitignore); a clean checkout (CI) skips the checks that need it.
const voiceSkip = existsSync(new URL('./voice/skippy.wav', import.meta.url)) ? false : 'the voice clip is not in git; it is present only in a local checkout';

// ---- The engine -------------------------------------------------------------------------------------------------------------

const ENGINE = `${WORLD}
local Engine = (function() ${engineLua} end)()
local clock, calls, refuse, mode, vanilla, stocked = 0, {}, nil, 'puppy', false, {}
local cancelled = 0
local function make()
    return Engine.new({now = function() return clock end,
        remark = function(name, spec)
            calls[#calls + 1] = {name = name, spec = spec}
            if refuse then return false, refuse end
            return true
        end,
        cancel = function() cancelled = cancelled + 1 end,
        mode = function() return mode end,
        where = function() return {district = 'Watson', area = 'Little China', timeOfDay = 'night'} end,
        lookAt = function() return {name = 'Maelstrom Gunner', kind = 'human'} end,
        vanillaBusy = function() return vanilla end,
        stock = function(event, spec) stocked[event] = spec or false end,
        remember = function(text) calls[#calls + 1] = {name = 'remember', text = text} end})
end
local function last() return calls[#calls] end
local function victim(extra) local v = {kind = 'human', rarity = 'normal', faction = 'Maelstrom', distance = 12, weapon = 'skippy', lethal = true}
    for k, x in pairs(extra or {}) do v[k] = x end return v end
`;

function lua(body) {
  const out = runLua(`${ENGINE}\n${body}`);
  return out === undefined ? undefined : JSON.parse(out);
}
const dump = '\nreturn json.encode(result)';

test('a fight is a stream of distinct moments: start, first kill, headshots, streak, health, end, each with its priority', () => {
  const result = lua(`
    local e = make()
    e:start({healthPct = 100})
    clock = 9; e:onKill(victim())
    clock = 14; e:onKill(victim({headshot = true, zone = 'head'}))
    clock = 15; e:onKill(victim({headshot = true}))
    clock = 16; e:onKill(victim({headshot = true}))
    clock = 30; e:onHealth(45)
    clock = 40; e:onHealth(20)
    clock = 50; e:stop()
    local names, pri, endFacts = {}, {}, nil
    for _, c in ipairs(calls) do
        if c.name ~= 'remember' then names[#names + 1] = c.name; pri[#pri + 1] = c.spec.priority; endFacts = c.spec.facts end
    end
    local result = {names = names, pri = pri, endFacts = endFacts}
  ${dump}`);
  assert.deepEqual(result.names.slice(0, 3), ['fight-start', 'first-kill', 'headshot']);
  assert.ok(result.names.includes('headshot-streak'), 'the third headshot in a row is a streak');
  assert.ok(result.names.includes('v-hurt'));
  assert.ok(result.names.includes('near-death'));
  assert.equal(result.names.at(-1), 'fight-end');
  assert.deepEqual(result.pri.slice(0, 2), [3, 4], 'fight start 3, first kill 4');
  assert.equal(result.pri[result.names.indexOf('near-death')], 5);
  assert.equal(result.pri.at(-1), 5);
  assert.equal(result.endFacts.fight.kills, 4);
  assert.equal(result.endFacts.fight.headshots, 3);
  assert.equal(result.endFacts.outcome, 'narrow');
  assert.equal(result.endFacts.where.district, 'Watson');
});

test('every fact is plain data inside the bridge limits, unknown facts are left out, and counts are integers', () => {
  const result = lua(`
    local e = make()
    e:start({})
    clock = 3; e:onCombatants(4)
    clock = 8; e:onKill(victim({name = 'Maelstrom Gunner', headshot = true, zone = 'head', stealth = nil}))
    local f = last().spec.facts
    local result = {facts = f, size = #json.encode(f)}
  ${dump}`);
  const {facts, size} = result;
  assert.ok(size < 1500, 'facts stay small');
  assert.equal(facts.mode, 'puppy');
  assert.equal(facts.fight.enemies, 4);
  assert.equal(facts.fight.kills, 1);
  assert.equal(facts.fight.sinceLastKill, 0);
  assert.equal(facts.fight.accuracy, undefined, 'accuracy only after six shots');
  assert.equal(facts.victim.weapon, 'skippy');
  assert.equal(facts.victim.cyberpsycho, undefined, 'flags that are false are left out');
  for (const [key, value] of Object.entries(facts.fight)) assert.ok(value === true || typeof value === 'number' || typeof value === 'string', key);
});

test('one kill makes one remark: the best candidate wins, ties follow the order, puppy lethal kills are priority 3', () => {
  const result = lua(`
    local e = make()
    e:start({})
    clock = 5
    e:onKill(victim({rarity = 'elite', headshot = true, distance = 40}))
    local first = last()
    clock = 20
    e:onKill(victim())
    local plain = last()
    mode = 'killer'
    clock = 40
    e:onKill(victim())
    local killer = last()
    local result = {first = first.name, firstPri = first.spec.priority, plain = plain.name, plainPri = plain.spec.priority,
      killerPri = killer.spec.priority, regret = plain.spec.facts.regret, count = #calls}
  ${dump}`);
  assert.equal(result.first, 'first-kill', 'first kill beats a headshot or a long shot of the same priority');
  assert.equal(result.firstPri, 4);
  assert.equal(result.plain, 'kill');
  assert.equal(result.plainPri, 3, 'a lethal kill is the interesting one in puppy mode');
  assert.equal(result.killerPri, 2);
  assert.equal(result.regret, 2, 'two lethal kills in puppy mode so far');
  assert.equal(result.count, 4, 'start + three kills, one remark each');
});

test('elite kills, long shots, multi-kills, last enemy and kills by other means each get their own event', () => {
  const result = lua(`
    local e = make()
    e:start({})
    e:onCombatants(3)
    clock = 5; e:onKill(victim()); local a = last().name
    clock = 6; e:onKill(victim({rarity = 'boss'})); local boss = last().name
    clock = 7; e:onKill(victim({distance = 35})); local multi = last().name
    clock = 60; e:onCombatants(1); e:onKill(victim({distance = 5})); local lastOne = last().name
    e:onCombatants(4)
    clock = 80; e:onKill(victim({weapon = 'melee'})); local m1 = last().name
    clock = 90; e:onKill(victim({weapon = 'quickhack'})); local m2 = last().name
    local result = {a = a, boss = boss, multi = multi, lastOne = lastOne, m1 = m1, m2 = m2, facts = last().spec.facts.ways}
  ${dump}`);
  assert.equal(result.a, 'first-kill');
  assert.equal(result.boss, 'elite-kill');
  assert.equal(result.multi, 'multi-kill', 'three kills in 8 s');
  assert.equal(result.lastOne, 'last-enemy');
  assert.equal(result.m1, 'kill', 'one other-way kill is just a kill');
  assert.equal(result.m2, 'kill-other-way', 'the second within 30 s is noticed');
  assert.equal(result.facts, 2);
});

test('puppy mode: downed enemies, a mercy streak, limb shots and bystanders; killer mode treats them as filler', () => {
  const result = lua(`
    local e = make()
    e:start({})
    clock = 5; e:onDowned(victim({lethal = false})); local d1 = last()
    clock = 15; e:onDowned(victim({lethal = false}))
    clock = 25; e:onDowned(victim({lethal = false})); local streak = last()
    clock = 40; e:onHit({zone = 'leg', victim = victim()}); local limb = last()
    clock = 60; e:onHit({civilian = true, id = 'c1', victim = victim({civilian = true})}); local civ = last()
    clock = 80; e:onKill(victim({civilian = true, id = 'c2'})); local killed = last()
    mode = 'killer'
    clock = 100; e:onHit({civilian = true, id = 'c3', victim = victim({civilian = true})}); local civK = last()
    clock = 120; e:onHit({zone = 'arm', victim = victim()}); local limbK = last()
    local result = {d1 = d1.name, d1Pri = d1.spec.priority, streak = streak.name, streakN = streak.spec.facts.streak,
      limb = limb.name, limbPri = limb.spec.priority, civ = civ.name, civPri = civ.spec.priority, killed = killed.name,
      civilians = killed.spec.facts.fight.civilians, civKPri = civK.spec.priority, limbKPri = limbK.spec.priority,
      limbZone = limb.spec.facts.victim.zone}
  ${dump}`);
  assert.equal(result.d1, 'enemy-downed');
  assert.equal(result.d1Pri, 3);
  assert.equal(result.streak, 'mercy-streak');
  assert.equal(result.streakN, 3);
  assert.equal(result.limb, 'limb-shot');
  assert.equal(result.limbZone, 'leg');
  assert.equal(result.limbPri, 3);
  assert.equal(result.civ, 'civilian-hit');
  assert.equal(result.civPri, 4, 'a bystander hit is priority 4 in puppy mode');
  assert.equal(result.killed, 'civilian-killed');
  assert.equal(result.civilians, 2);
  assert.equal(result.civKPri, 3, 'and 3 in killer mode');
  assert.equal(result.limbKPri, 2);
});

test('shots, misses, reloads, health, heals, reinforcements and heat make their events, once per crossing', () => {
  const result = lua(`
    local e = make()
    e:start({healthPct = 100})
    e:onCombatants(2)
    for i = 1, 6 do clock = clock + 0.5; e:onShot() end
    clock = 10; e:onShot(); local shotCalls = #calls
    clock = 30; e:onReload({empty = true}); local reload = last()
    e:onCombatants(0); clock = 70; e:onReload({}); local calm = last()
    clock = 80; e:onCombatants(2); clock = 81; e:onCombatants(5); local reinf = last()
    clock = 100; e:onHealth(60); clock = 101; e:onHealth(48); local hurt = last()
    clock = 102; e:onHealth(47); local sameCount = #calls
    clock = 110; e:onHealth(80); clock = 111; e:onHealth(50); local big = last()
    clock = 130; e:onHealth(20); local near = last(); local nearBefore = #calls
    clock = 131; e:onHealth(15); local nearCount = #calls
    clock = 150; e:onHeal(60); local healed = last()
    clock = 200; e:onHeat(2); local heat = last()
    local misses = {}
    for _, c in ipairs(calls) do if c.name == 'miss-streak' then misses[#misses + 1] = c.spec.facts.missed end end
    local result = {misses = misses, reload = reload.name, empty = reload.spec.facts.empty, calm = calm.name, reinf = reinf.name,
      from = reinf.spec.facts.from, to = reinf.spec.facts.to, hurt = hurt.name, same = sameCount == #calls or sameCount,
      big = big.name, lost = big.spec.facts.lostPct, near = near.name, nearPri = near.spec.priority, nearTwice = nearCount == nearBefore,
      healed = healed.name, heat = heat.name, heatStage = heat.spec.facts.heat}
  ${dump}`);
  assert.deepEqual(result.misses, [6]);
  assert.equal(result.reload, 'reload-under-fire');
  assert.equal(result.empty, true);
  assert.equal(result.calm, 'reload');
  assert.equal(result.reinf, 'reinforcements');
  assert.equal(result.from, 2);
  assert.equal(result.to, 5);
  assert.equal(result.hurt, 'v-hurt');
  assert.equal(result.big, 'big-hit-taken');
  assert.equal(result.lost, 30);
  assert.equal(result.near, 'near-death');
  assert.equal(result.nearPri, 5);
  assert.equal(result.nearTwice, true, 'near death does not repeat until health is back above 40');
  assert.equal(result.healed, 'v-healed');
  assert.equal(result.heat, 'heat-up');
  assert.equal(result.heatStage, 2);
});

test('the game\'s own Skippy is never talked over: no remark is made while it speaks, and a remark waiting is cancelled', () => {
  const result = lua(`
    local e = make()
    e:start({})
    local before = #calls
    vanilla = true
    clock = 5; e:onKill(victim())
    local while_ = #calls - before
    e:vanillaSpoke()
    vanilla = false
    clock = 20; e:onKill(victim())
    local result = {while_ = while_, cancelled = cancelled, after = #calls - before}
  ${dump}`);
  assert.equal(result.while_, 0);
  assert.equal(result.cancelled, 1);
  assert.equal(result.after, 1, 'the next kill after it stopped speaking is remarked');
});

test('a moment held back only by the gap is offered again at the next game event, and dropped after five seconds', () => {
  const result = lua(`
    local e = make()
    e:start({})
    clock = 2; e:onKill(victim())
    refuse = 'addon-gap'
    clock = 5; e:onKill(victim({headshot = true, rarity = 'elite'}))
    local tried = #calls
    refuse = nil
    clock = 6; e:onShot()
    local retried = #calls
    local name = last().name
    -- a second moment that is held and then expires
    refuse = 'addon-gap'
    clock = 20; e:onKill(victim({rarity = 'boss'}))
    refuse = nil
    clock = 30; e:onShot()
    local result = {tried = tried, retried = retried, name = name, afterExpiry = #calls == retried + 1}
  ${dump}`);
  assert.equal(result.retried, result.tried + 1, 'one more attempt at the next event');
  assert.equal(result.name, 'elite-kill');
  assert.equal(result.afterExpiry, true, 'the stale moment was not offered again');
});

test('a budget or cooldown refusal is not kept; low-priority moments are never held', () => {
  const result = lua(`
    local e = make()
    e:start({})
    refuse = 'episode-budget'
    clock = 5; e:onKill(victim())
    refuse = nil
    clock = 6; e:onShot()
    local after = #calls
    mode = 'killer'
    refuse = 'addon-gap'
    clock = 20; e:onKill(victim()); clock = 22; refuse = nil; e:onShot()
    local result = {held = after, lowHeld = #calls}
  ${dump}`);
  assert.equal(result.held, 2, 'start, kill, and nothing after the budget refusal');
  assert.equal(result.lowHeld, 3, 'a priority 2 kill held by the gap was not retried');
});

test('stock: reflex moments are declared with slots in mode order, and only they ask for stocked lines', () => {
  const result = lua(`
    local e = make()
    e:declareStock()
    local order = {}
    for event in pairs(stocked) do order[#order + 1] = event end
    table.sort(order)
    local puppyMercy = stocked['mercy-streak'] ~= false
    mode = 'killer'
    e:declareStock()
    local killerMercy = stocked['mercy-streak']
    e:start({})
    clock = 5; e:onKill(victim())
    clock = 20; e:onKill(victim()); local kill = last()
    clock = 40; e:onKill(victim({rarity = 'boss'})); local boss = last()
    local result = {order = order, puppyMercy = puppyMercy, killerMercy = killerMercy, killStock = kill.spec.stock,
      bossStock = boss.spec.stock, killSpec = stocked['kill'], near = stocked['near-death']}
  ${dump}`);
  assert.ok(result.order.includes('kill') && result.order.includes('near-death') && result.order.includes('reload-under-fire'));
  assert.ok(!result.order.includes('fight-end') && !result.order.includes('first-kill') && !result.order.includes('civilian-hit'),
    'moments with their own specifics are written fresh');
  assert.equal(result.puppyMercy, true);
  assert.equal(result.killerMercy, false, 'mercy-streak is cleared outside puppy mode');
  assert.equal(result.killStock, true);
  assert.equal(result.bossStock, undefined);
  assert.deepEqual(result.killSpec.slots, ['fight.kills', 'victim.kind']);
  assert.equal(result.killSpec.facts.mode, 'killer');
  assert.deepEqual(result.near.slots, ['healthPct']);
  assert.match(result.killSpec.text, /prepared in advance/);
});

test('every slot a stocked line may use is a fact its own event always carries', () => {
  const result = lua(`
    local e = make()
    e:start({healthPct = 100})
    e:onCombatants(2)
    local facts = {}
    local function take(name) for i = #calls, 1, -1 do if calls[i].name == name then return calls[i].spec.facts end end end
    clock = 5; e:onKill(victim({headshot = true})); facts['kill'] = take('first-kill')
    clock = 20; e:onKill(victim()); facts['kill2'] = take('kill')
    clock = 40; e:onDowned(victim({lethal = false})); facts['enemy-downed'] = take('enemy-downed')
    clock = 50; e:onHit({zone = 'leg', victim = victim()}); facts['limb-shot'] = take('limb-shot')
    for i = 1, 6 do clock = clock + 0.2; e:onShot() end
    clock = 60; e:onShot(); facts['miss-streak'] = take('miss-streak')
    clock = 70; e:onHealth(80); clock = 71; e:onHealth(45); facts['big-hit-taken'] = take('big-hit-taken')
    clock = 90; e:onHealth(10); facts['near-death'] = take('near-death')
    clock = 100; e:onCombatants(5); facts['reinforcements'] = take('reinforcements')
    local result = {facts = facts, stock = Engine.STOCK}
  ${dump}`);
  const get = (facts, path) => path.split('.').reduce((value, key) => value?.[key], facts);
  const events = {kill: result.facts.kill2, 'enemy-downed': result.facts['enemy-downed'], 'limb-shot': result.facts['limb-shot'],
    'miss-streak': result.facts['miss-streak'], 'big-hit-taken': result.facts['big-hit-taken'], 'near-death': result.facts['near-death'],
    reinforcements: result.facts.reinforcements};
  for (const [event, facts] of Object.entries(events)) {
    const row = result.stock.find(entry => entry[0] === event);
    assert.ok(facts, `${event} was made`);
    for (const slot of row[3]) assert.notEqual(get(facts, slot), undefined, `${event} always carries ${slot}`);
  }
});

test('the fight end remembers a long, hard or notable fight', () => {
  const result = lua(`
    local e = make()
    e:start({healthPct = 100})
    for i = 1, 6 do clock = clock + 2; e:onKill(victim()) end
    clock = 30; e:stop()
    local text
    for _, c in ipairs(calls) do if c.name == 'remember' then text = c.text end end
    local result = {text = text}
  ${dump}`);
  assert.match(result.text, /6 kills/);
});

// ---- The hooks, against the real add-on API and a fake world ------------------------------------------------------------------

const GAME = String.raw`
local hooks, observed = {}, {}
local function remember(kind) return function(class, method, fn) hooks[class .. '.' .. method] = fn; observed[#observed + 1] = kind .. ':' .. class .. '.' .. method end end
Observe, ObserveAfter = remember('before'), remember('after')
local tokens = {}
TweakDBID = {new = function(name) tokens[name] = tokens[name] or {name = name}; return tokens[name] end}
ItemID = {GetTDBID = function(id) return id.tdbid end}
local weapon = {}
function weapon:GetItemID() return {tdbid = self.tdbid} end
local held = {tdbid = TweakDBID.new('Items.mq007_skippy')}
ScriptedPuppet = {GetActiveWeapon = function() return setmetatable(held, {__index = weapon}) end,
    IsPlayerCompanion = function(object) return object.companion == true end}
WeaponObject = {IsMagazineEmpty = function() return true end}
local facts = {mq007_skippy_aim_at_head = 1}
local health = 100
local player = {}
local pool = {GetStatPoolValue = function() return health end}
Game = {GetPlayer = function() return player end,
    GetQuestsSystem = function() return {GetFactStr = function(_, name) return facts[name] or 0 end} end,
    GetStatPoolsSystem = function() return pool end,
    FindEntityByID = function(id) return id.npc end}
Enum = {new = function(kind, name) return {value = name, kind = kind} end}
function FromVariant(value) return value end
local function npc(extra)
    local n = {hash = tostring(math.random(1000, 9999)) .. 'ULL', props = {type = 'Human', rarity = 'Normal', affiliation = 'MaelstromAffiliation'}}
    for k, v in pairs(extra or {}) do n.props[k] = v end
    function n:GetEntityID() return {hash = self.hash} end
    function n:IsCrowd() return self.props.crowd == true end
    function n:IsCharacterCivilian() return self.props.civilian == true end
    function n:IsCharacterPolice() return false end
    function n:IsPrevention() return false end
    function n:IsCharacterGanger() return self.props.ganger == true end
    function n:IsCharacterCyberpsycho() return false end
    function n:GetNPCType() return {value = self.props.type} end
    function n:GetNPCRarity() return {value = self.props.rarity} end
    function n:GetAffiliation() return {value = self.props.affiliation} end
    function n:GetTweakDBFullDisplayName() return 'Maelstrom Gunner' end
    function n:GetWorldPosition() return {x = 6, y = 8, z = 0} end
    return n
end
function player:GetWorldPosition() return {x = 0, y = 0, z = 0} end
function player:IsPlayer() return true end
function player:GetEntityID() return {hash = '77ULL'} end
local function attack(extra)
    local flags = extra and extra.flags or {}
    local a = {}
    function a:GetInstigator() return player end
    function a:HasFlag(flag) return flags[flag.value] == true end
    function a:GetAttackType() return {value = extra and extra.attackType or 'Ranged'} end
    return a
end
local function register(fn) GetMod = function(name) if name == 'CyberpunkConvai' then return {addons = M.public} end end end
`;

function playSkippy(script) {
  const out = runLua(`${WORLD}
    M.attach(host)
    local events = {}
    function registerForEvent(name, fn) events[name] = fn end
    ${GAME}
    register()
    local sources = {['engine.lua'] = function() ${engineLua} end}
    function dofile(name) return sources[name]() end
    local Skippy = (function() ${initLua} end)()
    events.onInit()
    tick(0.1)
    local function swapRaw() hooks['gameuiCrosshairContainerController.OnWeaponSwap']() end
    local function swap() Skippy.S.lastHeldAt = os.clock(); swapRaw() end
    local function fight(on) state.sample = {available = true, combat = on, tier = 1, vehicle = false}; tick(0.1) end
    local function finish() state.pendingId, state.speechId = nil, nil; tick(0.1); tick(3) end
    local function lastRemark() return submitted[#submitted] end
    ${script}
  `);
  return out === undefined ? undefined : JSON.parse(out);
}

test('Skippy registers, installs only event hooks, and stays silent until V holds him', () => {
  const result = playSkippy(`
    held.tdbid = TweakDBID.new('Items.some_other_gun')
    local names = {}
    for name in pairs(hooks) do names[#names + 1] = name end
    table.sort(names)
    fight(true); tick(); tick()
    local result = {names = names, submitted = #submitted, available = M.isSpeaker('addon-skippy-gun')}
    return json.encode(result)`);
  assert.equal(result.available, true);
  assert.equal(result.submitted, 0, 'no remark while the gun is not held');
  for (const hook of ['NPCPuppet.OnDeath', 'NPCPuppet.OnHit', 'PlayerPuppet.OnHealthUpdateEvent', 'ShootEvents.OnEnter',
    'ReloadEvents.OnEnter', 'PlayerPuppet.OnNumberOfCombatantsChanged', 'BaseSubtitlesGameController.ShowDialogLines',
    'gameuiCrosshairContainerController.OnWeaponSwap']) assert.ok(result.names.includes(hook), hook);
  assert.ok(!result.names.some(name => /onUpdate|OnTick|Update$/.test(name)), 'nothing per frame');
});

test('holding Skippy, a fight start makes the opening remark with the mode, the place and the weapon facts', () => {
  const result = playSkippy(`
    swap()
    fight(true); tick(0.1)
    local r = lastRemark()
    return json.encode({addon = r.context.addon, reaction = r.context.reaction, profile = r.context.profileKey})`);
  assert.equal(result.profile, 'addon-skippy-gun');
  assert.equal(result.addon.event, 'fight-start');
  assert.equal(result.addon.mode, 'killer', 'the game fact mq007_skippy_aim_at_head = 1');
  assert.equal(result.addon.facts.fight.seconds, 0);
  assert.equal(result.reaction.priority, 3);
});

test('a kill, a headshot hit and V losing health reach the speaker as remarks with their facts', () => {
  const result = playSkippy(`
    swap()
    fight(true); tick(0.1)
    -- finish the opening remark so the next one can start
    finish()
    local v = npc({type = 'Android', rarity = 'Elite'})
    hooks['NPCPuppet.OnHit'](v, {attackData = attack({flags = {Headshot = true}})})
    hooks['NPCPuppet.OnDeath'](v, {instigator = player})
    tick(0.1)
    local r = lastRemark()
    return json.encode({event = r.context.addon.event, facts = r.context.addon.facts, count = #submitted})`);
  assert.equal(result.event, 'first-kill');
  assert.equal(result.facts.victim.kind, 'android');
  assert.equal(result.facts.victim.rarity, 'elite');
  assert.equal(result.facts.victim.faction, 'Maelstrom');
  assert.equal(result.facts.victim.headshot, true);
  assert.equal(result.facts.victim.distance, 10);
  assert.equal(result.facts.victim.weapon, 'skippy');
  assert.equal(result.facts.fight.kills, 1);
  assert.equal(result.facts.fight.hits, 1);
});

test('a bystander killed in puppy mode is a priority 4 remark; ganger civilians and companions are not bystanders', () => {
  const result = playSkippy(`
    facts.mq007_skippy_aim_at_head = 0
    Skippy.S.modeRead.at = -10
    swap()
    fight(true); tick(0.1)
    finish()
    local ganger = npc({crowd = true, ganger = true})
    hooks['NPCPuppet.OnDeath'](ganger, {instigator = player})
    local gangerKills = Skippy.engine.f.kills
    tick(40)
    finish()
    local civilian = npc({civilian = true})
    hooks['NPCPuppet.OnDeath'](civilian, {instigator = player})
    tick(0.1)
    local r = lastRemark()
    return json.encode({gangerKills = gangerKills, event = r.context.addon.event, priority = r.context.reaction.priority,
      mode = r.context.addon.mode, civilians = r.context.addon.facts.fight.civilians})`);
  assert.equal(result.gangerKills, 1, 'a gang member among a crowd is a kill, not a bystander');
  assert.equal(result.event, 'civilian-killed');
  assert.equal(result.priority, 4);
  assert.equal(result.mode, 'puppy');
  assert.equal(result.civilians, 1);
});

test('hooks do nothing while V does not hold Skippy, and Skippy stops when V puts him away', () => {
  const result = playSkippy(`
    held.tdbid = TweakDBID.new('Items.some_other_gun')
    swap()
    fight(true); tick(0.1)
    hooks['NPCPuppet.OnDeath'](npc(), {instigator = player})
    hooks['ShootEvents.OnEnter']()
    local kills, shots = Skippy.engine.f.kills, Skippy.engine.f.shots
    held.tdbid = TweakDBID.new('Items.mq007_skippy')
    swap()
    local holding = Skippy.S.holding
    held.tdbid = TweakDBID.new('Items.some_other_gun')
    swap()
    return json.encode({kills = kills, shots = shots, holding = holding, after = Skippy.S.holding, submitted = #submitted})`);
  assert.equal(result.kills, 0);
  assert.equal(result.shots, 0);
  assert.equal(result.holding, true);
  assert.equal(result.after, false);
});

test('a line of the game\'s own Skippy blocks remarks for its length, and the main mod\'s own lines do not', () => {
  const result = playSkippy(`
    swap()
    fight(true); tick(0.1)
    finish()
    local before = #submitted
    hooks['BaseSubtitlesGameController.ShowDialogLines'](nil, {{speakerName = 'Skippy', id = {hash = '55'}, duration = 4}})
    hooks['NPCPuppet.OnDeath'](npc(), {instigator = player})
    tick(0.1)
    local during = #submitted - before
    local busy = Skippy.S.vanillaUntil > os.clock()
    Skippy.S.vanillaUntil = -10
    hooks['BaseSubtitlesGameController.ShowDialogLines'](nil, {{speakerName = 'Skippy', id = {hash = tostring(0x436F6E760000 + 5)}, duration = 4}})
    local ownBusy = Skippy.S.vanillaUntil > os.clock()
    return json.encode({during = during, busy = busy, ownBusy = ownBusy})`);
  assert.equal(result.during, 0);
  assert.equal(result.busy, true);
  assert.equal(result.ownBusy, false);
});

test('hook cost is measured and a failing hook cannot break the game', () => {
  const result = playSkippy(`
    swap()
    fight(true); tick(0.1)
    hooks['NPCPuppet.OnHit']({}, {attackData = {GetInstigator = function() error('boom') end}})
    hooks['ShootEvents.OnEnter']()
    local m = Skippy.S.meter
    return json.encode({shot = m.shot and m.shot.calls, hit = m.hit and m.hit.calls})`);
  assert.equal(result.shot, 1);
  assert.equal(result.hit, 1);
});

// ---- Manifest, voice, bridge hooks, package ------------------------------------------------------------------------------------

test('the manifest is valid, both modes exist, providers exclude Convai and the voice reference matches its checksum', {skip: voiceSkip}, async () => {
  const raw = JSON.parse(await readFile(new URL(`./${ADDON_MANIFEST}`, import.meta.url), 'utf8'));
  const manifest = validateManifest(raw, dir);
  const gun = manifest.speakers[0];
  assert.deepEqual(Object.keys(gun.modes).sort(), ['killer', 'puppy']);
  assert.deepEqual(manifest.providers, ['mistral', 'local']);
  const reference = inspectReference(await readFile(gun.voice.reference));
  assert.equal(reference.sha256, gun.voice.sha256);
  assert.ok(reference.duration > 10 && reference.duration < 20);
});

test('every fact the engine can send is documented in EVENTS.md, with its event name', async () => {
  const doc = await readFile(new URL('./EVENTS.md', import.meta.url), 'utf8');
  const {EVENTS} = (() => { const out = runLua(`${ENGINE}\nlocal names = {}; for k in pairs(Engine.EVENTS) do names[#names + 1] = k end; table.sort(names); return json.encode(names)`); return {EVENTS: JSON.parse(out)}; })();
  for (const name of EVENTS) assert.ok(doc.includes(`\`${name}\``), `${name} is in EVENTS.md`);
  for (const key of ['skippyKills', 'bestHeadshotStreak', 'sinceLastKill', 'stealthOpening', 'peakEnemies', 'lowestHealth', 'lookAt', 'bodyPart',
    'regret', 'ways', 'lostPct', 'healthPct', 'missed', 'firstBlood', 'longestStreak', 'outcome']) assert.ok(doc.includes(`\`${key}\``), `${key} is documented`);
});

test('the bridge hooks describe the moment in prose, vary the angle and keep memories short', () => {
  const facts = {mode: 'killer', fight: {seconds: 20, kills: 3, skippyKills: 3, headshots: 2, headshotStreak: 2, enemies: 1, health: 'hurt'},
    victim: {kind: 'human', rarity: 'elite', faction: 'Maelstrom', distance: 28, zone: 'head', headshot: true, weapon: 'skippy', name: 'Maelstrom Gunner'},
    where: {district: 'Watson', area: 'Little China', timeOfDay: 'night'}, streak: 3};
  assert.equal(describeVictim(facts.victim), 'an elite Maelstrom fighter (listed as "Maelstrom Gunner", hit in the head, a headshot, 28 m away)');
  const [block] = speakerBlocks({event: 'headshot-streak', facts, mode: 'killer'});
  assert.equal(block.tier, 'volatile');
  assert.match(block.text, /Stone Cold Killer mode/);
  assert.match(block.text, /3 kills so far/);
  assert.match(block.text, /Where: Little China, Watson, night/);
  assert.match(block.text, /Angle for this line:/);
  assert.match(block.text, /streak: 3/);
  const other = momentBlock({event: 'headshot-streak', facts: {...facts, fight: {...facts.fight, kills: 4, shots: 9}}, mode: 'killer'});
  assert.notEqual(other.match(/Angle for this line: ([^.]+)\./)[1], block.text.match(/Angle for this line: ([^.]+)\./)[1], 'the angle moves with the fight');
  assert.deepEqual(speakerBlocks({event: null, facts: null}), []);
  assert.match(remember({event: 'near-death', facts: {}, line: 'Stay with me, boss.'}), /almost died.*Stay with me/);
  assert.equal(remember({event: 'kill', facts: {}, line: 'x'}), null);
  assert.ok(remember({event: 'elite-kill', facts, line: 'x'}).length <= 300);
  assert.equal(describeVictim({kind: 'human', civilian: true}), 'a bystander (a civilian, not part of the fight)');
});

test('drawing Skippy after a while makes a greeting outside a fight, and the next fight starts as usual', () => {
  const result = playSkippy(`
    held.tdbid = TweakDBID.new('Items.some_other_gun')
    swapRaw()
    Skippy.S.lastHeldAt = os.clock() - 100
    held.tdbid = TweakDBID.new('Items.mq007_skippy')
    swapRaw()
    tick(0.1)
    local r = lastRemark()
    return json.encode({event = r.context.addon.event, priority = r.context.reaction.priority, where = r.context.addon.facts.where ~= nil or true})`);
  assert.equal(result.event, 'skippy-drawn');
  assert.equal(result.priority, 2);
});

test('the bridge answers a real Skippy remark through the add-on host with the mode persona and the moment block', async () => {
  const request = playSkippy(`
    swap()
    fight(true); tick(0.1)
    finish()
    hooks['NPCPuppet.OnDeath'](npc(), {instigator = player})
    tick(0.1)
    return json.encode(lastRemark().context)`);
  const input = parseInput(JSON.stringify(request));
  assert.ok(input, 'the request passes the protocol');
  const host = new AddonHost({addons: [validateManifest(JSON.parse(await readFile(new URL(`./${ADDON_MANIFEST}`, import.meta.url), 'utf8')), dir)], startedAt: 0});
  await host.loadModules();
  host.beginTurn(input);
  assert.equal(host.modeOf('addon-skippy-gun').id, 'killer');
  const moment = host.blocks(input).find(block => block.key === 'addon:skippy:moment');
  assert.ok(moment, 'the moment block');
  assert.match(moment.text, /Stone Cold Killer mode/);
  assert.match(moment.text, /1 kill so far/);
  assert.match(host.trigger(input), /at most 10 words/);
});

test('the add-on package builds with its Lua, manifest, bridge module, voice and notes, and without tests', {skip: voiceSkip}, async () => {
  const out = await mkdtemp(join(tmpdir(), 'skippy-addon-'));
  const {names} = await buildAddon({dir, out});
  await rm(out, {recursive: true, force: true});
  const folder = 'bin/x64/plugins/cyber_engine_tweaks/mods/CyberpunkConvaiSkippy/';
  for (const file of ['init.lua', 'engine.lua', 'convai-addon.json', 'bridge.mjs', 'voice/skippy.wav', 'EVENTS.md']) assert.ok(names.includes(folder + file), file);
  assert.ok(!names.some(name => /\.test\.mjs$|eval\//.test(name)));
});
