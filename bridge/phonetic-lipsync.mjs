import {spawn} from 'node:child_process';
import {mkdir, mkdtemp, writeFile, readFile, unlink, rmdir} from 'node:fs/promises';
import {resolve, join} from 'node:path';
import {inspectWav} from './speech-audio.mjs';
import {abortable, throwIfCancelled} from './transport-pool.mjs';

export function validateMouthCues(document, duration) {
  const cues = document?.mouthCues;
  if (!Number.isFinite(document?.metadata?.duration) || Math.abs(document.metadata.duration - duration) > 0.03
      || !Array.isArray(cues) || !cues.length || cues.length > 4000) throw Error('Invalid phonetic timeline');
  let end = 0;
  for (const cue of cues) {
    if (!Number.isFinite(cue?.start) || !Number.isFinite(cue.end) || cue.start < 0
        || Math.abs(cue.start - end) > 0.001 || cue.end <= cue.start || cue.end > duration + 0.03
        || !/^[A-HX]$/.test(cue.value)) throw Error('Invalid phonetic cue');
    end = cue.end;
  }
  if (Math.abs(end - duration) > 0.03) throw Error('Incomplete phonetic timeline');
  return cues.map(cue => ({...cue, end: Math.min(duration, cue.end)}));
}

// Rhubarb only analyses a byte-for-byte copy. Playback keeps the original WAV.
// Two CPU threads and one analyser at a time leave the GPU to the game/TTS.
export class PhoneticLipsync {
  constructor({project, executable, spawnImpl = spawn} = {}) {
    this.executable = executable || resolve(project, 'vendor/rhubarb-1.14.0/Rhubarb-Lip-Sync-1.14.0-Windows/rhubarb.exe');
    this.scratch = resolve(project, 'runtime/lipsync-work');
    this.spawn = spawnImpl;
    this.tail = Promise.resolve();
  }
  analyse(audio, {signal} = {}) {
    const job = this.tail.then(async () => {
      throwIfCancelled(signal);
      const bytes = Buffer.from(audio, 'base64'), {duration} = inspectWav(bytes);
      await mkdir(this.scratch, {recursive: true});
      const folder = await mkdtemp(join(this.scratch, 'phrase-'));
      const input = join(folder, 'source.wav'), output = join(folder, 'cues.json');
      const started = performance.now();
      try {
        await writeFile(input, bytes);
        throwIfCancelled(signal);
        await new Promise((done, fail) => {
          const child = this.spawn(this.executable, ['--quiet', '--threads', '2', '-r', 'phonetic',
            '-f', 'json', '--extendedShapes', 'GHX', '-o', output, input],
          {windowsHide: true, stdio: ['ignore', 'ignore', 'pipe']});
          let failure, log = '';
          const cancel = () => { failure = Error('Phonetic analysis cancelled'); child.kill(); };
          const timer = setTimeout(() => { failure = Error('Phonetic analysis timed out'); child.kill(); },
            Math.min(20000, 3500 + duration * 600));
          signal?.addEventListener('abort', cancel, {once: true});
          if (signal?.aborted) cancel();
          child.stderr.on('data', data => { if (log.length < 2000) log += data.toString(); });
          child.once('error', error => { failure = error; });
          child.once('close', code => {
            clearTimeout(timer); signal?.removeEventListener('abort', cancel);
            if (failure || code !== 0) fail(failure || Error(`Phonetic analysis failed (${code}): ${log.slice(-200)}`));
            else done();
          });
        });
        throwIfCancelled(signal);
        const raw = await readFile(output, 'utf8');
        if (raw.length > 1_000_000) throw Error('Oversized phonetic result');
        return {mouthCues: validateMouthCues(JSON.parse(raw), duration), mouthCuesFormat: 'rhubarb-phonetic-v1',
          timing: {lipAnalysisMs: performance.now() - started, lipEngine: 'rhubarb-1.14.0-phonetic'}};
      } finally {
        // Only the three paths created by this job are eligible for cleanup.
        await Promise.allSettled([unlink(input), unlink(output)]);
        await rmdir(folder).catch(() => {});
      }
    });
    this.tail = job.catch(() => {});
    return abortable(job, signal);
  }
}
