// Independent jaw, lip and tongue trajectories from acoustic mouth cues.
// See docs/LIPSYNC_REFINEMENT.md for the research and the mapping limits.
export const PHONETIC_TRACKS = Object.freeze([
  'lips_l_lower_raise', 'lips_r_lower_raise', 'lips_tighten_up', 'lips_tighten_dn',
  'lips_suck_dn', 'tongue_mid_tip_up',
  'lips_l_upper_raise', 'lips_r_upper_raise', 'lips_l_corner_stretch', 'lips_r_corner_stretch',
]);
const poses = {
  X: {},
  A: {lips_together_up: .18, lips_together_dn: .18, lips_tighten_up: .06, lips_tighten_dn: .06},
  // Keep the individual upper raisers neutral after Judy's v2 distortion
  // report. Opening uses the jaw and lips_apart_up; zero these reserved
  // channels explicitly so old weights cannot persist.
  B: {jaw_mid_open: .085, lips_apart_up: .045, lips_apart_dn: .02, lips_l_stretch: .14, lips_r_stretch: .14,
    lips_l_corner_stretch: .065, lips_r_corner_stretch: .065},
  C: {jaw_mid_open: .28, lips_apart_up: .10, lips_apart_dn: .075, lips_l_stretch: .12, lips_r_stretch: .12,
    lips_l_corner_stretch: .04, lips_r_corner_stretch: .04},
  D: {jaw_mid_open: .40, lips_apart_up: .13, lips_apart_dn: .13},
  E: {jaw_mid_open: .22, lips_apart_up: .06, lips_apart_dn: .055,
    lips_l_funnel: .25, lips_r_funnel: .25, lips_l_purse: .10, lips_r_purse: .10},
  F: {jaw_mid_open: .085, lips_apart_up: .02, lips_apart_dn: .025,
    lips_l_funnel: .19, lips_r_funnel: .19, lips_l_purse: .28, lips_r_purse: .28},
  G: {jaw_mid_open: .035, lips_l_lower_raise: .17, lips_r_lower_raise: .17,
    lips_suck_dn: .14, lips_tighten_up: .04},
  H: {jaw_mid_open: .18, lips_apart_up: .055, lips_apart_dn: .055, tongue_mid_tip_up: .25},
};
const clamp = x => Math.max(0, Math.min(1, x));
const smooth = x => x * x * (3 - 2 * x);
const rounded = new Set(['lips_l_funnel', 'lips_r_funnel', 'lips_l_purse', 'lips_r_purse']);

function movement(track, incoming) {
  // Prepare rounded lips before the sound while the jaw is still finishing
  // the preceding syllable. Closures/tongue contacts need tighter timing.
  if (track === 'tongue_mid_tip_up') return [.028, .035];
  if (/together|tighten/.test(track)) return [.028, .035];
  if (track === 'jaw_mid_open') return [.045, .045];
  if (rounded.has(track) && /[EF]/.test(incoming)) return [.080, .060];
  return [.050, .050];
}

function sampleTrack(cues, index, at, track) {
  let left = cues[index], right = left, blend = 0;
  for (const boundary of [index - 1, index]) {
    const a = cues[boundary], b = cues[boundary + 1];
    if (!a || !b) continue;
    const [anticipation, release] = movement(track, b.value);
    // A short consonant still reaches its target. Long, indiscriminate
    // smoothing would erase the P/B/M seal and make everything a vowel.
    const lead = Math.min(anticipation, (a.end - a.start) * .38, (b.end - b.start) * .38);
    const tail = Math.min(release, (a.end - a.start) * .38, (b.end - b.start) * .38);
    if (at >= b.start - lead && at <= b.start + tail) {
      left = a; right = b; blend = smooth(clamp((at - b.start + lead) / (lead + tail))); break;
    }
  }
  return (poses[left.value][track] || 0) * (1 - blend) + (poses[right.value][track] || 0) * blend;
}

export function phoneticPose(cues, at, level, tracks) {
  let index = 0;
  while (index < cues.length - 1 && cues[index].end <= at) index++;
  const effort = clamp(level);
  return tracks.map(track => {
    const value = sampleTrack(cues, index, at, track);
    // A vowel is a trajectory, not a held photograph. Let syllable effort
    // change the opening and lip extension independently; never derive the
    // phoneme from loudness or erase a quiet consonant/tongue contact.
    if (track === 'jaw_mid_open') return value * (.68 + .32 * effort);
    if (/apart|stretch|funnel|purse|upper_raise/.test(track)) return value * (.88 + .12 * effort);
    return value;
  });
}
