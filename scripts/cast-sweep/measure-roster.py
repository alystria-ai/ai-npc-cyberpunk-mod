"""Measure the game-side decode of a roster file with a real LuaJIT 2.1 (OBS's lua51.dll, the same family CET uses) and CET's own json.lua.

    python scripts/cast-sweep/measure-roster.py FILE [FILE ...] [--runs 7]

For each file: bytes, decode time (median of N fresh Lua states, CPU clock), garbage allocated by the decode (heap growth before any
collect), and what stays in the heap after init.lua's roster block drops the bridge-only fields (heap growth after a full collect).
Nothing touches the game.  Paths of the DLL and json.lua can be changed with --dll and --json.
"""
from __future__ import annotations

import argparse
import ctypes
import statistics
import sys
from pathlib import Path

DLL = r"C:\Program Files\obs-studio\bin\64bit\lua51.dll"
JSON = r"C:\Users\akshi\Desktop\Code Palace\Cyberpunk Mod\vendor\cet-1.38.0\x\bin\x64\plugins\cyber_engine_tweaks\scripts\json\json.lua"

CHUNK = r"""
local json = dofile(JSON_PATH)
collectgarbage(); collectgarbage()
local base = collectgarbage('count')
local f = io.open(FILE_PATH, 'rb'); local text = f:read('*a'); f:close()
local size = #text
collectgarbage('stop')   -- count everything the decode allocates: the result and the garbage
local before = collectgarbage('count')
local t0 = os.clock()
local profiles = json.decode(text)
local t1 = os.clock()
local peak = collectgarbage('count') - before
collectgarbage('restart')
-- init.lua's roster block: the bridge-only fields are dropped right after decoding
local bridgeOnly = {'backstory', 'sources', 'speakingStyleDescription', 'speakingStyleSampleDialogues', 'uncertainty', 'nativeIntrinsic'}
local supported = {}
for _, profile in ipairs(profiles) do
    supported[profile.key] = true
    for _, field in ipairs(bridgeOnly) do profile[field] = nil end
end
text = nil
collectgarbage(); collectgarbage()
local kept = collectgarbage('count') - base
RESULT = string.format('%d|%.3f|%.1f|%.1f|%d', size, (t1 - t0) * 1000, peak, kept, #profiles)
"""


def run_once(lua, file: str, json_path: str) -> list[float]:
    L = lua.luaL_newstate()
    lua.luaL_openlibs(L)
    code = f"JSON_PATH = {json_path!r}\nFILE_PATH = {file!r}\n" + CHUNK
    code = code.replace("\\", "/") if False else code
    rc = lua.luaL_loadstring(L, code.encode("utf-8"))
    if rc == 0:
        rc = lua.lua_pcall(L, 0, 0, 0)
    if rc != 0:
        raise RuntimeError(ctypes.string_at(lua.lua_tolstring(L, -1, None)).decode("utf-8", "replace"))
    lua.lua_getfield(L, -10002, b"RESULT")   # LUA_GLOBALSINDEX in 5.1
    value = ctypes.string_at(lua.lua_tolstring(L, -1, None)).decode()
    lua.lua_close(L)
    return [float(x) for x in value.split("|")]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("files", nargs="+")
    ap.add_argument("--runs", type=int, default=7)
    ap.add_argument("--dll", default=DLL)
    ap.add_argument("--json", default=JSON)
    args = ap.parse_args()
    lua = ctypes.CDLL(args.dll)
    lua.luaL_newstate.restype = ctypes.c_void_p
    for fn in (lua.luaL_openlibs, lua.luaL_loadstring, lua.lua_pcall, lua.lua_getfield, lua.lua_close):
        fn.argtypes = None
    lua.luaL_openlibs.argtypes = [ctypes.c_void_p]
    lua.luaL_loadstring.argtypes = [ctypes.c_void_p, ctypes.c_char_p]
    lua.lua_pcall.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_int, ctypes.c_int]
    lua.lua_getfield.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_char_p]
    lua.lua_close.argtypes = [ctypes.c_void_p]
    lua.lua_tolstring.restype = ctypes.c_void_p
    lua.lua_tolstring.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_void_p]
    print("file | bytes | rows | decode ms (median of %d) | decode garbage KB | kept after drop KB" % args.runs)
    for file in args.files:
        rows = [run_once(lua, str(Path(file).resolve()).replace("\\", "/"), args.json.replace("\\", "/")) for _ in range(args.runs)]
        med = lambda i: statistics.median(r[i] for r in rows)
        print(f"{Path(file).name} | {int(rows[0][0])} | {int(rows[0][4])} | {med(1):.1f} | {med(2):.0f} | {med(3):.0f}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
