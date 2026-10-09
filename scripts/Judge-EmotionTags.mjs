// Scoring support for scripts/Probe-EmotionTags.mjs (docs/EMOTION_TAGS.md).
//
//   node scripts/Judge-EmotionTags.mjs stats <label> [<label> ...]
//       Compliance and structure of the raw replies of each run (runtime/emotion-tags-probe/<label>-<profile>.json): valid tags,
//       strays, tags inside words, stage directions, tags per reply, share of {calm}, how much of the text a feeling covers.
//   node scripts/Judge-EmotionTags.mjs packet-fit <outDir> <label> [--seed 7] [--max N]
//       Blind packets for "does each sentence's emotion fit?": for every reply, the player line, the reply split into sentences,
//       and the emotion each system gave each sentence. Systems: the CURRENT picker (bridge/emotion-selector.mjs on the clean
//       text, the player line and Convai's own label), the tags alone, and the tags with the picker filling the rest (the
//       selector's `marks` input). Labels X1..X4 are shuffled per item; the key is a separate file.
//   node scripts/Judge-EmotionTags.mjs packet-voice <outDir> <labelA> <labelB> [--seed 7]
//       Blind packets for voice quality: the same player line answered under two runs (clean text, tags removed).
//   node scripts/Judge-EmotionTags.mjs merge-fit <outDir> | merge-voice <outDir>
//       Reads scores-<profile>.json next to key.json and prints means.
import {readFile, writeFile, mkdir, readdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {EMOTION_NAMES, emotionSpans, normaliseEmotion} from '../bridge/emotion-tags.mjs';
import {OMNI_TAGS, CJK_TAGS, parseTagged} from '../bridge/natural-speech.mjs';
// The bridge's own reading of a raw reply: the clean display text (no voice tag, no emotion tag) and the emotion marks.
const parseEmotionText = raw => { const parsed = parseTagged(raw); return {text: parsed.display, tags: parsed.marks}; };
// The picker being compared against. PICKER_BRIDGE=<dir> points at a copy of bridge/ (for example `git archive HEAD bridge`
// extracted to a scratch folder), so "the current picker" stays the committed one while another session edits the working tree.
import {pathToFileURL} from 'node:url';
const {selectEmotion} = await import(process.env.PICKER_BRIDGE
  ? pathToFileURL(resolve(process.env.PICKER_BRIDGE, 'emotion-selector.mjs')).href : '../bridge/emotion-selector.mjs');

const root = fileURLToPath(new URL('../', import.meta.url));
const runs = resolve(root, 'runtime/emotion-tags-probe');
const args = process.argv.slice(2);
const [command, first, second, third] = args;
const flag = (name, fallback) => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : fallback; };
let seed = Number(flag('--seed', 7));
const random = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
const shuffle = list => { for (let i = list.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [list[i], list[j]] = [list[j], list[i]]; } return list; };
const readJson = async path => JSON.parse((await readFile(path, 'utf8')).replace(/^﻿/, ''));
const pct = (a, b) => b ? Math.round(a / b * 1000) / 10 : null;
const mean = list => list.length ? Math.round(list.reduce((a, b) => a + b, 0) / list.length * 100) / 100 : null;

export async function loadRun(label) {
  const files = (await readdir(runs)).filter(name => name.startsWith(`${label}-`) && name.endsWith('.json'));
  const out = [];
  for (const file of files) {
    const run = await readJson(resolve(runs, file));
    if (run.label === label) out.push(run);
  }
  return out;
}

// ---- compliance ---------------------------------------------------------------------------------------------------

const STRICT = new RegExp(`\\{(?:${EMOTION_NAMES.join('|')})(?::(?:strong|subtle))?\\}`, 'g');
const SOUND_TAGS = new Set([...OMNI_TAGS, ...CJK_TAGS]);
const SENTENCE_END = /[.!?…]["')\]]*$/;

/** Everything wrong or notable about one raw reply, plus its structure. */
export function auditReply(raw) {
  const strict = raw.match(STRICT) ?? [];
  const parsed = parseEmotionText(raw);
  // Whatever brace characters are left once the strict tags are gone: recovered by the lenient reader, or stray.
  const leftover = raw.replace(new RegExp(STRICT.source, 'g'), ' ').match(/\{[^{}]*\}?|\}/g) ?? [];
  const lenient = leftover.filter(item => /^\{[^{}]*\}$/.test(item) && parseEmotionText(item + ' x').tags.length > 0).length;
  const stray = leftover.length - lenient;
  const cleanLeftBraces = /[{}]/.test(parsed.text);
  const inWord = /\p{L}\{[^{}]*\}\p{L}/u.test(raw);
  const brackets = [...raw.matchAll(/\[([^\]\n]{1,30})\]/g)].map(match => match[1].toLowerCase());
  // A bracketed emotion word ([surprise]) is understood as a feeling, so it is recovered rather than wrong.
  const bracketFeelings = brackets.filter(name => normaliseEmotion(name.split(':')[0], name.split(':')[1])).length;
  const badBrackets = brackets.filter(name => !SOUND_TAGS.has(name) && !normaliseEmotion(name.split(':')[0], name.split(':')[1]));
  const stageDirections = (raw.match(/\*[^*\n]{1,40}\*/g) ?? []).length + (raw.match(/\((?:[a-z]+(?: [a-z]+){0,2})\)/gi) ?? []).length;
  const tags = parsed.tags;
  const empty = (() => { // two tags with no word between them, or a tag with no word after it
    const stripped = raw.replace(/\[[a-z-]+\]/gi, ' ');
    return (stripped.match(/\{[^{}]*\}\s*(?=\{)/g) ?? []).length + (/\{[^{}]*\}[\s.,!?…]*$/.test(stripped) ? 1 : 0);
  })();
  const leaked = /^\s*(?:joy|warm|interest|surprise|sadness|fear|anger|disgust)\s*[:\-—,.]/i.test(parsed.text)
    || /\b(?:emotion|feeling)\s*[:=]\s*(?:joy|warm|interest|surprise|sadness|fear|anger|disgust|calm)\b/i.test(parsed.text);
  const text = parsed.text;
  const placements = tags.map(tag => {
    if (tag.at === 0) return 'start';
    const before = text.slice(0, tag.at).trimEnd();
    if (SENTENCE_END.test(before)) return 'sentence';
    if (/[,;:—–-]$/.test(before)) return 'clause';
    return 'mid';
  });
  const spans = emotionSpans(tags, text.length);
  const covered = spans.filter(span => span.emotion && span.emotion !== 'calm').reduce((sum, span) => sum + span.end - span.start, 0);
  // An empty stretch (two tags with no word between them) is harmless: the later tag wins. It is reported, not counted as invalid.
  const valid = stray === 0 && !cleanLeftBraces && !inWord && !leaked && badBrackets.length === 0 && stageDirections === 0 && !!text;
  return {tags: tags.length, strict: strict.length, lenient: lenient + bracketFeelings, stray, inWord, badBrackets, stageDirections, empty, leaked, valid,
    strictValid: valid && lenient + bracketFeelings === 0, opening: tags[0]?.at === 0, names: tags.map(tag => tag.name), strengths: tags.map(tag => tag.strength),
    placements, coverage: text.length ? covered / text.length : 0, words: text.split(/\s+/).filter(Boolean).length,
    calmFirstOnly: tags.length === 2 && tags[1].name === 'calm' && tags[0].name !== 'calm', clean: text};
}

export function summarise(rows) {
  const audits = rows.filter(row => row.raw !== undefined).map(row => ({row, audit: auditReply(row.raw)}));
  const n = audits.length;
  const allNames = audits.flatMap(({audit}) => audit.names), allPlaces = audits.flatMap(({audit}) => audit.placements);
  const count = (list, value) => list.filter(item => item === value).length;
  const withTags = audits.filter(({audit}) => audit.tags > 0);
  return {replies: n, errors: rows.filter(row => row.error).length,
    validPct: pct(audits.filter(({audit}) => audit.valid || audit.tags === 0 && audit.stray === 0).length, n),
    strictValidPct: pct(audits.filter(({audit}) => audit.strictValid || audit.tags === 0 && audit.stray === 0).length, n),
    invalid: audits.filter(({audit}) => !audit.valid && !(audit.tags === 0 && audit.stray === 0)).length,
    lenientRecovered: audits.filter(({audit}) => audit.lenient > 0).length, stray: audits.filter(({audit}) => audit.stray > 0).length,
    inWord: audits.filter(({audit}) => audit.inWord).length, badBrackets: audits.filter(({audit}) => audit.badBrackets.length).length,
    stageDirections: audits.filter(({audit}) => audit.stageDirections).length, emptyStretch: audits.filter(({audit}) => audit.empty).length,
    leakedWords: audits.filter(({audit}) => audit.leaked).length,
    taggedPct: pct(withTags.length, n), openingTagPct: pct(audits.filter(({audit}) => audit.opening).length, n),
    tagsPerReply: mean(audits.map(({audit}) => audit.tags)), maxTags: Math.max(0, ...audits.map(({audit}) => audit.tags)),
    over3Pct: pct(audits.filter(({audit}) => audit.tags > 3).length, n),
    calmSharePct: pct(count(allNames, 'calm'), allNames.length), strongPct: pct(audits.flatMap(({audit}) => audit.strengths).filter(s => s === 'strong').length, allNames.length),
    openerThenCalmPct: pct(audits.filter(({audit}) => audit.calmFirstOnly).length, n),
    nonCalmCoveragePct: Math.round(mean(audits.map(({audit}) => audit.coverage)) * 100),
    names: Object.fromEntries(EMOTION_NAMES.map(name => [name, count(allNames, name)])),
    placement: {start: count(allPlaces, 'start'), sentence: count(allPlaces, 'sentence'), clause: count(allPlaces, 'clause'), mid: count(allPlaces, 'mid')},
    avgWords: mean(audits.map(({audit}) => audit.words)), contextChars: mean(rows.map(row => row.contextChars).filter(Number.isFinite))};
}

// ---- timelines for the blind "fit" judging -----------------------------------------------------------------------

export function sentencesOf(text) {
  const out = [];
  const pattern = /[^.!?…]+(?:[.!?…]+["')\]]*|$)\s*/gu;
  for (const match of text.matchAll(pattern)) {
    const piece = match[0];
    if (!piece.trim()) continue;
    out.push({start: match.index, end: match.index + piece.trimEnd().length, text: piece.trim()});
  }
  // Very short fragments ("Ha.", "No.") stay their own sentence, so a tag on one is visible to the judge.
  return out;
}
const describe = (family, weight, scale) => family ? `${family}${scale === 2 ? ' (strong)' : ''}` : 'neutral';
const FAMILY_NAME = {trust: 'warm', anticipation: 'interest'};

/** A plan from bridge/emotion-selector.mjs as one label per sentence (the strongest feeling over the sentence, or neutral). */
function planLabels(plan, sentences) {
  return sentences.map(sentence => {
    const sums = {};
    for (const segment of plan?.segments ?? []) {
      const overlap = Math.min(segment.end, sentence.end) - Math.max(segment.start, sentence.start);
      if (overlap <= 0) continue;
      for (const [family, weight] of Object.entries(segment.weights)) sums[family] = (sums[family] ?? 0) + weight * overlap;
    }
    const length = Math.max(1, sentence.end - sentence.start);
    const [family, total] = Object.entries(sums).sort((a, b) => b[1] - a[1])[0] ?? [];
    const weight = family ? total / length : 0;
    return weight >= .25 ? describe(FAMILY_NAME[family] ?? family, weight, weight >= .7 ? 2 : 1) : 'neutral';
  });
}
function tagLabels(tags, text, sentences) {
  const spans = emotionSpans(tags, text.length);
  return sentences.map(sentence => {
    const span = spans.find(candidate => candidate.start <= sentence.start && sentence.start < candidate.end);
    // A tag in the middle of a sentence changes the second half; the label of a sentence is the feeling at its start, and
    // the one inside it when different ("sadness > anger").
    const inside = spans.filter(candidate => candidate.start > sentence.start && candidate.start < sentence.end && candidate.emotion);
    const name = emotion => !emotion ? 'untagged' : emotion === 'calm' ? 'neutral' : emotion;
    const head = name(span?.emotion) + (span?.intensity === 2 ? ' (strong)' : '');
    return inside.length ? `${head} > ${inside.map(span => name(span.emotion) + (span.intensity === 2 ? ' (strong)' : '')).join(' > ')}` : head;
  });
}
const toSignal = convai => convai ? {...convai, basis: 'ordered'} : undefined;

export function timelinesFor(row) {
  const clean = row.clean ?? parseEmotionText(row.raw).text;
  const parsed = parseEmotionText(row.raw);
  const sentences = sentencesOf(parsed.text);
  const picker = selectEmotion({player: row.player, reply: parsed.text, profile: row.profile, convai: toSignal(row.convai)});
  const hybrid = selectEmotion({player: row.player, reply: parsed.text, profile: row.profile, convai: toSignal(row.convai), marks: parsed.tags});
  // The same, but a {calm} tag leaves its stretch to the picker instead of forcing the resting face.
  const noCalm = selectEmotion({player: row.player, reply: parsed.text, profile: row.profile, convai: toSignal(row.convai),
    marks: parsed.tags.filter(tag => tag.name !== 'calm')});
  return {text: parsed.text, clean, sentences, picker: planLabels(picker, sentences), tags: tagLabels(parsed.tags, parsed.text, sentences),
    hybrid: planLabels(hybrid, sentences), hybridPickerOnCalm: planLabels(noCalm, sentences)};
}

// Who the judge is looking at (Cyberpunk 2077 characters, as the game writes them).
const CHARACTER = {
  'judy-alvarez': 'Judy Alvarez, a braindance editor: direct, quick, colloquial, dry little jokes, guarded and independent; warm underneath, soft sighs.',
  'panam-palmer': 'Panam Palmer, an Aldecaldo nomad: direct, articulate, practical, fiercely loyal and proud, teasing in calm company, short-tempered when pushed.',
  'johnny-silverhand': 'Johnny Silverhand, a dead rockerboy living on as an engram in V’s head: cynical, sardonic, profane, anti-corporate, blunt, gallows humour; rarely soft.',
  'jackie-welles': 'Jackie Welles, V’s best friend and fellow merc: big-hearted, loud, loyal, joking, optimistic, uses "choom".',
  'river-ward': 'River Ward, an NCPD detective: plainspoken, measured, earnest, a little awkward and gently funny in quiet company.',
  'rogue-amendiares': 'Rogue Amendiares, the Afterlife’s owner and a veteran fixer: dry, tough, weary, sharp-tongued, controlled, a soft spot for few.',
  'kerry-eurodyne': 'Kerry Eurodyne, a rock star: expansive, mercurial, irreverent, vain and self-aware, teasing by habit with candid half-sentences.',
  'evelyn-parker': 'Evelyn Parker, a braindance hustler hoping for a better life: anxious, friendly, dramatic, desperate, quick to charm.',
};

const FIT_RUBRIC = {
  task: 'A game character\'s face is animated from an emotion label per sentence. Several systems (X1, X2, ...) each gave every sentence of the reply a label. For each system give an integer score per sentence: 2 = the label fits what that sentence expresses in this character\'s voice and context (or "neutral" is right because the sentence is plain), 1 = acceptable or slightly off (right family but too strong/weak, or neutral where a faint feeling would be natural), 0 = wrong or misleading (opposite feeling, a smile on a grim line, a feeling on a plain line). "untagged" means the system gave no label for that sentence: score it as if neutral. "a > b" means the feeling changes from a to b inside the sentence; score it on whether the sequence fits.',
  output: 'Write scores-<character>.json: an array with one object per item, {id, X1:[score per sentence], X2:[...], ..., best:"X1"|"X2"|...|"tie"}. "best" is the system whose labels, overall, would make the face look most right; "tie" if equal.',
  note: 'Judge only the labels against the text. Do not guess how any label was produced.',
};
const LABEL_RUBRIC = {
  task: 'A game character speaks the reply and her/his face is animated one feeling per segment (a segment is a sentence or clause, listed under "segments" with its index). For each segment decide the feeling a careful viewer would expect on the face WHILE those words are spoken, given the player line and the character. Labels: joy (amused, delighted, proud, playful), warm (affection, care, comfort, trust, gentle teasing, flirting), interest (really intrigued, listening hard, curious), surprise (caught off guard), sadness (grief, regret, weariness, hurt), fear (worry, nervousness, alarm), anger (annoyance, irritation, rage, a defensive bite), disgust (revulsion, scorn, sneering contempt; not mere dryness), calm (flat, plain, businesslike: no visible feeling; most informational lines are calm).',
  accept: 'accept = other labels that would also be reasonable for that segment (may be empty). strength = how visible the feeling should be: 0 for calm, 1 subtle, 2 strong.',
  output: 'Write scores-<character>.json: an array with one object per item, {id, segments:[{label, accept:[...], strength}, ... one per segment in order]}.',
  note: 'Judge the words only; do not guess how they were produced. Do not label every segment calm to be safe: label what the face should show.',
};
const VOICE_RUBRIC = {
  scale: 'Each reply gets three integer scores from 1 to 5.',
  voice: 'How much it sounds like this specific character (diction, attitude, rhythm), as opposed to a generic assistant. 1 = generic or off. 5 = unmistakably them.',
  natural: 'How natural it is as spoken dialogue in a game: no stiffness, no leftover markup, no awkward punctuation or fragments. 1 = stilted. 5 = effortless.',
  quality: 'Overall, how good this is as the character\'s answer to the player\'s line (fits the line, has something to say, good length). 1 = poor. 5 = excellent.',
  output: 'Write scores-<character>.json: an array of {id, X:{voice,natural,quality}, Y:{voice,natural,quality}, better:"X"|"Y"|"tie"}.',
  note: 'Judge each reply by itself against the player line, then pick which is better overall. Do not guess how either was produced.',
};

// ---- commands -----------------------------------------------------------------------------------------------------

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (command === 'stats') {
    for (const label of args.slice(1)) {
      const loaded = await loadRun(label);
      const all = loaded.flatMap(run => run.rows);
      console.log(JSON.stringify({label, characters: loaded.map(run => run.profile), ...summarise(all)}, null, 1));
      for (const run of loaded) console.log(JSON.stringify({profile: run.profile, ...summarise(run.rows)}));
    }
  } else if (command === 'packet-fit') {
    const out = resolve(first), label = second;
    await mkdir(out, {recursive: true});
    const key = {};
    for (const run of await loadRun(label)) {
      const items = [];
      for (const row of run.rows.filter(row => row.raw)) {
        const t = timelinesFor({...row, profile: run.profile});
        if (!t.sentences.length) continue;
        const systems = [['picker', t.picker], ['tags', t.tags], ['hybrid', t.hybrid], ['hybridPickerOnCalm', t.hybridPickerOnCalm]];
        // Identical timelines are one system to the judge (and are scored once).
        const unique = [];
        for (const [name, labels] of systems) {
          const found = unique.find(entry => JSON.stringify(entry.labels) === JSON.stringify(labels));
          if (found) found.names.push(name); else unique.push({names: [name], labels});
        }
        shuffle(unique);
        const id = `${run.profile}/${row.n}`;
        key[id] = Object.fromEntries(unique.map((entry, index) => [`X${index + 1}`, entry.names]));
        items.push({id: String(row.n), category: row.category, player: row.player, sentences: t.sentences.map(sentence => sentence.text),
          systems: Object.fromEntries(unique.map((entry, index) => [`X${index + 1}`, entry.labels]))});
      }
      shuffle(items);
      await writeFile(resolve(out, `packet-${run.profile}.json`), JSON.stringify({character: CHARACTER[run.profile] ?? run.profile, rubric: FIT_RUBRIC, items}, null, 2) + '\n');
    }
    await writeFile(resolve(out, 'key.json'), JSON.stringify(key, null, 2) + '\n');
    console.log(JSON.stringify({items: Object.keys(key).length}));
  } else if (command === 'merge-fit') {
    const dir = resolve(first), key = await readJson(resolve(dir, 'key.json'));
    const totals = {}, best = {}, perChar = {};
    for (const file of (await readdir(dir)).filter(name => /^scores-.+\.json$/.test(name))) {
      const profile = file.slice('scores-'.length, -'.json'.length);
      for (const row of await readJson(resolve(dir, file))) {
        const entry = key[`${profile}/${row.id}`];
        if (!entry) continue;
        for (const [label, names] of Object.entries(entry)) {
          const scores = row[label]; if (!Array.isArray(scores) || !scores.length) continue;
          const itemMean = scores.reduce((a, b) => a + Number(b), 0) / scores.length;
          for (const name of names) {
            (totals[name] ??= []).push(itemMean);
            ((perChar[profile] ??= {})[name] ??= []).push(itemMean);
            for (const score of scores) (totals[`${name}:sentences`] ??= []).push(Number(score));
          }
        }
        const winner = row.best && entry[row.best];
        if (winner) for (const name of winner) best[name] = (best[name] ?? 0) + 1;
        if (row.best === 'tie') best.tie = (best.tie ?? 0) + 1;
      }
    }
    const summary = {meanFit: Object.fromEntries(Object.entries(totals).map(([k, v]) => [k, mean(v)])),
      n: Object.fromEntries(Object.entries(totals).map(([k, v]) => [k, v.length])), bestCounts: best,
      perCharacter: Object.fromEntries(Object.entries(perChar).map(([p, v]) => [p, Object.fromEntries(Object.entries(v).map(([k, list]) => [k, mean(list)]))]))};
    await writeFile(resolve(dir, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
    console.log(JSON.stringify(summary, null, 1));
  } else if (command === 'packet-label') {
    // Blind per-segment labels, the same kind as assets/emotion/segments-gold.json: units come from
    // `node scripts/Build-EmotionSegmentSet.mjs --probe-dir <dir> --out <units.json>`. A judge sees the clean text only (no tags,
    // no Convai label, no hint which prompt block wrote it); replies from every block are shuffled together.
    //   node scripts/Judge-EmotionTags.mjs packet-label <units.json> <out dir>
    const units = (await readJson(resolve(first))).units, out = resolve(second);
    await mkdir(out, {recursive: true});
    const byReply = new Map();
    for (const unit of units) { if (!byReply.has(unit.reply)) byReply.set(unit.reply, []); byReply.get(unit.reply).push(unit); }
    const byProfile = {};
    for (const group of byReply.values()) (byProfile[group[0].profile] ??= []).push(group);
    for (const [profile, groups] of Object.entries(byProfile)) {
      const items = shuffle(groups).map(group => ({id: group[0].reply, player: group[0].player, reply: group[0].replyText,
        segments: group.map((unit, index) => ({i: index, text: unit.text}))}));
      await writeFile(resolve(out, `packet-${profile}.json`), JSON.stringify({character: CHARACTER[profile] ?? profile, rubric: LABEL_RUBRIC, items}, null, 2) + '\n');
    }
    console.log(JSON.stringify({replies: byReply.size, segments: units.length, characters: Object.keys(byProfile).length}));
  } else if (command === 'merge-label') {
    //   node scripts/Judge-EmotionTags.mjs merge-label <units.json> <labelled dir> <out gold.json> [--set name=prefix ...]
    const units = (await readJson(resolve(first))).units, dir = resolve(second), outFile = resolve(third);
    const labels = new Map();
    for (const file of (await readdir(dir)).filter(name => /^scores-.+\.json$/.test(name)))
      for (const item of await readJson(resolve(dir, file))) labels.set(String(item.id), item.segments ?? item.labels ?? []);
    const replies = {}, kept = [];
    let missing = 0, invalid = 0;
    const groups = new Map();
    for (const unit of units) { if (!groups.has(unit.reply)) groups.set(unit.reply, []); groups.get(unit.reply).push(unit); }
    for (const [reply, group] of groups) {
      const given = labels.get(reply);
      if (!given || given.length !== group.length) { missing += group.length; continue; }
      const first = group[0];
      replies[reply] = {set: first.set, profile: first.profile, player: first.player, text: first.replyText, marks: first.marks, convai: first.convai};
      group.forEach((unit, index) => {
        const row = given[index], name = String(row?.label ?? '').toLowerCase();
        if (!EMOTION_NAMES.includes(name)) { invalid++; return; }
        kept.push({id: unit.id, reply, from: unit.from, to: unit.to, text: unit.text, label: name,
          accept: (row.accept ?? []).map(String).map(word => word.toLowerCase()).filter(word => EMOTION_NAMES.includes(word) && word !== name),
          strength: [0, 1, 2].includes(row.strength) ? row.strength : name === 'calm' ? 0 : 1});
      });
    }
    await writeFile(outFile, JSON.stringify({version: 1, built: new Date().toISOString(),
      note: 'Per-segment labels written blind to the picker and to the prompt block that produced the reply (scripts/Judge-EmotionTags.mjs packet-label).', replies, units: kept}) + '\n');
    console.log(JSON.stringify({replies: Object.keys(replies).length, units: kept.length, missing, invalid}));
  } else if (command === 'packet-voice') {
    const out = resolve(first), runA = await loadRun(second), runB = await loadRun(third);
    await mkdir(out, {recursive: true});
    const key = {};
    for (const a of runA) {
      const b = runB.find(run => run.profile === a.profile); if (!b) continue;
      const items = [];
      for (const rowA of a.rows) {
        const rowB = b.rows.find(row => row.n === rowA.n);
        if (!rowA.raw || !rowB?.raw) continue;
        const pair = shuffle([['A', parseEmotionText(rowA.raw).text], ['B', parseEmotionText(rowB.raw).text]]);
        key[`${a.profile}/${rowA.n}`] = {X: pair[0][0] === 'A' ? second : third, Y: pair[1][0] === 'A' ? second : third};
        items.push({id: String(rowA.n), category: rowA.category, player: rowA.player, X: pair[0][1], Y: pair[1][1]});
      }
      shuffle(items);
      await writeFile(resolve(out, `packet-${a.profile}.json`), JSON.stringify({character: CHARACTER[a.profile] ?? a.profile, rubric: VOICE_RUBRIC, items}, null, 2) + '\n');
    }
    await writeFile(resolve(out, 'key.json'), JSON.stringify(key, null, 2) + '\n');
    console.log(JSON.stringify({items: Object.keys(key).length}));
  } else if (command === 'merge-voice') {
    const dir = resolve(first), key = await readJson(resolve(dir, 'key.json'));
    const totals = {}, prefer = {};
    for (const file of (await readdir(dir)).filter(name => /^scores-.+\.json$/.test(name))) {
      const profile = file.slice('scores-'.length, -'.json'.length);
      for (const row of await readJson(resolve(dir, file))) {
        const entry = key[`${profile}/${row.id}`]; if (!entry) continue;
        for (const side of ['X', 'Y']) {
          const arm = entry[side], s = row[side]; if (!s) continue;
          for (const metric of ['voice', 'natural', 'quality']) (((totals[arm] ??= {})[metric]) ??= []).push(Number(s[metric]));
        }
        if (row.better === 'X' || row.better === 'Y') prefer[entry[row.better]] = (prefer[entry[row.better]] ?? 0) + 1;
        else prefer.tie = (prefer.tie ?? 0) + 1;
      }
    }
    const summary = {means: Object.fromEntries(Object.entries(totals).map(([arm, v]) => [arm, Object.fromEntries(Object.entries(v).map(([m, l]) => [m, mean(l)]))])),
      n: Object.fromEntries(Object.entries(totals).map(([arm, v]) => [arm, v.voice.length])), preferred: prefer};
    await writeFile(resolve(dir, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
    console.log(JSON.stringify(summary, null, 1));
  }
}

