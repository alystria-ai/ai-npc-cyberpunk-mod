// In-game A/B replay of the SAME audio with the previous local lip-sync and the
// game-trained model, through mod/speech-replay-probe.lua (no provider request).
//
//   node scripts/lipsync/stage_ab_fixture.mjs <wav> <old|new> [--faces source.json] [--profile judy-alvarez] [--install]
//
// Without --install it only writes the timeline next to the WAV for review.
// With --install it writes audio slot 7 and runtime/speech-fixture.json in the
// installed mod (120 s expiry); then request `speech-fixture:<profile>:<nonce>`
// through runtime/diagnostic-request.txt. "old" bakes the Lua easing that the
// phonetic path normally receives (the probe replays frames without motion).
import {readFile, writeFile} from 'node:fs/promises';
import {resolve, dirname, basename} from 'node:path';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {buildFacialTimeline} from '../../bridge/facial-timeline.mjs';
import {PhoneticLipsync} from '../../bridge/phonetic-lipsync.mjs';
import {JaliFace} from '../../bridge/jali-face.mjs';
import {storeSpeech} from '../../bridge/speech-audio.mjs';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const [wavPath, mode] = process.argv.slice(2);
const flag = name => process.argv.includes(name);
const option = (name, fallback) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : fallback; };
if (!wavPath || !['old', 'new'].includes(mode)) throw Error('usage: stage_ab_fixture.mjs <wav> <old|new> [--profile key] [--install]');
const bytes = await readFile(wavPath), audio = bytes.toString('base64'), owner = {requestId: 'ab-fixture', entity: 'fixture-owner'};

function bakeEase(face) {
  // mod/facial-playback.lua local-phonetic-smooth-v1 at 60 Hz audio time.
  const contact = new Set(['lips_together_up', 'lips_together_dn', 'tongue_mid_tip_up', 'lips_suck_dn']);
  const pose = face.tracks.map(() => 0);
  let last;
  const frames = face.frames.map(([at, ...values]) => {
    const elapsed = last === undefined ? 1 / 60 : Math.max(0, at - last); last = at;
    values.forEach((value, i) => {
      const seconds = contact.has(face.tracks[i]) && value > pose[i] ? .018 : .035;
      pose[i] += (value - pose[i]) * (1 - Math.exp(-elapsed / seconds));
    });
    return [at, ...pose.map(v => Math.round(v * 1e4) / 1e4)];
  });
  frames[frames.length - 1] = [frames.at(-1)[0], ...face.tracks.map(() => 0)];
  return {...face, frames, motion: undefined};
}

let face;
if (mode === 'old' && option('--faces')) {
  // Convai: the provider's ARKit timeline through the v10 retarget.
  face = buildFacialTimeline({audio, ...JSON.parse(await readFile(option('--faces'), 'utf8'))}, owner);
} else if (mode === 'old') {
  const cues = await new PhoneticLipsync({project}).analyse(audio);
  face = bakeEase(buildFacialTimeline({audio, ...cues}, owner));
} else {
  const model = await JaliFace.load(resolve(project, 'runtime/lipsync-model'));
  if (!model) throw Error('No local facial model in runtime/lipsync-model');
  face = buildFacialTimeline({audio, ...await model.analyseWav(audio)}, owner);
  await model.close();
}
const clean = Object.fromEntries(['version', 'source', 'articulation', 'duration', 'tracks', 'frames'].map(key => [key, face[key]]));
await writeFile(resolve(dirname(wavPath), `${basename(wavPath, '.wav')}-${mode}-timeline.json`), JSON.stringify(clean));
if (flag('--install')) {
  const game = process.env.CYBERPUNK_CONVAI_GAME || 'E:/SteamLibrary/steamapps/common/Cyberpunk 2077';
  const runtime = resolve(game, 'bin/x64/plugins/cyber_engine_tweaks/mods/AiNpcCyberpunkMod/runtime');
  const slot = await storeSpeech(audio, resolve(game, 'r6/audioware/CyberpunkConvai'), 7);
  const nonce = randomUUID().replaceAll('-', ''), profileKey = option('--profile', 'judy-alvarez');
  await writeFile(resolve(runtime, 'speech-fixture.json'), JSON.stringify({version: 1, nonce, profileKey,
    expiresAt: Math.floor(Date.now() / 1000) + 120, audio: slot, face: clean}));
  console.log(JSON.stringify({request: `speech-fixture:${profileKey}:${nonce}`, mode, source: clean.source, duration: slot.duration}));
} else console.log(JSON.stringify({mode, source: clean.source, articulation: clean.articulation, frames: clean.frames.length}));
