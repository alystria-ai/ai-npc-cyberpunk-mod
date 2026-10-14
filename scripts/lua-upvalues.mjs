#!/usr/bin/env node
// Counts the upvalues of every function in the mod's Lua files, the way LuaJIT counts them.
//
// Why: Cyber Engine Tweaks runs LuaJIT 2.1.0-beta3. Stock LuaJIT allows at most 60 upvalues per function (LJ_MAX_UPVAL); a function over the
// limit makes the whole file fail to load ("function at line N has more than N upvalues"), and the mod does not start. The tests run the Lua
// code in fengari (Lua 5.3), whose limit is 255, so they would never notice.
//
// The limit of the CET build itself was read from its plugin (cyber_engine_tweaks.asi, 2026-10-14): the call that raises "function at line %d has
// more than %d upvalues" passes 0x78 = 120 (the neighbouring "local variables" limit is the stock 200, so the pattern is the right one). That agrees
// with the game: mod/init.lua has had a function with 71 upvalues since 2026-10-13 (over 60 since about 2026-10-05) and loads without error.
// So CET_MAX_UPVALUES (120) is the hard limit; STOCK_LUAJIT_MAX_UPVALUES (60) is what a plain LuaJIT would accept, kept for an advisory report.
//
// How: fengari's own compiler (a port of the reference Lua 5.3 one) resolves every upvalue of every function and keeps them in the function
// prototype, so the count is the compiler's, not a guess from the text. Lua 5.3 adds one upvalue named `_ENV` to every function that touches a
// global (and to the main chunk); LuaJIT has no `_ENV` (globals live in the function environment, which is not an upvalue), so the LuaJIT
// count is the 5.3 count without it. Everything else (a captured local of any enclosing function, a function's own name for a recursive
// `local function`, an upvalue passed through an intermediate function) is counted the same in both.
//
// Usage: node scripts/lua-upvalues.mjs [--limit N] [--top N] [files or directories ...]
//   no paths: mod/*.lua and addons/**/*.lua. Exit code 1 when a function is over the limit (default 120, the CET build's; --limit 60 for stock LuaJIT).
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** The limit of the LuaJIT inside Cyber Engine Tweaks (measured, see above): a function with more fails to load. */
export const CET_MAX_UPVALUES = 120;
/** Stock LuaJIT 2.1's LJ_MAX_UPVAL, for reference. */
export const STOCK_LUAJIT_MAX_UPVALUES = 60;

let fengari;
function engine() {
  // The main checkout keeps node_modules; a linked worktree may not, so look in the parent project too.
  if (!fengari) {
    try { fengari = require("fengari"); } catch (error) {
      if (error?.code !== "MODULE_NOT_FOUND") throw error;
      const parent = ROOT.split(path.sep + ".claude" + path.sep + "worktrees" + path.sep)[0];
      fengari = require(path.join(parent, "node_modules", "fengari"));
    }
  }
  return fengari;
}

const text = value => (value ? Buffer.from(value.getstr ? value.getstr() : value).toString("utf8") : "");

/**
 * Every function of one Lua source, outermost first: [{line, lastLine, upvalues, lua53, names, depth}].
 * `upvalues` is the LuaJIT count (the `_ENV` of Lua 5.3 removed), `lua53` the compiler's own. The main chunk is line 0.
 * Throws with the compiler's message when the source does not parse.
 */
export function countUpvalues(source, chunkName = "chunk") {
  const { lua, lauxlib, to_luastring } = engine();
  const L = lauxlib.luaL_newstate();
  try {
    const buffer = to_luastring(source);
    const status = lauxlib.luaL_loadbuffer(L, buffer, buffer.length, to_luastring("=" + chunkName));
    if (status !== lua.LUA_OK) throw new Error(`${chunkName}: ${text(lua.lua_tostring(L, -1))}`);
    const root = L.stack[L.top - 1].value.p;
    const found = [];
    const walk = (proto, depth) => {
      const names = proto.upvalues.map(up => text(up.name));
      const real = names.filter(name => name !== "_ENV");
      found.push({ line: proto.linedefined, lastLine: proto.lastlinedefined, upvalues: real.length, lua53: names.length, names: real, depth });
      for (const child of proto.p) walk(child, depth + 1);
    };
    walk(root, 0);
    return found;
  } finally {
    lua.lua_close(L);
  }
}

/** The Lua files the mod ships: mod/*.lua and addons/**\/*.lua (relative, slash-separated, sorted). */
export function luaFiles(root = ROOT) {
  const out = [];
  const walk = dir => {
    for (const entry of readdirSync(path.join(root, dir), { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(rel);
      else if (entry.isFile() && entry.name.endsWith(".lua")) out.push(rel);
    }
  };
  for (const dir of ["mod", "addons"]) { try { walk(dir); } catch (error) { if (error?.code !== "ENOENT") throw error; } }
  return out.sort();
}

/** Counts for a list of files: [{file, line, lastLine, upvalues, lua53, names}], every function, worst first within the file order. */
export function scanFiles(files, root = ROOT) {
  const rows = [];
  for (const file of files) {
    const absolute = path.isAbsolute(file) ? file : path.join(root, file);
    const source = readFileSync(absolute, "utf8");
    for (const item of countUpvalues(source, file)) rows.push({ file, ...item });
  }
  return rows;
}

/** The functions over `limit`, worst first. */
export const overLimit = (rows, limit = CET_MAX_UPVALUES) => rows.filter(row => row.upvalues > limit).sort((a, b) => b.upvalues - a.upvalues);

function expand(paths) {
  const files = [];
  for (const entry of paths) {
    const absolute = path.resolve(entry);
    if (statSync(absolute).isDirectory()) {
      const walk = dir => {
        for (const item of readdirSync(dir, { withFileTypes: true })) {
          if (item.name === "node_modules" || item.name.startsWith(".")) continue;
          const full = path.join(dir, item.name);
          if (item.isDirectory()) walk(full);
          else if (item.name.endsWith(".lua")) files.push(full);
        }
      };
      walk(absolute);
    } else files.push(absolute);
  }
  return files.sort();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  let limit = CET_MAX_UPVALUES, top = 10;
  const paths = [];
  for (let index = 0; index < args.length; index++) {
    if (args[index] === "--limit") limit = Number(args[++index]);
    else if (args[index] === "--top") top = Number(args[++index]);
    else paths.push(args[index]);
  }
  const files = paths.length ? expand(paths) : luaFiles();
  const rows = scanFiles(files);
  const worst = [...rows].sort((a, b) => b.upvalues - a.upvalues).slice(0, top);
  console.log(`${files.length} files, ${rows.length} functions; most upvalues (LuaJIT count, limit ${limit}):`);
  for (const row of worst) console.log(`  ${String(row.upvalues).padStart(3)}  ${path.relative(ROOT, path.resolve(ROOT, row.file))}:${row.line}-${row.lastLine}`);
  const bad = overLimit(rows, limit);
  for (const row of bad) console.log(`OVER ${row.file}:${row.line}: ${row.upvalues} upvalues`);
  process.exitCode = bad.length ? 1 : 0;
}
