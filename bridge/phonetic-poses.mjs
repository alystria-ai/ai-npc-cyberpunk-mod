// Independent jaw, lip and tongue trajectories from acoustic mouth cues.
// See docs/LIPSYNC_REFINEMENT.md for the research and the mapping limits.
export const PHONETIC_TRACKS = Object.freeze([
  'lips_l_lower_raise', 'lips_r_lower_raise', 'lips_tighten_up', 'lips_tighten_dn',
  'lips_suck_dn', 'tongue_mid_tip_up',
  'lips_l_upper_raise', 'lips_r_upper_raise', 'lips_l_corner_stretch', 'lips_r_corner_stretch',
]);
export const PHONETIC_ARTICULATION = 'coarticulated-v5';
const poses = {
  X: {},
  // Native contact is a jaw-dependent corrective. A pressed P/B/M closure is
  // distinct from rest and can close over a partly open jaw.
  A: {jaw_mid_open: .08, lips_together_up: .85, lips_together_dn: .85, lips_tighten_up: .06, lips_tighten_dn: .06},
  // Independent lip lift replaces part of the old aggregate aperture, using
  // the native ranges rendered on Judy. Corner stretch shapes the corners;
  // native inner stretch has a different, smaller contribution.
  B: {jaw_mid_open: .085, lips_apart_up: .02, lips_apart_dn: .01, lips_l_stretch: .10, lips_r_stretch: .10,
    lips_l_corner_stretch: .16, lips_r_corner_stretch: .16,
    lips_l_upper_raise: .03, lips_r_upper_raise: .03, lips_l_lower_raise: .03, lips_r_lower_raise: .03},
  C: {jaw_mid_open: .28, lips_apart_up: .03, lips_apart_dn: .035, lips_l_stretch: .10, lips_r_stretch: .10,
    lips_l_corner_stretch: .14, lips_r_corner_stretch: .14,
    lips_l_upper_raise: .05, lips_r_upper_raise: .05, lips_l_lower_raise: .06, lips_r_lower_raise: .06},
  D: {jaw_mid_open: .40, lips_apart_up: .04, lips_apart_dn: .045,
    lips_l_upper_raise: .06, lips_r_upper_raise: .06, lips_l_lower_raise: .10, lips_r_lower_raise: .10},
  E: {jaw_mid_open: .22, lips_apart_up: .06, lips_apart_dn: .055,
    lips_l_funnel: .25, lips_r_funnel: .25, lips_l_purse: .10, lips_r_purse: .10},
  F: {jaw_mid_open: .085, lips_apart_up: .02, lips_apart_dn: .025,
    lips_l_funnel: .19, lips_r_funnel: .19, lips_l_purse: .28, lips_r_purse: .28},
  // The native lower_raise actually depresses/retracts the lower lip. It must
  // not oppose the upward/inward lower roll used by the F/V contact shape.
  G: {jaw_mid_open: .035, lips_suck_dn: .14, lips_tighten_up: .04},
  H: {jaw_mid_open: .28, lips_apart_up: .03, lips_apart_dn: .035, tongue_mid_tip_up: .25,
    lips_l_upper_raise: .04, lips_r_upper_raise: .04, lips_l_lower_raise: .06, lips_r_lower_raise: .06},
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

function target(cues, index, at, track) {
  const cue = cues[index], value = poses[cue.value][track] || 0;
  if (track !== 'jaw_mid_open' || cue.value !== 'A' || cue.end-cue.start > .18 + 1e-9) return value;
  const before=cues[index-1], after=cues[index+1];
  // Short internal bilabials close the lips while the jaw travels between
  // neighbouring sounds. Long, edge and pause-adjacent closures use the small
  // relaxed jaw target; never bridge an X/rest interval or invent asymmetry.
  if (!before || !after || /[AX]/.test(before.value) || /[AX]/.test(after.value)) return value;
  const left=poses[before.value].jaw_mid_open || 0, right=poses[after.value].jaw_mid_open || 0;
  return left + (right-left)*smooth(clamp((at-cue.start)/(cue.end-cue.start)));
}

function sampleTrack(cues, index, at, track) {
  let left = index, right = index, blend = 0;
  for (const boundary of [index - 1, index]) {
    const a = cues[boundary], b = cues[boundary + 1];
    if (!a || !b) continue;
    const [anticipation, release] = movement(track, b.value);
    // A short consonant still reaches its target. Long, indiscriminate
    // smoothing would erase the P/B/M seal and make everything a vowel.
    const lead = Math.min(anticipation, (a.end - a.start) * .38, (b.end - b.start) * .38);
    const tail = Math.min(release, (a.end - a.start) * .38, (b.end - b.start) * .38);
    if (at >= b.start - lead && at <= b.start + tail) {
      left = boundary; right = boundary+1; blend = smooth(clamp((at - b.start + lead) / (lead + tail))); break;
    }
  }
  return target(cues,left,at,track)*(1-blend)+target(cues,right,at,track)*blend;
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
