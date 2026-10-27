// The player's own Python for OmniVoice (docs/OMNIVOICE_AMD.md): an experimental override for a graphics card the Runtime's PyTorch cannot see.
//
// The OmniVoice pack ships a CUDA build of PyTorch (app/omni/python, torch 2.8.0+cu128): it sees NVIDIA cards only, so on an AMD card its worker exits
// with "needs CUDA" and OmniVoice is not tried again (bridge/resident-voice.mjs NO_CUDA_EXIT_CODE). A player who has a PyTorch for their card in a Python
// of their own (AMD's ROCm build for Windows: torch.version.hip is set and torch.cuda.* works through HIP, device "cuda") names that python.exe in
// <data>/omni-python.txt. Nothing changes for anyone without the file: the Runtime's Python stays the default.
//
// The named Python is used only after a self-test in it passed: PyTorch imports, sees a graphics card (CUDA or ROCm), one small sum on the card is right,
// and OmniVoice's own code (the pack's copy, never one of the player's) imports with that Python's libraries. Any refusal leaves the Runtime's Python in
// place, so a failure ends as today: Pocket or text, never a cloud voice. The self-test runs on demand only: the first time OmniVoice is wanted (with
// the card list, bridge/convai-bridge.mjs) or when the Help page's setup check asks, never at start-up or on a turn. Untested on real AMD hardware.
import {spawn} from 'node:child_process';
import {readFile as fsReadFile, stat} from 'node:fs/promises';
import {basename, dirname, isAbsolute, resolve} from 'node:path';
import {DEFAULT_PRIORITY, PRIORITY_LEVELS, PRIORITY_VARIABLE, priorityLevel} from './process-priority.mjs';

export const OWN_PYTHON_FILE = 'omni-python.txt';
// Told to the worker (bridge/resident-voice-worker.py): it runs in the player's Python and loads OmniVoice's code from this folder of the pack.
export const OWN_PYTHON_VARIABLE = 'CYBERPUNK_CONVAI_OMNI_OWN_PYTHON';
export const OMNI_SOURCE_VARIABLE = 'CYBERPUNK_CONVAI_OMNI_SOURCE';
// ROCm tuning (bridge/resident-voice-worker.py tune_rocm, docs/OMNIVOICE_AMD.md): '1' keeps MIOpen's convolutions.
export const ROCM_MIOPEN_VARIABLE = 'CYBERPUNK_CONVAI_ROCM_MIOPEN';
// The worker's priority level is the same rule on both routes (bridge/process-priority.mjs, docs/PROCESS_PRIORITY.md); re-exported for the callers that had it here.
export {PRIORITY_VARIABLE};
// Importing a ROCm PyTorch and OmniVoice's libraries the first time can take a while on a cold disk; a test that says nothing for this long is refused.
export const SELF_TEST_TIMEOUT_MS = 120_000;
const MARK = '@@OMNI-SELFTEST@@';
// Why a named Python was not used: the codes the setup check and the voice state carry (the game words them, mod/setup-check.lua).
export const REFUSALS = Object.freeze(['not-absolute', 'not-found', 'not-python', 'no-pack', 'start-failed', 'timed-out', 'bad-output',
  'no-torch', 'no-gpu', 'op-failed', 'missing-module', 'omnivoice-failed']);

// The self-test, fed to the player's python.exe on stdin (`python -I - <omnivoice folder>`: isolated, so no PYTHONPATH or user site of anyone else).
// It prints one marked JSON line and always exits 0; what it found is judged here (ownPythonVerdict), not in Python.
export const SELF_TEST_SOURCE = String.raw`
import importlib.abc, importlib.util, json, os, sys
out = {'python': sys.version.split()[0]}
def done():
    sys.stdout.write('${MARK}' + json.dumps(out) + '\n'); sys.stdout.flush(); os._exit(0)
try:
    import torch
except Exception as error:
    out['error'] = 'no-torch'; out['detail'] = repr(error)[:200]; done()
out['torch'] = str(torch.__version__)
out['hip'] = getattr(torch.version, 'hip', None)
out['cuda'] = getattr(torch.version, 'cuda', None)
try:
    out['available'] = bool(torch.cuda.is_available())
except Exception as error:
    out['available'] = False; out['detail'] = repr(error)[:200]
if out['available']:
    try:
        properties = torch.cuda.get_device_properties(0)
        out['device'] = str(properties.name)[:120]
        out['vramMiB'] = int(properties.total_memory // 1048576)
        values = torch.ones(1024, device='cuda', dtype=torch.float16)
        out['op'] = float((values * 2).sum().item()) == 2048.0
        torch.cuda.synchronize()
    except Exception as error:
        out['op'] = False; out['detail'] = repr(error)[:200]
source = sys.argv[1] if len(sys.argv) > 1 else ''
if out['available'] and out.get('op') and source:
    class Packaged(importlib.abc.MetaPathFinder):
        def find_spec(self, name, path=None, target=None):
            if name != 'omnivoice':
                return None
            return importlib.util.spec_from_file_location('omnivoice', os.path.join(source, '__init__.py'), submodule_search_locations=[source])
    sys.meta_path.insert(0, Packaged())
    try:
        import numpy, soundfile, omnivoice.models.omnivoice
        out['omnivoice'] = True
    except ModuleNotFoundError as error:
        out['omnivoice'] = False; out['missing'] = str(error.name or '')[:80]; out['detail'] = repr(error)[:200]
    except Exception as error:
        out['omnivoice'] = False; out['detail'] = repr(error)[:200]
done()
`;

/**
 * The optional ROCm settings in the lines after the python.exe line (`name = value`; # comments and anything else are ignored): `miopen-find-mode = NORMAL` (MIOpen's
 * own MIOPEN_FIND_MODE instead of the mod's FAST), `miopen = on` (keep MIOpen's convolutions; the mod turns them off on ROCm), `priority = high | normal | below` (the voice worker's process
 * priority; the mod's default is high on both routes, `normal` is the way back if the game stutters). Only these three names, only these values. Pure.
 */
export function parseRocmOptions(rows) {
  const options = {};
  for (const row of rows) {
    const found = /^([a-z-]+)\s*[=:]\s*([A-Za-z0-9_]{1,24})$/.exec(row);
    if (!found) continue;
    const [, name, value] = found, lower = value.toLowerCase();
    if (name === 'miopen-find-mode') options.miopenFindMode = value.toUpperCase();
    else if (name === 'miopen' && ['on', 'off'].includes(lower)) options.miopen = lower;
    else if (name === 'priority' && PRIORITY_LEVELS.includes(lower)) options.priority = lower;
  }
  return options;
}

/**
 * The worker's environment for the ROCm route (a Python whose self-test found torch.version.hip): MIOPEN_FIND_MODE=FAST unless the file names another mode or the
 * variable is already set where the game started (`processEnv`), MIOpen's convolutions off unless `miopen = on`. The priority is not here: it is one rule for both
 * routes (omniPriority). {} for any other backend: NVIDIA and the Runtime's Python are never touched. Pure.
 */
export function rocmWorkerEnvironment(own, processEnv = process.env) {
  if (!own?.used || own.backend !== 'rocm') return {};
  const options = own.options ?? {};
  const environment = {};
  if (options.miopenFindMode) environment.MIOPEN_FIND_MODE = options.miopenFindMode;
  else if (!processEnv?.MIOPEN_FIND_MODE) environment.MIOPEN_FIND_MODE = 'FAST';
  if (options.miopen === 'on') environment[ROCM_MIOPEN_VARIABLE] = '1';
  return environment;
}

/**
 * The OmniVoice worker's priority level: the `priority =` line of omni-python.txt when the own Python names one, else the level for this PC (bridge/process-priority.mjs:
 * priority.txt, else high). 'high' on both routes by default. Pure.
 */
export function omniPriority(own, turnLevel = DEFAULT_PRIORITY) {
  const named = own?.used === true ? priorityLevel(own.options?.priority) : null;
  return named ?? priorityLevel(turnLevel) ?? DEFAULT_PRIORITY;
}

/** The python.exe named by the file's text: the first line that is not empty or a # comment, quotes and spaces trimmed. {path} or {problem}, plus `options` (parseRocmOptions) when the lines after it name some. Pure. */
export function parseOwnPythonText(text) {
  const rows = String(text ?? '').replace(/^﻿/, '').split(/\r?\n/).map(row => row.trim()).filter(row => row && !row.startsWith('#'));
  const line = rows[0];
  if (!line) return {path: null, problem: null};
  const path = line.replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1').trim();
  const qualified = process.platform !== 'win32' || /^(?:[a-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+[\\/])/i.test(path);
  if (!path || /[\x00-\x1f\x7f]/.test(path) || !isAbsolute(path) || !qualified) return {path: null, problem: 'not-absolute'};
  if (!/^python(?:3(?:\.\d+)?)?(?:\.exe)?$/i.test(basename(path))) return {path: null, problem: 'not-python'};
  const options = parseRocmOptions(rows.slice(1));
  return {path, problem: null, ...(Object.keys(options).length ? {options} : {})};
}

/**
 * The override as the player left it: {configured: false} without the file (or with only comments in it), else {configured: true, path, problem}
 * where problem is null or a REFUSALS code about the path itself. Reads one small file.
 */
export async function readOwnPythonSetting({stateDirectory, readFile = fsReadFile, isFile = defaultIsFile} = {}) {
  if (!stateDirectory) return {configured: false};
  let text;
  try { text = await readFile(resolve(stateDirectory, OWN_PYTHON_FILE), 'utf8'); } catch { return {configured: false}; }
  const {path, problem, options} = parseOwnPythonText(String(text).slice(0, 4096));
  if (!path && !problem) return {configured: false};
  if (problem) return {configured: true, path: null, problem};
  return {configured: true, path, problem: (await isFile(path)) ? null : 'not-found', ...(options ? {options} : {})};
}
async function defaultIsFile(path) { try { return (await stat(path)).isFile(); } catch { return false; } }

/** 'rocm' (torch.version.hip set), 'cuda' (a CUDA build), or 'none' (no GPU build, or PyTorch sees no card). Pure. */
export function backendOf(report) {
  if (!report || report.available !== true) return 'none';
  if (typeof report.hip === 'string' && report.hip) return 'rocm';
  if (typeof report.cuda === 'string' && report.cuda) return 'cuda';
  return 'none';
}

/** The verdict on a self-test report: {usable, backend, reason, ...facts}. reason is null for a usable Python, else a REFUSALS code. Pure. */
export function ownPythonVerdict(report) {
  if (!report || typeof report !== 'object') return {usable: false, backend: 'none', reason: 'bad-output'};
  const facts = {backend: backendOf(report), torch: clip(report.torch, 40), hip: clip(report.hip, 40), cuda: clip(report.cuda, 40),
    device: clip(report.device, 120), vramMiB: Number.isFinite(report.vramMiB) && report.vramMiB > 0 ? Math.round(report.vramMiB) : null,
    python: clip(report.python, 20)};
  const refuse = (reason, extra = {}) => ({usable: false, ...facts, reason, ...extra, detail: clip(report.detail, 200)});
  if (report.error === 'no-torch') return refuse('no-torch');
  if (report.available !== true || facts.backend === 'none') return refuse('no-gpu');
  if (report.op !== true) return refuse('op-failed');
  if (report.omnivoice !== true) return report.missing ? refuse('missing-module', {module: clip(report.missing, 80)}) : refuse('omnivoice-failed');
  return {usable: true, ...facts, reason: null};
}
const clip = (value, size) => typeof value === 'string' && value.trim() ? value.trim().slice(0, size) : null;

/**
 * Runs the self-test in `python` (absolute) with the pack's OmniVoice folder `source`: resolves to the raw report, or {error: 'start-failed' |
 * 'timed-out' | 'bad-output'}. Never throws. The process is stopped when it runs out of time.
 */
export function runOwnPythonSelfTest({python, source, spawnImpl = spawn, timeoutMs = SELF_TEST_TIMEOUT_MS, setTimer = setTimeout, clearTimer = clearTimeout,
  environment = process.env} = {}) {
  return new Promise(done => {
    let child, timer = null, output = '', finished = false;
    const finish = value => { if (finished) return; finished = true; clearTimer(timer); done(value); };
    try {
      child = spawnImpl(python, ['-I', '-', source ?? ''], {windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
        env: {...environment, PYTHONUTF8: '1', PYTHONNOUSERSITE: '1', PYTHONDONTWRITEBYTECODE: '1'}});
    } catch { finish({error: 'start-failed'}); return; }
    timer = setTimer(() => { try { child.kill(); } catch {} finish({error: 'timed-out'}); }, timeoutMs);
    timer?.unref?.();
    child.stdout?.setEncoding?.('utf8');
    child.stdout?.on('data', part => { output = (output + part).slice(-64_000); });
    child.stderr?.on('data', () => {});
    child.on('error', () => finish({error: 'start-failed'}));
    child.on('close', () => {
      const line = output.split(/\r?\n/).reverse().find(row => row.startsWith(MARK));
      if (!line) { finish({error: 'bad-output'}); return; }
      try { const value = JSON.parse(line.slice(MARK.length)); finish(value && typeof value === 'object' ? value : {error: 'bad-output'}); }
      catch { finish({error: 'bad-output'}); }
    });
    try { child.stdin.on?.('error', () => {}); child.stdin.end(SELF_TEST_SOURCE); } catch { /* close or error ends it */ }
  });
}

/** The pack's own OmniVoice code beside the Runtime's OmniVoice Python (app/omni/python/Lib/site-packages/omnivoice). */
export const packagedOmniSource = runtimePython => runtimePython ? resolve(dirname(runtimePython), 'Lib', 'site-packages', 'omnivoice') : null;

/**
 * The whole decision: {configured: false} without the override, else {configured: true, used, path, reason, backend, ...facts}. `used` is true only for a
 * Python whose self-test passed; a refusal names its reason and the Runtime's Python stays. `packInstalled` false refuses at once ('no-pack': the model and
 * OmniVoice's code come from the pack). Never throws.
 */
export async function resolveOwnPython({stateDirectory, runtimePython, packInstalled = true, readSetting = readOwnPythonSetting, selfTest = runOwnPythonSelfTest,
  exists = defaultIsFile} = {}) {
  let setting;
  try { setting = await readSetting({stateDirectory}); } catch { setting = {configured: false}; }
  if (!setting?.configured) return {configured: false};
  const base = {configured: true, used: false, path: setting.path ?? null, ...(setting.options ? {options: setting.options} : {})};
  if (setting.problem) return {...base, backend: null, reason: setting.problem};
  const source = packagedOmniSource(runtimePython);
  if (!packInstalled || !source || !(await exists(resolve(source, '__init__.py')))) return {...base, backend: null, reason: 'no-pack'};
  let report;
  try { report = await selfTest({python: setting.path, source}); } catch { report = {error: 'start-failed'}; }
  if (report && ['start-failed', 'timed-out', 'bad-output'].includes(report.error)) return {...base, backend: null, reason: report.error};
  const verdict = ownPythonVerdict(report);
  const {usable, ...facts} = verdict;
  return {...base, ...facts, used: usable === true, source: usable ? source : null};
}

/** One log line about the decision (no folder names but the python.exe the player chose; the report keeps the same facts). */
export function ownPythonLine(result) {
  if (!result?.configured) return 'OmniVoice uses the Runtime\'s Python (no omni-python.txt)';
  const card = result.device ? `, ${result.device}${result.vramMiB ? ` ${result.vramMiB} MiB` : ''}` : '';
  const build = result.backend === 'rocm' ? `ROCm/HIP ${result.hip ?? '?'}` : result.backend === 'cuda' ? `CUDA ${result.cuda ?? '?'}` : 'no GPU backend';
  if (result.used) return `OmniVoice uses the player's own Python (experimental): PyTorch ${result.torch ?? '?'}, ${build}${card}`;
  const why = result.reason === 'missing-module' ? `missing-module ${result.module ?? '?'}` : result.reason;
  return `omni-python.txt was not used (${why}${result.backend ? `; backend: ${build}${card}` : ''}${result.detail ? `; ${result.detail}` : ''}); OmniVoice uses the Runtime's Python`;
}

/** What the voice state and the support report carry: small, no folder names. null without the override. */
export function ownPythonSummary(result) {
  if (!result?.configured) return null;
  return {used: result.used === true, backend: result.backend ?? null, reason: result.reason ?? null, module: result.module ?? null,
    torch: result.torch ?? null, hip: result.hip ?? null, cuda: result.cuda ?? null, device: result.device ?? null, vramMiB: result.vramMiB ?? null};
}
