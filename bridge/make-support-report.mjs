// What "Make support report.bat" starts: a support report made with the game closed (bridge/offline-support-report.mjs).
// Kept this small so that nothing but the report code decides whether it runs. Options: --game <folder>, --out <folder>, --no-open.
import {basename, dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {runOfflineReport} from './offline-support-report.mjs';

// The folder this file was started from, not where a symlink or junction leads: Node resolves those for import.meta.url, and a mod
// manager that links the files into the game folder keeps the real ones in its own staging folder, far from the game.
const own = fileURLToPath(import.meta.url);
const started = typeof process.argv[1] === 'string' && basename(process.argv[1]).toLowerCase() === basename(own).toLowerCase() ? resolve(process.argv[1]) : own;
const appDirectory = resolve(dirname(started), '..');
const result = await runOfflineReport({appDirectory, argv: process.argv.slice(2)});
process.exitCode = result.ok ? 0 : 1;
