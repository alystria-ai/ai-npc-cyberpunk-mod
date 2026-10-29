import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {warmMatureGuard, analyse} from './mature-guard.mjs';

// Source-level regressions for fixes of the 2026-10-14 review (the behaviour tests sit beside each module's own tests).
const read = path => readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

test('every status the phone shows for a provider failure is translated by the phone style layer', () => {
  const chat = read('../mod/phone-chat.lua');
  const table = chat.slice(chat.indexOf('local MISTRAL_STATUS = {'), chat.indexOf('local function copy'));
  const statuses = [...table.matchAll(/\] = '([^']+)',/g)].map(match => match[1]);
  assert.ok(statuses.length >= 5, String(statuses.length));
  const style = read('../mod/phone-chat-style.lua');
  const sources = style.slice(style.indexOf('local statusSources = {'), style.indexOf('local feedbackSources'));
  for (const status of statuses) assert.ok(sources.includes(`['${status}'] = true`), `not translated: ${status}`);
});

test('the Conversation provider options are translated (the catalogue has them in every language)', () => {
  const page = read('../mod/manager-ui.lua');
  const row = page.slice(page.indexOf("{'Convai free tier', 'Convai API key', 'Mistral'"));
  assert.match(row.slice(0, 220), /'Local AI', 'Custom \(OpenAI-compatible\)'\}, \{elements = true, description = true\}\)/);
  assert.ok(!/groq/i.test(row.slice(0, 200)), 'Groq was removed as a provider');
});

test('the phone-chat 30 ms reply probe runs before the 10 Hz early return, not after it', () => {
  const phone = read('../mod/phone-chat.lua');
  const update = phone.slice(phone.indexOf('function M.update(player, delta, phoneOpen)'));
  assert.ok(update.indexOf("convaiNative.revision('phone-chat-output.json')") < update.indexOf('if M.tick < 0.10 and M.world then return end'));
});

test('a page that fails to draw is attempted a few times, not on every frame', () => {
  const host = read('../mod/nsui.lua');
  assert.match(host, /renderFailures = renderFailures \+ 1/);
  assert.match(host, /if renderFailures < 3 then rebuildAt = os\.clock\(\) \+ 0\.25 end/);
  // A draw that raises still leaves the page's signature equal to what was built, so the same page is not drawn again at once.
  const page = read('../mod/manager-ui.lua');
  assert.match(page, /renderedSignature = pageSignature\(snapshot\)\s+lastSignature = renderedSignature/);
});

test('the Mature guard warm-up compiles the pattern tables in the background so the first Mature turn does not pay for them', async () => {
  await warmMatureGuard();
  await warmMatureGuard();   // a second call is a no-op
  for (const text of ['What are you doing tonight?', 'Привет, расскажи что-нибудь', 'Je suis fatigué', '今日は暑いね', 'Wake up samurai']) {
    // CPU time of this process, not wall time: an unprepared first call costs 150 to 450 ms of CPU and a prepared one under 1 ms, while the wall clock also counts
    // every moment the machine gave to other programs. (The CPU clock ticks in 16 ms steps on Windows, so 50 ms is three ticks.)
    const before = process.cpuUsage();
    analyse(text);
    const used = process.cpuUsage(before);
    const cpuMs = (used.user + used.system) / 1000;
    assert.ok(cpuMs < 50, `${text}: ${cpuMs.toFixed(1)} ms of CPU`);
  }
});
