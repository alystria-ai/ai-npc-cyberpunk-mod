// What the OmniVoice pack leaves out, and how its model and notices are written. Shared by packaging/build-release.mjs (a build from scratch) and
// packaging/rebuild-omni-pack.mjs (the same pack made from an existing OmniPack zip), so the two cannot drift. docs/PACKAGING.md, "The OmniVoice pack".
import {createReadStream} from 'node:fs';
import {crc32} from 'node:zlib';

export const PLUGIN = 'red4ext/plugins/AiNpcCyberpunkMod';
export const OMNI_PYTHON = `${PLUGIN}/app/omni/python/`;
export const OMNI_MODEL = `${PLUGIN}/app/omni/model/`;
export const OMNI_MODEL_FILE = `${OMNI_MODEL}model.safetensors`;
export const OMNI_AUDIO_TOKENIZER_FILE = `${OMNI_MODEL}audio_tokenizer/model.safetensors`;

// A folder of a Python package that holds only its own tests. `tests` (pandas, numpy, scipy, sympy, setuptools ...) and `test` (joblib,
// lightning_utilities) are never imported by the worker; `testing` is NOT in the list: torch.testing and numpy.testing are real packages that
// other modules import.
const TEST_FOLDERS = new Set(['tests', 'test']);
export const isPythonTestFile = path => {
  const parts = path.split('/');
  const at = parts.indexOf('site-packages');
  return at >= 0 && parts.slice(at + 1, -1).some(part => TEST_FOLDERS.has(part));
};

// torch/bin/ holds copies of two DLLs that torch/lib/ also holds with the same bytes (fbgemm.dll, asmjit.dll). torch loads its DLLs from
// torch/lib (torch/__init__.py adds that folder to the DLL search path), so the copies in bin/ are never read.
const TORCH_BIN_COPIES = new Set(['fbgemm.dll', 'asmjit.dll']);
export const isTorchBinCopy = path => {
  const match = /\/site-packages\/torch\/bin\/([^/]+)$/.exec(path);
  return Boolean(match) && TORCH_BIN_COPIES.has(match[1].toLowerCase());
};

// Draft clips of the first cast (the 0.2.1 lists named them; no list since does, and the Runtime of 0.2.1 dropped its copies too).
export const DRAFT_CLIP_FOLDER = `${PLUGIN}/voices/full-cast-draft/`;
export const isDraftClip = path => path.toLowerCase().startsWith(DRAFT_CLIP_FOLDER);

/** Why a file of the pack is left out (a short phrase), or null when it stays. `path` is the path inside the zip. */
export function omniLeaveOutReason(path) {
  if (isPythonTestFile(path)) return 'tests folder of a Python package';
  if (isTorchBinCopy(path)) return 'copy of a DLL in torch/lib';
  if (isDraftClip(path)) return 'draft clip of the first cast';
  return null;
}

// The same rules for a build that walks the staged Python folder (paths relative to it: Lib/site-packages/...).
export const omniPythonSkip = rel => omniLeaveOutReason(`${OMNI_PYTHON}${rel}`) !== null;

// The OmniVoice model file as it ships: the upstream float32 file rounded to float16 (packaging/convert-omni-fp16.py), the precision the worker loads it in.
// The audio tokenizer is NOT converted: OmniVoice loads it without a dtype, so it runs as float32.
export const OMNI_PRECISION = Object.freeze({model: 'float16', audioTokenizer: 'float32'});

/** The lines of the pack's THIRD-PARTY-NOTICES.txt. `tool` is toolchain from release.config.json, `studio` its voiceStudio entry. */
export function omniNoticeLines({tool, studio}) {
  const model = tool.omniModel;
  return [
    `Python ${tool.omniPython.version} embeddable distribution - PSF License: app/omni/python/LICENSE.txt`,
    `Python packages (omni.lock.txt), including PyTorch with CUDA 12.8 - licences in each *.dist-info folder`,
    `VoiceStudio ${studio.revision} (OmniVoice adapter and the omnivoice package) - ${studio.license} - ${studio.repository}`,
    `OmniVoice model (${model.repository} ${model.revision}) - code Apache-2.0, pretrained weights CC-BY-NC (see app/omni/model/README.md)`,
    `CHANGED: app/omni/model/model.safetensors is the upstream file with its weights rounded from float32 to float16 (the precision the voice engine loads them in; `
      + `packaging/convert-omni-fp16.py; upstream SHA-256 ${model.files['model.safetensors'].sha256}, this file ${model.converted['model.safetensors'].sha256}). `
      + 'The other model files, including the audio tokenizer, are the unmodified upstream files.',
    'OmniVoice audio tokenizer - Boson Higgs Audio 2 Community License (app/omni/model/audio_tokenizer/LICENSE)',
    `The OmniVoice weights are non-commercial (CC-BY-NC). VoiceStudio is AGPL-3.0-only: complete source at ${studio.repository} revision ${studio.revision} (app/omni/voicestudio/SOURCE.txt).`,
    'AI NPC Cyberpunk Mod itself: AI NPC Cyberpunk Mod Use License, see LICENSE.txt in this folder.',
  ];
}

export const omniNoticesText = lines => ['AI NPC Cyberpunk Mod OmniVoice pack - third-party components', '', ...lines.map(line => `- ${line}`), ''].join('\r\n');

/** The pack's marker, omni-pack.json (the launcher reads `model`, the setup check only that the file exists). */
export function omniMarker({config, version, commit}) {
  const tool = config.toolchain, model = tool.omniModel, studio = tool.voiceStudio;
  return {product: config.product, package: 'omni', version, commit: '' + commit, python: tool.omniPython.version,
    model: `${model.repository}@${model.revision}`, adapter: `${studio.repository}@${studio.revision}`,
    precision: OMNI_PRECISION, modelFileSha256: model.converted['model.safetensors'].sha256};
}

/** The paths a Runtime carries that the pack must not carry too (packaging/pack-listings/runtime-omni-clips-<v>.json: [path, size, crc] rows). */
export function runtimeClipSet(listing) {
  if (listing?.schema !== 1 || !Array.isArray(listing.files)) throw Error('Not a Runtime clip listing (schema 1).');
  return new Map(listing.files.map(([path, size, crc]) => [path.toLowerCase(), {path, size, crc}]));
}

/** CRC-32 of a file as eight hex digits (what zip directories and the pack listings carry). */
export async function crcOfFile(path) {
  let crc = 0;
  for await (const chunk of createReadStream(path, {highWaterMark: 4 * 1024 * 1024})) crc = crc32(chunk, crc);
  return (crc >>> 0).toString(16).padStart(8, '0');
}
