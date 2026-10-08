// Accuracy of the facial emotion selector on labelled companion exchanges (assets/emotion/exchanges-*.json).
//   node scripts/Evaluate-EmotionSelector.mjs [dev|holdout|all] [--details] [--json OUT]
// Compares the previous text path (emotion-analysis.mjs v1 behaviour: reply text only, warm resting smile) with the
// current selector (bridge/emotion-selector.mjs: player message + reply, character manner, neutral rest). For each it
// reports the reply-level family, the share that is exactly right or acceptable, the confusion matrix, and the
// "false smile" rate: replies whose gold feeling is negative or calm but whose face shows visible smiling corners
// while speaking (the real pose function, with each character's resting warmth and corner gain).
import {readFile, writeFile} from 'node:fs/promises';
import {resolve, dirname} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {baselineFromSignal} from '../bridge/emotion-analysis.mjs';
import {selectEmotion, SELECTOR_LABEL, restingFor} from '../bridge/emotion-selector.mjs';
import {mixTarget, expressionTarget} from '../bridge/companion-expressions.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// PREVIOUS_BRIDGE=<dir> runs the previous path from another copy of bridge/ (for example `git show HEAD:...`
// extracted to a scratch folder), so "previous" is exactly the code that was installed.
const previousBridge = process.env.PREVIOUS_BRIDGE ? pathToFileURL(resolve(process.env.PREVIOUS_BRIDGE) + '/').href
  : new URL('../bridge/', import.meta.url).href;
const {analyseReply} = await import(new URL('emotion-analysis.mjs', previousBridge).href);
const {textExpression} = await import(new URL('text-emotion.mjs', previousBridge).href);

const args = process.argv.slice(2), which = args.find(arg => !arg.startsWith('--')) || 'all';
const details = args.includes('--details'), jsonOut = args.includes('--json') ? args[args.indexOf('--json') + 1] : undefined;
const LABELS = ['joy', 'warm', 'interest', 'surprise', 'sadness', 'fear', 'anger', 'disgust', 'calm'];
const NEGATIVE = new Set(['sadness', 'fear', 'anger', 'disgust']);
const FAMILY_LABEL = {joy: 'joy', trust: 'warm', anticipation: 'interest', surprise: 'surprise', sadness: 'sadness',
  fear: 'fear', anger: 'anger', disgust: 'disgust'};
// A smile reads at about .15 corner-up on the rig (October 6/7 face-test screenshots: .22 is a soft resting smile).
const SMILE_VISIBLE = .15;

// The Lua resting warmth/gain table before this change (mod/facial-playback.lua, October 7).
const OLD_WARM = new Set(['jackie-welles', 'panam-palmer', 'kerry-eurodyne', 'misty-olszewski', 'mama-welles', 'river-ward',
  'claire-russell', 'dexter-deshawn', 'padre-ibarra', 'viktor-vektor']);
const OLD_DRY = new Set(['johnny-silverhand', 'rogue-amendiares', 'takemura', 'saul-bright', 'meredith-stout', 'solomon-reed',
  'spider-murphy', 'r3n0', 'regina-jones']);
const OLD_COLD = new Set(['adam-smasher', 'yorinobu-arasaka', 'hanako-arasaka', 'alan-noel', 'mr-hands']);
function oldResting(profile) {
  if (profile === 'judy-alvarez') return {warmth: .14, gain: 1.6};
  if (OLD_WARM.has(profile)) return {warmth: .22, gain: 1};
  if (OLD_DRY.has(profile)) return {warmth: .07, gain: 1};
  if (OLD_COLD.has(profile)) return {warmth: 0, gain: 1};
  return {warmth: .15, gain: 1};
}

function peakSmile(plan, resting) {
  let peak = 0;
  for (const segment of plan?.segments || []) {
    const pose = mixTarget({weights: segment.weights, phase: 'speaking', warmth: resting.warmth, gain: resting.gain});
    peak = Math.max(peak, pose.lips_l_corner_up);
  }
  if (!plan?.segments?.length) peak = mixTarget({weights: {}, phase: 'speaking', ...resting}).lips_l_corner_up;
  return Math.round(peak * 1000) / 1000;
}

const SELECTORS = {
  previous: item => {
    let plan;
    // Production wrapped the planner in try/catch and fell back to text-emotion.mjs's single cue.
    try { plan = analyseReply(item.reply, {profile: item.profile, mode: 'legacy'}); } catch {
      const cue = textExpression(item.reply, {profile: item.profile}), resting = oldResting(item.profile);
      const pose = expressionTarget({emotion: {emotion: cue.emotion, scale: cue.scale}, phase: 'speaking', ...resting});
      return {label: cue.basis === 'default' ? 'calm' : FAMILY_LABEL[{Joy: 'joy', Trust: 'trust', Interest: 'anticipation'}[cue.emotion]
        ?? cue.emotion.toLowerCase()], smile: Math.round(pose.lips_l_corner_up * 1000) / 1000, crashed: true};
    }
    const summary = plan.summary;
    return {label: summary.basis === 'default' ? 'calm' : FAMILY_LABEL[summary.family], smile: peakSmile(plan, oldResting(item.profile))};
  },
  selector: item => {
    const plan = selectEmotion({player: item.player, reply: item.reply, profile: item.profile});
    return {label: SELECTOR_LABEL(plan), smile: peakSmile(plan, restingFor(item.profile)), plan};
  },
};
// Sets recorded from real Convai turns also carry Convai's own label for that reply.
const WITH_CONVAI = {
  convai: item => {
    const family = item.convai ? baselineFromSignal({...item.convai, basis: 'ordered'})?.family : undefined;
    const weights = family ? {[family]: [.4, .67, 1][(item.convai.scale || 1) - 1]} : {};
    return {label: family ? FAMILY_LABEL[family] : 'calm', smile: peakSmile({segments: [{weights}]}, restingFor(item.profile))};
  },
  'selector+convai': item => {
    const plan = selectEmotion({player: item.player, reply: item.reply, profile: item.profile,
      convai: item.convai ? {...item.convai, basis: 'ordered'} : undefined});
    return {label: SELECTOR_LABEL(plan), smile: peakSmile(plan, restingFor(item.profile)), plan};
  },
};

async function load(name) { return JSON.parse(await readFile(resolve(root, `assets/emotion/exchanges-${name}.json`), 'utf8')); }
const sets = which === 'all' ? ['dev', 'holdout', 'blind', 'real'] : [which];
const report = {};
for (const set of sets) {
  const items = await load(set);
  report[set] = {};
  const selectors = items.some(item => 'convai' in item) ? {...SELECTORS, ...WITH_CONVAI} : SELECTORS;
  for (const [name, select] of Object.entries(selectors)) {
    const confusion = Object.fromEntries(LABELS.map(gold => [gold, Object.fromEntries(LABELS.map(label => [label, 0]))]));
    let exact = 0, acceptable = 0, negatives = 0, falseSmiles = 0, calms = 0, calmSmiles = 0, timeMs = 0;
    const misses = [];
    for (const item of items) {
      const started = performance.now(), out = select(item);
      timeMs += performance.now() - started;
      confusion[item.label][out.label]++;
      const ok = out.label === item.label, fine = ok || (item.accept || []).includes(out.label);
      exact += ok; acceptable += fine;
      const smiling = out.smile >= SMILE_VISIBLE;
      if (NEGATIVE.has(item.label)) { negatives++; if (smiling) falseSmiles++; }
      if (item.label === 'calm') { calms++; if (smiling) calmSmiles++; }
      if (!fine || (smiling && (NEGATIVE.has(item.label) || item.label === 'calm'))) misses.push({id: item.id, gold: item.label,
        got: out.label, smile: out.smile, player: item.player, reply: item.reply,
        ...(out.plan ? {evidence: out.plan.evidence} : {})});
    }
    report[set][name] = {n: items.length, exact: +(exact / items.length).toFixed(3), acceptable: +(acceptable / items.length).toFixed(3),
      falseSmileNegative: `${falseSmiles}/${negatives}`, smileOnCalm: `${calmSmiles}/${calms}`,
      msPerReply: +(timeMs / items.length).toFixed(3), confusion, misses};
  }
}

const pad = (value, width) => String(value).padStart(width);
for (const [set, byName] of Object.entries(report)) {
  console.log(`\n=== ${set} (${Object.values(byName)[0].n} exchanges) ===`);
  for (const [name, r] of Object.entries(byName)) {
    console.log(`${name.padEnd(15)} exact ${(r.exact * 100).toFixed(1)}%  acceptable ${(r.acceptable * 100).toFixed(1)}%  `
      + `false smiles on negative ${r.falseSmileNegative}  smiles on calm ${r.smileOnCalm}  ${r.msPerReply} ms/reply`);
  }
  for (const [name, r] of Object.entries(byName)) {
    console.log(`\n${name}: rows = gold, columns = chosen`);
    console.log('          ' + LABELS.map(label => pad(label.slice(0, 5), 6)).join(''));
    for (const gold of LABELS) console.log(gold.padEnd(10) + LABELS.map(label => pad(r.confusion[gold][label] || '.', 6)).join(''));
    if (details) for (const miss of r.misses) console.log(`  ${miss.id} gold ${miss.gold} got ${miss.got} smile ${miss.smile} | ${miss.player} => ${miss.reply}`
      + (miss.evidence ? `\n      ${JSON.stringify(miss.evidence)}` : ''));
  }
}
if (jsonOut) await writeFile(resolve(jsonOut), JSON.stringify(report, null, 2));
