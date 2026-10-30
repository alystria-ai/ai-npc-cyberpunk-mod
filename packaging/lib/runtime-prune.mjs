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
//  Five torch files that made the longest paths of the Runtime (over 140 characters inside the zip; a Mod Organizer 2 or Vortex mod folder named after the
//  mod leaves little room under Windows' 260, MAX_RUNTIME_ENTRY_PATH below). None is imported by `import torch`, by the Pocket, speech-to-text or phone workers
//  or by anything else of ours (checked 2026-10-31 against the 0.3.5 Runtime: the workers' imports and a Pocket generation give the same audio with the files gone):
//  torch/ao/pruning/_experimental/data_sparsifier/lightning/callbacks/   Experimental sparsifier callbacks for PyTorch Lightning, which is not shipped.
//  torch/_inductor/codegen/cuda/cutlass_lib_extensions/gemm_operation_extensions.py   CUDA CUTLASS code generation for torch.compile, imported on demand only.
//  torch/testing/_internal/distributed/rpc/examples/reinforcement_learning_rpc_test.py   An example script of torch's own tests.
//  torch/distributed/_shard/sharding_spec/chunk_sharding_spec_ops/embedding_bag.py   Sharded-tensor embedding ops. Without it torch.distributed._shard.sharded_tensor
//                                   and torch.distributed.fsdp no longer import: multi-GPU training, which no worker of ours does.
//  torch/distributed/elastic/multiprocessing/subprocess_handler/subprocess_handler.py   The torchrun launcher's subprocess wrapper. Without it
//                                   torch.distributed.elastic.multiprocessing no longer imports: the launcher, not `import torch.distributed`.
const SITE = 'Lib/site-packages/';
const TESTS_FOLDER = /^Lib\/site-packages\/(?:[^/]+\/)+tests\//;

export const PYTHON_PRUNE_RULES = Object.freeze([
  {id: 'sherpa-core-scripts', test: rel => rel.startsWith(`${SITE}Scripts/`)},
  {id: 'torch-bin', test: rel => rel.startsWith(`${SITE}torch/bin/`)},
  {id: 'package-tests', test: rel => TESTS_FOLDER.test(rel)},
  {id: 'networkx-atlas', test: rel => rel === `${SITE}networkx/generators/atlas.dat.gz`},
  {id: 'scipy-sobol-numbers', test: rel => rel === `${SITE}scipy/stats/_sobol_direction_numbers.npz`},
  {id: 'stray-wheel', test: rel => /^Lib\/site-packages\/[^/]+\.whl$/i.test(rel)},
  {id: 'torch-lightning-callbacks', test: rel => rel.startsWith(`${SITE}torch/ao/pruning/_experimental/data_sparsifier/lightning/callbacks/`)},
  {id: 'torch-cutlass-extensions', test: rel => rel === `${SITE}torch/_inductor/codegen/cuda/cutlass_lib_extensions/gemm_operation_extensions.py`},
  {id: 'torch-rpc-example', test: rel => rel === `${SITE}torch/testing/_internal/distributed/rpc/examples/reinforcement_learning_rpc_test.py`},
  {id: 'torch-shard-embedding-bag', test: rel => rel === `${SITE}torch/distributed/_shard/sharding_spec/chunk_sharding_spec_ops/embedding_bag.py`},
  {id: 'torch-elastic-subprocess-handler', test: rel => rel === `${SITE}torch/distributed/elastic/multiprocessing/subprocess_handler/subprocess_handler.py`},
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

// The longest path a Runtime entry may have inside the zip (release.config.json layout.maxRuntimeEntryPath is the value the build reads). Mod Organizer 2 names its
// mod folder after the Nexus title by default (41 characters for "AI Companions using Large Language Models") and may sit under
// C:/Users/<name>/AppData/Local/ModOrganizer/Cyberpunk 2077/mods/ (77 characters with a 20 character user name), which with the title leaves about 140 for an entry
// under Windows' 259 (260 with the end mark). docs/PACKAGING.md, "Path length".
export const MAX_RUNTIME_ENTRY_PATH = 140;

/** The names (zip paths) longer than `limit`. */
export const longRuntimePaths = (names, limit = MAX_RUNTIME_ENTRY_PATH) => [...names].filter(name => name.length > limit);

/**
 * A licence text of a package's dist-info that would pass the limit moves up the tree: Lib/site-packages/numpy-2.5.3.dist-info/licenses/numpy/_core/src/npysort/x86-simd-sort/LICENSE.md
 * becomes .../licenses/x86-simd-sort-LICENSE.md. The text itself ships (a BSD notice has to go with the binary), only its place changes; nothing reads these files
 * (pip's RECORD, read only by an uninstall, lists the old path). `rel` is a path inside the Python folder, `prefixLength` the length of the zip path before it.
 * Returns the new path, or null when the file stays.
 */
export function pythonRenamed(rel, prefixLength, limit = MAX_RUNTIME_ENTRY_PATH) {
  if (prefixLength + rel.length <= limit) return null;
  const match = /^(Lib\/site-packages\/[^/]+\.dist-info\/licenses\/)(?:[^/]+\/)+([^/]+)\/([^/]+)$/.exec(rel);
  return match ? `${match[1]}${match[2]}-${match[3]}` : null;
}

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
