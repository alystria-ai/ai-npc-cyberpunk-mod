// Settings > Dynamic info: which kinds of live game info a turn's context may carry (docs/DYNAMIC_INFO.md).
//
// The game side (mod/manager.lua) saves one on/off value per kind in runtime/settings.json, `dynamicInfo: {location: true, ...}`, all on by
// default except `mods` (a missing or malformed value takes the default), and stops reading an off kind from the game (mod/turn-context.lua, mod/init.lua).
// There are TWO sets of those switches: `dynamicInfo` for talk in person and `dynamicInfoPhone` for a holocall or a Phone Chat text (a character V is only
// calling or texting) and has defaults of its own (a caller or texter does not see V): see OFF_BY_DEFAULT_PHONE. A kind missing from the phone set takes the phone default.
// A turn uses the phone set when it is a phone turn and the character is not standing beside V (bridge/quest-context.mjs dynamicOff). The game side reads
// a kind when either set has it on. This
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
//   media      the song on the car or pocket radio and what its host said, what a TV shows  the turn context
//   mods       V's state according to other mods (Dark Future, Flesh and Chrome, Injuries) the turn context
// What each character knows about the story (the world facts, the recent shared events) is the character's own knowledge, not live info: it stays.
// V's gender for V's own voice and the dialogue volume are no part of the words the model reads: they are kept.
export const KINDS = Object.freeze(['location', 'time', 'company', 'condition', 'money', 'gear', 'about', 'quest', 'dialogue', 'lastTalk', 'media', 'mods']);
export const NO_KINDS = Object.freeze(new Set());

const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
/** Is this turn a Phone Chat text or a holocall (a one-to-one call, voice or video)? Whether the character stands beside V anyway is not asked here. */
export const phoneTurn = input => !!input && (input.channel === 'phone' || (!input.group && plain(input.holocall) && (input.holocall.mode === 'audio' || input.holocall.mode === 'holo')));

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
// The same for the phone set: what a caller or texter could not see is off (location, company and vehicle, health and heat and fights, money, gear, the
// music and TV around V, the game dialogue V is in, other mods' state). On: time, about, quest, lastTalk. Mirrors dynamicInfoDefault in mod/manager.lua.
export const OFF_BY_DEFAULT_PHONE = Object.freeze(new Set(['location', 'company', 'condition', 'money', 'gear', 'media', 'dialogue', 'mods']));

const tableOf = (settings, name) => settings && plain(settings) && plain(settings[name]) ? settings[name] : {};
const isOn = (table, kind, offByDefault = OFF_BY_DEFAULT) => offByDefault.has(kind) ? table[kind] === true : table[kind] !== false;

/**
 * The kinds a settings object turns off: a kind is off when saved as the boolean false, or (an off-by-default kind) when it is not saved as true.
 * `phone` picks the phone set (holocalls and Phone Chat); a kind it does not carry as a boolean takes the phone default.
 */
export function offKinds(settings, phone = false) {
  if (phone) return KINDS.filter(kind => !isOn(tableOf(settings, 'dynamicInfoPhone'), kind, OFF_BY_DEFAULT_PHONE));
  return KINDS.filter(kind => !isOn(tableOf(settings, 'dynamicInfo'), kind));
}

/**
 * The setting, followed from runtime/settings.json on the settings poll (a missing or unreadable file leaves it as it was, like the other
 * settings of the bridge). `off` is a frozen Set that is replaced, never changed, so a turn that holds it sees one consistent answer.
 */
export class DynamicInfo {
  constructor() { this.off = Object.freeze(new Set(OFF_BY_DEFAULT)); this.offPhone = Object.freeze(new Set(OFF_BY_DEFAULT_PHONE)); }
  /** Returns whether either set of off kinds changed. */
  update(settings) {
    if (!settings || typeof settings !== 'object') return false;
    const freeze = next => next.length ? Object.freeze(new Set(next)) : NO_KINDS;
    const person = offKinds(settings), phone = offKinds(settings, true);
    const changed = person.join() !== [...this.off].join() || phone.join() !== [...this.offPhone].join();
    if (changed) { this.off = freeze(person); this.offPhone = freeze(phone); }
    return changed;
  }
  /** The off kinds of one kind of turn: the phone set (holocall or Phone Chat) or the in-person set. */
  offFor(phone = false) { return phone ? this.offPhone : this.off; }
  on(kind, phone = false) { return !this.offFor(phone).has(kind); }
  /** On in either set: for what is stored or read once for every kind of turn (the time since the last talk). */
  onAny(kind) { return !this.off.has(kind) || !this.offPhone.has(kind); }
  /** One short line for the log. */
  describe() {
    const line = set => set.size ? `off: ${[...set].join(', ')}` : 'all on';
    return [...this.off].join() === [...this.offPhone].join() ? line(this.off) : `in person ${line(this.off)}, phone ${line(this.offPhone)}`;
  }
}

/** The one instance the bridge's context builders ask. */
export const dynamicInfo = new DynamicInfo();
