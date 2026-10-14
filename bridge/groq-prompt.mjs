// A smaller prompt for Groq's free plan (docs/LATENCY_2026-10-14.md; docs/FREE_CLOUD_OPTION_RESEARCH.md for the plan's limits).
//
// Groq's free plan allows 8,000 tokens a minute per model. A named character's prompt is 6,000 to 7,000 tokens (Judy: 28,750
// characters), so the second Groq reply within a minute was refused and the turn went to Mistral (slower, and a failed call first).
// This module makes the Groq route's prompt smaller by shaping the arguments `buildMessages` takes, before the token budget
// (bridge/prompt-budget.mjs) trims what is left in its fixed priority order. Nothing here touches another provider: the shaping lives in
// the Groq route's `chat` wrapper only, and `buildMessages` itself is unchanged, so the prompt of Mistral and of the local AI stays
// byte for byte what it was (bridge/groq-prompt.test.mjs holds the hashes).
//
// What is cut, and what never is:
//   - the persona's "Scope:" lines. Each item of the shipped profile's topic material is followed by a line that says what the item does
//     NOT establish. They guard a small model against over-claiming and are the least valuable tokens of the persona (20% of a named
//     character's backstory); the facts they qualify stay, and the section's own disclaimer paragraph stays.
//   - the topic material beyond its first items (the profile lists them in order of importance), at a paragraph boundary.
//   - the example lines beyond the first six (the repeat guard still sees all of them: it reads the persona the host holds, not this copy).
//   - conversation history beyond the last four exchanges, each line a little shorter; the older-talk summary and the retrieved memories
//     a little shorter.
//   Never touched: who the character is (name, intro, style, relationships, knowledge limits, appearance), the output rules, the format
//   notes, the right-now block, the world facts (the budget trims those by priority, and only when the prompt is still over the target) and
//   the player's words.
// The result is deterministic for a character, so the early part of the prompt is identical from turn to turn (Groq caches a stable prefix on
// gpt-oss and does not count cached tokens against the limit).
import {LIMITS} from './mistral-prompt.mjs';

export const GROQ_COMPACT = Object.freeze({
  topicChars: 2000,     // the topic-material section, after its Scope lines are gone, keeps its first paragraphs up to about this many characters
  samples: 6,           // example lines kept
  turns: 4,             // exchanges of history
  userLine: 300,
  replyLine: 420,
  summary: 900,
  remembered: 700,
});
// The prompt the route aims for, as a request budget in the budget's own estimate (3.6 characters a token, about 15% above the real count of 4.2):
// prompt + reply reserve + margin, about 3,800 real tokens a prompt, so two Groq turns fit in a minute. A prompt that cannot reach it keeps the plan's hard limit (GROQ_REQUEST_TOKENS) as before.
export const GROQ_SOFT_TOKENS = 4900;

const TOPIC_HEADER = /^PUBLIC INTRINSIC TOPIC MATERIAL[ \t]*$/m;
const NEXT_HEADER = /^[A-Z][A-Z ,'()-]{5,}$/m;

/** The backstory without its "Scope:" lines, and with the topic material cut to its first paragraphs (about `topicChars` characters). */
export function compactBackstory(backstory, {topicChars = GROQ_COMPACT.topicChars} = {}) {
  const text = String(backstory ?? '');
  if (!/^Scope:/m.test(text)) return text;
  const stripped = text.split('\n').filter(line => !/^Scope:/.test(line)).join('\n').replace(/\n{3,}/g, '\n\n');
  const header = TOPIC_HEADER.exec(stripped);
  if (!header) return stripped;
  const start = header.index, bodyStart = start + header[0].length;
  const rest = stripped.slice(bodyStart);
  const next = NEXT_HEADER.exec(rest.replace(/^\n/, ''));
  const end = next ? bodyStart + 1 + next.index : stripped.length;
  const section = stripped.slice(start, end).trimEnd();
  if (section.length <= topicChars) return stripped;
  const paragraphs = section.split(/\n{2,}/);
  const kept = [];
  let used = 0;
  // The first paragraph is the header and the section's own disclaimer (and the first item); it is always kept.
  for (const paragraph of paragraphs) {
    if (kept.length && used + paragraph.length + 2 > topicChars) break;
    kept.push(paragraph); used += paragraph.length + 2;
  }
  return `${stripped.slice(0, start)}${kept.join('\n\n')}\n\n${stripped.slice(end).replace(/^\n+/, '')}`.replace(/\n{3,}/g, '\n\n').trim();
}

/** The persona with the shorter backstory and fewer example lines; the same object when there is nothing to cut. */
export function compactPersona(persona, options = {}) {
  if (!persona || typeof persona !== 'object') return persona;
  const backstory = compactBackstory(persona.backstory, options);
  const keep = options.samples ?? GROQ_COMPACT.samples;
  const samples = Array.isArray(persona.samples) && persona.samples.length > keep ? persona.samples.slice(0, keep) : persona.samples;
  return backstory === persona.backstory && samples === persona.samples ? persona : {...persona, backstory, samples};
}

/**
 * The arguments of `buildMessages` for the Groq route: a smaller persona, a shorter history and tighter per-part limits. Pass the
 * route's own settings as `options` ({off: true} to switch the shaping off). A request that was not built by `buildMessages` has no
 * arguments and is never shaped.
 */
export function compactForGroq(args, options = {}) {
  if (!args || typeof args !== 'object' || options.off) return args;
  const c = {...GROQ_COMPACT, ...options};
  const limits = {...(args.limits ?? LIMITS)};
  limits.turns = Math.min(limits.turns ?? c.turns, c.turns);
  limits.userLine = Math.min(limits.userLine ?? c.userLine, c.userLine);
  limits.replyLine = Math.min(limits.replyLine ?? c.replyLine, c.replyLine);
  limits.summary = Math.min(limits.summary ?? c.summary, c.summary);
  limits.remembered = Math.min(limits.remembered ?? c.remembered, c.remembered);
  return {...args, persona: compactPersona(args.persona, c), limits,
    history: Array.isArray(args.history) && args.history.length > c.turns ? args.history.slice(-c.turns) : args.history};
}

/** Whether the shaping is on: `CYBERPUNK_CONVAI_GROQ_COMPACT=0` (or "off") sends the whole prompt, as before this module. */
export const groqCompactEnabled = (env = process.env) => !/^(?:0|off|false|no)$/i.test(String(env.CYBERPUNK_CONVAI_GROQ_COMPACT ?? '').trim());
