import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import fengari from 'fengari';

// Johnny Silverhand in the passenger seat of V's car (2026-10-23, the owner's 0.2.9 test: his reply was heard but his lips did not
// move; standing, they did). The game's scenes, workspots and mounts command his AI all the time, and the story-character face guards
// (Face.reds TalkRefusal and mod/facial-playback.lua luaActorSafe) refused a commanded AI. Johnny is a projection of V's head
// (mod/world-talk.lua PROJECTIONS), so for him alone a commanded AI no longer shuts his mouth; everything else that says the game has the
// floor (his own scene dialogue, a fight, an injury) still does. Face only: nothing about his seat or his animation is touched.
const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;
const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const reds = read('../r6/scripts/CyberpunkConvai/Face.reds');
const facial = read('../mod/facial-playback.lua');
const init = read('../mod/init.lua');
const worldTalk = read('../mod/world-talk.lua');
const between = (source, from, to) => {
  const start = source.indexOf(from), end = source.indexOf(to, start + from.length);
  assert(start >= 0 && end > start, `${from} ... ${to}`);
  return source.slice(start, end);
};
function run(code) {
  const state = lauxlib.luaL_newstate(); lualib.luaL_openlibs(state);
  const result = lauxlib.luaL_dostring(state, to_luastring(code));
  const error = result === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(state, -1));
  lua.lua_close(state); assert.equal(result, lua.LUA_OK, error);
}

test('Face.reds: a commanded AI refuses a named character except Johnny (told by Lua); his dialogue still refuses first', () => {
  const refusal = between(reds, 'public func TalkRefusal', 'private func PrepareSpawnedFace');
  assert.ok(refusal.indexOf('IsEntityInDialogue') < refusal.indexOf('ConvaiFaceIsProjection'), 'a scene dialogue is refused before anything else');
  assert.match(refusal, /if !npc\.ConvaiFaceIsProjection\(\) && !npc\.IsOnAutonomousAI\(\) \{ return "skipped:driven"; \};/);
  // The ordinary and quest-bound branch below keeps the commanded-AI refusal for everybody, Johnny's flag or not.
  const ordinary = refusal.slice(refusal.indexOf('let atPost'));
  assert.match(ordinary, /npc\.IsQuest\(\) \|\| !npc\.IsOnAutonomousAI\(\)/);
  assert.doesNotMatch(ordinary, /ConvaiFaceIsProjection/);
  // The flag: false until Lua says so, a plain field and two one-line methods, and a stand-in for a game without Codeware.
  assert.match(reds, /@addField\(NPCPuppet\)\s+private let m_convaiFaceProjection: Bool;/);
  assert.match(reds, /public final func ConvaiFaceProjection\(on: Bool\) -> Void \{\s+this\.m_convaiFaceProjection = on;\s+\}/);
  assert.match(reds, /public final func ConvaiFaceIsProjection\(\) -> Bool \{\s+return this\.m_convaiFaceProjection;\s+\}/);
  assert.match(reds, /@if\(!ModuleExists\("Codeware"\)\)\s+@addMethod\(NPCPuppet\)\s+public final func ConvaiFaceProjection\(on: Bool\) -> Void \{\s+\}/);
  // Nothing about the character's seat or animation: no AI command, no workspot call and no per-frame hook was added for this.
  assert.doesNotMatch(reds.slice(reds.indexOf('m_convaiFaceProjection')), /SendCommand|StopExecutingCommand|WorkspotSystem.*Exit|OnUpdate/);
});

test('luaActorSafe: a commanded AI does not shut a projection\'s mouth; dialogue, combat and injury still do', () => {
  const source = between(facial, 'local function luaActorSafe(', '-- M.screenEntity');
  run(`
    local state = {autonomous = true, combat = false, dialogue = false, scene = false, hurt = false}
    CName = {new = function(x) return x end}
    NPCPuppet = {IsInCombat = function() return state.combat end}
    StatusEffectSystem = {ObjectHasStatusEffectWithTag = function() return state.hurt end}
    Game = {GetSceneSystem = function() return {GetScriptInterface = function()
      return {IsEntityInDialogue = function() return state.dialogue end, IsEntityInScene = function() return state.scene end}
    end} end}
    local injuryTags, injuryNames = {'Injured', 'Defeated', 'Unconscious', 'Stunned', 'Ragdoll'}, nil
    ${source}
    local actor = {IsOnAutonomousAI = function() return state.autonomous end, GetEntityID = function() return 1 end}
    assert(luaActorSafe(actor, true) == true and luaActorSafe(actor, true, true) == true, 'a free character')
    state.autonomous = false
    assert(luaActorSafe(actor, true) == false, 'a commanded AI (a scene seat, a mount) refuses a named character')
    assert(luaActorSafe(actor, true, true) == true, 'but not Johnny: his mouth moves in the passenger seat')
    assert(luaActorSafe(actor, false, true) == true and luaActorSafe(actor, nil, true) == true)
    state.dialogue = true
    assert(luaActorSafe(actor, true, true) == false, 'his own scene dialogue is the game\\'s')
    state.dialogue = false; state.combat = true
    assert(luaActorSafe(actor, true, true) == false, 'a fight')
    state.combat = false; state.hurt = true
    assert(luaActorSafe(actor, true, true) == false, 'an injury')
    state.hurt = false; state.scene = true
    assert(luaActorSafe(actor, false, true) == false, 'the broad scene flag still counts unless the story rule lifts it')
  `);
  // Only the story speaker named by init.lua is judged this way, and the flag comes from the same press.
  assert.match(facial, /if entity~=nil and entity==M\.storyEntity then\s+local ok,ready=pcall\(luaActorSafe,actor,true,M\.storyProjection==true\)/);
  assert.equal([...facial.matchAll(/M\.storyProjection==true/g)].length, 1, 'read in one place only');
});

test('world-talk exposes the projection list; init.lua marks only a projection and clears the flag with the story speaker', () => {
  assert.match(worldTalk, /M\.PROJECTIONS = \{\['johnny-silverhand'\] = true\}/);
  assert.match(worldTalk, /local service = \{held = \{\}, count = 0, runtimeQuest = M\.runtimeQuest, PROJECTIONS = M\.PROJECTIONS\}/);
  assert.match(init, /convaiWorldTalk\.PROJECTIONS\[key\] == true or nil\s+convaiStory = primary\.story and \{entity = primary\.entity, key = key, name = name, projection = projection\} or nil/);
  assert.match(init, /convaiFacialPlayback\.storyProjection = projection == true/);
  assert.match(init, /convaiFacialPlayback\.storyEntity = primary\.entity\s+convaiFacialPlayback\.storyProjection = false/, 'a quest-bound archetype is never a projection');
  assert.match(init, /convaiFacialPlayback\.storyEntity, convaiFacialPlayback\.storyProjection = nil, nil/, 'cleared with the session');
});

test('convaiFaceRequestFor: Johnny\'s puppet is told before the request; nobody else is; old scripts without the method still get the request', () => {
  const helper = between(init, 'function convaiFaceRequestFor(', '-- A talk start whose speaker\'s face will not move');
  run(`
    local calls = {}
    local function npc(withMethod)
      local p = {ConvaiFaceRequest = function() calls[#calls + 1] = 'request'; return 'prepared:man_average_sermo' end}
      if withMethod then p.ConvaiFaceProjection = function(_, on) calls[#calls + 1] = 'projection=' .. tostring(on) end end
      return p
    end
    ${helper}
    local function names() local t = table.concat(calls, ','); calls = {}; return t end
    convaiStory = {entity = '10327ULL', key = 'johnny-silverhand', projection = true}
    local ok, status = convaiFaceRequestFor(npc(true), '10327ULL')
    assert(ok == true and status == 'prepared:man_average_sermo' and names() == 'projection=true,request', 'told first, then asked')
    ok = convaiFaceRequestFor(npc(true), '999ULL')
    assert(ok == true and names() == 'request', 'another entity is never marked')
    convaiStory = {entity = '10327ULL', key = 'judy-alvarez'}
    convaiFaceRequestFor(npc(true), '10327ULL')
    assert(names() == 'request', 'a story character who is not a projection is never marked')
    convaiStory = nil
    convaiFaceRequestFor(npc(true), '10327ULL')
    assert(names() == 'request', 'no story talk, no mark')
    convaiStory = {entity = '10327ULL', key = 'johnny-silverhand', projection = true}
    ok, status = convaiFaceRequestFor(npc(false), '10327ULL')
    assert(ok == true and status == 'prepared:man_average_sermo' and names() == 'request', 'scripts from before the method: the plain request, no error')
    local failing = {ConvaiFaceProjection = function() error('nope') end, ConvaiFaceRequest = function() error('no service') end}
    ok = convaiFaceRequestFor(failing, '10327ULL')
    assert(ok == false, 'a failed request still reports its failure to the log helper')
  `);
  // The two talk starts that can have Johnny as the speaker use it; nothing else in init.lua marks a puppet.
  assert.equal([...init.matchAll(/convaiFaceRequestFor\(/g)].length, 3, 'the definition, the text start and the voice start');
  assert.equal([...init.matchAll(/ConvaiFaceProjection\(true\)/g)].length, 1);
});
