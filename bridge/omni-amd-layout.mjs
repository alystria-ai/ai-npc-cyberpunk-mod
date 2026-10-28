// Where Settings > Voices > OmniVoice for AMD keeps AMD's ROCm PyTorch, and how that Python is made from the OmniVoice pack's (docs/OMNIVOICE_AMD.md).
//
// <data>/amd/                      (data = %LOCALAPPDATA%\AiNpcCyberpunkMod\data; short names on purpose: AMD's deepest file is 164 characters long and Windows stops at 260)
//   py/                            the AMD Python
//     python.exe, python311.dll, python311.zip, *.pyd, ...   the top-level files of the pack's app/omni/python (its interpreter, a few MB)
//     python311._pth               the path file: py/sp first, then the pack's own Lib/site-packages and the pack's other entries as absolute paths
//     sp/                          AMD's wheels unpacked (torch, torchaudio, torchvision, the rocm_sdk packages)
//     setup.json                   written last: what was set up (the card family, the files); without it nothing here is used
//   downloads/                     AMD's files while they download (resumed after a cancel or a lost connection; deleted once unpacked)
//   st/                            the next py/ while it is being unpacked (renamed to py/ when complete)
//
// So `import torch` finds AMD's PyTorch before the pack's CUDA one, and every other library (numpy, transformers, OmniVoice's own code) is the pack's: nothing
// of the pack is changed or copied beyond the interpreter, and the NVIDIA route is untouched. The path file is written again whenever the pack is somewhere
// else (syncAmdPython, before every test of this Python), and the interpreter files are copied again when the pack's interpreter changed.
import {copyFile, mkdir, readdir, readFile as fsReadFile, rename, stat, writeFile} from 'node:fs/promises';
import {basename, dirname, isAbsolute, join, resolve} from 'node:path';

export const AMD_DIRECTORY = 'amd';
export const SETUP_FILE = 'setup.json';
export const SITE_DIRECTORY = 'sp';

/** The setup's folders and files under the bridge's state folder. Pure. */
export function amdPaths(stateDirectory) {
  const root = resolve(stateDirectory, AMD_DIRECTORY);
  const python = resolve(root, 'py');
  return {root, home: python, python: resolve(python, 'python.exe'), site: resolve(python, SITE_DIRECTORY), setup: resolve(python, SETUP_FILE),
    downloads: resolve(root, 'downloads'), staging: resolve(root, 'st')};
}

/** The setup record ({version: 1, target, files, ...}) or null when nothing complete is set up. */
export async function readAmdSetup({stateDirectory, readFile = fsReadFile} = {}) {
  if (!stateDirectory) return null;
  try {
    const value = JSON.parse(String(await readFile(amdPaths(stateDirectory).setup, 'utf8')).replace(/^﻿/, ''));
    return value && typeof value === 'object' && value.version === 1 && typeof value.target === 'string' ? value : null;
  } catch { return null; }
}

/** The top-level files of the pack's Python that make the interpreter (everything but its path file). */
export async function interpreterFiles(packHome, {list = readdir} = {}) {
  const entries = await list(packHome, {withFileTypes: true});
  return entries.filter(entry => entry.isFile() && !/\._pth$/i.test(entry.name)).map(entry => entry.name).sort();
}

/**
 * The AMD Python's path file from the pack's (`packPth`, its text) and the pack's folder: the zip and '.' stay (the copied interpreter has them), py/sp comes
 * before the pack's first site-packages entry, every other entry becomes an absolute path into the pack, `import site` and comments are kept. Pure.
 */
export function pthText(packPth, packHome) {
  const rows = String(packPth ?? '').replace(/^﻿/, '').split(/\r?\n/).map(row => row.trim()).filter(Boolean);
  const out = [];
  let placed = false;
  for (const row of rows) {
    if (row.startsWith('#') || /^import\s/.test(row) || row === '.' || /^python\d+\.zip$/i.test(row)) {
      if (/^import\s/.test(row) && !placed) { out.push(SITE_DIRECTORY); placed = true; }
      out.push(row);
      continue;
    }
    if (!placed && /site-packages$/i.test(row)) { out.push(SITE_DIRECTORY); placed = true; }
    out.push(isAbsolute(row) ? row : resolve(packHome, row));
  }
  if (!placed) out.push(SITE_DIRECTORY);
  return out.join('\r\n') + '\r\n';
}

/** The pack's path file: [name, text], or null when the pack's Python has none (then it is not the embeddable Python this is built for). */
export async function packPthFile(packHome, {list = readdir, readFile = fsReadFile} = {}) {
  const entries = await list(packHome, {withFileTypes: true});
  const found = entries.find(entry => entry.isFile() && /^python\d+\._pth$/i.test(entry.name));
  return found ? [found.name, String(await readFile(join(packHome, found.name), 'utf8'))] : null;
}

/**
 * Makes `home` an interpreter like the pack's at `runtimePython` (app/omni/python/python.exe): copies its top-level files when one is missing or of another size,
 * and writes the path file when its text differs. Returns {copied, wrote}. Throws when the pack's Python is not there.
 */
export async function prepareInterpreter({home, runtimePython, fs = {copyFile, mkdir, readdir, readFile: fsReadFile, stat, writeFile}} = {}) {
  if (!runtimePython) throw Error('no OmniVoice Python');
  const packHome = dirname(runtimePython);
  const pth = await packPthFile(packHome, {list: fs.readdir, readFile: fs.readFile});
  if (!pth) throw Error('the OmniVoice Python has no path file');
  await fs.mkdir(home, {recursive: true});
  let copied = 0, wrote = false;
  for (const name of await interpreterFiles(packHome, {list: fs.readdir})) {
    const [from, to] = [join(packHome, name), join(home, name)];
    const [source, target] = await Promise.all([fs.stat(from), fs.stat(to).catch(() => null)]);
    if (target && target.size === source.size) continue;
    await fs.copyFile(from, to); copied++;
  }
  const [name, text] = pth;
  const wanted = pthText(text, packHome);
  const have = await fs.readFile(join(home, name), 'utf8').catch(() => null);
  if (have !== wanted) { await fs.writeFile(join(home, name), wanted); wrote = true; }
  return {copied, wrote};
}

/** Before a test of the AMD Python: the interpreter and the path file follow the pack the Runtime uses now. Nothing to do without a setup. */
export async function syncAmdPython({stateDirectory, runtimePython, prepare = prepareInterpreter} = {}) {
  if (!(await readAmdSetup({stateDirectory}))) return {copied: 0, wrote: false};
  return prepare({home: amdPaths(stateDirectory).home, runtimePython});
}

/** Writes the setup record last (in place of a half-made one) so a setup counts only once complete. */
export async function writeAmdSetup(path, value) {
  const temporary = `${path}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2));
  await rename(temporary, path);
}

/** Wheel folders named <name>.data/ (purelib, platlib) belong in the site folder itself; their other parts (scripts, headers, data) are not used. */
export const wheelDataFolder = name => /^[^/\\]+\.data$/i.test(basename(name));

// The packs of AMD's files on our Hugging Face repository (docs/OMNIVOICE_AMD.md, "Where the files come from"): one zip per card family in voice/amd/,
// built by packaging/build-omni-amd-packs.mjs from AMD's own wheels, listed with their SHA-256 in bridge/omni-amd-packs.mjs.
export const AMD_PACK_REPOSITORY = 'alystria-ai/ai-npc-cyberpunk-mod-packs';
export const AMD_PACK_FOLDER = 'voice/amd';
/** The manifest inside a pack zip, beside the wheels. */
export const AMD_PACK_MANIFEST = 'omni-amd-pack.json';

/**
 * The file name of a family's pack: model/runtime name, family, then the PyTorch and ROCm versions that are inside:
 * OmniAMD-gfx1201-PyTorch-2.14-ROCm-10.1.zip. `roots.torch` is the pinned torch ("2.14.0+rocm10.1.0"). Null when the versions cannot be read. Pure.
 */
export function amdPackName(roots, target) {
  const found = /^(\d+\.\d+)(?:\.\d+)*[^+]*\+rocm(\d+\.\d+)/.exec(String(roots?.torch ?? ''));
  if (!found || !/^gfx[0-9a-f]{3,5}$/.test(String(target ?? ''))) return null;
  return `OmniAMD-${target}-PyTorch-${found[1]}-ROCm-${found[2]}.zip`;
}
/** Where a pack is downloaded from. Pure. */
export const amdPackUrl = name => `https://huggingface.co/${AMD_PACK_REPOSITORY}/resolve/main/${AMD_PACK_FOLDER}/${name}`;
