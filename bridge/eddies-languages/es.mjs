// Spanish money words for bridge/eddies-languages.mjs (the worked example: every other language file has the same shape).
export default {
  language: 'es',
  // A clause with one of these is about money (word start).
  money: String.raw`eddies|eddie|eddys|edis|eds?\b|euros?|eurod[oó]lares?|d[oó]lares?|pavos|pasta|plata|lana|guita|pelas|billetes?|dinero|cash|cr[eé]ditos?|cr[eé]ds?|deuda|pr[eé]stamo|calderilla|luca|lucas|machacantes|pavo|pavos`,
  // Verb phrases that only money fits even with no noun or sum.
  moneyPhrases: String.raw`p[aá]game|pagarme|me pagues|lo que (?:me|te) deb|me deben|devu[eé]lveme (?:el|mi|lo)|saldar|el cambio|la vuelta|el vuelto|las vueltas|propina|estamos en paz|estamos a mano|quedamos a mano|a mano`,
  // What may follow a sum as its currency.
  unit: String.raw`eddies|eddie|eddys|edis|eds?|euros?|eurod[oó]lares?|d[oó]lares?|pavos|pesos|lana|pasta|pelas|cr[eé]ditos?|cr[eé]ds?|billetes?|lucas?`,
  // Words that may follow a bare sum ("dame 500 para la moto").
  after: String.raw`para|por|pa\b|de\b|que|y\b|o\b|ahora|ya\b|porfa|por favor|hermano|choom|amigo|y luego|hasta|cuando|colega|tio|tía`,
  // Words that make a number after a money verb something else ("dame 5 minutos").
  notMoney: String.raw`min|minutos?|segundos?|horas?|d[ií]as?|veces|a[nñ]os|meses|semanas?|personas?|kilos?|metros|km|cosas?|balas?|tiros?|%|vez|palabras?|cervezas?|copas?`,
  but: 'pero|aunque|y luego|y despu[eé]s',
  until: String.raw`hasta (?:ma[nñ]ana|el (?:lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo|d[ií]a \d+|fin de mes|mes que viene)|que (?:cobre|me paguen|llegue)|la paga|el cobro|fin de mes|la semana que viene)`,
  numbers: {
    words: {un: 1, uno: 1, una: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10, once: 11, doce: 12, trece: 13, catorce: 14,
      quince: 15, dieciseis: 16, diecisiete: 17, dieciocho: 18, diecinueve: 19, veinte: 20, veintiuno: 21, veintidos: 22, veintitres: 23, veinticuatro: 24,
      veinticinco: 25, treinta: 30, cuarenta: 40, cincuenta: 50, sesenta: 60, setenta: 70, ochenta: 80, noventa: 90, cien: 100, ciento: 100,
      doscientos: 200, doscientas: 200, trescientos: 300, trescientas: 300, cuatrocientos: 400, cuatrocientas: 400, quinientos: 500, quinientas: 500,
      seiscientos: 600, seiscientas: 600, setecientos: 700, setecientas: 700, ochocientos: 800, ochocientas: 800, novecientos: 900, novecientas: 900,
      'medio millar': 500, luca: 1000},
    scales: {mil: 1000, lucas: 1000},
    skip: ['y'],
  },
  intents: [
    ['reclaim', String.raw`\b(?:p[aá]game|devu[eé]lveme|dev[uú]elveme|me (?:debes|debias|adeudas|tienes que (?:pagar|devolver))|lo que me (?:debes|debias)|(?:mi )?(?:dinero|plata|pasta|lana) de vuelta|cu[aá]ndo me (?:vas a |va[s]? a )?(?:pag(?:as|ues|ar)|devuelv(?:es|as)|devolver)|ya me (?:pagas|devuelves)|es hora de que me (?:pagues|devuelvas)|salda tu deuda|devolverme|a ver cu[aá]ndo me (?:los|las|lo|la) (?:das|devuelves|pagas)|me prestaste|te prest[eé] [^,.]{0,30}(?:devu[eé]lve|dev[uú]elve|quiero|dame)|quiero (?:que me (?:devuelvas|pagues)|mi (?:dinero|plata|pasta)|(?:recuperar|que me devuelvas)))(?![\p{L}])`],
    ['repay', String.raw`\b(?:te (?:lo |los |las )?devuelvo|te (?:lo |los |las )?pago (?=lo que|la deuda|lo de|todo)|te debo|te debia|lo que te (?:debo|debia)|(?:los|las|lo) (?:\w+ )?que te (?:debia|debo)|aqu[ií] (?:tienes|est[aá]n?) (?:tu|el|lo|los|las)[^,.]{0,30}(?:te debia|te debo|dinero|plata)|salda mi deuda|estamos en paz|estamos a mano|quedamos a mano|pagarte|devolverte|cuentas claras|saldo (?:mi|la) deuda)\b`],
    ['lend', String.raw`\b(?:(?:necesitas|quieres|te hace falta|te falta|te hacen falta) (?:algo de |un poco de |unos |unas )?(?:dinero|plata|pasta|lana|eddies|pavos|un pr[eé]stamo)|quieres que te (?:preste|deje|adelante)|te hace falta alg[uú]n dinero|¿?necesitas pasta)`],
    ['borrow', String.raw`\b(?:pr[eé]stame|me (?:prestas|prestar[aá]s|puedes prestar|podr[ií]as prestar|podria[ns] prestar|puedes dejar|podr[ií]as dejar|das|puedes dar|podr[ií]as dar|adelantas|puedes adelantar|podr[ií]as adelantar|regalas|ayudas con|puedes echar una mano con)|puedes prestarme|podr[ií]as prestarme|podr[ií]a prestarme|me podr[ií]a prestar|dame|adel[aá]ntame|d[eé]jame|necesito (?:algo de |un poco de |unos |unas |\d|dinero|plata|pasta|un pr[eé]stamo|un adelanto|mil|cien)|estoy (?:sin|corto de|falto de) (?:dinero|plata|pasta|pavos|blanca)|estoy pelado|estoy sin blanca|ando (?:corto|pelado|sin)|me (?:hace|hacen) falta|me falta (?:dinero|plata|pasta)|puedo pedirte (?:dinero|prestado)|pedirte prestad[oa]|tienes (?:algo de )?(?:pasta|dinero|plata|lana) (?:que|para)|echame una mano con|me vendr[ií]a bien)(?![\p{L}])`],
    ['lend', String.raw`\b(?:te (?:presto|voy a prestar|puedo prestar|prestar[eé]|adelanto|puedo adelantar|puedo dejar|dejo|hago un pr[eé]stamo|presto yo)|puedo (?:prestarte|adelantarte|dejarte)|prestarte|si quieres[^,.]{0,20}(?:te presto|prestarte))`],
    ['give', String.raw`(?:\b(?:toma|tomad|ten(?=\s+(?:\d|[€$]|esto|este|eso|los|las|tu|mil|cien))|aqu[ií] (?:tienes|tiene|va|est[aá]n?)|aqu[ií] van|te doy|te voy a dar|te mando|te env[ií]o|te transfiero|te pago|te regalo|propina|qu[eé]date con (?:el cambio|la vuelta|el vuelto)|invito yo|es para ti|para ti|por las molestias|por tu (?:tiempo|ayuda|esfuerzo|molestia)|como regalo|un regalo|una propina|un detalle|qu[eé]date con|guarda el cambio)\b)`],
  ],
  // Not a negative question that asks ("¿no puedes prestarme 50?").
  negation: String.raw`\b(?:no(?! (?:puedes|podr[ií]as|podr[ií]a|me (?:puedes|podr[ií]as|vas|prestas|ayudas)|quieres|tienes|hay))|nunca|jam[aá]s|ni|sin(?! blanca)|nadie|tampoco)\b`,
  hypothetical: String.raw`\b(?:si (?:te|me|yo|tu|lo|alguna|un d[ií]a|fuera|pudiera|tuviera|prestara)(?! (?:hace|hacen|falta|quieres|necesitas|hiciera falta|sirve))|y si|imagina|supongamos|suponiendo|hipot[eé]ticamente|jugando|bromeo|en broma|de broma|como si|ojal[aá]|cu[aá]ndo me paguen|se me)\b`,
  later: String.raw`\b(?:ma[nñ]ana|luego|despu[eé]s|m[aá]s tarde|alg[uú]n d[ií]a|pr[oó]xim[oa]|ayer|anoche|ya te (?:pagu[eé]|devolv[ií])|cuando (?:tenga|pueda|cobre)|te pagar[eé]|te devolver[eé]|el mes que viene|la semana (?:que viene|pasada)|otro d[ií]a|te pagu[eé]|te devolv[ií])\b`,
  joke: String.raw`\b(?:broma|bromeo|jaja|en serio no|es un chiste|de coña)\b`,
};
