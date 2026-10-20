// A cheap screen for the companion-action decision (bridge/text-actions.mjs): can V's message be a request for an action at all?
//
// The decision is a model request. On a turn where the game offers an action (a leave is offered in every private talk with a party
// member), asking it for every line of small talk would add a round trip to the first sound of an ordinary chat. So a line is only
// sent to the decision when it contains a word that a request for one of the offered actions could use. This is a screen, not the
// decision: it only has to let every real request through (the model then says no to the look-alikes); a line it stops is never an
// action, and the character still gets the standing notes of what it cannot do. It is a few regular expressions, well under a
// millisecond, and keeps the stems of the languages the game's menus are translated into (English, German, French, Spanish, Italian,
// Portuguese, Polish, Russian, Ukrainian, Turkish, Czech, Hungarian, Japanese, Korean, Chinese).
//
// Latin and Cyrillic stems start at a word start; a stem is a regular expression fragment. Japanese, Korean and Chinese are not
// written with spaces, so those stems match anywhere. Tuned on scripts/Eval-MistralPrompt.mjs --actions (recall must stay at 95% or
// better) and the extra phrasings in bridge/text-actions.test.mjs.

const STEMS = {
  DRIVE: {
    words: String.raw`driv|wheel|rid(?:e|es|ing)(?![\p{L}])|cars?(?![\p{L}])|vehicle|taxi|cab(?![\p{L}])|chauffeur|lift(?![\p{L}])|take (?:me|us)|drop (?:me|us)|get (?:me|us)|bring (?:me|us)|waypoint|marker|destination|navigat|route|map(?![\p{L}])|floor it|let'?s go|lets go|let us (?:go|move|roll)|head (?:out|there|over|to)|go there|hop in|get in|buckle|gas(?![\p{L}])|` // en
      + String.raw`f[aä]hr|lenk|auto(?![\p{L}])|wagen|fuhr|bring mich|nimm mich|steuer|` // de
      + String.raw`condui|volant|voiture|emm[eè]ne|conduis|trajet|` // fr
      + String.raw`conduc|volante|coche|ll[eé]va|punto que|` // es
      + String.raw`guida|macchina|portami|volante|` // it
      + String.raw`dirig|dirij|carro|leva-?me|leve-?me|me leve|` // pt
      + String.raw`prowad|jed[zź]|kierownic|samoch|zawie[zź]|wioz|podwie[zź]|` // pl
      + String.raw`води|веди|поведи|вези|рул|машин|подвез|отвез|довез|поезж|поедем|повез|авто|такси|` // ru
      + String.raw`кермо|керу|машин|авто|відвез|підвез|повез|` // uk
      + String.raw`s[uü]r(?![\p{L}])|s[uü]rd|s[uü]rer|direksiyon|araba|g[oö]t[uü]r|` // tr
      + String.raw`[rř]i[dď]|je[dď]|volant|auto(?![\p{L}])|odvez|zave[dď]|` // cs
      + String.raw`vezes|vezet|korm[aá]ny|aut[oó]|vigy|vigyél|vidd|` // hu
      // Seated drive, V already sits in the car ("you drive", "swap seats", "take over", "your turn", "slide over"):
      + String.raw`swap|switch (?:seats|places)|seats?(?![\p{L}])|take ?over|your turn|my turn|slide over|move over|trade places|change (?:seats|places)|scoot|` // en
      + String.raw`sitz|platz|tausch|[uü]bernimm|[uü]bernehm|[uü]berlass|abl[oö]s|rutsch|` // de
      + String.raw`si[eè]ge|place(?![\p{L}])|[eé]chang|changeons|chang[eé]|prends la|prend la|reprends|relais|[aà] toi|glisse|` // fr
      + String.raw`asiento|cambi[ae]|c[aá]mbia|t[oó]ma el|tu turno|rel[eé]va|desl[ií]za|pasa al|` // es
      + String.raw`sedile|posto|cambia|scambia|prendi tu|tocca a te|subentra|spostati|` // it
      + String.raw`banco|lugar|troc[ae]|assum[ae]|sua vez|tua vez|desliza|` // pt
      + String.raw`fotel|siedzeni|miejsc|zamie[nń]|zmie[nń]|przejmij|przejmi|twoja kolej|przesu[nń]|przesi[aą]d|` // pl
      + String.raw`сиден|мест[оа]|поменя|смени|пересяд|пересад|возьми|займи|твоя очередь|подвинь|сдвинь|за руль|садись|` // ru
      + String.raw`сидін|місц|поміня|змін|пересяд|пересід|візьми|займи|твоя черга|посунь|за кермо|сідай|` // uk
      + String.raw`koltuk|de[gğ]i[sş]|devral|s[ıi]ra sende|kayd[ıi]r|` // tr
      + String.raw`sedadl|vym[eě]n|prohod|p[rř]evez|p[rř]evem|p[rř]esa[dď]|p[rř]esed|posu[nň]|` // cs
      + String.raw`[uü]l[eé]s|cser[eé]l|vedd [aá]t|[aá]tvesz|[aá]t[uü]lj|[uü]lj|helyet|`, // hu
    spaceless: '運転|ドライブ|乗せ|乗って|車|連れて|送って|운전|태워|차로|데려다|데려가|开车|驾驶|方向盘|带我|送我|载我|车'
      + '|席|代わ|替わ|交代|入れ替|任せ|자리|교대|바꿔|바꾸|맡|换座|换位|座位|座椅|换我|你来开|接管|交换',
  },
  FIGHT: {
    words: String.raw`attack|fight|kill|shoot(?!out)|take (?:him|her|them|that|those|these|this|it|out|down)|take .{0,16} out|get (?:him|her|them|that|those|these|this)|hit (?:him|her|them|that)|waste|eliminat|murder|finish (?:him|her|them|it)|deal with (?:him|her|them|that|it|the)|smash|cut down|pinned|handle (?:the|him|her|them|that|it)|do something about|make (?:him|her|them) (?:stop|pay|bleed|regret)|destroy|smoke (?:him|her|them)|blast|punch|beat|stab|slice|open fire|go (?:get|after)|dispatch|neutrali|put (?:him|her|them|a bullet)|drop (?:him|her|them)|tagged|marked|target|marked|mark(?![\p{L}])|enem|hostile|charge|engage|rush|light (?:him|her|them|it) up|cut (?:him|her|them) down|end (?:him|her|them)|flatline|fry|ice (?:him|her|them)|trash|` // en
      + String.raw`angreif|k[aä]mpf|t[oö]te|erschie|schie[sß]|knall|greif|nimm .{0,12} aus|schalt .{0,12} aus|erledig|` // de
      + String.raw`attaque|combat|tue(?![\p{L}])|tuer|tire(?![\p{L}])|bute|[eé]limine|descends|d[eé]fonce|r[eè]gle|compte|` // fr
      + String.raw`ataque|ataca|mata|dispara|elimina|pelea|lucha|acaba con|paliza|dale|` // es
      + String.raw`attacca|uccidi|spara|elimina|combatti|fallo fuori|` // it
      + String.raw`atira|luta|acaba com|derruba|` // pt
      + String.raw`zaatakuj|atakuj|zabij|strzel|walcz|za[lł]atw|rozwal|` // pl
      + String.raw`атакуй|убей|убить|стреляй|бей|убери|мочи|завали|порви|уничтож|нападай|вали|разберись|` // ru
      + String.raw`атакуй|вбий|вбити|стріляй|бий|знищ|` // uk
      + String.raw`sald[ıi]r|[oö]ld[uü]r|vur(?![\p{L}])|d[oö]v[uü][sş]|` // tr
      + String.raw`za[uú]to[cč]|zabij|st[rř][ií]lej|bojuj|` // cs
      + String.raw`t[aá]madj|öld(?![\p{L}])|l[oő]dd|harcolj|` // hu
      + String.raw`target|`,
    spaceless: '攻撃|倒し|殺|撃っ|やっつけ|공격|죽여|쏴|싸워|처리|攻击|杀|干掉|打|开枪|解决',
  },
  FOLLOW: {
    words: String.raw`follow|come (?:with|along|on|over|here)|join|tag along|stick (?:with|close|by|around)|with me|travel|accompan|walk with|stay (?:with|close|by)|keep up|let'?s (?:go|roll|move|get)|lets (?:go|roll|move)|let us (?:go|move|roll)|together|ride along|team up|partner|company|hang with|roll with|back me|have my back|by my side|along with|move out|with us|be my|my crew|my team|on board|fall in|split off|peel off|tail(?![\p{L}])|shadow|squad|beside me|next to me|after me|behind me|at my side|` // en
      + String.raw`folge|komm mit|begleit|mitkommen|komm(?![\p{L}])|mit mir|bleib|bei mir|` // de
      + String.raw`suis(?![\p{L}])|suivre|viens|accompagn|avec moi|` // fr
      + String.raw`s[ií]gueme|ven conmigo|acomp[aá][nñ]|conmigo|ven(?![\p{L}])|` // es
      + String.raw`seguimi|vieni|accompagn|con me|` // it
      + String.raw`segue|vem comigo|acompanh|comigo|vem(?![\p{L}])|` // pt
      + String.raw`chod[zź]|id[zź] za|p[oó]jd[zź]|towarzysz|ze mn[aą]|za mn[aą]|` // pl
      + String.raw`за мной|пойдем|пойдём|пошли|со мной|иди со|идём|идем|следуй|присоединяйся|пойдешь|пойдёшь|ходи|иди за|сопровожда|` // ru
      + String.raw`за мною|ходімо|йди зі|йди за|зі мною|зі мною|супроводж|ходи|` // uk
      + String.raw`takip|gel(?![\p{L}])|benimle|e[sş]lik|` // tr
      + String.raw`poj[dď]|n[aá]sleduj|jdi se|doprovo|se mnou|` // cs
      + String.raw`gyere|k[oö]vess|velem|csatlakoz|` // hu
      + String.raw`join|`,
    spaceless: '一緒|ついて|来て|付いて|行こう|따라|같이|함께|와줘|와라|跟|一起|来吧|陪|同行',
  },
  LEAVE: {
    words: String.raw`leave|go (?:home|away|now|on|ahead|back|rest)|you (?:can|may) go|dismiss|bounce|walk off|send(?:ing)? you|kick(?:ing)? you|drop out|off the team|step away|head off|(?:^|[.!?]\s*)go(?![\p{L}])|get lost|beat it|scram|done(?![\p{L}])|through(?![\p{L}])|that'?s all|will be all|be all(?![\p{L}])|your own|own thing|off you go|you go(?![\p{L}])|part (?:ways|company)|without you|on my own|alone|solo|walk away|split up|separate|farewell|good ?bye|bye(?![\p{L}])|take off|clear out|piss off|buzz off|disappear|free to go|you'?re free|no longer|fired|own way|get out|out of here|get going|run along|enough|finished|see you|later|head home|no need|don'?t need you|not need you|on your way|disband|quit|resign|release|stand down|off duty|off the clock|` // en
      + String.raw`geh(?![\p{L}])|gehen|verschwinde|hau ab|fertig|allein|tsch[uü]ss|lass mich|nach hause|entlass|mach'?s gut|` // de
      + String.raw`va-?t'?en|pars(?![\p{L}])|d[eé]gage|on a fini|seul|laisse-?moi|rentre|partir|lib[eè]re|` // fr
      + String.raw`vete|l[aá]rgate|hemos terminado|solo(?![\p{L}])|d[eé]jame|a casa|adi[oó]s|despedid|irte|` // es
      + String.raw`vattene|vai(?![\p{L}])|abbiamo finito|da solo|lasciami|a casa|congeda|andare|` // it
      + String.raw`vai embora|some(?:[!.\s]*$|,? por favor| daqui| j[aá](?![\p{L}])| de aqui| da minha)|acabou|sozinho|deixa-?me|v[aá](?![\p{L}])|para casa|dispensad|embora|` // pt
      + String.raw`id[zź] sobie|spadaj|odejd[zź]|koniec|sam(?![\p{L}])|zostaw|wynoś|do domu|idź(?![\p{L}])|odej[sś]|zwalniam|zwolni|` // pl
      + String.raw`уходи|уйди|проваливай|свободн|мы закончили|закончили|один(?![\p{L}])|оставь|иди домой|ступай|пока(?![\p{L}])|прощай|свободы|вали|гуляй|можешь идти|иди(?![\p{L}])|` // ru
      + String.raw`йди|геть|ми закінчили|закінчили|сам(?![\p{L}])|залиш|іди|можеш іти|` // uk
      + String.raw`git(?![\p{L}])|defol|bitti|yaln[ıi]z|b[ıi]rak|eve git|gidebilirsin|ç[ıi]kar|` // tr
      + String.raw`jdi pry[cč]|vypadni|konec|s[aá]m(?![\p{L}])|nech m[eě]|dom[uů]|jdi(?![\p{L}])|` // cs
      + String.raw`menj(?![\p{L}])|t[uű]nj|v[eé]ge|egyed[uü]l|hagyj|haza|`, // hu
    spaceless: '走了|可以走|行って|帰って|去って|別れ|終わり|一人|もういい|ばいばい|가|떠나|끝|혼자|그만|돌아가|走吧|离开|滚|结束|一个人|回家|算了|再见',
  },
};

const compiled = Object.fromEntries(Object.entries(STEMS).map(([code, {words, spaceless}]) => [code,
  [new RegExp(`(?<![\\p{L}\\p{N}])(?:${words.replace(/\|$/, '')})`, 'iu'), new RegExp(spaceless, 'u')]]));

/** Whether `text` has a word a request for the action `code` could use. */
export const mentions = (code, text) => {
  const patterns = compiled[code];
  const value = String(text ?? '').slice(0, 600);
  return !!patterns && (patterns[0].test(value) || patterns[1].test(value));
};

/**
 * The offered codes (of `codes`) that V's words could be asking for. `last` is what the character said just before ({r}): a short
 * answer to the character's own offer ("yes", "please", "go ahead") counts for the action that line was about.
 */
export function screenWords(text, {codes, last} = {}) {
  const value = String(text ?? '');
  const hits = (codes ?? Object.keys(STEMS)).filter(code => mentions(code, value));
  if (hits.length) return hits;
  if (last && typeof last.r === 'string' && value.trim().split(/\s+/).length <= 6) {
    return (codes ?? Object.keys(STEMS)).filter(code => mentions(code, last.r.slice(-300)));
  }
  return [];
}

// ---- Plain requests, for a decision that did not come ------------------------------------------------------------------------
//
// The decision is a model request, and a small model (a 4B local one, a server the player runs, a free cloud model) sometimes answers none to
// "drive me there", times out, or answers in a way nobody can read. Then a turn that plainly asked for a ride ended as talk. This is the safety net
// under that: a few sentence-shaped English requests that cannot be read as anything else ("drive me", "take the wheel", "attack him", "follow
// me", "come with me"). It runs only after the decision has failed or said none, only for lines the screen already let through, never for sending
// a companion away (a wrong guess there costs the player a companion), and the game still checks the exact offer. No model, well under a millisecond.
const EXPLICIT_LEAD = String.raw`^(?:[^\s,;:]{1,24},\s*){0,2}(?:(?:hey|ok|okay|alright|all right|so|now|then|please|listen|come on|c'mon|quick|just)[,\s]+)*`
  + String.raw`(?:(?:can|could|would|will) you(?: please| just)?\s+|please\s+|i need you to\s+|i want you to\s+|you(?:'ll| will| can| should| better)?\s+)?`;
const EXPLICIT = {
  DRIVE: String.raw`(?:drive (?:for )?(?:me|us)|take the wheel|take (?:me|us) (?:there|to (?:the )?(?:waypoint|marker|destination|map marker))|drive (?:there|to (?:the )?(?:waypoint|marker|destination))|give (?:me|us) a (?:ride|lift)|be (?:my|our) (?:driver|chauffeur))`,
  FIGHT: String.raw`(?:(?:attack|kill|shoot|take out|take down|go after|go get|waste|finish|eliminate|destroy|get) (?:him|her|them|that (?:guy|one|gonk|merc|target|enemy)|the (?:target|enemy|marked (?:one|guy|target)|tagged (?:one|guy|target))|my target)|take (?:him|her|them) (?:out|down))`,
  FOLLOW: String.raw`(?:follow (?:me|us)|come (?:along )?with (?:me|us)|come along|tag along|walk with (?:me|us)|join (?:me|us)|travel with (?:me|us))`,
};
// Anything that makes the sentence a condition, a refusal, a memory or a wish for later is not a plain request.
const NOT_PLAIN = /\b(?:if|when|whenever|unless|because|once|never|ever|not|no|don'?t|didn'?t|won'?t|wouldn'?t|couldn'?t|can'?t|wish|someday|later|tomorrow|maybe|sometime|used to|instead|rather|how|why|what|who)\b/i;
// The bare verb counts only as the whole sentence ("Attack!"), never as the start of "attack of the clones".
// DRIVE: V sits in the car already ("you drive", "take over", "swap seats"); these stay whole-sentence so "take over the world" is not a request.
const BARE = {FIGHT: 'attack|fight',
  DRIVE: String.raw`drive(?: now| please)?|take over(?: (?:the )?(?:wheel|driving))?(?: from me| for me| please| now)?|`
    + String.raw`(?:swap|switch|change) (?:seats|places)(?: with me)?(?: please| now)?|trade places(?: with me)?|your turn to drive|slide over and drive`};
const explicitPatterns = Object.fromEntries(Object.entries(EXPLICIT).map(([code, phrase]) =>
  [code, new RegExp(`${EXPLICIT_LEAD}(?:${phrase}(?:\\s+[^\\s]+){0,7}${BARE[code] ? `|${BARE[code]}` : ''})$`, 'i')]));

/**
 * The one offered code (of `codes`) that `text` plainly asks for in a sentence of its own, or null (no match, several actions, or nothing offered).
 * Only DRIVE, FIGHT and FOLLOW: a leave is never guessed.
 */
export function explicitRequest(text, {codes} = {}) {
  const sentences = String(text ?? '').slice(0, 400).split(/[.!?;\n]+/).map(part => part.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const hits = new Set();
  for (const sentence of sentences) {
    if (sentence.length > 120 || NOT_PLAIN.test(sentence)) continue;
    for (const code of Object.keys(EXPLICIT)) if ((!codes || codes.includes(code)) && explicitPatterns[code].test(sentence)) hits.add(code);
  }
  return hits.size === 1 ? [...hits][0] : null;
}
