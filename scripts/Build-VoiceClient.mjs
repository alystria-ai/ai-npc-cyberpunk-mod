import {build} from 'esbuild';
import {mkdir, readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {atomicFile} from '../bridge/guarded-file.mjs';

const defaultProject = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

// Rebuild rather than trusting timestamps or an older generated file. The
// official SDK and every transitive import are resolved by esbuild on each
// launch. A failed build never replaces the previous complete artifact and
// must prevent the launcher from starting a worker with that older artifact.
export async function buildVoiceClient({projectDirectory = defaultProject} = {}) {
  const project = resolve(projectDirectory);
  const output = resolve(project, 'runtime/realtime-client.js');
  const result = await build({
    absWorkingDir: project,
    entryPoints: [resolve(project, 'bridge/realtime-client.mjs')],
    outfile: output,
    bundle: true,
    format: 'esm',
    platform: 'browser',
    write: false,
    logLevel: 'silent',
  });
  const files = result.outputFiles;
  if (files?.length !== 1 || resolve(files[0].path) !== output || !files[0].contents.byteLength) {
    throw Error('Voice client build did not produce the expected browser bundle.');
  }
  const bytes = files[0].contents, sha256 = digest(bytes);
  await mkdir(dirname(output), {recursive: true});
  if (!await atomicFile(output, bytes)) throw Error('Voice client bundle publication was cancelled.');
  if (digest(await readFile(output)) !== sha256) throw Error('Voice client bundle verification failed.');
  return {output, sha256, bytes: bytes.byteLength};
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length && (args.length !== 2 || args[0] !== '--project' || !args[1])) {
      throw Error('Usage: node scripts/Build-VoiceClient.mjs [--project DIRECTORY]');
    }
    const result = await buildVoiceClient({projectDirectory: args[1] || defaultProject});
    console.log(`Voice client rebuilt and verified (${result.bytes} bytes, SHA-256 ${result.sha256}).`);
  } catch (error) {
    console.error(`Voice client build failed: ${error.message}`);
    process.exitCode = 1;
  }
}
