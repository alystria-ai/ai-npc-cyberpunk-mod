// The small changes mod/holocall.lua got for the bond quests (mod/quest-prims-calls.lua, mod/quest-world-calls.lua): a call the character makes to V (opts.incoming) rings until V picks
// up, a refusal can be quiet, the portrait voice call can be asked for, the connect hook onCallStarted, M.lastEnd, and the quiet end 'scripted'. A call V makes behaves as before.
// Run on the same lean fake game as bridge/holocall.test.mjs (one player with the native methods Holocall.reds adds). Nothing here starts the game.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {run as runLua} from './quest-lua-fixture.mjs';

const source = readFileSync(new URL('../mod/holocall.lua', import.meta.url), 'utf8').replace(/\r\n/g, '\n');

const fixture = `
local holocall
local logs, notices, ended, started = {}, {}, {}, {}
convaiNotices = {send = function(_, id, text) notices[#notices + 1] = {id = id, text = text}; return true end}
convaiUiLocale = {revision = function() return 1 end, t = function(text, args) return text end}
local function logged(pattern) for _, line in ipairs(logs) do if line:find(pattern) then return line end end end
local game = {begin = 'ok', window = 'audiocall', events = {}, ends = 0, connects = {}}
local player = {}
function player:GetEntityID() return {hash = '7ULL'} end
function player:ConvaiHolocallTakeRequest() return '' end
function player:ConvaiHolocallBegin(contact, name) game.began = contact; return game.begin end
function player:ConvaiHolocallConnect(live) game.connects[#game.connects + 1] = live; return game.window end
function player:ConvaiHolocallEnd() game.ends = game.ends + 1 end
function player:ConvaiHolocallTakeEvent() return table.remove(game.events, 1) or '' end
function player:ConvaiHolocallHasBacking() return false end
local open = {available = true, combat = false, tier = 1, dialogue = false, choices = false, call = false, replacer = false}
local function tick(seconds, s) local left = seconds; while left > 0 do holocall.update(player, 0.1, true, s or open); left = left - 0.1 end end
dofile = function(path) error('unexpected ' .. path) end
holocall = (function() ${source} end)()
holocall.configure({
  log = function(line) logs[#logs + 1] = line end,
  contacts = function() return {{contact = 'panam', key = 'panam-palmer', name = 'Panam Palmer', record = 'Character.Panam'}} end,
  supported = function(key) return key == 'panam-palmer' end,
  profileEnabled = function(key) return true end,
  warm = function() end, liveImage = function() return false end, busy = function() return false end,
  onConnected = function(call) started[#started + 1] = 'env:' .. call.contact end,
  onEnded = function(call, reason) ended[#ended + 1] = call.contact .. ':' .. reason end,
})
holocall.sweepDue = false
`;
const withModule = code => runLua(`${fixture}\n${code}`);

test('a call V makes is as before: it rings, connects by itself, and the connect hook (when set) is told once with the profile key', () => withModule(`
local told = {}
holocall.onCallStarted = function(key, call) told[#told + 1] = key .. ':' .. tostring(call.quest) end
assert(holocall.start(player, 'panam', open))
assert(holocall.call.incoming == nil and holocall.call.quest == nil)
tick(3)
assert(holocall.connected() and #told == 1 and told[1] == 'panam-palmer:nil' and started[1] == 'env:panam')
tick(2); assert(#told == 1, 'once per call')
holocall.finish(player, 'hangup')
assert(holocall.lastEnd.serial == 1 and holocall.lastEnd.reason == 'hangup')
`));

test('an incoming call rings until V picks up: it never connects by itself, however long, and a pick-up connects it after the minimum ring', () => withModule(`
assert(holocall.start(player, 'panam', open, nil, {incoming = true, quiet = true, quest = true}))
assert(holocall.call.incoming == true and holocall.call.quest == true and holocall.call.state == 'dialing')
tick(60)
assert(holocall.call.state == 'dialing' and #game.connects == 0, 'rings and rings')
game.events = {'hangup'}   -- the phone button, a tap or a hold: the only signal the redscript gives
tick(0.3)
assert(holocall.call.answered == true)
tick(2)
assert(holocall.connected() and #game.connects == 1)
-- Once connected, the phone button hangs up as ever.
game.events = {'hangup'}; tick(0.3)
assert(holocall.call == nil and ended[#ended] == 'panam:hangup')
`));

test('a redscript that reports "answer" for a tap makes a hangup turn the incoming call away', () => withModule(`
holocall.HANGUP_ANSWERS = false
assert(holocall.start(player, 'panam', open, nil, {incoming = true, quiet = true, quest = true}))
game.events = {'hangup'}; tick(0.3)
assert(holocall.call == nil and ended[1] == 'panam:hangup' and holocall.lastEnd.reason == 'hangup')
assert(holocall.start(player, 'panam', open, nil, {incoming = true, quiet = true, quest = true}))
game.events = {'answer'}; tick(2)
assert(holocall.connected())
`));

test('the combat, scene and game-call checks still end a ringing incoming call', () => withModule(`
assert(holocall.start(player, 'panam', open, nil, {incoming = true, quiet = true, quest = true}))
tick(2, {available = true, combat = true, tier = 1})
assert(holocall.call == nil and holocall.lastEnd.reason == 'combat')
`));

test('a refusal is quiet for a quest call and loud for V\'s: the same refusal, one notice or none', () => withModule(`
game.begin = 'quest-call'
assert(holocall.start(player, 'panam', open, nil, {incoming = true, quiet = true, quest = true}) == false)
assert(#notices == 0 and logged('refused contact=panam reason=quest%-call'))
assert(holocall.start(player, 'panam', open) == false)
assert(#notices == 1 and notices[1].id == 'holocall-refused')
assert(holocall.start(player, 'nobody', open, nil, {quiet = true}) == false and #notices == 1, 'a quiet refusal for a contact that is not one')
`));

test('the portrait voice call can be asked for, and the quest end sends no notice', () => withModule(`
assert(holocall.start(player, 'panam', open, nil, {voice = true, quest = true, incoming = true}))
assert(holocall.call.cast == 'voice' and holocall.call.wantLive == false)
game.events = {'hangup'}; tick(2.5)
assert(holocall.connected())
holocall.finish(player, 'scripted')
assert(holocall.lastEnd.reason == 'scripted' and #notices == 0, 'quiet')
holocall.start(player, 'panam', open); tick(2.5); holocall.finish(player, 'idle')
assert(#notices == 1, 'any other end tells V')
`));

test('a raising hook does not break the connect, and abandon records why the call ended', () => withModule(`
holocall.onCallStarted = function() error('hook broke') end
assert(holocall.start(player, 'panam', open)); tick(3)
assert(holocall.connected())
holocall.abandon('save restored')
assert(holocall.call == nil and holocall.lastEnd.reason == 'save restored' and holocall.lastEnd.serial == 1)
`));

test('the redscript and the Lua agree: the pick-up and the quiet end add no native call and no new redscript method', () => {
  const code = source.split('\n').filter(line => !line.trim().startsWith('--')).join('\n');
  assert.match(code, /function M\.start\(player, contact, sample, waited, opts\)/);
  assert.doesNotMatch(code, /ConvaiHolocallIncoming|ShowIncomingContact|StartAudiocall/);
});
