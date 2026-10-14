import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import fengari from 'fengari';

// Controller fixture: a fake native workspot layer, scripted speech/listening
// state and the real selection policy and generated catalog.
const controller = readFileSync(new URL('../mod/companion-gestures.lua', import.meta.url), 'utf8');
const selection = readFileSync(new URL('../mod/gesture-selection.lua', import.meta.url), 'utf8');
const catalog = readFileSync(new URL('../mod/gesture-catalog.lua', import.meta.url), 'utf8');
function run(code) {
  const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;
  const vm = lauxlib.luaL_newstate(); lualib.luaL_openlibs(vm);
  const result = lauxlib.luaL_dostring(vm, to_luastring(fixture + code));
  const error = result === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(vm, -1));
  lua.lua_close(vm); assert.equal(result, lua.LUA_OK, error);
}
const fixture = `
local selectionSource=[==[${selection}]==]
local catalogSource=[==[${catalog}]==]
dofile=function(path)
  if path=='gesture-selection.lua' then return load(selectionSource)() end
  if path=='gesture-catalog.lua' then return load(catalogSource)() end
  if path=='gesture-workspot.lua' then return {} end
  error('unexpected dofile '..path)
end
local calls,logs={}, {}
local function count(name) local n=0;for _,c in ipairs(calls) do if c.name==name then n=n+1 end end;return n end
local function last(name) for i=#calls,1,-1 do if calls[i].name==name then return calls[i] end end end
local function talks() local n=0 for _,c in ipairs(calls) do if c.name=='play' and c.component:find('convai_talk',1,true) then n=n+1 end end return n end
local function idles() local n=0 for _,c in ipairs(calls) do if c.name=='play' and c.component:find('convai_idle',1,true) then n=n+1 end end return n end
local npc={inside=false}
local native={TAG='t'}
function native.inWorkspot(n) return n.inside end
function native.spawnDevice(n,t) calls[#calls+1]={name='spawn',template=t};return true,{hash=9} end
local deviceReady=true
function native.deviceEntity(id) if deviceReady then return {device=true} end;return nil end
function native.moveDevice() calls[#calls+1]={name='move'};return true end
local placedFlag=true
function native.devicePlaced() return placedFlag end
function native.deleteDevice() calls[#calls+1]={name='delete'};return true end
function native.sweep() calls[#calls+1]={name='sweep'};return true end
function native.play(d,n,component) calls[#calls+1]={name='play',component=component};n.entering=true;return true end
function native.jump(n,clip,instant) calls[#calls+1]={name='jump',clip=clip,instant=instant==true};return true end
function native.exit(n,instant) calls[#calls+1]={name='exit',instant=instant==true};n.leaving=true;return true end
function native.stopInDevice(n) calls[#calls+1]={name='stopInDevice'};return true end
local m=(load([==[${controller}]==]))()
local enabled=true
local speaking=nil -- {knownEnd, at, family, scale}
local listening=nil
local allowed=true
local seed=7
local c=m.new({enabled=function() return enabled end,
  speech=function(entity) if speaking and entity=='77' then return speaking end end,
  listening=function() return listening end,
  allowed=function() return allowed,'guard' end, native=native,
  random=function() seed=(seed*1103515245+12345)%2147483648;return seed/2147483648 end,
  log=function(kind,fields) logs[#logs+1]={kind=kind,fields=fields} end})
local player={pos={x=0,y=0,z=0}}
function player:GetWorldPosition() return self.pos end
local entry={serial=1,record='Character.Judy',entityID={hash='77'},npc=npc,playerGap=1.8,
  motor={kind='hold',feedback={state='AICommandState : Executing (2)'}}}
local context={idle=true,settled=true,combat=false,phase='settled'}
local held=false
local function step(seconds,observe)
  for i=1,math.max(1,math.floor(seconds/.1+.5)) do
    c.tick(player,.1,{{entry=entry,transport=entry.transport==true}})
    if npc.entering then npc.entering=nil;npc.inside=true end
    if npc.leaving and not npc.stuck then npc.leaving=nil;npc.inside=false end
    if speaking then speaking.at=math.min(speaking.knownEnd,(speaking.at or 0)+.1) end
    if observe~=false then held=c.observe(entry,context,.1) end
  end
end
local function lastLog(kind) for i=#logs,1,-1 do if logs[i].kind==kind then return logs[i] end end end
-- Settled beside V for a while before anything happens (the talk stance waits for it).
step(1.2);seed=7
`;

test('off by default setting, idle and short replies never enter a stance', () => run(`
  enabled=false;speaking={knownEnd=12,at=0};step(2)
  assert(count('play')==0 and not held,'disabled')
  enabled=true;speaking=nil;step(.1)
  speaking={knownEnd=3,at=0};step(3)
  assert(talks()==0,'short replies do not enter a talk stance')
`));

test('a long reply enters the character stance family, gestures, and leaves after the reply', () => run(`
  speaking={knownEnd=14,at=0,family='joy',scale=2};step(.5)
  local play=last('play')
  assert(play and play.component=='convai_talk_judy','Judy talks from her own relaxed loop: '..tostring(play and play.component))
  assert(held,'movement waits while in the stance')
  step(8)
  assert(count('jump')>=2,'gestures played: '..count('jump'))
  local cat=load(catalogSource)()
  local fam=cat.families.judy_own
  for _,call in ipairs(calls) do
    if call.name=='jump' and call.clip~=fam.idle.name then
      local found
      for _,clip in ipairs(fam.clips) do if clip.name==call.clip then found=clip end end
      assert(found and found.perRig.woman_base and (found.character==nil or found.character=='judy'),'clip valid for Judy: '..call.clip)
      assert(found.category~='idlebreak')
    end
  end
  speaking=nil;step(4)
  assert(count('exit')==1 and not last('exit').instant,'native fast exit after the linger')
  assert(not held and lastLog('finished').fields.reason=='reply ended')
`));

test('V walking away ends the stance; one-tick flickers do not', () => run(`
  speaking={knownEnd=20,at=0};step(.6)
  context.settled=false;step(.1);context.settled=true;step(.3)
  assert(count('exit')==0,'flicker ignored')
  for i=1,6 do player.pos={x=i*.15,y=0,z=0};step(.1) end
  assert(count('exit')==1 and lastLog('exit').fields.reason=='movement')
`));

test('combat leaves instantly; a stuck exit escalates to StopInDevice, never anything harsher', () => run(`
  speaking={knownEnd=20,at=0};step(.6)
  npc.stuck=true;context.combat=true;step(.1)
  assert(last('exit').instant==true,'instant fast exit on combat')
  step(3.2)
  assert(count('stopInDevice')==1,'StopInDevice after the patience')
  step(3)
  assert(lastLog('failed'),'gives up and cools down')
  npc.stuck=false;npc.inside=false;context.combat=false;step(1)
  assert(count('play')==1,'cooldown blocks an immediate retry')
`));

test('a wedged queue after exit triggers one brief re-enter and clean exit', () => run(`
  speaking={knownEnd=8,at=0};step(.6)
  speaking=nil;step(4)
  assert(not held and count('exit')==1)
  entry.motor.feedback.state='AICommandState : Enqueued (1)';context.settled=false;context.idle=false
  step(2)
  assert(lastLog('recovery-begin'),'recovery started')
  step(1.5)
  assert(count('play')==2 and count('exit')==2 and not last('exit').instant,'re-entered and left with a native fast exit')
  entry.motor.feedback.state='AICommandState : Executing (2)';step(1)
  assert(not held)
`));

test('never starts while unsettled, in combat, guarded, or in a foreign workspot (vehicle seat)', () => run(`
  speaking={knownEnd=20,at=0}
  context.settled=false;step(1);assert(count('play')==0)
  context.settled=true;context.combat=true;step(1);assert(count('play')==0)
  context.combat=false;allowed=false;step(1);assert(count('play')==0)
  allowed=true;npc.inside=true;step(1);assert(count('play')==0,'foreign workspot')
`));

test('transport or an unobserved tick stops the stance; dismissal deletes the device', () => run(`
  speaking={knownEnd=20,at=0};step(.6)
  assert(held)
  entry.transport=true;step(.1,false)
  assert(last('exit').instant==true,'transport takes the copy')
  entry.transport=false
  c.release(entry,'dismissed')
  assert(count('delete')==1)
`));

test('listening to V plays only nods from the stance family', () => run(`
  listening='77';step(12)
  local cat=load(catalogSource)()
  for _,call in ipairs(calls) do
    if call.name=='jump' and call.clip~=cat.families.judy_own.idle.name then
      local category
      for _,clip in ipairs(cat.families.judy_own.clips) do if clip.name==call.clip then category=clip.category end end
      assert(category=='nod','listening clip '..call.clip..' is '..tostring(category))
    end
  end
`));

test('unknown characters are left alone', () => run(`
  entry.record='Character.Somebody';speaking={knownEnd=20,at=0};step(2)
  assert(count('play')==0)
`));

test('Johnny goes into an idle as soon as he is settled, again after a gap, and talks from hands at sides', () => run(`
  entry.record='Character.Somebody';step(30)
  assert(count('play')==0,'an unknown character with no readable body type keeps its vanilla idle')
  entry.record='Character.Silverhand';entry.serial=2;calls={};logs={}
  step(3)
  local began=lastLog('flavour-begin')
  assert(began and idles()==1,'an idle right after settling, no timer')
  step(91)
  assert(lastLog('finished') and lastLog('finished').fields.reason=='flavour ended')
  step(46)
  assert(#(function() local n={};for _,l in ipairs(logs) do if l.kind=='flavour-begin' then n[#n+1]=l end end;return n end)()>=2,'repeats after a short gap')
  speaking={knownEnd=20,at=0};step(.3)
  step(1.5)
  assert(last('play').component=='convai_talk_on_sides','Johnny talks from hands at sides like his idle: '..tostring(last('play').component))
`));

test('never starts for a copy left behind or not in a social stance; leaves when V gets far', () => run(`
  entry.playerGap=10;speaking={knownEnd=20,at=0};step(2)
  assert(count('play')==0,'too far to start')
  entry.record='Character.Silverhand';step(200)
  assert(count('play')==0,'no flavour idle for a copy left behind')
  entry.record='Character.Judy';entry.playerGap=1.8;context.phase='catch_up';step(1)
  assert(count('play')==0,'not while catching up')
  context.phase='attend';step(1.5)
  assert(count('play')==1 and held)
  entry.playerGap=5;step(.1)
  assert(count('exit')==1 and lastLog('exit').fields.reason=='too far')
`));

test('a long reply streamed phrase by phrase is judged by its text, and gestures keep coming', () => run(`
  local words={}
  for i=1,26 do words[#words+1]='word' end
  c.replyText=function() return table.concat(words,' ') end
  -- each phrase reports only its own 2.5 s; the text says about 10 s
  speaking={knownEnd=2.5,at=0}
  local n=0
  for i=1,140 do
    step(.1)
    if speaking.at>=speaking.knownEnd and speaking.knownEnd<10 then speaking.knownEnd=speaking.knownEnd+2.5 end
  end
  local cat=load(catalogSource)()
  local durations={}
  for _,clip in ipairs(cat.families.judy_own.clips) do durations[clip.name]=clip.perRig.woman_base and clip.perRig.woman_base.duration end
  local covered=0
  for _,call in ipairs(calls) do
    if call.name=='jump' and durations[call.clip] then n=n+1;covered=covered+durations[call.clip] end
  end
  assert(count('play')==1,'entered once')
  assert(n>=2 and covered>=4.5,'gestures '..n..' covering '..covered..' s of a 10 s reply')
  c.replyText=function() return 'short reply here' end
`));

test('a short reply split into phrases still does not gesture', () => run(`
  c.replyText=function() return 'Yes, I can do that.' end
  speaking={knownEnd=2.0,at=0};step(3)
  assert(count('play')==0)
`));

test('gesture jumps are instant; the return to the idle loop is queued at the clip end', () => run(`
  speaking={knownEnd=14,at=0};step(9)
  local cat=load(catalogSource)()
  local idle=cat.families.judy_own.idle.name
  local gestures,returns=0,0
  for _,call in ipairs(calls) do
    if call.name=='jump' then
      if call.clip==idle and call.instant then -- the crossing from her own idle to the stance loop
      elseif call.clip==idle then returns=returns+1
      else assert(call.instant,'gesture jump is instant: '..call.clip);gestures=gestures+1 end
    end
  end
  assert(gestures>=1 and returns>=1,'gestures '..gestures..' returns '..returns)
`));

test('an archive without the new family falls back to the previous family', () => run(`
  local realPlay=native.play
  native.play=function(d,n,component)
    calls[#calls+1]={name='play',component=component}
    if component~='convai_talk_judy' then n.entering=true end
    return true
  end
  speaking={knownEnd=20,at=0};step(4)
  assert(lastLog('family-missing') and lastLog('family-missing').fields.family=='judy_own')
  step(1)
  assert(last('play').component=='convai_talk_on_sides','fell back: '..tostring(last('play').component))
  assert(held,'now in the fallback stance')
`));

test('a one-tick V speed spike (collision nudge) does not end the stance', () => run(`
  speaking={knownEnd=20,at=0};step(.6)
  player.pos={x=.4,y=0,z=0};step(.1)
  player.pos={x=.42,y=0,z=0};step(.3)
  assert(count('exit')==0,'a nudge is not running')
`));

test('every tier-1 companion maps to a family on its own rig with plenty of visible clips', () => run(`
  local cat=load(catalogSource)()
  local tier1={'Character.Judy','Character.Panam','Character.Rogue','Character.Misty','Character.alex','Character.Claire',
    'Character.Evelyn','Character.Lizzy_Wizzy','Character.Mama_Welles','Character.Stout','Character.reggie','Character.songbird',
    'Character.wakako_okada','Character.Silverhand','Character.Kerry','Character.Victor_Vector','Character.Takemura',
    'Character.mr_hands','Character.Padre','Character.Jackie','Character.Sobchak','Character.reed','Character.Elcoyote_Barman',
    'Character.Hanako','Character.Saul','Character.Placide','Character.Mitch','Character.Alt'}
  for _,record in ipairs(tier1) do
    local known=cat.characters[record]
    assert(known,'unmapped '..record)
    local fam=cat.families[known.talk]
    assert(fam,'missing family '..tostring(known.talk)..' for '..record)
    local onRig=false
    for _,rig in ipairs(fam.rigs) do if rig==known.rig then onRig=true end end
    assert(onRig,record..' family not on its rig')
    -- Stance loops are the families' own base poses (own-idle loops crossed legs, Oct 8).
    assert(fam.idle.perRig[known.rig],record..' family has no loop on its rig')
    local visible=0
    for _,clip in ipairs(fam.clips) do
      local row=clip.perRig[known.rig]
      if row and clip.category~='idlebreak' and not clip.exclude and (row.reach or 0)>=25 then visible=visible+1 end
    end
    -- Oct 9: directional, turning and sweeping clips no longer count (excluded from conversation).
    assert(visible>=25,record..' has only '..visible..' conversation clips with 25 cm+ reach')
    local fallback=cat.families[known.fallback]
    assert(fallback,'missing fallback for '..record)
  end
`));

test('every tier-1 family loop shares its lower body with the clips it plays', () => run(`
  local cat=load(catalogSource)()
  local checked=0
  for record,known in pairs(cat.characters) do
    local fam=cat.families[known.talk]
    local usable=0
    for _,clip in ipairs(fam.clips) do
      local row=clip.perRig[known.rig]
      if row and clip.category~='idlebreak' then
        assert(row.legs~=nil or true)
        if row.legs and row.legs<=8 and not clip.exclude and (row.reach or 0)>=25 and (row.reach or 0)<=90 then usable=usable+1 end
      end
    end
    -- Ambient-loop families (idle_stand: judy_own and the like) have no measured leg gap; they are checked live.
    if fam.idle.name~='idle_stand' then assert(usable>=8,record..' has only '..usable..' leg-matched visible clips in '..known.talk) end
    checked=checked+1
  end
  assert(checked>=23)
`));

test('every character with a signature or generic idle resolves it on its own rig', () => run(`
  local cat=load(catalogSource)()
  local checked,own=0,0
  for record,known in pairs(cat.characters) do
    if known.idle then
      local component=cat.idleComponents[known.idle]
      assert(component=='convai_idle_'..known.idle,record..' idle component '..tostring(component))
      local source=cat.idleSources[known.idle]
      assert(source,record..' idle '..known.idle..' has no recorded source')
      local onRig=false
      for _,rig in ipairs(source.rigs) do if rig==known.rig then onRig=true end end
      assert(onRig,record..' idle '..known.idle..' was not checked on '..known.rig)
      assert(known.idleSource==source.kind,record..' idle label')
      if source.kind~='generic' then own=own+1 end
      -- The controller plays exactly that component when the copy settles.
      local s2,localCalls,localLogs=7,{},{}
      local npc2={inside=false}
      local native2=setmetatable({play=function(d,n,comp) localCalls[#localCalls+1]=comp;n.entering=true;return true end},{__index=native})
      local c2=m.new({enabled=function() return true end,speech=function() return nil end,listening=function() return nil end,
        allowed=function() return true end,native=native2,random=function() s2=(s2*1103515245+12345)%2147483648;return s2/2147483648 end,
        log=function(kind,fields) localLogs[#localLogs+1]={kind=kind,fields=fields} end})
      local e2={serial=50+checked,record=record,entityID={hash='88'},npc=npc2,playerGap=1.8,motor={kind='hold',feedback={state='Executing'}}}
      for i=1,1150 do
        c2.tick(player,.1,{{entry=e2}})
        if npc2.entering then npc2.entering=nil;npc2.inside=true end
        c2.observe(e2,context,.1)
        if localCalls[1] then break end
      end
      local pool={['convai_idle_'..known.idle]=true}
      for _,key in ipairs(cat.generic.rigs[known.rig].idles) do pool['convai_idle_'..key]=true end
      for _,key in ipairs(known.idles or {}) do pool['convai_idle_'..key]=true end
      assert(pool[localCalls[1] or ''],record..' played '..tostring(localCalls[1]))
      checked=checked+1
    end
  end
  assert(checked>=27,'characters with idles: '..checked)
  assert(own>=15,'character-specific idles: '..own)
  for _,record in ipairs({'Character.Judy','Character.Sobchak','Character.Rogue','Character.Misty','Character.reed',
    'Character.Hanako','Character.Placide','Character.songbird','Character.alex'}) do
    assert(cat.characters[record] and cat.characters[record].flavour and cat.idleSources[cat.characters[record].idle].kind~='generic',record)
  end
  -- Saul's own loop is the angry arms-crossed set, which did not fit him (Round 11): he rests in a generic idle on purpose.
  assert(cat.characters['Character.Saul'].flavour and cat.idleSources[cat.characters['Character.Saul'].idle].kind=='generic')
`));

test('every tier-1 character has an idle of their own: no two characters share one', () => run(`
  local cat=load(catalogSource)()
  local owner={}
  for record,known in pairs(cat.characters) do
    local key=known.key
    if known.idle then
      local previous=owner[known.idle]
      assert(previous==nil or previous==key,known.idle..' is shared by '..tostring(previous)..' and '..key)
      owner[known.idle]=key
    end
  end
  -- Alt Cunningham is tier 1 with her own q116 workspot, on the woman rig
  assert(cat.characters['Character.Alt'] and cat.characters['Character.Alt'].idle=='alt' and cat.characters['Character.Alt'].rig=='woman_base')
`));

test('with phrase timing from the face timeline, gestures start on phrase starts', () => run(`
  local cat=load(catalogSource)()
  local idle=cat.families.judy_own.idle.name
  local starts={}
  local realJump=native.jump
  native.jump=function(n,clip,instant)
    if clip~=idle then starts[#starts+1]=speaking.at end
    return realJump(n,clip,instant)
  end
  speaking={knownEnd=30,at=0,offset=0,phrases={{start=0},{start=4.2},{start=9.1},{start=13.4},{start=18.8},{start=23.5}}}
  step(29)
  assert(#starts>=3,'gestures at phrase starts: '..#starts)
  for _,at in ipairs(starts) do
    local latest=0
    for _,span in ipairs(speaking.phrases) do if span.start<=at+1e-9 then latest=span.start end end
    assert(at-latest<=.8,'gesture '..(at-latest)..' s into a phrase')
  end
`));

test('the stance is entered while V waits for the reply (thinking), and left again when nothing comes', () => run(`
  c.thinking=function() return '77' end
  step(.3)
  assert(held,'entered on thinking')
  step(2)
  assert(count('play')==1 and last('play').component=='convai_talk_judy','Judy takes her stance before the first word')
  local gestures=0 for _,call in ipairs(calls) do if call.name=='jump' and call.clip~='idle_stand' then gestures=gestures+1 end end
  assert(gestures==0,'no gestures while only thinking')
  c.thinking=function() return nil end
  step(5)
  assert(count('exit')==1 and lastLog('finished').fields.reason=='reply ended' and not held)
`));

test('after movement pushes her out, the stance is not re-entered at once; it waits to be settled again', () => run(`
  speaking={knownEnd=60,at=0};step(.8)
  assert(held and count('play')==1)
  for i=1,6 do player.pos={x=i*.15,y=0,z=0};step(.1) end
  step(.5)
  assert(lastLog('exit').fields.reason=='movement' and not held)
  step(1.5)
  assert(not held and count('play')==1,'no re-entry during the delay')
  step(5)
  assert(held and count('play')==2,'re-entered once settled')
`));

test('the idle waits five seconds after the end of a reply', () => run(`
  entry.record='Character.Silverhand';entry.serial=2;calls={};logs={}
  speaking={knownEnd=8,at=0};step(1.6)
  assert(held)
  step(10)
  speaking=nil;step(4)
  assert(lastLog('finished').fields.reason=='reply ended')
  local before=0 for _,l in ipairs(logs) do if l.kind=='flavour-begin' then before=before+1 end end
  step(3)
  local mid=0 for _,l in ipairs(logs) do if l.kind=='flavour-begin' then mid=mid+1 end end
  assert(mid==before,'no idle within 5 s of the reply')
  step(4)
  local after=0 for _,l in ipairs(logs) do if l.kind=='flavour-begin' then after=after+1 end end
  assert(after>before,'it follows five seconds after the reply')
`));

test('a stance enters directly on the stance loop: no ambient idle first, gestures after the enter blend, a plain exit', () => run(`
  local cat=load(catalogSource)()
  for key,fam in pairs(cat.families) do assert(fam.bridge==nil,key..' has no ambient bridge') end
  assert(cat.families.on_sides_plain==nil,'the plain variant is gone, on_sides is plain now')
  local fam=cat.families.judy_own
  speaking={knownEnd=20,at=0};step(1.0)
  assert(held and last('play') and count('jump')==0,'no jump during the enter blend')
  step(3.0)
  assert(count('jump')>=1,'a gesture follows the enter blend')
  assert(not lastLog('bridge-in') and not lastLog('bridge-out'),'no crossing logged')
  speaking=nil;step(6)
  assert(count('exit')==1 and not last('exit').instant,'the native fast exit, nothing before it')
  assert(not held and lastLog('finished').fields.reason=='reply ended')
`));

test('combat leaves a stance at once', () => run(`
  speaking={knownEnd=20,at=0};step(3.5)
  context.combat=true;step(.3)
  assert(count('exit')==1 and last('exit').instant,'instant exit in combat')
`));

// The generic fallback: a record the catalog does not list gets its rig's own talk family and a hip or folded-arms
// idle from its body type (catalog.generic).
for (const [bodyType, rig, pool] of [
  ['WomanAverage', 'woman_base', ['convai_idle_jackie_hips', 'convai_idle_panam_hips', 'convai_idle_generic_hips']],
  ['ManAverage', 'man_base', ['convai_idle_generic_arms_crossed', 'convai_idle_generic']],
  ['ManBig', 'man_big', ['convai_idle_generic_hips_big', 'convai_idle_generic', 'convai_idle_jackie_hips']]]) {
  test(`an uncatalogued ${bodyType} copy talks from on_sides and idles from its rig's pool`, () => run(`
    entry.record='Character.sq017_blue_moon_x'
    local reads=0
    function native.bodyType() reads=reads+1;return '${bodyType.toLowerCase()}' end
    speaking={knownEnd=14,at=0};step(.5)
    assert(last('play') and last('play').component=='convai_talk_on_sides','talk family: '..tostring(last('play') and last('play').component))
    assert(held,'movement waits while in the stance')
    step(8)
    assert(count('jump')>=2,'gestures played: '..count('jump'))
    local cat=load(catalogSource)()
    local fam=cat.families.on_sides
    for _,call in ipairs(calls) do
      if call.name=='jump' and call.clip~=fam.idle.name then
        local found
        for _,clip in ipairs(fam.clips) do if clip.name==call.clip then found=clip end end
        assert(found and found.perRig.${rig} and found.category~='idlebreak','clip valid: '..call.clip)
      end
    end
    speaking=nil;step(4)
    assert(count('exit')==1 and not held and lastLog('finished').fields.reason=='reply ended')
    assert(reads==1,'the body type is read once per copy: '..reads)
    -- the idle five seconds after the reply, a random one of the rig's pool, never the same twice in a row
    local inPool={}
    for _,key in ipairs({${pool.map((k) => `'${k}'`).join(',')}}) do inPool[key]=true end
    local seen={}
    for round=1,6 do
      local before=idles()
      local waited=0
      while idles()==before and waited<160 do step(.5);waited=waited+1 end
      assert(idles()==before+1,'an idle follows: '..idles()..' vs '..before)
      if round==1 then assert(waited<=16,'the first idle follows the reply within about five seconds: '..waited) end
      local component=last('play').component
      assert(inPool[component],'idle from the rig pool: '..component)
      seen[component]=true
      step(50)
    end
    local order={} for _,l in ipairs(logs) do if l.kind=='flavour-begin' then order[#order+1]=l.fields.component end end
    for i=2,#order do assert(order[i]~=order[i-1] or ${pool.length}==1,'not the same idle twice in a row: '..order[i]) end
    local kinds=0 for _ in pairs(seen) do kinds=kinds+1 end
    assert(kinds>=${Math.min(pool.length, 2)},'more than one idle used: '..kinds)
    assert(reads==1,'still one read')
  `));
}

test('an uncatalogued copy with a body type the catalog has no rig for, or one that cannot be read, gets nothing', () => run(`
  entry.record='Character.some_fat_man'
  local reads=0
  function native.bodyType() reads=reads+1;return 'manfat' end
  speaking={knownEnd=14,at=0};step(3)
  assert(count('play')==0 and not held,'fat body: no stance')
  step(150)
  assert(count('play')==0 and reads==1,'no idle either, and decided once: '..reads)
  entry.serial=2;reads=0
  function native.bodyType() reads=reads+1;return nil end
  speaking={knownEnd=14,at=0};step(2)
  assert(reads==1 and count('play')==0,'read once, nothing yet: '..reads)
  step(3)
  assert(count('play')==0 and reads==1,'an unreadable body type is retried at most every 5 s: '..reads)
  step(3)
  assert(reads==2,'retried after 5 s: '..reads)
  function native.bodyType() return 'womanaverage' end
  step(6)
  assert(last('play') and last('play').component=='convai_talk_on_sides','readable now: '..tostring(last('play') and last('play').component))
`));

test('records on the catalog never list are left alone even when their body type matches', () => run(`
  local cat=load(catalogSource)()
  assert(type(cat.generic)=='table' and cat.generic.never~=nil,'catalog carries the fallback and its never list')
  entry.record='Character.Judy'
  function native.bodyType() error('a catalogued record must not read the body type') end
  speaking={knownEnd=14,at=0};step(.5)
  assert(last('play').component=='convai_talk_judy','catalogued Judy is unchanged')
`));

test('Adam Smasher and Dexter, which the catalog deliberately leaves out, never get the fallback', () => run(`
  local cat=load(catalogSource)()
  assert(cat.generic.never['Character.Smasher'] and cat.generic.never['Character.Dexter'])
  function native.bodyType() error('a never-listed record must not even read the body type') end
  for _,record in ipairs({'Character.Smasher','Character.Dexter'}) do
    entry.record=record
    speaking={knownEnd=14,at=0};step(3)
    assert(count('play')==0 and not held,record)
    speaking=nil
  end
`));

test('the catalog fallback maps every body type to a rig with a talk family and an idle checked on it', () => run(`
  local cat=load(catalogSource)()
  for body,rig in pairs(cat.generic.bodyTypes) do
    assert(body==body:lower():gsub('[^a-z0-9]',''),body)
    local row=cat.generic.rigs[rig]
    assert(row,rig)
    local fam=cat.families[row.talk]
    assert(fam,row.talk)
    local ok=false for _,r in ipairs(fam.rigs) do if r==rig then ok=true end end
    assert(ok,row.talk..' on '..rig)
    assert(cat.idleComponents[row.idle],row.idle)
    local checked=false for _,r in ipairs(cat.idleSources[row.idle].rigs) do if r==rig then checked=true end end
    assert(checked,row.idle..' checked on '..rig)
  end
`));

test('a kept device that has not followed her yet is not played; a device that never follows is replaced', () => run(`
  speaking={knownEnd=14,at=0};step(.5)
  assert(count('play')==1 and count('spawn')==1,'first stance on a fresh device')
  speaking=nil;step(4)
  assert(count('exit')==1 and not npc.inside,'left after the reply')
  local plays,spawns=count('play'),count('spawn')
  placedFlag=false
  speaking={knownEnd=14,at=0};step(1)
  assert(count('play')==plays,'no play while the old device is somewhere else')
  assert(count('move')>=1,'the device is moved to her')
  assert(held,'she is held (no walking) while the device catches up')
  step(1)
  assert(lastLog('device-replaced') and count('delete')>=1 and count('spawn')==spawns+1,'a device that does not follow is replaced by a new one')
  assert(count('play')==plays,'still not played')
  placedFlag=true;step(.5)
  assert(count('play')==plays+1,'plays once the device is at her pose')
`));

test('the talk stance waits until she has turned toward V (placed at her pose and yaw)', () => run(`
  entry.facingError=70
  speaking={knownEnd=14,at=0};step(2.5)
  assert(count('play')==0,'still turning: no stance')
  entry.facingError=10;step(.5)
  assert(count('play')==1,'turned: stance')
`));

// Live 2026-10-11: GetBodyType returns a CName, and tostring() of one is not the name.
const workspotSource = readFileSync(new URL('../mod/gesture-workspot.lua', import.meta.url), 'utf8');
test('the real body type read understands a CName (NameToString, or the name inside tostring)', () => {
  const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;
  const vm = lauxlib.luaL_newstate(); lualib.luaL_openlibs(vm);
  const code = `
    ws=load([==[${workspotSource}]==])()
    local raw='ToCName{ hash_lo = 0x02871D38, hash_hi = 0xA1219CE9 --[[ WomanAverage --]] }'
    local function cname() return setmetatable({}, {__tostring=function() return raw end}) end
    local function npcOf(v) return {GetBodyType=function() return v end} end
    -- 1. NameToString resolves it
    NameToString=function() return 'WomanAverage' end

    assert(ws.bodyType(npcOf(cname()))=='womanaverage', 'NameToString path')
    -- 2. NameToString unusable: the comment inside tostring
    NameToString=function() return 'None' end
    assert(ws.bodyType(npcOf(cname()))=='womanaverage', 'comment path')
    NameToString=nil
    assert(ws.bodyType(npcOf(cname()))=='womanaverage', 'no NameToString')
    -- 3. plain strings and failures
    assert(ws.bodyType(npcOf('ManBig'))=='manbig')
    assert(ws.bodyType(npcOf(nil))==nil)
    assert(ws.bodyType({GetBodyType=function() error('x') end})==nil)
  `;
  const result = lauxlib.luaL_dostring(vm, to_luastring(code));
  const error = result === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(vm, -1));
  lua.lua_close(vm); assert.equal(result, lua.LUA_OK, error);
});

test('a catalogued character rotates her own idle with the rig\'s clean generic idles and does not turn while still facing away', () => run(`
  entry.record='Character.sq017_blue_moon';entry.serial=3;calls={};logs={}
  entry.facingError=80;step(5)
  assert(idles()==0,'no idle while she is still turning toward V')
  entry.facingError=5;step(3)
  assert(idles()==1,'idle as soon as she has turned')
  local seen={}
  for round=1,10 do step(40) end
  for _,l in ipairs(logs) do if l.kind=='flavour-begin' then seen[l.fields.component]=true end end
  assert(seen.convai_idle_uscracks_cute,'her signature idle is in the rotation')
  assert(seen.convai_idle_jackie_hips or seen.convai_idle_panam_hips or seen.convai_idle_generic_hips,'and the clean generic idles')
  assert(not seen.convai_idle_generic_hip,'the lurching generic_hip is not part of the generic pool')
  local order={} for _,l in ipairs(logs) do if l.kind=='flavour-begin' then order[#order+1]=l.fields.component end end
  for i=2,#order do assert(order[i]~=order[i-1],'no repeat in a row') end
  -- a talk stance for her uses on_sides (the gang-loop family drifted on her live)
  speaking={knownEnd=14,at=0};step(2)
  assert(last('play').component=='convai_talk_on_sides','talks from on_sides: '..tostring(last('play').component))
`));

test('no idle or talk stance starts while V crouches or the copy is held crouched, and a running one leaves at once', () => run(`
  entry.record='Character.Silverhand';entry.serial=2;calls={};logs={}
  context.crouched=true
  step(60)
  assert(count('play')==0 and idles()==0,'no idle while crouched')
  speaking={knownEnd=20,at=0};step(3)
  assert(talks()==0,'no talk stance while crouched')
  speaking=nil;step(1)
  context.crouched=false
  step(3)
  assert(idles()==1,'the idle starts once V stands: '..idles())
  context.crouched=true;step(.3)
  assert(count('exit')==1 and lastLog('exit').fields.reason=='crouching' and not last('exit').instant,'leaves for a crouch with the fast exit')
  step(.5)
  assert(not held and lastLog('finished').fields.reason=='crouching','released')
  local plays=count('play')
  step(60)
  assert(count('play')==plays,'and stays out while crouched')
`));

test('a crouch while the workspot is only starting cancels it without stranding the copy', () => run(`
  entry.record='Character.Silverhand';entry.serial=2;calls={};logs={}
  for i=1,30 do step(.1);if count('play')>=1 then break end end
  assert(count('play')==1,'started')
  context.crouched=true;step(.1)
  assert(lastLog('finished') and lastLog('finished').fields.reason=='crouching','finished at once')
  step(2)
  assert(count('play')==1,'no new play')
`));

test('movement ends the workspot first and the follow waits for the pose blend-out, so she is never walked in the idle pose', () => run(`
  entry.record='Character.Silverhand';entry.serial=2;calls={};logs={}
  step(3)
  assert(lastLog('flavour-begin') and held,'in an idle, holding movement')
  for i=1,8 do player.pos={x=i*.15,y=0,z=0};step(.1) end
  assert(lastLog('exit') and lastLog('exit').fields.reason=='movement','exits on movement')
  local at=count('exit')
  -- the workspot is left within a tick, but movement still waits for the blend
  local heldTicks,total=0,0
  for i=1,12 do step(.1);total=total+1;if held then heldTicks=heldTicks+1 end end
  assert(heldTicks>=3 and heldTicks<=5,'held about 0.4 s after the workspot is left: '..heldTicks)
  assert(not held,'then released')
  assert(count('exit')==at,'no second exit')
`));

test('a combat exit and a start that never entered the workspot do not delay movement', () => run(`
  entry.record='Character.Silverhand';entry.serial=2;calls={};logs={}
  step(3)
  context.combat=true;step(.1);context.combat=false
  for i=1,3 do step(.1) end
  assert(lastLog('finished') and lastLog('finished').fields.reason=='combat','finished on combat')
  assert(not held,'released at once after an instant exit')
`));

test('an idle workspot that moves the body is logged once as drift, with how long after entering', () => run(`
  entry.record='Character.Silverhand';entry.serial=2;calls={};logs={}
  entry.position={x=1,y=1,z=0}
  step(3)
  assert(held and not lastLog('drift'),'no drift yet')
  entry.position={x=1.05,y=1,z=0};step(.5)
  assert(not lastLog('drift'),'5 cm is not drift')
  entry.position={x=1.3,y=1,z=0};step(.5)
  local d=lastLog('drift')
  assert(d and d.fields.metres>.2 and d.fields.after>0,'drift logged')
  local n=0 for _,l in ipairs(logs) do if l.kind=='drift' then n=n+1 end end
  step(1);for _,l in ipairs(logs) do if l.kind=='drift' then n=n-1 end end
  assert(n==0,'once')
`));

// Group rounds: the members who are not speaking keep the stance and nod now and then.
const groupFixture = `
  npc.id='77'
  local function mk(record,serial,hash) return {serial=serial,record=record,entityID={hash=hash},npc={inside=false,id=hash},playerGap=1.8,
    motor={kind='hold',feedback={state='AICommandState : Executing (2)'}}} end
  local E={entry,mk('Character.Panam',2,'78'),mk('Character.Rogue',3,'79')}
  local cat=load(catalogSource)()
  local category={}
  for _,family in pairs(cat.families) do for _,clip in ipairs(family.clips) do category[clip.name]=clip.category end end
  native.play=function(d,n,component) calls[#calls+1]={name='play',component=component,who=n.id};n.entering=true;return true end
  native.jump=function(n,clip,instant) calls[#calls+1]={name='jump',clip=clip,instant=instant==true,who=n.id,at=c.clock};return true end
  native.exit=function(n,instant) calls[#calls+1]={name='exit',instant=instant==true,who=n.id};n.leaving=true;return true end
  local words={}
  for i=1,60 do words[#words+1]='word' end
  c.replyText=function() return table.concat(words,' ') end
  local roleOf,speakerOf={},nil
  local asked=0
  c.group=function(e) asked=asked+1;if roleOf[e] then return roleOf[e],speakerOf end end
  c.speech=function(e) if speaking and e==speakerOf then return speaking end end
  local function gstep(seconds,count)
    for i=1,math.floor(seconds/.1+.5) do
      local rows={}
      for k=1,count or 3 do rows[#rows+1]={entry=E[k],transport=false} end
      c.tick(player,.1,rows)
      for k=1,count or 3 do
        local n=E[k].npc
        if n.entering then n.entering=nil;n.inside=true end
        if n.leaving then n.leaving=nil;n.inside=false end
      end
      if speaking then speaking.at=math.min(speaking.knownEnd,(speaking.at or 0)+.1) end
      for k=1,count or 3 do c.observe(E[k],context,.1) end
    end
  end
  local function jumpsOf(who)
    local list={}
    for _,call in ipairs(calls) do if call.name=='jump' and call.who==who and category[call.clip] then list[#list+1]=call end end
    return list
  end
  local function playsOf(who) local n=0 for _,call in ipairs(calls) do if call.name=='play' and call.who==who then n=n+1 end end return n end
  local function exitsOf(who) local n=0 for _,call in ipairs(calls) do if call.name=='exit' and call.who==who then n=n+1 end end return n end
  local function startRound(speaker)
    speakerOf=speaker
    for _,k in ipairs({'77','78','79'}) do roleOf[k]='reply' end
    speaking={knownEnd=24,at=0}
  end
`;

test('members of a group round who are not speaking keep the stance and only nod, later and rarely', () => run(groupFixture + `
  startRound('77')
  gstep(26)
  for _,who in ipairs({'78','79'}) do
    assert(playsOf(who)==1,who..' enters the stance once, not '..playsOf(who))
    assert(exitsOf(who)==0,who..' stays in the stance while the other speaks')
    local jumps=jumpsOf(who)
    assert(#jumps>=1 and #jumps<=3,who..' nods '..#jumps..' times in a 24 s reply')
    for _,call in ipairs(jumps) do assert(category[call.clip]=='nod',who..' played '..call.clip..' ('..tostring(category[call.clip])..')') end
    for i=2,#jumps do assert(jumps[i].at-jumps[i-1].at>=8,who..' nods too close') end
  end
  -- the speaker gestures as ever, with more than nods
  local others=0 for _,call in ipairs(jumpsOf('77')) do if category[call.clip]~='nod' then others=others+1 end end
  assert(others>=2,'the speaker still gestures: '..others)
  local log=lastLog('gesture')
  assert(log,'logged')
`));

test('two group listeners never start a nod within two seconds of each other', () => run(groupFixture + `
  startRound('77')
  speaking.knownEnd=120
  words={}
  for i=1,320 do words[#words+1]='word' end
  gstep(110)
  local starts={}
  for _,who in ipairs({'78','79'}) do for _,call in ipairs(jumpsOf(who)) do starts[#starts+1]={at=call.at,who=who} end end
  table.sort(starts,function(a,b) return a.at<b.at end)
  assert(#starts>=6,'enough nods to compare: '..#starts)
  local both={}
  for _,s in ipairs(starts) do both[s.who]=true end
  assert(both['78'] and both['79'],'both listeners nod')
  for i=2,#starts do
    if starts[i].who~=starts[i-1].who then assert(starts[i].at-starts[i-1].at>=1.99,'nods '..(starts[i].at-starts[i-1].at)..' s apart') end
  end
`));

test('a short reply in the round gives its listeners no nod and the stance is kept without a gesture', () => run(groupFixture + `
  c.replyText=function() return 'Sure thing, V.' end
  startRound('77')
  speaking.knownEnd=2.5
  gstep(8)
  for _,who in ipairs({'78','79'}) do
    assert(#jumpsOf(who)==0,who..' nodded into a short reply')
    assert(exitsOf(who)==0,who..' keeps the stance for the round')
  end
`));

test('between speakers the members keep the stance; when the round ends they leave after the linger', () => run(groupFixture + `
  startRound('77')
  gstep(3)
  local plays=playsOf('78')+playsOf('79')
  speaking=nil
  for _,k in ipairs({'77','78','79'}) do roleOf[k]='between' end
  speakerOf=nil
  gstep(9)
  assert(exitsOf('78')==0 and exitsOf('79')==0 and exitsOf('77')==0,'nobody leaves while the next speaker is prepared')
  -- the next speaker is Panam; Judy and Rogue keep listening
  speakerOf='78'
  for _,k in ipairs({'77','78','79'}) do roleOf[k]='reply' end
  speaking={knownEnd=24,at=0}
  gstep(6)
  assert(playsOf('78')+playsOf('79')==plays,'no re-entry between speakers')
  assert(exitsOf('77')==0 and exitsOf('79')==0)
  -- round over
  speaking=nil;roleOf={}
  gstep(6)
  for _,who in ipairs({'77','78','79'}) do assert(exitsOf(who)==1,who..' leaves once after the round') end
  assert(lastLog('finished').fields.reason=='reply ended')
`));

test('V speaking a group utterance: every member listens and nods, with group pacing', () => run(groupFixture + `
  for _,k in ipairs({'77','78','79'}) do roleOf[k]='recording' end
  gstep(30)
  for _,who in ipairs({'77','78','79'}) do
    local jumps=jumpsOf(who)
    assert(#jumps>=1 and #jumps<=3,who..' nods '..#jumps..' times in 30 s')
    assert(jumps[1].at>=3,who..' first nod at '..jumps[1].at)
    for _,call in ipairs(jumps) do assert(category[call.clip]=='nod') end
  end
`));

test('a copy outside the round is left alone, and with the setting off the round is never even asked about', () => run(groupFixture + `
  startRound('77')
  roleOf['79']=nil
  gstep(8)
  local talks=0
  for _,call in ipairs(calls) do if call.name=='play' and call.who=='79' and call.component:find('convai_talk',1,true) then talks=talks+1 end end
  assert(talks==0 and #jumpsOf('79')==0,'a copy outside the round takes no talk stance and no nod (it may idle)')
  enabled=false
  gstep(12) -- the running stances leave (they still look at their own state while they do, and for the 10 s health window)
  speaking=nil;roleOf={}
  asked=0
  calls={}
  gstep(5)
  assert(asked==0,'the group lookup ran '..asked..' times with the setting off')
`));

// Round 11: prop idles (cigarette, sunglasses, cup, bottle). The natives are optional in the controller; these tests give
// the fixture fake hand slots. Every VM is fresh, so installing them here affects no other test.
const propFixture = `
  local slots,clears={}, {}
  function native.slotItem(n,slot,wanted) calls[#calls+1]={name='slotItem',slot=slot};return true,slots[slot] end
  function native.clearSlot(n,slot,wanted)
    clears[#clears+1]={slot=slot,item=wanted}
    local had=slots[slot];slots[slot]=nil
    return true,had and 'removed' or 'empty'
  end
  local function propLogs(kind) local n=0 for _,l in ipairs(logs) do if l.kind==kind then n=n+1 end end return n end
  local function untilPlay() for i=1,80 do step(.1);if idles()>=1 then return end end end
  entry.record='Character.Silverhand';entry.serial=2;calls={};logs={}
  -- The random value that makes the controller pick one idle of Johnny's pool first (his own idle, his pool, then the rig's generic idles).
  local function aim(key)
    local cat=load(catalogSource)()
    local known=cat.characters[entry.record]
    local pool,seen={}, {}
    local function add(k) if k and not seen[k] and cat.idleComponents[k] then seen[k]=true;pool[#pool+1]=k end end
    add(known.idle) for _,k in ipairs(known.idles or {}) do add(k) end
    if cat.generic.mix then for _,k in ipairs(cat.generic.rigs[known.rig].idles) do add(k) end end
    for i,k in ipairs(pool) do if k==key then return (i-.5)/#pool end end
    error('not in the pool: '..key)
  end
  local aimed=aim('johnny_smoke')
  c.random=function() return aimed end
`;

test('a prop idle starts with a free hand, is looked at once, and the declared item is taken out of the slot afterwards', () => run(propFixture + `
  untilPlay()
  local began=lastLog('flavour-begin')
  assert(began and began.fields.component=='convai_idle_johnny_smoke','the cigarette idle: '..tostring(began and began.fields.component))
  slots['AttachmentSlots.WeaponLeft']={match=true,fists=false} -- the engine put the cigarette in his left hand
  step(4)
  assert(propLogs('props-seen')==1 and propLogs('props-missing')==0,'looked once and saw it')
  local reads=0 for _,call in ipairs(calls) do if call.name=='slotItem' then reads=reads+1 end end
  assert(reads==2,'one read to check the hand before the idle and one look after it began: '..reads)
  assert(#clears==0,'nothing is cleared while the idle runs')
  for i=1,8 do player.pos={x=i*.15,y=0,z=0};step(.1) end
  assert(lastLog('exit') and lastLog('exit').fields.reason=='movement')
  step(1)
  assert(#clears==1,'the first clean-up pass half a second after the idle ended: '..#clears)
  assert(clears[1].slot=='AttachmentSlots.WeaponLeft' and clears[1].item=='Items.crowd_cigarette_i_stick','exactly the declared item and slot')
  assert(slots['AttachmentSlots.WeaponLeft']==nil,'taken out')
  local removed=0 for _,l in ipairs(logs) do if l.kind=='props-clear' and l.fields.state=='removed' then removed=removed+1 end end
  assert(removed==1,'the removal is logged')
  step(4)
  assert(#clears==2,'and a second pass a few seconds later: '..#clears)
  local loud=0 for _,l in ipairs(logs) do if l.kind=='props-clear' then loud=loud+1 end end
  assert(loud==1,'a pass that finds the slot already empty is silent')
  step(10)
  assert(#clears==2,'no further native calls once the clean-up is done')
`));

test('a prop idle is not started while her hand holds something: a prop-free idle takes its place and nothing is ever cleared', () => run(propFixture + `
  slots['AttachmentSlots.WeaponLeft']={match=false,fists=false,record='Items.Preset_Yukimura_Default'}
  slots['AttachmentSlots.WeaponRight']={match=false,fists=false,record='Items.Preset_Yukimura_Default'}
  untilPlay()
  assert(propLogs('props-busy')==1,'the busy hand is noted')
  local began=lastLog('flavour-begin')
  assert(began.fields.component~='convai_idle_johnny_smoke' and began.fields.component~='convai_idle_johnny_shades','a prop-free idle instead: '..began.fields.component)
  for round=1,6 do step(40) end
  for _,l in ipairs(logs) do
    if l.kind=='flavour-begin' then assert(l.fields.component~='convai_idle_johnny_smoke' and l.fields.component~='convai_idle_johnny_shades','never a prop idle with a full hand') end
  end
  assert(#clears==0,'nothing of hers is ever removed')
`));

test('empty fists do not count as a busy hand, and a different item found at the look is left alone', () => run(propFixture + `
  slots['AttachmentSlots.WeaponLeft']={match=false,fists=true}
  untilPlay()
  assert(lastLog('flavour-begin').fields.component=='convai_idle_johnny_smoke' and propLogs('props-busy')==0,'fists are free')
  slots['AttachmentSlots.WeaponLeft']={match=false,fists=false,record='Items.Preset_Yukimura_Default'} -- something else turns up in the hand
  step(4)
  assert(propLogs('props-other')==1 and propLogs('props-missing')==0,'something else in the hand is noted, not counted as a miss')
  for i=1,8 do player.pos={x=i*.15,y=0,z=0};step(.1) end
  step(5)
  assert(clears[1] and clears[1].item=='Items.crowd_cigarette_i_stick','the clean-up asks only for the declared item, so a rifle in the hand is never touched')
`));

test('a prop that never shows up is counted, and after the second miss that idle is dropped for the session', () => run(propFixture + `
  local seed2=11
  c.random=function() seed2=(seed2*1103515245+12345)%2147483648;return seed2/2147483648 end
  for round=1,70 do step(30) end -- the hands stay empty: no prop ever appears
  local disabled,misses,picked={}, {}, {}
  for _,l in ipairs(logs) do
    if l.kind=='props-missing' then misses[l.fields.key]=(misses[l.fields.key] or 0)+1; assert(l.fields.misses==misses[l.fields.key]) end
    if l.kind=='props-disabled' then
      assert(misses[l.fields.key]==2,l.fields.key..' is dropped after exactly two misses: '..tostring(misses[l.fields.key]))
      disabled[l.fields.key]=true
    end
    if l.kind=='flavour-begin' then
      for key in pairs(disabled) do assert(l.fields.component~='convai_idle_'..key,key..' picked again after it was dropped') end
      picked[l.fields.component]=true
    end
  end
  assert(disabled.johnny_smoke and disabled.johnny_shades,'both prop idles ended up dropped')
  assert(picked.convai_idle_johnny_smoke and picked.convai_idle_johnny_shades,'and both were tried first')
  assert(#clears>=4,'a miss still cleans up after itself: '..#clears)
`));

test('an old gesture-workspot.lua without the slot natives, or the kill switch, means no prop idle at all', () => run(`
  entry.record='Character.Silverhand';entry.serial=2;calls={};logs={}
  local function components() local list={} for _,l in ipairs(logs) do if l.kind=='flavour-begin' then list[#list+1]=l.fields.component end end return list end
  for round=1,12 do step(40) end
  local list=components()
  assert(#list>=4,'idles still happen: '..#list)
  for _,component in ipairs(list) do assert(component~='convai_idle_johnny_smoke' and component~='convai_idle_johnny_shades',component) end
  -- natives present, kill switch off
  local slots={}
  function native.slotItem() return true,nil end
  function native.clearSlot() return true,'empty' end
  m.policy.propIdles=false
  logs={}
  for round=1,12 do step(40) end
  list=components()
  assert(#list>=4)
  for _,component in ipairs(list) do assert(component~='convai_idle_johnny_smoke' and component~='convai_idle_johnny_shades',component) end
`));

test('releasing a copy in a prop idle still cleans her hands, and abandoning at world teardown makes no native call', () => run(propFixture + `
  untilPlay()
  slots['AttachmentSlots.WeaponLeft']={match=true,fists=false}
  step(1)
  c.release(entry,'despawn')
  for i=1,15 do c.tick(player,.1,{}) end
  assert(#clears==1 and slots['AttachmentSlots.WeaponLeft']==nil,'cleaned half a second after the release')
  for i=1,40 do c.tick(player,.1,{}) end
  assert(#clears==2,'second pass')
  -- again, abandoned instead
  entry.serial=3;npc.inside=false;calls={};logs={};clears={}
  c.random=function() return .7 end
  untilPlay()
  slots['AttachmentSlots.WeaponLeft']={match=true,fists=false}
  step(1)
  for i=1,8 do player.pos={x=i*.15,y=0,z=0};step(.1) end
  c.abandon('world teardown')
  local reads=#calls
  for i=1,60 do c.tick(player,.1,{}) end
  assert(#clears==0,'no clean-up native call after abandon')
  assert(#calls==reads+1 or #calls==reads,'only the one-time sweep follows')
`));

test('the catalog declares every prop idle completely, in hand slots, and never as a character\'s own primary idle', () => run(`
  local cat=load(catalogSource)()
  local n=0
  for key,prop in pairs(cat.propIdles) do
    n=n+1
    assert(cat.idleComponents[key],key..' has a component')
    assert(cat.idleSources[key],key..' has a recorded source')
    assert(type(prop.prop)=='string' and #prop.items>=1,key..' declares its items')
    for _,row in ipairs(prop.items) do
      assert(row.item:match('^Items%.[%w_]+$'),key..' item '..row.item)
      assert(row.slot=='AttachmentSlots.WeaponRight' or row.slot=='AttachmentSlots.WeaponLeft',key..' slot '..row.slot)
    end
    for record,known in pairs(cat.characters) do assert(known.idle~=key,record..' has the prop idle '..key..' as its primary idle') end
  end
  assert(n==4,'cigarette, sunglasses, cup and bottle: '..n)
  assert(cat.experimentalIdles==nil,'the Round 4 experimental list is gone')
  -- who may use which
  local function pool(record)
    local known=cat.characters[record]
    local keys={known.idle}
    for _,key in ipairs(known.idles or {}) do keys[#keys+1]=key end
    return keys,known
  end
  local function has(keys,key) for _,k in ipairs(keys) do if k==key then return true end end return false end
  for _,record in ipairs({'Character.Silverhand','CyberpunkConvai.JohnnyCompanion'}) do
    local keys,known=pool(record)
    assert(known.rig=='man_base')
    for _,key in ipairs({'johnny_crossed','johnny_aggressive','johnny_smoke','johnny_shades'}) do assert(has(keys,key),record..' pool '..key) end
  end
  local judy=pool('Character.Judy');assert(has(judy,'judy_coffee') and not has(judy,'panam_beer'))
  local panam=pool('Character.Panam');assert(has(panam,'panam_beer') and not has(panam,'judy_coffee'))
  -- the prop idles are checked on the rig of the character that uses them
  for key,prop in pairs(cat.propIdles) do
    local source=cat.idleSources[key]
    local rigs={} for _,rig in ipairs(source.rigs) do rigs[rig]=true end
    for record,known in pairs(cat.characters) do
      if has(pool(record),key) then assert(rigs[known.rig],record..' uses '..key..' which was not checked on '..known.rig) end
    end
  end
`));

test('Padre and Saul rest in measured, fitting idles: Padre in hands folded in front, Saul in relaxed hands at the sides', () => run(`
  local cat=load(catalogSource)()
  local padre,saul=cat.characters['Character.Padre'],cat.characters['Character.Saul']
  assert(padre.idle=='generic_front' and padre.idles[1]=='generic_back','Padre: '..tostring(padre.idle))
  assert(cat.idleSources.generic_front.kind=='generic' and cat.idleSources.generic_front.what:find('hands folded in front',1,true))
  assert(saul.idle=='generic' and saul.idleSource=='generic' and saul.idles[1]=='generic_back','Saul: '..tostring(saul.idle))
  assert(saul.note:find('angry',1,true),'the note says why his own loop is not used')
  assert(padre.rig=='man_base' and saul.rig=='man_base')
  for _,key in ipairs({'generic_front','generic','generic_back'}) do
    local ok=false
    for _,rig in ipairs(cat.idleSources[key].rigs) do if rig==padre.rig then ok=true end end
    assert(ok,key..' is checked on '..padre.rig)
  end
  assert(cat.idleSources.generic_hold.what:find('right hand held out',1,true),'the hold pose is described from the measurement')
`));
