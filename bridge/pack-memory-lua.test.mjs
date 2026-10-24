import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {WORLD, runLua} from './addon-lua-harness.mjs';

// The game side of a content pack's separate memory (mod/addons.lua contentMemory, mod/manager-ui.lua memorySettings): the bridge writes `memory = "separate"` in the pack's
// status entry, the game says which memory Forget acts on. Shared packs and no packs say nothing.
const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const STATUS = String.raw`
local function status(addons) files['runtime/addons-status.json'] = json.encode({version = 1, api = '1.1', addons = addons}) end
local medieval = {id = 'medieval', name = 'Medieval AI NPCs', version = '1.0.0', status = 'ready', content = {worldRules = 3, prompting = {'*'}, memory = 'separate'}}
local plain = {id = 'plain', name = 'Plain Pack', version = '1.0.0', status = 'ready', content = {worldRules = 1, prompting = {}}}
`;

test('contentMemory: nothing without a separate-memory pack; the pack\'s name while it is on; installed but no name while it is off', () => {
  runLua(`${WORLD}${STATUS}
    M.attach(host)
    local installed, name = M.contentMemory()
    assert(installed == false and name == nil, 'no pack')
    status({plain})
    now = now + 5
    installed, name = M.contentMemory()
    assert(installed == false and name == nil, 'a pack that shares its memory')
    assert(M.contentPacks()[1].memory == nil)
    status({plain, medieval})
    now = now + 5
    installed, name = M.contentMemory()
    assert(installed == true and name == 'Medieval AI NPCs', tostring(name))
    assert(M.contentPacks()[2].memory == 'separate' and M.contentPacks()[1].memory == nil)
    -- Switched off in the settings: the normal memory is in use.
    assert(M.stageSetting('addon:medieval:contentEnabled', false) and M.commitSettings())
    installed, name = M.contentMemory()
    assert(installed == true and name == nil, 'off: installed, no pack in use')
    assert(M.stageSetting('addon:medieval:contentEnabled', true) and M.commitSettings())
    installed, name = M.contentMemory()
    assert(installed == true and name == 'Medieval AI NPCs')
    -- Only a literal "separate" counts.
    status({{id = 'odd', name = 'Odd', version = '1.0.0', status = 'ready', content = {worldRules = 1, prompting = {}, memory = 'yes'}}})
    now = now + 5
    installed = M.contentMemory()
    assert(installed == false)
  `);
});

test('contentMemory reads the status file at most every few seconds, like contentPacks, and nothing else', () => {
  runLua(`${WORLD}${STATUS}
    M.attach(host)
    status({medieval})
    now = now + 5
    M.contentMemory()
    local reads = #opened
    for _ = 1, 20 do M.contentMemory() end
    assert(#opened == reads, 'no further read inside the interval')
  `);
});

test('the memory page asks for the memory in use through guarded calls and names it in every Forget row', () => {
  const page = read('../mod/manager-ui.lua');
  assert.match(page, /if not \(convaiAddons and convaiAddons\.contentMemory\) then return false, nil end\s+local ok, installed, name = pcall\(convaiAddons\.contentMemory\)/);
  assert.match(page, /readonly\('memory-in-use', 'Memory in use', inUse,/);
  assert.match(page, /ui\.t\('This clears the memory in use: \{memory\}\.', \{memory = inUse\}\)/);
  assert.match(page, /add\('memory-in-use:' \.\. tostring\(packName\)\)/, 'the page is drawn again when the pack is switched');
  // Without such a pack nothing is added: the descriptions are the ones the page always had.
  assert.equal((page.match(/if note then rows\[#rows\]\.description = rows\[#rows\]\.description \.\. '\\n\\n' \.\. note end/g) ?? []).length, 2, 'both Forget rows, and only with a note');
});
