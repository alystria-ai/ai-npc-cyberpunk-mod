// Hungarian money words for bridge/eddies-languages.mjs (see es.mjs for the shape). Hungarian writes numbers as one word ("kétszázötven", "kétezer",
// "háromszázat"), so the engine segments compounds: only units, teens and tens are listed as words; the hundreds and thousands (and their case forms)
// are scales, so "ötszáz" keeps its scale and is a bare sum. Direction: "nekem" (me) is the one who receives (borrow), "neked" (you) the one who gives
// (lend, give). Debts: "tartozom neked" is V paying, "tartozol nekem" is V being paid; past and relative forms count too.
export default {
  language: 'hu',
  // Nouns and slang for money. Not the verbs (kölcsönad, fizet, tartozik): "tartozom neked egy sörrel" is no money. Bare "kölcsön" is no noun here
  // ("adj kölcsön egy kis figyelmet"), only its case forms (kölcsönt, kölcsönre).
  money: String.raw`eddies?|eddie|eds\b|forint\w*|ft\b|penz\w*|dollar\w*|euro\w*|eur\b|kredit\w*|keszpenz\w*|hitel\w*|adossag\w*|tartozas\w*|zseb\w*|ezres\w*|ezer\w*|kolcson(?:t|re|ok)\b|l[oó]v[eé]\w*|[\p{L}]*ezer\w*|[\p{L}]*ezres\w*|[\p{L}]*ezrest\w*|[\p{L}]*sz[aá]z\w*`,
  // Phrases that only money fits, with no noun ("csőd vagyok", "fizess vissza", "amivel tartozom": the debt, "visszajáró": the change).
  moneyPhrases: 'csod vagyok|penz nelkul vagyok|fizet\\w* vissza|fizess vissza|fizesd vissza|amivel (?:tartozom|tartoztam|tartozol|ados vagyok)|amit kolcsonad\\w*|mindazt|visszajar\\w*|ados\\w* vagyok',
  // What may follow a sum as its currency (Hungarian adds the case endings: forintot, forintért, Ft-ot, eddie-t).
  unit: 'eddies?|eddie|eds\\b|forint\\w*|ft\\b|penz\\w*|dollar\\w*|euro\\w*|eur\\b|kredit\\w*|keszpenz\\w*',
  // Words that may follow a bare sum ("kétezer, kérlek").
  after: String.raw`kerlek|legyszi|haver|teso|cimbora|csak|most|neked|helyett|utan|ahhoz|azert|kerem|ide|bro|pls|tesom|mar|amig|amit|amivel|amikor`,
  // Words that make a number after a money verb something else ("adj egy percet", "három órát").
  notMoney: 'perc\\w*|masodperc\\w*|ora\\w*|nap\\b|napig\\w*|napon\\w*|het\\b|honap\\w*|ev\\b|evek\\w*|emberek\\w*|ember\\b|kilo\\w*|kg\\b|meter\\w*|golyo\\w*|loves\\w*|alkalom\\w*|darab\\w*|db\\b|szor\\w*|szer\\b',
  but: String.raw`\bde\b|\bviszont\b|\bazonban\b`,
  // Until tomorrow ("holnapig" is no postponement of an ask): cut out before the time test.
  until: String.raw`holnap\w*ig|j[oö]v[oö] \w+ig`,
  numbers: {
    compound: true,
    words: {
      egy: 1, kettő: 2, két: 2, három: 3, négy: 4, öt: 5, hat: 6, hét: 7, nyolc: 8, kilenc: 9, tíz: 10, tizenegy: 11, tizenkettő: 12, tizenkét: 12,
      tizenhárom: 13, tizennégy: 14, tizenöt: 15, tizenhat: 16, tizenhét: 17, tizennyolc: 18, tizenkilenc: 19,
      húsz: 20, huszonegy: 21, huszonkettő: 22, huszonkét: 22, huszonhárom: 23, huszonnégy: 24, huszonöt: 25, huszonhat: 26, huszonhét: 27,
      huszonnyolc: 28, huszonkilenc: 29, harminc: 30, negyven: 40, ötven: 50, hatvan: 60, hetven: 70, nyolcvan: 80, kilencven: 90,
    },
    scales: {száz: 100, százat: 100, százas: 100, százra: 100, ezer: 1000, ezret: 1000, ezres: 1000, ezresek: 1000, ezrest: 1000, ezrek: 1000},
    skip: ['és'],
  },
  intents: [
    // V wants the character to pay back what the character owes V: "tartozol nekem", "add vissza", "fizesd vissza", "mikor adod vissza", "visszakérem".
    ['reclaim', String.raw`\b(?:tartozol\b|fizesd vissza|fizess vissza|add vissza|adod vissza|adj vissza|visszafizeted|visszaadod|visszafizetn[eé]d|visszafizetn[eé]l|visszaadn[aá]d|visszaadn[aá]l|fizet\w*ed vissza|fizetsz vissza|visszak[eé]r\w*|visszakerem)\b`],
    // V pays back what V owes: "visszafizetem", "visszaadom", "tartozom neked", "tartoztam" (past), "adós vagyok".
    ['repay', String.raw`\b(?:kvit(?:tek|t)? vagyunk|vagyunk kvit\w*|kvittek|visszafizetem|visszafizettem|visszaadom|visszaadtam|tartozom|tartoztam|ad[oó]s\w* vagyok)\b`],
    // V asks the character whether they need money: "kell neked", "pénzed kell", "pénz kell?", "szükséged van", "akarsz kölcsönt": before 'borrow'.
    ['lend', String.raw`\b(?:kell (?:neked|penzed)|penzed kell|penz kell\b|szukseged van|akarsz kolcson\w*|kolcson\w* akarsz)\b`],
    // V asks the character to lend (or give) V money: the verb with "nekem" (me) is the one who receives, in a request or a polite form.
    ['borrow', String.raw`\b(?:kolcsonad\w*\b[^,.!?]{0,25}?\bnekem|nekem\b[^,.!?]{0,25}?\bkolcsonad\w*|adn[aá]l?\b[^,.!?]{0,20}?\b(?:nekem|kolcson\w*)|tudn[aá]l?\b[^,.!?]{0,25}?\b(?:nekem|kolcsonad\w*)|kolcsonadn[aá]l|kolcsonadsz\b|adj (?:nekem |m[aá]r )?(?:kolcson\w*|penzt|penz\b|\d)|add nekem (?:kolcson|penz)\w*|kolcsonker\w*|kern[eé]k (?:nekem )?kolcson\w*|kerek (?:nekem )?kolcson\w*|szuksegem (?:van|lenne)\b|kellene\b|kell nekem\b|nincs (?:penzem|penz)\b|csod vagyok|penz nelkul vagyok)`],
    // V offers the character money: "kölcsönadok neked", "adhatok kölcsön", "ha kell" offers are polite; the verb with "neked" (you) is the giver.
    ['lend', String.raw`\b(?:kolcsonadok|kolcsonadom|kolcsonadhatok|kolcsonadnek|kolcsonadn[eé]k|kolcson tudok|kolcson tudnek|adhatok kolcson\w*|adok kolcson\w*|adok neked\b[^,.!?]{0,25}?\bkolcson\w*)\b`],
    // V gives the character money: a gift, a tip, thanks for an effort, with or without a verb.
    ['give', String.raw`\b(?:tessek|vedd|vegyed|fogd|tartsd meg|borravalo\w*|ajandek\w*|faradoz\w*|munk\w*ert|segitseg\w*|(?:neked|nekem) (?:adom|adok|szanom|fizetem|fizetek)|(?:adok|adom) neked|fizetek neked|fizetem neked|kifizetem(?![^,.!?]{0,15}?\b(?:a|az) (?:\w*(?:szaz|ezer|ezre|ezres)|\d))|kifizetek)\b`],
  ],
  // Not a question that asks ("nem tudnál kölcsönadni 50-et?", "nem adnál?"): "nem" before those does not refuse; "nem" inside "amíg ... nem kapok" is a time clause.
  negation: String.raw`\b(?:(?<!\bam[ií]g\b[^,.!?]{0,40}?)nem\b(?! (?:tudn[aá]\w*|adn[aá]\w*|kolcsonad\w*|fizetn\w*|k[eé]rn\w*|kellene\w*|lenne))|soha|sose|sem|senki|semmi)\b`,
  // A condition of V's own or of an imagined act ("ha lenne pénzem", "ha kölcsönadnék neked..."). "Ha kell" and "ha van kedved" are polite offers.
  hypothetical: String.raw`\b(?:ha (?:lenne|volna|lennek|lenn[eé]k|kolcsonadnek|kolcsonadn[eé]k|adnek|adn[eé]k|tudnek|tudn[eé]k|volnek)|tegy[uü]k fel|k[eé]pzeld el|k[eé]pzelj el|viccel\w*|hipotet\w*)\b`,
  // A conditional before the ask takes it back ("ha kölcsönadnék neked 500-at, visszafizetnéd?" is no ask).
  joke: String.raw`\b(?:ha (?:lenne|volna|lennek|lenn[eé]k|kolcsonadnek|kolcsonadn[eé]k|adnek|adn[eé]k|tudnek|tudn[eé]k|volnek)|tegy[uü]k fel|viccel\w*|hipotet\w*)\b`,
  // A time that is not now ("holnap visszaadom", "majd kölcsönadok", "tegnap fizettem").
  later: String.raw`\b(?:holnap\w*|majd|k[eé]s[oö]bb|tegnap\w*|j[oö]v[oö] (?:heten|h[oó]napban|[eé]vben)|m[uú]lt (?:heten|h[oó]napban|[eé]vben)|amikor lesz p[eé]nzem|ha lesz p[eé]nzem|m[aá]r visszaadtam|m[aá]r visszafizettem|m[aá]r fizettem|tavaly)\b`,
};
