import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {inspectSetup, resolveRuntimeLayout, RuntimeError, verifyManifestFiles} from './runtime-layout.mjs';
import {recoverService, requestStop, serviceStatus, superviseRuntime} from './runtime-bootstrap.mjs';

function options(argv) {
  const result = {action: argv[0] || 'status'};
  if (!['start', 'stop', 'status', 'check', 'recover'].includes(result.action))
    throw new RuntimeError('invalid-option', 'Choose start, stop, status, check or recover.');
  const values = new Map([['--app', 'appDirectory'], ['--development-project', 'developmentProject'],
    ['--game', 'gameDirectory'], ['--state', 'stateDirectory']]);
  for (let index = 1; index < argv.length; index++) {
    const option = argv[index];
    if (option === '--no-game-watch') { result.watchGame = false; continue; }
    const name = values.get(option);
    if (!name || result[name] !== undefined || !argv[index + 1] || argv[index + 1].startsWith('--'))
      throw new RuntimeError('invalid-option', 'A runtime command option is invalid.');
    result[name] = argv[++index];
  }
  if (result.watchGame === false && !result.developmentProject)
    throw new RuntimeError('invalid-option', 'Packaged services must follow the owning game process.');
  result.appDirectory ||= resolve(dirname(fileURLToPath(import.meta.url)), '..');
  return result;
}

try {
  const input = options(process.argv.slice(2)), layout = await resolveRuntimeLayout(input);
  let result;
  if (input.action === 'check') {
    if (layout.packaged) await verifyManifestFiles(layout.appRoot, layout.manifest);
    const setup = await inspectSetup(layout);
    result = {schema: 1, state: setup.length ? 'setup-required' : 'checked', setup,
      packaged: layout.packaged, runtimeVersion: layout.manifest?.runtimeVersion || 'development'};
  } else if (input.action === 'status') result = await serviceStatus(layout);
  else if (input.action === 'stop') result = await requestStop(layout, {waitMs: 55_000});
  else if (input.action === 'recover') result = await recoverService(layout);
  else {
    const prior = await serviceStatus(layout);
    if (prior.supervisorAlive) result = {...prior, existing: true};
    else {
      const controller = new AbortController();
      for (const name of ['SIGINT', 'SIGTERM']) process.on(name, () => controller.abort());
      result = await superviseRuntime(layout, {watchGame: input.watchGame !== false, signal: controller.signal});
    }
  }
  process.stdout.write(JSON.stringify(result) + '\n');
  if (['setup-required', 'game-not-running'].includes(result.state)) process.exitCode = 2;
  else if (result.state === 'error') process.exitCode = 1;
} catch (error) {
  // Never serialize an exception stack, supplied path, config body or secret.
  process.stderr.write(JSON.stringify({schema: 1, state: 'error',
    code: error instanceof RuntimeError ? error.code : 'bootstrap-failed',
    message: error instanceof RuntimeError ? error.message : 'The runtime could not complete this command.'}) + '\n');
  process.exitCode = 1;
}
