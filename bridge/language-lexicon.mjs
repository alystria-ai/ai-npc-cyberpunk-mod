// Word lists for the language detector (bridge/reply-language.mjs). Data only; loaded once when the bridge starts.
//
// Each list holds the common words of one Latin-script language as a player types them to a character: function words, the
// everyday verbs in their usual forms, question words, greetings, and the nouns and adjectives of driving, fighting, shopping and
// small talk. The detector uses the lists twice: as a lexicon (a word found in only one list is strong evidence for that language,
// a word found in several shares its weight) and as the training text of a small character model, which recognises the spelling
// of words the lists do not hold ("arrivati" ends like Italian participles even though no list names it).
//
// Words spelled the same in English and the language ("plan", "police", "mission", "taxi") are left out of the other language's
// list on purpose: they say nothing, and they would pull an English line towards it.
// Accented words are listed with their accent-less spelling too where players commonly drop the accent ("ca va", "como estas").
// Elision heads are listed with their apostrophe ("j'", "l'", "qu'"); the detector splits "j'ai" into "j'" and "ai".

export const WORDS = {
  en: `the a an and or but if then than so because as of in on at to for with from by about into over after before under between through
    i me my mine myself you your yours yourself he him his she her hers it its we us our ours they them their theirs this that these those
    am is are was were be been being do does did done doing have has had having will would shall should can could may might must
    not no yes yeah yep nope nah what which who whom whose why how where when there here now then today tonight tomorrow yesterday
    just only very really too also still even ever never always again already soon later maybe perhaps please sorry thanks thank welcome
    hello hi hey bye goodbye okay sure fine right wrong good bad best better great nice cool awesome terrible big small little old new young
    all any some many much more most few less other another each every both either neither one two three four five ten
    go goes going went gone come comes coming came get gets getting got give gave take took make made let see saw look looking know knew think thought
    want need like love hate feel tell told say said ask asked talk speak call help find found keep put bring brought leave left stay wait run walk drive
    driving drove ride riding stop move turn open close buy sell pay cost price money fight kill shoot hit hurt die dead alive live work try use
    happened happen believe remember forget understand mean meant hear heard listen watch show start finish
    don't doesn't didn't can't won't wouldn't couldn't shouldn't isn't aren't wasn't weren't haven't hasn't hadn't i'm i'll i've i'd you're you'll you've you'd
    he's she's it's we're we'll we've they're they'll they've that's there's what's who's here's where's how's let's gonna wanna gotta lemme gimme
    guy guys man men woman women friend friends people person kid kids boy girl brother sister mom dad family home house room door street road city town
    car bike truck van ride gun weapon weapons knife armor jacket food drink beer water coffee shop store bar club job work gig deal thing things stuff
    way time day night morning evening week year minute second hour moment life world place name head hand hands eyes face heart mind plan idea story
    problem question answer reason trouble luck chance mistake fault news truth lie secret game fun party music song
    left right straight fast slow faster slower quick quickly careful ahead behind back away down up out off inside outside around near far close
    long short high low hot cold hungry tired ready busy late early free safe dangerous crazy insane sick drunk broke rich poor
    who's anyone anything anywhere everyone everything everywhere someone something somewhere nobody nothing nowhere
    mate dude bro pal buddy boss sir miss mister lady`,

  fr: `le la les un une des du de d' au aux et ou mais donc ni car que qu' qui quoi dont où quand comment pourquoi parce combien quel quelle quels quelles
    est sont était étais étaient été être suis es sommes êtes sera serait soit sois serai ai as a avons avez ont avait avais avoir eu aurai aurait
    je j' tu il elle on nous vous ils elles me m' te t' se s' lui leur leurs moi toi soi mon ma mes ton ta tes son sa ses notre nos votre vos
    ce c' cet cette ces ça ca ceci cela ici là la-bas très tres trop assez plus moins aussi encore déjà deja toujours jamais souvent parfois
    peut-être peut-etre vraiment seulement bien mal mieux mauvais mauvaise bon bonne bons bonnes beau belle belles beaux grand grande petit petite
    oui non pas ne n' rien personne tout tous toute toutes quelque quelques quelqu'un chaque autre autres même meme sans avec pour par dans sur sous entre vers chez
    depuis pendant avant après apres contre devant derrière derriere l' merci svp bonjour bonsoir salut bonne nuit revoir allô allo d'accord
    vais vas va allons allez vont aller fais fait faisons faites font faire veux veut voulons voulez veulent vouloir peux peut pouvons pouvez peuvent pouvoir
    sais sait savons savez savent savoir viens vient venons venez viennent venir vois voit voyons voyez voir dis dit disons dites disent dire donne donnes
    donnez donner prends prend prenez prendre mets mettre arrête arrete arrêter arreter attends attendez attendre regarde regardez écoute ecoute écoutez
    conduis conduire parle parler aide aider besoin envie peur trouver trouve cherche chercher pense penser crois croire comprends comprends comprendre
    appelle appeler tuer tue mort morte vivant vie argent temps heure heures jour jours nuit soir matin demain hier aujourd'hui semaine moment fois
    chose choses gens homme femme ami amis amie copain copine pote mec fille garçon garcon enfant voiture moto ville rue quartier maison
    arme armes flingue flics gars coûte coute coûter couter prix cher chère chere fatigué fatigue fatiguée prêt pret prête prete content contente
    désolé desole désolée problème probleme réponse reponse histoire idée idee travail boulot patron
    suis-je es-tu est-ce qu'est-ce n'est c'est j'ai j'suis t'es y'a il-y-a viens-tu veux-tu peux-tu allons-y vas-y allez-y
    doit dois dois-je faut faudrait fallait devons devez doivent devoir connais connaît connaissez connaitre rester reste restons restez partir pars part partons
    partez monter monte descendre descends sortir sors sort entrer entre entrez ouvrir ouvre fermer ferme montre montrer laisse laisser laissez emmène emmener
    amène amener ramène rapporter apporte apporter acheter achète vendre vends payer paye paie coûté combien-de mange manger boire bois boit
    dormir dors dort fatigue rapide vite lentement doucement attention prudent faites-moi dis-moi donne-moi montre-moi aide-moi
    mon-pote ma-belle quelle-heure heure-est-il
    flingue flingues bagnole caisse bagnoles frisson frissons veste vestes marché marche marchés magasin magasins boutique cette-veste
    hier-soir ce-soir cette-nuit tout-de-suite maintenant tout-à-l'heure tout-a-l'heure bientôt bientot dépêche depeche dépêchons dépêchez
    désolé merci-beaucoup beaucoup peu trop-de pas-de rien-du-tout jamais-de
    quoi-de-neuf comment-vas-tu ça-va ca-va comment-allez-vous enchanté enchante bienvenue
    chaud froid faim soif sommeil raison tort chance malchance
    voulez-vous pouvez-vous avez-vous êtes-vous savez-vous
    ah oh eh hé hein bah ben bof voilà voila tiens
    celui celle ceux celles lequel laquelle lesquels y en leur-donne
    ensemble seul seule seuls ensuite puis alors donc enfin finalement
    ouvre-la ferme-la`,

  es: `el la los las un una unos unas lo al del y e o u pero sino aunque porque pues que qué quien quién quienes cual cuál cuáles como cómo donde dónde
    cuando cuándo cuanto cuánto cuánta cuántos cuántas por para con sin sobre entre hacia hasta desde contra durante según tras
    soy eres es somos sois son era eras éramos eran fue fui fueron sido ser estoy estás estas está esta estamos están estar estaba estuvo estado
    tengo tienes tiene tenemos tienen tener tenía tuve hay había hubo haber he has ha hemos han hecho
    yo tú tu usted nosotros nosotras vosotros ellos ellas él ella me te se nos os les le mi mis tus su sus nuestro nuestra vuestro mío mía
    este esta esto estos estas ese esa eso esos esas aquel aquella aquello aquí aqui allí alli ahí ahi acá
    muy mucho mucha muchos muchas poco poca pocos más mas menos tan tanto también tambien tampoco ya aún aun todavía todavia siempre nunca jamás casi
    sí si no nada nadie nunca algo alguien alguno alguna algún todo toda todos todas cada otro otra otros otras mismo misma
    bien mal mejor peor bueno buena buenos buenas malo mala grande pequeño pequeña nuevo nueva viejo vieja
    hola adiós adios gracias vale oye mira ey eh claro perdón perdon disculpa por-favor favor buenas buenos-días buenas-noches noches días dias tardes
    voy vas va vamos van ir vámonos vamonos vente ven vengo vienes viene vienen venir vete váyase
    quiero quieres quiere queremos quieren querer puedo puedes puede podemos pueden poder sé sabes sabe sabemos saben saber
    hago haces hace hacemos hacen hacer dime dices dice decimos dicen decir digo doy das da dan dar dame dale
    veo ves ve vemos ven ver miro mira miras mirar escucha escuchar espera esperar para-ya para-el para-coche
    necesito necesitas necesita necesitamos necesitar ayuda ayudar ayúdame ayudame busco buscar encontrar encuentro
    pienso piensas piensa pensar creo crees cree creer entiendo entiendes entiende entender llamar llamo llama
    matar mata muerto muerta vivo vida dinero tiempo hora horas día dia noche tarde mañana manaña ayer hoy semana momento vez veces
    cosa cosas gente hombre mujer amigo amiga amigos chico chica chicos chicas tío tia hermano hermana compa
    coche carro moto camino calle ciudad barrio casa tienda mercado arma armas pistola
    cuesta cuánto-cuesta cuanto-cuesta precio caro cara barato barata rápido rapido lento despacio cuidado cuida
    cansado cansada listo lista contento contenta lo-siento siento problema pregunta respuesta historia idea plan trabajo jefe cliente
    duele duelen cabeza falta faltan conducir conduce conduces maneja manejar llévame llevame llevas llevar lleva
    quién-conduce tengo-que tienes-que hay-que que-pasa qué-pasa qué-tal que-tal cómo-estás como-estas
    música buena bonita guapo guapa chula chulo
    estoy-cansado vámonos-de cuídate cuidate tranquilo tranquila tranquilos calma
    esta-noche anoche ahora luego después despues antes pronto tarde temprano
    mucho-gusto de-nada con-permiso adelante vamos-ya
    dónde-está donde-esta quién-es quien-es qué-es que-es
    ojo ojos mano manos cara corazón corazon
    pasa pasó paso pasar quedar queda quédate quedate salir sal sale salgo subir sube bajar baja entrar entra abrir abre cerrar cierra
    comer come como bebo beber bebe dormir duerme
    parar para-ahí detente detén`,

  it: `il lo la i gli le un uno una un' e ed o ma però pero perché perche poiché quindi anche neanche nemmeno né se che chi cui cosa come dove quando quanto quanta quanti quante
    di del dello della dei degli delle a al allo alla ai agli alle da dal dallo dalla dai dagli dalle in nel nello nella nei negli nelle con col su sul sullo sulla sui per tra fra
    sono sei è siamo siete era eri erano fu sarà sarebbe essere stato stata stati state sto stai sta stiamo stanno stare
    ho hai ha abbiamo avete hanno avere avevo aveva ebbe avuto avrò
    io tu lui lei noi voi loro mi ti ci vi si lo la li le ne mio mia miei mie tuo tua tuoi tue suo sua suoi sue nostro nostra nostri vostro
    questo questa questi queste quello quella quelli quelle codesto qui qua lì lì là
    molto molta molti molte poco poca pochi più meno tanto tanta troppo abbastanza anche già ancora sempre mai spesso forse proprio solo soltanto
    sì si no non niente nulla nessuno qualcosa qualcuno ogni tutto tutta tutti tutte altro altra altri altre stesso stessa
    bene male meglio peggio buono buona buoni brutto brutta grande piccolo piccola nuovo nuova vecchio vecchia
    ciao salve buongiorno buonasera buonanotte arrivederci addio grazie prego scusa scusi mille per-favore favore allora dai forza basta ecco
    vado vai va andiamo andate vanno andare andiamo-via vieni viene veniamo venite vengono venire vengo
    voglio vuoi vuole vogliamo volete vogliono volere posso puoi può possiamo potete possono potere so sai sa sappiamo sapete sanno sapere
    faccio fai fa facciamo fate fanno fare dimmi dici dice diciamo dite dicono dire dico do dai dà diamo danno dare dammi dagli
    vedo vedi vede vediamo vedete vedono vedere guarda guardi guardare ascolta ascoltare aspetta aspettare aspetto fermati fermare ferma fermiamoci
    ho-bisogno bisogno aiuto aiutare aiutami aiuta cerco cerca cercare trovare trovo penso pensi pensa pensare credo credi crede credere
    capisco capisci capisce capire chiamare chiamo chiama uccidere ucciso morto morta vivo vita soldi tempo ora ore giorno giorni notte sera mattina domani ieri oggi stasera
    settimana momento volta volte cosa cose gente uomo donna amico amica amici ragazzo ragazza ragazzi bambino
    macchina auto moto strada città quartiere casa negozio mercato arma armi pistola fucile
    costa quanto-costa prezzo caro cara economico veloce lento piano attento attenzione
    stanco stanca pronto pronta contento contenta dispiace scusami problema domanda risposta storia idea lavoro capo cliente
    siamo-quasi arrivati arrivato arrivata arrivare arrivo quasi andati andato andata partito partiti finito finiti finita stato visto fatto detto preso messo stanco-morto
    stiamo andando stai andando sto andando guidare guido guidi guida portami portare porta porto
    mangiare mangio mangi mangia bere bevo beve dormire dormo dorme fame sete sonno
    parlare parlo parli parla italiano parli-italiano
    ieri-sera ci-vediamo vediamoci a-presto presto tardi subito adesso ora-adesso dopo prima poi
    bellissima bellissimo bella bello belle belli brava bravo bravi bravissimo
    giubbotto giacca tipo banda capo ci-stanno stanno-seguendo seguire seguendo seguito
    fuori dentro sopra sotto davanti dietro vicino lontano
    tempo-fa che-tempo-fa tempo-fa non-so non-mi-fido mi-fido fido fidarsi
    figlio figlia fratello sorella madre padre mamma papà
    caffè perfetto perfetta giusto giusta sbagliato sbagliata vero vera falso
    dell' all' nell' sull' dall' quest' c' l' un' sant' com' dov' cos' quand' anch' d'`,

  pt: `o a os as um uma uns umas e ou mas porém porque pois que quê quem qual quais como onde quando quanto quanta quantos quantas
    de do da dos das em no na nos nas com por para pra pelo pela pelos pelas ao aos à às sobre entre até desde contra sem sob após
    sou és é somos são era eras eram foi fui foram sido ser estou está estás estamos estão estar estava esteve estado
    tenho tem tens temos têm ter tinha tive havia há haver hei
    eu tu você vocês ele ela nós eles elas me te se nos lhe lhes meu minha meus minhas teu tua seu sua seus suas nosso nossa
    este esta isto estes estas esse essa isso esses essas aquele aquela aquilo aqui aí ali lá cá
    muito muita muitos muitas pouco pouca poucos mais menos tão tanto também tampouco já ainda sempre nunca jamais quase talvez realmente apenas só
    sim não nada ninguém algo alguém algum alguma todo toda todos todas cada outro outra outros outras mesmo mesma
    bem mal melhor pior bom boa bons boas ruim grande pequeno pequena novo nova velho velha
    olá oi tchau adeus obrigado obrigada valeu por-favor favor desculpa desculpe licença bom-dia boa-noite boa-tarde noite tarde dia dias noites
    vou vai vamos vão ir vamos-embora embora venha vem venho vens vêm vir
    quero queres quer queremos querem querer posso podes pode podemos podem poder sei sabes sabe sabemos sabem saber
    faço fazes faz fazemos fazem fazer diga digo diz dizemos dizem dizer dou dá damos dão dar dê me-dá
    vejo vês vê vemos veem ver olha olhe olhar escuta escutar espera esperar espere pare parar pára
    preciso precisa precisamos precisar ajuda ajudar ajude me-ajuda procuro procurar encontrar encontro
    acho acha achar penso pensa pensar creio creio-que entendo entende entender chamar chamo chama
    matar morto morta vivo vida dinheiro tempo hora horas dia noite amanhã ontem hoje semana momento vez vezes
    coisa coisas gente homem mulher amigo amiga amigos cara garoto garota menino menina rapaz
    carro moto estrada rua cidade bairro casa loja mercado arma armas pistola
    custa quanto-custa preço caro cara barato barata rápido rápida devagar cuidado atenção
    cansado cansada pronto pronta contente desculpa problema pergunta resposta história ideia plano trabalho chefe cliente
    falta falar falo fala fala-português português fala-inglês leva levar leva-me levo praia celular telefone
    restaurante melhor-restaurante perigosa perigoso perigosos mesmo-assim muito-perigosa
    atrás de-nós cuidado-com tarde-demais está-tarde já-está-tarde
    quero-ir vamos-lá vamos-nessa bora tá tô tava né pois-é
    ficar fico fica ficamos ficam sair saio sai sair subir sobe descer desce entrar entra abrir abre fechar fecha
    comer como-eu beber bebo dormir dorme fome sede sono
    ver-você viu vi vimos
    não-quero lutar luta lutas lutar-hoje hoje-não
    nação coração mão mãos irmão irmã mãe pai filho filha
    ações emoções informações opinião opiniões pensão questões lições situação situações decisão decisões
    conversa conversar conversamos
    eu-preciso preciso-de de-um um-carro carro-novo
    unhas filho-da-mãe`,

  de: `der die das den dem des ein eine einen einem einer eines gute guten guter gutes kein keine keinen keinem und oder aber denn sondern doch weil dass daß ob wenn als wie wo wohin woher wann warum wieso weshalb was wer wen wem wessen welche welcher welches
    ist sind war waren bin bist sei seid sein gewesen werde wirst wird werden wurde wurden geworden habe hast hat haben hatte hatten gehabt
    ich du er sie es wir ihr mich dich ihn uns euch ihnen ihm mir dir mein meine meinen meinem dein deine deinen sein seine ihre unser unsere euer
    nicht nichts nie nein ja jetzt hier da dort dorthin heute morgen gestern abend nacht tag tage woche zeit mal schon noch nur auch sehr ganz viel viele mehr weniger zu zum zur von vom mit nach bei seit aus für auf an am im in ins um über unter vor hinter zwischen durch gegen ohne bis
    gut schlecht besser beste schön hässlich groß klein neu alt jung lang kurz schnell langsam leicht schwer richtig falsch wahr müde fertig bereit froh
    hallo tschüss danke dankeschön bitte entschuldigung entschuldige gern gerne klar genau natürlich vielleicht wirklich eigentlich eben halt
    gehe gehst geht gehen gegangen komm kommst kommt kommen komme fahre fährst fährt fahren fahr bleib bleibe bleibt bleiben warte wartet warten halt halte hält anhalten
    will willst wollen wollt kann kannst können könnt muss musst müssen müsst soll sollst sollen darf darfst dürfen weiß weißt wissen kenne kennst kennen mag magst mögen möchte möchtest möchten
    mache machst macht machen gib gibst gibt geben sag sagst sagt sagen sehe siehst sieht sehen schau schaue schauen hör höre hören denke denkst denkt denken glaube glaubst glaubt glauben
    verstehe verstehst versteht verstehen brauche brauchst braucht brauchen suche suchst sucht suchen finde findest findet finden helfen hilf hilfe hilfst hilft
    lass lasst lassen lass-uns uns nimm nimmt nehmen bring bringe bringt bringen zeig zeige zeigen kauf kaufe kaufen verkaufen zahlen kosten kostet
    töten tot lebendig leben geld stunde stunden minute minuten augenblick moment mal ding dinge sache sachen leute mensch menschen mann männer frau frauen freund freunde kumpel junge mädchen kind kinder
    auto wagen motorrad straße stadt viertel haus laden markt waffe waffen pistole
    problem frage antwort geschichte idee plan arbeit chef kunde
    sprichst sprechen spreche spricht deutsch englisch sprichst-du
    wetter polizei hafen bar abend heute-abend kämpfe kampf kämpfen munition implantat idee gelaunt schlecht-gelaunt
    wie-weit weit weiter wie-lange lange noch-nicht noch-mal nochmal nochmals
    ich-habe ich-bin ich-brauche ich-will ich-kann ich-muss
    wir-müssen müssen-los los gehen-wir lass-uns-gehen
    zur-bar zum-hafen
    keine-lust lust hunger durst angst glück pech
    süß lecker billig teuer günstig vorsichtig langsamer schneller
    echt wirklich total ziemlich ganz-schön
    ähm äh hm na tja naja nö
    ihn sie-haben haben-sie
    über-uns über-mich für-dich für-mich mit-mir mit-dir
    ß`,

  nl: `de het een en of maar want dus als dat die dit deze wat wie waar wanneer waarom hoe welke omdat hoewel
    ben bent is zijn was waren geweest word wordt worden werd heb hebt heeft hebben had hadden gehad
    ik jij je u hij zij ze wij we jullie ons mijn jouw uw zijn haar hun onze mij jou hem hen hun
    niet geen niets nooit nee ja nu hier daar vandaag gisteren morgen vanavond nacht dag tijd al nog ook heel erg veel meer minder te van met naar bij uit voor op aan in om over onder tussen door tegen zonder tot
    goed slecht beter beste mooi lelijk groot klein nieuw oud jong lang kort snel langzaam makkelijk moeilijk waar fout moe klaar blij
    hallo doei dank bedankt dankjewel alsjeblieft sorry graag natuurlijk misschien echt eigenlijk gewoon even maar-even toch wel
    ga gaat gaan gegaan kom komt komen kan kun kunt kunnen moet moeten wil wilt willen zal zullen mag mogen weet weten ken kent kennen
    doe doet doen zeg zegt zeggen geef geeft geven zie ziet zien kijk kijken luister luisteren denk denkt denken geloof geloven snap snapt begrijp begrijpt begrijpen
    help helpen hulp zoek zoeken vind vinden neem nemen breng brengen laat laten koop kopen verkopen betalen kost kosten
    rijden rijd rij rijdt wacht wachten blijf blijven stop stoppen
    dood levend leven geld uur minuut moment ding dingen zaak mensen man vrouw vriend vrienden maat jongen meisje kind kinderen
    auto motor straat stad wijk huis winkel markt wapen wapens pistool centrum rit
    probleem vraag antwoord verhaal idee plan werk baas klant
    geen-zin gedoe zin honger dorst angst geluk pech
    weg waarheen heen heen-gaan we-heen gaan-we dichtstbijzijnde
    geweldig echt-geweldig mooi-wapen
    hoi hoe-gaat-het met-je het-met-je`,

  pl: `i oraz lub albo ale bo ponieważ więc że żeby jeśli jeżeli gdy kiedy gdzie dokąd skąd co kto kogo komu kim czy jak jaki jaka jakie dlaczego czemu ile który która które
    jest są był była było byli były być będzie będą jestem jesteś jesteśmy jesteście mam masz ma mamy macie mają miał miała mieć
    ja ty on ona ono my wy oni one mnie mi cię ci go mu ją jej nas nam was wam ich im mój moja moje twój twoja twoje jego nasz nasza wasz wasza się siebie
    nie tak nic nigdy już jeszcze też także bardzo trochę dużo mało więcej mniej tu tutaj tam teraz dzisiaj dziś wczoraj jutro wieczorem noc dzień czas
    do od z ze w we na po za przed pod nad przez dla bez u o przy między
    dobry dobra dobre zły zła lepszy najlepszy ładny duży mały nowy stary młody szybko wolno łatwo trudno prawda fałsz zmęczony gotowy
    cześć hej dzień-dobry dobranoc do-widzenia dziękuję dzięki proszę przepraszam sorry oczywiście może naprawdę właściwie stary
    idę idziesz idzie idziemy idą iść jadę jedziesz jedzie jedziemy jadą jechać jedźmy jedź chodź chodźmy
    chcę chcesz chce chcemy chcą chcieć mogę możesz może możemy mogą móc wiem wiesz wie wiemy wiedzieć muszę musisz musi musimy musieć
    robię robisz robi robić mówię mówisz mówi mówić powiedz powiedzieć daj dać daję widzę widzisz widzi widzieć patrz patrzeć słuchaj słuchać myślę myślisz myśli myśleć
    rozumiem rozumiesz rozumieć potrzebuję potrzebujesz potrzebuje pomóż pomoc pomocy szukam szukać znaleźć biorę weź wziąć kupić sprzedać zapłacić kosztuje kosztować
    czekaj czekać zostań zostać stój stop
    zabić martwy żywy życie pieniądze godzina minuta chwila rzecz rzeczy ludzie człowiek mężczyzna kobieta przyjaciel kumpel chłopak dziewczyna dziecko
    samochód motor ulica miasto dzielnica dom sklep rynek broń pistolet
    problem pytanie odpowiedź historia pomysł plan praca szef klient
    nie-chcę walczyć dzisiaj najbliższy najbliższa najbliższe sklep centrum szybko
    jak-się-masz co-słychać`,

  cs: `a i nebo ale protože tedy že aby jestli když kdy kde kam odkud co kdo koho komu kým jak jaký jaká jaké proč kolik který která které
    je jsou byl byla bylo byli být bude budou jsem jsi jsme jste mám máš má máme máte mají měl měla mít
    já ty on ona ono my vy oni ony mě mi tě ti ho mu ji jí nás nám vás vám jim můj moje tvůj tvoje jeho její náš naše váš se si
    ne ano nic nikdy už ještě také taky velmi moc trochu hodně málo více méně tady tu tam teď dnes včera zítra večer noc den čas
    do od z ze v ve na po za před pod nad přes pro bez u o při mezi
    dobrý dobrá dobré špatný lepší nejlepší hezký velký malý nový starý mladý rychle pomalu snadno těžko pravda lež unavený připravený
    ahoj čau dobrý-den dobrou-noc nashledanou děkuji děkuju díky prosím promiň samozřejmě možná opravdu vlastně kámo
    jdu jdeš jde jdeme jdou jít jedu jedeš jede jedeme jedou jet pojď pojďme
    chci chceš chce chceme chtějí chtít mohu můžu můžeš může můžeme mohou moct vím víš ví víme vědět musím musíš musí musíme muset
    dělám děláš dělá dělat říkám říkáš říká říct řekni dej dát vidím vidíš vidí vidět podívej koukej slyším poslouchej myslím myslíš myslí myslet
    rozumím rozumíš rozumět potřebuji potřebuju potřebuješ pomoz pomoc pomozte hledám hledat najít vezmi vzít koupit prodat zaplatit stojí stát
    počkej čekat zůstaň zůstat stůj
    zabít mrtvý živý život peníze hodina minuta chvíle věc věci lidé člověk muž žena přítel kamarád kluk holka dítě
    auto motorka ulice město čtvrť dům obchod trh zbraň pistole
    problém otázka odpověď příběh nápad plán práce šéf zákazník
    nerozumím tomu nejbližší obchod kde-je jak-se-máš jak-dlouho`,

  hu: `a az egy és vagy de mert hogy ha amikor mikor hol hová honnan mi mit ki kit kinek kivel hogyan milyen miért mennyi melyik
    van vannak volt voltak lesz vagyok vagy vagyunk vagytok nincs nincsenek
    én te ő mi ti ők engem téged őt minket titeket őket nekem neked neki nekünk nektek nekik enyém tied övé velem veled vele
    nem igen semmi soha már még is szintén nagyon kicsit sok kevés több kevesebb itt ott most ma tegnap holnap este éjszaka nap idő
    be ki fel le el meg át rá ide oda
    jó rossz jobb legjobb szép nagy kicsi új régi fiatal gyorsan lassan könnyű nehéz igaz hamis fáradt kész
    szia sziasztok helló viszlát jó-éjszakát köszönöm köszi kérem bocsánat persze talán tényleg valójában haver
    megyek mész megy megyünk mennek menni jövök jössz jön jövünk jönnek jönni gyere gyerünk
    akarok akarsz akar akarunk akarnak akarni tudok tudsz tud tudunk tudnak tudni tudom tudod lehet kell kellene szeretnék
    csinálok csinálsz csinál csinálni mondok mondasz mond mondani mondd adj adni látok látsz lát látni nézd nézz hallok hallasz hallgass gondolok gondolsz gondol gondolni
    értem érted érteni szükségem szükséged segíts segítség keresek keresni találni vegyél venni eladni fizetni kerül
    várj várni maradj maradni állj
    megölni halott élő élet pénz óra perc pillanat dolog dolgok emberek ember férfi nő barát haver fiú lány gyerek
    autó motor utca város negyed ház bolt piac fegyver pisztoly
    probléma kérdés válasz történet ötlet terv munka főnök vásárló
    legközelebbi hol-van mennyi-idő még-van értem-ezt nem-értem ezt azt segítséget`,

  tr: `ve veya ama fakat çünkü ki eğer ise da de mi mı mu mü ne nasıl nerede nereye nereden neden niçin kim kime kimi hangi kaç
    bir bu şu o ben sen biz siz onlar beni seni onu bizi sizi onları bana sana ona bize size onlara benim senin onun bizim sizin onların
    değil evet hayır yok var hiç hiçbir asla artık henüz hâlâ bile çok az daha en pek biraz şimdi bugün dün yarın akşam gece gün zaman burada orada
    için ile gibi kadar göre karşı sonra önce üzerinde altında arasında
    iyi kötü daha-iyi güzel çirkin büyük küçük yeni eski genç hızlı yavaş kolay zor doğru yanlış yorgun hazır
    merhaba selam hoşça-kal güle-güle teşekkürler teşekkür sağ-ol lütfen özür affedersin tabii tabi belki gerçekten aslında dostum kardeşim abi
    gidiyorum gidiyorsun gidiyor gidiyoruz gidiyorlar gitmek gel geliyorum geliyorsun geliyor gelmek gidelim
    istiyorum istiyorsun istiyor istemek yapabilirim yapabilirsin yapabilir bilmiyorum biliyorum biliyorsun biliyor bilmek zorundayım lazım gerek
    yapıyorum yapıyorsun yapıyor yapmak söyle söylemek ver vermek görüyorum görüyorsun görmek bak bakmak dinle dinlemek düşünüyorum düşünmek anlıyorum anlamıyorum anlamak
    ihtiyacım yardım yardım-et arıyorum aramak bulmak al almak satmak ödemek
    bekle beklemek dur durmak kal kalmak
    öldürmek ölü canlı hayat para saat dakika an şey şeyler insanlar adam kadın arkadaş çocuk
    araba motor sokak şehir mahalle ev dükkan pazar silah tabanca
    sorun soru cevap hikaye fikir plan iş patron müşteri
    ne-kadar kaldı anlamıyorum bunu şunu tehlikeli gerçekten-çok yakın en-yakın istasyon bu-şehir
    nasılsın nasılsınız görüşürüz`,

  sv: `och eller men för att att om när var vart varifrån vad vem vilken vilket vilka varför hur mycket många
    är var vara varit blir blev bli ha har hade haft kan kunde ska skulle vill ville får fick måste borde
    jag du han hon vi ni de dem mig dig honom henne oss er min mitt mina din ditt dina hans hennes vår vårt våra
    inte aldrig ingen inget ingenting nej ja nu här där idag igår imorgon ikväll natt dag tid redan ännu också mycket lite mer mindre
    till från med utan på i av för under över mellan genom mot hos
    bra dålig bättre bäst fin stor liten ny gammal ung snabb långsam lätt svår sant fel trött klar
    hej hejsan hejdå tack tackar snälla förlåt ursäkta självklart kanske verkligen egentligen kompis
    går gå åker åka kommer komma kom åt
    vill-jag vill ha kan jag vet vet-inte förstår förstå förstår-inte behöver behöva hjälp hjälpa söker leta hitta ta tar köpa sälja betala kostar
    gör göra säger säga ge ger ser se titta lyssna tänker tänka tror tro
    vänta stanna stopp
    döda död levande liv pengar timme minut stund sak saker människor man kvinna vän pojke flicka barn
    bil motorcykel gata stad område hus butik marknad vapen pistol
    problem fråga svar historia idé plan jobb chef kund
    hur-länge länge till jag-förstår-inte slåss slåss-nu närmaste butik var-ligger hjälpen hur-mår-du mår
    ligger`,

  ro: `și sau dar pentru că deoarece deci să dacă când unde încotro de-unde ce cine pe-cine cui cum de-ce cât cât-de cât-timp care
    sunt ești este e suntem sunteți era a-fost fi am ai are avem aveți au avea avut
    eu tu el ea noi voi ei ele mă mine te tine îl o ne vă îi le mi-a meu mea mei mele tău ta tăi tale lui lor nostru noastră vostru voastră se își
    nu da nimic niciodată deja încă și-ea foarte puțin mult mai mai-puțin aici acolo acum azi ieri mâine seara noapte zi timp
    la în din cu fără pe sub peste între prin spre către lângă
    bun bună rău mai-bine frumos urât mare mic nou vechi tânăr repede încet ușor greu adevărat fals obosit gata
    salut bună noroc la-revedere mulțumesc mersi te-rog scuze scuză desigur poate într-adevăr frate
    merg mergi merge mergem merg-la mergeți a-merge vin vii vine venim vin-cu veniți a-veni vino
    vreau vrei vrea vrem vor a-vrea pot poți poate putem pot a-putea știu știi știe știm a-ști trebuie
    fac faci face facem a-face spun spui spune a-spune dă da-mi vezi văd vede a-vedea uită-te ascult ascultă cred crezi crede a-crede
    înțeleg nu-înțeleg înțelegi a-înțelege am-nevoie nevoie ajutor ajută-mă caut a-căuta găsesc ia a-lua cumpăr a-cumpăra vând a-vinde plătesc costă
    așteaptă a-aștepta stai oprește
    mort viu viață bani oră minut moment lucru lucruri oameni om bărbat femeie prieten băiat fată copil
    mașină motocicletă stradă oraș cartier casă magazin piață armă pistol
    problemă întrebare răspuns poveste idee plan muncă șef client
    mai-e până acolo nimic înțeleg cea-mai-apropiată stație unde-este mult-pentru ajutor ce-mai-faci
    ce-mai-faci mulțumesc-mult`,

  ca: `i o però perquè doncs que si quan on d'on què qui com per-què quant quin quina quins quines
    sóc ets és som sou són era va-ser ser estic estàs està estem esteu estan estar he has ha hem heu han haver tinc tens té tenim teniu tenen tenir hi-ha
    jo tu ell ella nosaltres vosaltres ells elles em et es ens us els li mi meu meva meus meves teu teva seu seva nostre vostre
    no sí res mai ja encara també molt poc més menys aquí allà ara avui ahir demà vespre nit dia temps
    a al als de del dels en amb sense sobre sota entre cap per
    bo bona dolent millor bonic gran petit nou vell jove ràpid lent fàcil difícil veritat fals cansat
    adéu gràcies si-us-plau perdó és-clar potser realment amic amics company
    vaig vas va anem aneu van anar vinc véns ve venim veniu vénen venir
    vull vols vol volem voleu volen voler puc pots pot podem podeu poden poder sé saps sap sabem sabeu saben saber
    faig fas fa fem feu fan fer dic dius diu diem dieu diuen dir dóna dono veig veus veu veiem veure mira escolta penso penses pensa pensar crec creus creu entenc entens entén entendre
    necessito necessites necessita ajuda ajudar ajuda'm busco buscar trobar agafa comprar vendre pagar costa
    espera esperar queda quedar atura
    morir mort viu vida diners hora minut moment cosa coses gent home dona noi noia nen
    cotxe moto carrer ciutat barri casa botiga mercat arma pistola
    problema pregunta resposta història idea pla feina cap client
    quant-falta falta encara no-ho-entenc entenc ho ho com-va tot com-va va-tot on-és botiga més-propera gràcies-per l'ajuda ajuda amic
    ç ny l·l col·legi propera
    l' d' s' m' t' n' qu'`,

  no: `og eller men for fordi at hvis når hvor hvorfor hva hvem hvilken hvilket hvilke hvordan hvor-mye mange
    er var være vært bli ble blir har hadde ha hatt kan kunne skal skulle vil ville må burde får fikk
    jeg du han hun vi dere de dem meg deg ham henne oss min mitt mine din ditt dine hans hennes vår vårt våre
    ikke aldri ingen ingenting nei ja nå her der i-dag i-går i-morgen i-kveld natt dag tid allerede ennå også mye litt mer mindre
    til fra med uten på i av under over mellom gjennom mot hos
    bra dårlig bedre best fin stor liten ny gammel ung rask sakte lett vanskelig sant feil sliten klar
    hei hallo ha-det takk takker vær-så-snill unnskyld selvfølgelig kanskje virkelig egentlig kompis
    går gå drar dra kjører kjøre kommer komme kom
    vil-jeg vil ha vet vet-ikke forstår forstå forstår-ikke trenger trenge hjelp hjelpe leter lete finne ta tar kjøpe selge betale koster
    gjør gjøre sier si gi gir ser se titte lytte tenker tenke tror tro
    vent vente stopp bli
    drepe død levende liv penger time minutt øyeblikk ting folk mann kvinne venn gutt jente barn
    bil motorsykkel gate by område hus butikk marked våpen pistol
    problem spørsmål svar historie idé plan jobb sjef kunde
    hvor-lenge lenge hvor-er nærmeste butikk hjelpen hvordan-har-du-det det hvordan-går-det
    nærmeste ø å æ`,

  vi: `và hoặc nhưng vì nếu khi ở đâu tại sao gì ai nào như thế nào bao nhiêu bao lâu
    là có không được đã đang sẽ rất cũng vẫn còn chưa đừng hãy
    tôi tao mình bạn anh chị em ông bà cậu mày nó chúng ta chúng tôi họ của cho với từ đến trong ngoài trên dưới sau trước giữa
    này kia đó đây ấy nữa lắm quá hơn nhất tất cả mọi nhiều ít một hai ba
    tốt xấu đẹp lớn nhỏ mới cũ nhanh chậm dễ khó đúng sai mệt sẵn sàng
    xin chào tạm biệt cảm ơn xin lỗi làm ơn tất nhiên có lẽ thật sự bạn-bè
    đi đến về ra vào lên xuống chạy dừng đợi chờ
    muốn cần có-thể biết hiểu nghĩ nói nghe thấy nhìn xem làm giúp tìm lấy mua bán trả
    hôm nay ngày mai hôm qua tối đêm sáng giờ phút lúc
    người đàn ông phụ nữ bạn con trai con gái trẻ em xe ô tô xe máy đường phố thành phố nhà cửa hàng chợ súng
    vấn đề câu hỏi trả lời câu chuyện ý tưởng kế hoạch công việc sếp khách
    còn bao lâu nữa cửa hàng gần nhất ở đâu vậy thế nào hôm nay thế nào chào`,

  // Cyrillic: Russian and Ukrainian share a script, so these two lists only ever decide between each other (apostrophes are dropped).
  ru: `что как это ты мне тебе спасибо пожалуйста привет хорошо друг помощь помочь да нет где когда почему они мы вы он она оно здесь тут там сейчас потом уже еще ещё очень сколько ехать
    меня тебя его её их нас вас ему ей им нам вам мой моя мое мои твой твоя свой себя себе кто чем чего кого кому зачем куда откуда потому чтобы если но или и а то же ли бы не ни
    быть есть был была было были будет буду будешь можно нужно надо должен хочу хочешь хочет хотим могу можешь может знаю знаешь знает понимаю понимаешь понял поняла думаю думаешь
    идти иду идёшь идем идём пойдем пойдём поехали ехать еду едем стой стоп подожди подождите жди давай давайте смотри слушай скажи говори дай возьми взять купить продать цена дорого дешево
    деньги время час часа минута секунда день ночь утро вечер завтра вчера сегодня сегодняшний человек люди мужчина женщина мальчик девочка ребенок машина дорога город улица район дом магазин рынок
    оружие пистолет работа босс клиент проблема вопрос ответ история идея план назад вперед вперёд вверх вниз выше ниже слева справа рядом далеко близко быстро медленно осторожно
    отмена отменить выбери выберите выбрать голос разговор разговоры выключено включено выключить включить настройки закрыть открыть сохранить удалить забыть память персонаж каталог группа
    телефон чат контакт недоступен недоступна недоступно приглашение режим разработчика высота взгляд текущая шаги короткий длинный образец всех все всё всего каждый другой другая только
    хороший плохой лучше хуже большой маленький новый старый правда конечно может быть наверное просто тоже тоже уже ещё пока потом снова опять никогда всегда иногда вместе один одна два три
    спасибо-за помощью братан брат сестра мама папа привет-как дела отлично плохо устал усталa готов готова рад рада извини прости пожалуйста-помоги`,
  uk: `що як це ти мені тобі дякую будь ласка привіт добре друг друже допомога допомогу допомогти так ні де коли чому вони ми ви він вона воно тут там зараз потім вже ще дуже скільки їхати їдемо
    мене тебе його її їх нас вас йому їй їм нам вам мій моя моє мої твій твоя свій себе собі хто чим чого кого кому навіщо куди звідки тому щоб якщо але або і й а то ж чи б не ні
    бути є був була було були буде буду будеш можна треба потрібно мушу хочу хочеш хоче хочемо можу можеш може знаю знаєш знає розумію розумієш зрозумів зрозуміла думаю думаєш
    йти іду йдеш йдемо ходімо поїхали їхати їду стій стоп зачекай зачекайте чекай давай давайте дивись слухай скажи кажи дай візьми взяти купити продати ціна дорого дешево
    гроші час година години хвилина секунда день ніч ранок вечір завтра вчора сьогодні сьогоднішній людина люди чоловік жінка хлопець дівчина дитина машина дорога місто вулиця район дім будинок магазин ринок
    зброя пістолет робота бос клієнт проблема питання відповідь історія ідея план назад вперед вгору вниз вище нижче ліворуч праворуч поруч далеко близько швидко повільно обережно
    скасувати скасування вибери виберіть вибрати голос розмова розмови вимкнено увімкнено вимкнути увімкнути налаштування закрити відкрити зберегти видалити забути пам'ять персонаж каталог група
    телефон чат контакт недоступний недоступна недоступно запрошення режим розробника висота погляд поточна кроки короткий довгий зразок всіх всі все всього кожен інший інша тільки лише
    хороший поганий краще гірше великий маленький новий старий правда звичайно можливо напевно просто теж також вже ще поки потім знову знову ніколи завжди іноді разом один одна два три спершу
    дякую-за допомогою брат сестра мама тато привіт-як справи чудово погано втомився втомилась готовий готова радий рада вибач пробач будь-ласка допоможи служба служби журнали
    над перегляд закрий закрийте телефон продовжити щоб компаньйон недоступний вимкнено розмовляти поговорити персонажа персонажем`,
};

// Words that are no evidence for any language: names of the game's people and places, street slang, interjections, and the
// Spanish and Japanese nicknames the characters use inside English sentences. They never count as a word of any list.
export const NEUTRAL = new Set(`v jackie jack welles judy alvarez panam palmer vik viktor vektor johnny silverhand kerry eurodyne river ward rogue misty olszewski
  goro takemura saburo arasaka militech kang tao biotechnica trauma team maelstrom valentinos tyger claws animals voodoo boys mox aldecaldos scavs 6th street
  delamain afterlife night city watson westbrook heywood pacifica santo domingo badlands dogtown kabuki japantown jig-jig
  choom choombas preem nova gonk gonks eddies eddie cred creds chrome chromed ripperdoc ripper netrunner netrunners braindance bd bds cyberpsycho cyberpsychos
  corpo corpos fixer fixers merc mercs gig gigs flatline flatlined samurai edgerunner edgerunners cyberware delta wraith
  ok okay okey hm hmm hmmm mm mhm uh uhh um umm ah aah oh ooh eh ehh huh haha hahaha hehe lol lmao rofl xd brb thx thanks ty np eta wtf omg yo sup
  hermano hermana chica chico amigo amiga vato vata pendejo carnal compa cabrón cabron mijo mija jefe patrón patron ese cuate loco loca
  sayonara arigato arigatou konnichiwa sensei senpai baka sugoi
  bro dude`.split(/\s+/));
