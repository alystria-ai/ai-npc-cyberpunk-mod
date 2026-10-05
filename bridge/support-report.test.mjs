import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile, readdir, writeFile, stat, mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {createZip, readZip, crc32} from './zip-writer.mjs';
import {createRedactor, tailFile, pruneReports, buildReport, collectReport, credentialSecrets,
  SupportReportControl, parseReportRequest, publishSupportPaths, locateLogs, shortHash,
  REPORT_KEEP, LOG_MAX_LINES, LOG_MAX_BYTES} from './support-report.mjs';
import {PLANTED, VECTORS, fakeInstall, plantedInstall} from './support-report-fixture.mjs';

const zipText = async path => readZip(await readFile(path)).map(entry => ({name: entry.name, text: entry.data.toString('utf8')}));
const everything = entries => entries.map(entry => `${entry.name}\n${entry.text}`).join('\n');
const wait = ms => new Promise(done => setTimeout(done, ms));

test('zip writer round-trips text and binary, is verifiable and refuses unsafe names', () => {
  const binary = Buffer.from(Array.from({length: 3000}, (_, index) => index * 7 % 256));
  const archive = createZip([{name: 'a.txt', data: 'hello hello hello hello'}, {name: 'logs/b.bin', data: binary},
    {name: 'empty.txt', data: ''}]);
  const back = readZip(archive);
  assert.deepEqual(back.map(entry => entry.name), ['a.txt', 'logs/b.bin', 'empty.txt']);
  assert.equal(back[0].data.toString(), 'hello hello hello hello');
  assert(back[1].data.equals(binary) && back[2].data.length === 0);
  assert.equal(crc32(Buffer.from('123456789')), 0xCBF43926);
  for (const name of ['../x.txt', '/abs.txt', 'a\\b.txt', 'a/../b.txt', 'C:/x.txt', '', 'a b.txt', 'A.txt']) {
    if (name === 'A.txt') continue;
    assert.throws(() => createZip([{name, data: 'x'}]), /Invalid ZIP entry name/, name);
  }
  assert.throws(() => createZip([{name: 'a.txt', data: 'x'}, {name: 'A.TXT', data: 'y'}]), /Invalid ZIP entry name/);
  const damaged = Buffer.from(archive); damaged[40] ^= 0xFF;
  assert.throws(() => readZip(damaged));
});

test('redactor removes every planted secret pattern and leaves ordinary log text alone', () => {
  const redact = createRedactor();
  for (const vector of VECTORS) {
    const output = redact.text(vector.input);
    for (const gone of vector.gone ?? []) assert(!output.includes(gone), `${gone} survived in: ${output}`);
    for (const keep of vector.keep ?? []) assert(output.includes(keep), `${keep} was lost from: ${output}`);
  }
});

test('known secrets are scrubbed even where no pattern would catch them, and IDs become stable short hashes', () => {
  const redact = createRedactor({secrets: [PLANTED.shortKey, '  padded-secret-value  '], ids: ['character-slug-0001']});
  const text = redact.text(`bare ${PLANTED.shortKey} and padded-secret-value and character-slug-0001`);
  assert(!text.includes(PLANTED.shortKey) && !text.includes('padded-secret-value') && !text.includes('character-slug-0001'));
  assert(text.includes(`[id:${shortHash('character-slug-0001')}]`));
  const again = redact.text(`id ${PLANTED.userId}`), other = redact.text(`id ${PLANTED.userId}`);
  assert.equal(again, other, 'the same ID always gets the same hash');
  assert.match(again, /\[id:[0-9a-f]{8}\]/);
  assert.notEqual(redact.text(`id ${PLANTED.userId}`), redact.text(`id ${PLANTED.characterId}`));
  // Short strings are never treated as secrets, so ordinary words are not erased.
  assert.equal(createRedactor({secrets: ['abc']}).text('abc def'), 'abc def');
});

test('structured values are redacted by key name as well as by content', () => {
  const redact = createRedactor({secrets: [PLANTED.shortKey]});
  const value = redact.value({apiKey: 'visible-but-secret', accessToken: 'tok-123456', authorization: 'Bearer zzzzzzzz',
    endUserId: PLANTED.userId, characterId: PLANTED.characterId, sessionId: 'plain-session', count: 5, ok: true,
    nested: {note: `see ${PLANTED.shortKey}`, list: [{password: 'pw-value-1'}]}, voiceProvider: 'omni'});
  const text = JSON.stringify(value);
  for (const gone of ['visible-but-secret', 'tok-123456', 'zzzzzzzz', PLANTED.userId, PLANTED.characterId, 'plain-session',
    PLANTED.shortKey, 'pw-value-1']) assert(!text.includes(gone), `${gone} survived: ${text}`);
  assert(value.count === 5 && value.ok === true && value.voiceProvider === 'omni');
  assert.match(value.endUserId, /^\[id:[0-9a-f]{8}\]$/);
});

test('log tails are bounded by lines and bytes, drop a cut first line and collapse progress bars', async () => {
  const f = await fakeInstall();
  try {
    const big = join(f.runtime, 'big.log');
    await writeFile(big, Array.from({length: 6000}, (_, index) => `line ${index}`).join('\n') + '\n');
    const tail = await tailFile(big);
    assert.equal(tail.lines.length, LOG_MAX_LINES);
    assert.equal(tail.lines.at(-1), 'line 5999');
    assert.equal(tail.truncated, true);
    const huge = join(f.runtime, 'huge.log');
    await writeFile(huge, 'x'.repeat(100) + '\n' + 'y'.repeat(3 * 1024 * 1024) + '\nlast line\n');
    const bytes = await tailFile(huge);
    assert(bytes.lines.join('\n').length <= LOG_MAX_BYTES + 200 * bytes.lines.length, 'bounded by bytes');
    assert.equal(bytes.lines.at(-1), 'last line');
    assert(bytes.lines[0].length <= 1100, 'a very long line is truncated');
    const bars = join(f.runtime, 'bars.log');
    await writeFile(bars, ['start', ...Array.from({length: 50}, (_, i) => `Loading weights: ${i}%| | ${i}/100 [00:01, 5.0it/s]`), 'done', ''].join('\r'));
    const collapsed = await tailFile(bars);
    assert.equal(collapsed.lines.length, 3);
    assert.equal(collapsed.lines[0], 'start');
    assert.equal(await tailFile(join(f.runtime, 'missing.log')), null);
    assert.equal(await tailFile(f.runtime), null, 'a directory is not a log');
  } finally { await f.cleanup(); }
});

test('the report holds versions, settings, party, providers, recent errors and bounded redacted logs, and nothing planted', async () => {
  const f = await plantedInstall();
  try {
    const request = {id: 'r-test-1', issuedAt: Date.now(), lua: {cetVersion: 'v1.99.0', language: 'en', view: 'help',
      party: [{profile: 'bob-sagan', name: 'Bob Sagan', state: 'following'}, {profile: 'judy-alvarez', state: 'ready'}]}};
    const result = await buildReport({game: f.game, runtime: f.runtime, stateDirectory: f.state, project: f.project,
      request, secrets: [], knownIds: [PLANTED.characterId], bridge: {busy: false}});
    assert(result.path.startsWith(join(f.runtime, 'reports')) && /convai-report-\d{8}-\d{6}\.zip$/.test(result.path));
    assert(result.bytes > 1000 && (await stat(result.path)).size === result.bytes);
    const entries = await zipText(result.path);
    // Only these entries can exist, so credentials, audio and chat text cannot be in a report.
    for (const entry of entries) assert.match(entry.name, /^(?:README\.txt|summary\.json|logs\/\d\d-[a-z0-9-]+\.txt)$/, entry.name);
    const all = everything(entries);
    for (const [name, value] of Object.entries(PLANTED)) assert(!all.includes(value), `planted ${name} appears in the report`);
    assert(!all.toLowerCase().includes('planted conversation'), 'conversation text appears');
    const summary = JSON.parse(entries.find(entry => entry.name === 'summary.json').text);
    assert.equal(summary.schema, 1);
    assert.equal(summary.versions.cet, 'v1.99.0');
    assert.equal(summary.versions.game.product, '2.31');
    assert.equal(summary.versions.red4ext, '1.30.0');
    assert.match(summary.versions.mod.fingerprint, /^[0-9a-f]{12}$/);
    assert.equal(summary.request.cetVersion, 'v1.99.0');
    assert.equal(summary.settings.voiceProvider, 'omni');
    assert.deepEqual(summary.settings.conversationDisabled, ['judy-alvarez']);
    assert.equal(summary.settings.conversationEnabledCount, 1);
    assert(!('apiKey' in summary.settings) || summary.settings.apiKey === '[redacted]');
    assert.deepEqual(summary.party.companions.map(row => row.profile), ['bob-sagan', 'judy-alvarez']);
    const bob = summary.providers.companions.find(row => row.profile === 'bob-sagan');
    assert.equal(bob.voice, 'omni'); assert.equal(bob.conversation, 'convai-realtime');
    assert.equal(summary.providers.companions.find(row => row.profile === 'judy-alvarez').voice, 'convai');
    assert.equal(summary.providers.companions.find(row => row.profile === 'judy-alvarez').relationshipVariant.variant, 'ordinary');
    assert(summary.providers.companions.find(row => row.profile === 'judy-alvarez').conversationEnabled === false);
    assert(summary.recentErrors.some(row => row.source === 'bridge-stderr' && /provider disconnected/.test(row.line)));
    assert(summary.recentErrors.some(row => row.source === 'redscript' && /Cannot resolve type/.test(row.line)));
    const ids = summary.logs.map(row => row.id);
    for (const expected of ['probe', 'mcm', 'mod-log', 'bridge-stderr', 'bridge-stdout', 'launcher', 'cet', 'cet-scripting', 'redscript', 'red4ext']) {
      assert(ids.includes(expected), `log ${expected} listed`);
    }
    const stderr = entries.find(entry => /-bridge-stderr.txt$/.test(entry.name));
    assert(stderr, 'bridge stderr log is in the zip');
    const lines = stderr.text.split('\n');
    assert(lines.length <= LOG_MAX_LINES + 6, `bounded (${lines.length})`);
    assert(stderr.text.includes('Error: provider disconnected') && !stderr.text.includes('routine line 100\n'));
    assert(stderr.text.includes('<user>'), 'the Windows account name is hidden');
    assert(summary.privacy.redactions.ids >= 1 && summary.privacy.redactions.paths >= 1);
  } finally { await f.cleanup(); }
});

test('credential files are only scrub lists: never read into the report even when they are the only secret source', async () => {
  const f = await plantedInstall();
  try {
    const secrets = await credentialSecrets(f.state);
    assert(secrets.includes(PLANTED.shortKey) && secrets.includes(PLANTED.hfToken) && secrets.includes(PLANTED.kaggle));
    const {entries} = await collectReport({game: f.game, runtime: f.runtime, stateDirectory: f.state, project: f.project,
      request: {id: 'r-x', issuedAt: Date.now()}, secrets: []});
    const all = entries.map(entry => `${entry.name}\n${entry.data}`).join('\n');
    for (const value of [PLANTED.shortKey, PLANTED.hfToken, PLANTED.kaggle]) assert(!all.includes(value));
    assert(!entries.some(entry => /convai-key|huggingface|kaggle/i.test(entry.name)));
    // The bare short key in probe.log (no pattern) was removed by the scrub list.
    assert(all.includes('[secret-redacted]'));
  } finally { await f.cleanup(); }
});

test('a planted key in a log and in settings never appears in the report, with or without the key file', async () => {
  const f = await plantedInstall();
  try {
    await mkdir(join(f.runtime, 'reports'), {recursive: true});
    for (const withKeyFile of [true, false]) {
      const state = withKeyFile ? f.state : join(f.base, 'empty-state');
      await mkdir(state, {recursive: true});
      const result = await buildReport({game: f.game, runtime: f.runtime, stateDirectory: state, project: f.project,
        request: {id: 'r-y', issuedAt: Date.now()}, secrets: [PLANTED.shortKey], now: () => Date.now() + (withKeyFile ? 0 : 2000)});
      const all = everything(await zipText(result.path));
      assert(!all.includes(PLANTED.shortKey), `short key leaked (key file: ${withKeyFile})`);
      assert(!all.includes(PLANTED.hexKey), 'hex key leaked');
    }
  } finally { await f.cleanup(); }
});

test('only the five newest reports are kept and unrelated files are never removed', async () => {
  const f = await fakeInstall();
  try {
    const folder = join(f.runtime, 'reports');
    await mkdir(folder, {recursive: true});
    const names = [];
    for (let index = 1; index <= 8; index++) names.push(`convai-report-20261005-12000${index}${index % 2 ? '' : '-lua'}.${index % 2 ? 'zip' : 'txt'}`);
    for (const name of [...names, 'notes.txt', 'convai-report-latest.zip', 'convai-report-20261005-120000-extra.log']) await writeFile(join(folder, name), 'x');
    const removed = await pruneReports(folder);
    assert.deepEqual(removed, names.slice(0, 3));
    const left = (await readdir(folder)).sort();
    assert.deepEqual(left, [...names.slice(3), 'convai-report-20261005-120000-extra.log', 'convai-report-latest.zip', 'notes.txt'].sort());
    assert.equal(REPORT_KEEP, 5);
    // A real build prunes as well.
    for (let index = 0; index < 4; index++) {
      await buildReport({game: f.game, runtime: f.runtime, stateDirectory: f.state, project: f.project, request: {id: 'r', issuedAt: 0},
        now: () => new Date(2026, 9, 5, 13, 0, index).getTime()});
    }
    const reports = (await readdir(folder)).filter(name => /^convai-report-\d{8}-\d{6}\.zip$/.test(name));
    assert(reports.length + (await readdir(folder)).filter(name => /^convai-report-\d{8}-\d{6}-lua\.txt$/.test(name)).length <= 5);
  } finally { await f.cleanup(); }
});

test('request parsing accepts only a well-formed version 1 request', () => {
  const now = Date.now();
  const ok = parseReportRequest(JSON.stringify({version: 1, id: 'r1800000000-1', issuedAt: now, lua: {view: 'help'}}), now);
  assert.equal(ok.id, 'r1800000000-1');
  for (const bad of ['', '{', '[]', 'null', JSON.stringify({version: 2, id: 'a', issuedAt: now}),
    JSON.stringify({version: 1, id: '../../x', issuedAt: now}), JSON.stringify({version: 1, id: 'a b', issuedAt: now}),
    JSON.stringify({version: 1, id: 'a', issuedAt: 'now'}), JSON.stringify({version: 1, id: 'x'.repeat(65), issuedAt: now}),
    JSON.stringify({version: 1, id: 'a', issuedAt: now, lua: 'x'.repeat(20000)})]) {
    assert.equal(parseReportRequest(bad, now), null, bad.slice(0, 40));
  }
});

test('bridge running: a new request produces one zip and a ready result with its path; old and repeated requests do not', async () => {
  const f = await plantedInstall();
  try {
    const requestPath = join(f.runtime, 'report-request.json'), resultPath = join(f.runtime, 'report-result.json');
    const stale = {version: 1, id: 'old-session', issuedAt: Date.now() - 1000, lua: {}};
    await writeFile(requestPath, JSON.stringify(stale));
    let builds = 0, midBuild;
    const control = await SupportReportControl.open({game: f.game, runtime: f.runtime, stateDirectory: f.state, project: f.project,
      secrets: () => [PLANTED.shortKey], knownIds: () => [PLANTED.characterId], bridge: () => ({busy: false}),
      build: async options => {
        builds++;
        midBuild = JSON.parse(await readFile(resultPath, 'utf8'));
        return buildReport(options);
      }});
    // The path list for the Help page is published when the service starts.
    const paths = JSON.parse(await readFile(join(f.runtime, 'support-paths.json'), 'utf8'));
    assert.equal(paths.gameRoot, f.game); assert.equal(paths.reports, join(f.runtime, 'reports'));
    assert.equal(paths.logs.launcher.path, join(f.game, 'red4ext', 'plugins', 'CyberpunkConvaiLauncher', 'launcher.log'));
    assert.equal(paths.logs['bridge-stderr'].path, join(f.state, 'bridge.stderr.log'));
    assert.equal(paths.logs['bridge-stderr'].exists, true); assert.equal(paths.logs['mod-log'].exists, true);
    await control.poll();
    assert.equal(builds, 0, 'a request left by an earlier session is not replayed');
    const request = {version: 1, id: 'r1800000000-7', issuedAt: Date.now(), lua: {cetVersion: 'v1.99.0', view: 'help', party: []}};
    await writeFile(requestPath, JSON.stringify(request));
    await control.poll();
    assert.equal(builds, 1);
    assert.deepEqual({id: midBuild.id, state: midBuild.state}, {id: request.id, state: 'building'});
    const result = JSON.parse(await readFile(resultPath, 'utf8'));
    assert.equal(result.version, 1); assert.equal(result.id, request.id); assert.equal(result.state, 'ready'); assert.equal(result.mode, 'bridge');
    assert(result.path.startsWith(join(f.runtime, 'reports')) && result.path.endsWith(result.fileName));
    assert((await stat(result.path)).size === result.bytes);
    const all = everything(await zipText(result.path));
    assert(!all.includes(PLANTED.shortKey) && !all.includes(PLANTED.characterId));
    await control.poll(); await writeFile(requestPath, JSON.stringify(request)); await control.poll();
    assert.equal(builds, 1, 'the same request id builds once');
    await writeFile(requestPath, JSON.stringify({...request, id: 'r1800000000-8', issuedAt: Date.now() - 600000}));
    await control.poll();
    assert.equal(builds, 1, 'an expired request is ignored');
    await writeFile(requestPath, '{"version":1,"id":"half');
    await control.poll(); assert.equal(builds, 1, 'a half-written request waits for the rest');
    await writeFile(requestPath, JSON.stringify({...request, id: 'r1800000000-9', issuedAt: Date.now()}));
    await control.poll(); assert.equal(builds, 2);
    assert.equal(JSON.parse(await readFile(resultPath, 'utf8')).id, 'r1800000000-9');
    control.close();
    await writeFile(requestPath, JSON.stringify({...request, id: 'r1800000000-10', issuedAt: Date.now()}));
    await control.poll(); assert.equal(builds, 2, 'a closed control does nothing');
  } finally { await f.cleanup(); }
});

test('bridge running but the report cannot be built: the result says failed with a code, never a path or text', async () => {
  const f = await fakeInstall();
  try {
    const requestPath = join(f.runtime, 'report-request.json'), resultPath = join(f.runtime, 'report-result.json');
    const control = await SupportReportControl.open({game: f.game, runtime: f.runtime, stateDirectory: f.state, project: f.project,
      build: async () => { throw Object.assign(Error(`secret detail ${PLANTED.shortKey}`), {code: 'write-failed'}); }});
    await writeFile(requestPath, JSON.stringify({version: 1, id: 'r-fail', issuedAt: Date.now(), lua: {}}));
    await control.poll();
    const result = JSON.parse(await readFile(resultPath, 'utf8'));
    assert.deepEqual({id: result.id, state: result.state, code: result.code}, {id: 'r-fail', state: 'failed', code: 'write-failed'});
    assert(!JSON.stringify(result).includes(PLANTED.shortKey) && !('path' in result));
  } finally { await f.cleanup(); }
});

test('log locations prefer the first existing candidate and report where a missing log will appear', async () => {
  const f = await fakeInstall();
  try {
    await mkdir(join(f.state, 'logs'), {recursive: true});
    await writeFile(join(f.state, 'logs', 'bridge.stderr.log'), 'packaged layout');
    await writeFile(join(f.state, 'bridge.stdout.log'), 'development layout');
    const logs = Object.fromEntries((await locateLogs({game: f.game, modRoot: f.modRoot, runtime: f.runtime, stateDirectory: f.state})).map(row => [row.id, row.path]));
    assert.equal(logs['bridge-stderr'], join(f.state, 'logs', 'bridge.stderr.log'));
    assert.equal(logs['bridge-stdout'], join(f.state, 'bridge.stdout.log'));
    assert.equal(logs['bridge-service'], join(f.state, 'bridge-service.log'), 'a missing log reports its expected place');
    assert.match(logs.red4ext, /red4ext-<date>\.log$/);
    const none = await locateLogs({game: f.game, modRoot: f.modRoot, runtime: f.runtime});
    assert(!none.some(row => row.id.startsWith('bridge-')), 'no state folder, no service log rows');
    const written = await publishSupportPaths({game: f.game, modRoot: f.modRoot, runtime: f.runtime, stateDirectory: f.state});
    assert.equal(written.logs['bridge-stderr'].exists, true);
  } finally { await f.cleanup(); }
});

test('the bridge starts the report service and installs it in the package plan', async () => {
  const source = await readFile(new URL('./convai-bridge.mjs', import.meta.url), 'utf8');
  assert(source.includes("import {SupportReportControl} from './support-report.mjs'"));
  assert(/SupportReportControl\.open\(\{game, runtime, stateDirectory, project,/.test(source));
  assert(/setInterval\(\(\) => \{ void supportReport\.poll\(\)/.test(source));
  assert(/clearInterval\(supportTimer\); supportReport\.close\(\)/.test(source));
  const {BRIDGE_MODULES} = await import('../packaging/runtime-layout.mjs');
  for (const module of ['bridge/support-report.mjs', 'bridge/zip-writer.mjs']) assert(BRIDGE_MODULES.includes(module), module);
});
