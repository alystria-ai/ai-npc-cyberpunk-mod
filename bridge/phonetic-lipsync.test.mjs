import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {mkdtemp, mkdir, readFile, readdir, writeFile, rm, symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve, dirname} from 'node:path';
import {silentWav} from './speech-audio.mjs';
import {buildFacialTimeline} from './facial-timeline.mjs';
import {PhoneticLipsync, validateMouthCues} from './phonetic-lipsync.mjs';
import {phoneticPose} from './phonetic-poses.mjs';
import {SPEECH_TRACKS} from './facial-timeline.mjs';

function withPaths(executable, work, callback) {
  const names = ['CYBERPUNK_CONVAI_RHUBARB', 'CYBERPUNK_CONVAI_LIPSYNC_WORK'];
  const previous = names.map(name => process.env[name]);
  for (const [index, value] of [executable, work].entries()) {
    if (value === undefined) delete process.env[names[index]]; else process.env[names[index]] = value;
  }
  try { return callback(); }
  finally {
    for (const [index, value] of previous.entries()) {
      if (value === undefined) delete process.env[names[index]]; else process.env[names[index]] = value;
    }
  }
}

async function ownedFixture(t, prefix) {
  const base = resolve(tmpdir()), root = await mkdtemp(join(base, prefix));
  assert.equal(dirname(root), base);
  t.after(() => rm(root, {recursive: true, force: true}));
  return root;
}

test('development defaults remain unchanged and portable analysis captures absolute asset/data paths', () => {
  const project = resolve('relocated 模组 application'), executable = resolve(project, 'tools/rhubarb/rhubarb.exe');
  const work = resolve(project, '../persistent data/lipsync-work');
  const local = withPaths(undefined, undefined, () => new PhoneticLipsync({project}));
  assert.equal(local.executable, resolve(project, 'vendor/rhubarb-1.14.0/Rhubarb-Lip-Sync-1.14.0-Windows/rhubarb.exe'));
  assert.equal(local.scratch, resolve(project, 'runtime/lipsync-work'));
  const packaged = withPaths(executable, work, () => new PhoneticLipsync({project}));
  assert.equal(packaged.executable, executable); assert.equal(packaged.scratch, work);
  for (const [exe, directory] of [[executable, undefined], [undefined, work], ['rhubarb.exe', work],
    [executable, 'work'], [executable, resolve(project, 'mutable/cache')], [resolve(work, 'other.exe'), work]]) {
    assert.throws(() => withPaths(exe, directory, () => new PhoneticLipsync({project})), /absolute|paths together|remain separate/);
  }
});

test('relocated phonetic job preserves WAV bytes, uses the owned hidden helper and only removes its scratch files', async t => {
  const root = await ownedFixture(t, 'convai-phonetic-relocation-');
  const app = join(root, 'relocated 模组 application'), work = join(root, 'persistent data/lipsync-work');
  await mkdir(app); await mkdir(work, {recursive: true});
  await writeFile(join(work, 'preserved-user-file.txt'), 'keep');
  const executable = join(app, 'tools/rhubarb/rhubarb.exe'), audio = silentWav(), launches = [];
  const analyser = withPaths(executable, work, () => new PhoneticLipsync({project: app,
    spawnImpl(exe, args, options) {
      launches.push({exe, args, options});
      const child = new EventEmitter(); child.stderr = new PassThrough();
      child.kill = () => { throw Error('Successful fixture must not be killed'); };
      queueMicrotask(async () => {
        try {
          assert.deepEqual(await readFile(args.at(-1)), audio);
          await writeFile(args.at(-2), JSON.stringify({metadata: {duration: .1}, mouthCues: [{start: 0, end: .1, value: 'D'}]}));
          child.emit('close', 0);
        } catch (error) { child.emit('error', error); child.emit('close', 1); }
      });
      return child;
    }}));
  const result = await analyser.analyse(audio.toString('base64'));
  assert.deepEqual(audio, silentWav()); assert.equal(result.mouthCuesFormat, 'rhubarb-phonetic-v1');
  assert.equal(launches.length, 1); assert.equal(launches[0].exe, executable);
  assert.deepEqual(launches[0].args.slice(0, 10), ['--quiet', '--threads', '2', '-r', 'phonetic', '-f', 'json', '--extendedShapes', 'GHX', '-o']);
  assert.equal(launches[0].options.windowsHide, true); assert.equal(launches[0].options.shell, undefined);
  assert.deepEqual(launches[0].options.stdio, ['ignore', 'ignore', 'pipe']);
  assert.deepEqual(await readdir(work), ['preserved-user-file.txt']);
  assert.deepEqual(await readdir(app), []);
});

test('cancelling relocated analysis retires its exact child before cleanup and allows the next job', async t => {
  const root = await ownedFixture(t, 'convai-phonetic-cancel-');
  const app = join(root, 'app'), work = join(root, 'data/lipsync-work'); await mkdir(app);
  let started, kills = 0, count = 0;
  const spawning = new Promise(done => { started = done; });
  const analyser = withPaths(join(app, 'tools/rhubarb/rhubarb.exe'), work, () => new PhoneticLipsync({project: app,
    spawnImpl(_exe, args) {
      const child = new EventEmitter(); child.stderr = new PassThrough();
      child.kill = () => { kills++; setImmediate(() => child.emit('close', 1)); return true; };
      if (++count === 1) started();
      else queueMicrotask(async () => {
        await writeFile(args.at(-2), JSON.stringify({metadata: {duration: .1}, mouthCues: [{start: 0, end: .1, value: 'X'}]}));
        child.emit('close', 0);
      });
      return child;
    }}));
  const abort = new AbortController(), first = analyser.analyse(silentWav().toString('base64'), {signal: abort.signal});
  const rejected = assert.rejects(first, /cancelled/);
  await spawning; abort.abort(); await rejected; await analyser.tail;
  assert.equal(kills, 1); assert.deepEqual(await readdir(work), []);
  await analyser.analyse(silentWav().toString('base64'));
  assert.equal(count, 2); assert.deepEqual(await readdir(work), []);
});

test('linked scratch roots cannot redirect audio or helper output', async t => {
  const root = await ownedFixture(t, 'convai-phonetic-linked-');
  const app = join(root, 'app'), target = join(root, 'other-owned-directory'), link = join(root, 'scratch-link');
  await mkdir(app); await mkdir(target);
  await symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir');
  let launched = false;
  const analyser = withPaths(join(app, 'tools/rhubarb/rhubarb.exe'), link,
    () => new PhoneticLipsync({project: app, spawnImpl() { launched = true; throw Error('must not spawn'); }}));
  await assert.rejects(analyser.analyse(silentWav().toString('base64')), /Linked lip-sync work/);
  assert.equal(launched, false); assert.deepEqual(await readdir(target), []);
});

function sample() {
  const bytes = Buffer.concat([silentWav().subarray(0, 44), Buffer.alloc(24000 * 2 * 1.8)]);
  bytes.writeUInt32LE(bytes.length - 8, 4); bytes.writeUInt32LE(bytes.length - 44, 40);
  const cues = [...'ABCDEFGHX'].map((value, index) => ({value, start: index * .2, end: (index + 1) * .2}));
  return {bytes, cues};
}
test('local articulation distinguishes closure, vowels, rounding, F/V and L even during quiet consonants', () => {
  const {bytes, cues} = sample(), before = Buffer.from(bytes);
  const face = buildFacialTimeline({audio: bytes.toString('base64'), mouthCues: cues,
    mouthCuesFormat: 'rhubarb-phonetic-v1'}, {requestId: 'one', entity: 'judy'});
  const at = (time, name) => face.frames[Math.round(time * 60)][face.tracks.indexOf(name) + 1];
  assert.equal(face.source, 'local-phonetic'); assert.deepEqual(bytes, before);
  assert.equal(face.articulation, 'coarticulated-v5');
  assert.ok(at(.1, 'jaw_mid_open') > 0); assert.equal(at(.1, 'lips_together_up'), .85);
  assert.ok(at(.3, 'lips_l_stretch') > .08);
  assert.ok(at(.3, 'lips_apart_up') < .03);
  for (const track of ['lips_l_upper_raise', 'lips_r_upper_raise']) {
    assert.ok(at(.3,track)>0);
    assert.ok(face.frames.every(frame => frame[face.tracks.indexOf(track) + 1] <= .06),
      'independent upper lift stays within the rendered range with reduced aperture');
  }
  assert.ok(at(.3, 'lips_l_corner_stretch') > .1);
  assert.ok(at(.7, 'jaw_mid_open') > at(.5, 'jaw_mid_open'));
  assert.ok(at(.9, 'lips_l_funnel') > .2);
  assert.ok(at(1.1, 'lips_l_purse') > .2);
  assert.ok(at(1.3, 'lips_suck_dn') > .1);
  assert.equal(at(1.3,'lips_l_lower_raise'),0);
  assert.equal(at(1.3,'lips_r_lower_raise'),0);
  assert.ok(at(1.5, 'tongue_mid_tip_up') > .2);
  assert.ok(at(1.5,'jaw_mid_open')>=at(.5,'jaw_mid_open'));
  assert.ok(face.frames[Math.round(1.7 * 60)].slice(1).every(v => v === 0));
  assert.ok(face.frames.at(-1).slice(1).every(v => v === 0));
  assert.equal(face.tracks.some(name => /head|eye|brow/.test(name)), false);
});

test('rounded lips prepare before the jaw changes; quiet contact shapes survive varying effort', () => {
  const cues = [{start: 0, end: .5, value: 'D'}, {start: .5, end: 1, value: 'F'},
    {start: 1, end: 1.5, value: 'A'}, {start: 1.5, end: 2, value: 'G'}, {start: 2, end: 2.5, value: 'X'}];
  const at = (time, effort, track) => phoneticPose(cues, time, effort, SPEECH_TRACKS)[SPEECH_TRACKS.indexOf(track)];
  assert.ok(at(.44, .5, 'lips_l_purse') > 0);
  assert.equal(at(.44, .5, 'jaw_mid_open'), at(.3, .5, 'jaw_mid_open'));
  assert.ok(at(.3, .9, 'jaw_mid_open') > at(.3, .1, 'jaw_mid_open') * 1.25);
  assert.ok(at(1.25, 0, 'jaw_mid_open') > 0);
  assert.equal(at(1.25, 0, 'lips_together_up'), at(1.25, 1, 'lips_together_up'));
  assert.equal(at(1.75, 0, 'lips_suck_dn'), at(1.75, 1, 'lips_suck_dn'));
  assert.equal(at(1.75, 0, 'lips_l_lower_raise'),0);
  assert.ok(phoneticPose(cues, 2.25, 1, SPEECH_TRACKS).every(value => value === 0));
});

test('short bilabial closure survives transitions; malformed cue timing falls back without corrupting audio', () => {
  const {bytes, cues} = sample();
  const valid = {metadata: {duration: 1.8}, mouthCues: cues};
  assert.equal(validateMouthCues(valid, 1.8).length, 9);
  for (const bad of [{...cues[1], start: 0}, {...cues[1], value: 'Z'}, {...cues[1], end: NaN}]) {
    const altered = [...cues]; altered[1] = bad;
    assert.throws(() => validateMouthCues({...valid, mouthCues: altered}, 1.8), /Invalid/);
    assert.equal(buildFacialTimeline({audio: bytes.toString('base64'), mouthCues: altered,
      mouthCuesFormat: 'rhubarb-phonetic-v1'}, {requestId: 'one', entity: 'judy'}).source, 'audio-envelope');
  }
  const closed = buildFacialTimeline({audio: bytes.toString('base64'), mouthCuesFormat: 'rhubarb-phonetic-v1',
    mouthCues: [{start: 0, end: .45, value: 'D'}, {start: .45, end: .52, value: 'A'}, {start: .52, end: 1.8, value: 'F'}]},
  {requestId: 'one', entity: 'judy'});
  const frame = closed.frames[29]; // 483 ms, centre of a 70 ms M/P/B closure
  assert.ok(frame[1]>.1); assert.equal(frame[closed.tracks.indexOf('lips_together_up') + 1],.85);
});

test('brief internal lip closure preserves the neighbouring jaw trajectory without crossing rest',()=>{
  const track=name=>SPEECH_TRACKS.indexOf(name);
  const pose=(cues,at)=>phoneticPose(cues,at,1,SPEECH_TRACKS);
  const cues=[{start:0,end:.4,value:'D'},{start:.4,end:.47,value:'A'},{start:.47,end:.9,value:'D'}];
  const closed=pose(cues,.435);
  assert.equal(closed[track('jaw_mid_open')],.4);
  assert.equal(closed[track('lips_together_up')],.85);
  const bounded=[{start:0,end:.22,value:'D'},{start:.22,end:.4,value:'A'},{start:.4,end:1,value:'F'}];
  assert(pose(bounded,.31)[track('jaw_mid_open')]>.2); // .40-.22 has binary roundoff.
  for(const shape of ['X','A']){
    const adjacent=cues.map((cue,index)=>index===0?{...cue,value:shape}:cue);
    assert.equal(pose(adjacent,.435)[track('jaw_mid_open')],.08);
  }
  const long=[{start:0,end:.4,value:'D'},{start:.4,end:.7,value:'A'},{start:.7,end:1,value:'D'}];
  assert.equal(pose(long,.55)[track('jaw_mid_open')],.08);
  assert(pose([{start:0,end:1,value:'X'}],.5).every(value=>value===0));
});

test('all phoneme transitions remain finite and within calibrated native ranges',()=>{
  const shapes=[...'ABCDEFGHX'];
  for(const first of shapes)for(const second of shapes)for(const effort of [0,.5,1]){
    const cues=[{start:0,end:.12,value:first},{start:.12,end:.24,value:second}];
    for(let sample=0;sample<=24;sample++){
      const values=phoneticPose(cues,sample/100,effort,SPEECH_TRACKS);
      values.forEach((value,index)=>{
        const name=SPEECH_TRACKS[index];
        const limit=/together/.test(name)?.85:/upper_raise/.test(name)?.06:/lower_raise/.test(name)?.10:.4;
        assert(Number.isFinite(value)&&value>=0&&value<=limit+1e-9,`${first}/${second}: ${name}=${value}`);
      });
    }
  }
});
