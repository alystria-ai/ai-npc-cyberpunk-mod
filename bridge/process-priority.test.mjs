import {test} from 'node:test';
import assert from 'node:assert/strict';
import {constants as osConstants} from 'node:os';
import {BrowserPriority, DEFAULT_PRIORITY, PRIORITY_ENVIRONMENT, PRIORITY_FILE, PRIORITY_VARIABLE, nodePriority, parsePriorityText, priorityEnvironment, priorityLevel,
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
