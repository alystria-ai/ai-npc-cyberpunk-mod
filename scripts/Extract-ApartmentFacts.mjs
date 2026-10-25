#!/usr/bin/env node
// Lists the quest facts that mean "the game is directing one of V's apartments" from the game's cooked quest data, so a game update changes
// data, not logic (docs/HOUSEMATES.md, "Quest and scene safety"; the table is D.reservedFacts in mod/housemate-spots-data.lua).
//
//   node scripts/Extract-ApartmentFacts.mjs [--game <dir>] [--json-dir <dir>] [--out <file>] [--check]
//
//   --json-dir  read already converted *.json files (questphase and scene), recursively, instead of touching the game
//   --game      the Cyberpunk 2077 folder (default E:/SteamLibrary/steamapps/common/Cyberpunk 2077); the needed files are unbundled and
//               converted with the WolvenKit CLI (read only) into a fresh temp directory that is deleted afterwards
//   --out       write the JSON there instead of stdout
//   --check     compare with D.reservedFacts in mod/housemate-spots-data.lua and print what the data lacks / what the game does not have
//               (informational: exit 0 unless the CLI failed). Without --out the report replaces the JSON on stdout.
//   --wolvenkit <exe> / --dotnet <dir>   override the vendored CLI and .NET runtime
//
// Output: {version: 1, source, facts: {any, h10, corpo, glen, japan, north}} with sorted unique names.
import {existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath, pathToFileURL} from 'node:url';

export const GROUPS = ['any', 'h10', 'corpo', 'glen', 'japan', 'north'];

// What counts as an apartment fact.
const FAMILY = [/^dlc6_apart_/, /^mq055_/, /apartment/, /^web_apartment/, /^q305_/, /^johnny_default_sit_active$/, /^mq000_/];
// Never listed: ownership results are not a scene, and apartment_on is a global switch (docs/HOUSEMATES.md).
const EXCLUDED = [/^dlc6_apart_.+_purchased$/, /^apartment_on$/];
// Which apartment a name belongs to. The first rule that matches wins. The short district tokens (_dtn_ ...) are the game's own
// abbreviations in names such as dlc6_apart_dtn_sleeping.
const APARTMENT_RULES = [
    ['corpo', /cct_dtn|downtown|(^|_)dtn(_|$)/],
    ['glen', /hey_gle|heywood|(^|_)gle(_|$)|(^|_)hey(_|$)/],
    ['japan', /wbr_jpn|japantown|(^|_)jpn(_|$)/],
    ['north', /wat_nid|northside|(^|_)nid(_|$)/],
    ['h10', /megabuilding|mq000|johnny/],
];

export function classify(name) {
    const text = String(name);
    for (const [group, pattern] of APARTMENT_RULES) if (pattern.test(text)) return group;
    return 'any';
}

export function isApartmentFact(name) {
    if (typeof name !== 'string' || !/^[A-Za-z0-9_]+$/.test(name)) return false; // notes such as "x - fact disabled after feedback" are not fact names
    if (EXCLUDED.some((pattern) => pattern.test(name))) return false;
    return FAMILY.some((pattern) => pattern.test(name));
}

function factValue(value) {
    if (typeof value === 'string') return value;
    if (value && typeof value === 'object' && typeof value.$value === 'string') return value.$value; // a serialized CName
    return null;
}

// jsonValues: parsed JSON documents. Returns {any, h10, corpo, glen, japan, north}, each a sorted array of unique names.
export function collectFacts(jsonValues) {
    const sets = Object.fromEntries(GROUPS.map((group) => [group, new Set()]));
    const stack = [...jsonValues];
    while (stack.length) {
        const node = stack.pop();
        if (!node || typeof node !== 'object') continue;
        if (Array.isArray(node)) {
            for (const item of node) stack.push(item);
            continue;
        }
        for (const key of Object.keys(node)) {
            const child = node[key];
            if (key === 'factName') {
                const name = factValue(child);
                if (name !== null && isApartmentFact(name)) sets[classify(name)].add(name);
            }
            if (child && typeof child === 'object') stack.push(child);
        }
    }
    return Object.fromEntries(GROUPS.map((group) => [group, [...sets[group]].sort()]));
}

function jsonFiles(dir) {
    const found = [];
    const walk = (current) => {
        for (const entry of readdirSync(current, {withFileTypes: true})) {
            const full = join(current, entry.name);
            if (entry.isDirectory()) walk(full);
            else if (entry.isFile() && entry.name.toLowerCase().endsWith('.json')) found.push(full);
        }
    };
    walk(dir);
    return found.sort();
}

function readJsonDir(dir) {
    const values = [];
    for (const file of jsonFiles(dir)) {
        try { values.push(JSON.parse(readFileSync(file, 'utf8'))); }
        catch (error) { console.error(`skipped ${file}: ${error.message}`); }
    }
    return values;
}

// The depot paths that carry apartment scenes (found by the earlier manual research). .NET regex, matched against the archive path.
export const DEPOT_REGEX = String.raw`(^|\\)(dlc6_apart[^\\]*\.(questphase|scene)|mq055_(apartment|message)[^\\]*\.questphase|mq000_01_apartment\.scene|mq000_vs_apartment_interactions\.questphase)$`;

function findUp(start, relative) {
    for (let dir = resolve(start); ; dir = dirname(dir)) {
        const candidate = join(dir, relative);
        if (existsSync(candidate)) return candidate;
        if (dirname(dir) === dir) return null;
    }
}

function runCli(exe, dotnetRoot, args, label) {
    const result = spawnSync(exe, args, {env: {...process.env, DOTNET_ROOT: dotnetRoot}, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024});
    const output = `${result.stdout || ''}${result.stderr || ''}`;
    if (result.error) throw new Error(`WolvenKit failed (${label}): ${result.error.message}`);
    if (result.status !== 0) throw new Error(`WolvenKit failed (${label}): exit ${result.status}\n${output.split('\n').slice(-20).join('\n')}`);
    if (/\[\s*\d+: Error/.test(output)) throw new Error(`WolvenKit reported an error (${label})\n${output.split('\n').slice(-20).join('\n')}`);
    return output;
}

function extractFromGame(gameDir, options) {
    const here = dirname(fileURLToPath(import.meta.url));
    const exe = options.wolvenkit || findUp(here, join('vendor', 'wolvenkit-console-9.0.1', 'WolvenKit.CLI.exe'));
    const dotnetRoot = options.dotnet || findUp(here, join('vendor', 'dotnet-runtime-10.0.12'));
    if (!exe || !existsSync(exe)) throw new Error('WolvenKit CLI is missing (vendor/wolvenkit-console-9.0.1/WolvenKit.CLI.exe, or --wolvenkit).');
    if (!dotnetRoot || !existsSync(dotnetRoot)) throw new Error('Local .NET runtime is missing (vendor/dotnet-runtime-10.0.12, or --dotnet).');
    const content = join(gameDir, 'archive', 'pc', 'content');
    const primary = join(content, 'basegame_4_gamedata.archive');
    if (!existsSync(primary)) throw new Error(`Game archive not found: ${primary}`);
    const optional = [join(gameDir, 'archive', 'pc', 'ep1', 'ep1_2_gamedata.archive'), join(gameDir, 'archive', 'pc', 'ep1', 'ep1_1_nightcity.archive')].filter(existsSync);
    const work = mkdtempSync(join(tmpdir(), 'apartment-facts-'));
    try {
        const raw = join(work, 'raw');
        const json = join(work, 'json');
        mkdirSync(raw);
        mkdirSync(json);
        runCli(exe, dotnetRoot, ['unbundle', primary, '--outpath', raw, '--regex', DEPOT_REGEX], 'unbundle basegame_4_gamedata');
        for (const archive of optional) {
            try { runCli(exe, dotnetRoot, ['unbundle', archive, '--outpath', raw, '--regex', DEPOT_REGEX], `unbundle ${archive}`); }
            catch (error) { console.error(`warning: ${error.message.split('\n')[0]}`); }
        }
        runCli(exe, dotnetRoot, ['convert', 'serialize', raw, '--outpath', json], 'convert serialize');
        const values = readJsonDir(json);
        if (!values.length) throw new Error('No apartment files were found in the game archive.');
        return values;
    } finally {
        rmSync(work, {recursive: true, force: true});
    }
}

// --- D.reservedFacts in the Lua data ---------------------------------------------------------------------------------------------------

export function parseReservedFacts(lua) {
    const start = lua.search(/D\.reservedFacts\s*=\s*\{/);
    if (start < 0) throw new Error('D.reservedFacts not found in the Lua data.');
    const open = lua.indexOf('{', start);
    let depth = 0;
    let end = -1;
    for (let index = open; index < lua.length; index += 1) {
        if (lua[index] === '{') depth += 1;
        else if (lua[index] === '}') { depth -= 1; if (depth === 0) { end = index; break; } }
    }
    if (end < 0) throw new Error('D.reservedFacts is not closed.');
    const body = lua.slice(open + 1, end).replace(/--[^\n]*/g, '');
    const table = Object.fromEntries(GROUPS.map((group) => [group, []]));
    for (const match of body.matchAll(/([A-Za-z_]\w*)\s*=\s*\{([^}]*)\}/g)) {
        const names = [...match[2].matchAll(/'([^']*)'|"([^"]*)"/g)].map((item) => item[1] ?? item[2]);
        table[match[1]] = [...new Set([...(table[match[1]] || []), ...names])].sort();
    }
    return table;
}

export function compareFacts(found, data) {
    const report = {};
    for (const group of GROUPS) {
        const have = new Set(data[group] || []);
        const seen = new Set(found[group] || []);
        report[group] = {
            missingInData: (found[group] || []).filter((name) => !have.has(name)),
            notInGame: (data[group] || []).filter((name) => !seen.has(name)),
        };
    }
    return report;
}

function formatReport(report) {
    const lines = [];
    for (const group of GROUPS) {
        const {missingInData, notInGame} = report[group];
        lines.push(`[${group}] in the game, not in D.reservedFacts: ${missingInData.length}`);
        for (const name of missingInData) lines.push(`    + ${name}`);
        lines.push(`[${group}] in D.reservedFacts, not found in the game data: ${notInGame.length}`);
        for (const name of notInGame) lines.push(`    - ${name}`);
    }
    return lines.join('\n');
}

// --- main ------------------------------------------------------------------------------------------------------------------------------

function parseArgs(argv) {
    const options = {};
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        const value = () => {
            if (index + 1 >= argv.length) throw new Error(`${arg} needs a value`);
            index += 1;
            return argv[index];
        };
        if (arg === '--game') options.game = value();
        else if (arg === '--json-dir') options.jsonDir = value();
        else if (arg === '--out') options.out = value();
        else if (arg === '--wolvenkit') options.wolvenkit = value();
        else if (arg === '--dotnet') options.dotnet = value();
        else if (arg === '--check') options.check = true;
        else throw new Error(`Unknown argument: ${arg}`);
    }
    return options;
}

function main() {
    const options = parseArgs(process.argv.slice(2));
    const game = options.game || 'E:/SteamLibrary/steamapps/common/Cyberpunk 2077';
    let source;
    let values;
    if (options.jsonDir) {
        source = resolve(options.jsonDir);
        values = readJsonDir(source);
        if (!values.length) throw new Error(`No JSON files under ${source}`);
    } else {
        source = game;
        values = extractFromGame(game, options);
    }
    const result = {version: 1, source, facts: collectFacts(values)};
    const text = `${JSON.stringify(result, null, 2)}\n`;
    if (options.out) writeFileSync(options.out, text);
    else if (!options.check) process.stdout.write(text);
    if (options.check) {
        const here = dirname(fileURLToPath(import.meta.url));
        const luaPath = join(here, '..', 'mod', 'housemate-spots-data.lua');
        const report = compareFacts(result.facts, parseReservedFacts(readFileSync(luaPath, 'utf8')));
        process.stdout.write(`${formatReport(report)}\n`);
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    try { main(); }
    catch (error) {
        console.error(error.message);
        process.exit(1);
    }
}
