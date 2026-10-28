import {test} from 'node:test';
import assert from 'node:assert/strict';
import {punctuateForSpeech} from './speech-punctuation.mjs';
import {MOD_LANGUAGES} from './speech-language.mjs';

// [language, line as typed or recognised, line as handed to the voice]
const CASES = [
  // English: the owner's own examples
  ['en', 'hey whats up', 'Hey, whats up?'],
  ['en', 'where are we going', 'Where are we going?'],
  ['en', 'i think we should go', 'I think we should go.'],
  ['en', 'ok', 'Ok.'],
  ['en', 'yes', 'Yes.'],
  // English: questions
  ['en', 'who is that', 'Who is that?'],
  ['en', "what's the plan", "What's the plan?"],
  ['en', 'hows it going', 'Hows it going?'],
  ['en', 'why not', 'Why not?'],
  ['en', 'how much for the car', 'How much for the car?'],
  ['en', 'which way', 'Which way?'],
  ['en', 'is she coming with us', 'Is she coming with us?'],
  ['en', 'are we there yet', 'Are we there yet?'],
  ['en', 'do you trust me', 'Do you trust me?'],
  ['en', 'did that work', 'Did that work?'],
  ['en', 'can you hear me', 'Can you hear me?'],
  ['en', 'could we stop for food', 'Could we stop for food?'],
  ['en', 'will they follow us', 'Will they follow us?'],
  ['en', 'would you do it again', 'Would you do it again?'],
  ['en', 'should we wait', 'Should we wait?'],
  ['en', 'have you seen her', 'Have you seen her?'],
  ['en', 'has anyone checked the roof', 'Has anyone checked the roof?'],
  ['en', 'is the car ready', 'Is the car ready?'],
  ['en', "isn't it late", "Isn't it late?"],
  ['en', 'ok so where are we going', 'Ok, so where are we going?'],
  ['en', 'hey can you hear me', 'Hey, can you hear me?'],
  ['en', 'when are we leaving', 'When are we leaving?'],
  ['en', 'when', 'When?'],
  ['en', 'sup', 'Sup?'],
  ['en', 'Okay. where are we going', 'Okay. where are we going?'],
  ['en', 'where are we going. wait', 'Where are we going. wait.'],
  // English: tags
  ['en', 'we should go, right', 'We should go, right?'],
  ['en', 'you are coming, ok', 'You are coming, ok?'],
  ['en', 'that was fun, yeah', 'That was fun, yeah?'],
  ['en', 'we go in quietly right', 'We go in quietly right?'],
  ['en', 'you know the way huh', 'You know the way huh?'],
  // English: not questions
  ['en', 'turn right', 'Turn right.'],
  ['en', 'i did it right', 'I did it right.'],
  ['en', 'that sounds ok', 'That sounds ok.'],
  ['en', "i'm ok", "I'm ok."],
  ['en', 'do it now', 'Do it now.'],
  ['en', 'do not touch that', 'Do not touch that.'],
  ['en', "don't move", "Don't move."],
  ['en', 'have a seat', 'Have a seat.'],
  ['en', 'what a day', 'What a day.'],
  ['en', 'whatever you say', 'Whatever you say.'],
  ['en', 'how beautiful', 'How beautiful.'],
  ['en', 'when i get back we talk', 'When i get back we talk.'],
  ['en', 'look at that', 'Look at that.'],
  ['en', 'listen to me', 'Listen to me.'],
  ['en', 'well done', 'Well done.'],
  ['en', 'wait for me', 'Wait for me.'],
  ['en', 'I said yeah', 'I said yeah.'],
  // English: marks that are already there stay as they are
  ['en', 'Hey V.', 'Hey V.'],
  ['en', 'Where are you?', 'Where are you?'],
  ['en', 'No way!', 'No way!'],
  ['en', 'wait... what', 'Wait... what?'],
  ['en', 'hmm...', 'Hmm...'],
  ['en', 'well…', 'Well…'],
  ['en', 'what?!', 'What?!'],
  ['en', 'Hey Judy, how are you holding up?', 'Hey Judy, how are you holding up?'],
  ['en', '"where are you?"', '"where are you?"'.replace('w', 'W')],
  ['en', 'she said "stop"', 'She said "stop".'],
  ['en', '(laughs)', '(Laughs).'],
  ['en', 'hey, whats up', 'Hey, whats up?'],
  ['en', 'ok then,', 'Ok, then.'],
  ['en', 'wait -', 'Wait.'],
  ['en', '  spaced out  ', 'Spaced out.'],
  // English: emoticons, emoji and links are not punctuated again
  ['en', 'nice one :)', 'Nice one :)'],
  ['en', 'thanks :D', 'Thanks :D'],
  ['en', 'lol xD', 'Lol xD'],
  ['en', 'love you <3', 'Love you <3'],
  ['en', 'see you ^_^', 'See you ^_^'],
  ['en', 'good job 👍', 'Good job 👍'],
  ['en', 'check www.example.com', 'Check www.example.com'],
  ['en', 'look at https://example.com/page?x=1', 'Look at https://example.com/page?x=1'],
  ['en', 'mail me at v@example.com', 'Mail me at v@example.com'],
  ['en', 'https://example.com is great', 'https://example.com is great.'],
  ['en', 'iPhone is better', 'iPhone is better.'],
  ['en', '3 minutes left', '3 minutes left.'],
  ['en', 'i need 5', 'I need 5.'],
  ['en', 'see you at 10pm~', 'See you at 10pm~'],
  // German
  ['de', 'wo gehen wir hin', 'Wo gehen wir hin?'],
  ['de', 'was machst du da', 'Was machst du da?'],
  ['de', 'warum nicht', 'Warum nicht?'],
  ['de', 'wie spät ist es', 'Wie spät ist es?'],
  ['de', 'kannst du mir helfen', 'Kannst du mir helfen?'],
  ['de', 'ist das dein ernst', 'Ist das dein ernst?'],
  ['de', 'hast du das gesehen', 'Hast du das gesehen?'],
  ['de', 'sag mal wo warst du', 'Sag mal wo warst du?'],
  ['de', 'ich glaube wir sollten gehen', 'Ich glaube wir sollten gehen.'],
  ['de', 'wie gesagt ich komme später', 'Wie gesagt ich komme später.'],
  ['de', 'gib mir das', 'Gib mir das.'],
  ['de', 'das ist gut, oder', 'Das ist gut, oder?'],
  ['de', 'ärger gibt es immer', 'Ärger gibt es immer.'],
  ['de', 'ßtraße', 'ßtraße.'],
  // French
  ['fr', 'où est-ce qu on va', 'Où est-ce qu on va?'],
  ['fr', "qu'est-ce que tu fais", "Qu'est-ce que tu fais?"],
  ['fr', 'pourquoi pas', 'Pourquoi pas?'],
  ['fr', 'comment ça va', 'Comment ça va?'],
  ['fr', 'peux-tu venir', 'Peux-tu venir?'],
  ['fr', 'as-tu vu ça', 'As-tu vu ça?'],
  ['fr', 'est-ce que tu viens', 'Est-ce que tu viens?'],
  ['fr', 'combien ça coûte', 'Combien ça coûte?'],
  ['fr', 'quand part-on', 'Quand part-on?'],
  ['fr', 'je pense que nous devrions partir', 'Je pense que nous devrions partir.'],
  ['fr', 'quand je suis arrivé il était déjà parti', 'Quand je suis arrivé il était déjà parti.'],
  ['fr', "d'accord on y va", "D'accord on y va."],
  ['fr', 'on y va, hein', 'On y va, hein?'],
  // Spanish
  ['es', 'dónde vamos', 'Dónde vamos?'],
  ['es', 'qué pasa', 'Qué pasa?'],
  ['es', 'cómo estás', 'Cómo estás?'],
  ['es', 'donde vamos', 'Donde vamos?'],
  ['es', 'como estas', 'Como estas?'],
  ['es', 'que pasa', 'Que pasa?'],
  ['es', 'por qué no', 'Por qué no?'],
  ['es', 'puedes ayudarme', 'Puedes ayudarme?'],
  ['es', '¿quién es', '¿Quién es?'],
  ['es', 'creo que deberíamos irnos ya mismo', 'Creo que deberíamos irnos ya mismo.'],
  ['es', 'como tú quieras amigo mío', 'Como tú quieras amigo mío.'],
  ['es', 'vamos, verdad', 'Vamos, verdad?'],
  ['es', 'hay que irse', 'Hay que irse.'],
  // Italian
  ['it', 'dove andiamo', 'Dove andiamo?'],
  ['it', 'che cosa vuoi', 'Che cosa vuoi?'],
  ['it', 'perché no', 'Perché no?'],
  ['it', 'puoi aiutarmi', 'Puoi aiutarmi?'],
  ['it', 'come stai', 'Come stai?'],
  ['it', 'penso che dovremmo andare adesso', 'Penso che dovremmo andare adesso.'],
  ['it', 'andiamo, vero', 'Andiamo, vero?'],
  // Portuguese
  ['pt', 'onde vamos', 'Onde vamos?'],
  ['pt', 'o que você quer', 'O que você quer?'],
  ['pt', 'por que não', 'Por que não?'],
  ['pt', 'pode me ajudar', 'Pode me ajudar?'],
  ['pt', 'eu acho que devemos ir agora mesmo', 'Eu acho que devemos ir agora mesmo.'],
  ['pt', 'vamos, né', 'Vamos, né?'],
  // Polish
  ['pl', 'gdzie idziemy', 'Gdzie idziemy?'],
  ['pl', 'co robisz', 'Co robisz?'],
  ['pl', 'czy to prawda', 'Czy to prawda?'],
  ['pl', 'dlaczego nie', 'Dlaczego nie?'],
  ['pl', 'jak się masz', 'Jak się masz?'],
  ['pl', 'myślę że powinniśmy już iść', 'Myślę że powinniśmy już iść.'],
  // Russian and Ukrainian (the script decides between them)
  ['ru', 'куда мы идем', 'Куда мы идем?'],
  ['ru', 'что делать', 'Что делать?'],
  ['ru', 'как дела', 'Как дела?'],
  ['ru', 'ты придешь ли', 'Ты придешь ли?'],
  ['ru', 'я думаю нам пора идти', 'Я думаю нам пора идти.'],
  ['ru', 'пойдем, ладно', 'Пойдем, ладно?'],
  ['uk', 'куди ми йдемо', 'Куди ми йдемо?'],
  ['uk', 'чому ні', 'Чому ні?'],
  ['uk', 'я думаю нам час іти', 'Я думаю нам час іти.'],
  ['uk', 'де ми', 'Де ми?'],
  // Turkish (dotted and dotless i)
  ['tr', 'nereye gidiyoruz', 'Nereye gidiyoruz?'],
  ['tr', 'ne yapıyorsun', 'Ne yapıyorsun?'],
  ['tr', 'bu iyi mi', 'Bu iyi mi?'],
  ['tr', 'gelir misin', 'Gelir misin?'],
  ['tr', 'ıslık çalıyorum', 'Islık çalıyorum.'],
  ['tr', 'iyi bir fikir', 'İyi bir fikir.'],
  ['tr', 'bence artık gitmeliyiz', 'Bence artık gitmeliyiz.'],
  // Czech
  ['cs', 'kam jdeme', 'Kam jdeme?'],
  ['cs', 'kdo to je', 'Kdo to je?'],
  ['cs', 'můžeš mi pomoct', 'Můžeš mi pomoct?'],
  ['cs', 'myslím že bychom měli jít', 'Myslím že bychom měli jít.'],
  // Hungarian
  ['hu', 'hova megyünk', 'Hova megyünk?'],
  ['hu', 'miért nem', 'Miért nem?'],
  ['hu', 'szerintem indulnunk kellene', 'Szerintem indulnunk kellene.'],
  ['hu', 'megyünk, ugye', 'Megyünk, ugye?'],
  // Japanese
  ['ja', 'どこに行くの', 'どこに行くの？'],
  ['ja', '大丈夫ですか', '大丈夫ですか？'],
  ['ja', '何してるの', '何してるの？'],
  ['ja', '行こう', '行こう。'],
  ['ja', 'そうだね', 'そうだね。'],
  ['ja', '行きましょう。', '行きましょう。'],
  ['ja', 'どこに行くの？', 'どこに行くの？'],
  // Korean
  ['ko', '어디 가', '어디 가?'],
  ['ko', '뭐 해', '뭐 해?'],
  ['ko', '괜찮아요', '괜찮아요.'],
  ['ko', '지금 갈까요', '지금 갈까요?'],
  ['ko', '가자', '가자.'],
  ['ko', '어디 가?', '어디 가?'],
  // Chinese (simplified and traditional)
  ['zh', '你好吗', '你好吗？'],
  ['zh', '我们去哪里', '我们去哪里？'],
  ['zh', '你在做什么', '你在做什么？'],
  ['zh', '我们走吧', '我们走吧。'],
  ['zh', '今天天气很好', '今天天气很好。'],
  ['zh', '你在做什麼', '你在做什麼？'],
  ['zh', '我们走吧！', '我们走吧！'],
  ['zh', '好不好', '好不好？'],
];

test('lines are punctuated for speech, in the 15 languages of the mod', () => {
  const failures = [];
  for (const [language, line, expected] of CASES) {
    const got = punctuateForSpeech(line, {language});
    if (got !== expected) failures.push(`${language}: ${JSON.stringify(line)} -> ${JSON.stringify(got)}, expected ${JSON.stringify(expected)}`);
  }
  assert.deepEqual(failures, []);
  const covered = new Set(CASES.map(([language]) => language));
  for (const language of MOD_LANGUAGES) assert.ok(covered.has(language), `${language} has cases`);
});

test('it is idempotent: a finished line comes back unchanged, whatever the language', () => {
  for (const [language, line, expected] of CASES) {
    assert.equal(punctuateForSpeech(expected, {language}), expected, `${language}: ${JSON.stringify(expected)}`);
    const once = punctuateForSpeech(line, {language});
    assert.equal(punctuateForSpeech(once, {language}), once, `${language}: ${JSON.stringify(line)}`);
  }
});

test('the language code may be a regional one or missing; the script of the line settles Japanese, Korean, Chinese and Cyrillic', () => {
  assert.equal(punctuateForSpeech('onde vamos', {language: 'pt-BR'}), 'Onde vamos?');
  assert.equal(punctuateForSpeech('你好吗', {language: 'zh-cn'}), '你好吗？');
  assert.equal(punctuateForSpeech('where to', {}), 'Where to?');
  assert.equal(punctuateForSpeech('where to'), 'Where to?');
  assert.equal(punctuateForSpeech('where to', {language: 'xx'}), 'Where to?');
  assert.equal(punctuateForSpeech('куда мы', {language: 'en'}), 'Куда мы?');
  assert.equal(punctuateForSpeech('куди ми', {language: 'uk'}), 'Куди ми?');
  assert.equal(punctuateForSpeech('どこ行く', {language: 'en'}), 'どこ行く？');
  assert.equal(punctuateForSpeech('어디 가', {language: 'en'}), '어디 가?');
  // A Latin line in a language whose script it does not use is read as English.
  assert.equal(punctuateForSpeech('where are we going', {language: 'ja'}), 'Where are we going?');
});

test('nothing speakable, and anything that is not a string, comes back as it was', () => {
  assert.equal(punctuateForSpeech(''), '');
  assert.equal(punctuateForSpeech('   '), '');
  assert.equal(punctuateForSpeech('...'), '...');
  assert.equal(punctuateForSpeech(' ?! '), '?!');
  assert.equal(punctuateForSpeech(undefined), undefined);
  assert.equal(punctuateForSpeech(null), null);
  assert.equal(punctuateForSpeech(5), 5);
});

test('it costs microseconds a line, with no model call', () => {
  const lines = CASES.map(([language, line]) => [line, {language}]);
  for (const [line, options] of lines) punctuateForSpeech(line, options);   // warm up
  const rounds = 200, began = performance.now();
  for (let round = 0; round < rounds; round++) for (const [line, options] of lines) punctuateForSpeech(line, options);
  const perLine = (performance.now() - began) * 1000 / (rounds * lines.length);
  assert.ok(perLine < 100, `${perLine.toFixed(1)} microseconds a line`);
  // A long line stays cheap too.
  const long = 'word '.repeat(48).trim();
  const start = performance.now();
  for (let n = 0; n < 1000; n++) punctuateForSpeech(long);
  assert.ok((performance.now() - start) / 1000 < 0.5);
});
