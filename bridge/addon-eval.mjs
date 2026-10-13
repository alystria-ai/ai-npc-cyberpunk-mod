// Offline evaluation of an add-on speaker (docs/ADDON_API.md, "Evaluating a speaker"). A script is a scripted sequence of game
// events and things V says; each step is answered by the same prompt, persona (mode), recent-lines and memory blocks, trigger and
// text host the bridge uses in the game, and a repeated remark is dropped the same way. An optional LLM judge scores each line
// against a rubric (in character, fun, fits the moment, short, fresh). Nothing here touches the game, Convai or the player's memory:
// the memory store and the journal live in memory only.
//
// Script (JSON):
//   {"speaker": "gun", "mode": "killer", "memories": ["..."], "context": "V is in a Watson back alley at night.",
//    "steps": [{"event": "first-kill", "text": "V killed the first enemy.", "facts": {"weapon": "Skippy"}, "maxWords": 10,
//               "blocks": [{"key": "fight", "text": "Four Tyger Claws.", "tier": "volatile"}], "mode": "puppy",
//               "expect": "relieved it was quick"},
//              {"say": "Skippy, how many left?"}]}
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {ADDON_MANIFEST, AddonHost, fixedProvider, sampleLine, sharedMemory, validateManifest} from './addons.mjs';
import {PersonaBook, joinBlocks} from './mistral-prompt.mjs';
import {TextProviderHost, mistralRoute} from './text-provider-host.mjs';
import {MistralMemory} from './mistral-memory.mjs';
import {DEFAULT_MODELS} from './mistral-client.mjs';

const TIERS = ['now', 'notes', 'world', 'volatile'];

/** Checks a script and returns it normalised, or throws naming what is wrong. */
export function parseScript(raw) {
  const value = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('a script is a JSON object');
  if (typeof value.speaker !== 'string') throw Error('script.speaker names the speaker id');
  if (!Array.isArray(value.steps) || !value.steps.length || value.steps.length > 60) throw Error('script.steps lists 1 to 60 steps');
  const steps = value.steps.map((step, index) => {
    if (!step || typeof step !== 'object') throw Error(`step ${index + 1} must be an object`);
    if (typeof step.event === 'string' === (typeof step.say === 'string')) throw Error(`step ${index + 1} has either "event" or "say"`);
    return {event: step.event ?? null, say: step.say ?? null, text: typeof step.text === 'string' ? step.text : null,
      facts: step.facts && typeof step.facts === 'object' ? step.facts : null, maxWords: Number.isInteger(step.maxWords) ? step.maxWords : 14,
      blocks: Array.isArray(step.blocks) ? step.blocks : [], mode: typeof step.mode === 'string' ? step.mode : null,
      expect: typeof step.expect === 'string' ? step.expect : ''};
  });
  return {speaker: value.speaker, mode: typeof value.mode === 'string' ? value.mode : null, context: typeof value.context === 'string' ? value.context : '',
    memories: Array.isArray(value.memories) ? value.memories.filter(item => typeof item === 'string') : [], steps};
}

const JUDGE_RUBRIC = `You judge one spoken line from a character in a Cyberpunk 2077 mod, strictly. Score it from 1 to 10 against this rubric:
- in character: it sounds like the persona and mode described, never like an assistant;
- fun: it is witty, surprising or charming, something a player would want to hear again;
- fits: it reacts to the event or V's words, and every number, name and fact in it comes from the facts given (a wrong or invented number is a failure);
- short: it is one spoken line within the word limit, no narration, stage directions or asterisks;
- fresh: it does not repeat the character's earlier lines, their jokes or their wording, and it is not one of the character's example lines or a close copy of one (a copied example scores 3 at most).
Scale: 5 is filler, a line that is fine but forgettable; 7 is genuinely good; 9 and 10 are rare. Most lines are 4 to 6.
Answer with JSON only: {"score": <1-10>, "inCharacter": <true|false>, "fresh": <true|false>, "notes": "<one short sentence>"}`;

/**
 * An LLM judge on Mistral. `chat` is streamChat (or a stand-in), `apiKey` the key, `model` the judge model (default the largest
 * of the default models). Returns async ({speaker, mode, step, line, previous}) => {score, inCharacter, fresh, notes}. The judge
 * sees the speaker's example lines (to catch a copy) and the facts of the event in full (to catch a wrong number).
 */
export function llmJudge({chat, apiKey, model = DEFAULT_MODELS[1]}) {
  return async ({speaker, mode, step, line, previous}) => {
    const examples = (mode?.samples?.length ? mode.samples : speaker.persona.samples).map(sample => sampleLine(sample, speaker.name)).filter(Boolean);
    const brief = [`Character: ${speaker.name}.`, `Persona: ${speaker.persona.backstory}`,
      mode ? `Mode "${mode.name}": ${mode.style}` : `Style: ${speaker.persona.style}`,
      examples.length ? `The character's example lines (already used up; a copy is a failure):\n${examples.map(item => `- ${item}`).join('\n')}` : '',
      step.event ? `Game event: ${step.text ?? step.event}${step.facts ? `\nFacts (the only numbers and names the line may use): ${JSON.stringify(step.facts)}` : ''}` : `V said: ${step.say}`,
      `Word limit: ${step.maxWords}.`, step.expect ? `The script author hoped for: ${step.expect}` : '',
      previous.length ? `Earlier lines:\n${previous.map(item => `- ${item}`).join('\n')}` : 'No earlier lines.', `The line: ${line}`].filter(Boolean).join('\n');
    const response = await chat({apiKey, model, temperature: 0, maxTokens: 200, retries: 1,
      messages: [{role: 'system', content: JUDGE_RUBRIC}, {role: 'user', content: brief}], extraBody: {response_format: {type: 'json_object'}}});
    try {
      const verdict = JSON.parse(String(response.text).replace(/^```(?:json)?|```$/g, '').trim());
      const score = Math.max(1, Math.min(10, Number(verdict.score) || 1));
      return {score, inCharacter: verdict.inCharacter !== false, fresh: verdict.fresh !== false, notes: String(verdict.notes ?? '').slice(0, 300)};
    } catch { return {score: null, inCharacter: null, fresh: null, notes: 'the judge did not answer with JSON'}; }
  };
}

/**
 * Runs a script against an add-on folder. `chat` answers the speaker's requests (streamChat with `apiKey`, or a stand-in in tests);
 * `judge` (optional) scores each line. Returns {addon, speaker, steps: [{index, event, say, mode, line, words, duplicate, similar,
 * prompt?, verdict?}], average, duplicates}. `keepPrompts` adds each step's full prompt (the messages) to its result.
 */
export async function evaluateScript({addonDir, script, chat, apiKey = 'offline-evaluation', judge = null, models = DEFAULT_MODELS,
  keepPrompts = false, log = () => {}}) {
  const dir = resolve(addonDir);
  const manifest = validateManifest(JSON.parse((await readFile(resolve(dir, ADDON_MANIFEST), 'utf8')).replace(/^﻿/, '')), dir);
  const plan = parseScript(script);
  const speaker = manifest.speakers.find(item => item.id === plan.speaker);
  if (!speaker) throw Error(`add-on ${manifest.id} has no speaker ${plan.speaker}`);
  const host = new AddonHost({addons: [manifest], log, startedAt: 0});
  await host.loadModules();
  const roster = [];
  host.extend(roster, {});
  for (const memory of plan.memories) host.remember(speaker.profileKey, memory);
  if (plan.mode) host.setMode(speaker.profileKey, plan.mode);
  const prompts = [];
  const capture = async options => { prompts.push(options.messages); return chat(options); };
  const provider = {apiKey, noteSuccess() {}, noteLimit() {}, limit: null};
  const text = new TextProviderHost({provider: fixedProvider(provider, 'mistral'), memory: sharedMemory(await MistralMemory.open({path: null})),
    personas: new PersonaBook(roster), routes: {mistral: mistralRoute({provider, chat: capture, gapMs: 0, model: () => models})}, log});
  const results = [];
  for (const [index, step] of plan.steps.entries()) {
    const remark = step.event !== null;
    const input = {requestId: `eval-${index}`, profileKey: speaker.profileKey, name: speaker.name, text: step.say ?? step.text ?? step.event,
      reaction: remark ? {kind: 'addon', addon: manifest.id, speaker: speaker.id, event: step.event, priority: 3, expiresAt: 0, maxWords: step.maxWords} : null,
      addon: {id: manifest.id, speaker: speaker.id, ...(remark ? {event: step.event, text: step.text ?? undefined, facts: step.facts ?? undefined,
        maxWords: step.maxWords} : {}), ...(step.mode ? {mode: step.mode} : {}), blocks: step.blocks}};
    host.beginTurn(input);
    const blocks = [...(plan.context ? [{tier: 'now', text: plan.context}] : []), ...host.blocks(input)];
    const contextParts = {...Object.fromEntries(TIERS.map(tier => [tier, joinBlocks(blocks.filter(item => item.tier === tier).map(item => item.text))])),
      worldBlocks: blocks.filter(item => item.tier === 'world' && item.text).map(item => ({key: item.key, text: item.text}))};
    const previous = host.recentLines(speaker.profileKey);
    const before = prompts.length;
    const reply = await text.reply({text: remark ? host.trigger(input) : input.text, reaction: input.reaction, context: joinBlocks(blocks.map(item => item.text)),
      contextParts, local: {profileKey: speaker.profileKey, name: speaker.name, channel: 'private'}});
    const line = reply.text;
    const review = host.review(input, line);
    if (!review.duplicate) host.afterReply(input, line);
    const mode = host.modeOf(speaker.profileKey);
    const entry = {index: index + 1, event: step.event, say: step.say, mode: mode?.id ?? null, line, words: line.split(/\s+/).filter(Boolean).length,
      duplicate: review.duplicate, similar: review.similar, ...(keepPrompts ? {prompt: prompts.slice(before).at(-1)} : {})};
    if (judge && !review.duplicate) {
      try { entry.verdict = await judge({speaker, mode, step, line, previous}); } catch (error) { entry.verdict = {score: null, notes: `judge failed: ${error.message}`}; }
    }
    results.push(entry);
  }
  const scores = results.map(item => item.verdict?.score).filter(Number.isFinite);
  return {addon: manifest.id, speaker: speaker.id, steps: results, duplicates: results.filter(item => item.duplicate).length,
    average: scores.length ? Math.round(scores.reduce((sum, value) => sum + value, 0) / scores.length * 10) / 10 : null};
}
