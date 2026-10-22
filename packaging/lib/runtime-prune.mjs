// What the Runtime build leaves out because no code of ours (and no code of the packages we ship) loads it. One place, so the release build
// (packaging/build-release.mjs) and the tests (packaging/runtime-prune.test.mjs) read the same rules. docs/PACKAGING.md, "What the Runtime leaves out".
//
// None of this reaches the OmniPack: its Python (3.11, CUDA torch) is built by the same installer but has its own closure that nobody has run
// without these files; it can take the same rules at its next rebuild, after a run on a CUDA machine.

// ---- Python (app/python) -------------------------------------------------------------------------------------------------------------------
// `rel` is a path inside the Python folder, forward slashes ("Lib/site-packages/torch/bin/fbgemm.dll").
//
//  Lib/site-packages/Scripts/       The data folder of the sherpa-onnx-core wheel: a second copy of onnxruntime.dll and the sherpa-onnx C and C++ API
//                                   libraries, byte for byte what Lib/site-packages/sherpa_onnx/lib/ holds. sherpa_onnx/__init__.py loads its own
//                                   lib/ folder; nothing names Scripts/ (pip's RECORD lists it, which only an uninstall reads).
//  torch/bin/                       asmjit.dll and fbgemm.dll, identical to the two in torch/lib/. torch/__init__.py puts torch/lib on the DLL
//                                   search path and pre-loads every DLL in it; torch/bin is on no path (the only use of "bin" in torch is the Linux
//                                   torch_shm_manager). The build already drops the .exe files that were the rest of this folder.
//  <package>/tests/                 The packages' own unit tests and their data (2,348 files). Nothing imports a tests folder; torch/testing,
//                                   numpy/testing and sympy/testing are different folders (real packages other code imports) and stay.
const SITE = 'Lib/site-packages/';
const TESTS_FOLDER = /^Lib\/site-packages\/(?:[^/]+\/)+tests\//;

export const PYTHON_PRUNE_RULES = Object.freeze([
  {id: 'sherpa-core-scripts', test: rel => rel.startsWith(`${SITE}Scripts/`)},
  {id: 'torch-bin', test: rel => rel.startsWith(`${SITE}torch/bin/`)},
  {id: 'package-tests', test: rel => TESTS_FOLDER.test(rel)},
]);

/** True for a file of the Runtime's Python that the build leaves out (in addition to the build's own PYTHON_SKIP). */
export const pythonPruned = rel => PYTHON_PRUNE_RULES.some(rule => rule.test(rel));

// ---- Pocket TTS source (app/pocket-tts) ----------------------------------------------------------------------------------------------------
// The upstream checkout has 140 files; the voice worker imports the pocket_tts/ package only (bridge/pocket-voice-worker.py puts the folder on
// sys.path), and the licence stays beside it. The rest is the repository around the package: its tests, training code, documentation site,
// Docker and CI files, lock file and contributor notes (88 files). The build still checks the whole upstream tree against the pinned digest and
// the list in bridge/pocket_voice_runtime.py; it just ships these files only, and the worker's source check (source_shipped() in
// bridge/pocket_voice_runtime.py) looks at exactly these.
export const POCKET_SHIPPED_PREFIX = 'pocket_tts/';
export const POCKET_SHIPPED_FILES = Object.freeze(['LICENSE']);

/** True for a file of the pinned Pocket TTS tree (path relative to its root) that the Runtime ships. */
export const pocketShipped = rel => rel.startsWith(POCKET_SHIPPED_PREFIX) || POCKET_SHIPPED_FILES.includes(rel);

// ---- Node packages (app/node_modules) ------------------------------------------------------------------------------------------------------
// `rel` is a path inside one package folder (the bridge imports `chromium` from "playwright" and starts the system browser; no browser is shipped).
//  playwright-core/bin/   install scripts (.ps1 and .sh) that `playwright install` runs to fetch or replace a browser; the bridge never installs one.
//  *.d.ts                 TypeScript declarations (index.d.ts, types/*.d.ts); Node never reads them, "types" in package.json is for editors.
export const nodePackagePruned = (name, rel) => (name === 'playwright-core' && rel.startsWith('bin/')) || /\.d\.ts$/i.test(rel);
