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
  if not name:find('__%d%d__') then name='st__01__'..name end
  return {name=name,category=category,perRig=perRig,character=character}
end
local all={woman_base=3,man_base=3,man_big=3}
local clips={
  clip('a__talk__neutral__01','neutral',all),clip('a__talk__neutral__02','neutral',all),
  clip('a__talk__neutral__03','neutral',all),clip('a__shrug__01','shrug',{woman_base=2,man_base=2,man_big=2}),
  clip('a__what__happy__01','happy',all),clip('a__calm_down__happy__01','happy',{woman_base=6,man_base=6,man_big=6}),
  clip('a__whatever__sad__02','sad',all),clip('a__no__angry__01','angry',all),
  clip('a__threaten__angry__01','angry',all),clip('a__yes__head__01','nod',all),
  clip('takemura__talk__01','neutral',{man_base=3},'takemura'),clip('a__describe_down__01','neutral',all),
  clip('a__lh_flick__01','neutral',all),clip('a__what__neutral__01','question',all),clip('a__shrug__02','shrug',all),
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

test('clips start only after the previous one ends plus a calm hold, first one shortly after speech starts', () => run(`
  local s=m.new(lcg)
  local played=run(s,60)
  assert(played[1].at>=.1 and played[1].at<=.5,'first at '..played[1].at)
  for i=2,#played do
    local gap=played[i].at-(played[i-1].at+played[i-1].duration)
    assert(gap>=m.holds[1][1]-1e-6 and gap<=m.holds[1][2]+1.15,'calm hold '..gap..' at '..i)
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
      if family.idle.name=='idle_stand' and rig~='man_big' then
        -- An ambient loop is 25-40 cm from every interactive-scene clip's feet: the leg gate rejects all of them (Oct 12).
        assert(n==0,name..'/'..rig..' plays clips from an ambient idle_stand loop: '..n)
      else
        assert(n>3,name..'/'..rig..' played '..n)
      end
    end
  end
  assert(m.idleComponent(catalog,'johnny')=='convai_idle_johnny')
  assert(m.idleComponent(catalog,'river')=='convai_idle_river')
  assert(m.idleComponent(catalog,'nobody')=='convai_idle_generic')
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
  assert(n/10>=1.8,'average '..(n/10))
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

test('arm-overhead sweeps (demonstrate, 100 cm+) never play as talk', () => run(`
  assert(not m.allowed('stand__2h_on_sides__01__demonstrate_positive__08'))
  local function reachClip(name,reach) local c=clip(name,'neutral',all);c.perRig.woman_base.reach=reach;return c end
  local pool={reachClip('e__wave__01',105),reachClip('e__talk__neutral__07',45),reachClip('e__what__neutral__02',55),
    reachClip('e__describe__01',60),reachClip('e__talk__neutral__08',40),reachClip('e__describe__02',50)}
  local overhead=0
  for i=1,10 do
    local s=m.new(lcg)
    for t=0,30,.1 do
      local item=m.next(s,{now=t,mode='speaking',rig='woman_base',character='judy',family='neutral',scale=2,remaining=30,total=30,clips=pool})
      if item and item.clip.name=='e__wave__01' then overhead=overhead+1 end
    end
  end
  assert(overhead<=2,'overhead clip chosen '..overhead..' times')
`));

test('clips whose lower body does not match the stance loop never play (leg crossing)', () => run(`
  local function legClip(name,legs) local c=clip(name,'neutral',all);c.perRig.woman_base.legs=legs;return c end
  local pool={legClip('f__talk__neutral__07',26),legClip('f__talk__neutral__09',2),legClip('f__describe__01',1),legClip('f__what__01',3)}
  for i=1,10 do
    local s=m.new(lcg)
    for t=0,30,.1 do
      local item=m.next(s,{now=t,mode='speaking',rig='woman_base',character='judy',family='neutral',scale=2,remaining=30,total=30,clips=pool})
      if item then assert(item.clip.name~='f__talk__neutral__07','leg-mismatched clip played') end
    end
  end
`));

// Oct 9 (Judy feedback): repeats, pointing, fit to the line.
const judy = `
local fam=catalog.families.arms_crossed
local function judyRun(s,seconds,extra)
  local played={}
  for t=0,seconds,.1 do
    local input={now=t,mode='speaking',rig='woman_base',character='judy',family='neutral',scale=2,remaining=200,total=200,clips=fam.clips}
    for k,v in pairs(extra or {}) do input[k]=v end
    local item=m.next(s,input)
    if item then played[#played+1]={at=t,name=item.clip.name,kind=m.kind(item.clip),clip=item.clip,duration=item.duration} end
  end
  return played
end
`;

test('never the same clip twice in a row, speaking or listening, with the real catalog', () => run(judy + `
  for _,family in ipairs({'neutral','joy','sadness','anger','fear','surprise','disgust','trust'}) do
    for seedRun=1,4 do
      local played=judyRun(m.new(lcg),180,{family=family})
      assert(#played>=10,family..' played '..#played)
      for i=2,#played do assert(played[i].name~=played[i-1].name,'immediate repeat '..played[i].name) end
    end
  end
  local s=m.new(lcg);local previous
  for t=0,300,.1 do
    local item=m.next(s,{now=t,mode='listening',rig='woman_base',character='judy',clips=fam.clips})
    if item then assert(item.clip.name~=previous,'nod repeated '..item.clip.name);previous=item.clip.name end
  end
`));

test('no clip repeats within the last four, and no gesture kind twice running', () => run(judy + `
  for seedRun=1,6 do
    local played=judyRun(m.new(lcg),240)
    for i=2,#played do
      for back=1,math.min(4,i-1) do assert(played[i].name~=played[i-back].name,'repeat within '..back..': '..played[i].name) end
      assert(played[i].kind~=played[i-1].kind,'same kind twice running: '..played[i].kind)
    end
  end
  assert(m.kind({name='stand__arms_crossed_front__01__yes__happy__02'})=='yes')
  assert(m.kind({name='judy__stand_2h_arms_crossed__01__gesture__03'})=='gesture')
`));

test('a tiny pool alternates instead of repeating; a one-clip pool may repeat', () => run(`
  local pool={clip('a__yes__happy__01','neutral',all),clip('a__yes__happy__02','neutral',all)}
  local s=m.new(lcg);local played={}
  for t=0,90,.1 do
    local item=m.next(s,{now=t,mode='speaking',rig='woman_base',character='judy',family='neutral',scale=1,remaining=90,total=90,clips=pool})
    if item then played[#played+1]=item.clip.name end
  end
  assert(#played>=6)
  for i=2,#played do assert(played[i]~=played[i-1],'two-clip pool repeated') end
  local one={clip('a__talk__neutral__01','neutral',all)}
  local s2=m.new(lcg);local n=0
  for t=0,40,.1 do
    if m.next(s2,{now=t,mode='speaking',rig='woman_base',character='judy',family='neutral',scale=1,remaining=40,total=40,clips=one}) then n=n+1 end
  end
  assert(n>=3,'one-clip pool still gestures: '..n)
`));

test('directional, pointing and turning clips are never chosen on any rig or mood', () => run(`
  local excluded,total=0,0
  for name,family in pairs(catalog.families) do
    for _,clip in ipairs(family.clips) do
      total=total+1
      if clip.exclude then excluded=excluded+1;assert(clip.fit~='centred' and clip.fit~='neutral',clip.name) end
    end
  end
  assert(excluded>0 and excluded<total,'catalog classification present: '..excluded..'/'..total)
  for name,family in pairs(catalog.families) do
    for _,rig in ipairs(family.rigs) do
      for _,mood in ipairs({'neutral','joy','anger','surprise','sadness'}) do
        local s=m.new(lcg)
        for t=0,90,.1 do
          local mode=(t>60) and 'listening' or 'speaking'
          local item=m.next(s,{now=t,mode=mode,rig=rig,character='judy',family=mood,scale=3,remaining=90,total=90,clips=family.clips})
          if item then
            assert(not item.clip.exclude,'excluded clip chosen: '..item.clip.name..' ('..tostring(item.clip.exclude)..')')
            for _,word in ipairs({'point','describe_left','describe_right','describe_back','head_flick_left','head_flick_right','look_around'}) do
              assert(not item.clip.name:find(word,1,true),'directional clip chosen: '..item.clip.name)
            end
          end
        end
      end
    end
  end
  assert(m.excluded({name='x__01__point_back__01'}) and m.excluded({name='x__01__talk__01',exclude='turns'}))
  assert(not m.excluded({name='x__01__talk__neutral__01'}))
`));

test('short replies get no gesture at all, with or without phrase timing', () => run(`
  for _,total in ipairs({1.5,3,4.9}) do
    local s=m.new(lcg)
    for t=0,total,.1 do
      assert(m.next(s,{now=t,mode='speaking',rig='woman_base',character='judy',family='joy',scale=3,
        remaining=total-t,total=total,phraseAt=0,phraseAge=t,clips=clips})==nil,'short reply of '..total..' s gestured')
    end
  end
`));

test('gestures land on phrase starts when phrase timing is known', () => run(`
  local phrases={0,3.2,7.9,11.5,16.0,19.4,24.1,28.0}
  for seedRun=1,5 do
    local s=m.new(lcg);local starts=0
    for t=0,30,.1 do
      local at=0
      for _,p in ipairs(phrases) do if p<=t+1e-9 then at=p end end
      local item=m.next(s,{now=t,mode='speaking',rig='woman_base',character='judy',family='neutral',scale=2,
        remaining=30-t,total=30,phraseAt=at,phraseAge=t-at,clips=clips})
      if item then starts=starts+1;assert(t-at<=m.phraseWindow+1e-6,'gesture '..(t-at)..' s into a phrase') end
    end
    assert(starts>=3,'gestured at '..starts..' phrase starts')
  end
`));

test('the mood sets the energy: sad lines never get happy, emphatic or big clips', () => run(judy + `
  local cap=m.energy.sadness+m.energyStep
  for seedRun=1,6 do
    for _,p in ipairs(judyRun(m.new(lcg),120,{family='sadness',scale=2})) do
      local row=p.clip.perRig.woman_base
      assert(p.clip.category~='happy' and p.clip.category~='emphatic' and p.clip.category~='angry','sad got '..p.clip.category)
      assert(type(row.reach)~='number' or row.reach<=cap,'sad got a '..row.reach..' cm clip')
    end
    for _,p in ipairs(judyRun(m.new(lcg),120,{family='joy',scale=2})) do
      assert(p.clip.category~='sad' and p.clip.category~='fear','joy got '..p.clip.category)
    end
  end
`));

test('centred clips are preferred over clips that leave the body centre', () => run(`
  local function shaped(name,centre) local c=clip(name,'neutral',all);c.perRig.woman_base.reach=30;c.perRig.woman_base.centre=centre;return c end
  local pool={shaped('g__talk__neutral__01',1),shaped('g__what__neutral__01',1),shaped('g__describe_down__01',1),
    shaped('g__lh_flick__01',.1),shaped('g__rh_flick__01',.1),shaped('g__this_or_that__01',.1)}
  local centred,wide=0,0
  for i=1,20 do
    local s=m.new(lcg)
    for t=0,60,.1 do
      local item=m.next(s,{now=t,mode='speaking',rig='woman_base',character='judy',family='neutral',scale=2,remaining=60,total=60,clips=pool})
      if item then if item.clip.perRig.woman_base.centre>.5 then centred=centred+1 else wide=wide+1 end end
    end
  end
  assert(centred>wide*1.5,'centred '..centred..' wide '..wide)
`));

test('look-alike moves (flicks, describes, talk) do not run back to back, and memory carries across replies', () => run(`
  assert(m.group({name='st__01__rh_flick__02'})=='flick' and m.group({name='st__01__describe_down__01'})=='describe')
  assert(m.group({name='st__01__talk__neutral__03'})=='talk' and m.group({name='st__01__what__neutral__01'})=='what')
  assert(m.hand({name='st__01__rh_flick__02'})=='r' and m.hand({name='st__01__2h_flick__01'})=='b')
  local pool={}
  for i=1,3 do pool[#pool+1]=clip('rh_flick__0'..i,'neutral',all);pool[#pool+1]=clip('describe_down__0'..i,'neutral',all) end
  for i=1,3 do pool[#pool+1]=clip('talk__neutral__0'..i,'neutral',all) end
  pool[#pool+1]=clip('what__neutral__01','question',all);pool[#pool+1]=clip('shrug__01','shrug',all)
  local sameGroup,total=0,0
  for run=1,12 do
    local s=m.new(lcg);local last
    -- twelve separate replies on one companion: the state is kept between them
    for reply=1,12 do
      for t=0,16,.1 do
        local item=m.next(s,{now=reply*100+t,mode='speaking',rig='woman_base',character='judy',family='neutral',scale=2,remaining=16-t,total=16,
          reply=reply,clips=pool})
        if item then
          assert(item.clip.name~=last,'repeat across replies '..item.clip.name)
          local group=m.group(item.clip)
          if last and group==m.group({name=last}) then sameGroup=sameGroup+1 end
          total=total+1;last=item.clip.name
        end
      end
    end
  end
  assert(total>100)
  assert(sameGroup<total*.25,'look-alike back to back '..sameGroup..'/'..total)
`));

test('a mood with two clips of its own is mixed into calm talk and never repeats one of them straight away', () => run(`
  local pool={clip('what__happy__01','happy',all),clip('calm_down__happy__01','happy',all)}
  for i=1,6 do pool[#pool+1]=clip('talk__neutral__0'..i,'neutral',all) end
  local own,calm=0,0
  for run=1,12 do
    local s=m.new(lcg);local last
    for reply=1,10 do
      for t=0,16,.1 do
        local item=m.next(s,{now=reply*100+t,mode='speaking',rig='woman_base',character='judy',family='joy',scale=3,remaining=16-t,total=16,reply=reply,clips=pool})
        if item then
          assert(item.clip.name~=last,'repeat '..item.clip.name);last=item.clip.name
          if item.clip.category=='happy' then own=own+1 else calm=calm+1 end
        end
      end
    end
  end
  assert(own>0 and calm>own*.3,'own '..own..' calm '..calm)
  assert(own<(own+calm)*.8,'colour swamps the calm talk: own '..own..' calm '..calm)
`));

test('clips that hold a hand out to the side (fit open) are used, but less often than centred ones', () => run(`
  local function shaped(name,fit) local c=clip(name,'neutral',all);c.fit=fit;c.perRig.woman_base.reach=30;c.perRig.woman_base.centre=.8;return c end
  local pool={shaped('talk__neutral__01'),shaped('what__neutral__01'),shaped('shrug__01'),shaped('lh_flick__01'),
    shaped('talk__neutral__02','open'),shaped('what__neutral__02','open'),shaped('shrug__02','open'),shaped('rh_flick__02','open')}
  local open,plain=0,0
  for run=1,30 do
    local s=m.new(lcg)
    for t=0,60,.1 do
      local item=m.next(s,{now=t,mode='speaking',rig='woman_base',character='judy',family='neutral',scale=2,remaining=60,total=60,clips=pool})
      if item then if item.clip.fit=='open' then open=open+1 else plain=plain+1 end end
    end
  end
  assert(open>0,'open clips never used')
  assert(open<plain,'open '..open..' plain '..plain)
`));

test('the first clip waits for busyUntil (the enter blend into the stance), then lands on the next phrase start', () => run(`
  local s=m.new(lcg)
  local first
  for t=0,30,.1 do
    local item=m.next(s,{now=t,mode='speaking',rig='woman_base',character='judy',family='neutral',scale=2,remaining=30-t,total=30,clips=clips,busyUntil=1.65})
    if item then first=t;break end
  end
  assert(first and first>=1.65,'first clip at '..tostring(first))
`));
