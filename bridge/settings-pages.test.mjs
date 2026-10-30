// Settings is a short list of category pages (2026-10-30, docs/MANAGER_UI.md): AI provider, Voice and microphone, Conversations, Companions, Night City, Interface,
// Content packs (only with add-ons) and Privacy and help. These tests pin the pages and their rows, where Back goes, the one-time migrations of the settings file that
// came with the reorganisation and the "vision" wording of the Companion vision row. Rows keep their stored keys, so the older tests find them by id.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {run, nsuiFixture} from './manager-fixture.mjs';
import {run as runStartup, managerLua} from './startup-lua-fixture.mjs';

const luaString = text => `'${text.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n').replace(/\r/g, '\\r')}'`;

test('Settings lists the category pages in order, each with an Open button and a line of help, and no row of any category sits on the list', () => {
  run(`${nsuiFixture}
    assert(invoke('tab:settings').ok)
    local rows = {}
    for _, section in ipairs(loaded.categories) do
      if section.id ~= 'navigation' then
        for _, item in ipairs(section.settings) do rows[#rows + 1] = item end
      end
    end
    local names = {'AI provider', 'Voice and microphone', 'Conversations', 'Companions', 'Night City', 'Interface', 'Privacy and help'}
    local ids = {'settings:provider', 'settings:voice', 'settings:conversations', 'settings:companions', 'settings:night-city', 'settings:interface', 'settings:privacy'}
    assert(#rows == #names, 'the list has ' .. #rows .. ' rows (Content packs only shows with add-ons)')
    for index, item in ipairs(rows) do
      assert(item.id == ids[index] and item.label == names[index] and item.type == 'action' and item.value == 'Open', index .. ': ' .. item.id)
      assert(item.description ~= '' and not item.description:find('\\n', 1, true), item.id .. ' has one line of help')
    end
    assert(loaded.categories[1].settings[1].id == 'settings:back' and loaded.categories[1].settings[1].description == 'Return to Companion Manager.')
  `);
});

// Row ids of each page in the owner's order (docs/MANAGER_UI.md). Rows that depend on the PC or on a module (Custom voices, OmniVoice for AMD, Relationships, Help) are left
// out of the list a page is compared with.
const pages = {
  'settings-provider': ['conversationProvider'],
  'settings-voice': ['voiceProvider', 'replyLanguage', 'voiceVolume', 'vVoice', 'vVoiceEngine', 'vVoiceVolume', 'naturalSpeech', 'micDevice', 'voiceActivation', 'voiceChoices', 'audioDelay'],
  'settings-conversations': ['storyConversations', 'johnnyInHead', 'companionSpeakUp', 'companionVision', 'dynamic-info', 'memory'],
  'settings-companions': ['immersive-invitations', 'housemates', 'companionOutfits', 'characterEddies', 'companionReactions'],
  'settings-night-city': ['reputation', 'npcThreats', 'revengeAmbushes'],
  'settings-interface': ['uiLanguage', 'subtitleStyle'],
  'settings-privacy': ['errorReports', 'developerMode'],
};

test('each category page holds exactly its rows in the owner’s order, every row on one page only, and the rows that are gone have no row anywhere', () => {
  run(`${nsuiFixture}
    local pages = ${JSON.stringify(pages).replace(/\[/g, '{').replace(/\]/g, '}').replace(/"([^"]+)":/g, '["$1"] =')}
    local order = {'settings-provider', 'settings-voice', 'settings-conversations', 'settings-companions', 'settings-night-city', 'settings-interface', 'settings-privacy'}
    local opens = {['settings-provider'] = 'provider', ['settings-voice'] = 'voice', ['settings-conversations'] = 'conversations', ['settings-companions'] = 'companions',
      ['settings-night-city'] = 'night-city', ['settings-interface'] = 'interface', ['settings-privacy'] = 'privacy'}
    local seen = {}
    assert(invoke('tab:settings').ok)
    for _, view in ipairs(order) do
      assert(invoke('settings:' .. opens[view]).ok and managerUi.inspect().view == view, view)
      -- Back to settings is the one row of the way back, and it returns to the list.
      local back = loaded.categories[1].settings[1]
      assert(back.id == view .. ':back' and back.label == 'Back to settings' and back.value == 'Back', view .. ' back row')
      local wanted, index, listed = {}, 0, {}
      for _, id in ipairs(pages[view]) do wanted[id] = true end
      for _, section in ipairs(loaded.categories) do
        if section.id ~= 'navigation' then
          for _, item in ipairs(section.settings) do
            assert(not seen[item.id], item.id .. ' is on two pages')
            seen[item.id] = view
            if wanted[item.id] then listed[#listed + 1] = item.id end
          end
        end
      end
      -- The rows that depend on the PC or on a module are the only ones that may be extra.
      local extra = {['custom-voices'] = true, ['omni-amd'] = true, relationships = true, help = true}
      for id in pairs(seen) do
        if seen[id] == view and not wanted[id] then assert(extra[id] or id:find('^key') or id:find('^paid') or id:find('^custom') or id:find('^gemini') or id:find('^convai') or id:find('^local') or id:find('^mature') or id:find('^own'), view .. ' has an unexpected row ' .. id) end
      end
      assert(table.concat(listed, ',') == table.concat(pages[view], ','), view .. ': ' .. table.concat(listed, ','))
      assert(invoke(view .. ':back').ok and managerUi.inspect().view == 'settings', view .. ' goes back to the list')
    end
    -- What is gone: no row for them on any page.
    for _, id in ipairs({'archetypeConversations', 'eyeContactHeight', 'headFollowStrength', 'battleReactions', 'lootReactions', 'vVoiceMic'}) do
      assert(not seen[id], id .. ' still has a row')
    end
    assert(seen.errorReports == 'settings-privacy' and seen.developerMode == 'settings-privacy' and seen.subtitleStyle == 'settings-interface' and seen.voiceChoices == 'settings-voice')
    -- The old Development and Help sections are not on any page.
    assert(managerUi.inspect().view == 'settings')
  `);
});

test('the pages that open from a category page go back to it, not to Settings', () => {
  run(`${nsuiFixture}
    assert(invoke('tab:settings').ok)
    local function opened(from, id, view, backId)
      assert(invoke('settings:' .. from).ok)
      assert(invoke(id).ok and managerUi.inspect().view == view, id)
      local back = loaded.categories[1].settings[1]
      assert(back.id == backId and back.label == 'Back to settings' and back.value == 'Back', id .. ' back row: ' .. tostring(back.id))
      assert(back.description:find(from == 'conversations' and 'Conversations' or 'Companions', 1, true), 'the help names the page it returns to: ' .. back.description)
      assert(invoke(backId).ok)
      assert(managerUi.inspect().view == 'settings-' .. from, id .. ' went back to ' .. managerUi.inspect().view)
      assert(invoke('settings-' .. from .. ':back').ok and managerUi.inspect().view == 'settings')
    end
    opened('conversations', 'dynamic-info', 'dynamic-info', 'dynamic-info:back')
    opened('conversations', 'memory', 'memory', 'memory:settings')
    opened('companions', 'immersive-invitations', 'immersive-invitations', 'immersive-invitations:back')
    opened('companions', 'housemates', 'housemates', 'housemates:back')
  `);
});

test('Restore defaults covers every category page and no page that is not a Settings page', () => {
  run(`${nsuiFixture}
    local DEFAULTS = {'settings', 'settings-provider', 'settings-voice', 'settings-conversations', 'settings-companions', 'settings-night-city', 'settings-interface', 'settings-privacy',
      'relationships', 'dynamic-info', 'key-bindings', 'immersive-invitations', 'housemates'}
    for _, name in ipairs(DEFAULTS) do assert(core.hasDefaults(name), name .. ' has Restore defaults') end
    for _, name in ipairs({'home', 'characters', 'party', 'models', 'memory', 'help', 'custom-endpoint'}) do assert(not core.hasDefaults(name), name .. ' has none') end
    -- Changing rows on four different pages and restoring puts every one back.
    assert(registered.applyBatch('manager', {{id = 'reputation', value = false}, {id = 'companionReactions', value = false}, {id = 'vVoice', value = 3}, {id = 'subtitleStyle', value = 3}}).ok)
    assert(saved.reputation == false and saved.battleReactions == false and saved.lootReactions == false and saved.vVoiceMic == true and saved.subtitleStyle == 'overhead')
    local changes = core.defaults()
    local byId = {}
    for _, change in ipairs(changes) do byId[change.id] = change.value end
    assert(byId.reputation == true and byId.companionReactions == true and byId.vVoice == 2 and byId.subtitleStyle == 2, 'the defaults of rows on four pages')
    assert(registered.applyBatch('manager', changes).ok)
    assert(saved.reputation == true and saved.npcThreats == true and saved.battleReactions == true and saved.lootReactions == true and saved.vVoice == true and saved.vVoiceMic == false and saved.subtitleStyle == 'dialogue')
  `);
});

test('Companions react is one switch for both stored settings, V’s voice is one list over typed and spoken lines with the engine on its own row, and the hidden rows cannot be set', () => {
  run(`${nsuiFixture}
    assert(invoke('tab:settings').ok)
    local react = row('companionReactions')
    assert(react and react.type == 'bool' and react.value == true and react.defaultValue == true, 'Companions react is on by default')
    assert(registered.applyBatch('manager', {{id = 'companionReactions', value = false}}).ok)
    assert(saved.battleReactions == false and saved.lootReactions == false and saved.battleReactionsChosen == true and saved.lootReactionsChosen == true)
    loaded = registered.loadMod('manager')
    assert(row('companionReactions').value == false)
    assert(registered.applyBatch('manager', {{id = 'companionReactions', value = true}}).ok and saved.battleReactions == true and saved.lootReactions == true)

    local v = row('vVoice')
    assert(v and v.type == 'select' and v.label == 'V’s voice' and v.defaultValue == 2 and v.value == 2, 'Typed lines is the default')
    assert(table.concat(v.elements, '|') == 'Off|Typed lines|Typed and spoken lines')
    assert(not row('vVoiceMic'), 'the microphone row is gone')
    for _, case in ipairs({{1, false, false}, {2, true, false}, {3, true, true}}) do
      assert(registered.applyBatch('manager', {{id = 'vVoice', value = case[1]}}).ok)
      assert(saved.vVoice == case[2] and saved.vVoiceMic == case[3] and saved.vVoiceChosen == true, 'mode ' .. case[1])
      loaded = registered.loadMod('manager')
      assert(row('vVoice').value == case[1], 'mode ' .. case[1] .. ' reads back')
    end
    assert(not registered.applyBatch('manager', {{id = 'vVoice', value = 4}}).ok)
    -- The engine is its own row: Pocket by default, one engine for typed and spoken lines, and it never turns V on or off.
    local engine = row('vVoiceEngine')
    assert(engine and engine.type == 'select' and engine.value == 1 and engine.defaultValue == 1 and #engine.elements == 3)
    assert(registered.applyBatch('manager', {{id = 'vVoice', value = 1}}).ok and saved.vVoice == false)
    assert(not registered.applyBatch('manager', {{id = 'vVoiceEngine', value = 2}}).ok and saved.vVoiceEngine == 'pocket', 'Voxtral needs a Mistral key')
    assert(registered.applyBatch('manager', {{id = 'vVoiceEngine', value = 1}}).ok and saved.vVoice == false and saved.vVoiceEngine == 'pocket')
    -- The hidden rows: nothing is saved for them.
    assert(not registered.applyBatch('manager', {{id = 'eyeContactHeight', value = 5}}).ok)
    assert(manager.applySettings(player, {eyeContactHeight = 0.1, headFollowStrength = 1.5, archetypeConversations = false}))
    assert(saved.eyeContactHeight == 0 and saved.headFollowStrength == 1 and saved.archetypeConversations == true, 'ignored, not saved')
  `);
});

test('the Companion vision row says vision, never picture, in its name and help', () => {
  run(`${nsuiFixture}
    assert(invoke('tab:settings').ok)
    local vision = row('companionVision')
    assert(vision and vision.label == 'Companion vision' and vision.type == 'bool' and vision.value == false)
    assert(vision.description:find('vision', 1, true) and not vision.description:lower():find('picture', 1, true), vision.description)
    assert(managerUi.inspect().view == 'settings-conversations')
    -- Nothing on any Settings page names a picture for this feature or still calls the setting by its old name.
    for _, view in ipairs({'settings-provider', 'settings-voice', 'settings-conversations', 'settings-companions', 'settings-night-city', 'settings-interface', 'settings-privacy', 'dynamic-info'}) do
      core.setView(view)
      for _, section in ipairs(core.model().categories) do
        for _, item in ipairs(section.settings) do
          assert(not item.description:lower():find('picture', 1, true), view .. ' / ' .. item.id .. ' says picture')
          assert(item.label ~= 'Companions can see' and not item.description:find('Companions can see', 1, true), item.id)
        end
      end
    end
  `);
});

// ---- The migrations of the settings file (mod/manager.lua loadSettings), each once ----------------------------------------------------------------------------------
const load = seed => runStartup(`${managerLua}
  ${seed === null ? '' : `files['runtime/settings.json'] = ${luaString(JSON.stringify(seed))}`}
  local manager = newManager()
  local player = newPlayer()
  local settings = manager.snapshot(player).settings
  report('settings', settings)
  manager.update(player, 0.1)
  report('file', json.decode(settingsText()))
`).file;

test('Companions react: on when either of React to battles and React to collected loot was on, off only when both were off, done once', () => {
  const base = {version: 2, battleReactionsChosen: true, lootReactionsChosen: true};
  const cases = [[true, true, true], [true, false, true], [false, true, true], [false, false, false]];
  for (const [battle, loot, expected] of cases) {
    const file = load({...base, battleReactions: battle, lootReactions: loot});
    assert.equal(file.battleReactions, expected, `battle ${battle} loot ${loot}`);
    assert.equal(file.lootReactions, expected, `battle ${battle} loot ${loot}`);
    assert.equal(file.reactionsMergedGiven, true);
  }
  assert.equal(load(null).battleReactions, true, 'a new player has both on');
  assert.equal(load(null).lootReactions, true);
  // After the marker, the file is left as it is.
  const after = load({...base, battleReactions: false, lootReactions: true, reactionsMergedGiven: true});
  assert.equal(after.battleReactions, false, 'a file that has been through the merge is not merged again');
  assert.equal(after.lootReactions, true);
});

test('V’s voice: microphone lines on means Typed and spoken lines (typed lines come on with it), the other pairs keep what they were, done once', () => {
  const seeded = (typed, mic, extra = {}) => load({version: 2, vVoice: typed, vVoiceChosen: true, vVoiceMic: mic, vVoiceMicOwn: true, ...extra});
  let file = seeded(true, true);
  assert.equal(file.vVoice, true); assert.equal(file.vVoiceMic, true);
  file = seeded(false, true);
  assert.equal(file.vVoice, true, 'microphone on and typed off: typed lines turn on, so the row reads Typed and spoken lines');
  assert.equal(file.vVoiceMic, true);
  assert.equal(file.vVoiceMergedGiven, true);
  file = seeded(true, false);
  assert.equal(file.vVoice, true); assert.equal(file.vVoiceMic, false);
  file = seeded(false, false);
  assert.equal(file.vVoice, false, 'a chosen Off stays Off'); assert.equal(file.vVoiceMic, false);
  file = load(null);
  assert.equal(file.vVoice, true, 'the default is Typed lines'); assert.equal(file.vVoiceMic, false);
  file = seeded(false, true, {vVoiceMergedGiven: true});
  assert.equal(file.vVoice, false, 'with the marker nothing is forced again'); assert.equal(file.vVoiceMic, true);
  file = seeded(true, true, {vVoiceEngine: 'voxtral'});
  assert.equal(file.vVoiceEngine, 'voxtral', 'the engine is untouched');
});

test('Talk to ordinary NPCs is always on: a saved off becomes on, and the setting cannot be turned off any more', () => {
  assert.equal(load({version: 2, archetypeConversations: false}).archetypeConversations, true);
  assert.equal(load({version: 2, archetypeConversations: 'no'}).archetypeConversations, true);
  assert.equal(load(null).archetypeConversations, true);
  const out = runStartup(`${managerLua}
    local manager = newManager()
    local player = newPlayer()
    manager.snapshot(player)
    local ok = manager.applySettings(player, {archetypeConversations = false})
    report('ok', ok); report('now', manager.archetypeConversations())
  `);
  assert.equal(out.now, true);
});

test('Eye contact height and Head tracking strength have no row and always use their defaults, whatever the file saved', () => {
  let file = load({version: 2, eyeContactHeight: 0.1, headFollowStrength: 1.5});
  assert.equal(file.eyeContactHeight, 0); assert.equal(file.headFollowStrength, 1);
  file = load({version: 2, eyeContactHeight: -0.05, headFollowStrength: 0});
  assert.equal(file.eyeContactHeight, 0); assert.equal(file.headFollowStrength, 1);
  file = load(null);
  assert.equal(file.eyeContactHeight, 0); assert.equal(file.headFollowStrength, 1);
});

test('Street reputation and NPCs react to threats and commands are on for a new player and for a file that never saved them, and a saved choice is kept', () => {
  let file = load(null);
  assert.equal(file.reputation, true); assert.equal(file.npcThreats, true);
  file = load({version: 2});
  assert.equal(file.reputation, true, 'a file with no saved value'); assert.equal(file.npcThreats, true);
  file = load({version: 2, reputation: false, npcThreats: false});
  assert.equal(file.reputation, false, 'a saved off is kept'); assert.equal(file.npcThreats, false);
  file = load({version: 2, reputation: true, npcThreats: false});
  assert.equal(file.reputation, true); assert.equal(file.npcThreats, false);
  file = load({version: 2, reputation: 'yes', npcThreats: 1});
  assert.equal(file.reputation, true, 'something that is not on or off is the default'); assert.equal(file.npcThreats, true);
});
