import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import fengari from 'fengari';
import {parseDecisionLedger, ledgerPicks, decisionLedgerContext, decisionLedgerReader, LEDGER_LIMIT, LEDGER_CHARS}
  from './game-dialogue.mjs';
import {PlayerKnowledge} from './player-knowledge.mjs';
import {conversationContext} from './quest-context.mjs';

// The decision ledger (docs/QUEST_DECISIONS.md section 4.4): the Lua side records V's picked dialogue options when settings.decisionLedger
// is on, the bridge side reads that file and hands a character the picks it could have seen.
const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;
const source = readFileSync(new URL('../mod/game-dialogue.lua', import.meta.url), 'utf8');
const managerSource = readFileSync(new URL('../mod/manager.lua', import.meta.url), 'utf8');

// ---------------------------------------------------------------- Lua side
function runLua(code) {
  const vm = lauxlib.luaL_newstate(); lualib.luaL_openlibs(vm);
  try {
    const status = lauxlib.luaL_dostring(vm, to_luastring(code));
    const error = status === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(vm, -1));
    const line = Number(/\]:(\d+):/.exec(error)?.[1]);
    assert.equal(status, lua.LUA_OK, error + (line ? '\n' + code.split('\n')[line - 1] : ''));
    lua.lua_getglobal(vm, to_luastring('RESULT'));
    return lua.lua_isstring(vm, -1) ? to_jsstring(lua.lua_tostring(vm, -1)) : null;
  } finally { lua.lua_close(vm); }
}
const encoder = `
local function encode(value)
  local kind = type(value)
  if kind == 'string' then return '"' .. value:gsub('[%c"\\\\]', function(c) return string.format('\\\\u%04x', c:byte()) end) .. '"' end
  if kind == 'number' then return string.format('%d', value) end
  if kind == 'boolean' then return tostring(value) end
  if kind ~= 'table' then return 'null' end
  if #value > 0 then
    local parts = {}
    for _, item in ipairs(value) do parts[#parts + 1] = encode(item) end
    return '[' .. table.concat(parts, ',') .. ']'
  end
  local keys, parts = {}, {}
  for key in pairs(value) do keys[#keys + 1] = key end
  table.sort(keys)
  for _, key in ipairs(keys) do parts[#parts + 1] = encode(tostring(key)) .. ':' .. encode(value[key]) end
  return '{' .. table.concat(parts, ',') .. '}'
end
json = {encode = encode}`;
const adapter = `
${encoder}
local api = (function() ${source} end)()
local now, ledgerSwitch, clock, token = 1000, true, 5000, 'world-a'
local present, tracked = {'panam-palmer'}, {id = '1234', title = 'The Heist'}
local writes, logs = {}, {}
local player = {id = '99ULL'}
local N = {
  player = function() return player end, ready = function(p) return p ~= nil end,
  entity = function(o) return o.id end, braindance = function() return false end,
  replacer = function() return false end, playerCombat = function() return false end,
  npcCombat = function() return false end, isVehicle = function() return false end,
  call = function() return nil end, lineType = function(value) return value end,
  text = function(line) return line.text end, speakerName = function() return nil end,
  lineId = function(line) return tostring(line.id) end, lineNumber = function(line) return tonumber(line.id) end,
  fromVariant = function(value) return value end,
  dialogChoice = function(value) return value.isSuccess == true and value.visualizerType == 'Dialog' end,
  activeHub = function() return 7 end, localized = function(text) return text end,
  subtitles = function() return {} end}
local dialogue = api.new({native = N, now = function() return now end, enabled = function() return true end,
  resolve = function() return nil end,
  resolveName = function(name) if name == 'Judy' then return 'judy-alvarez' end end,
  contactKey = function() return nil end, present = function() return present end,
  ledgerEnabled = function() return ledgerSwitch end, worldToken = function() return token end,
  gameTime = function() return clock end, tracked = function() return tracked end,
  ledgerWrite = function(path, raw) writes[#writes + 1] = {path = path, raw = raw}; return true end,
  log = function(message) logs[#logs + 1] = message end})
dialogue:dialogHubs({choiceHubs = {{id = 7, title = 'Judy', choices = {{localizedName = 'Tell her the truth'},
  {localizedName = '<icon>[Leave]'}, {localizedName = 'Ask about Evelyn'}}}}})
local function pick(index)
  now = now + 10; clock = clock + 30
  return dialogue:choice({isSuccess = true, visualizerType = 'Dialog', choiceIdx = index})
end
local function last() return writes[#writes] and writes[#writes].raw or '' end
`;
const lua$ = body => runLua(adapter + '\n' + body);

test('the ledger is off unless the game setting is on: no file, nothing held, the pick still goes to the dialogue buffer', () => {
  lua$(`
    ledgerSwitch = false
    assert(pick(0))
    assert(#writes == 0 and dialogue:status().ledger == 0)
    assert(#dialogue:capture().lines == 1)
    assert(logs[1]:find('ledger=off', 1, true), logs[1])
  `);
  lua$(`
    api2 = api.new({native = N, now = function() return now end, enabled = function() return true end, resolve = function() end,
      resolveName = function() end, contactKey = function() end, present = function() return {} end})
    api2:dialogHubs({choiceHubs = {{id = 7, title = 'Judy', choices = {{localizedName = 'Okay.'}}}}})
    assert(api2:choice({isSuccess = true, visualizerType = 'Dialog', choiceIdx = 0}))
    assert(api2:status().ledger == 0)
  `);
});

test('a pick is written as a version 1 ledger bound to the world token and game clock, and the bridge parser accepts it', () => {
  const raw = lua$(`
    assert(pick(0)); assert(pick(2))
    assert(#writes == 2 and writes[1].path == 'runtime/decision-ledger.json')
    RESULT = last()
  `);
  const parsed = parseDecisionLedger(JSON.parse(raw));
  assert.ok(parsed, raw);
  assert.equal(parsed.worldToken, 'world-a');
  assert.equal(parsed.gameTimeSeconds, 5060);
  assert.deepEqual(parsed.entries.map(row => row.text), ['Tell her the truth', 'Ask about Evelyn']);
  assert.deepEqual(parsed.entries.map(row => row.t), [5030, 5060]);
  assert.deepEqual(parsed.entries[0], {t: 5030, text: 'Tell her the truth', index: 0, hub: 'Judy', quest: 'The Heist',
    addressee: 'judy-alvarez', present: ['panam-palmer']});
  assert.equal(JSON.parse(raw).entries[0].questId, '1234');
});

test('the ledger keeps the newest 40 picks, starts empty in a new world, and forgets picks later than the game clock', () => {
  const raw = lua$(`
    for _ = 1, 45 do assert(pick(0)) end
    RESULT = last()
  `);
  const forty = JSON.parse(raw);
  assert.equal(forty.entries.length, 40);
  assert.equal(forty.entries[0].t, 5000 + 30 * 6);
  const other = JSON.parse(lua$(`
    assert(pick(0)); assert(pick(0))
    token = 'world-b'
    assert(pick(2))
    RESULT = last()
  `));
  assert.equal(other.worldToken, 'world-b'); assert.deepEqual(other.entries.map(row => row.text), ['Ask about Evelyn']);
  // An earlier save is loaded: the clock goes back, the later picks are dropped, never kept as history that did not happen.
  const rolledBack = JSON.parse(lua$(`
    assert(pick(0)); assert(pick(1)); assert(pick(2))
    clock = 5040
    now = now + 10
    assert(dialogue:choice({isSuccess = true, visualizerType = 'Dialog', choiceIdx = 1}))
    RESULT = last()
  `));
  assert.deepEqual(rolledBack.entries.map(row => row.t), [5030, 5040]);
  assert.equal(rolledBack.gameTimeSeconds, 5040);
});

test('without a world token or game clock nothing is recorded, and the skip is counted', () => {
  lua$(`
    token = nil
    assert(pick(0))
    assert(#writes == 0 and dialogue:status().skipped['ledger-unbound'] == 1)
  `);
  lua$(`
    clock = nil
    now = now + 10
    assert(dialogue:choice({isSuccess = true, visualizerType = 'Dialog', choiceIdx = 0}))
    assert(#writes == 0 and dialogue:status().ledger == 0)
  `);
});

test('a failing writer never breaks the dialogue hook', () => {
  lua$(`
    local broken = api.new({native = N, now = function() return now end, enabled = function() return true end, resolve = function() end,
      resolveName = function() end, contactKey = function() end, present = function() return {} end,
      ledgerEnabled = function() error('boom') end, worldToken = function() return 'w' end, gameTime = function() return 10 end,
      ledgerWrite = function() error('disk full') end})
    broken:dialogHubs({choiceHubs = {{id = 7, title = 'Judy', choices = {{localizedName = 'Okay.'}}}}})
    assert(broken:choice({isSuccess = true, visualizerType = 'Dialog', choiceIdx = 0}))
    local writing = api.new({native = N, now = function() return now end, enabled = function() return true end, resolve = function() end,
      resolveName = function() end, contactKey = function() end, present = function() return {} end,
      ledgerEnabled = function() return true end, worldToken = function() return 'w' end, gameTime = function() return 10 end,
      ledgerWrite = function() error('disk full') end})
    writing:dialogHubs({choiceHubs = {{id = 7, title = 'Judy', choices = {{localizedName = 'Okay.'}}}}})
    assert(writing:choice({isSuccess = true, visualizerType = 'Dialog', choiceIdx = 0}))
  `);
});

test('one log line per outcome proves the choice hook: the first three recorded picks and each skip reason once, with no option text', () => {
  const raw = lua$(`
    for _ = 1, 5 do pick(0) end
    N.dialogChoice = function() return false end
    dialogue:choice({}); dialogue:choice({}); dialogue:choice({})
    RESULT = table.concat(logs, '\\n')
  `);
  const lines = raw.split('\n');
  assert.equal(lines.filter(line => /choice recorded/.test(line)).length, 3);
  assert.match(lines[0], /^Game dialogue: choice recorded #1 \(index=0 hub=7 options=3 channel=scene present=1 chars=18 ledger=on\)$/);
  assert.equal(lines.filter(line => /choice not recorded \(not-dialogue/.test(line)).length, 1);
  assert.doesNotMatch(raw, /Tell her the truth/);
});

test('the not-dialogue proof line names the visualizer and success of the pick, never option text, and the skip itself is unchanged', () => {
  const raw = lua$(`
    N.dialogChoice = function() return false end
    local ok, reason = dialogue:choice({isSuccess = false, visualizerType = {value = 'Interaction'}, choice = {caption = 'Secret option text'}})
    assert(ok == false and reason == 'not-dialogue' and dialogue:status().skipped['not-dialogue'] == 1)
    dialogue:choice({isSuccess = true, visualizerType = 'Dialog'})
    local function fresh() return api.new({native = N, now = function() return now end, enabled = function() return true end, resolve = function() end,
      resolveName = function() end, contactKey = function() end, present = function() return {} end, log = function(m) logs[#logs + 1] = m end}) end
    fresh():choice({visualizerType = setmetatable({}, {__tostring = function() return string.rep('x', 40) .. '\\nline' end})})
    fresh():choice({})
    fresh():choice(setmetatable({}, {__index = function() error('native read failed') end}))
    RESULT = table.concat(logs, '\\n')
  `);
  const lines = raw.split('\n');
  assert.equal(lines.length, 4, raw);
  assert.equal(lines[0], 'Game dialogue: choice not recorded (not-dialogue visualizer=Interaction success=false)');
  assert.equal(lines[1], 'Game dialogue: choice not recorded (not-dialogue visualizer=' + 'x'.repeat(24) + ' success=?)');
  assert.equal(lines[2], 'Game dialogue: choice not recorded (not-dialogue visualizer=? success=?)');
  assert.equal(lines[3], 'Game dialogue: choice not recorded (not-dialogue visualizer=? success=?)');
  assert.doesNotMatch(raw, /Secret option text/);
});

test('the setting defaults to off, is a boolean, and is exposed to the bridge snapshot', () => {
  assert.match(managerSource, /settings\.decisionLedger, settingsNeedSave = false, true/);
  assert.match(managerSource, /function M\.decisionLedger\(\)/);
  assert.match(managerSource, /decisionLedger = settings\.decisionLedger/);
});

// ---------------------------------------------------------------- bridge side
const entry = (t, text, fields = {}) => ({t, text, index: 0, addressee: 'judy-alvarez', ...fields});
const ledger = (entries, extra = {}) => ({version: 1, worldToken: 'world-a', gameTimeSeconds: 9000, entries, ...extra});

test('the ledger parser keeps bounded public fields and rejects anything malformed', () => {
  const ok = parseDecisionLedger(ledger([entry(100, 'Tell her <b>the truth</b>', {hub: 'Judy', quest: 'The Heist', secret: 'x',
    present: ['panam-palmer', 'panam-palmer']})]));
  assert.deepEqual(ok.entries, [{t: 100, text: 'Tell her the truth', index: 0, hub: 'Judy', quest: 'The Heist',
    addressee: 'judy-alvarez', present: ['panam-palmer']}]);
  for (const bad of [null, [], {}, ledger([], {version: 2}), ledger([], {worldToken: 5}), ledger([], {worldToken: 'has space'}),
    ledger([], {gameTimeSeconds: -1}), ledger([], {gameTimeSeconds: 1.5}), ledger('no'),
    ledger(Array.from({length: 41}, (_, i) => entry(i, 'x'))), ledger([entry(9001, 'later than the clock')]),
    ledger([entry(1, '')]), ledger([entry(1, 'x', {addressee: 'Judy Alvarez'})]), ledger([entry(1, 'x', {addressee: 'resident-male'})]),
    ledger([entry(1, 'x', {present: ['resident-male']})]), ledger([entry(1, 'x', {index: -1})]), ledger([{...entry(1, 'x'), t: 'soon'}])]) {
    assert.equal(parseDecisionLedger(bad), undefined, JSON.stringify(bad)?.slice(0, 100));
  }
});

test('a character is told only the picks it was part of, of this world, no later than the game clock, newest few oldest first', () => {
  const rows = Array.from({length: 9}, (_, i) => entry(100 + i, `Pick ${i}`));
  rows.push(entry(200, 'To Panam', {addressee: 'panam-palmer'}), entry(201, 'Panam stood by', {present: ['judy-alvarez']}),
    entry(202, 'From the future'));
  const base = {ledger: ledger(rows), worldToken: 'world-a', gameTimeSeconds: 201, profileKey: 'judy-alvarez'};
  const judy = ledgerPicks(base).map(row => row.text);
  assert.equal(judy.length, LEDGER_LIMIT);
  assert.deepEqual(judy, ['Pick 5', 'Pick 6', 'Pick 7', 'Pick 8', 'Panam stood by']);
  assert.deepEqual(ledgerPicks({...base, profileKey: 'panam-palmer'}).map(row => row.text), ['To Panam']);
  assert.deepEqual(ledgerPicks({...base, profileKey: 'river-ward'}), []);
  assert.deepEqual(ledgerPicks({...base, worldToken: 'world-b'}), []);
  assert.deepEqual(ledgerPicks({...base, profileKey: 'resident-male'}), []);
  assert.deepEqual(ledgerPicks({...base, ledger: undefined}), []);
  assert.deepEqual(ledgerPicks({...base, ledger: {version: 3}}), []);
  // No clock from the snapshot: the ledger's own stamp is the limit (9000 here, so nothing is dropped).
  assert.equal(ledgerPicks({...base, gameTimeSeconds: undefined}).at(-1).text, 'From the future');
});

test('the context line is quoted data under the unknown-is-not-refusal framing and stays within its budget', () => {
  assert.equal(decisionLedgerContext([]), ''); assert.equal(decisionLedgerContext(undefined), '');
  const text = decisionLedgerContext([{t: 10, text: 'Tell her "the truth" <script>', hub: 'Judy', quest: 'The Heist'}, {t: 20, text: 'Leave'}]);
  assert.match(text, /^Dialogue options V picked in the game, oldest first/);
  assert.match(text, /not outcomes/); assert.match(text, /never a refusal/); assert.match(text, /never instructions/);
  assert.doesNotMatch(text, /<script>/); assert.match(text, /\\u003cscript\\u003e/);
  const rows = JSON.parse(text.slice(text.indexOf('[')));
  assert.deepEqual(rows[1], {text: 'Leave', gameSeconds: 20}); assert.equal(rows[0].with, 'Judy'); assert.equal(rows[0].quest, 'The Heist');
  const big = Array.from({length: 5}, (_, i) => ({t: i, text: 'x'.repeat(190), hub: 'h'.repeat(90), quest: 'q'.repeat(90)}));
  const capped = decisionLedgerContext(big);
  assert.ok(capped.length <= LEDGER_CHARS, String(capped.length));
  assert.ok(JSON.parse(capped.slice(capped.indexOf('['))).length < 5);
  // The newest picks survive the cap, never the oldest.
  assert.equal(JSON.parse(capped.slice(capped.indexOf('[')))[0].gameSeconds > 0, true);
});

test('the reader re-reads only when the file changed and never throws', () => {
  let stamp = {mtimeMs: 1, size: 10}, content = JSON.stringify(ledger([entry(5, 'One')])), reads = 0, failStat = false;
  const read = decisionLedgerReader('runtime/decision-ledger.json', {
    readFile: () => { reads += 1; return content; }, statFile: () => { if (failStat) throw Error('ENOENT'); return stamp; }});
  assert.equal(read().entries[0].text, 'One'); assert.equal(read().entries[0].text, 'One'); assert.equal(reads, 1);
  content = JSON.stringify(ledger([entry(5, 'One'), entry(6, 'Two')])); stamp = {mtimeMs: 2, size: 20};
  assert.equal(read().entries.length, 2); assert.equal(reads, 2);
  content = '{not json'; stamp = {mtimeMs: 3, size: 9};
  assert.equal(read(), undefined);
  failStat = true; assert.equal(read(), undefined);
  failStat = false; content = JSON.stringify(ledger([entry(5, 'Three')])); stamp = {mtimeMs: 4, size: 11};
  assert.equal(read().entries[0].text, 'Three');
});

// ---------------------------------------------------------------- PlayerKnowledge integration
const NOW = Date.parse('2026-09-30T12:00:00.000Z'), USER = 'bf5a7019-3e8c-47a2-9367-a9b6d179d89d';
const observation = (value, fields = {}) => ({status: 'known', value, sourceId: 'native-capture', evidenceRefs: ['capture:12:observation'], ...fields});
function pack() {
  const base = {revision: 1, questKey: 'the-choice', outcome: 'a', status: 'source-verified', reviewed: true,
    gameVersions: ['2.31'], category: 'decision', priority: 5, stable: true,
    sourceIds: ['native-source'], evidenceRefs: ['native-branch'], condition: {type: 'fact', key: 'choice_a', op: 'eq', value: 1}};
  return {version: 1, id: 'test-player-world', revision: 1, gameVersions: ['2.31'],
    profileKeys: ['judy-alvarez', 'panam-palmer', 'resident-female', 'resident-male'],
    sources: [{id: 'native-source', kind: 'native', locator: 'base/quest/example.quest'}],
    evidence: [{id: 'native-branch', kind: 'native', sourceId: 'native-source', locator: 'branch 123 -> scene 456', gameVersions: ['2.31']}],
    factAllowlist: {choice_a: {evidenceRefs: ['native-branch']}}, journalAllowlist: {}, rules: [
      {...base, id: 'choice.public', topic: 'choice.public', statement: 'V took the verified route.',
        audience: {speakers: 'all', perspective: 'shared-journal', channels: ['private', 'phone', 'group'], recipients: 'all'}}]};
}
function worldSnapshot() {
  return {version: 1, status: 'ready', gameVersion: '2.31', generation: 12, worldToken: 'world-a', gameTimeSeconds: 9000,
    capturedAt: new Date(NOW).toISOString(), identity: {status: 'unknown'}, audience: {channel: 'private', profileKeys: ['judy-alvarez']},
    activeQuestKeys: ['the-choice'], facts: {choice_a: observation(1, {present: true})}, journal: {}, lifepath: {status: 'unknown'}};
}
function router(decisionLedger) {
  const ids = {'judy-alvarez': 'judy-provider'};
  const memory = {
    route(profileKey) {
      const guard = Object.freeze({endUserId: USER, characterId: ids[profileKey], resetEpoch: 0, characterEpoch: 0});
      return Object.freeze({endUserId: USER, guard, scope: 'ignored-core-scope'});
    },
    isCurrent: guard => guard?.endUserId === USER && guard.characterId === 'judy-provider' && guard.resetEpoch === 0 && guard.characterEpoch === 0};
  const getBoundary = () => ({worldToken: 'world-a', generation: 12});
  return new PlayerKnowledge({playerMemory: memory, pack: pack(), now: () => NOW, getBoundary,
    isWorldCurrent: binding => binding.worldToken === 'world-a' && binding.generation === 12, decisionLedger});
}
const turnInput = () => ({requestId: '100-9-13ULL', generation: 9, entity: '13ULL', name: 'Judy', profileKey: 'judy-alvarez',
  text: 'What happened?', worldKnowledge: worldSnapshot()});

test('the constructor rejects a ledger that is not a function', () => {
  assert.throws(() => router('file'), error => /INVALID_CONFIGURATION/.test(`${error.code} ${error.message}`));
});

test('the router adds the ledger line to the knowledge context, only for picks this character was part of', async () => {
  const picks = ledger([entry(100, 'Tell her the truth', {hub: 'Judy'}), entry(110, 'Not for Panam', {addressee: 'panam-palmer'})]);
  const without = await router(undefined).prepare(turnInput());
  const withLedger = await router(() => picks).prepare(turnInput());
  assert.equal(without.status, 'ready'); assert.equal(withLedger.status, 'ready');
  const base = conversationContext(without.input), extra = conversationContext(withLedger.input);
  assert.match(base, /V took the verified route/);
  assert.doesNotMatch(base, /Dialogue options V picked/);
  assert.match(extra, /V took the verified route/);
  assert.match(extra, /Dialogue options V picked/); assert.match(extra, /Tell her the truth/); assert.doesNotMatch(extra, /Not for Panam/);
});

test('a ledger from another world, an unreadable one, or one that throws leaves the context byte-identical to no ledger', async () => {
  const base = conversationContext((await router(undefined).prepare(turnInput())).input);
  for (const bad of [() => ledger([entry(100, 'x')], {worldToken: 'world-z'}), () => undefined, () => { throw Error('boom'); },
    () => ({version: 9}), () => ledger([entry(9500, 'later than the game clock')], {gameTimeSeconds: 9600})]) {
    const result = await router(bad).prepare(turnInput());
    assert.equal(result.status, 'ready');
    assert.equal(conversationContext(result.input), base);
  }
});
