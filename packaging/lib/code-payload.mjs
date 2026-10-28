// The mod's own code in the Scripts package (from 0.3.4; docs/PACKAGING.md, "Code in the Scripts"). Shared by packaging/build-release.mjs
// (which writes it), packaging/build-runtime-update.mjs and packaging/runtime/apply-removals.mjs (which must never delete it), and
// packaging/runtime/install-code.mjs (which copies it). Imports nothing, so the shipped install-code.mjs can carry its own copy of the rules
// (CODE_PREFIXES and CODE_FILES there are held equal to these by packaging/code-payload.test.mjs).
//
// Layout (game-relative):
//   red4ext/plugins/AiNpcCyberpunkCode/               Scripts: the launcher DLL, the native plugin, install-code.mjs, code.json
//   red4ext/plugins/AiNpcCyberpunkCode/app/<rel>      Scripts: one complete copy of every code file, <rel> as in the Runtime's app/
//   red4ext/plugins/AiNpcCyberpunkMod/app/<rel>       Runtime base: install-code.mjs keeps these copies equal to the Scripts' ones
//   red4ext/plugins/AiNpcCyberpunkMod/app/defaults/scripts-code.json   the list of the copy now installed (written last)
// The Runtime base never ships a path under CODE_FOLDER, so Vortex (which deploys the Scripts) and a hand-installed Runtime never share a file.

export const CODE_FOLDER = 'red4ext/plugins/AiNpcCyberpunkCode';
export const CODE_APP = `${CODE_FOLDER}/app`;
export const CODE_MANIFEST = 'code.json';
export const INSTALLER = 'install-code.mjs';
export const RUNTIME_PLUGIN = 'red4ext/plugins/AiNpcCyberpunkMod';
export const RUNTIME_APP = `${RUNTIME_PLUGIN}/app`;
// In the Runtime's app/: the list of the code copy now installed.
export const INSTALLED_MANIFEST = 'defaults/scripts-code.json';
// An older Runtime's two DLLs (0.3.3 and older): the launcher renames them to <name>.retired before RED4ext loads them.
export const RETIRED_DLLS = Object.freeze([`${RUNTIME_PLUGIN}/CyberpunkConvai.dll`, 'red4ext/plugins/AiNpcCyberpunkModNative/CyberpunkConvaiNative.dll']);

// Which app-relative paths are code (shipped in the Scripts, copied into the Runtime's app/ by install-code.mjs). Everything else under app/
// belongs to the Runtime base: node/, python/, pocket-tts/, node_modules/, llama-cpp/, vgmstream/, models/, licenses/ (but licenses/client/),
// omni/, local-ai/, release.json, and in defaults/ the voice lists, the sign-in settings, the removal list and the update-step markers.
export const CODE_PREFIXES = Object.freeze(['bridge/', 'launcher/', 'assets/', 'characters/', 'research/', 'vision/', 'licenses/client/']);
export const CODE_FILES = Object.freeze(['package.json', 'defaults/characters.json', 'defaults/multilingual-profiles.json', 'defaults/runtime-code-files.json']);

// A relative path with forward slashes and no '.', '..' or empty part, no drive, colon, backslash or control character.
export function safeRelative(rel) {
  if (typeof rel !== 'string' || !rel || rel.length > 300 || /[\x00-\x1f\\:*?"<>|]/.test(rel) || rel.startsWith('/')) return false;
  return rel.split('/').every(part => part && part !== '.' && part !== '..' && !/[. ]$/.test(part) && !/~\d/.test(part));
}

export const isCodePath = rel => safeRelative(rel) && (CODE_FILES.includes(rel) || CODE_PREFIXES.some(prefix => rel.startsWith(prefix)));

// A game-relative path the Runtime's removal lists must never delete: the code copy install-code.mjs owns, and its list.
export function isCodeGamePath(gameRelative) {
  if (typeof gameRelative !== 'string' || !gameRelative.startsWith(`${RUNTIME_APP}/`)) return false;
  const rel = gameRelative.slice(RUNTIME_APP.length + 1);
  return rel === INSTALLED_MANIFEST || isCodePath(rel);
}

// The manifest the Scripts carry (code.json) and the Runtime keeps (defaults/scripts-code.json).
//   {version: 1, product, package: 'scripts-code', release, game, commit, runtimeBase, files: [{path, size, sha256}, ...]}
// release: the Scripts version; runtimeBase: the oldest Runtime base these Scripts run on.
export function manifestOf({product, release, game, commit, runtimeBase, files}) {
  const rows = [...files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  for (const row of rows) if (!isCodePath(row.path)) throw Error(`Not a code path: ${row.path}`);
  return {version: 1, product, package: 'scripts-code', release, game, commit, runtimeBase, files: rows};
}

// Version order of two release strings (0.3.4, 0.3.10, 2077.1): negative when a is older. Non-numeric parts compare as 0.
export function compareVersions(a, b) {
  const parts = value => String(value ?? '').split(/[-+]/)[0].split('.').map(part => Number.parseInt(part, 10) || 0);
  const x = parts(a), y = parts(b);
  for (let index = 0; index < Math.max(x.length, y.length); index += 1) {
    const difference = (x[index] ?? 0) - (y[index] ?? 0);
    if (difference) return difference;
  }
  return 0;
}
