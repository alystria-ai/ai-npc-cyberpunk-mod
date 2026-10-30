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
//  Three archives that the main file must not hold (an archive inside a download trips antivirus scanners, packaging/lib/package-guards.mjs):
//  networkx/generators/atlas.dat.gz The graph atlas (1253 small graphs). Only networkx.generators.atlas.graph_atlas() and graph_atlas_g() open it, on a call: the
//                                   module reads the path at import and the file at call time. Nothing of ours, torch or sympy calls either.
//  scipy/stats/_sobol_direction_numbers.npz  A numpy zip of Sobol direction numbers, opened by scipy.stats.qmc.Sobol when a generator is made. Importing scipy.stats
//                                   does not open it. Nothing of ours uses scipy.stats.qmc (the phone worker and the clip builder use scipy.signal).
//  Lib/site-packages/<name>.whl     A zero-byte file named like the scipy wheel, found at the top of site-packages in the 0.3.5 Runtime. Nothing reads it.
const SITE = 'Lib/site-packages/';
const TESTS_FOLDER = /^Lib\/site-packages\/(?:[^/]+\/)+tests\//;

export const PYTHON_PRUNE_RULES = Object.freeze([
  {id: 'sherpa-core-scripts', test: rel => rel.startsWith(`${SITE}Scripts/`)},
  {id: 'torch-bin', test: rel => rel.startsWith(`${SITE}torch/bin/`)},
  {id: 'package-tests', test: rel => TESTS_FOLDER.test(rel)},
  {id: 'networkx-atlas', test: rel => rel === `${SITE}networkx/generators/atlas.dat.gz`},
  {id: 'scipy-sobol-numbers', test: rel => rel === `${SITE}scipy/stats/_sobol_direction_numbers.npz`},
  {id: 'stray-wheel', test: rel => /^Lib\/site-packages\/[^/]+\.whl$/i.test(rel)},
]);

// Files a Python worker never loads at run time: C/C++ headers, link libraries, CMake files, caches. Applied to every Python the release builds (the Runtime's and the
// OmniPack's). A .pyc outside site-packages is the unzipped standard library itself (sourceless, packaging/build-release.mjs installPython), so it is kept (the rule
// before the unzip skipped every .pyc, which with an unzipped Lib ships no standard library; packaging/runtime-python.test.mjs holds the rule against the files the voice workers load).
export const PYTHON_SKIP = rel => /(?:^|\/)__pycache__(?:\/|$)/.test(rel) || /^Lib\/site-packages\/.*\.pyc$/.test(rel)
  || /^Lib\/site-packages\/torch\/(?:include|share)\//.test(rel) || /^Lib\/site-packages\/torch\/lib\/[^/]+\.lib$/i.test(rel)
  // Build tools inside wheels: setuptools' script-launcher stubs and PyTorch's protobuf compiler.
  || /^Lib\/site-packages\/setuptools\/(?:cli|gui)[^/]*\.exe$/i.test(rel) || /^Lib\/site-packages\/torch\/bin\/[^/]+\.exe$/i.test(rel);

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
