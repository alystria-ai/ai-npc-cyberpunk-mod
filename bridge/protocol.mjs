// Managed identity is authoritative. Never silently route an unsupported named
// companion into a resident profile just because its body type is recognized.
import {parseGroup} from './group-context.mjs';
import {parseJournal} from './quest-context.mjs';
import {parseBattle, parseReaction} from './battle-context.mjs';
import {parseLoot} from './loot-context.mjs';
import {parseWorldSnapshot} from './world-knowledge.mjs';
import {parseJournalHistory} from './journal-history.mjs';
import {parseGameDialogue} from './game-dialogue.mjs';
import {parseChauffeurOffer, parseTacticOffer, parseFollowOffer, parseLeaveOffer, parseFollowUnavailable}
  from './companion-actions.mjs';

export function profileFor(input, roster) {
  return roster.find(profile => profile.key === input.profileKey);
}

export function parseInput(raw) {
  let value;
  try { value = JSON.parse(raw); } catch { return null; }
  if (!value || typeof value !== 'object') return null;
  const {requestId, generation, entity, name, bodyType, profileKey, text} = value;
  if (typeof requestId !== 'string' || !/^[0-9]+-[0-9]+-[0-9]+ULL$/.test(requestId)
      || !Number.isSafeInteger(generation) || generation < 0 || typeof entity !== 'string' || !/^\d+ULL$/.test(entity)
      || !requestId.endsWith(`-${generation}-${entity}`)
      || typeof text !== 'string' || !text.trim() || text.length > 1200
      || typeof name !== 'string' || typeof bodyType !== 'string'
      || typeof profileKey !== 'string' || !/^[a-z0-9-]+$/.test(profileKey)) return null;
  const group = value.group === undefined ? undefined : parseGroup(value.group);
  if (group === null) return null;
  const journal = parseJournal(value.journal);
  const worldKnowledge = value.worldKnowledge === undefined ? undefined : parseWorldSnapshot(value.worldKnowledge);
  const journalHistory = value.journalHistory === undefined ? undefined : parseJournalHistory(value.journalHistory);
  // Optional recent game dialogue; a malformed snapshot carries no lines but keeps the message.
  const gameDialogue = parseGameDialogue(value.gameDialogue);
  const loot = parseLoot(value.loot, {entity, profileKey});
  if (loot === null) return null;
  const battle = parseBattle(value.battle), reaction = parseReaction(value.reaction, battle, loot);
  if (reaction === null) return null;
  // A malformed optional offer removes only gameplay admission; the original
  // conversation is still valid and must keep its actor/request identity.
  const chauffeurOffer = parseChauffeurOffer(value.chauffeurOffer);
  const tacticOffer = parseTacticOffer(value.tacticOffer);
  // Party membership offers (docs/WORLD_COMPANIONS.md): join V, leave V's party, or why joining is refused.
  const followOffer = parseFollowOffer(value.followOffer), leaveOffer = parseLeaveOffer(value.leaveOffer);
  const followUnavailable = parseFollowUnavailable(value.followUnavailable);
  return {requestId, generation, entity, name: name.slice(0, 120), bodyType: bodyType.slice(0, 80), profileKey, text: text.trim(), group,
    ...(journal ? {journal} : {}), ...(battle ? {battle} : {}), ...(loot ? {loot} : {}), ...(reaction ? {reaction} : {}),
    ...(chauffeurOffer ? {chauffeurOffer} : {}), ...(tacticOffer ? {tacticOffer} : {}),
    ...(followOffer ? {followOffer} : {}), ...(leaveOffer ? {leaveOffer} : {}),
    ...(followUnavailable ? {followUnavailable} : {}),
    ...(worldKnowledge ? {worldKnowledge} : {}), ...(journalHistory ? {journalHistory} : {}),
    ...(gameDialogue ? {gameDialogue} : {})};
}
