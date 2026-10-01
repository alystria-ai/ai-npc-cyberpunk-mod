import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {buildProfiles} from '../research/cyberpunk/scripts/build_research.mjs';
import {compileIntrinsicCharacterPacks, intrinsicProfileMaterial, normalizeIntrinsicCharacterPack,
  adoptedIntrinsicKeys, requireAdoptedIntrinsicPacks, requireAdoptedIntrinsicMaterial}
  from '../research/cyberpunk/scripts/intrinsic_character_claims.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function fixture() {
  const key = 'jackie-welles', name = 'Jackie Welles';
  const roster = [{key, name, kind: 'named', voice: 'existing-voice', model: 'existing-model',
    aliases: ['Jackie'], records: ['Character.Jackie']}];
  const dossiers = [{key, name, kind: 'named', profile: {backstory: 'A Heywood mercenary.',
    speakingStyleDescription: 'Warm and exuberant.',
    speakingStyleSampleDialogues: ['An old original example.']},
    knowledge: {background: ['His neighborhood.'], unknown: ['No unverified quest outcome.'],
      private: ['Never append this private biography.'], conditional: []}, relationships: [], sources: [], uncertainties: []}];
  const document = {Header: {WolvenKitVersion: '9.0.1', GameVersion: 2310}, Data: {RootChunk: {$type: 'scnSceneResource',
    actors: [{$type: 'scnActorDef', actorName: 'jackie', actorId: {id: 0}, record: 'Character.Jackie'}],
    screenplayStore: {lines: [{$type: 'scnscreenplayDialogLine', speaker: {id: 0}, text: 'A verified source line.'}]}}}};
  const raw = Buffer.from('Small synthetic native binary'), jsonRaw = Buffer.from(JSON.stringify(document));
  const source = {id: 'scene', depotPath: 'base\\quest\\fixture.scene',
    rawPath: 'runtime/voice-cast/test/raw/fixture.scene',
    jsonPath: 'runtime/voice-cast/test/raw/fixture.scene.json',
    assetSha256: hash(raw), jsonSha256: hash(jsonRaw), archiveEntrySha1: '1'.repeat(40), serializationVerified: true};
  const reference = {sourceId: 'scene', rawPath: source.rawPath, jsonPath: source.jsonPath,
    assetSha256: source.assetSha256, jsonSha256: source.jsonSha256,
    jsonPointer: '/Data/RootChunk/screenplayStore/lines/0', expectedType: 'scnscreenplayDialogLine',
    expectedValue: document.Data.RootChunk.screenplayStore.lines[0]};
  const journalDocument = {Header: {WolvenKitVersion: '9.0.1', GameVersion: 2310},
    Data: {RootChunk: {$type: 'gameJournalResource', subject: {$type: 'gameJournalCodexEntry', id: 'jackie_welles'}}}};
  const journalRaw = Buffer.from('Synthetic codex source'), journalJsonRaw = Buffer.from(JSON.stringify(journalDocument));
  const journalSource = {...source, id: 'journal', depotPath: 'base\\journal\\fixture.journal',
    rawPath: 'runtime/voice-cast/test/raw/fixture.journal', jsonPath: 'runtime/voice-cast/test/raw/fixture.journal.json',
    assetSha256: hash(journalRaw), jsonSha256: hash(journalJsonRaw)};
  const claim = {id: 'public.identity', text: 'He values his neighborhood and enjoys boxing.', kind: 'intrinsic',
    disclosure: 'self-may-volunteer', audience: ['private', 'phone', 'group'], exactnativeRefs: [reference],
    qualification: {status: 'source-authenticated-authoring', currentSaveQualified: false,
      evidenceBasis: 'native-dialogue', limits: 'This proves no meeting with V or championship result.'},
    attribution: {characterKey: key, mode: 'self-report', perspective: 'His own source speech, not a shared V event.',
      subjectRef: {sourceId: 'journal', jsonPointer: '/Data/RootChunk/subject/id'},
      speakers: [{sourceId: 'scene', actorPointer: '/Data/RootChunk/actors/0',
        linePointer: '/Data/RootChunk/screenplayStore/lines/0'}]}};
  const sample = {id: 'boxing', text: 'Choom, stop talking and put those gloves on.',
    authoring: 'original; not a game quote', useWhen: 'Asked about boxing.',
    claimIds: [claim.id], speakerPrefix: false};
  const pack = {version: 1, key, name, gameVersions: ['2.31'], nativeSources: [source, journalSource],
    claims: [claim], speakingStyleSamples: [sample], proposedProfile: {backstory: 'DO NOT IMPORT WHOLE PRIVATE PROPOSAL'}};
  const f = {roster, dossiers, pack, raw, jsonRaw, document, source, reference, claim,
    journalDocument, journalRaw, journalJsonRaw, journalSource};
  f.load = source => source.id === 'journal' ? {raw: f.journalRaw, jsonRaw: f.journalJsonRaw} : {raw: f.raw, jsonRaw: f.jsonRaw};
  return f;
}
function build(f) { return buildProfiles(f.roster, f.dossiers, {intrinsicPacks: [f.pack], loadIntrinsicArtifact: f.load})[0]; }

function aliasFixture(key, subjectId, title, actorName, voice) {
  const f = fixture();
  const names = {'misty-olszewski': 'Misty Olszewski', 'viktor-vektor': 'Viktor Vektor',
    'rogue-amendiares': 'Rogue Amendiares', takemura: 'Goro Takemura', 'evelyn-parker': 'Evelyn Parker',
    'solomon-reed': 'Solomon Reed', 'muamar-reyes': 'Muamar Reyes', 'mr-hands': 'Mr. Hands', 'regina-jones': 'Regina Jones',
    'mama-welles': 'Mama Welles'};
  const name = names[key];
  f.roster[0] = {...f.roster[0], key, name, aliases: [name], records: ['Character.ReviewedFixture']};
  f.dossiers[0] = {...f.dossiers[0], key, name};
  f.pack.key = key; f.pack.name = name; f.claim.attribution.characterKey = key;
  f.journalDocument.Data.RootChunk.subject.id = subjectId;
  f.journalDocument.Data.RootChunk.subject.title = {value: 'LocKey#12345'};
  f.document.Data.RootChunk.actors[0].actorName = actorName;
  f.document.Data.RootChunk.actors[0].voicetagId = {id: voice};
  f.jsonRaw = Buffer.from(JSON.stringify(f.document)); f.source.jsonSha256 = hash(f.jsonRaw);
  f.reference.jsonSha256 = f.source.jsonSha256;
  f.journalJsonRaw = Buffer.from(JSON.stringify(f.journalDocument)); f.journalSource.jsonSha256 = hash(f.journalJsonRaw);
  const localizedDocument = {Header: {WolvenKitVersion: '9.0.1', GameVersion: 2310},
    Data: {RootChunk: {$type: 'JsonResource', entry: {$type: 'localizationPersistenceOnScreenEntry',
      primaryKey: '12345', femaleVariant: title, maleVariant: ''}}}};
  const localizedRaw = Buffer.from('Synthetic reviewed title asset'), localizedJson = Buffer.from(JSON.stringify(localizedDocument));
  const localizedSource = {...f.source, id: 'title', depotPath: 'base\\localization\\en-us\\onscreens\\fixture.json',
    rawPath: 'runtime/voice-cast/test/raw/title.json', jsonPath: 'runtime/voice-cast/test/raw/title.json.json',
    assetSha256: hash(localizedRaw), jsonSha256: hash(localizedJson)};
  f.pack.nativeSources.push(localizedSource);
  f.claim.attribution.subjectTitleRefs = [
    {sourceId: 'journal', jsonPointer: '/Data/RootChunk/subject/title/value'},
    {sourceId: 'title', jsonPointer: '/Data/RootChunk/entry/primaryKey'},
    {sourceId: 'title', jsonPointer: '/Data/RootChunk/entry/femaleVariant'},
  ];
  f.claim.exactnativeRefs.push(
    {sourceId: 'journal', jsonPointer: '/Data/RootChunk/subject/title/value', expectedValue: 'LocKey#12345'},
    {sourceId: 'title', jsonPointer: '/Data/RootChunk/entry/primaryKey', expectedValue: '12345'},
    {sourceId: 'title', jsonPointer: '/Data/RootChunk/entry/femaleVariant', expectedValue: title});
  f.load = source => source.id === 'journal' ? {raw: f.journalRaw, jsonRaw: f.journalJsonRaw}
    : source.id === 'title' ? {raw: localizedRaw, jsonRaw: localizedJson} : {raw: f.raw, jsonRaw: f.jsonRaw};
  return f;
}

test('an unadopted fresh checkout remains valid without any native files', () => {
  const f = fixture();
  const [profile] = buildProfiles(f.roster, f.dossiers);
  assert.doesNotMatch(profile.backstory, /verified source|enjoys boxing|PRIVATE PROPOSAL/);
  assert.equal(profile.speakingStyleSampleDialogues, 'An old original example.');
  assert.equal(profile.nativeIntrinsic, undefined);
  assert.deepEqual(adoptedIntrinsicKeys({}), []);
});

test('source-authenticated public history adds bounded topic material while retaining authority and identity', () => {
  const f = fixture(), before = JSON.stringify(f.pack), [baseline] = buildProfiles(f.roster, f.dossiers), profile = build(f);
  assert.match(profile.backstory, /He values his neighborhood and enjoys boxing/);
  assert.match(profile.backstory, /one or two sentences/);
  assert.match(profile.backstory, /Current verified game facts override conflicting memories/);
  assert.match(profile.backstory, /This proves no meeting with V or championship result/);
  assert.doesNotMatch(profile.backstory, /Never append|WHOLE PRIVATE PROPOSAL/);
  assert.match(profile.speakingStyleSampleDialogues, /Choom, stop talking/);
  assert.match(profile.speakingStyleDescription, /without prepending your name/);
  assert.equal(profile.speakingStyleDescription, baseline.speakingStyleDescription);
  for (const field of ['key', 'name', 'voice', 'model', 'aliases', 'records']) assert.deepEqual(profile[field], f.roster[0][field]);
  assert.equal(JSON.stringify(f.pack), before, 'authored input remains unchanged');
  assert.equal(profile.nativeIntrinsic.referencesVerified, 4);
  assert.deepEqual(profile.nativeIntrinsic.claimIds, ['public.identity']);
  assert.notEqual(profile.researchRevision, baseline.researchRevision);
});

test('private, trust-earned, group-blocked and conditional claims never become static payload or samples', () => {
  const mutations = [
    claim => { claim.kind = 'private-intrinsic'; },
    claim => { claim.disclosure = 'only-when-topic-and-trust-support-it'; },
    claim => { claim.audience = ['private', 'phone']; },
    claim => { claim.audience.push('private-only'); },
    claim => { claim.kind = 'conditional'; },
    claim => { claim.requiredContext = ['Verified current-save choice.']; },
    claim => { claim.qualification.profileUse = 'conditional-topic-knowledge'; },
    claim => { claim.qualification.profileUse = 'style-reference-only'; },
    claim => { claim.qualification.currentSaveQualified = true; },
    claim => { claim.condition = {type: 'fact', key: 'quest-result', value: 1}; },
    claim => { claim.questKey = 'the-heist'; },
  ];
  for (const change of mutations) {
    const f = fixture(); change(f.claim);
    let reads = 0; f.load = () => { reads++; throw Error('Excluded history must not materialize'); };
    const profile = build(f);
    assert.doesNotMatch(profile.backstory, /enjoys boxing/);
    assert.doesNotMatch(profile.speakingStyleSampleDialogues, /Choom/);
    assert.equal(profile.nativeIntrinsic, undefined);
    assert.equal(reads, 0);
  }
});

test('structured or unknown prerequisite forms cannot bypass the public static-material gate', () => {
  for (const value of [{verifiedDisclosure: true}, null, 'trusted private listener', [null]]) {
    const f = fixture(); f.claim.requiredContext = value;
    assert.throws(() => build(f), /unsupported prerequisite shape/);
  }
  const f = fixture(); f.claim.qualification.requiredContext = {requiresTrust: true};
  assert.throws(() => build(f), /unsupported qualification shape/);
});

test('the alternate schema preserves a public recollection as perspective and excludes private topic material', () => {
  const f = fixture(); f.roster[0] = {...f.roster[0], key: 'johnny-silverhand', name: 'Johnny Silverhand', aliases: ['Johnny']};
  f.dossiers[0] = {...f.dossiers[0], key: 'johnny-silverhand', name: 'Johnny Silverhand'};
  f.journalDocument.Data.RootChunk.subject.id = 'johnny_silverhand';
  f.journalJsonRaw = Buffer.from(JSON.stringify(f.journalDocument)); f.journalSource.jsonSha256 = hash(f.journalJsonRaw);
  f.document.Data.RootChunk.actors[0].actorName = 'Santiago';
  f.document.Data.RootChunk.playerActors = [{$type: 'scnPlayerActorDef', actorId: {id: 9},
    playerName: 'Player', specCharacterRecordId: {$value: 'Character.johnny_replacer'}, voicetagId: {id: '1103967280742240508'}}];
  f.jsonRaw = Buffer.from(JSON.stringify(f.document)); f.source.jsonSha256 = hash(f.jsonRaw);
  const sourceView = source => ({id: source.id, depotPath: source.depotPath, rawFile: source.rawPath, jsonFile: source.jsonPath,
    rawSha256: source.assetSha256, jsonSha256: source.jsonSha256, archiveEntrySha1: '1'.repeat(40),
    nativeIndexVerified: true, serialization: 'fresh-pinned-wolvenkit-9.0.1'});
  f.pack = {schemaVersion: 1, characterKey: 'johnny-silverhand', gameVersion: '2.31',
    sources: [sourceView(f.source), sourceView(f.journalSource)],
    claims: [{id: 'johnny.recollection', text: 'Johnny remembers a colleague challenging his charm.',
      kind: 'uncertain-recollection', disclosure: 'only-with-explicit-memory-perspective',
      audience: ['private-one-to-one', 'group-without-private-details'],
      qualification: {profileUse: 'topic-knowledge', viewpoint: 'johnny-subjective-recollection',
        limits: ['Not objective proof of another person\'s motive.']},
      nativeRefs: [{sourceId: 'scene', jsonPointer: '/Data/RootChunk/screenplayStore/lines/0/text',
        valueSha256: hash(Buffer.from('A verified source line.')), valueEncoding: 'utf-8'}],
      attribution: {characterKey: 'johnny-silverhand', mode: 'represented-memory', perspective: 'A subjective Johnny frame.',
        subjectRef: {sourceId: 'journal', jsonPointer: '/Data/RootChunk/subject/id'},
        speakers: [{sourceId: 'scene', actorPointer: '/Data/RootChunk/actors/0',
          linePointer: '/Data/RootChunk/screenplayStore/lines/0', frameActorPointer: '/Data/RootChunk/playerActors/0',
          expectedSubjectRecord: 'Character.johnny_replacer', expectedSubjectVoicetag: '1103967280742240508'}]}}],
    sourcePolicy: {examples: 'Original editorial delivery examples, not game quotations.'},
    cadenceExamples: [{id: 'recollection', text: 'I remember the argument. That does not make me the referee.',
      context: 'History is being discussed.', claimIds: ['johnny.recollection']}]};
  let profile = build(f);
  assert.match(profile.backstory, /Johnny remembers a colleague/);
  assert.match(profile.backstory, /Keep recollections and opinions attributed/);
  assert.match(profile.speakingStyleSampleDialogues, /I remember the argument/);
  f.pack.claims[0].text = 'The colleague definitely had a secret motive.';
  profile = build(f);
  assert.doesNotMatch(profile.backstory, /definitely had/);
  f.pack.claims[0].text = 'Johnny remembers a colleague challenging his charm.';
  f.pack.claims[0].audience = ['private-one-to-one'];
  assert.doesNotMatch(build(f).backstory, /remembers a colleague/);
});

test('recorded binary and exported JSON hashes both reject stale artifacts', () => {
  for (const changed of ['raw', 'jsonRaw']) {
    const f = fixture(); f.load = () => ({raw: f.raw, jsonRaw: f.jsonRaw, [changed]: Buffer.from('changed')});
    assert.throws(() => build(f), /recorded binary or JSON hash mismatch/);
  }
  const f = fixture(); delete f.source.jsonSha256;
  assert.throws(() => build(f), /unqualified.*native source/);
});

test('exact values, types and source bindings are required beyond a matching artifact hash', () => {
  for (const change of [
    f => { f.reference.expectedValue = {$type: 'scnscreenplayDialogLine', text: 'invented'}; },
    f => { f.reference.expectedType = 'questSetVar_NodeType'; },
    f => { f.reference.assetSha256 = '0'.repeat(64); },
    f => { f.reference.sourceId = 'another-scene'; },
    f => { f.reference.jsonPointer = '/Header/ExportedDateTime'; },
    f => { delete f.reference.expectedValue; delete f.reference.expectedType; },
  ]) {
    const f = fixture(); change(f);
    assert.throws(() => build(f), /native value mismatch|native type mismatch|reference\/source mismatch|unknown source|untyped pointer|no recorded pointer expectation/);
  }
  const f = fixture(); f.document.Data.RootChunk = {screenplayStore: {lines: [{text: 'A verified source line.'}]}};
  f.jsonRaw = Buffer.from(JSON.stringify(f.document)); f.source.jsonSha256 = hash(f.jsonRaw);
  f.reference.jsonSha256 = f.source.jsonSha256; f.load = () => ({raw: f.raw, jsonRaw: f.jsonRaw});
  assert.throws(() => build(f), /missing native root type/);
});

test('a different native game or serializer version cannot masquerade as the declared reviewed source', () => {
  for (const field of ['GameVersion', 'WolvenKitVersion']) {
    const f = fixture(); f.document.Header[field] = field === 'GameVersion' ? 2300 : 'old-unpinned';
    f.jsonRaw = Buffer.from(JSON.stringify(f.document)); f.source.jsonSha256 = hash(f.jsonRaw);
    f.reference.jsonSha256 = f.source.jsonSha256; f.load = () => ({raw: f.raw, jsonRaw: f.jsonRaw});
    assert.throws(() => build(f), /native serializer or game version mismatch/);
  }
});

test('native paths are contained and character identity cannot be silently reassigned', () => {
  for (const path of ['../secret.txt', 'runtime/voice-cast/test/../../secret.txt', 'C:/secret.txt', 'runtime/other/secret.txt']) {
    const f = fixture(); f.source.rawPath = path;
    assert.throws(() => build(f), /unqualified.*native source/);
  }
  for (const change of [
    f => { f.pack.key = 'unknown-character'; },
    f => { f.pack.name = 'Johnny Silverhand'; },
    f => { f.claim.characterKey = 'johnny-silverhand'; },
    f => { f.roster[0].kind = 'ambient'; },
  ]) {
    const f = fixture(); change(f); assert.throws(() => build(f), /mismatched or duplicate character/);
  }
  const f = fixture();
  assert.throws(() => compileIntrinsicCharacterPacks([f.pack, f.pack], {roster: f.roster, loadArtifact: f.load}), /duplicate character/);
});

test('another subject or speaker cannot become Johnny history by editing only authored metadata', () => {
  const f = fixture();
  f.pack.key = 'johnny-silverhand'; f.pack.name = 'Johnny Silverhand';
  f.roster[0] = {...f.roster[0], key: 'johnny-silverhand', name: 'Johnny Silverhand', aliases: ['Johnny']};
  f.dossiers[0] = {...f.dossiers[0], key: 'johnny-silverhand', name: 'Johnny Silverhand'};
  f.claim.attribution.characterKey = 'johnny-silverhand';
  assert.throws(() => build(f), /native subject identity mismatch/);
  // Even a correct Johnny codex does not make Jackie the speaking subject.
  f.journalDocument.Data.RootChunk.subject.id = 'johnny_silverhand';
  f.journalJsonRaw = Buffer.from(JSON.stringify(f.journalDocument)); f.journalSource.jsonSha256 = hash(f.journalJsonRaw);
  assert.throws(() => build(f), /another character cannot become a self-report/);
});

test('only explicit reviewed codex aliases with exact localized title ownership qualify', () => {
  const rows = [
    ['misty-olszewski', 'misty', 'Misty', 'Misty', '1103967280742240328'],
    ['viktor-vektor', 'viktor', 'Viktor Vektor', 'Victor_Vector', '1103967280742240868'],
    ['rogue-amendiares', 'rogue', 'Rogue', 'rogue', '1215558083456446464'],
    ['takemura', 'goro_takemura', 'Goro Takemura', 'Takemura', '1641719118585413632'],
    ['evelyn-parker', 'eveyly_parker', 'Evelyn Parker', 'Evelyn', '1103967280742240436'],
    ['solomon-reed', 'reed', 'Solomon Reed', 'Reed_Holo', '2553392786132918272'],
    ['muamar-reyes', 'el_capitan', 'Muamar “El Capitan” Reyes', 'muamar_holo', '1609922889482010624'],
  ];
  for (const row of rows) assert.match(build(aliasFixture(...row)).backstory, /enjoys boxing/, row[0]);
  const wrongSubject = aliasFixture('solomon-reed', 'rogue', 'Solomon Reed', 'Reed', '2553392786132918272');
  assert.throws(() => build(wrongSubject), /native subject identity mismatch/);
  const repairedTypo = aliasFixture('evelyn-parker', 'evelyn_parker', 'Evelyn Parker', 'Evelyn', '1103967280742240436');
  assert.throws(() => build(repairedTypo), /native subject identity mismatch/);
  const unlisted = aliasFixture('solomon-reed', 'solomon_reed', 'Solomon Reed', 'Reed', '2553392786132918272');
  assert.throws(() => build(unlisted), /native subject identity mismatch/);
  const wrongTitle = aliasFixture('solomon-reed', 'reed', 'Jackie Welles', 'Reed', '2553392786132918272');
  assert.throws(() => build(wrongTitle), /reviewed native subject title mismatch/);
});

test('native actor aliases require the reviewed exact name, voice and title rather than suffix or last-name guesses', () => {
  for (const row of [
    ['viktor-vektor', 'viktor', 'Viktor Vektor', 'viktor', '1103967280742240868'],
    ['solomon-reed', 'reed', 'Solomon Reed', 'Reed', '2553392786132918272'],
    ['mr-hands', 'mr_hands', 'Mr. Hands', 'Mr_Hands', '1254681766112239616'],
    ['regina-jones', 'regina_jones', 'Regina Jones', 'regina_holo', '1609919435757879296'],
    ['mama-welles', 'mama_welles', 'Mama Welles', 'mama_welles', '1704188817181679616'],
    ['mama-welles', 'mama_welles', 'Mama Welles', 'Mama_Welles', '1704188817181679616'],
  ]) assert.match(build(aliasFixture(...row)).backstory, /enjoys boxing/, row[0]);
  for (const name of ['reed_holo', 'Reed_Holo_Unknown', 'Reed_fake', 'Solomon']) {
    const f = aliasFixture('solomon-reed', 'reed', 'Solomon Reed', name, '2553392786132918272');
    assert.throws(() => build(f), /another character cannot become a self-report/, name);
  }
  const f = aliasFixture('solomon-reed', 'reed', 'Solomon Reed', 'Reed', '1103967280742240508');
  assert.throws(() => build(f), /another character cannot become a self-report/);
  const wrongWitness = aliasFixture('mama-welles', 'mama_welles', 'Mama Welles', 'jackie', '1103967280742240500');
  assert.throws(() => build(wrongWitness), /another character cannot become a self-report/);
});

test('a codex alias cannot borrow an unrelated title locator or omit recorded title references', () => {
  const f = aliasFixture('misty-olszewski', 'misty', 'Misty', 'Misty', '1103967280742240328');
  delete f.claim.attribution.subjectTitleRefs;
  assert.throws(() => build(f), /requires sourced title or canonical record ownership/);
  f.claim.attribution.subjectTitleRefs = [
    {sourceId: 'journal', jsonPointer: '/Data/RootChunk/subject/title/value'},
    {sourceId: 'title', jsonPointer: '/Data/RootChunk/entry/primaryKey'},
    {sourceId: 'title', jsonPointer: '/Data/RootChunk/entry/femaleVariant'},
  ];
  f.claim.exactnativeRefs = f.claim.exactnativeRefs.filter(ref => ref.sourceId !== 'title');
  assert.throws(() => build(f), /invalid reviewed subject title references/);
});

test('scene speaker joins and third-party testimony are explicit, typed and separate from self-report', () => {
  const f = fixture(); delete f.claim.attribution;
  assert.throws(() => build(f), /missing claim-scoped subject attribution/);
  const g = fixture(); g.document.Data.RootChunk.actors[0].actorName = 'Misty';
  g.jsonRaw = Buffer.from(JSON.stringify(g.document)); g.source.jsonSha256 = hash(g.jsonRaw);
  g.reference.jsonSha256 = g.source.jsonSha256;
  g.claim.attribution.mode = 'third-party-report';
  assert.throws(() => build(g), /missing attributed third-party subject connection/);
  g.claim.attribution.subjectConnection = 'The witness describes this subject in the recorded dialogue.';
  assert.match(build(g).backstory, /enjoys boxing/);
  g.document.Data.RootChunk.screenplayStore.lines[0].speaker.id = 42;
  g.jsonRaw = Buffer.from(JSON.stringify(g.document)); g.source.jsonSha256 = hash(g.jsonRaw);
  g.reference.jsonSha256 = g.source.jsonSha256;
  assert.throws(() => build(g), /typed actor-to-screenplay speaker mismatch/);
});

test('an unrelated correct speaker or bare codex identity cannot launder another narrative line', () => {
  const f = fixture();
  f.document.Data.RootChunk.actors.push({$type: 'scnActorDef', actorName: 'Another Person', actorId: {id: 1}});
  f.document.Data.RootChunk.screenplayStore.lines.push({$type: 'scnscreenplayDialogLine', speaker: {id: 1}, text: 'Other speech.'});
  f.jsonRaw = Buffer.from(JSON.stringify(f.document)); f.source.jsonSha256 = hash(f.jsonRaw);
  f.reference.jsonSha256 = f.source.jsonSha256;
  f.reference.jsonPointer = '/Data/RootChunk/screenplayStore/lines/1';
  f.reference.expectedValue = f.document.Data.RootChunk.screenplayStore.lines[1];
  assert.throws(() => build(f), /attribution points outside the claim's narrative evidence/);
  f.claim.attribution.mode = 'native-codex'; f.claim.attribution.speakers = [];
  assert.throws(() => build(f), /scene evidence cannot masquerade as codex material/);
  f.claim.exactnativeRefs = [{sourceId: 'journal', jsonPointer: '/Data/RootChunk/subject/id', expectedValue: 'jackie_welles'}];
  assert.throws(() => build(f), /claim lacks subject-bound localized codex material/);
});

test('selected original samples must be prefix-free and depend entirely on included public claims', () => {
  const f = fixture(); f.pack.speakingStyleSamples[0].text = 'Jackie: Do not read this name aloud.';
  assert.throws(() => build(f), /without speaker labels/);
  f.pack.speakingStyleSamples[0].text = 'Some original private example.';
  f.pack.speakingStyleSamples[0].claimIds = ['private.missing'];
  assert.doesNotMatch(build(f).speakingStyleSampleDialogues, /private example/);
  f.pack.speakingStyleSamples[0].claimIds = ['public.identity'];
  f.pack.speakingStyleSamples[0].authoring = 'copied game quote';
  assert.doesNotMatch(build(f).speakingStyleSampleDialogues, /private example/);
});

test('public material cannot be forged by passing an unverified compiler view', () => {
  assert.throws(() => intrinsicProfileMaterial({key: 'jackie-welles', claims: []}), /Unverified public intrinsic view/);
  const f = fixture(), views = compileIntrinsicCharacterPacks([f.pack], {roster: f.roster, loadArtifact: f.load});
  assert(Object.isFrozen(views[0])); assert(Object.isFrozen(views[0].claims[0]));
  assert.match(intrinsicProfileMaterial(views[0]).backstory, /enjoys boxing/);
});

test('adopted history must remain present and qualified in subsequent ordinary rebuilds', () => {
  const f = fixture(), keys = adoptedIntrinsicKeys({nativeIntrinsicProfiles: ['jackie-welles']});
  assert.deepEqual(keys, ['jackie-welles']);
  assert.doesNotThrow(() => requireAdoptedIntrinsicPacks(keys, [f.pack]));
  assert.throws(() => requireAdoptedIntrinsicPacks(keys, []), /adopted public history pack is missing/);
  assert.doesNotThrow(() => requireAdoptedIntrinsicMaterial(keys, [build(f)]));
  const published = build(f);
  assert.deepEqual(adoptedIntrinsicKeys({}, [published]), ['jackie-welles'], 'roster receipt recovers a missing adoption setting');
  const previous = structuredClone(published);
  previous.nativeIntrinsic.claimIds.push('previous.public-history');
  assert.throws(() => requireAdoptedIntrinsicMaterial(keys, [published], [previous]), /adopted claimIds would be removed/);
  previous.nativeIntrinsic.claimIds.pop(); previous.nativeIntrinsic.sampleIds.push('previous.public-example');
  assert.throws(() => requireAdoptedIntrinsicMaterial(keys, [published], [previous]), /adopted sampleIds would be removed/);
  f.claim.kind = 'private-intrinsic';
  assert.throws(() => requireAdoptedIntrinsicMaterial(keys, [build(f)]), /no qualified material/);
  for (const config of [{nativeIntrinsicProfiles: 'all'}, {nativeIntrinsicProfiles: ['../unsafe']},
    {nativeIntrinsicProfiles: ['jackie-welles', 'jackie-welles']}]) assert.throws(() => adoptedIntrinsicKeys(config), /Invalid persistent adoption/);
});

test('both checked-in authoring formats normalize without assuming their proposed biographies are safe', () => {
  for (const key of ['jackie-welles', 'johnny-silverhand']) {
    const pack = JSON.parse(readFileSync(new URL(`../research/cyberpunk/native-character-claims/${key}.json`, import.meta.url), 'utf8'));
    const view = normalizeIntrinsicCharacterPack(pack);
    assert.equal(view.key, key); assert(view.sources.length); assert(view.claims.some(claim => claim.kind === 'private-intrinsic'));
    assert.equal(view.proposedProfile, undefined);
  }
});

// Optional local qualification, never a prerequisite for clean-checkout tests.
// Missing/stale evidence is a failure when deliberately requested, not a skip.
if (process.env.CYBERPUNK_INTRINSIC_SOURCE_CHECK === '1') {
  test('local adopted public claims match every recorded native byte hash and exact typed pointer', () => {
    const root = fileURLToPath(new URL('../', import.meta.url));
    const roster = JSON.parse(readFileSync(new URL('../characters/roster.json', import.meta.url), 'utf8'));
    const packs = ['jackie-welles', 'johnny-silverhand'].map(key => JSON.parse(readFileSync(
      new URL(`../research/cyberpunk/native-character-claims/${key}.json`, import.meta.url), 'utf8')));
    const result = compileIntrinsicCharacterPacks(packs, {roster, root});
    for (const view of result) {
      assert(view.claims.length > 0, view.key); assert(view.referencesVerified > 0, view.key);
      assert(view.claims.every(claim => !['private-intrinsic', 'conditional'].includes(claim.kind)));
      assert(intrinsicProfileMaterial(view).backstory.length < 6700);
    }
  });
}
