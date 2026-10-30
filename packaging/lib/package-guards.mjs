// The last check on every entry of a package a release build writes (packaging/build-release.mjs) and of the Full install package
// (packaging/build-full.mjs), kept in one place so the combined zip meets the very rules of the two it is made of.
import {CODE_FOLDER} from './code-payload.mjs';
import {SHIPPED_KEY_FILE} from './convai-auth.mjs';
import {listZip} from './zip.mjs';
import {entryHead} from './zip-entry.mjs';
import {open} from 'node:fs/promises';

// The Runtime base's marker plugin (native/autostart built with CONVAI_BASE_MARKER): a RED4ext plugin that does nothing.
export const BASE_MARKER = 'CyberpunkConvaiBase.dll';

/**
 * Why a zip entry must never ship, or null. `layout` is release.config.json "layout".
 * Only the shipped launcher and the native plugin (both in the Scripts' code folder from 0.3.4) and the base's marker may install a RED4ext plugin.
 * RED4ext loads a DLL that lies directly in a plugin folder; the Runtime's own app/ tree (Python, llama.cpp, vgmstream and their libraries) is not a plugin
 * and holds many DLLs and .ini files (the refactor that moved this check here had dropped them: a real Runtime or pack failed the final guard).
 * The development launcher (red4ext/plugins/CyberpunkConvaiLauncher) must never ship: with it, two services start.
 */
export function forbiddenEntry(name, layout) {
  if (/^misc\//.test(name)) return 'contains developer-only material';
  if (/^red4ext\//i.test(name) && /\.(?:dll|ini)$/i.test(name)
      && !name.startsWith(`${CODE_FOLDER}/`) && name !== `${layout.pluginDirectory}/${BASE_MARKER}`
      && !name.startsWith(`${layout.pluginDirectory}/app/`)) {
    return 'installs an unexpected RED4ext plugin file';
  }
  if (/(?:^|\/)CyberpunkConvaiLauncher[^/]*$/i.test(name)) return 'contains the development launcher';
  if (SHIPPED_KEY_FILE.test(name)) return 'would ship a Convai key file';
  if (/(?:^|\/)(?:convai-key\.txt|kaggle-access-token\.txt|huggingface-[^/]*\.txt|\.env|(?:player|vendor)-memory[^/]*\.(?:json|bak|tmp|corrupt)|phone-sessions\.json|characters-verified\.json)$/i.test(name)) {
    return 'contains a forbidden file';
  }
  return null;
}

// ---- No archive inside the main file --------------------------------------------------------------------------------------------------------
// Owner rule (2026-10-31): the Nexus main file (the Full zip) and the packages it is made of (the Scripts, which is also the Update zip, the Runtime base and the
// Runtime update) hold NO archive. Antivirus scanners open a zip, a gzip, a 7z and the like inside a download and flag what they cannot read (Nexus Mods
// quarantined 0.3.4 once already), so the lip-sync table ships as plain text and a package's own data is never a nested archive. The optional packs on
// Hugging Face are separate files and are not covered.
//
// An entry is refused by its NAME (an archive extension) or by its FIRST BYTES (a renamed archive): zip (also .whl, .jar), gzip, 7z, RAR, xz, bzip2, tar,
// cab; an .msi/.msp/.msm by its name and its OLE header (a plain OLE document is not an archive and is left alone).
export const ARCHIVE_GUARDED_PACKAGES = Object.freeze(['scripts', 'runtime']);
export const ARCHIVE_HEAD_BYTES = 512;
const ARCHIVE_NAME = /\.(?:zip|gz|tgz|7z|rar|xz|txz|lzma|bz2|tbz2|tar|cab|msi|msp|msm|whl|jar|apk|nupkg|vsix|pyz|egg|zst|lz4)$/i;
const OLE_HEAD = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const startsWith = (head, bytes, at = 0) => head.length >= at + bytes.length && bytes.every((byte, index) => head[at + index] === byte);
const ascii = text => [...text].map(character => character.charCodeAt(0));

/** What kind of archive these first bytes are, or null. `head` is a Buffer/Uint8Array of at least the first 262 bytes (fewer for a small file). */
export function archiveKind(head) {
  if (startsWith(head, [0x50, 0x4b, 0x03, 0x04]) || startsWith(head, [0x50, 0x4b, 0x05, 0x06]) || startsWith(head, [0x50, 0x4b, 0x07, 0x08])) return 'zip';
  if (startsWith(head, [0x1f, 0x8b, 0x08])) return 'gzip';
  if (startsWith(head, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])) return '7z';
  if (startsWith(head, ascii('Rar!\x1a\x07'))) return 'rar';
  if (startsWith(head, [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00])) return 'xz';
  if (startsWith(head, ascii('BZh')) && head.length > 9 && head[3] >= 0x31 && head[3] <= 0x39 && startsWith(head, [0x31, 0x41, 0x59, 0x26, 0x53, 0x59], 4)) return 'bzip2';
  if (startsWith(head, ascii('ustar'), 257)) return 'tar';
  if (startsWith(head, ascii('MSCF\0\0\0\0'))) return 'cab';
  return null;
}

/** Why this entry would be a nested archive, or null. `head`: its first bytes when they are known (a name alone is checked when they are not). */
export function archiveEntry(name, head) {
  if (ARCHIVE_NAME.test(name)) return `is an archive by its name (${/\.[^./]+$/.exec(name)[0].toLowerCase()})`;
  if (head) {
    const kind = archiveKind(head);
    if (kind) return `is a ${kind} archive by its first bytes`;
    if (/\.(?:msi|msp|msm)$/i.test(name) && startsWith(head, OLE_HEAD)) return 'is an installer package';
  }
  return null;
}

/** The entries of a package (a Map of name to {source} | {buffer} | {chunks}) that are archives. Reads only each file's first bytes. */
export async function archivesIn(entries) {
  const found = [];
  for (const [name, entry] of entries) {
    let head = null;
    if (entry.buffer) head = entry.buffer.subarray(0, ARCHIVE_HEAD_BYTES);
    else if (entry.source) {
      const handle = await open(entry.source, 'r');
      try { const buffer = Buffer.alloc(ARCHIVE_HEAD_BYTES); const {bytesRead} = await handle.read(buffer, 0, ARCHIVE_HEAD_BYTES, 0); head = buffer.subarray(0, bytesRead); } finally { await handle.close(); }
    }
    const why = archiveEntry(name, head);
    if (why) found.push(`${name} ${why}`);
  }
  return found;
}

/** Throws when a package the main file is made of would hold an archive. */
export async function assertNoArchives(id, entries) {
  const found = await archivesIn(entries);
  if (found.length) throw Error(`${id}: the main file holds no archive (nested archives trigger antivirus flags on Nexus Mods), but ${found.length} entr${found.length === 1 ? 'y is' : 'ies are'} one: ${found.slice(0, 6).join(', ')}`);
}

/** The entries of a finished zip that are archives, by name and by the first bytes of each file (the last check on a package the main file is made of). */
export async function archivesInZip(zip) {
  const found = [];
  for (const entry of await listZip(zip)) {
    if (entry.name.endsWith('/')) continue;
    const why = archiveEntry(entry.name, await entryHead(zip, entry, ARCHIVE_HEAD_BYTES));
    if (why) found.push(`${entry.name} ${why}`);
  }
  return found;
}
