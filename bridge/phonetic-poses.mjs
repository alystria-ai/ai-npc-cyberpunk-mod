// Continuous, conservative 3D retargeting of Rhubarb's nine mouth shapes.
// These are articulatory poses, not replacements for gaze or facial idle.
export const PHONETIC_TRACKS = Object.freeze([
  'lips_l_lower_raise', 'lips_r_lower_raise', 'lips_tighten_up', 'lips_tighten_dn',
  'lips_suck_dn', 'tongue_mid_tip_up',
]);
const poses = {
  X: {},
  A: {lips_together_up: .18, lips_together_dn: .18, lips_tighten_up: .06, lips_tighten_dn: .06},
  B: {jaw_mid_open: .055, lips_apart_up: .025, lips_apart_dn: .025, lips_l_stretch: .11, lips_r_stretch: .11},
  C: {jaw_mid_open: .20, lips_apart_up: .07, lips_apart_dn: .11, lips_l_stretch: .10, lips_r_stretch: .10},
  D: {jaw_mid_open: .34, lips_apart_up: .10, lips_apart_dn: .17},
  E: {jaw_mid_open: .18, lips_apart_up: .055, lips_apart_dn: .08,
    lips_l_funnel: .22, lips_r_funnel: .22, lips_l_purse: .09, lips_r_purse: .09},
  F: {jaw_mid_open: .065, lips_apart_up: .02, lips_apart_dn: .025,
    lips_l_funnel: .15, lips_r_funnel: .15, lips_l_purse: .25, lips_r_purse: .25},
  G: {jaw_mid_open: .045, lips_l_lower_raise: .14, lips_r_lower_raise: .14,
    lips_suck_dn: .11, lips_tighten_up: .04},
  H: {jaw_mid_open: .11, lips_apart_up: .04, lips_apart_dn: .06, tongue_mid_tip_up: .25},
};
const smooth = x => x * x * (3 - 2 * x);

export function phoneticPose(cues, at, level, tracks) {
  let index = 0;
  while (index < cues.length - 1 && cues[index].end <= at) index++;
  let left = cues[index], right = left, blend = 0;
  // Round vowels a little in advance. Short P/B/M closures retain their
  // centre; broad smoothing must never smear them into a permanently open jaw.
  for (const boundary of [index - 1, index]) {
    const a = cues[boundary], b = cues[boundary + 1];
    if (!a || !b) continue;
    const lead = Math.min(/[EF]/.test(b.value) ? .05 : .025, (a.end - a.start) * .3, (b.end - b.start) * .3);
    const tail = Math.min(.035, (b.end - b.start) * .3, (a.end - a.start) * .3);
    if (at >= b.start - lead && at <= b.start + tail) {
      left = a; right = b; blend = smooth((at - (b.start - lead)) / (lead + tail)); break;
    }
  }
  const a = poses[left.value], b = poses[right.value];
  return tracks.map(track => {
    const value = (a[track] || 0) * (1 - blend) + (b[track] || 0) * blend;
    // Energy gently modulates jaw travel only. Quiet consonants and silent
    // bilabial closures still have distinct shapes; X alone is relaxed rest.
    return value * (track === 'jaw_mid_open' ? .85 + .15 * level : 1);
  });
}
