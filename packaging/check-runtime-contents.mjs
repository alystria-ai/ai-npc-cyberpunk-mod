// Checks that a built Runtime zip carries what its features need: V's voice clips, "Make support report.bat" and the offline report code
// (packaging/lib/runtime-required.mjs). Reads only the zip's directory. Exit code 1 when something is missing.
//
//   node packaging/check-runtime-contents.mjs <Runtime zip>...      (several zips are one Runtime)
//
// Run it with packaging/check-pack-overlap.mjs on every Runtime zip before upload (docs/PACKAGING.md, "Checking a build").
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {listZip} from './lib/zip.mjs';
import {missingRuntimeFiles, requiredRuntimeFiles} from './lib/runtime-required.mjs';

const project = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');

export async function checkRuntimeContents(zips, {root = project, log = console.log} = {}) {
  const names = new Set();
  for (const zip of zips) for (const entry of await listZip(zip)) names.add(entry.name);
  const required = await requiredRuntimeFiles(root);
  const missing = missingRuntimeFiles(names, required);
  for (const [group, files] of Object.entries(required)) log(`${group}: ${files.length - (missing[group]?.length ?? 0)} of ${files.length} present`);
  for (const [group, files] of Object.entries(missing)) for (const file of files) log(`  MISSING (${group}): ${file}`);
  log(Object.keys(missing).length ? 'FAILED: the Runtime lacks files its features need (packaging/lib/runtime-required.mjs).' : 'OK: the Runtime carries V\'s voice clips and the offline support report tool.');
  return !Object.keys(missing).length;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const zips = process.argv.slice(2);
  if (!zips.length) { console.error('Usage: check-runtime-contents.mjs <Runtime zip>...'); process.exitCode = 2; }
  else checkRuntimeContents(zips.map(zip => resolve(zip))).then(ok => { process.exitCode = ok ? 0 : 1; }, error => { console.error(error.message); process.exitCode = 2; });
}
