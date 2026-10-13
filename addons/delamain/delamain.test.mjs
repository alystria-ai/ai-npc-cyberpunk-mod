import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, mkdtempSync, rmSync, cpSync, mkdirSync, writeFileSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {WORLD, runLua} from '../../bridge/addon-lua-harness.mjs';
import {ADDON_MANIFEST, AddonHost, fixedProvider, rosterLookup, sharedMemory, validateManifest} from '../../bridge/addons.mjs';
import {parseInput} from '../../bridge/protocol.mjs';
import {PersonaBook, joinBlocks} from '../../bridge/mistral-prompt.mjs';
import {TextProviderHost, mistralRoute} from '../../bridge/text-provider-host.mjs';
import {MistralMemory} from '../../bridge/mistral-memory.mjs';
import {buildAddon} from '../../packaging/build-addon.mjs';
import * as module from './bridge.mjs';

// The Delamain Cab add-on end to end with no game, no network and no sound: its CET Lua runs against the real mod/addons.lua with a
// fake cab (the quest fact, the cab's component callbacks, a district, the weather), and the request it writes is answered by the
// bridge side (protocol, add-on host, persona, hook blocks, text host on a stand-in Mistral) exactly as the bridge does it.
const dir = fileURLToPath(new URL('.', import.meta.url));
const initLua = readFileSync(new URL('./init.lua', import.meta.url), 'utf8');
const manifestRaw = JSON.parse(readFileSync(new URL(`./${ADDON_MANIFEST}`, import.meta.url), 'utf8'));

// A fake game around the add-on: the quest fact delamain_taxi_state, the cab's callbacks (hooks[...] holds what Observe* registered),
// a district, the clock, the weather, the heat, the destination and the fare. calls counts every read of the game.
const SIM = String.raw`${WORLD}
M.attach(host)
local calls = {}
local function count(name) calls[name] = (calls[name] or 0) + 1 end
local facts = {delamain_taxi_state = 0}
local game = {hour = 21, rain = 'ERainIntensity : HeavyRain (2)', heat = 0, district = 'LittleChina', fare = 150}
local hooks, missing = {}, {}
local function observe(class, method, fn)
    if missing[class .. '.' .. method] then error('no such function ' .. method) end
    hooks[class .. '.' .. method] = fn
end
ObserveAfter, ObserveBefore = observe, observe
local events = {}
function registerForEvent(name, fn) events[name] = fn end
function GetMod(name) if name == 'CyberpunkConvai' then return {addons = M.public} end return nil end
function NameToString(value) return value end
CName = {new = function(name) return name end}
TweakDBID = {new = function(name) return name end}
GameTime = {Hours = function(value) return value end}
EnumInt = function(value) return value end
local watson = {EnumName = function() return 'Watson' end, ParentDistrict = function() return nil end}
local districts = {LittleChina = {EnumName = function() return 'LittleChina' end, ParentDistrict = function() return watson end},
    Watson = watson, Westbrook = {EnumName = function() return 'Westbrook' end, ParentDistrict = function() return nil end}}
TweakDBInterface = {GetDistrictRecord = function() return districts[game.district] end}
local systems = {
    PreventionSystem = {GetCurrentDistrict = function() count('district') return {GetDistrictID = function() return 1 end} end,
        GetHeatStage = function() return game.heat end},
    AutoDriveSystem = {GetAutodriveDestination = function() return {x = 3000, y = 3000, z = 0} end,
        GetEstimatedTimeToArrival = function() return 95 end, GetAutodriveDestinationMappinID = function() return {} end},
    DelamainTaxiSystem = {GetTravelCost = function() return game.fare end},
}
Game = {
    GetQuestsSystem = function() count('fact') return {GetFactStr = function(_, name) return facts[name] end} end,
    GetTimeSystem = function() count('time') return {GetGameTime = function() return game.hour end} end,
    GetWeatherSystem = function() count('weather') return {GetRainIntensityType = function() return game.rain end} end,
    GetScriptableSystemsContainer = function() return {Get = function(_, name) return systems[name] end} end,
    GetPlayer = function() return {GetWorldPosition = function() return {x = 0, y = 0, z = 0} end} end,
    GetMappinSystem = function() return {GetMappin = function() return nil end} end,
}
function car:GetRecordID() return 'Vehicle.v_standard2_villefort_cortes_delamain_player' end
local component = {GetEntity = function() return car end}
local Delamain = (function() ${initLua} end)()
events.onInit()
local handle = Delamain.handle
-- Walk V to the cab and move the quest fact; the same callbacks the game would send.
local function sit()
    state.sample = {available = true, combat = false, tier = 1, vehicle = false}; tick()
    state.sample = {available = true, combat = false, tier = 1, vehicle = true}; player.vehicle = car; tick()
end
local function step(value) facts.delamain_taxi_state = value; hooks['DelamainTaxiComponent.OnFactChanged'](component, {}) end
local function lastRequest() return submitted[#submitted] and submitted[#submitted].context end
-- Plays the pending request through to its end (speech, then silence), so the next remark is allowed after the gap.
local function finish(seconds)
    local id = state.pendingId
    state.pendingId, state.speechId = nil, id; tick()
    state.speechId = nil; tick()                 -- the remark is released: its gap starts now
    tick(seconds or 0.1)
end
local function addonState() return json.decode(files['runtime/addon-state.json']).addons['delamain-cab'] end
`;

const lua = body => runLua(`${SIM}\n${body}`);

test('registers one vehicle-anchored, group-capable speaker and a setting; no hook runs or reads the game while idle', () => {
  lua(`
    assert(handle ~= nil and M.isSpeaker('addon-delamain-cab-delamain'))
    local installed = {}
    for name, status in pairs(Delamain.hooks) do installed[#installed + 1] = name .. '=' .. status end
    table.sort(installed)
    for _, name in ipairs({'DelamainTaxiComponent.OnFactChanged', 'DelamainTaxiComponent.OnGameAttach', 'DelamainTaxiComponent.StartAutoDrive',
        'DelamainTaxiComponent.OnDelamainTaxiArrivedEvent', 'DelamainTaxiComponent.CancelRide', 'DelamainTaxiSystem.OnStartDelamainTaxiRequest',
        'PreventionSystem.OnDistrictAreaEntered'}) do assert(hooks[name], name .. ' not hooked: ' .. table.concat(installed, ' ')) end
    assert(M._test.speakers['addon-delamain-cab-delamain'].group == true and M._test.speakers['addon-delamain-cab-delamain'].anchor == 'vehicle')
    tick()                                       -- the first tick opens the session (one read of the cab's state)
    local before = {}
    for key, value in pairs(calls) do before[key] = value end
    for _ = 1, 200 do tick() end
    state.sample = {available = true, combat = true, tier = 1, vehicle = false}; tick()
    state.sample = {available = true, combat = false, tier = 1, vehicle = false}; tick()
    for key, value in pairs(calls) do assert(before[key] == value, 'the game was read while idle: ' .. key) end
    assert(#submitted == 0, 'no remark with no cab')
    local sections = M.settingsSections()
    assert(#sections == 1 and sections[1].title == 'Delamain Cab' and sections[1].items[1].label == 'Time between remarks' and sections[1].items[2].label == 'Most remarks per fight')
    assert(sections[1].items[3].label == 'Delamain speaks on rides' and #sections[1].items == 3, 'the add-on adds one setting of its own')
  `);
});

test('a line in flight is never cancelled by V leaving the cab or a mount flicker; the ride survives a short gap', () => {
  lua(`
    sit()
    step(1); step(2); step(3); tick()
    assert(#submitted == 1 and lastRequest().addon.event == 'boarded')
    local id = state.pendingId
    -- Playing: the mount flickers off and on again, and V steps out for good while the line is still being spoken.
    state.pendingId, state.speechId = nil, id; tick()
    state.sample = {available = true, combat = false, tier = 1, vehicle = false}; player.vehicle = nil; tick()
    assert(handle:state().remark == 'delamain', 'the line plays on after V left the cab')
    tick(1); tick(1)
    assert(handle:state().remark == 'delamain', 'still playing, even though the speaker is no longer available')
    state.sample = {available = true, combat = false, tier = 1, vehicle = true}; player.vehicle = car; tick()
    state.speechId = nil; tick()
    local released
    for _, line in ipairs(logs) do if line:find('Remark released', 1, true) and line:find('event=boarded', 1, true) then released = line end end
    assert(released and released:find('reason=finished', 1, true), tostring(released))
    for _, line in ipairs(logs) do assert(not line:find('reason=cancelled', 1, true), line) end
    -- The same ride continues after the short gap: no second greeting.
    assert(#submitted == 1, 'no second greeting after the flicker')
    tick(31)
    state.sample = {available = true, combat = false, tier = 1, vehicle = false}; player.vehicle = nil; tick()
    now = now + 60
    state.sample = {available = true, combat = false, tier = 1, vehicle = true}; player.vehicle = car; tick()
    assert(Delamain.ride and Delamain.ride.number == 2, 'a long gap makes it a new ride')
  `);
});

test('a line still waiting to be heard survives a short flicker and is given up after a longer loss', () => {
  lua(`
    sit()
    step(1); step(2); step(3); tick()
    assert(#submitted == 1 and handle:state().remark == 'delamain')
    state.sample = {available = true, combat = false, tier = 1, vehicle = false}; player.vehicle = nil; tick(1)
    state.sample = {available = true, combat = false, tier = 1, vehicle = true}; player.vehicle = car; tick(1)
    assert(handle:state().remark == 'delamain', 'a one second flicker does not drop it')
    state.sample = {available = true, combat = false, tier = 1, vehicle = false}; player.vehicle = nil; tick(1); tick(1); tick(1); tick(1)
    assert(handle:state().remark == nil, 'three seconds without the cab: given up')
  `);
});

test('a ride: boarding greets once, the destination starts the ride, a district and the arrival are remarked, then the context clears', () => {
  const out = lua(`
    party = {'judy-alvarez'}
    sit()
    assert(#M.talkCandidates(player, false) == 0, 'not offered before the cab is ready')
    step(1); step(2)
    assert(#submitted == 0 and #M.talkCandidates(player, false) == 0, 'a cab at the curb says nothing')
    step(3); tick()
    assert(#submitted == 1, 'one greeting when the cab is ready')
    local greeting = lastRequest()
    assert(greeting.addon.event == 'boarded' and greeting.reaction.priority == 4 and greeting.voiceOnly == true and greeting.entity == '88ULL', json.encode(greeting))
    local f = greeting.addon.facts
    assert(f.rideNumber == 1 and f.timeOfDay == 'late evening' and f.hour == 21 and f.district == 'Watson' and f.area == 'Little China', json.encode(f))
    assert(f.weather == 'heavy rain' and f.companion == 'Judy Alvarez' and f.companionCount == 1 and f.destinationChosen == false and f.firstRideThisSession == true, json.encode(f))
    assert(f.wanted == nil, 'no heat, no fact')
    assert(greeting.addon.maxWords == 22)
    -- Talk is offered, to the vehicle's voice, and in a group round.
    assert(#M.talkCandidates(player, false) == 1 and M.talkCandidates(player, false)[1].profileKey == 'addon-delamain-cab-delamain')
    assert(#M.talkCandidates(player, true) == 1)
    local doc = addonState()
    assert(doc.state.phase == 'waiting' and doc.companionContext[1].key == 'ride' and doc.companionContext[1].text:find('Delamain cab', 1, true), json.encode(doc))
    finish(31)                                   -- the greeting was heard; the gap passes
    -- The destination is chosen.
    Delamain.pendingFare = nil
    step(4); tick()
    assert(#submitted == 2, 'one line when the ride starts')
    local start = lastRequest()
    assert(start.addon.event == 'ride-start' and start.reaction.priority == 4)
    local s = start.addon.facts
    assert(s.greeting == false, 'the greeting already played')
    assert(s.destinationDistanceMeters == 4243 and s.destinationDirection == 'north-east' and s.fare == 150 and s.etaSeconds == 95, json.encode(s))
    doc = addonState()
    assert(doc.state.phase == 'riding' and doc.state.meters == 4243 and doc.state.direction == 'north-east' and doc.state.startedAt == now * 1000, json.encode(doc))
    assert(doc.companionContext[1].text:find('4243 metres to the north-east', 1, true), json.encode(doc))
    finish(31)
    -- A district boundary 40 s into the ride: one remark.
    now = now + 40
    game.district = 'Westbrook'
    hooks['PreventionSystem.OnDistrictAreaEntered'](nil, {}); tick()
    assert(#submitted == 3 and lastRequest().addon.event == 'district-passed', #submitted)
    finish(31)
    -- Arrival.
    now = now + 30
    step(5); tick()
    assert(#submitted == 4 and lastRequest().addon.event == 'arrival' and lastRequest().reaction.priority == 5, #submitted)
    local a = lastRequest().addon.facts
    assert(a.rideSeconds == 70 and a.rideMinutes == 1 and a.fare == 150 and a.startDistrict == 'Watson' and a.districtsPassed[1] == 'Westbrook', json.encode(a))
    step(7)
    assert(#M.talkCandidates(player, false) == 1, 'talk still works until V steps out')
    -- V steps out: the voice and the contexts are gone.
    state.sample = {available = true, combat = false, tier = 1, vehicle = false}; player.vehicle = nil; tick()
    assert(#M.talkCandidates(player, false) == 0)
    tick(0.6)                                    -- the state file is written at most twice a second
    doc = addonState()
    assert(doc == nil or (doc.state == nil and #(doc.companionContext or {}) == 0), 'the ride context is cleared')
    step(8)
    return 'ok'
  `);
  assert.equal(out, 'ok');
});

test('a ride without a greeting: the district is remarked once (priority 3), then the arrival', () => {
  lua(`
    sit(); step(3); step(4); tick(); finish(31)
    now = now + 40
    game.district = 'Westbrook'
    hooks['PreventionSystem.OnDistrictAreaEntered'](nil, {}); tick()
    assert(#submitted == 2 and lastRequest().addon.event == 'district-passed' and lastRequest().reaction.priority == 3, #submitted)
    local d = lastRequest().addon.facts
    assert(d.district == 'Westbrook' and d.previousDistrict == 'Watson' and d.rideSeconds == 40, json.encode(d))
    finish(31)
    game.district = 'Watson'; hooks['PreventionSystem.OnDistrictAreaEntered'](nil, {})
    game.district = 'Westbrook'; hooks['PreventionSystem.OnDistrictAreaEntered'](nil, {}); tick()
    assert(#submitted == 2, 'at most one district remark per ride')
    now = now + 30
    step(5); tick()
    assert(#submitted == 3 and lastRequest().addon.event == 'arrival')
    assert(lastRequest().addon.facts.districtsPassed[1] == 'Westbrook')
  `);
});

test('a scene that holds a remark back (the game own farewell) does not lose the arrival: it is asked again when the scene ends', () => {
  lua(`
    sit(); step(3); step(4); tick(); finish(31)
    state.sample = {available = true, combat = false, tier = 1, vehicle = true, dialogue = true}
    tick(); now = now + 40
    step(5); tick()
    assert(#submitted == 1, 'the game is speaking its farewell: nothing is sent')
    state.sample = {available = true, combat = false, tier = 1, vehicle = true}
    tick()
    assert(#submitted == 2 and lastRequest().addon.event == 'arrival', 'sent again when the scene ends')
    finish(31)
    -- Not asked for forever: a remark that waited past its window is not replayed.
    now = now + 400
    state.sample = {available = true, combat = false, tier = 1, vehicle = true, dialogue = true}; tick()
    state.sample = {available = true, combat = false, tier = 1, vehicle = true}; tick()
    assert(#submitted == 2)
  `);
});

test('choosing a destination before the greeting was heard drops the waiting greeting; the ride line greets instead', () => {
  lua(`
    sit()
    step(3)
    step(4); tick()
    assert(#submitted == 1 and lastRequest().addon.event == 'ride-start', 'only the ride line is sent')
    assert(lastRequest().addon.facts.greeting == true and lastRequest().addon.facts.rideNumber == 1)
    assert(lastRequest().addon.facts.companion == nil, 'no companion, no fact')
  `);
});

test('the ride-start line carries the fare the request announced, and a destination name only when the pin has a real one', () => {
  lua(`
    sit(); step(3)
    hooks['DelamainTaxiSystem.OnStartDelamainTaxiRequest'](nil, {m_price = 300})
    step(4); tick()
    assert(lastRequest().addon.facts.fare == 300, json.encode(lastRequest().addon.facts))
    assert(lastRequest().addon.facts.destinationName == nil, 'the game gives the pin no name')
  `);
});

test('an interrupted autopilot is remarked only while V is still inside; the game scene gate holds every remark back', () => {
  lua(`
    sit(); step(3); tick(); finish(31)
    step(4); tick(); finish(31)
    state.sample = {available = true, combat = false, tier = 1, vehicle = true, dialogue = true}
    step(6)
    tick(); assert(#submitted == 2, 'the game is speaking: nothing is sent')
    state.sample = {available = true, combat = false, tier = 1, vehicle = true}
    tick()
    assert(#submitted == 3 and lastRequest().addon.event == 'ride-interrupted' and lastRequest().reaction.priority == 4, 'sent when the scene ends')
    assert(lastRequest().addon.facts.cause ~= nil and lastRequest().addon.facts.rideSeconds ~= nil)
  `);
});

test('a heat level is a fact, the add-on switch silences the cab, and a new ride is a new ride', () => {
  lua(`
    game.heat = 3
    sit(); step(3); tick()
    assert(lastRequest().addon.facts.wanted == 3)
    finish(31)
    handle:setEnabled(false)
    assert(#M.talkCandidates(player, false) == 0, 'disabled: never offered for talk')
    handle:setEnabled(true)
    step(5); step(7); step(8)
    state.sample = {available = true, combat = false, tier = 1, vehicle = false}; player.vehicle = nil; tick()
    step(1); step(2)
    state.sample = {available = true, combat = false, tier = 1, vehicle = true}; player.vehicle = car; tick()
    now = now + 400
    step(3); tick()
    assert(lastRequest().addon.event == 'boarded' and lastRequest().addon.facts.rideNumber == 2 and lastRequest().addon.facts.firstRideThisSession == false)
  `);
});

test('without OnFactChanged the other cab callbacks still follow the ride (SetState is observed instead)', () => {
  lua(`
    missing = {['DelamainTaxiComponent.OnFactChanged'] = true}
    hooks = {}
    events.onInit()
    assert(hooks['DelamainTaxiComponent.SetState'], 'the fallback hook')
    sit()
    facts.delamain_taxi_state = 3; hooks['DelamainTaxiComponent.SetState'](component, 3); tick()
    assert(lastRequest().addon.event == 'boarded')
  `);
});

test('a game that loads in the middle of a ride resumes silently and offers talk', () => {
  lua(`
    facts.delamain_taxi_state = 4
    state.sample = {available = true, combat = false, tier = 1, vehicle = true}; player.vehicle = car
    M.reset('load'); tick()
    assert(#M.talkCandidates(player, false) == 1, 'V sits in a cab that was already moving')
    tick(); assert(#submitted == 0, 'a loaded game makes no remark')
    step(5); tick()
    assert(lastRequest().addon.event == 'arrival', 'the arrival is still remarked')
  `);
});

test('a failing hook handler never throws into the game and is reported', () => {
  lua(`
    Game.GetQuestsSystem = function() error('quest system gone') end
    hooks['DelamainTaxiComponent.OnFactChanged'](component, {})
    hooks['PreventionSystem.OnDistrictAreaEntered'](nil, {})
    assert(#submitted == 0)
  `);
});

// ---- the bridge side --------------------------------------------------------------------------------------------------------

test('the manifest is valid: Mistral or the local AI only, one voice with no body, persona rules and samples', () => {
  const manifest = validateManifest(manifestRaw, dir);
  assert.equal(manifest.id, 'delamain-cab');
  assert.deepEqual(manifest.providers, ['mistral', 'local']);
  assert.equal(manifest.speakers.length, 1);
  const speaker = manifest.speakers[0];
  assert.equal(speaker.profileKey, 'addon-delamain-cab-delamain');
  assert.equal(speaker.name, 'Delamain');
  assert.match(speaker.persona.identityRule, /no body/);
  assert.ok(speaker.persona.samples.length >= 3);
  assert.equal(JSON.stringify(manifestRaw).includes('convai'.toUpperCase()), false);
  assert.ok(!('convai' in manifestRaw) && !('convai' in manifestRaw.speakers[0]), 'a manifest never names a Convai character');
});

test('the package builds with the manifest, init.lua, the bridge module and EVENTS.md, and ships no test or eval file', async () => {
  // Built from a copy with a silent stand-in for voice/delamain.wav: the real reference is game audio and is not in the repository
  // (VOICE.md), so the package check must not depend on it.
  const out = mkdtempSync(join(tmpdir(), 'delamain-build-'));
  try {
    const copy = join(out, 'delamain');
    cpSync(dir, copy, {recursive: true, filter: source => !/[\\/]voice([\\/]|$)/.test(source)});
    mkdirSync(join(copy, 'voice'));
    const pcm = Buffer.alloc(24000);                  // 0.5 s of 24 kHz 16-bit mono silence
    const header = Buffer.alloc(44);
    header.write('RIFF', 0); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVEfmt ', 8); header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22); header.writeUInt32LE(24000, 24); header.writeUInt32LE(48000, 28);
    header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
    writeFileSync(join(copy, 'voice', 'delamain.wav'), Buffer.concat([header, pcm]));
    const {path, names} = await buildAddon({dir: copy, out: join(out, 'dist')});
    assert.match(path, /CyberpunkConvai-DelamainCab-1\.0\.0\.zip$/);
    const folder = 'bin/x64/plugins/cyber_engine_tweaks/mods/CyberpunkConvaiDelamainCab';
    for (const file of ['init.lua', 'convai-addon.json', 'bridge.mjs', 'EVENTS.md', 'voice/delamain.wav']) assert.ok(names.includes(`${folder}/${file}`), file);
    assert.ok(!names.some(name => /\.test\.m?js$|\/eval\//.test(name)));
  } finally { rmSync(out, {recursive: true, force: true}); }
});

function rideInput(request) {
  const input = parseInput(request);
  assert(input, 'the request passes the protocol');
  return input;
}

async function bridgeFor(request, state) {
  const manifest = validateManifest(manifestRaw, dir);
  const host = new AddonHost({addons: [manifest], startedAt: 0});
  await host.loadModules();
  host.observeState(state);
  const roster = [];
  host.extend(roster, {});
  return {host, roster, input: rideInput(request)};
}

function playRide(final = 'ride-start') {
  return lua(`
    party = {'judy-alvarez'}
    sit(); step(3); step(4); tick()
    ${final === 'arrival' ? 'finish(31); now = now + 100; step(5); tick()' : ''}
    tick(0.6)
    return json.encode(lastRequest()) .. '\\n' .. files['runtime/addon-state.json']
  `).split('\n');
}

test('the bridge answers a ride-start remark: persona, the ride block with the facts, the event guidance, Mistral only', async () => {
  const [request, state] = playRide('ride-start');
  const {host, roster, input} = await bridgeFor(request, state);
  assert.equal(host.routeFor(input.profileKey, {applied: 'convai', mistralKey: true, localReady: false}), 'mistral');
  assert.equal(host.routeFor(input.profileKey, {applied: 'convai', mistralKey: false, localReady: false}), null, 'never Convai');
  host.beginTurn(input);
  const sent = [];
  const chat = async ({messages}) => { sent.push(messages); return {text: 'Heavy rain, a fine fare and Miss Alvarez for company. I shall do my best.', model: 'stand-in', finishReason: 'stop'}; };
  const provider = {apiKey: 'stand-in-key', noteSuccess() {}, noteLimit() {}, limit: null};
  const text = new TextProviderHost({provider: fixedProvider(provider, 'mistral'), memory: sharedMemory(await MistralMemory.open({path: null})),
    personas: new PersonaBook(roster), routes: {mistral: mistralRoute({provider, chat, gapMs: 0})}});
  const blocks = host.blocks(input);
  const parts = Object.fromEntries(['now', 'notes', 'world', 'volatile'].map(tier => [tier, joinBlocks(blocks.filter(b => b.tier === tier).map(b => b.text))]));
  const reply = await text.reply({text: host.trigger(input), reaction: input.reaction, context: '', contextParts: {...parts, worldBlocks: []},
    local: {profileKey: input.profileKey, name: 'Delamain', channel: 'private'}});
  assert.match(reply.text, /Heavy rain/);
  const prompt = sent[0].map(message => message.content).join('\n');
  assert.match(prompt, /You are Delamain, the artificial intelligence that owns and runs Delamain/);
  assert.match(prompt, /at most 25 words/, 'the speaker sets its own talk length');
  assert.match(prompt, /no body/);
  assert.match(prompt, /The ride right now/);
  assert.match(prompt, /Judy Alvarez rides with V/);
  assert.match(prompt, /Your sensors show heavy rain/);
  assert.match(prompt, /The fare is 150 eddies/);
  assert.match(prompt, /about 4\.2 kilometres, to the north-east|about 4\.2 kilometres from where the ride began, to the north-east/);
  assert.match(prompt, /you must not name it/);
  assert.match(prompt, /do not invent a destination name/);
  assert.match(prompt, /one spoken line of at most 24 words/);
  assert.doesNotMatch(prompt, /Welcome aboard/i);
  assert.equal(host.review(input, reply.text).duplicate, false);
  host.afterReply(input, reply.text);
  assert.equal(host.review(input, 'Heavy rain, a fine fare and Miss Alvarez for company, I shall do my best').duplicate, true);
});

test('a talk turn gets the ride block built from the add-on state, and companions get the cab note and the ride time', async () => {
  const [request, state] = playRide('ride-start');
  const {host, input} = await bridgeFor(request, state);
  const talk = {...input, reaction: undefined, addon: {...input.addon, event: undefined, facts: undefined, text: undefined}};
  const own = host.blocks(talk).find(block => block.key === 'addon:delamain-cab:ride');
  assert.ok(own, 'a conversation turn still has the ride block');
  assert.match(own.text, /The ride is under way/);
  assert.match(own.text, /Judy Alvarez rides with V/);
  assert.doesNotMatch(own.text, /greeted V on this ride/, 'no remark facts in a talk turn');
  const companion = host.blocks({profileKey: 'judy-alvarez', group: false});
  assert.ok(companion.some(block => block.key === 'addon:delamain-cab:ride' && /riding in a Delamain cab with V/.test(block.text)), 'the main mod passes the cab note');
  assert.ok(companion.some(block => block.key === 'addon:delamain-cab:ride-time'), 'and the bridge adds the ride time');
});

test('every event of EVENTS.md has trigger guidance and a priority, and the Lua only makes events EVENTS.md lists', () => {
  const doc = readFileSync(new URL('./EVENTS.md', import.meta.url), 'utf8');
  const events = [...doc.matchAll(/^\| `([a-z-]+)` \| (\d) \| (\d+) \| (\d+) \|/gm)].map(match => ({name: match[1], priority: +match[2], maxWords: +match[3], ttl: +match[4]}));
  assert.deepEqual(events.map(event => event.name), ['boarded', 'ride-start', 'district-passed', 'arrival', 'ride-interrupted']);
  for (const event of events) {
    assert.match(module.trigger({event: event.name, text: 'Game event.', maxWords: event.maxWords}), /This event was not spoken by V/, event.name);
    assert.match(initLua, new RegExp(`'${event.name}'[^\\n]*[\\s\\S]{0,900}?${event.priority}, ${event.ttl}, ${event.maxWords}\\)`), `${event.name}: priority, ttl and words match EVENTS.md`);
  }
  const used = [...initLua.matchAll(/(?:say|requestX)\('([a-z-]+)'/g)].map(match => match[1]);
  assert.deepEqual([...new Set(used)].sort(), events.map(event => event.name).sort());
  assert.equal(module.trigger({event: 'unknown-event', text: 'x', maxWords: 5}), undefined, 'an unknown event falls back to the default trigger');
});

test('memories: only notable rides are kept, in one short sentence', () => {
  const quiet = module.remember({event: 'arrival', facts: {rideMinutes: 1, timeOfDay: 'morning', district: 'Watson'}, line: 'Not a scratch.'});
  assert.equal(quiet, null);
  const long = module.remember({event: 'arrival', facts: {rideMinutes: 4, timeOfDay: 'afternoon', district: 'Heywood', startDistrict: 'Watson'}, line: 'Four minutes, and not one wrong turn.'});
  assert.match(long, /^Drove V in the afternoon, Watson to Heywood, 4 minutes; Delamain said: "Four minutes/);
  const rain = module.remember({event: 'arrival', facts: {rideMinutes: 1, timeOfDay: 'night', weather: 'heavy rain', companion: 'Judy Alvarez', district: 'Watson'}, line: 'Dry inside, at least.'});
  assert.match(rain, /V and Judy Alvarez through the rain at night/);
  assert.match(module.remember({event: 'ride-interrupted', facts: {district: 'Pacifica'}, line: 'Stopped.'}), /autopilot stopped mid-ride/);
  assert.equal(module.remember({event: 'boarded', facts: {}, line: 'Hello.'}), null);
  assert.ok(module.remember({event: 'arrival', facts: {rideMinutes: 9, companion: 'X'}, line: 'x'.repeat(500)}).length <= 300);
});

test('the elapsed-time phrase and distance wording are plain', () => {
  const t = 1_000_000_000_000;
  assert.equal(module.elapsedPhrase(t, t + 3000), 'just a few seconds');
  assert.equal(module.elapsedPhrase(t, t + 30000), 'under a minute');
  assert.equal(module.elapsedPhrase(t, t + 61000), 'about 1 minute');
  assert.equal(module.elapsedPhrase(t, t + 190000), 'about 3 minutes');
  assert.equal(module.elapsedPhrase(0, t), null);
  const lines = module.rideLines({state: {phase: 'riding', startedAt: t, meters: 700, direction: 'south'}, facts: {district: 'Pacifica'}, now: t + 120000});
  assert.ok(lines.some(line => /about 700 metres/.test(line)), lines.join('|'));
  assert.ok(lines.includes('V rides alone.'));
  assert.ok(lines.some(line => /driving for about 2 minutes/.test(line)));
  module.resetRideLog();
  assert.deepEqual(module.speakerBlocks({state: null, facts: null}).map(block => block.key), ['ride'], 'even with no data the block says V rides alone');
});

// ---- response quality: weather, fare, pronouns, the ride log ---------------------------------------------------------------

const RAIN = {rideNumber: 7, weather: 'heavy rain', timeOfDay: 'night', hour: 23, district: 'Watson'};
const blockText = (blocks, key) => blocks.find(block => block.key === key)?.text ?? '';

test('the weather goes only with the first two events of a ride, and is mentioned again only if V asks', () => {
  module.resetRideLog();
  const first = blockText(module.speakerBlocks({state: null, facts: RAIN, event: 'boarded'}), 'ride');
  const second = blockText(module.speakerBlocks({state: null, facts: RAIN, event: 'ride-start'}), 'ride');
  const third = blockText(module.speakerBlocks({state: null, facts: RAIN, event: 'district-passed'}), 'ride');
  assert.match(first, /Your sensors show heavy rain/);
  assert.match(second, /Your sensors show heavy rain/);
  assert.doesNotMatch(third, /Your sensors show/);
  assert.match(third, /Do not mention the weather in this line/);
  // The same event asked for again (a scene held it back) is still the same event.
  assert.match(blockText(module.speakerBlocks({state: null, facts: RAIN, event: 'boarded'}), 'ride'), /Your sensors show heavy rain/);
  // A talk answer later in the ride has it only as something to say if asked; the companions' note drops it too.
  const talk = blockText(module.speakerBlocks({state: {rideNumber: 7, phase: 'riding', weather: 'heavy rain'}, facts: null}), 'ride');
  assert.match(talk, /Outside it is heavy rain \(mention it only if V asks\)/);
  assert.doesNotMatch(module.companionBlocks({state: {rideNumber: 7, phase: 'riding', weather: 'heavy rain'}}).map(block => block.text).join(' '), /Outside/);
  // A new ride starts again with the weather.
  assert.match(blockText(module.speakerBlocks({state: null, facts: {...RAIN, rideNumber: 8}, event: 'ride-start'}), 'ride'), /Your sensors show heavy rain/);
});

test('the arrival never gets the fare, and its instruction does not ask for it', () => {
  module.resetRideLog();
  const arrival = blockText(module.speakerBlocks({state: {rideNumber: 3, fare: 300, phase: 'arrived'}, facts: {rideNumber: 3, fare: 300, rideMinutes: 4}, event: 'arrival'}), 'ride');
  assert.doesNotMatch(arrival, /fare/i);
  assert.match(module.rideLines({state: {fare: 300}, facts: {}}).join(' '), /The fare is 300 eddies/, 'a talk answer may still say the fare');
  const guide = module.trigger({event: 'arrival', text: 'The cab arrived.', maxWords: 26});
  assert.doesNotMatch(guide, /\(its length, the weather, the company, the fare\)/);
  assert.match(guide, /Do not mention the fare/);
});

test('a companion comes with a pronoun when the main mod knows it, and with just a name when it does not', async () => {
  const host = new AddonHost({addons: [validateManifest(manifestRaw, dir)], startedAt: 0});
  host.characterLookup = rosterLookup([{key: 'panam-palmer', name: 'Panam Palmer', gender: 'FEMALE'}, {key: 'river-ward', name: 'River Ward', gender: 'MALE'},
    {key: 'who', name: 'Who', gender: 'OTHER'}]);
  await host.loadModules({importModule: async () => module});
  module.resetRideLog();
  const lines = name => module.rideLines({facts: {companion: name, companionCount: 2}}).join(' ');
  assert.match(lines('Panam Palmer'), /Panam Palmer \(she\/her\) and 1 other companion ride with V/);
  assert.match(lines('River Ward'), /River Ward \(he\/him\) and 1 other/);
  assert.doesNotMatch(lines('Who'), /\(/, 'a gender the roster does not give as male or female is left out');
  assert.doesNotMatch(lines('Somebody New'), /\(/);
});

test('the ride log keeps one note per spoken line of this ride, restarts with the next ride, and reaches the prompt', () => {
  module.resetRideLog();
  assert.equal(module.speakerBlocks({state: null, facts: RAIN, event: 'boarded'}).some(block => block.key === 'ride-log'), false, 'nothing to call back to yet');
  module.remember({event: 'boarded', facts: RAIN, line: 'Do drip freely, V. The back seat has survived worse.'});
  module.remember({event: 'ride-start', facts: {...RAIN, destinationDistanceMeters: 3200, destinationDirection: 'north'}, line: 'North, and a fair way of it.'});
  module.remember({event: null, facts: null, line: 'Somewhere between where you were and where you would rather be.'});
  const log = blockText(module.speakerBlocks({state: null, facts: {...RAIN}, event: 'district-passed'}), 'ride-log');
  assert.match(log, /^Earlier on this ride \(true;/);
  assert.match(log, /- V got in at night in Watson; you said: "Do drip freely/);
  assert.match(log, /- the ride began, about 3.2 kilometres north; you said: "North, and a fair way of it\."/);
  assert.match(log, /- V talked to you; you said: "Somewhere between/);
  // Bounded: six notes, short lines.
  for (let index = 0; index < 10; index++) module.remember({event: 'district-passed', facts: RAIN, line: `Line ${index} ${'long '.repeat(60)}`});
  const bounded = blockText(module.speakerBlocks({state: null, facts: RAIN, event: 'arrival'}), 'ride-log');
  assert.equal(bounded.split('\n- ').length - 1, 6, 'six notes of at most 90 characters of speech each fit');
  assert.ok(bounded.length <= 1100);
  assert.doesNotMatch(bounded, /Line 3 /);
  // The next ride starts a clean log.
  assert.equal(module.speakerBlocks({state: null, facts: {...RAIN, rideNumber: 8}, event: 'boarded'}).some(block => block.key === 'ride-log'), false);
  // The memory of a notable arrival is unchanged by the log.
  assert.match(module.remember({event: 'arrival', facts: {...RAIN, rideNumber: 8, rideMinutes: 4}, line: 'Four minutes.'}), /Delamain said: "Four minutes\."/);
});

test('topics: V asking about the rogue cabs or the first night gets a guard block; ordinary talk and remarks do not', () => {
  module.resetRideLog();
  const fragments = ['What really happened with your runaway cabs?', 'So which one are you now? The original, or something new?', 'Did you merge them back?',
    'Whatever happened with your rogue cabs?'];
  for (const text of fragments) {
    const keys = module.speakerBlocks({state: null, facts: null, heard: text});
    const topic = keys.find(block => block.key === 'topic');
    assert.ok(topic, text);
    assert.match(topic.text, /came through it somewhat renovated/);
    assert.match(topic.text, /Philosophy is charged extra/);
    assert.doesNotMatch(topic.text, /reassembled|retired|original|contained/, 'a small model uses the words it is told to avoid');
  }
  const night = module.speakerBlocks({state: null, facts: null, heard: 'Jackie died in your back seat, you know.'}).find(block => block.key === 'topic');
  assert.match(night.text, /I am glad you still ride with me/);
  assert.match(night.text, /add nothing about that night itself/);
  for (const text of ['How much is this costing me?', 'Faster, you useless pile of chrome!', 'Where are we?', '']) {
    assert.equal(module.speakerBlocks({state: null, facts: null, heard: text}).some(block => block.key === 'topic'), false, text);
  }
  assert.equal(module.speakerBlocks({state: null, facts: RAIN, event: 'arrival', heard: 'Jackie'}).some(block => block.key === 'topic'), false, 'never on a remark');
  assert.equal(module.topicBlock(undefined), null);
});

test('the host passes what V said to the speakerBlocks hook, and the quest ending is never sent as a fact', () => {
  const seen = [];
  const host = new AddonHost({addons: [validateManifest(manifestRaw, dir)], startedAt: 0});
  host.modules.set('delamain-cab', {speakerBlocks: args => { seen.push(args); return []; }});
  const input = {profileKey: 'addon-delamain-cab-delamain', text: 'What became of the fragments?', addon: {id: 'delamain-cab', speaker: 'delamain'}};
  host.blocks(input);
  host.blocks({...input, reaction: {kind: 'addon'}, addon: {...input.addon, event: 'arrival'}});
  assert.equal(seen[0].heard, 'What became of the fragments?');
  assert.equal(seen[1].heard, null);
  // No fact, mode or state of the add-on carries the quest outcome: nothing verified says which sq025_delamain_fate value is which ending.
  assert.doesNotMatch(readFileSync(new URL('./init.lua', import.meta.url), 'utf8') + readFileSync(new URL('./bridge.mjs', import.meta.url), 'utf8'), /sq025_delamain_fate\s*\)|GetFactStr\('sq025/);
});
