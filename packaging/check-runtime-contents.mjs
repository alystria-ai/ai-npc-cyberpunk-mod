// Checks that a built Runtime zip carries what its features need: V's voice clips and
// the OmniVoice lists in app/defaults (packaging/lib/runtime-required.mjs). Reads only the zip's directory. Exit code 1 when something is missing.
//
//   node packaging/check-runtime-contents.mjs [--no-sign-in] <Runtime zip>...      (several zips are one Runtime; --no-sign-in for a --dry-run build, which has no
//   app/defaults/convai-auth.json)
//
// Run it with packaging/check-pack-overlap.mjs on every Runtime zip before upload (docs/PACKAGING.md, "Checking a build").
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {listZip} from './lib/zip.mjs';
import {missingRuntimeFiles, requiredRuntimeFiles} from './lib/runtime-required.mjs';
import {LANGUAGE_PACK_TREE, POCKET_MODEL_TREE} from './lib/pack-overlap.mjs';

const project = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');

export async function checkRuntimeContents(zips, {root = project, log = console.log, signIn = true} = {}) {
  const names = new Set();
  for (const zip of zips) for (const entry of await listZip(zip)) names.add(entry.name);
  const required = await requiredRuntimeFiles(root, {signIn});
  const missing = missingRuntimeFiles(names, required);
  // The Runtime never ships anything in the voice language packs' folder (docs/VOICE_LANGUAGE_PACKS.md): their own zips write it.
  const inPackTree = [...names].filter(name => [LANGUAGE_PACK_TREE, POCKET_MODEL_TREE].some(tree => name.toLowerCase().startsWith(tree.toLowerCase())));
  if (inPackTree.length) missing['voice language packs\' folder (must be empty in a Runtime)'] = inPackTree.slice(0, 20);
  for (const [group, files] of Object.entries(required)) log(`${group}: ${files.length - (missing[group]?.length ?? 0)} of ${files.length} present`);
  for (const [group, files] of Object.entries(missing)) for (const file of files) log(`  MISSING (${group}): ${file}`);
  log(Object.keys(missing).length ? 'FAILED: the Runtime lacks files its features need (packaging/lib/runtime-required.mjs).' : 'OK: the Runtime carries V\'s voice clips and its own OmniVoice lists.');
  return !Object.keys(missing).length;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), signIn = !args.includes('--no-sign-in'), zips = args.filter(arg => arg !== '--no-sign-in');
  if (!zips.length) { console.error('Usage: check-runtime-contents.mjs [--no-sign-in] <Runtime zip>...'); process.exitCode = 2; }
  else checkRuntimeContents(zips.map(zip => resolve(zip)), {signIn}).then(ok => { process.exitCode = ok ? 0 : 1; }, error => { console.error(error.message); process.exitCode = 2; });
}
