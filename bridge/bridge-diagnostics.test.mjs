import assert from 'node:assert/strict';
import {mkdir, mkdtemp, rm, utimes, writeFile} from 'node:fs/promises';
import {existsSync, readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {REPORT_FOLDER, REPORT_KEEP, collectCrashInfo, crashLogLines, decodeExitCode, exitCodeWords, newestNodeReport, prepareReportFolder,
  recentNodeReports, reportArguments, summariseNodeReport} from './bridge-diagnostics.mjs';
import {STAGE_FILE} from './stage-marker.mjs';
import {cleanCrash, queueRecord} from './error-events.mjs';

const folder = () => mkdtemp(join(tmpdir(), 'bridge-diagnostics-'));

// The shape of a real compact report from Node (header, javascriptStack, javascriptHeap, nativeStack, resourceUsage, then sections never read).
const exceptionReport = {
  header: {reportVersion: 4, event: 'Exception', trigger: 'Exception', nodejsVersion: 'v24.21.0', commandLine: ['node', '--secret-looking-argument'], processId: 1},
  javascriptStack: {message: 'Error: boom here', stack: ['at Timeout._onTimeout (C:\\Users\\someone\\game\\app\\bridge\\turn.mjs:41:23)', 'at listOnTimeout (node:internal/timers:581:17)',
    'at async run (file:///C:/Users/someone/game/app/bridge/convai-bridge.mjs:900:5)'], errorProperties: {}},
  javascriptHeap: {totalMemory: 150 * 1048576, usedMemory: 96 * 1048576, memoryLimit: 4144 * 1048576},
  nativeStack: [{pc: '0x1', symbol: 'node::TriggerNodeReport+3643'}, {pc: '0x2', symbol: 'v8::internal::V8::FatalProcessOutOfMemory+10'}, {pc: '0x3', symbol: 'v8::Isolate::Dispose+93'}],
  resourceUsage: {rss: 412 * 1048576},
  environmentVariables: {MISTRAL_API_KEY: 'must-never-be-read'},
};

test('exit codes are decoded: access violation, fast-fail, stack overflow, -1, abort', () => {
  assert.equal(decodeExitCode(3221225477).hex, '0xC0000005');
  assert.match(decodeExitCode(3221225477).meaning, /access violation/);
  assert.equal(decodeExitCode(0xC0000409).hex, '0xC0000409');
  assert.match(decodeExitCode(0xC00000FD).meaning, /stack overflow/);
  assert.equal(decodeExitCode(4294967295).hex, '0xFFFFFFFF');
  assert.match(decodeExitCode(4294967295).meaning, /TerminateProcess/);
  assert.deepEqual(decodeExitCode(-1), decodeExitCode(4294967295), 'a signed -1 is the same code');
  assert.match(decodeExitCode(134).meaning, /abort.*memory/);
  assert.match(decodeExitCode(1).meaning, /uncaught exception/);
  assert.equal(decodeExitCode(0), null);
  assert.equal(decodeExitCode(null), null);
  assert.equal(decodeExitCode('1'), null);
  assert.equal(exitCodeWords(4294967295).startsWith('0xFFFFFFFF, '), true);
  assert.equal(exitCodeWords(null), '');
  assert.equal(exitCodeWords(4), '', 'an ordinary small code adds nothing');
  assert.match(decodeExitCode(0xC0000099).meaning, /Windows error status/);
});

test('the launch flags switch on the fatal-error and uncaught-exception reports, compact, in the data folder', () => {
  const flags = reportArguments('D:\\data\\node-reports', {nodeExecutable: 'node.exe', ownExecutable: 'other.exe', allowed: new Set(['--report-exclude-env'])});
  assert.deepEqual(flags, ['--report-on-fatalerror', '--report-uncaught-exception', '--report-compact', '--report-directory=D:\\data\\node-reports']);
  const own = reportArguments('D:\\r', {nodeExecutable: 'node.exe', ownExecutable: 'node.exe', allowed: new Set(['--report-exclude-env'])});
  assert.equal(own.at(-1), '--report-exclude-env', 'the environment is left out when this Node knows the flag');
  assert.equal(reportArguments('D:\\r', {nodeExecutable: 'node.exe', ownExecutable: 'node.exe', allowed: new Set()}).includes('--report-exclude-env'), false);
});

test('a Node report is boiled down to the error, a few frames, native symbols and the memory figures', () => {
  const summary = summariseNodeReport(exceptionReport);
  assert.equal(summary.event, 'Exception');
  assert.equal(summary.error, 'Error: boom here');
  assert.deepEqual(summary.frames, ['turn.mjs:41 Timeout._onTimeout', 'convai-bridge.mjs:900 async run'], 'Node internals out, folders out');
  assert.deepEqual(summary.native, ['v8::internal::V8::FatalProcessOutOfMemory', 'v8::Isolate::Dispose'], 'the report writer\'s own frames are left out');
  assert.equal(summary.heapUsedMiB, 96); assert.equal(summary.heapTotalMiB, 150); assert.equal(summary.heapLimitMiB, 4144); assert.equal(summary.rssMiB, 412);
  assert.equal(summary.node, 'v24.21.0');
  const text = JSON.stringify(summary);
  assert.doesNotMatch(text, /must-never-be-read|secret-looking|someone/, 'the environment, the command line and folders are never read out');
  const fatal = summariseNodeReport({header: {event: 'Allocation failed - JavaScript heap out of memory', trigger: 'OOMError'}, javascriptStack: {message: 'No stack.', stack: ['Unavailable.']}});
  assert.equal(fatal.error, undefined, '"No stack." is not an error');
  assert.equal(fatal.trigger, 'OOMError');
  assert.equal(summariseNodeReport(null), null);
});

test('the report folder is made and old reports are removed: the newest five stay', async () => {
  const dir = await folder();
  try {
    const reports = join(dir, REPORT_FOLDER);
    await mkdir(reports);
    const now = Date.now();
    for (let index = 0; index < 8; index++) {
      const path = join(reports, `report.2026.${index}.json`);
      await writeFile(path, '{}');
      await utimes(path, new Date(now - index * 60_000), new Date(now - index * 60_000));
    }
    await writeFile(join(reports, 'notes.txt'), 'not a report');
    assert.equal(prepareReportFolder(reports, {now}), true);
    const left = readdirSync(reports).filter(name => name.startsWith('report.'));
    assert.equal(left.length, REPORT_KEEP);
    assert.ok(left.includes('report.2026.0.json') && !left.includes('report.2026.7.json'));
    assert.ok(existsSync(join(reports, 'notes.txt')), 'only report files are touched');
    assert.equal(prepareReportFolder(join(dir, 'new', 'folder'), {now}), true, 'a missing folder is made (Node does not make it)');
    assert.ok(existsSync(join(dir, 'new', 'folder')));
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test('the newest report written since the launch is found; an older run\'s is not', async () => {
  const dir = await folder();
  try {
    const reports = join(dir, REPORT_FOLDER);
    await mkdir(reports);
    const now = Date.now();
    await writeFile(join(reports, 'report.old.json'), JSON.stringify({...exceptionReport, javascriptStack: {message: 'Error: old one', stack: []}}));
    await utimes(join(reports, 'report.old.json'), new Date(now - 3_600_000), new Date(now - 3_600_000));
    await writeFile(join(reports, 'report.new.json'), JSON.stringify(exceptionReport));
    await writeFile(join(reports, 'report.cut.json'), '{"header":');
    assert.equal(newestNodeReport(reports, {since: now - 60_000}).file, 'report.new.json');
    assert.equal(newestNodeReport(reports, {since: now + 60_000}), null);
    assert.deepEqual(recentNodeReports(reports, {limit: 5}).map(row => row.file), ['report.new.json', 'report.old.json'], 'the cut-short file is skipped');
    assert.equal(newestNodeReport(join(dir, 'missing')), null);
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test('the crash facts: exit code, the stage from the marker of that process, memory, and the report', async () => {
  const dir = await folder();
  try {
    const now = Date.now();
    await mkdir(join(dir, REPORT_FOLDER));
    await writeFile(join(dir, REPORT_FOLDER, 'report.one.json'), JSON.stringify(exceptionReport));
    const marker = {version: 1, pid: 4242, startedAt: now - 600_000, updatedAt: now - 2000, stage: {name: 'turn.llmSent', at: now - 2500},
      previous: [{name: 'microphone.finish', at: now - 5000}, {name: 'turn.received', at: now - 4000}], memory: {rssMiB: 380, heapUsedMiB: 90, heapTotalMiB: 140, heapLimitMiB: 4144, at: now - 120_000}};
    await writeFile(join(dir, STAGE_FILE), JSON.stringify(marker));
    const info = collectCrashInfo({stateDirectory: dir, pid: 4242, exit: {code: 4294967295}, launchedAt: now - 600_000, now});
    assert.equal(info.exit.hex, '0xFFFFFFFF');
    assert.equal(info.stage.name, 'turn.llmSent'); assert.equal(info.stage.agoS, 3); assert.equal(info.stage.closed, false);
    assert.deepEqual(info.stage.previous, ['microphone.finish', 'turn.received']);
    assert.equal(info.memory.rssMiB, 380); assert.equal(info.memory.agoS, 120);
    assert.equal(info.uptimeS, 600);
    assert.equal(info.nodeReport.file, 'report.one.json');
    const lines = crashLogLines(info);
    assert.equal(lines.length, 2);
    assert.match(lines[0], /Last stage of the bridge: turn\.llmSent, 3 s before the end; before it: microphone\.finish, turn\.received; .*did not announce an exit.*rss 380 MiB/);
    assert.match(lines[1], /Node report report\.one\.json: Exception, Error: boom here, at turn\.mjs:41 Timeout\._onTimeout/);
    // The stage file of another process is not this bridge's.
    assert.equal(collectCrashInfo({stateDirectory: dir, pid: 1, exit: {code: 1}, now}).stage, undefined);
    // A bridge that announced its end says so.
    await writeFile(join(dir, STAGE_FILE), JSON.stringify({...marker, closed: true, exitCode: 1}));
    const closed = collectCrashInfo({stateDirectory: dir, pid: 4242, exit: {code: 1}, now});
    assert.equal(closed.stage.closed, true);
    assert.match(crashLogLines(closed)[0], /announced its own exit \(code 1\)/);
    assert.deepEqual(collectCrashInfo({stateDirectory: join(dir, 'none'), pid: 1, exit: {adopted: true}}), {});
    assert.deepEqual(crashLogLines({}), []);
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test('the queue keeps a crash\'s facts field by field and drops everything else', () => {
  const crash = cleanCrash({exit: {code: 4294967295, hex: '0xFFFFFFFF', meaning: 'ended from outside', secret: 'x'},
    stage: {name: 'turn.llmSent', agoS: 3, previous: ['a', 'b'], closed: false, text: 'hello there'}, memory: {rssMiB: 380, heapUsedMiB: 90, other: 1}, uptimeS: 600,
    nodeReport: {file: 'report.one.json', event: 'Exception', error: 'Error: boom', frames: ['a.mjs:1 f'], native: [], heapUsedMiB: 96, injected: 'no'}, extra: 'no'});
  assert.deepEqual(Object.keys(crash).sort(), ['exit', 'memory', 'nodeReport', 'stage', 'uptimeS']);
  assert.equal(crash.exit.secret, undefined); assert.equal(crash.stage.text, undefined); assert.equal(crash.nodeReport.injected, undefined);
  assert.equal(crash.nodeReport.native, undefined, 'an empty list is left out');
  assert.equal(cleanCrash(null), null); assert.equal(cleanCrash({}), null); assert.equal(cleanCrash([]), null);
  const record = queueRecord({kind: 'bridge-crash', message: 'The bridge exited unexpectedly', frame: 'exit code 4294967295', crash});
  assert.equal(record.crash.exit.hex, '0xFFFFFFFF');
  assert.equal(queueRecord({kind: 'turn-failed', message: 'x', crash}).crash, undefined, 'only a bridge crash carries one');
});

test('a real Node process that throws leaves a report this module can summarise (the launch flags work)', async () => {
  const {spawnSync} = await import('node:child_process');
  const dir = await folder();
  try {
    const reports = join(dir, REPORT_FOLDER);
    prepareReportFolder(reports);
    const result = spawnSync(process.execPath, [...reportArguments(reports, {nodeExecutable: process.execPath}), '-e', 'setTimeout(() => { throw new Error("real boom") }, 5)'],
      {encoding: 'utf8', windowsHide: true});
    assert.equal(result.status, 1);
    const report = newestNodeReport(reports);
    assert.ok(report, 'Node wrote a report');
    assert.equal(report.error, 'Error: real boom');
    assert.ok(Number.isFinite(report.heapUsedMiB) && Number.isFinite(report.rssMiB));
  } finally { await rm(dir, {recursive: true, force: true}); }
});
