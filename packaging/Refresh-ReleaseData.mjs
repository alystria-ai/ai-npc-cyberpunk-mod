// Copies the small release inputs that live in the ignored developer runtime/ folder into
// packaging/release-data/, so a clean checkout (and GitHub Actions) can build a release.
//
//   node packaging/Refresh-ReleaseData.mjs          copy and report what changed
//   node packaging/Refresh-ReleaseData.mjs --check  only report differences (exit 1 if any)
//
// The copied files are the Convai character-ID mappings the package installs by default and
// the three generated game archives (built from game files with WolvenKit, so CI cannot make
// them). Credentials, player state and audio are never copied.
import {createHash} from 'node:crypto';
import {copyFile, mkdir, readFile} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FILES = [
  ['runtime/characters.json', 'packaging/release-data/characters.json'],
  ['runtime/relationship-profiles.json', 'packaging/release-data/relationship-profiles.json'],
  ['runtime/multilingual-profiles.json', 'packaging/release-data/multilingual-profiles.json'],
  ['runtime/facial-rig/package/convai_facial.archive', 'packaging/release-data/archives/convai_facial.archive'],
  ['runtime/gestures/package/convai_gestures.archive', 'packaging/release-data/archives/convai_gestures.archive'],
  ['runtime/ambient-driver-guard/package/cyberpunk_convai_ambient_driver_guard.archive',
    'packaging/release-data/archives/cyberpunk_convai_ambient_driver_guard.archive'],
];
const check = process.argv.includes('--check');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const read = path => readFile(resolve(project, path)).catch(() => null);
let differences = 0;
for (const [source, target] of FILES) {
  const from = await read(source), to = await read(target);
  if (!from) { console.log(`missing source: ${source}`); differences++; continue; }
  if (from.toString('utf8').match(/api[-_]?key|hf_[A-Za-z0-9]{20,}/i) && source.endsWith('.json')) {
    throw Error(`${source} looks like it holds a credential; refusing to copy it.`);
  }
  if (to && digest(from) === digest(to)) continue;
  differences++;
  console.log(`${check ? 'differs' : 'updated'}: ${target}`);
  if (!check) {
    await mkdir(dirname(resolve(project, target)), {recursive: true});
    await copyFile(resolve(project, source), resolve(project, target));
  }
}
if (!differences) console.log('Release data is up to date.');
if (check && differences) process.exitCode = 1;
