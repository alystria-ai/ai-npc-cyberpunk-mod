// Since 0.2.3 the Runtime ships no double-click support report tool (players are not comfortable running a batch file). The report is made
// in the game (Companion Manager > Settings > Help > Help and support) and the automatic error reports go out on their own. This keeps the
// release recipe and the player texts free of the removed tool, and the error reports' helper in the Runtime, without a build.
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
// The removed names are spelled in pieces, so a search for them finds only the history lines in TODO.md and docs/PACKAGING.md.
const BATCH = ['Make support', 'report.bat'].join(' '), WRAPPER = ['bridge/make-support', 'report.mjs'].join('-'), LIBRARY = ['bridge/offline-support', 'report.mjs'].join('-');
const SETTING = ['support', 'Report', 'Batch'].join('');
const REMOVED = new RegExp([BATCH, WRAPPER.slice(7, -4), LIBRARY.slice(7, -4), SETTING].join('|'), 'i');

test('the batch file, its wrapper and the offline report code are gone from the repository and from the release recipe', async () => {
  for (const rel of [`packaging/${BATCH}`, WRAPPER, LIBRARY]) assert(!existsSync(resolve(project, rel)), rel);
  assert.equal(config.layout[SETTING], undefined);
  assert(!config.bridgeEntries.includes(WRAPPER));
  assert(!runtime.plannedComponents.some(component => component.id === 'support-report'));
  for (const [name, text] of [['release.config.json', JSON.stringify(config)], ['release-plan.json', JSON.stringify(plan)],
    ['runtime-layout.mjs', BRIDGE_AUXILIARY_FILES.concat(BRIDGE_MODULES).join('\n')], ['build-release.mjs', await read('packaging/build-release.mjs')]]) {
    assert.doesNotMatch(text, REMOVED, name);
  }
});

test('the Runtime carries no .bat file and no support report source in its plan', () => {
  for (const component of runtime.plannedComponents) for (const rel of component.sourceFiles ?? []) assert(!/\.bat$/i.test(rel), `${component.id}: ${rel}`);
  for (const archive of plan.archives) assert(!archive.files.some(file => /\.bat$/i.test(file.source + file.target)), `not in ${archive.id}.files`);
});

test('the error reports helper is shipped with the sender, named by path in the layout list and the release plan', async () => {
  assert(BRIDGE_AUXILIARY_FILES.includes('bridge/error-reports.mjs') && BRIDGE_AUXILIARY_FILES.includes('bridge/report-secrets.mjs'));
  assert(!BRIDGE_MODULES.includes('bridge/report-secrets.mjs'), 'the service itself never imports it');
  const bridge = runtime.plannedComponents.find(component => component.id === 'bridge');
  assert.deepEqual(bridge.sourceFiles, [...BRIDGE_MODULES, ...BRIDGE_AUXILIARY_FILES]);
  const reached = await importClosure(project, ['bridge/error-reports.mjs']);
  const known = new Set([...BRIDGE_MODULES, ...BRIDGE_AUXILIARY_FILES]);
  assert.deepEqual(reached.filter(file => !known.has(file)), [], 'the layout lists name everything the sender imports');
});

test('the player texts do not name the removed tool and send a player whose mod does not load to the Nexus Posts tab or Discord', async () => {
  const player = await read('packaging/PLAYER_README.md'), readme = await read('README.md'), page = await read('docs/NEXUS_PAGE.md');
  for (const [name, text] of [['PLAYER_README.md', player], ['README.md', readme], ['docs/NEXUS_PAGE.md', page]]) {
    assert.doesNotMatch(text, REMOVED, name);
    assert.doesNotMatch(text, /double-click \*{0,2}Make support|support report tool/i, name);
  }
  assert.match(player, /Posts tab/);
  assert.match(player, /Discord/);
  assert.doesNotMatch(player, /\b(?:antivirus|anti-virus|defender|malware|virus|smartscreen)\b/i);
});
