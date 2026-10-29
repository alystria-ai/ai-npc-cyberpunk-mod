// V gives a character a gift, read from V's words (docs/BOND_QUESTS.md 17.1, docs/QUEST_PRIMITIVES.md 10.3): "I got you something", "here, this is for you", "take this".
// No model and no I/O: a few regular expressions over a short line, run after the reply is published (bridge/bond-pack-runner.mjs afterTurn), only while a stage waits for
// a gift. English is read first, then the other menu languages (the ones bridge/eddies-languages.mjs reads). A money gift ("here, take 500 eddies") is the Eddies feature's
// own and is never a gift item. A question, a refusal, a promise ("I'll bring you something tomorrow") and a joke are not offers.
import {screenWords} from './eddies.mjs';

/** What the game gets with the offer: V's words, trimmed (the game matches the item V named against V's inventory). */
export const GIFT_WORDS_MAX = 80;

const CJK = new Set(['ja', 'ko', 'zh']);
// Combining marks (accents, the Cyrillic breve and diaeresis) are dropped so a line typed without them matches; kana and Hangul are left whole.
const fold = text => text.normalize('NFD').replace(/[̀-ͯ]/g, '').normalize('NFC').replace(/[łđøıßœæ]/gu, c => ({ł: 'l', đ: 'd', ø: 'o', ı: 'i', ß: 'ss', œ: 'oe', æ: 'ae'})[c]);
const prepare = text => fold(String(text ?? '').slice(0, 600).normalize('NFKC').toLowerCase().replace(/[‘’ʼ`´]/g, "'"));

// Per language: `offer` is the phrases of an offer (regular-expression source), `no` the words that make the clause a refusal or a promise. Sources are written folded.
const DATA = {
  en: {
    offer: String.raw`(?:i(?:'ve| have)? (?:got|bought|brought|made|picked up|found|grabbed) (?:you |u |ya )?(?:something|a (?:gift|present)|this|these|it)(?: for you| for ya)?|i got you|got you (?:something|a (?:gift|present)|this)|i brought you|brought you|(?:here|here's|here is|heres)[, ]+(?:this|these|it|a (?:gift|present)|something)(?: is| are)?(?: for you| for ya)?|(?:this|these|it)(?: is| are|'s) (?:for you|yours|a (?:gift|present) for you|my gift)|(?:this|these) (?:is|are) for you|for you[,. ]+(?:a (?:gift|present)|take (?:it|this))|a (?:gift|present) for you|(?:take|have) (?:this|these|it)(?! easy| back| out| from| off)(?:,? it'?s for you)?|i have something for you|have something for you|(?:i|i'?d) (?:wanted|want|like) to give you (?:something|this|a (?:gift|present))|get you something|give you this|giving you this|a little something for you|something for you)`,
    no: String.raw`(?:don'?t|do not|didn'?t|not|never|won'?t|will not|can'?t|cannot|no|nothing|nobody|if|would|should|could|might|maybe|gonna|going to|i'?ll|i will|i'?d|later|tomorrow|someday|next time|once|when i|joking|kidding|wish|want you to get|should i|what)`,
  },
  es: {
    offer: String.raw`(?:te (?:traje|he traido|compre|consegui|encontre|prepare) (?:algo|esto|un regalo|un detalle)|tengo (?:algo|un regalo|un detalle) para ti|esto es para ti|es para ti|un regalo para ti|toma(?:,)? (?:esto|este|esta|eso)|toma esto|te regalo|algo para ti|ten(?:,)? (?:esto|toma))`,
    no: String.raw`(?:no |nunca|nada|ni |si |quiza|tal vez|manana|despues|luego|algun dia|voy a|\?)`,
  },
  fr: {
    offer: String.raw`(?:je t'ai (?:apporte|ramene|achete|pris|trouve|fait) (?:quelque chose|un truc|un cadeau|ca|ceci)|j'ai (?:quelque chose|un truc|un cadeau|un petit cadeau) pour toi|c'est pour toi|un (?:petit )?cadeau pour toi|prends (?:ca|ceci|le)|tiens(?:,)? (?:prends|voila|c'est)|voila pour toi|pour toi,? (?:prends|tiens))`,
    no: String.raw`(?:\bne\b|\bpas\b|jamais|rien|\bsi\b|peut-etre|demain|plus tard|un jour|je vais|je ferai)`,
  },
  de: {
    offer: String.raw`(?:ich hab(?:e)? (?:dir )?(?:was|etwas) (?:mitgebracht|besorgt|gekauft|gefunden|dabei)|ich hab(?:e)? (?:was|etwas|ein geschenk) fur dich|das ist fur dich|(?:hier,? )?(?:das )?ist fur dich|ein geschenk fur dich|nimm (?:das|dies|es)|hier,? nimm|etwas fur dich|was fur dich)`,
    no: String.raw`(?:\bnicht\b|\bnie\b|niemals|nichts|\bkein|\bwenn\b|vielleicht|morgen|spater|irgendwann|ich werde|ich will dir)`,
  },
  it: {
    offer: String.raw`(?:ti ho (?:portato|comprato|preso|trovato|preparato) (?:qualcosa|una cosa|un regalo|questo)|ho (?:qualcosa|una cosa|un regalo) per te|questo e per te|e per te|un regalo per te|prendi (?:questo|questa|ce)|tieni(?:,)? (?:questo|prendi|e per te)?|qualcosa per te)`,
    no: String.raw`(?:\bnon\b|\bmai\b|niente|\bse\b|forse|domani|dopo|un giorno|ti porter|ti compro)`,
  },
  pt: {
    offer: String.raw`(?:trouxe (?:algo|uma coisa|um presente|isso|isto)|te trouxe|comprei (?:algo|uma coisa|um presente) (?:para|pra) (?:voce|ti)|tenho (?:algo|um presente|uma coisa) (?:para|pra) (?:voce|ti)|(?:isso|isto|esse|este) e (?:para|pra) (?:voce|ti)|e (?:para|pra) (?:voce|ti)|um presente (?:para|pra) (?:voce|ti)|toma(?:,)? (?:isto|isso)|pega (?:isso|isto)|algo (?:para|pra) (?:voce|ti))`,
    no: String.raw`(?:\bnao\b|nunca|nada|\bse\b|talvez|amanha|depois|um dia|vou te)`,
  },
  pl: {
    offer: String.raw`(?:mam dla ciebie (?:cos|prezent|upominek)|przyniosl(?:em|am) ci (?:cos|prezent)|kupilem ci|kupilam ci|to dla ciebie|prezent dla ciebie|cos dla ciebie|(?:wez|masz) (?:to|tu)|masz,? to dla ciebie)`,
    no: String.raw`(?:\bnie\b|nigdy|nic|\bjesli\b|moze|jutro|pozniej|kiedys|zamierzam|przyniose)`,
  },
  ru: {
    offer: String.raw`(?:я (?:тебе )?(?:кое-что )?(?:принес|принесла|купил|купила|нашел|нашла)(?: тебе)?(?: кое-что| подарок)?|у меня для тебя (?:кое-что|подарок)|это (?:тебе|для тебя)|подарок для тебя|вот,? (?:держи|возьми|это тебе)|держи|возьми (?:это|вот)|тебе подарок|кое-что для тебя)`,
    no: String.raw`(?:(?<![\p{L}])не(?![\p{L}])|никогда|ничего|(?<![\p{L}])если|может|завтра|потом|когда-нибудь|собираюсь|принесу|куплю)`,
  },
  uk: {
    offer: String.raw`(?:я (?:тобі )?(?:дещо|щось)? ?(?:приніс|принесла|купив|купила|знайшов|знайшла)(?: тобі)?(?: дещо| подарунок)?|у мене для тебе (?:дещо|щось|подарунок)|це (?:тобі|для тебе)|подарунок для тебе|ось,? (?:тримай|візьми)|тримай|візьми це|тобі подарунок|дещо для тебе)`,
    no: String.raw`(?:(?<![\p{L}])не(?![\p{L}])|ніколи|нічого|(?<![\p{L}])якщо|може|завтра|потім|колись|принесу|куплю)`,
  },
  cs: {
    offer: String.raw`(?:neco jsem ti (?:prinesl|prinesla|koupil|koupila)|mam pro tebe (?:neco|darek)|tohle je pro tebe|je to pro tebe|darek pro tebe|vezmi si (?:to|tohle)|tady mas|neco pro tebe)`,
    no: String.raw`(?:(?<![\p{L}])ne(?![\p{L}])|nikdy|nic|(?<![\p{L}])kdyz|mozna|zitra|pozdeji|nekdy|prinesu)`,
  },
  tr: {
    offer: String.raw`(?:sana (?:bir sey|bisey|bir hediye) (?:getirdim|aldim|buldum|hazirladim)|sana hediye|senin icin (?:bir sey|bisey|bir hediye) (?:aldim|getirdim)|bu senin icin|senin icin|hediye getirdim|al (?:bunu|sunu)|bu sana)`,
    no: String.raw`(?:degil|asla|hicbir|yok|eger|belki|yarin|sonra|bir gun|getirecegim)`,
  },
  hu: {
    offer: String.raw`(?:hoztam (?:neked )?valamit|valamit hoztam|van valamim neked|ezt neked hoztam|ez neked van|ajandek neked|ajandekot hoztam|vettem neked valamit|fogd (?:ezt|meg)|vedd el)`,
    no: String.raw`(?:(?<![\p{L}])nem(?![\p{L}])|soha|semmi|(?<![\p{L}])ha(?![\p{L}])|talan|holnap|kesobb|egyszer|hozok)`,
  },
  ja: {
    offer: String.raw`(?:プレゼント(?:を)?(?:持って|買って|用意|あげる|渡)|これ(?:を)?あげる|これ(?:を)?(?:どうぞ|受け取って|あげるよ)|あなたに(?:プレゼント|贈り物)|君に(?:プレゼント|贈り物|渡したいもの)|これ(?:は)?(?:あなた|君|お前)の(?:ため|もの)|お土産(?:を)?(?:持って|買って)|贈り物(?:を)?(?:持って|買って))`,
    no: String.raw`(?:ない|ません|じゃない|もし|明日|いつか|後で|あとで|つもり)`,
  },
  ko: {
    offer: String.raw`(?:선물(?:을)? ?(?:가져왔|준비했|샀|줄게|드릴게)|너(?:한테|에게) 줄 (?:게|거|것) ?(?:있어|있는데)?|이거 (?:너|당신) (?:줄게|거야)|이거 받아|선물이야|선물 줄게|이거 (?:선물|드릴게))`,
    no: String.raw`(?:않|안 |없|아니|만약|내일|언젠가|나중에|할 거)`,
  },
  zh: {
    offer: String.raw`(?:我给你带了|给你带了(?:点|个)?(?:东西|礼物)|这是给你的|送你|给你(?:一份|个)?礼物|这个给你|拿着这个|收下|我有(?:东西|礼物)给你|我给你买了|给你的礼物)`,
    no: String.raw`(?:不|没|别|如果|明天|以后|改天|打算|会给)`,
  },
};

const compiled = new Map();
function rulesOf(language) {
  if (compiled.has(language)) return compiled.get(language);
  const data = DATA[language];
  const cjk = CJK.has(language);
  const start = cjk ? '' : String.raw`(?<![\p{L}\p{N}])`;
  const rules = {
    offer: new RegExp(`${start}(?:${fold(data.offer)})`, 'iu'),
    no: new RegExp(language === 'en' ? String.raw`(?<![\p{L}\p{N}'])(?:${fold(data.no)})(?![\p{L}\p{N}])` : fold(data.no), 'iu'),
  };
  compiled.set(language, rules);
  return rules;
}
export const GIFT_LANGUAGES = Object.freeze(Object.keys(DATA));

// Which languages are worth trying for a line: English always first; a script narrows the rest so a Russian line does not run the Latin patterns.
function candidates(line) {
  const out = ['en'];
  if (/[぀-ヿ]/.test(line)) out.push('ja');
  if (/[가-힯]/.test(line)) out.push('ko');
  if (/[一-鿿]/.test(line)) out.push('zh', 'ja');
  if (/[Ѐ-ӿ]/.test(line)) out.push('ru', 'uk');
  if (/[a-z]/.test(line) && !/[぀-鿿가-힯]/.test(line)) out.push('es', 'fr', 'de', 'it', 'pt', 'pl', 'cs', 'tr', 'hu');
  return out;
}

// A clause ends at . ! ? ; and a comma that is not inside a number; the terminator stays with it so a question can be told.
const CLAUSES = /[^.!?;,。！？；、，]+[.!?;,。！？；、，]*/gu;

/**
 * V's line, read for a gift offer: {offer: true, language} or {offer: false}. The line must offer something now, to the character: a question, a refusal, a promise or a
 * condition is no offer, and neither is a gift of money (the Eddies feature reads that).
 */
export function screenGift(text) {
  if (typeof text !== 'string' || !text.trim()) return {offer: false};
  const raw = text.slice(0, 600);
  // Money is the Eddies feature's own: a sum or a money intent in the line.
  try { const money = screenWords(raw); if (money.intent === 'give' && money.amount !== null) return {offer: false}; } catch { /* the money screen never blocks a gift */ }
  const line = prepare(raw);
  for (const language of candidates(line)) {
    const rules = rulesOf(language);
    for (const clause of line.match(CLAUSES) ?? []) {
      const match = rules.offer.exec(clause);
      if (!match) continue;
      if (/[?？]\s*$/.test(clause)) continue;
      // The words of the clause around the offer: English refusals and conditions are matched before the offer only, so "here, take this, I won't be long" still gives.
      const before = clause.slice(0, match.index + (CJK.has(language) ? match[0].length : 0));
      const scope = language === 'en' || CJK.has(language) ? (CJK.has(language) ? clause : before) : clause;
      if (rules.no.test(scope)) continue;
      return {offer: true, language};
    }
  }
  return {offer: false};
}

/** V's words trimmed to what the game gets with the offer (80 characters at most, one line). */
export const giftWords = text => String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, GIFT_WORDS_MAX);
