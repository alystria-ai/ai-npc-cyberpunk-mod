// Polish money words for bridge/eddies-languages.mjs (the same shape as es.mjs; String.raw sources, folded: ą -> a, ł -> l, ż -> z ...).
export default {
  language: 'pl',
  // Money nouns and slang: eddies, edków, euro, pieniądze, kasa, forsa, hajs, szmal, gotówka, dług, grosz, złotych/zł (players use the zł sign
  // for the game's money too); the hundred and thousand words count (the screen reads a line with no digit only when a money word is in it).
  money: String.raw`(?<!(?:^|[^\p{L}])nie )(?:eddi\p{L}*|edk\p{L}*|eurodolar\p{L}*|euro\b|dolar\p{L}*|pieni(?:adz|edz)\p{L}*|kas[aeyi]\p{L}*|fors\p{L}*|hajs\p{L}*|szmal\p{L}*|gotowk\p{L}*|kredyt\p{L}*|pozyczk\p{L}*|grosz\p{L}*|zl\b|zlot\p{L}*|dlug(?:u|ow|iem|ach|ami)?\b|tysi\p{L}*|tys\b|stow\p{L}*|setk\p{L}*|setek|(?:sto|dwiescie|trzysta|czterysta|piecset|szescset|siedemset|osiemset|dziewiecset|dwustu|trzystu|czterystu|pieciuset|szesciuset|siedmiuset|osmiuset|dziewieciuset)(?!\s+(?:procent|raz|razy|lat|minut|osob|metr|km|krok|slow|dni))\b)`,
  // Verb phrases and idioms that are money talk with no noun or sum: keep-the-change, "rozlicz się", "wyrównajmy rachunki", "które ci wisiały".
  moneyPhrases: String.raw`reszty nie trzeba|reszta dla ciebie|rozlicz\p{L}*|wyrownaj\p{L}*|rachunk\p{L}*|(?:ktore|ktorych|co|te|to co) (?:ci |mi )?(?:wisial\p{L}*|bylem ci winien|bylam ci winna|bylem winien|bylam winna|byly ci winne|bylo ci winne|pozyczal\p{L}*|pozyczylem|pozyczylam)`,
  // What may follow a sum as its currency.
  unit: String.raw`eddi\p{L}*|edk\p{L}*|eurodolar\p{L}*|euro\b|dolar\p{L}*|kas[aey]\p{L}*|fors\p{L}*|hajs\p{L}*|szmal\p{L}*|pieni(?:adz|edz)\p{L}*|gotowk\p{L}*|zl\b|zlot\p{L}*`,
  // Words that may follow a bare sum ("dasz mi stówę na piwo", "stówa do wypłaty").
  after: String.raw`(?:na|za|dla|do|prosze|kolego|bracie|stary|mordo|ziomek|dzieki|teraz|zaraz|szybko|no|co)\b`,
  // Words that make a number after a money verb something else ("daj mi 5 minut").
  notMoney: String.raw`minut\p{L}*|sekund\p{L}*|godzin\p{L}*|dni\b|dzien\b|raz\b|razy\b|razow\b|lat\b|rok\p{L}*|miesi[aą]c\p{L}*|miesiac\p{L}*|tygodn\p{L}*|tydzien\b|osob\p{L}*|ludzi|kilogram\p{L}*|kg\b|metr\p{L}*|km\b|nabo\p{L}*|kul\p{L}*|strza\p{L}*|krok\p{L}*|procent\p{L}*|%|slow\b|slowa\b|pieter\p{L}*|pytan\p{L}*|butelk\p{L}*|kieliszk\p{L}*|piw\p{L}*`,
  // "until tomorrow" phrases: cut out before the time test, so "daj stówę do wypłaty" is still an ask.
  until: String.raw`do jutra|do wyplaty|do piatku|do poniedzialku|do przyszlego tygodnia|do konca tygodnia`,
  // Clause breaks inside a line.
  but: String.raw`\bale\b|\bjednak\b|\bchoc\b|\bchociaz\b|\ba potem\b|\bi potem\b`,
  numbers: {
    words: {
      jeden: 1, jedna: 1, jedno: 1, jedną: 1, jednej: 1, jednego: 1,
      dwa: 2, dwie: 2, dwoch: 2,
      trzy: 3, trzech: 3,
      cztery: 4, czterech: 4,
      piec: 5, pieciu: 5,
      szesc: 6, szesciu: 6,
      siedem: 7, siedmiu: 7,
      osiem: 8, osmiu: 8,
      dziewiec: 9, dziewieciu: 9,
      dziesiec: 10, dziesieciu: 10,
      jedenascie: 11, jedenastu: 11,
      dwanascie: 12, dwunastu: 12,
      trzynascie: 13, trzynastu: 13,
      czternascie: 14, czternastu: 14,
      pietnascie: 15, pietnastu: 15,
      szesnascie: 16, szesnastu: 16,
      siedemnascie: 17, siedemnastu: 17,
      osiemnascie: 18, osiemnastu: 18,
      dziewietnascie: 19, dziewietnastu: 19,
      dwadziescia: 20, dwudziestu: 20,
      trzydziesci: 30, trzydziestu: 30,
      czterdziesci: 40, czterdziestu: 40,
      piecdziesiat: 50, piecdziesieciu: 50,
      szescdziesiat: 60, szescdziesieciu: 60,
      siedemdziesiat: 70, siedemdziesieciu: 70,
      osiemdziesiat: 80, osiemdziesieciu: 80,
      dziewiecdziesiat: 90, dziewiecdziesieciu: 90,
      poltora: 1.5, poltorej: 1.5,
      pol: 0.5,
    },
    // Hundred and thousand, with the slang nouns (stówa, stówka, setka, tysiak) and the round hundreds (a bare "dwieście" is 200).
    scales: {
      sto: 100, stowa: 100, stowy: 100, stowe: 100, stowke: 100, stowka: 100, stowki: 100, stowek: 100,
      setka: 100, setki: 100, setke: 100, setek: 100,
      dwiescie: 200, dwustu: 200, trzysta: 300, trzystu: 300, czterysta: 400, czterystu: 400,
      piecset: 500, pieciuset: 500, szescset: 600, szesciuset: 600, siedemset: 700, siedmiuset: 700,
      osiemset: 800, osmiuset: 800, dziewiecset: 900, dziewieciuset: 900,
      tysiac: 1000, tysiaca: 1000, tysiace: 1000, tysiecy: 1000, tysiacem: 1000, tysiacu: 1000, tysiacach: 1000, tysiacami: 1000,
      tysiak: 1000, tysiaka: 1000, tysiaki: 1000, tysiakow: 1000, tysiaczek: 1000, tys: 1000,
    },
    // "dwa i pół tysiąca" is 2500: "i" between a number and "pół".
    skip: ['i'],
  },
  intents: [
    // V wants the character to pay back what the character owes V ("jesteś mi dwa tysiące winien", "obiecałeś oddać", "kiedy mi je zwrócisz").
    ['reclaim', String.raw`\b(?:oddaj mi|oddaj moje|zwroc mi|zwroc moje|jestes mi (?:\p{L}+ ){0,3}?winien|jestes mi (?:\p{L}+ ){0,3}?winna|jestes mi (?:\p{L}+ ){0,3}?winni|kiedy (?:mi )?(?:je |to )?(?:oddasz|zwrocisz|splacisz)\b|oddasz\b|oddawaj\b|splac dlug|splac mi|rozlicz sie|gdzie (?:moje|moja|moj|sa moje)|masz mi (?:cos )?oddac|mial(?:es|as) mi oddac|obiecales (?:mi )?(?:oddac|zwrocic)|chce (?:swoje|moje) (?:pieniadze|kase|kasy|hajs))`],
    // V pays back what V owes: "oto twoje", "jestem ci winien", "oddaję dług", "które ci wisiały", "jak obiecałem", "wyrównajmy rachunki".
    ['repay', String.raw`\b(?:jestesmy kwit\p{L}*|kwita\b|oto twoje|trzymaj (?:twoj |swoj )?dlug|jestem ci winien|jestem ci winna|jestem ci winni|(?:oddaje|zwracam|splacam|zwroce) (?:ci |tobie )?(?:\p{L}+ ){0,2}?dlug|oddaje ci|zwracam ci|zwroce ci|wyrownajmy|(?:ktore|ktorych|co|te|to co) (?:ci |mi |tobie )?(?:wisial\p{L}*|bylem ci winien|bylam ci winna|bylem winien|bylam winna|byly ci winne|bylo ci winne))`],
    // V asks whether the character needs money: an offer to lend. "Jeśli chcesz" is the character offering, not a condition.
    ['lend', String.raw`\b(?:potrzebujesz (?:\p{L}+ )?(?:kasy|pieniedzy|forsy|hajsu|kasiory|szmalu|pieniadze)|czy potrzebujesz|chcesz (?:troche |jakies |jakiejs )?(?:pieniedzy|kasy|forsy|hajsu|szmalu|pozyczk\p{L}*|pozycz\p{L}*)|chcesz (?=\p{L}* ?(?:tysi|stow|setk|tys\b)|\d[\d.,]*k? ?(?:eddi|edk|tys)))`],
    // V asks the character to lend (or give) V money. "pożyczę" / "mogę ci pożyczyć" is V's own offer, not an ask.
    ['borrow', String.raw`\b(?:(?<!moge ci )(?<!zebym ci )pozycz(?:ysz|yc)?\b|dasz\b|daj\b|podrzuc\b|podrzucisz\b|przelej\b|przelejesz\b|zrzuc\b|zrzucisz\b|wyslij\b|wyslesz\b|poratuj\b|potrzebuje\b|brakuje mi|splukan\p{L}*|moglbys mi|mogloby mi|prosic o\b|poprosic o\b|masz (?:jakas )?(?:gotowk\p{L}*|kase|kasy|forse|hajs\p{L}*)|pomozesz mi\b)`],
    // V offers to lend the character money.
    ['lend', String.raw`\b(?:pozycze ci|moge ci pozyczyc|moge ci (?:dac w pozyczke|zaliczkowac)|zaliczkow\p{L}*|dam ci w pozyczke|dam ci pozyczke|zebym (?:ci )?pozycz\p{L}*)`],
    // V gives the character money: a gift, a tip, keep-the-change, a payment for something. "oto" counts only with the sum right after it.
    ['give', String.raw`\b(?:trzymaj|bierz|wez|to dla ciebie|dla ciebie|na napiwek|napiwek|reszty nie trzeba|reszta dla ciebie|prezent|placze ci|zaplace ci|przelewam ci|wysylam ci|za przejazd|za kurs|za fatyg\p{L}*|za przysluge|za pomoc|z napiwkiem|oto(?= ?\d))`],
  ],
  // Not a negative question that asks ("nie pożyczysz 50?", "czy nie mógłbyś", "nie pomożesz"); "czy nie" is a question tag and "reszty nie trzeba" is keep-the-change.
  negation: String.raw`\b(?:ani|nic|nikt|nigdy|nigdzie|zadn\p{L}*)\b|(?<!czy )(?<!reszty )\bnie\b(?! (?:mozesz|moglbys|moglabys|mozecie|dasz|pozycz(?:ysz|yc)?|podrzucisz|przelejesz|zrzucisz|wyslesz|potrzebujesz|chcesz|masz|pomozesz|pomozecie|oddasz|zwrocisz)\b)`,
  // A condition is not an ask when it is V's own imagined act ("gdybym", "jeśli pożyczę", "jeśli ja"); "jeśli chcesz / potrzebujesz" is a polite offer.
  hypothetical: String.raw`\b(?:jesli (?!(?:chcesz|potrzebujesz|trzeba|ci|tobie|ty|mozesz|masz|sie|chcecie|potrzebujecie|potrzeba)\b)|jezeli (?!(?:chcesz|potrzebujesz|trzeba|ci|tobie|ty|mozesz|masz|sie|chcecie|potrzebujecie|potrzeba)\b)|gdyby|gdybym|gdybys|zalozmy|przypuscmy|wyobraz|hipotetycznie|zart|zartuje|zartuj|jakby)\b`,
  // Future and past: "tomorrow I'll pay you back", "I paid you yesterday". A past lend ("pożyczyłem ci") is the background of a reclaim, not a refusal.
  later: String.raw`\b(?:jutro|potem|pozniej|kiedys|wczoraj|przedwczoraj|za tydzien|w przyszlym tygodniu|w przyszlym miesiacu|w przyszlym roku|w poniedzialek|we wtorek|w srode|w czwartek|w piatek|w sobote|w niedziele|jak bede mial|jak bede miala|gdy bede mial|jak dostane|gdy dostane|zaplacilem|zaplacilam|zaplacili|oddalem|oddalam|oddali|przelalem|przelalam|wyslalem|wyslalam|zwrocilem|zwrocilam|splacilem|splacilam)\b`,
};
