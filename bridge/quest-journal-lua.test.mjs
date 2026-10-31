// The game half of the real quests (mod/quest-journal.lua, docs/REAL_QUESTS.md) on a fake game: what the quest log of QuestLog.reds is told for each change of
// the journal block, who gets the tracker, the cleanup on an ending, a removal, the setting going off, a load, and the journal block of the runner's own play
// files passed through the real quest executor (mod/quest-play.lua).
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import {run, load, base} from './quest-lua-fixture.mjs';
import {BondPacks} from './bond-pack-runner.mjs';
import {shippedPacks} from './bond-packs.mjs';
import {parseJournalHistory} from './journal-history.mjs';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const roster = new Set(JSON.parse(read('../characters/roster.json')).map(row => row.key));
const pilot = shippedPacks().map(row => row.pack).find(pack => pack.id === 'panam-sunset-coffee');
const toLua = value => {
  if (value === null || value === undefined) return 'nil';
  if (Array.isArray(value)) return '{' + value.map(toLua).join(',') + '}';
  if (typeof value === 'object') return '{' + Object.entries(value).map(([key, item]) => `[${JSON.stringify(key)}]=${toLua(item)}`).join(',') + '}';
  return JSON.stringify(value);
};

// The play files of the pilot as the runner writes them: started, walking, ended.
function playFiles() {
  const coverage = {status: 'complete', ageSeconds: 1, windowSeconds: 30, observed: 1, omitted: 0, unstable: false};
  const journalHistory = parseJournalHistory({version: 1, status: 'ready', generation: 1, capturedAtMs: 2000, worldToken: 'w1', tracked: {status: 'untracked'},
    coverage: {active: coverage, history: coverage}, quests: [{id: '100', nativeId: 'q104_02_av_chase', nativePath: 'quests/main_quest/act_01/q104_02_av_chase',
      title: 'Q', state: 'succeeded', lane: 'history', observedAtMs: 1000, objectivesComplete: true, objectives: []}]});
  const runner = new BondPacks({packs: [pilot], characters: roster, random: () => 0, reach: null, debounceMs: 0, exists: () => false, write: async () => {},
    bonds: {award() {}, publish() {}}});
  const t0 = 30 * 86400, files = {};
  const input = {requestId: 'r-1', profileKey: 'panam-palmer', name: 'Panam', text: 'hey', entity: 'e1', turnContext: {gameTime: t0}, journalHistory,
    bonds: {on: true, copy: 'party', packs: true, invitations: true}};
  runner.forTurn(input, {level: 3}); runner.afterTurn(input, 'ok');
  files.invite = runner.playState();
  const go = (name, at) => runner.noteEvent({pack: 'panam-sunset-coffee', serial: runner.playState().quests[0].serial, name, at});
  go('place:sunset:arrived', t0 + 100); files.walk = runner.playState();
  go('together:tour:broken', t0 + 400); files.left = runner.playState();
  return files;
}
const FILES = playFiles();

const harness = `
local Journal = ${load('quest-journal.lua')}
${base}
local calls = {}
local world = {
  set = function(row, track) calls[#calls + 1] = {'set', row.id, row.state, row.objective, track, row.x ~= nil}; return true end,
  remove = function(id) calls[#calls + 1] = {'remove', id}; return true end,
  clear = function(forget) calls[#calls + 1] = {'clear', forget}; return true end,
  status = function() return 'quests=1' end,
}
local files = {}
local function journalOf(opts)
  opts = opts or {}
  return Journal.new({world = opts.world or world, read = function(path) return files[path] end, decode = decode, log = log})
end
local function said() local parts = {} for _, c in ipairs(calls) do local p = {} for i = 1, #c do p[i] = tostring(c[i]) end parts[#parts + 1] = table.concat(p, ',') end calls = {} return table.concat(parts, ' | ') end
local function eq(a, b, what) if a ~= b then error((what or 'value') .. ': expected [' .. tostring(b) .. '] got [' .. tostring(a) .. ']') end end
local function row(fields)
  local r = {pack = 'panam-sunset-coffee', title = 'Coffee at the Sunset', description = 'Panam asked.', objective = 'Meet Panam at the Sunset Motel', state = 'active',
    serial = 1, since = 100, place = {id = 'sunset', name = 'the Sunset Motel', radius = 25, x = 1, y = 2, z = 3}}
  for k, v in pairs(fields or {}) do r[k] = v end
  return r
end
`;
const lua = code => run(`${harness}\n${code}`);

test('a pack that starts takes the tracker, an unchanged block costs nothing, a new objective and an ending are sent, a quest that went is removed', () => lua(`
local j = journalOf()
eq(j.apply({row()}), 1)
eq(said(), 'set,panam-sunset-coffee,active,Meet Panam at the Sunset Motel,2,true')
eq(j.holding(), true)
eq(j.apply({row()}), 0, 'unchanged')
eq(said(), '')
j.apply({row({objective = 'Walk around Rocky Ridge with Panam', serial = 2, since = 200, place = {id = 'lookout', name = 'x'}})})
eq(said(), 'set,panam-sunset-coffee,active,Walk around Rocky Ridge with Panam,0,false', 'a later stage never takes the tracker again; a place with no position has no pin')
j.apply({row({state = 'succeeded', objective = 'Walk around Rocky Ridge with Panam', place = false})})
eq(said(), 'set,panam-sunset-coffee,succeeded,Walk around Rocky Ridge with Panam,0,false')
j.apply({row({state = 'active', objective = 'Meet Panam at the Sunset Motel', serial = 3, since = 900})})
eq(said(), 'set,panam-sunset-coffee,active,Meet Panam at the Sunset Motel,2,true', 'a hangout played again starts again: it takes the tracker')
j.apply({})
eq(said(), 'remove,panam-sunset-coffee')
eq(j.holding(), false)
`));

test('a session start forgets what the game side held, tracks only the newest quest in progress, and drops a row stamped later than the save', () => lua(`
local j = journalOf()
j.apply({row({pack = 'a-one', since = 500}), row({pack = 'b-two', since = 400}), row({pack = 'c-later', since = 99999})},
  {startup = true, fresh = function(since) return since <= 1000 end})
eq(said(), 'clear,true | set,a-one,active,Meet Panam at the Sunset Motel,1,true | set,b-two,active,Meet Panam at the Sunset Motel,0,true')
j.apply({row({pack = 'a-one', since = 500}), row({pack = 'b-two', since = 400})})
eq(said(), '', 'the same rows again')
`));

test('a place the journal marks gets no second pin from the pin primitive; without a position the primitive pins as before', () => run(`
${harness}
local Places = ${load('quest-places.lua')}
local j = journalOf()
j.apply({row()})
eq(j.waypoint('panam-sunset-coffee', 'sunset'), true)
eq(j.waypoint('panam-sunset-coffee', 'lookout'), false)
eq(j.waypoint('other-pack', 'sunset'), false)
local adds, removes = 0, 0
local placeWorld = {pinAdd = function() adds = adds + 1; return 'pin' .. adds end, pinRemove = function() removes = removes + 1 end}
local places = Places.new({world = placeWorld, clock = function() return 0 end, log = log,
  journalPin = function(ctx, id) return j.waypoint(ctx and ctx.pack, id) end})
local ctx = {pack = 'panam-sunset-coffee', track = function() end}
places.pin(ctx, 'sunset', {x = 1, y = 2, z = 3, radius = 25})
eq(adds, 0, 'the journal marks it'); eq(places.pinned(ctx, 'sunset'), true)
places.unpin(ctx, 'sunset')
eq(removes, 0, 'nothing of the journal is removed here')
j.apply({row({place = {id = 'sunset', name = 'the Sunset Motel'}})})
eq(j.waypoint('panam-sunset-coffee', 'sunset'), false, 'no position, no waypoint')
places.pin(ctx, 'sunset', {x = 1, y = 2, z = 3, radius = 25})
eq(adds, 1); places.unpin(ctx, 'sunset'); eq(removes, 1)
j.apply({row({state = 'succeeded'})})
eq(j.waypoint('panam-sunset-coffee', 'sunset'), false, 'an ended quest has no waypoint')
`));

test('off and a load: clear removes everything, reset forgets it without asking the map, nothing is sent while nothing is held', () => lua(`
local j = journalOf()
j.clear('off')
eq(said(), '', 'nothing held, nothing asked')
j.apply({row()})
said()
j.clear('off')
eq(said(), 'clear,false')
eq(j.holding(), false)
j.apply({row()})
said()
j.reset()
eq(said(), 'clear,true')
j.apply({row()})
eq(said(), 'set,panam-sunset-coffee,active,Meet Panam at the Sunset Motel,2,true', 'rebuilt after the load')
j.apply(nil)
eq(said(), 'clear,false', 'no journal block at all')
`));

test('a pack place measured in the game gives the waypoint, bad rows are dropped, a failing game call is logged once and retried', () => lua(`
files['runtime/quest-place-capture.json'] = serialize({version = 1, places = {sunset = {x = 7, y = 8, z = 9}}})
local j = journalOf()
j.apply({row({place = {id = 'sunset', name = 'the Sunset Motel'}}), {pack = 'Bad Id!', title = 't', state = 'active'}, {pack = 'no-title', state = 'active'},
  {pack = 'odd-state', title = 't', state = 'weird'}})
eq(said(), 'set,panam-sunset-coffee,active,Meet Panam at the Sunset Motel,2,true', 'the capture filled the position')
local failing = {set = function() error('boom') end, remove = function() return true end, clear = function() return true end}
local k = journalOf({world = failing})
eq(k.apply({row()}), 0)
eq(k.apply({row()}), 0, 'retried, not held')
eq(logged('set failed'), true)
local long = string.rep('é', 400)
eq(#Journal.cleanRow(row({description = long})).description <= Journal.MAX_TEXT, true)
local status = j.status()
eq(status.quests, 1); eq(status.held, 'panam-sunset-coffee:active'); eq(status.game, 'quests=1')
`));

test('through the real quest executor: the runner\'s play files build, move and end the quest, and the setting going off clears it', () => run(`
local Journal = ${load('quest-journal.lua')}
local Play = ${load('quest-play.lua')}
${base}
local calls = {}
local world = {
  set = function(row, track) calls[#calls + 1] = row.id .. ':' .. row.state .. ':' .. row.objective .. ':' .. track; return true end,
  remove = function(id) calls[#calls + 1] = 'remove:' .. id; return true end,
  clear = function(forget) calls[#calls + 1] = 'clear:' .. tostring(forget); return true end,
}
local game = {files = {}, enabled = true, clock = 30 * 86400 + 1000}
local journal = Journal.new({world = world, read = function(path) return game.files[path] end, decode = decode, log = log})
local play = Play.new({enabled = function() return game.enabled end, clock = function() return 0 end, gameTime = function() return game.clock end,
  read = function(path) return game.files[path] end, write = function(path, text) game.files[path] = text; return true end,
  encode = serialize, decode = decode, session = 's1', log = log, journal = journal})
local function said() local text = table.concat(calls, ' | '); calls = {}; return text end
local function eq(a, b, what) if a ~= b then error((what or 'value') .. ': expected [' .. tostring(b) .. '] got [' .. tostring(a) .. ']') end end
game.files[Play.PLAY] = serialize(${toLua(FILES.invite)})
play.restore()
eq(said(), 'clear:true | panam-sunset-coffee:active:Meet Panam at the Sunset Motel:1', 'a session start: tracked as nothing else is')
game.files[Play.PLAY] = serialize(${toLua(FILES.walk)})
play.onPlayRevision()
eq(said(), 'panam-sunset-coffee:active:Walk around Rocky Ridge with Panam:0')
game.files[Play.PLAY] = serialize(${toLua(FILES.left)})
play.onPlayRevision()
eq(said(), 'panam-sunset-coffee:succeeded:Walk around Rocky Ridge with Panam:0', 'walked off: the left ending is a success with 15 points')
play.abandon()
eq(said(), 'clear:true', 'the world ended')
play.restore()
eq(said(), 'clear:true | panam-sunset-coffee:succeeded:Walk around Rocky Ridge with Panam:0', 'rebuilt from the file after the load')
play.settingOff()
eq(said(), 'clear:false')
eq(journal.holding(), false)
game.files[Play.PLAY] = nil
play.restore()
eq(said(), '', 'no file, nothing held: nothing asked')
`));

test('a pack that starts cannot be missed: a notice names it (title and first objective), once per start, never at a session start or a load, and the journal entry and map pin are made too', () => lua(`
local notices = {}
local j = Journal.new({world = world, read = function(path) return files[path] end, decode = decode, log = log,
  notice = function(r) notices[#notices + 1] = r.title .. '|' .. r.objective end})
-- The start: the journal entry is made with the tracker offer and the pin, and the notice is shown.
eq(j.apply({row()}), 1)
eq(said(), 'set,panam-sunset-coffee,active,Meet Panam at the Sunset Motel,2,true', 'entry, tracker and pin')
eq(#notices, 1, 'one notice')
eq(notices[1], 'Coffee at the Sunset|Meet Panam at the Sunset Motel')
-- The same block again, a later stage and an ending are not starts.
j.apply({row()}); j.apply({row({objective = 'Walk around Rocky Ridge with Panam', serial = 2})}); j.apply({row({state = 'succeeded'})})
eq(#notices, 1, 'only the start')
-- A hangout played again starts again.
j.apply({row({state = 'active', serial = 3, since = 900})})
eq(#notices, 2)
-- A session start or a load finds quests that are already running: no notice.
local again = Journal.new({world = world, read = function(path) return files[path] end, decode = decode, log = log, notice = function(r) notices[#notices + 1] = r.title end})
again.apply({row()}, {startup = true})
eq(#notices, 2, 'a quest found at a session start is not new')
-- A notice that raises an error never stops the entry.
local broken = Journal.new({world = world, read = function(path) return files[path] end, decode = decode, log = log, notice = function() error('boom') end})
calls = {}
eq(broken.apply({row({pack = 'judy-door-duty', title = 'Door Duty'})}), 1)
eq(broken.holding(), true)
`));
