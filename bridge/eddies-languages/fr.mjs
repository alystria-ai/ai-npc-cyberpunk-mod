// French money words for bridge/eddies-languages.mjs (the same shape as es.mjs, the worked example).
// Money nouns and slang (word end). "balles" stays out (bullets: "donne-moi 3 balles" would be an ask); "sous" (under) and "billet" alone (ticket) too.
const MONEY = String.raw`(?:eddies?|eddys?|edis?|eurodollars?|euros?|dollars?|creds?|cr[ée]dits?|fric|thunes?|tunes?|pognon|oseille|bl[ée]|flouze|p[eè]ze|grisbi|p[ée]pettes|monnaie|argent|dettes?|cash|billets? de banque)\b`;
// A debt verb ("tu me dois", "je te dois") counts as money talk only when its own clause names a sum or money: "Tu me dois une explication, pas de l'argent" is no ask.
// It looks at the whole clause, before the verb too ("les 500 que tu me dois"), and is placed before the verb in the intents.
const OWES = String.raw`(?:(?=[^!?;]*?(?:\d|${MONEY}))|(?<=^[^!?;]*(?:\d|${MONEY})[^!?;]*))`;

export default {
  language: 'fr',
  money: MONEY,
  // Money talk without a noun: "garde le reste" (keep the change), "rembourser", "un petit prêt".
  moneyPhrases: String.raw`rembours|un (?:petit )?pr[eê]t\b|pr[eê]t d'argent|ce que (?:je|tu) (?:te|me) (?:dois|devais)|garde le reste|que (?:tu|vous) me (?:rend|rembours|pai|pay)\w*|\b(?:mille|cents?) (?:pour|par) (?:la |le |ta |ton |ces |cette |tes |mes |vos |votre )?(?:mission|peine|course|trajet|taxi|travail|boulot|aide|services?)\b`,
  // What may follow a sum as its currency. Mass words (thune, fric, blé) are money nouns only: "une thune" is an article, not one.
  unit: String.raw`(?:eddies?|eddys?|edis?|eurodollars?|euros?|dollars?|creds?|cr[ée]dits?|briques?|thunes|tunes|cash)\b`,
  // Words that may follow a bare sum ("500 pour le taxi", "300 s'il te plaît").
  after: String.raw`(?:pour|svp|stp|s'il (?:te|vous) pla[iî]t|pitié|mon (?:pote|frère|vieux)|frérot|mec|choom|maintenant|tout de suite|vite|hein|quoi|a|et|ou|fissa)\b`,
  // Words that make a number after a money verb something else ("donne-moi 5 minutes", "dix cartouches").
  notMoney: String.raw`\b(?:min|minutes?|secondes?|sec|heures?|h|jours?|semaines?|mois|ans?|ann[ée]es?|fois|personnes?|kilos?|kg|m[eè]tres?|km|cartouches?|munitions?|verres?|bi[eè]res?|caf[ée]s?|bouteilles?|coups?|tirs?|pas|pour ?cent|clopes?|cigarettes?|points?|[ée]tages?)\b|%`,
  // Words that split a line into clauses.
  but: String.raw`\bmais\b|\bpourtant\b|\bsauf que\b|\bet puis\b|\bpar contre\b|\bet apr[eè]s\b|\bet ensuite\b`,
  // "jusqu'à demain": the time is cut out before the time test, so "lend me 500 until tomorrow" stays an ask.
  until: String.raw`jusqu'(?:à|a) (?:demain|apr[eè]s-demain|ce soir|lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche|la semaine prochaine|la fin du mois|le mois prochain|la fin de la semaine)\b`,
  numbers: {
    words: {
      un: 1, une: 1, deux: 2, trois: 3, quatre: 4, cinq: 5, six: 6, sept: 7, huit: 8, neuf: 9, dix: 10, onze: 11, douze: 12, treize: 13, quatorze: 14,
      quinze: 15, seize: 16, vingt: 20, trente: 30, quarante: 40, cinquante: 50, soixante: 60, 'quatre vingt': 80, 'quatre vingts': 80,
    },
    // "cent" and "cents" multiply ("deux cents" is 200, not 102); "mille" and the slang "brique(s)" (1000 euros) too.
    scales: {cent: 100, cents: 100, mille: 1000, brique: 1000, briques: 1000},
    skip: ['et'],
  },
  intents: [
    // V asks the character to pay back what the character owes V: the present, the future, the conditional-free asks, "I lent you X, I want it back".
    ['reclaim', String.raw`\b(?:rembourse[zr]?[- ]moi|rend(?:ez|s)?[- ]moi|me rembourser\b|tu comptes me rembourser|(?<!que )(?:tu|vous) (?:me |m')(?:rembourses?|rendez|rends|rendras|rembourseras|paies?|payes?|paieras)\b|${OWES}(?:tu|vous) me (?:dois|devez)|(?<!que )(?:tu|vous) m'(?:avais|avez|aviez|as|avait) (?:pr[eê]t|donn|avanc)\w*|(?<!que )(?:tu|vous) (?:as|avez|avais|aviez) emprunt\w*|je t'(?:ai|avais) pr[eê]t\w*|(?:il est temps|il faut|grand temps|c'est l'heure|ça suffit) que (?:tu|vous) me (?:rend|rembours|pay|pai)\w*|quand (?:est-ce que )?(?:tu|vous) me (?:pai|pay|rembours|rend)\w*|je veux (?:les |mon |mes |ma |le |la )?r[eé]cup\w*|je veux (?:mon|mes|ma) (?:argent|fric|thunes?|pognon|eddies|euros|sous)|(?:tu|vous) peux me payer)`],
    // V pays back what V owes: any tense of the debt ("que je te devais"), "je te rembourse", "on est quittes".
    ['repay', String.raw`\b(?:je te rembourse\w*|je te rends\b|${OWES}j'?te dois|${OWES}je te dois|(?:ce|ça|que|qui) je te (?:dois|dev\w*|dû\w*)\b|voil[aà] ce que je te|voici ce que je te|(?:on est|nous sommes) (?:à )?quittes?\b|je m'acquitte|je te r[eè]gle|je te paie ce que je te|je te paye ce que je te)`],
    // V offers a loan by asking whether the character needs money, or whether the character wants to borrow it: before borrow.
    ['lend', String.raw`\b(?:(?:tu|vous|t')\s*(?:as|avez|aurais|auriez)?\s*besoin\s+(?:d'|de |du |des )?|(?:tu|vous|t')\s*(?:veux|voulez|voudrais|voudriez)\s+|veux-tu\s+|voulez-vous\s+)(?:un petit |un peu d'|un peu de |quelques |de l'|de la |du |des |un |une )?(?:argent|thune|fric|pognon|eddies|euros|pr[eê]t|oseille|bl[ée]|flouze|liquide)|(?:tu|vous|t')\s*(?:veux|voulez)\s+(?:emprunter\b|que\s+je\s+te\s+(?:pr[eê]t|avanc)\w*)|(?:tu|vous)\s+(?:veux|voulez)\s+que\s+je\s+te\s+(?:pr[eê]te|avance|donne)`],
    // V asks the character to lend (or give) V money: the imperative, the polite conditional and inverted forms, "tu me filerais pas", "il me faudrait".
    ['borrow', String.raw`\b(?:pr[eê]te?[- ]moi|pr[eê]tez[- ]moi|(?:tu|vous) (?:(?:veux|voulez)(?: bien)? )?me (?:pas )?(?:pr[eê]t|avanc|fil|don|d[eé]pann|pass)\w*|(?:tu|vous) m'(?:pr[eê]t|avanc|fil|don|d[eé]pann)\w*|(?:peux|pourrais|pourrait|pourriez|pouvez|peut|pourras|pourrez|pourraient|aurais|auriez|auras)(?:[- ](?:tu|vous|on|elle|il))?\s+(?:pas\s+)?me\s+(?:pr[eê]t|fil|avanc|d[eé]pann|don|pass)\w*|me (?:pr[eê]t|fil|avanc|d[eé]pann)\w*|pr[eê]t\w*-(?:tu|vous)\b|fil\w*-(?:tu|vous)\b|avanc\w*-(?:tu|vous)\b|m'avance\w*|avance[- ]moi|d[eé]panne[- ]moi|donne[- ]moi|file[- ]moi|il me fa(?:ut|ud)\w*|j'ai besoin|jai besoin|j(?:e|')?\s?suis\s+(?:fauch|raide|[àa] sec|sans le sou|ruin|dans le rouge)|suis (?:fauch|raide))`],
    // V offers to lend the character money.
    ['lend', String.raw`\b(?:je te pr[eê]t\w*|je peux (?:te |t')(?:pr[eê]ter|avancer)|je vais te pr[eê]ter|je pourrais te pr[eê]ter|je t'avance\w*|je te fais un pr[eê]t|je peux t'avancer)`],
    // V gives the character money: a gift, a tip, a payment, the change; a purpose phrase with no verb ("pour ta peine, deux cents eddies").
    ['give', String.raw`\b(?:tiens|prends|tenez|prenez|voil[aà]|voici|je te (?:donne|paie|paye|verse|envoie|transf[eè]re|vire|offre|r[eé]gale)|je t'(?:envoie|offre|donne|paie|paye|verse|vire)|c'est pour toi|c'est pour (?:le |la |les |ton |ta )?(?:taxi|trajet|caf[ée]|d[eé]placement|peine|d[eé]rangement|frais|mission|course)|pour (?:ta|ton|votre|vos|la|le|les|tes|mes|cette|ce) (?:peine|peines|d[eé]rangements?|mission|services?|travail|boulot|efforts?|aide|courage|frais|trajet|taxi|course|pourboire)|pour les (?:frais|peines|d[eé]rangements?|d[eé]sagr[eé]ments?)|pourboire|garde la monnaie|garde le reste|c'est (?:un |mon )?cadeau|un cadeau|je t'invite|c'est moi qui paie)`],
  ],
  // Not a negative question that still asks ("ne peux-tu pas me prêter 50 ?", "tu me filerais pas"); "ne ... pas" and the like refuse the intent.
  negation: String.raw`^(?!.*\b(?:peux|pourrais|pourrait|pourriez|pourras|pourrez|veux|voudrais|voulez)[- ](?:tu|vous)\s*pas\b)(?=.*\b(?:ne|n)\b).*\b(?:pas|plus|jamais|rien|personne|aucun|aucune)\b|\b(?:jamais|personne|aucun|aucune|nulle part|non|rien du tout)\b|\bje te \p{L}+ pas\b`,
  // A condition aimed at the character ("si tu veux", "si t'as besoin") is a polite offer; only V's own imagined action is hypothetical.
  hypothetical: String.raw`\b(?:si (?!(?:tu|t'|vous)\s*(?:veux|voulez|peux|pouvez|as besoin|avez besoin|as envie|avez envie|en as besoin|en avez besoin)\b)(?:je|j'|tu|t'|on|il|elle|nous|vous|ils|[çc]a|c'est)|et si|imagine|imaginons|suppose|supposons|hypoth[eé]tiquement|pour de faux|pour rire|je (?:blague|rigole|plaisante)|comme si|au cas o[uù]|en fait si)`,
  // "le prêt d'hier" names the loan, it is not a time: "hier" counts only on its own.
  later: String.raw`\b(?:demain|plus tard|tout (?:a|à) l'heure|bient[oô]t|un jour|prochainement|la semaine prochaine|le mois prochain|l'an prochain|(?<!d')hier|avant-hier|l'autre jour|quand (?:j'aurai|j'ai|je (?:pourrai|recevrai|toucherai))|d[eè]s que j'ai|une fois que j'aurai|je te (?:paierai|rembourserai|rendrai)|je t'ai (?:pay|rembours|rendu|donn)|la prochaine fois|dans [^,.!?;]{0,12}(?:jours?|semaines?|mois|ans?)|la semaine derni[eè]re|hier soir|ce soir|demain soir)\b`,
};
