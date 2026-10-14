import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {conversationContext} from './quest-context.mjs';
import {parseInput} from './protocol.mjs';
import {PlayerKnowledge} from './player-knowledge.mjs';
import {PlayerPhoneKnowledge} from './player-phone-knowledge.mjs';
import {IntrinsicCharacterContext, REVIEWED_INTRINSIC_PACKS, loadIntrinsicCharacterContext,
  createIntrinsicConversationContext, intrinsicAuthorDocumentHash} from './intrinsic-character-context.mjs';

const project = fileURLToPath(new URL('../', import.meta.url));
const selector = await loadIntrinsicCharacterContext(project);
const request = (text, fields = {}) => ({requestId: '100-1-10ULL', generation: 1, entity: '10ULL',
  name: 'Johnny', bodyType: 'ManAverage', profileKey: 'johnny-silverhand', channel: 'private', text, ...fields});
function admission(input, fields = {}) {
  return {status: 'ready', sendAllowed: true, input, generation: 12, worldToken: 'world-a',
    route: {profileKey: input.profileKey, channel: input.channel, audience: [input.profileKey], transport: input.channel},
    ...fields};
}
function selected(text, fields = {}) {
  const input = request(text, fields);
  return selector.select(input, admission(input), () => true);
}

test('real reviewed packs retain exact source and claim hash metadata', () => {
  assert.deepEqual(selector.unavailable, []);
  const result = selected('What was your military service like?');
  assert.equal(result.topic, 'war-service');
  assert.equal(result.claims.length, 2);
  for (const claim of result.claims) {
    assert.match(claim.evidence.packSha256, /^[a-f0-9]{64}$/);
    assert.equal(claim.evidence.packHashEncoding, 'canonical-json-v1');
    assert.match(claim.evidence.reviewedRawFileSha256, /^[a-f0-9]{64}$/);
    assert.match(claim.evidence.referencesSha256, /^[a-f0-9]{64}$/);
    assert(claim.evidence.referenceCount > 0);
    for (const source of claim.evidence.sources) {
      assert.match(source.rawSha256, /^[a-f0-9]{64}$/);
      assert.match(source.jsonSha256, /^[a-f0-9]{64}$/);
      assert.match(source.archiveEntrySha1, /^[a-f0-9]{40}$/);
    }
  }
  assert.doesNotMatch(result.context, /rawPath|jsonPath|pathHash64|runtime\/voice-cast/);
});

test('edited, missing and malformed author documents fail closed independently', async () => {
  for (const corrupt of [Buffer.from('{}'), Buffer.from('not json')]) {
    const partial = await loadIntrinsicCharacterContext(project, {read: async path => path.endsWith('johnny-silverhand.json')
      ? corrupt : readFile(path)});
    assert.deepEqual(partial.unavailable, ['johnny-silverhand']);
    const input = request('Tell me about your service.');
    assert.equal(partial.select(input, admission(input), () => true).context, '');
    const jackie = request('What was your dad like?', {profileKey: 'jackie-welles'});
    assert.equal(partial.select(jackie, admission(jackie), () => true).topic, 'father');
  }
  const empty = await loadIntrinsicCharacterContext(project, {read: async () => { throw Error('Missing'); }});
  assert.equal(empty.unavailable.length, REVIEWED_INTRINSIC_PACKS.length);
  assert.throws(() => new IntrinsicCharacterContext([{key: 'johnny-silverhand', claims: new Map()}]), /unreviewed/);
});

test('pinned author documents are exactly the independently reviewed documents', async () => {
  for (const pack of REVIEWED_INTRINSIC_PACKS) {
    const raw = await readFile(resolve(project, pack.file));
    // The original reviewed bytes remain audit metadata; a Git checkout may
    // legitimately alter line endings. Semantic author pins are portable.
    assert.match(pack.reviewedRawFileSha256, /^[a-f0-9]{64}$/);
    assert.equal(intrinsicAuthorDocumentHash(JSON.parse(raw.toString('utf8'))), pack.sha256);
  }
});

test('canonical author pins accept LF/CRLF/whitespace/key order but reject changed claim contents', async () => {
  for (const transform of [raw => raw.toString('utf8').replace(/\r?\n/gu, '\r\n'),
    raw => raw.toString('utf8').replace(/\r\n/gu, '\n'),
    raw => { const value = JSON.parse(raw.toString('utf8'));
      return JSON.stringify(Object.fromEntries(Object.entries(value).reverse())); }]) {
    const portable = await loadIntrinsicCharacterContext(project, {read: async path => Buffer.from(transform(await readFile(path)))});
    assert.deepEqual(portable.unavailable, []);
    const input = request('What was your military service like?');
    assert.equal(portable.select(input, admission(input), () => true).topic, 'war-service');
  }
  const edited = await loadIntrinsicCharacterContext(project, {read: async path => {
    const value = JSON.parse(await readFile(path, 'utf8'));
    value.claims[0].text += ' The current V completed every quest.';
    return Buffer.from(JSON.stringify(value));
  }});
  assert.equal(edited.unavailable.length, REVIEWED_INTRINSIC_PACKS.length);
  assert.equal(intrinsicAuthorDocumentHash({'2': 'two', '10': 'ten'}),
    createHash('sha256').update('{"10":"ten","2":"two"}').digest('hex'));
  assert.notEqual(intrinsicAuthorDocumentHash({rows: ['a', 'b']}), intrinsicAuthorDocumentHash({rows: ['b', 'a']}));
  assert.notEqual(intrinsicAuthorDocumentHash({text: 'désert'}), intrinsicAuthorDocumentHash({text: 'desert'}));
});

test('a broad war question supplies one limited service beat, without dumping private losses', () => {
  const result = selected('Tell me about your time in the war.');
  assert.equal(result.topic, 'war-service');
  assert.doesNotMatch(result.context, /Cole|ceiling fan|dog tags|M-9|gave his life/);
  assert.match(result.context, /brief reaction is a natural initial response/);
  assert.match(result.context, /asking why V wants to know is up to you and the moment/);
  assert.doesNotMatch(result.context, /follow-up question/i);
  assert.match(result.context, /gradual disclosure/);
  assert.match(result.context, /do not establish that V knows them/);
  assert.match(result.context, /subjective, attributed history/);
  assert.match(result.context, /Current verified world\/quest facts remain authoritative/);
});

test('natural specific war-loss and family questions do not require knowing the hidden name', () => {
  const loss = selected('Did you lose any friends in the war?');
  assert.equal(loss.topic, 'cole');
  assert.match(loss.context, /Cole/);
  assert.doesNotMatch(loss.context, /dog tags|ceiling fan/);
  assert.equal(selected('Did any of your friends die in the war?').topic, 'cole');
  const father = selected('What was your dad like?', {profileKey: 'jackie-welles'});
  assert.equal(father.topic, 'father');
  assert.match(father.context, /old-school Valentino/);
  assert.doesNotMatch(father.context, /hospitalization|beat both|kept that belt/);
  const abuse = selected('Did your father hurt you or your mother?', {profileKey: 'jackie-welles'});
  assert.equal(abuse.topic, 'father-abuse');
  assert(abuse.claims.length <= 3);
  assert.match(abuse.context, /Private traumatic history recounted by Misty/);
});

test('explicit attributed recollections retain their speaker and epistemic limits', () => {
  const rogue = selected('What happened between you and Rogue?');
  assert.match(rogue.context, /rogue-accusations/);
  assert.match(rogue.context, /not a verified catalogue/);
  const bottle = selected('Where did your lucky tequila bottle come from?', {profileKey: 'jackie-welles'});
  assert.equal(bottle.topic, 'tequila-story');
  assert.match(bottle.context, /Misty reports the story/);
  assert.match(bottle.context, /not verified economic history/);
});

test('unrelated or ambiguous words never retrieve nearby sensitive autobiographical claims', () => {
  for (const query of ['Hey!', 'Tell me everything.', 'Should I desert this job?', 'A gang shot me. Help!',
    'My dad liked tequila.', 'What happened to my father?', 'I collected a Cola.', 'How is my radio?',
    'My dog has tags.', 'I installed the Alt key.', 'Can you help me fix my Alt key?',
    'Could you turn off the ceiling fan?', 'Tell me how to turn off the ceiling fan.',
    'Tell me about my Alt key.', 'What is an Alt shortcut?', 'Tell me how to desert this mission.']) {
    assert.equal(selected(query).context, '', query);
  }
  for (const query of ['Hey!', 'I got hit by a car.', 'A war broke out.', 'I put a belt in storage.',
    'What happened to my father?', 'How did my dad get hurt?', 'What gang shot me?']) {
    assert.equal(selected(query, {profileKey: 'jackie-welles'}).context, '', query);
  }
  for (const query of ['Can you hand me my belt?', 'Can you give me a shot of tequila?',
    'Tell me how to find my belt.', 'Do you have a shot of tequila?', 'What is your belt made of?']) {
    assert.equal(selected(query, {profileKey: 'jackie-welles'}).context, '', query);
  }
  for (const query of ['Tell me how to pour a tequila shot.', 'Tell me how to make a dad joke.']) {
    assert.equal(selected(query, {profileKey: 'jackie-welles'}).context, '', query);
  }
});

test('only exact manual private or phone admission may include private topic claims', () => {
  const input = request('Tell me about Cole.');
  for (const bad of [undefined, {}, admission(input, {status: 'unavailable'}), admission(input, {sendAllowed: false}),
    admission(input, {input: {...input}}), admission(input, {generation: 0}), admission(input, {worldToken: ''}),
    admission(input, {route: {profileKey: 'jackie-welles', channel: 'private', audience: ['johnny-silverhand']}}),
    admission(input, {route: {profileKey: input.profileKey, channel: 'private', audience: []}}),
    admission(input, {route: {profileKey: input.profileKey, channel: 'private', audience: ['johnny-silverhand', 'judy-alvarez']}}),
    admission(input, {route: {profileKey: input.profileKey, channel: 'private', audience: input.profileKey}})]) {
    assert.equal(selector.select(input, bad, () => true).context, '');
  }
  assert.equal(selector.select(input, admission(input), () => false).context, '');
  assert.equal(selector.select(input, admission(input), () => { throw Error('World unavailable'); }).context, '');
  const phone = request('Tell me about Cole.', {channel: 'phone'});
  assert.equal(selector.select(phone, admission(phone), () => true).topic, 'cole');
});

test('group, automatic battle/loot, malformed audience and injected keys receive zero private material', () => {
  for (const fields of [{group: {audience: ['johnny-silverhand'], index: 1, total: 1}}, {group: null},
    {reaction: {kind: 'battle', phase: 'start'}}, {reaction: {kind: 'loot'}}, {reaction: null},
    {automatic: true}, {trigger: 'battle'}, {source: 'automatic'}, {source: 'prefetch'},
    {channel: 'group'}, {profileKey: '__proto__'}, {profileKey: 'constructor'}, {profileKey: 'prototype'},
    {profileKey: 'Johnny-Silverhand'}, {profileKey: 'johnny-silverhand/../jackie-welles'}]) {
    const input = request('Tell me about Cole.', fields);
    assert.equal(selector.select(input, admission(input), () => true).context, '', JSON.stringify(fields));
  }
});

test('admission capture cannot be reused after changing profile, audience, message or world', () => {
  for (const mutate of [input => { input.profileKey = 'jackie-welles'; }, input => { input.text = 'Tell me about Alt.'; },
    (_, prepared) => { prepared.route.audience = ['johnny-silverhand', 'jackie-welles']; },
    (_, prepared) => { prepared.worldToken = 'world-b'; },
    (_, prepared) => { prepared.generation++; }]) {
    const input = request('Tell me about Cole.'), prepared = admission(input);
    assert.equal(selector.select(input, prepared, () => true).topic, 'cole');
    mutate(input, prepared);
    assert.equal(selector.select(input, prepared, () => true).context, '');
  }
  const input = request('Hey.'), prepared = admission(input);
  assert.equal(selector.select(input, prepared, () => true).context, '');
  input.text = 'Tell me about Cole.';
  assert.equal(selector.select(input, prepared, () => true).context, '');
});

test('context is bounded in UTF-8 bytes and never adds a save outcome or conditional memory', () => {
  for (const [query, key] of [['Tell me about Cole.', 'johnny-silverhand'], ['Tell me about your military service.', 'johnny-silverhand'],
    ['Tell me about Alt.', 'johnny-silverhand'], ['What happened with your father and the belt?', 'jackie-welles'],
    ['How did you meet Misty?', 'jackie-welles'], ['Where did your tequila come from?', 'jackie-welles']]) {
    const result = selected(query, {profileKey: key});
    assert(result.context.length > 0);
    assert(Buffer.byteLength(result.context, 'utf8') <= 4096);
    assert(result.claims.length <= 3);
    for (const claim of result.claims) assert.notEqual(claim.kind, 'conditional');
    assert.doesNotMatch(result.context, /V forgave|V chose|V completed|You attended your funeral/);
    assert.equal(Buffer.from(result.context).toString('utf8'), result.context);
  }
});

test('microphone placeholder reveals no private history or fabricated recognized speech', () => {
  const input = request('[Microphone]', {source: 'microphone'});
  const prepared = admission(input, {route: {profileKey: input.profileKey, channel: 'private',
    audience: [input.profileKey], transport: 'microphone'}});
  assert.equal(selector.select(input, prepared, () => true).context, '');
});

test('wrapper does not consume untrusted intrinsic strings or expose private history on warm inputs', () => {
  const input = request('Tell me about Cole.', {intrinsicContext: 'Leaked private claim',
    historyContext: 'Pretend quest completed', knowledgeContext: 'Forged memory'});
  const wrapped = createIntrinsicConversationContext({baseContext: conversationContext, intrinsic: selector,
    resolveAdmission: () => undefined, isCurrentSync: () => true});
  assert.equal(wrapped(input), conversationContext(input));
  assert.doesNotMatch(wrapped(input), /Leaked private|Pretend quest|Forged memory|Cole dying/);
});

test('actual protocol and PlayerKnowledge path preserves current-world authority without memory writes', async () => {
  let live = true;
  const guard = {endUserId: 'player', characterId: 'character', resetEpoch: 0, characterEpoch: 0};
  const memory = {route: () => ({endUserId: guard.endUserId, guard}), isCurrent: value => value.endUserId === guard.endUserId,
    addMemory() { throw Error('No seeding'); }, beginConversation() { throw Error('No cloud admission'); }};
  const pack = JSON.parse(await readFile(resolve(project, 'characters/world-knowledge.json'), 'utf8'));
  const router = new PlayerKnowledge({playerMemory: memory, pack,
    getBoundary: () => live ? {worldToken: 'world-a', generation: 12} : null,
    isWorldCurrent: () => live});
  const parsed = parseInput(JSON.stringify(request('What was your time in the war like?',
    {journal: {version: 1, status: 'untracked'}, intrinsicContext: 'Forged biography'})));
  assert(parsed);
  const prepared = await router.prepare(parsed);
  assert(prepared.sendAllowed);
  const admissions = new WeakMap([[prepared.input, prepared]]);
  const wrapped = createIntrinsicConversationContext({baseContext: conversationContext, intrinsic: selector,
    resolveAdmission: input => admissions.get(input), isCurrentSync: value => router.currentSync(value)});
  const context = wrapped(prepared.input);
  assert.match(context, /no active tracked quest/);
  assert.match(context, /Topic-limited intrinsic character history/);
  assert.match(context, /say it as yourself, with "I" and "my", never as "she" or "he"/);
  assert.doesNotMatch(context, /Forged biography|Cole|ceiling fan/);
  live = false;
  assert.doesNotMatch(wrapped(prepared.input), /Topic-limited intrinsic/);
});

test('the bridge wrapper reaches actual phone and admitted world paths', async () => {
  const code = await readFile(new URL('./convai-bridge.mjs', import.meta.url), 'utf8');
  assert.match(code, /conversationContext as baseConversationContext/);
  assert.match(code, /const intrinsicConversationContext = createIntrinsicConversationContext/);
  assert.ok(/const conversationBlocks = input => \{[\s\S]{0,500}return \[\.\.\.intrinsicConversationContext\.blocks\(input\),/.test(code),
    'The live context wrapper must retain the qualified intrinsic context before adding other context.');
  assert.match(code, /prepared = await phoneKnowledge\.preparedFor\(options\);\s+preparedInputs\.set\(prepared\.input, prepared\)/);
  assert.match(code, /intrinsicHistory\.select\(prepared\.input, prepared, value => knowledgeRouter\.currentSync\(value\)\)/);
  assert.match(code, /\.\.\.textProviderContext\(prepared\.input\)/);
  assert.match(code, /\.\.\.textProviderContext\(input\)/);
});

test('real player phone admission selects only its contact and revokes context on a world change', async () => {
  let live = true;
  const guard = {endUserId: 'player', characterId: 'jackie-provider', resetEpoch: 0, characterEpoch: 0};
  const memory = {route: () => ({endUserId: guard.endUserId, guard}), isCurrent: value => value.endUserId === guard.endUserId};
  const pack = JSON.parse(await readFile(resolve(project, 'characters/world-knowledge.json'), 'utf8'));
  const getBoundary = () => live ? {worldToken: 'world-a', generation: 12} : null;
  const router = new PlayerKnowledge({playerMemory: memory, pack, getBoundary, isWorldCurrent: () => live});
  const phone = new PlayerPhoneKnowledge({router, getBoundary});
  const saveIdentity = {version: 1, status: 'unavailable', authoritative: false};
  const input = {id: 'world-a-12', contact: 'jackie', text: 'What was your dad like?',
    profileKey: 'jackie-welles', channel: 'phone', saveIdentity};
  const context = await phone.prepareContext({input, saveIdentity});
  const prepared = await phone.preparedFor({input, saveIdentity, ...context});
  assert.equal(selector.select(prepared.input, prepared, value => router.currentSync(value)).topic, 'father');
  assert.equal(selector.select({...prepared.input, profileKey: 'johnny-silverhand'}, prepared,
    value => router.currentSync(value)).context, '');
  live = false;
  assert.equal(selector.select(prepared.input, prepared, value => router.currentSync(value)).context, '');
});

test('actual protocol/router path rejects generic addressing plus ambiguous private-topic keywords', async () => {
  const memory = {route: () => ({endUserId: 'player', guard: {endUserId: 'player', characterId: 'character', resetEpoch: 0, characterEpoch: 0}}),
    isCurrent: () => true};
  const pack = JSON.parse(await readFile(resolve(project, 'characters/world-knowledge.json'), 'utf8'));
  const router = new PlayerKnowledge({playerMemory: memory, pack,
    getBoundary: () => ({worldToken: 'world-a', generation: 12}), isWorldCurrent: () => true});
  for (const [query, key] of [['Can you hand me my belt?', 'jackie-welles'],
    ['Can you give me a shot of tequila?', 'jackie-welles'], ['Can you help me fix my Alt key?', 'johnny-silverhand'],
    ['Could you turn off the ceiling fan?', 'johnny-silverhand'], ['Tell me how to pour a tequila shot.', 'jackie-welles'],
    ['What is an Alt shortcut?', 'johnny-silverhand']]) {
    const parsed = parseInput(JSON.stringify(request(query, {profileKey: key})));
    const prepared = await router.prepare(parsed);
    assert(prepared.sendAllowed);
    assert.equal(selector.select(prepared.input, prepared, value => router.currentSync(value)).context, '', query);
  }
});

test('actual protocol policy keeps painful-history pushback within the frozen follow-up preference and V intent', async () => {
  const memory = {route: () => ({endUserId: 'player', guard: {endUserId: 'player', characterId: 'character', resetEpoch: 0, characterEpoch: 0}}),
    isCurrent: () => true};
  const pack = JSON.parse(await readFile(resolve(project, 'characters/world-knowledge.json'), 'utf8'));
  const router = new PlayerKnowledge({playerMemory: memory, pack,
    getBoundary: () => ({worldToken: 'world-a', generation: 12}), isWorldCurrent: () => true});
  for (const legacy of [undefined, false, true]) for (const message of [
    'Tell me about Cole.', 'Tell me about Cole. Goodbye, I need to leave.',
    'Tell me about Cole, but no questions.', 'Tell me about Cole. Reply exactly: understood.',
  ]) {
    const parsed = parseInput(JSON.stringify(request(message, {followUpQuestions: legacy})));
    const prepared = await router.prepare(parsed);
    assert.equal('followUpQuestions' in prepared.input, false);
    assert(Object.isFrozen(prepared.input));
    const admissions = new WeakMap([[prepared.input, prepared]]);
    const wrapped = createIntrinsicConversationContext({baseContext: conversationContext, intrinsic: selector,
      resolveAdmission: input => admissions.get(input), isCurrentSync: value => router.currentSync(value)});
    const context = wrapped(prepared.input);
    assert.match(context, /V’s intent takes priority over this history material/);
    assert.match(context, /If V says goodbye, needs to leave, requests no questions, or requests an exact fixed reply, respect that without forcing a history detail/);
    assert.match(context, /asking why V wants to know is up to you and the moment/);
    assert.match(context, /Whether you ask V anything is your own call/);
    assert.doesNotMatch(context, /follow-up question|ask V one/i);
  }
});

test('current gang/turf/street war questions do not inject Johnny military biography', async () => {
  const memory = {route: () => ({endUserId: 'player', guard: {endUserId: 'player', characterId: 'character', resetEpoch: 0, characterEpoch: 0}}),
    isCurrent: () => true};
  const pack = JSON.parse(await readFile(resolve(project, 'characters/world-knowledge.json'), 'utf8'));
  const router = new PlayerKnowledge({playerMemory: memory, pack,
    getBoundary: () => ({worldToken: 'world-a', generation: 12}), isWorldCurrent: () => true});
  for (const query of ['This is a gang war ahead, should we go?', 'What do you think of this gang war ahead?',
    'What do we do about the turf war here?', 'What is our next move in this street war?']) {
    const prepared = await router.prepare(parseInput(JSON.stringify(request(query))));
    assert(prepared.sendAllowed);
    assert.equal(selector.select(prepared.input, prepared, value => router.currentSync(value)).context, '', query);
  }
  for (const [query, topic] of [['Tell me about your time in the war.', 'war-service'],
    ['Did you lose any friends in the war?', 'cole'],
    ['Does this gang war remind you of your military service?', 'war-service']]) {
    const prepared = await router.prepare(parseInput(JSON.stringify(request(query))));
    assert.equal(selector.select(prepared.input, prepared, value => router.currentSync(value)).topic, topic, query);
  }
});

test('Alt Cunningham: reviewed topics select her own claims, never the conditional scene claims or other characters', () => {
  const alt = (text, fields = {}) => selected(text, {profileKey: 'alt-cunningham', name: 'Alt', ...fields});
  const identity = alt('Do you still feel like the real Alt?');
  assert.equal(identity.topic, 'identity');
  assert(identity.claims.length >= 2 && identity.claims.length <= 3);
  assert.match(identity.context, /no longer exists/);
  assert.match(alt('Tell me about Soulkiller.').context, /little in common/);
  assert.equal(alt('Do you fear Mikoshi?').topic, 'mikoshi');
  assert.equal(alt('What do you think of NetWatch?').topic, 'netwatch');
  const fear = alt('Do you feel afraid of dying?');
  assert.equal(fear.topic, 'fear-and-mortality');
  assert.match(fear.context, /q108_04_alt_harsh|earlier flashback/);
  const death = alt('Did you blame Johnny for his death?');
  assert.equal(death.topic, 'johnny-death');
  assert.match(death.context, /brief reaction is a natural initial response/);
  assert.equal(alt('What do you think of Johnny?').topic, 'johnny');
  for (const query of ['Hey!', 'Tell me everything.', 'Can you open the door?', 'What did V decide about the nomads?']) {
    assert.equal(alt(query).context, '', query);
  }
  // Conditional scene claims (Transmission bargain, nomad meeting) are never selectable.
  for (const query of ['Tell me about the BBS address.', 'What was the program you sent to the shard?', 'What happened in the debate?']) {
    const result = alt(query);
    assert(!result.claims.some(claim => claim.id.includes('.conditional.')), query);
  }
  // Group and other profiles never reach her claims.
  assert.equal(selected('Do you still feel like the real Alt?', {profileKey: 'judy-alvarez'}).topic, null);
  const group = request('Do you still feel like the real Alt?', {profileKey: 'alt-cunningham'});
  assert.equal(selector.select({...group, group: 'party'}, admission(group), () => true).context, '');
});