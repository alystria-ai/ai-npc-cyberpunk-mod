// Read-only with respect to the provider and production mod. Writes descriptive
// experiment results; no prompt ranking is inferred from latency or word count.
import {readFile, writeFile} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';

const here = dirname(fileURLToPath(import.meta.url));
const read = async path => JSON.parse(await readFile(resolve(here, path), 'utf8'));
const receipt = await read('.private/receipt.json');
const complete = receipt.exchanges.filter(e => !e.abandoned && e.turns.length === 2
  && e.turns.every(t => t.result?.textComplete));
if (!receipt.completed || complete.length !== 18 || !receipt.profiles.every(p => p.cleanup?.profileAbsent))
  throw Error('Run must be complete and every disposable profile verified absent.');
const records = complete.flatMap(e => e.turns.map((t, index) => ({responseId: t.blindId,
  exchangeId: e.blindId, characterKey: e.characterKey, scenarioId: e.scenarioId, variant: e.variant,
  turn: index + 1, firstTextMs: t.result.firstTextMs, completeMs: t.result.completeMs,
  words: t.result.text.trim().split(/\s+/).length, response: t.result.text})));
const median = list => { const s = [...list].sort((a, b) => a - b); const n = s.length;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2; };
const summary = rows => ({replies: rows.length, medianFirstTextMs: Math.round(median(rows.map(x => x.firstTextMs))),
  medianCompleteMs: Math.round(median(rows.map(x => x.completeMs))),
  minFirstTextMs: Math.round(Math.min(...rows.map(x => x.firstTextMs))),
  maxFirstTextMs: Math.round(Math.max(...rows.map(x => x.firstTextMs))),
  medianWords: median(rows.map(x => x.words))});
const sessions = complete.map(e => e.turns[0].result.sessionId);
const isolation = {
  allProfilesMemoryDisabledReadback: receipt.profiles.every(p => p.verified?.memoryEnabled === false),
  allProfilesModelReadback: receipt.profiles.every(p => p.verified?.model === receipt.model),
  allProfilesSeparateFieldsReadback: receipt.profiles.every(p => p.verified?.separateFields === true),
  oneSessionWithinEveryPair: complete.every(e => e.turns[0].result.sessionId === e.turns[1].result.sessionId),
  distinctMeasuredSessions: new Set(sessions).size,
  sessionIdsUsable: sessions.every(x => typeof x === 'string' && x.length > 1 && x !== '-1'),
  laterExchangesReuseOneSyntheticUser: receipt.exchanges.slice(receipt.identityPolicyChange ? 5 : 0)
    .every(e => e.endUserId === receipt.benchmarkEndUserId),
  ownedProfilesCreated: receipt.profiles.length,
  ownedProfilesAbsenceVerified: receipt.profiles.filter(p => p.cleanup?.profileAbsent).length,
  textSends: receipt.dispatchedTurns, measuredReplies: records.length,
  abandonedSends: receipt.exchanges.filter(e => e.abandoned).reduce((n, e) => n + e.turns.length, 0),
};
if (Object.values(isolation).some(x => x === false) || isolation.distinctMeasuredSessions !== 18)
  throw Error('Experiment isolation is not established.');
const byCharacter = [...new Set(records.map(x => x.characterKey))].map(characterKey => ({characterKey,
  ...summary(records.filter(x => x.characterKey === characterKey))}));
const byTurn = [1, 2].map(turn => ({turn, ...summary(records.filter(x => x.turn === turn))}));
const timing = {version: 1, model: receipt.model, textOnly: true, all: summary(records), byCharacter, byTurn,
  connectionMedianMs: Math.round(median(complete.map(e => e.connection.connectionMs))), isolation};
await writeFile(resolve(here, 'summary.json'), JSON.stringify(timing, null, 2) + '\n');

// Keep the key out of the blind packet. This local file is ignored along with
// raw IDs, and is disclosed to the reviewer only after their scores are frozen.
const key = complete.map(e => ({exchangeId: e.blindId, scenarioId: e.scenarioId,
  characterKey: e.characterKey, blindLabel: e.blindLabel, variant: e.variant,
  responseIds: e.turns.map(t => t.blindId)}));
await writeFile(resolve(here, '.private/unblind-key.json'), JSON.stringify(key, null, 2) + '\n');
const digest = path => readFile(resolve(here, path)).then(bytes => createHash('sha256').update(bytes).digest('hex'));
const hashes = {blindSamples: await digest('blind-samples.json'), scenarios: await digest('scenarios.json'),
  rubric: await digest('RUBRIC.md'), conditions: await digest('conditions.mjs')};
await writeFile(resolve(here, 'artifact-hashes.json'), JSON.stringify(hashes, null, 2) + '\n');
let reviewed = false;
try { await readFile(resolve(here, 'COMPARISON.md')); reviewed = true; }
catch (error) { if (error.code !== 'ENOENT') throw error; }

let md = '# Dialogue prompting pilot: recorded run\n\n'
  + `Model: **${receipt.model}**. Completed ${records.length} measured text replies in ${complete.length} two-turn exchanges. `
  + `TTS, microphone, lipsync and local GPU inference were disabled. No production profile was changed.\n\n`
  + '## Timing\n\nClient-observed text timing begins when the user text is sent; connection setup is separate. '
  + 'These numbers do not measure speech latency or isolated model inference.\n\n'
  + '| Character | Replies | Median first text | Median complete text | First text range | Median words |\n'
  + '| --- | ---: | ---: | ---: | ---: | ---: |\n';
for (const x of byCharacter) md += `| ${x.characterKey} | ${x.replies} | ${x.medianFirstTextMs} ms | ${x.medianCompleteMs} ms | ${x.minFirstTextMs}–${x.maxFirstTextMs} ms | ${x.medianWords} |\n`;
md += `\nAcross all replies: median first text **${timing.all.medianFirstTextMs} ms**, completed text **${timing.all.medianCompleteMs} ms**. `
  + `New connection setup median: **${timing.connectionMedianMs} ms**.\n\n`
  + '| Within exchange | Median first text | Median complete text |\n| --- | ---: | ---: |\n';
for (const x of byTurn) md += `| Turn ${x.turn} | ${x.medianFirstTextMs} ms | ${x.medianCompleteMs} ms |\n`;
md += '\n## Isolation and cleanup\n\n'
  + `All ${isolation.ownedProfilesCreated} disposable profiles were removed with fresh absence readbacks. `
  + 'Every profile had its selected model, separate description fields and disabled memory verified before use. '
  + 'Each measured pair used one session; all 18 sessions were distinct.\n\n'
  + `The run dispatched ${isolation.textSends} text turns. One in-flight reply was abandoned when the operator changed synthetic-ID reuse policy; `
  + 'its output was not recorded or inspected. One replacement was explicitly authorized, in a new session, without repeating any Core mutation. '
  + 'Eight previously completed replies were retained. Five synthetic IDs had been allocated before the stop; subsequent exchanges reused the first. '
  + 'See [cleanup receipt summary](CLEANUP.md) and [design](DESIGN.md).\n\n'
  + '## Style evaluation\n\nNo winner is declared in this timing report. '
  + (reviewed ? 'The separate reviewer froze all scores before unblinding. See the [condition comparison](COMPARISON.md) '
    + 'and [reviewer interpretation](UNBLINDED_REVIEW.md); both preserve the original scores. '
    : 'The [anonymous sample sheet](BLIND_SAMPLES.md) and [structured samples](blind-samples.json) are ready for the separate blind reviewer. '
      + 'Conditions must remain concealed until their per-reply and per-exchange scores are frozen. ')
  + 'One generation per cell and one model-authored reviewer cannot establish a universal best prompt or human preference.\n\n'
  + 'The references and review rubric separate factual fidelity, selective disclosure, register, emotional specificity and adaptation to V\'s next turn. '
  + 'A response can be factually right while still sounding like a biography. A short answer can also be generic or evasive.\n';
await writeFile(resolve(here, 'RESULTS.md'), md);
console.log(JSON.stringify({completed: true, measuredReplies: records.length, cleanupVerified: true,
  medianFirstTextMs: timing.all.medianFirstTextMs, medianCompleteMs: timing.all.medianCompleteMs, hashes}));
