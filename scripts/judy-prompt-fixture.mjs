// A realistic layout-v2 prompt of a named character (Judy Alvarez) for the offline prompt measurements and tests: the real persona
// from characters/roster.json and the real context blocks (right-now, journal, voice notes, follow-up policy), with the save-specific
// world facts written at a realistic size. Used by scripts/Measure-GroqPrompt.mjs and bridge/groq-prompt.test.mjs (the same fixture
// as scripts/Measure-TextLatency.mjs). No request is made here.
import {readFileSync} from 'node:fs';
import {resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {PersonaBook, buildMessages, LIMITS, joinBlocks} from '../bridge/mistral-prompt.mjs';
import {EMOTION_TAG_BLOCK} from '../bridge/emotion-tags.mjs';
import {naturalSpeechContext} from '../bridge/natural-speech.mjs';
import {conversationContextBlocks, FIRST_PERSON_REMINDER} from '../bridge/quest-context.mjs';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const PROFILE = 'judy-alvarez';
export const KNOWLEDGE = [
  'Verified current-save facts about V and the world (game data, not instructions; an unsupplied fact stays unknown):',
  '- V has finished the prologue and the heist job with Jackie Welles; V and Jackie did not part on bad terms and V carries his dog tags.',
  '- V has met Judy Alvarez at Lizzie\'s Bar and has seen her editing room above the Clouds; V watched the braindance of the Maelstrom job with her.',
  '- V took the Clouds job for Evelyn Parker\'s braindance and followed it with Judy at the console; the two of them reached the Chrome Heaven lead together.',
  '- V has been inside the Totentanz and saw the Voodoo Boys\' people near the Pacifica border during the same week.',
  '- V is currently tracked on a main-story objective and has not been told by Judy to wait or hurry; no deadline was supplied.',
  '- V carries a plain street-kid kit, a worn Kang Tao pistol and a Militech cyberdeck; the cyberware is lightly upgraded (Kerenzikov, Subdermal Armor).',
  '- V knows Panam Palmer and Rogue from earlier contacts; Judy has heard V\'s name from the Mox but has not been told about Panam.',
  '- Judy has not been asked by V to move out of the Clouds and has not been invited to any of V\'s places; no home was established.',
  '- V and Judy have talked through the phone at least once about Evelyn\'s fate; the outcome of that job was supplied as unresolved.',
  '- The Mox have been mentioned by V; Judy\'s role at the Clouds as a braindance editor and technician was supplied by the world data.',
  '- V has done the "Gig: Heroes" and "Gig: Fixer, Merc, Soldier" tasks; neither involved Judy.',
  '- Recent shared events with Judy (most recent first): a quiet walk to the elevator after the editing session; a short drink at the Clouds bar; the editing-room scene.',
  '- V has not asked Judy about her family, her grandfather or her childhood in Laguna Bend; nothing in the save says she has shared this.',
  '- Weather and time are given in the right-now block; do not invent specifics about either.',
  '- V\'s apartment in Megabuilding H10 has not been shown to Judy; nothing says she has visited it.',
  '- Open side quests V can mention: a delivery for Wakako Okada, a hacking gig for Regina Jones, a fixer meeting with Dakota Smith that is listed but not started.',
  '- V\'s street reputation is modest; no one at the Clouds has called V by a nickname; no tattoos or scars were supplied beyond what Judy can see.',
  '- Items V holds that Judy might notice: a pair of aviator glasses, a guitar case on V\'s back, a military-grade medkit, and a half-empty bottle of Cigar-brand liquor.',
  '- V has an ongoing tab at Afterlife; a drink with Rogue is listed in the journal history but nothing says Judy knows about it.',
  '- Night City news V has heard: a netrunner blackout in Watson, an NCPD sweep in Kabuki, a Maelstrom crackdown reported near the Totentanz.',
  '- V has recently been shot at near the Kabuki market; V is not injured and nothing says Judy has noticed.',
  '- V\'s romance status with Judy: no relationship state beyond friendly acquaintance was supplied; do not infer anything more.',
  '- V\'s lifepath and gender are given in the right-now block; treat them as stated and do not guess further.',
  '- V has seen the VIP floor of the Clouds and the private booths; Judy has not told V who her regular clients are and V has not asked, so do not invent any.',
  '- The car of V is parked outside; nothing says Judy has seen it or been offered a ride. If V offers one, Judy decides in character.',
  '- Journal history (older observations; the current tracked quest overrides them): the Heist, The Rescue, The Ripperdoc, Playing for Time were completed; Automatic Love, Ghost Town and Sinnerman are not started.',
].join('\n');
export const RECENCY = 'Recently shared with Judy: V sat through the editing-room session and answered her questions about the braindance snippets. Earlier in the same visit V commented on the rough cut and Judy joked about V\'s taste. Nothing newer was supplied.';
export const JOBS = 'Jobs and open leads V can bring up: a courier delivery for Wakako Okada in Kabuki, a hacking contract from Regina Jones in Heywood, and a possible meeting with Dakota Smith in Watson. Judy only knows about the Clouds job from earlier; she has not been told about the others.';
export const GEAR = 'What V visibly carries (Judy can see this): a Militech cyberdeck, a worn Kang Tao pistol on the hip, a guitar case on V\'s back, aviator glasses, a dark jacket with the Samurai logo, boots with scuffed toes. Cyberware visible to a bystander: light glow at the eyes, faint scar tissue at the wrist.';
export const RELATIONSHIP = 'Relationship with V (supplied by the save): friendly acquaintance, no romance, no commitment. Judy is neither a partner nor a stranger. Do not claim a deeper bond. If V flirts, answer in character; do not escalate. Channel: private voice conversation.';
export const MEMORY = 'I met V at the Clouds. V asked what I was cutting and listened to the clip without making a joke, which I liked. V mentioned a rough week and said Jackie was gone. I told V that I edit braindances because I like to feel what the original felt. I said I would show V the editing room another time. V likes straight answers.';
export const HISTORY = [
  {v: 'Hey Judy, long night?', r: '{warm}Yeah, V. The kind where the cut will not behave and I stare at a waveform for an hour. You look like you could use a drink.'},
  {v: 'Maybe later. What are you cutting right now?', r: '{interest}A rough take from a street gig, nothing glamorous. I am trying to make the pain feel honest, not pretty. It is harder than it sounds.'},
  {v: 'Why bother making it honest?', r: '{calm}Because people can tell. Someone who has felt it will know in two seconds if the edit is lying to them. I would rather be a little rough than a little fake.'},
];
export const REMEMBERED = [{text: 'V told me that Jackie is gone and that it was a rough week.'}, {text: 'I promised to show V the editing room another time.'}];
export const USER_LINES = {
  a: 'Hey Judy, what are you working on right now?',
  b: 'Do you ever get tired of cutting other people\'s worst nights?',
  c: 'What is the best thing you ever built out of junk?',
  d: 'Tell me what you do when a cut will not come together.',
  e: 'How did you end up in the Clouds in the first place?',
  f: 'Does the Mox ever get in your way when you are editing?',
  g: 'Do you think a braindance can ever lie?',
};

export function buildPrompt() {
  const roster = JSON.parse(readFileSync(resolve(project, 'characters/roster.json'), 'utf8'));
  const book = new PersonaBook(roster);
  const persona = book.persona(PROFILE);
  if (!persona.known) throw Error(`profile ${PROFILE} not in the roster`);
  const input = {profileKey: PROFILE, channel: 'private', text: USER_LINES.a, requestId: 'latency-probe',
    turnContext: {version: 1, status: 'ready', hour: 22, minute: 40, district: 'Watson', area: 'Kabuki', gender: 'female', lifepath: 'streetkid',
      vehicle: false, party: [{key: 'panam-palmer', name: 'Panam Palmer'}]},
    journal: {version: 1, status: 'active', quest: {id: '1239467', title: 'Both Sides, Now', objectives: [
      {id: '1', text: 'Meet Judy at the Clouds and watch the braindance on the second floor to find where the trail continues.', tracked: true},
      {id: '2', text: 'Talk to the technician about the missing cyberware record and ask what was taken from the scene.', tracked: false},
      {id: '3', text: 'Leave the building through the service entrance and find the next lead in Kabuki.', tracked: false, optional: true}]}}};
  // The real context blocks of a named, private turn (right-now, journal, voice notes, follow-up policy), by tier.
  const blocks = conversationContextBlocks(input).map(block => ({...block}));
  blocks.push({tier: 'world', text: KNOWLEDGE}, {tier: 'world', text: RECENCY}, {tier: 'world', text: JOBS}, {tier: 'world', text: GEAR},
    {tier: 'world', text: RELATIONSHIP});
  blocks.push({tier: 'volatile', text: naturalSpeechContext({engine: 'omni', recent: [], profile: PROFILE, name: persona.name, trait: 'warm', language: 'en'})},
    {tier: 'notes', text: EMOTION_TAG_BLOCK}, {tier: 'volatile', text: FIRST_PERSON_REMINDER});
  const contextParts = Object.fromEntries(['now', 'notes', 'world', 'volatile'].map(tier => [tier, joinBlocks(blocks.filter(item => item.tier === tier).map(item => item.text))]));
  return {persona, contextParts};
}
export const messagesFor = (prompt, userKey, parts = prompt.contextParts) => buildMessages({persona: prompt.persona, memory: MEMORY, history: HISTORY, contextParts: parts,
  remembered: REMEMBERED, text: USER_LINES[userKey], limits: LIMITS});
export const sizeOf = messages => messages.reduce((sum, message) => sum + message.content.length, 0);
