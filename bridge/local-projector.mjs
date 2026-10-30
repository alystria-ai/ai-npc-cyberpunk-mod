// Which vision projector (`--mmproj`) belongs to a Local AI model (docs/LOCAL_AI.md, "Vision (Companion vision)").
//
// A model has a projector when
//   (a) its manifest entry names one: a pack manifest's `standard` / `lite` entry (`mmproj: 'models/x.gguf'`, bridge/local-ai-pack.mjs), a Mature marker's entry
//       (bridge/mature-pack.mjs, only when the marker names it: a Mature model is never given one otherwise) or a custom manifest entry (bridge/custom-models.mjs). Each of
//       them checks the path with the rules of its own `file` and hands the absolute path here as `declared`.
//   (b) auto-discovery: in the model file's folder there is exactly one other .gguf whose name contains `mmproj` (any case) and the folder holds exactly one .gguf that is not
//       a projector (the model itself).
// Either way the candidate must really be a projector: the GGUF header says `general.architecture` is `clip` (llama.cpp's name for a vision projector, `mmproj` too). A file that is
// missing, too small, unreadable or something else means the model has none. A projector that is named but not usable is not replaced by a discovered one: the player's word stands.
//
// Pure functions with injectable file helpers ({list, stat, head}), plus a finder that remembers its answers for a few seconds so a caller that asks on every settings poll
// reads the folder once per window. Nothing here runs per frame or per turn, and nothing is read at all unless a caller asks.
import {basename, dirname, join, resolve} from 'node:path';
import {readdirSync, statSync} from 'node:fs';
import {parseGgufHeader, readGgufHead} from './custom-models.mjs';

export const PROJECTOR_LIMITS = Object.freeze({
  headerBytes: 256 * 1024,   // a projector has no vocabulary: its architecture key is among the first, and the header parser stops at the end of what was read
  minFileBytes: 64,          // below this it cannot hold a GGUF header
  cacheMs: 5000,             // how long the default finder remembers an answer
});
/** `general.architecture` of a vision projector file. */
export const PROJECTOR_ARCHITECTURES = Object.freeze(['clip', 'mmproj']);

const listNames = path => { try { return readdirSync(path); } catch { return []; } };
const statFile = path => { try { const stat = statSync(path); return stat.isFile() ? {size: stat.size, mtimeMs: stat.mtimeMs} : null; } catch { return null; } };
// Wrapped so the cycle with bridge/custom-models.mjs (which imports the model choice, which imports this file) is harmless: nothing here is called while modules load.
const headOf = (path, length) => readGgufHead(path, length);

/** The real file helpers. */
export const REAL_FILES = Object.freeze({list: listNames, stat: statFile, head: headOf});

const isGguf = name => /\.gguf$/i.test(name);
/** A file name that says it is a projector: `.gguf` with `mmproj` in the name. */
export const looksLikeProjector = name => isGguf(String(name)) && /mmproj/i.test(String(name));

/** Is `path` really a vision projector? true only for a readable GGUF file whose architecture is `clip`. Never throws. */
export function isProjectorFile(path, {stat = statFile, head = headOf} = {}) {
  try {
    if (typeof path !== 'string' || !path) return false;
    const info = stat(path);
    if (!info || !(info.size >= PROJECTOR_LIMITS.minFileBytes)) return false;
    const header = parseGgufHeader(head(path, Math.min(PROJECTOR_LIMITS.headerBytes, info.size)));
    return header?.ok === true && PROJECTOR_ARCHITECTURES.includes(String(header.architecture ?? '').toLowerCase());
  } catch { return false; }
}

/**
 * The absolute path of the projector of the model file `file`, or null.
 *   declared  the projector the model's manifest names (absolute, already checked by the manifest's path rules), or null
 *   auto      whether to look beside the model when none is named (false for a Mature pack model)
 */
export function findProjector({file, declared = null, auto = true} = {}, files = REAL_FILES) {
  try {
    if (declared) return isProjectorFile(declared, files) ? resolve(declared) : null;
    if (!auto || typeof file !== 'string' || !file) return null;
    const folder = dirname(file);
    const names = files.list(folder).filter(isGguf);
    const projectors = names.filter(looksLikeProjector);
    const models = names.filter(name => !looksLikeProjector(name));
    if (projectors.length !== 1 || models.length !== 1 || models[0].toLowerCase() !== basename(file).toLowerCase()) return null;
    const candidate = join(folder, projectors[0]);
    return isProjectorFile(candidate, files) ? candidate : null;
  } catch { return null; }
}

/**
 * A finder `(file, declared, {auto}) => path | null` that remembers each answer for `cacheMs`. Sized for a caller that asks every few seconds (the settings page, the 500 ms
 * poll of the bridge): the folder and the header are read once per window per model.
 */
export function createProjectorFinder({files = REAL_FILES, now = Date.now, cacheMs = PROJECTOR_LIMITS.cacheMs} = {}) {
  const memo = new Map();
  return (file, declared = null, {auto = true} = {}) => {
    if (!file) return null;
    const key = `${file}|${declared ?? ''}|${auto ? 1 : 0}`, at = now(), known = memo.get(key);
    if (known && at - known.at < cacheMs) return known.path;
    const path = findProjector({file, declared, auto}, files);
    if (memo.size > 64) memo.clear();
    memo.set(key, {at, path});
    return path;
  };
}

/** The finder listLocalModels uses unless it is given another (the real files, a 5 s memory). */
export const defaultProjectorFinder = createProjectorFinder();
/** A finder that finds nothing: for callers that must not touch the disk. */
export const noProjector = () => null;
