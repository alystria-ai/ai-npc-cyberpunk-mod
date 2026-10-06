// Per-segment emotion analysis of a reply's own text, for local voices (and as
// the phrase-level variation on top of a Convai turn's reply-level emotion).
// Cheap by design: one pass of regexes and map lookups (about a millisecond for
// a normal reply). No LLM, no network, no audio. The result is a PLAN: ordered
// text segments (sentences, split further at contrast words, long clauses and
// forced boundaries such as Omni phrase edges), each with sparse emotion-family
// weights (0..1) and a spoken-duration estimate. bridge/expression-timeline.mjs
// aligns that plan to the real audio time.
import {FAMILIES, WORDS, INTENSIFIERS, DIMINISHERS, NEGATORS, CONTRAST, PROFANITY, ADDRESS, SARCASM} from './emotion-lexicon.mjs';
export {FAMILIES};

const POSITIVE = new Set(['joy', 'trust']);
const NEGATIVE = new Set(['sadness', 'anger', 'fear', 'disgust']);
const clamp01 = value => Math.max(0, Math.min(1, value));

// Per-character baseline (the resting family weights while no phrase carries a
// feeling) and expressive range (a multiplier on phrase feelings). Weight 1 is
// the family's full pose, so trust .67 is the .167 resting smile of a warm face.
export const TRAITS = Object.freeze({
  warm: {baseline: {trust: .67}, range: 1.1},
  neutral: {baseline: {trust: .4}, range: 1},
  dry: {baseline: {trust: .3}, range: .9, sarcasm: 1.15},
  cold: {baseline: {anticipation: .35}, range: .7},
});
const COLD = new Set(['adam-smasher', 'yorinobu-arasaka', 'hanako-arasaka', 'alan-noel', 'mr-hands']);
const WARM = new Set(['judy-alvarez', 'jackie-welles', 'panam-palmer', 'kerry-eurodyne', 'misty-olszewski', 'mama-welles',
  'river-ward', 'claire-russell', 'dexter-deshawn', 'padre-ibarra', 'viktor-vektor']);
const DRY = new Set(['johnny-silverhand', 'rogue-amendiares', 'takemura', 'saul-bright', 'meredith-stout', 'solomon-reed',
  'spider-murphy', 'r3n0', 'regina-jones', 'songbird', 'nix']);
export function traitFor(profile) { return COLD.has(profile) ? 'cold' : WARM.has(profile) ? 'warm' : DRY.has(profile) ? 'dry' : 'neutral'; }

// ---- lookup tables ------------------------------------------------------
const single = new Map(), phrases = new Map();
for (const family of FAMILIES) {
  for (const [word, weight] of Object.entries(WORDS[family])) {
    const parts = word.split(' ');
    const table = parts.length === 1 ? single : phrases;
    if (!table.has(word)) table.set(word, []);
    table.get(word).push([family, weight]);
  }
}
const inflections = token => {
  const out = [token];
  if (token.length > 3) {
    out.push(token.replace(/ies$/, 'y'), token.replace(/s$/, ''), token.replace(/es$/, ''), token.replace(/ed$/, ''),
      token.replace(/ed$/, 'e'), token.replace(/ing$/, ''), token.replace(/ing$/, 'e'), token.replace(/ly$/, ''),
      token.replace(/(.)\1ing$/, '$1'), token.replace(/(.)\1ed$/, '$1'), token.replace(/er$/, ''), token.replace(/est$/, ''));
  }
  return out;
};
function lookupWord(token) {
  const direct = single.get(token);
  if (direct) return {entries: direct, scale: 1};
  const squeezed = token.replace(/(.)\1{2,}/g, '$1$1').replace(/(.)\1{2,}/g, '$1');
  for (const candidate of inflections(squeezed === token ? token : squeezed)) {
    if (candidate.length < 3 && candidate !== token) continue;
    const entries = single.get(candidate);
    if (entries) return {entries, scale: candidate === token ? 1 : .92};
  }
  if (/^(ha|he|hah|heh|hee){2,}$/.test(token)) return {entries: [['joy', .85]], scale: 1, tag: 'laugh'};
  return undefined;
}

// ---- tokens, segments ---------------------------------------------------
const TOKEN = /[\p{L}\p{N}][\p{L}\p{N}'’]*|\.{2,}|…|[.!?]+|[,;:]|—|–/gu;
function tokenise(text) {
  const out = [];
  for (const match of text.matchAll(TOKEN)) {
    const raw = match[0], lower = raw.toLowerCase().replace(/’/g, "'");
    const isWord = /^[\p{L}\p{N}]/u.test(raw);
    out.push({raw, lower, start: match.index, end: match.index + raw.length, word: isWord,
      terminal: !isWord && /^[.!?…]+$/.test(raw) && raw !== '…' && !/^\.{2,}$/.test(raw),
      ellipsis: raw === '…' || /^\.{2,}$/.test(raw), comma: /^[,;:—–]$/.test(raw)});
  }
  return out;
}
const ABBREVIATIONS = new Set(['mr', 'mrs', 'ms', 'dr', 'st', 'vs', 'v', 'jr', 'sr', 'etc']);
export function syllables(word) {
  const groups = word.toLowerCase().replace(/e$/, '').match(/[aeiouyáéíóúü]+/g);
  return Math.max(1, groups ? groups.length : 1);
}
const SYLLABLES_PER_SECOND = 4.4;
function pauseFor(closing) {
  if (!closing) return .04;
  if (closing.ellipsis) return .45;
  if (closing.terminal) return .3;
  if (closing.comma) return .12;
  return .04;
}

export function segmentText(text, {breaks = []} = {}) {
  const tokens = tokenise(text), sentences = [];
  let current = [];
  const flush = () => { if (current.length) sentences.push(current); current = []; };
  tokens.forEach((token, index) => {
    current.push(token);
    if (token.terminal || token.ellipsis) {
      const previous = tokens[index - 1];
      const abbreviation = token.raw === '.' && previous?.word && (ABBREVIATIONS.has(previous.lower)
        || (previous.raw.length === 1 && /[A-Z]/.test(previous.raw)));
      if (!abbreviation) flush();
    }
  });
  flush();
  // Split sentences at contrast words and very long clauses.
  const pieces = [];
  for (const sentence of sentences) {
    let start = 0;
    const content = list => list.filter(token => token.word).length;
    for (let i = 1; i < sentence.length; i++) {
      const token = sentence[i], contrast = token.word && CONTRAST.has(token.lower)
        && !(token.lower === 'though' && i === sentence.length - 2) && token.lower !== 'still' && token.lower !== 'yet';
      if (contrast && content(sentence.slice(start, i)) >= 2 && content(sentence.slice(i)) >= 2) {
        pieces.push({tokens: sentence.slice(start, i), contrastNext: true}); start = i;
      }
    }
    const rest = sentence.slice(start);
    const span = rest.length ? rest.at(-1).end - rest[0].start : 0;
    if (span > 110) {
      const middle = rest[0].start + span / 2;
      let best = -1, distance = Infinity;
      rest.forEach((token, i) => {
        if (!token.comma || i < 3 || i > rest.length - 3) return;
        const gap = Math.abs(token.end - middle);
        if (gap < distance && token.end - rest[0].start >= 30 && rest.at(-1).end - token.end >= 30) { best = i; distance = gap; }
      });
      if (best > 0) {
        pieces.push({tokens: rest.slice(0, best + 1)});
        pieces.push({tokens: rest.slice(best + 1), contrast: pieces.length && pieces.at(-1).contrastNext});
        continue;
      }
    }
    pieces.push({tokens: rest, contrast: start > 0});
  }
  // Mark the segment that starts at a contrast word.
  pieces.forEach((piece, i) => {
    const first = piece.tokens.find(token => token.word);
    if (first && CONTRAST.has(first.lower) && first.lower !== 'still' && first.lower !== 'yet') piece.contrast = true;
    if (pieces[i + 1]?.tokens.find(token => token.word) && pieces[i + 1].contrast) piece.contrastNext = true;
  });
  // Forced boundaries (for example Omni phrase edges) split further.
  let segments = pieces.filter(piece => piece.tokens.length).map(piece => ({
    tokens: piece.tokens, contrast: Boolean(piece.contrast), contrastNext: Boolean(piece.contrastNext),
    start: piece.tokens[0].start, end: piece.tokens.at(-1).end}));
  for (const edge of [...breaks].sort((a, b) => a - b)) {
    const at = segments.findIndex(segment => segment.start < edge && edge < segment.end);
    if (at < 0) continue;
    const segment = segments[at], cut = segment.tokens.findIndex(token => token.start >= edge);
    if (cut <= 0) continue;
    segments.splice(at, 1,
      {tokens: segment.tokens.slice(0, cut), contrast: segment.contrast, contrastNext: false,
        start: segment.start, end: segment.tokens[cut - 1].end},
      {tokens: segment.tokens.slice(cut), contrast: false, contrastNext: segment.contrastNext,
        start: segment.tokens[cut].start, end: segment.end});
  }
  // Merge one-word fragments into a neighbour (they carry no timing worth a phrase).
  const forced = new Set(breaks);
  for (let i = 0; i < segments.length; i++) {
    const words = segments[i].tokens.filter(token => token.word).length;
    if (words < 2 && segments.length > 1 && !forced.has(segments[i].start) && !forced.has(segments[i + 1]?.start)) {
      const into = i > 0 ? i - 1 : i + 1, a = Math.min(i, into), b = Math.max(i, into);
      const merged = {tokens: [...segments[a].tokens, ...segments[b].tokens], contrast: segments[a].contrast,
        contrastNext: segments[b].contrastNext, start: segments[a].start, end: segments[b].end};
      segments.splice(a, 2, merged); i = Math.max(-1, a - 1);
    }
  }
  return segments;
}

// ---- scoring ------------------------------------------------------------
function scoreSegment(segment, trait) {
  const tokens = segment.tokens, scores = Object.fromEntries(FAMILIES.map(family => [family, 0]));
  const tags = new Set();
  const lowerText = (segment.text ?? tokens.map(token => token.raw).join(' ')).toLowerCase().replace(/’/g, "'");
  let negationWindow = -10, addressDone = false;
  const clauseBreak = index => tokens[index].comma || tokens[index].terminal || tokens[index].ellipsis;
  let i = 0;
  const modifierFor = at => {
    let factor = 1, negated = false;
    for (let back = 1; back <= 3 && at - back >= 0; back++) {
      const token = tokens[at - back];
      if (!token.word) { if (clauseBreak(at - back)) break; continue; }
      const two = at - back - 1 >= 0 && tokens[at - back - 1].word ? tokens[at - back - 1].lower + '_' + token.lower : '';
      if (NEGATORS.has(token.lower)) negated = !negated;
      else if (INTENSIFIERS[token.lower]) { factor *= INTENSIFIERS[token.lower]; tags.add('intensifier'); }
      else if (DIMINISHERS[two] || DIMINISHERS[token.lower]) { factor *= DIMINISHERS[two] ?? DIMINISHERS[token.lower]; tags.add('diminisher'); }
    }
    return {factor, negated};
  };
  const apply = (family, value, at) => {
    const {factor, negated} = modifierFor(at);
    const amount = value * factor;
    if (!negated) { scores[family] += amount; return; }
    tags.add('negation');
    // "not happy" is mildly sad; "not scared/angry/sad" is relief (a little trust).
    if (POSITIVE.has(family)) scores.sadness += amount * .35;
    else if (NEGATIVE.has(family)) scores.trust += amount * .3;
  };
  while (i < tokens.length) {
    const token = tokens[i];
    if (!token.word) { i++; continue; }
    let matched = false;
    for (let size = 4; size >= 2 && !matched; size--) {
      if (i + size > tokens.length || !tokens.slice(i, i + size).every(part => part.word)) continue;
      const entries = phrases.get(tokens.slice(i, i + size).map(part => part.lower).join(' '));
      if (entries) {
        for (const [family, weight] of entries) apply(family, weight, i);
        i += size; matched = true;
      }
    }
    if (matched) continue;
    const found = lookupWord(token.lower);
    if (found) {
      if (found.tag) tags.add(found.tag);
      for (const [family, weight] of found.entries) apply(family, weight * found.scale, i);
    }
    if (ADDRESS.has(token.lower) && !addressDone && !found?.entries.some(([family]) => family === 'trust')) {
      scores.trust += .3; addressDone = true; tags.add('address');
    }
    if (token.lower === 'v' && token.raw === 'V' && (clauseBreak(i - 1) || clauseBreak(i + 1) || i === 0)) {
      scores.trust += .25; tags.add('address');
    }
    i++;
  }
  // Profanity: emphasis on a feeling it modifies, otherwise anger.
  const profane = tokens.filter(token => token.word && PROFANITY.has(token.lower)).length;
  if (profane) {
    tags.add('profanity');
    const strongest = Math.max(...FAMILIES.map(family => scores[family]));
    if (scores.joy > scores.anger && scores.joy >= strongest) scores.joy *= 1.2;
    else if (strongest > .3 && !NEGATIVE.has(FAMILIES.find(family => scores[family] === strongest))) scores.anger += .15;
    else scores.anger += .35 * Math.min(2, profane);
  }
  // Sarcasm: a positive phrase with a known scornful pattern is a dry smirk, not joy.
  if (SARCASM.some(pattern => pattern.test(lowerText))) {
    tags.add('sarcasm');
    const praise = scores.joy + scores.trust;
    scores.joy = 0; scores.trust *= .3;
    scores.disgust += .25 * (trait.sarcasm || 1) + praise * .15; scores.anticipation += .3;
  }
  const raw = tokens.map(token => token.raw);
  const exclaims = (segment.text ?? '').split('!').length - 1;
  segment.exclaims = exclaims; segment.questions = (segment.text ?? '').split('?').length - 1;
  if (raw.filter(word => /^[A-Z]{3,}$/.test(word)).length >= 1 && (exclaims || raw.filter(word => /^[A-Z]{3,}$/.test(word)).length >= 2)) {
    tags.add('emphasis');
    for (const family of FAMILIES) scores[family] *= 1.2;
  }
  const dominantScore = Math.max(...FAMILIES.map(family => scores[family]));
  if (exclaims) {
    tags.add('exclamation');
    for (const family of FAMILIES) scores[family] *= 1 + .12 * Math.min(3, exclaims);
    if (dominantScore < .2) scores.anticipation += .15;
  }
  if (segment.questions) {
    tags.add('question');
    scores.anticipation += .3 + (/\b(really|seriously|you did|no way|what\?)/.test(lowerText) ? 0 : 0);
    if (/\b(really|seriously)\b/.test(lowerText) || /\bwhat\?!/.test(lowerText)) scores.surprise += .25;
  }
  const opening = tokens[0]?.ellipsis || tokens.some(token => token.ellipsis);
  if (opening) {
    // Hesitation: trailing off or "... well", softer feelings plus a thinking brow.
    tags.add('hesitation');
    for (const family of FAMILIES) scores[family] *= .8;
    scores.anticipation += .12;
  }
  return {scores, tags};
}

const toWeight = score => clamp01(score * .85);

export function analyseReply(text, {profile, baseline, breaks = [], now} = {}) {
  if (typeof text !== 'string' || !text.trim() || text.length > 12000) return undefined;
  const traitName = traitFor(profile), trait = TRAITS[traitName];
  const segmentsRaw = segmentText(text, {breaks});
  if (!segmentsRaw.length) return undefined;
  // Baseline: the character's resting weights, replaced by Convai's own
  // reply-level label (kept at 60 % so phrase analysis can still vary it).
  const base = Object.fromEntries(FAMILIES.map(family => [family, 0]));
  for (const [family, weight] of Object.entries(trait.baseline)) base[family] = weight;
  if (baseline?.family && FAMILIES.includes(baseline.family)) {
    for (const family of FAMILIES) base[family] *= .4;
    base[baseline.family] = Math.max(base[baseline.family], clamp01((baseline.weight ?? .67) * .6));
  }
  const segments = segmentsRaw.map((segment, index) => {
    segment.text = text.slice(segment.start, segment.end);
    const {scores, tags} = scoreSegment(segment, trait);
    const next = segmentsRaw[index + 1];
    // Contrast: the clause before "but" is played down, the one after is stressed.
    let emphasis = 1;
    if (segment.contrastNext) { emphasis *= .6; tags.add('pre-contrast'); }
    if (segment.contrast) { emphasis *= 1.18; tags.add('contrast'); }
    const feelings = {};
    for (const family of FAMILIES) {
      const weight = clamp01(toWeight(scores[family]) * emphasis * trait.range);
      if (weight >= .2) feelings[family] = weight;
    }
    // Baseline yields to a clearly negative phrase and is topped up by feelings.
    const negativeSum = [...NEGATIVE].reduce((sum, family) => sum + (feelings[family] || 0), 0);
    const finals = {};
    for (const family of FAMILIES) {
      let resting = base[family];
      if (family === 'trust' || family === 'joy') resting *= 1 - clamp01(negativeSum * 1.4);
      const own = feelings[family] || 0;
      const total = own + resting * (1 - own);
      if (total >= .08) finals[family] = Math.round(clamp01(total) * 1000) / 1000;
    }
    const words = segment.tokens.filter(token => token.word), syl = words.reduce((sum, token) => sum + syllables(token.raw), 0);
    const closing = [...segment.tokens].reverse().find(token => !token.word) ?? null;
    const closingEnds = closing && segment.tokens.at(-1) === closing ? closing : null;
    const dominant = Object.entries(feelings).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    return {start: segment.start, end: segment.end, weights: finals, feelings, dominant, tags: [...tags].sort(),
      syllables: syl, seconds: syl / SYLLABLES_PER_SECOND, pauseAfter: next ? pauseFor(closingEnds) : 0,
      mixed: Object.keys(feelings).length > 1};
  });
  const plan = {version: 1, length: text.length, trait: traitName, baseline: Object.fromEntries(
    Object.entries(base).filter(([, weight]) => weight > 0)), segments};
  plan.summary = summarise(plan);
  return plan;
}

export const LABELS = Object.freeze({joy: 'Joy', trust: 'Trust', sadness: 'Sadness', anger: 'Anger', fear: 'Fear',
  disgust: 'Disgust', surprise: 'Surprise', anticipation: 'Interest'});
// Reply-level label for the receipt path: the family with the most weighted time.
export function summarise(plan) {
  const sums = Object.fromEntries(FAMILIES.map(family => [family, 0]));
  let total = 0;
  for (const segment of plan.segments) {
    const span = Math.max(.2, segment.seconds);
    total += span;
    for (const [family, weight] of Object.entries(segment.weights)) sums[family] += weight * span;
  }
  const ranked = Object.entries(sums).sort((a, b) => b[1] - a[1]);
  const [family, sum] = ranked[0], mean = total ? sum / total : 0;
  const fromText = plan.segments.some(segment => segment.dominant === family);
  return {family, label: LABELS[family], weight: Math.round(mean * 1000) / 1000, basis: fromText ? 'text' : 'default',
    scale: mean >= .8 ? 3 : mean >= .5 ? 2 : 1};
}

// The reply-level cue (same shape as text-emotion.mjs' signal) from a plan.
export function planSignal(plan) {
  if (!plan) return undefined;
  const {label, scale, basis} = plan.summary;
  return {version: 1, correlated: true, sequence: 0, emotion: label, scale, basis};
}

// Segments of a plan that fall inside [from, to) characters of the full reply,
// with offsets rebased to that range. Used for per-phrase Omni timelines.
export function planRange(plan, from, to) {
  const segments = plan.segments.filter(segment => segment.end > from && segment.start < to)
    .map(segment => ({...segment, start: Math.max(segment.start, from) - from, end: Math.min(segment.end, to) - from}));
  return {...plan, segments, length: to - from};
}

// Character offsets of each phrase in the original text (phrases are verbatim slices, in order).
export function phraseOffsets(text, phrases) {
  const out = [];
  let cursor = 0;
  for (const phrase of phrases) {
    const found = text.indexOf(phrase, cursor);
    const start = found >= 0 ? found : cursor;
    out.push([start, start + phrase.length]);
    cursor = start + phrase.length;
  }
  return out;
}

// A Convai turn's own reply-level label (never our text cue) as the baseline
// the phrase analysis varies. Our own signals carry basis text/tone/default.
export function baselineFromSignal(signal, strength = [.4, .67, 1]) {
  if (!signal || !['ordered', 'response-id'].includes(signal.basis)) return undefined;
  const label = String(signal.emotion || '').toLowerCase();
  const family = {joy: 'joy', happy: 'joy', happiness: 'joy', ecstasy: 'joy', serenity: 'joy', trust: 'trust', acceptance: 'trust',
    admiration: 'trust', love: 'trust', sadness: 'sadness', sad: 'sadness', grief: 'sadness', pensiveness: 'sadness',
    anger: 'anger', angry: 'anger', rage: 'anger', annoyance: 'anger', fear: 'fear', terror: 'fear', apprehension: 'fear',
    anxiety: 'fear', disgust: 'disgust', loathing: 'disgust', boredom: 'disgust', surprise: 'surprise', amazement: 'surprise',
    distraction: 'surprise', anticipation: 'anticipation', interest: 'anticipation', vigilance: 'anticipation'}[label];
  if (!family) return undefined;
  return {family, weight: strength[Math.max(0, Math.min(2, (signal.scale || 1) - 1))]};
}

// One-entry cache: continuous streams republish the same growing text many times a second.
export function createPlanner({profile, breaks} = {}) {
  let key, plan;
  return (text, signal) => {
    const baseline = baselineFromSignal(signal), id = text + '\u0000' + (baseline ? baseline.family + baseline.weight : '');
    if (id !== key) {
      key = id;
      try { plan = analyseReply(text, {profile, baseline, breaks}); } catch { plan = undefined; }
    }
    return plan;
  };
}
