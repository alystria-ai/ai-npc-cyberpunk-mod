// The removal list a Runtime carries (app/defaults/runtime-removals.json) as the builders write it. The reader and the deleting are in
// packaging/runtime/apply-removals.mjs (shipped in the Runtime, run at every start); this is the build side: the file's text, and the check
// that a list only names what the start step may delete and nothing the same Runtime ships.
import {PLUGIN, REMOVALS_FILE, refusalFor} from '../runtime/apply-removals.mjs';

export const REMOVALS_ENTRY = `${PLUGIN}/app/${REMOVALS_FILE}`;
// Paths the release always declares as removed, besides what an update zip finds by comparing two Runtimes (kept in the repository, so a
// full Runtime built from it carries them too): {"removes": ["red4ext/plugins/..."]}.
export const DECLARED_REMOVALS = 'packaging/runtime-removals.json';

const byPath = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// The file's text: version and the sorted, de-duplicated paths. Stable, so the same list is the same bytes.
export function removalListText(version, removes) {
  return JSON.stringify({version, removes: [...new Set(removes)].sort(byPath)}, null, 1) + '\n';
}

// Splits `paths` into what a list may carry and what it may not: {ok, refused: [{path, why}]}. `shipped` is the set of paths (any case) the
// same Runtime ships; a path in it must not be removed (the start step would delete a file the Runtime has just put there).
export function checkRemovals(paths, shipped = new Set()) {
  const ok = [], refused = [], keys = new Set(), lowered = new Set([...shipped].map(path => path.toLowerCase()));
  for (const path of paths) {
    const why = refusalFor(path) ?? (lowered.has(String(path).toLowerCase()) ? 'the new Runtime ships it' : null);
    if (why) refused.push({path, why});
    else if (!keys.has(path.toLowerCase())) { keys.add(path.toLowerCase()); ok.push(path); }
  }
  return {ok: ok.sort(byPath), refused};
}
