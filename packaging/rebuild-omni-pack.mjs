// Makes the leaner OmniVoice pack from an existing OmniPack zip, without rebuilding its Python environment.
//
//   node packaging/rebuild-omni-pack.mjs --from <OmniPack zip> --out <folder> --version 0.2.9 --python <app/omni/python/python.exe of an installed pack>
//        [--work <folder>] [--commit <sha>] [--timestamp <unix seconds>] [--release-config <file>] [--keep-work]
//
// Why: the pack's contents have not changed since 0.2.1 (the Python environment, the VoiceStudio adapter, the reference clips and the Voxtral slots are
// "reused unchanged", docs/PACKAGING.md), and the lists and clips of the characters added since live in the Runtime, so a build from scratch
// (packaging/build-release.mjs --packages omni, which needs the private bucket's current lists and a fresh 3 GB pip install) would give the
// same pack. This tool applies exactly the changes the builder now makes, to the zip that players have:
//   - model.safetensors is rounded to float16 (packaging/convert-omni-fp16.py, pinned in release.config.json toolchain.omniModel.converted);
//   - the tests folders of the Python packages, the DLL copies in torch/bin and the draft clips are left out (packaging/lib/omni-pack-rules.mjs);
//   - the notices, omni-pack.json and the install note are rewritten the way the builder writes them;
//   - nothing the Runtime carries (packaging/pack-listings/runtime-omni-clips-*.json) may be in the pack.
// Everything else is copied byte for byte (each entry is checked against its CRC-32 on the way out and the SHA-256 of the result is recorded).
// Output: <out>/OmniPack-OmniVoice-0.6B-<version>.zip and the same name .files.json (the same names the builder uses).
import {mkdir, readFile, rm, stat, writeFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {ZipWriter, listZip} from './lib/zip.mjs';
import {extractEntry} from './lib/zip-entry.mjs';
import {run, sha256File} from './lib/files.mjs';
import {OMNI_MODEL_FILE, omniLeaveOutReason, omniMarker, omniNoticeLines, omniNoticesText, runtimeClipSet} from './lib/omni-pack-rules.mjs';
import {INSTALL_NOTE, INSTALL_NOTE_NAME} from './build-pocket-models.mjs';
import {packTitle} from './lib/pack-names.mjs';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PLUGIN = 'red4ext/plugins/AiNpcCyberpunkMod';
const REPLACED = new Set([`${PLUGIN}/app/omni/THIRD-PARTY-NOTICES.txt`, `${PLUGIN}/app/omni/omni-pack.json`, OMNI_MODEL_FILE, INSTALL_NOTE_NAME]);

/**
 * Decides what becomes of every entry of the old pack: {keep, leave: [{path, why}], replaced, clash}. Pure, so a test can run it on a listing.
 * `runtimeClips` is the Map from runtimeClipSet: a path in it that the old pack also holds is a clash (the pack must not ship what the Runtime ships).
 */
export function planRebuild(entries, runtimeClips = new Map()) {
  const keep = [], leave = [], replaced = [], clash = [];
  for (const entry of entries) {
    if (entry.name.endsWith('/')) continue;
    if (runtimeClips.has(entry.name.toLowerCase())) clash.push(entry.name);
    const why = omniLeaveOutReason(entry.name);
    if (why) leave.push({path: entry.name, why, bytes: entry.uncompressed});
    else if (REPLACED.has(entry.name)) replaced.push(entry.name);
    else keep.push(entry);
  }
  return {keep, leave, replaced, clash};
}

async function main(argv) {
  const option = name => { const at = argv.indexOf(name); return at >= 0 ? argv[at + 1] : undefined; };
  const [from, outDirectory, version, python] = ['--from', '--out', '--version', '--python'].map(option);
  if (!from || !outDirectory || !version || !python) {
    console.error('Usage: node packaging/rebuild-omni-pack.mjs --from <OmniPack zip> --out <folder> --version <v> --python <python.exe of an installed OmniPack> [--work <folder>] [--commit <sha>] [--timestamp <unix seconds>] [--release-config <file>] [--keep-work]');
    return 2;
  }
  const out = resolve(outDirectory), work = resolve(option('--work') ?? resolve(out, 'work'));
  const git = args => spawnSync('git', args, {cwd: project, encoding: 'utf8'}).stdout.trim();
  const commit = option('--commit') ?? git(['rev-parse', 'HEAD']);
  const timestamp = new Date(Number(option('--timestamp') ?? git(['log', '-1', '--format=%ct', commit])) * 1000);
  const config = JSON.parse((await readFile(resolve(option('--release-config') ?? resolve(project, 'packaging/release.config.json')), 'utf8')).replace(/^﻿/, ''));
  const tool = config.toolchain, upstream = tool.omniModel.files['model.safetensors'], pin = tool.omniModel.converted['model.safetensors'];
  const log = message => console.log(`[omni] ${message}`);

  const entries = await listZip(from);
  const runtimeClips = runtimeClipSet(JSON.parse(await readFile(resolve(project, config.omniPack.runtimeClips), 'utf8')));
  const plan = planRebuild(entries, runtimeClips);
  if (plan.clash.length) throw Error(`The old pack holds ${plan.clash.length} clip(s) the Runtime carries, e.g. ${plan.clash[0]}.`);
  const oldModel = entries.find(entry => entry.name === OMNI_MODEL_FILE);
  if (!oldModel || oldModel.uncompressed !== upstream.size) throw Error('The old pack has no upstream model.safetensors of the pinned size.');
  log(`${entries.length} entries; keeping ${plan.keep.length}, leaving out ${plan.leave.length} (${(plan.leave.reduce((sum, item) => sum + item.bytes, 0) / 1e6).toFixed(1)} MB), replacing ${plan.replaced.length}.`);

  await rm(work, {recursive: true, force: true});
  await mkdir(work, {recursive: true});
  await mkdir(out, {recursive: true});

  // The upstream model out of the old pack (CRC-checked while it is read), its SHA-256 against the pin, then the float16 file.
  const upstreamFile = resolve(work, 'upstream/model.safetensors'), halfFile = resolve(work, 'float16/model.safetensors');
  await mkdir(dirname(upstreamFile), {recursive: true}); await mkdir(dirname(halfFile), {recursive: true});
  await extractEntry(from, oldModel, upstreamFile);
  const upstreamSha = await sha256File(upstreamFile);
  if (upstreamSha !== upstream.sha256) throw Error(`The old pack's model is ${upstreamSha}, not the pinned upstream file ${upstream.sha256}.`);
  log('Rounding the model to float16.');
  await run(python, [resolve(project, pin.script), upstreamFile, halfFile], {quiet: true});
  const halfSha = await sha256File(halfFile);
  if (halfSha !== pin.sha256 || (await stat(halfFile)).size !== pin.size) throw Error(`The float16 model is ${halfSha}, not the pinned ${pin.sha256}.`);
  await rm(upstreamFile);

  // Extract what is kept, then write the new zip in sorted order with the builder's writer (ZIP64 where needed, one fixed timestamp).
  const staged = new Map();
  const stageRoot = resolve(work, 'files');
  let index = 0;
  for (const entry of plan.keep) {
    const target = resolve(stageRoot, String(index++));
    await mkdir(dirname(target), {recursive: true});
    await extractEntry(from, entry, target);
    staged.set(entry.name, {source: target});
    if (index % 2000 === 0) log(`extracted ${index} of ${plan.keep.length}`);
  }
  const rows = new Map(staged);
  rows.set(OMNI_MODEL_FILE, {source: halfFile});
  const studio = tool.voiceStudio;
  rows.set(`${PLUGIN}/app/omni/THIRD-PARTY-NOTICES.txt`, {buffer: Buffer.from(omniNoticesText(omniNoticeLines({tool, studio})), 'utf8')});
  rows.set(`${PLUGIN}/app/omni/omni-pack.json`, {buffer: Buffer.from(JSON.stringify(omniMarker({config, version, commit}), null, 2) + '\n', 'utf8')});
  rows.set(INSTALL_NOTE_NAME, {buffer: Buffer.from(INSTALL_NOTE, 'utf8')});

  const names = [...rows.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const zipPath = resolve(out, `${packTitle(config, 'omni')}-${version}.zip`);
  const writer = await ZipWriter.create(zipPath, {timestamp});
  const files = [];
  for (const [position, name] of names.entries()) {
    const added = await writer.add(name, rows.get(name));
    files.push({path: name, bytes: added.uncompressed, sha256: added.sha256});
    if (position % 2000 === 0) log(`written ${position} of ${names.length}`);
  }
  const closed = await writer.close();
  await writeFile(resolve(out, `${packTitle(config, 'omni')}-${version}.files.json`), JSON.stringify(files, null, 1) + '\n');
  const hash = await sha256File(zipPath);
  log(`${zipPath}: ${closed.bytes} bytes, ${closed.entries} entries, sha256 ${hash}`);
  if (!option('--keep-work')) await rm(work, {recursive: true, force: true});
  console.log(JSON.stringify({zip: zipPath, bytes: closed.bytes, entries: closed.entries, sha256: hash, leftOut: plan.leave.length}));
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; }, error => { console.error(error?.stack || error.message); process.exitCode = 1; });
}
