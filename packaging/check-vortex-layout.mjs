// Checks that an optional pack zip installs through Vortex's Cyberpunk 2077 extension (E1337Kat/cyberpunk2077_ext_redux, v0.13.0 and the versions around it).
//
//   node packaging/check-vortex-layout.mjs <zip-or-url>...
//       Lists every .dll in each pack (any folder, any depth). Exit code 1 when a pack has one. Reads only the zip's directory (a URL is read with HTTP range
//       requests: a few MB, never the pack).
//
// Why (Discord 2026-10-23: installing the Local AI Standard pack with Vortex stopped with "Error: Red4Ext installer failed to generate any instructions! at
// Object.installRed4ExtMod", docs/PACKAGING.md, "Packs and Vortex"): the extension asks its installers one after another, and its RED4ext installer
// (src/installer.red4ext.ts) claims any zip that has a file ending in .dll at any depth (`testForRed4ExtMod`: findAllSubdirsWithSome(root, .dll)). It then
// only knows four layouts, and every one needs a .dll that sits directly in red4ext/plugins/ or directly in a folder of it (or at the top of the zip). Our packs
// hold their DLLs deeper (red4ext/plugins/AiNpcCyberpunkMod/app/local-ai/llama/*.dll), so none matches and the install fails. A zip with no .dll at all is not
// claimed by it (nor by the other installers: nothing in a pack looks like a CET, redscript, TweakXL, archive, REDmod or config mod), so it reaches the
// extension's last installer, which asks "install anyway?" and copies every file to the same path under the game folder.
import {resolve} from 'node:path';
import {basename} from 'node:path';
import {fileURLToPath} from 'node:url';
import {filesOfZip, isUrl} from './lib/pack-overlap.mjs';

/** The paths of a pack (strings, or {path} records) that end in .dll, in any case. */
export const dllPaths = files => files.map(file => typeof file === 'string' ? file : file.path).filter(path => /\.dll$/i.test(path));

/** {ok, dlls}: ok when the pack holds no .dll, so Vortex's RED4ext installer does not claim it. */
export function vortexProblems(files) {
  const dlls = dllPaths(files);
  return {ok: dlls.length === 0, dlls};
}

export async function checkPacks(sources, {log = console.log, fetchImpl} = {}) {
  let ok = true;
  for (const source of sources) {
    const {files} = await filesOfZip(source, {fetchImpl});
    const {ok: clean, dlls} = vortexProblems(files);
    const name = basename(isUrl(source) ? new URL(source).pathname : source);
    if (clean) { log(`${name}: ${files.length} files, no .dll: Vortex's RED4ext installer leaves it alone.`); continue; }
    ok = false;
    log(`${name}: ${dlls.length} .dll file(s) of ${files.length}; Vortex's RED4ext installer claims this pack and fails ("failed to generate any instructions"):`);
    for (const path of dlls.slice(0, 10)) log(`  ${path}`);
    if (dlls.length > 10) log(`  ... and ${dlls.length - 10} more`);
  }
  log(ok ? 'OK: no pack has a .dll.' : 'FAILED: take the .dll files out of the pack (the engine belongs in the Runtime, docs/PACKAGING.md "Local AI packs") or the pack cannot be added with Vortex.');
  return ok;
}

async function main(argv) {
  if (!argv.length) { console.error('Usage: check-vortex-layout.mjs <zip-or-url>...'); return 2; }
  return (await checkPacks(argv)) ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; }, error => { console.error(error.message); process.exitCode = 2; });
}
