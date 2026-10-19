// Where the player's custom chat models can be listed (docs/LOCAL_AI.md, "Add your own model") and what the support report says about those folders.
// Kept apart from bridge/custom-models.mjs, which imports it: the support report (and "Make support report.bat") needs only this small part, none of the
// scanner's imports.
import {readFileSync, statSync} from 'node:fs';
import {isAbsolute, join, resolve} from 'node:path';
import {LOCAL_AI_ENV} from './local-ai-pack.mjs';

export const CUSTOM_MARKER = 'manifest.custom.json';
const readUtf8 = path => readFileSync(path, 'utf8').replace(/^\uFEFF/, '');

// The player's own models outside the game folder: <data home>/local-ai, where the data home is %LOCALAPPDATA%\AiNpcCyberpunkMod.
export const OUTSIDE_FOLDER = 'local-ai';
const DATA_HOME_NAME = 'AiNpcCyberpunkMod';
const DATA_HOME_VARIABLE = 'CYBERPUNK_CONVAI_DATA_HOME';
// Fully qualified Windows paths only (C:\... or \\server\share\...); a relative or drive-relative value is never used (the data home's own rule).
const QUALIFIED = /^(?:[a-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+)/i;
export const qualified = value => typeof value === 'string' && isAbsolute(value) && (process.platform !== 'win32' || QUALIFIED.test(value));
const usableHome = value => qualified(value) && value === value.trim() && !/[\x00-\x1f]/.test(value);

/**
 * The folder for the player's own models outside the game folder (`<data home>/local-ai`), or null without a data home. It follows the data home
 * of packaging/runtime/state-home.mjs: CYBERPUNK_CONVAI_DATA_HOME when that is an absolute path, else %LOCALAPPDATA%\AiNpcCyberpunkMod. Pure: no I/O.
 */
export function outsideLocalAiRoot(environment = process.env) {
  const override = environment?.[DATA_HOME_VARIABLE];
  if (typeof override === 'string' && override !== '' && usableHome(override)) return resolve(override, OUTSIDE_FOLDER);
  return usableHome(environment?.LOCALAPPDATA) ? resolve(environment.LOCALAPPDATA, DATA_HOME_NAME, OUTSIDE_FOLDER) : null;
}

/** The text of a manifest as JSON; curly quotes pasted from a web page are read as straight ones (they are never valid JSON). Throws when it is not JSON. */
export function parseManifestText(text) {
  try { return JSON.parse(text); } catch (error) {
    const fixed = text.replace(/[\u201C\u201D\u201E\u201F\u2033]/g, '"').replace(/[\u2018\u2019]/g, "'");
    if (fixed === text) throw error;
    return JSON.parse(fixed);
  }
}

// ---- For the support report ----------------------------------------------------------------------------------------------------

/**
 * The folders that can hold a custom manifest, for the support report and its list of secrets: [{where: 'outside' | 'mod' | 'dev', root}].
 * 'outside' is the data home's local-ai folder (absent without a data home), 'mod' the Local AI folder of the mod (CYBERPUNK_CONVAI_LOCAL_AI, else
 * `local-ai` next to the bridge), 'dev' the developer folder (CYBERPUNK_CONVAI_LOCAL_AI_DEV). Pure: no I/O.
 */
export function customManifestFolders({project, environment = process.env} = {}) {
  const named = name => (typeof environment?.[name] === 'string' && environment[name].trim() ? resolve(environment[name]) : null);
  const outside = outsideLocalAiRoot(environment);
  const mod = named(LOCAL_AI_ENV.root) ?? (project ? resolve(project, 'local-ai') : null);
  const dev = named(LOCAL_AI_ENV.dev);
  return [outside && {where: 'outside', root: outside}, mod && {where: 'mod', root: mod}, dev && {where: 'dev', root: dev}].filter(Boolean);
}

/**
 * What the support report says about the custom-model folders: for each one {where, folder: 'found' | 'missing', manifest: 'found' | 'missing'
 * | 'unreadable' | 'invalid', entries, servers}. `entries` is how many models the manifest lists and `servers` how many of those are servers the
 * player runs (an `endpoint`); neither is checked here (the bridge's own log says which are usable). The dev folder is listed only when it has a
 * manifest. Never a path, a name or a key. Never throws.
 */
export function describeCustomFolders({project, environment = process.env} = {}) {
  const rows = [];
  const outsideRoot = outsideLocalAiRoot(environment);
  if (!outsideRoot) rows.push({where: 'outside', folder: 'unavailable', manifest: 'missing', entries: 0, servers: 0});
  for (const {where, root} of customManifestFolders({project, environment})) {
    const row = {where, folder: 'missing', manifest: 'missing', entries: 0, servers: 0};
    try { if (statSync(root).isDirectory()) row.folder = 'found'; } catch { /* not there */ }
    let text = null;
    try {
      const path = join(root, CUSTOM_MARKER), info = statSync(path);
      if (info.isFile()) { row.manifest = 'unreadable'; if (info.size <= 262144) text = readUtf8(path); }
    } catch { /* missing, or not readable: the row says which */ }
    if (text !== null) {
      row.manifest = 'invalid';
      try {
        const manifest = parseManifestText(text);
        if (manifest && typeof manifest === 'object' && Array.isArray(manifest.models)) {
          row.manifest = 'found';
          row.entries = Math.min(manifest.models.length, 99);
          row.servers = Math.min(manifest.models.filter(entry => entry && typeof entry === 'object' && entry.endpoint !== undefined).length, 99);
        }
      } catch { /* not JSON */ }
    }
    if (where === 'dev' && row.manifest === 'missing') continue;
    rows.push(row);
  }
  return rows;
}
