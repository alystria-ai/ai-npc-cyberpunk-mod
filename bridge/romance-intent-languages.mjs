// The non-English rows of the romance screen (see bridge/romance-intent.mjs for how rows are compiled and matched, and for the English set).
// Each row has `propose` (V starts a romance) and `end` (V ends one): regex sources that start at a word start, written with plain accented letters.
// Japanese, Korean and Chinese are not written with spaces, so their rows use `anywhere` only (matched anywhere in the line).
// Only unambiguous romance phrases are here. Phrases that also occur in action talk ("let's split up", "we're done here", "it's over" alone, "let's go out")
// are left out on purpose, and so are plain friendly forms ("love you guys", "as a friend"). Informal and formal address and the partner's gender are covered where the language needs it.

// Latin rows: every accented letter in a source also matches its plain form, so a line typed without accents ("ich mochte", "kocham cie") is still read.
const PLAIN = {ł: 'l', ı: 'i'};
const fold = source => source.replace(/[À-ɏ]/g, ch => {
  if (ch === 'ß') return '(?:ß|ss)';
  const base = PLAIN[ch] ?? ch.normalize('NFD')[0];
  return base === ch ? ch : `[${ch}${base}]`;
});
const latin = row => ({propose: row.propose.map(fold), end: row.end.map(fold)});

const de = latin({
  propose: [
    String.raw`sei (?:meine (?:feste )?freundin|mein fester freund|meine partnerin|mein partner|meine liebste|mein liebster)`,
    String.raw`(?:willst|möchtest|wirst|wollt|wollen sie|möchten sie|werden sie)(?: du| ihr)? (?:doch |bitte )?(?:meine (?:feste )?freundin|mein fester freund|meine partnerin|mein partner)(?: sein| werden)?`,
    String.raw`(?:willst|möchtest) du mit mir (?:zusammen sein|ausgehen)`,
    String.raw`ich bin (?:\p{L}+ )?in dich verliebt|ich bin verliebt in dich|ich (?:habe|hab) mich (?:\p{L}+ )?in dich verliebt|ich verliebe mich (?:\p{L}+ )?in dich`,
    String.raw`ich (?:habe|hab|empfinde|fühle) (?:\p{L}+ )?(?:gefühle|etwas|mehr) für dich`,
    String.raw`ich liebe dich(?![\p{L}'])(?! (?:auch|alle|beide|jungs|leute|wie (?:einen|eine|meinen|meine)|als (?:freund|freundin|kumpel|bruder|schwester)|mann|alter))`,
    String.raw`ich (?:will|möchte),? (?:dass wir (?:zusammen sind|ein paar (?:sind|werden))|mit dir zusammen sein)`,
    String.raw`(?:lass uns|wollen wir) (?:ein paar werden|es offiziell machen|daten)|(?:sind wir|wir sind) mehr als (?:nur )?freunde`,
  ],
  end: [
    String.raw`schluss mit (?:dir|uns)|mit (?:dir|uns) schluss|mit dir ist (?:es )?schluss`,
    String.raw`zwischen uns ist (?:es |alles )?(?:aus|vorbei|schluss)|es ist (?:aus|vorbei) zwischen uns|unsere beziehung ist (?:vorbei|aus|zu ende)`,
    String.raw`ich bin (?:mit dir (?:fertig|durch)|(?:fertig|durch) mit dir)|ich habe die nase voll von dir`,
    String.raw`ich liebe dich nicht(?![\p{L}'])|ich empfinde nichts mehr für dich|ich habe keine gefühle mehr für dich`,
    String.raw`ich (?:will|möchte|kann) nicht mehr mit dir zusammen sein|ich will nicht mehr (?:deine freundin|dein freund|deine partnerin|dein partner) sein`,
    String.raw`ich verlasse dich(?! (?:hier|jetzt))|ich trenne mich von dir|ich (?:will|möchte) mich von dir trennen`,
    String.raw`(?:lass uns|wir sollten) (?:einfach |nur )?(?:freunde bleiben|nur freunde sein)|ich will (?:nur )?freunde bleiben`,
    String.raw`ich (?:will|möchte) andere (?:leute|menschen|frauen|männer) (?:treffen|daten)|wir sollten uns nicht mehr (?:sehen|treffen)`,
  ],
});

const fr = latin({
  propose: [
    String.raw`sois (?:ma (?:copine|petite amie|compagne)|mon (?:copain|petit ami|compagnon))`,
    String.raw`(?:veux|voulez|voudrais|voudriez)(?:[- ](?:tu|vous))? (?:bien )?(?:sortir avec moi|être (?:ma (?:copine|petite amie|compagne)|mon (?:copain|petit ami|compagnon)|à moi))`,
    String.raw`je suis (?:\p{L}+ )?amoureu(?:x|se) de (?:toi|vous)|je suis tombée? amoureu(?:x|se) de (?:toi|vous)|je tombe amoureu(?:x|se) de (?:toi|vous)|je craque pour (?:toi|vous)|je suis (?:fou|folle) de toi`,
    String.raw`j'ai (?:de |des )?(?:vrais |forts |profonds )?sentiments pour (?:toi|vous)|j'éprouve (?:des )?(?:vrais )?sentiments pour (?:toi|vous)`,
    String.raw`je (?:t'|vous )aime(?![\p{L}'])(?!,? (?:bien|aussi|tous|toutes|les gars|mon pote|comme|en tant|beaucoup comme))`,
    String.raw`je (?:veux|voudrais|souhaite) (?:qu'on (?:soit (?:ensemble|en couple)|sorte ensemble)|que nous (?:soyons (?:ensemble|en couple)|sortions ensemble)|(?:être|sortir) avec (?:toi|vous)|être (?:ton (?:copain|petit ami|compagnon)|ta (?:copine|petite amie|compagne)))`,
    String.raw`(?:et )?si on (?:sortait|se mettait) ensemble|mettons-nous (?:en couple|ensemble)|officialisons|rendons (?:ça|cela|les choses) officiel(?:le)?s?`,
    String.raw`(?:on est|nous sommes|sommes-nous|est-ce qu'on est) plus que (?:de simples |juste )?(?:des )?amis`,
  ],
  end: [
    String.raw`je romps(?: avec (?:toi|vous))?|je (?:veux|dois|vais|voudrais) rompre|rompons(?![\p{L}])|je (?:te|vous) quitte|je (?:veux|dois|vais|voudrais) (?:te|vous) quitter|je (?:veux|voudrais) qu'on rompe`,
    String.raw`c'est (?:fini|terminé|la fin) entre (?:nous|toi et moi)|entre (?:nous|toi et moi),? (?:c'est|tout est) (?:fini|terminé)|tout est fini entre nous|notre (?:histoire|relation) est (?:finie|terminée)`,
    String.raw`j'en ai (?:fini|terminé) avec (?:toi|nous)`,
    String.raw`je ne (?:t'|vous )aime plus|je n'éprouve plus rien pour (?:toi|vous)|je n'ai plus de sentiments pour (?:toi|vous)`,
    String.raw`je ne veux plus (?:être|sortir) avec (?:toi|vous)|je ne veux plus être (?:ton (?:copain|petit ami)|ta (?:copine|petite amie))|je ne veux plus de (?:notre|cette) relation`,
    String.raw`je (?:te|vous) largue|je mets fin à (?:notre (?:relation|histoire)|cette relation)`,
    String.raw`restons (?:juste |seulement |simplement )?(?:bons )?amis|on devrait (?:juste |seulement )?rester amis|arrêtons de nous voir|on devrait arrêter de se voir`,
    String.raw`je (?:veux|voudrais) (?:voir|rencontrer|fréquenter) d'autres (?:gens|personnes|filles|garçons|hommes|femmes)`,
  ],
});

const es = latin({
  propose: [
    String.raw`(?:sé|se) mi (?:novia|novio|pareja)`,
    String.raw`(?:quieres|quiere|querrías|querría|quisieras|aceptas|aceptarías|te gustaría) (?:ser (?:mi (?:novia|novio|pareja)|mía|mío)|salir conmigo|estar conmigo|empezar una relación conmigo)`,
    String.raw`estoy (?:\p{L}+ )?enamorad[oa] de ti|me (?:he )?enamoré de ti|me estoy enamorando de ti|me enamoro de ti`,
    String.raw`tengo sentimientos (?:reales |fuertes |profundos )?por ti|siento algo (?:especial |fuerte |más )?por ti`,
    String.raw`te amo(?![\p{L}'])(?!,? (?:como|chicos|a todos|todos|amigos|hermano|tío|bro|también))`,
    String.raw`te quiero(?: mucho| de verdad| con locura)?(?!,?\s*(?:amigos?|hermano|tío|bro|chicos|colega))(?=\s*(?:[.!,]|$))`,
    String.raw`quiero (?:que (?:estemos juntos|seamos pareja|seamos novios|seas mi (?:novia|novio|pareja))|estar contigo|ser tu (?:novia|novio|pareja))|quisiera que (?:estemos juntos|seamos pareja)`,
    String.raw`salgamos como pareja|empecemos una relación|hagámoslo oficial|seamos (?:pareja|novios)|(?:podemos|podríamos) ser (?:pareja|novios)|(?:somos|seremos|seamos) (?:algo )?más que (?:solo |simples )?amigos`,
  ],
  end: [
    String.raw`(?:terminar|romper|terminamos|rompemos|rompo|termino|acabo) (?:contigo|con vos|con usted|lo nuestro|nuestra relación|esta relación)`,
    String.raw`(?:terminemos|rompamos|acabemos) (?:lo nuestro|nuestra relación)`,
    String.raw`se acabó (?:lo nuestro|entre nosotros|lo que teníamos)|entre nosotros (?:todo )?(?:se )?acabó|lo nuestro (?:se )?(?:acabó|terminó|ha terminado)|todo terminó entre nosotros`,
    String.raw`he terminado contigo|ya terminé contigo|ya no hay nada entre nosotros`,
    String.raw`ya no te (?:amo|quiero)(?![\p{L}'])|no te amo(?![\p{L}'])|ya no siento nada por ti|ya no tengo sentimientos por ti|dejé de (?:amarte|quererte)`,
    String.raw`ya no quiero (?:estar contigo|ser tu (?:novia|novio|pareja))|no quiero estar contigo (?:más|nunca más)|no quiero seguir (?:siendo tu (?:novia|novio|pareja)|con lo nuestro|con nuestra relación)`,
    String.raw`(?:te voy a dejar|te estoy dejando|te dejo para siempre|voy a dejarte)(?=\s*(?:[.!,]|$))`,
    String.raw`(?:seamos|quedemos como|sigamos siendo) (?:solo |sólo |simplemente )amigos|quiero (?:ver|conocer|salir con) (?:a )?(?:otras personas|otra gente)|(?:deberíamos|tenemos que) dejar de vernos|dejemos de vernos`,
  ],
});

const it = latin({
  propose: [
    String.raw`(?:sii|fai) la mia (?:ragazza|compagna)|(?:sii|fai) il mio (?:ragazzo|compagno)`,
    String.raw`(?:vuoi|vorresti|volete|vuole|accetti di|ti va di) (?:essere (?:la mia (?:ragazza|compagna)|il mio (?:ragazzo|compagno)|mia|mio)|uscire con me|metterti con me|fidanzarti con me|diventare (?:la mia (?:ragazza|compagna)|il mio (?:ragazzo|compagno)))`,
    String.raw`sono (?:\p{L}+ )?innamorat[oa] di te|mi sono innamorat[oa] di te|mi sto innamorando di te|sono (?:cotto|cotta|pazzo|pazza) di te`,
    String.raw`(?:provo|ho) (?:dei )?(?:veri |forti |profondi )?sentimenti per te|provo qualcosa per te|sento qualcosa per te`,
    String.raw`ti amo(?![\p{L}'])(?!,? (?:ragazzi|tutti|come|amici|fratello|anche|bro))`,
    String.raw`(?:voglio|vorrei) (?:che (?:stiamo insieme|siamo una coppia|diventiamo una coppia|stessimo insieme|fossimo una coppia)|stare insieme a te|essere (?:il tuo ragazzo|la tua ragazza|il tuo compagno|la tua compagna))`,
    String.raw`mettiamoci insieme|ufficializziamo|rendiamolo ufficiale|fidanziamoci|(?:possiamo|potremmo|dovremmo) (?:essere una coppia|metterci insieme|fidanzarci)`,
    String.raw`(?:siamo|sei) (?:qualcosa di )?più che (?:solo |semplici )?amici`,
  ],
  end: [
    String.raw`ti sto lasciando|voglio lasciarti|devo lasciarti|ti lascio (?:per sempre|definitivamente)|rompo con te|voglio rompere con te|dobbiamo rompere|chiudo con te|chiudiamo (?:la nostra storia|la relazione)`,
    String.raw`è finita tra (?:noi|di noi)(?: due)?|tra noi(?: due)? è (?:tutto )?finit[ao]|la nostra (?:storia|relazione) è finita`,
    String.raw`ho (?:finito|chiuso) con te|ne ho abbastanza della nostra storia`,
    String.raw`non ti amo più|non ti amo(?![\p{L}'])|non provo più (?:nulla|niente) per te|non ho più sentimenti per te`,
    String.raw`non voglio più (?:stare con te|stare insieme|essere (?:la tua ragazza|il tuo ragazzo|la tua compagna|il tuo compagno))|non voglio stare più con te`,
    String.raw`ti mollo|ti ho mollato|sei stat[oa] mollat[oa]`,
    String.raw`restiamo (?:solo |soltanto |semplicemente )?amici|(?:rimaniamo|torniamo ad essere) (?:solo )?amici`,
    String.raw`voglio (?:vedere|frequentare|uscire con) (?:altre persone|altra gente)|dovremmo smettere di vederci|smettiamo di vederci`,
  ],
});

const pt = latin({
  propose: [
    String.raw`(?:seja|sê) (?:minha namorada|meu namorado|minha parceira|meu parceiro)`,
    String.raw`(?:quer(?:es|ia|ias)?|aceita(?:s)?|gostaria(?:s)? de) (?:namorar comigo|ser (?:minha namorada|meu namorado|minha parceira|meu parceiro)|ser (?:minha|meu)(?![\p{L}])|sair comigo)|namor[ae]s? comigo`,
    String.raw`(?:estou|tô|to) (?:\p{L}+ )?(?:apaixonad[oa]|caidinh[oa]|louc[oa]) (?:por|de) (?:ti|você|voce|vc)|(?:eu )?me apaixonei (?:perdidamente )?por (?:ti|você|voce|vc)|(?:estou|tô|to) me apaixonando por (?:ti|você|voce|vc)`,
    String.raw`(?:tenho|sinto) (?:\p{L}+ )?sentimentos por (?:ti|você|voce)|sinto algo (?:especial |forte )?por (?:ti|você|voce)`,
    String.raw`(?:te amo|amo-te|amo (?:você|voce))(?![\p{L}'])(?!,? (?:como|galera|pessoal|todos|amigos|irmão|também|cara|mano))`,
    String.raw`(?:quero|queria|gostaria de) (?:que (?:a gente |nós )?(?:sejamos (?:um casal|namorados)|namoremos)|ser (?:seu namorado|sua namorada|teu namorado|tua namorada)|namorar (?:com )?(?:você|voce|contigo))`,
    String.raw`vamos (?:namorar|ser um casal|começar a namorar|oficializar|tornar isso oficial|fazer isso oficial)`,
    String.raw`(?:somos|seremos|seríamos) mais (?:do )?que amigos|(?:podemos|poderíamos) (?:ser um casal|namorar)`,
  ],
  end: [
    String.raw`(?:terminar|terminando|termino|terminei|romper|rompendo|rompo|rompi) (?:com (?:você|voce|vc|ti)|o namoro|nosso (?:namoro|relacionamento)|nossa relação)`,
    String.raw`acabou entre nós|entre nós (?:tudo )?acabou|nosso (?:namoro|relacionamento) (?:acabou|terminou|acabado)|está tudo acabado entre nós`,
    String.raw`(?:não aguento|não quero) mais (?:esse|este|o|nosso) (?:namoro|relacionamento)`,
    String.raw`não te amo(?![\p{L}'])|não amo mais (?:você|voce)|não amo-te|deixei de te amar|não sinto mais nada por (?:ti|você|voce)|não tenho mais sentimentos por (?:ti|você|voce)`,
    String.raw`não quero mais (?:ficar com (?:você|voce)|estar com (?:você|voce)|namorar (?:com )?(?:você|voce)|namorar contigo|ficar contigo|estar contigo|ser (?:sua namorada|seu namorado|tua namorada|teu namorado))`,
    String.raw`(?:vou te deixar|estou te deixando|estou a deixar-te|vou deixar-te|tô te deixando)(?=\s*(?:[.!,]|$))|(?:vou te largar|te larguei|tô te largando|estou te largando)(?![\p{L}])`,
    String.raw`(?:vamos|fiquemos|sejamos) (?:ser |continuar |ficar )?(?:só|apenas|somente) amigos|vamos continuar amigos`,
    String.raw`quero (?:ver|conhecer|sair com|ficar com) outras pessoas|(?:temos|devemos|vamos) parar de nos ver`,
  ],
});

const pl = latin({
  propose: [
    String.raw`(?:bądź|zostań) (?:moją (?:dziewczyną|partnerką)|moim (?:chłopakiem|partnerem))`,
    String.raw`(?:chcesz|zechcesz|chciałbyś|chciałabyś|zostaniesz|czy zostaniesz) (?:być |zostać )?(?:moją (?:dziewczyną|partnerką)|moim (?:chłopakiem|partnerem))|(?:chcesz|zechcesz) ze mną chodzić`,
    String.raw`zakochał(?:em|am) się w (?:tobie|pani|panu)|jestem (?:\p{L}+ )?w tobie zakochan(?:y|a)|jestem (?:\p{L}+ )?zakochan(?:y|a) w (?:tobie|pani|panu)|zakochuję się w tobie`,
    String.raw`mam (?:\p{L}+ )?uczucia do (?:ciebie|pani|pana)|czuję do (?:ciebie|pani|pana) (?:coś(?: więcej)?|więcej)`,
    String.raw`kocham cię(?![\p{L}'])(?!,? (?:też|wszystkich|jak |jako |chłopaki|chłopcy|bracie|stary|kolego|koleżanko))`,
    String.raw`chcę,? żebyśmy (?:byli (?:razem|parą)|zostali parą)|chcę być (?:twoją (?:dziewczyną|partnerką)|twoim (?:chłopakiem|partnerem))`,
    String.raw`zostańmy parą|bądźmy parą|zacznijmy ze sobą chodzić|zróbmy to oficjalnym|zróbmy z tego coś oficjalnego`,
    String.raw`jesteśmy (?:czymś|kimś) więcej niż (?:tylko )?przyjaciółmi|czy jesteśmy (?:czymś|kimś) więcej`,
  ],
  end: [
    String.raw`zrywam z (?:tobą|panią|panem)|zerwał(?:em|am) z tobą|(?:chcę|muszę|musimy) z tobą zerwać|(?:chcę|muszę) zerwać z tobą|kończę z tobą`,
    String.raw`między nami (?:wszystko )?(?:jest )?skończone|koniec między nami|między nami koniec|koniec z nami|nasz związek (?:jest )?skończony|koniec naszego związku`,
    String.raw`skończył(?:em|am) z tobą`,
    String.raw`już cię nie kocham|nie kocham cię(?![\p{L}'])|przestał(?:em|am) cię kochać|już nic do ciebie nie czuję|nie czuję już nic do ciebie`,
    String.raw`nie chcę już z tobą być|nie chcę już być (?:z tobą|twoją (?:dziewczyną|partnerką)|twoim (?:chłopakiem|partnerem))|nie chcę być już z tobą`,
    String.raw`rzucam cię|odchodzę od ciebie|rzucił(?:em|am) cię`,
    String.raw`zostańmy (?:tylko |po prostu )?przyjaciółmi|bądźmy (?:tylko|po prostu) przyjaciółmi`,
    String.raw`chcę się spotykać z (?:innymi|kimś innym)|powinniśmy przestać się spotykać|przestańmy się widywać`,
  ],
});

const ru = {
  propose: [
    String.raw`будь (?:моей девушкой|моим парнем|моей женщиной|моим мужчиной)|стань (?:моей девушкой|моим парнем)`,
    String.raw`(?:хочешь|хотите|захочешь|согласишься|будешь|будете|хотела бы|хотел бы)(?: ли)?(?: ты| вы)? (?:встречаться со мной|со мной встречаться|(?:быть|стать) (?:моей девушкой|моим парнем|моей парой|моим молодым человеком))`,
    String.raw`я (?:\p{L}+ )?влюбил(?:ся|ась) в (?:тебя|вас)|я (?:\p{L}+ )?влюбл[её]н(?:а)? в (?:тебя|вас)|я в (?:тебя|вас) (?:\p{L}+ )?(?:влюбл[её]н(?:а)?|влюбился|влюбилась)|влюбляюсь в (?:тебя|вас)`,
    String.raw`у меня к (?:тебе|вам) (?:\p{L}+ )?чувства|я испытываю к (?:тебе|вам) (?:\p{L}+ )?чувства|я что-то к (?:тебе|вам) чувствую|я чувствую к (?:тебе|вам) (?:что-то|нечто)|у меня есть чувства к (?:тебе|вам)`,
    String.raw`(?:я )?(?:тебя люблю|люблю тебя|вас люблю|люблю вас)(?![\p{L}'])(?!,? (?:как|тоже|ребят|парни|все|усіх|всіх|друг|брат))`,
    String.raw`(?:я )?хочу,? чтобы мы (?:были вместе|стали парой|были парой|встречались)|я хочу быть (?:твоим парнем|твоей девушкой)`,
    String.raw`давай (?:будем )?встречаться(?= *(?:[.!?,]|$))|давай (?:начн[её]м встречаться|будем парой|станем парой)|давай сделаем (?:это|наши отношения) официальн(?:ым|ыми)`,
    String.raw`мы (?:с тобой )?(?:уже )?больше,? чем (?:просто )?друзья`,
  ],
  end: [
    String.raw`(?:расстаюсь|расстаёмся|расстаемся) с (?:тобой|вами)|с (?:тобой|вами) расстаюсь|мы расст(?:аё|ае)мся|давай расстанемся|(?:нам|нам с тобой) (?:надо|нужно|пора) расстаться|(?:я )?хочу (?:с тобой )?расстаться|(?:я )?порываю с (?:тобой|вами)`,
    String.raw`между нами (?:вс[её]) (?:кончено|закончено|кончилось|закончилось)|между нами конец|наши отношения (?:закончены|закончились|кончены|кончились)`,
    String.raw`я с тобой (?:закончил|закончила|порвал|порвала)|я (?:порвал|порвала|закончил|закончила) с тобой`,
    String.raw`(?:я )?(?:тебя|вас) (?:больше |уже )?не люблю|(?:я )?(?:больше |уже )?не люблю (?:тебя|вас)|я тебя разлюбил(?:а)?|я разлюбил(?:а)? тебя|я к тебе больше ничего не чувствую|я больше ничего к (?:тебе|вам) не чувствую`,
    String.raw`я (?:больше |уже )?не хочу (?:больше )?(?:быть с тобой|встречаться с тобой|быть твоим парнем|быть твоей девушкой|с тобой встречаться)`,
    String.raw`я (?:тебя бросаю|бросаю тебя|ухожу от тебя)`,
    String.raw`давай (?:(?:просто |только )?останемся (?:просто |только )?|(?:просто|только) будем |будем (?:просто|только) )друзьями`,
    String.raw`давай перестанем (?:встречаться|видеться)|(?:нам|нам с тобой) (?:надо|нужно|стоит) перестать (?:встречаться|видеться)|я хочу встречаться с (?:другими|кем-то другим|кем-то ещ[её])`,
  ],
};

const uk = {
  propose: [
    String.raw`будь (?:моєю дівчиною|моїм хлопцем)|стань (?:моєю дівчиною|моїм хлопцем)`,
    String.raw`(?:хочеш|хочете|захочеш|будеш|будете|хотіла б|хотів би)(?: ти| ви)? (?:зустрічатися зі мною|зі мною зустрічатися|(?:бути|стати) (?:моєю дівчиною|моїм хлопцем|моєю парою))`,
    String.raw`я (?:\p{L}+ )?закохав(?:ся|лася) (?:в|у) (?:тебе|вас)|я (?:\p{L}+ )?закохан(?:ий|а) (?:в|у) (?:тебе|вас)|я (?:в|у) (?:тебе|вас) (?:\p{L}+ )?закохан(?:ий|а)|закохуюся (?:в|у) (?:тебе|вас)`,
    String.raw`у мене (?:\p{L}+ )?почуття до (?:тебе|вас)|у мене до (?:тебе|вас) (?:\p{L}+ )?почуття|я (?:щось )?відчуваю до (?:тебе|вас) (?:щось|почуття|більше)|я щось до (?:тебе|вас) відчуваю`,
    String.raw`(?:я )?(?:тебе кохаю|кохаю тебе|кохаю вас|вас кохаю|люблю тебе|тебе люблю)(?![\p{L}'])(?!,? (?:як|теж|хлопці|усіх|всіх|друг|брат))`,
    String.raw`я хочу,? щоб ми (?:були разом|стали парою|зустрічалися|були парою)|я хочу бути (?:твоїм хлопцем|твоєю дівчиною)`,
    String.raw`давай (?:будемо )?зустрічатися(?= *(?:[.!?,]|$))|давай (?:почнемо зустрічатися|станемо парою|будемо парою|зробимо це офіційним|зробимо наші стосунки офіційними)`,
    String.raw`ми (?:з тобою )?більше,? ніж (?:просто )?друзі`,
  ],
  end: [
    String.raw`розриваю (?:з тобою|наші стосунки|стосунки)|(?:я )?хочу (?:з тобою )?розірвати стосунки|нам (?:треба|потрібно|варто) розірвати (?:наші )?стосунки|я хочу з тобою розійтися|я хочу розійтися з тобою`,
    String.raw`між нами (?:все|усе) (?:скінчено|закінчено|скінчилося|закінчилося)|між нами кінець|наші стосунки (?:закінчені|закінчилися|скінчилися|скінчені)`,
    String.raw`я (?:з тобою|з вами) (?:закінчив|закінчила|порвав|порвала)|я (?:закінчив|закінчила|порвав|порвала) з тобою`,
    String.raw`(?:я )?тебе (?:більше |вже )?не (?:кохаю|люблю)|(?:я )?(?:більше |вже )?не (?:кохаю|люблю) тебе|я розлюбив(?:ла)? тебе|я тебе розлюбив(?:ла)?|я до тебе більше нічого не відчуваю|я більше нічого до тебе не відчуваю`,
    String.raw`я (?:більше |вже )?не хочу (?:більше )?(?:бути з тобою|зустрічатися з тобою|бути твоїм хлопцем|бути твоєю дівчиною)`,
    String.raw`я (?:тебе кидаю|кидаю тебе|йду від тебе)`,
    String.raw`давай (?:(?:просто |лише |тільки )?залишимося (?:просто |лише |тільки )?|(?:просто|лише|тільки) будемо |будемо (?:просто|лише|тільки) )друзями`,
    String.raw`давай перестанемо зустрічатися|нам (?:треба|потрібно|варто) перестати зустрічатися|я хочу зустрічатися з (?:іншими|кимось іншим)`,
  ],
};

const tr = latin({
  propose: [
    String.raw`(?:benim )?sevgilim (?:ol(?![\p{L}])|olur musun|olur musunuz|olmak ister misin)|(?:benim )?(?:kız|erkek) arkadaşım (?:ol(?![\p{L}])|olur musun|olmak ister misin)`,
    String.raw`benimle (?:sevgili ol(?:ur musun|mak ister misin)?|çıkar mısın|çıkar mısınız|çıkmak ister misin)`,
    String.raw`sana (?:âşık|aşık) (?:oldum|olduğumu)|sana (?:âşığım|aşığım)|(?:âşık|aşık) oldum sana|sana tutuldum|sana abayı yaktım`,
    String.raw`sana karşı (?:\p{L}+ )?(?:duygularım|hislerim) var|sana karşı (?:bir )?şeyler hissediyorum|sana (?:bir )?şeyler hissediyorum`,
    String.raw`seni (?:çok )?seviyorum(?![\p{L}'])(?!,? (?:gibi|olarak|kardeşim|dostum|çocuklar|arkadaşlar))`,
    String.raw`seninle sevgili olmak istiyorum|(?:sevgilin|kız arkadaşın|erkek arkadaşın) olmak istiyorum|(?:çift|sevgili|birlikte) olmamızı istiyorum`,
    String.raw`sevgili olalım|çift olalım|resmileştirelim|ilişkimizi resmileştirelim|ilişkiye başlayalım`,
    String.raw`arkadaştan (?:daha )?fazlasıyız|arkadaştan (?:daha )?fazlası mıyız`,
  ],
  end: [
    String.raw`(?:senden|sizden) ayrılıyorum|seninle ayrılıyorum|(?:senden|seninle) ayrılmak istiyorum|seninle ayrılmamız gerek|ilişkimizi bitiriyorum|ilişkimizi bitirmek istiyorum|bu ilişkiyi bitiriyorum`,
    String.raw`aramızda(?: her şey)? bitti|aramız bitti|bitti aramızda|biz bittik|ilişkimiz bitti`,
    String.raw`seninle bitirdim|senden vazgeçtim`,
    String.raw`seni (?:artık )?sevmiyorum|artık seni sevmiyorum|sana karşı (?:artık )?(?:hislerim|duygularım) kalmadı|artık sana bir şey hissetmiyorum`,
    String.raw`(?:artık )?seninle (?:birlikte )?olmak istemiyorum|artık (?:sevgilin|kız arkadaşın|erkek arkadaşın) olmak istemiyorum|seninle artık olmak istemiyorum`,
    String.raw`seni terk ediyorum|seni terk edeceğim|seni bırakıyorum(?=\s*(?:[.!,]|$))`,
    String.raw`(?:sadece|yalnızca) arkadaş (?:kalalım|olalım)|arkadaş kalalım`,
    String.raw`başka (?:insanlarla|biriyle|kişilerle) (?:görüşmek|çıkmak) istiyorum|birbirimizi görmeyi (?:bırakmalıyız|kesmeliyiz|keselim)`,
  ],
});

const cs = latin({
  propose: [
    String.raw`buď (?:moje|mou|mojí) (?:holka|holkou|přítelkyně|přítelkyní|partnerka|partnerkou)|buď (?:můj|mým) (?:kluk|klukem|partner|partnerem)`,
    String.raw`(?:chceš|chcete|budeš|budete|chtěl bys|chtěla bys|chtěl byste|chtěla byste) (?:se mnou chodit|být (?:moje|mou|mojí) (?:holka|holkou|přítelkyně|přítelkyní|partnerka|partnerkou)|být (?:můj|mým) (?:kluk|klukem|partner|partnerem))`,
    String.raw`jsem do (?:tebe|vás) (?:\p{L}+ )?zamilovan(?:ý|á)|jsem (?:\p{L}+ )?zamilovan(?:ý|á) do (?:tebe|vás)|zamiloval(?:a)? jsem se do (?:tebe|vás)|zamilovávám se do (?:tebe|vás)|jsem do (?:tebe|vás) blázen`,
    String.raw`mám (?:\p{L}+ )?city k (?:tobě|vám)|mám k (?:tobě|vám) (?:\p{L}+ )?city|cítím k (?:tobě|vám) (?:něco|víc|cosi)`,
    String.raw`(?:miluju|miluji) tě(?![\p{L}'])(?!,? (?:jako|taky|také|kluci|holky|všechny|kámo|brácho))`,
    String.raw`chci,? abychom (?:spolu chodili|byli pár|spolu byli)|chci být (?:tvoje holka|tvůj kluk|tvoje přítelkyně|tvůj partner|tvoje partnerka)|(?:chci|chtěl bych|chtěla bych) s (?:tebou|vámi) chodit`,
    String.raw`pojďme (?:spolu chodit|být pár|to udělat oficiální)|začněme spolu chodit|udělejme to oficiální`,
    String.raw`(?:jsme|nejsme) (?:něco )?víc než (?:jen |pouhí )?(?:kamarádi|přátelé)`,
  ],
  end: [
    String.raw`rozcházím se s (?:tebou|vámi)|(?:chci|musím|musíme|potřebuju|potřebuji|chtěl bych|chtěla bych) se (?:s tebou|s vámi) rozejít|rozešel jsem se s tebou|rozešla jsem se s tebou|(?:dávám|dal jsem|dala jsem) ti kopačky|končím s tebou`,
    String.raw`mezi námi je (?:konec|po všem|všechno u konce|hotovo)|mezi námi (?:všechno )?skončilo|náš vztah (?:je u konce|skončil)`,
    String.raw`jsem s tebou (?:hotov(?:ý|á)|skončil(?:a)?)|s tebou jsem (?:hotov(?:ý|á)|skončil(?:a)?)|skončil(?:a)? jsem s tebou`,
    String.raw`(?:už )?tě (?:už )?nemiluj(?:u|i)|nemiluj(?:u|i) tě(?: už)?|přestal(?:a)? jsem tě milovat|(?:už )?k tobě (?:už )?nic necítím`,
    String.raw`(?:už )?nechci s tebou (?:už )?(?:být|chodit)|už s tebou nechci (?:být|chodit)|(?:už )?nechci (?:už )?být (?:tvoje holka|tvůj kluk|tvoje přítelkyně|tvůj partner|tvoje partnerka)`,
    String.raw`opouštím tě|odcházím od tebe`,
    String.raw`(?:zůstaňme|buďme) (?:jen|prostě|pouze) (?:kamarádi|přátelé)|zůstaňme (?:kamarády|přáteli)`,
    String.raw`chci (?:se vídat|chodit) s (?:někým jiným|jinými|dalšími lidmi)|měli bychom se přestat vídat|přestaňme se vídat`,
  ],
});

const hu = latin({
  propose: [
    String.raw`legyél (?:a )?(?:barátnőm|párom|fiúm|pasim|csajom|szerelmem)`,
    String.raw`(?:akarsz|szeretnél|szeretne|akar) velem (?:járni|randizni)|(?:akarsz|szeretnél) (?:a barátnőm|a párom|a fiúm) lenni|(?:lennél|leszel|lenne|lesz) (?:a )?(?:barátnőm|párom|fiúm|pasim|csajom)|(?:járj|randizz) velem`,
    String.raw`szerelmes vagyok (?:beléd|magába|önbe)|(?:beléd|magába) (?:\p{L}+ )?szerelmes vagyok|szerelmes lettem (?:beléd|magába)|(?:beléd|magába) (?:szerettem|zúgtam|estem|szerelmesedtem)`,
    String.raw`(?:vannak (?:\p{L}+ )?érzéseim|(?:\p{L}+ )?érzéseim vannak) (?:irántad|feléd|hozzád)|érzek valamit (?:irántad|feléd|hozzád)`,
    String.raw`szeretlek(?![\p{L}'])(?!,? (?:titeket|mindenkit|srácok|haver|haverom|tesó|mint|is))`,
    String.raw`(?:azt )?(?:akarom|szeretném),? hogy (?:együtt legyünk|járjunk egymással|pár legyünk)|(?:a )?(?:barátnőd|párod) (?:akarok|szeretnék) lenni|veled (?:akarok|szeretnék) (?:járni|randizni)`,
    String.raw`járjunk (?:együtt|egymással)|legyünk egy pár(?![\p{L}])|legyünk pár(?=\s*(?:[.!?,]|$))|tegyük hivatalossá|kezdjünk el (?:együtt )?járni`,
    String.raw`(?:többek|több) vagyunk (?:mint )?(?:egyszerű )?barátok(?:nál)?`,
  ],
  end: [
    String.raw`szakítok veled|szakítottam veled|(?:szakítani|szakítanom) (?:akarok|szeretnék|kell) veled|szakítanunk kell|szakítsunk(?![\p{L}])`,
    String.raw`vége (?:van )?köztünk|köztünk (?:mindennek )?vége|vége (?:van )?kettőnk között|vége a kapcsolatunknak|véget ért a kapcsolatunk|a kapcsolatunk véget ért`,
    String.raw`végeztem veled|végeztem a kapcsolatunkkal`,
    String.raw`(?:már )?nem szeretlek(?: (?:már|többé))?|(?:már )?nem érzek semmit irántad|(?:már )?nem érzek irántad semmit|már semmit sem érzek irántad`,
    String.raw`nem akarok (?:már |többé )?veled (?:lenni|járni|együtt lenni)|nem akarok (?:már |többé )?a (?:barátnőd|párod|fiúd) lenni`,
    String.raw`elhagylak(?![\p{L}])`,
    String.raw`maradjunk barátok|legyünk (?:csak|egyszerűen) barátok`,
    String.raw`(?:másokkal|mással|más emberekkel) akarok (?:járni|randizni)|hagyjuk abba a (?:találkozgatást|találkozást|randizást)`,
  ],
});

// Japanese, Korean and Chinese: matched anywhere in the line.
const ja = {
  propose: [],
  end: [],
  anywhere: {
    propose: [
      String.raw`(?:俺|私|僕|あたし|わたし|ぼく|おれ|うち)と(?:付き合|つきあ|交際)`,
      String.raw`(?:彼女|彼氏|恋人)に(?:なって|なりませんか|ならない|なれ)`,
      String.raw`(?<!として)(?:あなた|貴方|君|きみ|お前|おまえ)(?:のこと)?が好き(?:です|だ|なんだ|なの|だよ)(?!.{0,4}(?:友達|友だち|仲間))`,
      String.raw`(?:あなた|貴方|君|きみ|お前|おまえ)を愛して(?:る|いる|います|ます)|(?<![をがはに])愛し(?:てる|ている|てます|ています)`,
      String.raw`(?:あなた|貴方|君|きみ|お前|おまえ)に(?:惚れ|ほれ)(?:た|ました|てる|ています|ちゃった)|(?:あなた|貴方|君|きみ)に恋(?:を)?して(?:いる|る|います)|(?:あなた|貴方|君|きみ)に恋愛感情(?:が|を)(?:ある|あります|持っ)`,
      String.raw`(?:私たち|俺たち|僕たち|俺達|私達|僕達|わたしたち|あたしたち|二人)(?:は|、)?(?:付き合|つきあ|恋人(?:に|同士に)|カップルに)`,
      String.raw`(?:恋人|カップル)(?:に|同士に)なろう|恋人(?:同士)?になりましょう|正式に(?:付き合|つきあ)|友達以上(?:の関係|だ|じゃない)`,
    ],
    end: [
      String.raw`(?:あなた|貴方|君|きみ|お前|おまえ)と(?:別れ|わかれ)(?:よう|たい|ます|る|ました|た|てください)|(?:私|俺|僕|あたし|わたし)と別れて(?:ください|くれ|ほしい|欲しい)`,
      String.raw`(?:私たち|俺たち|僕たち|俺達|私達|僕達|あたしたち|わたしたち|二人)(?:は|の関係は|の恋は|、)(?:もう)?終わ(?:り|った|ろう|ってる)|(?:私たち|俺たち|僕たち|俺達|私達|僕達|あたしたち|わたしたち)の(?:関係|恋|恋愛)(?:は|を)(?:もう)?終わ`,
      String.raw`(?:あなた|貴方|君|きみ|お前|おまえ)とは(?:もう)?終わ(?:り|った|ろう)`,
      String.raw`(?:あなた|貴方|君|きみ|お前|おまえ)(?:のこと)?(?:を|は|が)(?:もう|もはや)?(?:愛して(?:い)?(?:ない|ません)|好きじゃない|好きではない|好きじゃありません|好きでなくなった)`,
      String.raw`(?:あなた|貴方|君|きみ|お前|おまえ)と(?:は)?(?:もう)?(?:一緒に)?(?:いたくない|いられない|いたくありません|付き合えない|付き合いたくない|やっていけない)`,
      String.raw`(?:あなた|貴方|君|きみ|お前|おまえ)(?:を|と)(?:振る|振ります|振った|フる|フった)`,
      String.raw`友達に戻(?:ろう|りましょう|りたい|ってほしい)|(?:これからは|もう|やっぱり|ただ)友達(?:でいよう|のままでいよう|のままでいたい|でいたい)`,
      String.raw`他の(?:人|男|女|子)と(?:付き合|つきあ)(?:いたい|いたくなった|う)|もう会うのはやめ(?:よう|ましょう)`,
      String.raw`(?:(?:私たち|俺たち|僕たち|俺達|私達|僕達|あたしたち|わたしたち|二人)(?:は|、)?(?:もう)?|(?:あなた|貴方|君|きみ|お前|おまえ)と)破局`,
    ],
  },
};

const ko = {
  propose: [],
  end: [],
  anywhere: {
    propose: [
      String.raw`(?<!친구)(?<!친구\s)사귀(?:자|어\s*줄래|어\s*주세요|실래요|지\s*않을래|어\s*볼래|어요)`,
      String.raw`(?:내|제|나의|저의)\s*(?:여자친구|남자친구|애인|연인|여친|남친)(?:가|이|로)?\s*(?:되어|돼|될래|되라|되어라)`,
      String.raw`(?<!친구로서\s?)(?<!친구로\s?)(?:너를|너|널|당신을|당신|그대를|그대)\s*(?:진심으로\s*|정말\s*|많이\s*|너무\s*)?(?:사랑(?:해|해요|합니다|한다|하고\s*있어(?:요)?)|좋아(?:해|해요|합니다|한다|하고\s*있어(?:요)?))(?!\s*[?？])`,
      String.raw`(?:너|당신|그대)(?:한테|에게|에)\s*(?:완전히\s*|완전\s*)?반(?:했어|했어요|했습니다|했다)|(?:너|당신)(?:랑|와|하고)?\s*사랑에\s*빠`,
      String.raw`(?:너|당신)(?:한테|에게|한테는|에게는)\s*(?:특별한\s*|진짜\s*|깊은\s*|연애\s*)?(?:감정|마음)이\s*(?:있어|있어요|있습니다|생겼어|생겼어요)`,
      String.raw`우리\s*(?:둘이\s*)?(?:사귈래|사귀자|사귈까|커플(?:이)?\s*(?:되자|될래|될까)|연인(?:이)?\s*(?:되자|될래|될까))`,
      String.raw`정식(?:으로)?\s*(?:사귀|연애)|친구\s*이상(?:이|의\s*사이|의\s*관계)|(?:너|당신)(?:랑|하고|와)\s*연애\s*(?:하자|하고\s*싶|해\s*볼래|해요)`,
    ],
    end: [
      String.raw`(?:우리|너랑|너와|너하고|당신과|당신하고|나랑|저랑)\s*(?:이제\s*|그만\s*|이만\s*|이쯤에서\s*)?헤어(?:지자|지고\s*싶|질래|집시다|져|져요|졌어|졌다|지기로|지겠)`,
      String.raw`우리\s*(?:사이|관계)(?:는|가)?\s*(?:이제\s*)?끝|(?:너|당신)(?:랑|와|하고)\s*(?:나|저)(?:\s*사이|\s*관계)?(?:는|도)?\s*(?:이제\s*)?끝|(?:너|당신)(?:랑|와|하고)(?:은|는)\s*(?:이제\s*|완전히\s*)?끝`,
      String.raw`(?:너를|너|널|당신을|당신)\s*(?:더\s*이상|이제|이젠|더는)?\s*(?:사랑하지\s*않(?:아|아요|습니다|는다)|사랑\s*안\s*(?:해|해요|한다))|(?:너를|너|널|당신을|당신)\s*(?:더\s*이상|이제|이젠)\s*좋아하지\s*않`,
      String.raw`(?:너|당신)(?:에\s*대한|한테)\s*(?:감정|마음|사랑)이?\s*(?:식었|없어졌|사라졌|남아\s*있지\s*않)`,
      String.raw`(?:너|당신)(?:랑|와|하고)\s*(?:더\s*이상|이제|더는|이젠)\s*(?:같이\s*|함께\s*)?(?:있고\s*싶지\s*않|사귀고\s*싶지\s*않|사귀기\s*싫|사귀지\s*못|만나고\s*싶지\s*않)`,
      String.raw`(?:너|당신)(?:를|을)\s*(?:떠날게|떠날\s*거야|떠나겠어|떠날래)`,
      String.raw`우리\s*(?:그냥|이제|다시)\s*친구(?:로|로서)?\s*(?:지내|남|돌아가|하)(?:자|요|기로|겠)`,
      String.raw`다른\s*(?:사람|여자|남자)(?:을|이랑|과|하고)?\s*(?:만나고\s*싶|만나\s*보고\s*싶|사귀고\s*싶)|우리\s*(?:이제\s*)?(?:그만\s*(?:만나|보)자|(?:더\s*이상\s*)?만나지\s*말자)`,
    ],
  },
};

const zh = {
  propose: [],
  end: [],
  anywhere: {
    propose: [
      String.raw`(?:做|当|當|成为|成為)我(?:的)?(?:女朋友|男朋友|女友|男友|对象|對象|恋人|戀人|伴侣|伴侶)`,
      String.raw`(?:和|跟|與|与)我(?:交往|谈恋爱|談戀愛|处对象|處對象)|(?:和|跟|與|与)我在一起(?:吧|好吗|好嗎|可以吗|可以嗎|好不好|吗|嗎)|愿意(?:和|跟)我在一起|願意(?:和|跟)我在一起`,
      String.raw`(?:我们|我們|咱们|咱們)(?:在一起|交往|谈恋爱|談戀愛|正式交往)吧|(?:我们|我們)正式交往`,
      String.raw`我想(?:要)?(?:和|跟|與|与)你(?:在一起|交往|谈恋爱|談戀愛)|(?:和|跟|與|与)你(?:成为|成為)(?:情侣|情侶|恋人|戀人|一对|一對)`,
      String.raw`(?<![不没沒别別谁誰])(?:爱你|愛你|喜欢你|喜歡你|爱上了你|愛上了你|爱上你|愛上你|喜欢上了你|喜歡上了你|喜欢上你|喜歡上你)(?!们|們|的|吗|嗎|呢)`,
      String.raw`(?:对你|對你)有(?:好感|感觉|感覺|感情)|(?:对你|對你)(?:动心|動心|心动|心動)`,
      String.raw`(?:我们|我們)(?:是不是|算不算|已经|已經)?(?:不只是|不止是|不仅仅是|不僅僅是|超越|超过|超過|超出)(?:了)?朋友`,
    ],
    end: [
      String.raw`(?:我们|我們|咱们|咱們|和你|跟你|與你|与你|我要|我想|我决定|我決定|我们得|我們得)分手|分手吧`,
      String.raw`(?:我们|我們|咱们|咱們)(?:之间|之間|的感情|的关系|的關係|的爱情|的愛情)(?:已经|已經)?(?:结束|結束|完了|到头了|到頭了|到此为止|到此為止)`,
      String.raw`我(?:跟|和|與|与)你(?:已经|已經|早就)?(?:完了|结束了|結束了|玩完了|断了|斷了)`,
      String.raw`我(?:已经|已經)?不(?:再)?(?:爱|愛)你(?:了|啦)?|我(?:已经|已經|早就)?不(?:再)?(?:喜欢|喜歡)你了|我(?:对你|對你)(?:已经|已經)?(?:没有|沒有|没|沒)(?:感觉|感覺|感情)了`,
      String.raw`我(?:不想|不要|不愿意|不願意)(?:再)?(?:和|跟|與|与)你(?:在一起|交往|继续下去|繼續下去)`,
      String.raw`我(?:不想|不要|不愿意|不願意)(?:再)?(?:做|当|當)你(?:的)?(?:女朋友|男朋友|女友|男友|对象|對象)`,
      String.raw`我(?:要|决定|決定|打算)(?:离开|離開)你了|你被(?:我)?甩了`,
      String.raw`(?:还是|還是|就|只|仅|僅)(?:做|当|當|是)(?:回)?(?:普通)?朋友(?:吧|好了|算了|就好)`,
      String.raw`我(?:想|要)(?:和|跟|與|与)(?:别人|別人|其他人|别的人|別的人)(?:交往|约会|約會|谈恋爱|談戀愛)|(?:我们|我們)(?:不要|别|別|不)(?:再)?(?:见面|見面|来往|來往)了`,
    ],
  },
};

export const LANGUAGE_PATTERNS = Object.freeze({de, fr, es, it, pt, pl, ru, uk, tr, cs, hu, ja, ko, zh});
