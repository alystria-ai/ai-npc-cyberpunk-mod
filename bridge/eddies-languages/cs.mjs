// Czech money words for bridge/eddies-languages.mjs (see es.mjs for the shape). Czech numbers are several words ("dvě stě padesát"), so the engine adds
// them up from numbers.words, and the hundreds and thousands come from numbers.scales. Direction: "mi" is the one who receives (borrow), "ti" the one who
// gives (lend, give). Debts: "ti ... dlužím" is V paying, "mi dlužíš" / "dlužíš mi" is V being paid; past tenses count too.
export default {
  language: 'cs',
  // Nouns and slang for money. Not the verbs (půjčit, dlužit, vrátit, zaplatit): "zaplatil jsem za pivo" is no money.
  money: String.raw`eddies?|eddie|eds\b|kredit\w*|korun\w*|kč\b|eur\w*|dolar\w*|prach\w*|pen[ií]z\w*|penez\w*|pen[eě]z\w*|mamon\w*|hotovost\w*|dluh\w*|p[uů]j[cč]k\w*|drobn\w*|stov(?:k|ek)\w*|[\p{L}]*tisic\w*|dysk\w*|kvit\w*`,
  // Verb and noun phrases that only money fits, with no noun ("na mizině", "co jsem ti dlužil": the debt, "jsme kvit": even).
  moneyPhrases: 'na mizin\\w*|na d[nň]\\w*|bez pen\\w*|co [^,.!?]{0,12}?dlu[zž]\\w*|jsme (?:kvit|vyrovnan\\w*|v pohod\\w*)|nech si drobn\\w*|vyrovnan\\w*',
  // What may follow a sum as its currency.
  unit: 'eddies?|eddie|eds\\b|kredit\\w*|korun\\w*|kč\\b|eur\\w*|dolar\\w*|prach\\w*|pen[ií]ze|penez\\w*|pen[eě]z\\w*|mamon\\w*|hotovost\\w*',
  // Words that may follow a bare sum ("dva tisíce na ripperdoca").
  after: String.raw`na|pro|za|do|ke|k|jako|hned|ted|prosim|kamo|bracho|bracha|choom|hele|chlape|vole|jo|dik|diky|a|ale|tak|nebo|jen|hej|pak|jestli|kdyz|than|nez|az`,
  // Words that make a number after a money verb something else ("dej mi pět minut").
  notMoney: 'minut\\w*|min\\b|sekund\\w*|hodin\\w*|dni\\b|dny\\b|dnu\\b|tydn\\w*|mesic\\w*|let\\b|lid[ií]|lidi|osob\\w*|kilo\\w*|kg\\b|metr\\w*|kulk\\w*|krat\\b|kus\\w*|vystrel\\w*',
  but: String.raw`\bale\b|\bovsem\b|\bnicmene\b|\ba pak\b|\ba potom\b|\bjenze\b|\bjenom\b`,
  // Until a day ("do pátku" is no postponement of an ask): cut out before the time test.
  until: String.raw`do (?:patku|zitra|zitrka|pondeli\w*|tydne|tydnu)`,
  numbers: {
    words: {
      jeden: 1, jedna: 1, jedno: 1, jednu: 1, dva: 2, dvě: 2, tři: 3, čtyři: 4, pět: 5, šest: 6, sedm: 7, osm: 8, devět: 9, deset: 10,
      jedenáct: 11, dvanáct: 12, třináct: 13, čtrnáct: 14, patnáct: 15, šestnáct: 16, sedmnáct: 17, osmnáct: 18, devatenáct: 19,
      dvacet: 20, třicet: 30, čtyřicet: 40, padesát: 50, šedesát: 60, sedmdesát: 70, osmdesát: 80, devadesát: 90,
      dvoutisíc: 2000, třitisíc: 3000, čtyřtisíc: 4000, pětitisíc: 5000, šestitisíc: 6000, sedmitisíc: 7000, osmitisíc: 8000, devítisíc: 9000,
      desetitisíc: 10000,
    },
    scales: {
      sto: 100, stě: 100, sta: 100, set: 100, stovka: 100, stovku: 100, stovky: 100,
      tisíc: 1000, tisíce: 1000, tisíci: 1000, tisícovka: 1000, tisícovku: 1000, tisícovky: 1000, tisíců: 1000,
    },
  },
  intents: [
    // V wants the character to pay back what the character owes V: "dlužíš mi", "mi dlužíš", "vrať mi", "chci je zpátky", "kdy mi zaplatíš".
    ['reclaim', String.raw`\b(?:(?:zaplat|vrat|splat|dluz)\w* (?:mi|me)\b|kdy (?:mi|me) (?:\w+ )?(?:zaplat|vrat|splat)\w*|dlu[zž]\w* (?:mi|me)\b|\bmi\b[^,.!?]{0,20}?\bdlu[zž]\w*|chci [^,.!?]{0,15}?zp[aá]tky|chci zp[aá]tky|jsi mi dlu[zž]\w*|vr[aá]t\w* (?:by[sš] )?mi\b)`],
    // V pays back what V owes: "vracím ti", "dlužím ti", "co ti dlužím", "splácím", "jsme kvit" (even), "vrátil jsem ti".
    ['repay', String.raw`\b(?:vr[aá][tc][ií]m ti|vr[aá]til (?:jsem )?ti|ti vr[aá][tc][ií]m|vr[aá][tc][ií]m to|dlu[zž]\w* ti\b|\bti\b[^,.!?]{0,20}?\bdlu[zž]\w*|spl[aá]c[ií]m (?:ti|dluh|tu|ten|te|t[eě]ch)|zaplatil jsem ti|jsme (?:kvit|kvits|vyrovnan\w*|v pohod\w*|vyrovnani))\b`],
    // V asks whether the character needs money ("potřebuješ peníze", "budeš potřebovat peníze", "chceš prachy"): before 'borrow' (V's own "potřebuju").
    ['lend', String.raw`\b(?:pot[rř]ebuje[sš]|bude[sš] pot[rř]ebovat|pot[rř]ebovat\b|chce[sš] (?:si )?p[uů]j[cč]it|chce[sš] (?:n[eě]jak\w* )?(?:pen[ií]ze|penize|prachy|eddies|korun\w*|kredit\w*|stovk\w*)|m[aá][sš] (?:n[eě]jak\w* )?(?:pen[ií]ze|penize|prachy|eddies))\b`],
    // V asks the character to lend or give V money: "mi" is the one who receives, in a request, a conditional or a relative clause; past "půjčil" is not asked.
    ['borrow', String.raw`\b(?:p[uů]j[cč](?:[ií][sš]|[ií]te|it|\b) (?:mi|me)\b|p[uů]j[cč]\w* by[sš] (?:mi|me)\b|\bmi\b[^,.!?]{0,25}?\bp[uů]j[cč](?:[ií][sš]|[ií]te|it|\b)|(?:(?:ne)?m[oô]h\w* by\w*|(?:ne)?m[uů][zž]e[sš]|(?:ne)?m[uů][zž]ete|by[sš]|by[sš]te) (?:mi|me)\b|d[aá][sš] mi\b|dej mi\b|dal by[sš] mi\b|pot[rř]ebuj\w*|nem[aá]m (?:ani |nic |[zž][aá]dn\w* )?(?:pen[ií]ze|penize|korunu|korun|prachy|eddies)|jsem (?:na m[ií]zin[eě]|bez pen[eě]z|na d[nň][eě])|pom[oó]z mi\b[^,.!?]{0,20}?\bp[uů]j[cč]\w*)`],
    // V offers the character money: "ti" is the one who receives: "půjčím ti", "ať ti půjčím", "můžu ti půjčit".
    ['lend', String.raw`\b(?:\bti\b[^,.!?]{0,15}?\bp[uů]j[cč](?:[ií]m|it)\b|\bp[uů]j[cč](?:[ií]m|it)\b[^,.!?]{0,6}?\bti\b|m[oů][zž]u ti\b)`],
    // V gives the character money: a gift, a tip or a thank-you, with or without a verb.
    ['give', String.raw`\b(?:tady m[aá][sš]\b(?! (?:t[eě]ch|ty|ten|to|tu|t[eě]|tady))|t[aá]dy je\b|je (?:to |tohle )?pro tebe|vem si\b|vezm[eě] si\b|nech si drobn\w*|spropitn\w*|dysk\w*|za (?:tv\w+|v[aá]\w+) (?:cas|praci|pomoc|snahu|namahu|sluzby)|d[aá]m ti\b|po[sš]l[aá]m ti\b|zaplat[ií]m ti\b|plat[ií]m ti\b|d[aá]rek\b|bak[sš][ií]\w*)`],
  ],
  // Not a question that asks ("nepůjčil bys mi...?", "nemůžeš mi půjčit?"): only the forms of V's own refusals refuse. "nebo" is "or".
  negation: String.raw`\b(?:nemuzu|nemam|nepujcim|nedam|nebudu|nejsem|neni|nechci|nemusim|nedokazu|nemohu|nevim|nevratim|nezaplatim|nepomohu|nikdy|nic|nikdo|zadn\w*)\b`,
  // A condition of V's own or an imagined act ("kdybych ti půjčil..."). A condition aimed at "you" that offers ("když budeš potřebovat") is no condition.
  hypothetical: String.raw`\b(?:kdyby\w*|p[rř]edpokl\w*|p[rř]edstav\w* si|hypotet\w*|[zž]ert\w*|legrac\w*)\b`,
  // A conditional or a joke before the ask takes it back ("kdybych ti půjčil 500, vrátil bys mi je?" is no ask).
  joke: String.raw`\b(?:kdyby\w*|predstav\w* si|hypotet\w*|zert\w*|legrac\w*)\b`,
  // A time that is not now (the "do pátku" of an ask is cut out by `until` first).
  later: String.raw`\b(?:zitra|pozdeji|vcera|predevcirem|priste|pristi tyden|pristi mesic|pristi rok|minuly tyden|minuly mesic|minule|az (?:budu|mam)|kdyz budu mit|casem|nekdy|uz jsem zaplatil|zaplatil jsem ti)\b`,
};
