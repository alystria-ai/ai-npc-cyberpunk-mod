// The "PUBLIC INTRINSIC TOPIC MATERIAL" of a named character, split into one item per claim (docs/NATURAL_TALK_RESEARCH_2026-10-30.md, sections 14 and 15).
//
// In roster.json 77 characters carry this section in their backstory: an intro paragraph (background and personal views, not proof that V met them, verified game facts override),
// then one paragraph per claim, each a first-person view or anecdote with a "Scope:" line under it. All of it sat in every prompt (2,400 characters on average, 5,400 at most), and
// a model brought those views up whatever V had said. Split here, the section leaves the fixed persona (`core`) and each claim becomes an item the turn can retrieve by what V said
// (bridge/talk-retrieval.mjs). Pure functions, no I/O.
//
//   splitTopicMaterial(backstory) -> {core, preface, items: [{text}]} | null (a backstory without the section)
//
// `core` is the backstory with the whole section cut out, everything else byte for byte (identity, relationships, the knowledge and save rules, the knowledge limits, the appearance).
// `preface` is the section's own intro paragraph, kept as it is: the retrieved items travel with it, so the provenance rule ("not proof that V met you, verified game facts override")
// is said whenever a view is offered. An item is a claim paragraph with its Scope line when the text has one (the Scope lines that are limits, such as "does not give me access
// through the Blackwall", stay with their claim; the lean text of bridge/mistral-prompt.mjs leanBackstory has already dropped the ones that are only provenance notes).
import {createHash} from 'node:crypto';

export const TOPIC_HEADING = 'PUBLIC INTRINSIC TOPIC MATERIAL';
// The intro line of the section: the roster's wording, or the shorter one of the lean text (bridge/mistral-prompt.mjs TOPIC_LINE).
const INTRO = /^(?:These are background and personal perspectives|Background and personal views)/;
// The next section of a backstory: an all-capitals heading line, or the appearance paragraph.
const NEXT_SECTION = /^(?:[A-Z][A-Z0-9 &'-]{5,}|Your appearance:)[ \t]*$/m;

const tidy = text => String(text).replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
/** A short stable id for a text (the cache key of its vector, and the cooldown key of the item). */
export const textKey = text => createHash('sha1').update(String(text)).digest('hex').slice(0, 16);

export function splitTopicMaterial(backstory) {
  const whole = String(backstory ?? '');
  const heading = new RegExp(`^${TOPIC_HEADING}[ \\t]*$`, 'm').exec(whole);
  if (!heading) return null;
  const from = heading.index, bodyStart = from + heading[0].length;
  const rest = whole.slice(bodyStart);
  const next = NEXT_SECTION.exec(rest.replace(/^\n/, ''));
  const offset = rest.startsWith('\n') ? 1 : 0;
  const body = next ? rest.slice(0, offset + next.index) : rest;
  const after = next ? rest.slice(offset + next.index) : '';
  const paragraphs = tidy(body).split(/\n\s*\n/).map(part => part.trim()).filter(Boolean);
  if (!paragraphs.length) return null;
  // The section opens with its intro line, which the roster text runs straight into the first claim (no blank line between them).
  let intro = '';
  const lines = paragraphs[0].split('\n');
  if (INTRO.test(lines[0])) { intro = lines.shift().trim(); if (lines.length) paragraphs[0] = lines.join('\n').trim(); else paragraphs.shift(); }
  // A Scope line stands alone in a paragraph when the writer left a blank line before it: it belongs to the claim above.
  const claims = [];
  for (const part of paragraphs) {
    if (/^Scope:/.test(part) && claims.length) claims[claims.length - 1] += `\n${part}`;
    else claims.push(part);
  }
  const items = claims.map(claim => ({text: claim.replace(/\s*\n\s*/g, '\n')}));
  const core = tidy(`${whole.slice(0, from)}${after}`);
  return {core, preface: intro, items};
}

/** The item as a prompt line: the claim, its Scope line indented beneath it. */
export const itemLine = item => `- ${String(item.text).split('\n').map((line, index) => (index ? `  ${line}` : line)).join('\n')}`;
