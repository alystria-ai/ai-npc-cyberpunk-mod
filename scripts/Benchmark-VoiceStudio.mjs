import {readFile, writeFile, mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {VoiceStudioClient} from '../bridge/voice-studio.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const registryFile = resolve(root, 'runtime/voice-studio-profiles.json');
const registry = JSON.parse(await readFile(registryFile, 'utf8').catch(e => { if (e.code === 'ENOENT') return '{}'; throw e; }));
registry.provider = 'voicestudio'; registry.profiles ??= {};
registry.engine = process.argv.find(a => a.startsWith('--engine='))?.slice(9) || 'omnivoice';
registry.steps = Number(process.argv.find(a => a.startsWith('--steps='))?.slice(8) || 32);
registry.timeoutMs = 120_000;
const manifest = JSON.parse(await readFile(resolve(root, 'runtime/voice-references/extracted/manifest.json'), 'utf8'));
const roster = JSON.parse(await readFile(resolve(root, 'characters/roster.json'), 'utf8'));
const selected = JSON.parse(await readFile(resolve(root, 'runtime/voice-references/selected-benchmark.json'), 'utf8'));
const chosen = Object.fromEntries(selected.clips.map(c => [c.key, c.stringId]));
const keys = (process.argv.find(a => a.startsWith('--keys='))?.slice(7) || 'ana-friedman,blue-moon').split(',');
const label = process.argv.find(a => a.startsWith('--label='))?.slice(8) || '';
const runs = Number(process.argv.find(a => a.startsWith('--runs='))?.slice(7) || 2);
if (label && !/^[a-z0-9-]{1,32}$/.test(label)) throw Error('Invalid comparison label');
if (!Number.isInteger(runs) || runs < 1 || runs > 4) throw Error('Invalid comparison run count');
let client = new VoiceStudioClient(registry);
await client.health();
for (const key of keys) {
  const candidate = manifest.candidates.find(c => c.key === key && c.stringId === chosen[key]);
  if (!candidate || !candidate.source.sha1Verified || !candidate.transcript?.trim()) throw Error('A verified reference is required for ' + key);
  const audio = await readFile(candidate.wavPath);
  const sha256 = createHash('sha256').update(audio).digest('hex');
  if (sha256 !== candidate.wav.sha256) throw Error('Reference audio changed for ' + key);
  if (registry.profiles[key]?.referenceSha256 !== sha256) {
    const saved = await client.createProfile({name: 'AI NPC Cyberpunk Mod - ' + roster.find(p => p.key === key).name,
      audio, transcript: candidate.transcript});
    registry.profiles[key] = {id: saved.id, referenceSha256: sha256, referenceStringId: candidate.stringId,
      listeningVerified: false, purpose: 'engine comparison'};
    await writeFile(registryFile, JSON.stringify(registry, null, 2) + '\n');
    console.log('Saved local comparison profile: ' + key);
  }
}
if (process.argv.includes('--setup-only')) process.exit(0);
client = new VoiceStudioClient(registry);
const directory = resolve(root, 'runtime/voice-comparison', registry.engine + (registry.steps === 32 ? '' : `-${registry.steps}steps`) + (label ? '-' + label : ''));
await mkdir(directory, {recursive: true});
const text = 'Hey V, good to see you. Where are we headed next?';
const report = {engine: registry.engine, steps: registry.steps, text, processing: 'raw; speed 1; no mastering, denoising or postprocessing',
  note: 'First run includes model load; subsequent runs measure warm whole-WAV generation, not first audio packet.', runs: []};
for (const key of keys) {
  for (let run = 0; run < runs; run++) {
    const started = Date.now();
    try {
      const result = await client.synthesize(key, text);
      const path = resolve(directory, `${key}-${run}.wav`);
      await writeFile(path, Buffer.from(result.audio, 'base64'));
      const row = {key, run, elapsedMs: Date.now() - started, ...result.wav, timing: result.timing, path};
      report.runs.push(row); console.log(JSON.stringify(row));
    } catch (error) {
      report.runs.push({key, run, elapsedMs: Date.now() - started, error: error.message});
      console.error(key + ': ' + error.message);
      await writeFile(resolve(directory, 'report.json'), JSON.stringify(report, null, 2));
      process.exitCode = 1; break;
    }
    await writeFile(resolve(directory, 'report.json'), JSON.stringify(report, null, 2));
  }
  if (process.exitCode) break;
}
