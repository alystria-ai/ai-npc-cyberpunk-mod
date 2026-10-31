import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdir, mkdtemp, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, relative} from 'node:path';
import {GAME_FOLDERS as PLACE_PACKS_FOLDERS} from '../packaging/runtime/place-packs.mjs';
import {SETUP_CHECK_FILE, SETUP_REQUEST_FILE, SERVICE_HOSTS, SetupCheckControl, cachedBrowserName, cachedGraphicsCards, cachedMemoryFacts, cachedModManagers,
  checkReachable, collectSetupCheck, detectBrowserName, detectGraphicsCards, detectMemoryFacts, detectModManagers, findNestedPacks, GAME_FOLDERS,
  graphicsCardsFrom, localAiCheck, neededServices, parseRegistryValues, parseSetupRequest, readPackPlacement,
  resetSetupCheckCaches, DISK_LOW_BYTES} from './setup-check.mjs';
import {ErrorEvents} from './error-events.mjs';

// Every test works in a temporary folder with fake files, fake registry output, fake DNS and fake sockets. No process is started
// (reg.exe is replaced by an injected function), no connection is made and nothing outside the temporary folder is read or changed.

const CLASS_KEY = 'HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}';
const NAME_OUTPUT = [
  '', `${CLASS_KEY}\\0000`, '    DriverDesc    REG_SZ    Intel(R) UHD Graphics', '',
  `${CLASS_KEY}\\0001`, '    DriverDesc    REG_SZ    NVIDIA GeForce RTX 4080 Laptop GPU', '',
  `${CLASS_KEY}\\0002`, '    DriverDesc    REG_SZ    Microsoft Basic Display Adapter', '',
  `${CLASS_KEY}\\0003`, '    DriverDesc    REG_SZ    Parsec Virtual Display Adapter', '',
  `${CLASS_KEY}\\0003\\Settings`, '    DriverDesc    REG_SZ    Not an adapter', '',
  // A localized tail, as Windows prints it in German.
  'Ende der Suche: 5 Übereinstimmung(en) gefunden.', ''].join('\r\n');
const QWORD_OUTPUT = ['', `${CLASS_KEY}\\0001`, '    HardwareInformation.qwMemorySize    REG_QWORD    0x2ff000000', '',
  'Ende der Suche: 1 Übereinstimmung(en) gefunden.', ''].join('\r\n');
const SIZE_OUTPUT = ['', `${CLASS_KEY}\\0000`, '    HardwareInformation.MemorySize    REG_BINARY    0000008000000000', '',
  `${CLASS_KEY}\\0001`, '    HardwareInformation.MemorySize    REG_DWORD    0xffffffff', '', 'Ende der Suche: 2 Übereinstimmung(en) gefunden.', ''].join('\r\n');

const registry = outputs => {
  const calls = [];
  const run = async (file, args, options) => {
    calls.push({file, args, options});
    const output = outputs[args.at(-1)];
    if (output instanceof Error) throw output;
    return {stdout: output ?? '', stderr: ''};
  };
  return {run, calls};
};

test('registry output is parsed by key, with the type and the text as printed', () => {
  const keys = parseRegistryValues(NAME_OUTPUT);
  assert.deepEqual([...keys.keys()].map(key => key.slice(key.lastIndexOf('\\') + 1)), ['0000', '0001', '0002', '0003', 'Settings']);
  assert.deepEqual(keys.get(`${CLASS_KEY}\\0001`), {DriverDesc: {type: 'REG_SZ', data: 'NVIDIA GeForce RTX 4080 Laptop GPU'}});
  assert.deepEqual(parseRegistryValues(QWORD_OUTPUT).get(`${CLASS_KEY}\\0001`), {'HardwareInformation.qwMemorySize': {type: 'REG_QWORD', data: '0x2ff000000'}});
  assert.equal(parseRegistryValues('').size, 0);
  assert.equal(parseRegistryValues(undefined).size, 0);
  assert.equal(parseRegistryValues('ERROR: The system was unable to find the specified registry key or value.\r\n').size, 0);
  // A value name with a space, an empty string value and a value before any key header.
  const odd = parseRegistryValues('    Orphan    REG_SZ    x\r\nHKEY_LOCAL_MACHINE\\A\\0000\r\n    Driver Date    REG_SZ    10-1-2026\r\n    DriverDesc    REG_SZ    \r\n');
  assert.deepEqual(odd.get('HKEY_LOCAL_MACHINE\\A\\0000'), {'Driver Date': {type: 'REG_SZ', data: '10-1-2026'}, DriverDesc: {type: 'REG_SZ', data: ''}});
});

test('graphics cards: several adapters, the 64-bit size first and the 32-bit size as the fallback, largest card first, basic adapters excluded', async () => {
  const {run, calls} = registry({DriverDesc: NAME_OUTPUT, 'HardwareInformation.qwMemorySize': QWORD_OUTPUT, 'HardwareInformation.MemorySize': SIZE_OUTPUT});
  const cards = await detectGraphicsCards({run, platform: 'win32', env: {SystemRoot: 'C:\\Windows'}});
  assert.deepEqual(cards, [
    {name: 'NVIDIA GeForce RTX 4080 Laptop GPU', memoryMiB: Number(0x2ff000000n / 1048576n)},   // the QWORD, not the 4 GiB DWORD
    {name: 'Intel(R) UHD Graphics', memoryMiB: 2048},                                           // little-endian REG_BINARY: 0x80000000
    {name: 'Parsec Virtual Display Adapter', memoryMiB: null},                                  // unknown memory sorts last
  ]);
  assert.equal(cards[0].memoryMiB, 12272);
  assert.equal(calls.length, 3, 'three queries, no more');
  assert.deepEqual(calls.map(call => call.args), ['DriverDesc', 'HardwareInformation.qwMemorySize', 'HardwareInformation.MemorySize']
    .map(value => ['query', 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}', '/s', '/v', value]));
  for (const call of calls) {
    assert.equal(call.file, 'C:\\Windows\\System32\\reg.exe');
    assert.equal(call.options.timeout, 5000); assert.equal(call.options.windowsHide, true);
  }
});

test('graphics cards: the 32-bit size alone, a dword, basic adapters only, nothing registered, a failing or hanging reg.exe, and not Windows', async () => {
  const dwordOnly = ['', `${CLASS_KEY}\\0000`, '    HardwareInformation.MemorySize    REG_DWORD    0x40000000', ''].join('\r\n');
  const one = ['', `${CLASS_KEY}\\0000`, '    DriverDesc    REG_SZ    AMD Radeon(TM) Graphics', ''].join('\r\n');
  const {run} = registry({DriverDesc: one, 'HardwareInformation.MemorySize': dwordOnly});
  assert.deepEqual(await detectGraphicsCards({run, platform: 'win32'}), [{name: 'AMD Radeon(TM) Graphics', memoryMiB: 1024}]);
  // Only basic adapters: they are better than nothing.
  const basic = ['', `${CLASS_KEY}\\0000`, '    DriverDesc    REG_SZ    Microsoft Basic Display Adapter', '', `${CLASS_KEY}\\0001`,
    '    DriverDesc    REG_SZ    Microsoft Remote Display Adapter', ''].join('\r\n');
  assert.deepEqual((await detectGraphicsCards({run: registry({DriverDesc: basic}).run, platform: 'win32'})).map(card => card.name),
    ['Microsoft Basic Display Adapter', 'Microsoft Remote Display Adapter']);
  assert.deepEqual(await detectGraphicsCards({run: registry({}).run, platform: 'win32'}), []);
  // reg.exe exits 1 when no key has a value: the output printed before is still read, and any other failure is an empty list.
  const partial = Object.assign(Error('exit 1'), {code: 1, stdout: NAME_OUTPUT});
  assert.equal((await detectGraphicsCards({run: registry({DriverDesc: partial, 'HardwareInformation.qwMemorySize': partial,
    'HardwareInformation.MemorySize': partial}).run, platform: 'win32'})).length, 3);
  const timedOut = Object.assign(Error('timed out'), {killed: true, signal: 'SIGTERM'});
  assert.deepEqual(await detectGraphicsCards({run: registry({DriverDesc: timedOut, 'HardwareInformation.qwMemorySize': timedOut,
    'HardwareInformation.MemorySize': timedOut}).run, platform: 'win32'}), []);
  assert.deepEqual(await detectGraphicsCards({run: async () => { throw TypeError('x'); }, platform: 'win32'}), []);
  assert.deepEqual(await detectGraphicsCards({run: async () => ({}), platform: 'win32'}), []);
  let called = 0;
  assert.deepEqual(await detectGraphicsCards({run: async () => { called++; return {stdout: NAME_OUTPUT}; }, platform: 'linux'}), []);
  assert.equal(called, 0, 'nothing is started off Windows');
  // The pure part: duplicates collapse, and a long or control-character name is cleaned.
  const twice = parseRegistryValues(`${CLASS_KEY}\\0000\r\n    DriverDesc    REG_SZ    A\r\n${CLASS_KEY}\\0001\r\n    DriverDesc    REG_SZ    A\r\n`);
  assert.equal(graphicsCardsFrom(twice, new Map(), new Map()).length, 1);
});

test('the graphics cards, the browser name and the mod managers are looked up once per process', async () => {
  resetSetupCheckCaches();
  try {
    const {run, calls} = registry({DriverDesc: NAME_OUTPUT});
    const first = await cachedGraphicsCards({run, platform: 'win32'});
    const second = await cachedGraphicsCards({run: async () => { throw Error('asked again'); }, platform: 'win32'});
    assert.equal(calls.length, 3); assert.equal(first, second);
    let browserLookups = 0;
    const candidates = function* () { browserLookups++; yield {name: 'Brave', executablePath: 'C:\\Brave\\brave.exe'}; };
    assert.equal(cachedBrowserName({env: {}, candidates}), 'Brave');
    assert.equal(cachedBrowserName({env: {}, candidates}), 'Brave');
    assert.equal(browserLookups, 1);
    const managers = cachedModManagers({sharedObjects: ['C:\\x\\usvfs_x64.dll']});
    assert.equal(managers, cachedModManagers({sharedObjects: []}));
    assert.deepEqual(await managers, {managers: ['mo2']});
  } finally { resetSetupCheckCaches(); }
});

test('the memory facts of a report: total RAM from Node, the commit limit from one PowerShell read, read once per process, null where they cannot be read', async () => {
  const calls = [];
  const run = async (file, args, options) => { calls.push({file, args, options}); return {stdout: '41943040\r\n'}; };
  const facts = await detectMemoryFacts({run, platform: 'win32', env: {SystemRoot: 'C:\\Windows'}, ramBytes: 32 * 1024 ** 3});
  assert.deepEqual(facts, {totalRamMiB: 32768, commitLimitMiB: 40960});
  assert.equal(calls.length, 1); assert.match(calls[0].file, /powershell\.exe$/i); assert.ok(calls[0].args.join(' ').includes('TotalVirtualMemorySize'));
  assert.equal(calls[0].options.windowsHide, true); assert.ok(calls[0].options.timeout <= 10_000);
  // A read that fails, prints nothing usable, or runs off Windows keeps the RAM and leaves the commit limit unknown; nothing throws.
  assert.deepEqual(await detectMemoryFacts({run: async () => { throw Error('no powershell'); }, platform: 'win32', ramBytes: 8 * 1024 ** 3}), {totalRamMiB: 8192, commitLimitMiB: null});
  assert.deepEqual(await detectMemoryFacts({run: async () => ({stdout: 'garbage'}), platform: 'win32', ramBytes: 8 * 1024 ** 3}), {totalRamMiB: 8192, commitLimitMiB: null});
  assert.deepEqual(await detectMemoryFacts({run, platform: 'linux', ramBytes: 4 * 1024 ** 3}), {totalRamMiB: 4096, commitLimitMiB: null});
  assert.equal(calls.length, 1, 'no process off Windows');
  assert.deepEqual(await detectMemoryFacts({run, platform: 'linux', ramBytes: () => { throw Error('os'); }}), {totalRamMiB: null, commitLimitMiB: null});
  resetSetupCheckCaches();
  try {
    const first = cachedMemoryFacts({run, platform: 'win32', ramBytes: 16 * 1024 ** 3});
    const second = cachedMemoryFacts({run: async () => { throw Error('asked again'); }, platform: 'win32'});
    assert.equal(first, second); assert.equal(calls.length, 2); assert.deepEqual(await first, {totalRamMiB: 16384, commitLimitMiB: 40960});
  } finally { resetSetupCheckCaches(); }
});

test('the browser: the first installed one, a developer override, or none', () => {
  const empty = function* () {};
  assert.equal(detectBrowserName({env: {}, candidates: empty}), null);
  assert.equal(detectBrowserName({env: {CYBERPUNK_CONVAI_BROWSER: 'C:\\x\\browser.exe'}, candidates: empty}), 'Configured browser');
  assert.equal(detectBrowserName({env: {}, candidates: function* () { yield {name: 'Microsoft Edge', channel: 'msedge'}; throw Error('never reached'); }}), 'Microsoft Edge');
});

async function temp(work) {
  const root = await mkdtemp(join(tmpdir(), 'setup-check-'));
  try { return await work(root); } finally { await rm(root, {recursive: true, force: true}); }
}
const put = async (path, text = '{}') => { await mkdir(join(path, '..'), {recursive: true}); await writeFile(path, text); };
async function files(root, base = root) {
  const found = [];
  for (const entry of await readdir(root, {withFileTypes: true})) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) found.push(...await files(path, base)); else found.push(relative(base, path));
  }
  return found.sort();
}

test('mod managers: the usvfs library in this process means Mod Organizer 2, a deployment file in the game folder means Vortex', async () => {
  assert.deepEqual(await detectModManagers({game: 'G', sharedObjects: ['C:\\Windows\\System32\\ntdll.dll'], readdir: async () => ['bin']}), {managers: []});
  for (const library of ['C:\\Mods\\MO2\\usvfs_x64.dll', 'D:\\USVFS_X64.DLL', 'C:\\Mods\\usvfs_x86.dll', '/opt/mo2/usvfs_x64.dll']) {
    assert.deepEqual(await detectModManagers({game: 'G', sharedObjects: [library], readdir: async () => []}), {managers: ['mo2']}, library);
  }
  assert.deepEqual(await detectModManagers({game: 'G', sharedObjects: ['C:\\x\\usvfs_x64.dll.bak', 'C:\\usvfs\\other.dll'], readdir: async () => []}), {managers: []});
  for (const name of ['vortex.deployment.json', 'vortex.deployment.cyberpunk2077.json', 'Vortex.Deployment.JSON']) {
    assert.deepEqual(await detectModManagers({game: 'G', sharedObjects: [], readdir: async () => ['archive', name]}), {managers: ['vortex']}, name);
  }
  for (const name of ['vortex.deployment.txt', 'vortex.deployment.json.bak', 'myvortex.deployment.json']) {
    assert.deepEqual(await detectModManagers({game: 'G', sharedObjects: [], readdir: async () => [name]}), {managers: []}, name);
  }
  assert.deepEqual(await detectModManagers({game: 'G', sharedObjects: ['C:\\usvfs_x64.dll'], readdir: async () => ['vortex.deployment.json']}), {managers: ['mo2', 'vortex']});
  // Never throws: a folder that cannot be listed, a bad library list.
  assert.deepEqual(await detectModManagers({game: 'G', sharedObjects: [], readdir: async () => { throw Object.assign(Error('no'), {code: 'EPERM'}); }}), {managers: []});
  assert.deepEqual(await detectModManagers({game: 'G', sharedObjects: 'not a list', readdir: async () => []}), {managers: []});
  assert.deepEqual(await detectModManagers({sharedObjects: []}), {managers: []});
  await temp(async root => {
    await put(join(root, 'vortex.deployment.json'));
    assert.deepEqual(await detectModManagers({game: root, sharedObjects: []}), {managers: ['vortex']});
    assert.deepEqual(await detectModManagers({game: join(root, 'missing'), sharedObjects: []}), {managers: []});
    assert((await detectModManagers({game: root})).managers.every(name => name === 'mo2' || name === 'vortex'), 'the real process report is readable');
  });
});

const PLUGIN = ['red4ext', 'plugins', 'AiNpcCyberpunkMod'], MOD = ['bin', 'x64', 'plugins', 'cyber_engine_tweaks', 'mods', 'AiNpcCyberpunkMod'];
const inner = (...parts) => [...PLUGIN, 'app', ...parts];

test('nested packs: wrapper folders in the game folder, the mod folder and the plugin folder are found; the real installation never is', async () => {
  await temp(async root => {
    const game = join(root, 'Cyberpunk 2077'), plugin = join(game, ...PLUGIN), modRoot = join(game, ...MOD);
    // The real installation, with every pack in place.
    await put(join(plugin, 'app', 'local-ai', 'manifest.standard.json'));
    await put(join(plugin, 'app', 'omni', 'omni-pack.json'));
    await put(join(plugin, 'app', 'launcher', 'start-service.mjs'), '//');
    // The game's own folders, which hold look-alike trees that are not searched.
    await put(join(game, 'bin', 'x64', 'Cyberpunk2077.exe'), 'exe');
    await put(join(game, 'archive', 'pc', 'mod', 'x.archive'), 'a');
    await put(join(game, 'tools', ...inner('omni', 'omni-pack.json')));
    // 1. A wrapper named after the zip, one level in; the same one level deeper (X/X); a wrapper with no pack in it; a folder that is not a wrapper.
    await put(join(game, 'LocalAI-Standard', ...inner('local-ai', 'manifest.standard.json')));
    await put(join(game, 'Downloads', 'AI-NPC-OmniVoice-0.2', ...inner('omni', 'omni-pack.json')));
    await put(join(game, 'Empty-0.2', ...inner('readme.txt')), 'text');
    await put(join(game, 'Notes', 'readme.txt'), 'text');
    // 2. The mod folder: the whole tree, and just the app folder.
    await put(join(modRoot, 'app', 'local-ai', 'manifest.lite.json'));
    await put(join(modRoot, ...inner('local-ai', 'manifest.mature-standard.json')));
    // 3. The plugin folder: one wrapper folder inside it, holding an unnamed Mature pack and a custom manifest.
    await put(join(plugin, 'Mature-0.2', ...inner('local-ai', 'mature', 'model.gguf')), 'weights');
    await put(join(plugin, 'Mature-0.2', ...inner('local-ai', 'manifest.custom.json')));
    await put(join(plugin, 'voices', 'judy.wav'), 'wav');
    const before = await files(root);

    const found = await findNestedPacks({game, modRoot, plugin});
    const folder = (...parts) => relative(game, join(game, ...parts));
    assert.deepEqual(found.map(row => `${row.pack} @ ${row.folder}`).sort(), [
      `Local AI @ ${folder(...PLUGIN, 'Mature-0.2')}`,
      `Local AI lite @ ${folder(...MOD)}`,
      `Local AI standard @ LocalAI-Standard`,
      `Mature @ ${folder(...PLUGIN, 'Mature-0.2')}`,
      `Mature standard @ ${folder(...MOD)}`,
      `OmniVoice @ ${folder('Downloads', 'AI-NPC-OmniVoice-0.2')}`,
    ].sort());
    assert(found.every(row => !row.folder.startsWith(root) && row.folder !== '.'), 'folders are relative to the game folder');
    assert(!found.some(row => row.folder === folder(...PLUGIN)), 'the real installation is not reported');
    assert.deepEqual(await files(root), before, 'detect only: nothing is moved, created or deleted');
    // The same install with the defaults for the mod and plugin folders.
    assert.deepEqual(await findNestedPacks({game}), found);
  });
});

test('nested packs: a game without wrappers, a missing game folder and a failing listing give an empty list and never throw', async () => {
  await temp(async root => {
    const game = join(root, 'game');
    await put(join(game, ...PLUGIN, 'app', 'local-ai', 'manifest.standard.json'));
    await put(join(game, 'r6', 'scripts', 'a.reds'), 'x');
    assert.deepEqual(await findNestedPacks({game}), []);
    assert.deepEqual(await findNestedPacks({game: join(root, 'missing')}), []);
    assert.deepEqual(await findNestedPacks({}), []);
    assert.deepEqual(await findNestedPacks({game, fs: {readdir: async () => { throw Error('denied'); }, lstat: async () => { throw Error('denied'); }}}), []);
    // The folder in the report is '.' only for a candidate that is the game folder itself, which never happens.
    assert.equal(PLACE_PACKS_FOLDERS.size, GAME_FOLDERS.size);
    assert.deepEqual([...GAME_FOLDERS].sort(), [...PLACE_PACKS_FOLDERS].sort(), 'the folders skipped are the launcher\'s');
  });
});

function connector(behave) {
  const calls = [], sockets = [];
  const connect = options => {
    calls.push(options);
    const socket = Object.assign(new EventEmitter(), {destroyed: 0, destroy() { this.destroyed++; }});
    sockets.push(socket);
    setImmediate(() => behave(socket, options));
    return socket;
  };
  return {connect, calls, sockets};
}
const resolves = async () => ({address: '203.0.113.7', family: 4});
const fails = code => async () => { throw Object.assign(Error(code), {code}); };

test('reachability: a name that does not resolve, a refused connection, silence and a connection that works', async () => {
  for (const code of ['ENOTFOUND', 'EAI_AGAIN', 'ESERVFAIL']) {
    const net = connector(() => assert.fail('no connection after a failed lookup'));
    assert.equal(await checkReachable('api.convai.com', {lookup: fails(code), connect: net.connect}), 'no-dns', code);
    assert.equal(net.calls.length, 0);
  }
  assert.equal(await checkReachable('x', {lookup: () => new Promise(() => {}), connect: () => assert.fail('no connection'), timeoutMs: 20}), 'no-dns', 'a resolver that never answers');
  assert.equal(await checkReachable('x', {lookup: () => { throw TypeError('boom'); }, connect: () => assert.fail('no connection')}), 'no-dns');

  for (const code of ['ECONNREFUSED', 'ECONNRESET', 'EACCES', 'EPERM']) {
    const net = connector(socket => socket.emit('error', Object.assign(Error(code), {code})));
    assert.equal(await checkReachable('api.mistral.ai', {lookup: resolves, connect: net.connect}), 'blocked', code);
    assert.equal(net.sockets[0].destroyed, 1);
  }
  const aggregate = connector(socket => socket.emit('error', Object.assign(new AggregateError([
    Object.assign(Error('v6'), {code: 'ENETUNREACH'}), Object.assign(Error('v4'), {code: 'ECONNREFUSED'})], 'all failed'), {code: undefined})));
  assert.equal(await checkReachable('api.mistral.ai', {lookup: resolves, connect: aggregate.connect}), 'blocked', 'one refused address among unreachable ones');
  const unreachable = connector(socket => socket.emit('error', Object.assign(Error('no route'), {code: 'ENETUNREACH'})));
  assert.equal(await checkReachable('x', {lookup: resolves, connect: unreachable.connect}), 'timeout', 'no route is no answer');
  const timedOut = connector(socket => socket.emit('error', Object.assign(Error('timed out'), {code: 'ETIMEDOUT'})));
  assert.equal(await checkReachable('x', {lookup: resolves, connect: timedOut.connect}), 'timeout');

  const silent = connector(() => {});
  assert.equal(await checkReachable('x', {lookup: resolves, connect: silent.connect, timeoutMs: 20}), 'timeout');
  assert.equal(silent.sockets[0].destroyed, 1, 'the socket is closed when nothing answers');

  const open = connector(socket => socket.emit('connect'));
  assert.equal(await checkReachable('api.convai.com', {lookup: resolves, connect: open.connect}), 'reachable');
  assert.deepEqual(open.calls, [{host: 'api.convai.com', port: 443}]);
  assert.equal(open.sockets[0].destroyed, 1, 'closed at once');
  open.sockets[0].emit('error', Object.assign(Error('late'), {code: 'ECONNRESET'}));   // a late event is not an unhandled error
  const other = connector(socket => socket.emit('connect'));
  await checkReachable('x', {port: 8443, lookup: resolves, connect: other.connect});
  assert.equal(other.calls[0].port, 8443);
  assert.equal(await checkReachable('x', {lookup: resolves, connect: () => { throw Object.assign(Error('denied'), {code: 'EACCES'}); }}), 'blocked');
  assert.equal(await checkReachable('x', {lookup: resolves, connect: () => { throw Error('odd'); }}), 'timeout');
  assert.deepEqual(Object.keys(SERVICE_HOSTS), ['convai', 'mistral', 'gemini', 'inworld']);
  assert.deepEqual(Object.values(SERVICE_HOSTS), ['api.convai.com', 'api.mistral.ai', 'generativelanguage.googleapis.com', 'api.inworld.ai']);
});

// ---------------------------------------------------------------- the document

async function install(root, {scripts = '0.2.0', runtime = '0.2.0', pocket = true, packageVersion = null, scriptsGame, runtimeGame} = {}) {
  const game = join(root, 'game'), modRoot = join(game, ...MOD), project = join(root, 'app'), stateDirectory = join(root, 'state');
  await mkdir(modRoot, {recursive: true}); await mkdir(project, {recursive: true}); await mkdir(stateDirectory, {recursive: true});
  if (scripts !== null) await put(join(modRoot, 'release.json'), JSON.stringify({product: 'ai-npc', package: 'scripts', version: scripts, ...(scriptsGame === undefined ? {} : {game: scriptsGame}), commit: 'abc123'}));
  if (runtime !== null) await put(join(project, 'release.json'), JSON.stringify({product: 'ai-npc', package: 'runtime', version: runtime, ...(runtimeGame === undefined ? {} : {game: runtimeGame}), commit: 'abc123'}));
  if (packageVersion !== null) await put(join(project, 'package.json'), JSON.stringify({name: 'x', version: packageVersion}));
  if (pocket) await mkdir(join(project, 'pocket-tts'), {recursive: true});
  return {game, modRoot, project, stateDirectory};
}
const quietLocalAi = {status: 'ready', reason: null, packInstalled: false, tiers: {standard: null, lite: null}, matureOnly: false, ownServer: false, models: []};
const options = (paths, over = {}) => ({...paths, now: () => 1_800_000_000_000, settings: {}, localAi: () => quietLocalAi,
  omniPack: () => ({installed: false, missing: ['model', 'adapter']}), browser: () => 'Microsoft Edge',
  graphics: async () => [{name: 'NVIDIA GeForce RTX 4070 Laptop GPU', memoryMiB: 8188}, {name: 'Intel(R) UHD Graphics', memoryMiB: 128}],
  modManagers: () => ({managers: []}), reach: async () => 'reachable', nestedPacks: async () => [], placement: async () => null,
  freeSpace: async () => 50 * 1024 ** 3, python: async () => ({state: 'ok', layout: 'lib', missing: [], missingCount: 0}), ...over});
const byId = document => Object.fromEntries(document.checks.map(check => [check.id, check]));
const KEYS = {
  versions: ['id', 'state', 'code', 'scripts', 'runtime', 'scriptsGame', 'runtimeGame'], packs: ['id', 'state', 'code', 'found', 'nested', 'moved', 'omniMissing'],
  browser: ['id', 'state', 'code', 'name'], 'local-ai': ['id', 'state', 'code', 'selected', 'installed'],
  internet: ['id', 'state', 'code', 'service', 'host'], gpu: ['id', 'state', 'code', 'name', 'memoryMiB', 'adapters'],
  'mod-manager': ['id', 'state', 'code', 'managers'], compiler: ['id', 'state', 'code'], disk: ['id', 'state', 'code', 'drive', 'freeGiB'], python: ['id', 'state', 'code', 'layout', 'missing', 'missingCount'],
};

test('the document has exactly the agreed shape: ten checks in order, each with its own fields', async () => temp(async root => {
  const document = await collectSetupCheck(options(await install(root), {request: 'r-1'}));
  assert.deepEqual(Object.keys(document), ['version', 'updated', 'bridgePid', 'request', 'checks']);
  assert.equal(document.version, 1); assert.equal(document.updated, 1_800_000_000_000);
  assert.equal(document.bridgePid, process.pid); assert.equal(document.request, 'r-1');
  assert.deepEqual(document.checks.map(check => check.id), ['versions', 'packs', 'browser', 'local-ai', 'internet', 'gpu', 'mod-manager', 'compiler', 'disk', 'python']);
  for (const check of document.checks) assert.deepEqual(Object.keys(check), KEYS[check.id], check.id);
  assert.deepEqual(byId(document).versions, {id: 'versions', state: 'ok', code: 'match', scripts: '0.2.0', runtime: '0.2.0', scriptsGame: '2.31', runtimeGame: '2.31'});
  assert.deepEqual(byId(document).browser, {id: 'browser', state: 'ok', code: 'found', name: 'Microsoft Edge'});
  assert.deepEqual(byId(document).python, {id: 'python', state: 'ok', code: 'ok', layout: 'lib', missing: [], missingCount: 0});
  assert.deepEqual(byId(document).gpu, {id: 'gpu', state: 'ok', code: 'found', name: 'NVIDIA GeForce RTX 4070 Laptop GPU', memoryMiB: 8188,
    adapters: [{name: 'NVIDIA GeForce RTX 4070 Laptop GPU', memoryMiB: 8188}, {name: 'Intel(R) UHD Graphics', memoryMiB: 128}]});
  assert.deepEqual(byId(document)['mod-manager'], {id: 'mod-manager', state: 'ok', code: 'none', managers: []});
  assert.deepEqual(byId(document)['local-ai'], {id: 'local-ai', state: 'ok', code: 'not-used', selected: false, installed: false});
  assert.deepEqual(byId(document).internet, {id: 'internet', state: 'ok', code: 'reachable', service: 'convai', host: 'api.convai.com'});
  assert.equal(JSON.parse(JSON.stringify(document)).checks.length, 10, 'plain JSON');
  assert.equal((await collectSetupCheck(options(await install(root), {request: '../../etc'}))).request, null, 'only a well-formed id is echoed');
  assert.equal((await collectSetupCheck(options(await install(root)))).request, null);
}));

test('internet: the services the chosen providers need, each tested once, the first one that fails is the answer', async () => temp(async root => {
  const paths = await install(root);
  const seen = [];
  const reach = results => async host => { seen.push(host); return results[host] ?? 'reachable'; };
  const run = async (settings, results = {}) => { seen.length = 0; return byId(await collectSetupCheck(options(paths, {settings, reach: reach(results)}))).internet; };

  // Convai by default, with no internet: each failure code is the answer.
  for (const code of ['no-dns', 'blocked', 'timeout']) {
    assert.deepEqual(await run({}, {'api.convai.com': code}), {id: 'internet', state: 'problem', code, service: 'convai', host: 'api.convai.com'});
  }
  assert.deepEqual(seen, ['api.convai.com']);
  assert.equal((await run({conversationProvider: 'groq'})).service, 'convai', 'an unknown provider is Convai, as the bridge reads it');
  // Mistral for the text and for the Voxtral voice: one host, one test.
  assert.deepEqual(await run({conversationProvider: 'mistral', voiceProvider: 'voxtral'}), {id: 'internet', state: 'ok', code: 'reachable', service: 'mistral', host: 'api.mistral.ai'});
  assert.deepEqual(seen, ['api.mistral.ai']);
  // Convai text with the Convai voice: one host. Convai text with the Voxtral voice: two, conversation first, the failing one is named.
  await run({voiceProvider: 'convai'}); assert.deepEqual(seen, ['api.convai.com']);
  assert.deepEqual(await run({voiceProvider: 'voxtral'}, {'api.mistral.ai': 'blocked'}), {id: 'internet', state: 'problem', code: 'blocked', service: 'mistral', host: 'api.mistral.ai'});
  assert.deepEqual(seen, ['api.convai.com', 'api.mistral.ai']);
  assert.equal((await run({voiceProvider: 'voxtral'}, {'api.convai.com': 'no-dns', 'api.mistral.ai': 'timeout'})).service, 'convai', 'the first that fails, in order');
  assert.deepEqual(await run({conversationProvider: 'mistral', voiceProvider: 'voxtral'}, {'api.mistral.ai': 'no-dns'}),
    {id: 'internet', state: 'problem', code: 'no-dns', service: 'mistral', host: 'api.mistral.ai'});
  // Nothing needed: the local AI with a local voice (the Convai voice is not available without Convai, so the bridge uses Pocket instead).
  for (const settings of [{conversationProvider: 'local'}, {conversationProvider: 'local', voiceProvider: 'omni'}, {conversationProvider: 'local', voiceProvider: 'convai'}]) {
    assert.deepEqual(await run(settings), {id: 'internet', state: 'ok', code: 'not-needed', service: null, host: null}, JSON.stringify(settings));
    assert.deepEqual(seen, []);
  }
  assert.deepEqual(neededServices({conversationProvider: 'mistral', voiceProvider: 'convai'}), ['mistral']);
  // A test that throws or answers with something unexpected is 'unknown', never a problem.
  const odd = byId(await collectSetupCheck(options(paths, {reach: async () => { throw Error('x'); }}))).internet;
  assert.deepEqual(odd, {id: 'internet', state: 'unknown', code: 'unknown', service: 'convai', host: 'api.convai.com'});
}));

test('local AI: not used, ready, warming, and every way it can be unavailable', async () => temp(async root => {
  const paths = await install(root);
  const check = async (settings, info) => byId(await collectSetupCheck(options(paths, {settings, localAi: () => ({...quietLocalAi, ...info})}))) ['local-ai'];
  const selected = {conversationProvider: 'local'};
  const installed = {packInstalled: true, tiers: {standard: {file: 'a'}, lite: null}};

  // Not selected: fine, whatever the install holds.
  assert.deepEqual(await check({}, installed), {id: 'local-ai', state: 'ok', code: 'not-used', selected: false, installed: true});
  assert.deepEqual(await check({conversationProvider: 'mistral'}, {status: 'failed'}), {id: 'local-ai', state: 'ok', code: 'not-used', selected: false, installed: false});
  // Selected and working.
  assert.deepEqual(await check(selected, {...installed, status: 'ready'}), {id: 'local-ai', state: 'ok', code: 'ready', selected: true, installed: true});
  assert.deepEqual(await check(selected, {...installed, status: 'warming'}), {id: 'local-ai', state: 'ok', code: 'warming', selected: true, installed: true});
  // Selected and not installed: no pack and no server of the player's own.
  assert.deepEqual(await check(selected, {status: 'not-installed'}), {id: 'local-ai', state: 'problem', code: 'not-installed', selected: true, installed: false});
  assert.equal((await check(selected, {status: 'ready'})).code, 'not-installed');
  assert.deepEqual(await check(selected, {status: 'ready', ownServer: true}), {id: 'local-ai', state: 'ok', code: 'ready', selected: true, installed: true}, 'a server of the player\'s own');
  // Failures.
  assert.equal((await check(selected, {...installed, status: 'no-memory', reason: 'low-memory'})).code, 'no-memory');
  assert.equal((await check(selected, {...installed, status: 'failed', reason: 'low-memory'})).code, 'no-memory');
  assert.equal((await check(selected, {...installed, status: 'failed', reason: 'no-gpu'})).code, 'no-gpu');
  assert.equal((await check(selected, {...installed, status: 'failed', reason: 'start-failed'})).code, 'start-failed');
  // A server the player runs that is down, blocked or wrongly set up: still a problem row (the Help page shows it), marked so no error report is filed for it (2026-10-22 report ee4689b6).
  assert.deepEqual(await check(selected, {...installed, status: 'failed', reason: 'start-failed', playerServer: true}), {id: 'local-ai', state: 'problem', code: 'start-failed', selected: true, installed: true, playerServer: true});
  assert.equal('playerServer' in await check(selected, {...installed, status: 'failed', reason: 'start-failed'}), false, 'our own failed start is not marked');
  assert.equal('playerServer' in await check(selected, {...installed, status: 'failed', reason: 'crashed', playerServer: true}), false, 'only a start that failed');
  assert.equal((await check(selected, {...installed, status: 'failed', reason: 'crashed'})).code, 'crashed');
  assert.equal((await check(selected, {...installed, status: 'failed', reason: 'stopped'})).code, 'failed');
  assert.equal((await check(selected, {...installed, status: 'failed'})).code, 'failed');
  for (const code of ['no-memory', 'no-gpu', 'start-failed', 'crashed', 'failed']) {
    assert.equal(localAiCheck(selected, {...installed, status: code === 'no-memory' ? 'no-memory' : 'failed', reason: {'no-memory': 'low-memory', 'no-gpu': 'no-gpu',
      'start-failed': 'start-failed', crashed: 'crashed', failed: 'x'}[code]}).state, 'problem', code);
  }
  // Windows would not run the model server: the check names the cause (and only for a failed start).
  const failedStart = {...installed, status: 'failed', reason: 'start-failed'};
  assert.equal(localAiCheck(selected, {...failedStart, blocked: true}).cause, 'blocked');
  assert.equal(localAiCheck(selected, failedStart).cause, undefined);
  // Not enough free system memory for the part that runs on the processor: the Help row names what helps (0.4.0 reports 014a3be6 and 316c6d2b).
  assert.equal(localAiCheck(selected, {...failedStart, lowRam: true}).cause, 'low-ram');
  assert.equal(localAiCheck(selected, {...failedStart, lowRam: true, blocked: true}).cause, 'blocked', 'a blocked file is the cause to name');
  assert.equal(localAiCheck(selected, {...installed, status: 'failed', reason: 'crashed', lowRam: true}).cause, undefined);
  assert.equal(localAiCheck(selected, {...installed, status: 'failed', reason: 'crashed', blocked: true}).cause, undefined);
  // Mature-only install with Mature content off: blocked before any start is tried (the server still reads 'stopped', so the status says 'ready').
  const matureOnly = {packInstalled: true, tiers: {standard: null, lite: null}, matureOnly: true, models: [{tier: 'good', name: 'M', file: 'm.gguf', present: true}], status: 'ready'};
  assert.deepEqual(await check(selected, matureOnly), {id: 'local-ai', state: 'problem', code: 'mature-off', selected: true, installed: true});
  assert.equal((await check({...selected, matureContent: false}, matureOnly)).code, 'mature-off');
  assert.equal((await check({...selected, matureContent: 'yes'}, matureOnly)).code, 'mature-off', 'only true turns it on');
  assert.equal((await check({...selected, matureContent: true}, matureOnly)).code, 'ready');
  assert.equal((await check(selected, {...matureOnly, ownServer: true})).code, 'ready');
  assert.equal((await check({...selected, matureContent: true}, {...installed, status: 'failed', reason: 'mature-off'})).code, 'mature-off', 'the server\'s own reason');
  assert.equal((await check(selected, {...installed, matureOnly: false, status: 'ready'})).code, 'ready', 'with a standard model it needs no Mature setting');
}));

test('versions: equal, different, or unknown (a development checkout has no release.json)', async () => {
  await temp(async root => {
    const same = await collectSetupCheck(options(await install(join(root, 'a'))));
    assert.deepEqual(byId(same).versions, {id: 'versions', state: 'ok', code: 'match', scripts: '0.2.0', runtime: '0.2.0', scriptsGame: '2.31', runtimeGame: '2.31'});
    const mismatch = await collectSetupCheck(options(await install(join(root, 'b'), {scripts: '0.2.0', runtime: '0.2.1'})));
    assert.deepEqual(byId(mismatch).versions, {id: 'versions', state: 'problem', code: 'mismatch', scripts: '0.2.0', runtime: '0.2.1', scriptsGame: '2.31', runtimeGame: '2.31'});
    // No Scripts release.json: unknown, with the Runtime version still given.
    const development = await collectSetupCheck(options(await install(join(root, 'c'), {scripts: null, runtime: null, packageVersion: '0.3.0-dev'})));
    assert.deepEqual(byId(development).versions, {id: 'versions', state: 'unknown', code: 'unknown', scripts: null, runtime: '0.3.0-dev', scriptsGame: '2.31', runtimeGame: '2.31'});
    // release.json wins over package.json, and a release.json of the wrong package is not read.
    const both = await install(join(root, 'd'), {scripts: '0.2.0', runtime: '0.2.0', packageVersion: '9.9.9'});
    assert.equal(byId(await collectSetupCheck(options(both))).versions.runtime, '0.2.0');
    await put(join(both.modRoot, 'release.json'), JSON.stringify({package: 'runtime', version: '0.2.0'}));
    assert.equal(byId(await collectSetupCheck(options(both))).versions.scripts, null);
    await put(join(both.modRoot, 'release.json'), '{"version": "0.2');   // half written
    assert.deepEqual(byId(await collectSetupCheck(options(both))).versions, {id: 'versions', state: 'unknown', code: 'unknown', scripts: null, runtime: '0.2.0', scriptsGame: '2.31', runtimeGame: '2.31'});
    const none = await collectSetupCheck(options(await install(join(root, 'e'), {scripts: null, runtime: null})));
    assert.deepEqual(byId(none).versions, {id: 'versions', state: 'unknown', code: 'unknown', scripts: null, runtime: null, scriptsGame: '2.31', runtimeGame: '2.31'});
  });
});

test('versions: the same version built for two games is a problem that names both games; a package with no game field is the 2.31 build', async () => {
  await temp(async root => {
    const both25 = await collectSetupCheck(options(await install(join(root, 'a'), {scriptsGame: '2.5', runtimeGame: '2.5'})));
    assert.deepEqual(byId(both25).versions, {id: 'versions', state: 'ok', code: 'match', scripts: '0.2.0', runtime: '0.2.0', scriptsGame: '2.5', runtimeGame: '2.5'});
    const oldRuntime = await collectSetupCheck(options(await install(join(root, 'b'), {scriptsGame: '2.5'})));
    assert.deepEqual(byId(oldRuntime).versions, {id: 'versions', state: 'problem', code: 'game-mismatch', scripts: '0.2.0', runtime: '0.2.0', scriptsGame: '2.5', runtimeGame: '2.31'});
    const oldScripts = await collectSetupCheck(options(await install(join(root, 'c'), {runtimeGame: '2.5'})));
    assert.deepEqual(byId(oldScripts).versions, {id: 'versions', state: 'problem', code: 'game-mismatch', scripts: '0.2.0', runtime: '0.2.0', scriptsGame: '2.31', runtimeGame: '2.5'});
    const explicit = await collectSetupCheck(options(await install(join(root, 'd'), {scriptsGame: '2.31'})));
    assert.equal(byId(explicit).versions.code, 'match');
    // A game field that is not a version reads as the 2.31 build; the version mismatch still comes first.
    const junk = await collectSetupCheck(options(await install(join(root, 'e'), {scriptsGame: 'banana', runtimeGame: 5})));
    assert.equal(byId(junk).versions.code, 'match');
    const versionFirst = await collectSetupCheck(options(await install(join(root, 'f'), {scripts: '0.2.0', runtime: '0.2.1', scriptsGame: '2.5'})));
    assert.equal(byId(versionFirst).versions.code, 'mismatch');
  });
});

test('packs: what is installed, what is nested, what the launcher moved, and what it could not', async () => temp(async root => {
  const paths = await install(root);
  const all = {tiers: {standard: {file: 's'}, lite: {file: 'l'}}, models: [{tier: 'lite', name: 'a'}, {tier: 'good', name: 'b'}], packInstalled: true};
  const found = byId(await collectSetupCheck(options(paths, {omniPack: () => ({installed: true, missing: []}), localAi: () => ({...quietLocalAi, ...all})}))).packs;
  assert.deepEqual(found, {id: 'packs', state: 'ok', code: 'ok', found: ['Pocket TTS', 'OmniVoice', 'Local AI standard', 'Local AI lite', 'Mature standard', 'Mature lite'],
    nested: [], moved: [], omniMissing: []});
  assert.deepEqual(byId(await collectSetupCheck(options(paths))).packs.found, ['Pocket TTS']);
  assert.deepEqual(byId(await collectSetupCheck(options(await install(join(root, 'no-pocket'), {pocket: false})))).packs.found, [], 'Pocket is listed only when its folder is there');
  await mkdir(join(root, 'app2', 'models', 'pocket'), {recursive: true});
  assert.deepEqual(byId(await collectSetupCheck(options({...paths, project: join(root, 'app2')}))).packs.found, ['Pocket TTS']);
  // An OmniVoice pack that is only partly there lists what is missing; a complete one lists nothing.
  assert.deepEqual(byId(await collectSetupCheck(options(paths, {omniPack: () => ({installed: false, missing: ['model']})}))).packs.omniMissing, ['model']);

  const nested = [{pack: 'OmniVoice', folder: 'AI-NPC-OmniVoice-0.2'}, {pack: 'Local AI lite', folder: 'Downloads\\AI-NPC-LocalAI-Lite-0.2'}];
  const problem = byId(await collectSetupCheck(options(paths, {nestedPacks: async () => nested}))).packs;
  assert.deepEqual({state: problem.state, code: problem.code, nested: problem.nested}, {state: 'problem', code: 'nested', nested});
  // What the launcher moved at this start is listed; moving things is no problem by itself.
  const moved = byId(await collectSetupCheck(options(paths, {placement: async () => ({fixed: [{pack: 'OmniVoice', from: 'AI-NPC-OmniVoice-0.2'}], conflicts: [], errors: []})}))).packs;
  assert.deepEqual({state: moved.state, code: moved.code, moved: moved.moved}, {state: 'ok', code: 'ok', moved: [{pack: 'OmniVoice', from: 'AI-NPC-OmniVoice-0.2'}]});
  // Conflicts or errors in the launcher's report are a problem; nested folders found now come first.
  for (const placement of [{fixed: [], conflicts: ['local-ai/models/chat.gguf'], errors: []}, {fixed: [], conflicts: [], errors: ['Could not finish moving the files']}]) {
    const conflict = byId(await collectSetupCheck(options(paths, {placement: async () => placement}))).packs;
    assert.deepEqual({state: conflict.state, code: conflict.code}, {state: 'problem', code: 'conflict'});
  }
  const both = byId(await collectSetupCheck(options(paths, {nestedPacks: async () => nested, placement: async () => ({fixed: [], conflicts: ['x'], errors: []})}))).packs;
  assert.equal(both.code, 'nested');
  assert.equal(byId(await collectSetupCheck(options(paths, {placement: async () => null}))).packs.code, 'ok');
}));

test('gpu, browser and mod manager', async () => temp(async root => {
  const paths = await install(root);
  const checks = async over => byId(await collectSetupCheck(options(paths, over)));
  assert.deepEqual((await checks({graphics: async () => []})).gpu, {id: 'gpu', state: 'unknown', code: 'unknown', name: null, memoryMiB: null, adapters: []});
  assert.deepEqual((await checks({graphics: async () => [{name: 'Parsec Virtual Display Adapter', memoryMiB: null}]})).gpu,
    {id: 'gpu', state: 'ok', code: 'found', name: 'Parsec Virtual Display Adapter', memoryMiB: null, adapters: [{name: 'Parsec Virtual Display Adapter', memoryMiB: null}]});
  assert.deepEqual((await checks({browser: () => null})).browser, {id: 'browser', state: 'problem', code: 'missing', name: null});
  assert.deepEqual((await checks({browser: async () => 'Brave'})).browser, {id: 'browser', state: 'ok', code: 'found', name: 'Brave'});
  assert.deepEqual((await checks({modManagers: () => ({managers: ['mo2']})}))['mod-manager'], {id: 'mod-manager', state: 'note', code: 'mo2', managers: ['mo2']});
  assert.deepEqual((await checks({modManagers: () => ({managers: ['vortex']})}))['mod-manager'], {id: 'mod-manager', state: 'note', code: 'vortex', managers: ['vortex']});
  assert.deepEqual((await checks({modManagers: () => ({managers: ['mo2', 'vortex']})}))['mod-manager'], {id: 'mod-manager', state: 'note', code: 'mo2', managers: ['mo2', 'vortex']});
}));

test('voice: a row only when the bridge can say, a problem only while the Pocket voice has failed, and never the reason\'s words', async () => temp(async root => {
  const paths = await install(root);
  const checks = async over => byId(await collectSetupCheck(options(paths, over)));
  assert.equal((await checks({})).voice, undefined, 'a run without the bridge\'s voice has no such row (eight checks, as before)');
  assert.deepEqual((await checks({voice: () => null})).voice, {id: 'voice', state: 'ok', code: 'ok'});
  assert.deepEqual((await checks({voice: async () => ({engine: 'v-helper', reason: 'ValueError: a folder C:\\Users\\someone\\game'})})).voice,
    {id: 'voice', state: 'problem', code: 'pocket-failed', engine: 'v-helper'});
  assert.deepEqual((await checks({voice: async () => ({engine: 'pocket', reason: 'ImportError: DLL load failed: An Application Control policy has blocked this file.', cause: 'blocked'})})).voice,
    {id: 'voice', state: 'problem', code: 'pocket-failed', engine: 'pocket', cause: 'blocked'});
  // Windows ran out of memory (the paging file is too small): the row names that cause and nothing else of the reason; an unknown cause is dropped.
  assert.deepEqual((await checks({voice: async () => ({engine: 'pocket', reason: 'OSError: The paging file is too small for this operation to complete. (os error 1455)', cause: 'virtual-memory'})})).voice,
    {id: 'voice', state: 'problem', code: 'pocket-failed', engine: 'pocket', cause: 'virtual-memory'});
  // A file or Python module of the voice is not on the disk (report 0b8367fd0ebd2f2f, No module named urllib): the row carries the cause, and the game says to reinstall the Full download.
  assert.deepEqual((await checks({voice: async () => ({engine: 'pocket', reason: "ModuleNotFoundError: No module named 'urllib'", cause: 'missing-files'})})).voice,
    {id: 'voice', state: 'problem', code: 'pocket-failed', engine: 'pocket', cause: 'missing-files'});
  assert.deepEqual((await checks({voice: async () => ({engine: 'pocket', reason: 'x', cause: 'C:\\Users\\someone'})})).voice, {id: 'voice', state: 'problem', code: 'pocket-failed', engine: 'pocket'});
  const boom = () => { throw Error('detector failed'); };
  assert.deepEqual((await checks({voice: boom})).voice, {id: 'voice', state: 'unknown', code: 'unknown'});
  assert.equal((await collectSetupCheck(options(paths, {voice: () => null}))).checks.length, 11);
}));

test('microphone: a row only once an input was opened or one is chosen; the label of the input, never an id', async () => temp(async root => {
  const paths = await install(root);
  const checks = async over => byId(await collectSetupCheck(options(paths, over)));
  assert.equal((await checks({})).microphone, undefined, 'a run without the microphone source has no such row');
  assert.equal((await checks({microphone: () => null})).microphone, undefined, 'nothing opened and nothing chosen: no row');
  assert.deepEqual((await checks({microphone: () => ({chosen: null, device: 'Microphone (Realtek(R) Audio)', missing: false})})).microphone,
    {id: 'microphone', state: 'ok', code: 'default', device: 'Microphone (Realtek(R) Audio)'});
  assert.deepEqual((await checks({microphone: async () => ({chosen: 'Headset Mic (USB)', device: 'Headset Mic (USB)', missing: false})})).microphone,
    {id: 'microphone', state: 'ok', code: 'chosen', device: 'Headset Mic (USB)', chosen: 'Headset Mic (USB)'});
  assert.deepEqual((await checks({microphone: () => ({chosen: 'Headset Mic (USB)', device: null, missing: false})})).microphone,
    {id: 'microphone', state: 'ok', code: 'chosen', device: 'Headset Mic (USB)', chosen: 'Headset Mic (USB)'}, 'chosen but not opened yet: named as chosen');
  assert.deepEqual((await checks({microphone: () => ({chosen: 'Headset Mic (USB)', device: 'Microphone (Realtek(R) Audio)', missing: true})})).microphone,
    {id: 'microphone', state: 'note', code: 'missing', device: 'Microphone (Realtek(R) Audio)', chosen: 'Headset Mic (USB)'});
  assert.deepEqual((await checks({microphone: () => ({chosen: null, device: 'Default - CABLE Output (VB-Audio Virtual Cable)', missing: false, loopback: true})})).microphone,
    {id: 'microphone', state: 'note', code: 'loopback', device: 'Default - CABLE Output (VB-Audio Virtual Cable)'}, 'the Windows default looks like a loopback');
  assert.deepEqual((await checks({microphone: () => ({chosen: 'Stereo Mix (Realtek)', device: null, missing: false, loopback: true})})).microphone,
    {id: 'microphone', state: 'note', code: 'loopback', device: 'Stereo Mix (Realtek)', chosen: 'Stereo Mix (Realtek)'}, 'a chosen loopback is told before anything opened');
  const boom = () => { throw Error('detector failed'); };
  assert.equal((await checks({microphone: boom})).microphone, undefined);
}));

test('omni-python: a row only with omni-python.txt; the backend it found (CUDA, ROCm) or why it was refused, never a folder', async () => temp(async root => {
  const paths = await install(root);
  const checks = async over => byId(await collectSetupCheck(options(paths, over)));
  assert.equal((await checks({}))['omni-python'], undefined, 'a run without the source has no such row');
  assert.equal((await checks({omniPython: () => null}))['omni-python'], undefined, 'no file, no row: nothing changes for NVIDIA or CPU players');
  assert.equal((await collectSetupCheck(options(paths, {omniPython: () => null}))).checks.length, 10);
  const rocm = {used: true, backend: 'rocm', reason: null, module: null, torch: '2.14.0+rocm10.1.0', hip: '10.1.0', cuda: null, device: 'AMD Radeon RX 9070 XT', vramMiB: 16304};
  assert.deepEqual((await checks({omniPython: async () => rocm}))['omni-python'],
    {id: 'omni-python', state: 'ok', code: 'used', backend: 'rocm', device: 'AMD Radeon RX 9070 XT', memoryMiB: 16304});
  assert.equal((await checks({omniPython: async () => ({...rocm, backend: 'cuda', hip: null, cuda: '12.8'})}))['omni-python'].backend, 'cuda');
  assert.deepEqual((await checks({omniPython: async () => ({used: false, backend: 'none', reason: 'no-gpu'})}))['omni-python'],
    {id: 'omni-python', state: 'problem', code: 'refused', reason: 'no-gpu', module: null, backend: 'none'});
  assert.deepEqual((await checks({omniPython: async () => ({used: false, backend: 'rocm', reason: 'missing-module', module: 'transformers'})}))['omni-python'],
    {id: 'omni-python', state: 'problem', code: 'refused', reason: 'missing-module', module: 'transformers', backend: 'rocm'});
  assert.deepEqual((await checks({omniPython: async () => ({used: false, backend: null, reason: 'not-found'})}))['omni-python'],
    {id: 'omni-python', state: 'problem', code: 'refused', reason: 'not-found', module: null, backend: null});
  assert.deepEqual((await checks({omniPython: async () => ({used: false, reason: null})}))['omni-python'], {id: 'omni-python', state: 'unknown', code: 'untested'});
  assert.deepEqual((await checks({omniPython: async () => ({used: false, reason: null, testing: true})}))['omni-python'], {id: 'omni-python', state: 'unknown', code: 'testing'});
  // The light run (start-up) asks without starting the self-test; the Help page's run may start it.
  const asked = [];
  await collectSetupCheck(options(paths, {light: true, omniPython: options => { asked.push(options); return null; }}));
  await collectSetupCheck(options(paths, {omniPython: options => { asked.push(options); return null; }}));
  assert.deepEqual(asked, [{light: true}, {light: false}]);
  assert.equal((await checks({omniPython: () => { throw Error('x'); }}))['omni-python'], undefined);
  // No file, but a discrete AMD Radeon card and no NVIDIA one: a pointer row to the experimental route. Never at start-up (light), never for other card lists.
  const rx = {name: 'AMD Radeon RX 9070 XT', memoryMiB: 16304}, rtx = {name: 'NVIDIA GeForce RTX 4060', memoryMiB: 8188}, igpu = {name: 'AMD Radeon(TM) Graphics', memoryMiB: 512};
  const pointer = {id: 'omni-python', state: 'note', code: 'amd-route', device: 'AMD Radeon RX 9070 XT'};
  assert.deepEqual((await checks({omniPython: () => null, graphics: async () => [rx]}))['omni-python'], pointer);
  assert.deepEqual((await checks({omniPython: () => null, graphics: async () => [igpu, rx]}))['omni-python'], pointer);
  for (const cards of [[rtx], [rtx, rx], [igpu, rtx], [igpu], [{name: 'Intel(R) UHD Graphics 770'}], [{name: 'Mystery Adapter'}], []]) {
    assert.equal((await checks({omniPython: () => null, graphics: async () => cards}))['omni-python'], undefined, JSON.stringify(cards));
  }
  assert.equal((await checks({omniPython: () => null, graphics: async () => { throw Error('x'); }}))['omni-python'], undefined, 'detection failing: no row');
  assert.equal(byId(await collectSetupCheck(options(paths, {light: true, omniPython: () => null, graphics: async () => [rx]})))['omni-python'], undefined);
  assert.equal((await checks({omniPython: async () => ({used: false, backend: 'none', reason: 'no-gpu'}), graphics: async () => [rx]}))['omni-python'].code, 'refused', 'an own Python file keeps its own row');
}));

test('a detector that fails turns only its own check into unknown', async () => temp(async root => {
  const paths = await install(root);
  const boom = () => { throw Error('detector failed'); };
  const reject = async () => { throw Error('detector failed'); };
  const unknown = id => ({id, state: 'unknown', code: 'unknown'});
  for (const [name, over, id] of [['browser', {browser: boom}, 'browser'], ['graphics', {graphics: reject}, 'gpu'], ['localAi', {localAi: boom}, 'local-ai'],
    ['modManagers', {modManagers: reject}, 'mod-manager'], ['nestedPacks', {nestedPacks: reject}, 'packs']]) {
    const document = await collectSetupCheck(options(paths, over));
    assert.equal(document.checks.length, 10, name);
    assert.deepEqual(byId(document)[id], unknown(id), name);
    for (const other of document.checks) {
      if (other.id !== id) assert(!(other.state === 'unknown' && other.code === 'unknown'), `${name}: ${other.id} is unaffected`);
    }
    assert.equal(byId(document).versions.code, 'match');
  }
  // A missing detector is the same, and a settings reader that fails reads as the defaults.
  const bare = await collectSetupCheck({game: paths.game, modRoot: paths.modRoot, project: paths.project, light: true});
  assert.deepEqual(byId(bare)['local-ai'], unknown('local-ai'));
  assert.equal(byId(bare).versions.code, 'match');
  const noSettings = await collectSetupCheck(options(paths, {settings: boom}));
  assert.equal(byId(noSettings).internet.service, 'convai');
  const reading = await collectSetupCheck(options(paths, {settings: async () => ({conversationProvider: 'local'})}));
  assert.equal(byId(reading)['local-ai'].selected, true);
}));

test('a light run starts no process and makes no connection', async () => temp(async root => {
  const paths = await install(root);
  const trap = name => () => assert.fail(`${name} must not run in a light run`);
  const light = await collectSetupCheck(options(paths, {light: true, request: 'r-2', browser: trap('browser'), graphics: trap('graphics'), reach: trap('reach')}));
  assert.deepEqual(light.checks.map(check => check.id), ['versions', 'packs', 'browser', 'local-ai', 'internet', 'gpu', 'mod-manager', 'compiler', 'disk', 'python']);
  assert.deepEqual(byId(light).browser, {id: 'browser', state: 'unknown', code: 'unknown', name: null});
  assert.deepEqual(byId(light).gpu, {id: 'gpu', state: 'unknown', code: 'unknown', name: null, memoryMiB: null, adapters: []});
  assert.deepEqual(byId(light).internet, {id: 'internet', state: 'unknown', code: 'unknown', service: 'convai', host: 'api.convai.com'});
  assert.equal(byId(light).versions.code, 'match');
  assert.equal(byId(light)['local-ai'].code, 'not-used');
  // Where no service is needed the answer needs no connection, so it is given.
  const local = await collectSetupCheck(options(paths, {light: true, settings: {conversationProvider: 'local'}, reach: trap('reach')}));
  assert.equal(byId(local).internet.code, 'not-needed');
}));

test('the pack-move report is only believed when it is from this start', async () => temp(async root => {
  const state = join(root, 'state');
  const write = value => put(join(state, 'pack-placement.json'), typeof value === 'string' ? value : JSON.stringify(value));
  const startedAt = 1_800_000_000_000, now = () => startedAt + 5000;
  const report = {version: 1, updated: startedAt - 2000, fixed: [{pack: 'OmniVoice', from: 'AI-NPC-OmniVoice-0.2'}, {pack: 7}, null], conflicts: ['a', 3], errors: ['bad\u0000news']};
  const read = () => readPackPlacement({stateDirectory: state, startedAt, now});
  assert.equal(await read(), null, 'no file');
  await write(report);
  assert.deepEqual(await read(), {fixed: [{pack: 'OmniVoice', from: 'AI-NPC-OmniVoice-0.2'}], conflicts: ['a', '3'], errors: ['bad news']});
  await write({...report, updated: startedAt - 9 * 60 * 1000}); assert.notEqual(await read(), null, 'nine minutes before the start');
  await write({...report, updated: startedAt - 11 * 60 * 1000}); assert.equal(await read(), null, 'an earlier game start');
  await write({...report, updated: startedAt + 60_000}); assert.equal(await read(), null, 'from the future');
  await write({...report, version: 2}); assert.equal(await read(), null);
  await write({...report, updated: 'now'}); assert.equal(await read(), null);
  await write('{"version":1,"upd'); assert.equal(await read(), null, 'half written');
  await write(''); assert.equal(await read(), null, 'an empty placeholder');
  await write({version: 1, updated: startedAt, fixed: 'x', conflicts: {}, errors: null});
  assert.deepEqual(await read(), {fixed: [], conflicts: [], errors: []});
  assert.equal(await readPackPlacement({}), null);
}));

// ------------------------------------------------------------------- the control

const request = (id, issuedAt = Date.now()) => JSON.stringify({version: 1, id, issuedAt});

test('request parsing accepts only a well-formed version 1 request', () => {
  assert.deepEqual(parseSetupRequest(request('s1800000000-1', 5)), {id: 's1800000000-1', issuedAt: 5});
  for (const bad of ['', '{', '[]', 'null', 7, undefined, JSON.stringify({version: 2, id: 'a', issuedAt: 1}), JSON.stringify({version: 1, id: '../x', issuedAt: 1}),
    JSON.stringify({version: 1, id: 'a b', issuedAt: 1}), JSON.stringify({version: 1, id: 'a', issuedAt: 'now'}), JSON.stringify({version: 1, id: 'a', issuedAt: -1}),
    JSON.stringify({version: 1, id: 'x'.repeat(65), issuedAt: 1}), JSON.stringify({version: 1, id: 'a', issuedAt: 1, pad: 'x'.repeat(20000)}), '{"version":1,"id":"half']) {
    assert.equal(parseSetupRequest(bad), null, String(bad).slice(0, 40));
  }
});

async function control(root, extra = {}) {
  const runtime = join(root, 'runtime');
  await mkdir(runtime, {recursive: true});
  const calls = [];
  const paths = await install(root);
  const instance = await SetupCheckControl.open({runtime, log: message => calls.push(['log', message]), ...extra, collect: extra.collect ?? (async (id, run) => {
    calls.push(['collect', id, run]);
    return collectSetupCheck(options(paths, {request: id, light: run.light}));
  })});
  return {instance, calls, runtime, requestPath: join(runtime, SETUP_REQUEST_FILE), resultPath: join(runtime, SETUP_CHECK_FILE)};
}
const collects = calls => calls.filter(call => call[0] === 'collect');
// Waits for something to have happened. The check is repeated until it holds, with a generous ceiling that only a hung test reaches: a fixed
// pause here would be a guess about how long the machine takes (writing the answer file between two runs is real disk work).
async function until(check, label, ceilingMs = 60_000) {
  const end = Date.now() + ceilingMs;
  while (!check()) {
    if (Date.now() > end) assert.fail(`timed out waiting for ${label}`);
    await new Promise(done => setTimeout(done, 2));
  }
}

test('a request left by an earlier session is never answered; a new one is answered once with its id', async () => temp(async root => {
  const runtime = join(root, 'runtime');
  await mkdir(runtime, {recursive: true});
  const requestPath = join(runtime, SETUP_REQUEST_FILE), resultPath = join(runtime, SETUP_CHECK_FILE);
  await writeFile(requestPath, request('old-session', Date.now() - 1000));
  const f = await control(root);
  await f.instance.poll();
  assert.equal(collects(f.calls).length, 0, 'the old request is not replayed');
  await assert.rejects(readFile(resultPath, 'utf8'), {code: 'ENOENT'});

  const asked = request('s-1');
  await writeFile(requestPath, asked);
  await f.instance.poll();
  assert.deepEqual(collects(f.calls).map(call => [call[1], call[2]]), [['s-1', {light: false}]], 'a request is a full run');
  const answer = JSON.parse(await readFile(resultPath, 'utf8'));
  assert.equal(answer.request, 's-1'); assert.equal(answer.version, 1); assert.equal(answer.checks.length, 10);
  assert.equal(await readFile(requestPath, 'utf8'), asked, 'the request file is left exactly as the game wrote it');

  await f.instance.poll(); await f.instance.poll();
  await writeFile(requestPath, asked); await f.instance.poll();
  assert.equal(collects(f.calls).length, 1, 'the same id is answered once');
  await writeFile(requestPath, request('s-2')); await f.instance.poll();
  assert.equal(collects(f.calls).length, 2);
  assert.equal(JSON.parse(await readFile(resultPath, 'utf8')).request, 's-2');
  await writeFile(requestPath, asked); await f.instance.poll();
  assert.equal(collects(f.calls).length, 2, 'an id that was answered earlier is not answered again');
  assert.deepEqual(await files(runtime), [SETUP_REQUEST_FILE, SETUP_CHECK_FILE].sort(), 'no temporary or extra file is left');
}));

test('malformed, expired and future requests are ignored; a half-written one waits for the rest', async () => temp(async root => {
  const f = await control(root);
  const send = async text => { await writeFile(f.requestPath, text); await f.instance.poll(); };
  const now = Date.now();
  for (const text of ['{"version":1,"id":"half', JSON.stringify({version: 2, id: 'a', issuedAt: now}), JSON.stringify({version: 1, id: '../../x', issuedAt: now}),
    request('old', now - 3 * 60 * 1000), request('future', now + 10_000), 'not json']) await send(text);
  assert.equal(collects(f.calls).length, 0);
  await send(request('edge-old', now - 100_000)); assert.equal(collects(f.calls).length, 1, 'under two minutes old counts');
  await send(request('edge-new', now + 2000)); assert.equal(collects(f.calls).length, 2, 'a clock a few seconds ahead counts');
  // The same text arriving in two halves: nothing until it is whole.
  const whole = request('whole');
  await send(whole.slice(0, 20)); assert.equal(collects(f.calls).length, 2);
  await send(whole); assert.equal(collects(f.calls).length, 3);
  f.instance.close();
  await send(request('after-close')); assert.equal(collects(f.calls).length, 3, 'a closed control does nothing');
  assert.equal(await f.instance.run('x'), null);
  assert.equal(collects(f.calls).length, 3);
}));

test('empty exchange files are read as missing: no run, nothing written, nothing removed', async () => temp(async root => {
  const runtime = join(root, 'runtime');
  await mkdir(runtime, {recursive: true});
  for (const name of [SETUP_REQUEST_FILE, SETUP_CHECK_FILE]) await writeFile(join(runtime, name), '');
  const f = await control(root);
  for (let round = 0; round < 3; round++) await f.instance.poll();
  assert.equal(collects(f.calls).length, 0);
  assert.equal(await readFile(f.resultPath, 'utf8'), '', 'no answer is written for no request');
  // The request then overwrites the empty placeholder and is answered in place.
  await writeFile(f.requestPath, request('s-empty'));
  await f.instance.poll();
  assert.equal(JSON.parse(await readFile(f.resultPath, 'utf8')).request, 's-empty');
  assert.deepEqual(await files(runtime), [SETUP_REQUEST_FILE, SETUP_CHECK_FILE].sort());
}));

test('one run at a time: asks made during a run share one more run afterwards, for the newest request', async () => temp(async root => {
  const gates = [], runs = [], log = [];
  const f = await control(root, {collect: async (id, run) => {
    runs.push({id, light: run.light});
    await new Promise(done => gates.push(done));
    log.push(`done ${id}`);
    return {version: 1, updated: 1, bridgePid: process.pid, request: id, checks: []};
  }});
  // Opens the gate of the run in progress, then waits for what follows: the queued run starting (the answer of this one is written to disk first)
  // or the control going free.
  const finishOne = async () => {
    const before = runs.length;
    gates.shift()();
    await until(() => runs.length > before || f.instance.running === null, 'the next run to start or the control to be free');
  };
  const first = f.instance.run('a');
  await until(() => runs.length === 1 && gates.length === 1, 'the first run to start');
  const second = f.instance.run('b'), third = f.instance.run('c'), quiet = f.instance.run(null, {light: true});
  await new Promise(done => setImmediate(done));
  assert.deepEqual(runs, [{id: 'a', light: false}], 'nothing else runs while one is running');
  await finishOne();
  assert.deepEqual(runs, [{id: 'a', light: false}, {id: 'c', light: false}], 'one more run, for the newest id, full because a full one was asked for');
  await finishOne();
  await Promise.all([first, second, third, quiet]);
  assert.deepEqual(log, ['done a', 'done c']);
  assert.equal(JSON.parse(await readFile(f.resultPath, 'utf8')).request, 'c');
  assert.equal(f.instance.running, null, 'the control is free again');

  // A queue made only of light asks stays light; one full ask makes it full and gives it the id.
  runs.length = 0;
  const running = f.instance.run(null, {light: true});
  await until(() => runs.length === 1 && gates.length === 1, 'the light run to start');
  const again = f.instance.run(null, {light: true});
  await finishOne(); await finishOne();
  await Promise.all([running, again]);
  assert.deepEqual(runs, [{id: null, light: true}, {id: null, light: true}]);
  runs.length = 0;
  const lightRun = f.instance.run(null, {light: true});
  await until(() => runs.length === 1 && gates.length === 1, 'the next light run to start');
  const queuedLight = f.instance.run(null, {light: true}), queuedFull = f.instance.run('z'), queuedLater = f.instance.run(null, {light: true});
  await finishOne(); await finishOne();
  await Promise.all([lightRun, queuedLight, queuedFull, queuedLater]);
  assert.deepEqual(runs, [{id: null, light: true}, {id: 'z', light: false}]);
  assert.equal(gates.length, 0);
}));

test('a run that fails is logged, writes nothing and does not stop the next one', async () => temp(async root => {
  let fail = true;
  const f = await control(root, {collect: async id => { if (fail) throw Error('could not build'); return {version: 1, updated: 1, bridgePid: process.pid, request: id, checks: []}; }});
  assert.equal(await f.instance.run('a'), null);
  assert(f.calls.some(call => call[0] === 'log' && /could not build/.test(call[1])));
  await assert.rejects(readFile(f.resultPath, 'utf8'), {code: 'ENOENT'});
  fail = false;
  assert.equal((await f.instance.run('b')).request, 'b');
  assert.equal(JSON.parse(await readFile(f.resultPath, 'utf8')).request, 'b');
  // A document that is not an object is not written.
  const odd = await control(join(root, 'odd'), {collect: async () => 'text'});
  assert.equal(await odd.instance.run('c'), null);
}));

test('the first run of the bridge can be light: the result carries no request', async () => temp(async root => {
  const f = await control(root);
  const document = await f.instance.run(null, {light: true});
  assert.equal(document.request, null);
  assert.deepEqual(collects(f.calls).map(call => call[2]), [{light: true}]);
  assert.equal(JSON.parse(await readFile(f.resultPath, 'utf8')).request, null);
}));

// ---------------------------------------------------------- sources and lists

const source = name => readFile(new URL(name, import.meta.url), 'utf8');

test('the bridge opens the setup check, runs it once at start, polls it and closes it at shutdown', async () => {
  const text = await source('./convai-bridge.mjs');
  assert(/from '\.\/setup-check\.mjs'/.test(text));
  assert(/SetupCheckControl\.open\(\{runtime,/.test(text));
  assert(text.indexOf('SetupCheckControl.open(') > text.indexOf('SupportReportControl.open('), 'opened next to the support report');
  assert(/const setupTimer = setInterval\(\(\) => \{ void setupCheck\.poll\(\)/.test(text));
  assert(/clearInterval\(setupTimer\); setupCheck\.close\(\)/.test(text));
  assert(/await pollSettings\(false\);\s*void setupCheck\.run\(null, \{light: true\}\)\.catch\(/.test(text), 'a light first run, not awaited, right after the settings are read');
  // The support report's lines are untouched.
  assert(/SupportReportControl\.open\(\{game, runtime, stateDirectory, project,/.test(text));
  assert(/clearInterval\(supportTimer\); supportReport\.close\(\)/.test(text));
});

test('the module is packaged, its exchange files are classified, and it never deletes or imports from the packaging folder', async () => {
  const {BRIDGE_MODULES} = await import('../packaging/runtime-layout.mjs');
  assert(BRIDGE_MODULES.includes('bridge/setup-check.mjs'));
  assert.deepEqual([...BRIDGE_MODULES].sort(), [...BRIDGE_MODULES], 'the module list stays in order');
  const manifest = JSON.parse(await source('../packaging/runtime-exchange.json'));
  for (const name of [SETUP_REQUEST_FILE, SETUP_CHECK_FILE]) assert(manifest.exchange.includes(name), `${name} is shipped as a placeholder`);
  assert.deepEqual([...manifest.exchange].sort(), manifest.exchange, 'the exchange list stays alphabetical');
  const text = await source('./setup-check.mjs');
  assert.doesNotMatch(text, /\b(?:rm|rmSync|unlink|unlinkSync|rename|renameSync|writeFile|writeFileSync|truncate)\s*\(/, 'only atomicFile writes, and only the answer');
  assert.doesNotMatch(text, /from '[^']*packaging[^']*'/);
  assert.equal(SETUP_CHECK_FILE, 'setup-check.json'); assert.equal(SETUP_REQUEST_FILE, 'setup-check-request.json');
  const control = await source('./setup-check.mjs');
  assert.doesNotMatch(control, /atomicFile\(\s*(?:this\.)?requestPath/, 'the request file is only read');
});

// From 0.3.4 the Scripts carry the code and the Runtime is the base (docs/PACKAGING.md, "Code in the Scripts"): the Scripts' release.json names
// runtimeBase, the Runtime's release.json is the base's version and defaults/scripts-code.json the code the Scripts installed.
test('versions with the code in the Scripts: a base at or above runtimeBase matches, an older one is base-old naming the base needed', async () => temp(async root => {
  const scheme = async (name, {base, required = '0.3.3', code = '0.3.4', scripts = '0.3.4'} = {}) => {
    const paths = await install(join(root, name), {scripts, runtime: base, scriptsGame: '2.5', runtimeGame: '2.5'});
    await put(join(paths.modRoot, 'release.json'), JSON.stringify({package: 'scripts', version: scripts, game: '2.5', runtimeBase: required}));
    if (code !== null) await put(join(paths.project, 'defaults', 'scripts-code.json'), JSON.stringify({version: 1, package: 'scripts-code', release: code, files: []}));
    return byId(await collectSetupCheck(options(paths))).versions;
  };
  assert.deepEqual(await scheme('a', {base: '0.3.3'}), {id: 'versions', state: 'ok', code: 'match', scripts: '0.3.4', runtime: '0.3.3', required: '0.3.3',
    scriptsGame: '2.5', runtimeGame: '2.5', base: true});
  assert.equal((await scheme('b', {base: '0.3.4'})).code, 'match');
  assert.equal((await scheme('c', {base: '0.3.10', required: '0.3.9'})).code, 'match', 'compared as numbers');
  assert.deepEqual(await scheme('d', {base: '0.3.2'}), {id: 'versions', state: 'problem', code: 'base-old', scripts: '0.3.4', runtime: '0.3.2', required: '0.3.3',
    scriptsGame: '2.5', runtimeGame: '2.5', base: true});
  // The code in the Runtime is not the Scripts' (the copy did not happen): a mismatch between the Scripts and the code that runs.
  assert.deepEqual(await scheme('e', {base: '0.3.3', code: '0.3.3'}), {id: 'versions', state: 'problem', code: 'mismatch', scripts: '0.3.4', runtime: '0.3.3',
    scriptsGame: '2.5', runtimeGame: '2.5'});
  assert.equal((await scheme('f', {base: '0.3.3', code: null})).code, 'mismatch');
}));

// ---------------------------------------------------------------- the disk (error report 1cbe337a5144ebbd: ENOSPC on a C: drive with 0.8 GiB free)

const GIB = 1024 ** 3;

test('disk: under 2 GiB free on the game drive or the data drive is a problem that names the drive and the free space, rounded down to a tenth', async () => temp(async root => {
  const paths = await install(root), asked = [];
  const run = free => async folder => { asked.push(folder); return typeof free === 'function' ? free(folder) : free; };
  const low = byId(await collectSetupCheck(options(paths, {freeSpace: run(0.84 * GIB)}))).disk;
  assert.deepEqual(low, {id: 'disk', state: 'problem', code: 'low', drive: low.drive, freeGiB: 0.8});
  assert.match(low.drive, /^[A-Z]$/);
  assert.deepEqual(asked, [paths.game, paths.stateDirectory], 'the game folder and the data folder are asked, nothing else');
  assert.equal(byId(await collectSetupCheck(options(paths, {freeSpace: run(1.99 * GIB)}))).disk.freeGiB, 1.9, 'never rounds up to the line');
  assert.deepEqual(byId(await collectSetupCheck(options(paths, {freeSpace: run(2 * GIB)}))).disk, {id: 'disk', state: 'ok', code: 'enough', drive: low.drive, freeGiB: 2});
  // The data folder alone is low (the game is on a big drive): still a problem, and the lower of the two is the one named.
  const dataLow = byId(await collectSetupCheck(options(paths, {freeSpace: run(folder => folder === paths.stateDirectory ? 0.3 * GIB : 400 * GIB)}))).disk;
  assert.deepEqual([dataLow.state, dataLow.freeGiB], ['problem', 0.3]);
  assert.equal(DISK_LOW_BYTES, 2 * GIB);
}));

test('disk: a drive that cannot be read, or a folder with no drive letter, leaves the check unknown and never fails the document', async () => temp(async root => {
  const paths = await install(root);
  const unknown = {id: 'disk', state: 'unknown', code: 'unknown'};
  assert.deepEqual(byId(await collectSetupCheck(options(paths, {freeSpace: async () => { throw Object.assign(new Error('EPERM'), {code: 'EPERM'}); }}))).disk, unknown);
  assert.deepEqual(byId(await collectSetupCheck(options(paths, {freeSpace: async () => NaN}))).disk, unknown);
  assert.deepEqual(byId(await collectSetupCheck(options({...paths, game: '//server/share/game', stateDirectory: '/data'}))).disk, unknown, 'a share has no drive letter to name');
  const light = byId(await collectSetupCheck(options(paths, {light: true, freeSpace: async () => 1 * GIB}))).disk;
  assert.deepEqual([light.state, light.code], ['problem', 'low'], 'a light run (the bridge start) reads it too: it starts no process');
  // The real statfs works on this PC.
  const real = byId(await collectSetupCheck({...options(paths), freeSpace: undefined})).disk;
  assert.equal(typeof real.freeGiB, 'number');
}));

test('disk: a nearly full drive is no error report of its own: it is the PC of the player and the game tells them', () => {
  const recorded = [];
  const events = new ErrorEvents({stateDirectory: tmpdir(), runtime: tmpdir()});
  events.record = event => recorded.push(event.message);
  events.setupChecked({checks: [{id: 'disk', state: 'problem', code: 'low', drive: 'C', freeGiB: 0.8}, {id: 'browser', state: 'problem', code: 'missing'}]});
  assert.deepEqual(recorded, ['browser missing']);
});
