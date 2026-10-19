import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {run, catalog} from './setup-check-fixture.mjs';
import {collectSetupCheck, readPackPlacement} from './setup-check.mjs';

// What a beginner is told in the installs that go wrong (docs/FRESH_INSTALL_0.2.2.md in deliverables/qa was the walk through them). Three gaps were
// found with the 0.2.2 zips:
//   1. redscript missing: the scripts do not load, and the message sent the player to a compile log that does not exist.
//   2. a Runtime older than the Scripts (0.2.1 has no setup check): the running service never answers, and nothing was said.
//   3. the launcher's pack-move report never reached the Help page (readPackPlacement threw on its default clock, and the caller swallowed it).

const ALL = 'codeware codeware-ui codeware-textinput audioware';
// One whole first load, as in reds-requirements.test.mjs, keeping the notice from whichever tick returns it. The service keeps answering its
// heartbeat (serviceRunning) the way a live bridge does; \`reply\` is what the service writes for the request (nothing for a Runtime without a setup check).
const firstLoad = String.raw`
  function firstLoad(reply)
    local shown = check.tick(true, true)
    advance(12); serviceRunning(); shown = check.tick(true, true) or shown
    local request = files['runtime/setup-check-request.json'] and json.decode(files['runtime/setup-check-request.json'])
    for _ = 1, 20 do
      advance(1); serviceRunning()
      if request and reply then reply(request.id); reply = nil end
      shown = check.tick(true, true) or shown
    end
    return shown, request
  end
  -- the Lua of a game whose scripts did not compile: no framework answers except RED4ext's own plugin
  function scriptsDidNotLoad()
    env.codeware, env.tweakxl, env.audioware, env.scripts, env.native = nil, nil, nil, false, true
    applyEnv()
  end
`;

test('scripts that did not load because redscript is missing say so, instead of sending the player to a log that does not exist', () => run(String.raw`
  ${firstLoad}
  installFiles(); serviceRunning()
  scriptsDidNotLoad()
  -- the service looked for the compiler's file and it is not there
  answer({compiler = {id = 'compiler', state = 'problem', code = 'missing'}})
  check.run()
  assert(lineOf('redscript').state == 'problem')
  assert(lineOf('redscript').description == 'redscript is missing. Install it from Nexus Mods, then restart the game.', lineOf('redscript').description)
  assert(table.concat(check.problems(), ',') == 'redscript', table.concat(check.problems(), ','))
  assert(table.concat(check.reportLines(), '\n'):find('redscript: problem no-compiler', 1, true))
  assert(table.concat(check.reportLines(), '\n'):find('service compiler: problem missing', 1, true))
  local shown = firstLoad()
  assert(shown == 'redscript is missing. Install it from Nexus Mods, then restart the game.', tostring(shown))
  assert(not shown:find('redscript_rCURRENT', 1, true) and not shown:find('log', 1, true))
  assert(#console == 1 and console[1] == '[AiNpcCyberpunkMod] AI NPC Cyberpunk Mod: redscript is missing. Install it from Nexus Mods, then restart the game.', table.concat(console, ' | '))
  assert(files['runtime/probe.log']:find('Setup check: problems: redscript', 1, true))
`));

test('scripts that did not load with the compiler in place, or with no answer from the service, still point to the compile log', () => run(String.raw`
  ${firstLoad}
  installFiles(); serviceRunning()
  scriptsDidNotLoad()
  local generic = 'This mod’s scripts did not load. Open r6/logs/redscript_rCURRENT.log. If the error names another mod, that mod is the problem. Missing or old Codeware, Audioware or redscript, or a game version other than 2.31, can also cause it.'
  -- the compiler's file is there: another mod's error is the likely cause
  answer({})
  check.run()
  assert(lineOf('redscript').description == generic, lineOf('redscript').description)
  assert(check.inspect().game.checks.redscript.code == 'missing')
  assert(firstLoad() == 'Open r6/logs/redscript_rCURRENT.log. A mod it names is why the scripts did not load.')
  -- the service says nothing about the compiler (a Runtime without that check, or no answer yet): the same
  files['runtime/setup-check.json'] = nil
  check.run()
  assert(lineOf('redscript').description == generic)
  -- a compiler that is missing only matters while the scripts did not load
  env.scripts, env.requirements = true, '${ALL}'; env.codeware, env.tweakxl, env.audioware = '1.20.5', '1.11.4', '1.9.9'; applyEnv()
  answer({compiler = {id = 'compiler', state = 'problem', code = 'missing'}})
  check.run()
  assert(lineOf('redscript').state == 'ok' and lineOf('redscript').description == 'Loaded.')
`));

test('a running service that never answers the setup check is a Runtime older than the Scripts: the page and the notice say so', () => run(String.raw`
  ${firstLoad}
  installFiles(); serviceRunning()
  env.requirements = '${ALL}'; applyEnv()
  check.run()
  assert(lineOf('versions') == nil, 'nothing to say before the service has had a chance to answer')
  local shown, request = firstLoad(nil)
  assert(request ~= nil, 'a running service is asked')
  assert(shown == 'The Scripts and Runtime versions do not match. Install the same version of both.', tostring(shown))
  local line = lineOf('versions')
  assert(line.state == 'problem' and line.value == 'Problem', tostring(line and line.state))
  assert(line.description == 'The conversation service did not answer the setup check, so its Runtime is probably older than these Scripts. Download the Runtime for the same version and extract it into the Cyberpunk 2077 folder, then restart the game.', line.description)
  assert(check.problemCount() == 1 and table.concat(check.problems(), ',') == 'versions')
  assert(ids():sub(1, 17) == 'versions=problem ', ids())
  assert(table.concat(check.reportLines(), '\n'):find('the running service did not answer the request', 1, true))
  -- once per game session, like every first-load notice
  for _ = 1, 30 do advance(1); serviceRunning(); assert(check.tick(true, true) == nil) end
  -- an answer of this session clears it, and the page then shows the two versions
  answer({}); check.run()
  assert(lineOf('versions').state == 'ok' and lineOf('versions').description == 'Scripts 0.2.1 and Runtime 0.2.1.', lineOf('versions').description)
  assert(#check.problems() == 0)
`));

test('no setup-check answer is held against a service that is not running, one that stopped, or one that has already answered once', () => run(String.raw`
  ${firstLoad}
  -- no service at all: the first load decides at once and names a service that never started, not a Runtime of another version
  installFiles()
  env.requirements = '${ALL}'; applyEnv()
  check.run()
  local shown = check.tick(true, true); advance(12); shown = check.tick(true, true) or shown
  assert(shown == 'The conversation service did not start. Is the Runtime installed? See Help in Settings.', tostring(shown))
  assert(lineOf('versions') == nil and table.concat(check.problems(), ',') == 'service')
`));

test('a service that answered the light run of this session is never called silent, however late its answer to the request is', () => run(String.raw`
  ${firstLoad}
  installFiles(); serviceRunning()
  env.requirements = '${ALL}'; applyEnv()
  answer({})        -- what the bridge writes at the end of its start
  check.run()
  local shown, request = firstLoad(nil)    -- and then never replies to the request
  assert(request ~= nil and shown == nil, tostring(shown))
  assert(lineOf('versions').state == 'ok')
  assert(#check.problems() == 0)
`));

test('a service that stopped before the request expired is not blamed on the Runtime version', () => run(String.raw`
  ${firstLoad}
  installFiles(); serviceRunning()
  env.requirements = '${ALL}'; applyEnv()
  check.run()
  check.tick(true, true); advance(12); check.tick(true, true)
  assert(files['runtime/setup-check-request.json'] ~= nil)
  -- the heartbeat stops and the request runs out
  local shown
  for _ = 1, 40 do advance(1); shown = check.tick(true, true) or shown end
  assert(lineOf('versions') == nil, 'a stopped service is not an older Runtime')
  assert(not table.concat(check.problems(), ','):find('versions', 1, true))
`));

test('a Local AI or Mature pack one folder too deep is told once: the packs line says where it is, and Local AI does not also say to download one', () => run(String.raw`
  installFiles(); serviceRunning()
  local function packs(name) return {id = 'packs', state = 'problem', code = 'nested', found = {}, nested = {{pack = name, folder = 'AI-NPC-Zip'}}, moved = {}} end
  local notInstalled = {id = 'local-ai', state = 'problem', code = 'not-installed', selected = true, installed = false}
  for _, name in ipairs({'Mature lite', 'Local AI standard'}) do
    answer({packs = packs(name), ['local-ai'] = notInstalled}); check.run()
    assert(lineOf('packs').state == 'problem' and lineOf('packs').description:find('one folder too deep, in AI-NPC-Zip', 1, true), name)
    assert(lineOf('local-ai') == nil, name .. ': no second line that sends the player to download what they already have')
  end
  -- OmniVoice is not a Local AI pack: its absence from Local AI is a separate fact
  answer({packs = packs('OmniVoice'), ['local-ai'] = notInstalled}); check.run()
  assert(lineOf('local-ai').state == 'problem' and lineOf('local-ai').description:find('No Local AI pack found', 1, true))
  -- and with no pack in the way the line is as before
  answer({['local-ai'] = notInstalled}); check.run()
  assert(lineOf('local-ai').description:find('No Local AI pack found', 1, true))
`));

test('the new sentence is a catalogued English UI key', () => {
  const text = 'The conversation service did not answer the setup check, so its Runtime is probably older than these Scripts. Download the Runtime for the same version and extract it into the Cyberpunk 2077 folder, then restart the game.';
  assert.equal(catalog[text], text);
});

// ------------------------------------------------------------------ the bridge side

const MOD = ['bin', 'x64', 'plugins', 'cyber_engine_tweaks', 'mods', 'AiNpcCyberpunkMod'];
async function temp(work) {
  const root = await mkdtemp(join(tmpdir(), 'fresh install '));
  try { return await work(root); } finally { await rm(root, {recursive: true, force: true}); }
}
const put = async (path, text = '{}') => { await mkdir(dirname(path), {recursive: true}); await writeFile(path, text); };
async function install(root, {compiler = true} = {}) {
  const game = join(root, 'game'), modRoot = join(game, ...MOD), project = join(root, 'app'), stateDirectory = join(root, 'state');
  await mkdir(modRoot, {recursive: true}); await mkdir(project, {recursive: true}); await mkdir(stateDirectory, {recursive: true});
  await put(join(modRoot, 'release.json'), JSON.stringify({package: 'scripts', version: '0.2.2'}));
  await put(join(project, 'release.json'), JSON.stringify({package: 'runtime', version: '0.2.2'}));
  if (compiler) await put(join(game, 'engine', 'tools', 'scc.exe'), 'x');
  return {game, modRoot, project, stateDirectory};
}
const quiet = {status: 'ready', reason: null, packInstalled: false, tiers: {standard: null, lite: null}, matureOnly: false, ownServer: false, models: []};
const options = (paths, over = {}) => ({...paths, now: () => 1_800_000_000_000, settings: {}, localAi: () => quiet, omniPack: () => ({installed: false, missing: []}),
  browser: () => 'Microsoft Edge', graphics: async () => [], modManagers: () => ({managers: []}), reach: async () => 'reachable', nestedPacks: async () => [], ...over});
const byId = document => Object.fromEntries(document.checks.map(check => [check.id, check]));

test('the compiler check looks only for redscript\'s file, and is part of the light run', async () => temp(async root => {
  const paths = await install(root);
  const trap = () => assert.fail('no process and no connection');
  assert.deepEqual(byId(await collectSetupCheck(options(paths)))['compiler'], {id: 'compiler', state: 'ok', code: 'found'});
  const light = await collectSetupCheck(options(paths, {light: true, browser: trap, graphics: trap, reach: trap}));
  assert.deepEqual(byId(light).compiler, {id: 'compiler', state: 'ok', code: 'found'});
  const without = await install(join(root, 'second'), {compiler: false});
  assert.deepEqual(byId(await collectSetupCheck(options(without))).compiler, {id: 'compiler', state: 'problem', code: 'missing'});
  // No game folder named: nothing is claimed.
  assert.deepEqual(byId(await collectSetupCheck(options({...paths, game: undefined}))).compiler, {id: 'compiler', state: 'unknown', code: 'unknown'});
}));

test('the launcher\'s pack-move report is read with the default clock (it threw "now is not a function" and the packs line never showed it)', async () => temp(async root => {
  const state = join(root, 'state');
  const report = (extra = {}) => put(join(state, 'pack-placement.json'), JSON.stringify({version: 1, updated: Date.now(), fixed: [], conflicts: [], errors: [], ...extra}));
  await report({fixed: [{pack: 'Mature lite', from: 'AI-NPC-Cyberpunk-Mod-Mature-Lite-0.2.1'}]});
  // Neither the clock nor the start time is given, as the bridge's own call does for the clock.
  assert.deepEqual(await readPackPlacement({stateDirectory: state}), {fixed: [{pack: 'Mature lite', from: 'AI-NPC-Cyberpunk-Mod-Mature-Lite-0.2.1'}], conflicts: [], errors: []});
  assert.notEqual(await readPackPlacement({stateDirectory: state, startedAt: Date.now() - 60_000}), null);
  await report({updated: Date.now() - 11 * 60 * 1000});
  assert.equal(await readPackPlacement({stateDirectory: state}), null, 'the window still applies');
}));

test('what the launcher moved, and what it could not, reach the packs line with no test double for the report', async () => temp(async root => {
  const paths = await install(root);
  const write = value => put(join(paths.stateDirectory, 'pack-placement.json'), JSON.stringify({version: 1, updated: Date.now(), fixed: [], conflicts: [], errors: [], ...value}));
  const packs = async () => byId(await collectSetupCheck({...options(paths), placement: undefined})).packs;
  await write({fixed: [{pack: 'Mature lite', from: 'AI-NPC-Cyberpunk-Mod-Mature-Lite-0.2.1'}]});
  let row = await packs();
  assert.equal(row.code, 'ok');
  assert.deepEqual(row.moved, [{pack: 'Mature lite', from: 'AI-NPC-Cyberpunk-Mod-Mature-Lite-0.2.1'}]);
  await write({fixed: [{pack: 'Local AI standard', from: 'X'}], conflicts: ['local-ai/models/a.gguf']});
  row = await packs();
  assert.deepEqual([row.state, row.code], ['problem', 'conflict']);
  await write({errors: ['Could not finish moving the OmniVoice files into place from X: EBUSY.']});
  assert.deepEqual([(await packs()).state, (await packs()).code], ['problem', 'conflict']);
  // A pack still too deep outranks both.
  await write({conflicts: ['a']});
  row = byId(await collectSetupCheck({...options(paths), placement: undefined, nestedPacks: async () => [{pack: 'OmniVoice', folder: 'Y'}]})).packs;
  assert.equal(row.code, 'nested');
}));
