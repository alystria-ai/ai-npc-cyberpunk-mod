// A line sent right after the player picks Local AI must go to Local AI, not to Convai (owner rule: Local AI never reaches the cloud). The settings poll
// runs every 500 ms and the provider switch waits for an idle boundary, so a request that arrived inside that window used to be answered by the provider
// that was in use before. A submitted turn now reads the provider setting itself before it picks its provider (convai-bridge.mjs syncProviderForNewTurn).
// A real bridge process (bridge/bridge-run-fixture.mjs): its side-effect guard refuses every outward effect, so nothing here reaches a service.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {launchBridge} from './bridge-run-fixture.mjs';

const request = (id, text) => JSON.stringify({requestId: `${id}-0-5ULL`, generation: 0, entity: '5ULL', name: 'Judy Alvarez', bodyType: 'female', profileKey: 'judy-alvarez', text});

test('a request written at once after the setting changed to Local AI meets Local AI as the applied provider, never Convai', {timeout: 90000}, async () => {
  const bridge = await launchBridge({settings: {conversationProvider: 'convai', voice: false}});
  try {
    await bridge.ready();
    const before = await bridge.until(() => bridge.read('mistral-state.json'), value => value?.provider === 'convai', 'Convai was not the applied provider');
    assert.equal(before.effective, 'convai');
    // The change and the line, back to back: no settings poll can have run in between.
    await bridge.writeSettings({conversationProvider: 'local', voice: false});
    await bridge.write('last-input.json', request(1, 'Hello Judy, are you there?'));
    const reply = await bridge.until(() => bridge.read('reply.json'), value => value?.requestId === '1-0-5ULL', 'no reply to the line', 60000);
    // The line is answered (here with the fixture's "no profile" refusal: the world has no characters) only after the switch to Local AI was made: before this
    // change the provider was switched by a later poll, after the turn had already picked Convai.
    const log = bridge.errors();
    assert.ok(log.includes('Conversation provider: local'), `the provider was switched before the turn was answered
${JSON.stringify(reply)}
${log}`);
    const state = await bridge.read('mistral-state.json');
    assert.equal(state.effective, 'local');
    // Nothing of the Convai route ran: no browser or Convai connection was attempted.
    assert.deepEqual((await bridge.forbidden()).filter(line => /convai\.com|WebSocket/i.test(line)), []);
  } finally { await bridge.cleanup(); }
});

const source = readFileSync(new URL('./convai-bridge.mjs', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
test('the wiring: a turn syncs the provider before it is started (processInput), and the switch for that turn skips the idle test only', () => {
  assert.match(source, /async function applyProviderChoice\(\{newTurn = false\} = \{\}\) \{\n  if \(providerSwitching \|\| stopped \|\| !mistral\.pending \|\| \(!newTurn && voiceBoundaryBusy\(\)\) \|\| voiceRouteReservation\) return;/);
  assert.match(source, /async function processInput\(request, prepared\) \{\n(?:\s*\/\/[^\n]*\n)?\s*await syncProviderForNewTurn\(\);\n\s*return withTurnClock/);
  assert.match(source, /if \(mistral\.pending\) await applyProviderChoice\(\{newTurn: true\}\);/);
  // the settings poll adopts the setting through the same function
  assert.match(source, /await adoptProviderSetting\(settings\);\n\s*await mistralControl\.poll\(\)/);
});
