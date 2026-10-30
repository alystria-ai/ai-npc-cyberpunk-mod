import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import fengari from 'fengari';

// Lua (and LuaJIT, which the game runs) refuses a function with more than 200 local variables active at once, and the main chunk of mod/init.lua is such a function: one more
// top-level `local` than the limit and the whole mod fails to load ("main function has more than 200 local variables", triage 30 Oct 2026, error signature 690e381f).
// docs/TALK_FALLBACK.md explains why new helpers there have been global functions. This test measures the chunk with the fengari compiler (same limit, same counting of the locals that are
// active at once) and fails well before the limit, so the next person sees it here and not as a broken mod in a player's game.

const {lua, lauxlib, to_luastring} = fengari;
const LUA_LOCAL_LIMIT = 200;
const FAIL_AT = 190;
const source = readFileSync(new URL('../mod/init.lua', import.meta.url), 'utf8');

// Compiles the chunk (never runs it) with `extra` more locals declared in front of it. The error text, or '' when it compiles.
function compileError(extra) {
  const state = lauxlib.luaL_newstate();
  const prefix = extra > 0 ? 'local ' + Array.from({length: extra}, (_, index) => '_p' + index).join(',') + ' ' : '';
  const code = to_luastring(prefix + source);
  const status = lauxlib.luaL_loadbuffer(state, code, code.length, '=init.lua');
  return status === 0 ? '' : lua.lua_tojsstring(state, -1);
}

// How many locals the main chunk has active at its busiest point: the limit minus the most extra locals it can still take.
function mainChunkLocals() {
  let low = 0, high = LUA_LOCAL_LIMIT;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (compileError(middle) === '') low = middle; else high = middle - 1;
  }
  return LUA_LOCAL_LIMIT - low;
}

test('the measuring works: the chunk compiles, and one that takes too many locals is refused with the limit error', () => {
  assert.equal(compileError(0), '', 'mod/init.lua must compile');
  assert.match(compileError(LUA_LOCAL_LIMIT + 50), /too many local variables/);
});

test(`the main chunk of mod/init.lua keeps its top-level locals under ${FAIL_AT} of Lua's ${LUA_LOCAL_LIMIT}`, () => {
  // Room for FAIL_AT-or-more means the chunk cannot take (LIMIT - FAIL_AT + 1) more locals.
  const room = compileError(LUA_LOCAL_LIMIT - FAIL_AT + 1);
  if (room === '') return;
  assert.fail(`mod/init.lua's main chunk has about ${mainChunkLocals()} local variables active at once (Lua's limit is ${LUA_LOCAL_LIMIT}, and this test fails at ${FAIL_AT}). `
    + 'Do not add another top-level `local` there. Group related locals into one table (for example `gazeState = {candidate = nil, dwell = 0}` and use `gazeState.dwell`), '
    + 'or move the code into a module file in mod/ that init.lua loads with dofile (like companions.lua), or make a helper a global function (docs/TALK_FALLBACK.md).');
});
