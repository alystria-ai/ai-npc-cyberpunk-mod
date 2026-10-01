import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync, readdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {buildProfiles} from '../research/cyberpunk/scripts/build_research.mjs';
import {compileIntrinsicCharacterPacks, intrinsicProfileMaterial, normalizeIntrinsicCharacterPack,
  adoptedIntrinsicKeys, requireAdoptedIntrinsicPacks, requireAdoptedIntrinsicMaterial,
  REVIEWED_INTRINSIC_SUBJECT_BINDINGS, REVIEWED_HELD_IDENTITY_BINDINGS, verifyIntrinsicAttribution,
  verifyReviewedLivePropertyEvidence, resolveIntrinsicActorRecord}
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

// Structural fixtures use the validator, not the compiler's authenticated-view
// constructor. Separate compiler tests above/below enforce actual byte hashes.
function contactAttributionFixture(key = 'jim-jarry', witness = false) {
  const ledger = REVIEWED_INTRINSIC_SUBJECT_BINDINGS[key];
  const identity = ledger.subjectQualifications[0], binding = witness ? ledger.witnesses[0] : ledger.actors[0];
  const documents = {journal: {}, title: {}, scene: {}, subtitle: {}};
  function put(sourceId, pointer, value) {
    const parts = pointer.slice(1).split('/'); let node = documents[sourceId];
    for (const part of parts.slice(0, -1)) node = node[part] ??= {};
    node[parts.at(-1)] = value;
  }
  const subjectPointer = identity.subjectPointer.slice(0, -3);
  const subject = {$type: 'gameJournalContact', id: ledger.id, name: {value: 'LocKey#12345'}};
  const title = {$type: 'localizationPersistenceOnScreenEntry', primaryKey: '12345', femaleVariant: ledger.titles[0]};
  const actor = {$type: 'scnActorDef', actorName: binding.name, actorId: {id: 0}, voicetagId: {id: binding.voice},
    acquisitionPlan: 'findInContext', findActorInContextParams: {specRecordId: {$type: 'TweakDBID', $storage: 'string', $value: 'Character.jim_jarry'}}};
  const line = {$type: 'scnscreenplayDialogLine', speaker: {id: 0}, itemId: {id: 1}, locstringId: {ruid: '98765'}};
  const event = {$type: 'scnDialogLineEvent', screenplayLineId: {id: 1}};
  const descriptor = {$type: 'scnlocLocStoreEmbeddedVariantDescriptorEntry', localeId: 'en_us',
    locstringId: {ruid: '98765'}, variantId: {ruid: '76543'}, vpeIndex: 0};
  const payload = {$type: 'scnlocLocStoreEmbeddedVariantPayloadEntry', variantId: {ruid: '76543'}, content: 'Reviewed speech.'};
  const subtitle = {$type: 'localizationPersistenceSubtitleEntry', stringId: '98765', femaleVariant: 'Reviewed speech.'};
  put('journal', subjectPointer, subject); put('title', identity.primaryKeyPointer.slice(0, -11), title);
  put('scene', binding.qualification.actorPointer, actor); put('scene', binding.qualification.linePointer, line);
  put('scene', binding.qualification.eventPointer, event);
  put('scene', '/Data/RootChunk/locStore/vdEntries/0', descriptor);
  put('scene', '/Data/RootChunk/locStore/vpEntries/0', payload);
  put('subtitle', '/Data/RootChunk/root/Data/entries/0', subtitle);
  const profile = {key, name: ledger.titles[0], records: ['Character.jim_jarry']};
  const pack = {key, sources: [
    {id: 'journal', ...identity.subject}, {id: 'title', ...identity.localization},
    {id: 'scene', ...binding.qualification}, {id: 'subtitle', depotPath: 'base\\localization\\en-us\\subtitles\\fixture.json'}]};
  const ref = (sourceId, jsonPointer, expectedValue) => ({sourceId, jsonPointer, expectedValue});
  const speaker = {sourceId: 'scene', actorPointer: binding.qualification.actorPointer,
    linePointer: binding.qualification.linePointer, eventPointer: binding.qualification.eventPointer,
    expectedVoicetag: binding.voice};
  const claim = {id: 'public.media', kind: 'intrinsic', nativeRefs: [
    ref('journal', identity.subjectPointer, ledger.id), ref('journal', identity.titlePointer, subject.name.value),
    ref('title', identity.primaryKeyPointer, title.primaryKey), ref('title', identity.variantPointer, title.femaleVariant),
    ref('scene', speaker.actorPointer, actor), ref('scene', speaker.linePointer, line), ref('scene', speaker.eventPointer, event),
    ref('scene', '/Data/RootChunk/locStore/vdEntries/0', descriptor), ref('scene', '/Data/RootChunk/locStore/vpEntries/0', payload),
    ref('subtitle', '/Data/RootChunk/root/Data/entries/0', subtitle)],
    attribution: {characterKey: key, mode: 'self-report', perspective: 'Attributed performed media only.',
      subjectRef: {kind: 'journal-contact', sourceId: 'journal', jsonPointer: identity.subjectPointer,
        expected: ledger.id, containerType: 'gameJournalContact'},
      subjectTitleRefs: [{sourceId: 'journal', jsonPointer: identity.titlePointer},
        {sourceId: 'title', jsonPointer: identity.primaryKeyPointer}, {sourceId: 'title', jsonPointer: identity.variantPointer}],
      speakers: [speaker]}};
  return {claim, pack, profile, subject, title, actor, line, event, descriptor, payload, subtitle, speaker, put, documents,
    verify: () => verifyIntrinsicAttribution(claim, pack, profile, id => documents[id])};
}

test('a genuine contact joins its exact localized name and emitted same-actor English speech', () => {
  const f = contactAttributionFixture(); assert.equal(f.verify().mode, 'self-report');
  assert.throws(() => intrinsicProfileMaterial(f.verify()), /Unverified public intrinsic view/);
  delete f.speaker.eventPointer;
  f.speaker.expectedSubjectVoicetag = f.speaker.expectedVoicetag; delete f.speaker.expectedVoicetag;
  assert.equal(f.verify().mode, 'self-report', 'exact cited events and legacy voice fields remain compatible');
});

test('contact identity cannot borrow Jim B, a codex type, another title or a different localization key', () => {
  for (const mutate of [
    f => { f.subject.id = 'jim'; f.claim.attribution.subjectRef.expected = 'jim'; },
    f => { f.subject.$type = 'gameJournalCodexEntry'; },
    f => { f.title.femaleVariant = 'Jim B'; },
    f => { f.title.primaryKey = '54321'; },
    f => { f.subject.name.value = 'Jim Jarry'; },
  ]) {
    const f = contactAttributionFixture(); mutate(f);
    assert.throws(f.verify, /subject identity mismatch|subject title mismatch|subject-to-title binding/);
  }
  const f = contactAttributionFixture(); f.pack.sources.find(s => s.id === 'title').jsonSha256 = '0'.repeat(64);
  assert.throws(f.verify, /subject title mismatch/, 'a self-asserted source digest is not the reviewed title receipt');
});

test('contact self-report requires the reviewed actor and voice in the reviewed scene', () => {
  for (const mutate of [
    f => { f.actor.actorName = 'announcer'; },
    f => { f.actor.voicetagId.id = '123'; f.speaker.expectedVoicetag = '123'; },
    f => { f.pack.sources.find(s => s.id === 'scene').jsonSha256 = '0'.repeat(64); },
  ]) {
    const f = contactAttributionFixture(); mutate(f);
    assert.throws(f.verify, /another character cannot become a self-report|unreviewed emitted actor receipt/);
  }
  const f = contactAttributionFixture(); f.line.speaker.id = 9;
  assert.throws(f.verify, /typed actor-to-screenplay speaker mismatch/);
});

test('a reviewed third-party witness remains distinct from the contact subject', () => {
  const f = contactAttributionFixture('rachel-casich', true);
  assert.throws(f.verify, /another character cannot become a self-report/);
  f.claim.attribution.mode = 'third-party-report';
  assert.throws(f.verify, /missing attributed third-party subject connection/);
  f.claim.attribution.subjectConnection = 'The presenter explicitly identifies Rachel and attributes the credits to her.';
  assert.equal(f.verify().mode, 'third-party-report');
});

test('unused lines, choice events and missing recorded fields cannot qualify as spoken evidence', () => {
  for (const mutate of [
    f => { f.event.screenplayLineId.id = 2; },
    f => { f.event.$type = 'scnChoiceEvent'; },
    f => { f.claim.nativeRefs = f.claim.nativeRefs.filter(r => r.jsonPointer !== f.speaker.eventPointer); },
  ]) {
    const f = contactAttributionFixture(); mutate(f);
    assert.throws(f.verify, /missing recorded emitted dialog event/);
  }
  const f = contactAttributionFixture(); f.claim.nativeRefs = f.claim.nativeRefs.filter(r => r.jsonPointer !== f.speaker.actorPointer);
  assert.throws(f.verify, /speaker join lacks exact recorded native field/);
});

test('new speech keeps its same-ID English descriptor, payload and shipped subtitle references', () => {
  for (const mutate of [
    f => { f.descriptor.localeId = 'fr_fr'; },
    f => { f.descriptor.locstringId.ruid = '54321'; },
    f => { f.descriptor.vpeIndex = 99; },
    f => { f.payload.variantId.ruid = '999'; },
    f => { f.subtitle.stringId = '999'; },
  ]) {
    const f = contactAttributionFixture(); mutate(f);
    assert.throws(f.verify, /same-line English descriptor and payload|same-ID shipped English subtitle/);
  }
});

test('canonical record identity uses only the active same-actor typed acquisition field', () => {
  const record = 'Character.mq015_seller', pointer = '/Data/RootChunk/actors/0';
  const actor = {$type: 'scnActorDef', acquisitionPlan: 'findInContext',
    findActorInContextParams: {specRecordId: {$type: 'TweakDBID', $storage: 'string', $value: record}},
    spawnDespawnParams: {specRecordId: {$type: 'TweakDBID', $storage: 'string', $value: record}}};
  const subject = {actorPointer: pointer, jsonPointer: pointer + '/findActorInContextParams/specRecordId',
    canonicalRecord: record, containerType: 'TweakDBID'};
  assert.equal(resolveIntrinsicActorRecord(actor, subject, [record]), record);
  actor.findActorInContextParams.specRecordId = {$type: 'TweakDBID', $storage: 'uint64', $value: '97740682400'};
  assert.equal(resolveIntrinsicActorRecord(actor, subject, [record]), record, 'verified CRC32 plus ASCII length');
  actor.findActorInContextParams.specRecordId.$value = String(97740682400n | (42n << 40n));
  assert.equal(resolveIntrinsicActorRecord(actor, subject, [record]), record, 'runtime offset bits preserve identity');
  for (const value of ['0', '97740682401']) {
    actor.findActorInContextParams.specRecordId.$value = value;
    assert.throws(() => resolveIntrinsicActorRecord(actor, subject, [record]), /zero, ambiguous or mismatched/);
  }
  actor.findActorInContextParams.specRecordId.$value = '97740682400';
  assert.throws(() => resolveIntrinsicActorRecord(actor, subject, [record, record]), /zero, ambiguous or mismatched/);
  actor.findActorInContextParams.specRecordId.$value = 97740682400;
  assert.throws(() => resolveIntrinsicActorRecord(actor, subject, [record]), /zero, ambiguous or mismatched/, 'uint64 storage never passes through rounded JSON numbers');
  actor.findActorInContextParams.specRecordId.$value = '97740682400';
  assert.throws(() => resolveIntrinsicActorRecord(actor, {...subject, jsonPointer: pointer + '/spawnDespawnParams/specRecordId'}, [record]), /active acquisition field/);
  for (const plan of ['spawnSet', 'findInWorld', 'community']) {
    actor.acquisitionPlan = plan;
    assert.throws(() => resolveIntrinsicActorRecord(actor, subject, [record]), /active acquisition field/);
  }
  actor.acquisitionPlan = 'spawnDespawn'; subject.jsonPointer = pointer + '/spawnDespawnParams/specRecordId';
  assert.equal(resolveIntrinsicActorRecord(actor, subject, [record]), record);
  actor.spawnDespawnParams.findInWorld = 1;
  assert.throws(() => resolveIntrinsicActorRecord(actor, subject, [record]), /active acquisition field/);
  actor.spawnDespawnParams.findInWorld = 0; actor.spawnDespawnParams.isEnabled = 0;
  assert.throws(() => resolveIntrinsicActorRecord(actor, subject, [record]), /active acquisition field/);
});

test('an active record cannot borrow another actor or use an unbound localization secondaryKey', () => {
  const f = contactAttributionFixture(), actorPointer = f.speaker.actorPointer;
  const recordPointer = actorPointer + '/findActorInContextParams/specRecordId';
  f.claim.attribution.subjectRef = {kind: 'actor-record', sourceId: 'scene', actorPointer, jsonPointer: recordPointer,
    canonicalRecord: 'Character.jim_jarry', containerType: 'TweakDBID'};
  assert.throws(f.verify, /missing reviewed record display-name property binding/);
  f.speaker.actorPointer = '/Data/RootChunk/actors/8';
  assert.throws(f.verify, /actor-record is not the recorded speaking actor/);
});

test('contact metadata and authored assurance cannot turn a document into native spoken evidence', () => {
  const f = contactAttributionFixture(); f.claim.attribution.mode = 'authored-document';
  f.claim.attribution.bindingVerified = true;
  assert.throws(f.verify, /missing reviewed document authorship/);
  f.claim.attribution.mode = 'native-codex'; f.claim.attribution.speakers = [];
  assert.throws(f.verify, /only a genuine codex can supply native-codex material/);
});

// These construct typed structural fixtures from the reviewed receipts, without
// producing compiler views or pretending that synthetic bytes are game assets.
function heldIdentityFixture(key, witness = false) {
  const ledger = REVIEWED_HELD_IDENTITY_BINDINGS[key];
  const receipt = ledger.identityQualification || ledger.authoredDocuments[0];
  const documents = {}, sources = structuredClone(receipt.sources);
  const get = (id, pointer) => pointer.slice(1).split('/').reduce((value, part) => value?.[part], documents[id]);
  function put(id, pointer, value) {
    const parts = pointer.slice(1).split('/'); let node = documents[id];
    for (const part of parts.slice(0, -1)) node = node[part] ??= {};
    node[parts.at(-1)] = structuredClone(value);
  }
  for (const source of sources) documents[source.id] = {Data: {RootChunk: {$type:
    source.depotPath.endsWith('.scene') ? 'scnSceneResource' : source.depotPath.endsWith('.journal') ? 'gameJournalResource' : 'JsonResource'}}};
  for (const ref of receipt.refs) {
    put(ref.sourceId, ref.jsonPointer, ref.expectedValue);
    const parent = /^(\/Data\/RootChunk\/root\/Data\/entries\/\d+)\//u.exec(ref.jsonPointer)?.[1];
    if (parent && !get(ref.sourceId, parent).$type) {
      const source = sources.find(s => s.id === ref.sourceId);
      put(ref.sourceId, `${parent}/$type`, source.depotPath.includes('\\subtitles\\')
        ? 'localizationPersistenceSubtitleEntry' : 'localizationPersistenceOnScreenEntry');
    }
  }
  const identity = ledger.subjectQualifications[0];
  const sourceFor = receipt => sources.find(s => s.assetSha256 === receipt.assetSha256 && s.jsonSha256 === receipt.jsonSha256).id;
  const journal = sourceFor(identity.subject), title = sourceFor(identity.localization);
  const proof = {characterKey: key, mode: key === '8ug8ear' ? 'authored-document' : witness ? 'third-party-report' : 'self-report',
    perspective: 'Reviewed source perspective; no shared player history.', speakers: [],
    subjectRef: {kind: 'journal-contact', sourceId: journal, jsonPointer: identity.subjectPointer,
      expected: ledger.id, containerType: 'gameJournalContact'},
    subjectTitleRefs: [{sourceId: journal, jsonPointer: identity.titlePointer},
      {sourceId: title, jsonPointer: identity.primaryKeyPointer}, {sourceId: title, jsonPointer: identity.variantPointer}]};
  let refs = structuredClone(receipt.refs), speaker;
  if (key === '8ug8ear') {
    proof.documentRef = {...receipt.documentRef, sourceId: journal, author: receipt.author};
    proof.authorshipRefs = [{sourceId: journal, jsonPointer: receipt.documentRef.titlePointer},
      {sourceId: title, jsonPointer: receipt.titlePointer.replace(/femaleVariant$/u, 'primaryKey')},
      {sourceId: title, jsonPointer: receipt.titlePointer}];
  } else {
    proof.identityProof = {kind: receipt.kind, reviewId: receipt.reviewId};
    const bindings = witness ? ledger.witnesses : ledger.actors;
    speaker = receipt.lines.find(line => bindings.some(binding => binding.qualification.actorPointer === line.actorPointer
      && sourceFor(binding.qualification) === line.sourceId));
    if (!speaker) {
      // Role proof does not contain dialogue. The synthetic speech tests the
      // independent claim-speaker gate while the real role route stays exact.
      const binding = bindings[0], sourceId = sourceFor(binding.qualification);
      speaker = {sourceId, actorPointer: binding.qualification.actorPointer, linePointer: '/Data/RootChunk/screenplayStore/lines/900',
        eventPointer: '/Data/RootChunk/sceneGraph/Data/graph/900/Data/events/0/Data', expectedVoicetag: binding.voice};
      const actor = get(sourceId, speaker.actorPointer), items = [
        [speaker.linePointer, {$type: 'scnscreenplayDialogLine', speaker: {id: actor.actorId.id}, itemId: {id: 900}, locstringId: {ruid: '900'}}],
        [speaker.eventPointer, {$type: 'scnDialogLineEvent', screenplayLineId: {id: 900}}],
        ['/Data/RootChunk/locStore/vdEntries/900', {$type: 'scnlocLocStoreEmbeddedVariantDescriptorEntry', localeId: 'en_us', locstringId: {ruid: '900'}, variantId: {ruid: '901'}, vpeIndex: 900}],
        ['/Data/RootChunk/locStore/vpEntries/900', {$type: 'scnlocLocStoreEmbeddedVariantPayloadEntry', variantId: {ruid: '901'}, content: 'Structural role speech.'}],
      ];
      for (const [pointer, value] of items) { put(sourceId, pointer, value); refs.push({sourceId, jsonPointer: pointer, expectedValue: value}); }
      sources.push({id: 'test-subtitle', depotPath: 'base\\localization\\en-us\\subtitles\\role.json'});
      documents['test-subtitle'] = {Data: {RootChunk: {$type: 'JsonResource'}}};
      const subtitle = {$type: 'localizationPersistenceSubtitleEntry', stringId: '900', femaleVariant: 'Structural role speech.'};
      put('test-subtitle', '/Data/RootChunk/root/Data/entries/0', subtitle);
      refs.push({sourceId: 'test-subtitle', jsonPointer: '/Data/RootChunk/root/Data/entries/0', expectedValue: subtitle});
    }
    proof.speakers = [structuredClone(speaker)];
    if (witness) proof.subjectConnection = 'The separately reviewed witness names the subject.';
    refs = refs.filter(ref => !ref.jsonPointer.includes('/screenplayStore/lines/') || ref.sourceId === speaker.sourceId
      && (ref.jsonPointer === speaker.linePointer || ref.jsonPointer.startsWith(speaker.linePointer + '/')));
  }
  const claim = {id: 'reviewed.public', kind: 'intrinsic', attribution: proof, nativeRefs: refs};
  const pack = {key, sources}, profile = {key, name: ledger.titles[0], records: []};
  return {ledger, receipt, documents, pack, profile, claim, proof, speaker, get, put,
    verify: () => verifyIntrinsicAttribution(claim, pack, profile, id => documents[id])};
}

test('the exact signed typed essay qualifies written perspective without inventing spoken evidence', () => {
  const f = heldIdentityFixture('8ug8ear'), result = f.verify();
  assert.equal(result.mode, 'authored-document'); assert.equal(result.identity.author, '8ug8ear');
  assert.equal(result.identity.evidenceKind, 'signed-native-document');
  assert.throws(() => intrinsicProfileMaterial(result), /Unverified public intrinsic view/);
  f.proof.mode = 'self-report'; assert.throws(f.verify, /missing native speaker binding/);
});

test('a forged signature, different document author or title cannot borrow the signed essay', () => {
  for (const mutate of [
    f => { const ref = f.receipt.refs.find(r => r.jsonPointer === f.receipt.titlePointer); f.put(ref.sourceId, ref.jsonPointer, 'Blaming Bartmoss – by Someone Else'); },
    f => { f.proof.documentRef.author = 'Someone Else'; },
    f => { f.proof.documentRef.expectedId = 'unrelated_document'; },
    f => { f.put(f.proof.documentRef.sourceId, f.proof.documentRef.titlePointer, 'LocKey#7269'); },
    f => { f.put(f.proof.documentRef.sourceId, f.proof.documentRef.jsonPointer + '/$type', 'gameJournalCodexEntry'); },
    f => { f.proof.authorshipRefs = []; },
    f => { f.claim.nativeRefs = f.claim.nativeRefs.filter(r => r.jsonPointer !== f.receipt.contentPointer); },
  ]) {
    const f = heldIdentityFixture('8ug8ear'); mutate(f);
    assert.throws(f.verify, /reviewed identity field mismatch|reviewed document authorship|document title, author|signed title authorship/);
  }
});

test('five source-specific narrative aliases preserve their named speaker evidence and world holds', () => {
  for (const key of ['coach-fred', 'pepe-najarro', 'cynthia-najarro', 'dennis-cranmer', 'liam-northom']) {
    const f = heldIdentityFixture(key), result = f.verify();
    assert.equal(result.mode, 'self-report', key); assert.equal(result.identity.worldRegistryBindingVerified, false, key);
    assert(result.identity.reviewId.includes(key));
    delete f.proof.identityProof;
    assert.throws(f.verify, /missing explicit reviewed identity proof/);
  }
  assert.match(REVIEWED_HELD_IDENTITY_BINDINGS['dennis-cranmer'].identityQualification.limits, /third person|contextual/iu);
  assert.equal(REVIEWED_HELD_IDENTITY_BINDINGS['jake-estevez'], undefined);
});

test('narrative identity rejects another actor, event, English text, source revision or contact title', () => {
  for (const mutate of [
    f => { f.put(f.speaker.sourceId, f.speaker.actorPointer + '/actorName', 'Another Person'); },
    f => { f.put(f.speaker.sourceId, f.speaker.actorPointer + '/voicetagId/id', '999'); },
    f => { f.put(f.speaker.sourceId, f.speaker.linePointer + '/speaker/id', 999); },
    f => { f.put(f.speaker.sourceId, f.speaker.eventPointer + '/screenplayLineId/id', 999); },
    f => { f.put(f.speaker.sourceId, f.speaker.eventPointer + '/$type', 'scnChoiceEvent'); },
    f => { const ref = f.receipt.refs.find(r => r.jsonPointer.includes('/vpEntries/')); f.put(ref.sourceId, ref.jsonPointer + '/content', 'Another name.'); },
    f => { f.pack.sources.find(s => s.id === f.speaker.sourceId).jsonSha256 = '0'.repeat(64); },
    f => { const r = f.proof.subjectTitleRefs.at(-1); f.put(r.sourceId, r.jsonPointer, 'A different contact'); },
  ]) {
    const f = heldIdentityFixture('coach-fred'); mutate(f);
    assert.throws(f.verify, /reviewed identity field mismatch|exact reviewed identity source|native subject title mismatch/);
  }
});

test("Lizzy's full-name testimony stays separate from Liam's self-report", () => {
  const f = heldIdentityFixture('liam-northom', true);
  assert.equal(f.verify().mode, 'third-party-report');
  f.proof.mode = 'self-report'; assert.throws(f.verify, /another character cannot become a self-report/);
});

test('Life Coach requires the same actor initializer and typed caller contact, with role-only scope', () => {
  const f = heldIdentityFixture('life-coach'), result = f.verify();
  assert.equal(result.identity.evidenceKind, 'same-actor-holocall-initializer-to-typed-contact');
  assert.match(result.identity.limits, /No legal name/); assert.equal(result.identity.worldRegistryBindingVerified, false);
  for (const mutate of [
    f => { const ref = f.receipt.refs.find(r => r.jsonPointer.endsWith('/holocallInitScn')); f.put(ref.sourceId, ref.jsonPointer + '/DepotPath/$value', 'base\\other.scene'); },
    f => { const ref = f.receipt.refs.find(r => r.expectedValue?.$type === 'questCallContact_NodeType'); f.put(ref.sourceId, ref.jsonPointer + '/caller/Data/realPath', 'contacts/another'); },
    f => { const ref = f.proof.subjectTitleRefs.at(-1); f.put(ref.sourceId, ref.jsonPointer, 'Brian Gustav'); },
  ]) { const changed = heldIdentityFixture('life-coach'); mutate(changed); assert.throws(changed.verify, /identity field mismatch|subject title mismatch/); }
});

function livePropertyFixture() {
  // Small byte fixtures exercise runtime provenance validation. The compiler
  // itself obtains its immutable receipt exclusively from the reviewed ledger.
  const receipt = structuredClone(REVIEWED_HELD_IDENTITY_BINDINGS.r3n0.recordBindings[0].propertyQualification);
  const probe = {recordExists: true, properties: structuredClone(receipt.properties), record: receipt.record,
    capturedAt: receipt.capturedAt, gameVersion: receipt.gameVersion,
    nativeRecordId: 'ToTweakDBID{ hash = 0xC1CC74A0, length = 22 --[[ Character.mq015_seller --]] }', version: 1, readOnly: true};
  const artifact = {querySnapshotRaw: Buffer.from('read-only query fixture'), installedFiles: receipt.installedTweakdbFiles.map(file =>
    ({absolutePath: file.absolutePath, raw: Buffer.from('installed fixture ' + file.name)}))};
  receipt.querySnapshotSha256 = hash(artifact.querySnapshotRaw);
  receipt.installedTweakdbFiles.forEach((file, index) => { file.bytes = artifact.installedFiles[index].raw.length; file.sha256 = hash(artifact.installedFiles[index].raw); });
  artifact.installedReceiptRaw = Buffer.from(JSON.stringify(receipt.installedTweakdbFiles.map(({name, bytes, sha256}) => ({name, bytes, sha256}))));
  receipt.installedReceiptSha256 = hash(artifact.installedReceiptRaw);
  const review = {evidenceKind: 'live-read-only-TweakDB-property-probe', installedReceiptSha256: receipt.installedReceiptSha256,
    queryCode: {snapshotSha256: receipt.querySnapshotSha256}, probe};
  function serialize() {
    artifact.probeRaw = Buffer.from(JSON.stringify(probe)); receipt.probeSha256 = hash(artifact.probeRaw); review.probeSha256 = receipt.probeSha256;
    artifact.reviewRaw = Buffer.from(JSON.stringify(review)); receipt.reviewSha256 = hash(artifact.reviewRaw);
  }
  serialize(); return {receipt, artifact, probe, review, serialize, verify: () => verifyReviewedLivePropertyEvidence(receipt, artifact)};
}

test('reviewed live record properties retain runtime provenance and reject a wrong flat or stale TweakDB receipt', () => {
  assert.equal(livePropertyFixture().verify().properties.displayName.localized, 'R3N0');
  for (const mutate of [
    f => { f.artifact.probeRaw = Buffer.from('{}'); },
    f => { f.artifact.querySnapshotRaw = Buffer.from('changed query'); },
    f => { f.artifact.installedReceiptRaw = Buffer.from('[]'); },
    f => { f.artifact.installedFiles[0].raw = Buffer.from('stale installed file'); },
    f => { f.probe.properties.displayName.query = "TweakDB:GetFlat('Character.other.displayName')"; f.serialize(); },
    f => { f.probe.readOnly = false; f.serialize(); },
    f => { f.probe.nativeRecordId = 'ToTweakDBID{ hash = 0x12345678, length = 22 }'; f.serialize(); },
    f => { f.review.evidenceKind = 'native-cr2w-serialization'; f.serialize(); },
  ]) { const f = livePropertyFixture(); mutate(f); assert.throws(f.verify, /hash mismatch|stale installed TweakDB|provenance mismatch|record ID mismatch/); }
});

test('a live property declaration cannot bypass the speaking actor or exact flat proof', () => {
  const f = contactAttributionFixture(), ledger = REVIEWED_HELD_IDENTITY_BINDINGS.r3n0, binding = ledger.recordBindings[0];
  f.pack.key = f.profile.key = f.claim.attribution.characterKey = 'r3n0'; f.profile.records = [binding.record];
  f.actor.actorName = 'Seller'; f.actor.voicetagId.id = f.speaker.expectedVoicetag = ledger.actors[0].voice;
  f.actor.findActorInContextParams.specRecordId.$value = binding.record;
  Object.assign(f.pack.sources.find(s => s.id === 'scene'), ledger.actors[0].qualification);
  Object.assign(f.pack.sources.find(s => s.id === 'title'), binding.localizationQualification);
  const pointer = '/Data/RootChunk/root/Data/entries/20789';
  const title = {$type: 'localizationPersistenceOnScreenEntry', primaryKey: binding.primaryKey,
    secondaryKey: binding.secondaryKey, femaleVariant: 'R3N0'};
  f.put('title', pointer, title); f.claim.nativeRefs.push({sourceId: 'title', jsonPointer: pointer, expectedValue: title});
  f.claim.attribution.subjectRef = {kind: 'actor-record', sourceId: 'scene', actorPointer: f.speaker.actorPointer,
    jsonPointer: f.speaker.actorPointer + '/findActorInContextParams/specRecordId', canonicalRecord: binding.record, containerType: 'TweakDBID'};
  f.claim.attribution.recordDisplayNameRefs = ['primaryKey', 'secondaryKey', 'femaleVariant'].map(field => ({sourceId: 'title', jsonPointer: `${pointer}/${field}`}));
  const proof = f.claim.attribution.recordDisplayNameBinding = {kind: 'reviewed-live-property', reviewId: binding.propertyQualification.reviewId,
    record: binding.record, flat: 'displayName', jsonPointer: '/properties/displayName'};
  const verify = () => verifyIntrinsicAttribution(f.claim, f.pack, f.profile, id => f.documents[id], () => ({properties: binding.propertyQualification.properties}));
  assert.equal(verify().identity.evidenceKind, 'live-read-only-TweakDB-property-probe');
  proof.flat = 'unrelated'; assert.throws(verify, /missing reviewed live-property provenance/); proof.flat = 'displayName';
  proof.kind = 'native-property'; assert.throws(verify, /missing reviewed live-property provenance/); proof.kind = 'reviewed-live-property';
  f.actor.acquisitionPlan = 'community'; assert.throws(verify, /active acquisition field/);
});

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

if (process.env.CYBERPUNK_WAVE3_SOURCE_CHECK === '1') {
  test('eight resolved identity candidates authenticate their current sources while privacy and world holds remain', () => {
    const root = fileURLToPath(new URL('../', import.meta.url));
    const read = path => JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), 'utf8').replace(/^\uFEFF/u, ''));
    const roster = read('characters/roster.json');
    const expected = {'8ug8ear': [4, 6], 'coach-fred': [6, 6], 'pepe-najarro': [4, 3], 'cynthia-najarro': [3, 3],
      'dennis-cranmer': [5, 4], 'liam-northom': [3, 3], 'life-coach': [3, 3], r3n0: [3, 3], 'jake-estevez': [0, 0]};
    const packs = Object.keys(expected).map(key => read(`research/cyberpunk/native-character-proposals-wave3/${key}.json`));
    const views = compileIntrinsicCharacterPacks(packs, {roster, root});
    for (const view of views) {
      assert.deepEqual([view.claims.length, view.samples.length], expected[view.key], view.key);
      assert(view.claims.every(claim => !/^(?:private\.|conditional\.|held\.)/u.test(claim.id)), view.key);
      assert(view.claims.every(claim => claim.attribution.identity.worldRegistryBindingVerified === false), view.key);
    }
    const reno = views.find(view => view.key === 'r3n0');
    assert(reno.sources.some(source => source.kind === 'live-read-only-TweakDB-property-probe'));
    assert.equal(reno.policy, 'recorded-native-and-reviewed-live-property-public-only');
    assert(reno.rejected.some(claim => claim.id === 'held.defensive-sale'));
    assert(views.find(view => view.key === 'cynthia-najarro').rejected.some(claim => claim.id === 'private.appearance-history'));
    assert(views.find(view => view.key === 'dennis-cranmer').rejected.some(claim => claim.id === 'private.haruyoshi-account'));
    assert(views.find(view => view.key === 'liam-northom').rejected.some(claim => claim.id === 'private.backup-and-alteration-proposal'));
    assert(views.find(view => view.key === 'life-coach').rejected.some(claim => claim.id === 'conditional.previous-v-session'));
  });

  test('all 19 previously adopted public payloads remain byte-identical to the saved baseline', () => {
    const root = fileURLToPath(new URL('../', import.meta.url));
    const read = path => JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), 'utf8').replace(/^\uFEFF/u, ''));
    const baseline = read('runtime/verification/wave3-legacy-baseline.json'), keys = Object.keys(baseline);
    assert.equal(keys.length, 19);
    const roster = read('characters/roster.json');
    const dossiers = readdirSync(new URL('../research/cyberpunk/dossiers/', import.meta.url))
      .filter(file => file.endsWith('.json')).map(file => read(`research/cyberpunk/dossiers/${file}`));
    const intrinsicPacks = keys.map(key => read(`research/cyberpunk/native-character-claims/${key}.json`));
    const profiles = buildProfiles(roster, dossiers, {intrinsicPacks, intrinsicRoot: root});
    for (const key of keys) {
      const profile = profiles.find(item => item.key === key);
      for (const field of ['backstory', 'speakingStyleDescription', 'speakingStyleSampleDialogues']) {
        assert.equal(profile[field], baseline[key][field], `${key}/${field}`);
      }
    }
  });
}
