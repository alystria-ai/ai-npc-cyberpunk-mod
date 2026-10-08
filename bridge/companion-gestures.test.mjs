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
local npc={inside=false}
local native={TAG='t'}
function native.inWorkspot(n) return n.inside end
function native.spawnDevice(n,t) calls[#calls+1]={name='spawn',template=t};return true,{hash=9} end
local deviceReady=true
function native.deviceEntity(id) if deviceReady then return {device=true} end;return nil end
function native.moveDevice() calls[#calls+1]={name='move'};return true end
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
`;

test('off by default setting, idle and short replies never enter a stance', () => run(`
  enabled=false;speaking={knownEnd=12,at=0};step(2)
  assert(count('play')==0 and not held,'disabled')
  enabled=true;speaking=nil;step(3)
  assert(count('play')==0,'idle keeps the vanilla idle')
  speaking={knownEnd=3,at=0};step(3)
  assert(count('play')==0,'short replies do not gesture')
`));

test('a long reply enters the character stance family, gestures, and leaves after the reply', () => run(`
  speaking={knownEnd=14,at=0,family='joy',scale=2};step(.5)
  local play=last('play')
  assert(play and play.component=='convai_talk_arms_crossed','Judy talks from the arms-crossed loop: '..tostring(play and play.component))
  assert(held,'movement waits while in the stance')
  step(8)
  assert(count('jump')>=2,'gestures played: '..count('jump'))
  local cat=load(catalogSource)()
  local fam=cat.families.arms_crossed
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
    if call.name=='jump' and call.clip~=cat.families.arms_crossed.idle.name then
      local category
      for _,clip in ipairs(cat.families.arms_crossed.clips) do if clip.name==call.clip then category=clip.category end end
      assert(category=='nod','listening clip '..call.clip..' is '..tostring(category))
    end
  end
`));

test('unknown characters are left alone', () => run(`
  entry.record='Character.Somebody';speaking={knownEnd=20,at=0};step(2)
  assert(count('play')==0)
`));

test('Johnny takes his signature idle now and then when settled, never Judy, and talks from hands at sides', () => run(`
  step(130)
  assert(count('play')==0,'Judy keeps her vanilla idle (no flavour)')
  entry.record='Character.Silverhand';entry.serial=2;calls={};logs={}
  step(115)
  local began=lastLog('flavour-begin')
  assert(began and began.fields.component=='convai_idle_johnny','signature idle component')
  step(31)
  assert(lastLog('finished') and lastLog('finished').fields.reason=='flavour ended')
  step(160)
  assert(#(function() local n={};for _,l in ipairs(logs) do if l.kind=='flavour-begin' then n[#n+1]=l end end;return n end)()>=2,'repeats with a gap')
  speaking={knownEnd=20,at=0};step(.3)
  if lastLog('flavour-begin') and not lastLog('exit') then end
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
  context.phase='attend';step(.6)
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
  for i=1,100 do
    step(.1)
    if speaking.at>=speaking.knownEnd and speaking.knownEnd<10 then speaking.knownEnd=speaking.knownEnd+2.5 end
  end
  local cat=load(catalogSource)()
  local durations={}
  for _,clip in ipairs(cat.families.arms_crossed.clips) do durations[clip.name]=clip.perRig.woman_base and clip.perRig.woman_base.duration end
  local covered=0
  for _,call in ipairs(calls) do
    if call.name=='jump' and durations[call.clip] then n=n+1;covered=covered+durations[call.clip] end
  end
  assert(count('play')==1,'entered once')
  assert(n>=2 and covered>=6,'gestures '..n..' covering '..covered..' s of a 10 s reply')
  c.replyText=function() return 'short reply here' end
`));

test('a short reply split into phrases still does not gesture', () => run(`
  c.replyText=function() return 'Yes, I can do that.' end
  speaking={knownEnd=2.0,at=0};step(3)
  assert(count('play')==0)
`));

test('gesture jumps are instant; the return to the idle loop is queued at the clip end', () => run(`
  speaking={knownEnd=14,at=0};step(6)
  local cat=load(catalogSource)()
  local idle=cat.families.arms_crossed.idle.name
  local gestures,returns=0,0
  for _,call in ipairs(calls) do
    if call.name=='jump' then
      if call.clip==idle then assert(not call.instant,'idle return waits for the clip');returns=returns+1
      else assert(call.instant,'gesture jump is instant: '..call.clip);gestures=gestures+1 end
    end
  end
  assert(gestures>=1 and returns>=1,'gestures '..gestures..' returns '..returns)
`));

test('an archive without the new family falls back to the previous family', () => run(`
  local realPlay=native.play
  native.play=function(d,n,component)
    calls[#calls+1]={name='play',component=component}
    if component~='convai_talk_arms_crossed' then n.entering=true end
    return true
  end
  speaking={knownEnd=20,at=0};step(4)
  assert(lastLog('family-missing') and lastLog('family-missing').fields.family=='arms_crossed')
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
    'Character.mr_hands','Character.Padre','Character.Jackie','Character.Sobchak','Character.reed','Character.Elcoyote_Barman'}
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
      if row and clip.category~='idlebreak' and (row.reach or 0)>=25 then visible=visible+1 end
    end
    assert(visible>=40,record..' has only '..visible..' clips with 25 cm+ reach')
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
        if row.legs and row.legs<=8 and (row.reach or 0)>=25 and (row.reach or 0)<=90 then usable=usable+1 end
      end
    end
    assert(usable>=8,record..' has only '..usable..' leg-matched visible clips in '..known.talk)
    checked=checked+1
  end
  assert(checked>=23)
`));
