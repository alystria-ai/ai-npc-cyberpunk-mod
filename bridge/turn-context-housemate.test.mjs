// The housemate note of the turn context (docs/HOUSEMATES.md): where she lives, whether she is home, who else lives there.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseTurnContext, parseHousemate, describeTurnContext, turnContext, MAX_CHARS} from './turn-context.mjs';
import {parseInput} from './protocol.mjs';
import {stripSnapshot} from './dynamic-info.mjs';

const scene = (extra = {}) => ({version: 1, status: 'ready', hour: 2, minute: 10, district: 'Watson', area: 'Kabuki',
  gender: 'female', lifepath: 'streetkid', vehicle: false, party: [{key: 'judy-alvarez', name: 'Judy'}, {key: 'panam-palmer', name: 'Panam'}], ...extra});
const turn = (extra = {}) => ({requestId: '100-1-11ULL', generation: 1, entity: '11ULL', profileKey: 'judy-alvarez', name: 'Judy', bodyType: 'WomanAverage', text: 'So what now?', ...extra});
const note = (extra = {}) => ({apartment: 'Corpo Plaza apartment', atHome: true, others: ['Panam Palmer', 'River Ward'], ...extra});

test('a housemate note is parsed with its apartment, home flag and others, and dropped when malformed', () => {
  assert.deepEqual(parseHousemate(note()), {apartment: 'Corpo Plaza apartment', atHome: true, others: ['Panam Palmer', 'River Ward']});
  assert.deepEqual(parseHousemate(note({moved: 'now', asked: true})), {apartment: 'Corpo Plaza apartment', atHome: true, others: ['Panam Palmer', 'River Ward'], moved: 'now', asked: true});
  assert.deepEqual(parseHousemate(note({others: undefined, atHome: false})), {apartment: 'Corpo Plaza apartment', atHome: false, others: []});
  assert.deepEqual(parseHousemate(note({others: {}})).others, []);
  for (const bad of [undefined, null, 'x', [], note({apartment: ''}), note({apartment: 'x'.repeat(81)}), note({apartment: 7}), note({apartment: undefined}),
    note({atHome: 'yes'}), note({atHome: undefined}), note({others: Array(9).fill('Judy')}), note({others: 'Judy'})]) {
    assert.equal(parseHousemate(bad), null, JSON.stringify(bad));
  }
  assert.equal(parseHousemate(note({others: Array(8).fill('Judy').map((name, i) => name + i)})).others.length, 8);
  // A bad name in the list is skipped, the rest stays; an unknown moved word is ignored.
  assert.deepEqual(parseHousemate(note({others: ['Panam', '', 4, 'Panam', 'River']})).others, ['Panam', 'River']);
  assert.equal(parseHousemate(note({moved: 'later'})).moved, undefined);
  assert.equal(parseHousemate(note({asked: 'yes'})).asked, undefined);
  assert.equal(parseHousemate(note({apartment: 'H10 <b>flat</b>\n7'})).apartment, 'H10 flat 7');
  // Inside the snapshot a bad note is dropped and the rest stays.
  assert.equal(parseTurnContext(scene({housemate: note({apartment: ''})})).housemate, undefined);
  assert.equal(parseTurnContext(scene({housemate: note({apartment: ''})})).district, 'Watson');
  assert.equal(parseTurnContext(scene()).housemate, undefined);
  assert.equal(parseTurnContext(scene({housemate: note()})).housemate.apartment, 'Corpo Plaza apartment');
});

test('the wording, one sentence each, in her own voice', () => {
  const text = turnContext(parseInput(JSON.stringify(turn({turnContext: scene({housemate: note()})}))));
  assert.match(text, /You live at V's place in Corpo Plaza apartment\. You are home\. Also living there: Panam Palmer and River Ward\./);
  const out = turnContext(turn({turnContext: scene({housemate: note({atHome: false, others: ['Panam Palmer']})})}));
  assert.match(out, /You live at V's place in Corpo Plaza apartment\. You are out with V\. Also living there: Panam Palmer\./);
  assert.doesNotMatch(out, /You are home/);
  const alone = turnContext(turn({turnContext: scene({housemate: note({others: []})})}));
  assert.doesNotMatch(alone, /Also living there/);
  const moved = turnContext(turn({turnContext: scene({housemate: note({moved: 'now'})})}));
  assert.match(moved, /V has just told you that you can stay at their place\./);
  assert.doesNotMatch(moved, /waiting for the answer/);
  const asked = turnContext(turn({turnContext: scene({housemate: note({asked: true})})}));
  assert.match(asked, /You asked V which of their flats you should move into and are waiting for the answer\./);
  assert.doesNotMatch(turnContext(turn({turnContext: scene({housemate: note({asked: false})})})), /which of their flats/);
  // Nothing tells her to recite it: the block's own closing rule stays last.
  assert.ok(text.endsWith('Do not recite it, and mention a place or the time only if it matters to what V says.'));
});

test('the note sits right after who she is and where, and the other facts keep their budget', () => {
  const text = turnContext(turn({turnContext: scene({housemate: note()})}));
  assert.match(text, /^Right now \(from the game, this turn only\): You are with V in person\. You are somewhere in Kabuki, Watson; exactly where is not given\. You live at V's place/);
  assert.ok(text.indexOf('You live at') < text.indexOf('It is late night'));
  const crowded = scene({party: [], weather: 'rain', health: 'hurt', heat: 3, money: 'broke', motion: 'walking', vehicle: false});
  const without = turnContext(turn({turnContext: crowded}));
  const withNote = turnContext(turn({turnContext: {...crowded, housemate: note({moved: 'now', asked: true})}}));
  const bodyOf = value => value.slice('Right now (from the game, this turn only): '.length);
  for (const piece of bodyOf(without).split(/(?<=\.) /).filter(part => !part.startsWith('Treat this') && !part.startsWith('Your usual') && !part.startsWith('Do not recite'))) {
    assert.ok(withNote.includes(piece), piece);
  }
  assert.ok(without.length <= MAX_CHARS);
  assert.ok(withNote.length <= MAX_CHARS + 600, `${withNote.length} characters`);
});

test('an absent field changes nothing', () => {
  const plain = turn({turnContext: scene()});
  const before = describeTurnContext(plain);
  const other = describeTurnContext(turn({turnContext: scene({housemate: undefined})}));
  assert.deepEqual(other, before);
  assert.doesNotMatch(before.text, /live at|Also living/);
  assert.deepEqual(describeTurnContext(turn({turnContext: scene({housemate: note({apartment: ''})})})), before, 'a malformed note is as if absent');
});

test('it is dropped with the company kind, and only with it', () => {
  const input = turn({turnContext: scene({housemate: note()})});
  const company = describeTurnContext(input, {off: new Set(['company'])}).text;
  assert.doesNotMatch(company, /live at V's place|Also living there|You are home/);
  assert.doesNotMatch(company, /Also with V/);
  for (const kind of ['location', 'time', 'condition', 'money', 'about']) {
    assert.match(describeTurnContext(input, {off: new Set([kind])}).text, /You live at V's place in Corpo Plaza apartment\./, kind);
  }
  assert.equal(stripSnapshot(parseTurnContext(scene({housemate: note()})), new Set(['company'])).housemate, undefined);
  // The note alone with company off leaves none of its words.
  const only = turn({turnContext: {version: 1, status: 'ready', housemate: note()}});
  assert.doesNotMatch(describeTurnContext(only, {off: new Set(['company'])}).text, /live at|Also living|You are home/);
  assert.match(describeTurnContext(only).text, /You live at V's place/);
});

test('channels: in person and group get all of it, a phone contact or caller only where she lives, strangers and Johnny nothing', () => {
  const ctx = scene({housemate: note({moved: 'now'})});
  const groupInput = turn({turnContext: ctx, group: {version: 1, index: 1, total: 2, audience: ['judy-alvarez', 'panam-palmer'], round: 1}});
  const group = describeTurnContext(parseInput(JSON.stringify(groupInput)) ?? groupInput).text;
  assert.match(group, /You live at V's place in Corpo Plaza apartment\. You are home\./);
  for (const input of [turn({channel: 'phone', turnContext: ctx}), turn({turnContext: ctx, holocall: {version: 1, contact: 'Judy', mode: 'audio'}})]) {
    const text = describeTurnContext(input.channel ? input : parseInput(JSON.stringify(input))).text;
    assert.match(text, /You live at V's place in Corpo Plaza apartment\./);
    assert.match(text, /V has just told you that you can stay at their place\./);
    assert.doesNotMatch(text, /You are home|You are out with V|Also living there/);
  }
  const stranger = turn({profileKey: 'npc-vendor-clothing', name: 'Vendor', turnContext: ctx});
  assert.doesNotMatch(describeTurnContext(stranger, {ambient: true}).text, /live at/);
  assert.doesNotMatch(describeTurnContext(turn({turnContext: ctx}), {voice: true}).text, /live at/);
  // An automatic reaction carries no block at all, except the housemate's welcome (a talk with V: it carries the game clock and the "last talked" line, merged
  // with the speak-up time awareness). A chat line between two housemates carries none.
  const chat = {...turn({turnContext: ctx}), reaction: {kind: 'house', event: 'chat', partner: 'Panam', partnerKey: 'panam-palmer', place: 'x', n: 1, of: 6, lines: [], expiresAt: 1, maxWords: 22}};
  assert.equal(describeTurnContext(chat).text, '');
  const welcome = {...turn({turnContext: ctx}), reaction: {kind: 'house', event: 'welcome', place: 'x', awayHours: 1, others: [], expiresAt: 1, maxWords: 22}};
  assert.match(describeTurnContext(welcome).text, /^Right now \(from the game, this turn only\): You are with V in person\./);
});
