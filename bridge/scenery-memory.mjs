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

export const IDLE_MS = 20 * 60_000;      // a conversation silent for this long hears the scenery again
export const MAX_CONVERSATIONS = 256;    // least recently used go first (every stranger V talks to is a conversation)
const ALL = Object.freeze({weather: true, time: true});

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
   */
  decide({key, id, weather, part, text = ''}) {
    if (typeof key !== 'string' || typeof id !== 'string' || !id) return ALL;
    const asked = String(text ?? ''), at = this.now(), entry = this.conversations.get(key);
    // The same turn again: the same answer, whatever was recorded since.
    if (entry && entry.id === id && entry.weather === weather && entry.part === part && entry.text === asked) {
      this.conversations.delete(key); this.conversations.set(key, entry);
      return entry.decision;
    }
    // What the conversation was last told (a turn on which the game could not read one keeps the earlier value).
    const before = entry && at - entry.at <= this.idleMs ? entry.known : null;
    const decision = {
      // The first turn of a conversation does not announce the weather (response audit 2026-10-22: told "It is raining." on a first turn, a vendor or a bartender
      // mentioned the rain in 11 replies of 12, against 1 of 12 in dry weather); it comes when V asks, and when it changes later in the talk.
      weather: weather !== undefined && (before ? before.weather !== weather || WEATHER_ASK.test(asked) : WEATHER_ASK.test(asked)),
      time: part !== undefined && (!before || before.part !== part || TIME_ASK.test(asked))};
    this.conversations.delete(key);
    this.conversations.set(key, {id, weather, part, text: asked, at, decision, known: {weather: weather ?? before?.weather, part: part ?? before?.part}});
    while (this.conversations.size > this.limit) this.conversations.delete(this.conversations.keys().next().value);
    return decision;
  }
  /** A new world, key or provider: every conversation starts again. */
  clear() { this.conversations.clear(); }
}

export const sceneryMemory = new SceneryMemory();
