// Builds the OmniVoice server folder (docs/REMOTE_OMNIVOICE.md, "The server folder") from an installed mod:
//
//   node packaging/build-omni-server.mjs --from "<game>/red4ext/plugins/AiNpcCyberpunkMod" --to "D:/OmniVoice-Server" [--bridge <bridge folder>] [--no-voices] [--launcher-only]
//
// The folder is made of what the Runtime and the OmniVoice pack already contain, so there is no second copy of the voice code to keep in step:
//   app/node/               the Runtime's Node
//   app/bridge/             the files of bridge/omni-server-main.mjs's import closure, the voice worker (resident-voice-worker.py, voice-cuda-graph.py) and nothing else
//   app/defaults/           the OmniVoice voice list the worker starts with
//   app/omni/               the OmniVoice pack whole (its Python with PyTorch, the model, the voice adapter, its notices)
//   app/release.json        the version the server reports
//   voices/picked, voices/archetypes   the shipped reference clips (without them the game sends the clips the server lacks; --no-voices leaves them out)
//   Start OmniVoice server.cmd, Show graphics cards.cmd, README.txt   from packaging/omni-server/
// --launcher-only makes just the three small files: the start file then names the mod's folder (MOD_FOLDER) and uses that install, for a second graphics card of the same PC.
//
// `--bridge` names the folder to take the bridge files from (default: the installed mod's own app/bridge when it holds the server, else this repository's bridge/).
import {cp, mkdir, readFile, stat, writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repository = resolve(here, '..');
export const SERVER_ENTRY = 'omni-server-main.mjs';
export const WORKER_FILES = Object.freeze(['resident-voice-worker.py', 'voice-cuda-graph.py']);
export const TEMPLATE_FILES = Object.freeze(['Start OmniVoice server.cmd', 'Show graphics cards.cmd', 'README.txt']);
export const VOICE_FOLDERS = Object.freeze(['picked', 'archetypes']);

const IMPORT = /(?:from|import)\s*\(?\s*['"](\.\/[^'"]+\.mjs)['"]/g;
/** The files of `entry` and everything it imports from the same folder (static and dynamic imports of "./x.mjs"), as sorted file names. */
export async function importClosure(directory, entry = SERVER_ENTRY) {
  const seen = new Set(), pending = [entry];
  while (pending.length) {
    const name = pending.pop();
    if (seen.has(name)) continue;
    seen.add(name);
    const source = await readFile(join(directory, name), 'utf8');
    for (const match of source.matchAll(IMPORT)) pending.push(match[1].slice(2));
  }
  return [...seen].sort();
}

const isFile = async path => { try { return (await stat(path)).isFile(); } catch { return false; } };
const isDirectory = async path => { try { return (await stat(path)).isDirectory(); } catch { return false; } };

export function parseArguments(argv) {
  const options = {from: null, to: null, bridge: null, voices: true, launcherOnly: false};
  for (let at = 0; at < argv.length; at++) {
    const name = argv[at];
    if (name === '--no-voices') options.voices = false;
    else if (name === '--launcher-only') options.launcherOnly = true;
    else if (['--from', '--to', '--bridge'].includes(name)) {
      const value = argv[++at];
      if (!value) return {error: `${name} needs a folder`};
      options[name.slice(2)] = resolve(value);
    } else return {error: `Unknown option ${name}`};
  }
  if (!options.to) return {error: 'Say where to build the folder with --to'};
  if (!options.launcherOnly && !options.from) return {error: 'Say which installed mod to take the files from with --from (its folder that holds "app" and "voices")'};
  return options;
}

/** Builds the folder. Resolves {to, files: [relative paths copied by name], folders: [relative folders copied whole]}. */
export async function buildServerFolder({from, to, bridge = null, voices = true, launcherOnly = false, log = () => {}} = {}) {
  if (!to) throw Error('No destination folder');
  await mkdir(to, {recursive: true});
  const copied = {files: [], folders: []};
  for (const name of TEMPLATE_FILES) {
    await cp(join(here, 'omni-server', name), join(to, name));
    copied.files.push(name);
  }
  if (launcherOnly) return {to, ...copied};
  const app = join(from, 'app');
  const missing = [];
  for (const [path, words] of [[join(app, 'node', 'node.exe'), 'app/node/node.exe'], [join(app, 'omni', 'python', 'python.exe'), 'app/omni/python/python.exe'],
    [join(app, 'omni', 'model', 'model.safetensors'), 'app/omni/model/model.safetensors'], [join(app, 'omni', 'voicestudio', 'backend', 'services', 'tts_backend.py'), 'app/omni/voicestudio']]) {
    if (!(await isFile(path))) missing.push(words);
  }
  if (missing.length) throw Error(`The installed mod lacks ${missing.join(', ')} (is the OmniVoice pack installed?)`);
  // The bridge files: the installed Runtime's when it already holds the server, else this repository's.
  const installed = join(app, 'bridge');
  const source = bridge ?? (await isFile(join(installed, SERVER_ENTRY)) ? installed : join(repository, 'bridge'));
  if (!(await isFile(join(source, SERVER_ENTRY)))) throw Error(`${SERVER_ENTRY} is not in ${source}`);
  const names = [...await importClosure(source), ...WORKER_FILES];
  await mkdir(join(to, 'app', 'bridge'), {recursive: true});
  for (const name of names) {
    // The worker comes from the same place as the server so the two agree; a worker the bridge folder lacks is taken from the installed one.
    const file = existsSync(join(source, name)) ? join(source, name) : join(installed, name);
    await cp(file, join(to, 'app', 'bridge', name));
    copied.files.push(`app/bridge/${name}`);
  }
  log(`${names.length} bridge files`);
  for (const [relative, optional] of [['app/node', false], ['app/omni', false], ['app/release.json', true], ['app/defaults/local-voices.autobest-long.json', true]]) {
    const path = join(from, ...relative.split('/'));
    if (!existsSync(path)) { if (optional) continue; throw Error(`${relative} is missing`); }
    await mkdir(dirname(join(to, ...relative.split('/'))), {recursive: true});
    await cp(path, join(to, ...relative.split('/')), {recursive: true, filter: item => !/[\\/]__pycache__([\\/]|$)/.test(item)});
    (await isDirectory(path) ? copied.folders : copied.files).push(relative);
    log(`copied ${relative}`);
  }
  if (voices) {
    for (const folder of VOICE_FOLDERS) {
      const path = join(from, 'voices', folder);
      if (!(await isDirectory(path))) continue;
      await cp(path, join(to, 'voices', folder), {recursive: true});
      copied.folders.push(`voices/${folder}`);
      log(`copied voices/${folder}`);
    }
  }
  await writeFile(join(to, 'server-folder.txt'), `Built ${new Date().toISOString()} from the mod's ${(await readFile(join(app, 'release.json'), 'utf8').then(text => JSON.parse(text).version, () => null)) ?? 'installed'} files.\n`);
  return {to, ...copied};
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = parseArguments(process.argv.slice(2));
  if (options.error) { console.error(options.error); process.exit(2); }
  buildServerFolder({...options, log: message => console.log(message)}).then(result => console.log(`Built ${result.to}: ${result.files.length} files and ${result.folders.join(', ') || 'no folders'} copied.`),
    error => { console.error(error.message); process.exit(1); });
}
