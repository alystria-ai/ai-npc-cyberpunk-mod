// The bridge's wiring of the game's room for the model (docs/LOCAL_AI.md, "Room for the game on a small card"): Local AI waits for the voice settings and for OmniVoice to settle before it
// places the model, and tells the supervisor how much graphics memory a voice engine that is still to load will take. The bridge is a script, so these read its source.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const source = readFileSync(new URL('./convai-bridge.mjs', import.meta.url), 'utf8').replace(/\r\n/g, '\n');

test('omniSettled needs the voice settings read first: the first poll starts Local AI before it reads them, and the default voice is Pocket', () => {
  const settled = source.slice(source.indexOf('const omniSettled ='), source.indexOf('// The graphics memory of OmniVoice'));
  assert.match(settled, /voiceSettingsRead\s*&&/);
  assert.match(settled, /requestedProvider !== 'omni'/);
  assert.match(settled, /provider === 'omni'/);
  assert.match(settled, /omniPack\?\.installed === false/);
  assert.match(settled, /fallback != null/, 'a failed OmniVoice whose fallback is the committed voice is settled: Local AI does not wait the full two minutes for it');
  assert.ok(source.indexOf('let voiceSettingsRead') < source.indexOf('const omniSettled ='), 'the flag is declared before it is read');
});

test('the voice engine still to load counts OmniVoice only, only while it is wanted, on and not loaded', () => {
  const start = source.indexOf('const omniStillToLoadMiB =');
  const text = source.slice(start, source.indexOf('\n', source.indexOf('SMALL_CARD_ROOM.omniVoiceMiB', start)));
  for (const part of ["requestedProvider === 'omni'", 'omniPack?.installed !== false', 'playbackEnabled !== false', "provider !== 'omni'", 'omniRetry != null', ': 0']) assert.ok(text.includes(part), part);
  assert.ok(!/pocket/i.test(text), 'Pocket runs on the CPU and counts nothing');
});

test('the Local AI server is given the game room with the voice sizes, not the service age', () => {
  assert.match(source, /gameRoom: \{voiceMiB: omniStillToLoadMiB, residentVoiceMiB: omniResidentMiB\}/);
  assert.ok(!/gameRoom:[^\n]*uptime/.test(source), 'the reservation does not depend on how long the service has run');
  assert.match(source, /const omniResidentMiB = \(\) => localVoice\.provider === 'omni' \? SMALL_CARD_ROOM\.omniVoiceMiB : 0;/);
  assert.match(source, /import \{SMALL_CARD_ROOM\} from '\.\/local-vram-fit\.mjs'/);
});
