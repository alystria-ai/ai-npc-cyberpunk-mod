import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import fengari from 'fengari';

// A character whose model another mod replaced (or whose look the game changed after it spawned) kept its voice but not its
// lips: the face graph the mod prepared at spawn is replaced by the vanilla graph when the appearance is rebuilt, or the new
// model runs a graph the mod has no copy of. Face.reds now prepares a rebuilt face again for every kind of character (our own
// copies, characters another mod spawned, the game's own), and every talk start or reply whose face will not move writes one line
// that names the status, what it means and the facts that identify the model (docs/FACIAL_ANIMATION.md, "A replaced model").
const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;
const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const reds = read('../r6/scripts/CyberpunkConvai/Face.reds');
const facialSource = read('../mod/facial-playback.lua');
const init = read('../mod/init.lua');
const body = (source, from, to) => {
  const start = source.indexOf(from), end = source.indexOf(to, start + from.length);
  assert(start >= 0 && end > start, `${from} ... ${to}`);
  return source.slice(start, end);
};
const inOrder = (text, needles) => {
  const at = needles.map(needle => {
    const found = text.indexOf(needle);
    assert(found >= 0, needle);
    return found;
  });
  assert.deepEqual([...at].sort((a, b) => a - b), at, needles.join(' < '));
};

function run(code) {
  const state = lauxlib.luaL_newstate(); lualib.luaL_openlibs(state);
  const result = lauxlib.luaL_dostring(state, to_luastring(code));
  const error = result === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(state, -1));
  lua.lua_close(state); assert.equal(result, lua.LUA_OK, error);
}
// facial-playback.lua as the game loads it: a few globals it touches at load, no dev probe file.
const withFacial = code => run(`
  io.open = function() return nil end
  Game = {GetPlayer = function() return nil end}
  CName = {new = function(x) return x end}
  NewObject = function() return {} end
  local face = (function() ${facialSource} end)()
  ${code}`);

// ---- the redscript side: who gets a rebuilt face prepared, and by which rule ----

test('FaceOwner names the four kinds in a fixed order, and a rebuilt face is prepared by the rule its kind had at its first build', () => {
  const owner = body(reds, 'public static func FaceOwner', 'public func RebuildCounts');
  assert.match(owner, /if !dynamic\.IsManaged\(id\) \{ return 3; \};\s*if dynamic\.IsTagged\(id, n"CyberpunkConvaiCompanion"\) \{ return 1; \};\s*if ConvaiFaceService\.SpawnedElsewhere\(dynamic, id\) \{ return 2; \};\s*return 0;/);
  const rebuilt = body(reds, 'private func PrepareRebuiltFace', 'private func PrepareGameFace');
  assert.match(rebuilt, /if owner == 1 \{ return this\.PrepareFaceComponent\(face\); \};\s*if owner == 2 \{ return this\.PrepareSpawnedFace\(face\); \};\s*return this\.PrepareGameFace\(npc, face\);/,
    'our copy: the companion graph; another mod\'s character: the spawned-character preparation; the game\'s own: its spawn rules');
  // A game-placed character: a named roster record while the setting is on, else a crowd graph through the same filters as at its spawn.
  const game = body(reds, 'private func PrepareGameFace', 'public static func FaceOwner');
  inOrder(game, ['this.m_storyTalk', 'ArrayContains(this.m_named, record)', 'this.PrepareSpawnedFace(face)', 'this.CrowdIndex(', 'if index < 0 { return ""; };',
    'this.PrepareCrowdFace(npc, face, index)']);
  assert.doesNotMatch(game, /face\.graph = |ScheduleAppearanceChange|GetDelaySystem/, 'it only delegates; the graph is written by the preparations');
  // The crowd preparation applies the quest and roster filters, the rig check and the load check, then writes once.
  const crowd = body(reds, 'private func PrepareCrowdFace', 'private func PrepareStoryFace');
  inOrder(crowd, ['ConvaiFaceService.CrowdSkipReason(', 'this.CheckRig(face)', 'ResourceRef.IsLoaded(graph)', 'face.graph = graph;', 'return "prepared:"']);
  assert.equal([...crowd.matchAll(/face\.graph = /g)].length, 1);
});

test('rebuilds are watched only once something exists that one could take the face from, and nothing runs per frame', () => {
  // Four places switch the watch on: our copy's or a spawned character's build (one line in OnCompanionExtract), our copy's
  // Initialize, a prepared story character, a prepared crowd NPC.
  assert.equal([...reds.matchAll(/this\.m_watchRebuilds = true;/g)].length, 4);
  assert.match(body(reds, 'private cb func OnCompanionInitialize', 'private func NoteRebuild'), /npc\.ConvaiFacePrepared\(false, "initializing"\);\s*this\.m_watchRebuilds = true;/);
  assert.match(body(reds, 'private cb func OnWorldInitialize', 'private func PrepareCrowdFace'),
    /if StrBeginsWith\(status, "prepared:"\) \{\s*npc\.ConvaiFacePrepared\(true, status, ResRef\.ToString\(ResourceRef\.GetPath\(face\.graph\)\)\);\s*this\.m_watchRebuilds = true;\s*\} else \{\s*npc\.ConvaiFacePrepared\(false, status\);\s*\};/,
    'a skipped NPC costs no string read: only a prepared one reads its graph path');
  assert.match(body(reds, 'private func PrepareStoryFace', 'public func SetStoryTalk'), /if StrBeginsWith\(status, "prepared:"\) \{ this\.m_watchRebuilds = true; \};/);
  // The extraction callback only notes while watching; before that it is the lookup it always was.
  const extract = body(reds, 'private cb func OnCompanionExtract', 'private func PrepareExtractedComponents');
  assert.match(extract, /if this\.m_watchRebuilds \{ this\.NoteRebuild\(builder\); \};/);
  assert.doesNotMatch(reds, /OnUpdate|UpdateScriptableService|GetDelaySystem|DelayCallback|ScheduleAppearanceChange/);
  // The reassembly handler returns before any native call while nothing is watched.
  assert.match(body(reds, 'private cb func OnReassemble', 'private func PrepareRebuiltFace'), /^private cb func OnReassemble\(event: ref<EntityLifecycleEvent>\) \{\s*if !this\.m_watchRebuilds \{ return; \};/);
});

test('the status line counts rebuilds per kind and every reassembly, so a report says where a face was lost', () => {
  const counts = body(reds, 'public func RebuildCounts', 'private cb func OnWorldInitialize');
  for (const word of ['noted=', 'claimed=', 'reassembled=', 'unmatched=', 'kinds=ours:', ',spawned:', ',game:', 'events=']) assert(counts.includes(`"${word}`) || counts.includes(word), word);
  assert.match(reds, /ArrayResize\(this\.m_rebuildKinds, 6\);/);
  // The indexes line up: a kind's reassemblies at kind - 1, its claims at kind + 2, read back in the same order.
  const claim = body(reds, 'private cb func OnReassemble', 'private func PrepareRebuiltFace');
  assert(claim.includes('this.m_rebuildKinds[owner - 1] += 1;') && claim.includes('this.m_rebuildKinds[owner + 2] += 1;'));
  for (const [kind, seen, claimed] of [['ours', 0, 3], ['spawned', 1, 4], ['game', 2, 5]]) {
    assert(counts.includes(`${kind}:" + IntToString(this.m_rebuildKinds[${seen}]) + "/" + IntToString(this.m_rebuildKinds[${claimed}])`), kind);
  }
});

test('ConvaiFaceDetail only reads: kind, record, appearance, template, face graph and rig, and the state of the mod graphs', () => {
  const detail = body(reds, 'public final func ConvaiFaceDetail', 'public final func ConvaiFaceApply(');
  for (const field of ['"kind="', '" record="', '" appearance="', '" template="', '" graph="', '" rig="']) assert(detail.includes(field), field);
  assert.match(detail, /ConvaiFaceService\.FaceOwner\(dynamic, this\.GetEntityID\(\)\)/);
  assert.match(detail, /service\.RigReport\(face\) \+ " " \+ service\.GraphReport\(\)/);
  assert.doesNotMatch(detail, /face\.graph = |ConvaiFacePrepared|ScheduleAppearanceChange|ApplyFeature|\.Toggle\(/, 'a read, never a write');
  const report = body(reds, 'public func RigReport', 'public func GraphReport');
  assert(report.includes('"tracks=rig-not-loaded"') && report.includes('"tracks=missing:"') && report.includes('"tracks=ok"'));
  const graphs = body(reds, 'public func GraphReport', 'public static func CrowdSkipReason');
  assert(graphs.includes('"mod-graphs=loaded:"') && graphs.includes('" failed:"') && graphs.includes('" waiting:"'));
  // Only the log helper in Lua asks for the detail: it is never part of a talk start, a frame or a write.
  assert.equal([...init.matchAll(/ConvaiFaceDetail/g)].length, 0, 'init.lua goes through facial-playback.faceNote');
  assert.equal([...facialSource.matchAll(/ConvaiFaceDetail/g)].length, 2, 'one call (faceNote) and its comment');
  assert.equal([...reds.matchAll(/\.RigReport\(/g)].length, 1, 'the rig report is read only by the detail');
  assert.equal([...reds.matchAll(/\.GraphReport\(/g)].length, 1, 'the graph report is read only by the detail');
});

test('our own copy answers its own status at a talk start (the old silent "managed" is gone), never an empty word', () => {
  const request = body(reds, 'public final func ConvaiFaceRequest()', 'public final func ConvaiFaceDetail');
  assert.doesNotMatch(request, /return "managed"/);
  inOrder(request, ['let ours = this.ConvaiFaceStatus();', 'return "no-face-rig";', 'return "unprepared:" + ResRef.ToString(ResourceRef.GetPath(ownFace.graph));',
    'service.TalkRefusal(this, spawned)']);
  // A prepared copy whose face another mod rebuilt says so through the same stale check as every other kind.
  assert.match(body(reds, 'public final func ConvaiFaceStatus()', 'public final func ConvaiFaceReady()'), /return "stale:" \+ live/);
});

// ---- the Lua side: one line per face that will not move ----

test('every status word Face.reds can answer has a plain reason in the log, and a speaking face has none', () => {
  const words = new Set();
  for (const [, word] of reds.matchAll(/return "([^"]+)"/g)) words.add(word);
  for (const [, word] of reds.matchAll(/ConvaiFacePrepared\((?:true|false), "([^"]+)"/g)) words.add(word);
  // A word that ends in ":" is a prefix with a graph path (or, for a screen face, another status) after it.
  const sample = word => word === 'screen:' ? 'screen:unsupported-rig'
    : word.endsWith(':') ? `${word}base\\animations\\facial\\_facial_graphs\\x.animgraph` : word;
  // The other strings the file returns are not face statuses: the rebuild counts and the crowd mode names.
  const list = [...words].filter(word => !/^(tracks=|mod-graphs=|noted=|off$|ungated$|gated$)/.test(word)).map(sample);
  assert(list.length >= 14, `found ${list.length} status words: ${list.join(', ')}`);
  for (const word of list) assert(!word.includes('"'), word);
  withFacial(`
    local words = {${list.map(word => JSON.stringify(word)).join(',')}}
    local missing = {}
    for _, word in ipairs(words) do
      local reason = face.faceStatusReason(word)
      if word:find('^prepared') then assert(reason == nil, word .. ' is a speaking face')
      elseif reason == nil then missing[#missing + 1] = word end
    end
    assert(#missing == 0, 'no reason for: ' .. table.concat(missing, ', '))
    assert(face.faceStatusReason('screen:speech-graph-not-loaded'):find('convai_facial.archive', 1, true), 'a screen face says the same')
    assert(face.faceStatusReason(nil) == nil and face.faceStatusReason('') == nil and face.faceStatusReason('something-new') == nil)
  `);
});

test('the reasons name what to do: the archive for a graph that did not load, the graph path for a model another mod replaced, the live graph for a rebuilt face', () => withFacial(`
  local reason = face.faceStatusReason
  assert(reason('speech-graph-not-loaded'):find('convai_facial.archive', 1, true))
  local replaced = reason('unsupported-graph:custom_mod\\\\npc\\\\face.animgraph')
  assert(replaced:find('custom_mod', 1, true) and replaced:find('another mod', 1, true), replaced)
  local light = reason('unprepared:base\\\\animations\\\\facial\\\\_facial_graphs\\\\man_average_sermo_lc.animgraph')
  assert(light:find('light%-crowd'), light)
  local stale = reason('stale:base\\\\animations\\\\facial\\\\_facial_graphs\\\\woman_average_sermo.animgraph noted=0 claimed=0')
  assert(stale:find('rebuilt', 1, true) and stale:find('woman_average_sermo.animgraph', 1, true) and not stale:find('noted', 1, true), stale)
  assert(reason('skipped:named'):find('Talk to story characters', 1, true))
  assert(reason('unsupported-rig'):find('lip-sync tracks', 1, true))
  assert(reason('service-unavailable'):find('redscript', 1, true))
`));

test('faceNote adds the reason and the native facts, and survives scripts that lack the detail or fail reading it', () => withFacial(`
  local actor = {ConvaiFaceDetail = function() return 'kind=companion record=Character.Judy appearance=judy_default template=a.ent graph=g rig=r tracks=ok mod-graphs=loaded:13 failed:0 waiting:0' end}
  local note = face.faceNote(actor, 'stale:g noted=0')
  assert(note:find('^ why=the face was rebuilt'), note)
  assert(note:find(' | kind=companion record=Character.Judy appearance=judy_default template=a.ent graph=g rig=r', 1, true), note)
  -- A speaking face has no reason, but the facts still follow when a caller asks (the reply line does so only when the face is not ready).
  assert(face.faceNote(actor, 'prepared:woman_average_sermo'):find('^ | kind=') == 1)
  -- Older scripts: no detail method (the call errors), an erroring one, a non-string answer, no actor at all.
  assert(face.faceNote({}, 'unsupported-rig') == ' why=' .. face.faceStatusReason('unsupported-rig'))
  assert(face.faceNote({ConvaiFaceDetail = function() error('boom') end}, 'no-face-rig') == ' why=' .. face.faceStatusReason('no-face-rig'))
  assert(face.faceNote({ConvaiFaceDetail = function() return 5 end}, 'no-face-rig') == ' why=' .. face.faceStatusReason('no-face-rig'))
  assert(face.faceNote(nil, 'speech-graph-not-loaded') == ' why=' .. face.faceStatusReason('speech-graph-not-loaded'))
  assert(face.faceNote(nil, 'something-new') == '')
`));

test('only a face that cannot speak needs a talk-start line; a failed read always does', () => withFacial(`
  assert(face.faceNeedsLine(true, 'prepared:man_big_sermo') == false)
  assert(face.faceNeedsLine(true, 'managed') == false, 'what older scripts answered for our own copies')
  for _, status in ipairs({'stale:x', 'skipped:named', 'unsupported-graph:x', 'speech-graph-not-loaded', 'unprepared:x', 'no-face-rig', 'initializing'}) do
    assert(face.faceNeedsLine(true, status) == true, status)
  end
  assert(face.faceNeedsLine(false, 'attempt to call a nil value') == true)
`));

test('convaiFaceRequestLog writes the one line, run as init.lua has it, and reports the mod graphs once per session', () => {
  const source = body(init, 'function convaiFaceRequestLog', '-- Names for nameless ordinary NPCs');
  run(`
    local lines = {}
    local log = function(line) lines[#lines + 1] = line end
    local reports = 0
    io.open = function() return nil end
    Game = {GetPlayer = function() return nil end,
      GetScriptableServiceContainer = function() return {GetService = function() return {GraphReport = function()
        reports = reports + 1; return 'mod-graphs=loaded:13 failed:0 waiting:0' end} end} end}
    CName = {new = function(x) return x end}; NewObject = function() return {} end
    convaiFacialPlayback = (function() ${facialSource} end)()
    ${source}
    local actor = {ConvaiFaceDetail = function() return 'kind=world record=Character.Judy appearance=judy_apartment template=judy.ent graph=g rig=r' end}
    -- The first talk start of the session says whether the archive is mounted, a speaking face writes nothing else, and it is said once.
    convaiFaceRequestLog(actor, '9003073ULL', true, 'prepared:woman_average_sermo')
    assert(#lines == 1 and lines[1] == 'Face graphs: mod-graphs=loaded:13 failed:0 waiting:0 crowd=gated story=nil', lines[1])
    convaiFaceRequestLog(actor, '9003073ULL', true, 'prepared:man_big_sermo'); convaiFaceRequestLog(actor, '9003073ULL', true, 'managed')
    assert(#lines == 1 and reports == 1, 'a speaking face writes nothing, and the graphs are read once')
    convaiFaceRequestLog(actor, '9003073ULL', true, 'stale:base\\\\x.animgraph noted=0 claimed=0')
    assert(#lines == 2 and reports == 1)
    local line = lines[2]
    assert(line:find('^Face request: actor=9003073ULL status=stale:base\\\\x%.animgraph noted=0 claimed=0 why=the face was rebuilt'), line)
    assert(line:find('appearance=judy_apartment', 1, true) and line:find('template=judy.ent', 1, true), line)
    convaiFaceRequestLog(actor, '55ULL', false, 'attempt to call a nil value')
    assert(#lines == 3 and lines[3]:find('^Face request: actor=55ULL status=attempt to call a nil value'), lines[3])
    assert(not lines[3]:find('kind=world', 1, true), 'a failed read has no actor to ask')
    -- Without the facial module (it failed to load) the old rule holds: a speaking face is quiet, anything else is written plainly.
    convaiFacialPlayback = nil
    convaiFaceRequestLog(actor, '1ULL', true, 'prepared:x'); convaiFaceRequestLog(actor, '2ULL', true, 'skipped:quest')
    assert(#lines == 4 and lines[4] == 'Face request: actor=2ULL status=skipped:quest', lines[4])
  `);
  // A game whose redscript half is missing still gets its one graphs line, saying it could not be read.
  run(`
    local lines = {}
    local log = function(line) lines[#lines + 1] = line end
    io.open = function() return nil end
    Game = {GetPlayer = function() return nil end, GetScriptableServiceContainer = function() return {GetService = function() return nil end} end}
    CName = {new = function(x) return x end}; NewObject = function() return {} end
    convaiFacialPlayback = (function() ${facialSource} end)()
    ${source}
    convaiFaceRequestLog({}, '1ULL', true, 'service-unavailable'); convaiFaceRequestLog({}, '1ULL', true, 'service-unavailable')
    assert(#lines == 3 and lines[1]:find('^Face graphs: not readable %('), lines[1])
    assert(lines[2]:find('status=service-unavailable why=the redscript half', 1, true) and lines[3] == lines[2], lines[2])
  `);
});

test('the three talk starts and the reply line use the helper; nothing logs a face request any other way', () => {
  assert.equal([...init.matchAll(/convaiFaceRequestLog\(/g)].length, 4, 'the definition and the three talk starts (text, voice, group speaker)');
  assert.equal([...init.matchAll(/log\('Face request: /g)].length, 1, 'the only Face request line is the one convaiFaceRequestLog writes');
  assert.equal([...init.matchAll(/:ConvaiFaceRequest\(\)/g)].length, 5, 'the call sites are unchanged: three talk starts, the scripted dev talk, a spawned speaker\'s reaction');
  // The reply line: the reason and the facts follow face=... only when the speaker's mouth is not ready.
  const result = body(init, "local faceState, faceNote = 'none', ''", "if automatic and pending.requestId == automatic.requestId then");
  assert.match(result, /if not \(faceOk and faceReady == true\) and convaiFacialPlayback and convaiFacialPlayback\.faceNote then/);
  assert.match(result, /\.\. ' face=' \.\. faceState \.\. why \.\. faceNote\r?\n/);
  // The graph report is read at a talk start, never from a frame or an update.
  assert.equal([...init.matchAll(/graphReport/g)].length, 2, 'one existence check and one call, both in the log helper');
});
