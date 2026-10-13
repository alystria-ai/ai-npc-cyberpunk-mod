// Shared by the add-on tests (bridge/addons-lua.test.mjs, addons/*/*.test.mjs): runs mod/addons.lua (and an add-on's own Lua)
// in fengari with a real JSON encoder, an in-memory file system, a fake world and the seams init.lua attaches. Not shipped.
import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import fengari from 'fengari';

const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;
export const addonsSource = readFileSync(new URL('../mod/addons.lua', import.meta.url), 'utf8');

// A small real JSON encoder (the files the bridge reads are checked as JSON), plus an in-memory file system.
export const LUA_HARNESS = String.raw`
local encoded = {}
local function copy(value)
    if type(value) ~= 'table' then return value end
    local out = {}; for key, child in pairs(value) do out[key] = copy(child) end; return out
end
local function encodeValue(value)
    local kind = type(value)
    if kind == 'nil' then return 'null' end
    if kind == 'boolean' then return tostring(value) end
    if kind == 'number' then
        if value % 1 == 0 and math.abs(value) < 2^53 then return string.format('%d', value) end
        return string.format('%.17g', value)
    end
    if kind == 'string' then
        return '"' .. (value:gsub('[%c"\\]', function(c) return string.format('\\u%04x', c:byte()) end)) .. '"'
    end
    if kind == 'function' then error('cannot encode a function') end
    if #value > 0 or next(value) == nil then
        local parts = {}
        for index = 1, #value do parts[index] = encodeValue(value[index]) end
        return '[' .. table.concat(parts, ',') .. ']'
    end
    local keys = {}
    for key in pairs(value) do keys[#keys + 1] = tostring(key) end
    table.sort(keys)
    local parts = {}
    for _, key in ipairs(keys) do parts[#parts + 1] = encodeValue(key) .. ':' .. encodeValue(value[key]) end
    return '{' .. table.concat(parts, ',') .. '}'
end
json = {encode = function(value) local text = encodeValue(value); encoded[text] = copy(value); return text end,
    decode = function(text) return copy(assert(encoded[text], 'not encoded by this harness')) end}
files, opened = {}, {}
io = {open = function(path, mode)
    opened[#opened + 1] = (mode or 'r') .. ' ' .. path
    if mode == 'rb' or mode == nil or mode == 'r' then
        if files[path] == nil then return nil end
        return {read = function() return files[path] end, close = function() return true end}
    end
    return {write = function(_, text) files[path] = (mode == 'a' and (files[path] or '') or '') .. text; return true end,
        close = function() return true end}
end}
os.remove = function(path) files[path] = nil; return true end
os.rename = function(from, to) if files[from] == nil then return nil end; files[to], files[from] = files[from], nil; return true end
now = 1000000
os.time = function() return now end
`;

/** Runs `body` with `M` = mod/addons.lua; returns the chunk's string result, if any. */
export function runLua(body) {
  const L = lauxlib.luaL_newstate(); lualib.luaL_openlibs(L);
  try {
    const prefix = `${LUA_HARNESS}
local M = (function() ${addonsSource} end)()
`;
    const program = prefix + body;
    const status = lauxlib.luaL_dostring(L, to_luastring(program));
    let error = status === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(L, -1));
    // Say which line of the test body failed (the chunk line minus the harness and the module in front of it).
    const failedAt = Number(/\]:(\d+):/.exec(error)?.[1]);
    if (error && failedAt) {
      const own = failedAt - prefix.split(String.fromCharCode(10)).length + 1;
      if (own >= 1) error += ' [test line ' + own + ': ' + body.split(String.fromCharCode(10))[own - 1]?.trim() + ']';
    }
    assert.equal(status, lua.LUA_OK, error);
    return lua.lua_gettop(L) > 0 && lua.lua_type(L, -1) === lua.LUA_TSTRING ? to_jsstring(lua.lua_tostring(L, -1)) : undefined;
  } finally { lua.lua_close(L); }
}

// A fake world and the seams init.lua attaches.
export const WORLD = String.raw`
local player = {hash = '77ULL', vehicle = nil}
function player:IsAttached() return true end
function player:GetEntityID() return {hash = self.hash} end
function player:GetMountedVehicle() return self.vehicle end
local car = {hash = '88ULL'}
function car:IsAttached() return true end
function car:GetEntityID() return {hash = self.hash} end
local state = {sample = {available = true, combat = false, tier = 1, vehicle = false}}
local submitted, dropped, notices, logs, warmed = {}, {}, {}, {}, {}
local party = {}
local partyCallback
local generation = 0
local host = {
    log = function(line) logs[#logs + 1] = line end,
    state = function() return state end,
    submit = function(context, anchor) submitted[#submitted + 1] = {context = context, anchor = anchor}; state.pendingId = context.requestId; state.pendingProfile = context.profileKey; return true end,
    drop = function(requestId, reason, entity) dropped[#dropped + 1] = {requestId = requestId, reason = reason, entity = entity}
        if state.pendingId == requestId then state.pendingId = nil end
        if state.speechId == requestId then state.speechId = nil end end,
    nextGeneration = function() generation = generation + 1; return generation end,
    outputs = function() return {enabled = true} end,
    sample = function() return state.sample end,
    notify = function(_, text) notices[#notices + 1] = text end,
    player = function() return player end,
    warm = function(key, entity) warmed[#warmed + 1] = key .. '@' .. entity end,
    registerProfile = function(key) end,
    partyProfiles = function() return party end,
    watchParty = function(fn) partyCallback = fn end,
}
local function tick(seconds) M.tick(player, seconds or 0.1, true) end
local function lease() return json.decode(files['runtime/reaction-lease.json']) end
`;
