import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import fengari from 'fengari';
const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;
const facial = readFileSync(new URL('../mod/facial-playback.lua', import.meta.url), 'utf8');

// A growing continuous timeline is handed to face.updateContinuous again for every revision, with the rows it
// already held. Rows are range-checked once: only a row it has not seen costs the per-weight checks again.
const setup = `
CName={new=function(x) return x end}
NewObject=function(name) return {} end
convaiCompanions={owns=function() return true end}
local judy={id='Judy-1'}
function judy:GetEntityID() return {hash=self.id} end
function judy:IsAttached() return true end
function judy:IsDeadNoStatPool() return false end
function judy:ConvaiFaceReady() return true end
function judy:ConvaiFaceApply() return true end
function judy:ConvaiFaceReset() return true end
local face=(function() ${facial} end)()
local context={entity='Judy-1',requestId='live-voice',generation=8}
local reads=0
-- A row that counts every weight read (index 2 and up).
local function row(t,weight)
 return setmetatable({},{__index=function(_,k) if k>=2 then reads=reads+1 end; return k==1 and t or weight end,__len=function() return 2 end})
end
local function timeline(rows,complete,source)
 local frames={}
 for i=1,#rows do frames[i]=rows[i] end
 local duration=frames[#frames][1]
 return {version=1,continuous=true,complete=complete,requestId=context.requestId,entity=context.entity,
  generation=context.generation,duration=duration,source=source or 'convai-arkit61',articulation='arkit61-open-v2',
  tracks={'jaw_mid_open'},frames=frames},duration
end
`;
function run(body) {
  const state = lauxlib.luaL_newstate(); lualib.luaL_openlibs(state);
  const result = lauxlib.luaL_dostring(state, to_luastring(setup + body));
  const error = result === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(state, -1));
  lua.lua_close(state); assert.equal(result, lua.LUA_OK, error);
}

test('a growing continuous timeline range-checks only the rows it has not checked before', () => run(`
 local rows={}
 for i=0,19 do rows[#rows+1]=row(i*.1,.2) end
 local line,duration=timeline(rows,false)
 assert(face.updateContinuous(context,line,judy,duration),face.error)
 local first=reads
 assert(first==20*3,'first revision checked '..first..' weight reads')
 for i=20,29 do rows[#rows+1]=row(i*.1,.3) end
 line,duration=timeline(rows,false)
 assert(face.updateContinuous(context,line,judy,duration),face.error)
 assert(reads-first==10*3,'grown revision re-checked old rows: '..(reads-first)..' weight reads')
 -- A new row that is out of range is still refused, and refusing it ends the reply like any invalid revision.
 rows[#rows+1]=row(3.0,2)
 line,duration=timeline(rows,false)
 assert(not face.updateContinuous(context,line,judy,duration) and tostring(face.error):find('Invalid facial weight'))
`));

test('a new reply starts with nothing checked', () => run(`
 local rows={}
 for i=0,9 do rows[#rows+1]=row(i*.1,.2) end
 local line,duration=timeline(rows,false)
 assert(face.updateContinuous(context,line,judy,duration),face.error)
 assert(reads==30)
 face.stop(judy,'finished')
 reads=0
 assert(face.updateContinuous(context,line,judy,duration),face.error)
 assert(reads==30,'a new reply skipped the checks for rows an earlier reply had seen: '..reads)
`));
