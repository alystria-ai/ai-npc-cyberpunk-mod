// German money words for bridge/eddies-languages.mjs (see es.mjs for the shape). German writes numbers as one word ("zweihundertfünfzig", "fünftausend"), so
// the engine segments compounds from numbers.words / numbers.scales: only units, teens and tens are listed as words; hundreds and thousands come from
// the scales, so "dreihundert" keeps its scale (a bare sum). Direction: "mir" is the one who receives (borrow), "dir" the one who gives (lend, give);
// debts: "ich ... dir ... schulde" is V paying, "du ... mir ... schuldest" is V being paid.
export default {
  language: 'de',
  // Nouns and slang for money. Not the verbs (leihen, zahlen, schulden): "ich schulde dir einen Gefallen" is no money.
  money: String.raw`eddies?|eddie|eds\b|euro\b|eur\b|dollars?|credits?|creds?|kohle|kr[oö]ten|moos|knete|zaster|schotter|penunze|piepen|pinke|moneten|geld|cash|bucks|taler|kredit|darlehen|trinkgeld|gehalt|lohn|m[aä]use\w*|scheine?\b|kies\b|cent\b|pfennig\w*|taschengeld|bares\b|[\p{L}]*tausend\w*|[\p{L}]*hundert\w*|riesen?\b`,
  // Verb and noun phrases that only money fits, with no noun ("passt so", "was ich dir schulde": the debt, "alles zurück").
  moneyPhrases: 'behalt(?:e|en)? den rest|passt so|stimmt so|keep the change|bin pleite|knapp bei kasse|zahl(?:e|st)? mich aus|was (?:ich|du|ihr|sie) (?:dir|dich|mir|mich|euch|ihnen|ihr)? ?(?:noch )?schuld\\w*|alles zur[uü]ck|die ich dir (?:noch )?schuld\\w*|schuldig war|schuldig bin|schuldete',
  // What may follow a sum as its currency.
  unit: 'eddies?|eddie|eds\\b|euros?|eur\\b|dollars?|credits?|creds?|kohle|kr[oö]ten|moos|knete|zaster|piepen|schotter|moneten|bucks|taler|pinke|m[aä]use',
  // Words that may follow a bare sum without a currency ("leih mir fünfhundert, bitte").
  after: String.raw`bitte|mal|kumpel|choom|chummer|alter|mann|digga|hier|f[uü]r|fur|und|oder|zur[uü]ck|jetzt|gleich|schon|ja|kurz|eben|dann|danke|ok|okay|hey|du|dir|dich|mir|mich|nimm|sofort|haver|leihen|vorstrecken|borgen|geben|pumpen|als|trinkgeld|kannst|kann|willst|wenn|wenn du|falls|sobald|bis|ab|nach`,
  // Words that make a number after a money verb something else ("gib mir fünf Minuten").
  notMoney: 'min\\b|minuten?|sek\\b|sekunden?|std\\b|stunden?|tage[ns]?\\b|wochen?|monate[ns]?|jahre[ns]?|personen?|leute|kilos?|kg\\b|meter|km\\b|st[uü]ck|kugeln?|sch[uü]sse|treffer|gramm|liter|biere?|mal\\b',
  but: String.raw`\baber\b|\bsondern\b|\bund dann\b|\bund danach\b`,
  // Until a day ("bis morgen" is no postponement of an ask): cut out before the time test.
  until: String.raw`bis (?:morgen|[uü]bermorgen|n[aä]chste\w* (?:woche|monat)|monatsende|wochenende|n[aä]chsten monat|ende der woche)`,
  numbers: {
    compound: true,
    words: {
      ein: 1, eins: 1, eine: 1, einen: 1, einem: 1, einer: 1, eines: 1, zwei: 2, zwo: 2, drei: 3, vier: 4, 'fünf': 5, sechs: 6, sieben: 7, acht: 8, neun: 9,
      zehn: 10, elf: 11, 'zwölf': 12, dreizehn: 13, vierzehn: 14, 'fünfzehn': 15, sechzehn: 16, siebzehn: 17, achtzehn: 18, neunzehn: 19,
      zwanzig: 20, 'dreißig': 30, vierzig: 40, 'fünfzig': 50, sechzig: 60, siebzig: 70, achtzig: 80, neunzig: 90,
    },
    scales: {hundert: 100, hunderter: 100, tausend: 1000, tausender: 1000, riese: 1000, riesen: 1000},
    skip: ['und'],
  },
  intents: [
    // V wants the character to pay back what the character owes V: "du schuldest mir", "du bist mir 300 schuldig", "du hast mir ... geliehen", "ich will sie zurück".
    ['reclaim', String.raw`\b(?:(?:zahl|zahlst|zahlen|bezahl|bezahlst)\w* (?:du )?(?:mir|mich)\b|zahl(?:e)? (?:mein|meine|meinen)\b|(?:du|ihr|sie|Sie) (?:schuldest|schuldet|bist|warst|schuldeten) (?:mir|mich)\b|schulden bei mir\b|(?:du|ihr|sie|Sie)\b[^,.!?]{0,30}?\bmir\b[^,.!?]{0,20}?\bschuld\w*|(?:du|ihr|sie|Sie) (?:hast|habt|haben|hattest|hatten) mir\b[^,.!?]{0,30}?\bgeliehen|ich (?:will|m[oö]chte|verlange|h[aä]tte gern)\b[^,.!?]{0,20}?\b(?:zur[uü]ck|wieder)\b|zur[uü]ck(?:haben|verlangen|fordern|bekommen|kriegen)|gib (?:mir )?(?:mein|meine|meinen|das|die|dein|deine) [^,.!?]{0,30}?(?:zur[uü]ck|wieder)\b|[uü]berweist (?:du )?mir\b|wann\b[^,.!?]{0,25}?\b(?:zahlst|gibst|bezahlst|[uü]berweist\w*|bringst|zur[uü]ck\w*)\b)`],
    // V pays back what V owes: "ich schulde dir", "die ich dir schuldig war", "ich zahl dir alles zurück", "wir sind quitt" (even).
    ['repay', String.raw`\b(?:ich (?:schulde|schuldete) (?:dir|dich)\b|meine schuld\w*|(?:zahl|zahle|bezahl|bezahle|geb|gebe)\w* (?:ich )?(?:dir|dich)\b[^,.!?]{0,25}?zur[uü]ck|(?:zahl|zahle|bezahl|bezahle|geb|gebe)\w* ich\b[^,.!?]{0,25}?\b(?:dir|dich)\b[^,.!?]{0,20}?zur[uü]ck|\bich\b[^,.!?]{0,30}?\b(?:dir|dich|euch|ihnen)\b[^,.!?]{0,15}?\bschuld\w*|\bich (?:hab|habe|hatte) dir [^,.!?]{0,20}?zur[uü]ck|\bich (?:hab|habe|hatte) dir (?:noch )?(?:was |etwas )?zu zahlen|wir sind (?:wieder )?(?:quitt|quits|kvitt)|sind wir (?:wieder )?(?:quitt|quits)|(?:wir sind|sind wir) quitt)\b`],
    // V asks whether the character needs money ("brauchst du Geld", "wenn du Geld brauchst", "willst du Geld leihen"): before 'borrow'.
    ['lend', String.raw`\b(?:brauchst (?:du )?(?:mal |grad |gerade |eben |noch |so |ein |einen |paar )*(?:geld|kohle|eddies|kr[oö]ten|moos|knete|kredit|darlehen|m[aä]use\w*)|geld (?:brauchst|br[aä]uchst)|wenn du (?:mal |grad )?(?:geld|kohle|eddies|kr[oö]ten|moos|knete|kredit|darlehen) brauchst|willst du (?:dir )?(?:geld|kohle|eddies|moos|kr[oö]ten|(?:'?n(?:en|e)?|ein|einen) kredit|ein darlehen)|willst du (?:dir )?(?:geld |kohle |was )?(?:leihen|borgen)|m[oö]chtest du (?:dir )?(?:geld |kohle |eddies )?(?:leihen|borgen|haben)|soll ich dir (?:geld |was |\d)?(?:leihen|vorstrecken|vorschie(?:ß|ss)en|borgen))\b`],
    // V asks the character to lend (or give) V money: a verb with "mir" (the one who receives) in a request, a conditional or a relative clause.
    ['borrow', String.raw`\b(?:(?:kannst|k[oö]nnt\w*|w[uü]rd\w*|h[aä]tt\w*|willst|magst|darf\w*|m[oö]chtest|w[aä]rst|kannste|h[aä]ttest|k[oö]nntest|k[oö]nnte|w[uü]rdest)\s+(?:du|ihr|sie|Sie|er)?\s*(?:mir|mich)\b[^,.!?]{0,40}?\b(?:leih\w*|vorstreck\w*|vorschie(?:ß|ss)\w*|borg\w*|pump\w*|aush[eü]lf\w*|geb\w*|gib|schick\w*|[uü]berweis\w*|verleih\w*)|(?:du|ihr|sie|Sie) mir\b[^,.!?]{0,40}?\b(?:leihen|vorstrecken|vorschie(?:ß|ss)en|borgen|pumpen|aush[eü]lfen|geben)\b|leih(?:e|st|ste)? (?:mir|mich)\b|borg(?:e|st)? (?:mir|mich)\b|pump(?:e|st|en)? (?:mir|mich)\b|gib (?:mir|mich)\b(?![^,.!?]{0,15}?\b(?:die|das|den|dem|meine|mein)\b)|h[aä]tteste\b|gibst du mir\b|kann ich mir\b|k[oö]nnte ich mir\b|ich brauch(?:e|st)?\b|ich (?:bin|war) (?:pleite|blank|knapp|abgebrannt|klamm)|ich hab (?:kein|keine|keinen|gar kein)e? (?:geld|kohle|cent|eddies)|hast du (?:mal |vielleicht |zuf[aä]llig )?[^,.!?]{0,25}?f[uü]r mich\b|hilf(?:st)? (?:du )?mir (?:mal )?aus\b|helf mir aus\b|spot me\b|float me\b|gib (?:mir )?(?:einen|nen) kredit)`],
    // V offers the character money ("ich kann dir 400 vorstrecken, wenn du willst", "soll ich dir ... vorstrecken?"): the verb with "dir" is the giver.
    ['lend', String.raw`\b(?:ich (?:leih|leihe|verleih|verleihe|streck|strecke|schie(?:ß|ss)e) (?:dir|dich)\b|(?:ich (?:kann|k[oö]nnte|w[uü]rde|werde)|k[oö]nnte ich|w[uü]rde ich|kann ich) (?:dir|dich)\b[^,.!?]{0,40}?\b(?:leihen|vorstrecken|vorschie(?:ß|ss)en|borgen|verleihen)\b|soll ich dir\b[^,.!?]{0,40}?\b(?:leihen|vorstrecken|vorschie(?:ß|ss)en|borgen))`],
    // V gives the character money: a gift, a tip, an award or a fee, with or without a verb.
    ['give', String.raw`\b(?:hier,? (?:nimm|bitte nimm|hast du|hab|das ist f[uü]r dich|ist f[uü]r dich|das ist das)|hier sind\b[^,.!?]{0,25}?\b(?:als|trinkgeld|dank|f[uü]r)\b|nimm\b|trinkgeld|f[uü]r dich\b|behalt(?:e|en)? (?:den rest|die|das|den)\b|dankesch[oö]n|stimmt so|passt so|das ist mein|schmei(?:ß|ss)e?\b|f[uü]r (?:deine|die|dein|eure|ihre|seine)? ?(?:m[uü]he|hilfe|arbeit|dienste?|geduld|fahrt|mitarbeit|unterst[uü]tzung|zeit)\b|als (?:dank|belohnung|bezahlung|lohn|gratifikation|anerkennung|trinkgeld)\b|f[uü]r den auftrag|du bekommst|ich (?:geb|gebe|schenk|schenke|[uü]berweis|[uü]berweise|zahl|zahle|bezahl|bezahle) (?:dir|dich)\b(?![^,.!?]{0,20}?\b(?:die|das|den|dem|der|diese)\b[^,.!?]{0,15}?\d)|ich zahl's dir\b)`],
  ],
  // Not a negative question that asks ("kannst du mir nicht 50 leihen?", "könnten Sie mir nicht helfen"): "nicht" after those openings does not refuse.
  negation: String.raw`\b(?:(?<!\b(?:kannst|k[oö]nntest|k[oö]nnten|k[oö]nnt\w*|h[aä]ttest|w[uü]rdest|w[uü]rden|magst|willst|wirst|kann|k[oö]nnte|w[uü]rde|m[oö]chtest) (?:du |ihr |sie |Sie )?(?:mir |mich |uns |euch )?)nicht\b|nie\b|niemals|kein(?:e|en|em|er|es)?\b|nichts|niemand|nix|weder|ohne|nimmer|keinesfalls|nicht mal|nichtmal|soha)`,
  // A condition of V's own or an imagined act ("wenn ich dir ... leihen würde", "if I had money", "stell dir vor"). A condition aimed at "you" that
  // offers ("wenn du willst", "wenn du Geld brauchst") is no condition.
  hypothetical: String.raw`\b(?:wenn ich|wenn wir|wenn mir|falls ich|sofern ich|angenommen|stell(?:e|t)? (?:dir|euch) vor|hypothetisch|h[aä]tte ich|h[aä]tt(?:e)? ich|aus spa(?:ß|ss)|im scherz|scherz|witz|nur so|wenn (?:du|ihr|sie|Sie)\b[^,.!?]{0,40}?\b(?:w[uü]rdest|w[aä]re|h[aä]ttest|w[aä]rst|w[uü]rden))\b`,
  // A time that is not now (the "bis morgen" of an ask is cut out by `until` first).
  later: String.raw`\b(?:morgen|[uü]bermorgen|sp[aä]ter|nachher|gestern|vorgestern|irgendwann|bald|demn[aä]chst|sobald|nachtr[aä]glich|n[aä]chste[nrs]? (?:woche|monat|jahr|mal)|letzte[nrs]? (?:woche|monat|jahr|mal)|n[aä]chsten monat|wenn ich (?:wieder|irgendwann|mal|sp[aä]ter|geld|kohle|was) (?:habe|hab|verdiene|bekomme)|erst (?:wenn|dann))\b`,
};
