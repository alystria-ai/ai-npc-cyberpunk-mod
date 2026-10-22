// A temporary folder with an ASCII path, for the Windows tools that cannot write a file under any other.
//
// Found on a machine whose user name is not ASCII (2026-10-21, tested with Cyrillic and Chinese folders): Windows PowerShell's Add-Type
// hands its temporary files to the C# compiler through the console code page, so with TEMP under C:\Users\<Cyrillic or Chinese name> it fails with
// "Could not write to output file ... The directory name is invalid" (bridge/audio-output-probe.ps1 compiles a small helper that way). llama-server
// had the same trouble with its key file (bridge/local-llm-server.mjs). Python, sherpa-onnx, llama-fit-params, the browser and the model paths
// of llama-server were checked with the same folders and read them without help.
//
// asciiTempEnvironment() is {} (nothing changes, nothing is run) on every other system and whenever the real temporary folder is ASCII
// already; otherwise it is {TEMP, TMP} naming an ASCII folder that exists: the 8.3 short name of the real one (cmd's `%~s` modifier; the short
// name is only a second spelling of the same folder, so the child writes where it always did), else a folder made under the player's own
// profile (LOCALAPPDATA, then USERPROFILE) when that path is ASCII. Never a folder every account can write (the old fallback under
// C:\Users\Public let another account pre-create it or swap the DLL that Add-Type builds there and loads: security review 2026-10-22, finding 13).
// {} when none of these works: one clear line says so (a log line, once), and the caller behaves as it did before (the probe fails and gives up).
import {execFileSync} from 'node:child_process';
import {existsSync, mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

export const isAsciiText = text => /^[\x20-\x7e]*$/.test(String(text ?? ''));

/** The 8.3 short spelling of a folder, or null (not Windows, no such folder, 8.3 names switched off for the volume). The path travels in the environment, not in the command line. */
export function shortPathOf(folder, {run = execFileSync, platform = process.platform} = {}) {
  if (platform !== 'win32' || !folder) return null;
  try {
    // Verbatim: Node would otherwise escape the inner quotes with backslashes, which cmd does not read.
    const text = String(run('cmd.exe', ['/d', '/s', '/c', '"for %I in ("%CONVAI_LONG_PATH%") do @echo %~sI"'],
      {env: {...process.env, CONVAI_LONG_PATH: folder}, windowsHide: true, windowsVerbatimArguments: true, timeout: 5000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']})).trim();
    return text && isAsciiText(text) && !/[\r\n"%]/.test(text) ? text : null;
  } catch { return null; }
}

let remembered = null;

export const NO_ASCII_TEMP_MESSAGE = 'The temporary folder has characters that Windows PowerShell cannot compile under, and it has no 8.3 short name or per-user ASCII folder to use instead,'
  + ' so the audio output probe may fail to start (Lip sync delay Auto then assumes 0 ms).';

export function asciiTempEnvironment({tmpDir = tmpdir(), platform = process.platform, environment = process.env, short = shortPathOf, exists = existsSync,
    makeFolder = folder => mkdirSync(folder, {recursive: true, mode: 0o700}), remember = true,
    log = message => console.error(`[CyberpunkConvai] ${message}`)} = {}) {
  if (platform !== 'win32' || isAsciiText(tmpDir)) return {};
  if (remember && remembered?.from === tmpDir) return remembered.value;
  let folder = null;
  const named = short(tmpDir);
  if (named && isAsciiText(named) && exists(named)) folder = named;
  else {
    // A folder of the player's own, under their profile: only when that path is ASCII (a profile named in Cyrillic or Chinese is not), and never
    // under a place every account can write.
    for (const base of [environment.LOCALAPPDATA, environment.USERPROFILE]) {
      if (typeof base !== 'string' || !base) continue;
      const candidate = join(base, 'AiNpcCyberpunkMod-temp');
      try { if (isAsciiText(candidate)) { makeFolder(candidate); if (exists(candidate)) { folder = candidate; break; } } } catch { /* not writable: try the next */ }
    }
  }
  if (!folder) { try { log(NO_ASCII_TEMP_MESSAGE); } catch { /* a log that fails changes nothing */ } }
  const value = folder ? {TEMP: folder, TMP: folder} : {};
  if (remember) remembered = {from: tmpDir, value};
  return value;
}
