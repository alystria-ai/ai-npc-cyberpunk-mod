// Paying a character in eddies (docs/EDDIES_PAYMENT.md). Off by default (Settings > Companion behavior > Pay characters in eddies).
//
// V types a line to a character who is V's own copy (in the party, an invited visitor, a housemate). The game (mod/eddies-payment.lua) then sends,
// next to the line, a PAY OFFER: who may be paid, V's balance and the most V may pay in one go. THIS module decides the amount, from V's own words only:
//   - a screen (`screenPayment`) that reads the typed line in the 15 menu languages and answers an amount only when the line plainly says "I pay you N eddies"
//     (or hands them over: "here, take 500 eddies"). Anything else (a question, an "if", a promise, a negation, a fraction, two amounts, a third person, a
//     past payment, a number with no money word) is refused, never guessed. The character's reply decides nothing about money;
//   - the limits (`paymentDecision`): a whole number from 1 up to the offer's `max` (the balance, never above the hard cap `PAY_CAP`);
//   - `PaymentActions`: one packet per turn into the mailbox the companion actions use (`runtime/companion-actions.json`), which the game's lease
//     (mod/gameplay-actions.lua) matches against the offer before it asks the game side to take the eddies. The game checks everything again.
// It works the same on every provider: nothing of it goes through the model.

const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
/** The most V can pay a character in one line, whatever the balance. */
export const PAY_CAP = 100000;
export const PAY_TTL_MS = 5000;
const ENTITY = /^\d+ULL$/;
const PROFILE = /^[a-z0-9-]+$/;

/** The game's pay offer ({available, actor: {id, key}, balance, max}) as sent, or null. Strict: any other shape is no offer. */
export function parsePayOffer(value) {
  if (!plain(value) || value.available !== true || Object.keys(value).length !== 4 || !plain(value.actor)) return null;
  const {actor, balance, max} = value;
  if (Object.keys(actor).length !== 2 || typeof actor.id !== 'string' || !ENTITY.test(actor.id) || typeof actor.key !== 'string' || !PROFILE.test(actor.key)) return null;
  if (!Number.isSafeInteger(balance) || balance < 1 || !Number.isSafeInteger(max) || max < 1 || max > PAY_CAP || max !== Math.min(balance, PAY_CAP)) return null;
  return {available: true, actor: {id: actor.id, key: actor.key}, balance, max};
}

// ---- The screen -------------------------------------------------------------------------------------------------------------------------------
//
// One regular expression per kind of word, each the union of the 15 menu languages (en de fr es it pt pl ru uk tr cs hu ja ko zh). A word that is missing
// can only make the screen refuse, never pay: the refusal words and the third-person words are checked on the whole line, the payment shape on the clause.
// Latin and Cyrillic stems start and end at a word edge; Japanese, Korean and Chinese are not written with spaces, so those match anywhere.

const EDGE_BEFORE = String.raw`(?<![\p{L}\p{N}_])`, EDGE_AFTER = String.raw`(?![\p{L}\p{N}_])`;
const words = list => new RegExp(`${EDGE_BEFORE}(?:${list})${EDGE_AFTER}`, 'iu');
const anywhere = list => new RegExp(list, 'u');

// Money words: after a number. Eddies and the in-game currency in every language, plus the common short forms.
const MONEY_LATIN = String.raw`eddies|eddie|eddy|eds?|euro-?(?:dollar|dolar|dólar|dollár|dollar|dollari)\p{L}*|euros?|creds?|credits?|cash|bucks|e\$|€\$|`
  + String.raw`avrodolar\p{L}*|euro-?dolar\p{L}*|eurodoll\p{L}*|эдди|евро-?доллар\p{L}*|евро|едді|євро-?долар\p{L}*|євро`;
const MONEY_SPACELESS = 'エディ|ユーロダラー|ユーロドル|ユーロ|에디|유로달러|유로|欧洲美元|欧元|欧刀|尤罗|艾迪|埃迪';

// Number: 1,000 / 1.000 / 1 000 / 1'000 are thousands; 1.5 and 1,5 are fractions (refused); 5k and 2.5k are thousands.
const NUMBER = String.raw`\d{1,3}(?:[ ,.'  ]\d{3})+|\d+(?:[.,]\d+)?`;
const AMOUNT_AFTER = new RegExp(String.raw`(?<![A-Za-z\p{N}.,'])([-−–]?)\s?(${NUMBER})\s?(k?)\s?(?:(?:${MONEY_LATIN})${EDGE_AFTER}|(?:${MONEY_SPACELESS}))`, 'giu');
const AMOUNT_SYMBOL = new RegExp(String.raw`(?:€\$|e\$|\$|€|¥)\s?([-−–]?)\s?(${NUMBER})\s?(k?)(?![\p{L}\p{N}])`, 'giu');

// Whole-line refusals: a question, a condition, a promise or an intention, a negation, a time other than now, a debt, a request. One list per language.
const REFUSE = {
  en: String.raw`if|would|could|should|might|may|maybe|perhaps|suppose|imagine|will|\p{L}*'ll|gonna|going to|wanna|want|wanted|need|needs|have to|must|shall|when|once|unless|until|after|before|`
    + String.raw`\p{L}*n't|didnt|dont|do not|did not|wont|cant|cannot|can|not|never|no|nothing|without|how much|how many|what|whether|`
    + String.raw`from|out|off|into|steal|stole|rob|robbed|loot|looted|lost|spent|spend|cost|costs|price|worth|sell|sold|buy|bought|owe|owes|owed|debt|refund|back|again|yesterday|earlier|already|last|ago|later|tomorrow|tonight|soon|offer|offering|offered|promise|promised|deal|bet|lend|loan|borrow|`
    + String.raw`ask|asked|tell|told|make|made|let|lets|let's|help|pretend|joke|kidding|fake|hypothetically|someday|sometime`,
  de: String.raw`wenn|falls|würde|würdest|wuerde|könnte|koennte|sollte|vielleicht|angenommen|werde|werd|will|möchte|moechte|muss|müsste|nicht|nie|niemals|kein|keine|keinen|nichts|ohne|nein|noch|später|spaeter|`
    + String.raw`morgen|gestern|vorhin|schon|bereits|wieder|zurück|zurueck|schulde|schuldig|wie viel|wieviel|was|ob|sobald|bevor|nachdem|bis|versprech\p{L}*|angebot|leih\p{L}*|borg\p{L}*|brauche`,
  fr: String.raw`si|s'il|quand|lorsque|dès que|avant|après|jusqu\p{L}*|pourrais|pourrait|pourrions|voudrais|voudrait|devrais|peut-être|imagine|suppose|vais|va|allons|veux|veut|faut|dois|doit|`
    + String.raw`ne|n'\p{L}*|pas|jamais|rien|sans|non|déjà|encore|plus tard|demain|(?<=\p{L} )hier|tout à l'heure|combien|est-ce|rembours\p{L}*|promets|promesse|offre|prêt|emprunt\p{L}*|aide|besoin`,
  es: String.raw`si|cuando|cuándo|antes|después|hasta|podría|podrías|debería|quizá|quizás|tal vez|imagina|supón|voy a|vas a|iré|pagaré|daré|quiero|necesito|tengo que|debo|debes|no|nunca|jamás|nada|sin|ni|ya|`
    + String.raw`todavía|aún|luego|mañana|ayer|cuánto|cuanto|qué|deuda|devuelv\p{L}*|prometo|promesa|oferta|prest\p{L}*|ayuda`,
  it: String.raw`se|quando|prima|dopo|finché|potrei|potresti|dovrei|forse|magari|immagina|supponi|vado a|andrò|pagherò|darò|voglio|vorrei|devo|ho bisogno|non|mai|niente|nulla|senza|no|già|ancora|`
    + String.raw`domani|ieri|quanto|cosa|che cosa|debito|restitu\p{L}*|prometto|promessa|offerta|prest\p{L}*|aiuto`,
  pt: String.raw`se|quando|antes|depois|até|poderia|deveria|talvez|imagina|suponha|vou|vais|irei|pagarei|darei|quero|preciso|tenho que|devo|não|nao|nunca|jamais|nada|sem|já|ainda|`
    + String.raw`amanhã|ontem|quanto|o que|dívida|divida|devolv\p{L}*|prometo|promessa|oferta|emprest\p{L}*|ajuda`,
  pl: String.raw`jeśli|jeżeli|gdyby|kiedy|gdy|zanim|po|dopóki|mógłbym|mógłbyś|powinienem|może|wyobraź|załóżmy|zapłacę|dam|dostaniesz|chcę|chciałbym|muszę|potrzebuję|nie|nigdy|nic|bez|już|jeszcze|`
    + String.raw`później|jutro|wczoraj|przed chwilą|ile|co|czy|dług|zwrot|obiecuję|oferta|pożycz\p{L}*|pomoc`,
  ru: String.raw`если|когда|пока|прежде|перед|после|мог бы|смог бы|должен|может быть|возможно|представь|допустим|заплачу|дам|отдам|хочу|нужно|надо|не|ни|никогда|ничего|без|нет|уже|ещё|еще|`
    + String.raw`потом|позже|завтра|вчера|только что|сколько|что|ли|долг|верн\p{L}*|обещаю|предлож\p{L}*|одолж\p{L}*|займ\p{L}*|помоги\p{L}*`,
  uk: String.raw`якщо|коли|поки|перед|після|міг би|мав би|можливо|уяви|припустимо|заплачу|дам|віддам|хочу|треба|потрібно|не|ні|ніколи|нічого|без|ще|вже|потім|пізніше|завтра|вчора|щойно|`
    + String.raw`скільки|що|чи|борг|поверн\p{L}*|обіцяю|пропоную|позич\p{L}*|допоможи\p{L}*`,
  tr: String.raw`eğer|olursa|zaman|önce|sonra|kadar|olabilir|belki|hayal et|varsay|ödeyeceğim|vereceğim|vericem|vereyim|istiyorum|lazım|gerek|zorunda|değil|değilim|yok|asla|hiç|hiçbir|olmadan|`
    + String.raw`henüz|daha|yarın|dün|az önce|kaç|ne kadar|ne|borç|geri|söz|teklif|ödünç|vermedim|ödemedim|vermiyorum|ödemiyorum|vermem|ödemem|yardım`,
  cs: String.raw`pokud|jestli|když|kdy|než|po|dokud|mohl bych|měl bych|možná|představ si|předpokládej|zaplatím|dám|dostaneš|chci|potřebuji|musím|ne|nikdy|nic|bez|už|ještě|později|zítra|včera|`
    + String.raw`před chvílí|kolik|co|dluh|vrát\p{L}*|slibuji|nabídka|půjč\p{L}*|pomoc`,
  hu: String.raw`ha|amikor|mikor|mielőtt|miután|amíg|tudnék|kellene|talán|képzeld|tegyük fel|fizetni fogok|adni fogok|akarok|szeretnék|kell|nem|soha|semmi|nélkül|már|még|később|holnap|tegnap|az előbb|`
    + String.raw`mennyi|mi|vajon|tartozás|tartozom|vissza|ígérem|ajánlat|kölcsön|segítség`,
};
const REFUSE_SPACELESS = {
  ja: 'お前が|あなたが|君が|おまえが|あんたが|彼が|彼女が|から|もし|たら|ば|なら|ない|ません|まだ|後で|あとで|明日|昨日|さっき|いくら|借り|返|かな|かも|でしょう|だろう|つもり|予定|約束|しよう|したい|ほしい|欲しい|てくれ|助け|冗談|嘘',
  ko: '네가|니가|너가|당신이|그가|그녀가|만약|면|라면|않|안 |못|아니|없|언제|내일|어제|아까|나중|얼마|빌|갚|할까|까요|예정|약속|싶|려고|도와|농담|거짓',
  zh: '你给|你給|你付|你转|他给|她给|他付|她付|如果|假如|要是|若|会|將|将|打算|想|要|需要|不|没|沒|别|別|从未|未|明天|昨天|刚才|剛才|以前|之前|以后|以後|之后|等|欠|还你|還你|多少|吗|嗎|呢|帮|幫|开玩笑|玩笑|假装|假裝',
};
const REFUSAL = words(Object.values(REFUSE).join('|'));
const REFUSAL_SPACELESS = anywhere(Object.values(REFUSE_SPACELESS).join('|'));

// A third person near the verb: "I paid him 500", "she gave them 500".
const THIRD = words(String.raw`him|her|them|his|their|someone|somebody|everybody|everyone|she|he|they|`
  + String.raw`ihm|ihr|ihnen|ihn|jemandem|lui|leur|eux|elle|quelqu'un|él|ella|ellos|ellas|ele|ela|eles|lei|loro|jemu|jej|jego|ему|ей|им|кому-то|йому|їй|їм|комусь|onu|ona|onlar|jemu|jí|jim|neki|nekik|valakinek|il|ils|elles|alguien|alguém|egli|qualcuno|er|он|она|они|оно|він|вона|вони|хтось|oni|někdo|valaki|on (?:ti |vám )?(?:zaplatil|dal|poslal|převedl)\p{L}*`);

// The recipient: V's words must point at the character (or use her first name) right where the verb is.
const RECIPIENT_LIST = String.raw`you|ya|u|your|y'all|`
  + String.raw`dir|dich|euch|te|t'\p{L}*|toi|vous|a ti|ti|tobie|ciebie|ty|ci|тебе|тебя|вам|вас|тобі|тебе|sana|sen|size|tebe|tobě|vám|neked|téged|önnek`;
const RECIPIENT_SPACELESS = 'お前|おまえ|あなた|君|きみ|あんた|너|당신|네게|你|您';

// First-person payment verbs (the subject is "I" or "we" in English; elsewhere the verb form says it).
const DECLARE_EN = String.raw`(?:i|we|im|i'm|ive|i've|we're|we've)(?:\s+(?:am|have|just|now|hereby|also|simply|finally|then))*\s+`
  + String.raw`(?:pay|pays|paid|paying|give|gave|given|giving|hand|handed|handing|hands|send|sent|sending|transfer|transferred|transferring|wire|wired|slip|slipped|toss|tossed|throw|threw|drop|dropped|tip|tipped|bribe|bribed)`;
const DECLARE_OTHER = String.raw`zahle|zahlte|bezahle|bezahlte|gezahlt|bezahlt|gebe|gab|gegeben|überweise|überwies|überwiesen|schicke|schickte|geschickt|reiche|reichte|gereicht|stecke|drücke|`
  + String.raw`paie|paye|payé|donne|donné|vire|viré|envoie|envoyé|remets|remis|glisse|`
  + String.raw`pago|pagué|pagado|doy|di|dado|envío|envié|enviado|mando|mandé|transfiero|transferí|entrego|entregué|`
  + String.raw`dato|invio|inviato|mandato|trasferisco|trasferito|consegno|consegnato|pagato|`
  + String.raw`paguei|dou|dei|envio|enviei|mandei|transfiro|transferi|entreguei|`
  + String.raw`płacę|zapłaciłem|zapłaciłam|płaciłem|płaciłam|daję|dałem|dałam|przelewam|przelałem|przelałam|wysyłam|wysłałem|wysłałam|wręczam|wręczyłem|wręczyłam|`
  + String.raw`плачу|заплатил|заплатила|даю|дал|дала|отдаю|отдал|отдала|перевожу|перевёл|перевел|перевела|отправляю|отправил|отправила|вручаю|вручил|вручила|`
  + String.raw`заплатив|дав|віддаю|віддав|віддала|переказую|переказав|переказала|відправляю|відправив|відправила|`
  + String.raw`ödüyorum|ödedim|veriyorum|verdim|gönderiyorum|gönderdim|aktarıyorum|aktardım|uzatıyorum|bırakıyorum|`
  + String.raw`platím|zaplatil|zaplatila|dávám|dal|dala|posílám|poslal|poslala|převádím|převedl|převedla|`
  + String.raw`fizetek|fizettem|adok|adtam|küldök|küldtem|utalok|utaltam|átadok|átadtam`;
const DECLARATIVE = new RegExp(`${EDGE_BEFORE}(?:${DECLARE_EN}|${DECLARE_OTHER})${EDGE_AFTER}`, 'iu');
// Japanese and Korean drop the pronoun and Chinese has none to drop: the verb alone says V pays (a payment the other way, "you gave me", is refused above), and
// Chinese names "I" in front of the verb.
const DECLARATIVE_SPACELESS = anywhere('払う|払います|払った|払ってる|あげる|あげます|あげた|渡す|渡します|渡した|送る|送った|送金|支払|'
  + '줄게|줄께|줬어|줬다|줍니다|준다|드릴게요|드려요|드립니다|보낼게|보냈어|지불할게|지불했어|송금했어|'
  + '我(?:现在|現在|先|就|这就|刚刚|刚|剛)?(?:付|给|給|转|轉|汇|匯)');
// A hand-over to the character, said at the start of a clause: "take 500 eddies", "here's 500 eddies".
const FILLER = String.raw`hey|yo|ok|okay|so|well|alright|right|look|then|oh|ah|now|just|also|na|bon|alors|bueno|dai|então|bom|ну|так|hát`;
const IMPERATIVE_LIST = String.raw`take|have|keep|grab|accept|here|here's|heres|here you go|`
  + String.raw`nimm|nimm dir|hier|hier ist|hier sind|behalte|behalt|nehmt|`
  + String.raw`tiens|tenez|prends|prenez|voilà|voila|garde|gardez|voici|`
  + String.raw`toma|tome|ten|aquí tienes|aqui tienes|aquí|aqui|quédate|quedate|acepta|agarra|coge|`
  + String.raw`tieni|prendi|prendete|ecco|tenga|accetta|`
  + String.raw`pega|pegue|fica com|fique com|aceita|`
  + String.raw`weź|bierz|masz|proszę|oto|trzymaj|zatrzymaj|przyjmij|`
  + String.raw`держи|возьми|бери|вот|на|прими|получи|оставь|держите|возьмите|`
  + String.raw`тримай|візьми|ось|прийми|отримай|залиш|тримайте|`
  + String.raw`al|alın|buyur|işte|kabul et|tut|sakla|`
  + String.raw`vem si|vezmi|tady|tu máš|tady máš|drž|přijmi|ber|tumáš|`
  + String.raw`tessék|vedd|vegyél|itt|itt van|tartsd meg|fogadd el|nesze`;
const IMPERATIVE = new RegExp(`^[\\s"'*(]*(?:(?:${FILLER})[\\s,.!-]+){0,3}(?:${IMPERATIVE_LIST})${EDGE_AFTER}`, 'iu');
const IMPERATIVE_SPACELESS = anywhere('受け取って|受け取れ|取って|取っとけ|持ってけ|持っていけ|받아|받으세요|받아요|가져가|가져|챙겨|拿着|收下|拿去|拿好|给你|送你|请收下|收好');
// "500 eddies for you" after the amount.
const FOR_YOU = words(String.raw`for you|for your|für dich|für euch|pour toi|pour vous|para ti|para vos|per te|para você|para voce|dla ciebie|для тебя|для вас|для тебе|для вас|sana|sizin için|pro tebe|neked`);

const NAME_PART = name => {
  const first = String(name ?? '').split(/\s+/)[0]?.replace(/[^\p{L}'-]/gu, '') ?? '';
  return first.length >= 3 ? first.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`) : null;
};

// A plain apostrophe in what the player typed (a phone keyboard types the curly one), full-width digits as ASCII, no control characters.
const normal = value => String(value ?? '').slice(0, 600).normalize('NFKC').replace(/[‘’‛ʼ`´]/g, "'").replace(/[\u0000-\u001f\u007f]/g, ' ');

function numberValue(sign, digits, kilo) {
  if (sign || /^0[.,]/.test(digits)) return null;   // negative, or 0,5 (a fraction)
  const scale = kilo ? 1000 : 1;
  if (/^\d{1,3}(?:[ ,.'\u00a0\u202f]\d{3})+$/.test(digits)) return Number(digits.replace(/\D/g, '')) * scale;
  if (/^\d+$/.test(digits)) return Number(digits) * scale;
  if (kilo && /^\d+[.,]\d$/.test(digits)) return Math.round(Number(digits.replace(',', '.')) * 1000);   // 2.5k
  return null;   // a fraction: eddies are whole
}

/**
 * What V's typed line says about paying the character: {status: 'none'} (no amount of money in it), {status: 'refused', reason, amount?} (it speaks of an
 * amount but not as a payment made now, or the amount is not usable) or {status: 'pay', amount} (a plain payment, a whole number of at least 1).
 * `name` is the character's name: her first name counts as the one paid.
 */
export function screenPayment(text, {name = null} = {}) {
  const line = normal(text);
  const found = [];
  for (const [pattern, kind] of [[AMOUNT_AFTER, 'after'], [AMOUNT_SYMBOL, 'symbol']]) {
    pattern.lastIndex = 0;
    for (const match of line.matchAll(pattern)) found.push({sign: match[1], digits: match[2], kilo: match[3] === 'k' || match[3] === 'K', index: match.index, end: match.index + match[0].length, kind});
  }
  if (!found.length) return {status: 'none'};
  // One amount only: two amounts (or the same one twice) cannot be told apart from a plan, a total or a quote.
  if (found.length > 1) return {status: 'refused', reason: 'several-amounts'};
  const [amount] = found;
  const value = numberValue(amount.sign, amount.digits, amount.kilo);
  if (value === null) return {status: 'refused', reason: amount.sign ? 'negative' : 'fraction'};
  if (!Number.isSafeInteger(value) || value < 1) return {status: 'refused', reason: 'not-positive'};
  if (/[?？¿]/.test(line)) return {status: 'refused', reason: 'question', amount: value};
  if (REFUSAL.test(line) || REFUSAL_SPACELESS.test(line)) return {status: 'refused', reason: 'conditional-or-negated', amount: value};
  // The clause that holds the amount.
  const start = Math.max(line.lastIndexOf('.', amount.index), line.lastIndexOf('!', amount.index), line.lastIndexOf(';', amount.index), line.lastIndexOf(':', amount.index),
    line.lastIndexOf('\n', amount.index), line.lastIndexOf('。', amount.index), line.lastIndexOf('！', amount.index)) + 1;
  const stops = ['.', '!', ';', ':', '\n', '。', '！'].map(mark => line.indexOf(mark, amount.end)).filter(at => at >= 0);
  const clause = line.slice(start, stops.length ? Math.min(...stops) : line.length);
  const first = NAME_PART(name);
  const recipient = new RegExp(`${EDGE_BEFORE}(?:${RECIPIENT_LIST}${first ? `|${first}` : ''})${EDGE_AFTER}|${RECIPIENT_SPACELESS}`, 'iu');
  // A hand-over at the start of the clause ("take 500 eddies", "here's 500 eddies"), eddies "for you", or "I pay you / I paid Judy 500 eddies": the verb with the
  // character next to it and nobody else.
  let shaped = IMPERATIVE.test(clause) || IMPERATIVE_SPACELESS.test(clause) || FOR_YOU.test(line.slice(amount.end, amount.end + 24));
  if (!shaped) {
    const verb = DECLARATIVE.exec(clause);
    if (DECLARATIVE_SPACELESS.test(clause)) shaped = true;
    else if (verb) {
      const near = clause.slice(Math.max(0, verb.index - 40), verb.index + verb[0].length + 40);
      shaped = recipient.test(near) && !THIRD.test(near);
    }
  }
  if (!shaped) return {status: 'refused', reason: 'not-a-payment', amount: value};
  return {status: 'pay', amount: value};
}

/**
 * The decision for one turn: {status: 'pay', amount, offer} when V's typed words pay a whole number of eddies within the game's offer, {status: 'refused', reason,
 * amount?} when they speak of an amount that cannot be paid (the reason tells the character why nothing moved), {status: 'none'} for everything else.
 * No offer (the switch is Off, a game-placed character, a spoken line, a group round) is always 'none'.
 */
export function paymentDecision(input) {
  const offer = parsePayOffer(input?.payOffer);
  if (!offer || input.reaction || input.group !== undefined || input.channel === 'phone' || offer.actor.id !== input.entity || offer.actor.key !== input.profileKey) return {status: 'none'};
  const screen = screenPayment(input.text, {name: input.name});
  if (screen.status !== 'pay') return screen;
  if (screen.amount > PAY_CAP) return {status: 'refused', reason: 'cap', amount: screen.amount};
  if (screen.amount > offer.balance) return {status: 'refused', reason: 'balance', amount: screen.amount};
  return {status: 'pay', amount: screen.amount, offer};
}

// ---- What the character is told ---------------------------------------------------------------------------------------------------------------

export const paidNote = amount => `Money: V just paid you ${amount} eddies, right now and in person, and you have them. Take it as done and thank V in your own way. `
  + 'Do not ask for the eddies again and do not offer them back.';
export const REFUSED_NOTE = amount => `Money: V spoke of paying you ${amount} eddies, but the game took none of it: V does not have that much, or it is more than can be paid in one go. `
  + 'You received nothing. Say so in your own way and never claim to have the eddies.';
export const NO_PAYMENT_NOTE = 'Money: no eddies changed hands this turn, whatever V says about money. Never say you have received eddies now. '
  + 'V is the one who would pay you, not the other way round, and a promise to pay later is only a promise.';

/**
 * The money note of a turn that has a pay offer: the payment, the refused amount, or "nothing moved" when V's words speak of money. '' for a turn with no offer
 * (the caller then uses the words-only note), and for an offer on a line that is not about money.
 */
export function paymentNote(input, talksOfMoney) {
  if (!parsePayOffer(input?.payOffer)) return '';
  const decision = paymentDecision(input);
  if (decision.status === 'pay') return paidNote(decision.amount);
  if (decision.status === 'refused' && decision.amount !== undefined && ['balance', 'cap'].includes(decision.reason)) return REFUSED_NOTE(decision.amount);
  return decision.status === 'refused' || talksOfMoney ? NO_PAYMENT_NOTE : '';
}

// ---- The packet -------------------------------------------------------------------------------------------------------------------------------

/**
 * Hands the game one payment per turn. `publish(packet, options)` writes the mailbox (the same file and the same guard as the companion actions); `after` is a
 * promise to wait for first (the mailbox's own clearing for the new turn, so the two writes cannot cross). Returns {paid: true} or {paid: false, why}.
 */
export class PaymentActions {
  constructor({publish, createToken, now = Date.now, log = () => {}}) {
    Object.assign(this, {publish, createToken, now, log}); this.last = null;
  }
  async admit(prepared, {source, isCurrent, isCurrentSync, signal, after} = {}) {
    const input = prepared?.input, offer = parsePayOffer(input?.payOffer);
    if (!offer) return {paid: false, why: 'no-offer'};
    const no = why => {
      try { this.log(`Eddies payment: person=${input.profileKey} paid=no(${why})`); } catch { /* a log line never breaks a turn */ }
      return {paid: false, why};
    };
    const decision = paymentDecision(input);
    if (decision.status !== 'pay') return {paid: false, why: decision.status === 'none' ? 'no-payment' : decision.reason};
    if (source !== 'private-text') return no('source:' + String(source));
    if (prepared?.route?.channel !== 'private' || prepared.route.transport === 'microphone') return no('channel');
    if (!prepared.sendAllowed) return no('send-not-allowed');
    if (input.reaction) return no('automatic-turn');
    if (input.channel !== 'private' || input.group !== undefined) return no('input-channel');
    if (typeof input.requestId !== 'string' || !/^\d+-\d+-\d+ULL$/.test(input.requestId) || !Number.isSafeInteger(input.generation) || input.generation < 0
        || !input.requestId.endsWith(`-${input.generation}-${input.entity}`)) return no('request-id');
    if (typeof prepared.worldToken !== 'string' || !prepared.worldToken || prepared.worldToken.length > 160 || !Number.isSafeInteger(prepared.generation) || prepared.generation < 1) return no('world-binding');
    if (typeof isCurrent !== 'function' || typeof isCurrentSync !== 'function') return no('no-currency-check');
    if (signal?.aborted) return no('aborted');
    if (isCurrentSync() !== true) return no('stale-world');
    // One payment per request, whatever calls this twice.
    if (this.last === input.requestId) return no('already-paid-this-turn');
    this.last = input.requestId;
    const actionId = this.createToken();
    if (typeof actionId !== 'string' || !actionId || actionId.length > 240) return no('token');
    try { await after; } catch { /* the clearing failed: the lease check still protects the game */ }
    const createdAt = this.now();
    const packet = {version: 1, action: 'companion-pay', actionId, requestId: input.requestId, generation: input.generation, entity: input.entity, profileKey: input.profileKey,
      worldToken: prepared.worldToken, worldGeneration: prepared.generation, source, createdAt, expiresAt: createdAt + PAY_TTL_MS,
      pay: {amount: decision.amount}, payOffer: offer};
    const current = async () => !signal?.aborted && Boolean(await isCurrent()) && isCurrentSync() === true;
    let published = false;
    try { published = await this.publish(packet, {signal, isCurrent: current, isCurrentSync}); } catch { published = false; }
    try { this.log(`Eddies payment: person=${input.profileKey} amount=${decision.amount} handed-over=${published ? 'yes' : 'no(not-published)'}`); } catch { /* never breaks a turn */ }
    return published ? {paid: true, amount: decision.amount} : {paid: false, why: 'not-published'};
  }
}
