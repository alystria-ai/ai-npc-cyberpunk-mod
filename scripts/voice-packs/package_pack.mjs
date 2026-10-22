// Zip a built voice language pack like the release packs: AI-NPC-Cyberpunk-Mod-Voices-<lang>.zip, its .files.json and SHA256SUMS.txt.
//
//   node scripts/voice-packs/package_pack.mjs <lang> <stage folder (holds red4ext/...)> <output folder>
//
// The zip holds the stage folder's files under their game-relative names (red4ext/plugins/AiNpcCyberpunkMod/voices/multilingual/<lang>/...) and the
// same fixed "HOW TO INSTALL" note every package carries (its text is fixed: packaging/build-release.mjs). Written with the release builder's own
// ZipWriter, so the layout, the listing (path, bytes, sha256 per file) and the checksum line are the ones the other packs have.
import {mkdir, readdir, readFile, rename, stat, writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {ZipWriter} from '../../packaging/lib/zip.mjs';

const [lang, stage, out] = process.argv.slice(2).map(value => value && resolve(value));
if (!process.argv[2] || !stage || !out) throw Error('usage: node package_pack.mjs <lang> <stage folder> <output folder>');
const language = process.argv[2];
const INSTALL_NOTE_NAME = 'HOW TO INSTALL - extract into your Cyberpunk 2077 folder.txt';
const INSTALL_NOTE = [
  'AI NPC Cyberpunk Mod',
  '',
  'Extract this zip INTO your Cyberpunk 2077 folder (the folder that has bin, archive and r6 in it), and allow folders to merge.',
  'The zip already starts with the right folders (red4ext or bin).',
  '',
  'Do not extract it into a new folder named after the zip. Windows "Extract All" and 7-Zip "Extract to <name>" do that by default:',
  'change the destination to the Cyberpunk 2077 folder itself. If it happened anyway, the mod moves its optional pack files into',
  'place by itself the next time the game starts.',
  '',
  'You can delete this text file after installing.',
  ''].join('\r\n');

async function walk(directory, prefix = '') {
  const found = [];
  for (const entry of await readdir(directory, {withFileTypes: true})) {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) found.push(...await walk(resolve(directory, entry.name), name));
    else if (entry.isFile()) found.push(name);
  }
  return found;
}
const sha256File = path => new Promise((resolveHash, reject) => {
  const hash = createHash('sha256');
  createReadStream(path).on('data', chunk => hash.update(chunk)).on('error', reject).on('end', () => resolveHash(hash.digest('hex')));
});

const manifestPath = resolve(stage, `red4ext/plugins/AiNpcCyberpunkMod/voices/multilingual/${language}/manifest.json`);
const manifest = JSON.parse((await readFile(manifestPath, 'utf8')).replace(/^﻿/, ''));
if (manifest.language !== language) throw Error(`the manifest is for ${manifest.language}, not ${language}`);
const names = (await walk(stage)).filter(name => !name.endsWith('.tmp') && !name.endsWith('.part')).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
if (!names.every(name => name.startsWith('red4ext/'))) throw Error('the stage folder holds files outside red4ext/');
await mkdir(out, {recursive: true});
// The zip is named after the language in full (the folder inside keeps the code).
const LANGUAGE_NAMES = {'zh-cn': 'Chinese', ja: 'Japanese', ko: 'Korean', fr: 'French', de: 'German', it: 'Italian', 'es-es': 'Spanish', pl: 'Polish', 'pt-br': 'Portuguese', ru: 'Russian'};
if (!LANGUAGE_NAMES[language]) throw Error(`no zip name for ${language}`);
const base = `AI-NPC-Cyberpunk-Mod-Voices-${LANGUAGE_NAMES[language]}`;
const temporary = resolve(out, `${base}.zip.tmp`);
const writer = await ZipWriter.create(temporary, {timestamp: new Date(`${manifest.built}T00:00:00Z`)});
const files = [];
const note = Buffer.from(INSTALL_NOTE, 'utf8');
files.push({path: INSTALL_NOTE_NAME, bytes: note.length, sha256: (await writer.add(INSTALL_NOTE_NAME, {buffer: note})).sha256});
for (const name of names) {
  const source = resolve(stage, name);
  const added = await writer.add(name, {source});
  files.push({path: name, bytes: (await stat(source)).size, sha256: added.sha256});
}
const archive = await writer.close();
const zipPath = resolve(out, `${base}.zip`);
await rename(temporary, zipPath);
const zipSha = await sha256File(zipPath);
await writeFile(resolve(out, `${base}.files.json`), JSON.stringify(files, null, 1) + '\n');
await writeFile(resolve(out, 'SHA256SUMS.txt'), `${zipSha}  ${base}.zip\n`);
console.log(JSON.stringify({zip: zipPath, bytes: archive.bytes, entries: archive.entries, sha256: zipSha, files: files.length}));
