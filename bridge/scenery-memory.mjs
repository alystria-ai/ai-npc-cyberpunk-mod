// What each conversation has already been told about the scenery: the weather and the part of the day (bridge/turn-context.mjs).
// A model given "It is raining." on every turn treats it as something to react to ("the rain is a minor inconvenience" in seven talk answers
// of ten, 2026-10-14; a player report of 2026-10-21: "the NPCs always mention the weather"). So a conversation hears each of them when it is
// new to it: the weather when it changes during the talk or V's own words ask about it (not on the first turn), the part of the day on the first turn, a change, the first turn after a long silence, or when V's words ask.
// Nothing is written to disk and nothing leaves the bridge: a restart simply tells every conversation once more.
//
// The context of one turn is built several times (the prepared reply, the look-ahead, the turn itself, the log line), so a decision is
// made once per turn id and the same answer returned each time; a turn with no id is never gated (it hears everything, as before). The
// previous turn's values are only read, never rewritten, until a different turn id arrives.

// V's words ask about the weather (or about how it feels outside). On a first turn this is the only way the weather reaches the model, so the list is wide and in doubt it says yes: a weather word
// that is not a question about the weather only costs one more sentence of context. English whole words; the languages of the game's menus (cs de es fr hu it ja ko pl pt ru tr uk zh) by word stems,
// which catch inflections ("regnet", "lloviendo", "дождь"), and the CJK scripts by the character.
const WEATHER_WORDS_EN = 'weather|rain|rains|raining|rainy|rainfall|drizzle|drizzling|downpour|pouring|storm|storms|stormy|thunder|lightning|sky|skies|cloud|clouds|cloudy|overcast|fog|foggy|mist|misty|smog|smoggy|sun|sunny|sunshine|sandstorm|umbrella|forecast|cold|chilly|freezing|frozen|hot|warm|heat|humid|snow|snowing|snowy|hail|wind|windy|breeze|wet|damp|soaked|dry|outside|outdoors|temperature|degrees';
const WEATHER_STEMS = [
  'llov', 'lluvi', 'tormenta', 'nieve', 'nevand', 'niebla', 'nublad', 'cielo', 'calor', 'fr[ií]o', 'clima', 'viento', 'mojad', 'humed',   // es
  'chuv', 'chove', 'tempestade', 'neve', 'nevoeiro', 'n[eé]voa', 'nubl', 'c[eé]u\\b', 'vento', 'molhad', 'umidade',   // pt
  'pleu', 'pluie', 'orage', 'neige', 'brouillard', 'ciel', 'soleil', 'chaud', 'froid', 'm[eé]t[eé]o', 'nuage', 'humide',   // fr
  'regn', 'sturm', 'gewitter', 'schnee', 'nebel', 'himmel', 'sonne', 'wetter', 'kalt', 'hei[sß]', 'wolk', 'nass', 'feucht',   // de
  'piov', 'pioggia', 'temporale', 'tempesta', 'nebbia', 'sole\\b', 'caldo', 'freddo', 'nuvol', 'bagnat', 'umid',   // it
  'deszcz', 'burz', '[sś]nieg', 'mg[lł]', 'niebo', 'sło[nń]c', 'slonc', 'pogod', 'zimn', 'gor[aą]c', 'wiatr', 'chmur', 'mokr', 'wilgot',   // pl
  'd[eě][sš][tť]', 'pr[sš][ií]', 'bou[rř]', 's[nň][ií]h', 'mlh', 'oblo[hž]', 'slune[cč]', 'po[cč]as[ií]', 'zim[aoy]', 'hork', 'v[ií]tr', 'mrak',   // cs
  'e[sső]ő', 'esik', 'vihar', 'k[oö]d', 'id[oő]j[aá]r', 'hideg', 'meleg', 'sz[eé]l\\b', 'felh[oő]', 'nedves', 'havaz',   // hu
  'дожд', 'ливн', 'гроз', 'бур[яеи]', 'снег', 'туман', 'неб[оае]', 'солнц', 'погод', 'холод', 'жар[аок]', 'тепл', 'ветер', 'ветр', 'облак', 'мокр', 'сыр',   // ru
  'дощ', 'злив', 'сніг', 'небо', 'сонц', 'погод', 'холод', 'спек', 'жарк', 'тепл', 'вітер', 'хмар', 'мокр',   // uk
  'ya[gğ]mur', 'ya[gğ][iı]', 'f[iı]rt[iı]na', 'k[aâ]r\\b', 'sis\\b', 'g[oö]k', 'g[uü]ne[sş]', 'hava\\b', 'so[gğ]uk', 's[iı]cak', 'r[uü]zgar', 'bulut', '[iı]slak',   // tr
];
const WEATHER_CJK = ['雨', '雪', '嵐', '霧', '天気', '天候', '曇', '晴', '寒', '暑', '風', '湿', '濡れ',   // ja
  '风', '暴', '雾', '天空', '天气', '冷', '热', '云', '阴', '雲', '氣', '熱', '濕', '陰',   // zh
  '날씨', '비가', '비 [오와]', '폭풍', '눈이', '안개', '하늘', '추워', '춥', '더워', '덥', '바람', '구름', '맑', '흐리', '습'];   // ko
const WEATHER_ASK = new RegExp('\\b(?:' + WEATHER_WORDS_EN + ')\\b|(?<![\\p{L}\\p{N}])(?:' + WEATHER_STEMS.join('|') + ')|' + WEATHER_CJK.join('|'), 'iu');
const TIME_ASK = /\b(?:what time|the time|time is it|o'?clock|clock|hour|hours|late|early|morning|afternoon|evening|tonight|midnight|noon|dawn|dusk|sunrise|sunset|dark|daylight)\b/i;

// V's words ask about what is playing or on (the radio, a song, the TV): the music and TV line then comes again even though the conversation heard it before.
// Live 2026-10-25: told once on the first turn, it was gone on the next, so a companion asked "what song is this?" knew nothing. In doubt it says yes: one more short sentence.
const MEDIA_ASK = /\b(?:songs?|music|musical|radio|tunes?|tracks?|playing|plays|listen\w*|stations?|channels?|tv|television|telly|screen|news|broadcast|dj|band|artist|singer|singing|sings|lyrics|album|beat|hear|hearing|sound|sounds|volume|what's on|whats on)\b|(?<![\p{L}\p{N}])(?:m[uú]sica|musique|musik|canci[oó]n|chanson|canzone|piosenk|muzyk|p[eě]sni|zene|м[ую]зык|песн|пісн|m[uü]zik|[sş]ark[iı]|r[aá]dio)|音楽|歌|曲|音乐|广播|テレビ|电视|노래|음악|라디오/iu;
// V's words ask about themself: how they look or seem, whether they are all right, or a bodily need (hungry, thirsty, tired, eat, drink, sleep), or the state of their body ("can you see information on the state of my body", live 2026-10-26: not recognised, answered "I'm not a med-scanner"). A companion who has V's state
// (Settings > Dynamic info > Other mods' state) then hears it again even though the conversation was told it before: live 2026-10-26, V hungry in Dark Future, a few turns of
// "how do I look" and "do I seem okay", and Alex never said it. Convai's context is replaced on every turn (bridge/realtime-client.mjs updateContext), so a fact told on an earlier
// turn is simply gone from the next one. In doubt it says yes: one more short sentence, and only when there is a state to tell. English whole words and phrases; the menu languages
// (cs de es fr hu it ja ko pl pt ru tr uk zh) by stems, the CJK scripts by the character.
const SELF_ASK_EN = /\b(?:how (?:do|does|did|would|will) (?:i|it|that|this) (?:look|seem|sound|appear|feel)|how am i|how'?s it look|do i (?:look|seem|sound|appear)|am i (?:ok|okay|alright|all right|fine|good|well|tired|hungry|thirsty|sick|hurt|exhausted|sleepy)|what do i look like|looking (?:ok|okay|alright|fine|rough|tired|pale|terrible|awful|bad|like hell)|hungry|thirsty|starving|starved|famished|tired|exhausted|sleepy|drowsy|eat|eating|food|drink|drinking|sleep|nap|holding up|(?:state|condition|shape|status|health|vitals?|wellbeing|well-being) of (?:my|me)|my (?:state|condition|shape|status|health|vitals?|body|stats|stomach|energy|appearance)|(?:see|sees|seeing|notice|noticed|noticing|spot|sense|detect|scan|scanning|diagnose|examine|inspect|check)(?:\s+\w+){0,4}?\s+(?:me|myself)|wrong with me|what'?s up with me|(?:anything|something) (?:wrong|off|different) (?:with|about) me|how do you find me|how (?:are|is) (?:things|everything) with me|how i'?m (?:doing|looking|holding)|feel(?:ing)? (?:\w+ )?(?:rough|weak|dizzy|faint|off|sick|ill|awful|terrible|drained|wiped|sluggish|lightheaded|tired|hungry|thirsty|exhausted|empty|hollow|bad|strange|odd)|dizzy|faint|drained|wiped|sluggish|lightheaded|peckish|snack|meal|breakfast|lunch|dinner|bite to eat|something to (?:eat|drink)|need (?:a )?(?:rest|break|nap|meal|food|drink|water|coffee))\b/i;
const SELF_ASK_STEMS = [
  /c[oó]mo me (?:ves|veo)|me veo|parezco|estoy (?:bien|mal)|hambre|sed\b|cansad|agotad|sue[nñ]o\b|comer|beber|dormir|descans|mi cuerpo|mi estado|estado de mi|c[oó]mo estoy|me (?:ves|ve|notas|nota)\b|mala cara|aspecto/,   // es
  /como (?:eu )?pare[cç]o|como estou|estou (?:bem|mal)|fome|sede\b|exaust|sono\b|dormir|descans|meu corpo|meu estado|estado do meu|como estou|me v[eê]s?\b|minha apar[eê]ncia|cara de/,   // pt
  /comment (?:je|tu me|vous me)|j'ai l'air|ai-je l|faim\b|soif|fatigu|[eé]puis|manger|boire|sommeil|dormir|reposer|mon corps|mon [eé]tat|[eé]tat de mon|tu me vois|vous me voyez|mauvaise mine|bonne mine|mon apparence/,   // fr
  /wie sehe ich|sehe ich|wie geht es mir|hunger|hungrig|durst|m[uü]de|ersch[oö]pft|essen\b|trinken|schlaf|ausruhen|mein(?:en)? k[oö]rper|mein zustand|zustand meines|siehst du mich|sehen sie mich|sieht man mir|aussehen/,   // de
  /come (?:sembro|mi vedi|sto\b|appaio)|sembro|ho (?:fame|sete|sonno)|fame\b|sete\b|stanc|esaust|mangiar|bere\b|dormire|riposar|il mio corpo|mio stato|stato del mio|come sto\b|mi (?:vedi|noti|vede|nota)\b|che faccia/,   // it
  /jak wygl[aą]dam|wygl[aą]dam|g[lł]odn|spragnion|zm[eę]czon|wyczerpan|je[sś][cć]\b|pi[cć]\b|spa[cć]\b|odpoczy|moje cia[lł]o|m[oó]j stan|stan mojego|jak si[eę] czuj|widzisz mnie|wida[cć] po mnie|m[oó]j wygl[aą]d/,   // pl
  /jak vypad[aá]m|vypad[aá]m|hladov|[zž][ií]zniv|unaven|vy[cč]erpan|j[ií]st\b|p[ií]t\b|sp[aá]t\b|odpo[cč]|m[eé] t[eě]lo|m[uů]j stav|stav m[eé]ho|vid[ií][sš] m[eě]|vid[ií]te m[eě]|na mn[eě] vid[eě]t|jak mi je/,   // cs
  /hogy n[eé]zek ki|n[eé]zek ki|[eé]hes|szomjas|f[aá]radt|kimer[uü]lt|enni\b|inni\b|aludni|pihen|a testem|[aá]llapotom|l[aá]tsz engem|rajtam|hogy vagyok|hogy [eé]rzem/,   // hu
  /как я выгляжу|выгляж|я в порядке|голод|хочу (?:есть|пить|спать)|жажд|уста[лв]|измотан|поесть|выпить|отдох|мо[её] (?:состояние|тело)|состояние моего|видишь меня|видно по мне|как я себя чувствую|самочувств/,   // ru
  /як я виглядаю|виглядаю|голод|спраг|втом|виснаж|їсти\b|пити\b|спати\b|відпоч|мій стан|стан мого|моє тіло|бачиш мене|видно по мені|як я почуваюсь|самопочутт/,   // uk
  /nas[iı]l (?:g[oö]r[uü]n[uü]yorum|duruyorum)|g[oö]r[uü]n[uü]yorum|a[cç][iı]m|a[cç][iı]kt|susad|yorgun|bitkin|uyku|yemek|i[cç]mek|dinlen|v[uü]cudum|durumum|halim|beni g[oö]r[uü]yor|nas[iı]l hissediyorum/,   // tr
];
const SELF_ASK_CJK = ['見える', '見えて', '大丈夫', 'お腹', '空腹', '喉が', '疲れ', '眠', '食べ', '飲み', '休', '体', '様子', '顔色', '具合', '調子',   // ja
  '看起来', '看上去', '我怎么样', '还好吗', '饿', '渴', '累', '疲', '困', '吃', '喝', '睡', '休息', '看起來', '餓', '渴', '身体', '身體', '状态', '狀態', '气色', '氣色', '脸色', '臉色', '看得出',   // zh
  '어때 보', '보여', '괜찮', '배고', '목마', '피곤', '졸려', '먹', '마시', '자고', '쉬', '몸', '상태', '컨디션', '안색'];   // ko
const SELF_ASK_OTHERS = new RegExp('(?<![\\p{L}\\p{N}])(?:' + SELF_ASK_STEMS.map(row => row.source).join('|') + ')|' + SELF_ASK_CJK.join('|'), 'iu');
/** True when V's words ask about themself (how they look, whether they are all right, a bodily need). */
export const asksAboutSelf = text => { const asked = String(text ?? ''); return SELF_ASK_EN.test(asked) || SELF_ASK_OTHERS.test(asked); };
// V's words ask what a companion carries or is armed with (weapon, gun, "what are you packing?"). She then hears what she carries again, worded as the answer
// (bridge/turn-context.mjs): the sentence is in every in-person block already, but a model told "do not recite it" answered "none" to "what weapon do you have?"
// (live 2026-10-26). In doubt it says yes. English whole words; the menu languages (cs de es fr hu it ja ko pl pt ru tr uk zh) by stems, the CJK scripts by the character.
const WEAPON_ASK_EN = /\b(?:weapons?|guns?|armed|unarmed|arms|armou?ry|pieces?|packing|packin|pistols?|revolvers?|handguns?|sidearms?|firearms?|rifles?|shotguns?|smgs?|sniper|blades?|katanas?|knife|knives|swords?|strapped|carry(?:ing)?|carried|holster(?:ed|ing)?|ammo)\b/i;
const WEAPON_ASK_STEMS = [
  /armas?\b|pistola|armad[ao]|desarmad|fusil|escopeta|rev[oó]lver|cuchillo|espada|llevas|cargas/,   // es
  /armas?\b|pistola|armad[ao]|desarmad|espingarda|rev[oó]lver|faca\b|espada|carrega/,   // pt
  /armes?\b|pistolet|arm[eé]e?\b|fusil|flingue|couteau|[eé]p[eé]e\b|tu portes|vous portez/,   // fr
  /waffe|pistole|bewaffnet|gewehr|knarre|schusswaffe|revolver|messer|schwert/,   // de
  /arm[ae]\b|armi\b|pistola|armat[ao]|disarmat|fucile|rivoltella|coltello|spada\b|porti\b/,   // it
  /bro[nń]|pistolet|uzbrojon|karabin|spluw|gnat\b|n[oó][zż]\b|miecz|rewolwer|nosisz/,   // pl
  /zbra[nň]|pistol|ozbrojen|pu[sš]k|bouch|n[uů][zž]\b|me[cč]\b|revolver|nos[ií]š/,   // cs
  /fegyver|pisztoly|felfegyverz|puska|stukker|k[eé]s\b|kard\b|hordasz/,   // hu
  /оруж|пистолет|ствол|вооруж|винтовк|пушк|нож\b|меч\b|револьвер|носишь/,   // ru
  /зброя|зброї|зброю|пістолет|ствол|озброєн|гвинтівк|ніж\b|меч\b|револьвер|носиш/,   // uk
  /silah|tabanca|t[uü]fek|b[iı]ça[gğ]|k[iı]l[iı][cç]|ta[sş][iı]yor/,   // tr
];
const WEAPON_ASK_CJK = ['武器', '銃', '拳銃', '刀', '剣', '持って', '携帯',   // ja
  '枪', '槍', '手枪', '手槍', '剑', '劍', '带着', '帶著', '携带', '攜帶',   // zh
  '무기', '총', '권총', '칼', '검을', '들고', '갖고', '가지고'];   // ko
const WEAPON_ASK_OTHERS = new RegExp('(?<![\\p{L}\\p{N}])(?:' + WEAPON_ASK_STEMS.map(row => row.source).join('|') + ')|' + WEAPON_ASK_CJK.join('|'), 'iu');
/** True when V's words ask what a companion carries or is armed with. */
export const asksAboutWeapon = text => { const asked = String(text ?? ''); return WEAPON_ASK_EN.test(asked) || WEAPON_ASK_OTHERS.test(asked); };
export const IDLE_MS = 20 * 60_000;      // a conversation silent for this long hears the scenery again
export const MAX_CONVERSATIONS = 256;    // least recently used go first (every stranger V talks to is a conversation)
const ALL = Object.freeze({weather: true, time: true});
const NO_SIGNALS = Object.freeze({});

export class SceneryMemory {
  constructor({idleMs = IDLE_MS, limit = MAX_CONVERSATIONS, now = Date.now} = {}) {
    Object.assign(this, {idleMs, limit, now}); this.conversations = new Map();
  }
  /**
   * Which of the two facts this turn carries: {weather, time}, both booleans.
   *   key      the conversation (one character, one physical NPC, or one phone contact)
   *   id       the turn's id; without one nothing is decided and everything is sent
   *   weather  the weather kind the game sent, or undefined
   *   part     the part of the day, or undefined
   *   text     what V said (a keyword check: asking about the weather or the hour always gets it)
   *   signals  {media, mods}: a short text per fact that changes when the fact does (bridge/media-context.mjs, bridge/mod-state.mjs), or undefined
   *            when there is nothing to say; such a fact is told on the first turn, on a change and after a long silence, never on every turn
   */
  decide({key, id, weather, part, text = '', signals = NO_SIGNALS}) {
    if (typeof key !== 'string' || typeof id !== 'string' || !id) return ALL;
    const asked = String(text ?? ''), at = this.now(), entry = this.conversations.get(key);
    // The same turn again: the same answer, whatever was recorded since.
    const signalKey = JSON.stringify([signals.media ?? null, signals.mods ?? null]);
    if (entry && entry.id === id && entry.weather === weather && entry.part === part && entry.text === asked && entry.signalKey === signalKey) {
      this.conversations.delete(key); this.conversations.set(key, entry);
      return entry.decision;
    }
    // What the conversation was last told (a turn on which the game could not read one keeps the earlier value).
    const before = entry && at - entry.at <= this.idleMs ? entry.known : null;
    const decision = {
      // The first turn of a conversation does not announce the weather (response audit 2026-10-22: told "It is raining." on a first turn, a vendor or a bartender
      // mentioned the rain in 11 replies of 12, against 1 of 12 in dry weather); it comes when V asks, and when it changes later in the talk.
      weather: weather !== undefined && (before ? before.weather !== weather || WEATHER_ASK.test(asked) : WEATHER_ASK.test(asked)),
      time: part !== undefined && (!before || before.part !== part || TIME_ASK.test(asked)),
      // Present only when there is something to say about them.
      ...(signals.media !== undefined ? {media: !before || before.media !== signals.media || MEDIA_ASK.test(asked)} : {}),
      // V asking about themself (how they look, whether they are all right) always gets the state again: `modsAsked` makes the turn word it as the answer to that (bridge/turn-context.mjs).
      ...(signals.mods !== undefined ? {mods: !before || before.mods !== signals.mods || asksAboutSelf(asked), ...(asksAboutSelf(asked) ? {modsAsked: true} : {})} : {})};
    this.conversations.delete(key);
    // A turn with nothing to say about media or mods keeps no earlier signature: when it comes back it is new again.
    this.conversations.set(key, {id, weather, part, text: asked, signalKey, at, decision,
      known: {weather: weather ?? before?.weather, part: part ?? before?.part, media: signals.media, mods: signals.mods}});
    while (this.conversations.size > this.limit) this.conversations.delete(this.conversations.keys().next().value);
    return decision;
  }
  /** A new world, key or provider: every conversation starts again. */
  clear() { this.conversations.clear(); }
}

export const sceneryMemory = new SceneryMemory();
