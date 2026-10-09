#!/usr/bin/env node
// Per tier-1 character: how many conversation clips the selection policy can
// actually use (docs/COMPANION_GESTURES.md, "Round 5"). Runs the real Lua
// policy and catalog under fengari, so the numbers are what the game sees.
//   node scripts/Report-GesturePools.mjs [--catalog <lua>] [--selection <lua>] [--json]
// Compare two builds by pointing --catalog/--selection at older copies
// (git show <rev>:mod/gesture-catalog.lua > old.lua).
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, resolve} from 'node:path';
import fengari from 'fengari';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : fallback; };
const selection = readFileSync(arg('selection', resolve(root, 'mod/gesture-selection.lua')), 'utf8');
const catalog = readFileSync(arg('catalog', resolve(root, 'mod/gesture-catalog.lua')), 'utf8');
const asJson = process.argv.includes('--json');
const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;

const code = `
local m=(function()${selection}end)()
local catalog=(function()${catalog}end)()
local out={}
local function usable(clip, rig, character)
  local onRig = clip.perRig and clip.perRig[rig]
  if not onRig then return false end
  local reach, legs = onRig.reach, onRig.legs
  if type(reach)=='number' and reach > m.maximumReach then return false end
  if type(legs)=='number' and legs > m.maximumLegGap then return false end
  if not m.allowed(clip.name) or m.symbolic(clip) or m.excluded(clip) then return false end
  if clip.character ~= nil and clip.character ~= character then return false end
  return clip.category ~= 'idlebreak' and clip.category ~= 'nod'
end
local seen = {}
local keys = {}
for record, known in pairs(catalog.characters) do keys[#keys+1] = record end
table.sort(keys)
for _, record in ipairs(keys) do
  local known = catalog.characters[record]
  local family = catalog.families[known.talk] or catalog.families[known.fallback or 'on_sides']
  if family and not seen[known.key..record] then
    seen[known.key..record] = true
    local names, kinds, groups, open, nods = {}, {}, {}, 0, 0
    local count, calm, atEnergy = 0, 0, 0
    local cap = (m.energy and m.energy.neutral or 99) + (m.energyStep or 0)
    local filler = {}
    for _, category in ipairs(m.filler or {}) do filler[category] = true end
    for _, clip in ipairs(family.clips) do
      if clip.perRig and clip.perRig[known.rig] and clip.category == 'nod' and not m.excluded(clip) then nods = nods + 1 end
      if usable(clip, known.rig, known.key) then
        count = count + 1
        if filler[clip.category] then
          calm = calm + 1
          local reach = clip.perRig[known.rig].reach
          if type(reach) ~= 'number' or reach <= cap then atEnergy = atEnergy + 1 end
        end
        kinds[m.kind(clip)] = true
        if m.group then groups[m.group(clip)] = true end
        if clip.fit == 'open' then open = open + 1 end
      end
    end
    local nk, ng = 0, 0
    for _ in pairs(kinds) do nk = nk + 1 end
    for _ in pairs(groups) do ng = ng + 1 end
    local idleKey = known.idle
    out[#out+1] = string.format('%s\\t%s\\t%s\\t%s\\t%d\\t%d\\t%d\\t%d\\t%d\\t%d\\t%d\\t%s', record, known.key, known.rig, known.talk, count, calm, atEnergy, nk, ng, open, nods, tostring(idleKey))
  end
end
return table.concat(out, '\\n')
`;
const vm = lauxlib.luaL_newstate();
lualib.luaL_openlibs(vm);
const result = lauxlib.luaL_dostring(vm, to_luastring(code));
if (result !== lua.LUA_OK) { console.error(to_jsstring(lua.lua_tostring(vm, -1))); process.exit(1); }
const text = to_jsstring(lua.lua_tostring(vm, -1));
lua.lua_close(vm);
const rows = text.split('\n').filter(Boolean).map((line) => {
    const [record, key, rig, talk, usable, calm, atEnergy, kinds, groups, open, nods, idle] = line.split('\t');
    return {record, key, rig, talk, usable: +usable, calm: +calm, atEnergy: +atEnergy, kinds: +kinds, groups: +groups, open: +open, nods: +nods, idle};
});
if (asJson) console.log(JSON.stringify(rows, null, 2));
else {
    console.log('record'.padEnd(34), 'key'.padEnd(12), 'rig'.padEnd(11), 'family'.padEnd(13), 'usable calm calm@mood kinds groups open nods idle');
    for (const r of rows) console.log(r.record.padEnd(34), r.key.padEnd(12), r.rig.padEnd(11), r.talk.padEnd(13),
        String(r.usable).padStart(6), String(r.calm).padStart(4), String(r.atEnergy).padStart(9), String(r.kinds).padStart(5), String(r.groups).padStart(6), String(r.open).padStart(4), String(r.nods).padStart(4), r.idle);
}
