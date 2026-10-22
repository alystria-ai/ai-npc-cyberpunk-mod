// Checks a release zip against the optional packs, and makes the listing of the packs it checks against.
//
//   node packaging/check-pack-overlap.mjs check <zip>... [--listing packaging/pack-listings/packs-0.2.1.json]
//       Every file the zip (the Runtime, the Scripts) shares with a pack must have the same bytes as the pack's copy, and nothing may be in
//       a tree only the OmniVoice pack writes, and no path may be in the zip twice with different bytes. Exit code 1 otherwise, with the
//       paths grouped by folder. Reads only the zip's directory (ZIP64 too: the 6.5 GB OmniVoice pack is one).
//
//   node packaging/check-pack-overlap.mjs listing <out.json> <Name=zip-or-url>...
//       Writes the listing from the packs' zips. A URL (the pack on Hugging Face, public, no token) is read with HTTP range requests: the
//       end of the file and its directory, a few MB for the biggest pack, never the pack itself. Prints the bytes read.
//       e.g. OmniPack=https://huggingface.co/alystria-ai/ai-npc-cyberpunk-mod-packs/resolve/main/voice/OmniPack.zip
//
// Why: docs/PACKAGING.md, "Packs reused unchanged". The rule and the shared names are in packaging/lib/pack-overlap.mjs.
import {readFile, writeFile} from 'node:fs/promises';
import {basename, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {compareWithPacks, countByFolder, duplicatePaths, filesOfZip, isUrl, listingText, packRecord, validateListing} from './lib/pack-overlap.mjs';

const project = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
export const DEFAULT_LISTING = resolve(project, 'packaging/pack-listings/packs-0.2.1.json');
export const LISTING_NOTE = 'The optional packs of version 0.2.1, which later versions reuse unchanged (server-side copies on Hugging Face): path, size and CRC-32 of every file, '
  + 'except the OmniVoice pack\'s own trees (listed under "claimed" with their file counts). Made by packaging/check-pack-overlap.mjs listing; '
  + 'read by the same tool and by packaging/pack-overlap.test.mjs.';

export async function checkZips(zips, listing, {log = console.log} = {}) {
  let ok = true;
  for (const zip of zips) {
    const {files} = await filesOfZip(zip);
    const result = compareWithPacks(files, listing);
    log(`${basename(zip)}: ${files.length} files; shares ${result.identical.length + result.different.length} paths with the packs `
      + `(${result.identical.length} identical, ${result.different.length} different)${result.inPackTrees.length ? `, ${result.inPackTrees.length} inside a pack's own tree` : ''}.`);
    for (const [title, items] of [['with DIFFERENT bytes', result.different], ['inside a tree only the OmniVoice pack writes', result.inPackTrees]]) {
      for (const pack of [...new Set(items.map(item => item.pack))]) {
        const mine = items.filter(item => item.pack === pack);
        log(`  ${pack}: ${mine.length} file(s) ${title}`);
        for (const [folder, count] of countByFolder(mine)) log(`    ${folder}: ${count}`);
      }
    }
    // A path the zip itself holds twice is a "Replace or skip?" inside the zip; with other bytes the answer picks the copy the player gets.
    const twice = duplicatePaths(files), clashing = twice.filter(item => !item.same);
    if (twice.length) log(`  the zip holds ${twice.length} path(s) more than once${clashing.length ? `, ${clashing.length} with DIFFERENT bytes` : ' (the same bytes each time)'}:`);
    for (const item of twice.slice(0, 20)) log(`    ${item.path} (${item.copies.length} copies${item.same ? '' : ': ' + item.copies.map(copy => `${copy.size} bytes, ${copy.crc}`).join(' / ')})`);
    if (twice.length > 20) log(`    ... and ${twice.length - 20} more`);
    ok &&= result.ok && !clashing.length;
  }
  log(ok ? 'OK: every file shared with a pack has the same bytes, so Replace is always safe.' : 'FAILED: move these files to paths the packs do not use, and keep one copy of each path in a zip (docs/PACKAGING.md, "Packs reused unchanged").');
  return ok;
}

export async function makeListing(out, sources, {log = console.log, fetchImpl} = {}) {
  const packs = [];
  let total = 0;
  for (const source of sources) {
    const [name, where] = source.split(/=(.*)/s);
    if (!name || !where) throw Error(`Expected Name=zip-or-url, got "${source}".`);
    const {files, size, bytesRead} = await filesOfZip(where, {fetchImpl});
    total += bytesRead;
    packs.push(packRecord({name, file: basename(isUrl(where) ? new URL(where).pathname : where), bytes: size}, files));
    log(`${name}: ${files.length} files${isUrl(where) ? `, ${bytesRead} bytes read` : ''}`);
  }
  const text = listingText(packs, LISTING_NOTE);
  validateListing(JSON.parse(text));
  await writeFile(out, text);
  log(`Wrote ${out}${total ? `; ${total} bytes read in all` : ''}.`);
  return packs;
}

async function main(argv) {
  const [command, ...rest] = argv;
  if (command === 'check') {
    const at = rest.indexOf('--listing');
    const listingPath = at >= 0 ? resolve(rest[at + 1]) : DEFAULT_LISTING;
    const zips = rest.filter((item, index) => index !== at && index !== at + 1 || at < 0);
    if (!zips.length) throw Error('Name at least one zip to check.');
    return (await checkZips(zips, validateListing(JSON.parse(await readFile(listingPath, 'utf8'))))) ? 0 : 1;
  }
  if (command === 'listing' && rest.length >= 2) { await makeListing(resolve(rest[0]), rest.slice(1)); return 0; }
  console.error('Usage: check-pack-overlap.mjs check <zip>... [--listing FILE]\n       check-pack-overlap.mjs listing <out.json> <Name=zip-or-url>...');
  return 2;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; }, error => { console.error(error.message); process.exitCode = 2; });
}
