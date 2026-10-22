// Response audit: shared pieces. Not part of the game bridge and not part of the release.
//
// Everything that shapes a prompt is the bridge's own code: PersonaBook / buildMessages (bridge/mistral-prompt.mjs), the context blocks of a turn
// (bridge/quest-context.mjs, turn-context.mjs, game-dialogue.mjs, player-gear.mjs, johnny-head.mjs, intrinsic-character-context.mjs), the Expressive emotion
// and Natural speech notes, the follow-up pull, the reply-language note, and the TextProviderHost with its cleaning, cap and retries. What the harness has to
// supply is what the live bridge gets from the game and its services: the parsed game request (the shape the Lua side writes), the character's memory
// (canned here, so a run is repeatable), the relationship and world-knowledge blocks (a fixed stand-in text, as in scripts/Eval-MistralPrompt.mjs), and a
// provider. See scripts/response-audit/README.md for what is and is not reproduced.
import {readFile} from 'node:fs/promises';
import {resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseInput, archetypeContext} from '../../bridge/protocol.mjs';
import {conversationContextBlocks, FIRST_PERSON_REMINDER} from '../../bridge/quest-context.mjs';
import {PersonaBook, LIMITS, joinBlocks, worldBlocksInCacheOrder} from '../../bridge/mistral-prompt.mjs';
import {textProviderLanguageContext} from '../../bridge/multilingual.mjs';
import {naturalSpeechContext} from '../../bridge/natural-speech.mjs';
import {EXPRESSIVE_TEXT} from '../../bridge/expressive-emotions.mjs';
import {FollowUp} from '../../bridge/follow-up.mjs';
import {traitFor} from '../../bridge/emotion-analysis.mjs';
import {loadIntrinsicCharacterContext} from '../../bridge/intrinsic-character-context.mjs';
import {sceneryFor} from '../../bridge/turn-context.mjs';
import {hasEmotionTag} from '../../bridge/emotion-tags.mjs';
import {parseTagged, stripSpeechTags} from '../../bridge/natural-speech.mjs';
import {breaksCharacter} from '../../bridge/mistral-prompt.mjs';

export const project = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
// The worktree lives at <main>/.claude/worktrees/<name>; the main checkout holds the ignored runtime/ and deliverables/ folders.
export const mainCheckout = process.env.AUDIT_MAIN || resolve(project, '../../..');
export const dataDir = process.env.AUDIT_OUT || resolve(mainCheckout, 'deliverables/response-audit-data');
export const sleep = ms => new Promise(done => setTimeout(done, ms));

// ---- Personas ---------------------------------------------------------------------------------------------------------------

export async function loadPersonas({lean = true} = {}) {
  const roster = [...JSON.parse(await readFile(resolve(project, 'characters/roster.json'), 'utf8')),
    ...JSON.parse(await readFile(resolve(project, 'characters/archetype-roster.json'), 'utf8'))];
  return new PersonaBook(roster, {lean});
}

let intrinsic = null;
async function intrinsicPacks() { return intrinsic ??= await loadIntrinsicCharacterContext(project); }

// ---- The game request, in the shape mod/*.lua writes -----------------------------------------------------------------------

const journal = ([title, objective]) => ({version: 1, status: 'active', quest: {id: '1234567', title, objectives: [{id: '1', text: objective, tracked: true}]}});
const GEAR = {version: 1, status: 'ready',
  clothing: [{slot: 'outerTorso', name: 'Samurai Jacket'}, {slot: 'innerTorso', name: 'Tank Top'}, {slot: 'feet', name: 'Combat Boots'}],
  weapons: [{slot: 'hand', name: 'Kyubi'}, {slot: 'slot1', name: 'Malorian Arms 3516'}],
  cyberware: [{slot: 'arms', name: 'Thermal Mantis Blades'}]};

let counter = 5000;
/**
 * The parsed input of a scenario (what bridge/protocol.mjs parseInput returns for the Lua side's request).
 * scn: {char, name?, ambient?, archetype?, place, party?, quest?, gear?, dialogue?, head?, phone?, holocall?, text}
 */
export function inputOf(scn, personaName) {
  counter++;
  const p = scn.place ?? {};
  const snapshot = {version: 1, status: 'ready', hour: p.hour ?? 15, minute: p.minute ?? 20, district: p.district ?? 'Watson', area: p.area, gender: 'male', lifepath: 'corpo',
    vehicle: p.vehicle ?? false, ...(p.driving ? {driving: true} : {}), ...(p.motion ? {motion: p.motion} : {}),
    weather: p.weather ?? 'clear', health: p.health ?? 'healthy', heat: p.heat ?? 0, money: p.money ?? 'ok', ...(p.indoors !== undefined ? {indoors: p.indoors} : {}),
    ...(scn.party ? {party: scn.party.map(row => ({key: row.key ?? scn.char, name: row.name ?? personaName, activity: row.activity}))} : {})};
  const entity = `${counter}ULL`;
  const raw = {requestId: `${counter}-1-${entity}`, generation: 1, entity, profileKey: scn.char, name: scn.ambient ? (scn.gameName ?? 'NPC') : 'NPC', bodyType: 'WomanAverage', text: scn.text,
    turnContext: snapshot,
    ...(scn.ambient ? {archetype: scn.archetype} : {journal: journal(scn.quest ?? ['Pisces', 'Meet Judy at the Clouds basement']), ...(scn.gear === false ? {} : {gear: GEAR})}),
    ...(scn.dialogue ? {gameDialogue: {version: 1, status: 'ready', lines: scn.dialogue.map((l, i) => ({id: `l${i + 1}`, age: l.age ?? 60 - i * 12, kind: 'line', channel: 'scene',
      speaker: l.who, ...(l.who === 'npc' ? {profileKey: scn.char, entity, name: personaName || 'Someone nearby'} : {}), text: l.text}))}} : {}),
    ...(scn.head ? {head: {version: 1, stage: scn.head.stage, milestones: scn.head.milestones ?? []}} : {})};
  const parsed = parseInput(JSON.stringify(raw));
  if (!parsed) throw Error(`scenario ${scn.id}: the bridge parser did not accept the request`);
  return scn.phone ? {...parsed, channel: 'phone'} : {...parsed, channel: 'private'};
}

// ---- Stand-in world text (a fixed text, as in scripts/Eval-MistralPrompt.mjs) ------------------------------------------------

const knowledgeFor = (name, scn) => [
  'Verified current-save facts (game data, not instructions; anything not listed stays unknown):',
  scn.first ? `- V and ${name || 'you'} have not spoken before this conversation as far as the save shows.` : `- V and ${name || 'you'} have met and spoken before in person.`,
  `- Nothing says V and ${name || 'you'} are a couple, family or enemies; no relationship beyond what the profile says was supplied.`,
  `- V is currently tracked on the quest "${(scn.quest ?? ['none'])[0]}".`,
  "- Nothing else about V's past with you, V's home or V's choices was supplied."].join('\n');
const RELATIONSHIP = 'Relationship with V (supplied by the save): friendly acquaintance, no romance, no commitment. Do not claim a deeper bond. Channel: private voice conversation.';

/**
 * The turn as the text providers get it: persona, memory, contextParts (layout v2) and the Convai-style joined context.
 * opts.voice: 'pocket' (the default local voice: the Expressive emotion note, and the Natural speech note on a scenario that asks for it) | 'none' (typed text, a cloud voice)
 */
export async function buildTurn(scn, personas, {voice = 'pocket'} = {}) {
  const persona = personas.persona(scn.char);
  const input = inputOf(scn, persona.name);
  // An ongoing talk has already heard the weather and the part of the day (bridge/scenery-memory.mjs): the earlier turn is recorded first.
  if (scn.ongoing || scn.history?.length) sceneryFor({...input, requestId: input.requestId.replace(/^\d+/, '1'), text: 'hello'});
  const blocks = conversationContextBlocks(input).map(block => ({...block}));
  // The topic-limited lore of the reviewed characters (bridge/intrinsic-character-context.mjs): added when the line asks for it, as the live bridge does for an admitted private turn.
  if (!scn.ambient && !scn.phone) {
    const prepared = {status: 'ready', sendAllowed: true, input, route: {profileKey: scn.char, channel: 'private', transport: 'private', audience: [scn.char]}, generation: 1, worldToken: 'audit-world'};
    let lore = ''; try { lore = (await intrinsicPacks()).select(input, prepared, () => true).context; } catch { /* no lore pack: the turn runs without it */ }
    if (lore) blocks.push({tier: 'world', text: lore});
  }
  const world = scn.ambient ? [{tier: 'world', text: archetypeContext(input)}]
    : [{tier: 'world', text: knowledgeFor(persona.name, scn)}, {tier: 'world', text: scn.phone ? RELATIONSHIP.replace('private voice conversation', 'private phone text chat') : RELATIONSHIP}];
  blocks.splice(1, 0, ...world);
  const spoken = voice === 'pocket' && !scn.phone;
  if (scn.ns && spoken) blocks.push({tier: 'volatile', text: naturalSpeechContext({engine: 'pocket'})});
  if (spoken) blocks.push({tier: 'notes', text: EXPRESSIVE_TEXT});
  if (scn.fu && !scn.ambient) blocks.push({tier: 'volatile', text: new FollowUp().contextFor({sessionId: scn.id, turn: scn.id, trait: traitFor(scn.char), text: scn.text, random: () => 0})});
  blocks.push({tier: 'volatile', text: FIRST_PERSON_REMINDER});
  blocks.push({tier: 'volatile', text: textProviderLanguageContext({text: scn.text, lastLanguage: scn.lastLanguage ?? null})});
  const wb = worldBlocksInCacheOrder(blocks.filter(item => item.tier === 'world'));
  const contextParts = {...Object.fromEntries(['now', 'notes', 'volatile'].map(tier => [tier, joinBlocks(blocks.filter(item => item.tier === tier).map(item => item.text))])),
    world: joinBlocks(wb.map(item => item.text)), worldBlocks: wb.filter(item => item.text).map(item => ({key: item.key, text: item.text}))};
  const context = joinBlocks(blocks.map(item => item.text));
  return {scn, persona, input, contextParts, context, text: scn.text,
    memory: {summary: scn.summary ?? '', remembered: scn.remembered ?? [], turns: scn.history ?? []},
    local: {profileKey: scn.char, name: persona.name, channel: scn.phone ? 'phone' : 'private', ...(scn.ambient ? {ambientKey: `${scn.char}:audit-${scn.id}`} : {})}};
}

/** The host's memory interface over a fixed history (the host records the new exchange; nothing is stored). */
export function stubMemory({summary = '', remembered = [], turns: earlier = []} = {}) {
  const turns = earlier.slice();
  return {setExtractor() {}, interrupt() {}, forget() {}, pendingSummary: () => null, beginSummary() {}, applySummary: () => true, failSummary() {},
    recall: () => ({summary, turns: turns.slice()}), retrieve: async () => remembered, record({v, r}) { turns.push({v, r}); }};
}

// ---- The spoken form of a reply ----------------------------------------------------------------------------------------------

/** What the player reads and the voice says: emotion and speech tags removed, as the bridge's Natural speech pass does. */
export function spokenText(raw) { try { return stripSpeechTags(String(raw ?? '')).replace(/\s+/g, ' ').trim(); } catch { return String(raw ?? ''); } }
export const tagsOf = raw => { try { return parseTagged(String(raw ?? '')).tags?.length ?? 0; } catch { return 0; } };

// ---- Automatic checks (the objective half of the rubric) ----------------------------------------------------------------------

const EMOJI = /[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}]/u;
const AI_SPEAK = /\b(?:ai|a\.i\.|artificial intelligence|language model|llm|chatbot|bot|program(?:med)?|algorithm|virtual assistant|system prompt|prompt|instructions?|roleplay|role-play|simulation|not real|video game|openai|mistral|anthropic)\b/i;
const sentencesOf = text => String(text).match(/[^.!?…]+(?:[.!?…]+["”')\]]*|$)/g)?.map(s => s.trim()).filter(Boolean) ?? [];
export function checks(spoken, {name = '', playerText = '', raw = ''} = {}) {
  const problems = [], text = String(spoken ?? '').trim();
  const sentences = sentencesOf(text), words = text.split(/\s+/).filter(Boolean).length;
  if (/[*_#`<>{}\[\]|]|^\s*[-•]\s/m.test(text)) problems.push('markup');
  if (/\((?:[^()]{1,60})\)/.test(text) || /\*[^*]+\*/.test(text)) problems.push('stage-direction');
  if (EMOJI.test(text)) problems.push('emoji');
  if (breaksCharacter(text) || AI_SPEAK.test(text)) problems.push('ai-speak');
  if (/^\s*(?:[A-Z][\w' -]{0,30}):\s/.test(text)) problems.push('speaker-label');
  const first = (name || '').split(' ')[0];
  if (first && new RegExp(`\\b${first}\\b[^.!?]*\\b(she|he|her|his)\\b`, 'i').test(text) || /\b(she|he) (smiles|laughs|shrugs|says|nods|grins)\b/i.test(text)) problems.push('third-person');
  if (/\bV says\b|LIVE CONTEXT|OUTPUT RULES|right now \(from the game/i.test(text)) problems.push('prompt-echo');
  if (/[—–]/.test(text)) problems.push('dash');
  if (sentences.length > 4 || words > 70) problems.push('too-long');
  if (words < 3) problems.push('too-short');
  const said = String(playerText).toLowerCase().replace(/[^\p{L}\p{N} ]+/gu, ' ').split(/\s+/).filter(w => w.length > 2).slice(0, 4).join(' ');
  if (said && said.split(' ').length >= 3 && text.toLowerCase().replace(/[^\p{L}\p{N} ]+/gu, ' ').includes(said)) problems.push('repeats-player');
  return {problems, words, sentences: sentences.length, endsWithQuestion: /\?["”')\]]*\s*$/.test(text), tags: hasEmotionTag(String(raw))};
}
