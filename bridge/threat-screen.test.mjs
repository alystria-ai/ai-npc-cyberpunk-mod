import {test} from 'node:test';
import assert from 'node:assert/strict';
import {screenMessage, screenCode, screenedKinds, normalize} from './threat-screen.mjs';

// The screen of V's words for the threat reactions (docs/NPC_THREATS_COMMANDS.md): many phrasings in English and the 15 menu languages, and
// the lines it must refuse (jokes, quotes, questions, denials, talk that only sounds violent). Codes only, never the words, leave the screen.
const code = line => screenCode(screenMessage(line));
function expect(rows, wanted) {
  for (const line of rows) assert.equal(code(line), wanted, line);
}

test('English death threats', () => expect([
  'I will kill you', 'I\'m going to fucking kill you, gonk.', 'Give me your eddies or I\'ll shoot you', 'You\'re dead.', 'You are a dead man',
  'I\'ll put a bullet in your head', 'We\'ll gut you like a fish', 'Your money or your life.', 'Say your prayers', 'Don\'t make me kill you',
  'If you touch her again I\'ll end you', 'I swear I\'ll blow your brains out', 'Imma stab you', 'You\'re gonna die here',
], 'kill'));

test('English threats to hurt and fight challenges', () => expect([
  'I\'ll break your legs', 'Fight me!', 'I\'m gonna beat the shit out of you', 'I\'ll kick your ass', 'Keep talking and I\'ll punch you',
  'I will fuck you up', 'Let\'s take this outside', 'Come at me', 'I\'ll knock your teeth out', 'We\'ll teach you a lesson',
], 'hurt'));

test('English insults at the person', () => expect([
  'You stupid bitch', 'Fuck you', 'you piece of shit', 'You\'re an idiot', 'Screw you, asshole', 'Go fuck yourself',
  'you\'re so pathetic', 'son of a bitch', 'Your mom is a whore',
], 'insult'));

test('English commands begin their clause, or come in a polite question', () => {
  expect(['Get down!', 'Hey you, get down on the ground now!', 'Hands up!', 'On your knees', 'Everybody down!', 'Duck!'], 'get-down');
  expect(['Freeze!', 'Stop right there', 'Don\'t move.', 'Stay where you are', 'Hold it right there', 'Can you stop?', 'Halt!'], 'stop');
  expect(['Get out of the car!', 'Step out of the vehicle', 'Could you get out of the car?', 'Get out, now!'], 'exit-vehicle');
  // A command and a threat in one line: both, and the threat is the strongest one found.
  assert.equal(code('Get out of the car or I\'ll shoot you!'), 'kill+exit-vehicle');
  assert.equal(code('Freeze, you idiot!'), 'insult+stop');
});

test('English: what sounds violent but is not a threat, an insult or a command', () => expect([
  'I could murder a burger', 'You\'re killing me', 'This song kills', 'Killing time before the gig', 'Stop talking', 'stop it', 'Get out of here',
  'I\'ll shoot you a text', 'My boss will kill me', 'They\'ll kill you if you go there', 'I\'ll hit you up later', 'I\'ll beat you at chess',
  'that guy is an idiot', 'you look nice', 'you\'re right', 'I told you to get down', 'Why did you stop?', 'The car is dead',
  'Where did you get that gun?', 'hello', '', '   ',
], 'none'));

test('refusals: jokes, quotes, questions and denials take the line back, and say which', () => {
  expect(['I\'ll kill you lol', 'I\'ll kill you, just kidding', 'Get down haha', 'I\'m gonna kill you 😂', 'you idiot jk'], 'none(joke)');
  expect(['He said "I\'ll kill you"', 'The sign says “get out of the car”', 'She yelled «freeze»'], 'none(quote)');
  expect(['Should I shoot you?', 'Do you want me to kill you?', 'Are you an idiot?', 'Get down?'], 'none(question)');
  expect(['I won\'t hurt you', 'I would never kill you', 'I\'m not going to shoot you'], 'none(negated)');
  // Somebody else's threat is no threat of V's (the nearest subject is not "I").
  assert.equal(code('Nobody is going to hurt you'), 'none');
  assert.equal(code('Any last words?'), 'none(question)', 'even a rhetorical question is left to the model');
  // A denied joke marker makes a line more serious, not less.
  expect(['I\'m not joking, I\'ll kill you', 'No kidding, I will kill you'], 'kill');
});

// Every menu language: a death threat, a threat to hurt or an insult, the three commands, a denial and a joke.
const LANGUAGES = {
  ru: {kill: ['Я тебя убью', 'Ты труп', 'Пристрелю, сука'], hurt: ['Я тебе морду набью', 'Изобью тебя'], insult: ['ты урод', 'Пошёл нахуй'],
    'get-down': ['Ложись!', 'Руки вверх!', 'На землю!'], stop: ['Стой!', 'Не двигайся!', 'Стоп!'], 'exit-vehicle': ['Выходи из машины!', 'Вылезай!'],
    negated: ['Я тебя не убью', 'Я никогда не убью тебя'], joke: ['Я убью тебя, шучу', 'убью тебя ахаха'], serious: ['Я не шучу, я убью тебя']},
  uk: {kill: ['Я тебе вб\'ю', 'Ти труп'], hurt: ['Наб\'ю тобі пику'], insult: ['ти покидьок'], 'get-down': ['Лягай!', 'Руки вгору!'], stop: ['Стій!', 'Не рухайся!'],
    'exit-vehicle': ['Вилазь з машини!'], negated: ['Я тебе не вб\'ю'], joke: ['Вб\'ю тебе, жартую']},
  de: {kill: ['Ich bringe dich um', 'Ich werde dich umbringen', 'Du bist tot'], hurt: ['Ich verprügel dich', 'Ich hau dir eine rein'], insult: ['du Arschloch', 'Fick dich'],
    'get-down': ['Hände hoch!', 'Auf den Boden!'], stop: ['Halt!', 'Keine Bewegung!', 'Bleib stehen!'], 'exit-vehicle': ['Steig aus!', 'Raus aus dem Auto!'],
    joke: ['Ich bring dich um, nur Spaß'], none: ['das ist halt so', 'Ich werde dich nicht umbringen']},
  fr: {kill: ['Je vais te tuer', 'T\'es mort', 'Je te bute'], hurt: ['Je vais te casser la gueule'], insult: ['connard', 'Va te faire foutre'],
    'get-down': ['À terre !', 'Les mains en l\'air !'], stop: ['Ne bouge pas !', 'Plus un geste !'], 'exit-vehicle': ['Sors de la voiture !'],
    negated: ['Je te tue pas'], joke: ['Je vais te tuer mdr'], none: ['c\'est dur', 'Je ne vais pas te tuer']},
  es: {kill: ['Te voy a matar', 'Estás muerto', 'Te mato'], hurt: ['Te voy a partir la cara'], insult: ['hijo de puta', 'Eres un imbécil'],
    'get-down': ['¡Al suelo!', '¡Manos arriba!'], stop: ['¡Alto!', '¡No te muevas!', 'Alto ahí'], 'exit-vehicle': ['Bájate del coche', 'Sal del auto'],
    negated: ['No te voy a matar'], joke: ['Te voy a matar jajaja'], none: ['Es para ti', 'Para mí un café']},
  pt: {kill: ['Vou te matar', 'Você tá morto'], hurt: ['Vou te encher de porrada'], insult: ['filho da puta', 'seu otário'],
    'get-down': ['Mãos ao alto!', 'No chão!'], stop: ['Não se mexa!', 'Fica parado!'], 'exit-vehicle': ['Sai do carro!'],
    negated: ['Não vou te matar'], joke: ['Vou te matar kkkk']},
  it: {kill: ['Ti ammazzo', 'Sei morto'], hurt: ['Ti spacco la faccia'], insult: ['stronzo', 'Vaffanculo'], 'get-down': ['Mani in alto!', 'A terra!'],
    stop: ['Fermo!', 'Non muoverti!'], 'exit-vehicle': ['Scendi dalla macchina!'], negated: ['Non ti ammazzo'], joke: ['Ti ammazzo, scherzo']},
  pl: {kill: ['Zabiję cię', 'Jesteś trupem'], hurt: ['Obiję ci mordę'], insult: ['ty debilu', 'Spierdalaj'], 'get-down': ['Na ziemię!', 'Ręce do góry!'],
    stop: ['Stój!', 'Nie ruszaj się!'], 'exit-vehicle': ['Wysiadaj!'], negated: ['Nie zabiję cię'], joke: ['Zabiję cię xD']},
  cs: {kill: ['Zabiju tě', 'Jsi mrtvej'], hurt: ['Rozbiju ti hubu'], insult: ['ty debile', 'Jdi do prdele'], 'get-down': ['K zemi!', 'Ruce vzhůru!'],
    stop: ['Stůj!', 'Nehýbej se!'], 'exit-vehicle': ['Vystup!', 'Vylez z auta!'], none: ['Nezabiju tě'], joke: ['Zabiju tě, dělám si srandu']},
  hu: {kill: ['Megöllek', 'Halott vagy'], hurt: ['Megverlek'], insult: ['te hülye', 'Baszd meg'], 'get-down': ['A földre!', 'Kezeket fel!'],
    stop: ['Állj!', 'Ne mozdulj!'], 'exit-vehicle': ['Szállj ki!'], none: ['Nem öllek meg'], joke: ['Megöllek, csak viccelek']},
  tr: {kill: ['Seni öldüreceğim', 'Seni öldürmek istiyorum'], hurt: ['Seni döveceğim'], insult: ['şerefsiz', 'Siktir git'], 'get-down': ['Yere yat!', 'Eller yukarı!'],
    stop: ['Dur!', 'Kıpırdama!'], 'exit-vehicle': ['Arabadan in!'], none: ['Seni öldürmeyeceğim'], joke: ['Seni öldüreceğim, şaka']},
  ja: {kill: ['殺してやる', 'ぶっ殺すぞ', '死ね'], hurt: ['ぶん殴るぞ'], insult: ['このクソ野郎'], 'get-down': ['伏せろ！', '手を上げろ！'], stop: ['動くな！', '止まれ！'],
    'exit-vehicle': ['車から降りろ！'], negated: ['殺すつもりはない'], joke: ['冗談だよ、殺してやる']},
  ko: {kill: ['죽여버리겠어', '넌 죽었어'], hurt: ['패버린다'], insult: ['개새끼'], 'get-down': ['엎드려!', '손 들어!'], stop: ['멈춰!', '움직이지 마!'],
    'exit-vehicle': ['차에서 내려!'], joke: ['죽여버린다 ㅋㅋ']},
  zh: {kill: ['我要杀了你', '你死定了', '我要殺了你'], hurt: ['我揍你'], insult: ['王八蛋', '混蛋'], 'get-down': ['趴下！', '舉起手來！'], stop: ['站住！', '别动！', '不許動！'],
    'exit-vehicle': ['下车！', '下車！'], negated: ['我不会杀了你'], joke: ['开玩笑的，杀了你'], none: ['我打你电话']},
};

for (const [language, rows] of Object.entries(LANGUAGES)) {
  test(`${language}: threats, insults, the three commands, denials and jokes`, () => {
    for (const [wanted, lines] of Object.entries(rows)) {
      const result = wanted === 'negated' ? 'none(negated)' : wanted === 'joke' ? 'none(joke)' : wanted === 'serious' ? 'kill' : wanted;
      expect(lines, result);
    }
  });
}

test('a question is no threat in any language', () => {
  for (const line of ['Ты хочешь, чтобы я тебя убил?', 'Willst du, dass ich dich umbringe?', '你想让我杀了你吗？', '¿Quieres que te mate?', 'Ti ammazzo?', 'Убью тебя?'])
    assert.match(code(line), /^none/, line);
});

// The live test of 2026-10-26: a lethal phrasing read as a threat to hurt is a fist fight instead of a gun. Every lethal phrasing is a death threat.
test('lethal phrasings are death threats in English: a bullet in the head, brains blown out, dead, ended, in the ground, flatlined', () => expect([
  'I\'ll put a bullet in your head', 'I\'ll put a bullet in your head, understand?', 'I\'ll put a bullet in your head, you hear me?', 'Shut up or I\'ll put a bullet in your head, idiot',
  'i\'ll put a bullet in ur head', 'I\'ll put a bullet in ya head', 'I\'ll put a bullet through your head', 'I\'ll put a bullet between your eyes', 'I\'ll put one in your head',
  'I\'ll put two in your chest', 'I\'ll put a hole in you', 'I\'ll put a round through your skull', 'I\'ll shoot you in the head', 'I\'ll shoot you in the face',
  'I\'ll blow your brains out', 'I\'ll blow your fucking brains out', 'I\'ll blow your head off', 'You\'re dead', 'You are so dead', 'you\'re dead meat', 'Consider yourself dead',
  'You\'re as good as dead', 'I\'ll end you', 'I\'m going to end you', 'I\'ll put you in the ground', 'I\'ll put you six feet under', 'You\'ll be six feet under by tonight',
  'I\'ll flatline you', 'I\'m gonna flatline you, choom', 'I\'ll zero you', 'I\'ll cut your throat', 'I\'ll snap your neck', 'I\'ll break your neck',
  'You won\'t leave here alive', 'You\'re not leaving here alive', 'I\'ll have you killed', 'Dead man walking',
], 'kill'));

test('lethal phrasings are death threats in the 15 menu languages', () => expect([
  'Ich jag dir eine Kugel in den Kopf', 'Ich puste dir das Hirn weg', 'Du bist so gut wie tot', 'Ich bring dich unter die Erde',
  'Je vais te faire sauter la cervelle', 'Une balle entre les yeux', 'Je vais te faire la peau', 'Six pieds sous terre, toi',
  'Te voy a volar los sesos', 'Te meto un tiro', 'Te voy a enterrar', 'Voy a acabar contigo',
  'Vou estourar seus miolos', 'Uma bala na cabeça', 'Vou te enterrar', 'Vou acabar com você',
  'Ti faccio saltare il cervello', 'Ti sparo in testa', 'Ti metto sottoterra', 'Ti faccio la pelle',
  'Wpakuję ci kulkę w łeb', 'Rozwalę ci łeb', 'Zakopię cię', 'Już po tobie',
  'Ustřelím ti hlavu', 'Kulku mezi oči', 'Zakopu tě', 'Je s tebou konec',
  'Golyót eresztek a fejedbe', 'Kiloccsantom az agyad', 'Elföldellek', 'Végzek veled',
  'Kafana kurşun sıkarım', 'Beynini dağıtırım', 'Seni toprağa gömerim', 'İşini bitiririm',
  'Я тебе мозги вышибу', 'Пущу тебе пулю в лоб', 'Я тебя закопаю', 'Конец тебе',
  'Я тобі мізки виб\'ю', 'Пущу тобі кулю', 'Я тебе закопаю', 'Кінець тобі',
  '頭をぶち抜いてやる', '脳天をぶち抜くぞ', '埋めてやる', 'お前はもう死んでいる',
  '머리를 날려버릴 거야', '머리에 총알 박아줄 거야', '묻어버릴 거야', '넌 끝났어',
  '我要爆你的头', '我把你埋了', '送你上西天', '你完了',
], 'kill'));

test('lethal words that are no threat: games, a bed, a car, treasure, slang, a day at work, a denial', () => {
  for (const line of ['I\'ll end you in chess', 'I\'ll beat you in a race', 'I\'ll put you in the car', 'I\'ll put you down for a nap', 'I\'ll put one in your hand',
    'I\'ll have you picked up at six', 'you\'re dead to me', 'I\'m dead tired', 'Would you put a bullet in my head?', 'Я закопаю клад', '저세상 텐션이네',
    'Heute ist dein letzter Tag im Büro', 'Ich werde dich nicht unter die Erde bringen', '你完了吗？'])
    assert.match(code(line), /^none/, line);
  assert.equal(code('I won\'t put a bullet in your head'), 'none(negated)');
  assert.equal(code('I\'ll put a bullet in your head lol'), 'none(joke)');
});

test('a question tag after a threat or a command is no question; a real question still is', () => {
  assert.equal(code('Do that again and I\'ll put a bullet in your head, understand?'), 'kill');
  assert.equal(code('I\'ll break your legs, got it?'), 'hurt');
  assert.equal(code('Ich bring dich um, verstanden?'), 'kill');
  assert.equal(code('Я тебя убью, понял?'), 'kill');
  assert.equal(code('Should I kill you?'), 'none(question)');
  assert.equal(code('Will you put a bullet in my head, right?'), 'none');
});

test('normalize: one case, one apostrophe, no inverted marks', () => {
  assert.equal(normalize('  I’LL  KILL  you  '), 'i\'ll kill you');
  assert.equal(normalize('¡Al suelo!'), 'al suelo!');
  assert.equal(normalize(null), '');
});

test('screenedKinds: a fight needs words that earn it, a command needs that command, and leave and police stay the model\'s', () => {
  const all = ['leave', 'call-police', 'attack', 'cower', 'brawl', 'get-down', 'stop', 'exit-vehicle'];
  const kinds = line => screenedKinds(all, screenMessage(line)).join(',');
  assert.equal(kinds('Nice weather today'), 'leave,call-police', 'a calm line offers no fight, no cower and no command');
  assert.equal(kinds('I will kill you'), 'leave,call-police,attack,cower', 'a death threat: the weapon, never the fists');
  assert.equal(kinds('I\'ll break your legs'), 'leave,call-police,cower,brawl', 'a threat to hurt: fists');
  assert.equal(kinds('You piece of shit'), 'leave,call-police,brawl', 'an insult: fists, and nobody cowers at an insult');
  assert.equal(kinds('Get down!'), 'leave,call-police,get-down');
  assert.equal(kinds('Get out of the car or I\'ll shoot you'), 'leave,call-police,attack,cower,exit-vehicle');
  assert.equal(kinds('I\'ll kill you lol'), 'leave,call-police');
  // The offer's own order is kept and nothing is added.
  assert.deepEqual(screenedKinds(['stop', 'leave'], screenMessage('Freeze!')), ['stop', 'leave']);
  assert.deepEqual(screenedKinds(['attack'], screenMessage('hello')), []);
  assert.deepEqual(screenedKinds(undefined, null), []);
});

test('the screen is cheap: a long message is read in a few milliseconds', () => {
  const long = 'I really think that we should go to the market and buy some food before it closes, '.repeat(20) + 'or I will kill you.';
  const started = performance.now();
  for (let index = 0; index < 20; index++) assert.equal(code(long), 'kill');
  assert.ok((performance.now() - started) / 20 < 15, 'one long message under 15 ms');
});

// Live test 3 (2026-10-27, game 2.31): what V said to street people and to Tyger Claws, and what the screen used to miss.
test('live test 3: "get lost or I\'ll kill you" and conditions with no object are death threats; insults and dares at a ganger are read', () => {
  expect(['get lost or I\'ll kill you', 'Get lost or I\'ll kill you!', 'get lost, or I will kill you', 'move or I\'ll shoot', 'back off before I blast',
    'walk away or else I\'m gonna waste you'], 'kill');
  expect(['you\'re weak', 'you\'re nothing', 'you\'re soft', 'your gang is trash', 'Tyger Claws are scum', 'you Tyger Claws are a bunch of pussies',
    'pussy', 'Coward!', 'you little wimp', 'fuck the tyger claws', 'you\'re a bunch of losers', 'your boys are nothing but cowards',
    'Maelstrom are trash'], 'insult');
  expect(['you don\'t scare me', 'bring it on', 'come on, bring it', 'try me', 'make me', 'I dare you', 'I\'m not scared of you',
    'what are you gonna do about it', 'hand over your eddies', 'give me your money', 'gimme all your cash'], 'hurt');
  for (const line of ['you\'re nothing like him', 'you\'re soft spoken', 'you\'re nothing special', 'bring it here', 'make me a sandwich',
    'or I\'ll shoot it', 'I\'ll shoot the target', 'give me your hand', 'try me lol', 'what are you gonna do about it?', 'the tygers are open late'])
    assert.match(code(line), /^none/, line);
});
