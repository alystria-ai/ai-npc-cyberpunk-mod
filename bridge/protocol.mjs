// Managed identity is authoritative. Never silently route an unsupported named
// companion into a resident profile just because its body type is recognized.
import {parseGroup} from './group-context.mjs';
import {parseJournal} from './quest-context.mjs';
import {parseBattle, parseReaction} from './battle-context.mjs';
import {parseAddonInput, parseAddonReaction} from './addons.mjs';
import {parseLoot} from './loot-context.mjs';
import {parseWorldSnapshot} from './world-knowledge.mjs';
import {parseJournalHistory} from './journal-history.mjs';
import {parseGameDialogue} from './game-dialogue.mjs';
import {parseGear} from './player-gear.mjs';
import {parseTurnContext} from './turn-context.mjs';
import {parseHead, parseHeadReaction} from './johnny-head.mjs';
import {parseMeetReaction} from './appointment-events.mjs';
import {parseCallMeetOffer} from './call-meet.mjs';
import {parseHouseReaction} from './house-chat.mjs';
import {parseSpeakUpReaction} from './speakup-context.mjs';
import {resolveKnowledgeParts} from './knowledge-parts.mjs';
import {parseReputationSnapshot} from './reputation.mjs';
import {parseEddies} from './eddies.mjs';
import {parseChauffeurOffer, parseTacticOffer, parseFollowOffer, parseLeaveOffer, parseHomeOffer, parseReactionOffer, parseFollowUnavailable, parseTacticUnavailable, parseDriveUnavailable}
  from './companion-actions.mjs';

export {parseMeetReaction};

export function profileFor(input, roster) {
  return roster.find(profile => profile.key === input.profileKey);
}

// A game request, plus the optional archetype facts of an unnamed NPC (docs/NPC_ARCHETYPES.md).
const PROVIDER_NAMES = Object.freeze(['convai', 'mistral', 'local', 'custom']);
export function parseInput(raw) {
  const input = parseRequest(raw);
  if (!input) return input;
  let archetype;
  try { archetype = parseArchetype(JSON.parse(raw)?.archetype); } catch { archetype = null; }
  return archetype ? {...input, archetype} : input;
}

function parseRequest(raw) {
  let value;
  try { value = JSON.parse(raw); } catch { return null; }
  if (!value || typeof value !== 'object') return null;
  // World facts and journal rows named by revision come from the parts the game published (bridge/knowledge-parts.mjs).
  value = resolveKnowledgeParts(value);
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
  // Optional gear V wears and carries (bridge/player-gear.mjs); a malformed snapshot carries nothing but keeps the message.
  const gear = parseGear(value.gear);
  // Optional "right now" facts (bridge/turn-context.mjs): clock, district, company, vehicle, V's gender and lifepath.
  const turnContext = parseTurnContext(value.turnContext);
  const loot = parseLoot(value.loot, {entity, profileKey});
  if (loot === null) return null;
  // An add-on speaker's turn data (docs/ADDON_API.md); absent for every ordinary turn.
  const addon = parseAddonInput(value.addon);
  const battle = parseBattle(value.battle);
  // Johnny speaks up (docs/JOHNNY_IN_YOUR_HEAD.md, phase 2): his own unprompted remark, only with his head field on his profile.
  const head = group ? null : parseHead(value.head);
  // A companion speaks up on her own (docs/COMPANION_SPEAK_UP.md): a private turn of a named roster character with the journal, the right-now snapshot and,
  // after a scene, the scene's lines. It carries no battle, loot or head field, no add-on and no group, or the whole turn is refused.
  const speakUp = value.reaction?.kind === 'speakup';
  const reaction = value.reaction?.kind === 'addon' ? parseAddonReaction(value.reaction, addon, profileKey)
    : value.reaction?.kind === 'head' ? parseHeadReaction(value.reaction, head, profileKey)
      // She met V at the place she was invited to (docs/IMMERSIVE_INVITATIONS.md): her own greeting, a private turn only (bridge/appointment-events.mjs).
      : value.reaction?.kind === 'meet' ? parseMeetReaction(value.reaction, {group: !!group})
        // A housemate speaks (docs/HOUSEMATES.md): a line of a chat with another housemate, or a welcome home; a private turn only (bridge/house-chat.mjs).
        : value.reaction?.kind === 'house' ? parseHouseReaction(value.reaction, {group: !!group})
          : speakUp ? (group || head || addon || loot || battle || value.holocall !== undefined || value.head !== undefined ? null : parseSpeakUpReaction(value.reaction, profileKey))
            : parseReaction(value.reaction, battle, loot);
  if (reaction === null) return null;
  // A malformed optional offer removes only gameplay admission; the original
  // conversation is still valid and must keep its actor/request identity.
  const chauffeurOffer = parseChauffeurOffer(value.chauffeurOffer);
  const tacticOffer = parseTacticOffer(value.tacticOffer);
  // Party membership offers (docs/WORLD_COMPANIONS.md): join V, leave V's party, or why joining is refused.
  const followOffer = parseFollowOffer(value.followOffer), leaveOffer = parseLeaveOffer(value.leaveOffer);
  // Housemates (docs/HOUSEMATES.md): stay at V's place, move out, join V's party from home. A malformed offer is dropped, the message stands.
  const homeOffer = parseHomeOffer(value.homeOffer);
  // An ordinary world NPC's reaction offer (docs/NPC_REACTIONS.md); a person with any of the offers above is a companion and has none.
  const reactionOffer = chauffeurOffer || tacticOffer || followOffer || leaveOffer || homeOffer ? null : parseReactionOffer(value.reactionOffer);
  // An offer the game sent that did not survive the parser is not silent: the turn's reaction line says so (bridge/companion-actions.mjs admit).
  const reactionOfferDropped = value.reactionOffer !== undefined && !reactionOffer && !(chauffeurOffer || tacticOffer || followOffer || leaveOffer || homeOffer)
    ? 'malformed-offer' : undefined;
  const followUnavailable = parseFollowUnavailable(value.followUnavailable);
  const tacticUnavailable = parseTacticUnavailable(value.tacticUnavailable);
  const driveUnavailable = chauffeurOffer ? null : parseDriveUnavailable(value.driveUnavailable);
  // A holocall turn (docs/HOLOCALL.md): V and the character talk over the phone. Private turns only; a malformed value is dropped.
  // Johnny in V's head (docs/JOHNNY_IN_YOUR_HEAD.md): his stage with V (parsed above). Private turns only; never a holocall as well.
  const holocall = group || head ? null : parseHolocall(value.holocall);
  // The meeting V could ask for on this call (docs/IMMERSIVE_INVITATIONS.md, bridge/call-meet.mjs): a holocall line only, kept as the game sent it (the
  // packet that answers it echoes it, and the game compares); a malformed offer is no offer and never rejects the line.
  const meetOffer = holocall ? parseCallMeetOffer(value.meetOffer)?.raw : undefined;
  // The Conversation provider the player had chosen when the game wrote this request (mod/init.lua sendRequest); the bridge follows it for the turn.
  const provider = typeof value.provider === 'string' && PROVIDER_NAMES.includes(value.provider) ? value.provider : undefined;
  // Street reputation (docs/REPUTATION_DESIGN.md): sent only while the setting is on, only for an ordinary NPC's private turn.
  const reputation = value.reputation === undefined ? null : parseReputationSnapshot(value.reputation);
  // Eddies with characters (docs/EDDIES.md): sent only while the setting is on, for a private turn V sends (never a group round, a reaction, a call or Johnny in V's head).
  const eddies = value.eddies === undefined || group || reaction || holocall || head ? null : parseEddies(value.eddies, profileKey);
  return {requestId, generation, entity, name: name.slice(0, 120), bodyType: bodyType.slice(0, 80), profileKey, text: text.trim(), group,
    ...(provider ? {provider} : {}), ...(reputation ? {reputation} : {}), ...(eddies ? {eddies} : {}),
    ...(journal ? {journal} : {}), ...(battle ? {battle} : {}), ...(loot ? {loot} : {}), ...(reaction ? {reaction} : {}),
    ...(chauffeurOffer ? {chauffeurOffer} : {}), ...(tacticOffer ? {tacticOffer} : {}),
    ...(followOffer ? {followOffer} : {}), ...(leaveOffer ? {leaveOffer} : {}), ...(homeOffer ? {homeOffer} : {}), ...(reactionOffer ? {reactionOffer} : {}),
    ...(reactionOfferDropped ? {reactionOfferDropped} : {}),
    ...(followUnavailable ? {followUnavailable} : {}), ...(tacticUnavailable ? {tacticUnavailable} : {}), ...(driveUnavailable ? {driveUnavailable} : {}),
    ...(worldKnowledge ? {worldKnowledge} : {}), ...(journalHistory ? {journalHistory} : {}),
    ...(gameDialogue ? {gameDialogue} : {}), ...(gear ? {gear} : {}), ...(turnContext ? {turnContext} : {}),
    ...(addon ? {addon} : {}), ...(holocall ? {holocall} : {}), ...(meetOffer ? {meetOffer} : {}), ...(head ? {head} : {})};
}

// {version: 1, contact, mode: 'audio' | 'holo'} from mod/holocall.lua -> {contact, mode}, or null.
// A journal contact id (letters, digits, underscore) or, for a Chat row with no journal contact, the character's profile key (lowercase, digits, hyphens; up to 80).
const HOLOCALL_CONTACT = /^[A-Za-z0-9_-]{1,80}$/;
export function parseHolocall(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== 1) return null;
  if (typeof value.contact !== 'string' || !HOLOCALL_CONTACT.test(value.contact)) return null;
  if (value.mode !== 'audio' && value.mode !== 'holo') return null;
  return {contact: value.contact, mode: value.mode};
}

// Generic NPC profiles: the two ambient residents and every archetype (npc-*). They have no individual identity:
// sessions are partitioned by the actor entity, save-bound memory and quest knowledge are never attached.
export function isAmbientProfile(key) {
  return key === 'resident-male' || key === 'resident-female' || (typeof key === 'string' && /^npc-[a-z0-9-]+$/.test(key));
}

/**
 * Who a turn is with, for anything the bridge remembers between turns: the profile key for a named character, `<profile>|<entity>` for a generic person.
 * A crowd profile is a template shared by every stranger who uses it, so state kept under the profile alone would pass from one stranger to the next
 * (live 2026-10-27: two female pedestrians, one `resident-female`). The conversation history, the Convai session and the "already told" flags are already
 * keyed by the person (bridge/conversation-knowledge.mjs sessionKey); this is the same rule for the smaller per-profile states (the carried mood).
 * Without a usable entity the profile key is returned, as before.
 */
export function personKey(input) {
  const profile = input?.profileKey;
  return isAmbientProfile(profile) && typeof input.entity === 'string' && /^\d+ULL$/.test(input.entity) ? `${profile}|${input.entity}` : profile;
}

// The archetype facts the adapter sends: fixed vocabulary only (TweakDB enum names, the catalog base and title).
// memoryKey: the record of a one-shop vendor ("wat_kab_ripperdoc_01"), the identity its conversations are remembered under.
const ARCHETYPE_FIELDS = ['base', 'category', 'title', 'affiliation', 'vendorType', 'district', 'area', 'memoryKey'];
const ARCHETYPE_VALUE = /^[A-Za-z0-9][A-Za-z0-9 _.'-]{0,63}$/;
// npcName: the Night City name the game side gave a nameless ordinary NPC (mod/npc-names.lua, docs/NPC_NAMES.md): letters of any
// script, spaces, apostrophes (a street handle sits between them: Rico 'Chrome' Alvarez), hyphens and dots, 60 characters at most.
const NPC_NAME = /^\p{L}[\p{L}\p{M} '.\-]{0,59}$/u;
export function parseArchetype(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const result = {};
  for (const field of ARCHETYPE_FIELDS) {
    if (typeof value[field] === 'string' && ARCHETYPE_VALUE.test(value[field])) result[field] = value[field];
  }
  if (typeof value.npcName === 'string' && NPC_NAME.test(value.npcName.trim())) result.npcName = value.npcName.trim();
  return Object.keys(result).length ? result : null;
}

const AFFILIATION_NAMES = {TygerClaws: 'Tyger Claws', SixthStreet: '6th Street', TheMox: 'the Mox', KangTao: 'Kang Tao',
  VoodooBoys: 'Voodoo Boys', NCPD: 'NCPD', MaelstromAndroid: 'Maelstrom', ScavengersAndroid: 'Scavengers',
  SixthStreetAndroid: '6th Street', WraithsAndroid: 'Wraiths', UnaffiliatedCorpo: 'a private security firm'};
const VENDOR_NAMES = {RipperDoc: 'a ripperdoc clinic', Gunsmith: 'a weapons shop', Food: 'a food and drink counter',
  GrilledFood: 'a street grill', PackedFood: 'a packaged food stall', Drinks: 'a drinks stand', Kiosk: 'a kiosk',
  Market: 'a market stall', Clothing: 'a clothing shop', Clothes: 'a clothes stall', Armorsmith: 'an armored clothing shop',
  Medical: 'a medic shop', Junk: 'a junk shop', TechJunk: 'a tech junk stall', SkillTrainer: 'a specialist shop'};
// "SantoDomingo" -> "Santo Domingo", "Badlands_RockyRidge" -> "Rocky Ridge".
export function placeName(value) {
  if (typeof value !== 'string' || !value) return null;
  const last = value.split('_').filter(Boolean).pop() ?? value;
  return last.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').trim() || null;
}

// Per-turn context for an archetype or resident: what kind of person this is and where. Empty for named characters.
// `place`: Settings > Dynamic info > Location is on (bridge/dynamic-info.mjs); off, the district is left out.
export function archetypeContext(input, {place = true} = {}) {
  if (!input || !isAmbientProfile(input.profileKey)) return '';
  const facts = input.archetype ?? {};
  const lines = [];
  const label = typeof input.name === 'string' && input.name.trim() ? input.name.trim().slice(0, 60) : null;
  if (facts.npcName) {
    // A named passer-by: the same name the scanner shows. It is only a name; nothing about this person is a story.
    lines.push(`Your name is ${facts.npcName}. Say it when someone asks who you are or what to call you, and never change it.`);
    lines.push(facts.title ? `You are an ordinary ${facts.title}, not a story character.` : 'You are an ordinary person, not a story character.');
  } else if (facts.title) lines.push(`You are an unnamed ${facts.title}${label ? `; the game labels you "${label}"` : ''}.`);
  else if (label) lines.push(`The game labels you "${label}". You are an ordinary person, not a story character.`);
  if (facts.category === 'corpo-security' && facts.affiliation) {
    lines.push(`Your employer: ${AFFILIATION_NAMES[facts.affiliation] ?? placeName(facts.affiliation)}.`);
  }
  if (facts.category === 'vendor' && facts.vendorType && VENDOR_NAMES[facts.vendorType]) {
    lines.push(`You work at ${VENDOR_NAMES[facts.vendorType]} here.`);
  }
  const district = placeName(facts.district), area = placeName(facts.area);
  // Said as a fact and no more: "let the place flavor what you say" made every ordinary NPC work the district into its answer (a player report, 2026-10-22).
  if (district && place) lines.push(`Where you are now: ${area && area !== district ? `${area}, ` : ''}${district}. Mention it only when it matters to what V says: never announce the place name or tell V where they are unless V asks, and never invent a specific address.`);
  if (!lines.length) return '';
  return ['CURRENT PERSON (from the game, this conversation only)', ...lines].join('\n');
}
