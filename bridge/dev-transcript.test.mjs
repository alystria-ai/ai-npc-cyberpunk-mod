import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile} from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {basename, join} from 'node:path';
import {DevTranscript, TRANSCRIPT_FILE, MAX_BYTES, stamp} from './dev-transcript.mjs';
import {locateLogs} from './support-report.mjs';

const KEY = 'sk-' + 'a1B2c3D4'.repeat(4);
const FIXED = new Date(2026, 9, 30, 12, 1, 2);
const fixture = async (options = {}) => {
  const directory = await mkdtemp(join(tmpdir(), 'dev-transcript-'));
  const path = join(directory, TRANSCRIPT_FILE);
  const lines = [];
  const transcript = new DevTranscript({path, now: () => FIXED, log: line => lines.push(line), ...options});
  return {directory, path, lines, transcript, cleanup: () => rm(directory, {recursive: true, force: true})};
};
const turn = (extra = {}) => ({speaker: 'Judy Alvarez', provider: 'local', user: 'what do you think of this place', reply: "It's where the real deals happen.", picture: true,
  where: 'You are inside the Afterlife, a merc bar in Little China, Watson.', ...extra});

test('Developer mode off: nothing is written, not even the file, and a turn recorded meanwhile is not kept for later', async () => {
  const f = await fixture();
  try {
    assert.equal(f.transcript.enabled, false);
    assert.equal(f.transcript.record(turn()), undefined);
    assert.deepEqual(await readdir(f.directory), []);
    assert.equal(f.transcript.update({developerMode: false}), false);
    assert.equal(f.transcript.update({developerMode: 'yes'}), false, 'only a real true turns it on');
    f.transcript.record(turn());
    await f.transcript.flush();
    assert.deepEqual(await readdir(f.directory), []);
    // Turning it on later does not write the turns of the time it was off.
    assert.equal(f.transcript.update({developerMode: true}), true);
    await f.transcript.flush();
    assert.deepEqual(await readdir(f.directory), []);
  } finally { await f.cleanup(); }
});

test('Developer mode on: each turn is appended with the time, the speaker, the provider, V\'s words, the reply, the vision flag and the place', async () => {
  const f = await fixture();
  try {
    assert.equal(f.transcript.update({developerMode: true}), true);
    assert.equal(f.transcript.update({developerMode: true}), false, 'no change');
    f.transcript.record(turn());
    f.transcript.record(turn({speaker: 'Panam Palmer', provider: 'custom', user: 'a typed line', reply: 'line one\nline two', picture: false, where: ''}));
    await f.transcript.flush();
    const text = await readFile(f.path, 'utf8');
    assert.equal(text, [
      '[2026-10-30 12:01:02] Judy Alvarez | provider local | vision yes',
      '  where: You are inside the Afterlife, a merc bar in Little China, Watson.',
      '  V: what do you think of this place',
      "  Judy Alvarez: It's where the real deals happen.",
      '[2026-10-30 12:01:02] Panam Palmer | provider custom | vision no',
      '  V: a typed line',
      '  Panam Palmer: line one',
      '    line two', ''].join('\n'));
    // A settings file that could not be read for a moment changes nothing; turning the mode off stops the writing.
    assert.equal(f.transcript.update(null), false);
    assert.equal(f.transcript.enabled, true);
    assert.equal(f.transcript.update({developerMode: false}), true);
    f.transcript.record(turn({reply: 'after it was turned off'}));
    await f.transcript.flush();
    assert.ok(!(await readFile(f.path, 'utf8')).includes('after it was turned off'));
  } finally { await f.cleanup(); }
});

test('an empty text reads as such, control characters and a speaker name that could break a line are cleaned, a runaway text is cut', async () => {
  const f = await fixture();
  try {
    f.transcript.update({developerMode: true});
    f.transcript.record(turn({speaker: 'Bad | Name\nX', user: '', reply: 'a\u0007b\r\nc', where: undefined, provider: 'lo cal!'}));
    f.transcript.record(turn({reply: 'x'.repeat(50000)}));
    await f.transcript.flush();
    const text = await readFile(f.path, 'utf8');
    assert.match(text, /\] Bad {3}Name X \| provider local \| vision yes\n {2}V: \(nothing\)\n {2}Bad {3}Name X: a b\n {4}c\n/);
    assert.ok(text.length < 9000, `${text.length}`);
  } finally { await f.cleanup(); }
});

test('no key ever reaches the file: every secret the bridge holds is replaced, in V\'s words, the reply and the place', async () => {
  const f = await fixture({secrets: () => [KEY, 'short', null]});
  try {
    f.transcript.update({developerMode: true});
    f.transcript.record(turn({user: `my key is ${KEY}`, reply: `${KEY} and ${KEY}`, where: `at ${KEY}`}));
    f.transcript.record(turn({reply: 'a short word like short stays: only a real key (8 or more characters) is scrubbed'}));
    await f.transcript.flush();
    const text = await readFile(f.path, 'utf8');
    assert.ok(!text.includes(KEY));
    assert.match(text, /my key is \[key\]/);
    assert.match(text, /\[key\] and \[key\]/);
    assert.match(text, /a short word like short stays/);
    // A secrets function that fails does not lose the turn.
    const g = await fixture({secrets: () => { throw Error('no keys'); }});
    try { g.transcript.update({developerMode: true}); g.transcript.record(turn()); await g.transcript.flush(); assert.match(await readFile(g.path, 'utf8'), /Judy Alvarez/); } finally { await g.cleanup(); }
  } finally { await f.cleanup(); }
});

test('the file is rotated at the size limit: the full one becomes .1, the one before is dropped, and no entry is split', async () => {
  const f = await fixture({maxBytes: 600});
  try {
    f.transcript.update({developerMode: true});
    for (let index = 1; index <= 12; index++) f.transcript.record(turn({reply: `reply number ${index} ` + 'z'.repeat(60)}));
    await f.transcript.flush();
    const names = (await readdir(f.directory)).sort();
    assert.deepEqual(names, [TRANSCRIPT_FILE, `${TRANSCRIPT_FILE}.1`]);
    const [current, previous] = await Promise.all([readFile(f.path, 'utf8'), readFile(`${f.path}.1`, 'utf8')]);
    assert.ok(Buffer.byteLength(current) <= 600 && Buffer.byteLength(previous) <= 600, `${Buffer.byteLength(current)} ${Buffer.byteLength(previous)}`);
    for (const part of [current, previous]) assert.ok(part.startsWith('[2026-10-30 12:01:02]'), 'a file starts at an entry');
    assert.ok(current.includes('reply number 12 '), 'the newest is in the current file');
    assert.ok(!previous.includes('reply number 1 ') && !current.includes('reply number 1 '), 'the oldest entries are gone');
    assert.equal(MAX_BYTES, 2 * 1024 * 1024, 'about 2 MB in service');
    // A new session continues the file that is there (its size is read once), and rotates at the limit too.
    const next = new DevTranscript({path: f.path, maxBytes: 600, now: () => FIXED});
    next.update({developerMode: true});
    for (let index = 0; index < 3; index++) next.record(turn({reply: 'again ' + 'q'.repeat(100)}));
    await next.flush();
    assert.ok((await stat(f.path)).size <= 600);
  } finally { await f.cleanup(); }
});

test('a write that fails is logged and never breaks the next turn or throws', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.directory, 'blocker'), 'x');
    const broken = new DevTranscript({path: join(f.directory, 'blocker', TRANSCRIPT_FILE), log: line => f.lines.push(line)});
    broken.update({developerMode: true});
    assert.doesNotThrow(() => broken.record(turn()));
    await broken.flush();
    assert.ok(f.lines.some(line => /dev transcript not written/.test(line)));
    assert.doesNotThrow(() => broken.record(turn()));
    await broken.flush();
  } finally { await f.cleanup(); }
});

test('the time is this computer\'s clock as YYYY-MM-DD HH:MM:SS', () => {
  assert.equal(stamp(new Date(2026, 0, 5, 3, 4, 5)), '2026-01-05 03:04:05');
});

test('the transcript is no part of a support report: the log list takes logs by name and drops any with "transcript" in the name', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dev-transcript-report-'));
  try {
    const state = join(directory, 'state'), runtime = join(directory, 'runtime'), modRoot = join(directory, 'mod'), game = join(directory, 'game');
    for (const folder of [state, runtime, modRoot, game]) await mkdir(folder, {recursive: true});
    await writeFile(join(state, TRANSCRIPT_FILE), 'V: private words');
    await writeFile(join(state, `${TRANSCRIPT_FILE}.1`), 'V: more private words');
    await writeFile(join(runtime, TRANSCRIPT_FILE), 'V: private words');
    const rows = await locateLogs({game, modRoot, runtime, stateDirectory: state});
    assert.deepEqual(rows.filter(row => /transcript/i.test(basename(row.path)) || /transcript/i.test(row.id)), []);
  } finally { await rm(directory, {recursive: true, force: true}); }
});

test('the bridge wires it: updated on the settings poll from developerMode, recorded where a reply is published (both paths), and the secrets it scrubs are the keys', () => {
  const source = readFileSync(new URL('./convai-bridge.mjs', import.meta.url), 'utf8');
  assert.match(source, /new DevTranscript\(\{path: resolve\(stateDirectory, TRANSCRIPT_FILE\), secrets: \(\) => \[\.\.\.keys\.secrets\(\), \.\.\.mistral\.secrets\(\)\]/);
  assert.match(source, /devTranscript\.update\(settings\)/);
  assert.equal((source.match(/recordDevTurn\(input, profile, result\);/g) ?? []).length, 2, 'the continuous path and the ordinary path');
  const body = source.slice(source.indexOf('function recordDevTurn'), source.indexOf('// Named places measured'));
  assert.match(body, /if \(!devTranscript\.enabled\) return;/, 'nothing is built while it is off');
  assert.match(body, /turnContextWhere\(/);
});
