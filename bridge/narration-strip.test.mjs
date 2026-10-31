// Narration in plain prose (bridge/narration-strip.mjs): what is removed, and what real speech must keep. A player report of 31 Oct: sao10k/l3-euryale-70b on a Custom endpoint
// answered a holocall as "Jackie's voice over the phone, concerned, hey are you okay?" and the voice read all of it.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {stripNarration, nameForms} from './narration-strip.mjs';
import {cleanReply, PersonaBook} from './mistral-prompt.mjs';
import {ReplyStream, pickHead} from './reply-stream.mjs';
import {readFile} from 'node:fs/promises';

const JACKIE = {name: 'Jackie Welles'};
const strip = (text, who = JACKIE) => stripNarration(text, who);

// ---- Narration that goes ---------------------------------------------------------------------------------------------------------

test('the reported reply: a voice with a place and a delivery, then the words', () => {
  assert.equal(strip("Jackie's voice over the phone, concerned, hey are you okay?"), 'Hey are you okay?');
  assert.equal(strip("Jackie’s voice over the phone, concerned, hey are you okay?"), 'Hey are you okay?', 'a typographic apostrophe');
  assert.equal(strip("Jackie Welles's voice, low and tired: I'm here, choom."), "I'm here, choom.");
  assert.equal(strip("Jackie's voice crackles over the line, worried. Hey, V, where are you?"), 'Hey, V, where are you?');
});

test('the name with a verb of saying or a gesture, and with a delivery after a comma', () => {
  assert.equal(strip('Jackie says softly: I missed you.'), 'I missed you.');
  assert.equal(strip('Jackie said, quietly, I missed you.'), 'I missed you.');
  assert.equal(strip('Jackie replies warmly, sure, anytime.'), 'Sure, anytime.');
  assert.equal(strip('Jackie, grinning: you wish.'), 'You wish.');
  assert.equal(strip('Jackie, concerned, hey, what happened?'), 'Hey, what happened?');
  assert.equal(strip("Jackie grins at V and says: let's go."), "Let's go.");
  assert.equal(strip('Jackie smiles, then shakes his head, nah, not tonight.'), 'Nah, not tonight.');
  assert.equal(strip("Jackie says softly, 'hey V.'"), 'Hey V.', 'the quotation marks of the narrated line go with it');
  assert.equal(strip('Jackie says hello there.'), 'Hello there.', 'a verb of saying with no delimiter: the rest is what is said');
});

test('a sentence of pure narration is dropped, in front of the words or between sentences', () => {
  assert.equal(strip('Her voice crackles through the line.'), '');
  assert.equal(strip('Her voice crackles through the line. Hey V, where are you?'), 'Hey V, where are you?');
  assert.equal(strip("Hey V. Jackie's voice drops. Come over, now."), 'Hey V. Come over, now.');
  assert.equal(strip('Jackie grins. Told you, choom.'), 'Told you, choom.');
  assert.equal(strip('She sighs. I know, I know.'), 'I know, I know.');
  assert.equal(strip('He nods slowly. Fair enough.'), 'Fair enough.');
  assert.equal(strip('Okay. His voice softens. I get it.'), 'Okay. I get it.');
  assert.equal(strip("Yeah, sure. Jackie's voice cracks with worry. You alright?"), 'Yeah, sure. You alright?');
});

test('a place of the voice with a delivery in front of the words', () => {
  assert.equal(strip('Over the phone, concerned, hey are you okay?'), 'Hey are you okay?');
  assert.equal(strip('Through the line, softly: I am here.'), 'I am here.');
  assert.equal(strip('On the comm, tired, yeah, one sec.'), 'Yeah, one sec.');
});

test('a speaker label, in any form of the name', () => {
  assert.equal(strip('Jackie: hey V, you alive?'), 'Hey V, you alive?');
  assert.equal(strip('Jackie Welles: hey V.'), 'Hey V.');
  assert.equal(strip('Welles: hey V.'), 'Hey V.');
  assert.equal(strip('Hey. Jackie: you there?'), 'Hey. You there?', 'a label in front of a later sentence');
  assert.equal(stripNarration('Vik: easy, easy.', {name: 'Viktor Vektor', aliases: ['Vik']}), 'Easy, easy.', 'an alias');
});

test('the same with the name written as the persona carries it: the full name, a part of it, an alias', () => {
  assert.equal(stripNarration("Judy's voice over the line, tense, are you there?", {name: 'Judy Alvarez'}), 'Are you there?');
  assert.equal(stripNarration("Alvarez's voice over the line, tense, are you there?", {name: 'Judy Alvarez'}), 'Are you there?');
  assert.equal(stripNarration("Vik's voice drops, weary: sit down.", {name: 'Viktor Vektor', aliases: ['Vik']}), 'Sit down.');
  assert.equal(stripNarration('Kerry laughs: oh, come on.', {name: 'Kerry Eurodyne', aliases: ['Kerry']}), 'Oh, come on.');
});

test('an unnamed person: only the third person forms apply', () => {
  assert.equal(stripNarration('Her voice crackles through the line. Who is this?', {name: ''}), 'Who is this?');
  assert.equal(stripNarration('She says softly: not here.', {name: ''}), 'Not here.');
  assert.equal(stripNarration('He grins. Not bad, kid.', {name: ''}), 'Not bad, kid.');
  assert.equal(stripNarration("Jackie's voice over the phone, concerned, hey?", {name: ''}), "Jackie's voice over the phone, concerned, hey?", 'without a name there is nothing to know the lead by');
});

test('a few other languages, the simple leads only', () => {
  assert.equal(strip('La voz de Jackie por teléfono, preocupada, ¿estás bien?'), '¿estás bien?');
  assert.equal(strip('La voix de Jackie au téléphone, inquiète, ça va ?'), 'Ça va ?');
  assert.equal(strip('Jackie dice: ¿estás bien?'), '¿estás bien?');
  assert.equal(strip('Jackie dit doucement : ça va ?'), 'Ça va ?');
  assert.equal(strip('Jackie sagt leise: alles gut?'), 'Alles gut?');
  assert.equal(strip('Jackie disse baixinho: tudo bem?'), 'Tudo bem?');
  assert.equal(strip('Jackie: ¿estás bien?'), '¿estás bien?', 'a label works in every language');
  // Speech in those languages is untouched.
  assert.equal(strip('Mi voz está rota, necesito agua.'), 'Mi voz está rota, necesito agua.');
  assert.equal(strip('Ma voix est cassée, désolé.'), 'Ma voix est cassée, désolé.');
  assert.equal(strip('Jackie va a amar esto.'), 'Jackie va a amar esto.');
});

// ---- Speech that stays ----------------------------------------------------------------------------------------------------------

test('real speech with the same words is not touched', () => {
  const keep = [
    "Jackie's gonna love this.",
    "Jackie's not here right now.",
    'My voice is shot.',
    'My voice is gone, I screamed all night.',
    'Concerned? Me?',
    'Concerned, me? Never.',
    'Worried, yes. Scared, no.',
    'Softly, softly, we do not wake the whole block.',
    'Quietly, I want out.',
    'Sadly, I cannot do that.',
    'Honestly, over the phone is no way to say it.',
    'Over the phone? Sure.',
    'Over the phone, honestly, I cannot tell.',
    'Over the line is where we talk, not here.',
    'On the phone with Mama, so give me a minute.',
    'She said she would call.',
    'She says hi.',
    'She looks at me like I am crazy.',
    'She smiles at everyone, that is why we love her.',
    'She laughs at everything he says.',
    'Her voice is amazing, you should hear her sing.',
    'Her voice? Never heard it.',
    'His voice is on every radio in the city.',
    'He grinned like a fool when I told him.',
    'They nodded and left, as far as I can tell.',
    'Jackie, listen to me.',
    'Jackie, you are not hearing this.',
    'Jackie and me go way back.',
    'Jackie said it was fine, so it is fine.',
    'Jackie told me he would be late.',
    'Jackie wanted the jacket, not the gun.',
    'I told you, nothing happened.',
    'We sigh, we laugh, we move on.',
    'V, grinning like that is not helping.',
    'Smiling is free, so smile.',
    'Her voice',
    'Voice mail is full.',
  ];
  for (const line of keep) assert.equal(strip(line), line, line);
});

test('a name that is only a part of another word is not a name', () => {
  assert.equal(stripNarration('Jackies voice over the phone, concerned, hey.', {name: 'Jackie Welles'}), 'Jackies voice over the phone, concerned, hey.');
  assert.equal(stripNarration('Welles-Fargo says softly: hi.', {name: 'Jackie Welles'}), 'Welles-Fargo says softly: hi.');
});

test('a sentence that is narration but also asks something is speech', () => {
  assert.equal(strip('Her voice? Never heard it.'), 'Her voice? Never heard it.');
  assert.equal(strip('Hey. Her voice? Never heard it.'), 'Hey. Her voice? Never heard it.');
});

test('a person in the narration lead is speech: the lead names V or the speaker as "I" or "you"', () => {
  assert.equal(strip('Jackie says I should leave.'), 'Jackie says I should leave.');
  assert.equal(strip('Jackie laughs at you, so be careful.'), 'Jackie laughs at you, so be careful.');
  assert.equal(strip('Her voice sounds like yours.'), 'Her voice sounds like yours.');
});

test('nothing to say after the lead: the reply is empty (the host asks once more) and never the narration', () => {
  assert.equal(strip('Jackie smiles warmly.'), '');
  assert.equal(strip('Jackie, grinning.'), '');
});

// ---- The path every text provider goes through ----------------------------------------------------------------------------------

test('cleanReply removes narration for every caller: the finished reply, the stream, the first sentence', () => {
  const reported = "Jackie's voice over the phone, concerned, hey are you okay?";
  assert.equal(cleanReply(reported, {name: 'Jackie Welles'}), 'Hey are you okay?');
  assert.equal(cleanReply(`**Jackie:** ${reported}`, {name: 'Jackie Welles'}), 'Hey are you okay?');
  assert.equal(cleanReply(`"${reported}"`, {name: 'Jackie Welles'}), `"Hey are you okay?"`.slice(1, -1), 'the quotation marks that wrapped the narration and the words');
  assert.equal(cleanReply('Jackie says softly: "I missed you, V."', {name: 'Jackie Welles'}), 'I missed you, V.');
  assert.equal(cleanReply('*sighs* Her voice crackles through the line. (over the phone) Hey V.', {name: 'Jackie Welles'}), 'Hey V.');
  assert.equal(cleanReply('Jackie (over the phone): hey V.', {name: 'Jackie Welles'}), 'Hey V.');
  assert.equal(cleanReply('Jackie\'s gonna love this, V. My voice is shot.', {name: 'Jackie Welles'}), "Jackie's gonna love this, V. My voice is shot.");
  assert.equal(cleanReply("Vik's voice drops. Sit.", {name: 'Viktor Vektor', aliases: ['Vik']}), 'Sit.');
  assert.equal(cleanReply('Hey, V.', {name: 'Jackie Welles'}), 'Hey, V.', 'a reply without narration is unchanged');
  assert.equal(cleanReply('Hey, V.'), 'Hey, V.', 'no name given');
});

test('the persona carries the roster aliases for the cleaning', async () => {
  const roster = JSON.parse(await readFile(new URL('../characters/roster.json', import.meta.url), 'utf8'));
  const book = new PersonaBook(roster);
  assert.ok(book.persona('viktor-vektor').aliases.includes('Vik'));
  assert.equal(book.persona('viktor-vektor').name, 'Viktor Vektor');
  const unnamed = book.persona('not-a-key', 'Somebody');
  assert.equal(unnamed.aliases, undefined, 'an unknown key has no aliases');
});

test('the stream agrees with the finished reply: the first sentence is spoken without the narration, and the rest follows', () => {
  const full = "Jackie's voice over the phone, concerned, hey are you okay? Talk to me. Her voice cracks. What happened?";
  const stream = new ReplyStream({name: 'Jackie Welles', aliases: [], isTag: () => false, speak: false});
  const seen = [];
  for (let at = 1; at <= full.length; at += 3) { stream.update(full.slice(0, at)); seen.push(stream.clean); }
  stream.update(full);
  assert.equal(stream.clean, 'Hey are you okay? Talk to me. What happened?');
  assert.equal(cleanReply(full, {name: 'Jackie Welles'}), stream.clean);
  // The cleaned text only ever grows at its end once a sentence is in it: no step takes back a sentence that an earlier step gave the voice.
  const sentences = text => text.match(/[^.!?]+[.!?]/g) ?? [];
  for (let i = 1; i < seen.length; i++) {
    const before = sentences(seen[i - 1]);
    assert.deepEqual(sentences(seen[i]).slice(0, before.length), before, `step ${i}: ${JSON.stringify(seen[i - 1])} then ${JSON.stringify(seen[i])}`);
  }
  assert.equal(pickHead('Hey are you okay? Talk to me.', {minHeadChars: 5}).text, 'Hey are you okay?');
});

test('a partial reply, cut at a sentence end, is always the start of the finished reply', () => {
  const full = 'Jackie smiles softly. I missed you, V. Her voice drops. Where were you?';
  const finished = cleanReply(full, {name: 'Jackie Welles'});
  assert.equal(finished, 'I missed you, V. Where were you?');
  for (const end of [...full.matchAll(/[.?]/g)].map(match => match.index + 1)) {
    const part = cleanReply(full.slice(0, end), {name: 'Jackie Welles'});
    assert.ok(finished.startsWith(part), `${end}: ${JSON.stringify(part)}`);
  }
});

test('name forms: the full name, each part of three letters or more, the aliases; cheap and cached', () => {
  assert.deepEqual(nameForms('Jackie Welles').forms, ['Jackie Welles', 'Jackie', 'Welles']);
  assert.deepEqual(nameForms('Viktor Vektor', ['Vik', 'Viktor Vektor']).forms, ['Viktor Vektor', 'Viktor', 'Vektor', 'Vik']);
  assert.deepEqual(nameForms('').forms, []);
  assert.equal(nameForms('Jackie Welles'), nameForms('Jackie Welles'), 'the same object for the same name');
  assert.deepEqual(nameForms('Mr. Hands').forms, ['Mr. Hands', 'Hands']);
});

test('speed: a few hundred characters of reply cost far less than a millisecond', () => {
  const reply = "Jackie's voice over the phone, concerned, hey are you okay? Talk to me, choom. Her voice cracks. What happened over there? I heard it all on the line, and I am coming. Hold tight.";
  const plain = 'Yeah, I am fine. It was a long night and the coffee did not help, but the gig went well and the money is in. Where are you now? Tell me and I will drive over right away.';
  for (let i = 0; i < 300; i++) { strip(reply); strip(plain); }
  const rounds = 5000, started = process.hrtime.bigint();
  for (let i = 0; i < rounds; i++) { strip(reply); strip(plain); }
  const perReplyMs = Number(process.hrtime.bigint() - started) / 1e6 / (rounds * 2);
  assert.ok(perReplyMs < 0.25, `${perReplyMs.toFixed(4)} ms per reply`);
});
