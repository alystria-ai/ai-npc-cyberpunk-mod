// Portuguese money words for bridge/eddies-languages.mjs (the same shape as es.mjs, the worked example). Brazilian and European phrasing both.
// Money nouns and slang (word end): reais, euros, grana, guita (PT), bufunfa, tutu (BR), dinheiro, pix, pila, mangos, paus (1000 in PT slang).
// Left out on purpose: "cacau" (cocoa), "real" (true), "massa" (dough), "pasta" (pasta), "troco" (change; only "fica com o troco" is a phrase), "balas" (sweets, bullets).
const MONEY = String.raw`(?:reais|euros?|eur|eddies?|d[oó]lares?|dolares?|cr[eé]ditos?|creds?|dinheiro|dinheirinho|grana|guita|maquia|bufunfa|tutu|pix|pila|pilas|mangos?|paus|cent[ií]mos?|tost[oõ]es?|moedas?|empr[eé]stimo|d[ií]vidas?|d[ií]vida)\b`;
// A debt verb ("me deves", "te devo") counts as money talk only when its clause names a sum or money: "Me deves uma explicação, não dinheiro" is no ask.
// The clause before the verb counts too ("os 500 que te devo").
const OWES = String.raw`(?:(?=[^!?;]*?(?:\d|${MONEY}))|(?<=^[^!?;]*(?:\d|${MONEY})[^!?;]*))`;

export default {
  language: 'pt',
  money: MONEY,
  // Money talk without a noun: "fica com o troco" (keep the change), "estou te pagando de volta" (repaying), "que eu te devia" (what I owed you).
  moneyPhrases: String.raw`fica com (?:o|a) (?:troco|resto)\b|o que (?:te|me) dev\w*|(?:pag|devolv|reembols)\w*ndo de volta\b|[ée] para o (?:inc[oô]modo|transtorno|t[aá]xi)\b`,
  // What may follow a sum as its currency. Mass words (grana, guita, dinheiro) are money nouns only: "uma grana" is an article, not a sum. "paus" is the thousand unit.
  unit: String.raw`(?:reais|euros?|eur|eddies?|d[oó]lares?|dolares?|cr[eé]ditos?|creds?|paus|cent[ií]mos?|tost[oõ]es?|moedas?)\b`,
  // Words that may follow a bare sum ("500 por favor", "300 pra você", "500 que eu te devo").
  after: String.raw`(?:por favor|pfv|pfvr|pf|por gentileza|pelo amor de deus|vai|cara|mano|meu|irm[aã]o|valeu|agora|j[aá]|logo|para|pra|pro|por|e|ou|bora|de|que)\b`,
  // Words that make a number after a money verb something else ("dá-me 5 minutos", "dá-me 3 tiros").
  notMoney: String.raw`\b(?:minutos?|segundos?|horas?|dias?|semanas?|meses|anos?|vezes|pessoas?|quilos?|kg|metros?|km|balas|tiros|cartuchos|muni[cç][oõ]es|cervejas?|copos?|garrafas?|coisas?|palavras?|pontos?|andares?|degraus|passos|vez)\b|%`,
  // Words that split a line into clauses.
  but: String.raw`\bmas\b|\bporem\b|\bentretanto\b|\be depois\b|\bso que\b`,
  // "até amanhã", "até ao fim do mês": the time is cut out before the time test, so "empresta 500 até amanhã" stays an ask.
  until: String.raw`at[eé] (?:ao |a |à )?(?:fim do m[eê]s|amanh[aã]|depois de amanh[aã]|hoje|segunda(?:-feira)?|ter[cç]a(?:-feira)?|quarta(?:-feira)?|quinta(?:-feira)?|sexta(?:-feira)?|s[aá]bado|domingo|pr[oó]xima semana|a semana que vem|o m[eê]s que vem)\b`,
  numbers: {
    words: {
      um: 1, uma: 1, dois: 2, duas: 2, tres: 3, quatro: 4, cinco: 5, seis: 6, sete: 7, oito: 8, nove: 9, dez: 10, onze: 11, doze: 12, treze: 13,
      catorze: 14, quatorze: 14, quinze: 15, dezasseis: 16, dezesseis: 16, dezassete: 17, dezessete: 17, dezoito: 18, dezenove: 19, dezanove: 19,
      vinte: 20, trinta: 30, quarenta: 40, cinquenta: 50, sessenta: 60, setenta: 70, oitenta: 80, noventa: 90,
      cem: 100, cento: 100, duzentos: 200, duzentas: 200, trezentos: 300, trezentas: 300, quatrocentos: 400, quatrocentas: 400, quinhentos: 500,
      quinhentas: 500, seiscentos: 600, seiscentas: 600, setecentos: 700, setecentas: 700, oitocentos: 800, oitocentas: 800, novecentos: 900,
      novecentas: 900,
    },
    // "mil" is the thousand; "conto" and "contos" are the slang for a thousand (um conto, dois contos).
    scales: {mil: 1000, conto: 1000, contos: 1000},
    skip: ['e'],
  },
  intents: [
    // V asks the character to pay back what the character owes V: "você me deve", "me deves" (2nd person, no subject), "quero meu dinheiro de volta",
    // "você pegou X emprestado", "tinhas prometido devolver", "quando é que me pagas".
    ['reclaim', String.raw`\b(?:${OWES}(?:voc[eê]|tu|vc|c[eê])\s+(?:ainda\s+)?me\s+deves?|${OWES}me\s+deves|(?:voc[eê]|tu|vc|c[eê])\s+(?:ainda\s+)?me\s+(?:devolve|devolves|reembolsa|reembolsas|restitui|restituis|paga|pagas|pagues)\b|me\s+(?:devolve|reembolsa|restitui|paga)\b|me\s+(?:pagas|devolves|reembolsas|restituis)\b|quando (?:[ée] que )?(?:voc[eê] |tu |vc |c[eê] )?me (?:pag[ao]s?|pagues|devolv[ae]s?|reembols[ae]s?|restitu[ií]s?|deves)\b|(?:pagas|devolves|reembolsas|restituis)-me\b|cad[eê] (?:o |a |os |as )?(?:dinheiro|grana|reais|euros)\b|quero (?:o |a )?(?:meu|minha|meus|minhas) (?:dinheiro|grana|eddies|reais|euros|paus)\b|(?:prometeste|prometes|tinhas prometido|tinha prometido|prometeu|prometido)\s+(?:me\s+)?(?:devolver|pagar|restituir|reembolsar)\b|(?:voc[eê]|tu) (?:pegou|pegaste|emprestou|emprestaste) [^!?;]{0,30}?emprestad[oa]s?\b|(?:eu )?te emprestei\b)`],
    // V pays back what V owes: any tense of the debt, the gerund ("estou a devolver-te", "tô te pagando"), "acertei as contas", "estamos quites".
    ['repay', String.raw`\b(?:${OWES}devo-te|${OWES}te devo|${OWES}eu te devo|devolvo-te|te devolvo\b|te reembolso\b|reembolso-te|te pago o que|pago-te o que|o que (?:te|me) dev\w*|(?:que|o que|os que|as que) (?:eu )?te dev\w*|aqui (?:tens|tem|est[aá]|est[aã]o) o que|(?:t[oô]|estou|estava|estive) (?:a )?te (?:pag|devolv|reembols|restitu)\w*|(?:t[oô]|estou|estava) (?:a )?(?:devolv|reembols|restitu)\w*-te|acert\w* (?:as )?contas|(?:ficamos|estamos|tamo|t[aá]|somos) quites\b|(?:ficamos|estamos) conversados|(?:ficamos|estamos) em dia)`],
    // V offers a loan by asking whether the character needs money, or wants to borrow it: before borrow.
    ['lend', String.raw`\b(?:(?:precisas|precisa|precisam|queres|quer|quereis|querem|vais precisar|vai precisar|v[aã]o precisar)\s+(?:de\s+)?(?:algum\s+|um pouco de\s+|uns\s+|umas\s+)?(?:dinheiro|grana|guita|maquia|empr[eé]stimo|bufunfa|tutu|pix|pila|pilas|paus)\b|(?:queres|quer|quereis|querem) pegar emprestad\w*|queres que te empreste|quer que eu te empreste|quer que eu empreste|precisas de ajuda financeira|precisa de ajuda financeira)`],
    // V asks the character to lend V money: "me empresta", "empresta-me", "poderias emprestar-me", "me adianta", "me dá uma força com", "não rola uma grana".
    ['borrow', String.raw`\b(?:me emprest\w*|emprest\w*-me\b|(?:podes|poderias|poderia|pode|consegues|conseguirias|conseguiria) (?:me )?emprest\w*|(?:quero|queria|preciso) pegar emprestad\w*|me adiant\w*|adiant\w*-me\b|me d[aá] (?:uma )?for[cç]a|me d[aá]\b|d[aá]-me\b|me arruma\b|arruma-me\b|(?:n[aã]o )?rola (?:uma |um |mais |umas |uns )?(?:grana|dinheiro|emprest\w*|empr[eé]stimo|pix|guita)|estou (?:sem grana|liso|duro|teso|falido|sem dinheiro)|t[oô] (?:sem grana|liso|duro|teso|falido|sem dinheiro)|preciso de|preciso (?:de )?(?:um )?empr[eé]stimo|me faz um empr[eé]stimo)`],
    // V offers to lend the character money: "eu te empresto", "posso emprestar-te", "posso adiantar" (the first person; the second person is borrow).
    ['lend', String.raw`\b(?:(?:eu )?te emprest(?:o|ar|aria|are|arei)\b|vou (?:te )?emprestar|posso (?:te )?emprestar|te posso emprestar|posso emprestar-te|vou emprestar-te|emprest\w*-te\b|(?:eu )?te adiant\w*|vou (?:te )?adiantar|posso (?:te )?adiantar|adiant\w*-te\b|te dou um emprest\w*)`],
    // V gives the character money: a gift, a tip, a payment, the change; a purpose phrase with no verb.
    ['give', String.raw`\b(?:toma|pega|leva|toma a[ií]|pega a[ií]|aqui (?:tens|tem|est[aá]|est[aã]o|vai)|eu te pago|te pago|pago-te|vou-te pagar|dou-te|te dou|te mando|te envio|te transfiro|te fa[cç]o um pix|[ée] pra (?:voc[eê]|ti)|[ée] para (?:ti|voc[eê])|gorjeta|fica com (?:o|a) (?:troco|resto)|[ée] um presente|um presente|para o (?:inc[oô]modo|t[aá]xi|taxi|uber|trajeto|transtorno|trabalho|esfor[cç]o|servi[cç]o)|pel[oa]s? (?:corrida|viagem|miss[aã]o|ajuda|transtorno|inc[oô]modo|t[aá]xi|trajeto|esfor[cç]o|servi[cç]o|favor)|para as despesas|pelas despesas|como presente)`],
  ],
  // Not a negative question that still asks ("não me empresta 50?", "não rola uma grana?"): "não" and the rest refuse the intent, the question forms do not.
  negation: String.raw`^(?!.*\bn[aã]o (?:me |te )?(?:empresta|emprestas|d[aá]s?|d[aá]|podes|pode|poderias|poderia|adianta|adiantas|arruma|rola|tem|tens|sobra|sobram|devolveu|devolveste|pagou|pagaste|reembolsou|restituiu)\b)(?=.*\bn[aã]o\b)|\b(?:nunca|jamais|ningu[eé]m|(?<!agora )nada|nenhum|nenhuma|nem)\b`,
  // A condition aimed at the character ("se precisar", "se quiseres", "se você quiser") is a polite offer; only V's own imagined action is hypothetical.
  hypothetical: String.raw`\b(?:se\b(?!\s+(?:me |te |lhe |voc[eê] |tu |vc |o senhor |a senhora )?(?:precisar|precisares|precisarem|precisas|precisa|quiseres|quiser|quiserem|queres|quer|puderes|puder|puderem|tiveres|tiver|tiverem|pudermos|quisermos)\b)|imagina\b|imagine\b|supon(?:ha|hamos)\b|supondo\b|hipoteticamente\b|de brincadeira\b|brincadeira\b|zoeira\b|como se\b|fingindo\b|e se\b)`,
  // "o empréstimo de ontem" names the loan, it is not a time: "ontem" counts only on its own.
  later: String.raw`\b(?:amanh[aã]|mais tarde|daqui a pouco|um dia|na pr[oó]xima semana|semana que vem|m[eê]s que vem|(?<!de )ontem|anteontem|depois|quando (?:eu )?(?:tiver|receber|conseguir|puder|tenho)|assim que (?:eu )?(?:receber|tiver|conseguir)|vou te pagar|vou-te pagar|te pagarei|te devolverei|te reembolsarei|j[aá] (?:te )?(?:paguei|devolvi|reembolsei)|te (?:paguei|devolvi|reembolsei)|paguei-te|devolvi-te|reembolsei-te|no s[aá]bado)\b`,
};
