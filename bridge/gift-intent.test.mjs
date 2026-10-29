// V offers a gift in words (bridge/gift-intent.mjs): English first, the other menu languages, and what is not an offer (a question, a refusal, a promise, money). Offline.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {screenGift, giftWords, GIFT_LANGUAGES, GIFT_WORDS_MAX} from './gift-intent.mjs';

const offers = line => screenGift(line).offer;

test('English offers', () => {
  for (const line of ['I got you something', 'I got you something, hope you like it', 'here, this is for you', 'Here you go, this is for you.', 'Take this.', 'This is for you',
    'I brought you a tequila', 'I have something for you', 'a little something for you', 'I picked up a gift for you', 'here, take this tequila', 'Got you a present']) {
    assert.equal(offers(line), true, line);
  }
  assert.equal(screenGift('I got you something').language, 'en');
});

test('not offers: a question, a refusal, a promise, a condition, small talk', () => {
  for (const line of ['should I get you something?', 'do you want something for your birthday?', 'I will bring you something tomorrow', "I'll get you a gift one day", 'I do not have a gift for you',
    "I didn't bring you anything", 'if I got you something would you like it', 'take it easy', 'How are you?', '', '   ', 'what is this for you?']) {
    assert.equal(offers(line), false, JSON.stringify(line));
  }
  assert.equal(offers(undefined), false); assert.equal(offers(42), false);
});

test('a gift of money is the Eddies feature\'s, not an item', () => {
  assert.equal(offers('here, take 500 eddies'), false);
  assert.equal(offers("here's 200 eddies for you"), false);
  assert.equal(offers('take this, 1,000 eddies'), false);
  assert.equal(offers('here, take this'), true);
});

test('the other menu languages', () => {
  const lines = {
    es: ['te traje un regalo', 'toma esto', 'esto es para ti', 'tengo algo para ti'],
    fr: ['je t\'ai apporté quelque chose', 'c\'est pour toi', 'j\'ai un cadeau pour toi', 'prends ça'],
    de: ['ich habe dir etwas mitgebracht', 'das ist für dich', 'ein Geschenk für dich', 'nimm das'],
    it: ['ti ho portato un regalo', 'questo è per te', 'ho qualcosa per te', 'prendi questo'],
    pt: ['trouxe um presente para você', 'isso é para você', 'tenho algo para você'],
    pl: ['mam dla ciebie prezent', 'przyniosłem ci coś', 'to dla ciebie'],
    ru: ['это тебе', 'у меня для тебя подарок', 'я тебе кое-что принёс', 'возьми это'],
    uk: ['це тобі', 'у мене для тебе подарунок', 'візьми це'],
    cs: ['mám pro tebe dárek', 'tohle je pro tebe', 'něco jsem ti přinesl'],
    tr: ['sana bir hediye getirdim', 'bu senin için', 'sana bir şey aldım'],
    hu: ['hoztam neked valamit', 'ezt neked hoztam', 'ajándék neked'],
    ja: ['プレゼントを持ってきたよ', 'これをあげる', 'あなたにプレゼント'],
    ko: ['선물을 가져왔어', '이거 받아', '선물이야'],
    zh: ['我给你带了礼物', '这是给你的', '这个给你'],
  };
  for (const [language, list] of Object.entries(lines)) for (const line of list) {
    const result = screenGift(line);
    assert.equal(result.offer, true, `${language}: ${line}`);
  }
  assert.equal(screenGift('это тебе').language, 'ru');
  assert.deepEqual([...GIFT_LANGUAGES].sort(), ['cs', 'de', 'en', 'es', 'fr', 'hu', 'it', 'ja', 'ko', 'pl', 'pt', 'ru', 'tr', 'uk', 'zh']);
});

test('refusals and promises in other languages are not offers', () => {
  for (const line of ['no te traje nada', 'mañana te traeré algo', 'ich habe nichts für dich', 'nie mam dla ciebie nic', 'у меня нет подарка, это не тебе', 'wait, is this for you?']) {
    assert.equal(offers(line), false, line);
  }
});

test('what the game gets: V\'s words, one line, 80 characters', () => {
  assert.equal(giftWords('  I got   you\nsome tequila '), 'I got you some tequila');
  assert.equal(giftWords('x'.repeat(200)).length, GIFT_WORDS_MAX);
  assert.equal(giftWords(undefined), '');
});
