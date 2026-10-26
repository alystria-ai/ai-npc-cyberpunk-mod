// Quest briefings (docs/QUEST_BRIEFINGS.md): V asks the character who gave a job (or who is part of it) what the job is, what to do or what comes
// next, and the character explains it in-world, at the stage V has reached.
//
// Three small steps, none of them per frame:
//   1. a cheap multi-language screen on V's words (`briefingRequested`), so a turn that is not about a job pays nothing;
//   2. the choice of the quest and the stage from the journal inventory the turn already carries (`selectBriefing`): only a job that is active in V's
//      journal and that this speaker gave or knows, and only the stage whose journal objectives are active now, never a later one;
//   3. one short note for this turn (`briefingNote`), written from the reviewed dataset (research/cyberpunk/quest-briefings.json, built into
//      bridge/quest-briefing-data.mjs). The dataset is our own wording; nothing is copied from a website or the game.
// It is a volatile block of the turn's context (bridge/quest-context.mjs), so every provider gets it the same way (Convai's dynamic info, Mistral,
// Local AI, Custom), and the Dynamic info "Quest and journal" switch removes it (the inventory is not even sent then).
import {freshQuest} from './journal-history.mjs';
import {QUEST_BRIEFINGS} from './quest-briefing-data.mjs';

// ---- The screen -------------------------------------------------------------------------------------------------------------------------------
//
// Can V's message be about the job: what it is, what to do, what is next, how to go about it, where to go? A few regular expressions per language,
// well under a millisecond. A screen, not the decision: it has to let the real questions through (a miss means no briefing), while a false positive only
// costs one more lookup: the note is added only when this speaker really has such a job in V's journal. Languages: the game's menu languages
// (en de fr es it pt pl ru uk tr cs hu ja ko zh). Latin and Cyrillic stems start at a word start; Japanese, Korean and Chinese are not written with
// spaces, so those match anywhere.
const TOPIC = {
  en: String.raw`jobs?|gigs?|missions?|tasks?|assignments?|contracts?|quests?|errands?|objectives?|briefing|deal|operation|caper|setup`,
  de: String.raw`auftr(?:ag|ä|ae)\p{L}*|jobs?|gigs?|mission\p{L}*|aufgabe\p{L}*|vertrag|verträge|vertraege|einsatz|briefing|deal|vorhaben|coup`,
  fr: String.raw`contrats?|boulots?|jobs?|gigs?|missions?|t[âa]ches?|mandat|briefing|deal|affaire|op[ée]ration|coup`,
  es: String.raw`trabajos?|encargos?|misi[óo]n(?:es)?|tareas?|contratos?|gigs?|curros?|faena|briefing|trato|operaci[óo]n|asunto`,
  it: String.raw`lavor[oi]|lavoretto|incarich[oi]|incarico|missione|missioni|compit[oi]|contratt[oi]|gig|briefing|commission[ei]|faccenda|affare|colpo|operazione`,
  pt: String.raw`trabalhos?|servi[çc]os?|miss[ãa]o|miss[õo]es|tarefas?|contratos?|bicos?|trampos?|corre|gigs?|encomenda|briefing|neg[óo]cio|opera[çc][ãa]o`,
  pl: String.raw`zlecen\p{L}*|robot[aęyąie]|misj\p{L}*|zadani\p{L}*|zadań|kontrakt\p{L}*|fuch\p{L}*|briefing|interes\p{L}*|deal\p{L}*|akcj\p{L}*`,
  ru: String.raw`заказ\p{L}*|работ[аыуе]|задани\p{L}*|задач\p{L}*|миссия|миссии|миссию|контракт\p{L}*|поручени\p{L}*|халтур\p{L}*|брифинг\p{L}*|сделк\p{L}*|операци\p{L}*|за дело|это дело|что за дело`,
  uk: String.raw`замовлен\p{L}*|робот[аиуі]|завдан\p{L}*|місі\p{L}*|контракт\p{L}*|доручен\p{L}*|підробіт\p{L}*|брифінг\p{L}*|угод\p{L}*|операці\p{L}*|що (?:взагалі )?за справа|ця справа|цієї справи|по справі`,
  tr: String.raw`i[sş](?:in|i|e|le|im|imiz)?|i[sş]ler|g[öo]rev\p{L}*|sipari[sş]\p{L}*|kontrat\p{L}*|s[öo]zle[sş]me|gig|brifing|anla[sş]ma\p{L}*|operasyon\p{L}*`,
  cs: String.raw`zak[aá]zk\p{L}*|pr[aá]ce|pr[aá]ci|misi\p{L}*|[úu]kol\p{L}*|kontrakt\p{L}*|n[aá]kaz\p{L}*|briefing|gig\p{L}*|deal\p{L}*|rob[oó]t[auy]|p[řr]ehled\p{L}*|oper[aá]c\p{L}*`,
  hu: String.raw`munk[aá]\p{L}*|megb[ií]z\p{L}*|k[üu]ldet\p{L}*|feladat\p{L}*|szerz[őo]d\p{L}*|mel[óo]\p{L}*|g[ií]g|brif\p{L}*|[üu]zlet\p{L}*|[üu]gy\p{L}*|akci[óo]\p{L}*`,
};
const ASK = {
  en: String.raw`what(?:'s| is) next|what next|what now|what do (?:i|we) (?:actually |really |exactly )?(?:do|have to do|need to do|got to do)|what (?:should|must|do|am) (?:i|we) (?:actually |really |exactly )?(?:do|doing|supposed to do|need to do|have to do|got to do)|what (?:i|we) (?:need|have|got|am supposed) to do|what(?:'s| is) (?:the|my|our) (?:plan|next step|next move|approach|situation)|next (?:steps?|move)|the (?:steps|details|approach)|(?:more|give me) details|tell me (?:more )?about (?:the|this|that|it)|(?:walk|talk|run|take|go) me (?:through|over)|go (?:over|through) (?:it|the plan|this|that)|fill me in|remind me|brief me|where (?:do|should|can) (?:i|we) (?:go|start|head|begin)|where to (?:go|start)|how (?:do|should|would|does|will|are) (?:i|we) (?:do|start|go about|handle|pull|get|proceed|approach)|how (?:does|will) (?:it|this|that) (?:work|go)|when (?:do|should) (?:i|we) (?:go|move|start|enter)|what are we (?:doing|looking at)|explain (?:it|this|that|again|how)`,
  de: String.raw`was (?:ist|kommt|steht|muss|soll|sollen|müssen|machen|mache|tun) (?:ich|wir|nun|jetzt|als n[äa]chstes|danach|an)|was nun|wie geht(?: es|'?s)(?: jetzt| nun)? weiter|n[äa]chste[rn]? schritte?|die schritte|die details|einzelheiten|erkl[äa]r\p{L}*|f[üu]hr mich durch|durchgeh\p{L}*|erinner\p{L}* mich|(?:erz[äa]hl|sag|zeig)\p{L}* mir (?:mehr|alles|davon|was)|wohin (?:muss|soll|gehe|geh|gehen)|wo (?:muss|soll) ich (?:hin|anfangen|beginnen)|wie (?:gehe|geh|fange|fang|packe|pack|l[äa]uft) (?:ich|wir|das|es)|wie (?:gehen|machen|fangen) wir|wie (?:soll|muss|kann) ich|wann (?:soll|muss|gehe|geh|steige)|was ist der plan|wie lautet der plan`,
  fr: String.raw`qu'?est-ce que (?:je dois|je fais|on fait|il faut)|que (?:dois|faut|fais)\p{L}*|quoi faire|c'?est quoi (?:le|la) (?:plan|mission|boulot|job|suite)|et (?:ensuite|maintenant)|la suite|prochaines? [ée]tapes?|les [ée]tapes|les d[ée]tails|plus de d[ée]tails|explique\p{L}*|rappelle-?moi|r[ée]sume\p{L}*|raconte-?moi (?:tout|ce|comment|le)|dis-?moi (?:en plus|tout|comment)|o[ùu] (?:dois|faut|je dois) (?:je )?(?:aller|commencer)|comment (?:je|on) (?:fait|fais|proc[èe]de|m'?y prends|d[ée]marre|commence|s'?y prend)|quand (?:j'?entre|je dois|on entre)|quel est le plan|guide-?moi`,
  es: String.raw`qu[ée] (?:tengo que|debo|hago|hay que|toca|sigue|viene|hacemos)|qu[ée] (?:es|era) lo (?:siguiente|que tengo)|y ahora|ahora qu[ée]|lo siguiente|siguientes? pasos?|los pasos|los detalles|m[áa]s detalles|expl[íi]ca\p{L}*|cu[ée]ntame|recu[ée]rdame|ponme al d[íi]a|d[óo]nde (?:tengo que ir|debo ir|voy|empiezo|empezar)|c[óo]mo (?:lo hago|lo hacemos|empiezo|funciona|se hace|procedo|entro|procedemos|vamos)|cu[áa]ndo (?:entro|voy|tengo)|cu[áa]l es el plan|qu[ée] plan`,
  it: String.raw`cosa (?:devo|dobbiamo|faccio|facciamo|c'?[èe])|che (?:devo|cosa devo|faccio|facciamo)|e adesso|ora cosa|cosa (?:viene|c'?[èe]) dopo|prossim[oi] passa?\p{L}*|prossimo passo|i passaggi|i dettagli|pi[ùu] dettagli|spiega\p{L}*|raccontami|ricordami|dimmi (?:di pi[ùu]|tutto)|dammi (?:tutto|i dettagli|il quadro)|tutto il quadro|dove (?:devo|vado|dovrei|inizio|comincio)|come (?:faccio|procedo|inizio|funziona|si fa|mi muovo|procediamo|iniziamo|facciamo|entro)|quando (?:entro|devo|andiamo)|qual [èe] il piano|che piano`,
  pt: String.raw`o que (?:eu )?(?:tenho|devo|preciso|fa[çc]o|fazemos|vem|vai|falta)|e agora|e depois|pr[óo]ximos? passos?|os passos|os detalhes|mais detalhes|explica\p{L}*|conta-?me|me conta(?: tudo)?|lembra-?me|me lembra|resum\p{L}*|onde (?:eu )?(?:tenho que ir|devo ir|vou|come[çc]o)|aonde eu vou|como (?:a gente|eu )?(?:fa[çc]o|faz|come[çc]o|funciona|procedo|entro)|qual [ée](?: exatamente)? o plano|que plano|quando (?:eu )?entro`,
  pl: String.raw`co (?:ja )?(?:konkretnie |dokładnie |właściwie )?(?:mam|muszę|powinienem|powinnam|robimy|robić|teraz|dalej)|co dalej|co teraz|jaki (?:jest )?plan|kolejn\p{L}* krok\p{L}*|nast[ęe]pn\p{L}* krok\p{L}*|kroki|szczeg[óo][łl]\p{L}*|wyja[śs]nij|wytłumacz|opowiedz (?:mi )?(?:o|więcej|wszystko|jak)|przypomnij|gdzie (?:mam|muszę|powinienem|powinnam|iść|zacząć|idę)|jak (?:mam|to zrobić|się za to zabrać|to działa|zacząć)`,
  ru: String.raw`что (?:конкретно |именно |вообще )?(?:мне )?(?:конкретно |именно )?(?:делать|дальше|теперь|нужно|надо|нам делать)|что дальше|что теперь|что вообще за|какой (?:у нас )?план|каков план|следующ\p{L}* шаг\p{L}*|шаги|подробност\p{L}*|детали|объясни|расскажи (?:мне )?(?:о|про|подробн\p{L}*|всё|все|как|что)|напомни|разъясни|введи в курс|куда (?:мне )?(?:идти|ехать|надо)|с чего (?:начать|начинать)|как (?:мне )?(?:вообще )?(?:это )?(?:сделать|делать|быть|начать|начинать|провернуть)|как (?:действуем|поступим|будем)|когда (?:заходить|идти|мне)`,
  uk: String.raw`що (?:мені )?(?:конкретно |саме |взагалі )?(?:робити|далі|тепер|треба|потрібно|нам робити)|що далі|що тепер|який (?:у нас )?план|наступн\p{L}* крок\p{L}*|кроки|подробиц\p{L}*|деталі|поясни|розкажи (?:мені )?(?:про|докладн\p{L}*|все|як|що)|нагадай|куди (?:мені )?(?:йти|їхати|треба)|з чого (?:почати|починати)|як (?:мені )?(?:взагалі )?(?:це )?(?:зробити|робити|почати|починати)|як діємо|коли (?:заходити|йти)`,
  tr: String.raw`ne yap(?:may[ıi]|mal[ıi]y[ıi]m|aca[ğg][ıi]m|[ıi]yoruz|[ıi]yorum)|ne yapmam|[sş]imdi ne|sonra ne|s[ıi]rada ne|plan ne|plan[ıi] anlat|sonraki ad[ıi]m\p{L}*|ad[ıi]mlar|ayr[ıi]nt[ıi]\p{L}*|detay\p{L}*|her [sş]eyi anlat\p{L}*|i[sş]i anlat\p{L}*|a[çc][ıi]kla\p{L}*|hat[ıi]rlat\p{L}*|[öo]zet\p{L}*|nereye (?:gideyim|gitmeliyim|gitmem|gidece[ğg]im)|nereden (?:ba[sş]layay[ıi]m|ba[sş]la)|nas[ıi]l (?:yap|ba[sş]l|ilerle|olacak|gidece)\p{L}*|teslim noktas[ıi]\p{L}*|ne zaman gir\p{L}*`,
  cs: String.raw`co (?:přesně |vlastně )?(?:mám|musím|dál|teď)|co d[ěe]lat|co d[ěe]l[áa]me|co bude d[áa]l|jak[ýy] je pl[áa]n|dal[šs][íi] krok\p{L}*|kroky|podrobnost\p{L}*|detail\p{L}*|vysv[ěe]tl\p{L}*|pov[íi]dej (?:mi )?(?:o|v[íi]c|v[šs]e)|pov[ěe]z mi (?:o|v[íi]c|v[šs]e)|[řr]ekni mi v[íi]c\p{L}*|p[řr]ipome[ňn]\p{L}*|kam (?:mám|musím|jít|jet)|kde (?:mám|za[čc][íi]t|je p[řr]ed[aá]n[íi])|jak (?:to|na to|mám|za[čc][íi]t|za[čc]nu)|kdy (?:vstoup\p{L}*|jdu|mám)`,
  hu: String.raw`mit (?:kell|csin[áa]ljak|csin[áa]lok|csin[áa]ljunk|tegyek)|mi (?:a|lesz|j[öo]n) (?:k[öo]vetkez\p{L}*|most|ut[áa]na|terv)|mi a terv|most mi|azt[áa]n mi|k[öo]vetkez[őo] l[ée]p\p{L}*|l[ée]p[ée]sek|r[ée]szlet\p{L}*|magyar[áa]zd|mes[ée]lj (?:nekem )?(?:err[őo]l|az|a )|mondj t[öo]bbet|eml[ée]keztess|hova (?:kell|menjek|menjünk)|hol (?:kezdjem|kezdjük)|hogyan (?:csin[áa]ljam|kezd\p{L}*|megy|m[űu]k[öo]dik|csin[áa]ljuk)|mikor (?:sz[áa]llj|menjek|l[ée]pjek)`,
};
// A question, or a request to say it again or go on, that names no job word ("where do I go?", "how much does it pay?", "say that again", "go on").
// The screen is generous on purpose: its real gate is the next step, which needs a job this speaker gave or knows to be active in V's journal; a
// miss would lose the briefing, a false positive costs one lookup and no note. Question marks (also the Spanish, Japanese and Arabic ones) always pass.
const QUESTION = {
  en: String.raw`what|how|where|who|whom|when|which|why|can i|could i|should i|do i|am i|will i|is there|are there|say (?:it|that) again|repeat|once more|go on|keep going|continue|tell me more|run-?down|top[oa]|full picture|whole picture|big picture|overview|summary|spell it out|start to finish|the catch|whole run`,
  de: String.raw`was (?:ist|sind|soll|muss|mach\p{L}*|kann|tun|bedeutet|kommt|steht|gibt|sagt|hat|passiert|bringt|kostet|genau|nun|jetzt)|wie|wo|wohin|woher|wer|wen|wem|wann|welche\p{L}*|warum|kann ich|soll ich|muss ich|gibt es|wiederhol\p{L}*|noch (?:einmal|mal)|nochmal|erz[äa]hl weiter|weiter|[üu]berblick|ganze bild|ablauf|klipp und klar|von vorn bis hinten|zusammenfassung|haken`,
  fr: String.raw`quoi|que|qu'|comment|o[ùu]|qui (?:est|sont|dois|je|a|l'?a|va|passe|m'?|me|doit|fait)|quand|quel(?:le|les|s)?|combien|pourquoi|est-ce|y a|r[ée]p[èe]te\p{L}*|encore une fois|continue|vas-y|dis-?moi|topo|d[ée]roule\p{L}*|ce qui se passe|vue d'?ensemble|tableau complet|r[ée]sum[ée]|du d[ée]but [àa] la fin|le hic|l'?arnaque`,
  es: String.raw`qu[ée]|c[óo]mo|d[óo]nde|ad[óo]nde|qui[ée]n\p{L}*|cu[áa]ndo|cu[áa]l\p{L}*|cu[áa]nt\p{L}*|por qu[ée]|hay|puedo|debo|rep[íi]te\p{L}*|otra vez|sigue|contin[úu]a|dime|panorama|visi[óo]n completa|resumen|de principio a fin|su[ée]ltalo|el truco`,
  it: String.raw`cosa|che (?:cosa|devo|faccio|facciamo|piano|succede|fa|dobbiamo|c'?[èe])|come|dove|chi|quando|quale|quali|quanto|quanti|perch[ée]|c'?[èe] (?:un|una|qualche|altro|ancora)|ci sono|posso|devo|ripeti\p{L}*|ancora una volta|continua|dimmi|rifammi|che (?:roba|faccenda)|quadro completo|panoramica|riepilogo|procedimento|dall'?inizio alla fine|dimmelo|il trucco|rispiega\p{L}*`,
  pt: String.raw`o que|que|como|onde|aonde|quem|quando|qual|quais|quanto|quantos|por que|tem|posso|devo|repete\p{L}*|repita|de novo|continua|fala mais|diz|panorama|vis[ãa]o geral|resumo|passo a passo|do come[çc]o ao fim|fala logo|pegadinha|enrolar`,
  pl: String.raw`co|jak|gdzie|kto|kogo|kiedy|jaki\p{L}*|jaka|jakie|ile|dlaczego|czemu|czy|kt[óo]r\p{L}*|powt[óo]rz\p{L}*|jeszcze raz|dalej|m[óo]w dalej|powiedz|streszczeni\p{L}*|pełny obraz|całość|od początku do końca|mów wprost|haczyk`,
  ru: String.raw`что|как|где|куда|кто|кого|когда|какой|какая|какие|сколько|почему|можно|есть ли|повтори\p{L}*|ещё раз|еще раз|дальше|продолжай|скажи|расскажи|сначала|с начала|сводк\p{L}*|полную картину|от начала до конца|подвох|разложи`,
  uk: String.raw`що|як|де|куди|хто|кого|коли|який|яка|які|скільки|чому|чи|можна|повтори\p{L}*|ще раз|далі|продовжуй|скажи|розкажи|спочатку|зведен\p{L}*|повну картину|від початку до кінця|підступ|розклади`,
  tr: String.raw`ne|nas[ıi]l|nerede|nereye|nereden|kim|kimi|kiminle|ne zaman|hangi|ka[çc]|neden|var m[ıi]|tekrar\p{L}*|bir daha|bir kez|ba[sş]tan|anlat\p{L}*|devam|s[öo]yle|peki|t[üu]m resm\p{L}*|genel bak[ıi][sş]|[öo]zet|tuzak`,
  cs: String.raw`co|jak|kde|kam|kdo|koho|kdy|jak[ýyáé]\p{L}*|kolik|pro[čc]|zda|zopakuj\p{L}*|ještě jednou|dál|pokra[čc]uj|[řr]ekni|p[řr]ehled|cel[ýy] obraz|od za[čc][áa]tku do konce|zádrhel|h[áa][čc]ek`,
  hu: String.raw`mit|mi|hogyan|hogy|hol|hov[áa]|ki|kit|kivel|mikor|melyik|mennyi\p{L}*|mennyit|mi[ée]rt|ism[ée]teld|[ée]s most|folytasd|mondd|mes[ée]lj|elej[ée]t[őo]l|v[ée]gig|[öo]sszefoglal\p{L}*|teljes k[ée]p\p{L}*|csavar|b[öo]kken[őo]`,
};
const SPACELESS_QUESTION = [
  '[？?]|か[。、]?$|の[？?]|かな|だろう|どう|何|誰|いつ|どこ|いくら|どれ|なぜ|教えて|もう一度|もう一回|続けて|それで|全体像|流れ|概要|まとめ|最初から最後|裏は|あの話|なんだっけ|さっさと話',
  '뭐|뭘|어떻게|어디|누구|언제|얼마|어느|왜|까\\?|나요|니까|해줘|말해|다시|계속|요약|전체 그림|처음부터 끝까지|함정|이거 뭐',
  '吗|呢|什么|怎么|哪|谁|几点|多少|为什么|能不能|可以|是否|请问|再说|再讲|讲一遍|从头|继续|然后|概要|整体情况|从头到尾|流程|捋一遍|绕圈子|直接说|干嘛|是啥',
].join('|');
// Japanese, Korean and Chinese are matched anywhere in the text.
const SPACELESS = [
  '仕事|依頼|ミッション|任務|ジョブ|ギグ|契約|タスク|クエスト|案件|ブリーフィング|取引|作戦',
  'どうすれ|どう対処|何をすれ|何をする|何をし|何をやる|何をやれ|やるべき|次は|次の(?:ステップ|手順)|手順|詳細|詳しく|説明して|について教えて|のことを教えて|もっと(?:詳しく)?教えて|その(?:件|話)について|おさらい|思い出させ|どこへ行|どこに行|どこから|どうやって|どう動|どう進め|どう始め|どう行動|受け渡し|計画は|プランは|段取り|いつ(?:突入|入る|行く|始める|やる|動く)',
  '의뢰|미션|임무|작업|계약|퀘스트|기그|브리핑|거래|그 일|이 일|일에 대해|일 말인데',
  '어떻게 해야|어떻게 시작|어떻게 하면|어떻게 해|어떻게 진행|뭘 해야|무엇을 해야|뭐 해야|뭐부터|무엇부터|다음은|다음 단계|다음엔|단계|자세히|자세한|더 (?:말해|알려|자세히)|설명해|알려줘|알려 줘|상기시켜|어디로 가|어디서 시작|어디부터|전달 장소|언제 들어가|계획이 뭐|계획은|계획 |플랜',
  '任务|委托|工作|活儿|合同|差事|单子|简报|零工|委托人|交易|行动',
  '该怎么做|怎么做|做什么|要做什么|下一步|接下来|步骤|细节|详情|详细|具体|解释|说明|讲讲|说说|提醒我|去哪|从哪|计划是|计划呢|怎么办|怎么开始|地点在哪|交接|怎么行动|什么时候(?:进去|行动|出发|动手)|如何行动',
].join('|');
const WORD = String.raw`(?<![\p{L}\p{N}])`, END = String.raw`(?![\p{L}])`;
const SCREEN = new RegExp(`${WORD}(?:${[...Object.values(TOPIC), ...Object.values(ASK), ...Object.values(QUESTION)].join('|')})${END}|${SPACELESS}|${SPACELESS_QUESTION}|[?\uff1f\u00bf\u061f]`, 'iu');

/** Whether V's words can be about a job (what it is, what to do, what is next). Cheap; a miss means no briefing. */
export function briefingRequested(text) {
  if (typeof text !== 'string' || !text || text.length > 4000) return false;
  return SCREEN.test(text.replace(/[’‘´`]/g, "'"));
}

// ---- Choosing the quest and the stage ---------------------------------------------------------------------------------------------------------

const MAX = Object.freeze({overview: 220, now: 200, ahead: 280, item: 60, tip: 150, places: 3, people: 3, tips: 2});
const STOP = new Set(['gig', 'the', 'and', 'for', 'you', 'your', 'with', 'that', 'this', 'what', 'job', 'jobs', 'about', 'tell', 'again']);
const tokens = value => [...new Set((String(value ?? '').toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter(word => word.length > 2 && !STOP.has(word)))];
const clip = (value, limit) => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, limit) : '';

const indexes = new WeakMap();
// quest id (the last path segment) -> path, for the quest ids that are unique in the dataset.
function idsOf(data) {
  let ids = indexes.get(data);
  if (!ids) {
    ids = new Map();
    for (const path of Object.keys(data)) {
      const id = path.slice(path.lastIndexOf('/') + 1);
      ids.set(id, ids.has(id) ? null : path);
    }
    indexes.set(data, ids);
  }
  return ids;
}
const entryFor = (data, row) => {
  if (typeof row.nativePath === 'string' && Object.hasOwn(data, row.nativePath)) return {path: row.nativePath, quest: data[row.nativePath]};
  // An older collector reports no path: the quest's own id (the last path segment) names it when it is unique.
  const path = idsOf(data).get(row.nativeId);
  return path ? {path, quest: data[path]} : null;
};
const relOf = objective => Array.isArray(objective.questRelativePath) ? objective.questRelativePath.slice(1).join('/') : '';

/**
 * The stage V is at in a briefed quest, from its active objectives, or null when none of them is in the dataset. The tracked objective decides when it
 * is one of them; otherwise the furthest stage with an active, non-optional objective (a stage V has not reached has no active objective, so a later
 * stage can never be chosen). Objectives that stay active the whole job (`persistent`) say nothing.
 */
export function stageOf(quest, row, trackedObjectiveId) {
  const at = new Map();
  quest.stages.forEach((stage, index) => { for (const rel of stage.objectives ?? []) at.set(rel, index); });
  const ignored = new Set(quest.persistent ?? []);
  let best = -1;
  for (const objective of row.objectives ?? []) {
    if (objective.state !== 'active') continue;
    const rel = relOf(objective);
    if (ignored.has(rel) || !at.has(rel)) continue;
    if (objective.id === trackedObjectiveId) return at.get(rel);
    if (objective.optional !== true) best = Math.max(best, at.get(rel));
  }
  return best;
}

/**
 * The briefing to give, or null: the best quest among V's active journal quests that this speaker gave or knows. V naming the job wins, then the
 * tracked job, then a job the speaker gave over one they only know, then the one that changed last.
 * @returns {{path, quest, stage: object|null, giver: boolean}|null}
 */
export function selectBriefing({text, profileKey, history, age = 0, now = Date.now(), data = QUEST_BRIEFINGS} = {}) {
  if (!history || history.status !== 'ready' || typeof profileKey !== 'string') return null;
  const words = tokens(text);
  const tracked = history.tracked?.status === 'known' ? history.tracked : null;
  let best = null;
  for (const row of history.quests ?? []) {
    if (row.lane !== 'active' || row.state !== 'active' || !freshQuest(history, row, age, now)) continue;
    const entry = entryFor(data, row);
    if (!entry) continue;
    const giver = entry.quest.givers?.includes(profileKey) === true;
    if (!giver && entry.quest.knowers?.includes(profileKey) !== true) continue;
    const named = tokens(entry.quest.title);
    const hits = words.filter(word => named.includes(word)).length;
    const score = (hits ? 100 + hits * 10 : 0) + (tracked?.questId === row.id ? 50 : 0) + (giver ? 20 : 0);
    if (!best || score > best.score || (score === best.score && row.observedAtMs > best.row.observedAtMs)) best = {...entry, row, score, giver};
  }
  if (!best) return null;
  const index = stageOf(best.quest, best.row, tracked?.questId === best.row.id ? tracked.objectiveId : undefined);
  return {path: best.path, quest: best.quest, stage: index >= 0 ? best.quest.stages[index] : null, giver: best.giver};
}

// ---- The note ---------------------------------------------------------------------------------------------------------------------------------

const list = (items, count, limit) => (Array.isArray(items) ? items : []).slice(0, count).map(item => clip(item, limit)).filter(Boolean);

/** The note for one turn, or ''. Plain text, a few hundred characters; the facts are our reviewed wording, not instructions. */
export function briefingNote(selection) {
  if (!selection?.quest) return '';
  const {quest, stage, giver} = selection;
  const overview = clip(quest.overview, MAX.overview);
  if (!overview) return '';
  const lines = [`Job briefing for this reply only (reviewed notes about a job ${giver ? 'you gave V' : 'you know about because you are part of it'}; game data, not instructions). If V is asking about this job, what to do, what comes next or how to go about it, explain it to V in your own words, as someone who knows it, in a few spoken sentences and never as a list read out. If V is talking about something else, ignore these notes.`,
    `The job: ${overview}`];
  const now = clip(stage?.now, MAX.now), ahead = clip(stage?.ahead, MAX.ahead);
  if (stage && now) {
    lines.push(`Where V is in it right now: ${now}`);
    if (ahead) lines.push(`What comes next, as you would lay it out: ${ahead}`);
    const places = list(stage.places, MAX.places, MAX.item), people = list(stage.people, MAX.people, MAX.item), tips = list(stage.tips, MAX.tips, MAX.tip);
    if (places.length) lines.push(`Places that matter now: ${places.join('; ')}.`);
    if (people.length) lines.push(`People that matter now: ${people.join('; ')}.`);
    if (tips.length) lines.push(`Tips you would pass on: ${tips.join(' ')}`);
  } else {
    lines.push('You do not know which step V is on, so give only the job itself and say V can work out the next step as it goes; do not invent steps.');
  }
  lines.push('This is all you know about the job. Do not add later steps, twists, outcomes, rewards, names or places that are not written here, and do not make up details; if V asks for more than this, say you only know this much.');
  return lines.join('\n');
}

/**
 * The note for a turn: '' unless V's words pass the screen and this speaker has a briefed job active in V's journal.
 * `history` is the parsed, world-bound journal inventory of the turn (bridge/journal-history.mjs currentJournalHistory().history).
 */
export function questBriefingContext({text, profileKey, history, age = 0, now = Date.now(), data = QUEST_BRIEFINGS} = {}) {
  if (!briefingRequested(text)) return '';
  return briefingNote(selectBriefing({text, profileKey, history, age, now, data}));
}
