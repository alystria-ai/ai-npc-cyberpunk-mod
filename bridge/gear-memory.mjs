// What each conversation was last told about V's gear (bridge/player-gear.mjs gearFacts): the clothes, the weapon in hand, the equipped weapons and the cyberware, as
// lists of text. A turn whose gear differs from it says so in its own notes (gearChange), as the current fact that replaces what was true earlier. The memory is
// written only when a reply is published (bridge/convai-bridge.mjs publishResult), so a turn that never reached the player, or is repeated, is compared against what
// the character really saw, and the several builds of one turn's context all agree. Nothing is written to disk: a restart simply starts every conversation again.
export const MAX_CONVERSATIONS = 256;   // least recently used go first (every stranger V talks to is a conversation)

const sameItems = (a, b) => a.length === b.length && [...a].sort().every((item, index) => item === [...b].sort()[index]);

export class GearMemory {
  constructor({limit = MAX_CONVERSATIONS} = {}) { this.limit = limit; this.seen = new Map(); this.texts = new Map(); }
  /**
   * The gear block a talk with `key` (a profile key) had, for the reactions that follow it. The game sends the gear with V's own turns only, and a reaction (a companion speaking up, a
   * fight line) with none left the block out of the system message, so a model that continues a prompt only from a saved checkpoint (the lite and Mature models) read the whole message
   * again after every change of kind. A reaction now repeats the block, byte for byte, in its place.
   */
  remember(key, text) {
    if (typeof key !== 'string') return;
    this.texts.delete(key);
    if (typeof text === 'string' && text) this.texts.set(key, text);
    while (this.texts.size > this.limit) this.texts.delete(this.texts.keys().next().value);
  }
  /** The block remembered for `key`, or ''. */
  recall(key) { return this.texts.get(key) ?? ''; }
  /** [{key, now, before}] for each fact in `facts` that differs from what the conversation last saw; [] on its first turn or when nothing changed. */
  changes(key, facts) {
    const before = this.seen.get(key);
    if (!before || !facts) return [];
    return Object.keys(facts).filter(fact => Array.isArray(before[fact]) && !sameItems(before[fact], facts[fact]))
      .map(fact => ({key: fact, now: facts[fact], before: before[fact]}));
  }
  /** The conversation has been told `facts`. */
  commit(key, facts) {
    if (typeof key !== 'string' || !facts) return;
    const before = this.seen.get(key);
    this.seen.delete(key);
    this.seen.set(key, {...before, ...facts});
    while (this.seen.size > this.limit) this.seen.delete(this.seen.keys().next().value);
  }
  /** A new world, key or provider: every conversation starts again. */
  clear() { this.seen.clear(); this.texts.clear(); }
}

export const gearMemory = new GearMemory();
