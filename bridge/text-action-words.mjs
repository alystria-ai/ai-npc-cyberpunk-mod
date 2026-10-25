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
    words: String.raw`driv|wheel|rid(?:e|es|ing)(?![\p{L}])|cars?(?![\p{L}])|vehicle|taxi|cab(?![\p{L}])|chauffeur|lift(?![\p{L}])|take (?:me|us)|drop (?:me|us)|get (?:me|us)|bring (?:me|us)|waypoint|marker|destination|navigat|route|map(?![\p{L}])|floor it|let'?s go|lets go|let us (?:go|move|roll)|head (?:out|there|over|to)|go there|hop in|get in|buckle|gas(?![\p{L}])|run (?:me|us)|carry (?:me|us)|steer|whip (?:me|us)|hit the road|` // en
      + String.raw`f[aä]hr|lenk|auto(?![\p{L}])|wagen|fuhr|bring mich|nimm mich|steuer|` // de
      + String.raw`condui|volant|voiture|emm[eè]ne|conduis|trajet|` // fr
      + String.raw`conduc|volante|coche|ll[eé]va|punto que|` // es
      + String.raw`guida|macchina|portami|volante|` // it
      + String.raw`dirig|dirij|carro|leva-?me|leve-?me|me leve|` // pt
      + String.raw`(?:po)?prowad|jed[zź]|kierownic|samoch|zawie[zź]|wioz|podwie[zź]|` // pl
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
    words: String.raw`attack|fight|kill|shoot(?!out)|take (?:him|her|them|that|those|these|this|it|out|down)|take .{0,16} out|get (?:him|her|them|that|those|these|this)|hit (?:him|her|them|that)|waste|eliminat|murder|finish (?:him|her|them|it)|deal with (?:him|her|them|that|it|the)|smash|cut down|pinned|handle (?:the|him|her|them|that|it)|do something about|make (?:him|her|them) (?:stop|pay|bleed|regret)|destroy|smoke (?:him|her|them|that|the|this)|bust (?:him|her|them|up)|whack|finish the (?:job|fight)|take care of (?:him|her|them|that|the (?:guy|target|enemy|one|goon|gonk))|hurt (?:him|her|them)|blow (?:his|her|their) |jump (?:him|her|them)|clean (?:him|her|them) up|blast|punch|beat|stab|slice|open fire|go (?:get|after)|dispatch|neutrali|put (?:him|her|them|a bullet)|drop (?:him|her|them)|tagged|marked|target|marked|mark(?![\p{L}])|enem|hostile|charge|engage|rush|light (?:him|her|them|it) up|cut (?:him|her|them) down|end (?:him|her|them)|flatline|fry|ice (?:him|her|them)|trash|` // en
      + String.raw`angreif|k[aä]mpf|t[oö]te|erschie|schie[sß]|knall|greif|nimm .{0,12} aus|schalt .{0,12} aus|erledig|mach .{0,12}fertig|` // de
      + String.raw`attaque|combat|tue(?![\p{L}])|tuer|tire(?![\p{L}])|bute|[eé]limine|descends|d[eé]fonce|r[eè]gle|compte|` // fr
      + String.raw`ataque|ataca|mata|dispara|elimina|pelea|lucha|acaba con|paliza|dale|` // es
      + String.raw`attacca|uccidi|spara|elimina|combatti|fallo fuori|occupati di|` // it
      + String.raw`atira|luta|acaba com|derruba|` // pt
      + String.raw`zaatakuj|atakuj|zabij|strzel|walcz|za[lł]atw|rozwal|zlikwid|` // pl
      + String.raw`атакуй|убей|убить|стреляй|бей|убери|мочи|завали|порви|уничтож|нападай|вали|разберись|` // ru
      + String.raw`атакуй|вбий|вбити|стріляй|бий|знищ|` // uk
      + String.raw`sald[ıi]r|[oö]ld[uü]r|vur(?![\p{L}])|d[oö]v[uü][sş]|` // tr
      + String.raw`za[uú]to[cč]|zabij|st[rř][ií]lej|bojuj|` // cs
      + String.raw`t[aá]madj|öld(?![\p{L}])|l[oő]dd|harcolj|` // hu
      + String.raw`target|`,
    spaceless: '攻撃|倒し|殺|撃っ|やっつけ|공격|죽여|쏴|싸워|처리|攻击|杀|干掉|打|开枪|解决',
  },
  FOLLOW: {
    words: String.raw`fol+ow|follw|fllow|folw|cmon|c'?mon|c mon|come w |^come[.!\s]*$|come (?:with|along|on|over|here)|join|tag along|stick (?:with|close|by|around)|with me|travel|accompan|walk with|stay (?:with|close|by)|keep up|let'?s (?:go|roll|move|get)|lets (?:go|roll|move)|let us (?:go|move|roll)|together|ride along|team up|partner|company|hang with|roll with|back me|have my back|by my side|along with|move out|with us|be my|my crew|my team|on board|fall in|split off|peel off|tail(?![\p{L}])|shadow|squad|beside me|next to me|after me|behind me|at my side|` // en
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
    words: String.raw`leave|go (?:home|away|now|on|ahead|back|rest)|you (?:can|may) go|dismiss|bounce|walk off|send(?:ing)? you|kick(?:ing)? you|drop out|off the team|step away|head off|(?:^|[.!?]\s*)go(?![\p{L}])|get lost|beat it|scram|done(?![\p{L}])|through(?![\p{L}])|that'?s all|will be all|be all(?![\p{L}])|your own|own thing|off you go|you go(?![\p{L}])|part (?:ways|company)|without you|on my own|alone|solo|walk away|split up|separate|farewell|good ?bye|bye(?![\p{L}])|take off|clear out|piss off|buzz off|disappear|free to go|you'?re free|no longer|fired|own way|get out|out of here|get going|run along|enough|finished|see you|later|head home|no need|don'?t need you|not need you|on your way|disband|quit|resign|release|stand down|off duty|off the clock|not needed|take a hike|(?:got|have) (?:it|this) (?:from here|covered|handled)|off the hook|` // en
      + String.raw`geh(?![\p{L}])|gehen|verschwinde|hau ab|fertig|allein|tsch[uü]ss|lass mich|nach hause|entlass|mach'?s gut|` // de
      + String.raw`va-?t'?en|pars(?![\p{L}])|d[eé]gage|on a fini|seul|laisse-?moi|rentre|partir|lib[eè]re|` // fr
      + String.raw`vete|l[aá]rgate|hemos terminado|solo(?![\p{L}])|d[eé]jame|a casa|adi[oó]s|despedid|irte|` // es
      + String.raw`vattene|vai(?![\p{L}])|abbiamo finito|da solo|lasciami|a casa|congeda|andare|` // it
      + String.raw`vai embora|some(?:[!.\s]*$|,? por favor| daqui| j[aá](?![\p{L}])| de aqui| da minha)|acabou|sozinho|deixa-?me|v[aá](?![\p{L}])|para casa|dispensad|embora|` // pt
      + String.raw`id[zź] sobie|spadaj|odejd[zź]|koniec|sam(?![\p{L}])|zostaw|wynoś|do domu|idź(?![\p{L}])|mo[zż]esz i[sś][cć]|odej[sś]|zwalniam|zwolni|` // pl
      + String.raw`уходи|уйди|проваливай|свободн|свободен|мы закончили|закончили|один(?![\p{L}])|оставь|иди домой|ступай|пока(?![\p{L}])|прощай|свободы|вали|гуляй|можешь идти|иди(?![\p{L}])|` // ru
      + String.raw`йди|геть|ми закінчили|закінчили|сам(?![\p{L}])|залиш|іди|можеш іти|` // uk
      + String.raw`git(?![\p{L}])|defol|bitti|yaln[ıi]z|b[ıi]rak|eve git|gidebilirsin|ç[ıi]kar|` // tr
      + String.raw`jdi pry[cč]|vypadni|konec|s[aá]m(?![\p{L}])|nech m[eě]|dom[uů]|jdi(?![\p{L}])|` // cs
      + String.raw`menj(?![\p{L}])|t[uű]nj|v[eé]ge|egyed[uü]l|hagyj|haza|`, // hu
    spaceless: '走了|可以走|行って|帰って|去って|別れ|終わり|一人|もういい|ばいばい|가|떠나|끝|혼자|그만|돌아가|走吧|离开|滚|结束|一个人|回家|算了|再见',
  },
};

// Housemates (docs/HOUSEMATES.md): a character may be told she can live at V's place (STAY), that she can no longer (MOVEOUT), or be called from there
// into V's party (JOIN). Like the stems above these only have to let every real request through; the decision (and V's clear words) settle the rest, and
// the game checks the exact offer. They are added after the table so the existing stems read as they did.
STEMS.STAY = {
  words: String.raw`stay(?![\p{L}])|stays(?![\p{L}])|staying|move (?:in|into)|moving in|moved in|crash(?![\p{L}])|live (?:at|in|with|here|there)|living (?:at|in|with|here)|my (?:place|home|apartment|flat|pad|house|crib|spot|couch)|your (?:own )?(?:room|place|home|bed)|roomie|roommate|housemate|settle (?:in|down)|make yourself at home|spare room|bunk|sleep (?:here|over|at)|home sweet|` // en
    + String.raw`bleib|bleiben|zieh(?:e|st)? (?:ein|bei|zu)|einzieh|wohn(?:e|en|st)(?![\p{L}])|bei mir|mein(?:e|em|en)? (?:wohnung|zuhause|haus|bleibe)|dein zuhause|mitbewohner|unterkunft|` // de
    + String.raw`reste(?:s|r)?(?![\p{L}])|emm[eé]nage|habite|habiter|vis (?:ici|chez)|vivre|chez moi|mon (?:appart|appartement|logement|chez-moi)|colocataire|h[eé]berg|dors (?:ici|chez)|` // fr
    + String.raw`qu[eé]date|quedarte|mud[aá]te|mudarte|vive (?:aqu[ií]|conmigo|en)|vivir|mi (?:casa|piso|apartamento|depa)|duerme (?:aqu[ií]|en)|compa[nñ]er[oa] de (?:piso|casa)|` // es
    + String.raw`resta(?![\p{L}])|rimani|restare|trasferisc|vieni a vivere|vivi (?:qui|da me)|abita|casa mia|il mio (?:appartamento|posto)|coinquilin|` // it
    + String.raw`fica(?:r)?(?![\p{L}])|fique|mude-?se|mudar|mora (?:aqui|comigo|na)|morar|viver|minha casa|meu (?:apartamento|ap[eê])|colega de casa|` // pt
    + String.raw`zosta[nń]|zosta[cć]|zamieszkaj|wprowad[zź]|mieszkaj|mieszka[cć]|u mnie|moje mieszkanie|m[oó]j dom|wsp[oó][lł]lokator|przenie[sś] si[eę]|` // pl
    + String.raw`остан|остат|оставайся|оставаться|поселись|переезжай|переехать|живи|жить|у меня (?:дома|жить)|моя квартира|мой дом|в моей квартире|сосед|` // ru
    + String.raw`залиш|лишайся|оселись|переїжджай|живи|жити|у мене (?:вдома|жити)|моя квартира|мій дім|сусід|` // uk
    + String.raw`kal(?![\p{L}])|kalabilirsin|kalsan|ta[sş][ıi]n|yerle[sş]|ya[sş]a(?![\p{L}])|evimde|benim ev|dairem|oda arkada|` // tr
    + String.raw`z[uů]sta[nň]|z[uů]stat|nast[eě]huj|bydlet|bydli|u m[eě](?![\p{L}])|m[uů]j byt|m[uů]j d[uů]m|spolubyd|` // cs
    + String.raw`maradj|maradhatsz|k[oö]lt[oö]z|lakj|lakhatsz|n[aá]lam|a lak[aá]som|a h[aá]zam|lak[oó]t[aá]rs|`, // hu
  spaceless: '泊まって|泊まれ|住んで|住め|うちに住|一緒に住|引っ越|いていい|居ていい|うちにいて|ここにいて|俺の家|私の家|家に住'
    + '|살아|살래|지내|머물|묵어|같이 살|이사|우리 집|내 집|여기 있어'
    + '|住在|搬来|搬进|留下|住我|我家|同住|借住|可以住|住下|住这',
};
STEMS.MOVEOUT = {
  words: String.raw`move out|moving out|moved out|move on out|find (?:your|a) (?:own )?(?:place|apartment|flat|home)|your own (?:place|apartment|flat|home)|pack your|(?:can'?t|cannot|can not) (?:stay|live)|no longer (?:stay|live|welcome)|not welcome|kick(?:ing)? you out|out of my (?:place|apartment|flat|home|house)|leave my (?:place|apartment|flat|home|house)|get out of my|time to go|time you left|you (?:have|need) to go|` // en
    + String.raw`zieh(?:e|st)? aus|auszieh|such dir (?:eine|ne) (?:eigene )?wohnung|eigene wohnung|raus aus meiner|nicht mehr (?:bleiben|wohnen)|pack deine|` // de
    + String.raw`d[eé]m[eé]nage|trouve-?toi (?:un|ton)|ton propre|ne peux plus|fais tes valises|sors de chez moi|plus (?:rester|habiter)|` // fr
    + String.raw`mud[aá]te|m[uú]date|busca(?:te)? (?:tu|un) (?:propio )?(?:piso|casa|lugar|apartamento)|ya no puedes|haz las maletas|fuera de mi casa|vete de mi|` // es
    + String.raw`trasloca|cerca(?:ti)? (?:un|il tuo)|non puoi pi[uù]|fai le valigie|fuori da casa mia|esci da casa|` // it
    + String.raw`mude-?se|muda-?te|procura (?:um|o teu)|arranje|n[aã]o pode mais|faz as malas|fora da minha casa|sai da minha|` // pt
    + String.raw`wyprowad[zź]|poszukaj|znajd[zź] sobie|nie mo[zż]esz ju[zż]|spakuj|wyno[sś] si[eę] z|` // pl
    + String.raw`съезжай|выезжай|съехать|выселя|найди себе|больше не можешь|собирай вещи|убирайся из|` // ru
    + String.raw`виїжджай|з'їжджай|виселя|знайди собі|більше не можеш|збирай речі|` // uk
    + String.raw`ç[ıi]k evimden|kendi (?:evini|yerini)|art[ıi]k kalamaz|e[sş]yalar[ıi]n[ıi] topla|` // tr
    + String.raw`odst[eě]huj|vyst[eě]huj|najdi si|u[zž] nem[uů][zž]e[sš]|sbal si|vypadni z|` // cs
    + String.raw`k[oö]lt[oö]zz ki|keress magadnak|m[aá]r nem maradhatsz|pakolj|`, // hu
  spaceless: '出て行って|出ていって|引っ越して|出て行け|もう住めない|自分の家|荷物をまとめ|나가|이사 가|이사가|더는 못|짐 싸|搬出|搬走|不能再住|自己找|收拾东西|滚出',
};
// Coming along from home: the stems of following V plus a few for "get your things".
STEMS.JOIN = {
  words: STEMS.FOLLOW.words + String.raw`go with|grab your|get your|out with me|out with us|come out|party|gear up|suit up|pack up|` // en
    + String.raw`nimm deine|hol deine|bereit|` // de
    + String.raw`prends tes|prends ton|` // fr
    + String.raw`coge tus|agarra tus|` // es
    + String.raw`prendi le tue|` // it
    + String.raw`pega nas tuas|pega as tuas|` // pt
    + String.raw`we[zź] swoje|we[zź] rzeczy|` // pl
    + String.raw`бери свои|собирайся|` // ru
    + String.raw`бери свої|збирайся|` // uk
    + String.raw`e[sş]yalar[ıi]n[ıi] al|haz[ıi]rlan|` // tr
    + String.raw`vezmi si|sbal se|` // cs
    + String.raw`vedd a|k[eé]sz[uü]lj|`, // hu
  spaceless: STEMS.FOLLOW.spaceless + '|連れて|出かけ|準備して|나가자|준비해|出发|出门|准备好',
};

const compiled = Object.fromEntries(Object.entries(STEMS).map(([code, {words, spaceless}]) => [code,
  [new RegExp(`(?<![\\p{L}\\p{N}])(?:${words.replace(/\|$/, '')})`, 'iu'), new RegExp(spaceless, 'u')]]));

// The words of STAY that say "live there" and are not just a place word ("my place" alone can be an invitation to come over, bridge/meet-requests.mjs).
// Used by the phone (bridge/home-requests.mjs) to tell "you can stay at my place" from "come to my place".
const STRONG_STAY = [new RegExp(`(?<![\\p{L}\\p{N}])(?:${[
  String.raw`stay(?![\p{L}])|stays(?![\p{L}])|staying|move (?:in|into)|moving in|moved in|crash(?![\p{L}])|live (?:at|in|with|here|there)|living (?:at|in|with|here)|roomie|roommate|housemate|settle (?:in|down)|spare room|your (?:own )?(?:room|bed)`,
  String.raw`bleib|bleiben|zieh(?:e|st)? (?:ein|bei|zu)|einzieh|wohn(?:e|en|st)(?![\p{L}])|mitbewohner`,
  String.raw`reste(?:s|r)?(?![\p{L}])|emm[eé]nage|habite|habiter|vis (?:ici|chez)|colocataire`,
  String.raw`qu[eé]date|quedarte|mud[aá]te|vive (?:aqu[ií]|conmigo|en)|vivir|compa[nñ]er[oa] de (?:piso|casa)`,
  String.raw`resta(?![\p{L}])|rimani|restare|trasferisc|vieni a vivere|vivi (?:qui|da me)|coinquilin`,
  String.raw`fica(?:r)?(?![\p{L}])|fique|mude-?se|mora (?:aqui|comigo|na)|morar|viver|colega de casa`,
  String.raw`zosta[nń]|zamieszkaj|wprowad[zź]|mieszkaj|mieszka[cć]|wsp[oó][lł]lokator`,
  String.raw`остан|остат|оставайся|поселись|переезжай|живи|жить|сосед`,
  String.raw`залиш|лишайся|оселись|переїжджай|живи|жити|сусід`,
  String.raw`kal(?![\p{L}])|kalabilirsin|kalsan|yerle[sş]|ya[sş]a(?![\p{L}])`,
  String.raw`z[uů]sta[nň]|nast[eě]huj|bydlet|bydli|spolubyd`,
  String.raw`maradj|maradhatsz|k[oö]lt[oö]z|lakj|lakhatsz|lak[oó]t[aá]rs`,
].join('|')})`, 'iu'), new RegExp('泊まって|泊まれ|住んで|住め|一緒に住|引っ越|살아|지내|머물|묵어|같이 살|이사|住在|搬来|搬进|留下|同住|借住|可以住|住下', 'u')];
/** Whether `text` says that someone may live somewhere or has to move out (not merely names a place): the phone tells this from an invitation to come over. */
export const mentionsLiving = text => {
  const value = String(text ?? '').slice(0, 600);
  return STRONG_STAY[0].test(value) || STRONG_STAY[1].test(value) || mentions('MOVEOUT', value);
};

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

// ---- What the words settle without a model (a route that serves one request at a time) ---------------------------------------------------
//
// Narrower than explicitRequest and guess on purpose: a wrong answer here is not a second reply but a missed action or a ride nobody asked for, and the model is not asked
// afterwards. So only a line that is nothing but a command, or nothing but a question about the character, counts; English only (plain ASCII, so "I" in Polish or Czech
// is never read as English); questions, suggestions ("why don't you drive?", "how about you take the wheel"), remarks and anything that sends a companion away always go
// to the model.
const BARE_COMMAND = {
  DRIVE: String.raw`drive (?:me|us|for me|for us)|take the wheel|give (?:me|us) a (?:ride|lift)`,
  FIGHT: String.raw`attack(?: (?:him|her|them))?|kill (?:him|her|them)|take (?:him|her|them) (?:out|down)`,
  FOLLOW: String.raw`follow (?:me|us)|come with (?:me|us)|come along|tag along`,
};
const bareCommands = Object.fromEntries(Object.entries(BARE_COMMAND).map(([code, phrase]) =>
  [code, new RegExp(String.raw`^(?:(?:hey|ok|okay|alright|now|come on|please)[,\s]+)*(?:[A-Za-z]{2,20},\s*)?(?:please\s+)?(?:${phrase})(?:\s+please)?[.!]?$`, 'i')]));
// A question about the character herself, in a few shapes that cannot be a request: "do you know how to drive?", "did you ever fight in the pits?", "have you ever ...".
const ABOUT_HER = /^(?:do|did|does|have|has) you (?:ever|know how to|know what|remember)\b[^?!.]{0,100}\?$/i;
// A question that is also a request or a suggestion ("do you still want to drive?", "do you ever wanna come with us?", "do you know how to get to the marker?"): the model's.
const NOT_ABOUT_HER = /\b(?:me|us|we|our|my|want|wanna|gonna|going to|mind|care to|feel like|like to|get to|go to|to the)\b/i;
const ASCII_LINE = /^[\x20-\x7e]{1,160}$/;

/**
 * {code} when `text` is only a plain command for one offered action (DRIVE, FIGHT or FOLLOW, never a leave), {none: true} when it is only a question about the character,
 * else null (the model decides). `codes`: the offered codes of the turn; a leave among the words the screen found (`found`) always sends the line to the model.
 */
export function certainWords(text, {codes, found = []} = {}) {
  const line = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!ASCII_LINE.test(line) || found.includes('LEAVE')) return null;
  for (const code of Object.keys(bareCommands)) if (codes?.includes(code) && bareCommands[code].test(line)) return {code, argument: ''};
  if (ABOUT_HER.test(line) && !NOT_ABOUT_HER.test(line)) return {none: true};
  return null;
}

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
