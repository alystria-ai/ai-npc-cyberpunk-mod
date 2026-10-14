// First-person profile texts.
//
// The research pipeline (research/cyberpunk/scripts/build_research.mjs) composes each character's
// backstory and speaking style from dossiers and hash-bound native claim packs, all written in the
// third person. Those sources are evidence-bound and are not edited. Instead
// characters/first-person-profiles.json holds a rewritten copy of the two composed texts for every
// character whose profile was third person, keyed by the SHA-256 of the third-person text it was
// written from. buildProfiles() applies it after composing, and refuses to apply it when the
// source text changed (a stale rewrite must be redone, never silently dropped or kept).
//
// A text is split into lines. Headings and the fixed shared paragraphs stay as they are; every
// other line is one "segment" that is rewritten on its own. That is what lets the rewrite be checked
// line by line (same count, same labels, same names, similar length).

import {createHash} from 'node:crypto';

export const sha256 = text => createHash('sha256').update(text).digest('hex');

const HEADERS = new Set(['ESTABLISHED BACKGROUND', 'ESTABLISHED RELATIONSHIPS', 'PUBLIC INTRINSIC TOPIC MATERIAL',
  'KNOWLEDGE AND CURRENT SAVE', 'KNOWLEDGE LIMITS']);
const SECTION_KIND = {'ESTABLISHED BACKGROUND': 'background', 'ESTABLISHED RELATIONSHIPS': 'relationship',
  'PUBLIC INTRINSIC TOPIC MATERIAL': 'claim', 'KNOWLEDGE LIMITS': 'limit'};
const INTRINSIC_INTRO = 'These are background and personal perspectives, not proof that V met you,';
const APPEARANCE = '\n\nYour appearance:\n';
const GENERIC_STYLE_TAIL = 'Speak naturally to V, usually in one or two sentences unless asked for detail.';

/** The part of a composed backstory the rewrite covers, and the unchanged tail (appearance and marker). */
export function splitBackstory(backstory) {
  let at = backstory.lastIndexOf(APPEARANCE);
  if (at < 0) at = backstory.search(/\n\n\[CyberpunkConvai profile v2:[^\]]+\]\s*$/u);
  if (at < 0) at = backstory.length;
  return {core: backstory.slice(0, at), tail: backstory.slice(at)};
}

/** The part of a composed speaking style the rewrite covers (the dossier paragraphs) and the shared tail. */
export function splitStyle(style) {
  const at = style.lastIndexOf('\n\n' + GENERIC_STYLE_TAIL);
  if (at < 0) throw Error('The shared speaking-style paragraph is missing');
  return {core: style.slice(0, at), tail: style.slice(at)};
}

/**
 * Lines of a text, each marked `fixed` (kept verbatim) or with a `kind` (story, background,
 * relationship, claim, scope, limit, style). Joining every line's text with the stored separators
 * gives the text back byte for byte.
 */
export function lineSegments(core, {style = false} = {}) {
  const out = [];
  if (style) {
    core.split('\n').forEach((line, i, all) => out.push({text: line, kind: line.trim() ? 'style' : null, sep: i < all.length - 1 ? '\n' : ''}));
    return out;
  }
  let section = 'story', keepFixed = false;
  const blocks = core.split('\n\n');
  blocks.forEach((block, b) => {
    const lines = block.split('\n');
    if (HEADERS.has(lines[0])) { section = lines[0]; keepFixed = section === 'KNOWLEDGE AND CURRENT SAVE'; }
    lines.forEach((line, l) => {
      const sep = l < lines.length - 1 ? '\n' : (b < blocks.length - 1 ? '\n\n' : '');
      let kind;
      if (HEADERS.has(line) || keepFixed || line.startsWith(INTRINSIC_INTRO) || !line.trim()) kind = null;
      else if (section === 'story') kind = 'story';
      else if (section === 'PUBLIC INTRINSIC TOPIC MATERIAL') kind = line.startsWith('Scope:') ? 'scope' : 'claim';
      else kind = SECTION_KIND[section];
      out.push({text: line, kind, sep});
    });
  });
  return out;
}

/** The rewritable lines as [{kind, text}] in order. */
export const rewritable = segments => segments.filter(segment => segment.kind).map(({kind, text}) => ({kind, text}));

/** Put `replacements` (one string per rewritable line) back into the structure. */
export function reassemble(segments, replacements) {
  const need = segments.filter(segment => segment.kind).length;
  if (replacements.length !== need) throw Error(`Expected ${need} rewritten lines, got ${replacements.length}`);
  let i = 0;
  return segments.map(segment => (segment.kind ? replacements[i++] : segment.text) + segment.sep).join('');
}

/**
 * Apply one stored rewrite to a freshly composed text. `row` is {sourceSha256, text}; throws when
 * the composed text is not the one the rewrite was made from.
 */
export function applyRewrite(core, row, label) {
  if (!row) return core;
  if (sha256(core) !== row.sourceSha256) {
    throw Error(`${label}: the third-person source changed since its first-person rewrite; rewrite it again `
      + '(node scripts/Rewrite-FirstPersonProfiles.mjs extract) before building');
  }
  return row.text;
}
