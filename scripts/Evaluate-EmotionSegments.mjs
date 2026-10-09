// Per-SEGMENT accuracy of the emotion picker on hand-labelled real companion replies (assets/emotion/segments-gold.json:
// real Convai text replies with the character's own inline tags and Convai's late label; every segment labelled
// blind to the picker by separate writers). Three conditions, so each source of evidence is measured:
//   game    the character's tags AND Convai's label, as the bridge sees them with "Expressive emotions" on (the
//           player's setting during the October 9 evening test);
//   no-tags the setting off: Convai's label and the text;
//   text    the text alone (no label arrives in time).
//   node scripts/Evaluate-EmotionSegments.mjs [dev|holdout|fresh|all] [--details] [--json OUT]
// PREVIOUS_BRIDGE=<dir> runs another copy of bridge/ (for example `git archive <commit> bridge` extracted to a scratch
// folder) so "before" is exactly the code that was installed. Reported per condition:
//   exact       the segment's visible emotion (the strongest family at weight >= .2; calm when none) is the gold label
//   acceptable  ... or one of the gold alternates
//   dead        no family reaches .2: the face shows nothing for that segment
//   dead|gold   share of segments the writers expect to emote that render nothing (a miss)
//   over-emote  share of gold-calm segments that render an emotion (the picker should stay quiet there)
//   wrong sign  a smile on a gold-negative segment, or a frown/scorn on a gold smile
//   mean weight the average strength of the emotions shown, and the share of shown emotions that are clear (>= .35)
import {readFile, writeFile} from 'node:fs/promises';
import {resolve, dirname} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const bridge = process.env.PREVIOUS_BRIDGE ? pathToFileURL(resolve(process.env.PREVIOUS_BRIDGE) + '/').href : new URL('../bridge/', import.meta.url).href;
const {selectEmotion, LABEL_OF} = await import(new URL('emotion-selector.mjs', bridge).href);
const {phraseOffsets} = await import(new URL('emotion-analysis.mjs', bridge).href);
const {splitSpeechText} = await import(new URL('speech-stream.mjs', bridge).href);

const args = process.argv.slice(2);
const which = args.find(arg => !arg.startsWith('--')) || 'all';
const details = args.includes('--details'), jsonOut = args.includes('--json') ? args[args.indexOf('--json') + 1] : undefined;
const VISIBLE = .2, CLEAR = .35;
const NEGATIVE = new Set(['sadness', 'fear', 'anger', 'disgust']), SMILES = new Set(['joy', 'warm']);

// The gold file keeps each reply once (`replies`) and its labelled segments (`units`); a unit is flattened here with
// its reply's fields. Splits: `dev` is the first eight characters on the first 28 prompts (set1, what the picker was
// tuned on); `holdout` is four other characters on the same prompts (set2) plus older follow-up probes; `fresh` is
// twelve characters on 28 NEW prompts (set3), written and labelled after the picker was frozen, looked at once.
const file = JSON.parse(await readFile(resolve(root, 'assets/emotion/segments-gold.json'), 'utf8'));
const split = unit => unit.set === 'set1' ? 'dev' : unit.set === 'set3' ? 'fresh' : unit.set === 'set4' ? 'fresh2' : 'holdout';
const units = file.units.map(unit => ({...file.replies[unit.reply], ...unit, replyText: file.replies[unit.reply].text}))
  .filter(unit => which === 'all' || split(unit) === which);
const replies = new Map();
for (const unit of units) { if (!replies.has(unit.reply)) replies.set(unit.reply, []); replies.get(unit.reply).push(unit); }

const CONDITIONS = {
  game: unit => ({marks: unit.marks, convai: unit.convai ? {...unit.convai, basis: 'ordered'} : undefined}),
  'no-tags': unit => ({convai: unit.convai ? {...unit.convai, basis: 'ordered'} : undefined}),
  text: () => ({}),
};

function shown(plan, unit) {
  const middle = (unit.from + unit.to) / 2;
  const segment = plan.segments.find(candidate => candidate.start <= middle && middle < candidate.end + 1) ?? plan.segments.at(-1);
  const [family, weight] = Object.entries(segment.weights).sort((a, b) => b[1] - a[1])[0] ?? [];
  return family && weight >= VISIBLE ? {label: LABEL_OF[family], weight} : {label: 'calm', weight: 0};
}

const report = {};
for (const [condition, options] of Object.entries(CONDITIONS)) {
  const rows = [];
  for (const group of replies.values()) {
    const first = group[0], extra = options(first);
    let plan;
    try {
      const spans = phraseOffsets(first.replyText, splitSpeechText(first.replyText));
      plan = selectEmotion({player: first.player, reply: first.replyText, profile: first.profile, ...extra, breaks: spans.slice(1).map(span => span[0])});
    } catch (error) { console.error('plan failed', first.reply, error.message); }
    for (const unit of group) rows.push({unit, ...(plan ? shown(plan, unit) : {label: 'calm', weight: 0})});
  }
  const n = rows.length, count = test => rows.filter(test).length, pct = (a, b = n) => Math.round(1000 * a / Math.max(1, b)) / 10;
  const emotingGold = rows.filter(row => row.unit.label !== 'calm'), calmGold = rows.filter(row => row.unit.label === 'calm');
  const emoted = rows.filter(row => row.label !== 'calm');
  const exact = count(row => row.label === row.unit.label);
  const acceptable = count(row => row.label === row.unit.label || (row.unit.accept ?? []).includes(row.label));
  const wrongSign = count(row => (NEGATIVE.has(row.unit.label) && SMILES.has(row.label)) || (SMILES.has(row.unit.label) && NEGATIVE.has(row.label)));
  const exactEmoting = emotingGold.filter(row => row.label === row.unit.label).length;
  const acceptableEmoting = emotingGold.filter(row => row.label === row.unit.label || (row.unit.accept ?? []).includes(row.label)).length;
  report[condition] = {segments: n, replies: replies.size, exact: pct(exact), acceptable: pct(acceptable),
    dead: pct(count(row => row.label === 'calm')), deadGivenGoldEmotes: pct(emotingGold.filter(row => row.label === 'calm').length, emotingGold.length),
    overEmote: pct(calmGold.filter(row => row.label !== 'calm').length, calmGold.length),
    exactOnEmoting: pct(exactEmoting, emotingGold.length), acceptableOnEmoting: pct(acceptableEmoting, emotingGold.length),
    wrongSign: pct(wrongSign), goldCalm: pct(calmGold.length), meanWeight: Math.round(100 * emoted.reduce((s, r) => s + r.weight, 0) / Math.max(1, emoted.length)) / 100,
    clearShare: pct(emoted.filter(row => row.weight >= CLEAR).length, emoted.length)};
  if (details) {
    console.log(`\n--- ${condition}: disagreements ---`);
    for (const row of rows) if (row.label !== row.unit.label && !(row.unit.accept ?? []).includes(row.label))
      console.log(`${row.unit.id} ${row.unit.profile}  gold ${row.unit.label}${row.unit.accept?.length ? '(' + row.unit.accept + ')' : ''}  got ${row.label} ${row.weight.toFixed(2)}  "${row.unit.text.slice(0, 90)}"`);
  }
}
console.log(`\nSegments: ${units.length} in ${replies.size} replies (${which}); bridge: ${process.env.PREVIOUS_BRIDGE ? process.env.PREVIOUS_BRIDGE : 'current'}`);
console.table(report);
if (jsonOut) await writeFile(resolve(jsonOut), JSON.stringify(report, null, 2) + '\n');
