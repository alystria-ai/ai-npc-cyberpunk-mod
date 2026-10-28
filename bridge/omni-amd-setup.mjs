// Settings > Voices > OmniVoice for AMD (docs/OMNIVOICE_AMD.md): the one-button setup of OmniVoice on an AMD Radeon card.
//
// The OmniVoice pack's PyTorch is a CUDA build: it sees NVIDIA cards only. On a PC with a discrete AMD Radeon card and no NVIDIA one, the page offers one
// download: the ROCm PyTorch files of bridge/omni-amd-wheels.mjs for the card's family (packaging/resolve-omni-amd.mjs pins them). They come as ONE pack zip
// of that family from our Hugging Face repository (voice/amd/OmniAMD-<family>-PyTorch-<v>-ROCm-<v>.zip, built from AMD's own wheels by
// packaging/build-omni-amd-packs.mjs and listed with its SHA-256 in bridge/omni-amd-packs.mjs). Only when our pack is missing or does not check out, or no pack
// is listed for the family yet, the files are downloaded one by one from AMD's own package index (https://stable.repo.amd.com/rocm/whl-next/) instead. They are
// unpacked into the mod's data folder beside a copy of the pack's interpreter (bridge/omni-amd-layout.mjs), and that Python is then tested exactly like a player's own
// omni-python.txt (bridge/omni-own-python.mjs): only a Python whose test passed on the card is used, so a failure ends as before (Pocket or text, never a
// cloud voice). A player's own omni-python.txt always wins.
//
// File IPC like the other settings pages: the game writes runtime/omni-amd-command.json ({version, id, action: install | cancel | remove, issuedAt}),
// the bridge answers in runtime/omni-amd-state.json (status(), read by mod/omni-amd.lua). Nothing runs until the player presses a button, except one read
// of the card list (three registry reads, the same the Help page makes) a little after start-up when the OmniVoice pack is installed, so the page knows
// whether to offer the setup. The job runs in the background, off the game's thread, and it never blocks the settings poll.
import {createHash} from 'node:crypto';
import {createReadStream, createWriteStream} from 'node:fs';
import {cp, mkdir, readdir, readFile, rename, rm, stat, statfs, writeFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {join, resolve} from 'node:path';
import {Readable, Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {gpuVendors, amdRoute} from './gpu-vendors.mjs';
import {amdPackName, amdPackUrl, amdPaths, prepareInterpreter, readAmdSetup, wheelDataFolder, writeAmdSetup} from './omni-amd-layout.mjs';
import PINNED from './omni-amd-wheels.mjs';
import PACKS from './omni-amd-packs.mjs';

export const COMMANDS = Object.freeze(['install', 'cancel', 'remove']);
const COMMAND_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/;
const MIB = 2 ** 20;
// The card list is read this long after the service started (not at once: the game is still loading), and only with the OmniVoice pack installed.
export const CARD_DELAY_MS = 20_000;
// Room kept free on the drive beyond what the setup takes.
export const SPACE_MARGIN_BYTES = 512 * MIB;
// A status with download progress is published at most this often.
const PROGRESS_EVERY_MS = 500;

/** The pinned AMD files (bridge/omni-amd-wheels.mjs, written by packaging/resolve-omni-amd.mjs). A copy, so a caller may change it. */
export function loadManifest() { return structuredClone(PINNED); }

// Windows card names to AMD's LLVM target of that chip ("gfx" names, the ones AMD's index uses). Discrete Radeon RX 6000 to 9000 cards and their Pro twins.
const ARCHES = [
  [/\brx\s*9070(?!\d)|\bai\s*pro\s*r97\d\d(?!\d)/i, 'gfx1201'],
  [/\brx\s*9060(?!\d)/i, 'gfx1200'],
  [/\brx\s*7900(?!\d)|\bpro\s*w7[89]00(?!\d)/i, 'gfx1100'],
  [/\brx\s*7[78]00(?!\d)|\bpro\s*w7700(?!\d)/i, 'gfx1101'],
  [/\brx\s*76[05]0(?!\d)|\bpro\s*w7[56]00(?!\d)/i, 'gfx1102'],
  [/\brx\s*6[89][05]0(?!\d)|\bpro\s*w6800(?!\d)/i, 'gfx1030'],
  [/\brx\s*67[05]0(?!\d)/i, 'gfx1031'],
];
/** The chip family of an AMD card name ('gfx1201' for an RX 9070 XT), or null for a name not in the list. Pure. */
export function amdArch(name) {
  const text = String(name ?? '');
  return ARCHES.find(([pattern]) => pattern.test(text))?.[1] ?? null;
}
/** The discrete AMD card the setup is for ({name, arch, memoryMiB}), or null (no such card, or an NVIDIA card is there too: that PC stays on the NVIDIA route). Pure. */
export function amdCard(cards) {
  const list = Array.isArray(cards) ? cards : [];
  if (!amdRoute(list)) return null;
  const card = list.filter(item => gpuVendors([item]).includes('amd') && amdRoute([item]))
    .sort((a, b) => (Number(b?.memoryMiB) || 0) - (Number(a?.memoryMiB) || 0))[0];
  return card ? {name: String(card.name).slice(0, 80), arch: amdArch(card.name), memoryMiB: Number.isFinite(card.memoryMiB) ? Math.round(card.memoryMiB) : null} : null;
}

/**
 * Our pack of a family ({name, url, size, sha256}) when bridge/omni-amd-packs.mjs lists one that holds exactly the files of the pinned list, else null (then AMD's
 * files are downloaded one by one). The URL is built here from the name, never read from the list. Pure.
 */
export function packFor(manifest, packs, target, names) {
  const entry = packs?.packs?.[target];
  const name = amdPackName(manifest?.roots, target);
  if (!entry || !name || entry.name !== name || !Number.isSafeInteger(entry.size) || entry.size <= 0 || !/^[0-9a-f]{64}$/.test(entry.sha256 ?? '')
    || !Array.isArray(entry.files) || [...entry.files].sort().join('|') !== [...names].sort().join('|')) return null;
  return {name, url: amdPackUrl(name), size: entry.size, sha256: entry.sha256};
}

/**
 * What one card family needs: {target, files: [{name, ...}], pack, filesBytes, downloadBytes, unpackedBytes}, or null when the manifest has no such family.
 * downloadBytes is what the player downloads: our pack when there is one, else the sum of AMD's files. Pure.
 */
export function planFor(manifest, target, packs = PACKS) {
  const names = target && manifest?.targets?.[target];
  if (!Array.isArray(names) || !names.length) return null;
  const files = names.map(name => ({name, ...manifest.files?.[name]}));
  if (files.some(file => !/^https:\/\//.test(file.url ?? '') || !Number.isSafeInteger(file.size) || file.size <= 0)) return null;
  const filesBytes = files.reduce((sum, file) => sum + file.size, 0);
  const pack = packFor(manifest, packs, target, names);
  return {target, files, pack, filesBytes, downloadBytes: pack ? pack.size : filesBytes, unpackedBytes: files.reduce((sum, file) => sum + (file.unpacked || file.size), 0)};
}

/**
 * The free space a setup needs, margin included. Through our pack the zip and the wheels it holds are on the drive together, then the zip is deleted and the
 * unpacked files come; from AMD only the wheels and the unpacked files. What is already there from an earlier try (`present`) is not counted again. Pure.
 */
export function spaceNeeded(plan, {extracted = false, packBytes = 0, fileBytes = 0} = {}) {
  const files = extracted ? 0 : Math.max(0, plan.filesBytes - fileBytes);
  const pack = plan.pack && !extracted ? Math.max(0, plan.pack.size - packBytes) : 0;
  return files + Math.max(pack, plan.unpackedBytes) + SPACE_MARGIN_BYTES;
}

/**
 * Whether a downloaded file is the one the manifest names: its SHA-256 when the manifest has one, else the MD5 that AMD's server gives as its ETag (a file
 * uploaded in one piece: the ETag is the MD5; in one part of a multipart upload: the MD5 of that MD5). A file with only a multipart ETag of several parts is
 * checked by its size alone. Pure.
 */
export function checksumOk(file, {md5, sha256}) {
  if (file.sha256) return sha256 === file.sha256;
  const etag = String(file.etag ?? '').toLowerCase();
  if (/^[0-9a-f]{32}$/.test(etag)) return md5 === etag;
  const single = /^([0-9a-f]{32})-1$/.exec(etag);
  if (single) return createHash('md5').update(Buffer.from(md5, 'hex')).digest('hex') === single[1];
  return true;
}

export function parseAmdCommand(raw, now = Date.now()) {
  if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') > 4096) return null;
  let value;
  try { value = JSON.parse(raw.replace(/^\uFEFF/, '')); } catch { return null; }
  if (value === null || typeof value !== 'object' || Array.isArray(value) || value.version !== 1 || !COMMAND_ID.test(value.id ?? '')
    || !COMMANDS.includes(value.action) || !Number.isFinite(value.issuedAt) || value.issuedAt < 0 || value.issuedAt > now + 5000) return null;
  return {id: value.id, action: value.action};
}

class Cancelled extends Error { constructor() { super('cancelled'); this.code = 'cancelled'; } }
const failure = code => Object.assign(Error(code), {code});

/** Downloads one file to `path` (resuming a `.part` left from before), checking its size and checksum. onBytes(n) is told each part. */
export async function downloadFile(file, path, {fetchImpl = fetch, signal, onBytes = () => {}} = {}) {
  const verify = async () => {
    const md5 = createHash('md5'), sha256 = createHash('sha256');
    for await (const part of createReadStream(path)) { md5.update(part); sha256.update(part); }
    return checksumOk(file, {md5: md5.digest('hex'), sha256: sha256.digest('hex')});
  };
  const done = await stat(path).catch(() => null);
  if (done?.size === file.size) {
    if (await verify()) { onBytes(file.size); return; }
    await rm(path, {force: true});
  }
  const part = `${path}.part`;
  let have = (await stat(part).catch(() => null))?.size ?? 0;
  if (have > file.size) { await rm(part, {force: true}); have = 0; }
  let response;
  try {
    response = await fetchImpl(file.url, {signal, redirect: 'follow', headers: have ? {Range: `bytes=${have}-`} : {}});
  } catch (error) { if (signal?.aborted) throw new Cancelled(); throw failure('download-failed'); }
  if (have && response.status === 200) have = 0;
  else if (!(response.ok || response.status === 206)) throw Object.assign(failure('download-failed'), {missing: [401, 403, 404, 410].includes(response.status)});
  onBytes(have);
  const counter = new Transform({transform(chunk, encoding, next) { onBytes(chunk.length); next(null, chunk); }});
  try {
    const body = typeof response.body?.getReader === 'function' ? Readable.fromWeb(response.body) : Readable.from(response.body ?? []);
    await pipeline(body, counter, createWriteStream(part, {flags: have ? 'a' : 'w'}), {signal});
  } catch (error) {
    if (signal?.aborted) throw new Cancelled();
    throw failure('download-failed');
  }
  if ((await stat(part)).size !== file.size) { await rm(part, {force: true}); throw failure('download-failed'); }
  await rename(part, path);
  if (!(await verify())) { await rm(path, {force: true}); throw failure('checksum'); }
}

/** Unpacks an archive with Windows' own tar.exe (bsdtar reads zip files, so wheels too). Resolves when done; rejects on failure or cancel. */
export function tarExtract({archive, destination, signal}) {
  return new Promise((done, fail) => {
    const tar = process.platform === 'win32' ? resolve(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
    let child;
    try { child = spawn(tar, ['-xf', archive, '-C', destination], {windowsHide: true, stdio: 'ignore'}); } catch { fail(failure('unpack-failed')); return; }
    const stop = () => { try { child.kill(); } catch {} };
    signal?.addEventListener('abort', stop, {once: true});
    child.on('error', () => fail(failure('unpack-failed')));
    child.on('close', code => { signal?.removeEventListener('abort', stop); if (signal?.aborted) fail(new Cancelled()); else if (code === 0) done(); else fail(failure('unpack-failed')); });
  });
}

/**
 * Unpacks the plan's files into `site`: wheels whole (a <name>.data/purelib or platlib folder merged into the site folder), the `rocm` source package as
 * its pure-Python rocm_sdk package with a .dist-info made from its PKG-INFO (what pip's build of it would install).
 */
export async function unpackInto(site, plan, downloads, {extract = tarExtract, signal} = {}) {
  await mkdir(site, {recursive: true});
  for (const file of plan.files) {
    if (signal?.aborted) throw new Cancelled();
    const archive = join(downloads, file.name);
    if (file.kind === 'sdist') {
      const temporary = join(site, '..', 'sdist');
      await rm(temporary, {recursive: true, force: true}); await mkdir(temporary, {recursive: true});
      await extract({archive, destination: temporary, signal});
      const [root] = (await readdir(temporary)).filter(name => !name.startsWith('.'));
      if (!root) throw failure('unpack-failed');
      const source = join(temporary, root, 'src');
      for (const name of await readdir(source)) {
        if (name.endsWith('.egg-info')) continue;
        await cp(join(source, name), join(site, name), {recursive: true});
      }
      const info = join(site, `${file.project}-${file.version}.dist-info`);
      await mkdir(info, {recursive: true});
      await cp(join(temporary, root, 'PKG-INFO'), join(info, 'METADATA'));
      await writeFile(join(info, 'INSTALLER'), 'ai-npc-cyberpunk-mod\n');
      await rm(temporary, {recursive: true, force: true});
      continue;
    }
    await extract({archive, destination: site, signal});
    for (const name of (await readdir(site)).filter(wheelDataFolder)) {
      for (const kind of ['purelib', 'platlib']) {
        const from = join(site, name, kind);
        if (await stat(from).catch(() => null)) await cp(from, site, {recursive: true});
      }
      await rm(join(site, name), {recursive: true, force: true});
    }
  }
}

/** Free bytes on the drive of `path` (its nearest existing folder), or null when unknown. */
export async function freeBytes(path) {
  for (let at = path; at; at = resolve(at, '..')) {
    try { const s = await statfs(at); return Number(s.bavail) * Number(s.bsize); } catch {}
    if (resolve(at, '..') === at) break;
  }
  return null;
}

/**
 * The setup itself. Options: stateDirectory; runtimePython() (the OmniVoice pack's python.exe or null); packInstalled(); cards() (resolves to the card list);
 * ownPython() (the latest resolveOwnPython result, or null while it runs); ownFile() (resolves to whether the player's own omni-python.txt is there);
 * recheck() (tests the Python again, resolves to the new result); release() (resolves once no OmniVoice worker runs from the AMD Python any more);
 * commandPath, publish(value); manifest; fetchImpl, extract, free(path), now(), log(text), read(path).
 */
export class OmniAmdSetup {
  constructor(options = {}) {
    if (typeof options.commandPath !== 'string' || typeof options.publish !== 'function' || !options.stateDirectory) throw Error('Invalid AMD setup configuration');
    this.options = options;
    this.paths = amdPaths(options.stateDirectory);
    this.manifest = options.manifest === undefined ? loadManifest() : options.manifest;
    this.packs = options.packs === undefined ? PACKS : options.packs;
    this.now = options.now ?? Date.now;
    this.log = options.log ?? (() => {});
    this.read = options.read ?? (file => import('node:fs/promises').then(fs => fs.readFile(file, 'utf8')));
    this.startedAt = this.now();
    this.observed = ''; this.job = null; this.abort = null; this.running = null; this.writing = Promise.resolve();
    this.card = null; this.cardsKnown = false; this.cardsAsked = null; this.installed = false; this.ownFileSeen = false; this.packSeen = null;
    this.lastProgressAt = 0;
  }
  /** Ignores a command left from an earlier session and publishes the first status. */
  async open() {
    this.observed = await this.read(this.options.commandPath).catch(() => '');
    this.installed = !!(await readAmdSetup({stateDirectory: this.options.stateDirectory}));
    await this.refreshOwnFile();
    await this.publishStatus();
    return this;
  }
  async refreshOwnFile() { try { this.ownFileSeen = (await this.options.ownFile?.()) === true; } catch { this.ownFileSeen = false; } }
  /** The card list, read once (shared with the rest of the bridge through its cache). */
  askCards() {
    this.cardsAsked ??= Promise.resolve().then(() => this.options.cards?.()).then(cards => cards, () => [])
      .then(cards => { this.card = amdCard(cards); this.cardsKnown = true; return this.card; });
    return this.cardsAsked;
  }
  packInstalled() { try { return this.options.packInstalled?.() === true; } catch { return false; } }
  plan() { return planFor(this.manifest, this.card?.arch, this.packs); }
  status() {
    const plan = this.plan();
    const own = this.options.ownPython?.() ?? null;
    let test = null;
    if (own?.managed) {
      if (own.used) test = {state: 'used', backend: own.backend ?? null, device: own.device ?? null, vramMiB: own.vramMiB ?? null};
      else if (own.pending || own.testing) test = {state: 'testing'};
      else if (own.reason) test = {state: 'refused', backend: own.backend ?? 'none', reason: own.reason};
    }
    if (this.job?.testing) test = {state: 'testing'};
    const offered = this.cardsKnown && !!this.card && this.packSeen === true;
    return {version: 1, updated: this.now(), offered, installed: this.installed, ...(this.card?.arch ? {arch: this.card.arch} : {}), ...(this.card ? {card: this.card.name} : {}),
      ...(plan ? {downloadMiB: Math.round(plan.downloadBytes / MIB), diskMiB: Math.round(plan.unpackedBytes / MIB)} : {}),
      ownPython: this.ownFileSeen, ...(this.job ? {job: this.job.public} : {}), ...(test ? {test} : {})};
  }
  publishStatus() {
    this.writing = this.writing.catch(() => {}).then(() => this.options.publish(this.status()));
    return this.writing;
  }
  /** Called with every settings poll: the one deferred card read, then any new command. Never waits for a job. */
  async poll() {
    if (!this.cardsAsked && this.now() - this.startedAt >= CARD_DELAY_MS) {
      this.packSeen = this.packInstalled();
      if (this.packSeen) { await this.askCards(); await this.publishStatus(); }
      else this.cardsAsked = Promise.resolve(null);
    }
    const raw = await this.read(this.options.commandPath).catch(() => '');
    if (raw === this.observed) return;
    this.observed = raw;
    const command = parseAmdCommand(raw, this.now());
    if (!command) return;
    if (command.action === 'cancel') { this.cancel(command); return; }
    // A second install or remove while a job runs is not started (the page shows Cancel then): the running job keeps answering.
    if (this.running) return;
    this.running = (command.action === 'install' ? this.install(command) : this.remove(command)).catch(() => {}).finally(() => { this.running = null; this.abort = null; });
  }
  cancel(command) {
    if (this.abort && this.job?.public?.action === 'install') { this.job.cancelId = command.id; this.abort.abort(); return; }
    this.finish(command, 'install', {state: 'cancelled'});
    void this.publishStatus().catch(() => {});
  }
  setJob(id, action, state, extra = {}) {
    this.job = {...this.job, public: {id, action, state, ...extra}};
    return this.publishStatus();
  }
  finish(command, action, result) { this.job = {public: {id: command.id, action, ...result}}; }
  async install(command) {
    const id = command.id;
    this.abort = new AbortController();
    const signal = this.abort.signal;
    try {
      await this.setJob(id, 'install', 'checking');
      this.packSeen = this.packInstalled();
      const runtimePython = this.options.runtimePython?.() ?? null;
      if (!this.packSeen || !runtimePython) throw failure('no-pack');
      this.cardsAsked = null; this.cardsKnown = false;
      const card = await this.askCards();
      if (!card) throw failure('not-amd');
      const plan = this.plan();
      if (!plan) throw failure(this.manifest ? 'unsupported-card' : 'not-ready');
      await mkdir(this.paths.downloads, {recursive: true});
      // Room for what is still to download, the unpacked files and a margin; a setup already there is replaced, so its room counts as free.
      const sizeOf = async name => (await stat(join(this.paths.downloads, name)).catch(() => null))?.size ?? 0;
      let fileBytes = 0;
      for (const file of plan.files) fileBytes += Math.min(file.size, Math.max(await sizeOf(file.name), await sizeOf(`${file.name}.part`)));
      const extracted = !!plan.pack && await this.packExtracted(plan);
      const packBytes = plan.pack ? Math.min(plan.pack.size, Math.max(await sizeOf(plan.pack.name), await sizeOf(`${plan.pack.name}.part`))) : 0;
      const free = await (this.options.free ?? freeBytes)(this.paths.root);
      const old = this.installed ? plan.unpackedBytes : 0;
      if (Number.isFinite(free) && free + old < spaceNeeded(plan, {extracted, packBytes, fileBytes})) throw failure('no-space');
      // Download: our pack of the family (unpacked here into downloads/), else AMD's files one by one, with progress.
      let source = 'amd';
      if (plan.pack && await this.getPack(id, plan, signal)) source = 'huggingface';
      else await this.getFiles(id, plan, signal);
      // Unpack into st/ beside the interpreter copy; the old setup is let go and replaced only now.
      await this.setJob(id, 'install', 'unpacking');
      await rm(this.paths.staging, {recursive: true, force: true});
      await prepareInterpreter({home: this.paths.staging, runtimePython});
      await unpackInto(join(this.paths.staging, 'sp'), plan, this.paths.downloads, {extract: this.options.extract ?? tarExtract, signal});
      if (signal.aborted) throw new Cancelled();
      await writeAmdSetup(join(this.paths.staging, 'setup.json'), {version: 1, target: plan.target, card: card.name, installedAt: new Date(this.now()).toISOString(),
        torch: this.manifest.roots?.torch ?? null, source, files: plan.files.map(file => file.name), diskBytes: plan.unpackedBytes});
      await this.letGo();
      await rm(this.paths.home, {recursive: true, force: true, maxRetries: 10, retryDelay: 500});
      await rename(this.paths.staging, this.paths.home);
      this.installed = true;
      await rm(this.paths.downloads, {recursive: true, force: true}).catch(() => {});
      // The same test as a player's own Python: only a pass on the card is used.
      this.job.testing = true;
      await this.setJob(id, 'install', 'testing');
      const result = await this.options.recheck?.();
      this.job.testing = false;
      if (!(result?.managed && result.used && result.backend === 'rocm')) {
        this.log(`the test did not pass (${result?.reason ?? 'no result'})`);
        throw failure('test-failed');
      }
      this.log(`ready: ${card.name} (${plan.target})`);
      this.finish(command, 'install', {state: 'done'});
    } catch (error) {
      if (this.job) this.job.testing = false;
      await rm(this.paths.staging, {recursive: true, force: true}).catch(() => {});
      if (error instanceof Cancelled || signal.aborted) {
        this.log('cancelled');
        this.finish({id: this.job?.cancelId ?? id}, 'install', {state: 'cancelled'});
      } else {
        const code = typeof error?.code === 'string' && /^[a-z-]+$/.test(error.code) ? error.code : 'unknown';
        if (code === 'unknown') this.log(`failed: ${String(error?.message ?? error).slice(0, 200)}`);
        else this.log(`failed: ${code}`);
        this.finish(command, 'install', {state: 'failed', code: ['ENOSPC'].includes(error?.code) ? 'no-space' : code});
      }
    }
    await this.publishStatus();
  }
  /** One download with the progress of the whole job: `before` bytes of `total` were done by earlier files. */
  async download(file, path, {id, before, total, signal}) {
    let counted = 0;
    await downloadFile(file, path, {fetchImpl: this.options.fetchImpl ?? fetch, signal, onBytes: bytes => {
      counted += bytes; const now = this.now();
      if (now - this.lastProgressAt >= PROGRESS_EVERY_MS) {
        this.lastProgressAt = now;
        this.job.public = {id, action: 'install', state: 'downloading', doneMiB: Math.floor((before + counted) / MIB), totalMiB: Math.round(total / MIB)};
        void this.publishStatus().catch(() => {});
      }
    }});
  }
  /** AMD's files, one by one from AMD's own index. */
  async getFiles(id, plan, signal) {
    let done = 0;
    await this.setJob(id, 'install', 'downloading', {doneMiB: 0, totalMiB: Math.round(plan.filesBytes / MIB)});
    for (const file of plan.files) {
      await this.download(file, join(this.paths.downloads, file.name), {id, before: done, total: plan.filesBytes, signal});
      done += file.size;
      this.log(`downloaded ${file.name}`);
    }
  }
  /** Whether the pack was downloaded and unpacked in an earlier try: its marker is there and every file has its size. */
  async packExtracted(plan) {
    try {
      if ((await readFile(join(this.paths.downloads, `${plan.pack.name}.done`), 'utf8')).trim() !== plan.pack.sha256) return false;
      for (const file of plan.files) if ((await stat(join(this.paths.downloads, file.name))).size !== file.size) return false;
      return true;
    } catch { return false; }
  }
  /**
   * Our pack: downloaded (SHA-256 checked, resumed after a cancel), unpacked into downloads/ beside nothing else, then deleted. Returns false when our copy is
   * missing or does not check out, so the caller downloads AMD's files instead; any other failure ends the job as before.
   */
  async getPack(id, plan, signal) {
    const {pack} = plan, archive = join(this.paths.downloads, pack.name), marker = join(this.paths.downloads, `${pack.name}.done`);
    if (await this.packExtracted(plan)) return true;
    await rm(marker, {force: true});
    await this.setJob(id, 'install', 'downloading', {doneMiB: 0, totalMiB: Math.round(pack.size / MIB)});
    try {
      await this.download({url: pack.url, size: pack.size, sha256: pack.sha256}, archive, {id, before: 0, total: pack.size, signal});
    } catch (error) {
      if (error?.missing || error?.code === 'checksum') { this.log(`our pack ${pack.name} is ${error.missing ? 'missing' : 'not right'}: AMD's files are downloaded instead`); return false; }
      throw error;
    }
    this.log(`downloaded ${pack.name}`);
    await this.setJob(id, 'install', 'unpacking');
    await (this.options.extract ?? tarExtract)({archive, destination: this.paths.downloads, signal});
    for (const file of plan.files) {
      if ((await stat(join(this.paths.downloads, file.name)).catch(() => null))?.size !== file.size) throw failure('checksum');
    }
    await writeFile(marker, pack.sha256);
    await rm(archive, {force: true});
    return true;
  }
  /** The AMD Python is let go: the bridge stops using it (the worker that runs from it exits) before its files are replaced or removed. */
  async letGo() {
    try { await this.options.release?.(); } catch {}
  }
  async remove(command) {
    try {
      await this.letGo();
      await rm(this.paths.root, {recursive: true, force: true, maxRetries: 20, retryDelay: 500});
      this.installed = false;
      await this.options.recheck?.();
      this.log('removed');
      this.finish(command, 'remove', {state: 'removed'});
    } catch (error) {
      this.installed = !!(await readAmdSetup({stateDirectory: this.options.stateDirectory}));
      this.log(`removing failed: ${String(error?.code ?? error?.message ?? error).slice(0, 80)}`);
      this.finish(command, 'remove', {state: 'failed', code: 'unknown'});
    }
    await this.publishStatus();
  }
  /** For the bridge's shutdown: a running job is stopped (downloads resume next time). */
  close() { try { this.abort?.abort(); } catch {} return this.running ?? Promise.resolve(); }
}
