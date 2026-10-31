// 1 Nov 2026 (owner, live test on game 2.5): Restore defaults pressed on Dynamic info also switched off Character bonds and Story packs on the Companions page,
// because it put every settings page back. Each settings page now restores only its own rows, in every host (the overlay Companion Manager, MCM, Native
// Settings UI) through the one function they share, `core.defaults(page)` of mod/manager-ui.lua. These tests pin that for every page, and that every row (every
// stored key it writes) belongs to exactly one page.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {run, nsuiFixture} from './manager-fixture.mjs';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');

// Every page Restore defaults covers (hasDefaults), with the stored keys one of its rows writes, so a test can read what a batch changed.
const pageList = `
  local PAGES = {'settings-provider', 'settings-voice', 'settings-conversations', 'settings-companions', 'settings-night-city', 'settings-interface', 'settings-privacy',
    'dynamic-info', 'key-bindings', 'immersive-invitations', 'housemates', 'relationships'}
`;

test('every row Restore defaults covers belongs to exactly one page, and the pages together cover the rows of every Settings page', () => {
  run(`${nsuiFixture}
    ${pageList}
    local owner, count = {}, 0
    for _, page in ipairs(PAGES) do
      for _, id in ipairs(core.pageRows(page)) do
        assert(owner[id] == nil, id .. ' is on two pages: ' .. tostring(owner[id]) .. ' and ' .. page)
        owner[id], count = page, count + 1
      end
    end
    assert(count > 60, 'the pages hold their rows: ' .. count)
    -- The rows the old tests and the owner name sit on the pages they are on in the Settings reorganisation.
    local expected = {conversationProvider = 'settings-provider', matureContent = 'settings-provider', voiceProvider = 'settings-voice', vVoice = 'settings-voice',
      vVoiceEngine = 'settings-voice', voiceVolume = 'settings-voice', johnnyInHead = 'settings-conversations', companionSpeakUp = 'settings-conversations',
      characterBonds = 'settings-companions', storyPacks = 'settings-companions', companionOutfits = 'settings-companions', companionReactions = 'settings-companions',
      reputation = 'settings-night-city', npcThreats = 'settings-night-city', subtitleStyle = 'settings-interface', uiLanguage = 'settings-interface',
      ['dynamic:location'] = 'dynamic-info', ['dynamicPhone:location'] = 'dynamic-info'}
    for id, page in pairs(expected) do assert(owner[id] == page, id .. ' should be on ' .. page .. ', is on ' .. tostring(owner[id])) end
    -- The Settings list, Home and the pages without settings have no rows of their own.
    for _, page in ipairs({'settings', 'home', 'characters', 'side', 'party', 'models', 'bonds', 'memory', 'help', 'paid-tier', 'custom-endpoint'}) do
      assert(#core.pageRows(page) == 0 and not core.hasDefaults(page) and #core.defaults(page) == 0, page)
    end
    -- Both sets of Dynamic info are the one page: twelve in person, twelve for the phone.
    local dynamic = 0
    for id, page in pairs(owner) do if id:match('^dynamic') then dynamic = dynamic + 1; assert(page == 'dynamic-info', id) end end
    assert(dynamic == 24, dynamic)
  `);
});

test('Restore defaults on each page names rows of that page only, even when every page holds a changed row, and applying it touches no other page', () => {
  run(`${nsuiFixture}
    ${pageList}
    -- A changed row on many pages, the owner's two among them (Character bonds and Story packs are off by default; the dev flag shows Story packs).
    assert(registered.applyBatch('manager', {{id = 'characterBonds', value = true}, {id = 'storyPacks', value = true}, {id = 'companionOutfits', value = true},
      {id = 'reputation', value = false}, {id = 'subtitleStyle', value = 3}, {id = 'vVoice', value = 3}, {id = 'johnnyInHead', value = 5},
      {id = 'dynamic:location', value = false}, {id = 'dynamicPhone:time', value = false}}).ok)
    assert(saved.characterBonds == true and saved.storyPacks == true and saved.reputation == false and saved.dynamicInfo.location == false)
    local function snapshot() return manager.snapshot(player).settings end
    local function owns(page)
      local set = {}
      for _, id in ipairs(core.pageRows(page)) do set[id] = true end
      return set
    end
    for _, page in ipairs(PAGES) do
      local own = owns(page)
      for _, change in ipairs(core.defaults(page)) do
        assert(own[change.id] or change.id == 'keyBindings:reset', page .. ' restores ' .. change.id .. ', which is not its row')
      end
    end
    -- Dynamic info: only its own twenty-four switches (the owner's case).
    local before = {bonds = snapshot().characterBonds, packs = snapshot().storyPacks, outfits = snapshot().companionOutfits, reputation = snapshot().reputation,
      subtitles = snapshot().subtitleStyle, vVoice = snapshot().vVoice, johnny = snapshot().johnnyInHead}
    local changes = core.defaults('dynamic-info')
    assert(#changes == 2, 'the two changed switches: ' .. #changes)
    assert(registered.applyBatch('manager', changes).ok)
    local after = snapshot()
    assert(after.dynamicInfo.location == true and after.dynamicInfoPhone.time == true, 'the Dynamic info rows are back')
    assert(after.characterBonds == before.bonds and after.storyPacks == before.packs and after.companionOutfits == before.outfits, 'Character bonds, Story packs and Outfits stay on')
    assert(after.reputation == before.reputation and after.subtitleStyle == before.subtitles and after.vVoice == before.vVoice and after.johnnyInHead == before.johnny)
    assert(saved.characterBonds == true and saved.storyPacks == true and saved.companionOutfits == true, 'the saved file agrees')
    -- Companions: the three switches (and the Story packs that need Character bonds go off with them), nothing of Dynamic info, Night City or Voice.
    assert(registered.applyBatch('manager', {{id = 'dynamic:location', value = false}}).ok)
    local mid = snapshot()
    assert(mid.reputation == false and mid.subtitleStyle == 'overhead' and mid.vVoiceMic == true and mid.johnnyInHead == true, 'the other pages still hold their changes')
    assert(registered.applyBatch('manager', core.defaults('settings-companions')).ok)
    after = snapshot()
    assert(after.characterBonds == false and after.storyPacks == false and after.companionOutfits == false, 'Companions is back to its defaults')
    assert(after.dynamicInfo.location == false, 'Dynamic info is as it was')
    assert(after.reputation == mid.reputation and after.subtitleStyle == mid.subtitleStyle and after.vVoiceMic == mid.vVoiceMic and after.johnnyInHead == mid.johnnyInHead,
      'Night City, Interface, Voice and Conversations are as they were')
  `);
});

test('the Key bindings page restores the keys, and no other page does', () => {
  run(`${nsuiFixture}
    ${pageList}
    assert(manager.setKeyBinding(player, 'voice', 'IK_F2'))
    for _, page in ipairs(PAGES) do
      local has = false
      for _, change in ipairs(core.defaults(page)) do if change.id == 'keyBindings:reset' then has = true end end
      assert(has == (page == 'key-bindings'), page .. ' key bindings: ' .. tostring(has))
    end
    assert(core.apply(core.defaults('key-bindings')).ok and manager.keyBindings().voice == 'IK_F7')
  `);
});

test('the three hosts call the one page-scoped restore and nothing else', () => {
  const mcm = read('../mod/mcm-host.lua'), nsui = read('../mod/nsui.lua'), ui = read('../mod/manager-ui.lua');
  // MCM and Native Settings UI name the page on screen, so the manager can never fall back to another page.
  assert.match(mcm, /local changes = core\.defaults\(core\.view\(\)\)/);
  assert.match(nsui, /local changes = core\.defaults\(core\.view\(\)\)/);
  for (const [name, source] of [['mcm-host.lua', mcm], ['nsui.lua', nsui]]) {
    assert.doesNotMatch(source.replace(/^\s*--.*$/gm, ''), /core\.defaults\(\)/, `${name} restores without naming a page`);
  }
  // The manager walks one page, never the list of every page.
  const defaults = ui.slice(ui.indexOf('function M.defaults(name)'), ui.indexOf('local function splitMergedRows'));
  assert.match(defaults, /restorableRows\(name\)/);
  assert.doesNotMatch(defaults, /settingsPages\.list/, 'M.defaults no longer walks every Settings page');
  assert.doesNotMatch(defaults, /'relationships', 'dynamic-info', 'key-bindings'/, 'nor the list of sub-pages');
  // The Settings list has no Restore defaults button; every page with rows has one.
  assert.match(ui, /return \(name ~= 'settings' and settingsPages\.isSettingsView\(name\)\) or DEFAULTS_PAGES\[name\] == true/);
  // The Lua settings code of mod/manager.lua has no restore of its own beyond the key defaults the page asks for.
  const manager = read('../mod/manager.lua');
  assert.doesNotMatch(manager, /function M\.restoreDefaults|function M\.resetAll|function M\.defaults\b/);
});

test('Restore defaults on the provider page turns Mature content off without putting the Voice page’s Voxtral back', () => {
  const ui = read('../mod/manager-ui.lua');
  // The batch of a Restore defaults marks its changes, and Mature content off then leaves the rows of the Voice page alone.
  assert.match(ui, /changes\[#changes \+ 1\] = \{id = row\.id, value = target, restoring = true\}/);
  assert.match(ui, /if part and not explicit\.voiceProvider and not restoring then/);
  assert.match(ui, /if part and part\.before == 'voxtral' and not explicit\.vVoiceEngine and not restoring and vEngineNow == 1 and keySaved then/);
});
