// What each conversation has already been told about the scenery: the weather and the part of the day (bridge/turn-context.mjs).
// A model given "It is raining." on every turn treats it as something to react to ("the rain is a minor inconvenience" in seven talk answers
// of ten, 2026-10-14; a player report of 2026-10-21: "the NPCs always mention the weather"). So a conversation hears each of them when it is
// new to it: the weather when it changes during the talk or V's own words ask about it (not on the first turn), the part of the day on the first turn, a change, the first turn after a long silence, or when V's words ask.
// Nothing is written to disk and nothing leaves the bridge: a restart simply tells every conversation once more.
//
// The context of one turn is built several times (the prepared reply, the look-ahead, the turn itself, the log line), so a decision is
// made once per turn id and the same answer returned each time; a turn with no id is never gated (it hears everything, as before). The
// previous turn's values are only read, never rewritten, until a different turn id arrives.

const WEATHER_ASK = /\b(?:weather|rain|rains|raining|rainy|rainfall|drizzle|drizzling|downpour|pouring|storm|storms|stormy|thunder|lightning|sky|skies|cloud|clouds|cloudy|overcast|fog|foggy|mist|misty|smog|smoggy|sun|sunny|sunshine|sandstorm|umbrella|forecast)\b/i;
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
