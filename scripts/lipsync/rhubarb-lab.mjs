// Developer lab tool only (scripts/lipsync/stage_ab_fixture.mjs, the "old" side of the A/B replay): runs the Rhubarb copy kept in vendor/ over a
// WAV and returns its mouth cues. Nothing in bridge/ uses it and the Runtime ships no Rhubarb: a line with no cues from the lip-sync model plays
// on its audio envelope. Get the copy with scripts/Setup-PhoneticLipsync.ps1.
import {spawnSync} from 'node:child_process';
import {mkdtempSync, writeFileSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve, join} from 'node:path';
import {inspectWav} from '../../bridge/speech-audio.mjs';
import {validateMouthCues} from '../../bridge/mouth-cues.mjs';

export class PhoneticLipsync {
  constructor({project}) {
    this.executable = resolve(project, 'vendor/rhubarb-1.14.0/Rhubarb-Lip-Sync-1.14.0-Windows/rhubarb.exe');
  }
  // `audio` is a base64 WAV; resolves {mouthCues, mouthCuesFormat} for buildFacialTimeline.
  async analyse(audio) {
    const bytes = Buffer.from(audio, 'base64'), {duration} = inspectWav(bytes);
    const folder = mkdtempSync(join(tmpdir(), 'rhubarb-lab-')), input = join(folder, 'source.wav'), output = join(folder, 'cues.json');
    try {
      writeFileSync(input, bytes);
      const run = spawnSync(this.executable, ['--quiet', '--threads', '2', '-r', 'phonetic', '-f', 'json', '--extendedShapes', 'GHX', '-o', output, input],
        {windowsHide: true, encoding: 'utf8', timeout: 60000});
      if (run.error || run.status !== 0) throw Error(`Rhubarb failed (${run.error?.message ?? run.status}): ${(run.stderr ?? '').slice(-200)}`);
      return {mouthCues: validateMouthCues(JSON.parse(readFileSync(output, 'utf8')), duration), mouthCuesFormat: 'rhubarb-phonetic-v1'};
    } finally { rmSync(folder, {recursive: true, force: true}); }
  }
}
