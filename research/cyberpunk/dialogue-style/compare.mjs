// Join the already frozen blind review to the condition key. No provider calls,
// generation, production updates or score edits. Public output contains no raw
// remote IDs from the private recovery receipt.
import {readFile, writeFile} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';

const here = dirname(fileURLToPath(import.meta.url));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const file = path => readFile(resolve(here, path));
const parse = bytes => JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''));
const frozen = {
  'blind-scores.json': '6ecfedf6c71facca122d5dc502a2d2da14c7709ef258bb810d0e1f5580fe66e1',
  'BLIND_REVIEW.md': '75e3c66fad361fc61d028b920dfc5244abf427c8841b6c641aecb8b4280b087c',
};
for (const [path, expected] of Object.entries(frozen)) {
  if (sha(await file(path)) !== expected) throw Error('Frozen review changed: ' + path);
}
const scores = parse(await file('blind-scores.json'));
const packetBytes = await file('blind-samples.json');
if (sha(packetBytes) !== scores.blindSamplesSha256) throw Error('Scored packet hash differs.');
for (const [path, expected] of Object.entries(scores.inputs)) {
  if (sha(await file(path)) !== expected) throw Error('Reviewed input changed: ' + path);
}
const packet = parse(packetBytes);
const mapping = parse(await file('.private/unblind-key.json'));
const timings = parse(await file('timings.json'));
const timingById = new Map(timings.records.map(x => [x.responseId, x]));
const mapByExchange = new Map(mapping.map(x => [x.exchangeId, x]));
const scoreById = new Map(scores.responses.map(x => [x.responseId, x]));
const order = ['reviewed-baseline', 'interaction-directives', 'native-few-shot'];
const label = {'reviewed-baseline': 'Reviewed baseline', 'interaction-directives': 'Added directives', 'native-few-shot': 'Native few-shot'};
const characters = ['johnny-silverhand', 'judy-alvarez', 'panam-palmer'];
const names = {'johnny-silverhand': 'Johnny', 'judy-alvarez': 'Judy', 'panam-palmer': 'Panam'};
const rows = [];
for (const group of packet.groups) {
  for (const variant of group.variants) {
    const mapped = mapByExchange.get(variant.exchangeId);
    if (!mapped || mapped.blindLabel !== variant.label || mapped.scenarioId !== group.scenarioId
      || !order.includes(mapped.variant)) throw Error('Blind mapping mismatch.');
    for (const [index, turn] of variant.turns.entries()) {
      const score = scoreById.get(turn.responseId), timing = timingById.get(turn.responseId);
      if (!score || !timing || score.exchangeId !== variant.exchangeId || score.turn !== index + 1
        || !mapped.responseIds.includes(turn.responseId) || sha(turn.response) !== score.responseSha256)
        throw Error('Response join mismatch: ' + turn.responseId);
      const derived = Object.entries(scores.weights).reduce((n, [dimension, weight]) => n + score.ratings[dimension] * weight / 4, 0)
        - score.copyingPenalty;
      const final = score.majorFactualPrivacyFailure ? Math.min(49, derived) : derived;
      if (Math.abs(final - score.finalTotal) > 0.001) throw Error('Frozen score arithmetic mismatch: ' + turn.responseId);
      const withoutPrefix = turn.response.replace(/^(Johnny(?: Silverhand)?|Judy(?: Alvarez)?|Panam(?: Palmer)?):\s*/u, '');
      rows.push({responseId: turn.responseId, exchangeId: variant.exchangeId, scenarioId: group.scenarioId,
        characterKey: mapped.characterKey, character: group.character, kind: group.kind,
        condition: mapped.variant, blindLabel: variant.label, turn: index + 1,
        user: turn.user, response: turn.response,
        ratings: score.ratings, copyingPenalty: score.copyingPenalty,
        majorFactualPrivacyFailure: score.majorFactualPrivacyFailure, finalTotal: score.finalTotal,
        confidence: score.confidence, rationale: score.rationale, flags: score.flags,
        observedSpeakerPrefix: withoutPrefix !== turn.response,
        spokenWords: withoutPrefix.trim().split(/\s+/u).length,
        firstTextMs: timing.firstTextMs, completeMs: timing.completeMs,
      });
    }
  }
}
if (rows.length !== 36 || new Set(rows.map(x => x.responseId)).size !== 36 || mapping.length !== 18)
  throw Error('Comparison coverage is incomplete.');
const mean = xs => xs.reduce((a, b) => a + b, 0) / xs.length;
const median = xs => { const s = [...xs].sort((a, b) => a - b); return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };
const round = x => Number(x.toFixed(2));
function aggregate(list) {
  return {replies: list.length, scoreMean: round(mean(list.map(x => x.finalTotal))),
    dimensionMeans: Object.fromEntries(Object.keys(scores.weights).map(key => [key, round(mean(list.map(x => x.ratings[key])))])),
    speakerPrefixes: list.filter(x => x.observedSpeakerPrefix).length,
    medianSpokenWords: median(list.map(x => x.spokenWords)),
    medianFirstTextMs: Math.round(median(list.map(x => x.firstTextMs))),
    medianCompleteMs: Math.round(median(list.map(x => x.completeMs))),
    flagCounts: Object.fromEntries([...new Set(list.flatMap(x => x.flags))].sort().map(flag => [flag, list.filter(x => x.flags.includes(flag)).length])),
  };
}
const overall = order.map(condition => ({condition, ...aggregate(rows.filter(x => x.condition === condition))}));
const byCharacter = characters.flatMap(characterKey => order.map(condition => ({characterKey, condition,
  ...aggregate(rows.filter(x => x.characterKey === characterKey && x.condition === condition))})));
const byScenario = packet.groups.flatMap(group => order.map(condition => ({characterKey: mapping.find(x => x.scenarioId === group.scenarioId).characterKey,
  scenarioId: group.scenarioId, kind: group.kind, condition,
  ...aggregate(rows.filter(x => x.scenarioId === group.scenarioId && x.condition === condition))})));
const exchanges = scores.exchanges.map(exchange => {
  const mapped = mapByExchange.get(exchange.exchangeId);
  const members = rows.filter(x => x.exchangeId === exchange.exchangeId);
  if (members.length !== 2 || Math.abs(mean(members.map(x => x.finalTotal)) - exchange.meanTotal) > 0.006)
    throw Error('Exchange score mismatch.');
  return {...exchange, characterKey: mapped.characterKey, condition: mapped.variant,
    meanFromFrozenReplies: round(mean(members.map(x => x.finalTotal)))};
});
const data = {version: 1, unblindedAt: new Date().toISOString(), model: timings.model,
  frozenReviewHashes: frozen, frozenInputs: scores.inputs,
  scorePolicy: 'Unmodified scores and rationales from the frozen model-authored blind review. Means are descriptive ordinal-score summaries, not statistical significance or human preference.',
  conditions: order.map(id => ({id, label: label[id]})), overall, byCharacter, byScenario, exchanges, responses: rows};
await writeFile(resolve(here, 'comparison.json'), JSON.stringify(data, null, 2) + '\n');

let md = '# Unblinded dialogue prompting comparison\n\n'
  + 'The two added approaches did **not** improve the reviewed baseline overall in this small pilot. '
  + 'The baseline had the highest descriptive mean, but none produced consistently convincing personal back-and-forth. '
  + 'Keep the baseline for now; do not promote either experiment as a general improvement.\n\n'
  + 'These are frozen judgments from one model-authored blind review of 36 replies, not a human panel or statistical test. '
  + 'Each character/scenario/condition has only one two-turn generation. Small differences are inconclusive. '
  + 'All response texts, ratings, rationales and timings are joined in [comparison.json](comparison.json). '
  + 'The [blind review](BLIND_REVIEW.md) and [scores](blind-scores.json) remain byte-for-byte unchanged.\n\n'
  + '## Overall descriptive results\n\n'
  + '| Condition | Mean / 100 | Name prefixes | Median spoken words | Median first text | Median complete text |\n'
  + '| --- | ---: | ---: | ---: | ---: | ---: |\n';
for (const x of overall) md += `| ${label[x.condition]} | ${x.scoreMean.toFixed(2)} | ${x.speakerPrefixes} / ${x.replies} | ${x.medianSpokenWords} | ${x.medianFirstTextMs} ms | ${x.medianCompleteMs} ms |\n`;
md += '\nBaseline: reviewed biography, style description and original samples. Added directives: that baseline plus '
  + 'individual guidance about responding to V\'s social intent and adapting after clarification. Native few-shot: '
  + 'the same added guidance, replacing original samples with five short installed-game lines and their contexts. '
  + 'Prompt lengths and sample topics differ; this is not a controlled token-budget ablation.\n\n'
  + '## By character\n\n| Character | Baseline | Added directives | Native few-shot | Interpretation |\n| --- | ---: | ---: | ---: | --- |\n';
const interpretations = {
  'johnny-silverhand': 'Added directives did not help. Native examples and baseline are effectively tied overall; all personal follow-ups still package his identity into a slogan.',
  'judy-alvarez': 'Native examples and baseline are effectively tied. Baseline handled the personal continuation better; native examples handled the coffee correction better.',
  'panam-palmer': 'Baseline led in both scenarios. The native-example condition weakened the personal exchange; do not treat source quotations as an automatic fidelity gain.',
};
for (const key of characters) {
  const values = order.map(condition => byCharacter.find(x => x.characterKey === key && x.condition === condition).scoreMean.toFixed(2));
  md += `| ${names[key]} | ${values.join(' | ')} | ${interpretations[key]} |\n`;
}
md += '\n## By character and scenario\n\nEach value is the mean of two frozen reply scores. '
  + 'The letter is the former anonymous label **within that group only**.\n\n'
  + '| Character / scenario | Baseline | Added directives | Native few-shot |\n| --- | ---: | ---: | ---: |\n';
for (const key of characters) for (const kind of ['personal-past', 'ordinary-present']) {
  const values = order.map(condition => {
    const x = byScenario.find(x => x.characterKey === key && x.kind === kind && x.condition === condition);
    const e = exchanges.find(e => e.scenarioId === x.scenarioId && e.condition === condition);
    return `${x.scoreMean.toFixed(2)} (${e.anonymousLabel})`;
  });
  md += `| ${names[key]} / ${kind} | ${values.join(' | ')} |\n`;
}
md += '\n## What remained unconvincing\n\n'
  + '- **Johnny\'s personal follow-up:** all three conditions produce a compact identity summary. '
  + 'The native-example answer ends with “a grudge and a loud guitar”; the directive answer says his identity is “just a reaction” to war. '
  + 'Brevity improved neither individuality nor the feeling that he is deciding what to share. No condition needs to ask “why?” to succeed.\n'
  + '- **Shared conversational templates:** all six Johnny/Judy personal follow-ups start with “Fair enough,” '
  + 'and all three Panam follow-ups start with “I appreciate that.” The fixed polite V follow-up partly invites acknowledgement, '
  + 'so repetition is an observed limitation, not proof that sessions leaked or the service ignored style fields. '
  + 'The run verified separate sessions and disabled memory.\n'
  + '- **Coffee uncertainty:** several replies assume deliberate cheating or vendor error before evidence supports it. '
  + 'Some then joke about a fight V never proposed; two replace the stall with a machine. None first suggests checking the receipt. '
  + 'Accepting V\'s second-turn correction is useful, but does not erase the first-turn overreaction.\n'
  + '- **Name-label echoes:** 12 of 36 replies begin with the character\'s name: eight baseline, four directive, zero native-example. '
  + 'This is an output-format defect, kept separate from personality scores. Samples in multiple conditions use labels, '
  + 'so this small count does not prove that changing the example source fixes it. No score was retroactively reduced.\n'
  + '- **Source fidelity has limits:** the reviewer found no major quest, romance or private-memory leak, '
  + 'but flagged minor invented details and biographical imprecision. No held-out quote match was detected; '
  + 'that is not an exhaustive proof of originality.\n\n'
  + '## Narrow next experiment, if approved\n\n'
  + 'Test **Johnny only**, keeping the reviewed biography and speaking-style field unchanged. Compare the baseline '
  + 'against the same profile whose sample field contains two short **original multi-turn demonstrations** of '
  + 'choosing a small disclosure and revising an everyday assumption. Derive their delivery from inspected scenes, '
  + 'without copying scene lines, importing their trust state, or teaching the test answers.\n\n'
  + 'Use two fresh topics, three turns each, with two independent generations per condition: 24 replies total. '
  + 'A third turn tests whether Johnny follows the listener\'s direction or repeats another identity slogan. '
  + 'Keep any dialogue-only formatting instruction identical in both conditions and report prefix errors separately. '
  + 'This targets the clearest unresolved behavior; repeating the broad three-character trial with more adjectives is not supported by these results. '
  + 'No follow-up API calls or production changes have been made.\n\n'
  + '## All 36 scored replies joined\n\n'
  + 'Ratings are rhythm / register / personality / context / agency, each 0–4. '
  + 'IDs link directly to the unchanged text in the [blind packet](BLIND_SAMPLES.md) and structured comparison.\n\n'
  + '| Reply | Character / scenario | Condition | Turn | Ratings | Total | Prefix |\n| --- | --- | --- | ---: | --- | ---: | --- |\n';
for (const row of [...rows].sort((a, b) => characters.indexOf(a.characterKey) - characters.indexOf(b.characterKey)
  || a.scenarioId.localeCompare(b.scenarioId) || order.indexOf(a.condition) - order.indexOf(b.condition) || a.turn - b.turn)) {
  md += `| ${row.responseId} | ${names[row.characterKey]} / ${row.kind} | ${label[row.condition]} | ${row.turn} | ${Object.keys(scores.weights).map(k => row.ratings[k]).join(' / ')} | ${row.finalTotal.toFixed(2)} | ${row.observedSpeakerPrefix ? 'yes' : 'no'} |\n`;
}
md += '\n## Integrity and limits\n\n'
  + `- Frozen score SHA256: ${frozen['blind-scores.json']}.\n`
  + `- Frozen review SHA256: ${frozen['BLIND_REVIEW.md']}.\n`
  + '- The join verifies all reviewed input hashes, all 36 raw response hashes, all reply IDs, all 18 exchange mappings and score arithmetic.\n'
  + '- One model-authored evaluator, prior familiarity with the dossiers, small scene samples and fixed V continuations limit interpretation. '
  + 'There is no statistical significance claim, human preference result, voice-performance assessment or proof of long-term conversational stability.\n'
  + '- The one administratively interrupted reply was excluded before inspection and replaced under explicit authorization. '
  + 'All disposable profiles were removed. [Run and cleanup details](CLEANUP.md).\n';
await writeFile(resolve(here, 'COMPARISON.md'), md);
console.log(JSON.stringify({verifiedFrozenHashes: true, joinedReplies: rows.length, joinedExchanges: exchanges.length,
  overall: overall.map(x => ({condition: x.condition, scoreMean: x.scoreMean, speakerPrefixes: x.speakerPrefixes})),
  productionChanges: 0, apiCalls: 0}));
