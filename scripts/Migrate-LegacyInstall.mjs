#!/usr/bin/env node
// Moves a development (or any older) installation from the folders of the project's first name (CyberpunkConvai) to the
// AI NPC Cyberpunk Mod folders: the mod's data/ and runtime/, the Local AI / OmniVoice packs and voices of the plugin folder, and
// the CET key bindings; then it removes the old folders. The same code the packaged service runs at its first start
// (packaging/runtime/migrate-legacy.mjs), run here and now, with the game closed.
//
//   node scripts/Migrate-LegacyInstall.mjs [--game "E:\SteamLibrary\steamapps\common\Cyberpunk 2077"] [--dry-run]
//
// scripts/Install-DevelopmentMod.ps1 calls it before it installs the new files. Safe to run again: with no old folder it does nothing.
// The development launcher (red4ext/plugins/CyberpunkConvaiLauncher) keeps its name and is not touched.
import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {adoptLegacyInstall, cleanupLegacyInstall, legacyPaths} from '../packaging/runtime/migrate-legacy.mjs';

const argv = process.argv.slice(2);
const option = (name, fallback) => { const at = argv.indexOf(name); return at >= 0 && argv[at + 1] ? argv[at + 1] : fallback; };
const game = option('--game', 'E:\SteamLibrary\steamapps\common\Cyberpunk 2077');
const dryRun = argv.includes('--dry-run');

if (!existsSync(join(game, 'bin', 'x64', 'Cyberpunk2077.exe'))) { console.error(`Not a Cyberpunk 2077 folder: ${game}`); process.exit(2); }
if (process.platform === 'win32' && /Cyberpunk2077\.exe/i.test(spawnSync('tasklist', ['/FI', 'IMAGENAME eq Cyberpunk2077.exe', '/NH'], {encoding: 'utf8'}).stdout || '')) {
  console.error('Close the game first: its loaded DLLs and open files would hold the old folders.'); process.exit(2);
}
const paths = legacyPaths(game);
const present = ['oldMod', 'oldPlugin', 'oldNative'].filter(key => existsSync(paths[key]));
if (!present.length) { console.log('No old CyberpunkConvai folders found. Nothing to do.'); process.exit(0); }
console.log(`Old folders: ${present.map(key => paths[key]).join(', ')}`);
if (dryRun) { console.log('Dry run: nothing was changed.'); process.exit(0); }
const log = message => console.log(message);
const adopted = await adoptLegacyInstall({gameRoot: game, log});
const cleaned = await cleanupLegacyInstall({adopted, log});
console.log(`Moved ${adopted.report.moved.length} item(s); removed ${cleaned.removed.length} old folder(s)${cleaned.pending.length ? `; still in place: ${cleaned.pending.join(', ')}` : ''}.`);
if (adopted.report.errors.length) { console.error(adopted.report.errors.join('\n')); process.exit(1); }
