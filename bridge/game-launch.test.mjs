import {test} from 'node:test';
import assert from 'node:assert/strict';
import {GameLaunchIdentity, PowerShellUnavailable, identifyGameLaunch} from './game-launch.mjs';

test('launch identity is queried once per adapter world and survives save/CET identity changes', async () => {
  let now = 10000, calls = 0;
  const output = [];
  const resolver = new GameLaunchIdentity({now: () => now,
    identify: async () => { calls++; return '42-123456'; }, publish: async v => output.push(v)});
  const state = world => ({active: true, world, updated: now});
  await resolver.update(state('first'));
  now += 10000; await resolver.update(state('first'));
  assert.equal(calls, 1);
  await resolver.update(state('second'));
  assert.equal(calls, 2);
  assert.deepEqual(output.map(v => [v.world, v.launch]), [['first', '42-123456'], ['second', '42-123456']]);
});

test('missing processes retry with a bound; stale/unloaded states cannot authorize erasure', async () => {
  let now = 20000, calls = 0;
  const output = [];
  const resolver = new GameLaunchIdentity({now: () => now, identify: async () => {
    if (++calls === 1) throw Error('Not ready');
    return '43-999999';
  }, publish: async v => output.push(v)});
  const state = () => ({active: true, world: 'new', updated: now});
  await resolver.update(null);
  await resolver.update({...state(), active: false});
  await resolver.update({...state(), updated: 0});
  assert.equal(calls, 0);
  await assert.rejects(resolver.update(state()), /Not ready/);
  now += 100; await resolver.update(state());
  assert.equal(calls, 1); assert.equal(output.length, 0);
  now += 3000; await resolver.update(state());
  assert.equal(output[0].launch, '43-999999');
});

test('a failed identity write is retried instead of being recorded as complete', async () => {
  let now = 10000, writes = 0;
  const resolver = new GameLaunchIdentity({now: () => now, identify: async () => '44-987654',
    publish: async () => { if (++writes === 1) throw Error('Busy'); }});
  const state = {active: true, world: 'new', updated: now};
  await assert.rejects(resolver.update(state), /Busy/);
  now += 3000; await resolver.update({...state, updated: now});
  assert.equal(writes, 2); assert.equal(resolver.world, 'new');
});

// PowerShell blocked, missing or refusing on the player's PC: one log line, no more attempts, nothing thrown into the poll.
test('identifyGameLaunch tells a PowerShell that cannot be used from a game that is not running', async () => {
  const game = 'C:/Games/Cyberpunk 2077';
  const fails = error => async () => { throw error; };
  for (const [exec, reason] of [
    [fails(Object.assign(Error('spawn powershell.exe ENOENT'), {code: 'ENOENT'})), 'ENOENT'],
    [fails(Object.assign(Error('spawn powershell.exe EACCES'), {code: 'EACCES'})), 'EACCES'],
    [fails(Object.assign(Error('spawn powershell.exe EPERM'), {code: 'EPERM'})), 'EPERM'],
    [fails(Object.assign(Error('Command failed'), {code: 1, stderr: 'running scripts is disabled on this system'})), '1'],
    [fails(Object.assign(Error('stdout maxBuffer length exceeded'), {code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'})), 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'],
    [async () => ({stdout: 'This program is blocked by group policy.\r\n'}), 'unexpected output'],
  ]) {
    await assert.rejects(identifyGameLaunch(game, {exec}), error => error instanceof PowerShellUnavailable && error.reason === reason && !error.timeout, reason);
  }
  await assert.rejects(identifyGameLaunch(game, {exec: fails(Object.assign(Error('timed out'), {killed: true, signal: 'SIGTERM', code: null}))}),
    error => error instanceof PowerShellUnavailable && error.timeout === true && error.reason === 'timeout');
  // PowerShell ran and found no game process: a plain error that is retried, not a refusal.
  await assert.rejects(identifyGameLaunch(game, {exec: async () => ({stdout: '\r\n'})}),
    error => !(error instanceof PowerShellUnavailable) && /unavailable/.test(error.message));
  let call;
  assert.equal(await identifyGameLaunch(game, {exec: async (file, args, options) => { call = {file, args, options}; return {stdout: '42-123456\r\n'}; }}), '42-123456');
  assert.equal(call.file, 'powershell.exe'); assert.equal(call.options.windowsHide, true);
  assert.ok(call.options.timeout > 0 && call.options.timeout <= 10000, 'bounded');
});

test('identifyGameLaunch against a program that does not exist fails fast with ENOENT (no PowerShell is started)', async () => {
  const {execFile} = await import('node:child_process');
  const {promisify} = await import('node:util');
  const real = promisify(execFile);
  await assert.rejects(identifyGameLaunch('C:/Games/Cyberpunk 2077', {exec: (_file, args, options) => real('no-such-powershell-program', args, options)}),
    error => error instanceof PowerShellUnavailable && error.reason === 'ENOENT');
});

test('a PowerShell that cannot be used is logged once, never retried, and does not throw into the poll', async () => {
  for (const failure of [
    () => new PowerShellUnavailable('ENOENT'), () => new PowerShellUnavailable('EPERM'), () => new PowerShellUnavailable('1'),
    () => new PowerShellUnavailable('unexpected output')]) {
    let now = 10000, calls = 0; const logs = [], output = [];
    const resolver = new GameLaunchIdentity({now: () => now, log: line => logs.push(line),
      identify: async () => { calls++; throw failure(); }, publish: async value => output.push(value)});
    const state = world => ({active: true, world, updated: now});
    await resolver.update(state('first'));
    for (let turn = 0; turn < 10; turn++) { now += 4000; await resolver.update(state(turn % 2 ? 'first' : 'second')); }
    assert.equal(calls, 1, 'one attempt for the whole session');
    assert.equal(logs.length, 1); assert.equal(output.length, 0);
    assert.ok(logs[0].length < 200 && !/key|token|secret/i.test(logs[0]));
  }
});

test('one timeout is retried once; a second in a row counts as a refusal', async () => {
  let now = 10000, calls = 0; const logs = [];
  const resolver = new GameLaunchIdentity({now: () => now, log: line => logs.push(line),
    identify: async () => { calls++; throw new PowerShellUnavailable('timeout', {timeout: true}); }, publish: async () => {}});
  const state = () => ({active: true, world: 'new', updated: now});
  await resolver.update(state()); assert.equal(logs.length, 0);
  now += 3000; await resolver.update(state());
  assert.equal(logs.length, 1, 'two timeouts in a row');
  now += 3000; await resolver.update(state());
  assert.equal(calls, 2, 'no third attempt'); assert.equal(logs.length, 1);
  // A timeout followed by a success resets the count.
  let attempt = 0;
  const again = new GameLaunchIdentity({now: () => now, log: line => logs.push(line),
    identify: async () => { if (++attempt === 1) throw new PowerShellUnavailable('timeout', {timeout: true}); return '46-222'; },
    publish: async () => {}});
  await again.update(state()); now += 3000; await again.update(state());
  assert.equal(again.world, 'new'); assert.equal(logs.length, 1);
});

test('a game that is simply not found is retried every 3 s at first and then every 30 s', async () => {
  let now = 10000, calls = 0;
  const resolver = new GameLaunchIdentity({now: () => now, log: () => assert.fail('not a PowerShell problem'),
    identify: async () => { calls++; throw Error('Game launch identity unavailable'); }, publish: async () => {}});
  const state = () => ({active: true, world: 'new', updated: now});
  for (let turn = 0; turn < 5; turn++) { await assert.rejects(resolver.update(state())); now += 3000; }
  assert.equal(calls, 5);
  await resolver.update(state()); assert.equal(calls, 5, 'backs off after five misses');
  now += 30000; await assert.rejects(resolver.update(state())); assert.equal(calls, 6);
});
