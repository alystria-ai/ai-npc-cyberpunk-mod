import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fengari from 'fengari';
const source=readFileSync(new URL('../mod/face-probe.lua',import.meta.url),'utf8');
const diagnostics=readFileSync(new URL('../mod/diagnostics.lua',import.meta.url),'utf8');
const {lua,lauxlib,lualib,to_luastring,to_jsstring}=fengari;
function run(body) {
  const state=lauxlib.luaL_newstate(); lualib.luaL_openlibs(state);
  const status=lauxlib.luaL_dostring(state,to_luastring(`
    local report,now,menu,frames,resets,queries,updates,stops,abandons=nil,100,false,{},0,0,0,0,0
    local owned,ready,available,playerID=true,true,true,'player'
    os.time=function() return now end
    json={encode=function(value) report=value; return '{}' end}
    io.open=function() return {write=function() end,close=function() end} end
    registerForEvent=function() error('must not register CET events at runtime') end
    local player={IsAttached=function() return true end,IsDeadNoStatPool=function() return false end,
      GetEntityID=function() return {hash=playerID} end}
    local npc={ConvaiFaceReady=function() return ready end,ConvaiFaceStatus=function() return 'ready' end,
      ConvaiFaceApply=function(_,feature) frames[#frames+1]=feature; return true end,
      ConvaiFaceReset=function() resets=resets+1; return true end}
    Game={GetPlayer=function() queries=queries+1; return player end,
      GetAllBlackboardDefs=function() return {UI_System={IsInMenu='menu'}} end,
      GetBlackboardSystem=function() return {Get=function() return {GetBool=function() return menu end} end} end}
    NewObject=function() return {} end
    convaiCompanions={owns=function() return owned end,
      conversationCandidates=function() return available and {{entity='judy1',name='Judy',profileKey='judy-alvarez',npc=npc}} or {} end}
    local originalUpdate=function(delta) updates=updates+1; return delta,'update-result' end
    local originalStop=function(reason) stops=stops+1; return reason,'stop-result' end
    local originalAbandon=function() abandons=abandons+1; return 'abandon-result' end
    convaiSpeech={update=originalUpdate,stop=originalStop,abandon=originalAbandon}
    local probe=(function() ${source} end)()
    ${body}
  `));
  const error=status===lua.LUA_OK?'':to_jsstring(lua.lua_tostring(state,-1));
  lua.lua_close(state); assert.equal(status,lua.LUA_OK,error);
}

test('live-loaded jaw proof uses existing frames, completes two pulses, resets and restores delegates',()=>run(`
  probe.start('judy-alvarez')
  for i=1,160 do convaiSpeech.update(1/30) end
  assert(report.state=='completed' and report.restored and not probe.active)
  assert(#frames>=148 and #frames<=151 and resets==1)
  assert(frames[1].jaw_mid_open<0.01 and frames[38].jaw_mid_open>0.34)
  assert(frames[75].jaw_mid_open<0.01 and frames[113].jaw_mid_open>0.34)
  assert(updates==160 and convaiSpeech.update==originalUpdate)
  assert(convaiSpeech.stop==originalStop and convaiSpeech.abandon==originalAbandon)
`));

test('session unload drops the proof without querying destroyed actors',()=>run(`
  probe.start('judy-alvarez'); convaiSpeech.update(0.1)
  local before=queries
  Game.GetPlayer=function() error('native world has been destroyed') end
  convaiSpeech.abandon()
  assert(queries==before and resets==0 and abandons==1)
  assert(not probe.active and report.state=='unloaded' and not probe.entity)
  assert(convaiSpeech.update==originalUpdate)
`));

test('shutdown, menu and incoming speech each stop the diagnostic and restore the face',()=>run(`
  probe.start('judy-alvarez'); convaiSpeech.stop('shutdown')
  assert(report.state=='shutdown' and resets==1 and stops==1)
  probe.start('judy-alvarez'); menu=true; convaiSpeech.update(0)
  assert(report.state=='interrupted' and resets==2); menu=false
  probe.start('judy-alvarez'); convaiSpeech.requestId='real speech'; convaiSpeech.update(0.1)
  assert(report.state=='interrupted' and resets==3)
`));

test('deadline cancels zero-time updates and one probe cannot stack tick delegates',()=>run(`
  probe.start('judy-alvarez'); probe.start('judy-alvarez')
  convaiSpeech.update(0.1)
  assert(updates==1 and #frames==1 and resets==1)
  now=113; convaiSpeech.update(0)
  assert(report.state=='deadline' and resets==2 and convaiSpeech.update==originalUpdate)
`));

test('silent articulation compares rounded and wide lips at the same jaw opening, then returns to neutral',()=>run(`
  probe.start('judy-alvarez','articulation')
  for i=1,460 do convaiSpeech.update(1/60) end
  assert(report.state=='completed' and report.restored and report.duration==7.5 and resets==1)
  assert(report.mode=='articulation' and not probe.active and #frames>=220 and #frames<=225)
  local seen={}
  for _,sample in ipairs(report.samples) do
    seen[sample.phase]=true
    assert(sample.controls and sample.jaw==sample.controls.jaw_mid_open)
    for track,value in pairs(sample.controls) do
      assert(type(value)=='number' and value==value and value>=0 and value<=.4)
      assert(not track:match('upper_raise') and not track:match('eye') and not track:match('head'))
    end
    if sample.at>.4 and sample.at<5.8 then assert(sample.jaw==.14) end
    if sample.phase=='rounded' and sample.at>2.2 then
      assert(sample.controls.lips_l_funnel==.32 and sample.controls.lips_r_purse==.28)
      assert(sample.controls.lips_l_corner_stretch==0)
    elseif sample.phase=='wide' and sample.at>4.2 then
      assert(sample.controls.lips_l_corner_stretch==.23 and sample.controls.lips_r_stretch==.14)
      assert(sample.controls.lips_apart_dn==.18 and sample.controls.lips_l_funnel==0)
    end
  end
  assert(seen.baseline and seen.rounded and seen.wide and seen.neutral)
  for _,value in pairs(frames[#frames]) do assert(value==0) end
  assert(report.entity==nil and report.playerID==nil and report.requestId==nil and report.name==nil)
  assert(probe.actor==nil and probe.npc==nil and probe.player==nil)
  assert(convaiSpeech.update==originalUpdate and updates==460)
`));

test('articulation uses smooth bounded transitions rather than changing the jaw for each shape',()=>run(`
  probe.start('judy-alvarez','articulation')
  for i=1,450 do convaiSpeech.update(1/60) end
  local previous
  for _,frame in ipairs(frames) do
    for track,value in pairs(frame) do
      assert(value>=0 and value<=.4 and value==value)
      if previous then assert(math.abs(value-previous[track])<.06) end
    end
    previous=frame
  end
`));

test('articulation cancellation preserves delegate results and newer delegate ownership',()=>run(`
  probe.start('judy-alvarez','articulation')
  local a,b=convaiSpeech.update(.1); assert(a==.1 and b=='update-result')
  local replacement=function() return 'new-owner' end
  convaiSpeech.update=replacement
  local reason,result=convaiSpeech.stop('shutdown')
  assert(reason=='shutdown' and result=='stop-result' and resets==1)
  assert(convaiSpeech.update==replacement and convaiSpeech.stop==originalStop)
  assert(not probe.active and report.state=='shutdown')
`));

test('detail probe isolates lip lift and seal with a fixed jaw and restores its owner',()=>run(`
  probe.start('judy-alvarez','detail')
  for i=1,550 do convaiSpeech.update(1/60) end
  assert(report.state=='completed' and report.restored and report.duration==9 and resets==1)
  local seen={}
  for _,sample in ipairs(report.samples) do
    seen[sample.phase]=true
    for track,value in pairs(sample.controls) do
      local cap=track:match('^lips_together_') and .85 or .35
      assert(value==value and value>=0 and value<=cap)
      assert(not track:match('eye') and not track:match('head'))
    end
    if sample.at>.4 and sample.at<7.4 then assert(sample.jaw==.14) end
    if sample.phase=='upper' and sample.at>1.8 then
      assert(sample.controls.lips_l_upper_raise==.06 and sample.controls.lips_r_upper_raise==.06)
      assert(sample.controls.lips_l_lower_raise==0 and sample.controls.lips_together_up==0)
    elseif sample.phase=='lower' and sample.at>3.8 then
      assert(sample.controls.lips_l_lower_raise==.08 and sample.controls.lips_suck_dn==.06)
      assert(sample.controls.lips_l_upper_raise==0 and sample.controls.lips_together_up==0)
    elseif sample.phase=='seal' and sample.at>5.8 then
      assert(sample.controls.lips_together_up==.85 and sample.controls.lips_together_dn==.85)
      assert(sample.controls.lips_apart_up==0 and sample.controls.lips_l_lower_raise==0)
    end
  end
  assert(seen.baseline and seen.upper and seen.lower and seen.seal and seen.neutral)
  for _,value in pairs(frames[#frames]) do assert(value==0) end
  assert(convaiSpeech.update==originalUpdate and not probe.active)
  probe.start('judy-alvarez','detail'); menu=true; convaiSpeech.update(.1)
  assert(report.state=='interrupted' and report.restored and resets==2)
`));

test('upper-roll probe compares independent depth motion and its contact interaction at a fixed jaw',()=>run(`
  probe.start('judy-alvarez','roll')
  for i=1,460 do convaiSpeech.update(1/60) end
  assert(report.state=='completed' and report.restored and report.duration==7.5 and resets==1)
  local seen={}
  for _,sample in ipairs(report.samples) do
    seen[sample.phase]=true
    for track,value in pairs(sample.controls) do
      local cap=track:match('^lips_together_') and .85 or track=='lips_suck_up' and .06 or .14
      assert(value==value and value>=0 and value<=cap)
    end
    if sample.at>.4 and sample.at<6.2 then assert(sample.jaw==.14) end
    if sample.phase=='small-roll' and sample.at>1.8 then
      assert(sample.controls.lips_suck_up==.03 and sample.controls.lips_apart_up==.04)
    elseif sample.phase=='upper-roll' and sample.at>3.4 then
      assert(sample.controls.lips_suck_up==.06 and sample.controls.lips_l_upper_raise==.06)
    elseif sample.phase=='seal' and sample.at>5 then
      assert(sample.controls.lips_suck_up==.06 and sample.controls.lips_together_up==.85)
    end
  end
  assert(seen.baseline and seen['small-roll'] and seen['upper-roll'] and seen.seal and seen.neutral)
  for _,value in pairs(frames[#frames]) do assert(value==0) end
  assert(convaiSpeech.update==originalUpdate and not probe.active)
  probe.start('judy-alvarez','roll');menu=true;convaiSpeech.update(.1)
  assert(report.state=='interrupted' and report.restored and resets==2)
`));

test('lower-lip directional probe separates aperture, each half, paired motion and neutral reset',()=>run(`
  probe.start('judy-alvarez','lower')
  for i=1,580 do convaiSpeech.update(1/60) end
  assert(report.state=='completed' and report.restored and report.duration==9.5 and resets==1)
  local seen={}
  for _,sample in ipairs(report.samples) do
    seen[sample.phase]=true
    for _,value in pairs(sample.controls) do assert(value==value and value>=0 and value<=.14) end
    if sample.at>.4 and sample.at<7.9 then assert(sample.jaw==.14) end
    if sample.phase=='aperture' and sample.at>1.6 then
      assert(sample.controls.lips_apart_dn==.12 and sample.controls.lips_l_lower_raise==0)
    elseif sample.phase=='small-lower' and sample.at>2.9 then
      assert(sample.controls.lips_l_lower_raise==.06 and sample.controls.lips_r_lower_raise==.06)
    elseif sample.phase=='left-lower' and sample.at>4.2 then
      assert(sample.controls.lips_l_lower_raise==.12 and sample.controls.lips_r_lower_raise==0)
    elseif sample.phase=='right-lower' and sample.at>5.5 then
      assert(sample.controls.lips_r_lower_raise==.12 and sample.controls.lips_l_lower_raise==0)
    elseif sample.phase=='both-lower' and sample.at>6.8 then
      assert(sample.controls.lips_l_lower_raise==.12 and sample.controls.lips_r_lower_raise==.12)
    end
  end
  assert(seen.baseline and seen.aperture and seen['small-lower'] and seen['left-lower']
    and seen['right-lower'] and seen['both-lower'] and seen.neutral)
  for _,value in pairs(frames[#frames]) do assert(value==0) end
  assert(convaiSpeech.update==originalUpdate and not probe.active)
  probe.start('judy-alvarez','lower');convaiSpeech.requestId='new-real-speech';convaiSpeech.update(.1)
  assert(report.state=='interrupted' and report.restored and resets==2)
`));

test('closure probe holds contact while spanning the admitted jaw range, then releases and resets',()=>run(`
  probe.start('judy-alvarez','closure')
  for i=1,550 do convaiSpeech.update(1/60) end
  assert(report.state=='completed' and report.restored and report.duration==9 and resets==1)
  local seen={}
  for _,sample in ipairs(report.samples) do
    seen[sample.phase]=true
    for track,value in pairs(sample.controls) do
      assert(value==value and value>=0 and value<=(track=='jaw_mid_open' and .40 or .85))
    end
    if sample.at>1.3 and sample.at<5.7 then
      assert(sample.controls.lips_together_up==.85 and sample.controls.lips_together_dn==.85)
    end
    if sample.phase=='seal-max' and sample.at>4.9 then assert(sample.jaw==.4) end
    if sample.phase=='released-max' and sample.at>6.1 then
      assert(sample.jaw==.4 and sample.controls.lips_together_up==0)
    end
  end
  assert(seen.baseline and seen['seal-low'] and seen['seal-mid'] and seen['seal-high']
    and seen['seal-max'] and seen['released-max'] and seen.neutral)
  for _,value in pairs(frames[#frames]) do assert(value==0) end
  assert(convaiSpeech.update==originalUpdate and not probe.active)
`));

test('articulation rejects unsupported ownership or readiness, and resets before incoming speech applies',()=>run(`
  owned=false; assert(not pcall(probe.start,'judy-alvarez','articulation') and #frames==0)
  owned=true; ready=false; assert(not pcall(probe.start,'judy-alvarez','articulation') and #frames==0)
  ready=true; assert(not pcall(probe.start,'judy-alvarez','unknown') and #frames==0)
  convaiSpeech.update=function(delta)
    updates=updates+1
    assert(resets==1,'Diagnostic reset must precede the incoming speech frame')
    return delta,'real-speech'
  end
  probe.start('judy-alvarez','articulation'); convaiSpeech.requestId='real speech'
  local delta,result=convaiSpeech.update(.1)
  assert(delta==.1 and result=='real-speech' and report.state=='interrupted' and #frames==0)
`));

test('articulation cancels on target loss, player replacement, menu, deadline and native rejection',()=>run(`
  probe.start('judy-alvarez','articulation'); available=false; convaiSpeech.update(.1)
  assert(report.state=='target-lost' and not report.restored and resets==0 and #frames==0)
  available=true; probe.start('judy-alvarez','articulation'); playerID='other'; convaiSpeech.update(.1)
  assert(report.state=='target-lost' and not report.restored and resets==0)
  playerID='player'; probe.start('judy-alvarez','articulation'); menu=true; convaiSpeech.update(.1)
  assert(report.state=='interrupted' and resets==1 and #frames==0); menu=false
  probe.start('judy-alvarez','articulation'); now=113; convaiSpeech.update(0)
  assert(report.state=='deadline' and resets==2)
  probe.start('judy-alvarez','articulation'); npc.ConvaiFaceApply=function() return false end
  convaiSpeech.update(.1); assert(report.state=='error' and report.restored and resets==3)
`));

test('articulation unload abandons without touching actors and preserves the original result',()=>run(`
  probe.start('judy-alvarez','articulation'); convaiSpeech.update(.1)
  local before=queries; Game.GetPlayer=function() error('native world destroyed') end
  assert(convaiSpeech.abandon()=='abandon-result')
  assert(queries==before and resets==0 and report.state=='unloaded' and not probe.active)
  assert(not probe.entity and not probe.playerID and convaiSpeech.abandon==originalAbandon)
`));

test('non-finite frame delta cancels before any unbounded feature reaches the native actor',()=>run(`
  probe.start('judy-alvarez','articulation'); convaiSpeech.update(0/0)
  assert(report.state=='error' and report.restored and resets==1 and #frames==0)
  probe.start('judy-alvarez','articulation'); convaiSpeech.update(math.huge)
  assert(report.state=='error' and resets==2 and #frames==0)
`));

test('native resolution errors cannot leave a diagnostic delegate installed during cleanup',()=>run(`
  probe.start('judy-alvarez','articulation')
  local getPlayer=Game.GetPlayer
  Game.GetPlayer=function() error('native player unavailable') end
  local delta,result=convaiSpeech.update(.1)
  assert(delta==.1 and result=='update-result' and report.state=='error' and not report.restored)
  assert(not probe.active and not probe.hook and resets==0 and convaiSpeech.update==originalUpdate)
  Game.GetPlayer=getPlayer
  probe.start('judy-alvarez','articulation')
  convaiCompanions.conversationCandidates=function() error('native actor unavailable') end
  local reason,stopped=convaiSpeech.stop('shutdown')
  assert(reason=='shutdown' and stopped=='stop-result' and report.state=='shutdown')
  assert(not probe.active and not probe.hook and not report.restored and convaiSpeech.stop==originalStop)
`));

test('cancelling an already completed probe cannot reset a newer speech owner',()=>run(`
  probe.start('judy-alvarez','articulation')
  for i=1,230 do convaiSpeech.update(1/30) end
  assert(report.state=='completed' and resets==1 and not probe.active)
  local before=queries; convaiSpeech.requestId='new speech'
  probe.stop('cancelled')
  assert(resets==1 and queries==before and convaiSpeech.requestId=='new speech')
  assert(convaiSpeech.update==originalUpdate and not probe.hook)
`));

test('actual diagnostics routes the articulation trigger and cancellation without CET registrations',()=>run(`
  local request='party-face-articulation:judy-alvarez:bounded-test'
  io.open=function(path,mode)
    if path=='runtime/diagnostic-request.txt' then
      return {read=function() return request end,close=function() end}
    end
    return {write=function() end,close=function() end}
  end
  dofile=function(path) assert(path=='face-probe.lua'); return probe end
  local diagnose=function() ${diagnostics} end
  diagnose(); assert(probe.active and report.mode=='articulation' and report.duration==7.5)
  request='party-face-articulation:cancel:bounded-test'; diagnose()
  assert(report.state=='cancelled' and resets==1 and not probe.active)
  for _,mode in ipairs({'roll','lower','closure'}) do
    request='party-face-'..mode..':judy-alvarez:bounded-test';diagnose()
    assert(probe.active and report.mode==mode)
    request='party-face-'..mode..':cancel:bounded-test';diagnose()
    assert(report.state=='cancelled' and not probe.active)
  end
  request='party-face-probe:judy-alvarez:old-test'; diagnose()
  assert(probe.active and report.mode=='jaw' and report.duration==5)
  probe.stop('cancelled')
`));
