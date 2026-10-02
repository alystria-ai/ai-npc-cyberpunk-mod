import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {realpath, stat, writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {packageFile, readJson, RuntimeError, validateManifest} from './runtime-layout.mjs';

// An explicit staging recipe is the file allowlist. Never enumerate a vendor,
// developer runtime or player-state directory to turn it into a package.
try {
  const args = process.argv.slice(2), values = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    if (!['--app', '--recipe'].includes(key) || values[key] || !args[index + 1])
      throw new RuntimeError('invalid-option', 'Supply --app and --recipe once each.');
    values[key] = args[index + 1];
  }
  if (!values['--app'] || !values['--recipe'])
    throw new RuntimeError('invalid-option', 'Supply --app and --recipe once each.');
  const app = await realpath(resolve(values['--app'])), recipe = await readJson(resolve(values['--recipe']));
  if (!Array.isArray(recipe?.files) || !recipe.files.every(path => typeof path === 'string'))
    throw new RuntimeError('invalid-manifest', 'The staging recipe needs an explicit file path list.');
  const proposal = {schema: 1, runtimeVersion: recipe.runtimeVersion, scriptsVersion: recipe.scriptsVersion,
    bridgeEntry: 'bridge/convai-bridge.mjs', bootstrapEntry: 'bootstrap/Runtime-Service.mjs',
    clientAssetsDirectory: 'assets', executables: recipe.executables,
    localVoice: recipe.localVoice, tools: recipe.tools,
    files: recipe.files.map(path => ({path, bytes: 0, sha256: '0'.repeat(64)}))};
  validateManifest(proposal);
  const files = [];
  for (const path of [...recipe.files].sort()) {
    const absolute = await packageFile(app, path), info = await stat(absolute), hash = createHash('sha256');
    for await (const bytes of createReadStream(absolute)) hash.update(bytes);
    files.push({path, bytes: info.size, sha256: hash.digest('hex')});
  }
  const manifest = {...proposal, files}; validateManifest(manifest);
  // A fresh staging directory is required. Rebuild rather than overwriting an
  // installed manifest beside a running service or preserving unknown files.
  await writeFile(resolve(app, 'runtime-manifest.json'), JSON.stringify(manifest, null, 2) + '\n', {flag: 'wx'});
  process.stdout.write(JSON.stringify({schema: 1, state: 'manifest-created', files: files.length,
    runtimeVersion: manifest.runtimeVersion}) + '\n');
} catch (error) {
  process.stderr.write(JSON.stringify({schema: 1, state: 'error',
    code: error instanceof RuntimeError ? error.code : 'manifest-build-failed',
    message: error instanceof RuntimeError ? error.message : 'The runtime manifest could not be created.'}) + '\n');
  process.exitCode = 1;
}
