// What each conversation was last told about V's gear (bridge/player-gear.mjs gearFacts): the clothes, the weapon in hand, the equipped weapons and the cyberware, as
// lists of text. A turn whose gear differs from it says so in its own notes (gearChange), as the current fact that replaces what was true earlier. The memory is
// written only when a reply is published (bridge/convai-bridge.mjs publishResult), so a turn that never reached the player, or is repeated, is compared against what
// the character really saw, and the several builds of one turn's context all agree. Nothing is written to disk: a restart simply starts every conversation again.
export const MAX_CONVERSATIONS = 256;   // least recently used go first (every stranger V talks to is a conversation)

const sameItems = (a, b) => a.length === b.length && [...a].sort().every((item, index) => item === [...b].sort()[index]);

export class GearMemory {
  constructor({limit = MAX_CONVERSATIONS} = {}) { this.limit = limit; this.seen = new Map(); }
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
  clear() { this.seen.clear(); }
}

export const gearMemory = new GearMemory();
