// File helpers for the release builder: hashing, verified downloads, extraction, copying.
import {createHash} from 'node:crypto';
import {createReadStream, createWriteStream} from 'node:fs';
import {copyFile, lstat, mkdir, readdir, readFile, rename, rm, stat, writeFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {dirname, join, relative, resolve, sep} from 'node:path';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';

export const sha256Buffer = bytes => createHash('sha256').update(bytes).digest('hex');

export async function sha256File(path, {start, length} = {}) {
  const hash = createHash('sha256');
  const options = start === undefined ? {} : {start, end: start + length - 1};
  for await (const chunk of createReadStream(path, {...options, highWaterMark: 4 * 1024 * 1024})) hash.update(chunk);
  return hash.digest('hex');
}

export const exists = async path => { try { await stat(path); return true; } catch { return false; } };
export const posix = path => path.split(sep).join('/');

// Every regular file under `root`, as sorted forward-slash relative paths. Links are refused:
// a package must contain ordinary files only.
export async function walk(root, {skip = () => false} = {}) {
  const found = [];
  async function visit(directory) {
    const entries = await readdir(directory, {withFileTypes: true});
    for (const entry of entries) {
      const path = join(directory, entry.name), rel = posix(relative(root, path));
      if (skip(rel, entry)) continue;
      if (entry.isSymbolicLink()) throw Error(`Refusing a link inside a package tree: ${rel}`);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) found.push(rel);
    }
  }
  await visit(root);
  return found.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

export async function copyInto(source, target) {
  await mkdir(dirname(target), {recursive: true});
  const info = await lstat(source);
  if (!info.isFile()) throw Error(`Not a regular file: ${source}`);
  await copyFile(source, target);
}

export async function writeText(target, text) {
  await mkdir(dirname(target), {recursive: true});
  await writeFile(target, text);
}

export async function readJson(path) { return JSON.parse(await readFile(path, 'utf8')); }

// Downloads `url` to `target` once; an existing file is reused only when its hash matches.
export async function download(url, target, sha256, log = () => {}) {
  if (await exists(target)) {
    if (!sha256 || await sha256File(target) === sha256) return target;
    await rm(target);
  }
  await mkdir(dirname(target), {recursive: true});
  const temporary = `${target}.download`;
  log(`Downloading ${url}`);
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await fetch(url, {redirect: 'follow'});
      if (!response.ok || !response.body) throw Error(`HTTP ${response.status}`);
      await pipeline(Readable.fromWeb(response.body), createWriteStream(temporary));
      break;
    } catch (error) {
      if (attempt >= 4) throw Error(`Download failed for ${url}: ${error.message}`);
      await new Promise(done => setTimeout(done, attempt * 5000));
    }
  }
  const actual = await sha256File(temporary);
  if (sha256 && actual !== sha256) {
    await rm(temporary, {force: true});
    throw Error(`Checksum mismatch for ${url}: expected ${sha256}, got ${actual}`);
  }
  await rename(temporary, target);
  return target;
}

// Windows PowerShell 5.1 started from a PowerShell 7 step (GitHub's default shell) inherits a
// PSModulePath that points at PowerShell 7 modules, and then core cmdlets such as Get-FileHash
// fail to load. Give it its own default module path.
export function childEnv(command, env = process.env) {
  const copy = {...env};
  if (/(^|[\\/])powershell(\.exe)?$/i.test(command)) {
    for (const key of Object.keys(copy)) if (key.toLowerCase() === 'psmodulepath') delete copy[key];
  }
  return copy;
}

export function run(command, args, {cwd, env, quiet = false} = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, {cwd, env: childEnv(command, env), windowsHide: true, stdio: quiet ? ['ignore', 'pipe', 'pipe'] : 'inherit'});
    let output = '';
    child.stdout?.on('data', data => { output = (output + data).slice(-20000); });
    child.stderr?.on('data', data => { output = (output + data).slice(-20000); });
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolveRun(output)
      : reject(Error(`${command} ${args.slice(0, 3).join(' ')} ... exited with ${code}${quiet ? `\n${output.slice(-4000)}` : ''}`)));
  });
}

// Windows ships bsdtar as tar.exe, which reads ZIP archives.
export async function extractZip(archive, destination) {
  await rm(destination, {recursive: true, force: true});
  await mkdir(destination, {recursive: true});
  const tar = process.platform === 'win32' ? resolve(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
  await run(tar, ['-xf', archive, '-C', destination], {quiet: true});
}

export const inside = (root, path) => {
  const part = relative(root, path);
  return part === '' || (!part.startsWith('..') && !part.includes(':'));
};
