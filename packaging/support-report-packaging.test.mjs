// "Make support report.bat": a support report made with the game closed, for players the mod never loads for. Its three files reach the
// Runtime package through the release recipe (release.config.json, release-plan.json, runtime-layout.mjs, build-release.mjs); this keeps
// every one of those lists in step, without a build.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {importClosure} from './lib/closure.mjs';
import {BRIDGE_AUXILIARY_FILES, BRIDGE_MODULES} from './runtime-layout.mjs';

const project = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const read = rel => readFile(resolve(project, rel), 'utf8');
const config = JSON.parse(await read('packaging/release.config.json'));
const plan = JSON.parse(await read('packaging/release-plan.json'));
const runtime = plan.archives.find(archive => archive.id === 'runtime');
const BATCH = 'Make support report.bat';
const WRAPPER = 'bridge/make-support-report.mjs', LIBRARY = 'bridge/offline-support-report.mjs';

test('the batch file, the wrapper it starts and the report code are in the repository', () => {
  assert.equal(config.layout.supportReportBatch, BATCH);
  for (const rel of [`packaging/${BATCH}`, WRAPPER, LIBRARY]) assert(existsSync(resolve(project, rel)), rel);
});

test('the Runtime ships the wrapper and the report code in app/bridge through the bridge closure, with nothing from tests', async () => {
  assert(config.bridgeEntries.includes(WRAPPER), 'the closure starts from the wrapper');
  const closure = await importClosure(project, config.bridgeEntries);
  for (const rel of [WRAPPER, LIBRARY, 'bridge/support-report.mjs', 'bridge/setup-check.mjs', 'bridge/key-codec.mjs', 'bridge/zip-writer.mjs']) assert(closure.includes(rel), `${rel} is shipped`);
  assert(!closure.some(file => /\.test\.mjs$|fixture/i.test(file)));
  // Everything the wrapper reaches is a module the shipped bridge already carries, or one of the two new files the layout list names.
  const known = new Set([...BRIDGE_MODULES, ...BRIDGE_AUXILIARY_FILES]);
  const reached = await importClosure(project, [WRAPPER]);
  assert.deepEqual(reached.filter(file => !known.has(file)), [], 'the layout lists name everything the wrapper imports');
  assert(reached.length < 12, `the wrapper reaches only the report code: ${reached.join(', ')}`);
});

test('the layout list and the release plan name both files as started by path, in the same order', () => {
  assert(BRIDGE_AUXILIARY_FILES.includes(WRAPPER) && BRIDGE_AUXILIARY_FILES.includes(LIBRARY));
  assert(!BRIDGE_MODULES.includes(WRAPPER) && !BRIDGE_MODULES.includes(LIBRARY), 'the service never imports them');
  const bridge = runtime.plannedComponents.find(component => component.id === 'bridge');
  assert.deepEqual(bridge.sourceFiles, [...BRIDGE_MODULES, ...BRIDGE_AUXILIARY_FILES]);
});

test('the release plan puts the batch file beside the launcher, in the Runtime only', () => {
  const component = runtime.plannedComponents.find(item => item.id === 'support-report');
  assert.equal(component.destination, config.layout.pluginDirectory);
  assert.deepEqual(component.sourceFiles, [`packaging/${BATCH}`]);
  assert(component.sourceFiles.every(rel => existsSync(resolve(project, rel))));
  assert.equal(`${component.destination}/${BATCH}`, 'red4ext/plugins/AiNpcCyberpunkMod/Make support report.bat');
  // The plan's files lists are the development install's (scripts/development-files.json); the batch file is not part of that.
  for (const archive of plan.archives) assert(!archive.files.some(file => /support report\.bat/i.test(file.source + file.target)), `not in ${archive.id}.files`);
});

test('what the batch file starts is where the Runtime puts it: app/node/node.exe and app/bridge/make-support-report.mjs next to it', async () => {
  const batch = await read(`packaging/${BATCH}`);
  assert(batch.includes('%~dp0app\\node\\node.exe') && batch.includes('%~dp0app\\bridge\\make-support-report.mjs'));
  // node.exe is among the Node files the Runtime copies into app/node; the wrapper lands at app/bridge (the builder copies the closure to <app>/<path>).
  assert(config.toolchain.node.files.includes('node.exe'));
  const builder = await read('packaging/build-release.mjs');
  assert.match(builder, /pkg\.file\(`\$\{app\}\/node\/\$\{name\}`/);
  assert.match(builder, /pkg\.file\(`\$\{app\}\/\$\{rel\}`, resolve\(source\.root, rel\)\)/);
});

test('the builder writes the batch file into the plugin folder with CRLF line ends, whatever the checkout used', async () => {
  const builder = await read('packaging/build-release.mjs');
  assert.match(builder, /const supportBatch = config\.layout\.supportReportBatch;/);
  assert.match(builder, /pkg\.text\(`\$\{plugin\}\/\$\{supportBatch\}`, \(await readFile\(resolve\(source\.root, 'packaging', supportBatch\), 'utf8'\)\)\.replace\(\/\\r\?\\n\/g, '\\r\\n'\)\)/);
  // The guard at the end of the build refuses only dll and ini files outside the two plugin folders: a .bat in ours passes it.
  assert.doesNotMatch(BATCH, /\.(?:dll|ini)$/i);
  const attributes = await read('.gitattributes');
  assert.match(attributes, /^packaging\/\*\.bat text eol=crlf$/m, 'a checkout keeps the batch file CRLF');
});

test('the batch file is one the Runtime may carry: not a Lua file, a short path, and no secret or developer path in it', async () => {
  const target = `${config.layout.pluginDirectory}/${BATCH}`;
  assert(target.length <= config.layout.maxPathLength - config.layout.maxGameRootLength - 1);
  assert.notEqual(runtime.forbiddenExtension, '.bat');
  const batch = await read(`packaging/${BATCH}`);
  assert.doesNotMatch(batch, /[A-Za-z]:\\|api-key|token|secret/i);
});

test('the player texts give the way out in one short plain line, never recommend an option, and keep the wording rules', async () => {
  const player = await read('packaging/PLAYER_README.md'), readme = await read('README.md'), page = await read('docs/NEXUS_PAGE.md');
  for (const [name, text] of [['PLAYER_README.md', player], ['README.md', readme], ['docs/NEXUS_PAGE.md', page]]) {
    const at = text.indexOf('Make support report.bat');
    assert(at >= 0, `${name} names the file`);
    const around = text.slice(Math.max(0, at - 400), at + 500);
    assert.match(around, /red4ext(?:\\|\/)plugins(?:\\|\/)AiNpcCyberpunkMod|red4ext\\plugins\\AiNpcCyberpunkMod/, `${name} says where it is`);
    assert.match(around, /game (?:is )?closed|game closed|closed/i, `${name} says the game is closed`);
    assert.doesNotMatch(around, /recommend/i);
  }
  assert.doesNotMatch(player, /\b(?:antivirus|anti-virus|defender|malware|virus|smartscreen)\b/i);
});
