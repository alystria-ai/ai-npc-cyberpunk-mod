// Integration check through the same child-process transport used by the mod.
// Run only when the conversation bridge/local voice service is stopped.
import {readFile, writeFile, mkdir} from 'node:fs/promises';
import {resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {ResidentVoice, LOCAL_VOICE_KEYS} from '../bridge/resident-voice.mjs';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const configPath = resolve(project, 'runtime/local-voices.json');
const destination = resolve(project, 'runtime/local-voice-check');
await mkdir(destination, {recursive: true});
const report = {started: new Date().toISOString(), kind: 'integration-check',
  note: 'Current gameplay settings; not part of the RT Ultra 60 FPS comparison.', renders: []};
const client = new ResidentVoice(JSON.parse(await readFile(configPath, 'utf8')), {project, configPath,
  onState: state => { report.state = state; console.log(JSON.stringify(state)); },
  onLog: text => process.stderr.write(text)});
try {
  const started = performance.now(); await client.start(); report.startupMs = performance.now() - started;
  report.loaded = {...report.state};
  for (const [profile, steps] of [...LOCAL_VOICE_KEYS.map(key => [key, 32]), ['johnny-silverhand', 16]]) {
    client.setSteps(steps);
    const result = await client.synthesize(profile, 'Hey V. I am right here. Let us keep moving.');
    const bytes = Buffer.from(result.audio, 'base64');
    const file = `${profile}-${steps}.wav`;
    await writeFile(resolve(destination, file), bytes);
    report.renders.push({profile, steps, file, duration: result.wav.duration,
      sha256: createHash('sha256').update(bytes).digest('hex'), timing: result.timing});
  }
} finally {
  await client.close(); report.finished = new Date().toISOString();
  await writeFile(resolve(destination, 'result.json'), JSON.stringify(report, null, 2) + '\n');
}
console.log(JSON.stringify({startupMs: report.startupMs, renders: report.renders, loaded: report.loaded}));
