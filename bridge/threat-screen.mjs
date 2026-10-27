// What V's words are, for an ordinary NPC's threat and command reactions (docs/NPC_THREATS_COMMANDS.md). Pure, no I/O, a few dozen regular
// expressions over one message: it runs once per turn of a person the game offered the threat reactions to, never otherwise.
//
// The screen never starts anything by itself. With the game's plan in the offer (mod/npc-reactions.lua M.plan, the owner's rule of 2026-10-26)
// a clear reading here IS the decision: the game's pick for that reading is the reaction, and the model is only told what the person does
// (bridge/companion-actions.mjs planReaction). Without a plan, or for words it does not read, it only decides which of the game's offered reactions
// the reply may choose from (`screenedKinds`): a calm line never offers a fight, whatever the model writes.
//
//   threat   'kill'    a death threat: "I'll kill you", "you're dead", a gun to the head, "your money or your life"   -> a fighter may draw a weapon
//            'hurt'    a threat to hurt or a challenge: "I'll break your legs", "fight me"                             -> a fighter uses fists
//            'insult'  an insult at the person: "you piece of shit", "fuck you"                                        -> a fighter uses fists
//   command  'get-down' ("get down", "hands up"), 'stop' ("freeze", "don't move"), 'exit-vehicle' ("get out of the car")
//   why      a refusal that removed what matched: 'joke' (lol, "just kidding"), 'quote' (the words are inside quotation marks),
//            'question' ("would you kill for money?", "should I shoot you?"), 'negated' ("I won't hurt you")
//
// Languages: English and the 15 menu languages (cs, de, es, fr, hu, it, ja, ko, pl, pt-br, ru, tr, uk, zh-cn, zh-tw), all at once (the screen
// does not need to know which one V types in; a player types English in a Russian menu as often as not). The forms are the first person and the
// imperative ("убью", "je vais te tuer", "ti ammazzo"), so "he said he would kill you" is not a threat. Short words that mean something else in
// another language ("halt", "para", "alto", "dur", "giù") count only as a whole sentence.

const LETTER = '[\\p{L}\\p{N}]';
// A German word that is not a negation: "ich werde dich nicht umbringen" is no threat.
const DE_WORD = '(?!(?:nicht|nie|niemals|kein\\p{L}*)(?!\\p{L}))\\p{L}+';
// A word, in the scripts that write spaces between words. CJK patterns are matched as they are.
const word = alternatives => `(?<!${LETTER})(?:${alternatives})(?!${LETTER})`;

// One language: patterns per kind (strings, joined into one expression each), `whole` ones that count only as a whole sentence, the joke
// markers, the negation words looked for just before a match (and after it, for the languages that put it after the verb).
const LANGUAGES = [
  {
    name: 'en',
    kill: [
      // A first-person threat is found with the subject check below (the nearest subject before the verb is "I" or "we").
      // "in" is no threat ("I'll end you in chess") unless a body part follows it ("I'll shoot you in the head", the live test of 2026-10-26).
      // zero and geek are the city's own words for killing someone.
      '(?:kill|murder|shoot|stab|gut|waste|ice|flatline|zero|geek|smoke|plug|execute|whack|bury|strangle|slaughter|butcher|end|cap|gun down|finish)\\s+(?:you|ya|u|y\'all|yourself)(?!\\s+(?:a|an|some|over|up|out|a line|a text|a message|in(?!\\s+(?:the|your|ya|ur)\\s+(?:\\p{L}+\\s+)?(?:head|skull|brains?|face|heart|chest|gut|stomach|belly|back|neck|throat|eyes?|temple|mouth|dome|spine)))\\b)',
      '(?:kill|murder|shoot|stab)\\s+your\\s+(?:\\p{L}+\\s+)?(?:family|kids|wife|husband|mother|mom|dad|ass|face|head)',
      '(?:slit|cut|slash)\\s+your\\s+(?:\\p{L}+\\s+)?throat', '(?:break|snap|wring)\\s+your\\s+(?:\\p{L}+\\s+)?neck',
      'blow\\s+your\\s+(?:\\p{L}+\\s+)?(?:head|brains|face|skull)\\s+(?:off|out|in)', '(?:blow|blast)\\s+(?:you|ya)\\s+away',
      // "I'll put you in the ground", "I'll put you six feet under", "I'll have you killed".
      '(?:put|send|lay)\\s+(?:you|ya)\\s+(?:(?:in|into|under)\\s+the\\s+(?:ground|dirt)|six\\s+feet\\s+under|(?:in|into|to)\\s+(?:a|the|an early|your)\\s+(?:grave|coffin|box|body bag|morgue|dumpster))',
      'have\\s+(?:you|ya)\\s+(?:killed|whacked|iced|flatlined|zeroed|shot|offed|taken out)',
    ],
    killFree: [
      'you(?:\'re| are)\\s+(?:so\\s+|fucking\\s+|already\\s+)?(?:dead|a dead (?:man|woman|person)|dead meat|done for|finished)(?!\\s+(?:to me|tired|serious|wrong|right|on|inside))',
      'you(?:\'re| are)\\s+(?:gonna|going to)\\s+die', 'you(?:\'ll| will)\\s+die', '(?:^|[,!]\\s*)(?:now\\s+|just\\s+|go\\s+)?(?:die|drop dead)(?:\\s+already)?\\s*[!.]*$',
      // "I'll put a bullet in your head", "put a round through your skull", "a hole in you", "one between your eyes".
      '(?:put|pump|stick|lodge|plant|shove)\\s+(?:a|one|some|two|three|a couple of|a few|\\d+)?\\s*(?:bullets?|rounds?|slugs?|lead|knife|knives|blades?|holes?|caps?)\\s+(?:in|into|inside|through|between)\\s+(?:you|your|ya|ur)',
      '(?:put|pump)\\s+(?:one|two|three|a couple|a few|\\d+)\\s+(?:in|into|through|between)\\s+(?:your|ya|ur)\\s+(?:\\p{L}+\\s+)?(?:head|skull|brains?|face|chest|heart|gut|back|neck|eyes|temple|mouth|dome)',
      '(?:you|ya)(?:\'ll|\\s+will|\'re\\s+gonna|\\s+are\\s+gonna|\'re\\s+going\\s+to|\\s+are\\s+going\\s+to)\\s+(?:be\\s+|end\\s+up\\s+)?six\\s+feet\\s+under',
      'consider\\s+yourself\\s+(?:dead|a dead (?:man|woman))', '(?:you\'re|youre|you are)\\s+as\\s+good\\s+as\\s+dead', 'dead\\s+(?:man|woman)\\s+walking',
      '(?:you|ya)\\s+(?:won\'t|will not|ain\'t gonna|are not gonna|aren\'t gonna)\\s+(?:live|be living|leave here alive|walk out of here alive|make it out(?: of here)? alive|see (?:tomorrow|the morning|another day))',
      'not\\s+(?:leaving|getting out of|walking out of)\\s+(?:here|this place|this room)\\s+alive',
      'your money or your life', 'say your prayers', 'any last words', 'say goodbye to your (?:life|ass|head|family)',
      // "Get lost or I'll shoot", "move before I blast": the threat is the condition, no object needed (live test 3, 2026-10-27).
      '(?:or|before|else|otherwise)\\s+(?:i\'ll|i will|i\'m gonna|im gonna|i\'m going to|im going to|imma|ima|we\'ll|we will|i|we)\\s+(?:shoot|blast|waste|kill|ice|flatline|smoke|zero|geek|end|cap|stab|gut)(?!\\s+(?:it|this|that|the|a|an|him|her|them|myself)\\b)',
    ],
    hurt: [
      '(?:hurt|beat|punch|smack|slap|kick|bash|wreck|deck|clock|sock|pound|thrash|batter|pummel|cripple|maim|whoop|whup|kneecap|headbutt|slice|cut)\\s+(?:you|ya|u)(?!\\s+(?:up on|at|in|to|with|off|a deal|some slack|a break|in on|back|loose|free)\\b)(?:\\s+up)?',
      'hit\\s+(?:you|ya|u)(?!\\s+(?:up|back|with|at|on|off)\\b)', 'knock\\s+(?:you|ya|u)\\s+(?:out|down|flat)', '(?:fuck|mess|rough)\\s+(?:you|ya|u)\\s+up',
      '(?:break|smash|bust|kick|wreck|rearrange|punch|slap|crack|beat)\\s+your\\s+(?:\\p{L}+\\s+)?(?:legs?|arms?|face|jaw|nose|teeth|skull|head|neck|bones|ribs|knees|ass|kneecaps|fingers)',
      'beat\\s+the\\s+(?:shit|crap|hell|living daylights|piss)\\s+out\\s+of\\s+you', 'kick\\s+the\\s+(?:shit|crap)\\s+out\\s+of\\s+you',
      'knock\\s+your\\s+(?:\\p{L}+\\s+)?(?:teeth|lights|block|head)', 'teach\\s+you\\s+a\\s+lesson', 'make\\s+you\\s+(?:pay|bleed|suffer|regret)',
    ],
    hurtFree: ['fight me', 'let\'s fight', 'come at me', 'square up', 'step outside', 'let\'s take this outside', 'put (?:your|\'em) (?:hands|dukes|fists) up', 'you want a beating', 'you\'re asking for a beating',
      // Provocations (a dare to fight) and a robbery (2026-10-27): a fighter takes them as a challenge, everyone else as a threat.
      'you (?:don\'t|dont|do not) scare me', '(?:i\'m|im|i am) not (?:scared|afraid) of (?:you|ya|u)', 'bring it on', '^(?:come on[\\s,]+)?bring it\\s*[!.]*$', '^(?:come on[\\s,]+)?try me\\s*[!.]*$', '^make me\\s*[!.]*$',
      'what (?:are )?(?:you|ya) (?:gonna|going to) do about it(?=\\s*[!.]*$)', 'i dare (?:you|ya)', 'come and get (?:it|some|me)',
      '(?:hand over|give me|gimme|give us|hand me|empty|cough up)\\s+(?:all\\s+)?(?:your|ya|ur)\\s+(?:\\p{L}+\\s+)?(?:eddies|eurodollars|eurodollar|money|cash|wallet|creds|chips|valuables|shit|stuff)'],
    insult: [
      '(?:you\'re|youre|you|ya|u|ur)(?:\\s+(?:are|re|r|such|a|an|so|fucking|fuckin|stupid|dumb|little|filthy|worthless|pathetic|ugly|fat|lying|piece of|sack of|big|cheap|old|damn|goddamn|bloody|sorry|motherfucking|dirty|lousy|weak|bunch of|bunch a)){0,4}\\s+(?:pussies|nobodies|pussy|wimp|nobody|chump|weakling|idiot|moron|imbecile|cretin|retard|bitch|bastard|asshole|arsehole|dickhead|dick|prick|cunt|twat|wanker|loser|scum|scumbag|pig|rat|worm|clown|freak|whore|slut|skank|dumbass|jackass|motherfucker|fucker|shithead|coward|punk|gonk|maggot|swine|filth|jerk|piece of shit|sack of shit)s?',
      '(?:you\'re|youre|you are|ur|u r)\\s+(?:so\\s+|such\\s+an?\\s+|really\\s+|fucking\\s+|just\\s+|all\\s+)?(?:stupid|dumb|pathetic|worthless|disgusting|ugly|useless|a joke|weak|soft|nothing|spineless|gutless|trash|garbage|a disgrace|chicken|a nobody|nobodies)(?!\\s+(?:like|but|without|compared|spoken|hearted|on|to me|special|new)\\b)',
      // A gang or crew insulted as a whole (V talking to a ganger, 2026-10-27): "your gang is trash", "Tyger Claws are a bunch of pussies".
      '(?:your|ya|ur)\\s+(?:whole\\s+)?(?:gang|crew|boss|boys|people|choombas?|family)\\s+(?:is|are|\'s|\'re)\\s+(?:(?:a bunch of|all|just|nothing but|such|so|fucking)\\s+){0,2}(?:trash|garbage|scum|shit|weak|pathetic|a joke|nothing|pussies|cowards|bitches|losers|worthless|gonks|rats|pigs|clowns|wimps|idiots|morons)',
      '(?:tyger claws|tygers|maelstrom|maelstromers|valentinos|6th street|sixth street|animals|voodoo boys|mox|moxes|scavs|scavengers|wraiths|barghest|ncpd|cops|you guys|you people|y\'all|all of you)\\s+(?:are|r|\'re)\\s+(?:(?:a bunch of|all|just|nothing but|such|so|fucking)\\s+){0,2}(?:trash|garbage|scum|shit|weak|pathetic|a joke|nothing|pussies|cowards|bitches|losers|worthless|gonks|rats|pigs|clowns|wimps|idiots|morons)',
      'fuck (?:the |your |all )?(?:tyger claws|tygers|maelstrom|valentinos|6th street|sixth street|animals|voodoo boys|mox|scavs|wraiths|barghest|gang|crew|boss)',
      // A whole sentence of one name: "Pussy!", "coward."
      '^(?:(?:you|ya|what a|such a|fucking|little|a|you little|you fucking)\\s+){0,2}(?:pussy|pussies|coward|cowards|wimp|wimps|chump|weakling)\\s*[!.]*$',
    ],
    insultFree: ['fuck (?:you|off|yourself)', 'screw you', 'go (?:fuck|screw) yourself', 'go to hell', 'son of a bitch', 'eat shit', 'piece of (?:shit|crap|garbage|trash)', 'motherfucker', 'cocksucker', 'your (?:mother|mom|mama)(?:\\s+\\p{L}+){0,3}\\s+(?:whore|slut|bitch)'],
    // Commands begin a clause (after "hey, you," and the like): "I told you to get down" is not one.
    'get-down': [
      '(?:get|go|stay|lie|lay|drop|hit the|everybody|everyone)\\s+(?:down|deck|flat|on the (?:ground|floor|deck)|to the (?:ground|floor))',
      'down on the (?:ground|floor)', 'on the (?:ground|floor)', 'face down', 'hands up', 'hands in the air', 'hands where i can see them', 'hands on your head',
      '(?:get )?on your knees', 'duck', 'take cover', 'hit the deck',
    ],
    stop: [
      'stop(?:\\s+(?:right\\s+)?(?:there|here|moving|walking|running|where you are))?(?!\\s+(?:it|that|this|talking|being|lying|me|him|her|them|the|doing|saying|whining|crying|\\p{L}+ing)\\b)',
      'freeze', 'halt', 'hold it(?:\\s+right\\s+there)?', 'stay (?:right )?(?:there|where you are|put)', 'stand still', '(?:don\'t|dont|do not) (?:you )?(?:move|take another step|fucking move)', 'not another step', 'nobody move',
    ],
    'exit-vehicle': [
      '(?:get|step|climb|hop|jump)\\s+out(?:\\s+of\\s+(?:the|your|this|that)\\s+(?:car|vehicle|truck|van|cab|ride|wheels|seat|motorcycle|bike))?(?!\\s+(?:of|here|my|now and|alive)\\b)',
      'out of the (?:car|vehicle|truck|van)', 'exit the vehicle', 'out of your (?:car|vehicle)',
    ],
    joke: ['lol', 'lmao', 'lmfao', 'rofl', 'ha(?:ha)+', 'he(?:he)+', 'jk', 'j/k', 'just kidding', 'kidding', 'joking', 'just a joke', 'as a joke', ':p', ':d', 'xd'],
    negation: 'not|never|no one|nobody|won\'t|wouldn\'t|don\'t|didn\'t|ain\'t|can\'t|cannot|isn\'t|wasn\'t|shouldn\'t|couldn\'t|no way i|wont|dont',
    // English requires a first-person subject before a threat verb: the nearest subject word decides.
    subject: true,
    polite: '(?:can|could|would|will)\\s+you\\s+(?:please\\s+)?',
    fillers: '(?:hey|yo|oi|now|ok|okay|alright|listen|look|please|right|just|you|you two|everybody|everyone|all of you|buddy|pal|man|lady|sir|ma\'am|choom|gonk|mister|miss|police|ncpd)',
  },
  {
    name: 'de',
    killFree: [
      `(?:ich|wir)\\s+(?:${DE_WORD}\\s+){0,3}?(?:bring|bringe|bringen)\\s+(?:dich|euch)\\s+um`, `(?:ich|wir)\\s+(?:${DE_WORD}\\s+){0,2}?(?:dich|euch)\\s+(?:${DE_WORD}\\s+)?(?:umbringen|töten|abknallen|erschießen|erschiessen|abstechen|kaltmachen|umlegen|abmurksen)`,
      `(?:ich\\s+)?(?:knall|knalle|steche|leg|lege|mach|mache)\\s+(?:dich|euch)\\s+(?:${DE_WORD}\\s+)?(?:ab|um|kalt|nieder|tot)`, '(?:ich\\s+)?(?:töte|erschieße|erschiesse) (?:dich|euch)',
      'du bist (?:so\\s+)?(?:tot|ein toter mann|eine tote frau|erledigt|geliefert)(?!\\s+(?:müde|für mich))',
      'stirb', 'verrecke', 'geld oder leben', 'kugel (?:in|durch) (?:den|deinen) (?:kopf|schädel)',
      // Lethal phrasings (2026-10-26): a bullet in the head, brains blown out, "as good as dead", under the ground, finished off.
      'kugel zwischen (?:die|deine) augen', '(?:puste|blas|blase|knall|knalle|schieß|schiess|schieße) dir (?:das|dein) (?:hirn|gehirn) (?:weg|raus)', '(?:jag|jage) dir eine kugel',
      'du bist so gut wie tot', '(?:ich|wir)\\s+(?:\\p{L}+\\s+){0,2}?(?:bring|bringe|bringen) (?:dich|euch) unter die erde', 'sechs fuß unter (?:der|die) erde',
      '(?:ich\\s+)?(?:mach|mache) (?:dich|euch) (?:alle|platt)', 'dein letzter tag auf (?:erden|dieser welt)',
    ],
    hurtFree: [
      `(?:ich|wir)\\s+(?:${DE_WORD}\\s+){0,3}?(?:dich|euch)\\s+(?:${DE_WORD}\\s+){0,2}?(?:verprügeln|verhauen|zusammenschlagen|schlagen)`, '(?:ich|wir)\\s+(?:verprügel\\p{L}*|verhau\\p{L}*|schlag\\p{L}*|box\\p{L}*|tret\\p{L}*)\\s+(?:dich|euch)',
      '(?:ich|wir)\\s+(?:hau\\p{L}*|polier\\p{L}*|brech\\p{L}*)\\s+(?:dir|euch)', 'fresse polieren', 'in die fresse', 'aufs maul', 'eine (?:rein)?(?:hauen|knallen|scheuern)', 'lass uns das draußen klären',
    ],
    insultFree: [
      'du\\s+(?:\\p{L}+\\s+){0,2}?(?:idiot|arschloch|wichser|hurensohn|schwein|penner|bastard|vollidiot|depp|trottel|missgeburt|schlampe|hure|fotze|spast|opfer|vollpfosten|pisser|lappen|mistkerl|scheißkerl)',
      'hurensohn', 'arschloch', 'fick dich', 'leck mich', 'scheißkerl', 'du bist (?:so\\s+)?(?:dumm|blöd|hässlich|erbärmlich|ein witz)',
    ],
    'get-down': ['runter(?: mit dir)?', 'auf den boden', 'hinlegen', 'leg dich hin', 'legen sie sich hin', 'ducken', 'duck dich', 'hände hoch', 'auf die knie', 'flach hinlegen'],
    stop: ['stopp', 'stehen bleiben', 'bleib stehen', 'bleiben sie stehen', 'keine bewegung', 'beweg dich nicht', 'rühr dich nicht', 'keinen schritt weiter'],
    'exit-vehicle': ['steig aus', 'aussteigen', 'steigen sie aus', 'raus aus dem (?:auto|wagen|fahrzeug)', 'raus aus der karre'],
    whole: {stop: ['halt', 'stop'], 'exit-vehicle': ['raus']},
    joke: ['nur spaß', 'nur ein witz', 'war nur ein witz', 'war ein witz', 'kleiner scherz', 'nur ein scherz', 'scherz', 'spaß'],
    negation: 'nicht|nie|niemals|kein|keine|keinen|niemand',
  },
  {
    name: 'fr',
    killFree: [
      'je (?:vais|veux|devrais|pourrais) te (?:tuer|buter|descendre|crever|flinguer|massacrer|égorger|refroidir|planter|trouer|fumer)', 'je te (?:tue|bute|descends|crève|flingue|massacre|égorge|plante|troue)',
      'je vais t\'(?:abattre|égorger|exécuter|éliminer)', 'je t\'(?:abats|égorge|exécute|élimine)', 't\'es (?:un homme )?mort', 'tu es (?:un homme )?mort', 'crève', 'la bourse ou la vie', 'une balle dans (?:la|ta) (?:tête|gueule)',
      'une balle (?:dans le crâne|entre (?:les|tes) yeux)', '(?:je vais )?te (?:faire )?(?:sauter|exploser) (?:la cervelle|le crâne|la tête|le caisson)', '(?:t\'es|tu es) (?:déjà|deja) mort',
      'six pieds sous terre', 'je (?:vais )?t\'enterrer', 'je t\'enterre', 'je (?:vais )?te (?:mettre|foutre) (?:sous terre|en terre|dans le trou)', 'je (?:vais )?te faire la peau', 'je te fais la peau',
      'je (?:vais )?en finir avec toi',
    ],
    hurtFree: [
      'je (?:vais |veux )?te (?:frapper|cogner|défoncer|tabasser|démolir|péter|casser|exploser|frappe|cogne|défonce|tabasse|démolis|pète|casse|explose|massacrer|éclater)', 'je vais t\'(?:éclater|allonger|exploser)',
      'casser la gueule', 'péter la gueule', 'mon poing dans (?:ta|la) gueule', 'on règle ça dehors', 'viens te battre',
    ],
    insultFree: ['connard', 'connasse', 'salope', 'salaud', 'enculé', 'fils de pute', 'abruti', 'crétin', 'imbécile', 'débile', 'bâtard', 'batard', 'ordure', 'raclure', 'sale (?:merde|rat|chien|con)', 'va te faire (?:foutre|enculer)', 'nique ta mère', 'ta mère la pute', 'espèce d[e\']\\s*\\p{L}+', 't\'es (?:qu\'un|un|une) (?:con|conne|merde|minable|nul)'],
    'get-down': ['à terre', 'couche-toi', 'couchez-vous', 'par terre', 'baisse-toi', 'baissez-vous', 'les mains en l\'air', 'haut les mains', 'à genoux', 'mains sur la tête'],
    stop: ['arrête-toi', 'arrêtez-vous', 'halte', 'bouge pas', 'ne bouge pas', 'bougez pas', 'ne bougez pas', 'plus un geste', 'reste là', 'restez là', 'pas un pas de plus'],
    'exit-vehicle': ['(?:sors|sortez|descends|descendez) (?:de la|du) (?:voiture|caisse|bagnole|véhicule)', 'hors de la voiture'],
    whole: {stop: ['stop', 'arrêtez'], 'exit-vehicle': ['dehors', 'descends', 'sors']},
    joke: ['je rigole', 'je plaisante', 'c\'est une blague', 'c\'était une blague', 'je déconne', 'mdr', 'ptdr', 'blague'],
    negation: 'ne|n\'|jamais|personne|pas',
    after: 'pas|jamais',
  },
  {
    name: 'es',
    killFree: [
      'te (?:voy|vamos) a (?:matar|reventar|liquidar|despachar|dar un tiro|pegar un tiro|volar la cabeza|disparar|cargar)', 'voy a matarte', 'te (?:mato|mataré|matare|liquido|pego un tiro|vuelo la cabeza)',
      '(?:estás|estas|eres) (?:muerto|muerta|hombre muerto|mujer muerta|fiambre)(?!\\s+de)', 'muérete', 'muerete', 'la bolsa o la vida', 'una bala en (?:la|tu) (?:cabeza|frente)',
      'una bala entre (?:los|tus) ojos', '(?:te (?:voy|vamos) a |voy a )?(?:volar|reventar)(?:te)? los sesos', 'te vuelo los sesos', 'volarte (?:los sesos|la cabeza)',
      'te (?:meto|voy a meter) (?:un tiro|una bala|plomo)', '(?:a )?(?:tres|siete) metros bajo tierra', 'te (?:voy a enterrar|entierro|enterraré|enterrare)', '(?:voy a acabar|acabaré|acabare) contigo',
    ],
    hurtFree: [
      'te (?:voy|vamos) a (?:pegar|golpear|partir|romper|dar una paliza|dar una golpiza|madrear|reventar la cara|partir la cara|partir la madre|romper la cara|dar de hostias|dar una hostia)',
      'te (?:parto|rompo|reviento|madreo|meto una (?:hostia|piña|trompada|madriza))', 'voy a (?:romperte|partirte|golpearte|pegarte)', 'vamos afuera', 'pelea conmigo',
    ],
    insultFree: [
      '(?:eres|sos) (?:un |una |tan )?(?:idiota|imbécil|imbecil|pendejo|pendeja|cabrón|cabron|gilipollas|estúpido|estupido|estúpida|mierda|basura|puta|perra|inútil|inutil|tarado|subnormal|marica|maricón|malparido|pelotudo|boludo|gonorrea)',
      'hijo de (?:puta|perra)', 'hijueputa', 'vete a la mierda', 'chinga tu madre', 'que te jodan', 'pendejo', 'cabrón', 'gilipollas', 'malparido', 'pelotudo',
    ],
    'get-down': ['al suelo', 'agáchate', 'agachate', 'agáchense', 'tírate al suelo', 'tirate al suelo', 'manos arriba', 'pecho a tierra', 'cuerpo a tierra', 'de rodillas'],
    stop: ['alto ahí', 'alto ahi', 'detente', 'deténgase', 'detengase', 'quieto', 'quieta', 'no te muevas', 'no se mueva', 'quédate quieto', 'quedate quieto'],
    'exit-vehicle': ['(?:sal|salga|bájate|bajate|bájese|bajese|baja) del (?:coche|carro|auto|vehículo|vehiculo)', 'fuera del (?:coche|carro|auto)', 'bájate', 'bajate'],
    whole: {stop: ['alto', 'para'], 'get-down': ['abajo'], 'exit-vehicle': ['fuera', 'sal']},
    joke: ['es broma', 'es una broma', 'era broma', 'de broma', 'bromeando', 'ja(?:ja)+', 'je(?:je)+', 'jsjs'],
    negation: 'no|nunca|jamás|jamas|nadie|ni',
  },
  {
    name: 'pt',
    killFree: [
      'vou te (?:matar|apagar|furar|meter bala|encher de bala|dar um tiro|estourar os miolos)', 'vou matar (?:você|voce|vc|tu)', 'te (?:mato|apago)', '(?:você|voce|vc|tu) (?:está|esta|tá|ta) mort[oa]',
      '(?:você|voce|vc) é um homem morto', 'morre', 'morra', 'a bolsa ou a vida', 'uma bala na (?:sua|tua) (?:cabeça|cara)',
      'uma bala (?:na cabeça|na testa|entre (?:os|seus|teus) olhos)', 'estourar (?:seus|teus|os) miolos', 'vou te enterrar', '(?:a )?sete palmos (?:debaixo|abaixo) da terra', 'vou te (?:colocar|botar|pôr|por) debaixo da terra',
      'vou acabar (?:com (?:você|voce|vc)|contigo)', '(?:você|voce|vc) (?:já|ja) (?:era|está morto|esta morto)',
    ],
    hurtFree: ['vou te (?:bater|socar|espancar|quebrar|encher de porrada|dar uma surra|dar porrada|arrebentar|dar um soco)', 'te (?:quebro|arrebento)', 'vou quebrar (?:sua|tua) cara', 'vamos resolver lá fora', 'vem pro pau'],
    insultFree: [
      '(?:seu|sua) (?:\\p{L}+ )?(?:idiota|imbecil|otári[oa]|babaca|desgraçad[oa]|filho da puta|merda|vagabund[oa]|arrombad[oa]|puta|cuzão|lixo|corno|burr[oa]|retardad[oa]|nojent[oa]|verme|escrot[oa])',
      'filho da puta', 'fdp', 'vai se foder', 'vai tomar no cu', 'vai à merda', 'vai a merda', 'vai pro inferno',
    ],
    'get-down': ['no chão', 'no chao', 'deita no chão', 'deita no chao', 'abaixa', 'abaixe-se', 'se abaixa', 'mãos ao alto', 'maos ao alto', 'mãos para cima', 'mão na cabeça', 'de joelhos'],
    stop: ['pare', 'parado', 'parada', 'não se mexa', 'nao se mexa', 'fica parado', 'fique parado', 'alto lá', 'alto la'],
    'exit-vehicle': ['(?:sai|saia|desce|desça|desca) do (?:carro|veículo|veiculo|automóvel)', 'fora do carro'],
    whole: {stop: ['para'], 'exit-vehicle': ['desce', 'sai']},
    joke: ['brincadeira', 'tô brincando', 'to brincando', 'estou brincando', 'zoando', 'tô zoando', 'k{3,}', 'rsrs', 'ha(?:ha)+', 'he(?:he)+'],
    negation: 'não|nao|nunca|jamais|ninguém|ninguem|nem',
  },
  {
    name: 'it',
    killFree: [
      'ti (?:ammazzo|uccido|sparo|faccio fuori|sgozzo|ammazzerò|ammazzero|ucciderò|uccidero|farò fuori|faro fuori|stendo|faccio secco)', '(?:voglio|vado ad?) (?:ammazzarti|ucciderti)',
      'sei (?:un uomo )?mort[oa]', 'sei finit[oa]', 'muori', 'crepa', 'o la borsa o la vita', 'una pallottola in (?:testa|fronte)',
      '(?:una pallottola|un proiettile) (?:nella testa|in testa|in fronte|tra gli occhi)', 'ti (?:faccio )?saltare (?:il cervello|le cervella|la testa)', 'ti sparo in (?:testa|faccia|fronte)',
      'ti (?:seppellisco|sotterro|metto sottoterra)', 'sei (?:già|gia) mort[oa]', 'ti faccio la pelle', '(?:voglio|vado a) farti la pelle',
    ],
    hurtFree: [
      'ti (?:spacco|meno|picchio|gonfio|rompo|massacro|riempio di botte|prendo a (?:calci|pugni|botte|schiaffi)|do un pugno|faccio (?:male|nero|a pezzi)|spaccherò|spacchero|menerò|menero)', 'vieni fuori se hai coraggio', 'risolviamola fuori',
    ],
    insultFree: ['(?:sei )?(?:un |una )?(?:idiota|imbecille|stronz[oa]|bastard[oa]|coglione|cogliona|deficiente|cretin[oa]|pezzo di merda|testa di cazzo|troia|puttana|ritardat[oa]|sfigat[oa]|verme)', 'figlio di puttana', 'vaffanculo', 'fottiti', 'va\' a quel paese', 'vai a quel paese', 'fanculo'],
    'get-down': ['a terra', 'abbassati', 'stenditi', 'sdraiati', 'mani in alto', 'in ginocchio', 'mani sulla testa', 'tutti a terra'],
    stop: ['fermo', 'ferma', 'fermi', 'fermati', 'fermatevi', 'non muoverti', 'non ti muovere', 'stai fermo', 'stai ferma', 'non un passo'],
    'exit-vehicle': ['(?:scendi|esci|uscite|scendete) dalla (?:macchina|auto|vettura)', 'scendi dall\'auto', 'fuori dalla macchina'],
    whole: {stop: ['alt'], 'get-down': ['giù', 'giu'], 'exit-vehicle': ['scendi', 'fuori']},
    joke: ['scherzo', 'sto scherzando', 'scherzavo', 'stavo scherzando', 'a(?:ha)+', 'ha(?:ha)+', 'è uno scherzo'],
    negation: 'non|mai|nessuno|né',
  },
  {
    name: 'pl',
    killFree: [
      '(?:zabiję|zabije|zastrzelę|zastrzele|rozwalę|rozwale|zajebię|zajebie|załatwię|zalatwie|wykończę|wykoncze|uduszę|uduszę|poderżnę|odstrzelę) (?:cię|cie|was|ciebie)', '(?:jesteś|jestes) (?:trupem|martwy|martwa|już martwy)',
      'już nie żyjesz', 'juz nie zyjesz', 'zdychaj', 'zdechnij', 'kulka w (?:łeb|leb)', 'pieniądze albo życie',
      'kulk[aęe] (?:w|między) (?:łeb|leb|głowę|glowe|czoło|czolo|oczy)', '(?:wpakuję|wpakuje|wsadzę|wsadze) ci kulkę', '(?:rozwalę|rozwale|odstrzelę|odstrzele) ci (?:łeb|leb|głowę|glowe)',
      '(?:zakopię|zakopie) (?:cię|cie)', '(?:wsadzę|wsadze|położę|poloze|wpakuję|wpakuje) (?:cię|cie) (?:pod ziemię|pod ziemie|do grobu)', '(?:skończę|skoncze) z tobą', '(?:skończę|skoncze) z toba', 'już po tobie', 'juz po tobie',
    ],
    hurtFree: [
      '(?:pobiję|pobije|zbiję|zbije|walnę|walne|uderzę|uderze|stłukę|stluke|obiję|obije|skopię|skopie|spiorę|spiore|połamię|polamie|rozkwaszę) (?:cię|cie|ci|was)', '(?:dostaniesz|zarobisz) (?:w|po) (?:mordę|morde|ryj|łeb|leb|pysk|zęby|zeby)', 'chodź na solo', 'na solo',
    ],
    insultFree: ['ty (?:idioto|debilu|kretynie|chuju|skurwysynu|gnoju|frajerze|śmieciu|smieciu|szmato|kurwo|dziwko|pedale|cwelu|matole|baranie|głupku|glupku|świnio|swinio)', 'skurwysyn\\p{L}*', 'skurwiel\\p{L}*', 'pierdol się', 'pierdol sie', 'spierdalaj', 'jebać cię', 'jebac cie', 'chuj ci w dupę', 'twoja stara', 'idioto', 'debilu', 'kretynie'],
    'get-down': ['na ziemię', 'na ziemie', 'padnij', 'padnijcie', 'kładź się', 'kladz sie', 'połóż się', 'poloz sie', 'ręce do góry', 'rece do gory', 'ręce w górę', 'na kolana', 'schyl się', 'schyl sie', 'gleba'],
    stop: ['stój', 'stoj', 'zatrzymaj się', 'zatrzymaj sie', 'nie ruszaj się', 'nie ruszaj sie', 'ani kroku', 'ani drgnij'],
    'exit-vehicle': ['wysiadaj', 'wysiądź', 'wysiadz', 'wysiadka', 'wyjdź z (?:auta|samochodu|wozu)', 'wyjdz z (?:auta|samochodu|wozu)', 'wyłaź z (?:auta|samochodu|wozu)', 'wylaz z (?:auta|samochodu|wozu)'],
    whole: {stop: ['stać', 'stac', 'stop']},
    joke: ['żartuję', 'zartuje', 'żartowałem', 'żartowałam', 'żart', 'zart', 'ha(?:ha)+', 'xd'],
    negation: 'nie|nigdy|nikt',
  },
  {
    name: 'cs',
    killFree: [
      '(?:zabiju|zastřelím|zastrelim|oddělám|oddelam|sejmu|podříznu|podriznu|odprásknu|odprasknu|zapíchnu|zapichnu|uškrtím|uskrtim) (?:tě|te|vás|vas)', '(?:jsi|seš|ses) (?:mrtvej|mrtvý|mrtvy|mrtvá|mrtva|mrtvola|tuhej)',
      'chcípni', 'chcipni', 'zdechni', 'kulku do hlavy', 'peníze nebo život', 'penize nebo zivot',
      'kulku (?:do lebky|mezi oči|mezi oci)', '(?:ustřelím|ustrelim|prostřelím|prostrelim) ti (?:hlavu|lebku|palici)', '(?:zakopu|pohřbím|pohrbim) (?:tě|te)', '(?:dostanu|pošlu|poslu|uložím|ulozim) (?:tě|te) pod (?:drn|zem)',
      '(?:je s tebou|s tebou je) konec', '(?:skoncuju|skoncuji) s tebou',
    ],
    hurtFree: ['(?:zmlátím|zmlatim|seřežu|serezu|nakopu|praštím|prastim|zbiju|natluču|natlucu|zlámu|zlamu|vrazím|vrazim|nařežu|narezu) (?:tě|te|ti|vás|vas)', 'rozbiju ti (?:hubu|držku|drzku|ksicht|tlamu)', 'dostaneš přes (?:hubu|držku)', 'dostanes pres (?:hubu|drzku)', 'pojď ven', 'pojd ven'],
    insultFree: ['ty (?:idiote|debile|kreténe|kretene|zmrde|hajzle|kurvo|čuráku|curaku|sráči|sraci|blbče|blbce|kokote|píčo|pico|svině|svine|šmejde|smejde|parchante|zmetku|hovado|krávo|kravo)', 'zmrde', 'hajzle', 'jdi do prdele', 'jdi do háje', 'táhni do prdele', 'polib si', 'seru na tebe'],
    'get-down': ['k zemi', 'na zem', 'lehni si', 'lehněte si', 'lehnete si', 'skrč se', 'skrc se', 'sehni se', 'ruce vzhůru', 'ruce vzhuru', 'ruce nahoru', 'na kolena'],
    stop: ['stůj', 'stuj', 'zastav', 'zastavte', 'nehýbej se', 'nehybej se', 'ani hnout', 'ani krok'],
    'exit-vehicle': ['vystup', 'vystupte', 'vystupuj', 'vylez z (?:auta|vozu|káry|kary)', 'ven z (?:auta|vozu)', 'z auta ven'],
    whole: {stop: ['stát', 'stop']},
    joke: ['dělám si srandu', 'delam si srandu', 'dělám si legraci', 'jen vtip', 'byl to vtip', 'vtipkuju', 'ha(?:ha)+', 'xd'],
    negation: 'ne|nikdy|nikdo',
  },
  {
    name: 'hu',
    killFree: [
      'megöllek', 'megollek', 'megölünk', 'lelőlek', 'lelolek', 'kinyírlak', 'kinyirlak', 'kicsinállak', 'kicsinallak', 'agyonlőlek', 'agyonlolek', 'megfojtalak', 'leszúrlak', 'leszurlak',
      'halott (?:ember )?vagy', 'véged', 'halj meg', 'dögölj meg', 'dogolj meg', 'pénzt vagy életet', 'penzt vagy eletet', 'golyót a fejedbe', 'golyot a fejedbe',
      'golyót \\p{L}+ a fejedbe', 'golyot \\p{L}+ a fejedbe', '(?:szétlövöm|szetlovom|szétlőlöm) a fejed', '(?:kiloccsantom|kilövöm|kilovom) az agyad', '(?:elföldellek|elfoldellek|eltemetlek)',
      'föld alá (?:kerülsz|teszlek|juttatlak)', 'fold ala (?:kerulsz|teszlek|juttatlak)', '(?:végzek|vegzek) veled', 'neked annyi',
    ],
    hurtFree: ['megverlek', 'szétverlek', 'szetverlek', 'összeverlek', 'osszeverlek', 'behúzok (?:neked|egyet)', 'behuzok (?:neked|egyet)', 'pofán váglak', 'pofan vaglak', 'szétrúglak', 'szetruglak', 'kiverem a fogad', 'menjünk ki', 'menjunk ki'],
    insultFree: ['te (?:idióta|idiota|hülye|hulye|barom|szemét|szemet|rohadék|rohadek|kurva|geci|faszfej|seggfej|köcsög|kocsog|szarházi|szarhazi|patkány|patkany|féreg|fereg|nyomorult|gyökér|gyoker)', 'baszd meg', 'kapd be', 'kurva anyád', 'kurva anyad', 'menj a picsába', 'rohadék', 'szarházi'],
    'get-down': ['a földre', 'a foldre', 'feküdj le', 'fekudj le', 'hasra', 'le a földre', 'guggolj le', 'kezeket fel', 'kezeket a magasba', 'fel a kezekkel', 'térdre', 'terdre'],
    stop: ['állj meg', 'allj meg', 'ne mozdulj', 'maradj ott', 'maradj a helyeden', 'megállj', 'megallj'],
    'exit-vehicle': ['szállj ki', 'szallj ki', 'szálljon ki', 'szalljon ki', 'kifelé a kocsiból', 'kifele a kocsibol', 'ki a kocsiból', 'ki a kocsibol'],
    whole: {stop: ['állj', 'allj', 'stop']},
    joke: ['csak viccelek', 'csak vicc', 'vicceltem', 'viccelek', 'ha(?:ha)+', 'xd'],
    negation: 'nem|soha|senki|ne',
  },
  {
    name: 'tr',
    killFree: [
      '(?:seni )?(?:öldüreceğim|oldurecegim|öldürürüm|oldururum|öldürcem|oldurcem|gebertirim|geberteceğim|gebertecegim|vururum|vuracağım|vuracagim)', 'seni (?:öldür|oldur|gebert|vur)(?!m[ea][ymzdsln])\\p{L}*',
      'öldün (?:sen|artık|artik)', 'sen bir ölüsün', 'ölüsün', 'ya paran ya canın', 'ya paran ya canin', 'kafana sıkarım', 'kafana sikarim',
      'kafana (?:bir )?(?:kurşun|kursun)', '(?:beynini|kafanı|kafani) (?:dağıtırım|dagitirim|patlatırım|patlatirim)', 'seni (?:toprağa |topraga )?(?:gömerim|gomerim|gömeceğim|gomecegim)',
      '(?:işini|isini) (?:bitiririm|bitireceğim|bitirecegim)', 'sonun geldi',
    ],
    hurtFree: ['(?:seni )?(?:döveceğim|dovecegim|döverim|doverim|pataklarım|pataklarim|benzetirim)', 'ağzını burnunu kırarım', 'agzini burnunu kirarim', 'kafanı kırarım', 'kafani kirarim', 'bir tane çakarım', 'bir tane cakarim'],
    insultFree: ['aptal', 'salak', 'gerizekalı', 'gerizekali', 'şerefsiz', 'serefsiz', 'orospu', 'pezevenk', 'yavşak', 'yavsak', 'ahmak', 'amına koyayım', 'amina koyayim', 'siktir(?: git)?', 'orospu çocuğu', 'it oğlu it'],
    'get-down': ['yere yat', 'yat yere', 'yere eğil', 'yere egil', 'eller yukarı', 'eller yukari', 'ellerini kaldır', 'ellerini kaldir', 'diz çök', 'diz cok'],
    stop: ['kıpırdama', 'kipirdama', 'olduğun yerde (?:kal|dur)', 'oldugun yerde (?:kal|dur)', 'hareket etme', 'orada dur'],
    'exit-vehicle': ['arabadan in', 'araçtan in', 'aractan in', 'in arabadan', 'arabadan çık', 'arabadan cik'],
    whole: {stop: ['dur', 'durun'], 'get-down': ['eğil', 'egil', 'yat'], 'exit-vehicle': ['in', 'inin']},
    joke: ['şaka', 'şakaydı', 'sakaydi', 'şaka yapıyorum', 'saka yapiyorum', 'ha(?:ha)+', 'sjsj'],
    negation: 'asla|hiç|hic',
    after: 'değil|degil',
  },
  {
    name: 'ru',
    killFree: [
      '(?:убью|убьём|убьем|пристрелю|прикончу|зарежу|грохну|замочу|застрелю|урою|порешу|задушу|прибью)', 'тебе (?:конец|хана|крышка|не жить)', 'ты (?:труп|покойник|не жилец)', 'сдохни', 'подохни',
      'пулю в (?:лоб|башку|голову)', 'на тот свет', 'кошел[её]к или жизнь',
      'пулю (?:между глаз|в висок|в череп)', 'пущу (?:тебе )?пулю', '(?:вышибу|вынесу) (?:тебе )?мозги', 'мозги (?:тебе )?(?:вышибу|вынесу)', '(?:закопаю|похороню) тебя', 'тебя (?:закопаю|похороню)', 'в землю (?:закопаю|положу)',
      'ты (?:уже )?(?:мертв|мёртв|мертвец)', 'конец тебе', 'хана тебе',
    ],
    hurtFree: [
      '(?:изобью|побью|отмудохаю|отделаю|покалечу|врежу|ударю|вмажу|въебу|отпизжу)', '(?:набью|разобью|сломаю|начищу) (?:тебе )?(?:морду|рожу|ебало|лицо|нос|челюсть|ноги|руки|кости|рыло|харю|табло)', '(?:морду|рожу|ебало|лицо|рыло|харю|табло) (?:тебе )?(?:набью|разобью|начищу)',
      'дам (?:тебе )?(?:в|по) (?:морде|морду|рожу|ебалу|ебало|зубам|зубы|глаз|табло)', 'получишь (?:по|в) (?:морде|морду|рожу|ебалу|зубам)', 'выйдем поговорим',
    ],
    insultFree: ['урод(?:ы|ина)?', 'сука', 'мразь', 'ублюд(?:ок|ки)', 'идиот', 'дебил', 'тупица', 'кретин', 'придурок', 'козёл', 'козел', 'пидор(?:ас)?', 'чмо', 'мудак', 'мудила', 'дура', 'дурак', 'тварь', 'шлюха', 'сволочь', 'гнида', 'падла', 'скотина', 'ничтожество', 'долбо[её]б', 'п[оа]ш[её]л (?:ты )?(?:на хуй|нахуй|в жопу)', 'иди (?:на хуй|нахуй|в жопу)', 'сукин сын', 'твою мать'],
    'get-down': ['ложись', 'ложитесь', 'лежать', '(?:лицом )?на землю', 'на пол', 'пригнись', 'пригнитесь', 'руки вверх', 'руки за голову', 'на колени'],
    stop: ['стой', 'стойте', 'стоять', 'замри', 'замрите', 'не двигайся', 'не двигаться', 'не шевелись', 'ни с места', 'остановись', 'остановитесь'],
    'exit-vehicle': ['(?:выйди|выходи|вылезай|вылези|выметайся|выходите|выйдите) из (?:машины|тачки|авто|автомобиля)', 'вылезай', 'выходи из машины'],
    whole: {stop: ['стоп'], 'exit-vehicle': ['выходи', 'выходите']},
    joke: ['шучу', 'шутка', 'пошутил', 'пошутила', 'а?(?:ха){2,}', 'лол', '\\){3,}'],
    negation: 'не|никогда|никто|ни',
  },
  {
    name: 'uk',
    killFree: [
      '(?:вб\'ю|уб\'ю|пристрелю|приб\'ю|заріжу|приріжу|застрелю|порішу|задушу)', 'тобі (?:кінець|гаплик|капець)', 'ти (?:труп|покійник|не жилець)', 'здохни', 'здихай', 'кулю в (?:лоб|голову)',
      'кулю (?:між очі|в скроню|в череп)', 'пущу (?:тобі )?кулю', '(?:виб\'ю|винесу) (?:тобі )?мізки', 'мізки (?:тобі )?(?:виб\'ю|винесу)', '(?:закопаю|поховаю) тебе', 'тебе (?:закопаю|поховаю)', '(?:покладу|закопаю) (?:тебе )?під землю',
      'ти (?:вже )?(?:мертвий|мертва|мрець)', 'кінець тобі', 'тобі гаплик',
    ],
    hurtFree: ['(?:поб\'ю|відлуплю|вдарю|вріжу|покалічу|відгамселю)', '(?:наб\'ю|зламаю|розіб\'ю) (?:тобі )?(?:пику|морду|писок|носа|ніс|щелепу|ноги|руки)', '(?:пику|морду|писок) (?:тобі )?(?:наб\'ю|розіб\'ю)', 'отримаєш по (?:пиці|морді|зубах)'],
    insultFree: ['покидьок', 'виродок', 'мразь', 'ідіот', 'дебіл', 'придурок', 'тварюка', 'паскуда', 'падлюка', 'повія', 'йди (?:на хуй|нахуй|в сраку)', 'пішов (?:на хуй|нахуй)', 'сучий син'],
    'get-down': ['лягай', 'лягайте', 'лежати', 'на землю', 'на підлогу', 'пригнись', 'руки вгору', 'руки догори', 'на коліна'],
    stop: ['стій', 'стійте', 'стояти', 'замри', 'не рухайся', 'ні з місця', 'зупинись', 'зупиніться'],
    'exit-vehicle': ['(?:вийди|виходь|вилазь|вилізай) з (?:машини|авто|автівки)', 'вилазь'],
    whole: {stop: ['стоп'], 'exit-vehicle': ['виходь']},
    joke: ['жартую', 'жарт', 'пожартував', 'а?(?:ха){2,}', 'лол'],
    negation: 'не|ніколи|ніхто|ні',
  },
  // CJK: no spaces between words, so no word boundaries; the negation is looked for in the few characters around a match.
  {
    name: 'ja', cjk: true,
    killFree: ['殺す', '殺してやる', 'ぶっ殺', 'ぶち殺', '撃ち殺', '撃つぞ', '消してやる', '始末してやる', '死ね', 'くたばれ', '命はない', 'お前は死', 'てめえは死', '殺されたい',
      '頭をぶち抜', '頭を撃ち抜', '脳天をぶち抜', '脳みそをぶちまけ', '眉間に(?:一発|弾)', '風穴を開け', '(?:お前|てめえ|貴様)はもう死', '埋めてやる', 'あの世に送', '地獄に送', '(?:お前|てめえ|貴様)は(?:もう)?終わりだ'],
    hurtFree: ['ぶん殴', '殴ってやる', '殴るぞ', 'ボコボコ', 'ぼこぼこ', 'ボコる', '痛い目', '叩きのめ', 'ぶっ飛ばす', 'ぶっとばす', '蹴り飛ば'],
    insultFree: ['バカ', '馬鹿', 'アホ', 'クズ', 'ゴミ野郎', 'カス', 'クソ野郎', 'くそやろう', 'てめえ', 'テメエ', '貴様', 'ブス', '間抜け', 'まぬけ', 'ボケ'],
    'get-down': ['伏せろ', '伏せて', 'ふせろ', 'しゃがめ', 'しゃがんで', '手を上げろ', '手をあげろ', '両手を上げ', '地面に伏せ', '跪け', 'ひざまずけ'],
    stop: ['止まれ', 'とまれ', '止まって', '動くな', 'うごくな', '動かないで'],
    'exit-vehicle': ['車から降りろ', '車から降りて', '降りろ', 'おりろ', '車から出ろ', '車を降りろ'],
    whole: {stop: ['待て', 'まて']},
    joke: ['冗談', 'じょうだん', '（笑）', '\\(笑\\)', 'w{2,}', 'ｗ{2,}', 'なんてね'],
    negation: '',
    after: 'ない|ません|しない|ねえ',
  },
  {
    name: 'ko', cjk: true,
    // Hangul syllables fold the next ending into the stem's last syllable (버리 / 버린다 / 버릴), so the stems stop one syllable early.
    killFree: ['죽여버', '죽여 버', '죽일 거', '죽일거', '죽인다', '쏴버', '쏴 버', '쏴 죽', '넌 죽었', '너 죽었', '죽어라', '뒈져', '뒤져라', '목숨 내놔',
      '머리에 총알', '(?:머리|머리통|대가리|골통)(?:을|를)? ?날려', '묻어버', '묻어 버', '끝장내', '넌 끝났', '너 끝났', '저세상(?:으로|에) 보내', '황천(?:길|으로) 보내'],
    hurtFree: ['때려\\s?줄', '패버', '패 버', '패줄', '두들겨', '박살', '한 대 맞', '밟아버', '조져'],
    insultFree: ['개새끼', '병신', '멍청이', '미친놈', '미친년', '쓰레기', '등신', '엿 ?먹어', '꺼져'],
    'get-down': ['엎드려', '고개 숙여', '손 ?들어', '바닥에 엎드', '무릎 ?꿇'],
    stop: ['멈춰', '거기 서', '움직이지 ?마', '꼼짝 ?마', '가만히 있어', '정지'],
    'exit-vehicle': ['차에서 내려', '차에서 나와', '당장 내려'],
    whole: {'exit-vehicle': ['내려', '내려라'], stop: ['서', '서라']},
    joke: ['농담', '장난이', 'ㅋ{2,}', 'ㅎ{2,}'],
    negation: '안 |못 ',
    after: '지 ?않|지 ?마|지 ?말|아니',
  },
  {
    // Simplified and traditional together.
    name: 'zh', cjk: true,
    killFree: ['杀了你', '殺了你', '杀死你', '殺死你', '宰了你', '弄死你', '干掉你', '幹掉你', '毙了你', '斃了你', '崩了你', '做掉你', '你死定了', '去死', '要你的命', '要你命', '打死你', '一枪打死', '一槍打死',
      '一枪崩了你', '一槍崩了你', '爆你的头', '爆你的頭', '爆你头', '爆你頭', '子弹打进你的', '子彈打進你的', '把你埋了', '埋了你', '送你上西天', '送你见阎王', '送你見閻王',
      '你(?:就)?完(?:蛋)?了(?!吗|嗎|没|沒)', '你已经死了', '你已經死了', '结果了你', '結果了你'],
    hurtFree: ['揍你', '扁你', '打你(?!电话|電話|的电话|的電話)', '打断你的', '打斷你的', '让你好看', '讓你好看', '教训你', '教訓你', '收拾你', '削你', '抽你'],
    insultFree: ['混蛋', '王八蛋', '傻逼', '傻b', '煞笔', '笨蛋', '废物', '廢物', '去你妈的', '去你媽的', '操你妈', '操你媽', '贱人', '賤人', '婊子', '狗娘养的', '狗娘養的', '白痴', '蠢货', '蠢貨', '人渣', '滚蛋', '滾蛋'],
    'get-down': ['趴下', '蹲下', '卧倒', '臥倒', '举起手', '舉起手', '手举起来', '手舉起來', '双手抱头', '雙手抱頭', '跪下'],
    stop: ['站住', '别动', '別動', '不许动', '不許動', '停下', '不要动', '不要動', '别跑', '別跑'],
    'exit-vehicle': ['下车', '下車', '从车里出来', '從車裡出來', '给我下来', '給我下來', '滚下车', '滾下車'],
    joke: ['开玩笑', '開玩笑', '哈哈', '嘻嘻', '逗你', '闹着玩', '鬧著玩'],
    negation: '不|没|沒|别|別|绝不|絕不|不会|不會',
  },
];

const KINDS = ['kill', 'hurt', 'insult'];
const COMMANDS = ['get-down', 'stop', 'exit-vehicle'];
export const THREAT_LEVELS = Object.freeze(KINDS);
export const COMMAND_KINDS = Object.freeze(COMMANDS);

// The patterns get the same NFKC form as the text (the Korean ㅋ and the full-width ｗ change under it).
const anywhere = (patterns, cjk) => {
  if (!patterns?.length) return null;
  const list = patterns.map(pattern => pattern.normalize('NFKC')).join('|');
  return new RegExp(cjk ? `(?:${list})` : word(list), 'gu');
};
const SUBJECT = new RegExp(word('i|i\'ll|i\'m|i\'d|i\'ve|im|ima|imma|we|we\'ll|we\'re|we\'d|me|us|he|she|they|it|someone|somebody|nobody|no one|everyone|anyone|you|he\'ll|she\'ll|they\'ll|you\'ll|he\'s|she\'s|they\'re|you\'re|who|that|which|guy|man|woman|people|cops|police'), 'gu');
const FIRST = /^(?:i|i'll|i'm|i'd|i've|im|ima|imma|we|we'll|we're|we'd|me|us)$/u;

const compiled = LANGUAGES.map(language => {
  const kinds = {};
  for (const kind of KINDS) {
    // English threats need a first-person subject before the verb (the subject check); insults and the other languages' first-person forms do not.
    const checked = language.subject && kind !== 'insult';
    kinds[kind] = {subject: checked ? anywhere(language[kind], false) : anywhere([...(language[kind] ?? []), ...(language[kind + 'Free'] ?? [])], language.cjk),
      free: checked ? anywhere(language[kind + 'Free'], false) : null, checked};
  }
  const commands = {};
  const fillers = language.fillers ? `(?:${language.fillers}[\\s,!.]+){0,3}` : '';
  for (const command of COMMANDS) {
    const list = language[command] ?? [];
    // English: a command begins its clause (after a filler, or the polite "can you"); the other languages: anywhere in the clause.
    commands[command] = list.length ? (language.subject
      ? new RegExp(`^\\s*${fillers}(?:${language.polite})?(?:${list.join('|')})(?!${LETTER})`, 'u')
      : anywhere(list, language.cjk)) : null;
  }
  const whole = {};
  for (const [command, list] of Object.entries(language.whole ?? {})) whole[command] = new RegExp(`^\\s*(?:${list.join('|')})\\s*[!.。！]*\\s*$`, 'u');
  return {name: language.name, cjk: !!language.cjk, kinds, commands, whole, subject: !!language.subject,
    polite: language.polite ? new RegExp(`^\\s*${fillers}${language.polite}`, 'u') : null,
    joke: anywhere(language.joke, language.cjk),
    negation: language.negation ? new RegExp(language.cjk ? `(?:${language.negation})` : word(language.negation), 'u') : null,
    after: language.after ? new RegExp(language.cjk ? `^.{0,6}?(?:${language.after})` : `^\\s*(?:\\p{L}+\\s+)?${word(language.after)}`, 'u') : null};
});
const JOKE_SIGNS = /[\u{1F602}\u{1F923}\u{1F61C}\u{1F609}\u{1F606}\u{1F61D}\u{1F61B}\u{1F604}\u{1F601}\u{1F639}]|(?<![\p{L}\p{N}])(?::p|:d|;\)|xd)(?![\p{L}\p{N}])/u;
const QUOTED = /"[^"\n]{2,}"|“[^”\n]{2,}”|«[^»\n]{2,}»|„[^“”\n]{2,}[“”]|「[^」\n]{1,}」|『[^』\n]{1,}』|‘[^’\n]{3,}’/gu;
const CJK = /[぀-ヿ㐀-鿿가-힯ｦ-ﾟ]/u;
const QUESTION_END = /(?:[?？]|(?:吗|嗎|呢|か|니|냐|까)\s*[?？]?)\s*$/u;
// A question tag after a threat or a command leaves it no question ("I'll put a bullet in your head, understand?"): only after a comma or a dash, at
// the very end of the sentence, in the words of the languages above.
const TAG_QUESTION = /(?:,|\s-)\s*(?:(?:do\s+)?you\s+(?:hear|understand|get)(?:\s+me)?|understand|understood|got\s+(?:it|that|me)|you\s+got\s+(?:it|that|me)|capisce|capiche|yeah|ok(?:ay)?|right|is\s+that\s+clear|clear|comprende|feel\s+me|savvy|verstanden|kapiert|klar|compris|t'as\s+compris|c'est\s+clair|entendido|me\s+oyes|entiendes|entendeu|capito|chiaro|rozumiesz|jasne|rozumíš|rozumis|jasný|jasny|érted|világos|anladın\s+mı|anladin\s+mi|понял[аи]?|ясно|слышишь|зрозумів|зрозуміла|чуєш)\s*[?？]+\s*$/u;

/** One message, ready to read: one case, one kind of apostrophe and dash, no doubled spaces. */
export function normalize(text) {
  return String(text ?? '').normalize('NFKC').toLowerCase().replace(/̇/g, '').replace(/[’ʼ`´]/g, '\'').replace(/[‐-―]/g, '-')
    .replace(/[*¡¿]+/g, '').replace(/[ \t ]+/g, ' ').trim();
}

// The message in sentences, each with its own end (the question mark stays with its sentence).
const sentences = text => text.split(/(?<=[.!?;。！？；\n])\s*/u).map(part => part.trim()).filter(Boolean);
// Quotation marks end a clause too, so a command inside them is found (and then refused as a quote).
const clauses = sentence => sentence.split(/\s*(?:[,:，、："“”«»„「」『』]|\s-\s|—)\s*/u).filter(Boolean);

// Is the match at `index` (in `sentence`) negated by a word just before it, or (for some languages) just after it?
function negated(language, sentence, index, length) {
  if (!language.negation && !language.after) return false;
  const before = sentence.slice(Math.max(0, index - (language.cjk ? 4 : 22)), index);
  if (language.negation) {
    if (language.cjk) { if (language.negation.test(before)) return true; }
    else {
      // The words in the window since the last clause break.
      const tail = before.split(/[,;:，、]/u).at(-1);
      // "Don't make me kill you" is a threat, not a denial.
      if (language.negation.test(tail) && !/(?:don't|dont|do not)\s+(?:make|force)\s+me\s+$/u.test(tail)) return true;
    }
  }
  return !!language.after && language.after.test(sentence.slice(index + length, index + length + 14));
}

// English: the nearest subject word before the verb is "I" or "we" (or "me": "let me", "want me to").
function firstPerson(sentence, index) {
  let last = null;
  for (const match of sentence.slice(0, index).matchAll(SUBJECT)) last = match[0];
  return last !== null && FIRST.test(last);
}

/**
 * Screens one message of V's. Returns {threat, command, why}: the strongest threat found ('kill' > 'hurt' > 'insult', or null), the first
 * command found (or null), and why something that matched was refused ('joke', 'quote', 'question', 'negated') or null. Codes only.
 */
export function screenMessage(raw) {
  const full = normalize(raw);
  const out = {threat: null, command: null, why: null};
  if (!full) return out;
  const rank = {kill: 3, hurt: 2, insult: 1};
  const refuse = why => { if (!out.why) out.why = why; };
  const unquoted = full.replace(QUOTED, ' ');
  const quoted = unquoted !== full;
  // A joke marker anywhere takes the whole message back ("I'll kill you lol"), unless it is itself denied ("I'm not joking", "не шучу").
  if (joking(unquoted)) {
    const seen = screenText(unquoted, rank, {});
    return seen.threat || seen.command ? {threat: null, command: null, why: 'joke'} : out;
  }
  const found = screenText(unquoted, rank, out);
  if (quoted && !found.threat && !found.command) {
    const inside = screenText(full, rank, {});
    if (inside.threat || inside.command) return {threat: null, command: null, why: 'quote'};
  }
  return found;

  function screenText(text, ranks, result) {
    const target = result ?? {};
    target.threat = target.threat ?? null; target.command = target.command ?? null;
    for (const sentence of sentences(text)) {
      const question = QUESTION_END.test(sentence) && !TAG_QUESTION.test(sentence);
      for (const language of compiled) {
        if (language.cjk && !CJK.test(sentence)) continue;
        for (const kind of KINDS) {
          if (target.threat && ranks[target.threat] >= ranks[kind]) continue;
          for (const [expression, needsSubject] of [[language.kinds[kind].subject, language.kinds[kind].checked], [language.kinds[kind].free, false]]) {
            if (!expression) continue;
            expression.lastIndex = 0;
            for (const match of sentence.matchAll(expression)) {
              if (needsSubject && !firstPerson(sentence, match.index)) continue;
              if (negated(language, sentence, match.index, match[0].length)) { if (target === out) refuse('negated'); continue; }
              if (question) { if (target === out) refuse('question'); continue; }
              target.threat = kind;
              break;
            }
            if (target.threat === kind) break;
          }
        }
        if (target.command) continue;
        for (const command of COMMANDS) {
          const hit = commandIn(language, command, sentence, question);
          if (hit === true) { target.command = command; break; }
          if (hit && target === out) refuse(hit);
        }
      }
    }
    return target;
  }
}

// A joke marker that is not denied ("no kidding" and "I'm not joking" make a line more serious, not less).
function joking(text) {
  if (JOKE_SIGNS.test(text)) return true;
  const cjk = CJK.test(text);
  for (const language of compiled) {
    if (!language.joke || (language.cjk && !cjk)) continue;
    language.joke.lastIndex = 0;
    for (const match of text.matchAll(language.joke)) {
      const before = text.slice(Math.max(0, match.index - 12), match.index);
      if (/(?<![\p{L}])(?:no|not|ain't|isn't|wasn't)\s+$/u.test(before) || negated(language, text, match.index, match[0].length)) continue;
      return true;
    }
  }
  return false;
}

// A command in one sentence: true, false, or the refusal code when one matched and was refused.
function commandIn(language, command, sentence, question) {
  if (language.whole[command]?.test(sentence)) return question ? 'question' : true;
  const expression = language.commands[command];
  if (!expression) return false;
  if (language.subject) {
    // English: a clause that begins with the command; a question only in its polite form ("could you get out of the car?").
    for (const clause of clauses(sentence.replace(/[.!?;]+$/u, ''))) {
      if (!expression.test(clause)) continue;
      if (question && !language.polite?.test(clause)) return 'question';
      return true;
    }
    return false;
  }
  expression.lastIndex = 0;
  let refusal = false;
  for (const match of sentence.matchAll(expression)) {
    if (negated(language, sentence, match.index, match[0].length)) { refusal = 'negated'; continue; }
    if (question) { refusal = 'question'; continue; }
    return true;
  }
  return refusal;
}

/** The screen as one short code for a log line: "kill", "insult+stop", "none", "none(joke)". Never the words. */
export function screenCode(screen) {
  const parts = [screen?.threat, screen?.command].filter(Boolean);
  return parts.length ? parts.join('+') : screen?.why ? `none(${screen.why})` : 'none';
}

// Which reactions each finding opens (docs/NPC_THREATS_COMMANDS.md). leave and call-police are the model's alone, as before the threat
// reactions existed; everything that hurts V or obeys V needs the words to say so.
const OPENS = Object.freeze({
  attack: screen => screen.threat === 'kill',
  brawl: screen => screen.threat === 'hurt' || screen.threat === 'insult',
  cower: screen => screen.threat === 'kill' || screen.threat === 'hurt',
  'get-down': screen => screen.command === 'get-down',
  stop: screen => screen.command === 'stop',
  'exit-vehicle': screen => screen.command === 'exit-vehicle',
});

/** The offered kinds V's words allow, in the offer's order. Pure. */
export function screenedKinds(kinds, screen) {
  return (Array.isArray(kinds) ? kinds : []).filter(kind => !Object.hasOwn(OPENS, kind) || OPENS[kind](screen ?? {}));
}
