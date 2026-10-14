import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fengari from 'fengari';

const read = name => readFileSync(new URL(`../mod/${name}.lua`, import.meta.url), 'utf8');
const source = read('speech-replay-probe'), speechSource = read('speech'), faceSource = read('facial-playback');
const diagnostics = read('diagnostics');
const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;

function run(body) {
  const state = lauxlib.luaL_newstate(); lualib.luaL_openlibs(state);
  const program = `
    local function clone(value)
      if type(value)~='table' then return value end
      local copy={}; for key,item in pairs(value) do copy[key]=clone(item) end; return copy
    end
    local now,world,paused,pregame,composer,submission,manager,phone,voice=1000,true,false,false,false,false,false,false,true
    local nativeBlocked,combat,starts,stops,cursor,resets,forbidden=false,false,0,0,0,0,0
    local playerID='current-player'
    local files,documents,reports,access,frames={},{},{},{},{}
    local function native() assert(world,'world torn down') end
    local player={
      IsAttached=function() native(); return true end, IsDeadNoStatPool=function() native(); return false end,
      GetEntityID=function() native(); return {hash=playerID} end,
      ConvaiComposerOpen=function() native(); return composer end,
      ConvaiHasSubmission=function() native(); return submission end,
      ConvaiManagerIsOpen=function() native(); return manager end,
      ConvaiPhoneIsOpen=function() native(); return phone end,
      ConvaiManagerVoice=function() native(); return voice end,
      ConvaiSpeechStart=function(_,actor,event) native(); starts=starts+1; cursor=0; return true end,
      ConvaiSpeechStop=function() native(); stops=stops+1 end,
      ConvaiSpeechPause=function() native() end,
      ConvaiSpeechPosition=function() native(); return cursor end}
    local function actor(id,key,distance)
      local npc={id=id,key=key,distance=distance,owned=true,ready=true,alive=true,attached=true}
      function npc:GetEntityID() native(); return {hash=self.id} end
      function npc:IsAttached() native(); return self.attached end
      function npc:IsDeadNoStatPool() native(); return not self.alive end
      function npc:ConvaiFaceReady() native(); return self.ready end
      function npc:ConvaiFaceApply(feature) native(); frames[#frames+1]=clone(feature); return true end
      function npc:ConvaiFaceReset() native(); resets=resets+1; return true end
      return npc
    end
    local judy=actor('current-owned-copy','judy-alvarez',2)
    local panam=actor('panam-copy','panam-palmer',1)
    local people={panam,judy}
    convaiCompanions={owns=function(npc) return npc.owned end,conversationCandidates=function(_,radius)
      assert(radius==8); local rows={}
      for _,npc in ipairs(people) do rows[#rows+1]={npc=npc,entity=npc.id,profileKey=npc.key,name='Companion',distance=npc.distance} end
      return rows
    end}
    Game={GetPlayer=function() return world and player or nil end,
      GetAllBlackboardDefs=function() return {UI_System={IsInMenu='menu'}} end,
      GetSystemRequestsHandler=function() return {IsPreGame=function() return pregame end,IsGamePaused=function() return paused end} end,
      GetBlackboardSystem=function() return {Get=function() return {GetBool=function() return paused end} end} end}
    CName={new=function(value) return value end}; NewObject=function() return {} end
    registerForEvent=function() forbidden=forbidden+1; error('no event hooks') end
    Observe=function() forbidden=forbidden+1; error('no observers') end
    os.time=function() return now end
    local encoded,encodedSequence={},0
    json={decode=function(raw) return clone(assert(documents[raw],'invalid JSON')) end,
      encode=function(value) encodedSequence=encodedSequence+1; local key='encoded-'..encodedSequence; encoded[key]=clone(value); return key end}
    local allowedRead={['runtime/speech-fixture.json']=true,['runtime/last-input.json']=true,
      ['runtime/reply.json']=true,['runtime/microphone-command.json']=true,['runtime/microphone-state.json']=true,
      ['face-test.lua']=true,
      -- speech.start reads the bridge's Lip sync delay once per utterance (bounded, read only).
      ['runtime/audio-delay.json']=true}
    local allowedWrite={['runtime/speech-fixture-result.json']=true,['runtime/speech-state.json']=true}
    io.open=function(path,mode)
      access[#access+1]={path=path,mode=mode}
      if mode=='rb' then
        if not allowedRead[path] then forbidden=forbidden+1; error('unexpected read') end
        if not files[path] then return nil end
        return {read=function(_,bound) assert(type(bound)=='number'); return files[path]:sub(1,bound) end,close=function() end}
      end
      if not allowedWrite[path] then forbidden=forbidden+1; error('unexpected write') end
      return {write=function(_,raw) reports[path]=clone(encoded[raw]) end,close=function() end}
    end
    local captions={clear=function() convaiSubtitles.line=nil end,show=function() end,enabled=function() return true end,
      beginTimed=function() convaiSubtitles.line=true end,syncTimed=function() end}
    convaiSubtitles=captions
    local observer={sample=function() return {available=true,blocked=nativeBlocked,combat=combat} end,
      canSpeak=function(npc) return npc.attached and npc.alive and not npc.nativeBusy end}
    local face=(function() ${faceSource} end)()
    dofile=function(path)
      if path=='facial-playback.lua' then return face end
      if path=='subtitles.lua' then return captions end
      if path=='battle-observer.lua' then return observer end
      if path=='continuous-speech.lua' then error('no browser renderer in local probe') end
      forbidden=forbidden+1; error('unexpected module')
    end
    local speech=(function() ${speechSource} end)()
    speech.available=true
    local function loadProbe() return (function() ${source} end)() end
    local probe=loadProbe()
    local doc={version=1,nonce='probe-0001',profileKey='judy-alvarez',expiresAt=1120,
      audio={slot=1,event='convai_reply_1',duration=2},
      face={version=1,requestId='old-source-owner',entity='old-source-actor',generation=83,
        source='convai-arkit61',articulation='arkit61-native-v7',duration=2,
        tracks={'jaw_mid_open','lips_together_up','lips_l_upper_raise'},
        frames={{0,0,0,0},{.5,.2,.68,.04},{2,0,0,0}}}}
    files['runtime/speech-fixture.json']='fixture'; documents.fixture=doc
    local function start() return probe.run('speech-fixture:judy-alvarez:'..doc.nonce) end
    local function status() return reports['runtime/speech-fixture-result.json'].status end
    local function finish() cursor=.5; speech.update(.5); cursor=2; speech.update(1.5) end
    ${body}
    assert(forbidden==0,'Probe accessed a non-diagnostic boundary')
  `;
  try {
    const code = lauxlib.luaL_dostring(state, to_luastring(program));
    const error = code === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(state, -1));
    const line = Number(/\]:(\d+):/.exec(error)?.[1]);
    assert.equal(code, lua.LUA_OK, error + (line ? `\n${program.split('\n')[line-1]}` : ''));
  } finally { lua.lua_close(state); }
}

test('local fixture goes through real native speech and face playback, with fresh exact-copy ownership and cleanup', () => run(`
  assert(start() and status()=='started' and starts==1)
  assert(speech.actor==judy and speech.requestId=='fixture-probe-0001' and speech.context.entity==judy.id)
  assert(face.timeline.requestId==speech.requestId and face.generation==speech.context.generation)
  assert(doc.face.requestId=='old-source-owner' and doc.face.entity=='old-source-actor' and doc.face.generation==83)
  cursor=.5; speech.update(.5)
  assert(#frames==1 and frames[1].jaw_mid_open==.2 and frames[1].lips_together_up==.68 and frames[1].lips_l_upper_raise==.04)
  cursor=2; speech.update(1.5)
  assert(not speech.requestId and not face.active and resets==1 and speech.lastDelivery.state=='completed')
  local report=reports['runtime/speech-fixture-result.json']
  assert(report.duration==2 and report.source=='convai-arkit61' and report.format=='native-wav')
  local known={status=true,duration=true,source=true,format=true}
  for key in pairs(report) do assert(known[key],'Unexpected private report field') end
  assert(probe.player==nil and probe.actor==nil and probe.npc==nil)
`));

test('expired, overlong, wrong-profile and consumed nonce fixtures never start again, including after module reload', () => run(`
  doc.expiresAt=1000; assert(not start() and status()=='fixture-expired')
  doc.expiresAt=1121; assert(not start() and status()=='fixture-expired')
  doc.expiresAt=1120; doc.profileKey='panam-palmer'; assert(not start() and status()=='fixture-stale')
  doc.profileKey='judy-alvarez'; assert(not probe.run('speech-fixture:judy-alvarez:wrong-0000') and status()=='fixture-stale')
  assert(start()); finish(); probe=loadProbe(); assert(not start() and status()=='fixture-consumed' and starts==1)
`));

test('oversized or malformed fixture JSON fails closed before native playback', () => run(`
  files['runtime/speech-fixture.json']=string.rep('x',2097153)
  assert(not start() and status()=='fixture-invalid')
  files['runtime/speech-fixture.json']='broken'
  assert(not start() and status()=='fixture-invalid' and starts==0)
`));

test('file audio is limited to one known short native slot and rejects stream descriptors', () => run(`
  local original=clone(doc)
  for _,bad in ipairs({{slot=8,event='convai_reply_8',duration=2},{slot=.5,event='convai_reply_0',duration=2},
      {slot=1,event='other_event',duration=2},{slot=1,event='convai_reply_1',duration=15.1},
      {slot=1,event='convai_reply_1',duration=0},{slot=1,event='convai_reply_1',duration=0/0}}) do
    doc.audio=bad; assert(not start() and status()=='fixture-audio')
  end
  doc.audio=original.audio; doc.continuous={id='consumed'}; assert(not start() and status()=='fixture-audio')
  doc.continuous=nil; doc.stream={version=2}; assert(not start() and status()=='fixture-audio' and starts==0)
`));

test('mapped face rejects unknown or duplicate tracks, oversized curves, bad bounds and incomplete or foreign segment timelines', () => run(`
  local original=clone(doc.face)
  local cases={function(f) f.tracks[1]='unknown' end,function(f) f.tracks[2]='jaw_mid_open' end,
    function(f) f.frames[2][2]=.7001 end,function(f) f.frames[2][3]=1.0001 end,function(f) f.frames[2][4]=.5001 end,
    function(f) f.frames[2][4]=-1 end,function(f) f.frames[2][2]=0/0 end,
    function(f) f.frames[1][1]=.01 end,function(f) f.frames[3][1]=1.9 end,
    function(f) f.frames[2][1]=2 end,function(f) f.frames[2][5]=0 end,
    function(f) f.duration=2.1 end,function(f) f.source='invented' end,
    function(f) f.segment={index=1} end,function(f) f.continuous=true end,
    function(f) for i=4,903 do f.frames[i]={2,0,0,0} end end}
  for _,change in ipairs(cases) do doc.face=clone(original);change(doc.face); assert(not start() and status()=='fixture-face') end
  assert(starts==0)
`));

test('native controls admit the game lipsync ranges (incl. model puff/cheek/tongue) without widening other bounds', () => run(`
  doc.face.tracks={'jaw_mid_open','lips_apart_up','lips_apart_dn','lips_together_up','lips_together_dn',
    'lips_l_funnel','lips_r_funnel','lips_l_purse','lips_r_purse','lips_l_stretch','lips_r_stretch',
    'lips_l_lower_raise','lips_r_lower_raise','lips_tighten_up','lips_tighten_dn','lips_suck_dn',
    'tongue_mid_tip_up','lips_l_upper_raise','lips_r_upper_raise','lips_l_corner_stretch','lips_r_corner_stretch','lips_suck_up',
    'lips_puff_up','lips_puff_dn','cheek_l_puff','cheek_r_puff','tongue_mid_fwd'}
  doc.face.source='local-jali';doc.face.articulation='jali-audio-v1'
  doc.face.frames={{0},{.5},{2}}
  for i=2,28 do doc.face.frames[1][i]=0;doc.face.frames[2][i]=.1;doc.face.frames[3][i]=0 end
  doc.face.frames[2][23]=.300001; assert(not start() and status()=='fixture-face')
  doc.face.frames[2][23]=.29; doc.face.frames[2][28]=.500001; assert(not start() and status()=='fixture-face')
  doc.face.frames[2][28]=.1; doc.face.frames[2][24]=.45; assert(start()); cursor=.5;speech.update(.5)
  -- A model timeline's jaw is written at its reach (modelReach, October 15); the bounds themselves are unchanged.
  assert(face.active and frames[1].lips_suck_up==.29 and frames[1].jaw_mid_open==.1*face.modelReach.jaw_mid_open and frames[1].lips_puff_up==.45)
`));

test('busy speech, silent face probe, group round, phone and native UI all block without interrupting an owner', () => run(`
  speech.requestId='real-turn'; assert(not start() and status()=='blocked-speech' and stops==0)
  speech.requestId=nil; convaiFaceProbe={active=true}; assert(not start() and status()=='blocked-speech'); convaiFaceProbe=nil
  convaiGroupChat={round={}}; assert(not start() and status()=='blocked-conversation'); convaiGroupChat=nil
  convaiPhoneChat={pending={}}; assert(not start() and status()=='blocked-conversation'); convaiPhoneChat=nil
  composer=true; assert(not start() and status()=='blocked-ui'); composer=false
  submission=true; assert(not start() and status()=='blocked-ui'); submission=false
  manager=true; assert(not start() and status()=='blocked-ui'); manager=false
  phone=true; assert(not start() and status()=='blocked-ui'); phone=false
  paused=true; assert(not start() and status()=='blocked-world'); paused=false
  pregame=true; assert(not start() and status()=='blocked-world'); pregame=false
  voice=false; assert(not start() and status()=='blocked-muted')
  assert(starts==0 and stops==0)
`));

test('awaiting or malformed reply mailboxes block; reply ownership must match exactly', () => run(`
  local owner={requestId='user-turn',entity='live-copy',generation=4}
  files['runtime/last-input.json']='input';documents.input=owner
  assert(not start() and status()=='blocked-reply')
  files['runtime/reply.json']='reply'; documents.reply=clone(owner)
  for _,key in ipairs({'requestId','entity','generation'}) do
    documents.reply=clone(owner);documents.reply[key]=key=='generation' and 3 or 'other'
    assert(not start() and status()=='blocked-reply')
  end
  documents.reply=clone(owner); files['runtime/reply.json']='broken'; assert(not start() and status()=='blocked-reply')
  files['runtime/reply.json']='reply'; assert(start() and starts==1)
`));

test('outstanding microphone start or finish needs matching terminal acknowledgement', () => run(`
  files['runtime/microphone-command.json']='mic-command'; files['runtime/microphone-state.json']='mic-state'
  documents['mic-command']={action='start',input={requestId='mic-turn',entity='copy',generation=1}}
  for _,state in ipairs({'starting','recording','reply','processing','unknown'}) do
    documents['mic-state']={requestId='mic-turn',state=state}; assert(not start() and status()=='blocked-microphone')
  end
  documents['mic-command'].action='finish'; documents['mic-state']={requestId='old-mic',state='off'}
  assert(not start() and status()=='blocked-microphone')
  documents['mic-state'].requestId='mic-turn'; assert(start()); finish()
  doc.nonce='probe-0002'; documents['mic-command'].action='cancel'; documents['mic-state'].state='recording'
  assert(start() and starts==2)
`));

test('unknown or missing microphone completion and broken command JSON do not get treated as idle', () => run(`
  files['runtime/microphone-command.json']='mic-command'
  documents['mic-command']={action='finish',input={requestId='mic-turn',entity='copy',generation=1}}
  assert(not start() and status()=='blocked-microphone')
  documents['mic-command'].action='unknown'; assert(not start() and status()=='blocked-microphone')
  files['runtime/microphone-command.json']='broken'; assert(not start() and status()=='blocked-microphone' and starts==0)
`));

test('only a nearby live owned ready exact profile can be the replay actor', () => run(`
  judy.owned=false; assert(not start() and status()=='blocked-companion'); judy.owned=true
  judy.ready=false; assert(not start() and status()=='blocked-companion'); judy.ready=true
  judy.distance=9; assert(not start() and status()=='blocked-companion'); judy.distance=2
  judy.alive=false; assert(not start() and status()=='blocked-companion'); judy.alive=true
  judy.attached=false; assert(not start() and status()=='blocked-companion'); judy.attached=true
  judy.nativeBusy=true; assert(not start() and status()=='blocked-companion'); judy.nativeBusy=false
  nativeBlocked=true; assert(not start() and status()=='blocked-world'); nativeBlocked=false
  combat=true; assert(not start() and status()=='blocked-world'); combat=false
  assert(starts==0 and start() and speech.actor==judy)
`));

test('cancellation binds nonce, request, generation and exact entity; it cannot stop newer speech', () => run(`
  assert(start()); cursor=.5; speech.update(.5)
  local before=stops
  assert(not probe.run('speech-fixture:cancel:wrong-0000') and status()=='cancel-not-owned' and stops==before)
  local context={requestId='new-user-turn',entity=judy.id,generation=24,name='Judy'}
  local reply={text='User reply',audio={slot=2,event='convai_reply_2',duration=2},face=clone(doc.face)}
  reply.face.requestId=context.requestId;reply.face.entity=context.entity;reply.face.generation=context.generation
  speech.target=judy; assert(speech.start(context,reply)); before=stops
  assert(probe.run('speech-fixture:cancel:probe-0001') and status()=='inactive')
  assert(speech.requestId=='new-user-turn' and stops==before)
`));

test('the current diagnostic cancels normally, but unload cancellation never queries a destroyed actor', () => run(`
  assert(start()); cursor=.5; speech.update(.5)
  assert(probe.run('speech-fixture:cancel:probe-0001') and status()=='cancelled')
  assert(not speech.requestId and resets==1)
  doc.nonce='probe-0002'; assert(start()); world=false
  assert(probe.run('speech-fixture:cancel:probe-0002') and status()=='cancelled' and not speech.requestId)
  assert(not face.active and not speech.actor and resets==1)
`));

test('same request text cannot authorize cancellation after generation or actor ownership changes', () => run(`
  assert(start()); local previous=stops
  speech.context.generation=speech.context.generation+1
  assert(probe.run('speech-fixture:cancel:probe-0001') and status()=='inactive' and stops==previous)
  assert(speech.requestId=='fixture-probe-0001'); speech.stop('user-owner')
  doc.nonce='probe-0002'; assert(start()); previous=stops
  speech.context.entity='new-copy'
  assert(probe.run('speech-fixture:cancel:probe-0002') and status()=='inactive' and stops==previous)
  assert(speech.requestId=='fixture-probe-0002')
`));

test('production lifecycle still handles target loss, pause and world replacement during a replay', () => run(`
  assert(start());cursor=.5;speech.update(.5); paused=true;speech.update(.1)
  assert(speech.paused and speech.requestId and face.state=='paused')
  paused=false;cursor=.7;speech.update(.2);assert(face.active and not speech.paused)
  judy.alive=false;speech.update(.1);assert(not speech.requestId and not face.active)
  judy.alive=true;doc.nonce='probe-0002';assert(start());playerID='loaded-save-player';speech.update(.1)
  assert(not speech.requestId and not speech.actor and not face.active)
`));

test('native failure cannot leak an exception or old text into the report and a failed nonce is consumed', () => run(`
  player.ConvaiSpeechStart=function() starts=starts+1; error('private native message') end
  assert(not start() and status()=='playback-failed' and starts==1 and not speech.requestId)
  assert(not start() and status()=='fixture-consumed' and starts==1)
  local report=reports['runtime/speech-fixture-result.json']
  assert(report.error==nil and report.text==nil and report.requestId==nil and report.entity==nil)
`));

test('diagnostics dispatches the fixture handler without loading or replacing the live speech owner', () => {
  const start = diagnostics.indexOf("if request:match('^speech%-fixture:')");
  assert.ok(start >= 0);
  const branch = diagnostics.slice(start, diagnostics.indexOf("if request:match('^speech%-install:')", start));
  assert.match(branch, /dofile\('speech-replay-probe\.lua'\)\.run\(request\)/);
  assert.doesNotMatch(branch, /speech\.lua|registerForEvent|Observe|last-input|reply\.json/);
  assert.match(diagnostics, /request:match\('\^party%-face%-roll:'/);
});
