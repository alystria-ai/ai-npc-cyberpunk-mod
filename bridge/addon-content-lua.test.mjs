import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {WORLD, runLua} from './addon-lua-harness.mjs';

// The game side of the content packs (add-on API 1.1, mod/addons.lua "Content packs"): a pack never registers, so everything here runs with `live` false.
const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const STATUS = String.raw`
local function status(addons) files['runtime/addons-status.json'] = json.encode({version = 1, api = '1.1', addons = addons}) end
local medieval = {id = 'medieval', name = 'Medieval AI NPCs', version = '1.0.0', status = 'ready', content = {worldRules = 3, prompting = {'*'}}}
`;

test('a content pack is listed with an On/Off row, switched in the settings save, and written to the settings file the bridge reads', () => {
  runLua(`${WORLD}${STATUS}
    M.attach(host)
    assert(M.live == false and M.hasContent() == false and M.settingsActive() == false)
    assert(#M.contentPacks() == 0 and M.contentSignature() == '')
    status({medieval, {id = 'skippy', name = 'Skippy', version = '1.0.0', status = 'ready', speakers = {}}})
    now = now + 5                                    -- the status file is read again after a few seconds, never every call
    local packs = M.contentPacks()
    assert(#packs == 1 and packs[1].id == 'medieval' and packs[1].name == 'Medieval AI NPCs' and packs[1].enabled == true, 'on by default')
    assert(M.hasContent() and M.settingsActive() and M.live == false)
    assert(M.contentSignature() == 'medieval=true')
    -- Staged, then saved only by the commit; the bridge reads {medieval = {contentEnabled = false}}.
    assert(M.stageSetting('addon:medieval:contentEnabled', 'yes') == false, 'a switch is a boolean')
    assert(M.stageSetting('addon:nobody:contentEnabled', false) == false, 'only a listed pack')
    assert(M.stageSetting('addon:medieval:contentEnabled', false))
    assert(M.contentPacks()[1].enabled == true, 'not before the save')
    assert(M.commitSettings())
    local saved = json.decode(files['runtime/addon-settings.json'])
    assert(saved.version == 1 and saved.addons.medieval.contentEnabled == false)
    assert(M.contentPacks()[1].enabled == false and M.contentSignature() == 'medieval=false')
    assert(M.stageSetting('addon:medieval:contentEnabled', true) and M.commitSettings())
    assert(json.decode(files['runtime/addon-settings.json']).addons.medieval.contentEnabled == true)
    assert(M.contentSignature() == 'medieval=true')
    -- Nothing was queued for a tick that does not run, and no add-on was made live by the pack.
    assert(M.live == false)
  `);
});

test('the saved switch of a pack survives a restart, and other add-ons settings in the file are kept', () => {
  runLua(`${WORLD}${STATUS}
    M.attach(host)
    files['runtime/addon-settings.json'] = json.encode({version = 1, addons = {medieval = {contentEnabled = false}, skippy = {remarkGap = 3}}})
    status({medieval})
    local packs = M.contentPacks()
    assert(packs[1].enabled == false, 'the saved choice is read')
    assert(M.stageSetting('addon:medieval:contentEnabled', true) and M.commitSettings())
    local saved = json.decode(files['runtime/addon-settings.json'])
    assert(saved.addons.medieval.contentEnabled == true and saved.addons.skippy.remarkGap == 3, 'the other add-on keeps its values')
  `);
});

test('without a pack nothing is shown or written; the status file is read at most every few seconds', () => {
  runLua(`${WORLD}
    M.attach(host)
    assert(#M.contentPacks() == 0 and M.contentSignature() == '' and M.hasContent() == false)
    local reads = #opened
    for _ = 1, 20 do M.contentPacks() end
    assert(#opened == reads, 'the status file is not read again within the interval')
    assert(M.stageSetting('addon:medieval:contentEnabled', false) == false)
    assert(M.commitSettings() == true and files['runtime/addon-settings.json'] == nil, 'no change: no file written')
  `);
});

test('the first gameplay tick tells the player about a pack that could not load, once, and only when no add-on registered', () => {
  runLua(`${WORLD}${STATUS}
    M.attach(host)
    status({medieval, {id = 'broken', name = 'Broken Pack', version = '1.0.0', status = 'invalid', folder = 'AiNpcCyberpunkModBroken',
        reason = 'content.worldRules[0] must be a text'},
      {id = 'future', name = 'Future Pack', status = 'incompatible', folder = 'AiNpcCyberpunkModFuture', reason = 'needs add-on API 1.2; this AI NPC Cyberpunk Mod has 1.1'}})
    assert(M.noticePending == true)
    M.idleTick(player, false)                         -- no world yet: nothing happens, nothing is read
    assert(#notices == 0 and M.noticePending == true)
    M.idleTick(player, true)
    assert(M.noticePending == false)
    assert(#notices == 2, #notices)
    assert(notices[1] == 'Broken Pack could not load: content.worldRules[0] must be a text', notices[1])
    assert(notices[2] == 'Future Pack needs a newer AI NPC Cyberpunk Mod (needs add-on API 1.2; this AI NPC Cyberpunk Mod has 1.1). Update AI NPC Cyberpunk Mod.', notices[2])
    M.idleTick(player, true)
    assert(#notices == 2, 'once')
    assert(M.hasContent() and M.contentPacks()[1].id == 'medieval')
  `);
});

test('an empty status file (no add-ons) makes the first tick a single read and no notice', () => {
  runLua(`${WORLD}
    M.attach(host)
    files['runtime/addons-status.json'] = ''
    M.idleTick(player, true)
    assert(#notices == 0 and M.noticePending == false and M.live == false)
    for _, entry in ipairs(opened) do assert(entry == 'rb runtime/addons-status.json', 'only the status file is read: ' .. entry) end
  `);
});

test('init.lua only calls the one-time check while no add-on is live, and the settings page lists the packs through guarded calls', () => {
  const init = read('../mod/init.lua').split('\n').filter(line => !/^\s*--/.test(line)).join('\n');
  assert.match(init, /\n\s*elseif convaiAddons and convaiAddons\.noticePending then\s+(?:--[^\n]*\n\s*)*pcall\(convaiAddons\.idleTick, player, worldReady\)/);
  const page = read('../mod/manager-ui.lua');
  assert.match(page, /if convaiAddons and convaiAddons\.contentPacks then/);
  assert.match(page, /category\('addon-content', 'Content packs'/);
  assert.match(page, /convaiAddons\.contentSignature then add\('content:'/);
  assert.match(page, /'addon:' \.\. pack\.id \.\. ':contentEnabled'/);
});
