import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import fengari from 'fengari';
import {uiLocaleBootstrap} from './ui-locale-fixture.mjs';

const source = readFileSync(new URL('../mod/microphone.lua', import.meta.url), 'utf8');
const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;
const fixture = `
local function copy(value)
 if type(value)~='table'then return value end
 local result={};for key,item in pairs(value)do result[key]=copy(item)end;return result
end
local files,encoded,commands,feedback,cancellations={},{},{},{},{}
local serial,now,paused,available,enabled,world=0,100,false,true,true,1
json={encode=function(value)serial=serial+1;encoded[tostring(serial)]=copy(value);return tostring(serial)end,
 decode=function(raw)return copy(assert(encoded[raw]))end}
io={open=function(path,mode)
 if not available then return nil end
 if mode=='rb'then
  if not files[path]then return nil end
  return {read=function()return files[path]end,close=function()return true end}
 end
 return {write=function(_,raw)
  files[path]=raw
  if path=='runtime/microphone-command.json'then commands[#commands+1]=json.decode(raw)end
  return true
 end,close=function()return true end}
end}
os.time=function()return now end
local player={ConvaiPhoneFeedback=function(_,value)feedback[#feedback+1]=value end}
Game={GetAllBlackboardDefs=function()return {UI_System={IsInMenu='menu'}}end,
 GetBlackboardSystem=function()return {Get=function()return {GetBool=function()return paused end}end}end}
local mic=(function()${source}end)()
local function owner()return {session=world,generation=world,worldToken='world-'..world}end
mic.captureKnowledge=function(context)return {owner=owner(),worldKnowledge={at=now,group=context.group~=nil},journalHistory={at=now}}end
mic.currentKnowledgeOwner=owner
mic.captureJournal=function()return {at=now}end
mic.captureBattle=function()return {at=now}end
mic.captureFollowUpQuestions=function()return enabled end
mic.onCancelled=function(context,reason)cancellations[#cancellations+1]={id=context.requestId,reason=reason}end
local function input(group)
 return {requestId='voice-1',generation=1,entity='1ULL',profileKey='judy',name='Judy',text='[Microphone]',
  group=group and {id='group-1',index=1,total=2,audience={'judy','panam'},heard={}}or nil}
end
local function state(value,id)
 files['runtime/microphone-state.json']=json.encode({requestId=id or 'voice-1',state=value})
end
`;
function check(body) {
  const vm = lauxlib.luaL_newstate(); lualib.luaL_openlibs(vm);
  try {
    const program = fixture + '\n' + body;
    const result = lauxlib.luaL_dostring(vm, to_luastring(uiLocaleBootstrap + program));
    const error = result === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(vm, -1));
    const line = Number(/\]:(\d+):/.exec(error)?.[1]);
    assert.equal(result, lua.LUA_OK, error + (line ? '\n' + program.split('\n')[line - 1] : ''));
  } finally { lua.lua_close(vm); }
}

test('microphone keeps mode and never carries the retired follow-up field while refreshing finish context', () => check(`
 local context=input(true)
 assert(mic.begin(context)and #commands==1 and commands[1].action=='start')
 assert(commands[1].input.followUpQuestions==nil)
 state('recording');mic.update(player)
 assert(mic.state=='recording'and feedback[1]=='Listening - press the same voice chat shortcut again to finish')
 local previous=files['runtime/microphone-command.json']
 assert(mic.finish('private')==nil and files['runtime/microphone-command.json']==previous)
 now=103;assert(mic.finish('group')==context)
 local sent=commands[#commands]
 assert(sent.action=='finish'and sent.input.requestId=='voice-1'and sent.input.group.index==1)
 assert(sent.input.followUpQuestions==nil and sent.input.worldKnowledge.at==103)
 assert(sent.input.journal.at==103 and sent.input.battle.at==103 and sent.input.journalHistory.at==103)
 assert(mic.finish('group')==nil and #commands==2)
 assert(not mic.received('stale')and mic.context==context)
 assert(mic.received('voice-1')and not mic.context and not mic.targetValid and #commands==2)
 assert(#cancellations==0)
 context=input(false);assert(mic.begin(context));state('recording');mic.update(player)
 assert(feedback[#feedback]=='Listening - press the same voice chat shortcut again to finish')
`));

test('stale state files cannot start capture and the owned microphone auto-finishes exactly once', () => check(`
 local context=input(true);assert(mic.begin(context))
 state('recording','another-request');mic.update(player);assert(mic.state=='starting'and #feedback==0)
 state('recording');mic.update(player)
 now=130;assert(mic.update(player)==context and commands[#commands].action=='finish')
 assert(mic.update(player)==nil and #commands==2 and mic.state=='reply')
`));

test('menu, lost target, changed world and device errors retire capture without later callbacks', () => check(`
 local valid=true
 for _,failure in ipairs({'menu','target','world','device'})do
  paused=false;valid=true
  local context=input(true);assert(mic.begin(context,function()return valid end))
  if failure=='menu'then paused=true
  elseif failure=='target'then valid=false
  elseif failure=='world'then world=world+1
  else state('error')end
  assert(mic.update(player)==nil and not mic.context and not mic.targetValid)
  assert(commands[#commands].action=='cancel'and cancellations[#cancellations].id=='voice-1')
  state('recording');assert(mic.update(player)==nil and not mic.context)
  assert(mic.finish('group')==nil)
 end
`));

test('a spoken turn that is waiting for its reply survives a menu and a target out of reach, and completes when the reply arrives; a changed world still ends it', () => check(`
 local valid=true
 local context=input(true);assert(mic.begin(context,function()return valid end))
 state('recording');mic.update(player)
 now=103;assert(mic.finish('group')==context and mic.state=='reply')
 local sent=#commands
 paused=true;valid=false
 assert(mic.update(player)==nil and mic.context==context and mic.state=='reply' and #commands==sent and #cancellations==0, 'menu and distance do not cancel the pending turn')
 paused=false
 assert(mic.update(player)==nil and mic.context==context and #cancellations==0)
 assert(mic.received('voice-1') and not mic.context and #cancellations==0, 'the reply completes the turn')
 -- Before the finish the same menu still ends the recording.
 paused=false;valid=true
 context=input(false);assert(mic.begin(context,function()return valid end));state('recording');mic.update(player)
 paused=true;assert(mic.update(player)==nil and not mic.context and cancellations[#cancellations].reason=='menu')
 -- A new world still retires a pending turn.
 paused=false
 context=input(false);assert(mic.begin(context));state('recording');mic.update(player);now=110;assert(mic.finish('private')==context)
 world=world+1;assert(mic.update(player)==nil and not mic.context)
`));

test('failed writes and opening timeout cannot leave a recording owner alive', () => check(`
 available=false;assert(not mic.begin(input(true))and not mic.context)
 available=true;assert(mic.begin(input(true)))
 available=false;assert(mic.finish('group')==nil and not mic.context and not mic.knowledgeOwner)
 available=true;assert(mic.begin(input(false)))
 now=136;mic.update(player)
 assert(not mic.context and commands[#commands].action=='cancel')
 assert(feedback[#feedback]:find('timed out',1,true))
`));

test('private action capture follows old-owner cancellation and precedes start, while finish keeps the original offer', () => check(`
 local order,captures={},0
 mic.onCancelled=function(context,reason)order[#order+1]='cancel:'..context.requestId..':'..reason end
 mic.captureActions=function(context)
  captures=captures+1
  assert(context.worldKnowledge and context.journal and mic.context==nil)
  order[#order+1]='capture:'..context.requestId
  context.chauffeurOffer={available=true,actor={id=context.entity},waypoint={id='original'}}
 end
 local first=input();first.requestId='old';assert(mic.begin(first))
 local second=input();second.requestId='new';assert(mic.begin(second))
 assert(order[2]=='cancel:old:replaced'and order[3]=='capture:new')
 assert(commands[#commands].action=='start'and commands[#commands].input.chauffeurOffer.waypoint.id=='original')
 now=103;assert(mic.finish()==second)
 assert(captures==2 and commands[#commands].input.chauffeurOffer.waypoint.id=='original')
 mic.received('new');assert(#order==3,'delivery incorrectly cancelled a late action lease')
 available=false;assert(not mic.begin(input()))
 assert(order[#order]=='cancel:voice-1:start-write-failed')
`));

test('the voice key is spam-safe: connecting and bounce presses are ignored, a good press finishes, an overdue reply can be retried', () => check(`
 local clock=50;mic.clock=function()return clock end
 assert(mic.press()=='idle')
 local context=input(false);assert(mic.begin(context))
 assert(mic.press()=='connecting','a press while the device opens must not finish an empty recording')
 assert(mic.press()=='connecting' and #commands==1 and commands[1].action=='start')
 state('recording');mic.update(player)
 assert(mic.state=='recording' and mic.press()=='bounce','a double tap right after Listening is ignored')
 clock=50.3;assert(mic.press()=='bounce')
 clock=50.9;assert(mic.press()=='finish')
 assert(mic.finish('private')==context and mic.state=='reply' and commands[#commands].action=='finish')
 assert(mic.press()=='waiting','pressing while the reply is on its way changes nothing')
 now=now+7;assert(mic.press()=='waiting')
 now=now+1;assert(mic.press()=='retry','an overdue reply may be dropped by the next press')
 mic.cancel('voice-retry')
 assert(mic.press()=='idle' and not mic.context and not mic.recordingAt and not mic.finishedAt)
 assert(commands[#commands].action=='cancel' and cancellations[#cancellations].reason=='voice-retry')
 -- Rapid start, cancel, start: every owner is retired once and the last one is clean.
 for i=1,5 do local c=input(false);c.requestId='rapid-'..i;assert(mic.begin(c));assert(mic.press()=='connecting');mic.cancel('again')end
 assert(not mic.context and #cancellations==6)
 local last=input(false);last.requestId='rapid-last';assert(mic.begin(last))
 state('recording','rapid-last');mic.update(player);clock=60;assert(mic.press()=='finish')
`));

test('a recording with no speech says so, retires the turn and leaves no stuck state', () => check(`
 local context=input(false);assert(mic.begin(context))
 state('recording');mic.update(player);now=now+3;assert(mic.finish('private')==context and mic.state=='reply')
 state('no-speech');assert(mic.update(player)==nil)
 assert(feedback[#feedback]=='No speech was heard. Wait for Listening, then speak before you finish.')
 assert(not mic.context and mic.state==nil and commands[#commands].action=='cancel')
 assert(cancellations[#cancellations].reason=='no-speech')
 assert(mic.press()=='idle' and mic.begin(input(false)) and mic.state=='starting')
`));

test('every command carries what caused it, so a stop that never arrives can be told from a stop that was ignored', () => check(`
 local logged={};mic.log=function(line)logged[#logged+1]=line end
 local context=input(false);assert(mic.begin(context,nil,'press') and commands[1].source=='press')
 state('recording');mic.update(player);now=now+3
 assert(mic.finish('private','release')==context and commands[2].action=='finish' and commands[2].source=='release')
 mic.received('voice-1')
 assert(mic.begin(input(false)) and commands[3].source=='press','a start without a source is a press')
 state('recording');mic.update(player);now=now+31
 assert(mic.update(player)~=nil and commands[4].action=='finish' and commands[4].source=='cap','the 30 s limit says so')
 mic.cancel('menu');assert(commands[5].action=='cancel' and commands[5].source=='menu')
 -- a finish held back by a save in progress keeps its cause, and says it was delayed
 local c=input(false);c.requestId='saving';assert(mic.begin(c));state('recording','saving');mic.update(player);now=now+3
 local saving=true;local capture=mic.captureKnowledge
 mic.captureKnowledge=function(context)if saving then return false,'save-in-progress' end return capture(context)end
 assert(mic.finish('private','press')==nil and mic.finishPending and #commands==6)
 saving=false;assert(mic.update(player)==c and commands[#commands].source=='press-delayed',commands[#commands].source)
 local text=table.concat(logged,'|')
 assert(text:find('Microphone command: start source=press',1,true) and text:find('Microphone command: finish source=release',1,true))
`));

test('a device that sends no sound is named in the game; an ordinary empty recording keeps the generic notice', () => check(`
 local context=input(false);assert(mic.begin(context))
 state('recording');mic.update(player);now=now+3;assert(mic.finish('private')==context)
 files['runtime/microphone-state.json']=json.encode({requestId='voice-1',state='silent',device='Default - Headset (realme Buds Air7 Hands-Free)'})
 assert(mic.update(player)==nil)
 assert(feedback[#feedback]=='The microphone Default - Headset (realme Buds Air7 Hands-Free) sends no sound. Check your Windows input device.',feedback[#feedback])
 assert(not mic.context and cancellations[#cancellations].reason=='microphone-silent')
 -- a state with no name still reads as a sentence and never errors
 assert(mic.begin(input(false)));state('recording');mic.update(player);now=now+3;assert(mic.finish('private'))
 files['runtime/microphone-state.json']=json.encode({requestId='voice-1',state='silent'})
 assert(mic.update(player)==nil and feedback[#feedback]:find('The microphone ? sends no sound',1,true))
`));

test('nothing the mod speaks can play into a recording: the voice key silences it, and automatic, add-on and reaction turns wait', () => {
  const init = readFileSync(new URL('../mod/init.lua', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  // a recording begins by stopping every voice and clearing the subtitle (the hands-free headset microphone would hear it)
  assert.match(init, /cancelAutomatic\('microphone'\)[^]*?speech\.stop\('microphone'\); subtitles\.clear\(\)[^]*?microphone\.begin\(context, targetValid, 'press'\)/);
  // while it runs: no automatic add-on remark, and no battle or loot reaction, may start a voice
  assert.match(init, /seams\.submit = function\(context, anchor\)\n\s+if active or pending or automatic or microphone\.context or groupChat\.round then return false end/);
  assert.match(init, /local manual = active ~= nil or groupChat\.round ~= nil\n\s+or \(microphone\.context ~= nil and microphone\.state ~= 'reply'\)/);
  assert.match(init, /microphone = microphone\.context ~= nil and microphone\.state ~= 'reply'/);
});

test('the talk keys are registered as inputs (press and release), never as release-only hotkeys', () => {
  const init = readFileSync(new URL('../mod/init.lua', import.meta.url), 'utf8');
  assert.match(init, /registerInput\('cyberpunk_convai_voice', 'AI NPC Cyberpunk Mod: talk by voice'/);
  assert.match(init, /registerInput\('cyberpunk_convai_group_voice', 'AI NPC Cyberpunk Mod: group voice chat'/);
  assert.doesNotMatch(init, /registerHotkey\('cyberpunk_convai_(group_)?voice'/);
});

test('the bridge names a silent input and logs where each microphone command came from', () => {
  const bridge = readFileSync(new URL('./convai-bridge.mjs', import.meta.url), 'utf8');
  const session = readFileSync(new URL('./microphone-session.mjs', import.meta.url), 'utf8');
  assert.match(bridge, /microphoneErrorState\(error\)/);
  assert.match(session, /error\?\.code === 'MIC_SILENT'\) return \{state: 'silent'/);
  assert.match(bridge, /Microphone: ' \+ command\.action \+ ' command, source '/);
  assert.match(bridge, /mic\.stopCapture\(input\.requestId\)/);
  assert.match(source, /value\.state == 'silent'/);
});

test('the bridge reports a no-speech recording to the game as its own microphone state', () => {
  const bridge = readFileSync(new URL('./convai-bridge.mjs', import.meta.url), 'utf8');
  const client = readFileSync(new URL('./realtime-client.mjs', import.meta.url), 'utf8');
  assert.match(readFileSync(new URL('./microphone-session.mjs', import.meta.url), 'utf8'), /return \{state: 'no-speech'\}/);
  assert.match(client, /NO_SPEECH_ERROR = 'No speech was heard'/);
  assert.match(source, /value\.state == 'no-speech'/);
});

test('what Convai has heard is shown as a notice on the existing poll: throttled, only for this recording, until the reply starts', () => check(`
 local clock=10;mic.clock=function()return clock end
 local context=input(false);assert(mic.begin(context))
 local function heard(text,id)files['runtime/microphone-heard.json']=json.encode({requestId=id or 'voice-1',text=text})end
 heard('too early');mic.update(player);assert(#feedback==0,'nothing is shown before Listening');heard('')
 state('recording');mic.update(player);assert(feedback[#feedback]:find('Listening',1,true))
 local shown=#feedback
 heard('what do');mic.update(player)
 assert(#feedback==shown+1 and feedback[#feedback]=='You: what do')
 mic.update(player);assert(#feedback==shown+1,'an unchanged file costs no notice')
 heard('what do you think');mic.update(player);assert(#feedback==shown+1,'throttled inside 0.3 s')
 clock=10.4;mic.update(player)
 assert(#feedback==shown+2 and feedback[#feedback]=='You: what do you think','the held text shows on a later poll')
 heard('someone else',"another");clock=11;mic.update(player);assert(#feedback==shown+2,'words of another recording are ignored')
 heard('');clock=12;mic.update(player);assert(#feedback==shown+2,'empty words show nothing')
 now=now+1;clock=13;assert(mic.finish('private')==context and mic.state=='reply')
 heard('what do you think?');mic.update(player)
 assert(feedback[#feedback]=='You: what do you think?','the final transcript shows before the reply')
 assert(mic.received('voice-1') and not mic.context and not mic.heardRaw and not mic.heardAt)
 heard('late words');clock=14;mic.update(player);assert(feedback[#feedback]=='You: what do you think?')
`));

test('the heard words travel page, host, session, bridge file and game without a new per-frame path', () => {
  const read = name => readFileSync(new URL(name, import.meta.url), 'utf8');
  assert.match(read('./realtime-client.mjs'), /heard: \(\) => heardText\(turn\)/);
  assert.match(read('./realtime-host.mjs'), /heard: \(\) => this\.voiceHeard\(owner\)/);
  assert.match(read('./microphone-session.mjs'), /async heard\(\)/);
  const bridge = read('./convai-bridge.mjs');
  assert.match(bridge, /microphone-heard\.json/); assert.match(bridge, /else await publishHeard\(recording\)/);
  assert.match(source, /microphone-heard\.json/);
  assert.doesNotMatch(source, /onUpdate|GameSession|Cron/);
});

test('heard words go to V\'s subtitle line when the game shows them there, and to the notice line otherwise', () => check(`
 local clock=10;mic.clock=function()return clock end
 local spoken={};local subtitlesOn=true
 mic.onHeard=function(text)if not subtitlesOn then return false end spoken[#spoken+1]=text;return true end
 local context=input(false);assert(mic.begin(context));state('recording');mic.update(player)
 local shown=#feedback
 local function heard(text)files['runtime/microphone-heard.json']=json.encode({requestId='voice-1',text=text})end
 heard('what do');mic.update(player)
 assert(#spoken==1 and spoken[1]=='what do' and #feedback==shown,'subtitles replace the notice line')
 subtitlesOn=false;clock=11;heard('what do you');mic.update(player)
 assert(feedback[#feedback]=='You: what do you','subtitles off: the notice line')
 mic.onHeard=function()error('subtitle failure')end
 clock=12;heard('what do you think');mic.update(player)
 assert(feedback[#feedback]=='You: what do you think','a failing subtitle call never loses the words')
`));

test('a stale voice client bundle is reported once with the fix, and the first heard words are logged', () => {
  const host = readFileSync(new URL('./realtime-host.mjs', import.meta.url), 'utf8');
  const bridge = readFileSync(new URL('./convai-bridge.mjs', import.meta.url), 'utf8');
  assert.match(host, /window\.convaiRealtime\.heard \? window\.convaiRealtime\.heard\(\) : null/);
  assert.match(host, /run npm run build:voice and restart the bridge/);
  assert.match(bridge, /reading heard words for/); assert.match(bridge, /first heard words/);
});

test('an add-on speaker\'s context blocks are added at begin and again at finish, through the generic decorate seam only', () => check(`
 local decorated={}
 mic.decorate=function(context)decorated[#decorated+1]=context.requestId;context.addon={blocks={n=#decorated}}end
 local context=input(false);context.profileKey='addon-cab-delamain';context.voiceOnly=true
 assert(mic.begin(context)and commands[1].input.addon.blocks.n==1,'the start command carries the blocks')
 state('recording');mic.update(player)
 now=104;assert(mic.finish('private')==context)
 assert(commands[2].action=='finish'and commands[2].input.addon.blocks.n==2,'refreshed at finish')
 assert(#decorated==2)
 -- A decorator that fails never stops the recording; without one nothing changes.
 mic.decorate=function()error('boom')end
 context=input(false);context.requestId='voice-2'
 assert(mic.begin(context)and commands[#commands].action=='start')
 mic.decorate=nil;state('recording','voice-2');mic.update(player);now=110
 assert(mic.finish('private')==context and commands[#commands].action=='finish'and commands[#commands].input.addon==nil)
`));

test('empty microphone state and heard files (the shipped placeholders) mean nothing yet: a recording is not cancelled and nothing is shown', () => check(`
 -- a decoder that answers nil (not an error) for an empty document must not crash the poll either
 local decode=json.decode;json.decode=function(raw)if raw==''then return nil end return decode(raw)end
 local context=input(false);assert(mic.begin(context))
 files['runtime/microphone-state.json']='';files['runtime/microphone-heard.json']=''
 assert(mic.update(player)==nil and mic.context==context and mic.state=='starting' and #cancellations==0,'an empty state file ended the recording')
 state('recording');mic.update(player)
 assert(mic.state=='recording')
 local shown=#feedback
 files['runtime/microphone-heard.json']=''
 mic.update(player)
 assert(mic.context==context and #feedback==shown and #cancellations==0,'an empty heard file showed words or cancelled')
 files['runtime/microphone-state.json']=''
 mic.update(player)
 assert(mic.context==context and mic.state=='recording','an emptied state file after recording started is still nothing')
`));

test('the microphone command file is rewritten in place for every command, never removed or renamed', () => check(`
 local removed,renamed,opened={},{},{}
 os.remove=function(path)removed[#removed+1]=path;return true end
 os.rename=function(from,to)renamed[#renamed+1]=from..'>'..to;return true end
 local open=io.open
 io.open=function(path,mode)if mode=='wb'then opened[#opened+1]=path end return open(path,mode)end
 local context=input(false);assert(mic.begin(context));state('recording');mic.update(player)
 now=now+3;assert(mic.finish('private')==context)
 assert(#opened>=2)
 for _,path in ipairs(opened)do assert(path=='runtime/microphone-command.json','wrote '..path)end
 assert(#removed==0 and #renamed==0)
`));

test('a recording in a language nothing here hears says so under the Listening line', () => check(`
 local context=input(false);assert(mic.begin(context))
 files['runtime/microphone-state.json']=json.encode({requestId='voice-1',state='recording',note='english-only'})
 mic.update(player)
 assert(mic.state=='recording')
 local want='Listening - press the same voice chat shortcut again to finish'..string.char(10)..'Voice input only understands English for now. Typing works in any language.'
 assert(feedback[#feedback]==want,feedback[#feedback])
`));

test('a recording in a language an optional pack hears (not installed) names the pack under the Listening line', () => check(`
 local context=input(false);assert(mic.begin(context))
 files['runtime/microphone-state.json']=json.encode({requestId='voice-1',state='recording',note='pack-available'})
 mic.update(player)
 assert(mic.state=='recording')
 local want='Listening - press the same voice chat shortcut again to finish'..string.char(10)..'Voice input in this language needs the optional Microphone pack from the mod page. Typing works in any language.'
 assert(feedback[#feedback]==want,feedback[#feedback])
`));

test('Convai did not answer at the start of the turn: the connection notice, not the Windows input device one', () => check(`
 assert(mic.begin(input(false)));files['runtime/microphone-state.json']=json.encode({requestId='voice-1',state='starting'});mic.update(player)
 files['runtime/microphone-state.json']=json.encode({requestId='voice-1',state='error',reason='connection'})
 assert(mic.update(player)==nil)
 assert(feedback[#feedback]=='Voice input could not reach Convai. Press the voice key again, or type.',feedback[#feedback])
 assert(not mic.context and cancellations[#cancellations].reason=='microphone-connection')
`));

test('an unknown note adds no English-only line', () => check(`
 assert(mic.begin(input(false)));files['runtime/microphone-state.json']=json.encode({requestId='voice-1',state='recording',note='something-else'})
 mic.update(player)
 assert(feedback[#feedback]=='Listening - press the same voice chat shortcut again to finish',feedback[#feedback])
`));

test('Mistral failed and no local engine could read the recording: the same sentence, alone; a plain device error is still a device error', () => check(`
 assert(mic.begin(input(false)));state('recording');mic.update(player);now=now+3;assert(mic.finish('private'))
 files['runtime/microphone-state.json']=json.encode({requestId='voice-1',state='error',reason='language'})
 assert(mic.update(player)==nil)
 assert(feedback[#feedback]=='Voice input only understands English for now. Typing works in any language.',feedback[#feedback])
 assert(not mic.context and cancellations[#cancellations].reason=='microphone-language')
 assert(mic.begin(input(false)));state('recording');mic.update(player);now=now+3;assert(mic.finish('private'))
 state('error');assert(mic.update(player)==nil)
 assert(feedback[#feedback]=='Microphone unavailable. Check your Windows input device.',feedback[#feedback])
`));

test('the language the mod resolved is published for the bridge only when it changes', () => check(`
 assert(mic.publishLanguage('ru')==true and files['runtime/ui-language.txt']=='ru')
 files['runtime/ui-language.txt']=nil
 assert(mic.publishLanguage('ru')==false and files['runtime/ui-language.txt']==nil,'an unchanged language writes nothing')
 assert(mic.publishLanguage('pt-br')==true and files['runtime/ui-language.txt']=='pt-br')
 assert(mic.publishLanguage('')==false and mic.publishLanguage(nil)==false and mic.publishLanguage(42)==false)
 available=false;assert(mic.publishLanguage('de')==false,'a failed write is ignored')
 available=true;assert(mic.publishLanguage('de')==true and files['runtime/ui-language.txt']=='de','and tried again next time')
`));

test('wiring: a menu ends only a recording that is opening or running', () => {
  const init = readFileSync(new URL('../mod/init.lua', import.meta.url), 'utf8');
  assert.match(init, /if not worldReady then\s+gameplayActions\.revoke\('menu'\)\s+local round = groupChat\.round\s+if \(microphone\.context ~= nil and microphone\.state ~= 'reply'\) or \(round and round\.mode == 'voice' and round\.stage == 'recording'\) then\s+cancelVoice\('menu'\)/);
});
