import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import fengari from 'fengari';

// Companions and Johnny speak up on their own (feature 4): the pure scheduler and arbiter of mod/speak-up.lua. Time is simulated
// (tick(dt, eligible)); a seeded generator makes every run identical.
const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;
const source = readFileSync(new URL('../mod/speak-up.lua', import.meta.url), 'utf8');

function run(code) {
  const state = lauxlib.luaL_newstate(); lualib.luaL_openlibs(state);
  const result = lauxlib.luaL_dostring(state, to_luastring(code));
  const error = result === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(state, -1));
  lua.lua_close(state); assert.equal(result, lua.LUA_OK, error);
}

// The shared Lua prelude: the module, a seeded generator, constant-random schedulers and a simulation of the caller (tick, pick, claim,
// a line of `len` seconds, release) that records what the arbiter did.
const prelude = `
local R = (function() ${source} end)()
-- Park-Miller on floats (fengari's integers are 32 bit, so everything here stays a float).
local function rng(seed)
  local s = seed + 0.0
  return function()
    s = (s * 16807.0) % 2147483647.0
    return s / 2147483647.0
  end
end
-- levels are variables the test can change; r is the injected random (constant when set, else a seeded stream).
local lv = {c = 'off', j = 'off'}
local r = 0.5
local function make(c, j, constant, seed)
  lv.c, lv.j = c, j
  local stream = rng(seed or 12345)
  return R.new({companionLevel = function() return lv.c end, johnnyLevel = function() return lv.j end,
    random = function() if constant then return r end return stream() end})
end
local function ticks(S, count, dt, eligible) for _ = 1, count do S:tick(dt, eligible) end end

-- The caller: every step tick, release a finished line, pick when free. Returns counts, gaps and the checks.
local function sim(c, j, hours, dt, seed, len, candidates)
  local S = make(c, j, false, seed)
  candidates = candidates or {companion = true, johnny = true}
  local out = {lines = {companion = 0, johnny = 0}, starts = {companion = {}, johnny = {}}, minGap = math.huge,
    backToBack = 0, overlap = 0}
  local t, who, endsAt, lastEnd, lastWho = 0, nil, 0, nil, nil
  for _ = 1, math.floor(hours * 3600 / dt) do
    S:tick(dt, true); t = t + dt
    if who and t >= endsAt then S:release(who, true); lastEnd, lastWho, who = t, who, nil end
    if not who then
      local p = S:pick(candidates)
      if p then
        assert(S:claim(p), 'a pick must be claimable')
        if S:holder() ~= p then out.overlap = out.overlap + 1 end
        who, endsAt = p, t + len
        out.lines[p] = out.lines[p] + 1
        local list = out.starts[p]; list[#list + 1] = t
        if lastEnd and t - lastEnd < out.minGap then out.minGap = t - lastEnd end
        if lastWho == p then out.backToBack = out.backToBack + 1 end
      end
    end
  end
  out.hours = hours
  out.total = out.lines.companion + out.lines.johnny
  return out
end
local function gapStats(list)
  local gaps = {}
  for i = 2, #list do gaps[#gaps + 1] = list[i] - list[i - 1] end
  local sum = 0
  for _, g in ipairs(gaps) do sum = sum + g end
  local mean = sum / #gaps
  local var = 0
  for _, g in ipairs(gaps) do var = var + (g - mean) ^ 2 end
  return mean, var / #gaps, #gaps
end
`;
// Failures name the line inside the test's own Lua (the prelude is not counted).
const preludeLines = prelude.split('\n').length;
const withModule = code => {
  try { run(`${prelude}\n${code}`); }
  catch (error) {
    const text = String(error.message).replace(/\[string "\.\.\."\]:(\d+):/, (_, n) => `[test lua line ${Number(n) - preludeLines}]:`);
    error.message = text; throw error;
  }
};

// ---------------------------------------------------------------------------------------------------------------------
// (1) Each speaker alone.

test('one speaker alone: lines per eligible hour match the target rate and no gap is under the minimum', () => withModule(`
  for _, row in ipairs({{'rare', 2}, {'medium', 4}, {'normal', 6}}) do
    for _, who in ipairs({'companion', 'johnny'}) do
      local out = sim(who == 'companion' and row[1] or 'off', who == 'johnny' and row[1] or 'off', 100, 1, 7, 8)
      local rate = out.lines[who] / out.hours
      print(string.format('alone %s %s: %.3f lines/h (target %d) over %d h, min gap %.0f s', who, row[1], rate, row[2], out.hours, out.minGap))
      assert(math.abs(rate - row[2]) / row[2] < 0.1, who .. ' ' .. row[1] .. ' rate ' .. rate)
      assert(out.minGap >= R.MIN_GAP, 'gap ' .. out.minGap)
      local other = who == 'companion' and 'johnny' or 'companion'
      assert(out.lines[other] == 0, 'the speaker that is off never speaks')
      local mean, var = gapStats(out.starts[who])
      assert(var > 0, 'gaps are not constant')
      -- the mean gap is 3600 / rate (the line itself, 8 s, is part of the gap between starts)
      assert(math.abs(mean - 3600 / row[2]) / (3600 / row[2]) < 0.05, 'mean gap ' .. mean)
    end
  end
`));

test('one speaker alone at 0.1 s ticks, the way the game ticks', () => withModule(`
  local out = sim('medium', 'off', 30, 0.1, 99, 8)
  local rate = out.lines.companion / out.hours
  print(string.format('alone companion medium at 0.1 s: %.3f lines/h (target 4) over 30 h', rate))
  assert(math.abs(rate - 4) / 4 < 0.12, 'rate ' .. rate)
  assert(out.minGap >= R.MIN_GAP)
`));

test('random: a constant 0.5 gives the exact mean, other values stay inside the bounds', () => withModule(`
  -- constant 0.5: the gap is exactly 3600 / rate, so 10 hours of rare is exactly 20 lines
  local S = make('rare', 'off', true)
  local n, t, until_ = 0, 0, nil
  for _ = 1, 36000 do
    S:tick(1, true); t = t + 1
    if S:holder() and t >= until_ then S:release('companion', true) end
    local p = S:pick({companion = true})
    if p then assert(S:claim(p)); n = n + 1; until_ = t + 5 end
  end
  assert(n == 20, 'exact mean: ' .. n)
  -- the extremes: u = 0 gives 0.4 x mean, u close to 1 gives 1.6 x mean
  r = 0; S = make('normal', 'off', true)
  ticks(S, 239, 1, true); assert(not S:ready('companion'))
  ticks(S, 1, 1, true); assert(S:ready('companion'), '0.4 x 600 = 240')
  r = 0.999999; S = make('normal', 'off', true)
  ticks(S, 959, 1, true); assert(not S:ready('companion'))
  ticks(S, 1, 1, true); assert(S:ready('companion'), '1.6 x 600 = 960')
`));

// ---------------------------------------------------------------------------------------------------------------------
// (2) Both speakers on: the merged pace.

test('merged pace: the sum of the two rates, the 150 s gap respected, nobody twice in a row when the other could speak', () => withModule(`
  local cases = {
    {'rare', 'rare', 4}, {'medium', 'medium', 8}, {'normal', 'normal', 12}, {'rare', 'normal', 8}, {'normal', 'rare', 8},
    {'rare', 'medium', 6}, {'medium', 'normal', 10},
  }
  for index, row in ipairs(cases) do
    local out = sim(row[1], row[2], 120, 1, 31 + index, 8)
    local rate = out.total / out.hours
    print(string.format('merged companion=%s johnny=%s: %.3f lines/h (sum %d), min gap %.0f s, companion %d johnny %d, back-to-back %d',
      row[1], row[2], rate, row[3], out.minGap, out.lines.companion, out.lines.johnny, out.backToBack))
    assert(math.abs(rate - row[3]) / row[3] < 0.1, row[1] .. '+' .. row[2] .. ' rate ' .. rate)
    assert(out.minGap >= R.MIN_GAP, 'gap ' .. out.minGap)
    assert(out.overlap == 0)
  end
`));

test('share: rare + normal splits about 2:6, and the no-back-to-back rule bends it as little as it can', () => withModule(`
  local out = sim('rare', 'normal', 150, 1, 5, 8)
  local share = out.lines.companion / out.total
  print(string.format('share rare+normal: companion %d, johnny %d (companion share %.3f, ideal 0.250), back-to-back %d', out.lines.companion,
    out.lines.johnny, share, out.backToBack))
  assert(math.abs(share - 0.25) < 0.04, 'share ' .. share)
  local equal = sim('medium', 'medium', 100, 1, 6, 8)
  local half = equal.lines.companion / equal.total
  print(string.format('share medium+medium: companion share %.3f (ideal 0.500)', half))
  assert(math.abs(half - 0.5) < 0.04)
  -- back to back lines happen only when the other speaker had nothing to say or was not ready: here that is possible
  -- (a speaker alone is ready while the other's timer runs), the rule never forces a not-ready speaker
  local solo = sim('normal', 'normal', 100, 1, 8, 8, {companion = true, johnny = false})
  assert(solo.lines.johnny == 0 and solo.lines.companion > 0, 'a speaker without a candidate is never picked')
`));

// ---------------------------------------------------------------------------------------------------------------------
// (3) Off, and level changes at runtime.

test('off: a speaker that is off is never picked, both off does nothing', () => withModule(`
  local S = make('off', 'normal', true)
  ticks(S, 3000, 1, true)
  assert(S:pick({companion = true, johnny = true}) == 'johnny')
  assert(not S:claim('companion'), 'off cannot claim')
  S = make('normal', 'off', true)
  ticks(S, 3000, 1, true)
  assert(S:pick({companion = true, johnny = true}) == 'companion')
  assert(not S:claim('johnny'), 'off cannot claim')
  -- both off: the clock does not advance, nothing is ever ready
  S = make('off', 'off', true)
  local before = S:describe()
  ticks(S, 100000, 1, true)
  assert(S:describe() == before, 'nothing moved')
  assert(S:pick({companion = true, johnny = true}) == nil and not S:ready('companion') and not S:ready('johnny'))
  -- levels that are not a rate read as off: plain On, nil, junk, an error
  for _, odd in ipairs({'on', 'Off', '', 'often', 5, true}) do
    S = make(odd, odd, true); ticks(S, 4000, 1, true)
    assert(S:pick({companion = true, johnny = true}) == nil, tostring(odd))
  end
  S = R.new({companionLevel = function() error('boom') end, johnnyLevel = function() return nil end, random = function() return 0.5 end})
  ticks(S, 4000, 1, true)
  assert(S:pick({companion = true, johnny = true}) == nil, 'an error reads as off')
  S = R.new({companionLevel = function() error('boom') end, johnnyLevel = function() return 'normal' end, random = function() return 0.5 end})
  ticks(S, 700, 1, true)
  assert(S:pick({companion = true, johnny = true}) == 'johnny', 'the other level still works')
  S = R.new({random = function() return 0.5 end})
  ticks(S, 4000, 1, true)
  assert(S:pick({companion = true, johnny = true}) == nil, 'no level functions at all')
`));

test('level changes at runtime re-draw the timer from the moment of the change', () => withModule(`
  local S = make('normal', 'off', true)
  ticks(S, 650, 1, true)
  assert(S:ready('companion'))
  lv.c = 'off'; ticks(S, 1, 1, true)
  assert(not S:ready('companion') and S:pick({companion = true}) == nil, 'off drops the timer')
  ticks(S, 5000, 1, true)
  lv.c = 'normal'; ticks(S, 1, 1, true)
  assert(not S:ready('companion'), 'on again: a fresh timer, not the old due time')
  ticks(S, 598, 1, true); assert(not S:ready('companion'))
  ticks(S, 1, 1, true); assert(S:ready('companion'), 'a full mean (600 s) after it came on')
  -- a change of rate re-draws too
  lv.c = 'rare'; ticks(S, 1, 1, true)
  assert(not S:ready('companion'))
  ticks(S, 1798, 1, true); assert(not S:ready('companion'))
  ticks(S, 1, 1, true); assert(S:ready('companion'), 'rare: 1800 s from the change')
  lv.c = 'normal'; ticks(S, 1, 1, true)
  assert(not S:ready('companion'), 'faster rate: re-drawn (600 s from now), not carried over')
  -- the same level again keeps its timer (400 of 600 s gone, 200 left)
  ticks(S, 400, 1, true)
  lv.c = 'normal'; ticks(S, 1, 1, true)
  assert(not S:ready('companion'))
  ticks(S, 197, 1, true); assert(not S:ready('companion'))
  ticks(S, 1, 1, true); assert(S:ready('companion'))
`));

// ---------------------------------------------------------------------------------------------------------------------
// (4) Ineligible time is not counted.

test('ineligible time is not counted: no burst after a long fight or menu', () => withModule(`
  local S = make('normal', 'normal', true)
  ticks(S, 7200, 0.5, false)   -- an hour of ineligible ticks first: the clock does not move
  assert(not S:ready('companion') and not S:ready('johnny'))
  assert(S:pick({companion = true, johnny = true}) == nil)
  ticks(S, 599, 1, true)
  assert(not S:ready('companion'), 'the due time moved by eligible time only')
  ticks(S, 1, 1, true)
  assert(S:ready('companion') and S:ready('johnny'))
  -- a timer that ran for 500 s, then an hour of combat: 100 s left, not zero
  S = make('normal', 'off', true)
  ticks(S, 500, 1, true)
  ticks(S, 3600, 1, false)
  assert(not S:ready('companion'))
  ticks(S, 99, 1, true); assert(not S:ready('companion'))
  ticks(S, 1, 1, true); assert(S:ready('companion'))
  -- stress: random eligibility, an hour of play in total is about 6 lines for normal, however it is chopped up
  S = make('normal', 'off', false, 77)
  local rnd, lines, played, who, endsAt, t = rng(3), 0, 0, nil, 0, 0
  for _ = 1, 400000 do
    local eligible = (math.floor(t / 600) % 2) == 0   -- 10 minutes eligible, 10 minutes not
    S:tick(1, eligible); t = t + 1
    if eligible then
      played = played + 1
      if who and played >= endsAt then S:release(who, true); who = nil end
      if not who then
        local p = S:pick({companion = true})
        if p then assert(S:claim(p)); who = p; endsAt = played + 8; lines = lines + 1 end
      end
    end
  end
  local rate = lines / (played / 3600)
  print(string.format('chopped play: %.3f lines per eligible hour (target 6) over %.1f eligible h', rate, played / 3600))
  assert(math.abs(rate - 6) / 6 < 0.1)
`));

// ---------------------------------------------------------------------------------------------------------------------
// (5) The arbiter.

test('arbiter: one holder, release frees, pick is nil while held, wrong release is ignored', () => withModule(`
  local S = make('normal', 'normal', true)
  ticks(S, 700, 1, true)
  assert(not S:busy() and S:holder() == nil and S:lastSpeaker() == nil)
  assert(S:claim('companion') == true and S:holder() == 'companion' and S:busy())
  assert(S:claim('johnny') == false and S:claim('companion') == false, 'claim while held fails')
  assert(S:claim('johnny', {follow = true}) == false, 'a follow-on cannot cut in either')
  assert(S:pick({companion = true, johnny = true}) == nil, 'pick is nil while held')
  assert(S:release('johnny', true) == false and S:holder() == 'companion', 'only the holder releases')
  assert(S:release('companion', true) == true and S:holder() == nil and S:lastSpeaker() == 'companion')
  assert(S:release('companion', true) == false, 'releasing twice')
  assert(S:claim('nobody') == false and S:claim(nil) == false)
  -- the gap after a heard line: nobody picks or claims for MIN_GAP, then Johnny (the other, due since 600) may
  assert(S:pick({companion = true, johnny = true}) == nil and S:claim('johnny') == false, 'inside the gap')
  ticks(S, 149, 1, true)
  assert(S:pick({companion = true, johnny = true}) == nil)
  ticks(S, 1, 1, true)
  assert(S:pick({companion = true, johnny = true}) == 'johnny', 'the speaker who spoke last yields; companion is not even due')
  assert(S:pick({companion = true, johnny = true}) == 'johnny', 'pick does not claim')
  assert(not S:busy())
`));

test('arbiter: a line nobody heard gives the timer back and is not the last speaker', () => withModule(`
  local S = make('rare', 'off', true)
  ticks(S, 1800, 1, true)
  assert(S:ready('companion'))
  assert(S:claim('companion'))
  assert(not S:ready('companion'), 'claiming draws the next timer from now')
  assert(S:release('companion', false))
  assert(S:lastSpeaker() == nil, 'an unheard line is not the last speaker')
  assert(S:ready('companion') == false, 'restored, but not due sooner than RETRY from now')
  ticks(S, R.RETRY, 1, true)
  assert(S:ready('companion'), 'the old due time (already past) comes back after the retry delay')
  assert(S:pick({companion = true}) == 'companion', 'and there is no gap to wait for: the unheard line did not end anything')
  -- an unheard line whose old due time is far away keeps it exactly: claim is only possible when due, so the old due is in the past
  -- or equal to the clock; the restored value is therefore clock + RETRY at the most
  assert(S:claim('companion')); assert(S:release('companion', true))
  assert(S:lastSpeaker() == 'companion')
  assert(not S:ready('companion'), 'a heard line keeps the new timer (1800 s)')
  ticks(S, 1799, 1, true); assert(not S:ready('companion'))
  ticks(S, 1, 1, true); assert(S:ready('companion'))
  -- unheard follow-on: Johnny's timer comes back too
  S = make("off", "normal", true)
  ticks(S, 600, 1, true)
  assert(S:claim('johnny')); assert(S:release('johnny', false))
  ticks(S, R.RETRY, 1, true)
  assert(S:ready('johnny'))
`));

test('arbiter: claim enforces ready and the gap (the hard bounds), whatever the caller does', () => withModule(`
  local S = make('normal', 'normal', true)
  ticks(S, 599, 1, true)
  assert(S:claim('companion') == false and S:claim('johnny') == false, 'not due yet')
  ticks(S, 1, 1, true)
  assert(S:claim('companion'))
  assert(S:release('companion', true))
  assert(S:claim('johnny') == false, 'due, but the gap since the companion line has not passed')
  ticks(S, 150, 1, true)
  assert(S:claim('johnny'))
`));

test('arbiter: a stress run with random claims, releases and level changes never overlaps and respects the gap', () => withModule(`
  local S = make('normal', 'normal', false, 4)
  local dice = rng(8)
  local holder, endsAt, t, lastEnd = nil, 0, 0, nil
  local claims = 0
  for step = 1, 300000 do
    if step % 20000 == 0 then
      local choices = {'off', 'rare', 'medium', 'normal'}
      lv.c, lv.j = choices[math.floor(dice() * 4) + 1], choices[math.floor(dice() * 4) + 1]
    end
    S:tick(1, dice() < 0.8); t = t + 1
    assert(S:holder() == holder, 'the shadow holder agrees')
    local who = dice() < 0.5 and 'companion' or 'johnny'
    local ok = S:claim(who, dice() < 0.2 and {follow = true} or nil)
    if ok then
      assert(holder == nil, 'a claim succeeded while someone held the floor')
      holder, endsAt = who, t + math.floor(dice() * 20)
      claims = claims + 1
    end
    assert(S:pick({companion = true, johnny = true}) == nil or holder == nil)
    if holder and t >= endsAt then
      local heard = dice() < 0.8
      assert(S:release(holder, heard)); holder = nil
    end
  end
  assert(claims > 100, 'the stress run really claimed: ' .. claims)
`));

// ---------------------------------------------------------------------------------------------------------------------
// (6) Johnny's follow-on.

test('followOn: needs Johnny on and due, is exempt from the gap, counts toward his rate, honours the chance', () => withModule(`
  local S = make('normal', 'normal', true)
  ticks(S, 600, 1, true)
  assert(S:claim('companion')); ticks(S, 8, 1, true); assert(S:release('companion', true))
  ticks(S, 1, 1, true)   -- the companion line ended 1 s ago
  assert(S:pick({companion = true, johnny = true}) == nil, 'the gap blocks an ordinary line')
  assert(S:claim('johnny') == false, 'and an ordinary claim')
  r = 0.49; assert(S:followOn('companion') == true, 'chance: 0.49 yes')
  r = 0.5; assert(S:followOn('companion') == false, 'chance: 0.5 no (random < 0.5)')
  assert(S:followOn('talk') == false)
  r = 0.1; assert(S:followOn('talk') == true and S:followOn('scene') == true)
  assert(S:holder() == nil, 'followOn does not claim')
  r = 0.5
  assert(S:claim('johnny', {follow = true}) == true, 'exempt from the gap')
  assert(S:holder() == 'johnny')
  assert(S:release('johnny', true))
  assert(S:lastSpeaker() == 'johnny')
  r = 0.1
  assert(S:followOn('companion') == false, 'his timer was reset: no second follow-on straight away')
`));

test('followOn: the follow-on counts toward his rate; his own lines wait for a fresh due time', () => withModule(`
  local S = make('normal', 'normal', true)
  ticks(S, 600, 1, true)
  assert(S:claim('companion')); assert(S:release('companion', true))
  ticks(S, 1, 1, true)
  r = 0.1
  assert(S:followOn('companion'))
  r = 0.5
  assert(S:claim('johnny', {follow = true})); assert(S:release('johnny', true))
  -- his own unprompted line waits the full mean from the follow-on (601 + 600), not from the earlier due time
  ticks(S, 599, 1, true)
  assert(not S:ready('johnny'))
  ticks(S, 1, 1, true)
  assert(S:ready('johnny'))
  -- long run: with the follow-on tried after every companion line, his total stays at his rate
  local S2 = make('normal', 'normal', false, 21)
  local johnny, t, who, endsAt = 0, 0, nil, 0
  for _ = 1, 360000 do
    S2:tick(1, true); t = t + 1
    if who and t >= endsAt then
      S2:release(who, true)
      if who == 'companion' and S2:followOn('companion') and S2:claim('johnny', {follow = true}) then
        johnny = johnny + 1; who, endsAt = 'johnny', t + 6
      else who = nil end
    end
    if not who then
      local p = S2:pick({companion = true, johnny = true})
      if p and S2:claim(p) then who, endsAt = p, t + 8; if p == 'johnny' then johnny = johnny + 1 end end
    end
  end
  local rate = johnny / 100
  print(string.format('johnny with follow-ons: %.3f lines/h (his target 6)', rate))
  assert(math.abs(rate - 6) / 6 < 0.12, 'rate ' .. rate)
`));

test('followOn: never when Johnny is off or on-only, not due, someone holds the floor, or the source is unknown', () => withModule(`
  r = 0.1
  local S = make('normal', 'off', true)
  ticks(S, 5000, 1, true)
  assert(S:followOn('companion') == false and S:followOn('talk') == false and S:followOn('scene') == false, 'Johnny off')
  S = make('normal', 'on', true); ticks(S, 5000, 1, true)
  assert(S:followOn('talk') == false, 'plain On is answers only')
  assert(S:claim('johnny', {follow = true}) == false, 'and cannot claim')
  r = 0.5; S = make("off", "normal", true)
  ticks(S, 599, 1, true); r = 0.1
  assert(S:followOn('talk') == false, 'his timer is not due yet')
  r = 0.5; ticks(S, 1, 1, true); r = 0.1
  assert(S:followOn('talk') == true)
  assert(S:followOn('johnny') == false and S:followOn('nonsense') == false and S:followOn(nil) == false, 'unknown source')
  assert(S:claim('johnny')); r = 0.1
  assert(S:followOn('talk') == false and S:followOn('companion') == false, 'Johnny himself is speaking: not a source')
  assert(S:release('johnny', true))
  S = make('normal', 'normal', true)
  ticks(S, 600, 1, true)
  assert(S:claim('companion'))
  assert(S:followOn('companion') == false, 'the companion still holds the floor: release the source line first')
  assert(S:claim('johnny', {follow = true}) == false)
  assert(S:release('companion', true))
  assert(S:followOn('companion') == true)
  -- a follow-on claim is Johnny's only: the companion has no follow-on
  assert(S:claim('companion', {follow = true}) == false)
`));

test('followOn: a custom chance is honoured', () => withModule(`
  local S = R.new({companionLevel = function() return 'off' end, johnnyLevel = function() return 'normal' end,
    random = function() return r end, followChance = 0.9})
  r = 0.5; ticks(S, 600, 1, true)
  r = 0.89; assert(S:followOn('talk'))
  r = 0.9; assert(not S:followOn('talk'))
  assert(R.FOLLOW_CHANCE == 0.5 and R.MIN_GAP == 150 and R.MAX_STEP == 1 and R.RATES.rare == 2 and R.RATES.medium == 4 and R.RATES.normal == 6)
`));

// ---------------------------------------------------------------------------------------------------------------------
// (7) Reset.

test('reset: floor dropped, no last speaker, timers re-drawn on the next tick', () => withModule(`
  local S = make('normal', 'normal', true)
  ticks(S, 700, 1, true)
  assert(S:claim('companion')); assert(S:release('companion', true)); assert(S:claim('johnny', {follow = true}))
  assert(S:holder() == 'johnny' and S:lastSpeaker() == 'companion')
  S:reset()
  assert(S:holder() == nil and not S:busy() and S:lastSpeaker() == nil)
  assert(not S:ready('companion') and not S:ready('johnny') and S:pick({companion = true, johnny = true}) == nil)
  ticks(S, 1, 1, true)
  assert(not S:ready('johnny'), 'a fresh draw from the clock now (the clock keeps running)')
  ticks(S, 599, 1, true)
  assert(S:ready('johnny') and S:ready('companion'))
  assert(S:pick({companion = true, johnny = true}) ~= nil, 'no gap to wait for after a reset')
`));

// ---------------------------------------------------------------------------------------------------------------------
// (8) Purity, the clamp and robustness.

test('pure: no game access, no clocks, loads with nothing but the basic libraries', () => {
  const code = source.split(/\r?\n/).filter(line => !/^\s*--/.test(line)).join('\n').replace(/--.*$/gm, '');
  for (const word of ['Game', 'GetPlayer', 'GetMod', 'os\\.', 'io\\.', 'require', 'dofile', 'loadfile', 'loadstring', 'debug\\.', 'registerForEvent',
    'ObserveAfter', 'Override', 'Cron', 'GameTime', 'print']) {
    assert.ok(!new RegExp(`(^|[^\\w])${word}`).test(code), `no ${word}`);
  }
  // Lua 5.1 (CET's LuaJIT) must read it: no 5.3 operators or goto
  assert.ok(!/(\s\/\/\s|>>|<<|\sgoto\s|::)/.test(code), 'plain Lua 5.1 syntax');
  run(`
    local env = {math = math, string = string, pcall = pcall, type = type, tostring = tostring}
    local chunk = assert(load([==[${source}]==], 'speak-up', 't', env))
    local R = chunk()
    local S = R.new({companionLevel = function() return 'normal' end, random = function() return 0.5 end})
    for _ = 1, 600 do S:tick(1, true) end
    assert(S:ready('companion') and S:pick({companion = true}) == 'companion' and S:describe():find('speak%-up'))
    -- the default random (math.random) works
    local D = R.new({companionLevel = function() return 'rare' end})
    for _ = 1, 100 do D:tick(1, true) end
    assert(not D:ready('companion'))
  `);
});

test('tick: a long step counts as MAX_STEP; bad dt and a non-true eligible advance nothing', () => withModule(`
  local S = make('normal', 'off', true)
  ticks(S, 599, 100, true)   -- 599 ticks of 100 s each are 599 s of play: the clamp
  assert(not S:ready('companion'))
  ticks(S, 1, 100, true)
  assert(S:ready('companion'))
  S = make('normal', 'off', true)
  for _, bad in ipairs({-5, 0, 0/0, math.huge * 0, 'x', false}) do ticks(S, 1000, bad, true) end
  ticks(S, 1000, 1, 'yes'); ticks(S, 1000, 1, 1); ticks(S, 1000, 1, nil); ticks(S, 1000, 1, false)
  assert(not S:ready('companion'), 'nothing advanced')
  S:tick(math.huge, true)   -- an infinite step is one second
  ticks(S, 598, 1, true); assert(not S:ready('companion'))
  ticks(S, 1, 1, true); assert(S:ready('companion'))
  assert(R.MAX_STEP == 1)
`));

test('random: a broken random never breaks the scheduler', () => withModule(`
  for _, bad in ipairs({function() error('x') end, function() return 'a' end, function() return 0/0 end, function() return -3 end, function() return 7 end}) do
    local S = R.new({companionLevel = function() return 'normal' end, johnnyLevel = function() return 'normal' end, random = bad})
    ticks(S, 1000, 1, true)
    assert(S:pick({companion = true, johnny = true}) ~= nil, 'a due time was drawn')
    assert(S:describe():find('companion=normal'))
  end
`));

// ---------------------------------------------------------------------------------------------------------------------
// (9) Cost.

test('cost: tick with both levels off takes the cheap path (no tables, closures or strings in tick)', () => {
  const start = source.indexOf('function sched:tick');
  const end = source.indexOf('function sched:ready');
  assert.ok(start > 0 && end > start);
  const body = source.slice(start, end);
  assert.ok(!/\{/.test(body), 'tick builds no table');
  assert.ok(!/function\s*\(/.test(body.replace(/^function sched:tick\(dt, eligible\)/, '')), 'tick builds no closure');
  assert.ok(!/\.\./.test(body) && !/string\./.test(body), 'tick builds no string');
  // the cheap path: the two level reads, two compares and a return before the clock is advanced
  const guard = body.indexOf('c == nil and j == nil');
  assert.ok(guard > 0, 'both off is checked');
  assert.ok(body.indexOf('return', guard) < body.indexOf('clock = clock'), 'both off returns before the clock is advanced');
  assert.ok(body.indexOf('readLevel(companionLevel)') < guard && body.indexOf('sync(companion, c)') < guard, 'the reads and the syncs come first');
  // by behaviour: with both off nothing moves however long it ticks (no state is written)
  withModule(`
    local S = make('off', 'off', true)
    local before = S:describe()
    ticks(S, 500000, 0.1, true)
    assert(S:describe() == before)
  `);
});
