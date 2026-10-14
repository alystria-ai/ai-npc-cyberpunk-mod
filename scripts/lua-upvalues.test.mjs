// The upvalue counter (scripts/lua-upvalues.mjs) and the limit it guards: no function in mod/*.lua or addons/**/*.lua may have more upvalues
// than the LuaJIT inside Cyber Engine Tweaks accepts, because one over makes the whole file fail to load and the tests (fengari, Lua 5.3,
// limit 255) would never say so.
import { test } from "node:test";
import assert from "node:assert/strict";
import { CET_MAX_UPVALUES, STOCK_LUAJIT_MAX_UPVALUES, countUpvalues, luaFiles, overLimit, scanFiles } from "./lua-upvalues.mjs";

const byLine = (rows, line) => rows.find((row) => row.line === line);

test("counts the captured locals of each function, not the globals (Lua 5.3's _ENV is not a LuaJIT upvalue)", () => {
  const rows = countUpvalues(`local a, b, c = 1, 2, 3
local function f() return a + b end
local function g() print(c, f()) end
local function h() return undefinedGlobal end
return function() return a end`, "t");
  assert.equal(rows[0].line, 0);
  assert.equal(rows[0].upvalues, 0, "the main chunk captures nothing (only _ENV in 5.3)");
  assert.equal(byLine(rows, 2).upvalues, 2, "f: a and b");
  assert.deepEqual(byLine(rows, 2).names.sort(), ["a", "b"]);
  assert.equal(byLine(rows, 3).upvalues, 2, "g: c and f; print is a global");
  assert.equal(byLine(rows, 4).upvalues, 0, "h: a global only");
  assert.equal(byLine(rows, 5).upvalues, 1);
});

test("an upvalue used only by an inner function is also an upvalue of the function in between, and a recursive local function counts itself", () => {
  const rows = countUpvalues(`local x, y = 1, 2
local function outer()
  local function inner() return x + y end
  return inner
end
local function fact(n) if n < 2 then return 1 end return n * fact(n - 1) end`, "t");
  assert.equal(byLine(rows, 3).upvalues, 2);
  assert.equal(byLine(rows, 2).upvalues, 2, "x and y pass through outer");
  assert.equal(byLine(rows, 6).upvalues, 1, "fact refers to itself");
});

test("a function over the stock LuaJIT limit of 60 is counted exactly (fengari itself would accept it)", () => {
  for (const count of [59, 60, 61, 71, 120, 121]) {
    const names = Array.from({ length: count }, (_, index) => `v${index}`);
    const source = `${names.map((name) => `local ${name} = 1`).join("\n")}\nlocal function big() return ${names.join(" + ")} end`;
    const row = byLine(countUpvalues(source, "t"), count + 1);
    assert.equal(row.upvalues, count);
  }
  assert.equal(STOCK_LUAJIT_MAX_UPVALUES, 60);
  assert(CET_MAX_UPVALUES >= STOCK_LUAJIT_MAX_UPVALUES);
  const rows = [{ file: "a.lua", line: 1, upvalues: 120 }, { file: "a.lua", line: 9, upvalues: 121 }];
  assert.deepEqual(overLimit(rows).map((row) => row.line), [9]);
  assert.deepEqual(overLimit(rows, 60).map((row) => row.line), [9, 1]);
});

test("a file that does not parse is an error naming the file, not a silent zero", () => {
  assert.throws(() => countUpvalues("local = = 1", "broken.lua"), /broken\.lua/);
});

test("the Lua files the mod ships are found: mod/*.lua and every add-on's", () => {
  const files = luaFiles();
  assert(files.includes("mod/init.lua") && files.includes("mod/mcm.lua"));
  // Skippy and Delamain live in their own repos since 2026-10-14; the example add-on stays here.
  assert(files.includes("addons/example/init.lua"));
});

test(`no function in mod/*.lua or addons/**/*.lua has more than ${CET_MAX_UPVALUES} upvalues (the limit of the LuaJIT in Cyber Engine Tweaks)`, () => {
  const rows = scanFiles(luaFiles());
  assert(rows.length > 1000, "the scan really covered the mod");
  const over = overLimit(rows);
  assert.deepEqual(over.map((row) => `${row.file}:${row.line} has ${row.upvalues} upvalues`), []);
  // The counter sees the heaviest known closure (onUpdate in mod/init.lua): it was 71 on 2026-10-14 and is the one to watch.
  const heaviest = rows.filter((row) => row.file === "mod/init.lua").sort((a, b) => b.upvalues - a.upvalues)[0];
  assert(heaviest.upvalues > 40, `the onUpdate closure was not counted (${heaviest.upvalues})`);
});
