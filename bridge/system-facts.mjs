// What an error report says about the PC and the install beyond the graphics card and the memory (docs/ERROR_REPORTS.md, "The PC"): the processor, the Windows
// edition, build and language, the security products Windows Security Center knows (who blocks files), Smart App Control, whether this process runs with administrator rights,
// the drive of the game (kind, free space, under Program Files or not), the display, and the NAMES of the installed mods (CET mods, RED4ext plugins, r6/scripts folders, archive
// files, REDmod mods) so a conflict is visible. No user name, no folder (a name is a file or folder name, one level, never a path), no key.
//
// Read ONCE per process (cachedSystemFacts), by the error reporter when it builds its first report: three PowerShell calls side by side (the quick facts, then two slow reads
// of their own, Defender's folder protection and the drive's SSD/HDD kind: 3 to 8 s on a PC, so one that is late loses only its own field) and a few directory listings. Never on a turn's path, never per frame. Never throws: a field that cannot be read is null.
import {execFile} from 'node:child_process';
import {readdir as realReaddir} from 'node:fs/promises';
import {constants as osConstants, cpus as osCpus, setPriority} from 'node:os';
import {join} from 'node:path';
import {promisify} from 'node:util';

// The reads run below normal priority: they are a few seconds of PowerShell next to a running game (FPS first).
const defaultRun = (file, args, options) => {
  const call = promisify(execFile)(file, args, options);
  try { if (call.child?.pid) setPriority(call.child.pid, osConstants.priority.PRIORITY_BELOW_NORMAL); } catch { /* the priority stays */ }
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

/**
 * Everything above in one object, or null off Windows for the Windows parts: {cpu, os, antivirus, smartAppControl, controlledFolderAccess, elevated, drive, display, mods}.
 * `run` is a promisified execFile and `readdir` the listing function (tests). The processor's name and thread count come from Node when PowerShell does not answer.
 */
export async function detectSystemFacts({game, run = defaultRun, platform = process.platform, env = process.env, readdir = realReaddir, cpus = osCpus} = {}) {
  let windows = null;
  if (platform === 'win32') {
    const shell = join(env.SystemRoot || env.windir || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const letter = driveLetter(game);
    const options = {timeout: POWERSHELL_TIMEOUT_MS, windowsHide: true, encoding: 'utf8', maxBuffer: 1 << 18, env: {...env, ...(letter ? {FACT_DRIVE: letter} : {})}};
    const read = async script => {
      try {
        const result = await run(shell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], options);
        return JSON.parse(String(result?.stdout ?? '').trim().split(/\r?\n/).filter(Boolean).at(-1));
      } catch { return null; }
    };
    const [core, defender, disk] = await Promise.all([read(FACTS_SCRIPT), read(DEFENDER_SCRIPT), letter ? read(DISK_SCRIPT) : null]);
    windows = core ? shapeWindowsFacts(core, {game, env, defender, disk}) : null;
  }
  const shaped = windows ?? shapeWindowsFacts({}, {game, env});
  try {
    const list = cpus();
    if (shaped.cpu.name === null && list?.[0]?.model) shaped.cpu.name = clip(list[0].model, 120);
    if (shaped.cpu.threads === null && list?.length) shaped.cpu.threads = list.length;
  } catch { /* the processor stays unknown */ }
  return {...shaped, mods: await detectModNames({game, readdir}).catch(() => null)};
}

let cached = null;
/** detectSystemFacts once per process (the first report builds it; the rest reuse it). */
export function cachedSystemFacts(options) { return cached ??= detectSystemFacts(options); }
/** For tests: forget what the cache holds. */
export function resetSystemFactsCache() { cached = null; }
