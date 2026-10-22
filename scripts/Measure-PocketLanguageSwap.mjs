// Drives the real Pocket worker (bridge/pocket-voice-worker.py) through language swaps and records the worker's memory and latency after each step.
//
//   node scripts/Measure-PocketLanguageSwap.mjs --python <python.exe> --source <pocket-tts source dir> --export <student export dir> --voices <references dir>
//        --work <work dir> --config <addons.pocket-voices style json, for the model hashes> --out <result.json> [--rounds 2]
//
// <references dir> holds picked/autobest/pocket/johnny-silverhand.wav (English voice), multilingual/<lang>/{manifest.json,picked/panam-palmer.wav} (voice packs) and
// multilingual-pocket/<lang>/ (the extracted Pocket model zips). Nothing is written outside <work dir> and <result.json>. Sequence: English, then each language, then
// back to English, for `rounds` rounds; one line each. The point is the memory column: a swap must not grow the worker without bound.
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFileSync, writeFileSync, mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {PocketVoice} from '../bridge/pocket-voice.mjs';
import {POCKET_LANGUAGES, loadPocketModel} from '../bridge/pocket-language-models.mjs';

const args = Object.fromEntries(process.argv.slice(2).reduce((rows, item, at, all) => item.startsWith('--') ? [...rows, [item.slice(2), all[at + 1]]] : rows, []));
for (const name of ['python', 'source', 'export', 'voices', 'work', 'config', 'out']) if (!args[name]) throw Error(`--${name} is required`);
const rounds = Number(args.rounds ?? 2);
const sha256 = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const base = JSON.parse(readFileSync(args.config, 'utf8').replace(/^﻿/, ''));
const voices = resolve(args.voices);
mkdirSync(args.work, {recursive: true});
const english = resolve(voices, 'picked/autobest/pocket/johnny-silverhand.wav');
const config = {version: 1, provider: 'pocket', engine: 'pocket-tts',
  runtime: {sourceDirectory: resolve(args.source), exportDirectory: resolve(args.export), referenceDirectory: voices, workDirectory: resolve(args.work)},
  model: base.model, cpu: {threads: 4}, sampling: {temperature: 0.3, decodeSteps: 1},
  voices: {'johnny-silverhand': {reference: 'runtime/voice-references/picked/autobest/pocket/johnny-silverhand.wav', sha256: sha256(english), transcript: 'One native reference line.'}},
  preparation: {startupProfiles: [], maxCachedProfiles: 8}};
const configPath = resolve(args.work, 'config.json');
writeFileSync(configPath, JSON.stringify(config));
const memory = pid => Number(execFileSync('powershell', ['-NoProfile', '-Command', `(Get-Process -Id ${pid}).WorkingSet64`], {encoding: 'utf8'}).trim()) / 1e6;

const client = new PocketVoice(config, {project: resolve(import.meta.dirname, '..'), configPath, pythonExecutable: resolve(args.python), onLog: line => { if (process.env.POCKET_LOG) process.stderr.write(line); }});
const t0 = performance.now();
await client.start();
const rows = [{step: 'start', ms: Math.round(performance.now() - t0), rssMB: Math.round(memory(client.child.pid))}];
console.log(JSON.stringify(rows[0]));

const sentences = {en: 'Night City is quiet tonight, let us go for a drink.', fr: 'Night City est calme ce soir, allons boire un verre.', it: 'Night City è tranquilla stasera, andiamo a bere qualcosa.',
  de: 'Night City ist heute Nacht ruhig, lass uns etwas trinken gehen.', es: 'Night City está tranquila esta noche, vamos a tomar algo.', pt: 'Night City está tranquila hoje, vamos tomar um drink.'};
async function speak(label, profile, text, pocketLanguage) {
  const started = performance.now();
  let first = null, frames = 0;
  const result = await client.synthesizeStream(profile, text, {pocketLanguage, onPcm: packet => { first ??= performance.now() - started; frames += packet.frames; }});
  const row = {step: label, firstAudioMs: Math.round(first), totalMs: Math.round(performance.now() - started), audioS: +(frames / 24000).toFixed(2),
    preparationSource: result.timing?.voicePreparationSource, rssMB: Math.round(memory(client.child.pid))};
  rows.push(row); console.log(JSON.stringify(row));
}
const tags = Object.entries(POCKET_LANGUAGES);
for (let round = 1; round <= rounds; round++) {
  await speak(`round ${round} en`, 'johnny-silverhand', sentences.en);
  for (const [folder, info] of tags) {
    const loaded = await loadPocketModel({directory: resolve(voices, 'multilingual-pocket', folder), language: folder});
    if (!loaded.model) throw Error(`${folder}: ${loaded.problem}`);
    const manifest = JSON.parse(readFileSync(resolve(voices, 'multilingual', folder, 'manifest.json'), 'utf8').replace(/^﻿/, ''));
    const entry = manifest.voices['panam-palmer'];
    const descriptor = {reference: `runtime/voice-references/multilingual/${folder}/${entry.file}`, sha256: sha256(resolve(voices, 'multilingual', folder, entry.file)), transcript: entry.text};
    await speak(`round ${round} ${info.tag}`, 'panam-palmer', sentences[info.tag], {tag: info.tag, folder, expected: loaded.model.expected, voices: {'panam-palmer': descriptor}});
    // A second reply in the same language finds the model resident: no swap.
    await speak(`round ${round} ${info.tag} again`, 'panam-palmer', sentences[info.tag], {tag: info.tag, folder, expected: loaded.model.expected, voices: {'panam-palmer': descriptor}});
  }
  await speak(`round ${round} en after languages`, 'johnny-silverhand', sentences.en);
}
await client.close();
writeFileSync(args.out, JSON.stringify(rows, null, 1));
const sizes = rows.map(row => row.rssMB).filter(Number.isFinite);
console.log(JSON.stringify({steps: rows.length, rssMinMB: Math.min(...sizes), rssMaxMB: Math.max(...sizes), rssLastMB: sizes.at(-1)}));
