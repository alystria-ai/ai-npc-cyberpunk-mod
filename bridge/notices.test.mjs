import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, readdirSync} from 'node:fs';
import fengari from 'fengari';

// Every on-screen notice goes through mod/notices.lua. This file keeps the catalog, the call sites
// and docs/NOTIFICATIONS.md in step, so a new ungated notice fails here.
const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;
const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const noticesSource = read('../mod/notices.lua');
const modFiles = readdirSync(new URL('../mod/', import.meta.url)).filter(name => name.endsWith('.lua') && name !== 'notices.lua');

function run(body) {
  const state = lauxlib.luaL_newstate(); lualib.luaL_openlibs(state);
  try {
    const program = `
      local now = 1000
      os.time = function() return now end
      local notices = (function() ${noticesSource} end)()
      local developer = false
      notices.configure(function() return developer end)
      local shown = {}
      local player = {ConvaiPhoneFeedback = function(_, text) shown[#shown + 1] = text end}
      ${body}`;
    const status = lauxlib.luaL_dostring(state, to_luastring(program));
    const error = status === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(state, -1));
    assert.equal(status, lua.LUA_OK, error);
  } finally { lua.lua_close(state); }
}

// The catalog as data: id -> {class, repeatS}.
function catalog() {
  const entries = {};
  for (const match of noticesSource.matchAll(/\['([a-z0-9-]+)'\]\s*=\s*\{class = (PLAYER|DEVELOPER|REMOVED)(?:,\s*repeatS = (\d+))?\}/g)) {
    entries[match[1]] = {class: match[2].toLowerCase(), repeatS: match[3] ? Number(match[3]) : null};
  }
  return entries;
}
const entries = catalog();
const isId = text => /^[a-z0-9]+(-[a-z0-9]+)+$/.test(text);

// Mod Lua with comments removed, so prose cannot hide or fake a call.
function code(name) {
  return read(`../mod/${name}`).split('\n').map(line => line.replace(/^\s*--.*$/, '')).join('\n');
}

// The arguments of every call `callee(` in a source, split at top-level commas.
function calls(source, callee) {
  const found = [];
  let from = 0;
  for (;;) {
    const at = source.indexOf(callee, from);
    if (at < 0) break;
    from = at + callee.length;
    const before = source[at - 1];
    if (before && /[\w]/.test(before)) continue;
    if (/function\s+$/.test(source.slice(Math.max(0, at - 12), at))) continue; // a definition, not a call
    let depth = 1, index = at + callee.length, argument = '', quote = null;
    const args = [];
    while (index < source.length && depth > 0) {
      const char = source[index];
      if (quote) { argument += char; if (char === quote && source[index - 1] !== '\\') quote = null; }
      else if (char === "'" || char === '"') { quote = char; argument += char; }
      else if ('({['.includes(char)) { depth++; argument += char; }
      else if (')}]'.includes(char)) { depth--; if (depth > 0) argument += char; }
      else if (char === ',' && depth === 1) { args.push(argument); argument = ''; }
      else argument += char;
      index++;
    }
    args.push(argument);
    found.push({args, line: source.slice(0, at).split('\n').length});
  }
  return found;
}
const literals = text => [...text.matchAll(/'([^'\n]*)'/g)].map(match => match[1]);

test('the catalog is well formed', () => {
  assert(Object.keys(entries).length >= 30, 'the catalog could not be read');
  const declared = [...noticesSource.matchAll(/^\s*\['([a-z0-9-]+)'\]\s*=/gm)].map(match => match[1]);
  assert.deepEqual([...declared].sort(), Object.keys(entries).sort(), 'an entry does not match the catalog pattern');
  assert.equal(new Set(declared).size, declared.length, 'duplicate ids');
  for (const [id, entry] of Object.entries(entries)) {
    assert(isId(id), `${id} is not a hyphenated id`);
    if (entry.repeatS !== null) {
      assert.equal(entry.class, 'player', `${id}: only Player notices have a repeat window`);
      assert(entry.repeatS >= 5, `${id}: a window under 5 s does not stop a repeat`);
    }
  }
  // These are replaced in place by the notice board, which already decides when a text is new.
  for (const id of ['invite-board', 'party-joined', 'party-failed', 'party-dismiss-failed']) {
    assert.equal(entries[id].repeatS, null, `${id} is deduplicated by the board`);
  }
});

test('no mod file calls the game notice directly; everything goes through the gate', () => {
  for (const name of modFiles) {
    const source = code(name);
    assert(!/[:.]ConvaiPhoneFeedback\s*\(/.test(source),
      `${name} calls ConvaiPhoneFeedback directly: use convaiNotices.send(player, id, text) and add the id to mod/notices.lua`);
    assert(!/SetWarningMessage/.test(source), `${name} posts a warning message directly`);
  }
  // The gate itself posts exactly once, from sendLines.
  assert.equal([...code('notices.lua').matchAll(/:ConvaiPhoneFeedback\(/g)].length, 1);
  // Native side: the HUD warning line is posted by one method, plus the reply line (not a notice).
  const phone = read('../r6/scripts/CyberpunkConvai/PhoneContacts.reds');
  assert.equal([...phone.matchAll(/SetWarningMessage\(/g)].length, 1, 'PhoneContacts.reds posts another warning message');
  assert(/func ConvaiPhoneFeedback\(message: String\) -> Void \{\s*this\.SetWarningMessage\(/.test(phone));
  for (const name of readdirSync(new URL('../r6/scripts/CyberpunkConvai/', import.meta.url))) {
    if (name === 'PhoneContacts.reds') continue;
    const reds = read(`../r6/scripts/CyberpunkConvai/${name}`);
    const posts = [...reds.matchAll(/WarningMessage|SetWarningMessage|ShowGameNotification|UIInGameNotification/g)];
    // Composer.reds shows the character's reply through the same blackboard line; that is the reply, not a notice.
    assert.equal(posts.length, name === 'Composer.reds' ? 1 : 0, `${name} posts an on-screen message outside the gate`);
  }
});

test('every notice call site names a catalogued id', () => {
  const used = new Set();
  let sites = 0;
  for (const name of modFiles) {
    const source = code(name);
    const found = [];
    for (const call of calls(source, 'convaiNotices.send(')) found.push({call, expression: call.args[1], what: 'send'});
    for (const call of calls(source, 'report(')) {
      if (name === 'manager-party.lua') found.push({call, expression: call.args[0], what: 'report'});
    }
    for (const call of found) {
      const ids = literals(call.expression || '').filter(isId);
      assert(ids.length > 0, `${name}:${call.call.line} ${call.what}(...) has no catalogued id literal in "${(call.expression || '').trim()}"`);
      for (const id of ids) { assert(entries[id], `${name}:${call.call.line} uses ${id}, which is not in mod/notices.lua`); used.add(id); }
      sites++;
    }
    // Lines handed to sendLines and ids tested directly.
    for (const match of source.includes('sendLines(') ? source.matchAll(/\{id = '([^']+)'/g) : []) {
      assert(entries[match[1]], `${name} lists the unknown notice id ${match[1]}`); used.add(match[1]); sites++;
    }
    for (const match of source.matchAll(/\b(?:shown|visible|permit)\('([^']+)'/g)) {
      assert(entries[match[1]], `${name} checks the unknown notice id ${match[1]}`); used.add(match[1]);
    }
  }
  assert(sites >= 25, `only ${sites} call sites were found; the scan is broken`);
  // A queue notice carries its id through to the final send (mcm.lua forwards notice.id).
  assert(/\{id = notice\.id, text = notice\.message\}/.test(code('mcm.lua')), 'mcm.lua no longer forwards the queue notice id');
  for (const id of Object.keys(entries)) {
    assert(used.has(id), `${id} is in the catalog but no call site uses it: remove it or wire it up`);
  }
});

test('docs/NOTIFICATIONS.md lists exactly the catalog, with the same classes', () => {
  const doc = read('../docs/NOTIFICATIONS.md');
  const rows = [...doc.matchAll(/^\| `([a-z0-9-]+)` \| (Player|Developer|Removed) \| (.+?) \| (.+?) \| (.+?) \|$/gm)];
  assert(rows.length >= Object.keys(entries).length, 'the inventory table is missing rows');
  const seen = new Map();
  for (const [, id, label, text, , windowText] of rows) {
    assert(entries[id], `docs list ${id}, which is not in the catalog`);
    assert.equal(label.toLowerCase(), entries[id].class, `${id}: docs say ${label}, the catalog says ${entries[id].class}`);
    assert(text.trim().length > 4, `${id}: a row has no text`);
    if (entries[id].repeatS !== null) assert.equal(windowText.trim(), String(entries[id].repeatS), `${id}: window differs from the catalog`);
    seen.set(id, true);
  }
  for (const id of Object.keys(entries)) assert(seen.has(id), `${id} is not documented in docs/NOTIFICATIONS.md`);
});

test('a player build shows Player notices only; Developer mode adds the routine ones; Removed never shows', () => {
  run(`
    local ids = {}
    for id, entry in pairs(notices.catalog) do ids[#ids + 1] = {id = id, class = entry.class} end
    table.sort(ids, function(a, b) return a.id < b.id end)
    local function reset() shown = {}; now = now + 100000 end
    for _, entry in ipairs(ids) do
      reset(); developer = false
      local sent = notices.send(player, entry.id, 'text of ' .. entry.id)
      assert(sent == (entry.class == 'player'), entry.id .. ' with Developer mode off: ' .. tostring(sent))
      assert((#shown == 1) == (entry.class == 'player'))
      reset(); developer = true
      sent = notices.send(player, entry.id, 'text of ' .. entry.id)
      assert(sent == (entry.class ~= 'removed'), entry.id .. ' with Developer mode on: ' .. tostring(sent))
    end
    reset(); developer = true
    assert(notices.send(player, 'not-in-the-catalog', 'x') == false, 'an unknown id was shown to a developer')
    developer = false
    assert(notices.send(player, 'not-in-the-catalog', 'x') == false, 'an unknown id was shown to a player')
    assert(notices.send(nil, 'service-down', 'x') == false)
    assert(notices.send(player, 'service-down', '') == false and notices.send(player, 'service-down', nil) == false)
    assert(notices.class('service-down') == 'player' and notices.class('nope') == nil)
  `);
});

test('without a configured Developer check the gate behaves as a player build', () => {
  run(`
    notices.configure(nil)
    assert(notices.send(player, 'party-dismissed', 'Judy dismissed.') == false)
    assert(notices.send(player, 'service-down', 'x') == true)
    notices.configure(function() error('settings not loaded') end)
    assert(notices.send(player, 'party-dismissed', 'Judy dismissed.') == false)
  `);
});

test('an identical notice is not repeated inside its window for a player, a developer sees every one', () => {
  run(`
    assert(notices.send(player, 'mic-error', 'Microphone unavailable.'))
    now = now + 5
    assert(not notices.send(player, 'mic-error', 'Microphone unavailable.'), 'repeated inside the window')
    assert(notices.send(player, 'mic-error', 'A different text.'), 'a different text was dropped')
    now = now + 15
    assert(notices.send(player, 'mic-error', 'Microphone unavailable.'), 'still dropped after the window')
    assert(not notices.send(player, 'mic-error', 'Microphone unavailable.'))
    developer = true
    assert(notices.send(player, 'mic-error', 'Microphone unavailable.'), 'a developer lost a repeat')
    developer = false
    -- A notice without a window is never dropped as a repeat (the board decides for itself).
    assert(notices.send(player, 'mic-listening', 'Listening') and notices.send(player, 'mic-listening', 'Listening'))
    -- The voice fallback is announced once per ten minutes.
    assert(notices.send(player, 'voice-fallback', 'A is unavailable. Companions are using B instead.'))
    now = now + 599
    assert(not notices.send(player, 'voice-fallback', 'A is unavailable. Companions are using B instead.'))
    now = now + 2
    assert(notices.send(player, 'voice-fallback', 'A is unavailable. Companions are using B instead.'))
    -- The memory of repeats is bounded.
    for index = 1, 400 do notices.send(player, 'talk-no-target', 'hint ' .. index) end
    assert(#shown > 300)
  `);
});

test('sendLines shows the permitted lines as one notice and nothing when none is permitted', () => {
  run(`
    local count = notices.sendLines(player, {
      {id = 'invite-board', text = 'Judy joined your group.'}, {id = 'party-dismissed', text = 'Panam dismissed.'},
      {id = 'party-failed', text = 'Johnny could not join: x'}, {id = 'phone-queued', text = 'Judy: invite queued.'}})
    assert(count == 2 and #shown == 1)
    assert(shown[1] == 'Judy joined your group.\\nJohnny could not join: x', shown[1])
    shown = {}
    assert(notices.sendLines(player, {{id = 'party-dismissed', text = 'x'}, {id = 'tactic-outcome', text = 'y'}}) == 0)
    assert(#shown == 0 and notices.sendLines(player, {}) == 0)
    developer = true
    assert(notices.sendLines(player, {{id = 'party-dismissed', text = 'Panam dismissed.'}, {id = 'invite-board', text = 'Judy joined your group.'}}) == 2)
    assert(shown[1] == 'Panam dismissed.\\nJudy joined your group.')
    -- The progress notices were removed from the catalog: an unknown id is never shown, even to a developer.
    assert(notices.send(player, 'invite-joining', 'Judy is joining your party.') == false)
    assert(notices.send(player, 'phone-invite-ack', 'Preparing Judy…') == false)
    -- A game error while posting is swallowed and not counted as shown.
    local broken = {ConvaiPhoneFeedback = function() error('native') end}
    assert(notices.sendLines(broken, {{id = 'service-down', text = 'x'}}) == 0)
  `);
});

test('permit applies the class and the repeat window without posting', () => {
  run(`
    assert(notices.permit('phone-queue-refused', 'This contact has no companion mapping yet.'))
    assert(not notices.permit('phone-queue-refused', 'This contact has no companion mapping yet.'))
    assert(not notices.permit('phone-queued', 'Judy: invite queued.'))
    developer = true
    assert(not notices.permit('phone-queued', 'Judy: invite queued.'))
    assert(notices.permit('phone-queue-refused', 'This contact has no companion mapping yet.'))
    assert(#shown == 0)
  `);
});

test('the notice board posts no progress, to a player or a developer, and only the joined line at the end', () => {
  const partySource = read('../mod/manager-party.lua');
  const localeSource = read('../mod/ui-locale.lua');
  const state = lauxlib.luaL_newstate(); lualib.luaL_openlibs(state);
  try {
    const program = `
      local ui = (function() ${localeSource} end)()
      local notices = (function() ${noticesSource} end)()
      local party = (function() ${partySource} end)()
      local developer = false
      local clock, states = 10000, {}
      local board = party.newBoard({now = function() return clock end, feedback = function(id) return states[id] end})
      states.a = {id = 'a', name = 'Judy', state = 'ready', revision = 1}
      board.track('a', 'manager')
      -- In gameplay a ready invitation is the joining step: no one sees a line for it, a developer included.
      assert(board.take(true) == nil, 'a player saw the joining step')
      developer = true
      clock = clock + 60000
      assert(board.take(true) == nil, 'a developer saw the joining step')
      states.a = nil
      board.event({message = 'Judy joined your group.', info = {kind = 'joined', name = 'Judy'}})
      local note = board.take(true)
      assert(note and note.message == 'Judy joined your group.', tostring(note and note.message))
    `;
    const status = lauxlib.luaL_dostring(state, to_luastring(program));
    assert.equal(status, lua.LUA_OK, status === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(state, -1)));
  } finally { lua.lua_close(state); }
});
