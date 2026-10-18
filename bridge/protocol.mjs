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
import {resolveKnowledgeParts} from './knowledge-parts.mjs';
import {parseChauffeurOffer, parseTacticOffer, parseFollowOffer, parseLeaveOffer, parseFollowUnavailable, parseTacticUnavailable, parseDriveUnavailable}
  from './companion-actions.mjs';

export function profileFor(input, roster) {
  return roster.find(profile => profile.key === input.profileKey);
}

// A game request, plus the optional archetype facts of an unnamed NPC (docs/NPC_ARCHETYPES.md).
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
  const reaction = value.reaction?.kind === 'addon' ? parseAddonReaction(value.reaction, addon) : parseReaction(value.reaction, battle, loot);
  if (reaction === null) return null;
  // A malformed optional offer removes only gameplay admission; the original
  // conversation is still valid and must keep its actor/request identity.
  const chauffeurOffer = parseChauffeurOffer(value.chauffeurOffer);
  const tacticOffer = parseTacticOffer(value.tacticOffer);
  // Party membership offers (docs/WORLD_COMPANIONS.md): join V, leave V's party, or why joining is refused.
  const followOffer = parseFollowOffer(value.followOffer), leaveOffer = parseLeaveOffer(value.leaveOffer);
  const followUnavailable = parseFollowUnavailable(value.followUnavailable);
  const tacticUnavailable = parseTacticUnavailable(value.tacticUnavailable);
  const driveUnavailable = chauffeurOffer ? null : parseDriveUnavailable(value.driveUnavailable);
  // A holocall turn (docs/HOLOCALL.md): V and the character talk over the phone. Private turns only; a malformed value is dropped.
  const holocall = group ? null : parseHolocall(value.holocall);
  const scripted = group ? null : parseScripted(value.scripted);
  return {requestId, generation, entity, name: name.slice(0, 120), bodyType: bodyType.slice(0, 80), profileKey, text: text.trim(), group,
    ...(journal ? {journal} : {}), ...(battle ? {battle} : {}), ...(loot ? {loot} : {}), ...(reaction ? {reaction} : {}),
    ...(chauffeurOffer ? {chauffeurOffer} : {}), ...(tacticOffer ? {tacticOffer} : {}),
    ...(followOffer ? {followOffer} : {}), ...(leaveOffer ? {leaveOffer} : {}),
    ...(followUnavailable ? {followUnavailable} : {}), ...(tacticUnavailable ? {tacticUnavailable} : {}), ...(driveUnavailable ? {driveUnavailable} : {}),
    ...(worldKnowledge ? {worldKnowledge} : {}), ...(journalHistory ? {journalHistory} : {}),
    ...(gameDialogue ? {gameDialogue} : {}), ...(gear ? {gear} : {}), ...(turnContext ? {turnContext} : {}),
    ...(addon ? {addon} : {}), ...(holocall ? {holocall} : {}), ...(scripted ? {scripted} : {})};
}

// Development only (bridge/scripted-line.mjs): {file} names a JSON file holding the exact line to speak. Absent for every ordinary turn;
// the bridge ignores it unless Developer mode is on.
function parseScripted(value) {
  if (!value || typeof value !== 'object' || typeof value.file !== 'string') return null;
  const file = value.file;
  return file.length > 0 && file.length <= 520 && /\.json$/i.test(file) && !/[\u0000-\u001f]/.test(file) ? {file} : null;
}

// {version: 1, contact, mode: 'audio' | 'holo'} from mod/holocall.lua -> {contact, mode}, or null.
const HOLOCALL_CONTACT = /^[A-Za-z0-9_]{1,64}$/;
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
export function archetypeContext(input) {
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
  if (district) lines.push(`Where you are now: ${area && area !== district ? `${area}, ` : ''}${district}. Let the place flavor what you say, without inventing a specific address.`);
  if (!lines.length) return '';
  return ['CURRENT PERSON (from the game, this conversation only)', ...lines].join('\n');
}
