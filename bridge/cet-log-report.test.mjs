// Cyber Engine Tweaks' own logs in the automatic reports of a setup problem or a Lua error (bridge/cet-log.mjs, bridge/error-reports.mjs).
// Temp folders only: nothing here reaches the network or a real game folder.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {gzipSync} from 'node:zlib';
import {PLANTED, plantedInstall} from './support-report-fixture.mjs';
import {CET_LOG_KINDS, MAX_BODY_BYTES, MAX_LOG_LINES, buildErrorPayload, captureLogs, logSourcesFor} from './error-reports.mjs';
import {cetLines} from './cet-log.mjs';
import {MAX_BODY_BYTES as MAIN_BACKEND_LIMIT} from '../auth-backend/api/_lib/errors.js';
import {MAX_BODY_BYTES as CLOUDFLARE_BACKEND_LIMIT} from '../auth-backend-cf/src/errors.js';

const INSTALL = '3f2a9c1e-7b44-4d0e-9a52-0c1d2e3f4a5b';
const START = Date.UTC(2026, 9, 30, 10, 0, 0);
const record = (kind, extra = {}) => ({signature: '139d68ca96ea376c', kind, count: 1, firstAt: START, lastAt: START, source: 'game',
  message: kind === 'lua-error' ? 'attempt to index a nil value' : 'nsui missing', frame: kind === 'lua-error' ? 'init.lua:150' : 'game-setup', stack: [], ...extra});
const build = (f, rec) => buildErrorPayload({record: rec, game: f.game, modRoot: f.modRoot, runtime: f.runtime, stateDirectory: f.state, project: f.project,
  installId: INSTALL, environment: {}, names: [PLANTED.windowsUser], now: () => START, graphics: () => [], systemFacts: () => ({})});
const sourcesOf = payload => payload.report.logs.map(item => item.source);

const CET_LOG = [
  '[2026-10-29 20:00:00 UTC+02:00] [info] [Options::Options] [1] CET version v1.38.1 [HEAD]',
  '[2026-10-29 20:00:01 UTC+02:00] [info] [ModManager] [1] Loaded mod AppearanceMenuMod',
  '[2026-10-29 20:00:01 UTC+02:00] [info] [ModManager] [1] Loaded mod ModConfigurationMenuAPI',
  '[2026-10-29 20:00:02 UTC+02:00] [error] [ScriptContext] [1] Mod nativeSettings failed to load: init.lua:12: attempt to index a nil value (global \'GetVersion\')',
  '[2026-10-29 20:00:02 UTC+02:00] [warning] [ScriptContext] [1] Mod XUtils took 4 s to initialise',
  '[2026-10-29 20:00:03 UTC+02:00] [info] [ModManager] [1] Loaded mod Emoting',
  '',
].join('\n');

test('the lines of a CET log that can explain something are kept, the routine ones are not', () => {
  const kept = cetLines(CET_LOG.split('\n'));
  assert.equal(kept.length, 3);
  assert.ok(kept.some(line => /failed to load/.test(line)) && kept.some(line => /\[warning\]/.test(line)) && kept.some(line => /ModConfigurationMenuAPI/.test(line)));
  assert.ok(!kept.some(line => /Loaded mod AppearanceMenuMod|Loaded mod Emoting|CET version/.test(line)), 'routine lines are dropped');
  assert.deepEqual(cetLines(undefined), []);
  assert.deepEqual(cetLines([42, null, 'Native Settings UI registered']), ['Native Settings UI registered']);
});

test('a setup problem and a Lua error carry CET\'s log and scripting log, redacted; other kinds do not', async () => {
  const f = await plantedInstall();
  try {
    await writeFile(join(f.cet, 'cyber_engine_tweaks.log'), CET_LOG + `[2026-10-29 20:00:04 UTC+02:00] [error] [Options] [1] Root path "C:\\Users\\${PLANTED.windowsUser}\\mods" key ${PLANTED.shortKey}\n`);
    await writeFile(join(f.cet, 'scripting.log'), `[2026-10-29 20:00:05 UTC+02:00] [1] [nativeSettings] error: could not register (${PLANTED.windowsUser})\n[2026-10-29 20:00:06 UTC+02:00] [1] hello world\n`);
    for (const kind of CET_LOG_KINDS) {
      const {payload, body} = await build(f, record(kind));
      assert.deepEqual(sourcesOf(payload).filter(id => id === 'cet' || id === 'cet-scripting'), ['cet', 'cet-scripting']);
      const cet = payload.report.logs.find(item => item.source === 'cet'), scripting = payload.report.logs.find(item => item.source === 'cet-scripting');
      assert.ok(cet.lines.some(line => /Mod nativeSettings failed to load/.test(line)), 'the line that explains "nsui missing" is there');
      assert.ok(!cet.lines.some(line => /Loaded mod Emoting/.test(line)));
      assert.deepEqual(scripting.lines.length, 1, 'only the line that can explain something');
      for (const [name, value] of Object.entries(PLANTED)) assert.ok(!body.includes(value), `planted ${name} got out`);
      assert.ok(!body.includes(`Users\\${PLANTED.windowsUser}`) && !body.includes(`Users\\\\${PLANTED.windowsUser}`), 'the account name in a path is hidden');
    }
    for (const kind of ['turn-failed', 'voice-failed', 'slow-turn', 'bridge-exception']) {
      const {payload} = await build(f, record(kind, {message: 'x failed', frame: 'x.mjs:1'}));
      assert.ok(!sourcesOf(payload).some(id => id === 'cet' || id === 'cet-scripting'), kind);
    }
  } finally { await f.cleanup(); }
});

test('the CET sources take their lines from the other sources: still at most 150 lines, each line cut, and the body under the sender\'s cap and both backends\' limit', async () => {
  const f = await plantedInstall();
  try {
    const noisy = Array.from({length: 4000}, (_, index) => `[2026-10-29 20:00:00 UTC+02:00] [error] [ScriptContext] [1] Mod number${index} failed to load: ${'x'.repeat(900)}`).join('\n');
    await writeFile(join(f.cet, 'cyber_engine_tweaks.log'), noisy);
    await writeFile(join(f.cet, 'scripting.log'), noisy);
    await writeFile(join(f.state, 'bridge.stderr.log'), Array.from({length: 500}, (_, index) => `[Turn] line ${index} ${'y'.repeat(200)}`).join('\n'));
    await writeFile(join(f.state, 'bridge-service.log'), Array.from({length: 100}, (_, index) => `2026-10-29T10:00:00Z service ${index}`).join('\n'));
    await writeFile(join(f.runtime, 'probe.log'), Array.from({length: 100}, (_, index) => `2026-10-29T10:00:00Z probe ${index}`).join('\n'));
    const {payload, body} = await build(f, record('setup-problem'));
    const total = payload.report.logs.reduce((sum, item) => sum + item.lines.length, 0);
    assert.ok(total <= MAX_LOG_LINES, `${total} lines`);
    assert.equal(payload.report.logs.find(item => item.source === 'cet').lines.length, 20);
    assert.equal(payload.report.logs.find(item => item.source === 'cet-scripting').lines.length, 15);
    for (const item of payload.report.logs) for (const line of item.lines) assert.ok(line.length <= 306, `${item.source}: a line of ${line.length} characters`);
    assert.ok(Buffer.byteLength(body) <= MAX_BODY_BYTES);
    assert.ok(MAX_BODY_BYTES <= MAIN_BACKEND_LIMIT && MAX_BODY_BYTES <= CLOUDFLARE_BACKEND_LIMIT, 'the sender\'s cap is under both backends\' limit');
    assert.ok(gzipSync(body).length < 64 * 1024);
    // The shares of every kind add up to the same 150 lines.
    for (const kind of ['setup-problem', 'lua-error', 'turn-failed']) assert.equal(logSourcesFor(kind).reduce((sum, source) => sum + source.lines, 0), MAX_LOG_LINES, kind);
  } finally { await f.cleanup(); }
});

test('a record that waited keeps the CET lines of the moment it was seen, and a kept excerpt of another kind cannot smuggle CET lines in', async () => {
  const f = await plantedInstall();
  try {
    await writeFile(join(f.cet, 'cyber_engine_tweaks.log'), CET_LOG);
    const rec = record('setup-problem');
    const logs = await captureLogs({record: rec, game: f.game, modRoot: f.modRoot, runtime: f.runtime, stateDirectory: f.state, secrets: [], names: [PLANTED.windowsUser]});
    assert.ok(logs.some(item => item.source === 'cet'));
    // The log changes before the report is sent: the kept lines are the ones sent.
    await writeFile(join(f.cet, 'cyber_engine_tweaks.log'), '[2026-10-30 09:00:00 UTC+02:00] [error] [X] [1] something later\n');
    const kept = await build(f, {...rec, logs});
    assert.ok(kept.payload.report.logs.find(item => item.source === 'cet').lines.some(line => /nativeSettings failed to load/.test(line)));
    assert.ok(!JSON.stringify(kept.payload.report.logs).includes('something later'));
    // The queue file is the player's to edit: a turn-failed record with a cet source loses it.
    const edited = await build(f, record('turn-failed', {message: 'x failed', frame: 'x.mjs:1', logs: [{source: 'cet', lines: ['planted line']}, {source: 'service', lines: ['fine']}]}));
    assert.deepEqual(edited.payload.report.logs, [{source: 'service', lines: ['fine']}]);
  } finally { await f.cleanup(); }
});
