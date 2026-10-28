import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, readdirSync, statSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {nativeOffText} from '../packaging/lib/native-off.mjs';

// The switch between the native plugin and the Lua fallback is a set of NAMES that three languages have to agree on: the system names
// the plugin registers (C++), the names the Lua asks convaiNative.use() for, the names runtime/native-off.txt lists, and the class and
// function names (with their parameter counts) the Lua calls. A mismatch never fails loudly in the game: an unknown system name is
// simply "on" (Switches::Enabled answers true for a name nobody listed), a native called with the wrong number of arguments is a
// fault that quietly puts the system back on Lua, and a typo in the shipped native-off.txt leaves a system that was meant to start off
// switched on. These tests read the sources and fail at the commit instead.
//
// Nothing here runs the plugin or the game; it parses native/core/src, mod/*.lua, packaging/ and the docs that promise the behaviour.

const project = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const read = rel => readFileSync(join(project, rel), 'utf8');
const config = JSON.parse(read('packaging/release.config.json'));
const exchange = JSON.parse(read('packaging/runtime-exchange.json'));

function filesUnder(rel, keep) {
  const found = [];
  for (const name of readdirSync(join(project, rel))) {
    const path = `${rel}/${name}`;
    if (statSync(join(project, path)).isDirectory()) found.push(...filesUnder(path, keep));
    else if (keep(name)) found.push(path);
  }
  return found.sort();
}

// ---- a small argument splitter for C++ and Lua call sites ---------------------------------------------------------------------------
// text[open] is an opening bracket; returns the top-level arguments of that bracket and the index after its closing bracket. Strings and
// line comments are skipped; Lua long strings are not used at any call site read here.
function splitArguments(text, open, comment) {
  const pairs = {'(': ')', '[': ']', '{': '}'};
  const stack = [pairs[text[open]]];
  const args = [];
  let current = '';
  let index = open + 1;
  while (index < text.length && stack.length) {
    const char = text[index];
    if (char === '"' || char === "'") {
      let end = index + 1;
      while (end < text.length && text[end] !== char) end += text[end] === '\\' ? 2 : 1;
      current += text.slice(index, end + 1); index = end + 1; continue;
    }
    if (text.startsWith(comment, index)) {
      const end = text.indexOf('\n', index);
      index = end < 0 ? text.length : end; continue;
    }
    if (pairs[char]) stack.push(pairs[char]);
    else if (char === stack[stack.length - 1]) {
      stack.pop();
      if (!stack.length) { index += 1; break; }
    } else if (char === ',' && stack.length === 1) { args.push(current.trim()); current = ''; index += 1; continue; }
    current += char; index += 1;
  }
  if (current.trim() !== '') args.push(current.trim());
  return {args, end: index};
}

// ---- what the plugin registers --------------------------------------------------------------------------------------------------
// {className, system, natives: {Name: parameterCount}} for every native/core/src/systems/**/*Natives.cpp.
function registeredClasses() {
  const classes = new Map();
  for (const file of filesUnder('native/core/src/systems', name => name.endsWith('Natives.cpp'))) {
    const text = read(file);
    const declared = /StaticClass\s+g_class\(\s*"(\w+)"\s*,\s*"(\w+)"\s*\)/.exec(text);
    const system = /\.name\s*=\s*"(\w+)"/.exec(text);
    assert.ok(declared && system, `${file}: no StaticClass g_class("Class", "system") or CONVAI_SYSTEM .name`);
    assert.equal(declared[2], system[1], `${file}: the class is registered for one system and the CONVAI_SYSTEM names another`);
    const natives = {};
    for (const match of text.matchAll(/g_class\.Static\(/g)) {
      const {args} = splitArguments(text, match.index + match[0].length - 1, '//');
      const name = /^"(\w+)"$/.exec(args[0])?.[1];
      assert.ok(name && args.length === 4, `${file}: cannot read ${text.slice(match.index, match.index + 60)}`);
      assert.ok(args[3].startsWith('{'), `${file}: ${name} has no parameter list`);
      const inner = splitArguments(args[3], 0, '//').args;
      natives[name] = inner.length;
    }
    classes.set(declared[1], {className: declared[1], system: system[1], file, natives});
  }
  return classes;
}
const classes = registeredClasses();
const pluginSystems = new Set([...classes.values()].map(row => row.system));

test('the plugin registers the nine systems this suite knows, one class each, and no native is registered twice', () => {
  assert.deepEqual([...pluginSystems].sort(), ['actuator', 'chauffeur', 'clearance', 'core', 'faces', 'gaze', 'io', 'passage', 'vehicles']);
  assert.deepEqual([...classes.keys()].sort(), ['ConvaiNative', 'ConvaiNativeActuator', 'ConvaiNativeChauffeur', 'ConvaiNativeClearance',
    'ConvaiNativeFaces', 'ConvaiNativeGaze', 'ConvaiNativeIo', 'ConvaiNativePassage', 'ConvaiNativeVehicles']);
  for (const row of classes.values()) {
    const text = read(row.file);
    const names = [...text.matchAll(/g_class\.Static\(\s*"(\w+)"/g)].map(match => match[1]);
    assert.equal(new Set(names).size, names.length, `${row.className} registers a name twice`);
    assert.ok(names.length > 0, row.className);
  }
});

// ---- what the Lua calls ----------------------------------------------------------------------------------------------------------
// file -> [variable names that hold the class in that file, the class]. companion-tick-native.lua reads the class once into
// `bound`/`c`; facial-playback.lua keeps it in `native` (and `nativeFaces`, `class` in nativeFor).
const CALLERS = [
  ['mod/companion-tick-native.lua', ['bound', 'c'], 'ConvaiNativeActuator'],
  ['mod/companion-chauffeur-native.lua', ['class'], 'ConvaiNativeChauffeur'],
  ['mod/companion-vehicle-native.lua', ['class'], 'ConvaiNativeVehicles'],
  ['mod/companion-passage.lua', ['class'], 'ConvaiNativePassage'],
  ['mod/companion-clearance.lua', ['class'], 'ConvaiNativeClearance'],
  ['mod/facial-playback.lua', ['native', 'nativeFaces', 'class', 'ConvaiNativeFaces'], 'ConvaiNativeFaces'],
  ['mod/companion-actuator.lua', ['ConvaiNativeGaze'], 'ConvaiNativeGaze'],
  ['mod/native-core.lua', ['Core'], 'ConvaiNative'],
  ['mod/native-core.lua', ['Io'], 'ConvaiNativeIo'],
];

// Every `<variable>.<Capitalised>` in the code lines of a Lua file, with the number of arguments it is called with. Three forms exist:
// `x.Fn(args)`, `pcall(x.Fn, args)` and `native(x.Fn, args)` (native-core's guarded call). Anything else is reported as 'unclassified'
// so a new calling style fails this test instead of slipping past it.
// The Lua files use CRLF line ends: whole-line comments are blanked (the line numbers stay) so a comment that names a native is not a call.
const luaCode = text => text.split(/\r?\n/).map(line => line.replace(/^(\s*)--.*$/, '$1')).join('\n');
// Strings are blanked (same length) for the search, so a fault message that names a native is not a call; the argument count reads the original.
const blankStrings = code => code.replace(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"/g, quoted => ' '.repeat(quoted.length));
function luaCalls(text, variables) {
  const code = luaCode(text);
  const calls = [];
  const pattern = new RegExp(`\\b(${variables.join('|')})\\.([A-Z]\\w*)`, 'g');
  for (const match of blankStrings(code).matchAll(pattern)) {
    const before = code.slice(Math.max(0, match.index - 12), match.index);
    const after = code[match.index + match[0].length];
    const wrapped = /(?:pcall|native)\(\s*$/.exec(before);
    const line = code.slice(0, match.index).split('\n').length;
    if (wrapped) {
      const open = match.index - (before.length - wrapped.index) + wrapped[0].indexOf('(');
      calls.push({name: match[2], args: splitArguments(code, open, '--').args.length - 1, line});
    } else if (after === '(') {
      calls.push({name: match[2], args: splitArguments(code, match.index + match[0].length, '--').args.length, line});
    } else calls.push({name: match[2], args: null, line, unclassified: true});
  }
  return calls;
}

test('the call scanner counts nested arguments, strings and the guarded forms, so the checks below cannot pass by counting nothing', () => {
  const lua = [
    "local ok = pcall(c.Sense, npc, {a = 1, b = 2}, f(x, y), 'a,b', \"c)\")",
    'local t = class.Body(1, 2)',
    'local u = class.Stats()',
    '-- class.Nope(1)',
    "x = 'class.Nope2(1)'",
    'local v = pcall(function() return class.SelfTest() end)',
    'local w = native(Io.Write, name, text)',
    'local r = class.Fill(a,',
    '    b -- a trailing comment, with a comma',
    '    , c)',
    'local ref = class.Later',
  ].join('\r\n');
  const calls = luaCalls(lua, ['c', 'class', 'Io']).map(call => `${call.name}:${call.unclassified ? 'unclassified' : call.args}`);
  assert.deepEqual(calls, ['Sense:5', 'Body:2', 'Stats:0', 'SelfTest:0', 'Write:2', 'Fill:3', 'Later:unclassified']);
  // The C++ side: a parameter list is the number of {type, name} groups, whatever the layout.
  const cpp = 'g_class.Static("Mix", &Mix, "Int32", {{"Int32", "a"}, {handle, "b"},\n {"Bool", "c"}});\ng_class.Static("None", &None, "Bool", {});';
  const first = splitArguments(cpp, cpp.indexOf('('), '//').args;
  assert.equal(first.length, 4);
  assert.equal(splitArguments(first[3], 0, '//').args.length, 3);
  assert.equal(splitArguments('{}', 0, '//').args.length, 0);
});

test('every native function the Lua calls is registered by the plugin, with the parameter count the plugin declares', () => {
  const problems = [];
  const seen = new Map();
  for (const [file, variables, className] of CALLERS) {
    const text = read(file);
    const registered = classes.get(className);
    assert.ok(registered, `${className} is not registered by the plugin`);
    for (const call of luaCalls(text, variables)) {
      if (call.unclassified) { problems.push(`${file}:${call.line} ${call.name} is used in a form this test cannot count; extend luaCalls`); continue; }
      seen.set(`${className}.${call.name}`, (seen.get(`${className}.${call.name}`) ?? 0) + 1);
      const expected = registered.natives[call.name];
      if (expected === undefined) problems.push(`${file}:${call.line} calls ${className}.${call.name}, which the plugin does not register`);
      else if (expected !== call.args) problems.push(`${file}:${call.line} calls ${className}.${call.name} with ${call.args} arguments; the plugin declares ${expected}`);
    }
  }
  assert.deepEqual(problems, []);
  // Not vacuous: the scan found the calls this suite knows exist (a regex that stopped matching would otherwise pass everything).
  for (const name of ['ConvaiNativeActuator.Sense', 'ConvaiNativeActuator.SenseIdle', 'ConvaiNativeActuator.Life', 'ConvaiNativeActuator.CommandState',
    'ConvaiNativeActuator.Capabilities', 'ConvaiNativeChauffeur.Sample', 'ConvaiNativeChauffeur.Drive', 'ConvaiNativeVehicles.Inspect',
    'ConvaiNativeVehicles.Mounting', 'ConvaiNativePassage.CarSpot', 'ConvaiNativeClearance.Body', 'ConvaiNativeClearance.Segment',
    'ConvaiNativeFaces.Frame', 'ConvaiNativeFaces.Check', 'ConvaiNativeGaze.Fill', 'ConvaiNative.CheckVersion', 'ConvaiNative.SystemEnabled',
    'ConvaiNativeIo.Write', 'ConvaiNativeIo.Append', 'ConvaiNativeIo.Rename', 'ConvaiNativeIo.Watch', 'ConvaiNativeIo.Revision']) {
    assert.ok(seen.get(name) > 0, `${name} was not found in the Lua`);
  }
});

// What the plugin registers for diagnosis only: nothing in the mod calls them, a person reads them from the CET console or the log.
const DIAGNOSTIC_ONLY = new Set(['ConvaiNative.ApiVersion', 'ConvaiNativeChauffeur.Stats', 'ConvaiNativeClearance.Stats',
  'ConvaiNativePassage.Stats', 'ConvaiNativeVehicles.Stats', 'ConvaiNativeFaces.Info']);

test('every native the plugin registers is used by the Lua, except the listed diagnostics', () => {
  const used = new Set();
  for (const [file, variables, className] of CALLERS) for (const call of luaCalls(read(file), variables)) used.add(`${className}.${call.name}`);
  // ConvaiNativeFaces.Info is only named in a fault message, not called.
  const unused = [];
  for (const row of classes.values()) for (const name of Object.keys(row.natives)) {
    const key = `${row.className}.${name}`;
    if (!used.has(key) && !DIAGNOSTIC_ONLY.has(key)) unused.push(key);
  }
  assert.deepEqual(unused, [], 'registered natives no Lua calls: wire them up, remove them, or list them as diagnostics here');
  // The diagnostics really are not called (so the list does not hide a live native), and they are registered.
  for (const key of DIAGNOSTIC_ONLY) {
    const [className, name] = key.split('.');
    assert.ok(classes.get(className)?.natives[name] !== undefined, `${key} is no longer registered: drop it from the list`);
    assert.ok(!used.has(key), `${key} is called by the Lua: it is not diagnostic-only`);
  }
  assert.match(read('mod/facial-playback.lua'), /ConvaiNativeFaces\.Info shows which piece/);
});

// ---- system names -----------------------------------------------------------------------------------------------------------------
// The names the Lua asks convaiNative.use(...) for (and reports to convaiNative.fail(...)).
function luaSystemNames() {
  const gates = new Set();
  const failures = new Set();
  for (const file of filesUnder('mod', name => name.endsWith('.lua'))) {
    const text = read(file);
    const code = luaCode(text);
    for (const match of code.matchAll(/\buse\(\s*'([a-z][a-z.]*)'\s*\)/g)) gates.add(match[1]);
    for (const match of code.matchAll(/pcall\(\s*(?:api|convaiNative)\.use\s*,\s*'([a-z]+)'/g)) gates.add(match[1]);
    for (const match of code.matchAll(/\blocal\s+(?:NATIVE|SYSTEM)\s*=\s*'([a-z]+)'/g)) gates.add(match[1]);
    for (const match of code.matchAll(/\bevaluate\(\s*'([a-z]+)'\s*\)/g)) gates.add(match[1]);
    if (file.endsWith('companion-tick-native.lua')) for (const match of code.matchAll(/\bpart\(\s*'([a-z]+)'\s*\)/g)) gates.add(`actuator.${match[1]}`);
    for (const match of code.matchAll(/\b(?:fail|nativeFailed)\(\s*'([a-z]+)'/g)) failures.add(match[1]);
    for (const match of code.matchAll(/pcall\(\s*(?:api|convaiNative)\.fail\s*,\s*'([a-z]+)'/g)) failures.add(match[1]);
    for (const match of code.matchAll(/\bfail\(\s*(?:NATIVE|SYSTEM)\b/g)) failures.add('(variable)');
  }
  return {gates, failures};
}

test('every system the Lua gates on is a system the plugin registers, and every registered system has a Lua gate', () => {
  const {gates, failures} = luaSystemNames();
  const bases = new Set([...gates].map(name => name.split('.')[0]));
  assert.deepEqual([...bases].sort(), ['actuator', 'chauffeur', 'clearance', 'faces', 'gaze', 'io', 'passage', 'vehicles'],
    'an unregistered name is silently "on" in Switches::Enabled, so a typo here bypasses native-off.txt');
  for (const name of bases) assert.ok(pluginSystems.has(name), `${name} is not a registered system`);
  for (const name of pluginSystems) if (name !== 'core') assert.ok(bases.has(name), `the plugin registers ${name} but no Lua asks for it`);
  // The parts of the actuator system are the only dotted names, and the plugin has no parts of its own: Switches::Enabled('actuator.life')
  // is true unless that exact line is in native-off.txt, so every part is gated behind the whole system's switch first.
  assert.deepEqual([...gates].filter(name => name.includes('.')).sort(), ['actuator.life', 'actuator.sense', 'actuator.state']);
  const tick = read('mod/companion-tick-native.lua');
  assert.ok(tick.indexOf('switch.use(SYSTEM)') > 0 && tick.indexOf('switch.use(SYSTEM)') < tick.indexOf("part('life')"), 'the whole system is checked before a part');
  // Reported faults name a system the Lua also gates on.
  for (const name of failures) if (name !== '(variable)') assert.ok(bases.has(name), `fail('${name}') names no gated system`);
});

test('the systems that ship off in native-off.txt (none from 0.2.7) are registered systems the Lua gates on, once each, in lower case', () => {
  const {gates} = luaSystemNames();
  const bases = new Set([...gates].map(name => name.split('.')[0]));
  // The five systems that shipped off through 0.2.6 keep a working kill switch whether or not the list names them: each is a
  // registered system and a name the Lua asks convaiNative.use() for, so a line in native-off.txt reaches it.
  for (const name of ['actuator', 'vehicles', 'chauffeur', 'passage', 'faces']) {
    assert.ok(pluginSystems.has(name), `${name} is not a registered system: a line naming it would be ignored`);
    assert.ok(bases.has(name), `${name} is not a system the Lua gates on: a line naming it would not reach the Lua`);
  }
  assert.deepEqual(config.native.off, [], 'every native system ships on; list a name here only to ship that system off');
  assert.equal(new Set(config.native.off).size, config.native.off.length, 'a name listed twice');
  for (const name of config.native.off) {
    assert.match(name, /^[a-z]+$/, `${name}: the plugin lower-cases lines, but the clean-install test compares the raw names`);
    assert.ok(pluginSystems.has(name), `${name} is not a registered system: the plugin would ignore the line and leave it ON`);
    assert.ok(bases.has(name), `${name} is not a system the Lua asks for`);
    assert.notEqual(name, 'core', 'turning core off would turn off the handshake');
    assert.notEqual(name, 'io', 'io is the proven mailbox path and ships on');
  }
});

// ---- the native-off.txt file ----------------------------------------------------------------------------------------------------
// The plugin's parser (native/core/src/core/Switches.cpp, pinned by native/core/tests/io_tests.cpp): lines split at LF, everything from '#'
// dropped, trimmed, lower-cased, at most 64 characters, "all" switches everything off; an empty or missing file switches nothing off.
function parseSwitchFile(content) {
  const off = [];
  let all = false;
  for (const line of content.split('\n')) {
    const name = line.replace(/#.*/, '').trim().toLowerCase();
    if (name === '' || name.length > 64) continue;
    if (name === 'all') all = true; else off.push(name);
  }
  return {all, off};
}
const enabled = (parsed, system) => !parsed.all && !parsed.off.includes(system);

test('the port of the switch-file parser used here still matches the C++ it mirrors', () => {
  const source = read('native/core/src/core/Switches.cpp');
  for (const rule of [/find\('\\n', position\)/, /line\.find\('#'\)/, /std::tolower/, /name\.size\(\) <= 64/, /name == "all"/]) assert.match(source, rule);
  const unit = read('native/core/tests/io_tests.cpp');
  assert.match(unit, /ParseFile\("# comment\\r\\n IO \\r\\ngaze # trailing\\n"\)/);
  const parsed = parseSwitchFile('# comment\r\n IO \r\ngaze # trailing\n');
  assert.deepEqual(parsed, {all: false, off: ['io', 'gaze']});
  // An empty file, a comment-only file and a file of blank lines all mean "nothing is off": every system is native.
  for (const nothing of ['', '\n', '# nothing here\n', '  \r\n\r\n', '#all\n']) {
    const result = parseSwitchFile(nothing);
    assert.equal(result.all, false, JSON.stringify(nothing));
    for (const system of pluginSystems) assert.ok(enabled(result, system), `${system} with ${JSON.stringify(nothing)}`);
  }
  assert.ok(!enabled(parseSwitchFile('ALL'), 'faces'), 'all is case-insensitive too');
  assert.ok(enabled(parseSwitchFile('face\n'), 'faces'), 'a prefix or a typo switches nothing off');
  assert.ok(enabled(parseSwitchFile('faces.x\n'), 'faces'), 'a dotted name is a different name');
});

test('native-off.txt is never an empty placeholder: an empty file means every system, proven or not, is ON', () => {
  // The files the game and the service rewrite are listed in the "exchange" class and ship in no package. native-off.txt is not one of
  // them: only a person edits it, and the Runtime package ships it. An empty placeholder would arrive empty, and an empty
  // file switches nothing off, so it would silently turn on the systems that are not yet proven in the game.
  for (const file of ['native-off.txt']) {
    assert.ok(!exchange.exchange.includes(file), `${file} must not be an exchange placeholder`);
    assert.ok(exchange.optional.includes(file), `${file} is classified "optional" (made by the Runtime package or by hand)`);
  }
  for (const file of ['native-verify.txt', 'native-handshake.txt']) assert.ok(!exchange.exchange.includes(file), file);
  // The Scripts package ships no exchange file at all (only the static runtime/README.txt, packaging/lib/runtime-exchange.mjs).
  const builder = read('packaging/build-release.mjs');
  const scripts = builder.slice(builder.indexOf('async function scriptsPackage'), builder.indexOf('async function runtimePackage'));
  assert.match(scripts, /pkg\.text\(`\$\{mod\}\/runtime\/README\.txt`, RUNTIME_FOLDER_NOTE\)/);
  assert.ok(!/\.exchange\)/.test(scripts), 'the Scripts package builder does not walk the exchange list');
  // From 0.3.4 no package writes it (the DLL is in the Scripts, native.off is empty and a missing file means every system is on); the build refuses a
  // non-empty native.off rather than silently shipping those systems on.
  assert.ok(!builder.includes('config.native.offFile'), 'no package writes the switch file');
  assert.match(scripts, /if \(config\.native\.off\.length\) throw Error\(/);
  assert.deepEqual(config.native.off, []);
});

test('the native-off.txt the Runtime package writes switches off exactly the configured systems, and the docs list the same names', () => {
  const text = nativeOffText(config.native.off);
  const parsed = parseSwitchFile(text);
  assert.equal(parsed.all, false, 'the shipped file must not say "all": io, which ships proven, would go to Lua with the rest');
  assert.deepEqual(parsed.off, config.native.off);
  for (const system of pluginSystems) {
    assert.equal(enabled(parsed, system), !config.native.off.includes(system), `${system}: on/off in the shipped file`);
  }
  assert.ok(text.endsWith('\n') && !text.includes('\r'), 'LF lines with a final newline: the clean-install test and the plugin split on LF');
  // The comment lines of the shipped file say what an empty or missing file means.
  assert.match(text, /a missing file turns every system on/);
  // The layout paths agree: the Runtime package writes the file where the Lua and the plugin read it.
  assert.equal(config.native.offFile, `${config.layout.modDirectory}/runtime/native-off.txt`);
  // The kill switch is documented even with nothing listed: the file keeps its header, and the docs say the list is empty.
  assert.ok(text.split('\n').filter(line => line.startsWith('#')).length >= 3, 'the header documents the switch');
  if (config.native.off.length === 0) {
    assert.match(text, /every native system is on/i);
    assert.match(read('README.md'), /comment header and no system listed/);
    assert.match(read('README.md'), /Its list \(`native\.off`[^)]*\) is empty/);
    assert.match(read('docs/PACKAGING.md'), /the list is empty \(`native\.off`/);
  } else {
    for (const file of ['README.md', 'docs/PACKAGING.md']) for (const name of config.native.off) assert.ok(read(file).includes(`\`${name}\``), `${file} names ${name}`);
  }
});

test('the plugin, the Lua and the package agree on the file and folder names', () => {
  // The file the plugin watches, the file native-core.lua edits, the file the Runtime package writes.
  assert.match(read('native/core/src/plugin/Main.cpp'), /SetControlFile\("native-off\.txt"/);
  assert.match(read('mod/native-core.lua'), /realOpen\('runtime\/native-off\.txt', 'rb'\)/);
  assert.equal(config.native.offFile.split('/').pop(), 'native-off.txt');
  // The plugin derives the runtime folder from a fixed mod folder name; the package puts the mod there.
  const folder = /mods\\\\(\w+)\\\\runtime/.exec(read('native/core/src/core/Paths.cpp'));
  assert.ok(folder, 'Paths.cpp no longer builds the runtime folder from a literal mod folder name');
  assert.equal(config.layout.modDirectory.split('/').slice(-1)[0], folder[1]);
  assert.equal(config.layout.modDirectory, `bin/x64/plugins/cyber_engine_tweaks/mods/${folder[1]}`);
  // The DLL name is the CMake target, in the plugin folder the config names.
  const cmake = read('native/core/CMakeLists.txt');
  assert.match(cmake, /add_library\((\w+) SHARED/);
  assert.equal(`${/add_library\((\w+) SHARED/.exec(cmake)[1]}.dll`, config.layout.nativeDll);
  assert.equal(/project\((\w+) /.exec(cmake)[1], /add_library\((\w+) SHARED/.exec(cmake)[1]);
  assert.ok(config.layout.nativeDirectory.startsWith('red4ext/plugins/') && config.layout.nativeDirectory !== config.layout.pluginDirectory,
    'the native plugin has its own RED4ext folder, apart from the launcher');
  // The handshake file the Lua writes through the plugin is in the optional list (a person or a tool makes it; a missing file is fine).
  assert.match(read('mod/native-core.lua'), /Io\.Write\('native-handshake\.txt'/);
});

test('the API version the Lua asks for is the one the plugin answers to, and the handshake needs both', () => {
  const lua = /local M = \{API = (\d+)\}/.exec(read('mod/native-core.lua'));
  const cpp = /constexpr int kApiVersion = (\d+);/.exec(read('native/core/src/core/Version.hpp'));
  assert.ok(lua && cpp);
  assert.equal(lua[1], cpp[1], 'mod/native-core.lua and Version.hpp disagree on the API version: every system would stay on Lua');
  // CheckVersion is compatible when the API matches. File IO is proved separately by Lua's handshake and gates only the io system.
  const core = read('native/core/src/systems/core/CoreNatives.cpp');
  assert.match(core, /luaApi == kApiVersion;/);
  assert.match(core, /Guard\(\s*"core"/);
});
