import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {warmMatureGuard, analyse} from './mature-guard.mjs';

// Source-level regressions for fixes of the 2026-10-14 review (the behaviour tests sit beside each module's own tests).
const read = path => readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

test('the settings page redraws when the Inworld key state changes (the signature reads it, as it does Mistral)', () => {
  const mcm = read('../mod/mcm.lua');
  const body = mcm.slice(mcm.indexOf('local function pageSignature(snapshot)'));
  const settings = body.slice(body.indexOf("if view == 'settings' then"), body.indexOf('-- The Local AI model row'));
  assert.match(settings, /local inworld = type\(mistral\.inworld\) == 'table' and mistral\.inworld or \{\}/);
  assert.match(settings, /tostring\(inworld\.saved\), inworld\.tail or '', inworld\.result or ''/);
  // The characters view labels a voice "needs Inworld key" from the same state.
  const characters = body.slice(body.indexOf("if view == 'characters' then"), body.indexOf("if view == 'models' then"));
  assert.match(characters, /\(snapshot\.mistral or \{\}\)\.inworld or \{\}\)\.saved/);
});

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
  const mcm = read('../mod/mcm.lua');
  const row = mcm.slice(mcm.indexOf("{'Convai free tier', 'Convai API key', 'Mistral (free plan)'"));
  assert.match(row.slice(0, 200), /'Local AI', 'Custom \(OpenAI-compatible\)'\}, \{elements = true, description = true\}\)/);
  assert.ok(!/groq/i.test(row.slice(0, 200)), 'Groq was removed as a provider');
});

test('the phone-chat 30 ms reply probe runs before the 10 Hz early return, not after it', () => {
  const phone = read('../mod/phone-chat.lua');
  const update = phone.slice(phone.indexOf('function M.update(player, delta)'));
  assert.ok(update.indexOf("convaiNative.revision('phone-chat-output.json')") < update.indexOf('if M.tick < 0.10 and M.world then return end'));
});

test('a failing settings reload is attempted once per change, not on every frame', () => {
  const mcm = read('../mod/mcm.lua');
  assert.match(mcm, /if err then lastError = tostring\(err\); renderedSignature = lastSignature end/);
});

test('the Mature guard warm-up compiles the pattern tables in the background so the first Mature turn does not pay for them', async () => {
  await warmMatureGuard();
  await warmMatureGuard();   // a second call is a no-op
  for (const text of ['What are you doing tonight?', 'Привет, расскажи что-нибудь', 'Je suis fatigué', '今日は暑いね', 'Wake up samurai']) {
    const started = performance.now();
    analyse(text);
    assert.ok(performance.now() - started < 50, `${text}: ${(performance.now() - started).toFixed(1)} ms`);
  }
});
