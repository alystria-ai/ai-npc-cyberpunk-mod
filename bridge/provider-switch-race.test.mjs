// A line sent right after the player picks Local AI must go to Local AI, not to Convai (owner rule: Local AI never reaches the cloud). The settings poll
// runs every 500 ms and the full provider switch waits for an idle boundary, so a request that arrived inside that window used to be answered by the provider
// that was in use before. The game now writes the provider it has chosen into the request itself (mod/init.lua sendRequest, field `provider`), and the
// request poll follows it for the turn it starts (convai-bridge.mjs providerForTurn): no file is read, the whole switch is made only at the same idle
// boundary the Convai key's switch uses (minus the turn's own flags), and when something else is running a switch TO Local AI is made lightly so that this turn
// still goes local. A look-ahead turn never starts a switch.
// First a real bridge process (bridge/bridge-run-fixture.mjs, every outward effect refused), then the decision itself with fake collaborators.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {launchBridge} from './bridge-run-fixture.mjs';

const request = (id, text, provider) => JSON.stringify({requestId: `${id}-0-5ULL`, generation: 0, entity: '5ULL', name: 'Judy Alvarez', bodyType: 'female',
  profileKey: 'judy-alvarez', text, ...(provider ? {provider} : {})});

test('a request written at once after the setting changed to Local AI meets Local AI as the applied provider, never Convai', {timeout: 90000}, async () => {
  const bridge = await launchBridge({settings: {conversationProvider: 'convai', voice: false}});
  try {
    await bridge.ready();
    const before = await bridge.until(() => bridge.read('mistral-state.json'), value => value?.provider === 'convai', 'Convai was not the applied provider');
    assert.equal(before.effective, 'convai');
    // The change and the line, back to back: no settings poll can have run in between. The request carries the provider, as the game writes it.
    await bridge.writeSettings({conversationProvider: 'local', voice: false});
    await bridge.write('last-input.json', request(1, 'Hello Judy, are you there?', 'local'));
    const reply = await bridge.until(() => bridge.read('reply.json'), value => value?.requestId === '1-0-5ULL', 'no reply to the line', 60000);
    // The line is answered (here with the fixture's "no profile" refusal: the world has no characters) only after the switch to Local AI was made.
    const log = bridge.errors();
    assert.ok(log.includes('Conversation provider: local'), `the provider was switched before the turn was answered\n${JSON.stringify(reply)}\n${log}`);
    const state = await bridge.read('mistral-state.json');
    assert.equal(state.effective, 'local');
    // Nothing of the Convai route ran: no browser or Convai connection was attempted.
    assert.deepEqual((await bridge.forbidden()).filter(line => /convai\.com|WebSocket/i.test(line)), []);
  } finally { await bridge.cleanup(); }
});

// ---- The decision, with fake collaborators ------------------------------------------------------------------------------------------------------------
const source = readFileSync(new URL('./convai-bridge.mjs', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const between = (from, to) => { const a = source.indexOf(from), b = source.indexOf(to, a); assert.ok(a > 0 && b > a, `${from} ... ${to}`); return source.slice(a, b); };
const busyTest = between('function voiceBoundaryBusy(', '// Read-only observability for the Relationships setting');
const switching = between('let providerSwitching = false;', '// Resources the current settings do not use are released');

function world(over = {}) {
  const calls = [];
  const flags = {active: null, polling: false, streaming: 0, micPolling: false, mic: {current: null}, prefetchPolling: false, memoryQuiescing: false,
    phone: {active: false, forgetSessions: async () => { calls.push('forget'); }}, relationshipRouteReservation: false, lookahead: {busy: false}, voiceRouteReservation: false, stopped: false, ...over};
  const mistral = {preference: 'convai', applied: 'convai', get requested() { return this.preference; }, get pending() { return this.requested !== this.applied; },
    get active() { return this.applied !== 'convai'; }, get route() { return this.applied; }, localDown: false,
    apply() { this.applied = this.requested; calls.push('apply'); }, setPreference(value) { const changed = value !== this.preference; this.preference = value; return changed; }};
  const context = vm.createContext({...flags, mistral, calls, PROVIDERS: ['convai', 'mistral', 'local', 'custom'],
    adoptProviderSetting: async settings => mistral.setPreference(settings.conversationProvider),
    realtime: {close: async () => calls.push('close-realtime')}, phoneRealtime: {close: async () => calls.push('close-phone')},
    sessions: {clear: () => calls.push('clear-sessions')}, realtimeSessions: {clear() {}}, sceneryMemory: {clear() {}},
    warmTurnConnections: () => {}, dropPrefetch: () => calls.push('drop-prefetch'), prefetchObserved: '', logLocalDown: () => {}, customEndpoint: {},
    localServer: {ensure: async () => calls.push('local-ensure'), stop: async () => calls.push('local-stop')},
    mistralControl: {publishStatus: async () => {}}, rewarmLocalVoice: () => calls.push('rewarm'), localEmbedder: {close: async () => calls.push('embedder-close')},
    addonHost: {active: false}, pollLog: (...args) => { throw Error(args.join(' ')); }, console: {error() {}}, setTimeout, Promise});
  vm.runInContext(`${busyTest}\n${switching}\nglobalThis.api = {providerForTurn, applyProviderChoice, get teardownDue() { return providerTeardownDue; },
    set(name, value) { globalThis[name] = value; }};`, context);
  return {api: context.api, mistral, calls, context};
}

test('idle: the request\'s provider is adopted and the whole switch is made before the turn starts', async () => {
  const w = world();
  await w.api.providerForTurn({provider: 'local'});
  assert.equal(w.mistral.applied, 'local');
  assert.ok(w.calls.includes('close-realtime') && w.calls.includes('local-ensure'), w.calls.join());
  assert.equal(w.api.teardownDue, false);
  // the same provider again, or a request that names none: nothing happens
  const again = world(); again.mistral.preference = again.mistral.applied = 'local';
  await again.api.providerForTurn({provider: 'local'}); await again.api.providerForTurn({}); await again.api.providerForTurn({provider: 'groq'});
  assert.deepEqual(again.calls, []);
});

test('the turn\'s own flags (the active request and the request poll) do not hold the switch back, every other busy flag does', async () => {
  const own = world({active: {}, polling: true});
  await own.api.providerForTurn({provider: 'mistral'});
  assert.equal(own.mistral.applied, 'mistral');
  for (const [name, value] of [['streaming', 1], ['micPolling', true], ['prefetchPolling', true], ['memoryQuiescing', true], ['relationshipRouteReservation', true]]) {
    const w = world({[name]: value});
    await w.api.providerForTurn({provider: 'mistral'});
    assert.equal(w.mistral.applied, 'convai', `${name}: the switch to a cloud provider waits for the idle boundary`);
    assert.ok(!w.calls.includes('close-realtime'), name);
  }
  for (const over of [{mic: {current: {}}}, {phone: {active: true, forgetSessions: async () => {}}}, {lookahead: {busy: true}}]) {
    const w = world(over);
    await w.api.providerForTurn({provider: 'custom'});
    assert.equal(w.mistral.applied, 'convai', Object.keys(over)[0]);
  }
});

test('Local AI chosen while something else is running (a group round, Phone Chat, the microphone, memory saving, a voice change): this turn goes local, nothing is closed, the teardown waits', async () => {
  for (const over of [{lookahead: {busy: true}}, {streaming: 1}, {phone: {active: true, forgetSessions: async () => {}}}, {mic: {current: {}}}, {memoryQuiescing: true},
    {voiceRouteReservation: true}, {relationshipRouteReservation: true}]) {
    const w = world(over);
    await w.api.providerForTurn({provider: 'local'});
    const label = Object.keys(over)[0];
    assert.equal(w.mistral.applied, 'local', `${label}: the turn must not go to the old provider`);
    assert.ok(!w.calls.includes('close-realtime') && !w.calls.includes('close-phone') && !w.calls.includes('clear-sessions'), `${label}: a reply in progress keeps its pages and sessions`);
    assert.equal(w.api.teardownDue, true, label);
    assert.ok(w.calls.includes('local-ensure'), label);
    // the settings poll finishes the switch at its idle boundary, not before
    await w.api.applyProviderChoice();
    if (label === 'voiceRouteReservation' || label === 'lookahead' || label === 'streaming' || label === 'memoryQuiescing' || label === 'relationshipRouteReservation') assert.equal(w.api.teardownDue, true, `${label}: still busy`);
    w.api.set(label, label === 'lookahead' ? {busy: false} : false);
  }
  const done = world({lookahead: {busy: true}});
  await done.api.providerForTurn({provider: 'local'});
  done.api.set('lookahead', {busy: false});
  await done.api.applyProviderChoice();
  assert.equal(done.api.teardownDue, false);
  assert.ok(done.calls.includes('close-realtime') && done.calls.includes('clear-sessions'), 'the teardown ran once the boundary was idle');
});

test('a switch away from Local AI waits for the idle boundary: the line goes to the provider in use until then', async () => {
  const w = world({lookahead: {busy: true}}); w.mistral.preference = w.mistral.applied = 'local';
  await w.api.providerForTurn({provider: 'convai'});
  assert.equal(w.mistral.applied, 'local');
  assert.equal(w.mistral.preference, 'convai', 'the preference follows, so the settings poll applies it at the boundary');
});

test('wiring: the request poll and the microphone start ask for the provider (the request poll before the look-ahead claim), a started switch is waited for first, look-ahead turns never ask', () => {
  assert.equal((source.match(/providerForTurn\(/g) ?? []).length, 4, 'the definition, the request poll and two microphone starts');
  const abort = source.indexOf('active?.controller.abort();\n    // The provider the player chose'), call = source.indexOf('await providerForTurn(input);'), claim = source.indexOf('const held = lookahead.claim(input, owner);');
  assert.ok(abort > 0 && call > abort && claim > call, 'the provider is settled before a held look-ahead turn is claimed (the switch drops held turns)');
  assert.equal((source.match(/await providerForTurn\(input, \{mic: true\}\);/g) ?? []).length, 2, 'a recording goes to the chosen provider too');
  const ahead = between('function startAhead(entry) {', '// Runs the turn under its own TurnClock');
  assert.ok(!/providerForTurn|applyProviderChoice|lightApplyProvider/.test(ahead));
  // no settings.json read on the turn path
  const body = between('async function providerForTurn(input, {mic = false} = {}) {', '// Resources the current settings do not use');
  assert.ok(!/settings\.json/.test(body));
  // a switch the settings poll has started is waited for before anything is decided, and a line for Local AI is lightly applied even if it is still running
  assert.ok(body.indexOf('providerSwitching && waited') < body.indexOf('if (!mistral.pending) return;'));
  assert.match(body, /if \(mistral\.pending && mistral\.requested === 'local'\) lightApplyProvider\(\);/);
  // no group look-ahead is started while another provider than the one in use is chosen
  assert.match(source, /const textProviderChosen = \(\) => mistral\.active \|\| mistral\.requested !== 'convai';/);
  assert.match(source, /textProvider: textProviderChosen\(\), kind\}\);/);
  assert.match(source, /await adoptProviderSetting\(settings\);\n\s*await mistralControl\.poll\(\)/, 'the settings poll adopts the setting through the same function');
  // the microphone command carries the provider
  const lua = readFileSync(new URL('../mod/init.lua', import.meta.url), 'utf8').split(String.fromCharCode(13)).join('');
  assert.match(lua, /context\.provider = chosenProvider\(\)\n\s*if microphone\.begin\(context, targetValid, source == 'vad' and 'vad' or 'press', \{hold = holdId, vadId = vadId\}\) then/);
});

test('the game writes the provider into the request and the bridge reads only the four known names', async () => {
  const { parseInput } = await import('./protocol.mjs');
  assert.equal(parseInput(request(2, 'hi', 'local')).provider, 'local');
  for (const bad of ['groq', 'Local', '', 7, null]) assert.equal(parseInput(request(2, 'hi', bad || undefined).replace('}', `,"provider":${JSON.stringify(bad)}}`)).provider, undefined, String(bad));
  assert.equal(parseInput(request(2, 'hi')).provider, undefined);
  const { inputIdentity } = await import('./group-prefetch.mjs');
  assert.equal(inputIdentity(JSON.parse(request(3, 'same line', 'local'))), inputIdentity(JSON.parse(request(3, 'same line', 'convai'))), 'a prediction does not depend on the provider field');
  const lua = readFileSync(new URL('../mod/init.lua', import.meta.url), 'utf8').split(String.fromCharCode(13)).join('');
  assert.match(lua, /local function chosenProvider\(\)\n\s*local ok, provider = pcall\(function\(\) return manager\.conversationProvider\(\) end\)/);
  assert.match(lua, /local providerOk, provider = pcall\(function\(\) return chosenProvider\(\) end\)\n\s*context\.provider = providerOk and provider or nil\n\s*local encodedOk, encoded = pcall\(json\.encode, context\)/);
});

test('a microphone start: its own polling flag does not hold the switch back, a recording for Local AI goes local even while something else runs', async () => {
  const own = world({micPolling: true});
  await own.api.providerForTurn({provider: 'mistral'}, {mic: true});
  assert.equal(own.mistral.applied, 'mistral', 'the microphone poll itself is not other work');
  const typed = world({micPolling: true});
  await typed.api.providerForTurn({provider: 'mistral'});
  assert.equal(typed.mistral.applied, 'convai', 'for a typed line a recording in progress still is');
  const busy = world({micPolling: true, phone: {active: true, forgetSessions: async () => {}}});
  await busy.api.providerForTurn({provider: 'local'}, {mic: true});
  assert.equal(busy.mistral.applied, 'local', 'Local AI is chosen: the recording must not go to the cloud');
  assert.ok(!busy.calls.includes('close-realtime'));
});
