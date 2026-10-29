// Settings > Dynamic info: which kinds of live game info a turn's context may carry (docs/DYNAMIC_INFO.md).
//
// The game side (mod/manager.lua) saves one on/off value per kind in runtime/settings.json, `dynamicInfo: {location: true, ...}`, all on by
// default except `mods` (a missing or malformed value takes the default), and stops reading an off kind from the game (mod/turn-context.lua, mod/init.lua). This
// module is the bridge's half: it follows the same file and takes an off kind out of the context of EVERY provider, because they all build the
// turn's context in one place (bridge/quest-context.mjs conversationContextBlocks: Convai's dynamic info, and the layers of the Mistral, Local AI
// and Custom prompts). So an off kind is absent from the prompt even when an older request, or another mod's request, still carries it.
//
// The kinds, what each one covers, and where it is dropped:
//   location   the district, V's apartment or the named place, indoors or outdoors      turn context, ordinary NPCs' "where you are"
//   time       the hour of the day and the weather                                       turn context
//   company    who is with V, the vehicle, V's motion, what a companion is doing, a housemate's note   turn context
//   condition  V's health, the police heat, and the last fight                           turn context, the battle block of a manual turn
//   money      V's money band                                                            turn context
//   gear       V's clothes, weapons and cyberware                                        the gear block
//   about      V's gender and lifepath                                                   turn context
//   quest      the tracked quest and objective, the jobs V has open, the journal history   the journal, jobs and history blocks
//   dialogue   the last lines of game dialogue and V's chosen replies                    the game dialogue block
//   lastTalk   how long since V last talked to this character (game and real time)      the turn context's background line
//   media      the song on the car or pocket radio, what a TV near V shows               the turn context
//   mods       V's state according to other mods (Dark Future, Flesh and Chrome, Injuries) the turn context
// What each character knows about the story (the world facts, the recent shared events) is the character's own knowledge, not live info: it stays.
// V's gender for V's own voice and the dialogue volume are no part of the words the model reads: they are kept.
export const KINDS = Object.freeze(['location', 'time', 'company', 'condition', 'money', 'gear', 'about', 'quest', 'dialogue', 'lastTalk', 'media', 'mods']);
export const NO_KINDS = Object.freeze(new Set());

// The fields of a turn-context snapshot (bridge/turn-context.mjs parseTurnContext) each kind owns.
const SNAPSHOT_FIELDS = Object.freeze({
  location: ['district', 'area', 'indoors', 'position'], time: ['hour', 'minute', 'weather'], company: ['party', 'vehicle', 'driving', 'motion', 'housemate'],
  condition: ['health', 'heat'], money: ['money'], about: ['gender', 'lifepath'], lastTalk: ['gameTime'], media: ['media'], mods: ['mods', 'modsRead', 'facRead', 'injRead']});

/** The snapshot without what the off kinds own; the same object when nothing applies. `voice` and `dialogueVolume` always stay. */
export function stripSnapshot(snapshot, off = NO_KINDS) {
  if (!snapshot || snapshot.status !== 'ready' || !off || off.size === 0) return snapshot;
  let copy = null;
  for (const kind of off) {
    for (const field of SNAPSHOT_FIELDS[kind] ?? []) {
      if (!Object.hasOwn(snapshot, field)) continue;
      copy ??= {...snapshot};
      delete copy[field];
    }
  }
  return copy ?? snapshot;
}

// The kinds that are off until the player turns them on: a missing or non-boolean value is off for these, on for every other kind.
const OFF_BY_DEFAULT = Object.freeze(new Set(['mods']));

/** The kinds a settings object turns off: a kind is off when saved as the boolean false, or (an off-by-default kind) when it is not saved as true. */
export function offKinds(settings) {
  const table = settings && typeof settings === 'object' && settings.dynamicInfo && typeof settings.dynamicInfo === 'object' && !Array.isArray(settings.dynamicInfo)
    ? settings.dynamicInfo : {};
  return KINDS.filter(kind => OFF_BY_DEFAULT.has(kind) ? table[kind] !== true : table[kind] === false);
}

/**
 * The setting, followed from runtime/settings.json on the settings poll (a missing or unreadable file leaves it as it was, like the other
 * settings of the bridge). `off` is a frozen Set that is replaced, never changed, so a turn that holds it sees one consistent answer.
 */
export class DynamicInfo {
  constructor() { this.off = Object.freeze(new Set(OFF_BY_DEFAULT)); }
  /** Returns whether the set of off kinds changed. */
  update(settings) {
    if (!settings || typeof settings !== 'object') return false;
    const next = offKinds(settings), changed = next.join() !== [...this.off].join();
    if (changed) this.off = next.length ? Object.freeze(new Set(next)) : NO_KINDS;
    return changed;
  }
  on(kind) { return !this.off.has(kind); }
  /** One short line for the log. */
  describe() { return this.off.size ? `off: ${[...this.off].join(', ')}` : 'all on'; }
}

/** The one instance the bridge's context builders ask. */
export const dynamicInfo = new DynamicInfo();
