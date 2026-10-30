// What the Runtime build checks about the Python it ships (report 0b8367fd0ebd2f2f: a player's app/python had no Lib/urllib, so the voice never started).
// The list of files is bridge/runtime-python.mjs's, the one the running bridge checks the installed Runtime against, so the build and the game ask for
// the same files. Pure functions over path lists; packaging/build-release.mjs calls them, packaging/runtime-python.test.mjs tests them.
import {DISTUTILS_PACKAGE, DISTUTILS_PTH, SITE_PACKAGES, STDLIB_FILES} from '../../bridge/runtime-python.mjs';

const pycOrPy = (set, base) => set.has(`${base}.pyc`) || set.has(`${base}.py`);

/**
 * The files the voice workers import that `paths` (the Python folder's files, relative to it, forward slashes) does not hold: ['Lib/urllib/parse', ...].
 * With `zipped` the standard library is expected in python3XX.zip (a Runtime that still keeps it there), so only the site-packages are asked for.
 */
export function missingPythonFiles(paths, {zipped = false} = {}) {
  const set = paths instanceof Set ? paths : new Set(paths);
  const missing = [];
  if (!zipped) for (const file of STDLIB_FILES) if (!pycOrPy(set, `Lib/${file}`)) missing.push(`Lib/${file}`);
  for (const name of SITE_PACKAGES) {
    // A part of a package (torch/nn, scipy/signal) is not named again when the whole package is gone.
    if (name.includes('/') && missing.includes(`Lib/site-packages/${name.split('/')[0]}/__init__`)) continue;
    if (!set.has(`Lib/site-packages/${name}/__init__.py`)) missing.push(`Lib/site-packages/${name}/__init__`);
  }
  if (set.has(`Lib/site-packages/${DISTUTILS_PTH}`) && !set.has(`Lib/site-packages/${DISTUTILS_PACKAGE}/__init__.py`)) missing.push(`Lib/site-packages/${DISTUTILS_PACKAGE}/__init__`);
  return missing;
}

/** Throws when the Python that is about to be packed lacks a file a voice worker imports. `what` names the package in the message. */
export function assertPythonShipped(paths, {what = 'the Runtime', zipped = false} = {}) {
  const missing = missingPythonFiles(paths, {zipped});
  if (missing.length) {
    throw Error(`${what}'s Python lacks ${missing.length} file(s) the voice workers import (${missing.slice(0, 6).join(', ')}${missing.length > 6 ? ', ...' : ''}). `
      + 'A player with these gets "No module named" at the first voice and no voice at all; fix the build before shipping it.');
  }
}

/**
 * The unzipped standard library must hold every file of the zip it came from (`zipNames`: the zip's file names; `libPaths`: the files in Lib/ afterwards, relative to Lib/).
 * Returns the names that are missing.
 */
export function stdlibNotUnzipped(zipNames, libPaths) {
  const have = new Set(libPaths);
  return zipNames.filter(name => !name.endsWith('/') && !have.has(name));
}

/** Throws when the unzipped Lib is not the whole zip, or has fewer files than the zip has. */
export function assertStdlibUnzipped(zipNames, libPaths, {zip = 'python3XX.zip'} = {}) {
  const missing = stdlibNotUnzipped(zipNames, libPaths);
  if (missing.length) throw Error(`${zip} unzipped to Lib/ without ${missing.length} file(s) of it (${missing.slice(0, 6).join(', ')}${missing.length > 6 ? ', ...' : ''}).`);
}
