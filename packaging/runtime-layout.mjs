import {readFile, realpath, stat, lstat} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createHash} from 'node:crypto';
import {dirname, isAbsolute, relative, resolve, sep} from 'node:path';

export const MOD_DIRECTORY = 'bin/x64/plugins/cyber_engine_tweaks/mods/CyberpunkConvai';
export const OMNI_REVISION = 'c5fdb5ccb189668d56333f77ba2629f4cd7535f4';
export const ADAPTER_REVISION = '08a1592e3cb9b4c36beef5fa3185ec2313bb1fea';
export const CLIENT_ASSETS = Object.freeze([
  'realtime-client.js', 'continuous-pcm-player.mjs',
  'continuous-pcm-core.mjs', 'continuous-pcm-worklet.mjs',
]);
// The release recipe must name the production bridge's entire local import
// closure. Source tests compare this allowlist with the real entry point so a
// newly imported module cannot silently become a missing package component.
export const BRIDGE_MODULES = Object.freeze([
  'bridge/analysis-pcm.mjs',
  'bridge/audio-delay.mjs',
  'bridge/battle-context.mjs',
  'bridge/caption-cues.mjs',
  'bridge/chat-memory-resets.mjs',
  'bridge/companion-actions.mjs',
  'bridge/companion-expressions.mjs',
  'bridge/companion-invitations.mjs',
  'bridge/convai-bridge.mjs',
  'bridge/convai-continuous-speech.mjs',
  'bridge/convai-key.mjs',
  'bridge/convai-quota.mjs',
  'bridge/conversation-style.mjs',
  'bridge/dialogue-level.mjs',
  'bridge/distraction-context.mjs',
  'bridge/emotion-analysis.mjs',
  'bridge/emotion-lexicon.mjs',
  'bridge/emotion-selector.mjs',
  'bridge/emotion-tags.mjs',
  'bridge/expression-timeline.mjs',
  'bridge/expressive-emotions.mjs',
  'bridge/facial-timeline.mjs',
  'bridge/follow-up.mjs',
  'bridge/game-dialogue.mjs',
  'bridge/game-launch.mjs',
  'bridge/group-context.mjs',
  'bridge/group-lookahead.mjs',
  'bridge/group-prefetch.mjs',
  'bridge/guarded-file.mjs',
  'bridge/intrinsic-character-context.mjs',
  'bridge/jali-face-model.mjs',
  'bridge/jali-face.mjs',
  'bridge/journal-history.mjs',
  'bridge/journal-quest-types.mjs',
  'bridge/key-codec.mjs',
  'bridge/local-pcm-host.mjs',
  'bridge/local-stt-capture.mjs',
  'bridge/local-stt.mjs',
  'bridge/loot-context.mjs',
  'bridge/microphone-session.mjs',
  'bridge/mistral-client.mjs',
  'bridge/mistral-host.mjs',
  'bridge/mistral-key.mjs',
  'bridge/mistral-memory.mjs',
  'bridge/mistral-prompt.mjs',
  'bridge/multilingual.mjs',
  'bridge/natural-speech-talk.mjs',
  'bridge/natural-speech.mjs',
  'bridge/nearby-warm.mjs',
  'bridge/omni-pack.mjs',
  'bridge/party-connections.mjs',
  'bridge/phone-analysis-config.mjs',
  'bridge/phone-chat.mjs',
  'bridge/phone-poses.mjs',
  'bridge/phone-warm.mjs',
  'bridge/phonetic-lipsync.mjs',
  'bridge/phonetic-poses.mjs',
  'bridge/player-gear.mjs',
  'bridge/player-knowledge.mjs',
  'bridge/player-memory-api.mjs',
  'bridge/player-memory-control.mjs',
  'bridge/player-memory.mjs',
  'bridge/player-phone-knowledge.mjs',
  'bridge/pocket-facial-stream.mjs',
  'bridge/pocket-speech.mjs',
  'bridge/pocket-voice.mjs',
  'bridge/protocol.mjs',
  'bridge/quest-context.mjs',
  'bridge/quest-overview.mjs',
  'bridge/realtime-host.mjs',
  'bridge/relationship-routing.mjs',
  'bridge/reply-language.mjs',
  'bridge/request-ownership.mjs',
  'bridge/resident-phone-analysis.mjs',
  'bridge/resident-voice.mjs',
  'bridge/romance-context.mjs',
  'bridge/runtime-paths.mjs',
  'bridge/shared-key-guard.mjs',
  'bridge/speech-audio.mjs',
  'bridge/speech-stream.mjs',
  'bridge/support-report.mjs',
  'bridge/text-emotion.mjs',
  'bridge/transport-pool.mjs',
  'bridge/turn-context.mjs',
  'bridge/vendor-memory.mjs',
  'bridge/voice-config-paths.mjs',
  'bridge/voice-preview.mjs',
  'bridge/voice-profile-registry.mjs',
  'bridge/voice-routing-log.mjs',
  'bridge/voice-selection.mjs',
  'bridge/voice-variants.mjs',
  'bridge/world-knowledge.mjs',
  'bridge/world-session.mjs',
  'bridge/zip-writer.mjs',
]);
// Files the production bridge starts at run time by path (worker threads and
// Python workers) rather than by a static import, so the closure test cannot
// see them. A source test scans the closure for these references. The phone
// analysis worker is named by the prepared phone-analysis.json instead of a
// literal path; its models and dependency tree are generated data, not source.
export const BRIDGE_AUXILIARY_FILES = Object.freeze([
  'bridge/jali-face-worker.mjs',
  'bridge/jali-face-text.mjs', // imported only by the worker
  'bridge/resident-voice-worker.py',
  'bridge/voice-cuda-graph.py',
  'bridge/pocket-voice-worker.py',
  'bridge/pocket_voice_runtime.py',
  'bridge/phone-analysis-worker.py',
  'bridge/local-stt-worker.py',
  'bridge/audio-output-probe.ps1', // Lip sync delay Auto: default output device
]);
// These are the pinned external package entry points, not a replacement for the
// full reviewed Playwright distributions and their transitive source/notices.
export const NODE_PACKAGE_ENTRIES = Object.freeze([
  'node_modules/playwright/package.json', 'node_modules/playwright/index.mjs',
  'node_modules/playwright/index.js', 'node_modules/playwright/lib/index.js',
  'node_modules/playwright-core/package.json', 'node_modules/playwright-core/index.mjs',
  'node_modules/playwright-core/index.js', 'node_modules/playwright-core/lib/server/playwright.js',
]);

export class RuntimeError extends Error {
  constructor(code, message) { super(message); this.name = 'RuntimeError'; this.code = code; }
}

const inside = (root, path) => {
  const part = relative(root, path);
  return part === '' || (!part.startsWith('..' + sep) && part !== '..' && !isAbsolute(part));
};
const version = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(value);
const object = value => value && typeof value === 'object' && !Array.isArray(value);

export function packagePath(root, value) {
  if (typeof value !== 'string' || !value || /[\\:\x00-\x1f\x7f]/.test(value)
      || value.startsWith('/') || value.endsWith('/')
      || value.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new RuntimeError('invalid-manifest', 'Runtime paths must be relative package paths.');
  }
  const path = resolve(root, ...value.split('/'));
  if (!inside(root, path)) throw new RuntimeError('invalid-manifest', 'Runtime path escaped the application directory.');
  return path;
}

export async function packageFile(root, value) {
  const path = packagePath(root, value);
  let actual, info;
  try { actual = await realpath(path); info = await stat(actual); }
  catch { throw new RuntimeError('runtime-incomplete', 'A required runtime file is missing.'); }
  if (!inside(root, actual) || !info.isFile())
    throw new RuntimeError('invalid-manifest', 'A runtime file escaped the application directory.');
  return actual;
}

export async function readJson(path, maximum = 4 * 1024 * 1024) {
  let bytes;
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size > maximum) throw new Error();
    bytes = await readFile(path);
    if (bytes.length > maximum) throw new Error();
    return JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new RuntimeError('invalid-configuration', 'A runtime configuration file is invalid.');
  }
}

export function validateManifest(value) {
  if (!object(value) || value.schema !== 1 || !version(value.runtimeVersion)
      || !version(value.scriptsVersion) || value.bridgeEntry !== 'bridge/convai-bridge.mjs'
      || value.bootstrapEntry !== 'bootstrap/Runtime-Service.mjs'
      || value.clientAssetsDirectory !== 'assets' || !object(value.executables)
      || value.localVoice?.engine !== 'omnivoice' || value.localVoice.revision !== OMNI_REVISION
      || value.localVoice.adapterRevision !== ADAPTER_REVISION
      || value.localVoice.modelDirectory !== 'models/omnivoice'
      || value.localVoice.adapterDirectory !== 'voice/voicestudio/backend'
      || value.tools?.rhubarb?.path !== 'tools/rhubarb/rhubarb.exe' || value.tools.rhubarb.version !== '1.14.0'
      || !Array.isArray(value.files) || !value.files.length || value.files.length > 20_000) {
    throw new RuntimeError('invalid-manifest', 'The runtime manifest is invalid or unsupported.');
  }
  const files = new Map();
  for (const file of value.files) {
    if (!object(file) || typeof file.path !== 'string' || !/^[a-f0-9]{64}$/.test(file.sha256)
        || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || file.bytes > 16 * 1024 ** 3) {
      throw new RuntimeError('invalid-manifest', 'A runtime file declaration is invalid.');
    }
    packagePath(resolve('.'), file.path);
    // Player state is never an application manifest entry, including empty
    // defaults. The reviewed bridge/player-memory.mjs is application source,
    // whereas player-memory.json and similarly named copies remain private.
    if (/^(?:data|runtime|backups|research\/cache)(?:\/|$)/i.test(file.path)
        || (!BRIDGE_MODULES.includes(file.path)
          && /(?:^|\/)(?:\.env(?:\..*)?|convai-key\.txt|characters(?:-verified)?\.json|relationship-profiles\.json|local-voices\.json|player-memory(?:\..*)?|phone-history(?:\..*)?|phone-sessions\.json|memory-chat-resets\.json|.*\.(?:key|log))$/i.test(file.path))
        || /\.(?:lua|wav|wem|mp3|mp4|mkv|flac|ogg)$/i.test(file.path) || files.has(file.path.toLowerCase())) {
      throw new RuntimeError('invalid-manifest', 'Runtime manifests cannot contain player state or duplicate files.');
    }
    files.set(file.path.toLowerCase(), file);
  }
  const required = [...BRIDGE_MODULES, ...NODE_PACKAGE_ENTRIES,
    'Start-Runtime.ps1', value.bootstrapEntry,
    'bootstrap/runtime-layout.mjs', 'bootstrap/runtime-bootstrap.mjs',
    ...BRIDGE_AUXILIARY_FILES,
    'python/Lib/site-packages/omnivoice/__init__.py',
    'python/Lib/site-packages/omnivoice/models/omnivoice.py',
    'voice/voicestudio/backend/services/tts_backend.py', 'tools/rhubarb/rhubarb.exe',
    'characters/roster.json', 'characters/world-knowledge.json', 'characters/phone-contacts.json',
    'research/cyberpunk/generated/quest-catalog.json',
    'models/omnivoice/model.safetensors', 'models/omnivoice/config.json',
    'models/omnivoice/tokenizer.json', 'models/omnivoice/tokenizer_config.json',
    'models/omnivoice/chat_template.jinja', 'models/omnivoice/audio_tokenizer/model.safetensors',
    'models/omnivoice/audio_tokenizer/config.json', 'models/omnivoice/audio_tokenizer/preprocessor_config.json',
    ...CLIENT_ASSETS.map(name => `assets/${name}`)];
  for (const name of ['node', 'python', 'browser']) {
    const entry = value.executables[name];
    if (!object(entry) || typeof entry.path !== 'string' || !entry.path.endsWith('.exe'))
      throw new RuntimeError('invalid-manifest', 'Packaged executables must be declared explicitly.');
    required.push(entry.path);
  }
  if (required.some(path => !files.has(path.toLowerCase())))
    throw new RuntimeError('invalid-manifest', 'The runtime manifest omitted a required component.');
  return Object.freeze({...value, fileMap: files});
}

export async function verifyManifestFiles(appRoot, manifest, {checkpoint = async () => {}} = {}) {
  // Stream weights rather than collecting them into memory. No executable is
  // launched and no private runtime/configuration tree is walked or copied.
  for (const file of manifest.files) {
    await checkpoint(true);
    const path = await packageFile(appRoot, file.path), info = await stat(path);
    if (info.size !== file.bytes)
      throw new RuntimeError('runtime-integrity', 'A packaged runtime file failed its size check.');
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(path)) {
      await checkpoint(false); hash.update(chunk);
    }
    await checkpoint(true);
    if (hash.digest('hex') !== file.sha256)
      throw new RuntimeError('runtime-integrity', 'A packaged runtime file failed its hash check.');
  }
}

export async function resolveRuntimeLayout({appDirectory, developmentProject, gameDirectory,
  stateDirectory, executable = process.execPath}) {
  const packaged = !developmentProject;
  const appRoot = await realpath(resolve(developmentProject || appDirectory));
  let gameRoot, modRoot, manifest = null;
  if (packaged) {
    modRoot = dirname(appRoot);
    gameRoot = await realpath(resolve(appRoot, '../../../../../../..'));
    if (relative(resolve(gameRoot, MOD_DIRECTORY, 'app'), appRoot) !== '')
      throw new RuntimeError('invalid-installation', 'Install the runtime inside the CyberpunkConvai app directory.');
    if (gameDirectory || stateDirectory)
      throw new RuntimeError('invalid-installation', 'Packaged runtime paths are discovered from the installation.');
    manifest = validateManifest(await readJson(resolve(appRoot, 'runtime-manifest.json')));
  } else {
    if (!gameDirectory || !isAbsolute(gameDirectory))
      throw new RuntimeError('invalid-installation', 'Development mode needs an explicit absolute game directory.');
    gameRoot = await realpath(gameDirectory);
    modRoot = resolve(gameRoot, MOD_DIRECTORY);
  }
  const gameExecutable = resolve(gameRoot, 'bin/x64/Cyberpunk2077.exe');
  try { if (!(await stat(gameExecutable)).isFile()) throw new Error(); }
  catch { throw new RuntimeError('invalid-installation', 'Cyberpunk2077.exe is missing from the selected game directory.'); }
  const stateRoot = resolve(packaged ? resolve(modRoot, 'data') : stateDirectory || resolve(appRoot, 'runtime'));
  if (inside(appRoot, stateRoot) && packaged)
    throw new RuntimeError('invalid-installation', 'Player state must be separate from application binaries.');
  if (packaged) {
    try {
      const info = await lstat(stateRoot), actual = await realpath(stateRoot);
      if (!info.isDirectory() || info.isSymbolicLink() || relative(stateRoot, actual) !== '')
        throw new RuntimeError('invalid-installation', 'The packaged data directory cannot redirect into another location.');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  const entry = await packageFile(appRoot, 'bridge/convai-bridge.mjs');
  const nodeExecutable = packaged ? await packageFile(appRoot, manifest.executables.node.path) : executable;
  const env = {CYBERPUNK_CONVAI_GAME: gameRoot, CYBERPUNK_CONVAI_STATE: stateRoot,
    CYBERPUNK_CONVAI_KEY_FILE: resolve(stateRoot, 'convai-key.txt')};
  if (packaged) {
    env.CYBERPUNK_CONVAI_PYTHON = await packageFile(appRoot, manifest.executables.python.path);
    env.CYBERPUNK_CONVAI_BROWSER = await packageFile(appRoot, manifest.executables.browser.path);
    env.CYBERPUNK_CONVAI_CLIENT_ASSETS = resolve(appRoot, manifest.clientAssetsDirectory);
    env.CYBERPUNK_CONVAI_OMNI_MODEL = resolve(appRoot, manifest.localVoice.modelDirectory);
    env.CYBERPUNK_CONVAI_OMNI_ADAPTER = resolve(appRoot, manifest.localVoice.adapterDirectory);
    env.CYBERPUNK_CONVAI_OMNI_REFERENCES = resolve(stateRoot, 'voice-references');
    env.CYBERPUNK_CONVAI_OMNI_CACHE = resolve(stateRoot, 'voice-studio-data');
    env.CYBERPUNK_CONVAI_RHUBARB = resolve(appRoot, manifest.tools.rhubarb.path);
    env.CYBERPUNK_CONVAI_LIPSYNC_WORK = resolve(stateRoot, 'lipsync-work');
  }
  return Object.freeze({packaged, appRoot, gameRoot, gameExecutable, modRoot,
    gameRuntime: resolve(modRoot, 'runtime'), stateRoot, entry, nodeExecutable, manifest, env,
    leasePath: resolve(stateRoot, 'service-owner.json'),
    serviceStatusPath: resolve(stateRoot, 'service-status.json'),
    serviceControlPath: resolve(stateRoot, 'service-control.json'),
    bridgeControlPath: resolve(stateRoot, 'bridge-control.json')});
}

export async function inspectSetup(layout) {
  const needed = [];
  let key;
  try {
    const info = await stat(layout.env.CYBERPUNK_CONVAI_KEY_FILE);
    if (!info.isFile() || info.size > 4096) throw new Error();
    key = await readFile(layout.env.CYBERPUNK_CONVAI_KEY_FILE, 'utf8');
  } catch { needed.push('convai-key'); }
  if (key !== undefined && !/^api-key\s*=\s*\S+\s*$/i.test(key.trim())) needed.push('convai-key');
  const ids = await readJson(resolve(layout.stateRoot, 'characters.json'));
  if (!object(ids) || !Object.keys(ids).length
      || Object.keys(ids).length > 256
      || Object.entries(ids).some(([name, id]) => !/^[a-z0-9][a-z0-9-]{0,79}$/.test(name)
        || ['__proto__', 'constructor', 'prototype'].includes(name)
        || typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,255}$/.test(id))) needed.push('character-profiles');
  const config = await readJson(resolve(layout.stateRoot, 'local-voices.json'));
  if (config !== null && !object(config))
    throw new RuntimeError('invalid-configuration', 'Local voice configuration must be a JSON object.');
  return needed;
}

export function bridgeEnvironment(layout, source = process.env) {
  const env = {...source};
  // An inherited Node import hook or Python path must not redirect package code.
  for (const name of ['NODE_OPTIONS', 'NODE_PATH', 'PYTHONPATH', 'PYTHONHOME',
    'CYBERPUNK_CONVAI_PYTHON', 'CYBERPUNK_CONVAI_BROWSER', 'CYBERPUNK_CONVAI_CLIENT_ASSETS',
    'CYBERPUNK_CONVAI_OMNI_MODEL', 'CYBERPUNK_CONVAI_OMNI_ADAPTER',
    'CYBERPUNK_CONVAI_OMNI_REFERENCES', 'CYBERPUNK_CONVAI_OMNI_CACHE',
    'CYBERPUNK_CONVAI_RHUBARB', 'CYBERPUNK_CONVAI_LIPSYNC_WORK']) delete env[name];
  return {...env, ...layout.env};
}
