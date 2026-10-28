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
      out.push({file, kind, target, name: named ? named[1] : '?', body});
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
    for (const word of ['SetFact', 'AddFact', 'SetFactStr', 'ChangeEntryState', 'TrackEntry', 'SetEntryVisited', 'MarkEntryAsRead',
      'TriggerCall', 'questTriggerCallRequest', 'SendMessage', 'AddItem', 'GiveItem', 'AddMoney', 'ChangeMoney']) {
      assert(!text.includes(word), `${file}: ${word} changes game state that a save keeps`);
    }
  }
  // The one file with persistent fields is retired and must stay out of the Scripts package.
  const retired = readdirSync(redsFolder).filter(name => name.endsWith('.reds') && /\bpersistent\b/.test(stripComments(read(redsFolder, name))));
  for (const name of retired) assert(config.retiredRedscript.includes(name), `${name} has persistent fields and ships`);
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
