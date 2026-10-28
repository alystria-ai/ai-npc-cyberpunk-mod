// Revenge ambushes (Settings > Gameplay > Revenge ambushes): V has been killing one gang, and a small squad of it comes after V. When the squad starts the
// attack, ONE squad member says a short taunt or threat in the gang's flavour. The game sends a private turn of an ORDINARY NPC (an archetype profile such
// as `npc-maelstrom-male`, unlike a companion's speak-up) with `reaction = {kind: 'ambush', event: 'taunt', group, count, toll, expiresAt}`; there is no model
// decision anywhere. Like a battle bark the line is an automatic reaction: it is never stored in the speaker's conversation memory, it is no word of V's (V's
// text is a placeholder), and the speaker is told in its trigger what the moment is and the limits of the line. Pure.
//
// The turn carries nothing else the line needs: the person's own block (CURRENT PERSON, from the archetype facts) and the gang's flavour (the archetype
// profile) come with it as for any ordinary NPC. Never `group`, `head`, `addon`, `loot`, `battle` or `holocall` (bridge/protocol.mjs refuses the turn),
// and no street-reputation snapshot (reputation applies only to a turn with no reaction).

/** The gangs that can send a squad: the archetype base keys of characters/archetypes.json, and how a person of that gang names it. */
export const AMBUSH_GROUPS = Object.freeze(['maelstrom', 'tyger-claws', 'valentinos', 'sixth-street', 'animals', 'voodoo-boys', 'scavengers', 'wraiths', 'mox',
  'aldecaldos', 'barghest']);
const GANG_NAMES = Object.freeze({maelstrom: 'Maelstrom', 'tyger-claws': 'Tyger Claws', valentinos: 'Valentinos', 'sixth-street': '6th Street', animals: 'Animals',
  'voodoo-boys': 'Voodoo Boys', scavengers: 'Scavengers', wraiths: 'Wraiths', mox: 'Mox', aldecaldos: 'Aldecaldos', barghest: 'Barghest'});
export const AMBUSH_TOLLS = Object.freeze(['few', 'many']);
// The longest taunt (the text host also stops the stream near the limit: reaction.maxWords).
export const AMBUSH_WORDS = 12;
export const AMBUSH_MAX_SQUAD = 8;

const plain = value => !!value && typeof value === 'object' && !Array.isArray(value);

/**
 * The reaction of a squad's taunt -> {kind: 'ambush', event: 'taunt', group, count, toll, expiresAt, maxWords}, or null (fail closed).
 * The speaker must be an ordinary NPC of the very gang the squad belongs to: profile `npc-<group>-(male|female)`, and, when the game sent archetype facts with
 * a base, that base must be the group as well.
 */
export function parseAmbushReaction(value, profileKey, archetype) {
  if (!plain(value) || value.kind !== 'ambush' || value.event !== 'taunt' || !AMBUSH_GROUPS.includes(value.group)
      || !Number.isSafeInteger(value.count) || value.count < 1 || value.count > AMBUSH_MAX_SQUAD
      || !AMBUSH_TOLLS.includes(value.toll) || !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= 0) return null;
  if (typeof profileKey !== 'string' || !/^[a-z0-9-]{1,80}$/.test(profileKey)) return null;
  const match = /^npc-([a-z0-9-]+)-(?:male|female)$/.exec(profileKey);
  if (!match || match[1] !== value.group) return null;
  if (archetype !== undefined && archetype !== null && (!plain(archetype) || (archetype.base !== undefined && archetype.base !== value.group))) return null;
  return {kind: 'ambush', event: 'taunt', group: value.group, count: value.count, toll: value.toll, expiresAt: value.expiresAt, maxWords: AMBUSH_WORDS};
}

const TAIL = 'A statement, not a question: do not ask V or anyone else anything, not even a rhetorical question. '
  + 'Return only the spoken line, without narration, stage directions or actions.';

/** The trigger of the taunt: what the moment is and the limits of the line. Throws for anything but a valid ambush turn. */
export function ambushTrigger(input) {
  const reaction = input?.reaction;
  if (reaction?.kind !== 'ambush' || reaction.event !== 'taunt' || !AMBUSH_GROUPS.includes(reaction.group) || !AMBUSH_TOLLS.includes(reaction.toll)
      || !Number.isSafeInteger(reaction.count) || reaction.count < 1 || reaction.count > AMBUSH_MAX_SQUAD) throw Error('Invalid ambush trigger');
  const gang = GANG_NAMES[reaction.group];
  const squad = reaction.count === 1 ? `You are one of a small squad of ${gang}` : `You are one of ${reaction.count} members of ${gang}`;
  const anger = reaction.toll === 'many' ? 'a lot of your people, so you are furious and out for blood' : 'some of your people, so you are angry and want V to pay';
  return 'This was not spoken by V: V has not said anything, and you open the attack on your own. '
    + `${squad} who have just been sent after V and are starting the attack, because V has been killing ${anger}. `
    + `Say ONE short threat or taunt at V, of no more than ${AMBUSH_WORDS} words, in the voice and attitude of the ${gang}, as you would say it as the fight begins. `
    + 'Never state or guess how many of your people V has killed. '
    + 'Do not invent names, places, past events, weapons or injuries, and do not claim to do anything beyond the threat itself. ' + TAIL;
}
