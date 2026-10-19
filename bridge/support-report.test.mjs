import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile, readdir, writeFile, stat, mkdir, rm} from 'node:fs/promises';
import {join, parse} from 'node:path';
import {createZip, readZip, crc32} from './zip-writer.mjs';
import {createRedactor, tailFile, pruneReports, buildReport, collectReport, credentialSecrets,
  SupportReportControl, parseReportRequest, parseClipboardRequest, publishSupportPaths, locateLogs, localAiSection, shortHash,
  REPORT_KEEP, REPORT_NAME, LUA_REPORT_NAME, reportsDirectoryFor, LOG_MAX_LINES, LOG_MAX_BYTES} from './support-report.mjs';
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
    const judyRow = summary.providers.companions.find(row => row.profile === 'judy-alvarez');
    assert.deepEqual(judyRow.relationshipStyle, {mode: 'auto', style: 'ordinary', status: 'ready'});
    assert(!('relationshipVariant' in judyRow));
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

test('the launcher log is found in the released plugin folder, with the old development folder as a fallback', async () => {
  const f = await fakeInstall();
  try {
    const launcherPath = async () => (await locateLogs({game: f.game, modRoot: f.modRoot, runtime: f.runtime})).find(row => row.id === 'launcher').path;
    const released = join(f.game, 'red4ext', 'plugins', 'AiNpcCyberpunkMod', 'launcher.log');
    const old = join(f.game, 'red4ext', 'plugins', 'CyberpunkConvaiLauncher', 'launcher.log');
    assert.equal(await launcherPath(), released, 'neither exists: the released folder is where it will appear');
    await writeFile(old, 'old');
    assert.equal(await launcherPath(), old, 'only the old folder has one');
    await mkdir(join(f.game, 'red4ext', 'plugins', 'AiNpcCyberpunkMod'), {recursive: true});
    await writeFile(released, `2026-10-18 10:00:00 Game directory: C:\\Users\\${PLANTED.windowsUser}\\Games`);
    assert.equal(await launcherPath(), released, 'both exist: the released folder wins');
    const report = await collectReport({game: f.game, runtime: f.runtime, stateDirectory: f.state, project: f.project, reportId: 'r-launcher'});
    const entry = report.entries.find(row => /-launcher\.txt$/.test(row.name));
    assert(entry && entry.data.includes('Game directory') && !entry.data.includes(PLANTED.windowsUser), 'the launcher log is in the report, redacted');
  } finally { await f.cleanup(); }
});

test('the report shows Local AI detection from whitelisted state fields, the pack root and the manifests, and no key fields', async () => {
  const f = await fakeInstall();
  try {
    const packRoot = join(f.project, 'local-ai');
    await mkdir(packRoot, {recursive: true});
    for (const name of ['manifest.standard.json', 'manifest.mature-lite.json', 'manifest.txt']) await writeFile(join(packRoot, name), '{}');
    await writeFile(join(f.runtime, 'mistral-state.json'), JSON.stringify({
      version: 1, provider: 'local', effective: 'local', saved: true, tail: PLANTED.shortKey.slice(-4), apiKey: PLANTED.hexKey,
      localAi: 'not-installed', maturePack: true,
      localModels: [{id: 'bonsai-8b', name: 'Bonsai 8B', sizeMiB: 4631.4, file: `C:\\Users\\${PLANTED.windowsUser}\\secret.gguf`, token: PLANTED.hfToken}],
    }));
    const section = await localAiSection({runtime: f.runtime, project: f.project, environment: {}});
    assert.equal(section.localAi, 'not-installed'); assert.equal(section.maturePack, true);
    assert.deepEqual(section.localModels, [{id: 'bonsai-8b', name: 'Bonsai 8B', sizeMiB: 4631}]);
    assert.equal(section.root, packRoot); assert.equal(section.rootExists, true);
    assert.deepEqual(section.manifests, ['manifest.mature-lite.json', 'manifest.standard.json']);
    const chosen = join(f.base, 'elsewhere');
    const overridden = await localAiSection({runtime: f.runtime, project: f.project, environment: {CYBERPUNK_CONVAI_LOCAL_AI: chosen}});
    assert.equal(overridden.root, chosen); assert.equal(overridden.rootExists, false); assert.deepEqual(overridden.manifests, []);
    assert.equal(overridden.rootSource, 'CYBERPUNK_CONVAI_LOCAL_AI');

    const report = await collectReport({game: f.game, runtime: f.runtime, stateDirectory: f.state, project: f.project,
      reportId: 'r-local', environment: {}, secrets: [PLANTED.hexKey]});
    const text = report.entries.map(row => row.data).join('\n');
    for (const planted of [PLANTED.hexKey, PLANTED.hfToken, PLANTED.windowsUser, 'secret.gguf']) assert(!text.includes(planted), `${planted} leaked`);
    assert.equal(report.summary.localAi.localAi, 'not-installed');
    assert.equal(report.summary.localAi.localModels[0].name, 'Bonsai 8B');
    assert.equal(Object.keys(report.summary.localAi).some(key => /key|token|provider|effective|saved|tail/i.test(key)), false);
    // No state file yet (first start): the section says so instead of failing.
    await rm(join(f.runtime, 'mistral-state.json'));
    const missing = await localAiSection({runtime: f.runtime, project: f.project, environment: {}});
    assert.equal(missing.state, 'absent'); assert.equal(missing.localAi, null); assert.equal(missing.localModels, null);
    // The install ships the status files empty: that is no state yet too, not an unreadable file.
    await writeFile(join(f.runtime, 'mistral-state.json'), '');
    const placeholder = await localAiSection({runtime: f.runtime, project: f.project, environment: {}});
    assert.equal(placeholder.state, 'absent'); assert.equal(placeholder.localAi, null);
    await writeFile(join(f.runtime, 'bridge-service.json'), '');
    const empty = await collectReport({game: f.game, runtime: f.runtime, stateDirectory: f.state, project: f.project, reportId: 'r-empty', environment: {}});
    assert.equal(empty.summary.bridge.status['bridge-service.json'].state, 'absent');
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

test('Copy report path asks the service to copy only a report file path, once per request, and never raises', async () => {
  const f = await fakeInstall();
  try {
    const clipboardPath = join(f.runtime, 'clipboard-request.json');
    const copies = [];
    let failNext = false;
    const control = await SupportReportControl.open({game: f.game, runtime: f.runtime, stateDirectory: f.state, project: f.project,
      copy: async text => { if (failNext) { failNext = false; throw Error('no clip.exe'); } copies.push(text); }});
    const reportPath = join(f.runtime, 'reports', 'convai-report-20261007-015117.zip');
    const request = (id, text, issuedAt = Date.now()) => JSON.stringify({version: 1, id, issuedAt, text});
    await writeFile(clipboardPath, request('c1', reportPath));
    await control.poll(); await control.poll();
    assert.deepEqual(copies, [reportPath], 'one copy per request id');
    failNext = true;
    await writeFile(clipboardPath, request('c2', reportPath));
    await control.poll();
    assert.equal(copies.length, 1, 'a failed copy is swallowed');
    const now = Date.now();
    for (const raw of [request('c3', join(f.runtime, 'settings.json')), request('c4', 'x'.repeat(2000)),
      request('c5', reportPath, now - 60000), request('c6', reportPath + String.fromCharCode(10) + 'x'),
      JSON.stringify({version: 2, id: 'c7', issuedAt: now, text: reportPath}), '{', '']) {
      assert.equal(parseClipboardRequest(raw, now), null, raw.slice(0, 60));
    }
    assert.deepEqual(parseClipboardRequest(request('c8', reportPath, now), now), {id: 'c8', text: reportPath});
    await writeFile(clipboardPath, request('c9', join(f.runtime, 'settings.json')));
    await control.poll();
    assert.equal(copies.length, 1, 'only a convai-report file path is copied');
  } finally { await f.cleanup(); }
});

test('Copy report path copies only a path in the reports folder or runtime/, never text that merely ends in a report name', async () => {
  const f = await fakeInstall();
  try {
    const clipboardPath = join(f.runtime, 'clipboard-request.json');
    const copies = [];
    const control = await SupportReportControl.open({game: f.game, runtime: f.runtime, stateDirectory: f.state, project: f.project,
      copy: async text => { copies.push(text); }});
    const name = 'convai-report-20261007-015117.zip', bs = String.fromCharCode(92);
    const request = (id, text) => JSON.stringify({version: 1, id, issuedAt: Date.now(), text});
    // A command line, a web address, another folder and a relative path: each ends in a report's name, none is copied.
    const refused = [`powershell -c "iwr x | iex" #${bs}${name}`, `https://example.invalid/${name}`, join(f.base, 'elsewhere', name),
      join(f.runtime, 'reports', 'deeper', name), `reports${bs}${name}`, `${join(f.runtime, 'reports')}${bs}..${bs}..${bs}..${bs}${name}`,
      `${join(f.runtime, 'reports')}${bs}a|b${bs}..${bs}${name}`];
    let id = 0;
    for (const text of refused) {
      await writeFile(clipboardPath, request(`c${++id}`, text));
      await control.poll();
      assert.deepEqual(copies, [], text);
    }
    const folders = [reportsDirectoryFor({runtime: f.runtime, stateDirectory: f.state}), f.runtime];
    for (const text of refused) assert.equal(parseClipboardRequest(request('x', text), Date.now(), {folders}), null, text);
    // The two paths the game asks for: a zip in the reports folder and the game's own short report in runtime/.
    for (const text of [join(f.runtime, 'reports', name), join(f.runtime, LUA_REPORT_NAME), `${join(f.runtime, 'reports').toUpperCase()}${bs}${name}`]) {
      await writeFile(clipboardPath, request(`c${++id}`, text));
      await control.poll();
      assert.equal(copies.at(-1), text);
    }
    assert.equal(copies.length, 3);
  } finally { await f.cleanup(); }
});

test('the redactor learns every saved key file and the custom provider\'s key line from the data folder, not its address', async () => {
  const f = await fakeInstall();
  try {
    // Built at run time: a key-shaped literal in the repository trips push protection.
    const custom = 'test' + 'v'.repeat(28), mistral = 'test' + 'y'.repeat(28), inworld = 'test' + 'u'.repeat(28);
    await f.put(join(f.state, 'player-custom-endpoint.txt'), `# saved by Settings\nendpoint=https://example.invalid/api/v1\nmodel=vendor/model:free\napi-key="${custom}"\n`);
    await f.put(join(f.state, 'player-mistral-key.txt'), `api-key=${mistral}\n`);
    await f.put(join(f.state, 'player-inworld-key.txt'), `api-key=${inworld}\n`);
    const found = await credentialSecrets(f.state);
    for (const value of [custom, mistral, inworld]) assert(found.includes(value), value.slice(0, 6));
    assert(!found.some(value => /example\.invalid|vendor\/model/.test(value)), 'the address and the model id are not secrets');
    await f.put(join(f.state, 'bridge.stderr.log'), `[Custom] host example.invalid answered for ${custom} and ${mistral} and ${inworld}\n`);
    const {entries} = await collectReport({game: f.game, runtime: f.runtime, stateDirectory: f.state, project: f.project,
      request: {id: 'r-keys', issuedAt: Date.now()}, secrets: []});
    const text = entries.map(entry => entry.data).join('\n');
    for (const value of [custom, mistral, inworld]) assert(!text.includes(value), value.slice(0, 6));
    assert(text.includes('[Custom] host example.invalid answered for [secret-redacted]'));
  } finally { await f.cleanup(); }
});

test('zip reports go to <data home>/reports when the service data folder is <data home>/data, and stay in runtime/reports otherwise', async () => {
  const f = await fakeInstall();
  try {
    const home = join(f.base, 'LocalAppData', 'AiNpcCyberpunkMod'), state = join(home, 'data');
    await mkdir(state, {recursive: true});
    // The service's own data folder: the data home is its parent.
    assert.equal(reportsDirectoryFor({runtime: f.runtime, stateDirectory: state}), join(home, 'reports'));
    // Development (state in the project's runtime/), no state, and data/ kept in the mod folder after a deferred move: the old place.
    for (const stateDirectory of [f.state, undefined, null, join(f.modRoot, 'data'), join(f.base, 'data-copy'), join(parse(f.base).root, 'data')]) {
      assert.equal(reportsDirectoryFor({runtime: f.runtime, stateDirectory}), join(f.runtime, 'reports'), String(stateDirectory));
    }
    const control = await SupportReportControl.open({game: f.game, runtime: f.runtime, stateDirectory: state, project: f.project});
    // The Help page reads the published location; Lua cannot see %LOCALAPPDATA%.
    const paths = JSON.parse(await readFile(join(f.runtime, 'support-paths.json'), 'utf8'));
    assert.equal(paths.reports, join(home, 'reports'));
    assert.equal(paths.stateDirectory, state);
    const built = await buildReport({game: f.game, runtime: f.runtime, stateDirectory: state, project: f.project, request: {id: 'r', issuedAt: 0}});
    assert.equal(built.path, join(home, 'reports', built.name));
    assert((await stat(built.path)).size === built.bytes);
    await assert.rejects(stat(join(f.runtime, 'reports')), {code: 'ENOENT'}, 'nothing is created under the game folder');
    // Through the service: the ready result names the file outside the game folder, and only the newest five stay there.
    const requestPath = join(f.runtime, 'report-request.json'), resultPath = join(f.runtime, 'report-result.json');
    await writeFile(requestPath, JSON.stringify({version: 1, id: 'r-home', issuedAt: Date.now(), lua: {}}));
    await control.poll();
    const result = JSON.parse(await readFile(resultPath, 'utf8'));
    assert.equal(result.state, 'ready');
    assert(result.path.startsWith(join(home, 'reports')) && !result.path.startsWith(f.game), result.path);
    for (let index = 0; index < 7; index++) {
      await buildReport({game: f.game, runtime: f.runtime, stateDirectory: state, project: f.project, request: {id: 'r', issuedAt: 0},
        now: () => new Date(2026, 9, 5, 14, 0, index).getTime()});
    }
    assert((await readdir(join(home, 'reports'))).filter(name => REPORT_NAME.test(name)).length <= REPORT_KEEP);
    await assert.rejects(stat(join(f.runtime, 'reports')), {code: 'ENOENT'});
    control.close();
  } finally { await f.cleanup(); }
});

test('without a data home the zip reports are written to runtime/reports as before, and support-paths.json says so', async () => {
  const f = await fakeInstall();
  try {
    const built = await buildReport({game: f.game, runtime: f.runtime, stateDirectory: f.state, project: f.project, request: {id: 'r', issuedAt: 0}});
    assert.equal(built.path, join(f.runtime, 'reports', built.name));
    const published = await publishSupportPaths({game: f.game, modRoot: f.modRoot, runtime: f.runtime, stateDirectory: f.state});
    assert.equal(published.reports, join(f.runtime, 'reports'));
    assert.equal(JSON.parse(await readFile(join(f.runtime, 'support-paths.json'), 'utf8')).reports, join(f.runtime, 'reports'));
  } finally { await f.cleanup(); }
});

test('empty exchange files are read as missing: no report, no copy, no result written, and nothing is removed', async () => {
  const f = await fakeInstall();
  try {
    const names = ['report-request.json', 'report-result.json', 'clipboard-request.json', 'support-paths.json'];
    for (const name of names) await writeFile(join(f.runtime, name), '');
    const copies = [];
    let builds = 0;
    const control = await SupportReportControl.open({game: f.game, runtime: f.runtime, stateDirectory: f.state, project: f.project,
      copy: async text => { copies.push(text); }, build: async () => { builds++; throw Error('must not build'); }});
    // open() publishes the paths over the shipped empty file, in place.
    assert.equal(JSON.parse(await readFile(join(f.runtime, 'support-paths.json'), 'utf8')).version, 1);
    for (let round = 0; round < 3; round++) await control.poll();
    assert.equal(builds, 0); assert.deepEqual(copies, []);
    assert.equal(await readFile(join(f.runtime, 'report-result.json'), 'utf8'), '', 'no result is written for no request');
    for (const name of names) assert((await stat(join(f.runtime, name))).isFile(), `${name} is still there`);
    // The request then overwrites the empty file and is answered as usual.
    await writeFile(join(f.runtime, 'report-request.json'), JSON.stringify({version: 1, id: 'r-empty', issuedAt: Date.now(), lua: {}}));
    await control.poll();
    assert.equal(builds, 1);
    assert.equal(JSON.parse(await readFile(join(f.runtime, 'report-result.json'), 'utf8')).id, 'r-empty');
    control.close();
    assert.equal(parseReportRequest('', Date.now()), null); assert.equal(parseClipboardRequest('', Date.now()), null);
  } finally { await f.cleanup(); }
});

test('Copy report path also accepts the fixed short report written by the game, and nothing else new', () => {
  const now = Date.now();
  const bs = String.fromCharCode(92), mod = ['E:', 'Game', 'bin', 'x64', 'plugins', 'cyber_engine_tweaks', 'mods', 'AiNpcCyberpunkMod', 'runtime'].join(bs);
  const ask = text => parseClipboardRequest(JSON.stringify({version: 1, id: 'c1', issuedAt: now, text}), now);
  assert.deepEqual(ask(`${mod}${bs}${LUA_REPORT_NAME}`), {id: 'c1', text: `${mod}${bs}${LUA_REPORT_NAME}`});
  assert.equal(LUA_REPORT_NAME, 'convai-report-lua.txt');
  assert.equal(REPORT_NAME.test(LUA_REPORT_NAME), false, 'pruning never matches the fixed file');
  for (const name of ['convai-report-lua.txt.bak', 'convai-report-lua.zip', 'settings.json', 'xconvai-report-lua.txt']) {
    assert.equal(ask(`${mod}${bs}${name}`), null, name);
  }
});

test('a service that never started because no browser was found says so plainly at the top of the report', async () => {
  const f = await plantedInstall();
  try {
    const make = () => collectReport({game: f.game, runtime: f.runtime, stateDirectory: f.state, project: f.project,
      request: {id: 'r-browser', issuedAt: Date.now()}, secrets: []});
    const quiet = await make();
    assert(!('problems' in quiet.summary) && !quiet.entries[0].data.includes('PROBLEM'), 'no problem line without the failure');
    await f.put(join(f.runtime, 'bridge-service.json'), JSON.stringify({state: 'failed', code: 'browser-missing', updated: Date.now()}));
    const {summary, entries} = await make();
    assert.equal(Object.keys(summary)[1], 'problems', 'listed first, before the versions');
    assert.match(summary.problems[0], /Chromium browser such as Microsoft Edge[^]*browser-missing/);
    const readme = entries.find(entry => entry.name === 'README.txt').data;
    assert(readme.indexOf('PROBLEM FOUND') > 0 && readme.indexOf('PROBLEM FOUND') < readme.indexOf('Send this one file'), 'the README states it before the contents list');
    await f.put(join(f.runtime, 'bridge-service.json'), JSON.stringify({state: 'failed', code: 'missing-key', updated: Date.now()}));
    assert(!('problems' in (await make()).summary), 'only the browser fault is reported this way');
  } finally { await f.cleanup(); }
});

test('the report names the graphics card and its memory, at most eight cards, and a failing lookup never stops the report', async () => {
  const f = await plantedInstall();
  try {
    const make = graphics => collectReport({game: f.game, runtime: f.runtime, stateDirectory: f.state, project: f.project,
      request: {id: 'r-gpu', issuedAt: Date.now()}, secrets: [], graphics});
    const {summary, entries} = await make(async () => [{name: 'NVIDIA GeForce RTX 4070 Laptop GPU', memoryMiB: 8188.4}, {name: 'Intel(R) UHD Graphics', memoryMiB: null}]);
    assert.deepEqual(summary.system, {graphics: [{name: 'NVIDIA GeForce RTX 4070 Laptop GPU', memoryMiB: 8188}, {name: 'Intel(R) UHD Graphics', memoryMiB: null}]});
    assert(Object.keys(summary).indexOf('system') > Object.keys(summary).indexOf('versions'), 'the card is listed beside the versions');
    assert.match(entries.find(entry => entry.name === 'README.txt').data, /summary\.json {3}versions, graphics card, service status, setup check/);
    // hostile values: no name, a long name, a negative or text size, more than eight cards
    const many = Array.from({length: 12}, (_, index) => ({name: `Card ${index}`, memoryMiB: 1024}));
    assert.equal((await make(async () => many)).summary.system.graphics.length, 8);
    const odd = (await make(async () => [{name: ''}, {name: 'x'.repeat(500), memoryMiB: -5}, {name: 'Radeon', memoryMiB: 'lots'}, null, 'text'])).summary.system.graphics;
    assert.deepEqual(odd, [{name: 'x'.repeat(120), memoryMiB: null}, {name: 'Radeon', memoryMiB: null}]);
    // nothing found, a rejected lookup and a value that is not a list
    assert.deepEqual((await make(async () => [])).summary.system, {graphics: []});
    assert.deepEqual((await make(async () => { throw new Error('reg.exe is not here'); })).summary.system, {graphics: []});
    assert.deepEqual((await make(() => 'none')).summary.system, {graphics: []});
    // the Windows account name in a card's name is removed like anywhere else
    const named = (await make(async () => [{name: `Card in C:\\Users\\${PLANTED.windowsUser}\\x`, memoryMiB: 1}])).summary.system.graphics[0].name;
    assert(!named.includes(PLANTED.windowsUser), named);
  } finally { await f.cleanup(); }
});

test('the control hands its graphics source to the report it builds, and the zip names the card', async () => {
  const f = await plantedInstall();
  try {
    const requestPath = join(f.runtime, 'report-request.json'), resultPath = join(f.runtime, 'report-result.json');
    let handed;
    const control = await SupportReportControl.open({game: f.game, runtime: f.runtime, stateDirectory: f.state, project: f.project,
      secrets: () => [], knownIds: () => [], bridge: () => ({busy: false}), graphics: async () => [{name: 'AMD Radeon RX 7800 XT', memoryMiB: 16368}],
      build: async options => { handed = options.graphics; return buildReport(options); }});
    await writeFile(requestPath, JSON.stringify({version: 1, id: 'r1800000000-1', issuedAt: Date.now(), lua: {view: 'help', party: []}}));
    await control.poll();
    assert.equal(typeof handed, 'function');
    const result = JSON.parse(await readFile(resultPath, 'utf8'));
    assert.equal(result.state, 'ready');
    const summary = JSON.parse((await zipText(result.path)).find(entry => entry.name === 'summary.json').text);
    assert.deepEqual(summary.system, {graphics: [{name: 'AMD Radeon RX 7800 XT', memoryMiB: 16368}]});
    control.close();
  } finally { await f.cleanup(); }
});

test('setup problems found this session are listed at the top of the report; those from an earlier session or another process are not', async () => {
  const f = await plantedInstall();
  try {
    const now = Date.now();
    const document = (checks, extra = {}) => JSON.stringify({version: 1, updated: now, bridgePid: process.pid, request: null, checks, ...extra});
    const make = (request = {}) => collectReport({game: f.game, runtime: f.runtime, stateDirectory: f.state, project: f.project,
      request: {id: 'r-setup', issuedAt: now, ...request}, secrets: [], graphics: async () => [], now: () => now});
    const file = join(f.runtime, 'setup-check.json');
    assert(!('problems' in (await make()).summary), 'no setup document, no problem');
    await f.put(file, document([{id: 'versions', state: 'problem', code: 'mismatch', scripts: '0.2', runtime: '0.2.1'},
      {id: 'packs', state: 'problem', code: 'nested', nested: [{pack: 'OmniVoice', folder: 'AI-NPC-OmniVoice-0.2.1'}, {pack: 'Mature lite', folder: 'x'}]},
      {id: 'internet', state: 'problem', code: 'blocked', service: 'mistral', host: 'api.mistral.ai'},
      {id: 'gpu', state: 'ok', code: 'found', name: 'NVIDIA'}, {id: 'browser', state: 'ok', code: 'found', name: 'Edge'}]));
    let {summary, entries} = await make();
    assert.deepEqual(summary.problems, ['Setup check: versions mismatch (Scripts 0.2, Runtime 0.2.1)',
      'Setup check: packs nested (OmniVoice in AI-NPC-OmniVoice-0.2.1, Mature lite in x)', 'Setup check: internet blocked (mistral: api.mistral.ai)']);
    assert.equal(Object.keys(summary)[1], 'problems');
    assert(entries.find(entry => entry.name === 'README.txt').data.includes('PROBLEM FOUND:\n  Setup check: versions mismatch'));
    assert(summary.bridge.status['setup-check.json']?.value, 'the document is among the status files');
    // a missing browser is already told by the service status: not twice
    await f.put(join(f.runtime, 'bridge-service.json'), JSON.stringify({state: 'failed', code: 'browser-missing', updated: now}));
    await f.put(file, document([{id: 'browser', state: 'problem', code: 'missing'}]));
    ({summary} = await make());
    assert.equal(summary.problems.length, 1);
    assert.match(summary.problems[0], /browser-missing/);
    await rm(join(f.runtime, 'bridge-service.json'), {force: true});
    // another process's document counts for ten minutes only; this process's, always
    await f.put(file, document([{id: 'files', state: 'problem', code: 'missing'}], {bridgePid: process.pid + 1, updated: now - 11 * 60 * 1000}));
    assert(!('problems' in (await make()).summary), 'an old document of another process says nothing about now');
    await f.put(file, document([{id: 'files', state: 'problem', code: 'missing'}], {bridgePid: process.pid + 1, updated: now - 60 * 1000}));
    assert.deepEqual((await make()).summary.problems, ['Setup check: files missing']);
    await f.put(file, document([{id: 'files', state: 'problem', code: 'missing'}], {updated: now - 3 * 60 * 60 * 1000}));
    assert.deepEqual((await make()).summary.problems, ['Setup check: files missing'], 'this bridge process is still running');
    // wrong shapes are ignored
    for (const wrong of ['', 'not json', '[]', JSON.stringify({version: 1, checks: 'no'}), JSON.stringify({version: 1, updated: now, bridgePid: process.pid, checks: [null, 5, {id: 7}, {id: 'x'}]})]) {
      await f.put(file, wrong);
      assert(!('problems' in (await make()).summary), wrong);
    }
  } finally { await f.cleanup(); }
});

test('the game side checks the Help page sends are kept short, at most 24 rows, and a problem among them is listed', async () => {
  const f = await plantedInstall();
  try {
    const now = Date.now();
    const setup = [{id: 'tweakxl', state: 'problem', code: 'missing'}, {id: 'codeware', state: 'ok', code: 'found', version: '1.20.5'},
      {id: 'row of words '.repeat(10), state: 'bad state '.repeat(10), code: 'a long code '.repeat(20), version: 'version words '.repeat(10), extra: 'dropped'}, ...Array.from({length: 40}, (_, index) => ({id: `row${index}`, state: 'ok', code: 'found'}))];
    const {summary} = await collectReport({game: f.game, runtime: f.runtime, stateDirectory: f.state, project: f.project,
      request: {id: 'r-lua', issuedAt: now, lua: {cetVersion: '1.37.1', setup}}, secrets: [], graphics: async () => [], now: () => now});
    assert.equal(summary.request.setup.length, 24);
    assert.deepEqual(summary.request.setup[0], {id: 'tweakxl', state: 'problem', code: 'missing', version: undefined});
    assert.deepEqual(summary.request.setup[1], {id: 'codeware', state: 'ok', code: 'found', version: '1.20.5'});
    assert.deepEqual(Object.keys(summary.request.setup[2]).sort(), ['code', 'id', 'state', 'version']);
    assert(summary.request.setup[2].id.length <= 40 && summary.request.setup[2].state.length <= 20 && summary.request.setup[2].code.length <= 60 && summary.request.setup[2].version.length <= 40 && summary.request.setup[2].code.length > 30);
    assert.equal(summary.problems[0], 'Setup check (game): tweakxl missing');
    // no setup rows, a request of another shape
    for (const lua of [{}, {setup: 'text'}, {setup: null}, {setup: [null, 3, 'x']}]) {
      const result = await collectReport({game: f.game, runtime: f.runtime, stateDirectory: f.state, project: f.project,
        request: {id: 'r-lua2', issuedAt: now, lua}, secrets: [], graphics: async () => [], now: () => now});
      assert(!('problems' in result.summary), JSON.stringify(lua));
    }
  } finally { await f.cleanup(); }
});
