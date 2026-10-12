import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import fengari from 'fengari';

const source = readFileSync(new URL('../mod/relationship-state.lua', import.meta.url), 'utf8');
const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;
const fixture = `
local module=(function() ${source} end)()
local now, reads, writes, version=100000,0,{},'2.31'
local frame={status='ready',worldToken='world-one',generation=1}
local current=frame
local values={sq030_11_romance=1,sq030_judy_lover=1,sq030_romance=1}
local failedWrite, changedAt=false,nil
local function readFact(key)
  reads=reads+1
  if changedAt==reads then current=nil end
  if values[key]=='error' then error('native service gone') end
  return values[key] or 0
end
local collector=module.new({currentWorld=function()return current end,
  clock=function()return now end,readVersion=function()return version end,
  readFact=readFact,publish=function(value)
    writes[#writes+1]=value;return not failedWrite
  end})
`;
function run(body) {
  const state = lauxlib.luaL_newstate(); lualib.luaL_openlibs(state);
  try {
    const result = lauxlib.luaL_dostring(state, to_luastring(fixture + body));
    assert.equal(result, lua.LUA_OK, result === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(state, -1)));
  } finally { lua.lua_close(state); }
}

test('relationship capture exports positive receipts and leaves native zero explicitly unknown', () => run(`
  assert(collector:update(frame))
  local s=writes[1]
  assert(s.status=='ready' and s.worldToken=='world-one' and s.generation==1 and s.capturedAt==now)
  assert(s.gameVersion=='2.31' and reads==11)
  assert(s.facts.sq030_romance.value==1 and s.facts.sq030_romance.present)
  assert(s.facts.sq030_romance.sourceId=='native-quests-system')
  assert(s.facts.sq030_friendship.status=='unknown' and s.facts.sq030_friendship.value==nil)
  assert(s.facts.sq031_rogue_lover==nil)
`));

test('capture stays fresh while menu frames have no simulation progress and throttles within two seconds', () => run(`
  collector:update(frame);now=now+500;collector:update(frame)
  assert(reads==11 and #writes==1)
  now=now+1000;collector:update(frame)
  assert(reads==11 and #writes==1,'republished within the 2 s heartbeat')
  now=now+500;collector:update(frame)
  assert(reads==22 and #writes==2 and writes[2].capturedAt==now)
`));

test('a world change during native reads prevents further native access or stale ready publication', () => run(`
  changedAt=3
  assert(collector:update(frame))
  assert(reads==3 and #writes==1 and writes[1].status=='unavailable')
  assert(writes[1].reason=='world-changed-during-capture')
  collector:reset('detach');assert(reads==3)
  collector:update(frame);assert(reads==3 and writes[#writes].status=='unavailable')
`));

test('native failures, wrong versions and malformed facts never publish a partial relationship', () => run(`
  values.sq030_judy_lover='error';collector:update(frame)
  assert(writes[#writes].status=='unavailable')
  values.sq030_judy_lover='1';collector:update(frame)
  assert(writes[#writes].status=='unavailable')
  local before=reads;version='2.32';collector:update(frame)
  assert(reads==before and writes[#writes].reason=='unsupported-game-version')
`));

test('failed writes retry and a new save generation does not inherit the previous positive facts', () => run(`
  failedWrite=true;assert(not collector:update(frame))
  failedWrite=false;assert(collector:update(frame));assert(reads==22)
  collector:reset('save-reload')
  frame={status='ready',worldToken='world-two',generation=2};current=frame;values={}
  collector:update(frame)
  local s=writes[#writes]
  assert(s.worldToken=='world-two' and s.generation==2 and s.facts.sq030_romance.status=='unknown')
`));

test('every captured fact has an existing compiled native rule and source allowlist entry', () => {
  const pack = JSON.parse(readFileSync(new URL('../characters/world-knowledge.json', import.meta.url), 'utf8'));
  const pairs = [...source.matchAll(/\{'(sq\d+_[a-z0-9_]+|q\d+_[a-z0-9_]+)', '([^']+)'\}/g)];
  assert.equal(pairs.length, 11);
  for (const [, fact, ruleId] of pairs) {
    assert.ok(pack.factAllowlist[fact], `${fact} is not source qualified`);
    const rule = pack.rules.find(row => row.id === ruleId);
    assert.ok(rule && JSON.stringify(rule).includes(fact), `${ruleId} does not qualify ${fact}`);
  }
});

test('a due recapture of the same world waits for a frame no other heartbeat writes in; a first capture never waits', () => run(`
  local free=false
  convaiHeartbeatSlot=function() return free end
  assert(collector:update(frame));assert(reads==11 and #writes==1,'the first capture waited')
  now=now+2000;collector:update(frame);collector:update(frame)
  assert(reads==11 and #writes==1,'recaptured without the heartbeat slot')
  free=true;collector:update(frame)
  assert(reads==22 and #writes==2)
  convaiHeartbeatSlot=nil
`));
