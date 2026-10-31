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
    for (const call of calls(source, 'convaiNotices.cue(')) found.push({call, expression: call.args[1], what: 'cue'});
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
  // A queue notice carries its id through to the final send (manager-ui.lua forwards notice.id).
  assert(/\{id = notice\.id, text = notice\.message\}/.test(code('manager-ui.lua')), 'manager-ui.lua no longer forwards the queue notice id');
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
    assert(notices.send(player, 'mic-heard', 'You: hello') and notices.send(player, 'mic-heard', 'You: hello'))
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


// The loading board: one notice that stays up from the first loading line until the outcome replaces it. The game's
// warning line is a mock (notices.screen): posts are what the HUD was given, clears what hid it, `screen` what is on it.
const boardSetup = `
  local clock = 100
  notices.clock = function() return clock end
  local state, reads = {}, 0
  local KEYS = {'omni', 'local-ai'}
  local function read() reads = reads + 1; return state end
  local function describe(key, value) return key .. ':' .. value end
  local posts, clears, screen, mode = {}, 0, {'', false}, 'native'
  notices.screen = {
    post = function(_, text, instant) posts[#posts + 1] = {text = text, instant = instant}; screen = {text, true}; return mode end,
    clear = function() clears = clears + 1; screen = {'', false} end,
    read = function() return screen[1], screen[2] end}
  player.ConvaiPhoneFeedback = function(_, text) shown[#shown + 1] = text; screen = {text, true} end
  -- One tick: what the caller does. Loading lines go out as the load-progress id, outcomes as ordinary notices, then release.
  local function tick(world, seconds)
    clock = clock + (seconds or 0.25)
    local lines, release = notices.loading(world ~= false, KEYS, read, describe)
    if lines then
      local out = {}
      for _, line in ipairs(lines) do
        local id = line.phase == 'loading' and 'load-progress' or line.phase == 'ready' and 'load-ready' or 'load-failed'
        out[#out + 1] = {id = id, text = line.text, instant = line.instant, mask = line.mask, sig = line.sig}
      end
      notices.sendLines(player, out)
    end
    if release then notices.release(player) end
    return lines
  end
  local function run(seconds, world)
    for _ = 1, seconds * 4 do tick(world) end
  end
`;

test('the loading notice appears after 1.5 s, is posted once and stays, and the ready line replaces it', () => {
  run(`${boardSetup}
    state.omni = 'loading'
    run(1); assert(#posts == 0 and #shown == 0, 'a quick load showed a notice')
    run(1)
    assert(#posts == 1 and posts[1].text == 'omni:loading' and not posts[1].instant, 'no loading notice after 2 s: ' .. #posts)
    run(60); assert(#posts == 1, 'the notice was posted again: ' .. #posts)
    assert(#shown == 0 and clears == 0, 'something else was shown or the notice was hidden')
    state.omni = 'ready'
    run(1)
    assert(#shown == 1 and shown[1] == 'omni:ready', 'ready line ' .. tostring(shown[1]))
    assert(#posts == 1 and clears == 0, 'the ready line replaces the notice; nothing hides it first')
    run(30); assert(#shown == 1 and #posts == 1 and clears == 0, 'something was shown after the ready line')
  `);
});

test('the held notice is refreshed instantly just before the game would hide it', () => {
  run(`${boardSetup}
    state.omni = 'loading'
    run(79); assert(#posts == 1, 'refreshed too early: ' .. #posts)
    run(4); assert(#posts == 2 and posts[2].instant == true and posts[2].text == 'omni:loading', 'no refresh: ' .. #posts)
    run(60); assert(#posts == 2, 'refreshed again within 80 s')
    run(30); assert(#posts == 3)
  `);
});

test('a load that finishes before its notice was shown says nothing, a failure always does, a cancelled load takes the notice down', () => {
  run(`${boardSetup}
    state.omni = 'loading'; run(1); state.omni = 'ready'; run(10)
    assert(#posts == 0 and #shown == 0, 'a one-second load was announced')
    state.omni = 'loading'; run(1); state['local-ai'] = nil; state.omni = 'error'; run(2)
    assert(#shown == 1 and shown[1] == 'omni:error', 'a failure within the delay was not announced: ' .. tostring(shown[1]))
    run(30); assert(#shown == 1, 'the failure repeated')
    shown = {}; posts = {}
    state.omni = 'loading'; run(5); assert(#posts == 1 and screen[2] == true)
    state.omni = nil; run(2)
    assert(clears == 1 and screen[2] == false, 'a cancelled load left its notice up')
    run(30); assert(#shown == 0 and #posts == 1 and clears == 1, 'a cancelled load announced an outcome')
    -- a state that was never loading is not an outcome either
    state['local-ai'] = 'failed'; run(5); assert(#shown == 0)
    -- a failure while the notice is up replaces it
    state.omni = 'loading'; run(5); state.omni = 'failed'; run(1)
    assert(shown[#shown] == 'omni:failed' and clears == 1)
  `);
});

test('several loads are one notice that lists them; it changes in place and an outcome shows first', () => {
  run(`${boardSetup}
    state.omni = 'loading'; run(3)
    assert(#posts == 1 and posts[1].text == 'omni:loading')
    state['local-ai'] = 'loading'; run(3)
    assert(#posts == 2 and posts[2].text == 'omni:loading\\nlocal-ai:loading' and posts[2].instant == true, 'the notice did not list both: ' .. posts[#posts].text)
    -- One finishes: its ready line shows (replacing the notice), the other keeps loading and the notice returns after it.
    state.omni = 'ready'; run(0.5)
    assert(#shown == 1 and shown[1] == 'omni:ready', tostring(shown[1]))
    run(4); assert(#posts == 2, 'the notice covered the ready line')
    run(2); assert(#posts == 3 and posts[3].text == 'local-ai:loading', 'the remaining load was not shown again: ' .. posts[#posts].text)
    state['local-ai'] = 'no-memory'; run(1)
    assert(shown[#shown] == 'local-ai:no-memory', shown[#shown])
    run(30); assert(#posts == 3 and clears == 0)
    -- Both start together: one notice from the start.
    shown, posts = {}, {}
    state.omni, state['local-ai'] = 'loading', 'loading'; run(3)
    assert(#posts == 1 and posts[1].text == 'omni:loading\\nlocal-ai:loading', posts[1] and posts[1].text)
    -- Both end together: one outcome notice with a line each.
    state.omni, state['local-ai'] = 'ready', 'no-memory'; run(1)
    assert(shown[#shown] == 'omni:ready\\nlocal-ai:no-memory', shown[#shown])
  `);
});

test('a line whose text changes while its load goes on is posted in place when the text changes, and only then', () => {
  run(`${boardSetup}
    -- describe reads the live text, as a companion's wait line does (mod/manager-ui.lua).
    local text = 'first'
    local function describeText(key, value) return key == 'omni' and text or key .. ':' .. value end
    local function textTick(seconds)
      clock = clock + (seconds or 0.25)
      state.revisions = {omni = text}
      local lines = notices.loading(true, KEYS, read, describeText)
      if lines then
        local out = {}
        for _, line in ipairs(lines) do out[#out + 1] = {id = 'load-progress', text = line.text, instant = line.instant, mask = line.mask, sig = line.sig} end
        notices.sendLines(player, out)
      end
    end
    state.omni = 'loading'
    for _ = 1, 12 do textTick() end
    assert(#posts == 1 and posts[1].text == 'first' and not posts[1].instant, 'no first post: ' .. #posts)
    for _ = 1, 40 do textTick() end
    assert(#posts == 1, 'an unchanged text was posted again: ' .. #posts)
    text = 'second'; textTick()
    assert(#posts == 2 and posts[2].text == 'second' and posts[2].instant == true, 'a changed text was not posted in place: ' .. #posts)
    for _ = 1, 40 do textTick() end
    assert(#posts == 2 and #shown == 0 and clears == 0, 'the changed text was posted again or something else was shown')
    -- A second load joins the same notice with its own state; the first line keeps its text.
    state['local-ai'] = 'loading'; for _ = 1, 8 do textTick() end
    assert(#posts == 3 and posts[3].text == 'second\\nlocal-ai:loading', posts[#posts].text)
    text = 'third'; textTick()
    assert(#posts == 4 and posts[4].text == 'third\\nlocal-ai:loading', posts[#posts].text)
  `);
});

test('a mod notice replaces the held one and the loading notice comes back after 3 s; never on a younger notice', () => {
  run(`${boardSetup}
    state.omni = 'loading'
    run(3)
    assert(#posts == 1)
    notices.send(player, 'service-down', 'Another notice')
    run(2.5); assert(#posts == 1, 'the loading notice covered a younger notice')
    run(1); assert(#posts == 2 and posts[2].text == 'omni:loading' and not posts[2].instant, 'it did not come back: ' .. #posts)
    run(30); assert(#posts == 2)
    -- A notice that arrives while the load ends is simply replaced by the outcome; nothing is hidden underneath.
    notices.send(player, 'service-down', 'Again')
    state.omni = 'ready'; run(1)
    assert(shown[#shown] == 'omni:ready' and clears == 0)
  `);
});

test('a menu: nothing is posted there, a notice held when it opens is posted again instantly, and an outcome waits for gameplay', () => {
  run(`${boardSetup}
    state.omni = 'loading'; run(3); assert(#posts == 1)
    run(10, false); assert(#posts == 1 and #shown == 0, 'a popup was posted while paused')
    tick(true); assert(#posts == 2 and posts[2].instant == true, 'the notice was not posted again after the menu: ' .. #posts)
    run(30); assert(#posts == 2)
    -- The load finishes in a menu: nothing is shown there, the first gameplay tick says it once.
    state.omni = 'ready'
    run(10, false); assert(#shown == 0 and #posts == 2)
    tick(true); assert(#shown == 1 and shown[1] == 'omni:ready')
    run(10); assert(#shown == 1 and #posts == 2 and clears == 0)
    -- Waiting longer than 90 s in a menu drops the outcome (it would be stale) and the notice is taken down.
    state.omni = 'loading'; run(5); local before = #shown
    state.omni = 'ready'; run(100, false); run(1)
    assert(#shown == before, 'a stale ready line was shown')
    assert(clears == 1, 'the stale notice stayed up: ' .. clears)
    -- A load cancelled in a menu takes its notice down on the first gameplay tick.
    state.omni = 'loading'; run(5); state.omni = nil; run(5, false); local was = clears
    tick(true); assert(clears == was + 1)
  `);
});

test('a game notice over ours is waited out, then ours comes back; an unreadable screen never causes a loop', () => {
  run(`${boardSetup}
    state.omni = 'loading'; run(3); assert(#posts == 1)
    screen = {'You looted something', true}      -- the game's own notice replaced ours
    run(10); assert(#posts == 1, 'our notice covered a game notice')
    screen = {'', false}                         -- it timed out
    run(1.5); assert(#posts == 2 and posts[2].text == 'omni:loading', 'ours did not come back: ' .. #posts)
    run(20); assert(#posts == 2)
    -- A screen that always reads as empty (the read cannot be trusted) is given up on after one post, no loop.
    posts = {}
    notices.resetLoading(); state.omni = nil; run(2); state.omni = 'loading'
    notices.screen.read = function() return '', false end
    run(60); assert(#posts <= 2, 'an untrustworthy read looped: ' .. #posts)
    -- Cancelling takes a notice down even when the screen cannot be read.
    notices.screen.read = function() error('no screen') end
    state.omni = nil; run(2); assert(clears >= 1)
  `);
});

test('release never hides a notice that is not ours', () => {
  run(`${boardSetup}
    state.omni = 'loading'; run(3)
    screen = {'You looted something', true}
    state.omni = nil; run(2)
    assert(clears == 0, 'a game notice was hidden')
    state.omni = 'loading'; run(3)
    notices.send(player, 'service-down', 'Another notice')
    state.omni = nil; run(2)
    assert(clears == 0, 'a newer mod notice was hidden')
  `);
});

test('when the game line cannot be written the notice falls back to the ordinary one, shown again every 3 s', () => {
  run(`${boardSetup}
    mode = 'fallback'
    state.omni = 'loading'
    run(2); assert(#posts == 1)
    run(2.5); assert(#posts == 1)
    run(1); assert(#posts == 2, 'not shown again after 3 s')
    run(20); assert(#posts >= 8 and #posts <= 9, 'every 3 s: ' .. #posts)
    state.omni = nil; run(2); assert(clears == 0, 'an ordinary notice was hidden')
  `);
  run(`
    -- no Game here: the default screen falls back to PlayerPuppet:ConvaiPhoneFeedback
    assert(notices.sendLines(player, {{id = 'load-progress', text = 'Loading', mask = 1}}) == 1)
    assert(#shown == 1 and shown[1] == 'Loading')
    notices.release(player)
    assert(#shown == 1)
  `);
});

test('the default screen writes the warning line with a long duration once, and hides it with isShown = false', () => {
  run(`
    local written = {}
    local board = {SetVariant = function(_, id, value, force) written[#written + 1] = {id = id, value = value, force = force} end,
      GetVariant = function() return written[#written] and written[#written].value end}
    Game = {GetAllBlackboardDefs = function() return {UI_Notifications = {WarningMessage = 'warning-id'}} end,
      GetBlackboardSystem = function() return {Get = function() return board end} end}
    SimpleScreenMessage = {new = function() return {} end}
    Enum = {new = function(name, value) return name .. '.' .. value end}
    ToVariant = function(value) return value end
    FromVariant = function(value) return value end
    assert(notices.sendLines(player, {{id = 'load-progress', text = 'Loading the OmniVoice voice…', instant = false, mask = 1}}) == 1)
    assert(#shown == 0 and #written == 1, 'the ordinary notice was used')
    local message = written[1].value
    assert(written[1].id == 'warning-id' and written[1].force == true)
    assert(message.isShown == true and message.message == 'Loading the OmniVoice voice…' and message.duration >= 60)
    assert(message.isInstant == false and message.type == 'SimpleMessageType.Neutral')
    notices.release(player)
    assert(#written == 2 and written[2].value.isShown == false and written[2].value.message == '', 'it was not hidden')
    -- A second release has nothing to hide.
    notices.release(player); assert(#written == 2)
  `);
});

test('with nothing loading the state is read once a second at most and no line is built', () => {
  run(`${boardSetup}
    local built = 0
    describe = function() built = built + 1; return 'x' end
    for _ = 1, 80 do tick() end
    assert(reads >= 19 and reads <= 21, 'read ' .. reads .. ' times in 20 s')
    assert(built == 0 and #shown == 0 and #posts == 0)
    state.omni = 'loading'
    local startReads = reads
    for _ = 1, 20 do tick() end
    assert(reads - startReads >= 19, 'while loading it is read on every call')
    notices.resetLoading(); state.omni = nil
    for _ = 1, 8 do tick() end
    assert(#shown == 0, 'a reset board announced an outcome')
  `);
});

test('while a notice is held the screen is read once a second and nothing is built or posted', () => {
  run(`${boardSetup}
    state.omni = 'loading'; run(3)
    local built, screenReads, inner = 0, 0, notices.screen.read
    describe = function(key, value) built = built + 1; return key .. ':' .. value end
    notices.screen.read = function() screenReads = screenReads + 1; return inner() end
    run(30)
    assert(built == 0 and #posts == 1, 'lines were built or posted: ' .. built)
    assert(screenReads >= 28 and screenReads <= 31, 'screen read ' .. screenReads .. ' times in 30 s')
  `);
});

test('the loading ids are Player notices without a repeat window, and a read that fails is treated as nothing loading', () => {
  assert.equal(entries['load-progress'].class, 'player');
  assert.equal(entries['load-ready'].class, 'player');
  assert.equal(entries['load-failed'].class, 'player');
  for (const id of ['load-progress', 'load-ready', 'load-failed']) assert.equal(entries[id].repeatS, null, `${id}: the board decides when to show it`);
  run(`${boardSetup}
    read = function() error('state unreadable') end
    for _ = 1, 40 do tick() end
    assert(#shown == 0 and #posts == 0)
  `);
});

// The daily limit has two lines to read and a choice to make: it stays longer than the game's own five seconds.
test('only the daily-limit, setup-problem and talk-draft notices stay longer: they are written to the warning line with their own duration, every other notice keeps the five-second call', () => {
  run(`
    local written = {}
    local board = {SetVariant = function(_, id, value, force) written[#written + 1] = {id = id, value = value, force = force} end}
    Game = {GetAllBlackboardDefs = function() return {UI_Notifications = {WarningMessage = 'warning-id'}} end,
      GetBlackboardSystem = function() return {Get = function() return board end} end}
    SimpleScreenMessage = {new = function() return {} end}
    Enum = {new = function(name, value) return name .. '.' .. value end}
    ToVariant = function(value) return value end
    assert(notices.send(player, 'daily-limit', 'Today limit.'))
    assert(#shown == 0 and #written == 1, 'the five-second call was used')
    local message = written[1].value
    assert(written[1].id == 'warning-id' and written[1].force == true)
    assert(message.isShown == true and message.message == 'Today limit.' and message.isInstant == false)
    assert(message.duration == notices.showS['daily-limit'] and message.duration >= 8 and message.duration <= 12, 'duration ' .. tostring(message.duration))
    assert(message.type == 'SimpleMessageType.Neutral')
    -- every other id: the ordinary five-second notice, nothing written to the line
    written = {}
    assert(notices.send(player, 'service-down', 'The service is down.'))
    assert(#shown == 1 and shown[1] == 'The service is down.' and #written == 0)
    local ids = 0
    for id, seconds in pairs(notices.showS) do ids = ids + 1; assert(((id == 'daily-limit' or id == 'setup-problem') and seconds == 9) or (id == 'talk-draft' and seconds == 20)) end
    assert(ids == 3, 'another notice got a longer duration')
    -- a joined notice that holds a long line is shown with it; the line is still subject to the class and repeat window
    now = now + 100000
    shown, written = {}, {}
    assert(notices.sendLines(player, {{id = 'service-down', text = 'A.'}, {id = 'daily-limit', text = 'B.'}}) == 2)
    assert(#written == 1 and written[1].value.message == 'A.\\nB.' and written[1].value.duration == 9)
    assert(not notices.send(player, 'daily-limit', 'B.'), 'repeated inside its window')
  `);
});

test('when the warning line cannot be written the daily-limit notice falls back to the ordinary five-second notice', () => {
  run(`
    -- no Game here: the write fails
    assert(notices.send(player, 'daily-limit', 'Today limit.'))
    assert(#shown == 1 and shown[1] == 'Today limit.')
    -- a screen without the timed call (older state, tests) behaves the same
    now = now + 100000
    shown = {}
    notices.screen = {post = function() return 'native' end, clear = function() end}
    assert(notices.send(player, 'daily-limit', 'Today limit.') and #shown == 1)
    now = now + 100000
    notices.screen.timed = function() error('boom') end
    assert(notices.send(player, 'daily-limit', 'Today limit.') and #shown == 2)
  `);
});

test('the loading notice does not cover a long notice before it has run its time, and covers it again afterwards', () => {
  run(`${boardSetup}
    local timed = {}
    notices.screen.timed = function(_, text, seconds) timed[#timed + 1] = {text = text, seconds = seconds}; screen = {text, true}; return true end
    state.omni = 'loading'; run(2)
    assert(#posts == 1 and posts[1].text == 'omni:loading')
    assert(notices.send(player, 'daily-limit', 'Today limit.') and #timed == 1 and timed[1].seconds == 9)
    -- the ordinary rule would cover it after 3 s; it is on screen for its 9 s, the intro and the outro
    run(8); assert(#posts == 1, 'the loading notice covered the long notice: ' .. #posts)
    run(6); assert(#posts == 2 and posts[2].text == 'omni:loading', 'the loading notice did not come back: ' .. #posts)
    -- an ordinary notice keeps the short wait
    local before = #posts
    assert(notices.send(player, 'service-down', 'The service is down.'))
    run(4); assert(#posts == before + 1, 'the ordinary rule changed: ' .. #posts)
  `);
});

test('the default screen writes a timed notice once with the duration asked for', () => {
  run(`
    local written = {}
    local board = {SetVariant = function(_, id, value) written[#written + 1] = value end}
    Game = {GetAllBlackboardDefs = function() return {UI_Notifications = {WarningMessage = 'warning-id'}} end,
      GetBlackboardSystem = function() return {Get = function() return board end} end}
    SimpleScreenMessage = {new = function() return {} end}
    ToVariant = function(value) return value end
    assert(notices.screen.timed(player, 'x', 9) == true)
    assert(#written == 1 and written[1].duration == 9 and written[1].isShown == true)
    -- the held loading notice still gets its long safety net, and hiding writes duration 0
    assert(notices.screen.post(player, 'y', false) == 'native' and written[2].duration >= 60)
    assert(notices.screen.clear() == true and written[3].duration == 0 and written[3].isShown == false)
  `);
});

test('the talk key cue is one instant held notice changed in place, taken down by cueEnd, and never over a notice that replaced it', () => run(`
  local posts, clears = {}, 0
  notices.screen.post = function(_, text, instant) posts[#posts + 1] = {text, instant}; return 'native' end
  notices.screen.clear = function() clears = clears + 1; return true end
  assert(notices.cue(player, 'mic-cue', 'Opening microphone…') and posts[1][1] == 'Opening microphone…' and posts[1][2] == true, 'instant: no intro')
  assert(notices.cueActive())
  assert(notices.cue(player, 'mic-cue', 'Speak now') and #posts == 2 and posts[2][2] == true, 'the next text goes to the same line in place')
  assert(notices.cueEnd(player) and clears == 1 and not notices.cueActive())
  assert(not notices.cueEnd(player) and clears == 1, 'ending twice clears nothing more')
  notices.cue(player, 'mic-cue', 'Opening microphone…'); notices.lastSentAt = notices.lastSentAt + 5
  assert(not notices.cueEnd(player) and clears == 1, 'another notice replaced it: it stays')
  notices.mute(true); assert(true)
  assert(not notices.cue(nil, 'mic-cue', 'x'), 'no player, no cue')
`));
