// Italian money words for bridge/eddies-languages.mjs (the same shape as es.mjs, the worked example).
// Money nouns and slang (word end): never the verbs prestare, dare or dovere. "soldo"/"soldi", "grana", "quattrini", "palanche" are the slang players use.
const MONEY = String.raw`(?:euro|eur|soldo|soldi|denaro|quattrini|grana|palanche|contanti|cash|eddies?|crediti|debito|debiti|prestito|prestiti|bigliettoni|tesoretto|gruzzolo|moneta|monete|pecunia|mazzetta)\b`;
// A debt verb ("mi devi", "ti devo") counts as money talk only when its clause names a sum or money: "Mi devi una spiegazione, non soldi" is no ask.
// The clause before the verb counts too ("i 500 che ti devo").
const OWES = String.raw`(?:(?=[^!?;]*?(?:\d|${MONEY}))|(?<=^[^!?;]*(?:\d|${MONEY})[^!?;]*))`;

export default {
  language: 'it',
  money: MONEY,
  // Money talk without a noun: "ti sto ripagando" (repaying), "tieni pure il resto" (keep the change), "conto chiuso" (account settled).
  moneyPhrases: String.raw`ripag\w*|tieni (?:pure )?il (?:resto|cambio)\b|ti ridar[oò]\b|conto chiuso\b|che (?:ti|te) dov\w*|un kilo(?! di\b)\b`,
  // What may follow a sum as its currency. Mass words (soldi, grana) are money nouns only: "una grana" is an article, not a sum.
  unit: String.raw`(?:euro|eur|eddies?|crediti|dollari)\b`,
  // Words that may follow a bare sum ("300 per il taxi", "500 dai").
  after: String.raw`(?:per|per favore|per piacere|per cortesia|ti prego|ti supplico|dai|amico|fratello|choom|adesso|subito|ora|tanto|entro|e|o|oppure|grazie|basta|pure)\b`,
  // Words that make a number after a money verb something else ("dammi 5 minuti", "dammi 3 proiettili", "un kilo di pasta").
  notMoney: String.raw`\b(?:minut[oi]|second[oi]|ore|giorn[oi]|settiman[ae]|mes[ei]|ann[oi]|volt[ae]|person[ae]|chil[oi]|kg|met[ri]|km|colp[oi]|cartucc[ae]|proiettil[ei]|munizion[ei]|caff[eè]|birr[ae]|bicchier[ie]|bottigli[ae]|pezz[oi]|per cento|percento|cose|pass[oi]|pian[oi]|gradin[oi]|di)\b|%`,
  // Words that split a line into clauses.
  but: String.raw`\bma\b|\bpero\b|\banche se\b|\be poi\b|\bpoi\b|\be dopo\b`,
  // "fino a domani": the time is cut out before the time test, so "prestami 500 fino a domani" stays an ask.
  until: String.raw`fino a (?:domani|dopodomani|luned[iì]|marted[iì]|mercoled[iì]|gioved[iì]|venerd[iì]|sabato|domenica|stasera|la settimana prossima|il mese prossimo|la fine del mese)\b`,
  numbers: {
    // Units, teens, tens and the compound pieces. The tens lose their final vowel before "uno" and "otto" ("ventuno", "trentotto").
    words: {
      uno: 1, un: 1, una: 1, due: 2, tre: 3, quattro: 4, cinque: 5, sei: 6, sette: 7, otto: 8, nove: 9, dieci: 10, undici: 11, dodici: 12, tredici: 13,
      quattordici: 14, quindici: 15, sedici: 16, diciassette: 17, diciotto: 18, diciannove: 19, venti: 20, trenta: 30, quaranta: 40, cinquanta: 50,
      sessanta: 60, settanta: 70, ottanta: 80, novanta: 90,
      ventuno: 21, ventotto: 28, trentuno: 31, trentotto: 38, quarantuno: 41, quarantotto: 48, cinquantuno: 51, cinquantotto: 58, sessantuno: 61,
      sessantotto: 68, settantuno: 71, settantotto: 78, ottantuno: 81, ottantotto: 88, novantuno: 91, novantotto: 98,
    },
    // "cento" and "mila" multiply ("duecento" is 200, "duemila" 2000); "kilo" is the slang thousand ("un kilo" = 1000 euro).
    scales: {cento: 100, mille: 1000, mila: 1000, kilo: 1000},
    skip: ['e'],
    compound: true,
  },
  intents: [
    // V asks the character to pay back what the character owes V, or to give V's money back ("ridammi", "quando me li ridai", "ti ho prestato X").
    ['reclaim', String.raw`\b(?:${OWES}mi devi|ridammi|rendimi|restituiscimi|pagami|rimborsami|pagatemi|mi restituisci\b|mi ridai\b|mi ripaghi\b|ripagami|quando (?:mi|me)(?: (?:li|le|lo|la|ne))? (?:paghi|ridai|restituisci|ripaghi|ridarai|rendi|dai)\b|ti ricordi che mi devi|vuoi restituirmi|(?:ridar|restituir|rendere|render|pagar|rimborsar)mi\b|mi avevi (?:promesso|detto)|avevi promesso|ti ho (?:prestato|anticipato)\b|(?:voglio|vorrei|rivoglio) indietro|rivoglio\b|(?:voglio|vorrei|rivoglio) (?:indietro )?(?:i |il |le |la )?(?:miei|mio|mia|mie) (?:soldi|denaro|eddies|euro|quattrini))`],
    // V pays back what V owes: any tense of the debt ("che ti dovevo"), "ti ripago", "siamo pari".
    ['repay', String.raw`\b(?:ti (?:rid[oò]|restituisco|rimborso|ripago|ridar[oò]|ripagher[oò])\b|ti sto (?:ripagando|restituendo|rimborsando|ridando)|ti stavo (?:ripagando|restituendo)|(?:che|i|le|quelli|quello|ciò) ti dov(?:evo|evi|eva|evamo|evate|evano)\b|${OWES}ti devo|ecco (?:quello|ci[oò]) che ti devo|ecco i soldi che ti devo|siamo (?:pari|in pari|a posto)|mi sdebito|conto chiuso)`],
    // V offers a loan by asking whether the character needs money, or whether the character wants to borrow it: before borrow.
    ['lend', String.raw`\b(?:ti serv(?:ono|e)\s+(?:dei |qualche |un po' di |del )?(?:soldi|soldo|denaro|contanti|un prestito|euro|eddies|grana|palanche|quattrini)|ti serv(?:ono|e)\s+(?=\d)|hai bisogno di (?:soldi|denaro|contanti|un prestito|eddies|euro|quattrini|grana)|hai bisogno di (?=\d)|vuoi (?:dei |un po' di |qualche )?(?:soldi|denaro|contanti|un prestito|quattrini|grana|eddie|eddies)|vuoi farti (?:prestare|anticipare)|vuoi che ti (?:presti|anticipi|dia|mandi|faccia un prestito)|ti va un prestito)`],
    // V asks the character to lend (or give) V money: the imperative, the polite (Lei) and conditional forms, "da prestarmi", "passami".
    ['borrow', String.raw`\b(?:prestami|mi presti|mi prestaresti|mi presteresti|mi presterebbe|(?:mi |ci )?(?:pu(?:o|oi|ò)|potr\w*)\s+(?:prestar|anticipar|dar|passar|fare un prestito)\w*|(?:prestar|anticipar|dar|passar)mi\b|vuoi (?:prestar|anticipar|dar)mi\b|da prestarmi|passami|passatemi|mi dai|dammi|mi daresti|mi anticipi|anticipami|mi fai un prestito|sono (?:rimasto|rimasta|restato|rimaste?) senza|sono senza|sono al verde|sono in bolletta|sono (?:a secco|in rosso)|ho bisogno (?:di|d')|mi servono?|mi serve|mi servirebbe|mi servirebbero|mi occorre|mi occorrono|ti chiedo un prestito|mi basterebbe(?:ro)?|non mi presti|non mi dai|non mi presteresti|non mi anticipi|mi regali)`],
    // V offers to lend the character money.
    ['lend', String.raw`\b(?:ti presto|ti presterò|ti presterei|ti posso (?:prestare|anticipare)|posso (?:prestarti|anticiparti|prestartene|prestartelo)|ti faccio (?:un )?prestito|ti anticipo|ti posso dare un prestito|ti do un prestito|ti presto io)`],
    // V gives the character money: a gift, a tip, a payment, the change; the polite (Lei) "tenga"; a purpose phrase with no verb.
    ['give', String.raw`\b(?:tieni|tenga|tenete|prendi|prendete|prenda|ecco|ti do|ti dò|ti pago|ti mando|ti invio|ti trasferisco|ti faccio un bonifico|ti giro|ti bonifico|ti accredito|ti regalo|ti offro|ti lascio|è un regalo|un regalo|la mancia|tieni pure|è per te|per il disturbo|per il disagio|per le spese|per il taxi|per la corsa|per il viaggio|per il passaggio|per la mancia|per la festa|per la missione|per il lavoro|come regalo)`],
  ],
  // Not a negative question that still asks ("non mi presti 50 euro?"): a "non" anywhere else refuses the intent.
  negation: String.raw`^(?!.*\bnon (?:mi |ti |ci )?(?:puoi|potresti|pu[oò]|potrebbe|presti|presteresti|presterebbe|dai|daresti|anticipi|vuoi|passi|passeresti)\b)(?=.*\bnon\b)|\b(?:mai|nessun[oa]?|niente|nulla|nemmeno|neanche|neppure|nessuno)\b`,
  // A condition aimed at the character ("se ti serve", "se puoi", "se vuoi") is a polite offer; only V's own imagined action is hypothetical.
  hypothetical: String.raw`\b(?:se\b(?!\s+(?:ti |vi |ci |le |lo |ne |li |la )?(?:serv\w*|vuoi|vuole|volete|puoi|pu[oò]|potete|potresti|hai|ha|avete|bisogno|precis\w*|vuol\w*)\b)|ammesso che|immagina|immaginiamo|supponiamo|ipoteticamente|per scherzo|scherzo|per finta|come se|ipotesi|ammettiamo|per gioco)\b`,
  // "il prestito di ieri" names the loan, it is not a time: "ieri" counts only on its own.
  later: String.raw`\b(?:domani|pi[uù] tardi|tra poco|un giorno|prossima (?:settimana|volta)|il mese prossimo|(?<!di )ieri|l'altro ieri|stasera|quando (?:avrò|ho|riavrò|avrai|ce l'ho|ce l'avrò)|appena (?:avrò|ho)|ti (?:pagherò|ridarò|restituirò|ripagherò|darò)|ti ho (?:pagato|ridato|restituito|ripagato)|l'altro giorno|la settimana scorsa|dopo|tra [^,.!?;]{0,12}(?:giorni|settimane|mesi|anni))\b`,
};
