// The two live cases of 2026-10-27 as exact prompts, built with the bridge's own modules (no game needed): the clothes case (Alex, the suit then nude) and the drinks case
// (Claire Russell, Flesh and Chrome drinks stage 3). docs/FRESH_FACTS.md has the measurements. Run through scripts/fresh-facts-eval/run.mjs.
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {parseInput} from '../../bridge/protocol.mjs';
import {conversationContextBlocks} from '../../bridge/quest-context.mjs';
import {gearSeen} from '../../bridge/player-gear.mjs';
import {gearMemory} from '../../bridge/gear-memory.mjs';
import {sceneryMemory} from '../../bridge/scenery-memory.mjs';
import {dynamicInfo} from '../../bridge/dynamic-info.mjs';
import {PersonaBook, buildMessages, joinBlocks, worldBlocksInCacheOrder, freshParts} from '../../bridge/mistral-prompt.mjs';
import {defaultProfile} from '../../bridge/prompt-profiles.mjs';

const here = path => fileURLToPath(new URL(path, import.meta.url));
const roster = JSON.parse(readFileSync(here('../../characters/roster.json'), 'utf8'));
const personas = new PersonaBook(roster, {lean: true});

// The same split the bridge makes (contextPartsOf in bridge/convai-bridge.mjs).
export const contextPartsOf = blocks => {
  const world = worldBlocksInCacheOrder(blocks.filter(item => item.tier === 'world'));
  return {...Object.fromEntries(['now', 'notes', 'volatile'].map(tier => [tier, joinBlocks(blocks.filter(item => item.tier === tier).map(item => item.text))])),
    world: joinBlocks(world.map(item => item.text)), worldBlocks: world.filter(item => item.text).map(item => ({key: item.key, text: item.text})), ...freshParts(blocks)};
};

const clothes = rows => rows.map(([slot, name]) => ({slot, name}));
export const GEAR = {
  suited: () => ({version: 1, status: 'ready', clothing: clothes([['face', "Johnny's aviators"], ['outfit', "Aguilar's suit"]]), weapons: [{slot: 'hand', name: 'Malorian Arms 3516'}], cyberware: [{slot: 'eyes', name: 'Kiroshi Optics'}]}),
  nude: () => ({version: 1, status: 'ready', clothing: clothes([['face', "Johnny's aviators"]]), weapons: [{slot: 'hand', name: 'Malorian Arms 3516'}], cyberware: [{slot: 'eyes', name: 'Kiroshi Optics'}], nudity: 'nude'}),
};
dynamicInfo.update({dynamicInfo: {mods: true}});   // Settings > Dynamic info > Other mods' state is on, as in the live test
const SNAPSHOT = {version: 1, status: 'ready', hour: 22, minute: 10, district: 'Watson', weather: 'clear', gender: 'female', party: [], health: undefined};
let serial = 0;
const turn = (profileKey, name, text, extra = {}) => parseInput(JSON.stringify({requestId: `${900 + ++serial}-1-77ULL`, generation: 1, entity: '77ULL', profileKey, name, bodyType: 'WomanAverage', text,
  turnContext: SNAPSHOT, ...extra}));

function messagesFor(input, history, {profile = 'local-lite', mature = null} = {}) {
  const blocks = conversationContextBlocks(input);
  const persona = personas.persona(input.profileKey, input.name);
  const messages = buildMessages({persona, history, context: joinBlocks(blocks.map(item => item.text)), contextParts: contextPartsOf(blocks), text: input.text, profile: defaultProfile(profile), ...(mature ? {mature} : {})});
  return {messages, blocks, input};
}

/**
 * Alex: the suit was described a turn ago (the old reply is in the history), V is now naked and asks. `text`: what V says. `later`: V stripped a turn ago and Alex answered wrongly
 * (the second live miss: "You're still standing there in that suit"); the nude gear was told and committed, so this turn has no change note.
 */
export function clothesCase(text, {later = false, ...options} = {}) {
  gearMemory.clear(); sceneryMemory.clear();
  const first = turn('alex', 'Alex', 'what am i wearing?', {gear: GEAR.suited()});
  messagesFor(first, []);               // the first turn is built (it opens the conversation's memories)
  gearSeen(first, gearMemory);          // and its reply was published
  const history = [{v: 'hey alex, how is the night so far?', r: "Quiet. I'll take quiet. You look like you've got somewhere to be."},
    {v: 'what am i wearing?', r: "That's Aguilar's suit, right? You're standing there in it like it's armor. Sharp, I'll give you that."}];
  if (later) {
    const middle = turn('alex', 'Alex', 'i just took everything off, what am i wearing now?', {gear: GEAR.nude()});
    messagesFor(middle, history);
    gearSeen(middle, gearMemory);
    history.push({v: 'i just took everything off, what am i wearing now?', r: "You're standing there in that suit like it's armor. Same as before, and it still works on you."});
  }
  const second = turn('alex', 'Alex', text, {gear: GEAR.nude()});
  return {...messagesFor(second, history, options), history, later, facts: {removed: ["Aguilar's suit"], now: "completely naked, with only Johnny's aviators on"}};
}

/** Claire Russell: V has had a lot to drink (Flesh and Chrome drinks stage 3) and asks if V seems drunk. */
export function drinksCase(text, options) {
  gearMemory.clear(); sceneryMemory.clear();
  const history = [{v: 'hey claire, busy night?', r: 'Never stops. What can I get you?'}, {v: 'another round please', r: 'Coming up. You sure you want another?'}];
  const input = turn('claire-russell', 'Claire Russell', text, {turnContext: {...SNAPSHOT, mods: {fleshAndChrome: {drinks: 3}}, facRead: 'installed=yes read=ok state=breath0,energy0,drinks3,smoke0'}});
  return {...messagesFor(input, history, options), history, facts: {drinks: 3}};
}
