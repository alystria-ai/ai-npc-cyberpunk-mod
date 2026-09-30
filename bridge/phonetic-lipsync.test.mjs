import {test} from 'node:test';
import assert from 'node:assert/strict';
import {silentWav} from './speech-audio.mjs';
import {buildFacialTimeline} from './facial-timeline.mjs';
import {validateMouthCues} from './phonetic-lipsync.mjs';
import {phoneticPose} from './phonetic-poses.mjs';
import {SPEECH_TRACKS} from './facial-timeline.mjs';

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
