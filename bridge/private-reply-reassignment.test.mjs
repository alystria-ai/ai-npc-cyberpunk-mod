import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import fengari from 'fengari';
import {companionEngine} from './companion-fixture.mjs';
import {uiLocaleBootstrap} from './ui-locale-fixture.mjs';

// A managed copy's conversation profile can be reassigned (MCM Current party,
// companions.setProfile) while that copy's private reply is still requested,
// streaming or playing. The real companions.lua, microphone.lua and the real
// init.lua ownership code run here against a virtual runtime folder, so the
// files the bridge reads (last-input.json, microphone-command.json) are the
// ones asserted. Group rounds retire elsewhere (group-chat.test.mjs).
const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;
const read = name => readFileSync(new URL(`../mod/${name}`, import.meta.url), 'utf8');
const initSource = read('init.lua'), microphoneSource = read('microphone.lua');
const sliceBetween = (from, to, optional = false) => {
  const start = initSource.indexOf(from), end = initSource.indexOf(to);
  if (optional && start < 0) return '';   // Without the ownership code every behaviour check fails instead.
  assert(start >= 0 && end > start, `init.lua no longer contains ${from}`);
  return initSource.slice(start, end);
};
const declarations = sliceBetween('local privateReply, requestFileId, claimPrivateReply', 'local function acceptVoiceSubmission(context)', true);
const voiceAdmission = sliceBetween('local function acceptVoiceSubmission(context)', '-- Explain an unavailable conversation service');
// sendRequest, the submit wrapper that claims ownership, and retirePrivateReply.
const textRequest = sliceBetween('local function sendRequest(context)', 'local function reactionLease(valid)');
const profileHook = sliceBetween('companions.onProfileChanged = ', "registerHotkey('cyberpunk_convai_text'", true);

function run(code) {
  const state = lauxlib.luaL_newstate(); lualib.luaL_openlibs(state);
  const program = uiLocaleBootstrap + 'convaiUiLocale=uiLocaleFixture\n' + companionEngine + `
    -- Virtual runtime folder: only what the bridge would see.
    local files, registry, nextId = {}, {}, 0
    json={encode=function(value) nextId=nextId+1; registry[tostring(nextId)]=value; return tostring(nextId) end,
      decode=function(raw) return registry[raw] end, null={}}
    io.open=function(path, mode)
      if mode=='rb' then
        if files[path]==nil then return nil end
        return {read=function() return files[path] end, close=function() return true end}
      end
      return {write=function(_, raw) files[path]=raw; return true end, close=function() return true end}
    end
    os.remove=function(path) local had=files[path]~=nil; files[path]=nil; return had or nil end
    os.rename=function(from, to) files[to]=files[from]; files[from]=nil; return true end
    local function command() return files['runtime/microphone-command.json'] and registry[files['runtime/microphone-command.json']] end
    local commands = {}
    local realOpen=io.open
    io.open=function(path, mode)
      local handle=realOpen(path, mode)
      if handle and mode~='rb' and path=='runtime/microphone-command.json' then
        local write=handle.write
        handle.write=function(self, raw) commands[#commands+1]=registry[raw]; return write(self, raw) end
      end
      return handle
    end
    local microphone=(function() ${microphoneSource} end)()
    local cancelled={}
    local revoked={}
    local gameplayActions={capture=function() end, revoke=function(reason, id) revoked[#revoked+1]={reason=reason, id=id} end}
    local stopped, cleared, leases, automaticCancelled = {}, {}, {}, {}
    local speech={requestId=nil}
    function speech.stop(reason) stopped[#stopped+1]={reason=reason, id=speech.requestId}; speech.requestId=nil end
    local subtitles={entity=nil, owns=false}
    function subtitles.ownsUtterance() return subtitles.owns end
    function subtitles.clearEntity(entity)
      if entity==subtitles.entity then cleared[#cleared+1]=entity; subtitles.entity,subtitles.owns=nil,false end
    end
    local groupChat={round=nil}
    local tacticEnv={writeLease=function(id, valid) leases[#leases+1]={id=id, valid=valid} end}
    local automatic, pending, pendingKnowledgeOwner, active = nil, nil, nil, nil
    local focusEntity, focusUntil, generation = nil, nil, 0
    local knowledgeAllowed = true
    local function cancelAutomatic(reason)
      automaticCancelled[#automaticCancelled+1]={reason=reason, id=automatic and automatic.requestId}
      if pending and automatic and pending.requestId==automatic.requestId then pending=nil end
      if automatic and speech.requestId==automatic.requestId then speech.stop(reason) end
      automatic=nil
    end
    local function warmConversation() end
    local logs = {}
    local function log(line) logs[#logs+1]=line end
    local function followUpQuestions() return false end
    local function attachKnowledge() return {session=1} end
    local function refreshKnowledgeFrame() return {} end
    local function knowledgeOwner() return {session=1, paused=false} end
    local function sameKnowledgeOwner() return true end
    local questContext={capture=function() return {} end}
    local battles={capture=function() return {} end}
    microphone.onCancelled=function(context, reason)
      cancelled[#cancelled+1]={id=context.requestId, reason=reason}
      gameplayActions.revoke(reason, context.requestId)
      if pending and pending.requestId==context.requestId then pending, pendingKnowledgeOwner = nil, nil end
    end
    ${declarations}
    ${voiceAdmission}
    ${textRequest}
    ${profileHook}
    -- Three copies: two of the same model/profile and one other character.
    local first, second, third = spawn('judy-alvarez'), spawn('judy-alvarez'), spawn('panam-palmer')
    local function id(npc) return tostring(npc:GetEntityID().hash) end
    local firstSerial, secondSerial, thirdSerial = 1, 2, 3
    assert(companions.identity(first)=='judy-alvarez' and companions.identity(second)=='judy-alvarez'
      and companions.identity(third)=='panam-palmer')
    local function request(npc, key, extra)
      generation=generation+1
      local context={generation=generation, entity=id(npc), name=key, bodyType='Female', profileKey=key, text='Hello',
        sentAt=100, requestId='100-'..generation..'-'..id(npc)}
      for name, value in pairs(extra or {}) do context[name]=value end
      return context
    end
    local function lastInput() return files['runtime/last-input.json'] and registry[files['runtime/last-input.json']] end
  ` + code;
  const status = lauxlib.luaL_dostring(state, to_luastring(program));
  const error = status === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(state, -1));
  const line = Number(/\]:(\d+):/.exec(error)?.[1]);
  lua.lua_close(state);
  assert.equal(status, lua.LUA_OK, error + (line ? '\n' + program.split('\n')[line - 1] : ''));
}

test('setProfile names the exact reassigned actor and nothing else', () => run(`
  local seen = {}
  companions.onProfileChanged = function(entity, previous, key) seen[#seen+1] = {entity, previous, key} end
  assert(companions.setProfile(secondSerial, 'panam-palmer', 'Panam'))
  assert(#seen==1 and seen[1][1]==id(second) and seen[1][2]=='judy-alvarez' and seen[1][3]=='panam-palmer')
  -- Unchanged, rejected and unknown assignments never announce a change.
  assert(companions.setProfile(secondSerial, 'panam-palmer', 'Panam renamed') and #seen==1)
  assert(not companions.setProfile(secondSerial, '') and #seen==1)
  assert(not companions.setProfile(99, 'judy-alvarez') and #seen==1)
  -- A throwing listener cannot stop the assignment.
  companions.onProfileChanged = function() error('listener failed') end
  assert(companions.setProfile(firstSerial, nil) and companions.identity(first)==nil)
`));

test('a text reply still being generated is retired when its copy is reassigned', () => run(`
  local mine, other = request(first, 'judy-alvarez'), request(second, 'judy-alvarez')
  assert(sendRequest(mine) and pending==mine and lastInput().requestId==mine.requestId)
  focusEntity, focusUntil = id(first), os.time() + 1000
  -- Reassigning a different copy, even of the same profile, leaves it alone.
  assert(companions.setProfile(thirdSerial, 'judy-alvarez', 'Judy'))
  assert(pending==mine and lastInput() and lastInput().requestId==mine.requestId and #revoked==0 and #stopped==0)
  assert(companions.setProfile(firstSerial, 'panam-palmer', 'Panam'))
  assert(pending==nil, 'the old profile still owns the pending request')
  assert(files['runtime/last-input.json']==nil, 'the bridge would keep publishing for the old profile')
  assert(#revoked==1 and revoked[1].id==mine.requestId and revoked[1].reason=='profile-reassigned')
  assert(focusUntil<os.time()+100, 'focus on the reassigned copy was kept alive')
  -- The same copy's next request, now as Panam, is a new owner and unaffected.
  local renewed = request(first, 'panam-palmer')
  assert(sendRequest(renewed) and pending==renewed and lastInput().requestId==renewed.requestId)
`));

test('a reply that is streaming or playing is stopped, with no late audio or captions for the old profile', () => run(`
  local mine = request(first, 'judy-alvarez')
  assert(sendRequest(mine))
  -- Reply admitted: pending is retired, the speech channel owns the utterance.
  pending=nil; speech.requestId=mine.requestId
  subtitles.entity, subtitles.owns = id(first), true
  assert(companions.setProfile(firstSerial, 'panam-palmer', 'Panam'))
  assert(#stopped==1 and stopped[1].id==mine.requestId and stopped[1].reason=='profile-reassigned')
  assert(speech.requestId==nil)
  assert(files['runtime/last-input.json']==nil, 'late streamed phrases would still be accepted by the bridge')
  -- Retiring twice (or reassigning back) cannot stop anything else.
  speech.requestId='someone-else'
  assert(companions.setProfile(firstSerial, 'judy-alvarez', 'Judy'))
  assert(#stopped==1 and speech.requestId=='someone-else')
`));

test('captions shown without speech are cleared; a fully delivered reply is left alone', () => run(`
  local mine = request(first, 'judy-alvarez')
  assert(sendRequest(mine)); pending=nil
  subtitles.entity, subtitles.owns = id(first), true
  assert(companions.setProfile(firstSerial, 'panam-palmer', 'Panam'))
  assert(#cleared==1 and cleared[1]==id(first) and #stopped==0 and files['runtime/last-input.json']==nil)
  -- Finished long ago: no pending, speech or captions. Nothing is in flight, so
  -- the last request file (used by diagnostics) is not touched.
  local done, revokedBefore = request(second, 'judy-alvarez'), #revoked
  assert(sendRequest(done)); pending=nil
  assert(companions.setProfile(secondSerial, 'panam-palmer', 'Panam'))
  assert(lastInput() and lastInput().requestId==done.requestId and #revoked==revokedBefore)
`));

test('retirement never removes a newer request file, a group round or another character', () => run(`
  local mine = request(first, 'judy-alvarez')
  assert(sendRequest(mine)); pending=nil; speech.requestId=mine.requestId
  -- The request file now belongs to a later group turn that includes the copy.
  local groupTurn = request(second, 'judy-alvarez', {group={id='g', index=1, total=2, audience={'judy-alvarez','panam-palmer'}, heard={}}})
  assert(sendRequest(groupTurn) and pending==groupTurn)
  groupChat.round={id='g', requestId=groupTurn.requestId, participants={}}
  speech.requestId=groupTurn.requestId
  assert(companions.setProfile(firstSerial, 'panam-palmer', 'Panam'))
  assert(pending==groupTurn and speech.requestId==groupTurn.requestId and #stopped==0 and #revoked==0)
  assert(lastInput().requestId==groupTurn.requestId, 'a group round lost its request file')
  -- Even the group member's own reassignment is left to updateGroup.
  assert(companions.setProfile(secondSerial, 'panam-palmer', 'Panam'))
  assert(pending==groupTurn and speech.requestId==groupTurn.requestId and #stopped==0)
  groupChat.round=nil; pending=nil; speech.requestId=nil
  -- Another character's reply is untouched by a reassignment elsewhere.
  local judys = request(third, 'panam-palmer')
  assert(sendRequest(judys) and pending==judys)
  assert(companions.setProfile(firstSerial, 'judy-alvarez', 'Judy'))
  assert(pending==judys and lastInput().requestId==judys.requestId and #stopped==0 and #revoked==0)
`));

test('an open text box or recording for the copy is not submitted under the old identity', () => run(`
  active={generation=1, entity=id(first), name='Judy', profileKey='judy-alvarez'}
  local groupComposer={generation=2, entity=id(first), participants={{entity=id(first)}}}
  assert(companions.setProfile(secondSerial, 'panam-palmer', 'Panam') and active~=nil, 'another copy closed the composer')
  assert(companions.setProfile(firstSerial, 'panam-palmer', 'Panam'))
  assert(active==nil)
  active=groupComposer
  assert(companions.setProfile(firstSerial, 'judy-alvarez', 'Judy') and active==groupComposer, 'group composers belong to the group round')
  active=nil
  -- Recording by voice, private.
  local recording = request(first, 'judy-alvarez', {text='[Microphone]'})
  assert(microphone.begin(recording, function() return true end))
  assert(microphone.context==recording and command().action=='start')
  assert(companions.setProfile(secondSerial, 'judy-alvarez', 'Judy again') and microphone.context==recording)
  assert(companions.setProfile(firstSerial, 'panam-palmer', 'Panam'))
  assert(microphone.context==nil and command().action=='cancel' and command().input.requestId==recording.requestId)
  assert(cancelled[1].reason=='profile-reassigned')
`));

test('a voice reply is cancelled at the bridge while waiting and after playback has begun', () => run(`
  local voice = request(first, 'judy-alvarez', {text='[Microphone]'})
  assert(microphone.begin(voice, function() return true end))
  assert(acceptVoiceSubmission(microphone.finish('private')) and microphone.state=='reply' and pending==voice)
  assert(command().action=='finish')
  assert(companions.setProfile(firstSerial, 'panam-palmer', 'Panam'))
  assert(pending==nil and microphone.context==nil)
  assert(command().action=='cancel' and command().input.requestId==voice.requestId, 'the bridge was never told')

  -- Reply received: the microphone context is gone, speech is playing.
  assert(companions.setProfile(firstSerial, 'judy-alvarez', 'Judy'))
  local spoken = request(first, 'judy-alvarez', {text='[Microphone]'})
  assert(microphone.begin(spoken, function() return true end))
  assert(acceptVoiceSubmission(microphone.finish('private')))
  pending=nil; microphone.received(spoken.requestId); speech.requestId=spoken.requestId
  assert(microphone.context==nil and command().action=='finish')
  assert(companions.setProfile(firstSerial, 'panam-palmer', 'Panam'))
  assert(#stopped==1 and stopped[1].id==spoken.requestId)
  assert(command().action=='cancel' and command().input.requestId==spoken.requestId,
    'the bridge kept streaming this reply as the old profile')
`));

test('a voice cancel never overwrites a newer recording in the shared command file', () => run(`
  local voice = request(first, 'judy-alvarez', {text='[Microphone]'})
  assert(microphone.begin(voice, function() return true end))
  assert(acceptVoiceSubmission(microphone.finish('private')))
  pending=nil; microphone.received(voice.requestId); speech.requestId=voice.requestId
  -- Another copy starts talking by voice; its command now owns the file.
  local newer = request(third, 'panam-palmer', {text='[Microphone]'})
  assert(microphone.begin(newer, function() return true end))
  assert(command().input.requestId==newer.requestId and command().action=='start')
  local before = #commands
  assert(microphone.revoke(voice)==false)
  assert(#commands==before and command().input.requestId==newer.requestId and command().action=='start')
  -- Also never twice, and never for a context the microphone still owns.
  microphone.cancel('done'); assert(command().action=='cancel')
  assert(microphone.revoke(newer)==false and #commands==before+1)
  assert(microphone.revoke(nil)==false)
`));

test('automatic reactions and distraction lines of the copy are invalidated through their lease', () => run(`
  local reaction = request(first, 'judy-alvarez', {reaction={kind='battle', phase='start'}, text='Combat has begun.'})
  automatic = reaction
  assert(sendRequest(reaction) and pending==reaction)
  assert(companions.setProfile(firstSerial, 'panam-palmer', 'Panam'))
  assert(automatic==nil and pending==nil and automaticCancelled[1].reason=='profile-reassigned'
    and automaticCancelled[1].id==reaction.requestId)
  assert(files['runtime/last-input.json']==nil)

  local line = request(second, 'judy-alvarez', {reaction={kind='distraction'}, text='Distract them.'})
  assert(sendRequest(line) and pending==line)
  assert(companions.setProfile(secondSerial, 'panam-palmer', 'Panam'))
  assert(pending==nil and #leases==1 and leases[1].id==line.requestId and leases[1].valid==false)
`));
