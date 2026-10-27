import {test} from 'node:test';
import assert from 'node:assert/strict';
import {constants as osConstants} from 'node:os';
import {BrowserPriority, DEFAULT_PRIORITY, PriorityGate, priorityGate, PRIORITY_ENVIRONMENT, PRIORITY_FILE, PRIORITY_VARIABLE, nodePriority, parsePriorityText, priorityEnvironment, priorityLevel,
  readTurnPriority, setBrowserTreePriority, setProcessPriority} from './process-priority.mjs';

test('the default is high, and only high, normal and below are levels (never realtime)', () => {
  assert.equal(DEFAULT_PRIORITY, 'high');
  for (const word of ['high', 'normal', 'below', ' HIGH ', 'Normal']) assert.ok(priorityLevel(word), word);
  for (const word of ['realtime', 'highest', 'above', 'idle', '', null, undefined, 3, 'below normal']) assert.equal(priorityLevel(word), null, String(word));
});

test('priority.txt: the first priority line that is not a comment; anything else is ignored', () => {
  assert.equal(parsePriorityText('priority = normal'), 'normal');
  assert.equal(parsePriorityText('# the game stutters\n\npriority: Normal\n'), 'normal');
  assert.equal(parsePriorityText('\uFEFFpriority=below'), 'below');
  assert.equal(parsePriorityText('priority = realtime\npriority = high'), 'high', 'a refused value is skipped, the next line counts');
  assert.equal(parsePriorityText('# priority = normal'), null);
  assert.equal(parsePriorityText('normal'), null, 'only the "priority =" form');
  assert.equal(parsePriorityText('priority = normal; rm -rf'), null);
  assert.equal(parsePriorityText(null), null);
});

test('the level for this PC: the developer variable, else priority.txt, else high; a missing or unreadable file is the default', () => {
  const file = text => () => text;
  assert.deepEqual(readTurnPriority({stateDirectory: 'C:/s', environment: {}, readFile: () => { throw Error('ENOENT'); }}), {level: 'high', source: 'default'});
  assert.deepEqual(readTurnPriority({stateDirectory: 'C:/s', environment: {}, readFile: file('priority = normal')}), {level: 'normal', source: 'file'});
  assert.deepEqual(readTurnPriority({stateDirectory: 'C:/s', environment: {}, readFile: file('nonsense')}), {level: 'high', source: 'default'});
  assert.deepEqual(readTurnPriority({stateDirectory: 'C:/s', environment: {[PRIORITY_ENVIRONMENT]: 'normal'}, readFile: file('priority = high')}), {level: 'normal', source: 'environment'});
  assert.deepEqual(readTurnPriority({stateDirectory: 'C:/s', environment: {[PRIORITY_ENVIRONMENT]: 'realtime'}, readFile: file('')}), {level: 'high', source: 'default'});
  assert.deepEqual(readTurnPriority({environment: {}}), {level: 'high', source: 'default'}, 'no state folder: the default');
  const seen = [];
  readTurnPriority({stateDirectory: 'C:/s', environment: {}, readFile: path => { seen.push(path); return ''; }});
  assert.match(seen[0].replaceAll('\\', '/'), new RegExp(`/s/${PRIORITY_FILE.replace('.', '\\.')}$`));
});

test('high is Node\'s PRIORITY_HIGH (Windows HIGH_PRIORITY_CLASS), never PRIORITY_HIGHEST (REALTIME)', () => {
  assert.equal(nodePriority('high'), osConstants.priority.PRIORITY_HIGH);
  assert.notEqual(nodePriority('high'), osConstants.priority.PRIORITY_HIGHEST);
  assert.equal(nodePriority('normal'), osConstants.priority.PRIORITY_NORMAL);
  assert.equal(nodePriority('below'), osConstants.priority.PRIORITY_BELOW_NORMAL);
});

test('setProcessPriority: sets the class, and a refusal, a bad pid or a bad level is false and never throws', () => {
  const calls = [];
  assert.equal(setProcessPriority(4321, 'high', (pid, level) => calls.push([pid, level])), true);
  assert.deepEqual(calls, [[4321, osConstants.priority.PRIORITY_HIGH]]);
  assert.equal(setProcessPriority(4321, 'high', () => { throw Error('access denied'); }), false);
  for (const pid of [undefined, null, -1, 1.5, '12', NaN]) assert.equal(setProcessPriority(pid, 'high', () => calls.push('bad')), false, String(pid));
  for (const level of ['realtime', 'highest', undefined]) assert.equal(setProcessPriority(4321, level, () => calls.push('bad')), false, String(level));
  assert.equal(calls.includes('bad'), false);
});

test('a Python worker is told its level through one variable: high and below, nothing for normal', () => {
  assert.deepEqual(priorityEnvironment('high'), {[PRIORITY_VARIABLE]: 'high'});
  assert.deepEqual(priorityEnvironment('below'), {[PRIORITY_VARIABLE]: 'below'});
  assert.deepEqual(priorityEnvironment('normal'), {});
  assert.deepEqual(priorityEnvironment('realtime'), {});
  assert.equal(PRIORITY_VARIABLE, 'CYBERPUNK_CONVAI_WORKER_PRIORITY');
});

test('the browser tree: the PowerShell call gets the bridge pid and the class in its environment, never in the command text; a failure is null', async () => {
  const calls = [];
  const run = async (script, env, timeout) => { calls.push({script, env, timeout}); return 'junk\n7\n'; };
  assert.equal(await setBrowserTreePriority('high', {rootPid: 555, platform: 'win32', run}), 7);
  assert.deepEqual(calls[0].env, {PRIORITY_ROOT: '555', PRIORITY_CLASS: 'High'});
  assert.ok(!calls[0].script.includes('555') && !calls[0].script.includes('High\''), 'the values are not in the command text');
  assert.match(calls[0].script, /remote-debugging-/, 'only the browser this process started (Playwright\'s debugging pipe)');
  assert.ok(!/Realtime/i.test(calls[0].script));
  assert.equal(await setBrowserTreePriority('high', {rootPid: 555, platform: 'linux', run}), null, 'not Windows');
  assert.equal(await setBrowserTreePriority('realtime', {rootPid: 555, platform: 'win32', run}), null);
  assert.equal(await setBrowserTreePriority('high', {rootPid: 0, platform: 'win32', run}), null);
  assert.equal(await setBrowserTreePriority('high', {rootPid: 555, platform: 'win32', run: async () => null}), null, 'PowerShell failed');
  assert.equal(await setBrowserTreePriority('high', {rootPid: 555, platform: 'win32', run: async () => { throw Error('x'); }}), null);
  assert.equal(await setBrowserTreePriority('high', {rootPid: 555, platform: 'win32', run: async () => 'not a number'}), null);
});

function fakeClock() {
  const jobs = []; let time = 0;
  return {now: () => time, setTimer: (callback, ms) => { const job = {callback, at: time + ms}; jobs.push(job); return job; },
    clearTimer: job => { const at = jobs.indexOf(job); if (at >= 0) jobs.splice(at, 1); },
    advance(ms) { time += ms; for (const job of jobs.filter(item => item.at <= time)) { jobs.splice(jobs.indexOf(job), 1); job.callback(); } },
    get pending() { return jobs.length; }};
}
const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };

test('BrowserPriority: requests are joined, spaced and the last one always runs; only high does anything; the first result is logged once', async () => {
  const clock = fakeClock(), logs = [], runs = [];
  const keeper = new BrowserPriority({level: 'high', rootPid: 9, setTree: async (level, {rootPid}) => { runs.push([level, rootPid]); return 4; }, ...clock, log: line => logs.push(line)});
  keeper.request(); keeper.request(); keeper.request();
  assert.equal(clock.pending, 1, 'one timer for any number of requests');
  assert.deepEqual(runs, [], 'the browser\'s new processes get a moment to exist');
  clock.advance(400); await flush();
  assert.deepEqual(runs, [['high', 9]]);
  assert.deepEqual(logs, ['hidden browser priority: high for 4 processes']);
  // A page opens right after: the next call waits for the gap.
  keeper.request(); assert.equal(clock.pending, 1);
  clock.advance(1000); await flush(); assert.equal(runs.length, 1, 'inside the gap');
  clock.advance(3000); await flush(); assert.equal(runs.length, 2);
  assert.equal(logs.length, 1, 'said once');
  // A request while one runs is not lost.
  let release; const slow = new BrowserPriority({level: 'high', setTree: () => new Promise(done => { release = done; }), ...clock, log: () => {}});
  slow.request(); clock.advance(5000); await flush(); slow.request();
  release(1); await flush(); assert.equal(clock.pending, 1, 'the late request is scheduled after the run');
  keeper.cancel(); slow.cancel(); assert.equal(clock.pending, 0);
  for (const level of ['normal', 'below']) {
    const idle = new BrowserPriority({level, setTree: async () => { throw Error('must not run'); }, ...clock});
    idle.request(); assert.equal(clock.pending, 0, level);
  }
  const closed = new BrowserPriority({level: 'high', setTree: async () => 1, ...clock}); closed.close(); closed.request(); assert.equal(clock.pending, 0);
});

test('BrowserPriority: a failing call is logged once as not set and never throws', async () => {
  const clock = fakeClock(), logs = [];
  const keeper = new BrowserPriority({level: 'high', setTree: async () => { throw Error('powershell missing'); }, ...clock, log: line => logs.push(line)});
  keeper.request(); clock.advance(400); await flush();
  assert.deepEqual(logs, ['hidden browser priority: could not be set']);
});

test('PriorityGate: closed at the title screen everything starts at normal, the raisers run once when it opens, an open gate changes nothing', () => {
  const lines = [];
  let clock = 1000;
  const gate = new PriorityGate({log: line => lines.push(line), now: () => clock});
  // The shared gate and a fresh one are open: level() is the identity, whenOpen runs at once (tests, tools and standalone workers are unchanged).
  assert.equal(priorityGate.isOpen, true);
  assert.equal(gate.level('high'), 'high');
  let ran = 0; gate.whenOpen(() => { ran++; }, 'early'); assert.equal(ran, 1);
  assert.equal(gate.open('never closed'), false, 'a gate that never closed has nothing to open');
  const closed = new PriorityGate({log: line => lines.push(line), now: () => clock});
  closed.close();
  assert.equal(closed.isOpen, false);
  assert.equal(closed.level('high'), 'normal');
  assert.equal(closed.level('below'), 'below', 'only high is held back');
  assert.equal(closed.level('normal'), 'normal');
  const order = [];
  closed.whenOpen(() => { order.push('a'); }, 'conversation service');
  closed.whenOpen(() => { order.push('b'); return false; }, 'browser');
  closed.whenOpen(() => { throw Error('boom'); }, 'worker');
  const cancel = closed.whenOpen(() => { order.push('cancelled'); }, 'gone'); cancel();
  assert.deepEqual(order, [], 'nothing runs while the title is up');
  clock = 4500;
  assert.equal(closed.open('the game has a world'), true);
  assert.deepEqual(order, ['a', 'b'], 'in order, a failing raiser does not stop the others, a cancelled one never runs');
  assert.equal(closed.open('again'), false, 'once');
  assert.equal(closed.level('high'), 'high');
  closed.whenOpen(() => { order.push('late'); }, 'late'); assert.deepEqual(order, ['a', 'b', 'late'], 'a raiser registered after the open runs at once');
  assert.equal(closed.close().isOpen, true, 'a gate that opened never closes again');
  const said = lines.join('\n');
  assert.match(said, /\[Priority\] title screen: everything starts at normal priority until the game has a world \(1970-01-01T00:00:01\.000Z\)/);
  assert.match(said, /\[Priority\] raised at 1970-01-01T00:00:04\.500Z \(the game has a world, 3\.5 s after the service started\): conversation service, browser \(not raised\), worker \(not raised\)/);
});

test('BrowserPriority: at the title screen nothing is run, the tree is raised once when the gate opens', async () => {
  const clock = fakeClock(), runs = [], logs = [];
  const gate = new PriorityGate({open: false});
  gate.close();
  const keeper = new BrowserPriority({level: 'high', rootPid: 9, gate, setTree: async (level, {rootPid}) => { runs.push([level, rootPid]); return 4; }, ...clock, log: line => logs.push(line)});
  keeper.request(); keeper.request(); keeper.request();
  assert.equal(clock.pending, 0, 'no timer, no PowerShell call at the title screen');
  assert.equal(gate.waiting.length, 1, 'one waiting raise however many requests');
  clock.advance(60_000); await flush(); assert.deepEqual(runs, []);
  gate.open('the game has a world');
  assert.equal(clock.pending, 1);
  clock.advance(400); await flush();
  assert.deepEqual(runs, [['high', 9]]);
  assert.deepEqual(logs, ['hidden browser priority: high for 4 processes']);
  // A browser that went away before the world is not raised.
  const gone = new PriorityGate({open: false}); gone.close();
  const other = new BrowserPriority({level: 'high', gate: gone, setTree: async () => { throw Error('must not run'); }, ...clock});
  other.request(); other.cancel(); gone.open('x'); assert.equal(clock.pending, 0);
});
