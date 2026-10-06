import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import fengari from 'fengari';

const selection = readFileSync(new URL('../mod/gesture-selection.lua', import.meta.url), 'utf8');
const catalog = readFileSync(process.env.GESTURE_CATALOG || new URL('../mod/gesture-catalog.lua', import.meta.url), 'utf8');
function run(code) {
  const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;
  const vm = lauxlib.luaL_newstate(); lualib.luaL_openlibs(vm);
  const result = lauxlib.luaL_dostring(vm, to_luastring(fixture + code));
  const error = result === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(vm, -1));
  lua.lua_close(vm); assert.equal(result, lua.LUA_OK, error);
}
const fixture = `
local m=(function()${selection}end)()
local catalog=(function()${catalog}end)()
local seed=1
local function lcg() seed=(seed*1103515245+12345)%2147483648;return seed/2147483648 end
local function clip(name,category,durations,character)
  local perRig={}
  for rig,d in pairs(durations) do perRig[rig]={duration=d} end
  return {name=name,category=category,perRig=perRig,character=character}
end
local all={woman_base=3,man_base=3,man_big=3}
local clips={
  clip('a__talk__neutral__01','neutral',all),clip('a__talk__neutral__02','neutral',all),
  clip('a__talk__neutral__03','neutral',all),clip('a__shrug__01','shrug',{woman_base=2,man_base=2,man_big=2}),
  clip('a__what__happy__01','happy',all),clip('a__calm_down__happy__01','happy',{woman_base=6,man_base=6,man_big=6}),
  clip('a__whatever__sad__02','sad',all),clip('a__no__angry__01','angry',all),
  clip('a__threaten__angry__01','angry',all),clip('a__yes__head__01','nod',all),
  clip('takemura__talk__01','neutral',{man_base=3},'takemura'),
}
local function speak(s,t,extra)
  local input={now=t,mode='speaking',rig='woman_base',character='judy',family='neutral',scale=1,remaining=20,clips=clips}
  for k,v in pairs(extra or {}) do input[k]=v end
  return m.next(s,input)
end
local function run(s,seconds,extra)
  local played={}
  for t=0,seconds,.1 do
    local item=speak(s,t,extra)
    if item then played[#played+1]={at=t,name=item.clip.name,duration=item.duration} end
  end
  return played
end
`;

test('rude and strong gestures are never chosen, even when they are the only angry clip left', () => run(`
  for i=1,20 do
    local s=m.new(lcg)
    for _,p in ipairs(run(s,60,{family='anger',scale=3})) do assert(not p.name:find('threaten'),p.name) end
  end
  assert(not m.allowed('stand__2h_on_sides__01__fuck_you__angry__01'))
  assert(not m.allowed('stand__2h_on_sides__01__2h_clap__happy__01'))
  assert(not m.allowed('stand__2h_on_sides__01__thumb_up__happy__02'))
  assert(m.allowed('stand__2h_on_sides__01__talk__neutral__01'))
`));

test('emotion colours speech: joy plays happy clips mixed with calm talk', () => run(`
  local happy,calm=0,0
  for i=1,30 do
    local s=m.new(lcg)
    for _,p in ipairs(run(s,40,{family='joy',scale=2})) do
      if p.name:find('happy') then happy=happy+1 elseif p.name:find('neutral') or p.name:find('shrug') then calm=calm+1 end
    end
  end
  assert(happy>0 and calm>0,'happy='..happy..' calm='..calm)
`));

test('never repeats the previous clip and spreads clips through history', () => run(`
  local s=m.new(lcg)
  local played=run(s,120)
  assert(#played>8)
  for i=2,#played do assert(played[i].name~=played[i-1].name,'immediate repeat '..played[i].name) end
`));

test('clips start only after the previous one ends plus a gap, first one shortly after speech starts', () => run(`
  local s=m.new(lcg)
  local played=run(s,60)
  assert(played[1].at>=.1 and played[1].at<=.5,'first at '..played[1].at)
  for i=2,#played do
    local gap=played[i].at-(played[i-1].at+played[i-1].duration)
    assert(gap>=.6-1e-6 and gap<=1.7,'gap '..gap..' at '..i)
  end
`));

test('higher intensity gestures more often; Takemura gestures less than Johnny', () => run(`
  local function count(extra) local n=0;for i=1,10 do n=n+#run(m.new(lcg),60,extra) end;return n end
  local calm,intense=count({scale=1}),count({scale=3})
  assert(intense>calm,'scale 3 '..intense..' vs scale 1 '..calm)
  local takemura=count({rig='man_base',character='takemura'})
  local johnny=count({rig='man_base',character='johnny'})
  assert(johnny>takemura,'johnny '..johnny..' takemura '..takemura)
`));

test('a clip must fit the remaining speech; nothing starts in the last second', () => run(`
  local s=m.new(lcg)
  for t=0,2,.1 do
    local item=speak(s,t,{remaining=3,family='joy'})
    if item then assert(item.duration*.7<=3,item.clip.name) end
  end
  local s2=m.new(lcg)
  for t=0,3,.1 do assert(speak(s2,t,{remaining=1})==nil) end
`));

test('short replies never gesture; long replies do', () => run(`
  local s=m.new(lcg)
  for t=0,4,.1 do assert(speak(s,t,{total=4,remaining=4-t})==nil,'short reply gestured') end
  local s2=m.new(lcg)
  local n=0
  for t=0,8,.1 do if speak(s2,t,{total=8,remaining=8-t}) then n=n+1 end end
  assert(n>=1,'long reply should gesture')
`));

test('rig and character availability: Takemura clips only for Takemura on man_base', () => run(`
  for i=1,10 do
    for _,p in ipairs(run(m.new(lcg),60,{rig='man_base',character='johnny'})) do assert(not p.name:find('takemura'),p.name) end
  end
  local seen=false
  for i=1,10 do
    for _,p in ipairs(run(m.new(lcg),60,{rig='man_base',character='takemura'})) do if p.name:find('takemura') then seen=true end end
  end
  assert(seen,'Takemura should use his own clip')
  for _,p in ipairs(run(m.new(lcg),60,{rig='woman_base',character='takemura'})) do assert(not p.name:find('takemura')) end
`));

test('listening only nods, sparsely; thinking and idle never gesture', () => run(`
  local s=m.new(lcg)
  local nods={}
  for t=0,40,.1 do
    local item=m.next(s,{now=t,mode='listening',rig='woman_base',character='judy',clips=clips})
    if item then assert(item.clip.category=='nod');nods[#nods+1]=t end
  end
  assert(#nods>=2 and nods[1]>=2 and nods[1]<=4.1,'first nod '..tostring(nods[1]))
  for i=2,#nods do assert(nods[i]-nods[i-1]>=5,'nods too close') end
  local t2=m.new(lcg)
  for t=0,20,.1 do
    assert(m.next(t2,{now=t,mode='thinking',rig='woman_base',clips=clips})==nil)
    assert(m.next(t2,{now=t,mode='idle',rig='woman_base',clips=clips})==nil)
  end
`));

test('the generated catalog works with the policy for every rig and maps signature idles', () => run(`
  local families=catalog.families or {on_sides={rigs=catalog.rigs,clips=catalog.clips}}
  for name,family in pairs(families) do
    for _,rig in ipairs(family.rigs) do
      local s=m.new(lcg)
      local n=0
      local who=(name=='kerry' or name=='takemura' or name=='johnny') and name or (name:match('^(%a+)_own$') or 'judy')
      for t=0,60,.1 do
        local item=m.next(s,{now=t,mode='speaking',rig=rig,character=who,family='sadness',scale=2,remaining=30,clips=family.clips})
        if item then n=n+1;assert(item.clip.perRig[rig],'clip not on rig');assert(item.clip.category~='idlebreak') end
      end
      assert(n>3,name..'/'..rig..' played '..n)
    end
  end
  assert(m.idleComponent(catalog,'johnny')=='convai_idle_johnny')
  assert(m.idleComponent(catalog,'river')=='convai_idle_generic')
`));

test('talk favours expressive hand gestures over head flicks and nods', () => run(`
  assert(m.expressiveness('stand__arms_crossed_front__01__describe_down__01')>m.expressiveness('stand__arms_crossed_front__01__head_flick_down__02'))
  assert(m.expressiveness('judy__stand_2h_arms_crossed__01__gesture__01')>1)
  local expressiveClips={
    clip('b__head_flick_down__01','neutral',all),clip('b__head_flick_up__01','neutral',all),
    clip('b__describe_left__01','neutral',all),clip('b__talk_explain__01','neutral',all),clip('b__shrug__01','shrug',all),
    clip('b__describe_down__01','neutral',all),clip('b__talk__neutral__01','neutral',all),clip('b__talk__neutral__02','neutral',all),
    clip('b__point__01','neutral',all),clip('b__what__neutral__01','question',all)}
  local expressive,subtle=0,0
  for i=1,20 do
    local s=m.new(lcg)
    for t=0,30,.1 do
      local item=m.next(s,{now=t,mode='speaking',rig='woman_base',character='judy',family='neutral',scale=2,remaining=30,total=30,clips=expressiveClips})
      if item then if item.clip.name:find('head_flick') then subtle=subtle+1 else expressive=expressive+1 end end
    end
  end
  assert(expressive>subtle*3,'expressive '..expressive..' subtle '..subtle)
`));

test('a ten-second reply gets several gestures, not two', () => run(`
  local n=0
  for i=1,10 do
    local s=m.new(lcg)
    for t=0,10,.1 do
      if m.next(s,{now=t,mode='speaking',rig='woman_base',character='judy',family='neutral',scale=1,remaining=10-t,total=10,clips=clips}) then n=n+1 end
    end
  end
  assert(n/10>=2.0,'average '..(n/10))
`));

test('measured hand reach drives the choice: clips under 15 cm are almost never used', () => run(`
  local function reachClip(name,reach) local c=clip(name,'neutral',all);c.perRig.woman_base.reach=reach;return c end
  local pool={reachClip('c__head_flick__01',2),reachClip('c__lh_flick__01',4),reachClip('c__describe_left__02',74),
    reachClip('c__describe_right__01',59),reachClip('c__talk__neutral__10',40),reachClip('c__what__neutral__03',50),
    reachClip('c__describe_down__02',46),reachClip('c__describe_up__01',38),reachClip('c__lh_flick__05',42),reachClip('c__talk__neutral__09',39),
    reachClip('c__describe_front__02',48),reachClip('c__what_is_this__neutral__02',42)}
  local big,small=0,0
  for i=1,20 do
    local s=m.new(lcg)
    for t=0,30,.1 do
      local item=m.next(s,{now=t,mode='speaking',rig='woman_base',character='judy',family='neutral',scale=2,remaining=30,total=30,clips=pool})
      if item then if (item.clip.perRig.woman_base.reach or 0)<15 then small=small+1 else big=big+1 end end
    end
  end
  assert(big>small*8,'big '..big..' small '..small)
`));

test('symbolic gestures are never chosen: Judy gesture 02 (thumbs-up), measured symbolic clips, strong names', () => run(`
  assert(not m.allowed('judy__stand_2h_arms_crossed__01__gesture__02'))
  assert(m.allowed('judy__stand_2h_arms_crossed__01__gesture__03'))
  for _,name in ipairs({'stand__arms_crossed_front__01__go_away__angry__02','stand__2h_on_sides__01__salute__01','stand__arms_crossed_front__01__draw_gun__01','stand__arms_crossed_front__01__be_quiet__angry__03'}) do
    assert(not m.allowed(name),name)
  end
  local pool={clip('d__talk__neutral__01','neutral',all),clip('d__describe__01','neutral',all)}
  pool[2].symbolic=true
  for t=0,30,.1 do
    local item=m.next(m.new(lcg),{now=t,mode='speaking',rig='woman_base',character='judy',family='neutral',scale=2,remaining=30,total=30,clips=pool})
    if item then assert(item.clip.name~='d__describe__01','measured symbolic clip chosen') end
  end
`));
