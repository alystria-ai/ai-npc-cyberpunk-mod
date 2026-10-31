import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, readdirSync} from 'node:fs';

// What this mod's redscript may do to OTHER mods and to a save (docs/MOD_COMPATIBILITY.md). A compile error anywhere disables every
// redscript mod, so everything the scripts add to a shared game class must carry this mod's prefix, the scripts only ever WRAP game
// methods (never replace one), every wrapper runs the original, and nothing in them or in the Lua writes quest, journal or phone state.
// The offline compile of both builds (scripts/Compile-Redscript.ps1 -GameVersion 2.5 / 2.31) is the other half of this check.

const root = new URL('../', import.meta.url);
const redsFolder = new URL('r6/scripts/CyberpunkConvai/', root);
const read = (url, name) => readFileSync(new URL(name, url), 'utf8').replace(/\r\n/g, '\n');
const config = JSON.parse(read(root, 'packaging/release.config.json'));
// KnowledgeState.reds is retired and not shipped (packaging/release.config.json retiredRedscript).
const shipped = readdirSync(redsFolder).filter(name => name.endsWith('.reds') && !config.retiredRedscript.includes(name)).sort();
const variant = read(root, 'packaging/game-variants/2.5/r6/scripts/CyberpunkConvai/GameVariant.reds');

// Comments are dropped before anything is looked for in the code.
const stripComments = text => text.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
const code = Object.fromEntries(shipped.map(name => [name, stripComments(read(redsFolder, name))]));
const OURS = /^(m_)?[Cc]onvai|^OnConvai/;

// Every annotated declaration: {file, kind, target, name, body}. The name is the first identifier after `func`/`let`, and the body (for a
// method) is the text between its braces.
function annotated() {
  const out = [];
  for (const [file, text] of Object.entries(code)) {
    const pattern = /^@(addField|addMethod|wrapMethod|replaceMethod|replaceGlobal|wrapGlobal)\((\w*)\)\s*\n(?:@if\([^\n]*\)\s*\n)?([^\n]*)/gm;
    let match;
    while ((match = pattern.exec(text))) {
      const [, kind, target, line] = match;
      const named = /\b(?:func|let)\s+(\w+)/.exec(line);
      let body = '';
      if (kind !== 'addField') {
        const open = text.indexOf('{', match.index + match[0].length - line.length);
        let depth = 0, end = open;
        for (; end < text.length; end++) {
          if (text[end] === '{') depth++;
          else if (text[end] === '}' && --depth === 0) break;
        }
        body = text.slice(open, end + 1);
      }
      out.push({file, kind, target, name: named ? named[1] : '?', line, body});
    }
  }
  return out;
}

const declarations = annotated();

test('the scripts only add to and wrap game classes: nothing is replaced', () => {
  assert(declarations.length > 300, `only ${declarations.length} annotated declarations were read`);
  for (const item of declarations) {
    assert(['addField', 'addMethod', 'wrapMethod'].includes(item.kind), `${item.file}: @${item.kind}(${item.target}) ${item.name} replaces game code`);
  }
});

test('every field and method added to a game class carries this mod’s prefix, so no other mod can collide with it', () => {
  for (const item of declarations.filter(entry => entry.kind === 'addField' || entry.kind === 'addMethod')) {
    assert(OURS.test(item.name), `${item.file}: @${item.kind}(${item.target}) ${item.name} has no Convai prefix`);
  }
});

test('every class, struct, enum and global function the scripts declare is named Convai…', () => {
  let seen = 0;
  for (const [file, text] of Object.entries(code)) {
    for (const match of text.matchAll(/^(?:public |private |abstract |final |native )*(class|struct|enum)\s+(\w+)/gm)) {
      seen++;
      assert(/^Convai/.test(match[2]), `${file}: ${match[1]} ${match[2]} has no Convai prefix`);
    }
    // A function outside a class is at column zero and not annotated (an annotated one is a method added to a game class).
    const unguarded = text.replace(/^@if\([^\n]*\n/gm, '');
    for (const match of unguarded.matchAll(/^(?<!@[^\n]*\n)(?:public |private )?(?:static )?func\s+(\w+)/gm)) {
      seen++;
      assert(/^Convai/.test(match[1]), `${file}: global function ${match[1]} has no Convai prefix`);
    }
  }
  assert(seen > 20, `only ${seen} declarations were read`);
});

// The one wrapper that never runs the original: the Tab key of the phone cycles Unread, Contacts and Chat (ConvaiSelectPhoneTab), which
// takes over the vanilla two-way switch for good. A mod that wraps SelectOtherTab beneath ours is bypassed (docs/MOD_COMPATIBILITY.md).
const REPLACES_ORIGINAL = new Set(['NewHudPhoneGameController.SelectOtherTab']);

test('every wrapper runs the original method, except the one documented switch', () => {
  const wraps = declarations.filter(item => item.kind === 'wrapMethod');
  assert(wraps.length >= 45, `only ${wraps.length} wrappers were read`);
  for (const item of wraps) {
    const name = `${item.target}.${item.name}`;
    if (REPLACES_ORIGINAL.has(name)) {
      assert(!/\bwrappedMethod\(/.test(item.body), `${name} now calls the original: drop it from REPLACES_ORIGINAL and the note in docs/MOD_COMPATIBILITY.md`);
      continue;
    }
    assert(/\bwrappedMethod\(/.test(item.body), `${item.file}: the wrapper of ${name} never calls wrappedMethod`);
  }
});

// Wrappers of game methods that other mods wrap too, with the game's own return type. Another mod's wrapper returns what its
// wrappedMethod gives; when ours sits beneath it and declares another type the OTHER mod fails to compile ("can't coerce 'Void' into
// 'DelayID'", Much Better Contracts and Night City Allies companions with PlayVoiceOver, 28 Oct), and with it every redscript mod.
const GAME_RETURN_TYPES = {'GameObject.PlayVoiceOver': 'DelayID'};

test('wrappers of methods other mods also wrap declare the game’s own return type and return what the original gives', () => {
  for (const [name, type] of Object.entries(GAME_RETURN_TYPES)) {
    const wraps = declarations.filter(item => item.kind === 'wrapMethod' && `${item.target}.${item.name}` === name);
    assert(wraps.length > 0, `${name} is not wrapped any more: drop it from GAME_RETURN_TYPES`);
    for (const item of wraps) {
      assert(new RegExp(`->\\s*${type}\\s*\\{?\\s*$`).test(item.line), `${item.file}: the wrapper of ${name} must declare -> ${type}, the game's type`);
      assert(/\breturn\s+wrappedMethod\(/.test(item.body), `${item.file}: the wrapper of ${name} must return what wrappedMethod gives`);
    }
  }
});

test('the wrapped methods are exactly the list in docs/MOD_COMPATIBILITY.md', () => {
  const doc = read(root, 'docs/MOD_COMPATIBILITY.md');
  const block = /<!-- wrapped-methods:start -->\n```\n([\s\S]*?)```\n<!-- wrapped-methods:end -->/.exec(doc);
  assert(block, 'docs/MOD_COMPATIBILITY.md has no wrapped-methods block');
  const listed = block[1].split('\n').map(line => line.trim()).filter(Boolean).sort();
  const wrapped = [...new Set(declarations.filter(item => item.kind === 'wrapMethod').map(item => `${item.target}.${item.name}`))].sort();
  assert.deepEqual(wrapped, listed, 'a wrapper was added or removed: update the list in docs/MOD_COMPATIBILITY.md');
});

test('the scripts hold nothing that is saved and write no quest, journal or phone state', () => {
  for (const [file, text] of Object.entries(code)) {
    assert(!/\bpersistent\b/.test(text), `${file}: a persistent field would be written into every save`);
    for (const word of ['SetFact', 'AddFact', 'SetFactStr', 'ChangeEntryState', 'SetEntryVisited', 'MarkEntryAsRead',
      'TriggerCall', 'questTriggerCallRequest', 'SendMessage', 'AddItem', 'GiveItem', 'AddMoney', 'ChangeMoney']) {
      assert(!text.includes(word), `${file}: ${word} changes game state that a save keeps`);
    }
    // TrackEntry is never called. UntrackEntry has exactly one call site (owner decision 31 Oct 2026), checked in the next test.
    assert(!/\bTrackEntry\b/.test(text), `${file}: TrackEntry changes the game's tracked quest`);
    if (file !== 'QuestLog.reds') assert(!/\bUntrackEntry\b/.test(text), `${file}: UntrackEntry changes the game's tracked quest`);
  }
  // The one file with persistent fields is retired and must stay out of the Scripts package.
  const retired = readdirSync(redsFolder).filter(name => name.endsWith('.reds') && /\bpersistent\b/.test(stripComments(read(redsFolder, name))));
  for (const name of retired) assert(config.retiredRedscript.includes(name), `${name} has persistent fields and ships`);
});

test('the one UntrackEntry: only when a pack starts and takes the tracker from a game side job, never a main job, never restored', () => {
  const text = code['QuestLog.reds'];
  assert.equal([...text.matchAll(/\bUntrackEntry\b/g)].length, 1, 'UntrackEntry must have exactly one call site');
  assert.equal([...text.matchAll(/\.UntrackEntry\(\)/g)].length, 1, 'the call is journal.UntrackEntry()');
  // The call sits inside TakeTracker, the function every tracker change goes through.
  const start = text.indexOf('private final func TakeTracker(');
  assert(start > 0, 'TakeTracker is gone');
  let depth = 0, end = text.indexOf('{', start);
  for (let i = end; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}' && --depth === 0) { end = i; break; }
  }
  const body = text.slice(start, end + 1);
  assert(body.includes('.UntrackEntry()'), 'the untrack is not in TakeTracker');
  // Order: the main job returns before the untrack, and the untrack needs byItself (a pack that just started) and a quest that is known.
  const mainJob = body.indexOf('gameJournalQuestType.MainQuest');
  const untrack = body.indexOf('.UntrackEntry()');
  assert(mainJob > 0 && mainJob < untrack, 'the main job test must come before the untrack');
  assert(/MainQuest\) \{ return; \}/.test(body), 'a main job must leave TakeTracker before anything is written');
  const guard = body.slice(body.lastIndexOf('if', untrack), untrack);
  assert(/byItself\s*&&\s*IsDefined\(quest\)/.test(guard), 'the untrack must be guarded by byItself and a known quest');
  // The only calls into TakeTracker: byItself = true for a pack that just started (track 2), false for a session start and for V's pick.
  const calls = [...text.matchAll(/this\.TakeTracker\(id, (true|false)\)/g)].map(match => match[1]);
  assert.deepEqual(calls, ['true', 'false', 'false'], 'TakeTracker gained a caller: check it cannot untrack');
  assert(/if track == 2 \{ this\.TakeTracker\(id, true\); \}/.test(text));
  // Nothing is restored: no TrackEntry, and no code that re-tracks the game's quest after the pack ends.
  assert(!/\bTrackEntry\b/.test(text));
  // No per-frame work: the untrack is not reached from an update or a tick.
  assert(!/\b(OnUpdate|OnTick|Tick)\b[^\n]*UntrackEntry/.test(text));
});

test('the Lua sends track 2 (the only value that can untrack) only for a pack that starts in play, never at a session start', () => {
  const lua = stripLua(read(new URL('mod/', root), 'quest-journal.lua'));
  assert.equal([...lua.matchAll(/track = 2/g)].length, 1);
  assert(/if opts\.startup then[\s\S]*?track = 1[\s\S]*?else track = 2 end/.test(lua), 'track 2 must be the not-startup branch');
  assert(!/\bUntrackEntry\b|\bTrackEntry\b/.test(lua));
});

test('the Lua writes quest facts only from the housemate registry (a fact of its own), the developer tools and the retired save identity', () => {
  const luaFolder = new URL('mod/', root);
  const writers = readdirSync(luaFolder).filter(name => name.endsWith('.lua') && name !== 'diagnostics.lua')
    .filter(name => /SetFact(Str)?\(/.test(stripLua(read(luaFolder, name)))).sort();
  assert.deepEqual(writers, ['fact-identity.lua', 'housemate-registry.lua', 'housemate-survey.lua'],
    'a new file writes quest facts: add it to docs/MOD_COMPATIBILITY.md, "What is written into a save", and here');
  // fact-identity.lua is development-only and never packaged.
  assert(config.devOnlyLua.includes('fact-identity.lua'));
  // The housemate registry's fact names are all under this mod's prefix.
  assert.match(read(luaFolder, 'housemate-registry.lua'), /M\.PREFIX = 'cyberpunkconvai_hm_'/);
  assert.match(read(luaFolder, 'fact-identity.lua'), /local PREFIX, [^\n]*= 'cyberpunkconvai_mem_v1_'/);
  // Entities the mod spawns are never kept by the save.
  for (const name of readdirSync(luaFolder).filter(file => file.endsWith('.lua') && file !== 'diagnostics.lua')) {
    const text = stripLua(read(luaFolder, name));
    assert(!/persist(State|Spawn)\s*=\s*true/.test(text), `${name}: a spawned entity would be saved`);
  }
});
function stripLua(text) { return text.replace(/--\[\[[\s\S]*?\]\]/g, '').replace(/--[^\n]*/g, ''); }

test('both game builds declare the same helpers, so one build can never lack a function the other defines', () => {
  const names = text => [...stripComments(text).matchAll(/func\s+(\w+)\(/g)].map(match => match[1]).sort();
  assert.deepEqual(names(variant), names(read(redsFolder, 'GameVariant.reds')));
});

test('the module line of each file is this mod’s own module, or absent where the file declares only Convai… names', () => {
  for (const name of shipped) {
    const module = /^module\s+([\w.]+)/m.exec(code[name]);
    if (module) assert.equal(module[1], 'CyberpunkConvai', `${name}: module ${module[1]}`);
  }
});
