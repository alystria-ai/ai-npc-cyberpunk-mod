// What an error report says about the PC and the install beyond the graphics card and the memory (docs/ERROR_REPORTS.md, "The PC"): the processor, the Windows
// edition, build and language, the security products Windows Security Center knows (who blocks files), Smart App Control, whether this process runs with administrator rights,
// the drive of the game (kind, free space, under Program Files or not), the display, and the NAMES of the installed mods (CET mods, RED4ext plugins, r6/scripts folders, archive
// files, REDmod mods) so a conflict is visible. No user name, no folder (a name is a file or folder name, one level, never a path), no key.
//
// FPS first. The PowerShell reads (the quick facts, Defender's folder protection and the drive's SSD/HDD kind: 3 to 8 s each on a busy PC) are CPU work, so they are kept off the
// player's time: the answer is saved in the state folder (system-facts.json, with its time) and used for 7 days; only an install with no fresh copy reads again, in the
// background, one read at a time, each PowerShell child at idle priority and never waited for. A report is built from whatever is there at that moment (the saved copy, or none
// on the very first run) and later reports carry what the read found. The mod names are a few directory listings and are read once per process. Never on a turn's path, never
// per frame. Never throws: a field that cannot be read is null.
import {execFile} from 'node:child_process';
import {readFile as realReadFile, readdir as realReaddir, writeFile as realWriteFile} from 'node:fs/promises';
import {constants as osConstants, cpus as osCpus, setPriority} from 'node:os';
import {join} from 'node:path';
import {promisify} from 'node:util';

// The reads run at idle priority (Windows IDLE_PRIORITY_CLASS, never above below-normal) and do not keep the process alive.
const defaultRun = (file, args, options) => {
  const call = promisify(execFile)(file, args, options);
  try { if (call.child?.pid) setPriority(call.child.pid, osConstants.priority.PRIORITY_LOW); } catch { /* the priority stays */ }
  try { call.child?.unref?.(); } catch { /* ignore */ }
  return call;
};
const POWERSHELL_TIMEOUT_MS = 40_000;
const NAME_LIMIT = 60;
// A long mod list stays bounded so a report stays far under its size limit: the first names (sorted) and how many more there were.
export const MOD_LIST_LIMITS = Object.freeze({cet: 100, red4ext: 60, scripts: 80, archives: 200, redmod: 60, tweaks: 60, plugins: 60});

const clip = (value, size = NAME_LIMIT) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, size) : null;
const whole = value => Number.isFinite(Number(value)) && Number(value) > 0 ? Math.round(Number(value)) : null;
const tenth = value => Number.isFinite(Number(value)) && Number(value) >= 0 ? Math.round(Number(value) * 10) / 10 : null;

// One PowerShell script, values for it in the environment (never in the command text). Prints one line of JSON.
export const FACTS_SCRIPT = [
  "$ErrorActionPreference = 'SilentlyContinue'; [Console]::OutputEncoding = [Text.Encoding]::UTF8; $o = [ordered]@{};",
  "$c = Get-CimInstance Win32_Processor | Select-Object -First 1; $o.cpu = [ordered]@{name = $c.Name; cores = $c.NumberOfCores; threads = $c.NumberOfLogicalProcessors};",
  "$w = Get-CimInstance Win32_OperatingSystem; $v = Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion';",
  "$o.os = [ordered]@{caption = $w.Caption; edition = $v.EditionID; displayVersion = $v.DisplayVersion; build = $v.CurrentBuild; revision = $v.UBR;",
  "  uiLanguage = (Get-UICulture).Name; installLanguage = [Globalization.CultureInfo]::InstalledUICulture.Name; region = (Get-Culture).Name};",
  "$o.antivirus = @(Get-CimInstance -Namespace root/SecurityCenter2 -ClassName AntiVirusProduct | ForEach-Object { [ordered]@{name = $_.displayName; on = ((($_.productState -shr 12) -band 15) -eq 1)} });",
  "$sac = (Get-ItemProperty 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\CI\\Policy').VerifiedAndReputablePolicyState; $o.smartAppControl = $sac;",
  "$o.elevated = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator);",
  "$d = $env:FACT_DRIVE; if ($d -match '^[A-Za-z]$') {",
  "  $k = Get-CimInstance Win32_LogicalDisk -Filter (\"DeviceID='\" + $d + \":'\");",
  "  $o.drive = [ordered]@{kind = $k.DriveType; fileSystem = $k.FileSystem; freeGiB = [math]::Round($k.FreeSpace / 1GB, 1); sizeGiB = [math]::Round($k.Size / 1GB, 0)} };",
  "$g = Get-CimInstance Win32_VideoController | Where-Object { $_.CurrentHorizontalResolution } | Select-Object -First 1;",
  "$o.display = [ordered]@{width = $g.CurrentHorizontalResolution; height = $g.CurrentVerticalResolution; refreshHz = $g.CurrentRefreshRate};",
  "ConvertTo-Json -InputObject $o -Depth 5 -Compress"].join(' ');

// The slow reads, each in its own process: Defender's Controlled Folder Access (blocks writes to the Documents folder and others) and the kind of disk under the game's drive.
export const DEFENDER_SCRIPT = "$ErrorActionPreference = 'SilentlyContinue'; ConvertTo-Json -InputObject ([ordered]@{controlledFolderAccess = (Get-MpPreference).EnableControlledFolderAccess}) -Compress";
export const DISK_SCRIPT = [
  "$ErrorActionPreference = 'SilentlyContinue'; $d = $env:FACT_DRIVE; $m = $null; $b = $null;",
  "if ($d -match '^[A-Za-z]$') { $n = (Get-Partition -DriveLetter $d | Get-Disk).Number; $p = Get-PhysicalDisk | Where-Object { [string]$_.DeviceId -eq [string]$n }; $m = [string]$p.MediaType; $b = [string]$p.BusType }",
  "ConvertTo-Json -InputObject ([ordered]@{media = $m; bus = $b}) -Compress"].join(' ');

const DRIVE_KINDS = {2: 'removable', 3: 'fixed', 4: 'network', 5: 'optical', 6: 'ram'};
const SMART_APP_CONTROL = {0: 'off', 1: 'on', 2: 'evaluation'};
const CFA = {0: 'off', 1: 'on', 2: 'audit'};

/** The game folder is under Program Files (any of its three spellings), by the path as written; case ignored. Pure. */
export function underProgramFiles(game, env = process.env) {
  const norm = value => String(value ?? '').replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
  const path = norm(game);
  if (!path) return null;
  return ['ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432'].map(name => norm(env?.[name])).filter(Boolean)
    .some(root => path === root || path.startsWith(root + '\\'));
}

/** The drive letter of a Windows path, or null. Pure. */
export const driveLetter = game => /^([A-Za-z]):[\\/]/.exec(String(game ?? ''))?.[1]?.toUpperCase() ?? null;

/** The part of the PowerShell answer that is understood, shaped for the report. Pure; a field that is not what it should be is null. */
export function shapeWindowsFacts(raw, {game, env = process.env, defender, disk} = {}) {
  const value = raw && typeof raw === 'object' ? raw : {};
  if (defender && typeof defender === 'object') value.controlledFolderAccess = defender.controlledFolderAccess;
  if (disk && typeof disk === 'object') value.drive = {...(value.drive && typeof value.drive === 'object' ? value.drive : {}), media: disk.media, bus: disk.bus};
  const section = key => (value[key] && typeof value[key] === 'object' && !Array.isArray(value[key]) ? value[key] : {});
  const os = section('os'), drive = section('drive'), display = section('display'), cpu = section('cpu');
  const list = Array.isArray(value.antivirus) ? value.antivirus : value.antivirus && typeof value.antivirus === 'object' ? [value.antivirus] : [];
  return {
    cpu: {name: clip(cpu.name, 120), cores: whole(cpu.cores), threads: whole(cpu.threads)},
    os: {caption: clip(os.caption, 80), edition: clip(os.edition, 40), displayVersion: clip(os.displayVersion, 20), build: whole(os.build), revision: whole(os.revision),
      uiLanguage: clip(os.uiLanguage, 20), installLanguage: clip(os.installLanguage, 20), region: clip(os.region, 20)},
    antivirus: list.slice(0, 8).map(item => ({name: clip(item?.name, 80), on: typeof item?.on === 'boolean' ? item.on : null})).filter(item => item.name),
    smartAppControl: SMART_APP_CONTROL[Number(value.smartAppControl)] ?? null,
    controlledFolderAccess: CFA[Number(value.controlledFolderAccess)] ?? null,
    elevated: typeof value.elevated === 'boolean' ? value.elevated : null,
    drive: {letter: driveLetter(game), kind: DRIVE_KINDS[Number(drive.kind)] ?? null, fileSystem: clip(drive.fileSystem, 12), freeGiB: tenth(drive.freeGiB), sizeGiB: whole(drive.sizeGiB),
      media: clip(drive.media, 20) || null, bus: clip(drive.bus, 20) || null, underProgramFiles: underProgramFiles(game, env)},
    display: {width: whole(display.width), height: whole(display.height), refreshHz: whole(display.refreshHz)},
  };
}

// The names in one folder: directories only (`kind` 'dir'), or files with one of the extensions, sorted, bounded; {names, more}. A folder that is not there is empty.
async function names(folder, {kind, extensions, limit, readdir}) {
  let entries;
  try { entries = await readdir(folder, {withFileTypes: true}); } catch { return {names: [], more: 0}; }
  const found = [];
  for (const entry of entries) {
    const isDir = typeof entry?.isDirectory === 'function' ? entry.isDirectory() : false;
    if (kind === 'dir' ? !isDir : isDir) continue;
    const name = clip(String(entry?.name ?? ''));
    if (!name || name.startsWith('.')) continue;
    if (extensions && !extensions.some(extension => name.toLowerCase().endsWith(extension))) continue;
    found.push(name);
  }
  found.sort((a, b) => a.toLowerCase() < b.toLowerCase() ? -1 : a.toLowerCase() > b.toLowerCase() ? 1 : 0);
  return {names: found.slice(0, limit), more: Math.max(0, found.length - limit)};
}

/**
 * The names of the installed mods: {cet, red4ext, scripts, archives, redmod, tweaks, plugins, more}. cet: Cyber Engine Tweaks mod folders; red4ext: RED4ext plugin folders;
 * scripts: the folders (and .reds files) of r6/scripts; archives: the .archive files of archive/pc/mod; redmod: the REDmod mods; tweaks: r6/tweaks; plugins: the .asi and .dll
 * files next to the game (bin/x64/plugins). `more` has the number of names left out of a list that was cut. Reads directory listings only; never throws.
 */
export async function detectModNames({game, readdir = realReaddir} = {}) {
  const empty = {cet: [], red4ext: [], scripts: [], archives: [], redmod: [], tweaks: [], plugins: [], more: {}};
  if (typeof game !== 'string' || !game) return empty;
  const where = {
    cet: [join(game, 'bin', 'x64', 'plugins', 'cyber_engine_tweaks', 'mods'), {kind: 'dir'}],
    red4ext: [join(game, 'red4ext', 'plugins'), {kind: 'dir'}],
    scripts: [join(game, 'r6', 'scripts'), {kind: 'any', extensions: ['.reds']}],
    archives: [join(game, 'archive', 'pc', 'mod'), {kind: 'file', extensions: ['.archive']}],
    redmod: [join(game, 'mods'), {kind: 'dir'}],
    tweaks: [join(game, 'r6', 'tweaks'), {kind: 'any', extensions: ['.yaml', '.yml', '.xl']}],
    plugins: [join(game, 'bin', 'x64', 'plugins'), {kind: 'file', extensions: ['.asi', '.dll']}],
  };
  const out = {...empty, more: {}};
  await Promise.all(Object.entries(where).map(async ([key, [folder, options]]) => {
    let result;
    if (options.kind === 'any') {
      // Folders and the listed files together (r6/scripts holds folders of mods and a few loose .reds files).
      const [dirs, files] = await Promise.all([names(folder, {kind: 'dir', limit: MOD_LIST_LIMITS[key], readdir}),
        names(folder, {kind: 'file', extensions: options.extensions, limit: MOD_LIST_LIMITS[key], readdir})]);
      const all = [...dirs.names, ...files.names].sort((a, b) => a.toLowerCase() < b.toLowerCase() ? -1 : 1);
      result = {names: all.slice(0, MOD_LIST_LIMITS[key]), more: dirs.more + files.more + Math.max(0, all.length - MOD_LIST_LIMITS[key])};
    } else result = await names(folder, {kind: options.kind, extensions: options.extensions, limit: MOD_LIST_LIMITS[key], readdir});
    out[key] = result.names;
    if (result.more > 0) out.more[key] = result.more;
  }));
  return out;
}

/** The Windows reads, ONE AT A TIME (never side by side): the shaped facts, or null when the quick read gives nothing. `run` is a promisified execFile (tests). */
export async function readWindowsFacts({game, run = defaultRun, platform = process.platform, env = process.env} = {}) {
  if (platform !== 'win32') return null;
  const shell = join(env.SystemRoot || env.windir || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const letter = driveLetter(game);
  const options = {timeout: POWERSHELL_TIMEOUT_MS, windowsHide: true, encoding: 'utf8', maxBuffer: 1 << 18, env: {...env, ...(letter ? {FACT_DRIVE: letter} : {})}};
  const read = async script => {
    try {
      const result = await run(shell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], options);
      return JSON.parse(String(result?.stdout ?? '').trim().split(/\r?\n/).filter(Boolean).at(-1));
    } catch { return null; }
  };
  const core = await read(FACTS_SCRIPT);
  if (!core) return null;
  const defender = await read(DEFENDER_SCRIPT);
  const disk = letter ? await read(DISK_SCRIPT) : null;
  return shapeWindowsFacts(core, {game, env, defender, disk});
}

// The shaped facts with the processor's name and thread count from Node when PowerShell has not given them (free, no process).
function withNodeCpu(windows, {game, env, cpus}) {
  const shaped = windows ?? shapeWindowsFacts({}, {game, env});
  try {
    const list = cpus();
    if (shaped.cpu.name === null && list?.[0]?.model) shaped.cpu.name = clip(list[0].model, 120);
    if (shaped.cpu.threads === null && list?.length) shaped.cpu.threads = list.length;
  } catch { /* the processor stays unknown */ }
  return shaped;
}

/**
 * Everything in one object, WAITING for the PowerShell reads (tests and tools; the error reporter uses systemFactsNow): {cpu, os, antivirus, smartAppControl,
 * controlledFolderAccess, elevated, drive, display, mods}. `readdir` is the listing function (tests).
 */
export async function detectSystemFacts({game, run = defaultRun, platform = process.platform, env = process.env, readdir = realReaddir, cpus = osCpus} = {}) {
  const windows = await readWindowsFacts({game, run, platform, env});
  return {...withNodeCpu(windows, {game, env, cpus}), mods: await detectModNames({game, readdir}).catch(() => null)};
}

export const FACTS_CACHE_FILE = 'system-facts.json';
export const FACTS_MAX_AGE_MS = 7 * 24 * 3600 * 1000;
const CACHE_VERSION = 1;

// The saved copy: {at, facts} when it is this version's, for the same game drive, and shaped like facts; else null. Any age (a stale copy is still better than nothing while a read runs).
async function loadFactsCache({stateDirectory, game, readFile}) {
  if (!stateDirectory) return null;
  try {
    const saved = JSON.parse(await readFile(join(stateDirectory, FACTS_CACHE_FILE), 'utf8'));
    if (saved?.version !== CACHE_VERSION || !Number.isFinite(saved.at) || (saved.drive ?? null) !== driveLetter(game)) return null;
    const facts = saved.facts;
    if (!facts || typeof facts !== 'object' || !facts.cpu || !facts.os) return null;
    return {at: saved.at, facts: shapeWindowsFacts(facts, {game})};
  } catch { return null; }
}

let session = null;

async function startSession(options) {
  const {game, stateDirectory, refresh, now, platform, readFile, writeFile} = options;
  const state = {windows: null, refreshing: null, mods: null};
  const saved = await loadFactsCache({stateDirectory, game, readFile});
  if (saved) state.windows = saved.facts;
  const fresh = saved && now() - saved.at < FACTS_MAX_AGE_MS && saved.at <= now() + 3600_000;
  if (!fresh && refresh && platform === 'win32') {
    // Not awaited: the caller goes on with what it has. Only one read runs, and none is started again in this process whether it worked or not.
    state.refreshing = (async () => {
      try {
        const windows = await readWindowsFacts(options);
        if (!windows) return;
        state.windows = windows;
        if (stateDirectory) await writeFile(join(stateDirectory, FACTS_CACHE_FILE), JSON.stringify({version: CACHE_VERSION, at: now(), drive: driveLetter(game), facts: windows})).catch(() => {});
      } catch { /* the facts stay as they were */ }
    })();
  }
  return state;
}

/**
 * The facts for a report, NOW, without waiting for any PowerShell: the saved copy (7 days) or nothing yet for the Windows parts (the processor then comes from Node), plus the
 * mod names (directory listings, once per process). A saved copy older than 7 days, or none, starts ONE background refresh (one PowerShell read at a time at idle priority)
 * whose answer is saved and used by the reports built after it. `refresh: false` never starts one (the default under the test runner, where nothing may burn CPU).
 */
export async function systemFactsNow({game, stateDirectory, run = defaultRun, platform = process.platform, env = process.env, readdir = realReaddir, cpus = osCpus,
  readFile = realReadFile, writeFile = realWriteFile, now = Date.now, refresh = !process.env.NODE_TEST_CONTEXT} = {}) {
  const options = {game, stateDirectory, run, platform, env, readdir, cpus, readFile, writeFile, now, refresh};
  const state = await (session ??= startSession(options));
  state.mods ??= detectModNames({game, readdir}).catch(() => null);
  return {...withNodeCpu(state.windows ? structuredClone(state.windows) : null, {game, env, cpus}), mods: await state.mods};
}

/** The background refresh in flight (or none), for tests that want to wait for it. */
export async function systemFactsRefresh() { const state = session ? await session : null; await state?.refreshing; }
/** For tests: forget what this process holds. */
export function resetSystemFactsCache() { session = null; }
