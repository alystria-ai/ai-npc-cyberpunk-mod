// Other mods' state for the Digital Vixen mods Flesh and Chrome and Injuries, and V being visibly topless or naked: the bridge half (docs/DYNAMIC_INFO.md,
// docs/PLAYER_GEAR_CONTEXT.md). mod/vixen-state.lua sends small stages; bridge/mod-state.mjs validates and words them; bridge/turn-context.mjs puts them in the block
// and writes the fac: / inj: probe lines; mod/player-gear.lua sends `nudity`, bridge/player-gear.mjs validates it.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseMods, parseVixenRead, modsSentences, modsAskedSentences, modsSignature} from './mod-state.mjs';
import {describeTurnContext, parseTurnContext, sceneryFor, vixenProbeLines, modsProbeLine, nuditySentences} from './turn-context.mjs';
import {offKinds, stripSnapshot, dynamicInfo} from './dynamic-info.mjs';
import {conversationContext} from './quest-context.mjs';
import {parseGear, gearNudity, describeGear, gearDiagnostic} from './player-gear.mjs';
import {parseInput} from './protocol.mjs';
import {SceneryMemory, asksAboutClothes, asksAboutSelf} from './scenery-memory.mjs';

const fac = (state, rest = {}) => parseMods({fleshAndChrome: state, ...rest});
const inj = (state, rest = {}) => parseMods({injuries: state, ...rest});

test('parseMods keeps the Flesh and Chrome and Injuries stages in range and drops the rest', () => {
  assert.deepEqual(parseMods({fleshAndChrome: {breath: 2, energy: 4, drinks: 3, smoke: 1, bogus: 2}}), {fleshAndChrome: {breath: 2, energy: 4, drinks: 3, smoke: 1}});
  assert.deepEqual(parseMods({injuries: {limp: 1, arm: 3, head: 2, bleed: 3, treated: 1, other: 1}}), {injuries: {limp: 1, arm: 3, head: 2, bleed: 3, treated: 1}});
  assert.deepEqual(parseMods({darkFuture: {energy: 3}, fleshAndChrome: {breath: 1}, injuries: {bleed: 2}}), {darkFuture: {energy: 3}, fleshAndChrome: {breath: 1}, injuries: {bleed: 2}});
  for (const bad of [{fleshAndChrome: {}}, {fleshAndChrome: {breath: 0}}, {fleshAndChrome: {breath: 5}}, {fleshAndChrome: {drinks: 4}}, {fleshAndChrome: {smoke: 2}}, {fleshAndChrome: {energy: '3'}},
    {injuries: {bleed: 4}}, {injuries: {treated: 2}}, {injuries: []}, {injuries: {bleed: 1.5}}, {fleshAndChrome: null}, {injuries: 3}]) {
    assert.equal(parseMods(bad), undefined, JSON.stringify(bad));
  }
});

test('a companion in person and Johnny get the body, the injuries, what V has had and the rest, in separate short sentences', () => {
  const state = parseMods({fleshAndChrome: {breath: 2, energy: 3, drinks: 2, smoke: 1}, injuries: {bleed: 2, limp: 1}, darkFuture: {nerve: 3}});
  const person = modsSentences(state, 'person');
  assert.deepEqual(person, ['V is worn out and out of breath.', 'V is bleeding and limping a little.', 'V is tipsy: loose, a little loud, smelling of booze.', 'V has just had a cigarette.', 'V is badly on edge.']);
  assert.deepEqual(modsSentences(state, 'head'), person);
  for (const sentence of person) assert.ok(sentence.length < 100, sentence);
  assert.doesNotMatch(person.join(' '), /Flesh|Chrome|Injuries|Digital|mod\b|stage|tier|\d/i, 'no mod name, stage or number reaches the model');
});

test('the stages are worded from mild to worst', () => {
  assert.deepEqual(modsSentences(fac({breath: 1}), 'person'), ['V is a little winded.']);
  assert.deepEqual(modsSentences(fac({breath: 4}), 'person'), ['V is too spent to run or fight.']);
  assert.deepEqual(modsSentences(fac({drinks: 1}), 'person'), ['V has had a drink or two.']);
  assert.deepEqual(modsSentences(fac({drinks: 2}), 'person'), ['V is tipsy: loose, a little loud, smelling of booze.']);
  assert.deepEqual(modsSentences(fac({drinks: 3}), 'person'), ['V is drunk: slurring, unsteady on their feet, reeking of booze.'], 'a small model took "V has had a lot to drink" for nothing worth saying (live 2026-10-27)');
  assert.deepEqual(modsSentences(fac({drinks: 3, smoke: 1}), 'person'), ['V is drunk: slurring, unsteady on their feet, reeking of booze.', 'V has just had a cigarette.']);
  assert.deepEqual(modsSentences(inj({arm: 2}), 'person'), ['V is holding a broken arm.']);
  assert.deepEqual(modsSentences(inj({head: 3}), 'person'), ['V is badly concussed.']);
  assert.deepEqual(modsSentences(inj({bleed: 3}), 'person'), ['V is bleeding heavily.']);
  assert.deepEqual(modsSentences(inj({limp: 3}), 'person'), ['V is barely able to walk on an injured leg.']);
  assert.deepEqual(modsSentences(inj({treated: 1}), 'person'), ['V is bandaged up.']);
  assert.deepEqual(modsSentences(inj({treated: 1, limp: 1}), 'person'), ['V is limping a little.'], '"bandaged up" is said only when nothing else shows');
});

test('both mods have a daily energy: one phrase, the worse stage', () => {
  assert.deepEqual(modsSentences(parseMods({darkFuture: {energy: 2}, fleshAndChrome: {energy: 3}}), 'person'), ['V is worn out.']);
  assert.deepEqual(modsSentences(parseMods({darkFuture: {energy: 4}, fleshAndChrome: {energy: 1}}), 'person'), ['V is exhausted.']);
  assert.equal(modsSignature(parseMods({darkFuture: {energy: 2}, fleshAndChrome: {energy: 3}})), 'energy3');
});

test('a stranger sees breathlessness, blood, a limp, a held arm, a dazed face and strong drink, nothing else', () => {
  assert.deepEqual(modsSentences(fac({breath: 2, energy: 2, drinks: 3, smoke: 1}), 'ambient'), ['V looks out of breath.', 'V looks drunk and smells of booze.']);
  assert.deepEqual(modsSentences(fac({breath: 1, energy: 3, drinks: 2}), 'ambient'), ['V looks worn out.']);
  assert.deepEqual(modsSentences(inj({bleed: 1, limp: 2, arm: 3, head: 2, treated: 1}), 'ambient'), ['V looks to be holding a hurt arm, to be limping and to be bleeding.']);
  assert.deepEqual(modsSentences(inj({limp: 1, arm: 1, head: 2}), 'ambient'), []);
  assert.deepEqual(modsSentences(inj({head: 3}), 'ambient'), ['V looks to be dazed.']);
  assert.deepEqual(modsSentences(inj({treated: 1}), 'ambient'), []);
});

test('a phone, a call and a voice get none', () => {
  const state = parseMods({fleshAndChrome: {breath: 4}, injuries: {bleed: 3}});
  for (const form of ['phone', 'call', 'voice']) assert.deepEqual(modsSentences(state, form), [], form);
});

test('the signature changes with the injuries and what V has had, and is undefined when there is nothing to say', () => {
  assert.equal(modsSignature(inj({bleed: 2, limp: 1})), 'bleed2,limp1');
  assert.equal(modsSignature(fac({drinks: 1, smoke: 1})), 'drinks1,smoke1');
  assert.notEqual(modsSignature(inj({bleed: 2})), modsSignature(inj({bleed: 3})));
  assert.equal(modsSignature(parseMods({fleshAndChrome: {}})), undefined);
});

test('V asking about themself gets the injuries and the breath worded as the answer', () => {
  const sentences = modsAskedSentences(inj({bleed: 1}), 'person');
  assert.equal(sentences[0], 'V is bleeding a little.');
  assert.match(sentences[1], /V is asking how they look/);
  assert.deepEqual(modsAskedSentences(inj({bleed: 1}), 'phone'), []);
});

test('the compact notes from the game are kept as plain words and never as facts', () => {
  const note = 'installed=yes read=ok state=breath0,energy1,drinks0,smoke0';
  assert.equal(parseVixenRead(note), note);
  assert.equal(parseVixenRead('installed=yes read=off state=-'), 'installed=yes read=off state=-');
  assert.equal(parseVixenRead('installed=yes read=none state=limp?,arm?,head?,bleed?,treated?'), 'installed=yes read=none state=limp?,arm?,head?,bleed?,treated?');
  for (const bad of [undefined, null, 5, {}, '', 'installed=yes read=ok stage=breath0', 'installed=yes read=ok state=1; rm -rf', `${note} extra`, 'x'.repeat(200)]) assert.equal(parseVixenRead(bad), undefined, String(bad));
  const snapshot = {version: 1, status: 'ready', hour: 3, minute: 0, facRead: note, injRead: 'installed=yes read=ok state=limp0,arm0,head0,bleed2,treated0'};
  assert.equal(parseTurnContext(snapshot).facRead, note);
  assert.equal(parseTurnContext(snapshot).injRead, snapshot.injRead);
  assert.equal(parseTurnContext({version: 1, status: 'ready', facRead: note}).status, 'unavailable', 'a note alone is no snapshot');
  const parsed = parseTurnContext(snapshot);
  const off = new Set(offKinds({dynamicInfo: {mods: false}}));
  assert.equal(stripSnapshot(parsed, off).facRead, undefined);
  assert.equal(stripSnapshot(parsed, off).injRead, undefined);
  assert.equal(stripSnapshot(parsed, new Set(offKinds({dynamicInfo: {mods: true}}))).facRead, note);
});

const BASE = {requestId: 'v-1', profileKey: 'alex', name: 'Alex', entity: '11ULL', generation: 1, text: 'hello',
  turnContext: {version: 1, status: 'ready', hour: 8, minute: 30, district: 'Watson', gender: 'male', lifepath: 'corpo', vehicle: false, motion: 'still', weather: 'cloudy',
    health: 'healthy', heat: 0, indoors: false, money: 'ok', party: [{key: 'alex', name: 'Alex', activity: 'standing', holding: 'holstered', weapon: 'A-22B Chao'}],
    mods: {fleshAndChrome: {breath: 2}, injuries: {bleed: 2}}, facRead: 'installed=yes read=ok state=breath2,energy0,drinks0,smoke0',
    injRead: 'installed=yes read=ok state=limp0,arm0,head0,bleed2,treated0'}};

test('the fac: and inj: probe lines say what the game saw, the switch, whether V asked and where each state went', () => {
  const memory = new SceneryMemory({now: () => 1000});
  let serial = 0;
  const turn = (text, extra = {}) => ({...BASE, requestId: `x-${++serial}`, text, ...extra});
  const lines = (input, options = {}) => vixenProbeLines(input, {split: true, fresh: sceneryFor(input, memory, options.off), ...options});
  const first = lines(turn('hello'));
  assert.equal(first.fac, 'fac: installed=yes read=ok state=breath2,energy0,drinks0,smoke0 switch=on asked=no sent=background');
  assert.equal(first.inj, 'inj: installed=yes read=ok state=limp0,arm0,head0,bleed2,treated0 switch=on asked=no sent=background');
  assert.match(lines(turn('where to?')).fac, /sent=none\(told earlier in this talk, V did not ask\)$/);
  const asked = lines(turn('how do I look?'));
  assert.match(asked.fac, /asked=yes sent=right-now$/);
  assert.match(asked.inj, /asked=yes sent=right-now$/);
  // A state that is not there: the line says "no stage worth saying".
  const onlyInj = turn('how do I look?', {entity: '12ULL', turnContext: {...BASE.turnContext, mods: {injuries: {bleed: 2}}, facRead: 'installed=yes read=none state=breath?,energy?,drinks?,smoke?'}});
  assert.match(lines(onlyInj).fac, /asked=yes sent=none\(no stage worth saying\)$/);
  assert.match(lines(onlyInj).inj, /sent=right-now$/);
  // The switch off, and the game sent no note.
  const off = new Set(offKinds({dynamicInfo: {mods: false}}));
  const switched = turn('how do I look?');
  assert.match(vixenProbeLines(switched, {split: true, off, fresh: sceneryFor(switched, memory, off)}).fac, /switch=off asked=yes sent=none\(switch off\)$/);
  const none = turn('hi'); none.turnContext = {...BASE.turnContext}; delete none.turnContext.facRead;
  assert.deepEqual(Object.keys(vixenProbeLines(none, {split: true})), ['inj']);
  assert.deepEqual(vixenProbeLines(undefined, {}), {});
  // Dark Future's own line is unchanged and absent here.
  assert.equal(modsProbeLine(turn('hi'), {split: true}), '');
  // A stranger under the bar and a phone.
  const stranger = {...turn('how do I look?'), profileKey: 'ambient-citizen', archetype: {district: 'Watson'}, entity: '5ULL', turnContext: {...BASE.turnContext, mods: {fleshAndChrome: {breath: 1}}}};
  assert.match(vixenProbeLines(stranger, {split: true, ambient: true, fresh: sceneryFor(stranger, memory)}).fac, /sent=right-now\(fine\)$/, 'a stranger sees nothing wrong and is told so');
  assert.match(vixenProbeLines(turn('how do I look?', {channel: 'phone', entity: ''}), {split: true}).fac, /sent=none\(a phone gets none\)$/);
  // Words only: no name of the player, never what V typed.
  assert.doesNotMatch(JSON.stringify(asked), /alex|how do i look/i);
});

test('end to end: the sentences reach the block, with the switch on only', () => {
  const before = dynamicInfo.off;
  try {
    dynamicInfo.update({dynamicInfo: {mods: true}});
    assert.match(conversationContext({...BASE, requestId: 'e2e-1', text: 'how do I look?'}), /V is out of breath\. V is bleeding\. Otherwise V is rested\. V is asking how they look/s);
    dynamicInfo.update({dynamicInfo: {mods: false}});
    assert.doesNotMatch(conversationContext({...BASE, requestId: 'e2e-2', text: 'how do I look?'}), /out of breath|bleeding|facRead|state=breath/);
  } finally { dynamicInfo.off = before; }
});

// ---------------------------------------------------------------------------------------------------------------------
// Nudity

const gearOf = (nudity, clothing = [], extra = {}) => ({version: 1, status: 'ready', ...(clothing.length ? {clothing} : {}), weapons: [{slot: 'hand', name: 'Kyubi'}], ...(nudity ? {nudity} : {}), ...extra});
const nudeTurn = (nudity, clothing, extra = {}) => ({...BASE, requestId: `n-${Math.random()}`, text: 'hello', gear: gearOf(nudity, clothing), ...extra,
  turnContext: {...BASE.turnContext, mods: undefined, facRead: undefined, injRead: undefined}});

test('parseGear keeps topless and nude, drops anything else, and a snapshot of nudity alone is still a snapshot', () => {
  assert.equal(parseGear(gearOf('topless', [{slot: 'legs', name: 'Jeans'}])).nudity, 'topless');
  assert.equal(parseGear(gearOf('nude')).nudity, 'nude');
  for (const bad of ['naked', 'TOPLESS', true, 1, null, [], {}]) assert.equal(parseGear(gearOf(bad)).nudity, undefined, JSON.stringify(bad));
  assert.deepEqual(parseGear({version: 1, status: 'ready', nudity: 'nude'}), {version: 1, status: 'ready', nudity: 'nude'});
  assert.equal(parseGear({version: 1, status: 'ready'}).status, 'unavailable');
  assert.deepEqual(gearNudity(gearOf('nude')), {state: 'nude', bare: true});
  assert.deepEqual(gearNudity(gearOf('nude', [{slot: 'feet', name: 'Boots'}])), {state: 'nude', bare: false});
  assert.equal(gearNudity(gearOf(null, [{slot: 'legs', name: 'Jeans'}])), null);
  assert.equal(gearNudity(undefined), null);
  // Through the protocol, as the game sends it.
  const input = parseInput(JSON.stringify({requestId: '100-1-11ULL', generation: 1, entity: '11ULL', profileKey: 'judy-alvarez', name: 'Judy', bodyType: 'WomanAverage', text: 'hi',
    gear: gearOf('topless', [{slot: 'legs', name: 'Jeans'}])}));
  assert.equal(input.gear.nudity, 'topless');
});

test('companions in person, Johnny and strangers get a short factual note; nobody else', () => {
  const topless = nuditySentences(gearOf('topless', [{slot: 'legs', name: 'Jeans'}]), 'person');
  assert.equal(topless.length, 1);
  assert.match(topless[0], /^V is topless right now, and you can see it: this is the current truth and replaces anything said or described earlier/);
  assert.match(topless[0], /React the way you naturally would in character/);
  assert.match(nuditySentences(gearOf('nude'), 'person')[0], /^V is wearing nothing right now, and you can see it/);
  assert.match(nuditySentences(gearOf('nude', [{slot: 'feet', name: 'Boots'}]), 'person')[0], /^V is naked, with only accessories or footwear on right now, and you can see it/);
  assert.match(nuditySentences(gearOf('topless', [{slot: 'legs', name: 'Jeans'}]), 'head')[0], /^V is topless right now; you see it through V's eyes: the current truth\./);
  assert.match(nuditySentences(gearOf('nude'), 'ambient')[0], /^V is wearing nothing right now, in plain view of you: the current truth\. React as a stranger naturally would/);
  for (const form of ['phone', 'call', 'voice']) assert.deepEqual(nuditySentences(gearOf('nude'), form), [], form);
  assert.deepEqual(nuditySentences(gearOf(null, [{slot: 'legs', name: 'Jeans'}]), 'person'), []);
  assert.deepEqual(nuditySentences(gearOf('nude'), 'person', new Set(['gear'])), [], 'the gear switch governs it');
  // Neutral: no anatomy, no sexual wording, no gender.
  const all = [...topless, ...nuditySentences(gearOf('nude'), 'person'), ...nuditySentences(gearOf('nude'), 'ambient'), ...nuditySentences(gearOf('nude'), 'head')].join(' ');
  assert.doesNotMatch(all, /breast|chest|nipple|genital|sexy|sexual|arous|\bher\b|\bhis\b|\bshe\b|\bhe\b|woman|\bman\b/i);
});

test('the note is in the right-now block of a companion and of a stranger, whatever the Other mods switch says', () => {
  const memory = new SceneryMemory({now: () => 1000});
  const jeans = [{slot: 'legs', name: 'Jeans'}];
  const topless = nudeTurn('topless', jeans);
  assert.match(describeTurnContext(topless, {split: true, fresh: sceneryFor(topless, memory)}).text, /V is topless right now, and you can see it/);
  const stranger = {...nudeTurn('nude'), profileKey: 'ambient-citizen', archetype: {district: 'Watson'}, entity: '5ULL'};
  const out = describeTurnContext(stranger, {split: true, ambient: true, fresh: sceneryFor(stranger, memory)});
  assert.match(out.text, /V is wearing nothing right now, in plain view of you/);
  assert.match(out.text, /You have never met V/, 'the stranger is still a stranger');
  // The mods switch is off by default and does not matter here.
  assert.ok(dynamicInfo.off.has('mods'));
  assert.match(conversationContext({...nudeTurn('topless', jeans), requestId: 'n-ctx'}), /V is topless right now, and you can see it/);
  // The gear switch off: nothing.
  const off = new Set(offKinds({dynamicInfo: {gear: false}}));
  assert.doesNotMatch(describeTurnContext(nudeTurn('topless', jeans), {split: true, off}).text, /topless/);
  // No gear, a dressed V: nothing.
  assert.doesNotMatch(describeTurnContext({...nudeTurn('nude'), gear: undefined}, {split: true}).text, /wearing nothing/);
  assert.doesNotMatch(describeTurnContext(nudeTurn(null, jeans), {split: true}).text, /topless|naked|wearing nothing/);
});

test('it is told when new to the conversation, again when V asks about themself or their clothes, and not on every turn', () => {
  let serial = 0, clock = 1000;
  const memory = new SceneryMemory({now: () => clock});
  const jeans = [{slot: 'legs', name: 'Jeans'}];
  const turn = text => ({...nudeTurn('topless', jeans), requestId: `t-${++serial}`, text});
  const said = text => { const input = turn(text); return /V is topless/.test(describeTurnContext(input, {split: true, fresh: sceneryFor(input, memory)}).text); };
  assert.equal(said('hello'), true, 'the first turn');
  assert.equal(said('where are we going?'), false, 'not recited on the next');
  assert.equal(said('what am I wearing?'), true, 'V asks about their clothes');
  assert.equal(said('and the weather?'), false);
  assert.equal(said('how do I look?'), true, 'V asks how they look');
  assert.equal(said('ok'), false);
  clock += 25 * 60_000;
  assert.equal(said('hey again'), true, 'after a long silence');
  // A different state is new.
  const changed = {...nudeTurn('nude'), requestId: `t-${++serial}`, text: 'ok'};
  assert.match(describeTurnContext(changed, {split: true, fresh: sceneryFor(changed, memory)}).text, /wearing nothing/);
  // Dressed again, then bare again: new again.
  const dressed = {...nudeTurn(null, jeans), requestId: `t-${++serial}`, text: 'ok'};
  sceneryFor(dressed, memory);
  assert.equal(said('back'), true);
});

test('the clothes question reads English and the menu languages, and ignores ordinary talk', () => {
  for (const text of ['what am I wearing?', 'do I have clothes on', 'am I dressed?', 'I am naked', 'put something on', 'nice outfit', 'where are my pants', 'stop staring, I am topless',
    'qué ropa llevo', 'estoy desnuda', 'quel vêtement', 'ich bin nackt', 'sono nuda', 'jestem naga', 'jsem nahý', 'meztelen vagyok', 'на мне нет одежды', 'я голий', 'çıplağım', '服を着てない', '我没穿衣服', '옷을 안 입었어'])
    assert.equal(asksAboutClothes(text), true, text);
  for (const text of ['tell me about Night City', 'where are we going', 'what time is it', 'can you fix my car', 'let us go', 'see you later', '¿dónde está el coche?', 'wo ist das Auto', 'куда мы идем', '어디 가', '去哪里'])
    assert.equal(asksAboutClothes(text), false, text);
  assert.equal(asksAboutSelf('hello'), false);
});

test('the gear line keeps its rule about what V lacks, with the one exception, and the diagnostic names the state', () => {
  const input = {...BASE, gear: gearOf('topless', [{slot: 'legs', name: 'Jeans'}])};
  const text = describeGear(input).text;
  assert.match(text, /Never remark on what V is not wearing/);
  assert.match(text, /topless or naked is the one exception/);
  assert.doesNotMatch(describeGear({...BASE, gear: gearOf(null, [{slot: 'legs', name: 'Jeans'}])}).text, /one exception/);
  assert.match(gearDiagnostic(input), /nudity=topless$/);
  assert.doesNotMatch(gearDiagnostic({...BASE, gear: gearOf(null, [{slot: 'legs', name: 'Jeans'}])}), /nudity/);
  // Nudity alone: the gear line says plainly that nothing is worn, so a question about clothes has an answer to give.
  assert.match(describeGear({...BASE, gear: {version: 1, status: 'ready', nudity: 'nude'}}).text, /- wearing: nothing at all\./);
});

// ---------------------------------------------------------------------------------------------------------------------
// Live 2026-10-27 (probe.log 06:05 to 06:07, Convai): Alex said "You're topless" at once, then, with V nude, "You've got a shirt on" and a turn later "a dark shirt".

test('no restriction cue on nudity, on any form, first time or after: the character reacts however it would', () => {
  const forbidden = /do not describe|don't describe|never describe|do not mention|avoid|keep it (?:clean|short)|kept short|briefly|inappropriate|family|tasteful|polite|censor/i;
  for (const gear of [gearOf('topless', [{slot: 'legs', name: 'Jeans'}]), gearOf('nude'), gearOf('nude', [{slot: 'feet', name: 'Boots'}])])
    for (const form of ['person', 'head', 'ambient'])
      for (const full of [true, false]) {
        const [sentence, ...more] = nuditySentences(gear, form, undefined, full);
        assert.equal(more.length, 0);
        assert.doesNotMatch(sentence, forbidden, `${form} ${full}: ${sentence}`);
      }
  // The block of a turn and the gear line carry none either.
  const turn = nudeTurn('nude');
  const memory = new SceneryMemory({now: () => 1000});
  const block = describeTurnContext(turn, {split: true, fresh: sceneryFor(turn, memory)}).text;
  assert.doesNotMatch(block.replace(/Never claim to be anywhere else[^.]*\./, ''), /do not describe|body\b/i);
  assert.doesNotMatch(describeGear(turn).text, /do not describe/i);
});

test('the Alex turns of the live test: topless then nude, a stranger in between; each speaker is told on the first turn after a change, as the current fact', () => {
  let serial = 0, clock = 1000;
  const memory = new SceneryMemory({now: () => clock});
  const jeans = [{slot: 'legs', name: 'Jeans'}];
  const alex = (gear, text) => ({...BASE, requestId: `a-${++serial}`, text, gear, entity: '11148147ULL', turnContext: {...BASE.turnContext, mods: undefined, facRead: undefined, injRead: undefined}});
  const stranger = (gear, text) => ({...alex(gear, text), profileKey: 'resident-male', entity: '10009890ULL', archetype: {district: 'Watson'}});
  const block = (input, ambient = false) => describeTurnContext(input, {split: true, ambient, fresh: sceneryFor(input, memory)}).text;
  // Generation 8: Alex, V topless.
  assert.match(block(alex(gearOf('topless', jeans), 'am I dressed for this?')), /V is topless right now, and you can see it: this is the current truth/);
  // Generation 9: a stranger, V topless: told, in its own words, on its own first turn.
  assert.match(block(stranger(gearOf('topless', jeans), 'hey'), true), /V is topless right now, in plain view of you/);
  // Generation 10: Alex again, V now nude: a change, so the full note comes again and says it replaces what was said.
  const nude = block(alex(gearOf('nude'), 'ok'));
  assert.match(nude, /V is wearing nothing right now, and you can see it: this is the current truth and replaces anything said or described earlier in this talk about V's clothes \(a shirt, a jacket\)/);
  // Generation 11: nothing changed: not recited with the cue, but the standing line stays so an earlier "shirt" cannot come back.
  const next = block(alex(gearOf('nude'), 'so?'));
  assert.match(next, /V is still wearing nothing: the current truth, whatever was said about V's clothes earlier\./);
  assert.doesNotMatch(next, /React the way you naturally would/);
  // Generation 13: "what am i wearing": the full note again, and the gear line answers it.
  const asked = alex(gearOf('nude'), 'what am i wearing');
  assert.match(block(asked), /V is wearing nothing right now, and you can see it/);
  assert.match(describeGear(asked).text, /wearing: nothing at all[;.]/);
  // Dressed again: neither the note nor the standing line.
  assert.doesNotMatch(block(alex(gearOf(null, jeans), 'ok')), /current truth/);
});

test('through every provider path the right-now block carries it first and the gear line says what is worn', () => {
  const input = {...nudeTurn('nude'), requestId: 'prov-1'};
  const context = conversationContext(input);
  assert.match(context, /^Right now \(from the game, this turn only\): .*V is wearing nothing right now/s);
  assert.match(context, /V's current gear .* wearing: nothing at all[;.]/s);
  const topless = {...nudeTurn('topless', [{slot: 'legs', name: 'Jeans'}]), requestId: 'prov-2'};
  assert.match(conversationContext(topless), /wearing: legs: Jeans, upper body: nothing on[;.]/);
});
