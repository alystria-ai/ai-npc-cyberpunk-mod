// What "Make support report.bat" starts: a support report made with the game closed (bridge/offline-support-report.mjs).
// Kept this small so that nothing but the report code decides whether it runs. Options: --game <folder>, --out <folder>, --no-open.
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {runOfflineReport} from './offline-support-report.mjs';

const appDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const result = await runOfflineReport({appDirectory, argv: process.argv.slice(2)});
process.exitCode = result.ok ? 0 : 1;
