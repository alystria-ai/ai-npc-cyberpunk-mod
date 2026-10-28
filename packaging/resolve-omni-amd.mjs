// Writes bridge/omni-amd-wheels.mjs (a module, so the Runtime build ships it with the bridge's import closure): the exact AMD ROCm PyTorch files the in-game "Set up OmniVoice for AMD" downloads (docs/OMNIVOICE_AMD.md, docs/PACKAGING.md
// "OmniVoice for AMD"). Run it when AMD publishes a newer PyTorch, then commit the file:
//
//   node packaging/resolve-omni-amd.mjs [--hash]
//
// It reads AMD's own package index (https://stable.repo.amd.com/rocm/whl-next/, the one AMD's install guide names) and, for each card family in TARGETS,
// follows the Requires-Dist lines of torch[device-<gfx>], torchaudio and torchvision[device-<gfx>] the way pip would, for the OmniVoice pack's Python
// (CPython 3.11, win_amd64). A library the OmniVoice pack already carries (numpy, sympy, ...) is not downloaded: the pack's copy is used. Only the
// metadata is fetched (each wheel's METADATA through two or three small HTTP range reads, the tiny `rocm` source package whole): nothing large is downloaded.
// Each file gets its size, its unpacked size and the ETag AMD's server gives it (an MD5 for files uploaded in one part, which the game checks).
// --hash also downloads every file once (about 1.5 GB per card family, all of them several GB) and records its SHA-256, which the game then checks instead.
import {createHash} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {inflateRawSync, gunzipSync} from 'node:zlib';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const INDEX = 'https://stable.repo.amd.com/rocm/whl-next/';
export const OUTPUT = resolve(here, '..', 'bridge', 'omni-amd-wheels.mjs');
// AMD's matching set as its install guide gives it (checked 28 Oct 2026).
export const ROOTS = Object.freeze({torch: '2.14.0+rocm10.1.0', torchaudio: '2.11.0.3+rocm10.1.0', torchvision: '0.29.0a0+rocm10.1.0'});
// The card families offered: discrete Radeon RX 6000 (RDNA 2), 7000 (RDNA 3) and 9000 (RDNA 4) cards with enough memory to be worth it.
export const TARGETS = Object.freeze(['gfx1201', 'gfx1200', 'gfx1100', 'gfx1101', 'gfx1102', 'gfx1030', 'gfx1031']);
export const PYTHON_TAG = 'cp311';
// Already in the OmniVoice pack (packaging/python/omni.lock.txt): the pack's copy is used, never AMD's.
export const FROM_PACK = Object.freeze(['filelock', 'typing-extensions', 'setuptools', 'sympy', 'networkx', 'jinja2', 'fsspec', 'numpy', 'pillow', 'markupsafe', 'mpmath']);

export const normalise = name => name.toLowerCase().replace(/[-_.]+/g, '-');

/** One Requires-Dist line as {name, extras, specifier, extra (the marker's extra or null)}; null for a line with another marker. Pure. */
export function parseRequirement(line) {
  const [spec, marker = ''] = line.split(';').map(part => part.trim());
  const found = /^([A-Za-z0-9][A-Za-z0-9._-]*)\s*(?:\[([^\]]*)\])?\s*(.*)$/.exec(spec);
  if (!found) return null;
  const extra = /extra\s*==\s*["']([^"']+)["']/.exec(marker)?.[1] ?? null;
  if (marker && !extra) return null;
  return {name: normalise(found[1]), extras: (found[2] ?? '').split(',').map(x => x.trim()).filter(Boolean), specifier: found[3].replace(/[()\s]/g, ''), extra};
}

/** Version parts for comparison ("2.14.0+rocm10.1.0" -> [2, 14, 0], local part dropped; "0.29.0a0" -> [0, 29, 0, -1, 0]). Pure. */
export function versionKey(version) {
  const [public_] = String(version).split('+');
  return public_.split(/[.]/).flatMap(part => { const m = /^(\d+)(?:(a|b|rc)(\d+))?$/.exec(part); return m ? (m[2] ? [Number(m[1]), -1, Number(m[3])] : [Number(m[1])]) : [0]; });
}
export function compareVersions(a, b) {
  const x = versionKey(a), y = versionKey(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (x[i] ?? 0) - (y[i] ?? 0); if (d) return d; }
  return 0;
}
/** Whether `version` meets `specifier` ('', '==X', '== X', '~=X.Y.Z', '>=X'; several joined by commas). Pure. */
export function satisfies(version, specifier) {
  return specifier.split(',').filter(Boolean).every(part => {
    const m = /^(==|~=|>=|<=|!=|>|<)(.+)$/.exec(part);
    if (!m) return true;
    const [, op, wanted] = m, c = compareVersions(version, wanted);
    if (op === '==') return version === wanted || (c === 0 && !wanted.includes('+') && !wanted.includes('*'));
    if (op === '~=') { const prefix = wanted.split('.').slice(0, -1).join('.'); return c >= 0 && compareVersions(version.split('+')[0].split('.').slice(0, prefix.split('.').length).join('.'), prefix) === 0; }
    if (op === '>=') return c >= 0;
    if (op === '<=') return c <= 0;
    if (op === '>') return c > 0;
    if (op === '<') return c < 0;
    return c !== 0;
  });
}

/** The files a simple index page lists: [{name, url, version, kind}] for this Python on Windows (wheels) and source packages. Pure. */
export function indexFiles(html, pageUrl, project) {
  const files = [];
  for (const [, href] of String(html).matchAll(/href="([^"]+)"/g)) {
    const url = new URL(href, pageUrl).href.split('#')[0];
    const name = decodeURIComponent(url.split('/').pop());
    const wheel = /^([^-]+)-([^-]+)-([^-]+)-([^-]+)-([^-]+)\.whl$/.exec(name);
    if (wheel) {
      const [, , version, python, abi, platform] = wheel;
      const fits = (python === PYTHON_TAG && abi === PYTHON_TAG || python.split('.').includes('py3') && abi === 'none') && ['win_amd64', 'any'].includes(platform);
      if (fits) files.push({name, url, version, kind: 'wheel', project});
      continue;
    }
    const sdist = new RegExp(`^${project.replace(/-/g, '[-_]')}-([^-]+)\\.tar\\.gz$`, 'i').exec(name);
    if (sdist) files.push({name, url, version: sdist[1], kind: 'sdist', project});
  }
  return files;
}

async function http(url, init = {}) {
  const response = await fetch(url, {redirect: 'follow', ...init});
  if (!response.ok && response.status !== 206) throw Error(`${url}: HTTP ${response.status}`);
  return response;
}
const range = async (url, start, end) => Buffer.from(await (await http(url, {headers: {Range: `bytes=${start}-${end}`}})).arrayBuffer());

/** A remote zip's entries through range reads: {size, etag, entries: [{name, method, compressed, size, offset}]}. */
export async function remoteZip(url) {
  const head = await http(url, {method: 'HEAD'});
  const size = Number(head.headers.get('content-length'));
  const etag = (head.headers.get('etag') ?? '').replace(/"/g, '') || null;
  const tail = await range(url, Math.max(0, size - 65_557), size - 1);
  const at = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (at < 0) throw Error(`${url}: no zip directory`);
  let count = tail.readUInt16LE(at + 10), dirSize = tail.readUInt32LE(at + 12), dirOffset = tail.readUInt32LE(at + 16);
  const locator = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x06, 0x07]), at);
  if (locator >= 0 && (dirOffset === 0xffffffff || count === 0xffff)) {
    const record = await range(url, Number(tail.readBigUInt64LE(locator + 8)), Number(tail.readBigUInt64LE(locator + 8)) + 55);
    count = Number(record.readBigUInt64LE(32)); dirSize = Number(record.readBigUInt64LE(40)); dirOffset = Number(record.readBigUInt64LE(48));
  }
  const directory = await range(url, dirOffset, dirOffset + dirSize - 1);
  const entries = [];
  for (let p = 0, i = 0; i < count && p < directory.length; i++) {
    const nameLength = directory.readUInt16LE(p + 28), extraLength = directory.readUInt16LE(p + 30), commentLength = directory.readUInt16LE(p + 32);
    let compressed = directory.readUInt32LE(p + 20), unpacked = directory.readUInt32LE(p + 24), offset = directory.readUInt32LE(p + 42);
    const name = directory.toString('utf8', p + 46, p + 46 + nameLength);
    // A Zip64 extra field holds the sizes and the offset that did not fit.
    for (let e = p + 46 + nameLength; e < p + 46 + nameLength + extraLength;) {
      const id = directory.readUInt16LE(e), length = directory.readUInt16LE(e + 2);
      if (id === 1) {
        let q = e + 4;
        if (unpacked === 0xffffffff) { unpacked = Number(directory.readBigUInt64LE(q)); q += 8; }
        if (compressed === 0xffffffff) { compressed = Number(directory.readBigUInt64LE(q)); q += 8; }
        if (offset === 0xffffffff) offset = Number(directory.readBigUInt64LE(q));
      }
      e += 4 + length;
    }
    entries.push({name, method: directory.readUInt16LE(p + 10), compressed, size: unpacked, offset});
    p += 46 + nameLength + extraLength + commentLength;
  }
  return {size, etag, entries};
}
async function readEntry(url, entry) {
  const header = await range(url, entry.offset, entry.offset + 29);
  const start = entry.offset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
  const data = await range(url, start, start + entry.compressed - 1);
  return entry.method === 8 ? inflateRawSync(data) : data;
}

/** The metadata of one file: {requires: [lines], unpacked, size, etag, longest}. A source package (the `rocm` meta package) is small and read whole. */
async function metadataOf(file) {
  if (file.kind === 'sdist') {
    const response = await http(file.url);
    const bytes = Buffer.from(await response.arrayBuffer());
    const tar = gunzipSync(bytes);
    const files = new Map();
    for (let p = 0; p + 512 <= tar.length;) {
      const name = tar.toString('utf8', p, p + 100).replace(/\0.*$/s, '');
      if (!name) break;
      const size = parseInt(tar.toString('utf8', p + 124, p + 136).replace(/\0.*$/s, '').trim() || '0', 8);
      const prefix = tar.toString('utf8', p + 345, p + 500).replace(/\0.*$/s, '');
      files.set(prefix ? `${prefix}/${name}` : name, tar.subarray(p + 512, p + 512 + size));
      p += 512 + Math.ceil(size / 512) * 512;
    }
    const info = [...files].find(([name]) => /^[^/]+\/PKG-INFO$/.test(name))?.[1].toString('utf8') ?? '';
    const unpacked = [...files].filter(([name]) => name.includes('/src/rocm_sdk/') && !name.includes('/tests/')).reduce((sum, [, data]) => sum + data.length, 0);
    return {requires: requiresOf(info), unpacked, size: bytes.length, etag: (response.headers.get('etag') ?? '').replace(/"/g, '') || null, sha256: createHash('sha256').update(bytes).digest('hex')};
  }
  const zip = await remoteZip(file.url);
  const meta = zip.entries.find(entry => /^[^/]+\.dist-info\/METADATA$/.test(entry.name));
  if (!meta) throw Error(`${file.name}: no METADATA`);
  const text = (await readEntry(file.url, meta)).toString('utf8');
  return {requires: requiresOf(text), unpacked: zip.entries.reduce((sum, entry) => sum + entry.size, 0), size: zip.size, etag: zip.etag,
    longest: Math.max(...zip.entries.map(entry => entry.name.length))};
}
const requiresOf = text => String(text).split(/\r?\n/).filter(line => line.startsWith('Requires-Dist:')).map(line => line.slice(14).trim());

async function main() {
  const withHash = process.argv.includes('--hash');
  const pages = new Map();
  const listing = async project => {
    if (!pages.has(project)) {
      const response = await http(new URL(`${project}/`, INDEX).href);
      pages.set(project, indexFiles(await response.text(), response.url, project));
    }
    return pages.get(project);
  };
  const files = {}, metadata = new Map(), targets = {};
  const pick = async (project, specifier) => {
    const choices = (await listing(project)).filter(file => satisfies(file.version, specifier));
    choices.sort((a, b) => compareVersions(b.version, a.version) || (a.kind === 'wheel' ? -1 : 1));
    return choices[0] ?? null;
  };
  for (const target of TARGETS) {
    const wanted = [{name: 'torch', specifier: `==${ROOTS.torch}`, extras: [`device-${target}`]}, {name: 'torchaudio', specifier: `==${ROOTS.torchaudio}`, extras: []},
      {name: 'torchvision', specifier: `==${ROOTS.torchvision}`, extras: [`device-${target}`]}];
    const chosen = new Map();
    let complete = true;
    while (wanted.length) {
      const {name, specifier, extras} = wanted.shift();
      if (FROM_PACK.includes(name)) continue;
      let file = chosen.get(name);
      const fresh = !file;
      if (!file) {
        const found = await pick(name, specifier);
        if (!found) { console.error(`${target}: nothing in AMD's index for ${name} ${specifier}`); complete = false; break; }
        file = {...found, extrasSeen: new Set()};
        chosen.set(name, file);
      } else if (!satisfies(file.version, specifier)) { console.error(`${target}: ${name} ${file.version} does not meet ${specifier}`); complete = false; break; }
      if (!metadata.has(file.url)) metadata.set(file.url, await metadataOf(file));
      const newExtras = extras.filter(extra => !file.extrasSeen.has(extra));
      for (const extra of newExtras) file.extrasSeen.add(extra);
      for (const line of metadata.get(file.url).requires) {
        const requirement = parseRequirement(line);
        if (!requirement) continue;
        // The plain requirements once, an extra's the first time that extra is asked for.
        if (requirement.extra ? !newExtras.includes(requirement.extra) : !fresh) continue;
        wanted.push({name: requirement.name, specifier: requirement.specifier, extras: requirement.extras});
      }
    }
    if (!complete) continue;
    targets[target] = [...chosen.values()].map(file => file.name).sort();
    for (const file of chosen.values()) {
      const meta = metadata.get(file.url);
      files[file.name] ??= {url: file.url, kind: file.kind, project: normalise(file.project), version: file.version, size: meta.size, unpacked: meta.unpacked,
        etag: meta.etag, sha256: meta.sha256 ?? null};
    }
    console.error(`${target}: ${targets[target].length} files, ${(targets[target].reduce((sum, name) => sum + files[name].size, 0) / 2 ** 20).toFixed(0)} MiB`);
  }
  if (withHash) {
    for (const [name, file] of Object.entries(files)) {
      if (file.sha256) continue;
      const hash = createHash('sha256');
      const response = await http(file.url);
      for await (const part of response.body) hash.update(part);
      file.sha256 = hash.digest('hex');
      console.error(`hashed ${name}`);
    }
  }
  const manifest = {version: 1, resolved: new Date().toISOString().slice(0, 10), index: INDEX, python: PYTHON_TAG, roots: ROOTS, fromPack: FROM_PACK,
    targets, files: Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)))};
  await writeFile(OUTPUT, `// Written by packaging/resolve-omni-amd.mjs from AMD's package index: do not edit by hand (docs/OMNIVOICE_AMD.md).\nexport default ${JSON.stringify(manifest, null, 2)};\n`);
  console.error(`wrote ${OUTPUT}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
