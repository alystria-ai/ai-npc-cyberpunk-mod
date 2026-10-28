// OmniVoice phrase joins, before and after (bridge/speech-phrases.mjs, bridge/omni-join.mjs), on the real CUDA model.
//
// For each sample reply: the reply is cut by the OLD splitter (the `--before-ref` git ref, default integration/0.3.3's predecessor is not needed: any
// ref that still has the old bridge/speech-phrases.mjs) and by the NEW one; every phrase is rendered once by scripts/Render-OmniPhrases.py (the worker's
// own render call, alternating before and after in one process so the GPU and the game load are the same for both); then
//   BEFORE = the phrases exactly as the old bridge sent them (decoded and concatenated),
//   AFTER  = the new bridge's createOmniPcmVoice (cut, cropped, faded, level-matched, paused) fed the same renders.
// Writes <out>/<id>-before.wav and <id>-after.wav (24 kHz mono 16-bit) and report.json / report.txt with, per reply and median of `--repeat` runs:
//   (the first of --repeat rounds, default 3, is a warm-up and is not counted)
//   first word  = the first phrase's render time + the silence before its first word (the time to the first sound of speech)
//   finished    = when the last word has been played: phrases render one at a time, each plays when the one before it has ended and it is ready
//   dead air    = the longest silence between two phrases, and the sum of waits for an unfinished render
//
//   node scripts/Measure-OmniJoins.mjs --root "C:/path/to/dev checkout" --out deliverables/omni-joins --before-ref integration/0.3.4
//
// --root     the checkout that has runtime/local-voices.json, vendor/ (the OmniVoice snapshot and the reference clips); default: the parent folder's "Cyberpunk Mod"
// --memory-gib  cap on this process's CUDA memory (default 3: the game may be running)
import {spawn, execFileSync} from 'node:child_process';
import {mkdtemp, mkdir, writeFile, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve, dirname, join} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {createOmniPcmVoice, wavToPcm, OMNI_RATE} from '../bridge/omni-pcm.mjs';
import {splitSpeechText as splitNew} from '../bridge/speech-phrases.mjs';
import {encodePcmWav} from '../bridge/convai-audio-stream.mjs';
import {measureSpeech} from '../bridge/omni-join.mjs';

const here = dirname(fileURLToPath(import.meta.url)), project = resolve(here, '..');
const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, token, at, all) => {
  if (token.startsWith('--')) pairs.push([token.slice(2), all[at + 1]?.startsWith('--') || all[at + 1] === undefined ? true : all[at + 1]]);
  return pairs;
}, []));
const root = resolve(args.root ?? resolve(project, '../Cyberpunk Mod')), out = resolve(args.out ?? join(project, 'deliverables/omni-joins'));
const repeat = Math.max(1, Number(args.repeat ?? 3)), steps = Number(args.steps ?? 32), memory = String(args['memory-gib'] ?? 3);
const python = resolve(root, 'vendor/reference-voicestudio/.venv/Scripts/python.exe');

const REPLIES = [
  {id: '01', key: 'judy-alvarez', text: 'Hey V, I have been thinking about what happened last night. We could head down to the market together, pick up some food and talk about the next job. That sounds good to me.'},
  {id: '02', key: 'panam-palmer', text: 'Okay, listen. I don\'t like this place. Something feels off, and I think we are being watched. Let\'s get out of here before it gets worse, because I really don\'t want to find out who they are.'},
  {id: '03', key: 'johnny-silverhand', text: 'You want my honest opinion, choom? Burn it all down. Arasaka has been running this city for decades, and nobody ever made them pay for it. But sure, we can do it your way, if you really think a quiet approach is going to work this time.'},
  {id: '04', key: 'judy-alvarez', text: 'Wow, that was close! I thought we were done for. Are you okay? You took a pretty bad hit back there, so let me take a look at it before we do anything else. Then we can talk about what to do with the data we grabbed.'},
];

// The old splitter, from git (the module is self-contained).
const work = await mkdtemp(join(tmpdir(), 'omni-joins-'));
const oldFile = join(work, 'speech-phrases-old.mjs');
await writeFile(oldFile, execFileSync('git', ['-C', project, 'show', `${args['before-ref'] ?? 'integration/0.3.4'}:bridge/speech-phrases.mjs`], {encoding: 'utf8'}));
const {splitSpeechText: splitOld} = await import(pathToFileURL(oldFile).href);

// One job list: before/after of each reply, alternating, `repeat` times. With more than one round the first is a warm-up (the GPU's clocks and the first
// renders of a process are slower) and is left out of the numbers; the audio is the same every round (fixed seed).
const jobs = [];
for (let round = 0; round < repeat; round++) for (const reply of REPLIES) {
  jobs.push({name: `${reply.id}-before-${round}`, key: reply.key, phrases: splitOld(reply.text)});
  jobs.push({name: `${reply.id}-after-${round}`, key: reply.key, phrases: splitNew(reply.text)});
}
const jobFile = join(work, 'jobs.json'), renders = join(work, 'renders');
await writeFile(jobFile, JSON.stringify(jobs));
await new Promise((done, fail) => {
  const child = spawn(python, ['-I', join(here, 'Render-OmniPhrases.py'), '--root', root, '--jobs', jobFile, '--out', renders, '--steps', String(steps), '--memory-gib', memory], {stdio: ['ignore', 'inherit', 'ignore']});
  child.on('error', fail); child.on('exit', code => code === 0 ? done() : fail(Error('render failed ' + code)));
});
const timings = JSON.parse(await readFile(join(renders, 'timings.json'), 'utf8'));
await mkdir(out, {recursive: true});

const median = list => { const s = [...list].sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const seconds = frames => frames / OMNI_RATE;

// When is each phrase heard? Renders are one at a time from the start; a phrase plays when the previous one has ended and it is ready.
function schedule(renderTimes, lengths, firstWordFrames) {
  let ready = 0, playhead = 0, wait = 0;
  const starts = [];
  lengths.forEach((frames, at) => {
    ready += renderTimes[at];
    const start = Math.max(playhead, ready);
    if (at > 0) wait += Math.max(0, ready - playhead);
    starts.push(start); playhead = start + seconds(frames);
  });
  return {firstWord: starts[0] + seconds(firstWordFrames), finished: playhead, wait};
}

const report = [];
for (const reply of REPLIES) {
  const row = {id: reply.id, voice: reply.key, before: {runs: []}, after: {runs: []}};
  for (const side of ['before', 'after']) {
    for (let round = 0; round < repeat; round++) {
      const name = `${reply.id}-${side}-${round}`, job = timings.find(entry => entry.name === name);
      const wavs = await Promise.all(job.phrases.map((_, at) => readFile(join(renders, name, `p${String(at + 1).padStart(2, '0')}.wav`))));
      let pcm, lengths, firstWordFrames, longestGap = 0;
      if (side === 'before') {
        const parts = wavs.map(wavToPcm);
        pcm = Float32Array.from(parts.flatMap(part => [...part])); lengths = parts.map(part => part.length);
        firstWordFrames = measureSpeech(parts[0])?.start ?? 0;
        // The silence at the seam of two phrases: the first one's tail plus the next one's lead, as measured.
        parts.slice(1).forEach((part, at) => { const before = measureSpeech(parts[at]), now = measureSpeech(part); if (before && now) longestGap = Math.max(longestGap, seconds(parts[at].length - before.end + now.start)); });
      } else {
        const byText = new Map(job.phrases.map((phrase, at) => [phrase.text, wavs[at]]));
        const voice = createOmniPcmVoice({synthesize: async (profile, text) => ({audio: byText.get(text), timing: {}})});
        const packets = [], phrases = [];
        await voice.synthesizeStream(reply.key, reply.text, {onPcm: packet => packets.push(packet)});
        pcm = Float32Array.from(packets.flatMap(packet => [...packet.pcm]));
        // Phrase lengths as sent: re-run the same shaping to know each phrase's frames.
        const {PhraseJoiner} = await import('../bridge/omni-join.mjs');
        const joiner = new PhraseJoiner({rate: OMNI_RATE});
        job.phrases.forEach((phrase, at) => phrases.push(joiner.shape(wavToPcm(wavs[at]), {text: phrase.text, first: at === 0, last: at === job.phrases.length - 1})));
        lengths = phrases.map(part => part.length);
        firstWordFrames = measureSpeech(phrases[0])?.start ?? 0;
        let cursor = 0;
        phrases.forEach((part, at) => { const found = measureSpeech(part); if (at > 0 && found) { const prev = measureSpeech(phrases[at - 1]); longestGap = Math.max(longestGap, seconds(phrases[at - 1].length - prev.end + found.start)); } cursor += part.length; });
      }
      const when = schedule(job.phrases.map(phrase => phrase.took), lengths, firstWordFrames);
      row[side].runs.push({...when, longestGap, leadMs: firstWordFrames * 1000 / OMNI_RATE, firstRender: job.phrases[0].took, audioSeconds: seconds(pcm.length), renderSeconds: job.phrases.reduce((sum, phrase) => sum + phrase.took, 0), phrases: job.phrases.length, words: job.phrases.map(phrase => phrase.text.split(' ').length)});
      if (round === 0) await writeFile(join(out, `${reply.id}-${side}.wav`), Buffer.from(encodePcmWav(pcm, OMNI_RATE), 'base64'));
    }
    const runs = repeat > 1 ? row[side].runs.slice(1) : row[side].runs;
    Object.assign(row[side], Object.fromEntries(['firstWord', 'finished', 'wait', 'longestGap', 'audioSeconds', 'renderSeconds', 'leadMs', 'firstRender'].map(key => [key, median(runs.map(run => run[key]))])), {phrases: runs[0].phrases, words: runs[0].words});
  }
  report.push(row);
}
const f = value => value.toFixed(2);
const lines = [`OmniVoice joins on the CUDA model (${steps} steps), median of ${repeat > 1 ? repeat - 1 : 1} runs after a warm-up run; the GPU was shared with whatever else was running.`, ''];
for (const row of report) {
  lines.push(`${row.id} (${row.voice})`);
  for (const side of ['before', 'after']) {
    const r = row[side];
    lines.push(`  ${side.padEnd(6)} phrases ${r.words.join('/')}  silence before the first word ${r.leadMs.toFixed(0)} ms  first phrase render ${f(r.firstRender)} s  first word ${f(r.firstWord)} s (best run ${f(Math.min(...r.runs.map(run => run.firstWord)))})  finished ${f(r.finished)} s  waits for renders ${f(r.wait)} s  longest silence at a join ${f(r.longestGap)} s  speech+silence ${f(r.audioSeconds)} s  render total ${f(r.renderSeconds)} s`);
  }
}
const mean = (side, key) => report.reduce((sum, row) => sum + row[side][key], 0) / report.length;
lines.push('', `mean first word: ${f(mean('before', 'firstWord'))} s -> ${f(mean('after', 'firstWord'))} s;  mean finished: ${f(mean('before', 'finished'))} s -> ${f(mean('after', 'finished'))} s;  mean longest join silence: ${f(mean('before', 'longestGap'))} s -> ${f(mean('after', 'longestGap'))} s`);
await writeFile(join(out, 'report.txt'), lines.join('\n') + '\n');
await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n');
console.log(lines.join('\n'));
await rm(work, {recursive: true, force: true}).catch(() => {});
