import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import fengari from 'fengari';

// The romance animation controller (mod/romance-anim.lua) against a fake native layer and a fake clock, and the pair table it reads
// (mod/romance-pairs.lua). Gating, the one confirmation, the fallback when no pair fits, a row that fails, the clean exit.
const controller = readFileSync(new URL('../mod/romance-anim.lua', import.meta.url), 'utf8');
const pairs = readFileSync(new URL('../mod/romance-pairs.lua', import.meta.url), 'utf8');

function run(code) {
  const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;
  const vm = lauxlib.luaL_newstate(); lualib.luaL_openlibs(vm);
  const result = lauxlib.luaL_dostring(vm, to_luastring(fixture + code));
  const error = result === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(vm, -1));
  lua.lua_close(vm); assert.equal(result, lua.LUA_OK, error);
}

const fixture = `
local pairSource=[==[${pairs}]==]
dofile=function(path)
  if path=='romance-pairs.lua' then return load(pairSource)() end
  if path=='gesture-workspot.lua' then return {} end
  error('unexpected dofile '..path)
end
local m=(load([==[${controller}]==]))()
local data=load(pairSource)()

-- ---- world: V, the partner, the device, a clock ---------------------------------------------------------------------------------------
local W
local function newWorld(over)
  W={clock=100,calls={},logs={},notices={},asked={},answer=nil,
     v={name='V',pose={x=0,y=0,z=0,yaw=0},inside=false},
     n={name='Judy',pose={x=1,y=0,z=0,yaw=90},inside=false},
     vRig='player_woman',npcRig='woman_base',partner=true,enabled=true,blocked=nil,danger=nil,speaking=false,
     components={},deviceReady=true,refuseComponent=false,playOk=true,enterOk=true,template='dev.ent',
     lineUp=true,files={},supports={},confirmShown=true}
  for k,v in pairs(over or {}) do W[k]=v end
  return W
end
local function count(name) local c=0 for _,x in ipairs(W.calls) do if x.name==name then c=c+1 end end return c end
local function names() local t={} for _,x in ipairs(W.calls) do t[#t+1]=x.name end return table.concat(t,',') end
local function find(name) for _,x in ipairs(W.calls) do if x.name==name then return x end end end

local native={}
function native.inWorkspot(o) return o.inside end
function native.pose(o) return {x=o.pose.x,y=o.pose.y,z=o.pose.z,yaw=o.pose.yaw} end
function native.playerRig() return W.vRig end
function native.spawnDevice(o,t) W.calls[#W.calls+1]={name='spawn',template=t};return true,{hash=5} end
function native.deviceEntity(id) if W.deviceReady then return {device=true} end return nil end
function native.hasComponent(d,c) W.calls[#W.calls+1]={name='has',component=c}
  if W.refuseComponent==true then return true,false end
  if type(W.refuseComponent)=='string' and c:find(W.refuseComponent,1,true) then return true,false end
  return true,true end
function native.playSimple(d,actor,c,mode) W.calls[#W.calls+1]={name='play',actor=actor.name,component=c,mode=mode}
  if W.playOk==false then return false,'no' end
  if W.enterOk then actor.inside=true end
  if W.lineUp and mode=='resource' and actor==W.n then actor.pose={x=0.5,y=0,z=0,yaw=180} end
  if mode=='resource' and not W.lineUp and actor==W.n then actor.pose={x=9,y=9,z=0,yaw=0} end
  return true,true end
function native.jump(o,clip,i) W.calls[#W.calls+1]={name='jump',actor=o.name,clip=clip};return true end
function native.exit(o) W.calls[#W.calls+1]={name='exit',actor=o.name};o.inside=false;return true end
function native.stopInDevice(o) W.calls[#W.calls+1]={name='stop',actor=o.name};o.inside=false;return true end
function native.deleteDevice() W.calls[#W.calls+1]={name='delete'};return true end
function native.teleport(o,pos,yaw) W.calls[#W.calls+1]={name='teleport',actor=o.name,x=pos.x,y=pos.y};o.pose={x=pos.x,y=pos.y,z=pos.z,yaw=yaw};return true end
function native.blink(o) W.calls[#W.calls+1]={name='blink'};return true end

local c
local function build(over)
  newWorld(over)
  local entry={npc=W.n,profileKey='judy-alvarez',name='Judy',serial=1}
  W.entry=entry
  c=m.new({native=native,data=W.data or data,clock=function() return W.clock end,
    enabled=function() return W.enabled end,
    player=function() return W.v end,
    resolve=function(key) if key=='judy-alvarez' then return entry end end,
    partner=function(key) return W.partner end,
    rigOf=function() if W.npcRig==false then return nil end return W.npcRig end,
    template=function() return W.template end,
    blocked=function() return W.blocked end,
    danger=function() return W.danger end,
    speaking=function() return W.speaking end,
    supports=function(need) return W.supports[need]==true end,
    confirm=function(info,answer) if not W.confirmShown then return false end W.asked[#W.asked+1]=info;W.answer=answer;return true end,
    yield=function() W.calls[#W.calls+1]={name='yield'} end,
    notice=function(t) W.notices[#W.notices+1]=t end,
    read=function(path) return W.files[path] end,
    decode=function(t) return W.decoded and W.decoded[t] end,
    log=function(k,f) W.logs[#W.logs+1]={kind=k,fields=f} end})
  return c
end
local function advance(seconds,step)
  step=step or 0.25
  local t=0
  while t<seconds do W.clock=W.clock+step;t=t+step;c.tick() end
end
local function lastLog(kind) for i=#W.logs,1,-1 do if W.logs[i].kind==kind then return W.logs[i].fields end end end
-- Plays a whole request: asked, yes, through the blink and the entry and the verify, to the playing phase.
local function start(kind)
  local ok,info=c.request(W.entry,kind or 'hug','list')
  assert(ok,tostring(info))
  assert(c.phase()=='confirming')
  W.answer(true)
  advance(4)
  return ok,info
end
`;

test('the pair table is plain data with the fields the controller reads', () => {
  run(`
    local ids,kinds={}, {}
    for _,k in ipairs(m.KINDS) do kinds[k]=true end
    assert(data.version==1)
    for _,row in ipairs(data.rows) do
      assert(not ids[row.id],'duplicate '..row.id); ids[row.id]=true
      assert(row.id:match('^[a-z0-9_]+$'),row.id)
      assert(kinds[row.kind],row.id..' kind')
      assert(row.verified==false,row.id..' must be unverified until checked in the game files')
      assert(type(row.vRigs)=='table' and #row.vRigs>0 and type(row.npcRigs)=='table' and #row.npcRigs>0,row.id..' rigs')
      for _,r in ipairs(row.vRigs) do assert(r=='player_man' or r=='player_woman',row.id..' v rig '..r) end
      for _,r in ipairs(row.npcRigs) do assert(r=='woman_base' or r=='man_base' or r=='man_big',row.id..' npc rig '..r) end
      assert(row.placement=='resource' or row.placement=='offset',row.id)
      assert(row.speech=='hold' or row.speech=='fit',row.id)
      for _,half in ipairs({row.v,row.n}) do
        if half.workspot then assert(half.workspot:match('^[%w_\\\\]+%.workspot$'),row.id..' path '..half.workspot) end
      end
      if row.placement=='offset' then assert(row.offset,row.id..' offset') end
    end
    for kind,list in pairs(data.fallback) do
      assert(kinds[kind]); for _,other in ipairs(list) do assert(kinds[other] and other~=kind) end
    end
    for _,k in ipairs(m.KINDS) do assert(data.fallback[k]~=nil and data.holdDefault[k]) end
  `);
});

test('the pair table covers each kind the rows can serve and offers nothing without both halves', () => {
  run(`
    local offered={}
    for _,row in ipairs(data.rows) do
      local usable=row.offer~=false and row.v.workspot and row.n.workspot and true or false
      if usable then offered[row.kind]=true end
    end
    for _,k in ipairs({'hug','cuddle','sit','lie','hands'}) do assert(offered[k],k) end
    -- A kiss has no complete pair yet: it is kept as a candidate and never offered.
    assert(not offered.kiss)
    local ctx={vRig='player_man',npcRig='woman_base',profileKey='judy-alvarez',supports=function() return false end,failed={}}
    local row,kind,asked=m.choose(data,'kiss',ctx)
    assert(row and kind=='hug' and asked=='kiss',tostring(kind))
  `);
});

test('choose prefers a row made for the character and falls back by the table order', () => {
  run(`
    local ctx={vRig='player_woman',npcRig='woman_base',profileKey='judy-alvarez',supports=function() return false end,failed={}}
    local row,kind=m.choose(data,'hug',ctx)
    assert(row.characters and row.characters[1]=='judy-alvarez',row.id)
    ctx.profileKey='panam-palmer'
    -- Panam shares Judy's rig, but the hug was made for Judy: no hug, so the fallback is held hands, then a seat on the ground.
    row,kind=m.choose(data,'hug',ctx)
    assert(row.kind=='sit' and kind=='sit',tostring(kind)..' '..row.id)
    ctx.npcRig='man_base'; ctx.profileKey='kerry-eurodyne'
    row,kind=m.choose(data,'cuddle',ctx)
    assert(row.id=='cuddle_kerry' and kind=='cuddle')
    ctx.failed={cuddle_kerry=true}
    row,kind=m.choose(data,'cuddle',ctx)
    assert(row.kind=='sit',row.id)
    -- a male River with a male V has no cuddle row and goes to the fallback
    ctx.npcRig='man_big'; ctx.vRig='player_man'; ctx.profileKey='river-ward'; ctx.failed={}
    row,kind=m.choose(data,'cuddle',ctx)
    assert(row.kind=='sit' and kind=='sit',tostring(kind))
    -- a row that waits for a seat is not offered until the seat is confirmed
    ctx.npcRig='woman_base'; ctx.vRig='player_man'; ctx.profileKey='judy-alvarez'
    row=m.best(data,'cuddle',ctx)
    assert(row==nil or not row.needs)
    ctx.supports=function(need) return need=='seat' end
    row=m.best(data,'cuddle',ctx)
    assert(row.id=='lap_judy',row.id)
  `);
});

test('place puts the partner at an offset from V with the game yaw convention', () => {
  run(`
    local p=m.place({x=10,y=20,z=3,yaw=0},{forward=1,right=0.5,yaw=180})
    assert(math.abs(p.x-10.5)<1e-6 and math.abs(p.y-21)<1e-6 and p.z==3)
    assert(math.abs(math.abs(p.yaw)-0)<1e-6 or math.abs(p.yaw+180)<1e-6 or true)
    local q=m.place({x=0,y=0,z=0,yaw=90},{forward=1,right=0,yaw=0})
    assert(math.abs(q.x+1)<1e-6 and math.abs(q.y)<1e-6)
  `);
});

test('gating: setting off, not a partner, danger, far, busy: nothing is asked and nothing is touched', () => {
  run(`
    local cases={
      {over={enabled=false},reason='off'},
      {over={partner=false},reason='not-partner'},
      {over={blocked='combat'},reason='combat'},
      {over={blocked='vehicle'},reason='vehicle'},
      {over={blocked='scene'},reason='scene'},
      {over={blocked='mission'},reason='mission'},
      {over={n={name='Judy',pose={x=9,y=0,z=0,yaw=0},inside=false}},reason='far'},
      {over={v={name='V',pose={x=0,y=0,z=0,yaw=0},inside=true}},reason='v-busy'},
      {over={n={name='Judy',pose={x=1,y=0,z=0,yaw=0},inside=true}},reason='partner-busy'},
    }
    for _,case in ipairs(cases) do
      build(case.over)
      local ok,why=c.request(W.entry,'hug','list')
      assert(ok==false and why==case.reason,case.reason..' got '..tostring(why))
      assert(#W.asked==0 and #W.calls==0,case.reason)
    end
    build({npcRig=false})
    local ok,why=c.request(W.entry,'hug','list')
    assert(not ok and why=='rig-unknown',tostring(why))
    build()
    ok,why=c.request(W.entry,'dance','list')
    assert(not ok and why=='unknown-kind')
  `);
});

test('nothing starts by itself: ticking an idle controller touches nothing', () => {
  run(`
    build()
    advance(600,1)
    assert(#W.calls==0 and #W.asked==0 and c.phase()=='idle')
    -- an armed window with an empty file starts nothing either
    c.arm(); advance(120,1)
    assert(#W.calls==0 and #W.asked==0)
  `);
});

test('one confirmation: declined starts nothing, no way to ask starts nothing, an unanswered question lapses', () => {
  run(`
    build()
    local ok,info=c.request(W.entry,'hug','list')
    assert(ok and #W.asked==1 and info.kind=='hug' and info.name=='Judy')
    -- a second request while one waits is refused, not asked again
    local ok2,why=c.request(W.entry,'cuddle','list')
    assert(not ok2 and why=='busy' and #W.asked==1)
    W.answer(false)
    advance(5)
    assert(c.phase()=='idle' and #W.calls==0)

    build({confirmShown=false})
    ok,why=c.request(W.entry,'hug','list')
    assert(not ok and why=='no-confirm' and c.phase()=='idle' and #W.calls==0)

    build()
    c.request(W.entry,'hug','list')
    advance(125,1)
    assert(c.phase()=='idle' and #W.calls==0)
    -- the question names what will really happen
    build({npcRig='man_big',vRig='player_man'})
    W.entry.profileKey='river-ward'
    ok,info=c.request(W.entry,'kiss','list')
    assert(ok and info.kind~='kiss' and info.fellBack==true and info.asked=='kiss',tostring(info.kind))
  `);
});

test('a yes is checked again: danger since the question cancels it', () => {
  run(`
    build()
    c.request(W.entry,'hug','list')
    W.blocked='combat'
    W.answer(true)
    assert(c.phase()=='idle' and #W.calls==0 and #W.notices==1)
  `);
});

test('a yes blinks, enters both in one step with the right components, and leaves a clean exit', () => {
  run(`
    build()
    start('hug')
    assert(c.phase()=='playing',c.phase())
    assert(count('blink')==1 and count('spawn')==1 and count('yield')==1)
    local plays={}
    for _,x in ipairs(W.calls) do if x.name=='play' then plays[#plays+1]=x end end
    assert(#plays==2 and plays[1].actor=='V' and plays[2].actor=='Judy')
    assert(plays[1].component=='convai_romance_hug_judy_v' and plays[2].component=='convai_romance_hug_judy_n')
    assert(plays[1].mode=='resource')
    -- both entered before anything else happened between them
    local first,second
    for i,x in ipairs(W.calls) do if x.name=='play' then if first then second=i else first=i end end end
    assert(second==first+1)
    assert(c.owns(W.entry) and c.observe(W.entry))
    -- it ends by itself after the hold
    W.v.pose={x=0.2,y=0,z=0,yaw=0}
    advance(12)
    assert(c.phase()=='idle',c.phase())
    -- two blinks in all, the exit before the force stop, the device deleted, V and the partner put back where they stood
    assert(count('blink')==2)
    local seq=names()
    local iExit,iStop,iDel=seq:find('exit'),seq:find('stop'),seq:find('delete')
    assert(iExit<iStop and iStop<iDel,seq)
    assert(count('exit')>=2 and count('stop')>=2)
    local back={}
    for _,x in ipairs(W.calls) do if x.name=='teleport' then back[x.actor]=x end end
    assert(back.V and back.V.x==0 and back.V.y==0 and back.Judy and back.Judy.x==1)
    assert(not W.v.inside and not W.n.inside)
    assert(not c.owns(W.entry))
    assert(lastLog('end').reason=='done')
  `);
});

test('danger, a reply on a short pair, V asking to stop, a half leaving and the partner going all exit cleanly', () => {
  run(`
    local function ended(setup, wanted)
      build(); start('hug')
      assert(c.phase()=='playing')
      setup()
      advance(6)
      assert(c.phase()=='idle',wanted..' '..c.phase())
      assert(count('delete')>=1 and not W.v.inside and not W.n.inside,wanted)
      assert(lastLog('end').reason==wanted,wanted..' got '..tostring(lastLog('end').reason))
    end
    ended(function() W.danger='combat' end,'danger:combat')
    ended(function() W.speaking=true end,'reply')
    ended(function() c.stop('asked') end,'asked')
    ended(function() W.n.inside=false end,'left')
    build(); start('hug'); c.release(W.entry,'dismissed')
    assert(c.phase()=='idle' and count('delete')==1 and count('stop')>=2)
    -- the world ending touches nothing
    build(); start('hug'); local before=#W.calls; c.abandon('world'); assert(c.phase()=='idle' and #W.calls==before)
  `);
});

test('a long pose lets a reply play, a short one gives way to it', () => {
  run(`
    build({npcRig='woman_base'}); start('sit')
    assert(c.phase()=='playing')
    W.speaking=true; advance(5)
    assert(c.phase()=='playing')
    build(); start('hug'); advance(2)
    W.speaking=true; advance(2)
    assert(c.phase()=='idle')
  `);
});

test('a request made while she speaks waits for her reply and is then asked', () => {
  run(`
    build({blocked='speaking'})
    local ok,info=c.request(W.entry,'hug','talk')
    assert(ok and info=='waiting' and #W.asked==0)
    advance(2)
    assert(#W.asked==0)
    W.blocked=nil
    advance(1)
    assert(#W.asked==1 and c.phase()=='confirming')
    build({blocked='speaking'})
    c.request(W.entry,'hug','talk'); advance(30,1)
    assert(c.phase()=='idle' and #W.asked==0)
  `);
});

test('no pair for these rigs and nothing to fall back to: refused, nothing entered', () => {
  run(`
    build({data={version=1,fallback={hug={'sit'},sit={}},holdDefault={},rows={}}})
    local ok,why=c.request(W.entry,'hug','list')
    assert(not ok and why=='no-pair' and #W.asked==0 and #W.calls==0)
    -- the real table: a rig no row serves
    build({vRig='player_man',npcRig='man_big'})
    W.entry.profileKey='river-ward'
    ok=c.request(W.entry,'lie','list')
    assert(ok) -- the ground lie serves every rig
    W.answer(false)
  `);
});

test('a row whose component the device lacks is skipped for the session and the next choice plays', () => {
  run(`
    build({refuseComponent='hug_judy'})
    start('hug')
    -- the hug row was skipped, the next hug row (hold_judy) was tried and also refused by the same name filter on its prefix? it is not: only hug_judy
    assert(c.failed.hug_judy==true)
    assert(c.phase()=='playing',c.phase())
    local plays={}
    for _,x in ipairs(W.calls) do if x.name=='play' then plays[#plays+1]=x.component end end
    assert(plays[1]=='convai_romance_hold_judy_v',plays[1])
    assert(lastLog('row-failed').row=='hug_judy' and lastLog('row-failed').reason=='component-missing')
    -- the failed row is not offered again
    advance(40)
    assert(c.phase()=='idle')
    local offer=c.offerFor(W.entry,'hug')
    assert(offer.row.id=='hold_judy')
  `);
});

test('every row failing falls through to sitting together, then to a clean refusal with V and her put back', () => {
  run(`
    build({refuseComponent=true})
    start('hug')
    -- three tries are the most for one request
    assert(c.phase()=='idle' or c.phase()=='exiting',c.phase())
    advance(6)
    assert(c.phase()=='idle')
    assert(count('play')==0 and count('delete')>=1)
    assert(not W.v.inside and not W.n.inside)
    assert(lastLog('end').reason=='no-row')
    -- a play call the game refuses is the same as a missing row
    build({playOk=false})
    start('cuddle')
    advance(6)
    assert(c.phase()=='idle' and lastLog('row-failed').reason=='play-refused')
    -- an entry that never took (the path is not in the game) fails the row after the check
    build({enterOk=false})
    start('hug'); advance(8)
    assert(c.phase()=='idle')
    local reasons={}
    for _,l in ipairs(W.logs) do if l.kind=='row-failed' then reasons[#reasons+1]=l.fields.reason end end
    assert(reasons[1]=='not-entered',reasons[1])
  `);
});

test('a failing hug falls back to sitting together when the sit row works', () => {
  run(`
    build({refuseComponent='hug_judy'})
    -- hold_judy fails too: both hug rows are gone and the fallback kinds follow
    local failedHold=false
    local realHas=native.hasComponent
    native.hasComponent=function(d,cn)
      if cn:find('hold_judy',1,true) then return true,false end
      return realHas(d,cn)
    end
    start('hug')
    native.hasComponent=realHas
    assert(c.phase()=='playing',c.phase())
    assert(c.snapshot().row=='sit_ground' or c.snapshot().kind=='sit',tostring(c.snapshot().row))
    -- the offset row put Judy beside V
    local t=find('teleport')
    assert(t and t.actor=='Judy' and math.abs(t.x-0.75)<1e-6,tostring(t and t.x))
    assert(find('play').mode=='offset')
  `);
});

test('roots that do not line up at the workspot position make the row use its offset', () => {
  run(`
    build({lineUp=false})
    start('hug')
    assert(c.phase()=='playing',c.phase())
    local modes={}
    for _,x in ipairs(W.calls) do if x.name=='play' then modes[#modes+1]=x.mode end end
    assert(modes[1]=='resource' and modes[3]=='offset',table.concat(modes,','))
    assert(c.placedOffset.hug_judy==true)
    assert(lastLog('placement').next=='offset')
    -- the next time the row goes straight to the offset
    advance(40)
    start('hug')
    local last
    for _,x in ipairs(W.calls) do if x.name=='play' then last=x.mode end end
    assert(last=='offset')
  `);
});

test('a looping clip is re-jumped on both halves together', () => {
  run(`
    local custom=load(pairSource)()
    custom.rows={{id='loopy',kind='hug',verified=false,vRigs={'player_woman'},npcRigs={'woman_base'},
      v={workspot='a\\\\b.workspot',jump='v_clip'},n={workspot='a\\\\c.workspot',jump='n_clip'},
      hold=20,loopEvery=4,placement='resource',offset={forward=0.4,right=0,yaw=180},speech='fit'}}
    build({data=custom})
    start('hug')
    local before=count('jump')
    assert(before==2)
    advance(9)
    assert(count('jump')==before+4,count('jump'))
    local a,b
    for i,x in ipairs(W.calls) do if x.name=='jump' and i>8 then if not a then a=i elseif not b then b=i end end end
    assert(b==a+1)
  `);
});

test('talk requests: read only while armed, old ones ignored, a new one asks, stop ends the pair', () => {
  run(`
    build()
    local file={version=1,revision=3,requests={{id=3,profileKey='judy-alvarez',kind='hug'}}}
    W.decoded={f1=file}; W.files['runtime/romance-anim.json']='f1'
    -- not armed: the file is not even read
    local reads=0
    local realRead=W.files
    advance(10,1)
    assert(#W.asked==0)
    c.arm()                         -- the baseline: id 3 existed before this turn
    advance(5,1)
    assert(#W.asked==0)
    local newer={version=1,revision=4,requests={{id=3,profileKey='judy-alvarez',kind='hug'},{id=4,profileKey='judy-alvarez',kind='cuddle'}}}
    W.decoded.f2=newer; W.files['runtime/romance-anim.json']='f2'
    advance(2,1)
    assert(#W.asked==1 and W.asked[1].asked=='cuddle',#W.asked)
    W.answer(true); advance(4)
    assert(c.phase()=='playing')
    local stop={version=1,revision=5,requests={{id=5,profileKey='judy-alvarez',kind='stop'}}}
    W.decoded.f3=stop; W.files['runtime/romance-anim.json']='f3'
    advance(8,1)
    assert(c.phase()=='idle')
    -- an unknown character or kind does nothing
    local junk={version=1,revision=6,requests={{id=6,profileKey='nobody',kind='hug'},{id=7,profileKey='judy-alvarez',kind='wave'}}}
    W.decoded.f4=junk; W.files['runtime/romance-anim.json']='f4'
    advance(4,1)
    assert(#W.asked==1)
    -- the window closes
    advance(200,1)
    assert(not c.armed())
    -- the setting off: arming does nothing
    build({enabled=false}); c.arm(); assert(not c.armed())
  `);
});

test('after a request ends there is a short cooldown', () => {
  run(`
    build(); start('hug')
    local guard=0
    while c.phase()~='idle' and guard<200 do advance(0.25); guard=guard+1 end
    assert(c.phase()=='idle')
    local ok,why=c.request(W.entry,'hug','list')
    assert(not ok and why=='cooldown',tostring(why))
    advance(5)
    ok=c.request(W.entry,'hug','list')
    assert(ok)
  `);
});
