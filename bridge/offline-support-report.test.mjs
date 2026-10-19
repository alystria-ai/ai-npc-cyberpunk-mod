import {test} from 'node:test';
import assert from 'node:assert/strict';
import {copyFile, mkdtemp, mkdir, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {readZip} from './zip-writer.mjs';
import {packKey} from './key-codec.mjs';
import {REPORT_NAME} from './support-report.mjs';
import {PLANTED} from './support-report-fixture.mjs';
import {dataHomeFor} from '../packaging/runtime/state-home.mjs';
import {importClosure} from '../packaging/lib/closure.mjs';
import {MO2_HINT, REQUIREMENTS, checkRequirements, dataHomeRoot, enabledMods, fallbackReports, iniValue, locateOfflineLogs, offlineProblems,
  openInExplorer, parseArgs, pluginVersions, resolveOfflineLayout, runOfflineReport} from './offline-support-report.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = dirname(here);
// Fake secrets are made at run time, never written out as literals (a key-shaped string trips GitHub push protection).
const SECRET_PLAYER = 'test' + 'x'.repeat(28), SECRET_MISTRAL = 'test' + 'y'.repeat(28), SECRET_SHARED = 'test' + 'z'.repeat(28), SECRET_AUTH = 'test' + 'w'.repeat(28);
const SECRET_CUSTOM = 'test' + 'v'.repeat(28);
const CHAT = 'PLANTED CONVERSATION TEXT about the heist';
const USER = 'PlantedPlayerName';

const REQUIRED_FILES = [
  'bin/x64/Cyberpunk2077.exe', 'bin/x64/winmm.dll', 'bin/x64/plugins/cyber_engine_tweaks.asi', 'red4ext/RED4ext.dll', 'engine/tools/scc.exe',
  'red4ext/plugins/Codeware/Codeware.dll', 'red4ext/plugins/TweakXL/TweakXL.dll', 'red4ext/plugins/audioware/audioware.dll',
  'red4ext/plugins/ArchiveXL/ArchiveXL.dll',
  'bin/x64/plugins/cyber_engine_tweaks/mods/ModConfigurationMenuAPI/init.lua', 'r6/scripts/ModConfigurationMenu/UI/MCMContent.reds',
];
const MOD = 'bin/x64/plugins/cyber_engine_tweaks/mods/AiNpcCyberpunkMod';
const PLUGIN = 'red4ext/plugins/AiNpcCyberpunkMod';
const OURS = [`${MOD}/init.lua`, `${MOD}/manager.lua`, `${PLUGIN}/CyberpunkConvai.dll`, `${PLUGIN}/launcher.ini`, `${PLUGIN}/launcher.log`,
  `${PLUGIN}/app/node/node.exe`, `${PLUGIN}/app/bridge/convai-bridge.mjs`, `${PLUGIN}/app/bridge/make-support-report.mjs`, 'r6/scripts/CyberpunkConvai/Manager.reds'];

const CORE_LUA = '-- Mod Configuration Menu\nlocal PUBLIC_VERSION = "0.10.3"\nreturn {}\n';
const RED4EXT_LOG = [
  '[2026-10-19 04:31:33.208] [info    ] [ 26456] [RED4ext] RED4ext (v1.30.0) is initializing...',
  '[2026-10-19 04:31:33.209] [info    ] [ 26456] [RED4ext] Product version: 2.31',
  '[2026-10-19 04:31:35.397] [info    ] [ 26456] [RED4ext] ArchiveXL (version: 1.27.4, author(s): psiberx) has been loaded',
  '[2026-10-19 04:31:35.946] [info    ] [ 26456] [RED4ext] audioware (version: 1.9.9-rc.0, author(s): Roms1383) has been loaded',
  '[2026-10-19 04:31:36.737] [info    ] [ 26456] [RED4ext] Codeware (version: 1.20.5, author(s): psiberx) has been loaded',
  '[2026-10-19 04:31:36.897] [info    ] [ 26456] [RED4ext] TweakXL (version: 1.11.4, author(s): psiberx) has been loaded', ''].join('\n');
const CET_LOG = ['[2026-10-18 10:00:00 UTC] [info] CET version v1.32.3 [HEAD]', '[2026-10-19 10:00:00 UTC] [info] CET version v1.37.1 [HEAD]', ''].join('\n');
const REDSCRIPT_OK = '[INFO - Mon, 19 Oct 2026 04:31:49 +0530] Compilation complete\n';

/** A temporary folder with helpers for writing files into it. */
async function workspace() {
  const base = await mkdtemp(join(tmpdir(), 'offline report '));
  const put = async (path, text = '') => { await mkdir(dirname(path), {recursive: true}); await writeFile(path, text); return path; };
  return {base, put, cleanup: () => rm(base, {recursive: true, force: true}), at: (...parts) => join(base, ...parts)};
}

/**
 * A complete install under <base>/Cyberpunk 2077: every requirement, this mod's three pieces, logs, and a data folder under a fake
 * %LOCALAPPDATA% (<base>/local). `without` lists game-relative files or folders to leave out.
 */
async function healthyInstall({without = [], logs = true, extra = {}} = {}) {
  const w = await workspace();
  const game = w.at('Cyberpunk 2077'), local = w.at('local');
  const skip = path => without.some(name => path === name || path.startsWith(`${name}/`));
  const put = (relative, text = '') => skip(relative) ? null : w.put(join(game, ...relative.split('/')), text);
  for (const file of [...REQUIRED_FILES, ...OURS]) await put(file);
  await put(`${MOD}/release.json`, JSON.stringify({product: 'AI-NPC-Cyberpunk-Mod', package: 'scripts', version: '0.2.2'}));
  await put(`${PLUGIN}/app/release.json`, JSON.stringify({product: 'AI-NPC-Cyberpunk-Mod', package: 'runtime', version: '0.2.2'}));
  await put('bin/x64/plugins/cyber_engine_tweaks/mods/ModConfigurationMenuAPI/modules/core.lua', CORE_LUA);
  if (logs) {
    await put('bin/x64/plugins/cyber_engine_tweaks/cyber_engine_tweaks.log', CET_LOG);
    await put('bin/x64/plugins/cyber_engine_tweaks/scripting.log', `[info] script line\n`);
    await put('r6/logs/redscript_rCURRENT.log', REDSCRIPT_OK);
    await put('red4ext/logs/red4ext-2026-10-19-04-31-33.log', RED4EXT_LOG);
    await put('red4ext/logs/audioware-2026-10-19-04-31-33.log', '[info] audioware started\n');
    await put(`${MOD}/AiNpcCyberpunkMod.log`, 'mod log line\n');
    await put(`${MOD}/runtime/probe.log`, 'probe line\n');
  }
  for (const [relative, text] of Object.entries(extra)) await put(relative, text);
  const app = join(game, ...PLUGIN.split('/'), 'app');
  const env = {LOCALAPPDATA: local, TEMP: w.at('temp')};
  const outputs = [], opened = [];
  const run = (options = {}) => runOfflineReport({appDirectory: app, env, graphics: [], sharedObjects: [], stdout: {write: text => outputs.push(text)},
    open: path => opened.push(path), ...options});
  return {...w, game, local, app, env, outputs, opened, run, lines: () => outputs.join('').split('\n').filter(Boolean)};
}

const unzip = async path => readZip(await readFile(path)).map(entry => ({name: entry.name, text: entry.data.toString('utf8')}));
const summaryOf = entries => JSON.parse(entries.find(entry => entry.name === 'summary.json').text);
const readmeOf = entries => entries.find(entry => entry.name === 'README.txt').text;
const row = (summary, id) => summary.requirements.find(item => item.id === id);

test('a healthy install gives a report with every requirement present, versions where readable, and no PROBLEM line', async () => {
  const f = await healthyInstall();
  try {
    const result = await f.run();
    assert.equal(result.ok, true);
    // The same place the in-game report writes: <data home>/reports, and the same file name.
    assert.equal(dirname(result.path), join(f.local, 'AiNpcCyberpunkMod', 'reports'));
    assert.match(result.path.split(/[\\/]/).at(-1), REPORT_NAME);
    assert.deepEqual(f.opened, [result.path], 'Explorer is asked to show the file');
    // The player sees a working line and one result line naming the file and saying to send it.
    const lines = f.lines();
    assert.equal(lines.length, 2, lines.join('\n'));
    assert(lines[1].includes(result.path) && /send that file/i.test(lines[1]));
    const entries = await unzip(result.path);
    const summary = summaryOf(entries);
    assert.equal(summary.generatedBy, 'offline');
    assert.equal(summary.problems, undefined);
    assert.doesNotMatch(readmeOf(entries), /PROBLEM FOUND/);
    assert.match(readmeOf(entries), /made with the game closed/);
    assert.deepEqual(summary.requirements.map(item => item.id), REQUIREMENTS.map(item => item.id));
    assert(summary.requirements.every(item => item.state === 'present'), JSON.stringify(summary.requirements));
    const versions = Object.fromEntries(summary.requirements.map(item => [item.id, item.version]));
    assert.deepEqual(versions, {cet: 'v1.37.1', red4ext: '1.30.0', redscript: null, codeware: '1.20.5', tweakxl: '1.11.4', audioware: '1.9.9-rc.0',
      mcm: '0.10.3', archivexl: '1.27.4'});
    assert.equal(summary.modFiles.scripts.state, 'present');
    assert.equal(summary.modFiles.redscript.state, 'present');
    assert.equal(summary.modFiles.plugin.state, 'present');
    assert.deepEqual(summary.releases, {scripts: {found: true, version: '0.2.2'}, runtime: {found: true, version: '0.2.2'}, match: true});
    assert.equal(summary.offline.gameFolder.found, true);
    assert.deepEqual(summary.offline.mo2, {found: false});
    // The same logs the in-game report holds.
    const names = entries.map(entry => entry.name).filter(name => name.startsWith('logs/')).join(' ');
    for (const id of ['cet', 'cet-scripting', 'redscript', 'red4ext', 'audioware', 'launcher', 'mod-log', 'probe']) assert(names.includes(`-${id}.txt`), `${id} is in the report: ${names}`);
    // No service ran: no process of this tool is described as the bridge.
    assert.equal(summary.bridge.offline, true);
    assert.equal(summary.bridge.pid, undefined);
  } finally { await f.cleanup(); }
});

test('missing logs are not an error: the report is made and says which logs it did not find', async () => {
  const f = await healthyInstall({logs: false, without: [`${PLUGIN}/launcher.log`]});
  try {
    const result = await f.run();
    assert.equal(result.ok, true);
    const summary = summaryOf(await unzip(result.path));
    const logs = Object.fromEntries(summary.logs.map(entry => [entry.id, entry.found]));
    for (const id of ['cet', 'cet-scripting', 'redscript', 'red4ext', 'launcher', 'mod-log']) assert.equal(logs[id], false, id);
    // Versions that only a log can give are left empty; the files themselves are still found.
    assert.equal(row(summary, 'cet').state, 'present');
    assert.equal(row(summary, 'cet').version, null);
    assert.equal(row(summary, 'mcm').version, '0.10.3', 'the MCM version is read from its own file');
    assert.equal(summary.problems, undefined);
  } finally { await f.cleanup(); }
});

test('every missing requirement and every missing piece of this mod gets its own PROBLEM line', async () => {
  const f = await healthyInstall({without: ['red4ext/plugins/Codeware', 'red4ext/plugins/TweakXL', 'bin/x64/plugins/cyber_engine_tweaks/mods/ModConfigurationMenuAPI',
    'engine/tools/scc.exe', 'bin/x64/winmm.dll', 'red4ext/plugins/ArchiveXL', MOD, 'r6/scripts/CyberpunkConvai', `${PLUGIN}/CyberpunkConvai.dll`]});
  try {
    const result = await f.run();
    assert.equal(result.ok, true);
    const entries = await unzip(result.path);
    const summary = summaryOf(entries);
    const text = summary.problems.join('\n');
    assert.match(text, /Codeware is missing: red4ext\\plugins\\Codeware\\Codeware\.dll was not found/);
    assert.match(text, /TweakXL is missing: red4ext\\plugins\\TweakXL\\TweakXL\.dll was not found/);
    assert.match(text, /Mod Configuration Menu is incomplete: bin\\x64\\plugins\\cyber_engine_tweaks\\mods\\ModConfigurationMenuAPI\\init\.lua was not found/);
    assert.match(text, /redscript is missing: engine\\tools\\scc\.exe was not found/);
    assert.match(text, /RED4ext is incomplete: bin\\x64\\winmm\.dll was not found/);
    assert.match(text, /The mod's CET folder is missing: bin\\x64\\plugins\\cyber_engine_tweaks\\mods\\AiNpcCyberpunkMod\\init\.lua was not found/);
    assert.match(text, /The mod's redscript folder is missing: r6\\scripts\\CyberpunkConvai was not found/);
    assert.match(text, /The mod's RED4ext plugin is missing: red4ext\\plugins\\AiNpcCyberpunkMod\\CyberpunkConvai\.dll was not found/);
    assert(!/ArchiveXL/.test(text), 'ArchiveXL is optional: its absence is not a problem');
    assert.equal(row(summary, 'archivexl').state, 'absent');
    assert.equal(row(summary, 'codeware').state, 'missing');
    assert.equal(row(summary, 'mcm').state, 'incomplete', 'the reds half of MCM is still there');
    assert.equal(summary.problems.at(-1), MO2_HINT, 'a missing piece ends with the Mod Organizer 2 hint');
    assert.match(readmeOf(entries), /PROBLEM FOUND:\n {2}RED4ext is incomplete: bin\\x64\\winmm\.dll was not found\. Install it again\.\n {2}redscript is missing/);
    // A found game folder means the player is told only where the report is.
    assert.equal(f.lines().length, 2);
  } finally { await f.cleanup(); }
});

test('an empty reds folder, a half-extracted Runtime and mismatched package versions are each named', async () => {
  const f = await healthyInstall({without: ['r6/scripts/CyberpunkConvai/Manager.reds', `${PLUGIN}/app/node`, `${PLUGIN}/app/bridge/convai-bridge.mjs`]});
  try {
    await f.put(join(f.game, ...PLUGIN.split('/'), 'app', 'release.json'), JSON.stringify({package: 'runtime', version: '0.2.1'}));
    await mkdir(join(f.game, 'r6', 'scripts', 'CyberpunkConvai'), {recursive: true});
    const summary = summaryOf(await unzip((await f.run()).path));
    const text = summary.problems.join('\n');
    assert.match(text, /The mod's redscript folder is empty: r6\\scripts\\CyberpunkConvai has no \.reds files/);
    assert.match(text, /The Runtime package is incomplete: red4ext\\plugins\\AiNpcCyberpunkMod\\app\\node\\node\.exe was not found/);
    assert.match(text, /The Scripts package is 0\.2\.2 but the Runtime package is 0\.2\.1\. Install matching versions\./);
    assert.equal(summary.releases.match, false);
  } finally { await f.cleanup(); }
});

test('redscript errors from the last compile are counted in one PROBLEM line, without the Mod Organizer 2 hint', async () => {
  const f = await healthyInstall({extra: {'r6/logs/redscript_rCURRENT.log': [
    '[INFO - Mon, 19 Oct 2026 04:31:49 +0530] Compiling files in r6\\scripts:', '[ERROR - Mon, 19 Oct 2026 04:31:49 +0530] Type Foo not found',
    '[ERROR - Mon, 19 Oct 2026 04:31:49 +0530] Unknown function Bar', '[INFO - Mon, 19 Oct 2026 04:31:50 +0530] Compilation failed', ''].join('\n')}});
  try {
    const result = await f.run();
    const summary = summaryOf(await unzip(result.path));
    assert.deepEqual(summary.problems, ['redscript reported 2 error lines when it last compiled the scripts: see the redscript log in this report.']);
    assert(summary.recentErrors.some(item => item.source === 'redscript' && /Type Foo not found/.test(item.line)), 'the error lines are also in recentErrors');
  } finally { await f.cleanup(); }
});

test('started outside Mod Organizer 2 from a mod folder: the game is not found, it is said plainly with the hint, and nothing crashes', async () => {
  const w = await workspace();
  try {
    const app = w.at('MO2', 'mods', 'AI NPC Runtime', ...PLUGIN.split('/'), 'app');
    await w.put(join(app, 'bridge', 'make-support-report.mjs'));
    const outputs = [], opened = [];
    const result = await runOfflineReport({appDirectory: app, env: {LOCALAPPDATA: w.at('local'), TEMP: w.at('temp')}, graphics: [], sharedObjects: [],
      stdout: {write: text => outputs.push(text)}, open: path => opened.push(path)});
    assert.equal(result.ok, true);
    const lines = outputs.join('').split('\n').filter(Boolean);
    assert.equal(lines[0], 'Making the support report. This takes a few seconds.');
    assert(lines.some(line => /^The Cyberpunk 2077 folder was not found: .* has no bin\\x64\\Cyberpunk2077\.exe\./.test(line)), lines.join('\n'));
    assert(lines.includes(MO2_HINT), 'the hint is printed');
    assert(/send that file/.test(lines.at(-1)) && lines.at(-1).includes(result.path));
    const summary = summaryOf(await unzip(result.path));
    assert.equal(summary.offline.gameFolder.found, false);
    // What it could not search is "unknown", not "missing", and no per-requirement problem is claimed.
    assert(summary.requirements.every(item => item.state === 'unknown'), JSON.stringify(summary.requirements.map(item => item.state)));
    assert.equal(summary.problems.length, 2);
    // The report went to the data home, and nothing was created in the mod folder.
    assert.equal(dirname(result.path), w.at('local', 'AiNpcCyberpunkMod', 'reports'));
    assert.deepEqual(await readdir(join(app, '..')), ['app']);
  } finally { await w.cleanup(); }
});

test('without %LOCALAPPDATA% and without a mod folder, the report goes to the temporary folder instead of creating the mod folder', async () => {
  const w = await workspace();
  try {
    const app = w.at('game', ...PLUGIN.split('/'), 'app');
    await w.put(join(app, 'x.txt'));
    const env = {TEMP: w.at('temp')};
    const result = await runOfflineReport({appDirectory: app, env, graphics: [], sharedObjects: [], stdout: {write() {}}, open() {}});
    assert.equal(result.ok, true);
    assert.equal(dirname(result.path), fallbackReports(env));
    assert.deepEqual((await readdir(w.at('game'))).sort(), ['red4ext'], 'no CET mod folder was made');
  } finally { await w.cleanup(); }
});

/** Mod Organizer 2: <base>/MO2 holds ModOrganizer.ini, profiles, overwrite and mods; the game folder holds only the game. */
async function mo2Install({iniExtra = '', modlist, files = {}, overwrite = {}} = {}) {
  const w = await workspace();
  const game = w.at('Cyberpunk 2077'), instance = w.at('MO2'), mods = join(instance, 'mods');
  await w.put(join(game, 'bin', 'x64', 'Cyberpunk2077.exe'));
  const doubled = game.replace(/\\/g, '\\\\');
  await w.put(join(instance, 'ModOrganizer.ini'), `[General]\r\ngameName=Cyberpunk 2077\r\ngamePath=@ByteArray(${doubled})\r\nselected_profile=@ByteArray(Default)\r\n${iniExtra}`);
  if (modlist) await w.put(join(instance, 'profiles', 'Default', 'modlist.txt'), `# This file was automatically generated by Mod Organizer.\r\n${modlist}`);
  for (const [mod, list] of Object.entries(files)) for (const [relative, text] of Object.entries(list)) await w.put(join(mods, mod, ...relative.split('/')), text ?? '');
  for (const [relative, text] of Object.entries(overwrite)) await w.put(join(instance, 'overwrite', ...relative.split('/')), text ?? '');
  const app = join(mods, 'AI NPC Runtime', ...PLUGIN.split('/'), 'app');
  const env = {LOCALAPPDATA: w.at('local'), TEMP: w.at('temp')};
  return {...w, game, instance, mods, app, env};
}

const MO2_MODS = {
  'AI NPC Runtime': {[`${PLUGIN}/CyberpunkConvai.dll`]: '', [`${PLUGIN}/launcher.log`]: '', [`${PLUGIN}/app/node/node.exe`]: '', [`${PLUGIN}/app/bridge/convai-bridge.mjs`]: '',
    [`${PLUGIN}/app/release.json`]: JSON.stringify({version: '0.2.2'})},
  'AI NPC Scripts': {[`${MOD}/init.lua`]: '', [`${MOD}/release.json`]: JSON.stringify({version: '0.2.2'}), 'r6/scripts/CyberpunkConvai/Manager.reds': ''},
  Codeware: {'red4ext/plugins/Codeware/Codeware.dll': ''},
  'TweakXL (off)': {'red4ext/plugins/TweakXL/TweakXL.dll': ''},
  Audioware: {'red4ext/plugins/audioware/audioware.dll': ''},
  'Mod Configuration Menu': {'bin/x64/plugins/cyber_engine_tweaks/mods/ModConfigurationMenuAPI/init.lua': '', 'bin/x64/plugins/cyber_engine_tweaks/mods/ModConfigurationMenuAPI/modules/core.lua': CORE_LUA,
    'r6/scripts/ModConfigurationMenu/UI/MCMContent.reds': ''},
};
const MO2_GAME_FILES = {'bin/x64/winmm.dll': '', 'bin/x64/plugins/cyber_engine_tweaks.asi': '', 'red4ext/RED4ext.dll': '', 'engine/tools/scc.exe': ''};

test('Mod Organizer 2 layout: the game comes from ModOrganizer.ini, enabled mod folders and Overwrite are searched, a disabled mod is not', async () => {
  const f = await mo2Install({
    modlist: '+AI NPC Scripts\r\n+AI NPC Runtime\r\n+Codeware\r\n-TweakXL (off)\r\n+Audioware\r\n+Mod Configuration Menu\r\n*DLC\r\n',
    files: MO2_MODS,
    // The game wrote its logs into Overwrite, the mod's own log too (a partial copy of the mod folder, with no init.lua in it).
    overwrite: {'r6/logs/redscript_rCURRENT.log': REDSCRIPT_OK, 'red4ext/logs/red4ext-2026-10-19-04-31-33.log': RED4EXT_LOG,
      'bin/x64/plugins/cyber_engine_tweaks/cyber_engine_tweaks.log': CET_LOG, [`${MOD}/AiNpcCyberpunkMod.log`]: 'mod log line from Overwrite\n'}});
  for (const [relative, text] of Object.entries(MO2_GAME_FILES)) await f.put(join(f.game, ...relative.split('/')), text);
  try {
    const layout = await resolveOfflineLayout({appDirectory: f.app, env: f.env});
    assert.equal(layout.gameFound, true);
    assert.equal(layout.gameFromIni, true);
    assert.equal(layout.game, f.game);
    assert.equal(layout.mo2.profile, 'Default');
    assert.equal(layout.mo2.enabledOnly, true);
    assert.deepEqual(layout.roots.map(root => root.label), ['game folder', 'MO2 Overwrite', 'MO2 mod: AI NPC Scripts', 'MO2 mod: AI NPC Runtime',
      'MO2 mod: Codeware', 'MO2 mod: Audioware', 'MO2 mod: Mod Configuration Menu']);
    assert.equal(layout.modRoot, join(f.mods, 'AI NPC Scripts', ...MOD.split('/')));
    assert.equal(layout.plugin, join(f.mods, 'AI NPC Runtime', ...PLUGIN.split('/')));
    const logs = await locateOfflineLogs(layout);
    for (const id of ['cet', 'redscript', 'red4ext', 'mod-log']) assert(logs.find(entry => entry.id === id).path.startsWith(join(f.instance, 'overwrite')), `${id} comes from Overwrite`);

    const result = await runOfflineReport({appDirectory: f.app, env: f.env, graphics: [], sharedObjects: [], stdout: {write() {}}, open() {}});
    assert.equal(result.ok, true);
    const entries = await unzip(result.path);
    const summary = summaryOf(entries);
    assert(entries.some(entry => entry.name.startsWith('logs/') && entry.text.includes('mod log line from Overwrite')), "the mod's own log from Overwrite is in the report");
    assert.deepEqual(row(summary, 'codeware').foundIn, ['MO2 mod: Codeware']);
    assert.equal(row(summary, 'codeware').version, '1.20.5', 'the version comes from the RED4ext log in Overwrite');
    assert.equal(row(summary, 'mcm').version, '0.10.3');
    assert.equal(row(summary, 'tweakxl').state, 'missing', 'a disabled mod does not count');
    assert.match(summary.problems.join('\n'), /TweakXL is missing/);
    assert.equal(summary.problems.filter(line => /is missing|is incomplete/.test(line)).length, 1, summary.problems.join('\n'));
    assert.equal(summary.problems.at(-1), MO2_HINT);
    assert.equal(summary.modFiles.scripts.state, 'present');
    assert.equal(summary.modFiles.plugin.state, 'present');
    assert.equal(summary.offline.mo2.found, true);
    assert.equal(summary.offline.mo2.overwriteFound, true);
    assert(entries.some(entry => /^logs\/\d\d-redscript\.txt$/.test(entry.name)), 'the redscript log from Overwrite is in the report');
    assert.equal(summary.offline.gameFolder.namedBy, 'ModOrganizer.ini');
  } finally { await f.cleanup(); }
});

test('started through Mod Organizer 2 (usvfs is loaded) the hint is left out, and with no profile every mod folder is searched', async () => {
  const f = await mo2Install({files: MO2_MODS});
  for (const [relative, text] of Object.entries(MO2_GAME_FILES)) await f.put(join(f.game, ...relative.split('/')), text);
  try {
    const result = await runOfflineReport({appDirectory: f.app, env: f.env, graphics: [], stdout: {write() {}}, open() {},
      sharedObjects: ['C:\\Program Files\\Mod Organizer 2\\usvfs_x64.dll']});
    const summary = summaryOf(await unzip(result.path));
    assert.deepEqual(summary.offline.modManagers, ['mo2']);
    assert.equal(summary.offline.mo2.enabledModsOnly, false);
    assert.equal(row(summary, 'tweakxl').state, 'present', 'without a modlist every folder counts');
    assert.equal(summary.problems, undefined, 'nothing is missing and no hint is needed');
  } finally { await f.cleanup(); }
});

test('a Mod Organizer 2 folder with no ModOrganizer.ini above it is the plain "game not found" case', async () => {
  const f = await mo2Install({files: MO2_MODS});
  await rm(join(f.instance, 'ModOrganizer.ini'));
  try {
    const layout = await resolveOfflineLayout({appDirectory: f.app, env: f.env});
    assert.equal(layout.mo2, null);
    assert.equal(layout.gameFound, false);
    assert.equal(layout.roots.length, 1);
    // --game names the folder by hand.
    const named = await resolveOfflineLayout({appDirectory: f.app, game: f.game, env: f.env});
    assert.equal(named.gameFound, true);
    const fromEnvironment = await resolveOfflineLayout({appDirectory: f.app, env: {...f.env, CYBERPUNK_CONVAI_GAME: f.game}});
    assert.equal(fromEnvironment.game, f.game);
  } finally { await f.cleanup(); }
});

test('a normal install resolves from where the files are, with the data folder in %LOCALAPPDATA%, else in the mod folder', async () => {
  const f = await healthyInstall();
  try {
    const layout = await resolveOfflineLayout({appDirectory: f.app, env: f.env});
    assert.equal(layout.packaged, true);
    assert.equal(layout.game, f.game);
    assert.equal(layout.gameFound, true);
    assert.equal(layout.mo2, null);
    assert.equal(layout.modRoot, join(f.game, ...MOD.split('/')));
    assert.equal(layout.plugin, join(f.game, ...PLUGIN.split('/')));
    assert.equal(layout.project, f.app);
    assert.equal(layout.stateDirectory, join(f.local, 'AiNpcCyberpunkMod', 'data'), 'where it will be, even before the service made it');
    assert.equal(layout.stateExists, false);
    // A data folder left in the mod folder (a move that was put off) is used when the new one is not there.
    await mkdir(join(layout.modRoot, 'data'), {recursive: true});
    assert.equal((await resolveOfflineLayout({appDirectory: f.app, env: f.env})).stateDirectory, join(layout.modRoot, 'data'));
    await mkdir(join(f.local, 'AiNpcCyberpunkMod', 'data'), {recursive: true});
    assert.equal((await resolveOfflineLayout({appDirectory: f.app, env: f.env})).stateDirectory, join(f.local, 'AiNpcCyberpunkMod', 'data'));
    assert.equal((await resolveOfflineLayout({appDirectory: f.app, env: {}})).stateDirectory, join(layout.modRoot, 'data'), 'no %LOCALAPPDATA%');
  } finally { await f.cleanup(); }
});

test("the data folder rule is the launcher's own rule (packaging/runtime/state-home.mjs)", () => {
  const profile = 'C:\\Users\\Someone\\AppData\\Local';
  const cases = [{LOCALAPPDATA: profile}, {CYBERPUNK_CONVAI_DATA_HOME: 'D:\\Mod data', LOCALAPPDATA: profile},
    {CYBERPUNK_CONVAI_DATA_HOME: 'relative\\folder', LOCALAPPDATA: profile}, {CYBERPUNK_CONVAI_DATA_HOME: '', LOCALAPPDATA: 'D:\\L'},
    {LOCALAPPDATA: 'relative'}, {LOCALAPPDATA: ' C:\\padded'}, {}];
  for (const env of cases) assert.equal(dataHomeRoot(env), dataHomeFor(env).root, JSON.stringify(env));
});

test('planted secrets, conversation text and the Windows account name never reach the report', async () => {
  const f = await healthyInstall({logs: false});
  try {
    const data = join(f.local, 'AiNpcCyberpunkMod', 'data');
    // Credential files only the redactor may read: the player's own keys, the sign-in file and the key packed into the Runtime.
    await f.put(join(data, 'player-convai-key.txt'), `api-key=${SECRET_PLAYER}\n`);
    await f.put(join(data, 'player-mistral-key.txt'), `api-key=${SECRET_MISTRAL}\n`);
    await f.put(join(data, 'convai-auth.json'), JSON.stringify({enabled: true, url: 'https://example.invalid', secret: SECRET_AUTH}));
    // The custom provider's settings file: its key line is a secret; its address and model id are not.
    await f.put(join(data, 'player-custom-endpoint.txt'), `endpoint=https://example.invalid/v1\nmodel=vendor/model:free\napi-key=${SECRET_CUSTOM}\n`);
    await f.put(join(f.app, 'defaults', 'service.txt'), packKey(SECRET_SHARED));
    await f.put(join(data, 'huggingface-token.txt'), `${PLANTED.hfToken}\n`);
    const userPath = `C:\\Users\\${USER}\\Desktop\\Code Palace`;
    const dirty = [`[Bridge] starting in ${userPath}`, `Authorization: Bearer ${PLANTED.hexKey}`, `plain mention of ${SECRET_PLAYER} and ${SECRET_MISTRAL}`,
      `again ${SECRET_SHARED} then ${SECRET_AUTH}`, `[Custom] request with ${SECRET_CUSTOM} to example.invalid`, `hf ${PLANTED.hfToken}`, `session ${PLANTED.sessionId} user ${PLANTED.userId}`, 'error: the bridge failed to start', ''].join('\n');
    await f.put(join(f.game, ...MOD.split('/'), 'AiNpcCyberpunkMod.log'), dirty);
    await f.put(join(f.game, 'red4ext', 'logs', 'red4ext-2026-10-19-04-31-33.log'), dirty + RED4EXT_LOG);
    await f.put(join(data, 'bridge.stderr.log'), dirty);
    // Names that suggest what a player or a character said are never read.
    await f.put(join(f.game, ...MOD.split('/'), 'runtime', 'chat-history.log'), `${CHAT}\n`);
    await f.put(join(f.game, ...MOD.split('/'), 'runtime', 'voice-transcript.log'), `${CHAT}\n`);
    const result = await f.run();
    assert.equal(result.ok, true);
    const entries = await unzip(result.path);
    const everything = entries.map(entry => `${entry.name}\n${entry.text}`).join('\n');
    for (const [name, value] of Object.entries({SECRET_PLAYER, SECRET_MISTRAL, SECRET_SHARED, SECRET_AUTH, SECRET_CUSTOM, hfToken: PLANTED.hfToken, hexKey: PLANTED.hexKey,
      userId: PLANTED.userId, sessionId: PLANTED.sessionId, windowsUser: USER, chat: CHAT})) assert(!everything.includes(value), `${name} appears in the report`);
    assert(!entries.some(entry => /chat|transcript/i.test(entry.name)), 'no content-like log is listed');
    assert.match(everything, /\[secret-redacted\]/, 'the key values were scrubbed by value');
    assert(everything.includes('<user>'), 'the account name in a profile path is replaced');
    assert(everything.includes('the bridge failed to start'), 'ordinary log text is kept');
    assert(everything.includes('to example.invalid'), 'the custom endpoint\'s host is not a secret');
    const summary = summaryOf(entries);
    assert(summary.privacy.redactions.secrets >= 4, JSON.stringify(summary.privacy.redactions));
  } finally { await f.cleanup(); }
});

test('options: --game, --out and --no-open, in both spellings, and nothing else', () => {
  assert.deepEqual(parseArgs([]), {game: undefined, out: undefined, open: true});
  assert.deepEqual(parseArgs(['--game', 'D:\\Games\\Cyberpunk 2077', '--out', 'E:\\reports', '--no-open']), {game: 'D:\\Games\\Cyberpunk 2077', out: 'E:\\reports', open: false});
  assert.deepEqual(parseArgs(['--game=X', '--out=Y', '--bogus', 'stray']), {game: 'X', out: 'Y', open: true});
  assert.deepEqual(parseArgs(['--game']), {game: undefined, out: undefined, open: true}, 'a missing value is ignored');
});

test('--out is honoured, --no-open opens nothing, and a folder that cannot be written is a plain message, not a crash', async () => {
  const f = await healthyInstall();
  try {
    const out = f.at('out folder');
    const result = await f.run({argv: ['--out', out, '--no-open']});
    assert.equal(result.ok, true);
    assert.equal(dirname(result.path), out);
    assert.deepEqual(f.opened, []);
    // A file where the folder should be: nothing can be created there.
    const blocker = await f.put(f.at('blocker'), 'a file');
    f.outputs.length = 0;
    const failed = await f.run({argv: ['--out', join(blocker, 'inside'), '--no-open']});
    assert.equal(failed.ok, false);
    assert.match(f.lines().at(-1), /^The support report could not be made: /);
  } finally { await f.cleanup(); }
});

test('Explorer is started on the file with it selected, and a failure to start it is silent', () => {
  const calls = [];
  assert.equal(openInExplorer('C:\\Reports\\a b.zip', (file, args, options) => { calls.push({file, args, options}); return {on() {}, unref() {}}; }), true);
  assert.deepEqual(calls[0].args, ['/select,', 'C:\\Reports\\a b.zip']);
  assert.equal(calls[0].file, 'explorer.exe');
  assert.equal(calls[0].options.detached, true);
  assert.equal(openInExplorer('x', () => { throw Error('no explorer'); }), false);
});

test('ModOrganizer.ini values and modlist.txt lines are read the way MO2 writes them', () => {
  const ini = '[General]\r\ngameName=Cyberpunk 2077\r\ngamePath=@ByteArray(E:\\\\SteamLibrary\\\\steamapps\\\\common\\\\Cyberpunk 2077)\r\nselected_profile=@ByteArray(My Profile)\r\n'
    + '[Settings]\r\noverwrite_directory=%BASE_DIR%/overwrite\r\nquoted="D:\\\\x"\r\n';
  assert.equal(iniValue(ini, 'gamePath'), 'E:\\SteamLibrary\\steamapps\\common\\Cyberpunk 2077');
  assert.equal(iniValue(ini, 'selected_profile'), 'My Profile');
  assert.equal(iniValue(ini, 'overwrite_directory'), '%BASE_DIR%/overwrite');
  assert.equal(iniValue(ini, 'quoted'), 'D:\\x');
  assert.equal(iniValue(ini, 'absent'), null);
  assert.equal(iniValue(null, 'gamePath'), null);
  assert.deepEqual(enabledMods('# comment\r\n+One\r\n-Two\r\n*Unmanaged\r\n+Three Four\r\n\r\n+  \r\n'), ['One', 'Three Four']);
});

test('plugin versions are read from the RED4ext log lines and from nothing else', () => {
  const found = pluginVersions(RED4EXT_LOG + '[info] [RED4ext] Somebody (version: 9.9.9, author(s): x) mentioned\nCodeware (version: 0.0.1) outside the tag\n');
  assert.equal(found.red4ext, '1.30.0');
  assert.equal(found.plugins.get('codeware'), '1.20.5');
  assert.equal(found.plugins.get('tweakxl'), '1.11.4');
  assert.equal(found.plugins.get('audioware'), '1.9.9-rc.0');
  assert.equal(pluginVersions('').plugins.size, 0);
});

test('the problem lines are plain, short and one per piece; with no game folder only the game line and the hint are given', () => {
  const rows = [{id: 'codeware', name: 'Codeware', state: 'missing', missing: ['red4ext\\plugins\\Codeware\\Codeware.dll']}];
  const files = {scripts: {state: 'present', release: {}}, redscript: {state: 'present'}, plugin: {state: 'present', node: true, bridge: true, release: {}}};
  const layout = {gameFound: true, game: 'D:\\Games'};
  assert.deepEqual(offlineProblems({layout, rows, files}), ['Codeware is missing: red4ext\\plugins\\Codeware\\Codeware.dll was not found. Install it.', MO2_HINT]);
  assert.deepEqual(offlineProblems({layout, rows, files, managers: ['mo2']}), ['Codeware is missing: red4ext\\plugins\\Codeware\\Codeware.dll was not found. Install it.']);
  assert.deepEqual(offlineProblems({layout, rows: [], files}), []);
  const lost = offlineProblems({layout: {gameFound: false, game: 'D:\\Somewhere'}, rows, files});
  assert.equal(lost.length, 2);
  assert.match(lost[0], /^The Cyberpunk 2077 folder was not found: D:\\Somewhere has no bin\\x64\\Cyberpunk2077\.exe\./);
  for (const line of [...offlineProblems({layout, rows, files}), ...lost]) assert.doesNotMatch(line, /recommend/i);
});

test('Make support report.bat starts the bundled Node on the thin wrapper, keeps the window open, and is plain CRLF text', async () => {
  const bytes = await readFile(join(here, '..', 'packaging', 'Make support report.bat'));
  const text = bytes.toString('latin1');
  assert(bytes.every(byte => byte < 128), 'ASCII only');
  assert(!/(?<!\r)\n/.test(text), 'every line ends in CRLF');
  assert.match(text, /%~dp0app\\node\\node\.exe/);
  assert.match(text, /%~dp0app\\bridge\\make-support-report\.mjs/);
  assert.match(text, /"%NODE%" "%TOOL%" %\*/, 'options such as --game pass through');
  assert.match(text, /^pause\r?$/m);
  assert.match(text, /set "NODE_OPTIONS="/, 'an inherited Node option cannot change what runs');
  // The wrapper the batch file names exists and only calls the report code.
  const wrapper = await readFile(join(here, 'make-support-report.mjs'), 'utf8');
  assert.match(wrapper, /import \{runOfflineReport\} from '\.\/offline-support-report\.mjs'/);
});

test('the requirement list is the one on the Nexus page, plus optional ArchiveXL', () => {
  assert.deepEqual(REQUIREMENTS.filter(item => !item.optional).map(item => item.name), ['Cyber Engine Tweaks', 'RED4ext', 'redscript', 'Codeware', 'TweakXL', 'Audioware', 'Mod Configuration Menu']);
  assert.deepEqual(REQUIREMENTS.filter(item => item.optional).map(item => item.name), ['ArchiveXL']);
});

test('checkRequirements never throws on an empty folder', async () => {
  const w = await workspace();
  try {
    const layout = await resolveOfflineLayout({appDirectory: w.at('app'), game: w.at('nothing'), env: {}});
    const rows = await checkRequirements(layout, []);
    assert.equal(rows.length, REQUIREMENTS.length);
    assert(rows.every(item => item.state === 'unknown' || item.state === 'absent'));
  } finally { await w.cleanup(); }
});

/** Copies the shipped files of the wrapper (its import closure, as the release build copies it) into <app>/bridge. */
async function shipTheTool(app) {
  const closure = await importClosure(repo, ['bridge/make-support-report.mjs']);
  for (const rel of closure) { await mkdir(dirname(join(app, rel)), {recursive: true}); await copyFile(join(repo, rel), join(app, rel)); }
  return closure;
}

test('the shipped files alone are enough: the wrapper runs from a copy of its import closure, from a folder with spaces', async () => {
  const f = await healthyInstall();
  try {
    const closure = await shipTheTool(f.app);
    assert(closure.includes('bridge/offline-support-report.mjs') && closure.includes('bridge/support-report.mjs'));
    const out = f.at('cli out');
    const run = spawnSync(process.execPath, [join(f.app, 'bridge', 'make-support-report.mjs'), '--no-open', '--out', out],
      {cwd: f.base, env: {...process.env, LOCALAPPDATA: f.local, NODE_OPTIONS: ''}, encoding: 'utf8'});
    assert.equal(run.status, 0, run.stderr);
    const lines = run.stdout.split(/\r?\n/).filter(Boolean);
    assert.equal(lines.length, 2, run.stdout);
    const names = await readdir(out);
    assert.equal(names.length, 1);
    assert.match(names[0], REPORT_NAME);
    assert(lines[1].includes(join(out, names[0])) && /send that file/i.test(lines[1]));
    const summary = summaryOf(await unzip(join(out, names[0])));
    assert(summary.requirements.every(item => item.state === 'present'));
  } finally { await f.cleanup(); }
});

test('double-clicking Make support report.bat works from a folder with spaces, passes the options on and ends with the file named', {skip: process.platform !== 'win32'}, async () => {
  const f = await healthyInstall();
  try {
    await shipTheTool(f.app);
    await mkdir(join(f.app, 'node'), {recursive: true});
    await copyFile(process.execPath, join(f.app, 'node', 'node.exe'));
    const bat = join(f.game, ...PLUGIN.split('/'), 'Make support report.bat');
    await copyFile(join(repo, 'packaging', 'Make support report.bat'), bat);
    const out = f.at('bat out');
    // `/s` strips one outer pair of quotes, so the command has two. `pause` waits for a key: the input ends it, as a key press would.
    const run = spawnSync('cmd.exe', ['/d', '/s', '/c', `""${bat}" --no-open --out "${out}""`],
      {windowsVerbatimArguments: true, cwd: f.base, input: '\r\n', env: {...process.env, LOCALAPPDATA: f.local, NODE_OPTIONS: '--no-warnings'}, encoding: 'utf8'});
    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
    const names = await readdir(out);
    assert.equal(names.length, 1, run.stdout);
    assert.match(run.stdout, /Your support report is saved at .*convai-report-\d{8}-\d{6}\.zip - please send that file\./);
    assert.match(run.stdout, /Press any key/i, 'the window stays open until a key is pressed');
    // Without the Runtime's Node the batch file says so plainly and still waits, instead of closing on the player.
    await rm(join(f.app, 'node', 'node.exe'));
    const broken = spawnSync('cmd.exe', ['/d', '/s', '/c', `""${bat}""`], {windowsVerbatimArguments: true, cwd: f.base, input: '\r\n', encoding: 'utf8'});
    assert.match(broken.stdout, /Could not find app\\node\\node\.exe/);
    assert.match(broken.stdout, /Press any key/i);
  } finally { await f.cleanup(); }
});
