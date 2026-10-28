// The selection logic of packaging/test-release-install.mjs in its upgrade mode (--update-from), without any file access, so
// packaging/install-test-plan.test.mjs can cover it on small fixtures instead of the 1 GB zips.
//
// Three kinds of run:
//   clean install    no --update-from: the new Scripts (Update) and Runtime zips over an empty game folder.
//   runtime-update   --update-from and a real Runtime update zip among the packages (releases up to 0.3.3: Runtime-Update-<from>-to-<to>.zip with a removal
//                    list and a step marker). Checked as before.
//   code-upgrade     --update-from and NO Runtime update zip (0.3.4 and later, docs/PACKAGING.md, "The Full install package" and "Code in the Scripts"): the
//                    previous release's Scripts and Runtime are installed, then either path a, the small Update zip over them, or path b, the Full zip over
//                    them. The code is copied into the Runtime's app/ by install-code.mjs at the start, the base stays or is replaced.
import {fullBaseName} from './full-package.mjs';
import {isCodeGamePath} from './code-payload.mjs';
import {BASE_MARKER} from './package-guards.mjs';

export const UPGRADE_PATHS = Object.freeze(['update', 'full']);
export const MODES = Object.freeze({clean: null, runtimeUpdate: 'runtime-update', codeUpgrade: 'code-upgrade'});

const escaped = text => String(text).replace(/[.+]/g, '\\$&');

/** The Runtime update zips of this version in a package folder: Runtime-Update-<from>-to-<version><suffix>.zip. */
export const runtimeUpdateZips = (names, version, suffix = '') =>
  names.filter(name => new RegExp(`^Runtime-Update-.+-to-${escaped(version)}${escaped(suffix)}\\.zip$`).test(name));

const baseName = path => String(path ?? '').split(/[\\/]/).pop();

/**
 * Which run this is. `previous`: the previous release's packages were given (--update-from). A Runtime update zip counts when one is named with
 * --update-zip (by its file name: Runtime-Update-...) or when exactly one sits among the packages; a code Update zip named with --update-zip does not.
 */
export function chooseMode({previous, names, version, suffix = '', updateZipArgument = null}) {
  if (!previous) return MODES.clean;
  const named = updateZipArgument ? /^Runtime-Update-/.test(baseName(updateZipArgument)) : null;
  if (named === true) return MODES.runtimeUpdate;
  if (named === false) return MODES.codeUpgrade;
  return runtimeUpdateZips(names, version, suffix).length ? MODES.runtimeUpdate : MODES.codeUpgrade;
}

/** --upgrade-path: update (a), full (b) or both (the default), in the order they are run. */
export function upgradePathsFor(option) {
  if (option === undefined || option === null || option === '' || option === 'both') return [...UPGRADE_PATHS];
  if (!UPGRADE_PATHS.includes(option)) throw Error(`--upgrade-path must be one of ${UPGRADE_PATHS.join(', ')} or both, not ${option}`);
  return [option];
}

/**
 * The zips of the two code-upgrade paths in a package folder. `updateName`: the Update zip's file name from the build's naming
 * (updateBaseNameFor + .zip) or the --update-zip file name. `full` is the Full install of this version and game.
 */
export function upgradeZips({names, version, game, updateName}) {
  const full = `${fullBaseName(version, game)}.zip`;
  return {
    update: names.includes(updateName) ? updateName : null,
    full: names.includes(full) ? full : null,
    fullListing: names.includes(full.replace(/\.zip$/, '.files.json')) ? full.replace(/\.zip$/, '.files.json') : null,
  };
}

/** What the package folder must hold for a path: the zip it extracts and (for the Full zip) the listing the files are checked against. */
export function packagesForPath(path, zips) {
  if (path === 'update') return {zip: zips.update, listing: null, missing: zips.update ? [] : ['the Update zip']};
  if (path === 'full') return {zip: zips.full, listing: zips.fullListing, missing: [...(zips.full ? [] : ['the Full zip']), ...(zips.fullListing ? [] : ['the Full zip\'s .files.json'])]};
  throw Error(`Unknown upgrade path ${path}`);
}

/**
 * Path a leaves the Runtime base as the previous release had it: a base file of the new Runtime that differs is expected (the previous base was not
 * rebuilt), one that is MISSING is not (except the do-nothing marker plugin). Path b puts the new base in place: nothing may differ or be missing.
 * `missing`, `differing`: the new Runtime's listed files that are absent or other in the install.
 */
export function baseVerdict(path, {missing, differing}) {
  if (path === 'full') return {ok: missing.length === 0 && differing.length === 0, expected: 'every base file equals the new base', needed: missing};
  // The marker plugin (BASE_MARKER) is new in the 0.3.4 base and does nothing: a 0.3.3 base has the real launcher DLL instead, which the Update's launcher retires.
  const needed = missing.filter(rel => rel.split('/').pop() !== BASE_MARKER);
  return {ok: needed.length === 0, expected: 'no file of the new base that the code needs is missing (files left at the previous base are fine)', needed};
}

/**
 * The code files of the previous release (names relative to the game folder, from its zips) that the new code no longer has: they must be gone
 * after the start (install-code deletes what code.json "removes" names). `codeRows`: code.json's files ({path}).
 */
export function staleCode({previousNames, codeRows}) {
  const current = new Set(codeRows.map(row => row.path));
  const prefix = 'red4ext/plugins/AiNpcCyberpunkMod/app/';
  return previousNames.filter(name => isCodeGamePath(name) && !current.has(name.slice(prefix.length)) && !/\.pyc$/.test(name)
    && name !== `${prefix}defaults/scripts-code.json`).sort();
}

/** The setup check document (runtime/setup-check.json): the rows that matter after an upgrade are ok. The redscript compiler is not in a stand-in folder. */
export function setupCheckVerdict(document, {ignore = ['compiler']} = {}) {
  const rows = Array.isArray(document?.checks) ? document.checks : [];
  const row = id => rows.find(item => item?.id === id);
  const bad = rows.filter(item => item?.state === 'problem' && !ignore.includes(item.id)).map(item => `${item.id}/${item.code}`);
  const versions = row('versions');
  const ok = rows.length > 0 && versions?.state === 'ok' && versions.code === 'match' && bad.length === 0;
  return {ok, versions: versions ? `${versions.state}/${versions.code}` : 'no versions row', bad};
}

/** Whether the previous release's package list held each of the two DLLs the Scripts' launcher retires. */
export const hadRetiredDlls = (previousNames, dlls) => dlls.filter(dll => previousNames.some(name => name.toLowerCase() === dll.toLowerCase()));
