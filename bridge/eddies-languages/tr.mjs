// Turkish money words for bridge/eddies-languages.mjs. The text and these sources are folded first (ç->c, ğ->g, ı->i, ö->o, ş->s, ü->u, lower case),
// so the Turkish letters are written as Turkish and a line typed without them matches too. Turkish is verb-final and agglutinative: a verb is matched
// with its suffixes ("borç verir misin", "borç verebilir misin"), and the money comes before the verb.
//
// Person decides the intent: a second-person question or imperative asks ("borç verir misin", "ver bana", "geri öder misin"), a first-person form offers
// ("borç veririm", "avans verebilirim", "borç vermek isterim"). A possessive decides the debt: "borcum" is mine (I repay), "borcun" is yours (you repay).
// The sum words that may stand between a person and a debt noun ("sana 150 eddie borcum var") are digits, number words, scales and currency words; a debt
// with any other noun in between is not money ("sana iki kelime borcum var": two words owed).
const TOKEN = String.raw`(?:\d[\d.,]*k?|iki|uc|dort|bes|alti|yedi|sekiz|dokuz|on|yirmi|otuz|kirk|elli|altmis|yetmis|seksen|doksan|yuz|bin|binlik|yuzluk|lira[a-z]*|eddie[a-z]*|eddi|edi|para(?!siz|lel)[a-z]*|euro|eurodolar|dolar|kurus|mangir|harclik)`;
const SUMS = String.raw`(?:${TOKEN} )*`;
const SUMS1 = String.raw`(?:${TOKEN} )+`;
// First-person conditionals about V's own act ("borç versem", "alsam"): V's imagined action, so the whole line is no ask, the next clause included.
const SELF = String.raw`(?:versem|verseydim|verseydin|verirsem|odersem|odeseydim|alsam|alsaydim|gondersem|yollasam|istersem|yapsam|olsam|olsaydim)`;

export default {
  language: 'tr',
  // Money nouns and slang. "para" is not "parasız" (broke) or "paralel"; "borç" (debt, loan) is a noun, so "borcum", "borcunu", "borçlusun" match by stem.
  money: String.raw`eddies?|eddi\b|edi\b|\bpara(?!siz|lel)|lira|mangir|harclik|kurus|eurodolar|dolar|euro|borc|avans|maas|kredi`,
  // Verb phrases that only money fits, even with no noun or sum ("borcumu öde", "üstü kalsın": keep the change).
  moneyPhrases: String.raw`borc(?:um|umu|unu|un) (?:ode|odu)|ne zaman ode|odemen (?:gerek|lazim)|ustu (?:sende )?kalsin|ustu kalsin`,
  // What may follow a sum as its currency; a case suffix may follow it ("lirayı", "eddieyi", "parayı").
  unit: String.raw`eddie[a-z]*|eddi[a-z]*|edi\b|\bpara(?!siz|lel)[a-z]*|lira[a-z]*|mangir[a-z]*|harclik[a-z]*|kurus[a-z]*|eurodolar[a-z]*|dolar[a-z]*|euro[a-z]*`,
  // Words that may follow a bare sum ("500 lazım", "500 için", "bin lira kadar", "500 ver").
  after: String.raw`icin|lazim|eder|lutfen|hadi|tamam|olur mu|tamam mi|olur|ver|verir misin|verebilir misin|versene|verir misiniz|borc|kadar|civarinda|civari|falan|rica ederim|ne dersin|abi|kanka|dostum|kardesim|choom|bro|gerek`,
  // Words that make a number after a money verb something else: time, counts, people, ages, pieces, years, months.
  notMoney: String.raw`dakika|dk\b|saniye|saat|gun|kere|defa|kisi|adet|mermi|yas|tane|kez|hafta|yil|metre|km\b|kilo|sise|bardak|kutu|parca|sayfa|soru|ay\b|cocuk|gece`,
  // Clause breaks besides the punctuation.
  but: String.raw`\bama\b|\bfakat\b|\bancak\b`,
  // "until payday" / "yarına kadar": cut out before the time test, so "500 eddie yarına kadar borç ver" is still an ask.
  until: String.raw`(?:yarina|cumaya|maasa|maasima|haftaya|ay sonuna|ertesi gune) kadar`,
  // Joking words: a clause after one is no ask ("Şaka yapıyordum, bana hiçbir şey borç verme").
  joke: String.raw`saka|dalga`,
  numbers: {
    words: {bir: 1, iki: 2, uc: 3, dort: 4, bes: 5, alti: 6, yedi: 7, sekiz: 8, dokuz: 9, on: 10, yirmi: 20, otuz: 30, kirk: 40, elli: 50,
      altmis: 60, yetmis: 70, seksen: 80, doksan: 90},
    // The longer forms first: a digit run takes the first suffix that fits ("2 binlik", not "2 bin" and then "lik").
    scales: {yuzluk: 100, yuz: 100, binlik: 1000, bin: 1000},
  },
  intents: [
    // V asks the character to pay back what the character owes V: "bana borcun var", "iki yüz eddie borcun var", "borcunu öde", "bana geri öde",
    // "paramı ver", "ne zaman ödeyeceksin", "bin lirayı geri vereceğini söylemiştin", "paramı geri istiyorum".
    ['reclaim', String.raw`bana ${SUMS}borc(?:un|unu|lusun)|bana ${SUMS}borclu oldugun|${SUMS1}borc(?:un|unu) var|borc(?:un|unu) (?:ode|oder|odeyecek|odersin)|bana .*?geri (?:ode|iade)|bana .*?geri ver(?!iyor|irim|ecegim|dim|ebilirim|eyim)|geri ver(?!iyor|irim|ecegim|dim|ebilirim|eyim)|geri (?:verir misin|verebilir misin|oder misin|istiyorum|isterim)|parami (?:geri )?(?:ver(?!iyor|irim|ecegim|dim)|iade)|odemen (?:gerek|lazim|var)|ne zaman (?:ode|geri)|(?:ode|oder)(?:yecek)? misin|odeyeceksin|odeyecek misin|verecegini|soylemistin|vereceksin|verecek misin`],
    // V pays back what V owes: "sana borcum var", "borcumu ödüyorum", "işte senin paran", "geri veriyorum", "sana borçlu olduğum 500", "eşitiz", "basa bas".
    ['repay', String.raw`sana ${SUMS}borc(?:um|um var)|borc(?:um|umu) (?:odu|ode|geri|kapat)|(?<!bana )geri (?:veriyorum|veririm|verecegim|verdim)|iste senin (?:paran|parani)|(?:sana ${SUMS}|${SUMS1})?borclu oldugum(?= ${TOKEN})|esitiz|basa bas|basabas|hesap kapandi`],
    // V asks whether the character needs money, or wants to borrow: "borç ister misin", "paraya ihtiyacın var mı", "ödünç almak ister misin".
    ['lend', String.raw`borc ister misin|borc istiyor musun|(?:borc|odunc|avans) almak (?:ister misin|istermisin|istiyor musun)|para(?:na|ya)? ihtiyacin var|para (?:ister|istiyor) (?:misin|musun)|ihtiyacin var mi`],
    // V asks the character to lend or give V money: "borç verir misin", "bana ... borç ver", "ödünç ver", "ver bana", "borç alabilir miyim", "avans yapabilir misin", "lazım".
    // A first-person form is an offer, not an ask: the lookaheads keep "verebilirim", "veririm", "veriyorum", "vermek isterim" out.
    ['borrow', String.raw`borc (?:verir|verebilir) misin(?:iz)?|odunc (?:ver(?!iyorum|irim|ebilirim|eyim|ecegim|dim|mek)|alabilir miyim)|borc alabilir miyim|borc (?:alayim|isterim|istiyorum)|bana .*?ver(?!iyorum|irim|ecegim|dim|eyim|ebilirim|mek)|ver bana|avans (?:verir misin|verebilir misin|yapabilir misin|yapar misin)|avans ver(?!ebilirim|irim|iyorum|eyim|ecegim|mek)|lazim|ihtiyacim var`],
    // V offers to lend the character money: "sana 400 eddie borç veririm", "ödünç veriyorum sana", "avans verebilirim", "sana 800 eddie borç vermek isterim".
    ['lend', String.raw`(?:borc|odunc|avans) (?:veriyorum|veririm|verebilirim|vereyim|verecegim|vermek isterim|vermek istiyorum|yapabilirim|yapiyorum)`],
    // V gives the character money: a gift, a tip, a payment, the change, a token of thanks, "Al, 300 eddie", "Burada 2 bin eddie".
    ['give', String.raw`sana .*?(?:veriyorum|verecegim|gonderiyorum|gonderecegim|yolluyorum|oduyorum|odeyecegim|yatiriyorum)|buyur|alsana|bahsis|ustu (?:sende )?kalsin|hediye|karsiligi|zahmet|\bburada\b|\biste\b|\bal\b(?!.*bana)`],
  ],
  // A refusal ("borç vermem", "verme", "hayır"). "verir misin" and "vermez misin" are requests and "vermeyecek misin" a question: not refusals.
  negation: String.raw`hayir|asla|hic\b|hicbir|kesinlikle|olmaz|vermem|vermeyecegim|vermiyorum|verme(?![\p{L}])|vermeyeyim|vermedim|istemiyorum|istemem|istemeyecegim|borc(?:um|un) yok`,
  // A condition about V's own act refuses (the 1st-person forms, and a wish or a pretence). "eğer ihtiyacın olursa" (a polite offer) is not one.
  hypothetical: String.raw`olsaydi|olsaydin|olsaydim|olsaydik|olsaydiniz|olsa da|farz (?:et|edelim|edin)|diyelim ki|varsayalim|varsayin|hayal (?:et|edelim)|sanki|${SELF}|saka|dalga`,
  // Future and past: "yarın", "sonra", "dün", "ödedim", "verdim", "verdin", "ileride", "bir gün", "geçen". The 1st-person conditionals are here too: the
  // engine tests a clause before the intent clause only for these and for jokes, so "Sana 500 eddie borç versem, geri öder misin?" is refused.
  // "yarına kadar" / "maaşa kadar" is until, not a postponement (the lookaheads).
  later: String.raw`yarin(?!a kadar)|sonra|dun\b|odedim|odedik|verdim|verdin\b|verdi\b|verdik|aldim|ileride|bir gun|gelecek hafta|haftaya(?! kadar)|ay sonu(?!na kadar)|ayin sonunda|maas(?:im)? (?:yat|gel)|gecen|az once|iade ett|simdi degil|ertesi gun|onceden|${SELF}`,
};
