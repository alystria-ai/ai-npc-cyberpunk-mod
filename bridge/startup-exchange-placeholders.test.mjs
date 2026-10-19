// A bridge that starts in a freshly installed Mod Organizer 2 profile, and the control file that stops it, on a real bridge process
// (bridge/bridge-run-fixture.mjs).
//
// After the MO2 install every file of runtime/ that the game and the bridge exchange ships as an EMPTY placeholder
// (packaging/runtime-exchange.json, "exchange"), and the game's Lua rewrites its own files in place, so a read can find any of them empty.
// An empty file must read as "nothing yet" everywhere: no error, no turn, no command, and nothing written into the game's files.
import {test, describe, before, after} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {launchBridge} from './bridge-run-fixture.mjs';

const exchange = JSON.parse(readFileSync(new URL('../packaging/runtime-exchange.json', import.meta.url), 'utf8')).exchange;
// The files the game writes and the bridge only reads: requests, commands, leases and the world heartbeat. The bridge never writes them
// (it answers in its own files), so an empty one is still exactly the placeholder after the whole run.
const GAME_OWNED = ['last-input.json', 'microphone-command.json', 'phone-chat-input.json', 'own-key-command.json', 'mistral-key-command.json',
  'inworld-key-command.json', 'custom-provider-command.json', 'paid-tier-command.json', 'memory-command.json', 'editor-command.json', 'voice-preview.json', 'group-prefetch.json',
  'conversation-prewarm.json', 'party-connections.json', 'nearby-connections.json', 'world-session.json', 'relationship-state.json',
  'continuous-control.json', 'companion-invitations.json', 'reaction-lease.json', 'expression-receipt.json', 'report-request.json'];
// Status files the bridge publishes before it says it is ready (each is awaited by the startup, not left to a timer).
const PUBLISHED_BEFORE_READY = ['bridge-status.json', 'knowledge-status.json', 'memory-status.json', 'mistral-state.json', 'custom-provider-state.json', 'own-key-state.json', 'paid-tier-state.json'];
const POLL_FAILURES = /Settings poll|Microphone poll|Phone poll|Preparation poll|Look-ahead poll|Knowledge poll|Memory control|Support report|Paid tier|Character editor|Releasing unused|TypeError|ReferenceError|SyntaxError|Unhandled|uncaught|Unexpected (?:end|token)|JSON at position|is not valid JSON/i;

test('the shipped placeholder list names every game-owned file this test relies on', () => {
  for (const name of [...GAME_OWNED, ...PUBLISHED_BEFORE_READY]) assert.ok(exchange.includes(name), `${name} is not an exchange file`);
});

test('a bridge started over empty placeholders, an empty settings file and an empty control file starts quietly, publishes its status, leaves the game\'s files alone and stops cleanly', {timeout: 90000}, async () => {
  const bridge = await launchBridge({settings: '', stateFiles: {'bridge-control.json': ''},
    runtimeFiles: Object.fromEntries(exchange.map(name => [name, '']))});
  try {
    await bridge.ready();
    // Ready means the first poll is done and the status files the settings page reads are in place over their placeholders.
    for (const name of PUBLISHED_BEFORE_READY) {
      const value = await bridge.read(name);
      assert.ok(value && typeof value === 'object', `${name} was still the placeholder when the bridge said it was ready`);
    }
    assert.equal((await bridge.read('bridge-status.json')).state, 'waiting');
    await bridge.idle(2000);   // four more settings polls, and every other poll, over the empty files
    assert.doesNotMatch(bridge.errors(), POLL_FAILURES);
    assert.deepEqual(await bridge.forbidden(), []);

    assert.equal((await bridge.shutdown()).code, 0);
    assert.equal((await bridge.read('bridge-status.json')).state, 'stopped');
    for (const name of GAME_OWNED) assert.equal(await bridge.readText(name), '', `${name} was written by the bridge`);
    assert.equal(await bridge.readText('reply.json'), '', 'an empty request is not a turn: no reply was written');
    assert.doesNotMatch(bridge.errors(), POLL_FAILURES);
  } finally { await bridge.cleanup(); }
});

describe('bridge-control.json and the heartbeat in local-voice-state.json', {timeout: 120000}, () => {
  let bridge;
  // The heartbeat file is removed right after the start so that the renewal can be seen without waiting for the first publish to age.
  before(async () => {
    bridge = await launchBridge({settings: {voice: false}});
    await bridge.ready();
    await bridge.until(() => bridge.read('local-voice-state.json'), value => value?.bridgePid === bridge.child.pid, 'the heartbeat was never published');
    await bridge.remove('local-voice-state.json');
  }, {timeout: 60000});
  after(async () => { await bridge?.cleanup(); });
  test('a deleted heartbeat file is published again within the supervisor\'s adoption window, naming this process and not stopped', async () => {
    // The supervisor adopts a bridge whose heartbeat is under 15 s old (bridge-supervisor.mjs, adoptFreshMs); the bridge renews it every 5 s.
    const state = await bridge.until(() => bridge.read('local-voice-state.json'), value => value !== null, 'the heartbeat was not renewed', 9000);
    assert.equal(state.bridgePid, bridge.child.pid);
    assert.notEqual(state.state, 'stopped');
    assert.ok(Math.abs(Date.now() - state.updated) < 9000);
  });

  test('shutdown commands that are not exactly for this process are ignored', async () => {
    const pid = bridge.child.pid;
    for (const command of [{action: 'shutdown', pid: pid + 1}, {action: 'shutdown', pid: String(pid)}, {action: 'shutdown'}, {action: 'restart', pid},
      `{"action": "shutdown", "pid": ${pid}`, '', 'null', '[]']) {
      await bridge.writeControl(command);
      await bridge.idle(700);   // at least one poll sees it
    }
    assert.equal(bridge.closed, null, bridge.context());
  });

  test('a diagnostics command for this process writes bridge-diagnostics.json, and one for another process writes nothing', async () => {
    await bridge.writeControl({action: 'diagnostics', pid: bridge.child.pid + 1});
    await bridge.idle(1000);
    assert.equal(await bridge.readState('bridge-diagnostics.json'), null);
    await bridge.writeControl({action: 'diagnostics', pid: bridge.child.pid});
    const report = await bridge.until(() => bridge.readState('bridge-diagnostics.json'), value => value !== null, 'no diagnostics were written');
    assert.equal(report.version, 1);
    assert.equal(report.action.admitted, false, 'no companion action is waiting');
    assert.equal(bridge.closed, null);
  });

  test('a shutdown for this process ends it with exit code 0, and the heartbeat then says stopped so no supervisor adopts it', async () => {
    assert.deepEqual(await bridge.shutdown(), {code: 0, signal: null});
    assert.equal((await bridge.read('bridge-status.json')).state, 'stopped');
    const state = await bridge.read('local-voice-state.json');
    assert.equal(state.bridgePid, bridge.child.pid);
    assert.equal(state.state, 'stopped');
  });
});
