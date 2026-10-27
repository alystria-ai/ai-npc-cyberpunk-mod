// The build check (mod/setup-check.lua buildCheck, docs/GAME_VERSIONS.md "Wrong build"): the Scripts, the Runtime and the running game must be for the same
// game version. Six installs of 27 Oct paired the 2.5 Scripts with the 2.31 Runtime and nothing said so. Every combination, the one first-load notice that names
// what to download, the Help row, the console line and the report cause. The bridge side (the Runtime's game in the versions answer) is in setup-check.test.mjs.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {run} from './setup-check-fixture.mjs';

// S: the game the Scripts were built for (release.json), R: the Runtime's (the service's answer, or null when it did not say), G: the running game (null: unreadable).
const MATRIX = [
  // [S, R, G, code]
  ['2.31', '2.31', '2.31', 'ok'], ['2.5', '2.5', '2.5', 'ok'],
  ['2.5', '2.31', '2.5', 'runtime-wrong'], ['2.31', '2.5', '2.31', 'runtime-wrong'],
  ['2.5', '2.31', '2.31', 'scripts-wrong'], ['2.31', '2.5', '2.5', 'scripts-wrong'],
  ['2.5', '2.5', '2.31', 'both-wrong'], ['2.31', '2.31', '2.5', 'both-wrong'],
  ['2.5', '2.31', '2.51', 'differ'], ['2.5', '2.31', null, 'differ'], ['2.31', '2.5', null, 'differ'],
  // a game version neither build is for is only a note (the Game version row); it is no mismatch of the files
  ['2.5', '2.5', '2.51', 'ok'], ['2.31', '2.31', '2.32', 'ok'],
  // the Runtime did not say (no answer from the service, or one that does not name its game and has no readable release.json)
  ['2.5', null, '2.31', 'scripts-wrong'], ['2.5', null, '2.5', 'ok'], ['2.31', null, '2.5', 'scripts-wrong'], ['2.5', null, null, 'unknown'],
];

const luaValue = value => (value === null ? 'nil' : `'${value}'`);

test('every combination of the Scripts, the Runtime and the running game gives one build code', () => {
  for (const [scripts, runtime, game, code] of MATRIX) {
    run(String.raw`
      installFiles(); serviceRunning()
      put('release.json', {product = 'AI-NPC-Cyberpunk-Mod', package = 'scripts', version = '0.3.2', game = ${luaValue(scripts)}})
      env.gameVersion = ${luaValue(game)}; applyEnv()
      ${runtime ? `answer({versions = {id = 'versions', state = 'ok', code = 'match', scripts = '0.3.2', runtime = '0.3.2', scriptsGame = ${luaValue(scripts)}, runtimeGame = ${luaValue(runtime)}}})`
        : `answer()`}
      check.run()
      local build = check.inspect().game.checks.build
      assert(build.code == '${code === 'ok' ? 'match' : code}', 'S=${scripts} R=${runtime} G=${game}: ' .. tostring(build.code))
      assert(build.state == '${code === 'ok' ? 'ok' : code === 'unknown' ? 'unknown' : 'problem'}', 'S=${scripts} R=${runtime} G=${game}: ' .. tostring(build.state))
      assert(#check.problems() == ${code === 'ok' || code === 'unknown' ? 0 : 1}, 'problems: ' .. table.concat(check.problems(), ','))
      assert((lineOf('build') ~= nil) == ${code !== 'ok' && code !== 'unknown'}, 'the row exists only for a problem')
    `);
  }
});

test('the Runtime of a service that does not name its game (0.3.1 and older) is read from app/release.json; a release.json without a game is the 2.31 build', () => {
  run(String.raw`
    installFiles(); serviceRunning()
    put('release.json', {product = 'AI-NPC-Cyberpunk-Mod', package = 'scripts', version = '0.3.2', game = '2.5'})
    env.gameVersion = '2.5'; applyEnv()
    -- an older service says 'mismatch' for two versions and names no game
    answer({versions = {id = 'versions', state = 'problem', code = 'mismatch', scripts = '0.3.2', runtime = '0.3.1'}})
    put('runtime/bridge-service.json', {version = 1, state = 'running', code = 'running', updated = ms(), gameRoot = 'G:/Games/Cyberpunk 2077'})
    local runtimeFile = 'G:/Games/Cyberpunk 2077/red4ext/plugins/AiNpcCyberpunkMod/app/release.json'
    put(runtimeFile, {product = 'AI-NPC-Cyberpunk-Mod', package = 'runtime', version = '0.3.1'})
    check.run()
    local build = check.inspect().game.checks.build
    assert(build.code == 'runtime-wrong' and build.detail == 'scripts=2.5 runtime=2.31 game=2.5', tostring(build.detail))
    -- the versions row would send the player to update zips of the wrong game: the build row is the one that shows
    assert(lineOf('versions') == nil and lineOf('build').state == 'problem')
    -- a Runtime that names its game
    put(runtimeFile, {package = 'runtime', version = '0.3.1', game = '2.5'})
    check.run()
    assert(check.inspect().game.checks.build.state == 'ok')
    assert(lineOf('versions').state == 'problem', 'the plain version mismatch keeps its own row')
    -- another package's release.json is not the Runtime's
    put(runtimeFile, {package = 'scripts', version = '0.3.1', game = '2.31'})
    check.run()
    assert(check.inspect().game.checks.build.state == 'ok')
  `);
});

test('with no answer from the service this session nothing is read from the Runtime folder and the build is judged from the Scripts and the game alone', () => run(String.raw`
  installFiles(); serviceRunning()
  put('release.json', {package = 'scripts', version = '0.3.2', game = '2.5'})
  put('runtime/bridge-service.json', {version = 1, state = 'running', code = 'running', updated = ms(), gameRoot = 'G:/Games/Cyberpunk 2077'})
  put('G:/Games/Cyberpunk 2077/red4ext/plugins/AiNpcCyberpunkMod/app/release.json', {package = 'runtime', version = '0.3.1'})
  env.gameVersion = '2.5'; applyEnv()
  check.run()
  for _, path in ipairs(opened) do assert(not path:find('app/release.json', 1, true), path) end
  assert(check.inspect().game.checks.build.state == 'ok')
  env.gameVersion = '2.31'; applyEnv(); check.run()
  assert(check.inspect().game.checks.build.code == 'scripts-wrong')
`));

// The first-load notice: [Scripts game, Runtime game, running game, exact notice]. One short sentence naming what to download.
const NOTICES = [
  ['2.5', '2.31', '2.5', 'The Runtime is for game 2.31, yours is 2.5. Get the Runtime for 2.5 from Hugging Face.'],
  ['2.31', '2.5', '2.31', 'The Runtime is for game 2.5, yours is 2.31. Get the Runtime for 2.31 from Hugging Face.'],
  ['2.5', '2.31', '2.31', 'The Scripts are for game 2.5, yours is 2.31. Get the Scripts for 2.31 from Nexus Mods.'],
  ['2.31', '2.5', '2.5', 'The Scripts are for game 2.31, yours is 2.5. Get the Scripts for 2.5 from Nexus Mods.'],
  ['2.5', '2.5', '2.31', 'This mod is for game 2.5, yours is 2.31. Get the Scripts and Runtime for 2.31.'],
  ['2.31', '2.31', '2.5', 'This mod is for game 2.31, yours is 2.5. Get the Scripts and Runtime for 2.5.'],
  ['2.5', '2.31', '2.51', 'Scripts are for game 2.5, Runtime for 2.31. They must match. See Help in Settings.'],
];

test('the first load names the half to replace in one notice, once, and the console and the report say the cause', () => {
  for (const [scripts, runtime, game, expected] of NOTICES) {
    run(String.raw`
      installFiles(); serviceRunning()
      put('release.json', {product = 'AI-NPC-Cyberpunk-Mod', package = 'scripts', version = '0.3.2', game = '${scripts}'})
      env.gameVersion = '${game}'; applyEnv()
      local noted
      convaiErrorReports = {noteSetup = function(problems, checks) noted = {problems = problems, build = checks.build} end}
      check.tick(true, true)
      assert(check.tick(true, true) == nil, 'nothing for the first twelve seconds')
      advance(12); check.tick(true, true)
      local request = json.decode(files['runtime/setup-check-request.json'])
      answer({versions = {id = 'versions', state = 'problem', code = 'game-mismatch', scripts = '0.3.2', runtime = '0.3.2', scriptsGame = '${scripts}', runtimeGame = '${runtime}'}}, request.id)
      advance(1)
      local notice = check.tick(true, true)
      assert(notice == ${JSON.stringify(expected)}, tostring(notice))
      -- one notice per session
      advance(30); assert(check.tick(true, true) == nil); advance(300); assert(check.tick(true, true) == nil)
      -- the build comes first, and the error report gets the machine-readable cause
      assert(noted.problems[1] == 'build', table.concat(noted.problems, ','))
      assert(noted.build.detail == 'scripts=${scripts} runtime=${runtime} game=${game}', noted.build.detail)
      -- the console and probe.log say it once in English, with the three games
      assert(#console == 1 and console[1]:find('game build mismatch (scripts=${scripts} runtime=${runtime} game=${game})', 1, true), console[1])
      assert(files['runtime/probe.log']:find('Setup check: problems: build', 1, true))
      -- the report lines of the short report
      assert(table.concat(check.reportLines(), '\n'):find('build: problem ', 1, true))
    `);
  }
});

test('the Help page row names both games and where to get the right half, for each combination', () => {
  const cases = [
    ['2.5', '2.31', '2.5', ['Your game is 2.5 but the Runtime is the one for game 2.31.', 'Download the Runtime for game 2.5 from the mod’s Hugging Face page', 'game-2.31 folder']],
    ['2.5', '2.31', '2.31', ['Your game is 2.31 but the Scripts are the build for game 2.5.', 'Download the Scripts for game 2.31 from the mod’s Nexus Mods page', 'optional file']],
    ['2.5', '2.5', '2.31', ['Your game is 2.31 but the Scripts and the Runtime are the build for game 2.5.', 'Download both for game 2.31']],
    ['2.5', '2.31', null, ['The Scripts are the build for game 2.5 but the Runtime is the build for game 2.31, and the game version matches neither.']],
  ];
  for (const [scripts, runtime, game, parts] of cases) {
    run(String.raw`
      installFiles(); serviceRunning()
      put('release.json', {package = 'scripts', version = '0.3.2', game = '${scripts}'})
      env.gameVersion = ${luaValue(game)}; applyEnv()
      answer({versions = {id = 'versions', state = 'ok', code = 'match', scripts = '0.3.2', runtime = '0.3.2', scriptsGame = '${scripts}', runtimeGame = '${runtime}'}})
      check.run()
      local item = lineOf('build')
      assert(item.state == 'problem' and item.value == 'Problem' and item.label == 'Build for your game')
      ${parts.map(part => `assert(item.description:find(${JSON.stringify(part)}, 1, true), item.description)`).join('\n      ')}
      assert(check.problemCount() >= 1)
    `);
  }
});

test('when the three agree nothing is said, and the check adds no file read per tick', () => run(String.raw`
  installFiles(); serviceRunning()
  put('release.json', {package = 'scripts', version = '0.3.2', game = '2.5'})
  env.gameVersion = '2.5'; applyEnv()
  check.tick(true, true); advance(12); check.tick(true, true)
  local request = json.decode(files['runtime/setup-check-request.json'])
  answer({versions = {id = 'versions', state = 'ok', code = 'match', scripts = '0.3.2', runtime = '0.3.2', scriptsGame = '2.5', runtimeGame = '2.5'}}, request.id)
  advance(1)
  assert(check.tick(true, true) == nil and #console == 0)
  assert(lineOf('build') == nil and #check.problems() == 0)
  -- after the first load an idle tick opens no file and asks the game nothing
  local files_, calls = opens(), gameCalls
  for _ = 1, 20 do advance(1); check.tick(true, true) end
  assert(opens() == files_ and gameCalls == calls, 'nothing per tick')
`));
