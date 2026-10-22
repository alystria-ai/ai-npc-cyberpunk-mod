import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import fengari from 'fengari';
import {companionEngine} from './companion-fixture.mjs';
import {uiLocaleBootstrap} from './ui-locale-fixture.mjs';

// Duplicate copies: the same model, or the same conversation profile, present
// more than once. A copy's model and its conversation identity are separate
// (companions.setProfile), and every roster action must name one exact copy.
const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;
const partySource = readFileSync(new URL('../mod/manager-party.lua', import.meta.url), 'utf8');
const groupSource = readFileSync(new URL('../mod/group-chat.lua', import.meta.url), 'utf8');
const phoneChatSource = readFileSync(new URL('../mod/phone-chat.lua', import.meta.url), 'utf8');
const speechSource = readFileSync(new URL('../mod/speech.lua', import.meta.url), 'utf8');
const adapterSource = readFileSync(new URL('../mod/init.lua', import.meta.url), 'utf8');
const sliceBetween = (from, to) => {
  const start = adapterSource.indexOf(from), end = adapterSource.indexOf(to);
  assert(start >= 0 && end > start, `init.lua no longer contains ${from}`);
  return adapterSource.slice(start, end);
};
const phoneAdapter = sliceBetween('local function processPhoneAction(player)', 'local function updatePhoneInvitationFeedback(');
const groupAdapter = sliceBetween('local function groupAudience(player)', 'local function captureDiagnostic()');

function run(code, prelude = '') {
  const state = lauxlib.luaL_newstate(); lualib.luaL_openlibs(state);
  const program = uiLocaleBootstrap + 'convaiUiLocale=uiLocaleFixture\n' + prelude + companionEngine + code;
  const status = lauxlib.luaL_dostring(state, to_luastring(program));
  const error = status === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(state, -1));
  const line = Number(/\]:(\d+):/.exec(error)?.[1]);
  lua.lua_close(state);
  assert.equal(status, lua.LUA_OK, error + (line ? '\n' + program.split('\n')[line - 1] : ''));
}

// Real roster plus the real invitation queue, driven the way the phone does.
const partyHarness = `
  local queue=(function() ${partySource} end)().new(companions,nil)
  queue.bind('world')
  local managerUi={party=function() return queue end}
  local lastPhoneInvitation=nil
  local developer=false
  local manager={developerMode=function() return developer end}
  convaiNotices.configure(function() return developer end)
  local logs={}
  local function log(line) logs[#logs+1]=line end
  local ui=convaiUiLocale
  local phone={requests={},feedback={}}
  local phonePlayer={ConvaiPhoneTakeRequest=function() return table.remove(phone.requests,1) end,
    ConvaiPhoneFeedback=function(_,text) phone.feedback[#phone.feedback+1]=text end}
  local contacts={['judy']={'judy-alvarez','Judy Alvarez'},['panam']={'panam-palmer','Panam Palmer'}}
  companions.phoneContactKey=function(id)
    local contact=contacts[id]
    if not contact then return nil,'No mapping' end
    return contact[1],nil,contact[2]
  end
  ${phoneAdapter}
  local function press(request) phone.requests[#phone.requests+1]=request; processPhoneAction(phonePlayer) end
  local function serials()
    local result={}
    for _,row in ipairs(companions.list()) do result[#result+1]=row.serial end
    return table.concat(result,',')
  end
  -- A phone invitation that has finished joining.
  local function join(key)
    assert(queue.invite(key)); queue.flush(); tick(); queue.flush()
    local rows=companions.list(); return rows[#rows]
  end
`;

test('a phone invitation that fails to start is reported once, in gameplay, and an accepted one shows no preparing text in any mode', () => run(`${partyHarness}
  local calls,stage=0,'memory'
  local readiness={bind=function() end, newId=function(n) return 'invite:'..n end, cancel=function() end,
    prepare=function() calls=calls+1; if calls==1 then return false,'Bridge unavailable' end; return true end,
    status=function() return {state=stage} end, spawned=function() end}
  queue=(function() ${partySource} end)().new(companions,readiness)
  queue.bind('world')
  press('+judy')
  assert(#phone.feedback==0,'the open phone posted a failure that the queue also posts in gameplay')
  queue.flush()
  local notices=queue.takeNotices()
  assert(#notices==1 and notices[1].failed and notices[1].message:find('could not prepare: Bridge unavailable',1,true))
  press('+judy')
  assert(#phone.feedback==0,'an accepted invitation posted routine preparation text with Developer mode off')
  developer=true; press('+judy')
  assert(#phone.feedback==0,'an accepted invitation posted preparation text with Developer mode on: '..tostring(phone.feedback[1]))
`));

test('phone dismissal of a duplicated character removes only the most recent copy', () => run(`${partyHarness}
  local first,second=join('judy-alvarez'),join('judy-alvarez')
  assert(serials()=='1,2' and first.serial==1 and second.serial==2)
  press('-judy'); assert(serials()=='1,2','dismissal is deferred until gameplay resumes')
  queue.flush()
  assert(serials()=='1','the older copy must stay: '..serials())
  local survivor=companions.list()[1]
  assert(survivor.state=='ready' and survivor.profileKey=='judy-alvarez')
  assert(companions.identity(entities[1])=='judy-alvarez' and not companions.identity(entities[2]))
  assert(table.concat(companions.connectionProfiles(),',')=='judy-alvarez')
  press('-judy'); queue.flush(); assert(serials()=='')
  assert(#companions.connectionProfiles()==0)
`));

test('phone dismissal pressed twice in one frame takes two different copies and never one copy twice', () => run(`${partyHarness}
  join('judy-alvarez'); join('judy-alvarez'); join('judy-alvarez')
  press('-judy'); press('-judy')
  assert(serials()=='1,2,3')
  queue.flush()
  assert(serials()=='1','two requests must remove two distinct copies: '..serials())
  -- A repeat while every copy is already leaving is harmless and idempotent.
  press('-judy'); press('-judy')
  queue.flush(); assert(serials()=='')
`));

test('phone dismissal names the character a copy speaks as, not the model it wears', () => run(`${partyHarness}
  local one,two=join('judy-alvarez'),join('judy-alvarez')
  assert(companions.setProfile(two.serial,'panam-palmer','Panam'))
  -- The newer Judy-model copy now answers as Panam: Judy dismissal must take
  -- the copy that is still Judy, and Panam dismissal the reassigned one.
  press('-judy'); queue.flush()
  assert(serials()=='2','Judy dismissal removed the wrong copy: '..serials())
  assert(companions.identity(entities[2])=='panam-palmer')
  press('-judy')
  assert(phone.feedback[#phone.feedback]:find('not in your group',1,true),'a Panam-speaking copy answered to Judy')
  press('-panam'); queue.flush(); assert(serials()=='')
`));

test('phone dismissal cancels the newest pending invitation before any joined copy', () => run(`${partyHarness}
  join('judy-alvarez')
  assert(queue.invite('judy-alvarez'))
  assert(queue.count()==2 and #queue.list()==2)
  press('-judy'); queue.flush()
  assert(serials()=='1' and queue.count()==1 and #queue.list()==1,'the joined copy was dismissed instead of the invitation')
  assert(companions.list()[1].state=='ready')
`));

// The same native chauffeur adapter the chauffeur integration fixtures use.
const chauffeurPrelude = `
  local point={id='4001ULL',name='Selected waypoint',position={x=12,y=34,z=0},
    destinationType='PlayerTracked',markerPosition={x=12,y=34,z=1.2}}
  local car={id='3001ULL',entityID={hash='3001ULL'},name='Summoned owned car',record='Vehicle.Test',owned=false}
  local carInfo={ready=true,speed=0,playerGap=3,seats={{name='seat_front_left'},{name='seat_front_right'}}}
  companionChauffeurAdapter=function(api)
    api.inspectDrive=function() return {known=true,ready=true,foreign=false,busy=false,reservations=0} end
    api.sample=function(_,entry)
      return {actor={serial=entry.serial,id=tostring(entry.entityID.hash),key=entry.profileKey},
        actorValid=entry.system:IsManaged(entry.entityID) and entry.system:IsTagged(entry.entityID,'CyberpunkConvaiCompanion'),
        actorCalm=true,playerCombat=false,car=car,carValid=true,info=carInfo,summonedId=car.id,
        waypoint=point,auto={enabled=false},drive={known=true,ready=true,busy=false,foreign=false,reservations=0}}
    end
    return api
  end
`;

test('phone dismissal skips a protected chauffeur driver while another copy of that character exists', () => run(`${partyHarness}
  join('judy-alvarez'); local driver=join('judy-alvarez')
  assert(companions.queueChauffeur(driver.serial,nil,driver.entityID))
  assert(companions.chauffeurSnapshot().active)
  press('-judy'); queue.flush()
  assert(serials()=='2','the passenger copy leaves while the driver keeps driving: '..serials())
  assert(companions.chauffeurSnapshot().active and companions.chauffeurSnapshot().offer.actor.serial==2)
  assert(companions.identity(entities[2])=='judy-alvarez')
  -- Nobody else is left: the driver is protected and the refusal is explained.
  press('-judy'); queue.flush()
  assert(serials()=='2' and phone.feedback[#phone.feedback]:find('Stop the trip',1,true),phone.feedback[#phone.feedback])
`, chauffeurPrelude));

test('dismissing a passenger copy during a trip leaves the driver, its trip and its profile alone', () => run(`
  local driver=spawn(); local passenger=spawn()
  local rows=companions.list()
  companions.setProfile(rows[1].serial,'panam-palmer','Panam')
  assert(companions.queueChauffeur(rows[1].serial,nil,rows[1].entityID))
  assert(not companions.dismiss(rows[1].serial),'the driver is protected')
  assert(companions.dismiss(rows[2].serial))
  assert(#companions.list()==1 and companions.list()[1].serial==1 and companions.list()[1].state=='ready')
  assert(companions.chauffeurSnapshot().active and companions.chauffeurSnapshot().offer.actor.serial==1)
  assert(companions.identity(driver)=='panam-palmer' and entities[2]==nil)
`, chauffeurPrelude));

test('manager dismissal by serial removes exactly that copy while its duplicate keeps model, profile and entity', () => run(`
  local released={}
  companions.onBeforeRemove=function(entity) released[#released+1]=entity end
  local changes={}
  companions.onPartyChanged=function() changes[#changes+1]=table.concat(companions.connectionProfiles(),',') end
  local first,second=spawn(),spawn()
  local rows=companions.list()
  assert(rows[1].name=='Judy Alvarez #1' and rows[2].name=='Judy Alvarez #2')
  assert(companions.dismiss(rows[1].serial))
  assert(#companions.list()==1 and companions.list()[1].serial==2 and companions.list()[1].state=='ready')
  assert(#released==1 and released[1]==tostring(first.id.hash),'only the dismissed entity is released')
  assert(entities[1]==nil and entities[2]==second,'the surviving actor must not be touched')
  assert(companions.identity(second)=='judy-alvarez' and companions.owns(second))
  assert(changes[#changes]=='judy-alvarez','the shared connection stays while a copy remains')
  assert(companions.dismiss(2) and changes[#changes]=='')
`));

test('reassigning one copy leaves the other with its own profile, and dismissal recomputes the connections', () => run(`
  local first,second=spawn(),spawn()
  companions.setProfile(2,'panam-palmer','Panam')
  assert(companions.identity(first)=='judy-alvarez' and companions.identity(second)=='panam-palmer')
  local rows=companions.list()
  assert(rows[1].key=='judy-alvarez' and rows[2].key=='judy-alvarez','the model never changes')
  assert(rows[1].profileKey=='judy-alvarez' and rows[2].profileKey=='panam-palmer')
  assert(table.concat(companions.connectionProfiles(),',')=='judy-alvarez,panam-palmer')
  assert(companions.dismiss(1))
  assert(table.concat(companions.connectionProfiles(),',')=='panam-palmer')
  assert(companions.identity(second)=='panam-palmer')
  -- Reverse: dismiss the reassigned copy and keep the original profile.
  local third=spawn()
  assert(table.concat(companions.connectionProfiles(),',')=='judy-alvarez,panam-palmer')
  companions.setProfile(2,nil)
  assert(not companions.identity(second),'a cleared copy has no conversation profile')
  assert(select(2,companions.identity(second))=='Judy Alvarez')
  assert(table.concat(companions.connectionProfiles(),',')=='judy-alvarez')
  assert(companions.dismiss(2) and table.concat(companions.connectionProfiles(),',')=='judy-alvarez')
  assert(companions.identity(third)=='judy-alvarez')
`));

test('a copy whose actor is deleted asynchronously stops answering immediately but keeps its duplicate talking', () => run(`
  local first,second=spawn(),spawn()
  for _,npc in pairs(entities) do function npc:GetBodyType() return 'Female' end end
  local deleteDelegate=system.DeleteEntity
  local deferred={}
  system.DeleteEntity=function(_,id) deferred[#deferred+1]=id; return true end
  assert(companions.dismiss(1))
  assert(companions.list()[1].state=='leaving' and #companions.list()==2)
  assert(not companions.identity(first),'a leaving copy must not be a conversation target')
  assert(companions.identity(second)=='judy-alvarez')
  assert(#companions.conversationCandidates(player,50)==1)
  assert(table.concat(companions.connectionProfiles(),',')=='judy-alvarez')
  -- The deletion completes later; the duplicate is still untouched.
  system.DeleteEntity=deleteDelegate; deleteDelegate(system,deferred[1])
  tick(2)
  assert(#companions.list()==1 and companions.list()[1].serial==2 and companions.list()[1].state=='ready')
`));

// The real playback owner, wired to the roster the way init.lua wires it.
const speechHarness = `
  local starts,stops={},0
  -- The voice is the continuous renderer; this fake takes its place like the real adapter (mod/continuous-speech.lua): it refuses
  -- a reply whose speaker is not the entity of the context (no actor, or another copy), and counts starts and stops.
  local controller={version=1,available=true,
    start=function(context,_,_,actor)
      if not actor or tostring(actor:GetEntityID().hash)~=context.entity then return false,'target unavailable' end
      starts[#starts+1]=context.entity; return true
    end,
    stop=function() stops=stops+1 end,pause=function() return true end,status=function() return {} end,
    update=function() return nil end}
  player.ConvaiManagerVoice=function() return true end
  Game.GetAllBlackboardDefs=function() return {UI_System={}} end
  Game.GetBlackboardSystem=function() return {Get=function() return {GetBool=function() return false end} end} end
  json={encode=function() return '{}' end,decode=function() return {} end}
  os.remove=function() return true end; os.rename=function() return true end
  local clearedCaptions={}
  local captions={clear=function() end,show=function() end,enabled=function() return true end,
    beginTimed=function() end,syncTimed=function() end,
    clearEntity=function(entity) clearedCaptions[#clearedCaptions+1]=entity end}
  local face={status=function() return {} end,stop=function() end,start=function() end,pause=function() end,
    sync=function() end,abandon=function() end}
  local engineDofile=dofile
  dofile=function(path)
    if path=='facial-playback.lua' then return face end
    if path=='subtitles.lua' then return captions end
    return engineDofile(path)
  end
  local speech=(function() ${speechSource} end)()
  -- speech.lua loads the adapter lazily, at the first reply: the stub stays for that call.
  dofile=function(path)
    if path=='continuous-speech.lua' then return controller end
    return engineDofile(path)
  end
  speech.available=true
  companions.onBeforeRemove=speech.clearEntity
  local function say(npc,id)
    speech.target=npc
    local context={entity=tostring(npc:GetEntityID().hash),requestId=id,generation=1,name='Judy'}
    return speech.start(context,{text='Hello V',continuous={version=1,id=id..'-voice'}})
  end
`;

test('dismissing the speaking copy stops its playback; dismissing its silent duplicate does not', () => run(`${speechHarness}
  local first,second=spawn(),spawn()
  assert(say(first,'private-1') and speech.requestId=='private-1' and starts[1]==tostring(first.id.hash))
  -- The duplicate is not the speaker: playback continues untouched.
  assert(companions.dismiss(2))
  assert(speech.requestId=='private-1' and stops==0 and speech.target==first)
  assert(clearedCaptions[1]==tostring(second.id.hash),'only the dismissed copy releases captions')
  -- The speaker itself is dismissed: its line is stopped and it is no longer the target.
  assert(companions.dismiss(1))
  assert(speech.requestId==nil and speech.state=='target-dismissed' and speech.target==nil)
  assert(stops==1 and #companions.list()==0)
`));

test('dismissing a copy whose private reply has not arrived cannot speak through its duplicate', () => run(`${speechHarness}
  local first,second=spawn(),spawn()
  speech.target=first                  -- a private request to the first copy is pending
  assert(companions.dismiss(1))
  assert(speech.target==nil,'the dismissed copy remained the speech target')
  local context={entity=tostring(first.id.hash),requestId='late',generation=2,name='Judy'}
  assert(not speech.start(context,{text='Late',continuous={version=1,id='late-voice'}}))
  assert(speech.requestId==nil and #starts==0,'a late reply played through another copy of the same character')
  assert(companions.identity(second)=='judy-alvarez')
`));

// Minimal native car: V's own car plus mount/unmount commands that really
// move copies in and out of its seats (see companion-vehicle-integration).
const carPrelude = `
  local cars,selected,mounts={},nil,{}
  EntityID={new=function() return {hash='0ULL'} end}
  local function car(id)
    local value={id=id,entityID={hash=id},owned=false,ordinal=1,record='Vehicle.test',name='Test car',followAttempts=0}
    value.entity={id=value.entityID,ai={commands={}},attached=true}
    function value.entity:IsAttached() return self.attached end
    function value.entity:GetAIComponent() return self.ai end
    function value.entity:GetEntityID() return self.id end
    function value.entity:GetLinearVelocity() return {x=0,y=0,z=0} end
    function value.entity:IsPlayerMounted() return selected==value end
    function value.entity.ai:SendCommand(cmd) cmd.id=#self.commands+1; cmd.state='Executing'; self.commands[#self.commands+1]=cmd end
    function value.entity.ai:GetCommandState(cmd) return cmd.state end
    function value.entity.ai:StopExecutingCommand(cmd) cmd.state='Cancelled' end
    function value.entity.ai:CancelCommand(cmd) cmd.state='Cancelled' end
    function value.entity.ai:IsCommandActive(commandId)
      for _,cmd in ipairs(self.commands) do if cmd.id==commandId then return cmd.state=='Executing' or cmd.state=='NotExecuting' end end
      return false
    end
    function value.entity.ai:GetEnqueuedOrExecutingCommand(kind)
      for _,cmd in ipairs(self.commands) do if cmd.kind==kind and self:IsCommandActive(cmd.id) then return cmd end end
    end
    cars[id]=value; return value
  end
  companionVehicleAdapter=function(api)
    api.player=function() return selected end
    api.inspect=function(value)
      local current=cars[value.id]
      if not current then return {ready=false} end
      value.entity=current.entity
      local seats={}
      for _,name in ipairs({'seat_front_left','seat_front_right','seat_back_left'}) do
        local occupant=name=='seat_front_left' and selected==current and 'player' or nil
        for id,mount in pairs(mounts) do if mount.vehicle==current.id and mount.seat==name then occupant=id end end
        seats[#seats+1]={name=name,occupant=occupant}
      end
      return {ready=true,seats=seats,speed=0,playerGap=5,playerMounted=selected==current}
    end
    return api
  end
`;
const carSetup = `
  local primary=car('v-car')
  local ordinaryCreate=system.CreateEntity
  function system:CreateEntity(spec)
    local id=ordinaryCreate(self,spec)
    local npc=self:GetEntity(id)
    npc.ai.onSend=function(command)
      if command.kind=='AIMountCommand' then
        mounts[npc.id.hash]={vehicle=command.mountData.mountParentEntityId.hash,seat=command.mountData.slotName}
        command.state='Success'
      elseif command.kind=='AIUnmountCommand' then mounts[npc.id.hash]=nil; command.state='Success' end
    end
    return id
  end
  local ordinaryManaged,ordinaryEntity,ordinaryTagged=system.IsManaged,system.GetEntity,system.IsTagged
  function system:IsManaged(id) return cars[id.hash] and cars[id.hash].owned or ordinaryManaged(self,id) end
  function system:IsTagged(id,tag)
    if cars[id.hash] then return cars[id.hash].owned and tag=='CyberpunkConvaiPartyVehicle' end
    return ordinaryTagged(self,id,tag)
  end
  function system:GetEntity(id) return cars[id.hash] and cars[id.hash].entity or ordinaryEntity(self,id) end
  Game.FindEntityByID=function(id) return system:GetEntity(id) end
  Game.GetMountingFacility=function() return {GetMountingInfoSingleWithObjects=function(_,npc)
    if npc==player then
      return selected and {parentId=selected.entityID,slotId={id='seat_front_left'}} or nil
    end
    local mount=mounts[npc:GetEntityID().hash]
    return mount and {parentId={hash=mount.vehicle},slotId={id=mount.seat}} or nil
  end} end
  Quaternion.ToEulerAngles=function() return {} end
  PlayerPuppet={GetCurrentVehicleState=function() return 'Driving' end}
  function player:IsInCombat() return false end
  Game.GetTeleportationFacility=function() return {Teleport=function(_,npc,position) npc.pos=position end} end
  local function update(count) for _=1,count or 1 do companions.update(player,0.1) end end
  local function row(serial)
    for _,value in ipairs(companions.list()) do if value.serial==serial then return value end end
  end
`;

test('dismissing one of two riding duplicates deletes only that rider and the other copy keeps its seat, model and profile', () => run(`${carSetup}
  local first,second=spawn(),spawn()
  companions.setProfile(2,'panam-palmer','Panam')
  selected=primary; update(20)
  assert(row(1).transport.phase=='riding' and row(2).transport.phase=='riding')
  assert(mounts[first.id.hash] and mounts[second.id.hash])
  local cars=#companions.vehicleSnapshot().cars
  assert(companions.dismiss(1))
  assert(entities[1]==nil)
  assert(#companions.list()==1 and companions.list()[1].serial==2)
  assert(#companions.vehicleSnapshot().people==1,'the dismissed rider still owns a seat reservation')
  update(40)
  local survivor=row(2)
  assert(survivor and survivor.state=='ready' and survivor.key=='judy-alvarez' and survivor.profileKey=='panam-palmer')
  assert(entities[2]==second and companions.identity(second)=='panam-palmer')
  assert(survivor.transport.phase=='riding' and mounts[second.id.hash],'the surviving duplicate is not seated again')
  assert(#companions.vehicleSnapshot().cars==cars,'no car was created or deleted')
`, carPrelude));

// A frozen group round plus the real roster and the real adapter functions.
const groupHarness = `
  local groupChat=(function() ${groupSource} end)()
  for _,npc in pairs(entities) do function npc:GetBodyType() return 'Female' end end
  local judy1,judy2,panam
  local function addCopy(key)
    local npc=spawn(key); function npc:GetBodyType() return 'Female' end; return npc
  end
  local supportedProfiles={['judy-alvarez']=true,['panam-palmer']=true}
  local enabled={['judy-alvarez']=true,['panam-palmer']=true}
  local function profileIdentity(npc) return (companions.identity(npc)) end
  local function profileEnabled(_,key) return enabled[key]==true end
  local stopped,cleared,sent=0,0,{}
  local speech={state='idle',requestId=nil}
  function speech.stop() stopped=stopped+1; speech.requestId=nil end
  local subtitles={ownsUtterance=function() return false end,clearEntity=function() cleared=cleared+1 end}
  local microphone={}
  function microphone.cancel() microphone.context=nil end
  local pending,pendingKnowledgeOwner,generation,focusUntil,focusMode,focusEntity=nil,nil,0
  local function cancelVoice() error('text round used the microphone') end
  local function gameplayCanAcquire() return true end
  local function sendRequest(input) sent[#sent+1]=input; pending=input; return true end
  local function beginFocus() return true end
  local function log() end
  local function convaiFaceRequestLog() end -- the real one is defined earlier in init.lua, outside this slice
  ${groupAdapter}
  local function candidatesFor(radius)
    local result={}
    for _,candidate in ipairs(companions.conversationCandidates(player,radius or 8)) do
      if enabled[candidate.profileKey] then result[#result+1]=candidate end
    end
    return result
  end
  -- Address one specific copy exactly as selectConversation does.
  local function address(npc)
    local key,name=companions.identity(npc)
    local primary={npc=npc,name=name,entity=tostring(npc:GetEntityID().hash),bodyType='Female',profileKey=key}
    return primary,groupChat.choose(primary,candidatesFor(),supportedProfiles)
  end
`;

test('group chat with duplicate copies keeps one speaker per profile and lets the addressed copy speak', () => run(`${groupHarness}
  judy1=addCopy('judy-alvarez'); panam=addCopy('panam-palmer'); judy2=addCopy('judy-alvarez')
  -- Place the addressed duplicate farthest away: distance order must not win.
  judy1.pos={x=1,y=0,z=0}; panam.pos={x=2,y=0,z=0}; judy2.pos={x=6,y=0,z=0}
  assert(#companions.conversationCandidates(player,8)==3)
  local primary,chosen=address(judy2)
  assert(#chosen==2,'duplicate copies multiplied speakers: '..#chosen)
  assert(chosen[1].entity==primary.entity and chosen[1].npc==judy2,'the addressed copy must speak first')
  assert(chosen[2].profileKey=='panam-palmer')
  local primary2,chosen2=address(judy1)
  assert(#chosen2==2 and chosen2[1].npc==judy1 and chosen2[2].profileKey=='panam-palmer')
  groupChat.start('dup',chosen,'Hello')
  updateGroup(player); assert(#sent==1 and sent[1].entity==primary.entity and sent[1].profileKey=='judy-alvarez')
  assert(sent[1].group.total==2 and #sent[1].group.audience==2,'the audience counts each profile once')
  groupChat.received(sent[1].requestId,'Hi V',false,{'judy-alvarez','panam-palmer'})
  pending=nil; speech.requestId=sent[1].requestId
  speech.requestId=nil; updateGroup(player)
  updateGroup(player)
  assert(#sent==2 and sent[2].profileKey=='panam-palmer','the other profile speaks next, not the duplicate Judy')
`));

test('dismissing the silent duplicate does not disturb a group turn; dismissing the speaker retires it without substitution', () => run(`${groupHarness}
  judy1=addCopy('judy-alvarez'); panam=addCopy('panam-palmer'); judy2=addCopy('judy-alvarez')
  local _,chosen=address(judy2)
  groupChat.start('silent',chosen,'Hello'); updateGroup(player)
  assert(#sent==1 and sent[1].entity==tostring(judy2.id.hash))
  -- judy1 is not a participant: removing it changes nothing.
  assert(companions.dismiss(1)); updateGroup(player)
  assert(groupChat.round and groupChat.round.index==1 and pending==sent[1])
  -- judy2 is the waiting speaker: the round must end, even though no other
  -- copy now answers as Judy and none may take over her turn.
  local before=#sent
  assert(companions.dismiss(3)); updateGroup(player)
  assert(groupChat.round==nil and pending==nil,'a dismissed speaker kept its group turn')
  assert(#sent==before and #companions.list()==1 and companions.list()[1].profileKey=='panam-palmer')
`));

test('reassigning a speaking or queued duplicate retires or skips only that copy', () => run(`${groupHarness}
  judy1=addCopy('judy-alvarez'); panam=addCopy('panam-palmer'); judy2=addCopy('judy-alvarez')
  local _,chosen=address(judy1)
  -- Speaking: the current speaker is reassigned while its line plays.
  groupChat.start('speaking',chosen,'Hello'); updateGroup(player)
  groupChat.received(sent[#sent].requestId,'Hi',false,{'judy-alvarez','panam-palmer'})
  pending=nil; speech.requestId=sent[#sent].requestId; subtitles.entity=tostring(judy1.id.hash)
  companions.setProfile(1,'panam-palmer','Panam'); updateGroup(player)
  assert(groupChat.round==nil and stopped==1 and cleared==1 and speech.requestId==nil)
  -- The untouched duplicate keeps its profile and can be addressed again.
  assert(companions.identity(judy2)=='judy-alvarez' and companions.identity(judy1)=='panam-palmer')
  local primary,again=address(judy2)
  assert(#again==2 and again[1].npc==judy2 and again[2].profileKey=='panam-palmer')
  -- Queued: a later participant is reassigned while the first speaks.
  companions.setProfile(1,'judy-alvarez','Judy')
  local _,all=address(judy1)
  assert(#all==2 and all[1].npc==judy1 and all[2].npc==panam)
  groupChat.start('queued',all,'Hello'); updateGroup(player)
  local request=sent[#sent]; local before=#sent
  assert(request.entity==tostring(judy1.id.hash))
  groupChat.received(request.requestId,'First',false,{'judy-alvarez','panam-palmer'})
  pending=nil; speech.requestId=request.requestId
  companions.setProfile(2,'judy-alvarez','Judy') -- the queued Panam copy becomes a third Judy
  companions.setProfile(3,'panam-palmer','Panam') -- a non-participant duplicate changes too
  updateGroup(player)
  assert(groupChat.round and groupChat.round.index==1,'the speaker kept its turn')
  assert(#groupChat.round.reply.listeners==1 and groupChat.round.reply.listeners[1]=='judy-alvarez')
  speech.requestId=nil; updateGroup(player); updateGroup(player); updateGroup(player)
  assert(#sent==before,'a reassigned or non-participant copy spoke in the old round')
  assert(groupChat.round==nil,'the finished round must end rather than invent a replacement')
`));

test('reassigning or dismissing a copy never changes what phone Chat and memory are keyed by', () => {
  // Phone Chat history, drafts, and Forget state are keyed by contact and
  // conversation profile in this module; copies in the world are not an input.
  assert.doesNotMatch(phoneChatSource, /convaiCompanions|companions\.|manager-party|\.dismiss\(|setProfile/,
    'phone Chat must not depend on which copies are in the party');
});

test('the face writer\'s actor rows are rebuilt at most every 0.1 s, and at once when the party changes', () => run(`
  local first,second=spawn(),spawn()
  for _,npc in pairs(entities) do function npc:GetBodyType() return 'Female' end end
  local clock,scans=50,0
  os.clock=function() return clock end
  local scan=companions.conversationCandidates
  companions.conversationCandidates=function(...) scans=scans+1; return scan(...) end
  local rows=companions.expressionActors(player)
  assert(#rows==2 and scans==1)
  for _=1,5 do clock=clock+.015; assert(companions.expressionActors(player)==rows) end
  assert(scans==1,'rows rebuilt within 0.1 s: '..scans)
  clock=clock+.05; assert(#companions.expressionActors(player)==2 and scans==2)
  assert(companions.dismiss(1)); tick(2)
  assert(#companions.expressionActors(player)==1 and scans==3,'a changed party kept the old rows')
  companions.conversationCandidates=scan
`));

test('the live-picture copy of a holocall joins the face writer rows at the 0.1 s rebuild while its picture is up', () => run(`
  local first=spawn()
  for _,npc in pairs(entities) do function npc:GetBodyType() return 'Female' end end
  local clock=120
  os.clock=function() return clock end
  local live={npc={}, entity='9000ULL', profileKey='judy-alvarez', name='Judy'}
  convaiHolocall={faceRow=function() return live end}
  local rows=companions.expressionActors(player)
  assert(#rows==2 and rows[2]==live, 'the copy is the last row')
  live=nil; clock=clock+.11
  rows=companions.expressionActors(player)
  assert(#rows==1, 'gone with the picture')
  convaiHolocall=nil
`));

test('teardown: abandoning the session drops the cached actor rows (they hold NPC handles), whatever the clock says', () => run(`
  local first=spawn()
  for _,npc in pairs(entities) do function npc:GetBodyType() return 'Female' end end
  local clock=80
  os.clock=function() return clock end
  local scans=0
  local scan=companions.conversationCandidates
  companions.conversationCandidates=function(...) scans=scans+1; return scan(...) end
  local rows=companions.expressionActors(player)
  assert(scans==1 and #rows==1 and rows[1].npc~=nil)
  companions.abandon()
  clock=clock+.01
  local after=companions.expressionActors(player)
  assert(scans==2 and after~=rows, 'the rows with the old NPC handles were served after the session was abandoned')
  assert(#after==0)
  companions.conversationCandidates=scan
`));
