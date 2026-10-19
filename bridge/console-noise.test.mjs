import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {run} from './manager-fixture.mjs';

// The CET console of a player whose setup is incomplete (no Runtime, no browser, Local AI without its pack, an old Mod Configuration
// Menu, no Native Settings UI, no Audioware): a problem is one short line per session, never a line per tick, press or turn. The
// once-per-key logger of mod/init.lua is tested here over its real source; the hosts' own once-lines are in mcm-host.test.mjs.
const init = readFileSync(new URL('../mod/init.lua', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const slice = (from, to) => {
  const start = init.indexOf(from), end = init.indexOf(to, start);
  assert.ok(start >= 0 && end > start, `markers ${from} .. ${to}`);
  return init.slice(start, end);
};
const logger = slice('-- probe.log only, no console line', 'microphone.log = log');

const harness = `
  local console, flushes = {}, 0
  print = function(text) console[#console + 1] = tostring(text) end
  convaiLog = {lines = {}, n = 0, bytes = 0, at = 0}
  convaiLogFlush = function() flushes = flushes + 1; local text = table.concat(convaiLog.lines, '', 1, convaiLog.n); convaiLog.lines, convaiLog.n, convaiLog.bytes = {}, 0, 0; written = (written or '') .. text end
  written = ''
  ${logger}
  local function fileLines() convaiLogFlush(); local list = {}; for line in written:gmatch('[^\\n]+') do list[#list + 1] = line end; return list end
`;

test('a failure that comes round on every tick is one console line, and probe.log counts the repeats', () => run(`${harness}
  for _ = 1, 1500 do convaiLogOnce('Manager update failed: boom') end
  assert(#console == 1 and console[1] == '[CyberpunkConvai] Manager update failed: boom', table.concat(console, ' | '))
  local lines = fileLines()
  -- The first line, then one count at the 10th, 100th and 1000th time: a report still shows that it kept happening.
  assert(#lines == 4, #lines .. ': ' .. table.concat(lines, ' | '))
  assert(lines[2]:find('repeated 10 times', 1, true) and lines[3]:find('repeated 100 times', 1, true) and lines[4]:find('repeated 1000 times', 1, true), table.concat(lines, ' | '))
`));

test('a different failure is its own line, a key is not repeated on the console, and a varying message cannot grow the set', () => run(`${harness}
  assert(convaiLogOnce('Speech update failed: one') == true)
  assert(convaiLogOnce('Speech update failed: two') == true)
  assert(convaiLogOnce('Speech update failed: one') == false)
  assert(#console == 2, table.concat(console, ' | '))
  -- A key apart from the text: the turn number in the line changes, the key does not.
  assert(convaiLogOnce('automatic reaction without a reply: timed out', 'Conversation timed out: generation=4') == true)
  assert(convaiLogOnce('automatic reaction without a reply: timed out', 'Conversation timed out: generation=5') == false)
  assert(console[3] == '[CyberpunkConvai] Conversation timed out: generation=4', console[3])
  for index = 1, 500 do convaiLogOnce('varying ' .. index) end
  assert(#console <= 64 + 1, 'at most 64 keys: ' .. #console)
`));

test('convaiLogFile writes probe.log and never the console', () => run(`${harness}
  convaiLogFile('Phone navigation: presses=2')
  assert(#console == 0)
  assert(fileLines()[1]:find('Phone navigation: presses=2', 1, true))
`));

test('every line of the per-tick update loop that reports a failure goes through the once-per-key logger', () => {
  const loop = init.slice(init.indexOf("registerForEvent('onUpdate'"));
  for (const label of ['Manager update failed', 'Phone action failed', 'Invitation preparation failed', 'Speech update failed', 'Subtitle update failed',
    'Companion adoption update failed', 'Companion tactic update failed', 'Holocall update failed', 'Add-on update failed', 'Auto-connect update failed']) {
    assert.match(loop, new RegExp(`convaiLogOnce\\('${label}: '`), label);
    assert.doesNotMatch(loop, new RegExp(`[^\\w.]log\\('${label}: '`), `${label} must not print on every tick`);
  }
  // A talk the service cannot take is said once per kind of fault; an automatic reaction nobody answers once.
  assert.match(init, /convaiLogOnce\('Conversation service unavailable: ' \.\. tostring\(kind\)\)/);
  assert.match(init, /if expired\.reaction then convaiLogOnce\('automatic reaction without a reply: '/);
});

test('the phone-navigation line is for probe.log only', () => {
  const layout = readFileSync(new URL('../mod/phone-layout.lua', import.meta.url), 'utf8');
  assert.doesNotMatch(layout.replace(/--.*$/gm, ''), /\bprint\(/);
});

test('the Native Settings UI host keeps a repeated problem to one console line', () => {
  const host = readFileSync(new URL('../mod/nsui.lua', import.meta.url), 'utf8');
  for (const text of ['a row could not be updated', 'the page could not be drawn', 'a setting could not be applied', 'an action failed', 'defaults could not be applied']) {
    assert.match(host, new RegExp(`logRepeat\\('Manager: ${text}: '`), text);
  }
});
