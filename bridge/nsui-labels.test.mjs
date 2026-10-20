import {test} from 'node:test';
import assert from 'node:assert/strict';
import {run, nsuiHarness, source} from './manager-fixture.mjs';

// The rows of the Companion Manager tab in every interface language: Native Settings UI gives a label and a button a fixed width, so the
// host (mod/nsui.lua) cuts what does not fit (LAYOUT, in the units of optionUnits()). This builds every page with the real host in each of
// the 16 languages and holds it to what the host promises: nothing is wider than its budget; a switch, a selector, a slider or a button
// is never cut (a translation that does not fit must be shortened); a text line (a label with its value after it, such as a status or a
// log path) may be cut, and then its whole text leads its description. It cannot see the game: the budgets are estimates, to be
// confirmed in the live test.
const everything = {
  'service-status.lua': source('service-status.lua'), 'character-editor.lua': source('character-editor.lua'),
  'convai-paid-tier.lua': source('convai-paid-tier.lua'), 'support-report.lua': source('support-report.lua'),
  'setup-check.lua': source('setup-check.lua'), 'custom-provider.lua': source('custom-provider.lua'),
};
const languages = ['en', 'zh-cn', 'zh-tw', 'es', 'pt-br', 'fr', 'de', 'it', 'pl', 'cs', 'hu', 'tr', 'ru', 'uk', 'ja', 'ko'];
const views = ['home', 'characters', 'party', 'models', 'settings', 'memory', 'help', 'paid-tier', 'custom-endpoint'];

for (const code of languages) {
  test(`${code}: every row of every page fits its width; only text lines are cut and they keep their whole text in the description`, () => run(`
    ${nsuiHarness({modules: everything, locale: code === 'en' ? null : code})}
    local clock = 1000
    os.clock = function() return clock end
    local timeBase = os.time()
    os.time = function() return timeBase + math.floor(clock - 1000) end
    local function frames(count) for _ = 1, count do clock = clock + 0.1; managerUi.update(player, true) end end
    convaiUiLocale.configure('${code}'); convaiUiLocale.update(0)
    assert(convaiUiLocale.current() == '${code}', 'the language is not active: ' .. tostring(convaiUiLocale.current()))
    ns.leave(); ns.openScreen(TAB); frames(3)
    local layout = managerUi.LAYOUT
    local function units(text) return core.optionUnits(text) end
    local rows, cuts = 0, 0
    for _, view in ipairs({${views.map(view => `'${view}'`).join(', ')}}) do
      core.setView(view); frames(view == 'models' and 140 or 6); ns.verify()
      for _, section in ipairs(ns.sections()) do
        assert(units(section.label) <= layout.stripUnits + 0.05, view .. ': a section name is too wide: ' .. section.label)
        for _, option in ipairs(section.options) do
          rows = rows + 1
          local text = option.type == 'button' and option.buttonText or ''
          local line = option.type == 'button' and text == ''
          local limit = (text ~= '') and layout.buttonLabelUnits or layout.labelUnits
          assert(units(option.label) <= limit + 0.05, view .. ': a label is too wide: ' .. option.label .. ' (' .. units(option.label) .. ')')
          assert(units(text) <= layout.buttonUnits + 0.05, view .. ': a button text is too wide: ' .. text .. ' (' .. units(text) .. ')')
          assert(text:sub(-3) ~= '…', view .. ': a button text was cut: ' .. text)
          if option.label:sub(-3) == '…' then
            cuts = cuts + 1
            assert(line, view .. ': a row that is not a text line was cut: ' .. option.label)
            local whole = option.label:sub(1, -4)
            assert(option.desc:sub(1, #whole) == whole, view .. ': the whole line does not lead the description of ' .. option.label)
          end
        end
      end
    end
    assert(rows > 100, 'the pages were not built: ' .. rows .. ' rows')
  `));
}
