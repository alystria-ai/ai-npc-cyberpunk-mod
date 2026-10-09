// Pure expression policy. The native adapter must merge this with speech and
// call ConvaiFaceApply only once per owned actor. No actor handles, timers,
// network calls, text sentiment analysis, blink or gaze ownership live here.
const finite = value => typeof value === 'number' && Number.isFinite(value);
const clamp = (value, max = 1) => Math.max(0, Math.min(max, value));
const plain = value => value && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));

export const EXPRESSION_TRACKS = Object.freeze([
  'lips_l_corner_up', 'lips_r_corner_up', 'lips_l_corner_dn', 'lips_r_corner_dn',
  'eye_l_brows_raise_in', 'eye_r_brows_raise_in',
  'eye_l_brows_raise_out', 'eye_r_brows_raise_out', 'eye_l_brows_lower', 'eye_r_brows_lower',
  // Duchenne smile: the lower-lid/outer-eye squint that makes a smile read as genuine (and, since October 9,
  // the narrowed eyes of anger and disgust).
  'eye_l_oculi_squint_outer_lower', 'eye_r_oculi_squint_outer_lower',
  // October 9: widened eyes for surprise and fear. Blink and gaze stay out of expression ownership.
  'eye_l_widen', 'eye_r_widen',
  // October 9 (evening): native rig controls added to the graph layer: brows pulled together, upper-lid lowering,
  // inner squint, nose wrinkle, chin raise. Lua writes them only when the installed feature has them.
  'eye_l_brows_lateral', 'eye_r_brows_lateral', 'eye_l_oculi_squint_outer_upper', 'eye_r_oculi_squint_outer_upper',
  'eye_l_oculi_squint_inner', 'eye_r_oculi_squint_inner', 'nose_l_snear', 'nose_r_snear', 'lips_chin_raise',
]);
export const EXPRESSION_POLICY = Object.freeze({
  // October 6 recalibration. The game's own dialogue lipsync (6938 extracted
  // lines) does not vary these controls smoothly: it holds one constant mood
  // offset per line. Smile = corner up .10 with brows raise .10 (39 % of
  // lines); frown = corner down .20 with brows lower .324 (20 %). The earlier
  // caps (.12/.10/.20, speech 60 %, rest .025) were below those authored
  // offsets (frowns at half strength), so every expression was invisible.
  // October 6 live face-test on Judy (writer mode, screenshots): a smile reads
  // clearly at .35-.5 and 1.0 is an exaggerated grin; the first recalibration
  // (peaks <= .20, rest .06) was still invisible. Peaks below are the visible,
  // natural range: smile .45, frown .40, brows ~.45-.5.
  // October 9: in a blend (mixTarget) a family weight w moves the frowns and brows by w^mixCurve of its pose, so
  // subtle and medium feelings read while speaking; full feelings and the caps are unchanged; the smile stays
  // linear. Trust (warm) smiles .35, was .25.
  // October 9 (later), in-game captures of Judy at conversation distance: every control reaches the rig, but
  // brows read only from about .5, corners down stay subtle on her rig even at 1, the squint and widened eyes
  // read from about .3. Frowns and brows nearly doubled, eyes added, caps raised; smiles unchanged.
  version: 7, mixCurve: .6, restSmile: .12, squintMax: .5, widenMax: .6, squintPerSmile: .6, gainCapMax: 1.3, cornerUpMax: .80, cornerDownMax: .80, browRaiseMax: .90, browLowerMax: .90,
  speechMouthFactor: .85, attackSeconds: .18, releaseSeconds: .55,
  // Categorical scale 1..3 (Convai) -> fraction of the family's full pose.
  scaleStrength: Object.freeze([.4, .67, 1]),
  positiveAfterSpeechMs: 4000, negativeAfterSpeechMs: 8000,
});
// The only provider channels admitted by the native expression adapter. Their
// timestamps remain identical to the accepted speech timeline's timestamps.
export const PROVIDER_EXPRESSION_INDICES = Object.freeze([23, 24, 25, 26, 41, 42, 43, 44, 45]);

/** Bind a transport-qualified optional signal to the already accepted game
 * request. A raw SDK emotionChange body has no correlation authority. */
export function ownedExpressionReceipt(signal, owner) {
  if (!sameExpressionOwner(owner, owner) || signal?.version !== 1 || signal.correlated !== true
      || !Number.isSafeInteger(signal.sequence) || signal.sequence < 0) return undefined;
  const parsed = normalizeConvaiEmotion(signal);
  if (!parsed) return undefined;
  return {version: 1, entity: owner.entity, requestId: owner.requestId, generation: owner.generation,
    sequence: signal.sequence, emotion: parsed.emotion, scale: parsed.scale};
}
const limits = Object.freeze(Object.fromEntries(EXPRESSION_TRACKS.map(track => [track,
  track.includes('squint_outer_upper') ? .8 : track.includes('squint_inner') ? .6
  : track.includes('squint') ? EXPRESSION_POLICY.squintMax
  : track.includes('widen') ? EXPRESSION_POLICY.widenMax
  : track.includes('snear') ? .6 : track === 'lips_chin_raise' ? .5
  : track.includes('corner_up') ? EXPRESSION_POLICY.cornerUpMax
    : track.includes('corner_dn') ? EXPRESSION_POLICY.cornerDownMax
      : track.includes('lower') ? EXPRESSION_POLICY.browLowerMax : EXPRESSION_POLICY.browRaiseMax])));
const zero = () => Object.fromEntries(EXPRESSION_TRACKS.map(track => [track, 0]));
const negative = new Set(['anger', 'sadness', 'fear', 'disgust']);
// These are rendering aliases for explicit provider labels, not a claim that
// Convai guarantees this closed taxonomy. Unrecognized labels stay neutral.
const families = new Map([
  ['joy', 'joy'], ['happy', 'joy'], ['happiness', 'joy'], ['ecstasy', 'joy'], ['serenity', 'joy'],
  ['trust', 'trust'], ['acceptance', 'trust'], ['admiration', 'trust'], ['love', 'trust'],
  ['sadness', 'sadness'], ['sad', 'sadness'], ['grief', 'sadness'], ['pensiveness', 'sadness'],
  ['anger', 'anger'], ['angry', 'anger'], ['rage', 'anger'], ['annoyance', 'anger'],
  ['fear', 'fear'], ['terror', 'fear'], ['apprehension', 'fear'], ['anxiety', 'fear'],
  ['disgust', 'disgust'], ['loathing', 'disgust'], ['boredom', 'disgust'],
  ['surprise', 'surprise'], ['amazement', 'surprise'], ['distraction', 'surprise'],
  ['anticipation', 'anticipation'], ['interest', 'anticipation'], ['vigilance', 'anticipation'],
  ['neutral', 'neutral'], ['none', 'neutral'],
]);

/** SDK 1.7 emotionChange body; scale is categorical 1..3, not an ARKit weight.
 * Transport/response ownership must be established before admitting the body.
 * A null return means malformed/reset; an unknown valid label is neutral.
 */
export function normalizeConvaiEmotion(value) {
  if (!plain(value) || typeof value.emotion !== 'string') return null;
  const label = value.emotion.trim();
  if (!label || label.length > 80 || /[\u0000-\u001f\u007f]/u.test(label)) return null;
  const scale = value.scale === undefined ? 1 : value.scale;
  if (!Number.isInteger(scale) || scale < 1 || scale > 3) return null;
  return Object.freeze({version: 1, emotion: label, family: families.get(label.toLowerCase()) || 'unknown', scale});
}

/** Compare game request ownership only; never invent it from a late SDK event. */
export function sameExpressionOwner(left, right) {
  const valid = owner => plain(owner) && typeof owner.entity === 'string' && owner.entity.length > 0
    && owner.entity.length <= 128 && typeof owner.requestId === 'string' && owner.requestId.length > 0
    && owner.requestId.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(owner.entity + owner.requestId)
    && Number.isSafeInteger(owner.generation) && owner.generation >= 0;
  return valid(left) && valid(right) && left.entity === right.entity
    && left.requestId === right.requestId && left.generation === right.generation;
}

/** One metadata lease per managed copy, with bounded post-speech expression.
 * The adapter supplies an already correlated owner and monotonic local time.
 * Cancellation/dismissal uses clear(); normal audible completion uses end().
 */
export class OwnedExpressionSignal {
  constructor(entity) {
    if (typeof entity !== 'string' || !entity || entity.length > 128) throw Error('Invalid expression actor');
    this.entity = entity; this.clear();
  }
  begin(owner) {
    if (!sameExpressionOwner(owner, owner) || owner.entity !== this.entity) throw Error('Invalid expression owner');
    this.owner = Object.freeze({entity: owner.entity, requestId: owner.requestId, generation: owner.generation});
    this.sequence = -1; this.emotion = null; this.expiry = null; this.active = true;
  }
  accept(value, owner, sequence) {
    if (!this.active || !sameExpressionOwner(this.owner, owner)
      || !Number.isSafeInteger(sequence) || sequence < 0 || sequence <= this.sequence) return false;
    const parsed = normalizeConvaiEmotion(value);
    if (!parsed) return false;
    this.emotion = parsed; this.sequence = sequence; return true;
  }
  end(owner, nowMs) {
    if (!this.active || !sameExpressionOwner(this.owner, owner) || !finite(nowMs) || nowMs < 0) return false;
    this.active = false;
    this.expiry = nowMs + (negative.has(this.emotion?.family)
      ? EXPRESSION_POLICY.negativeAfterSpeechMs : EXPRESSION_POLICY.positiveAfterSpeechMs);
    this.endedAt = nowMs; return true;
  }
  read(nowMs) {
    if (!finite(nowMs) || nowMs < 0) return null;
    if (!this.active && this.expiry !== null && (nowMs < this.endedAt || nowMs >= this.expiry)) this.clear();
    return this.emotion;
  }
  clear() {
    this.owner = null; this.emotion = null; this.active = false;
    this.sequence = -1; this.expiry = null; this.endedAt = null;
  }
}

export function emotionSuppressesSmile(value) {
  const family = normalizeConvaiEmotion(value)?.family;
  return negative.has(family) || family === 'unknown';
}

function pair(target, stem, value) { target[`lips_l_${stem}`] = target[`lips_r_${stem}`] = value; }
function brows(target, stem, value) { target[`eye_l_brows_${stem}`] = target[`eye_r_brows_${stem}`] = value; }
// Unit-pose channels and the tracks they write (mirrors channelTracks in mod/facial-playback.lua; droop, the held
// lid close on the blink control, is Lua-only).
const CHANNEL_TRACKS = Object.freeze({up: ['lips_l_corner_up', 'lips_r_corner_up'], dn: ['lips_l_corner_dn', 'lips_r_corner_dn'],
  in: ['eye_l_brows_raise_in', 'eye_r_brows_raise_in'], out: ['eye_l_brows_raise_out', 'eye_r_brows_raise_out'],
  low: ['eye_l_brows_lower', 'eye_r_brows_lower'], sq: ['eye_l_oculi_squint_outer_lower', 'eye_r_oculi_squint_outer_lower'],
  wide: ['eye_l_widen', 'eye_r_widen'], lat: ['eye_l_brows_lateral', 'eye_r_brows_lateral'],
  lid: ['eye_l_oculi_squint_outer_upper', 'eye_r_oculi_squint_outer_upper'], sqi: ['eye_l_oculi_squint_inner', 'eye_r_oculi_squint_inner'],
  snear: ['nose_l_snear', 'nose_r_snear'], chin: ['lips_chin_raise'], droop: []});
function channel(target, key, value) { for (const track of CHANNEL_TRACKS[key]) target[track] = value; }
function providerPose(frame, family) {
  if (!plain(frame) || frame.format !== 'arkit61' || !Array.isArray(frame.values)
    || frame.values.length !== 61 || !frame.values.every(finite)) return null;
  const out = zero(), v = index => clamp(frame.values[index]);
  out.eye_l_brows_lower = .55 * v(41); out.eye_r_brows_lower = .55 * v(42);
  brows(out, 'raise_in', .45 * v(43));
  out.eye_l_brows_raise_out = .40 * v(44); out.eye_r_brows_raise_out = .40 * v(45);
  // Smile is also an "ee" speech shape. Only explicit positive metadata grants
  // additional smile intent; source smile values never classify the dialogue.
  if (family === 'joy' || family === 'trust') {
    out.lips_l_corner_up = .30 * v(23); out.lips_r_corner_up = .30 * v(24);
  } else {
    out.lips_l_corner_dn = .30 * v(25); out.lips_r_corner_dn = .30 * v(26);
  }
  return out;
}

function mouthBudget(speechPose, phase) {
  const read = name => finite(speechPose?.[name]) ? clamp(speechPose[name]) : 0;
  const closure = clamp(Math.max(read('lips_together_up'), read('lips_together_dn')) / .85);
  const rounding = clamp(Math.max(read('lips_l_funnel'), read('lips_r_funnel')) / .32
    + Math.max(read('lips_l_purse'), read('lips_r_purse')) / .28);
  return (phase === 'speaking' ? EXPRESSION_POLICY.speechMouthFactor : 1) * (1 - closure) * (1 - rounding);
}

/** Complete expression-only target. Native adapters may pass verified timed
 * ARKit61 poses, or omit them for Omni/fallback. Jaw/lip contact/visemes are
 * read only as conflict budgets and are never changed by this function.
 */
export function expressionTarget({emotion = null, phase = 'idle', speechPose = {}, providerFrame, blocked = false,
  warmth = EXPRESSION_POLICY.restSmile, gain = 1, smile = 1} = {}) {
  if (!['idle', 'listening', 'thinking', 'speaking'].includes(phase)) throw Error('Unknown expression phase');
  const out = zero();
  if (blocked) return out;
  let smileRaw = 0; // the emotion's smile before the character's smile multiplier (the squint follows this one)
  const parsed = normalizeConvaiEmotion(emotion), family = parsed?.family;
  const strength = parsed ? EXPRESSION_POLICY.scaleStrength[parsed.scale - 1] : 0;
  switch (family) {
    case 'joy': pair(out, 'corner_up', .45 * strength * smile); smileRaw = .45 * strength; brows(out, 'raise_out', .30 * strength); break;
    case 'trust': pair(out, 'corner_up', .35 * strength * smile); smileRaw = .35 * strength; break;
    case 'sadness': case 'anger': case 'fear': case 'disgust': case 'surprise':
      for (const [key, value] of Object.entries(FAMILY_POSES[family])) channel(out, key, value * strength);
      break;
    case 'anticipation': brows(out, 'raise_out', .15 * strength); break;
    case 'unknown': break; // A new provider label must not become a happy face.
    // No intent: the resting smile shows while idle and while talking.
    default: break;
  }
  let frowning = false;
  if (providerFrame !== undefined) {
    const source = providerPose(providerFrame, family);
    if (!source) return zero(); // Unqualified formats have no expression authority.
    for (const track of EXPRESSION_TRACKS) out[track] = Math.max(out[track], source[track]);
    if (source.lips_l_corner_dn > .005 || source.lips_r_corner_dn > .005
      || source.eye_l_brows_lower > .01 || source.eye_r_brows_lower > .01) { pair(out, 'corner_up', 0); frowning = true; }
  }
  if (negative.has(family) || family === 'unknown') pair(out, 'corner_up', 0);
  if (family === 'joy' || family === 'trust') {
    pair(out, 'corner_dn', 0); brows(out, 'lower', 0);
  }
  // Resting warmth is a floor under every non-negative intent (Interest, surprise,
  // neutral tone), while idle and while speaking; the emotion's own smile wins by max.
  // Idle only (October 8): while speaking the bridge's selector alone decides; Lua also holds it off after a sad turn.
  // October 9: listening and thinking keep the idle face too; only the audible reply changes it.
  if (phase !== 'speaking' && !negative.has(family) && family !== 'unknown' && !frowning
    && out.lips_l_corner_dn === 0)
  { pair(out, 'corner_up', Math.max(out.lips_l_corner_up, warmth)); smileRaw = Math.max(smileRaw, warmth); }
  return finishPose(out, {speechPose, phase, gain, smileRaw});
}

// Per-character corner gain (full lips read weakly), the Duchenne squint that
// follows the smile before mouth priority, then the mouth budget and the caps.
function finishPose(out, {speechPose, phase, gain, smileRaw}) {
  const capScale = Math.min(Math.max(gain, 1), EXPRESSION_POLICY.gainCapMax);
  for (const track of ['lips_l_corner_up', 'lips_r_corner_up', 'lips_l_corner_dn', 'lips_r_corner_dn']) out[track] *= gain;
  // The smile's own squint (Duchenne) or the feeling's narrowed eyes, whichever is stronger.
  const smileForSquint = smileRaw > 0 && out.lips_l_corner_up > 0 ? smileRaw * gain : out.lips_l_corner_up;
  const squint = Math.min(EXPRESSION_POLICY.squintMax,
    Math.max(out.eye_l_oculi_squint_outer_lower, EXPRESSION_POLICY.squintPerSmile * smileForSquint));
  out.eye_l_oculi_squint_outer_lower = squint; out.eye_r_oculi_squint_outer_lower = squint;
  const budget = mouthBudget(speechPose, phase);
  for (const track of EXPRESSION_TRACKS) {
    if (track.startsWith('lips_')) out[track] *= budget;
    out[track] = clamp(out[track], limits[track] * (track.includes('corner_') ? capScale : 1));
  }
  return out;
}

// Unit poses (family weight 1) for the blended path. They equal the single-label
// poses above at strength 1; mod/facial-playback.lua mirrors them.
export const FAMILY_POSES = Object.freeze({
  joy: {up: .45, out: .30}, trust: {up: .35},
  sadness: {dn: .75, in: .85, lat: .35, droop: .30, chin: .35},
  anger: {dn: .40, low: .80, lat: .70, lid: .80, sq: .40, sqi: .60, snear: .35, chin: .35, droop: .25},
  fear: {dn: .25, in: .80, out: .50, lat: .50, wide: .45}, disgust: {dn: .50, low: .60, snear: .60, sq: .25, chin: .20},
  surprise: {in: .60, out: .90, wide: .55}, anticipation: {out: .15},
});
export const MIX_FAMILIES = Object.freeze(['joy', 'trust', 'sadness', 'anger', 'fear', 'disgust', 'surprise', 'anticipation']);
// Smile or frown is decided on the earlier corner balance (linear), so the bigger frown poses (October 9) do
// not tip a joyful bittersweet line into a frown; the winner then shows at its own pose. Mirrors Lua cornerVote.
const CORNER_VOTE = Object.freeze({joy: {up: .45}, trust: {up: .35}, sadness: {dn: .40}, anger: {dn: .25}, fear: {dn: .15},
  disgust: {dn: .30}, surprise: {}, anticipation: {}});
const softSum = values => { const max = Math.max(0, ...values), sum = values.reduce((a, b) => a + b, 0); return max + .4 * (sum - max); };

/** Blend several emotion families (weights 0..1, array in MIX_FAMILIES order or
 * an object) into one complete ten-track pose: bittersweet states (a slight
 * smile with sad brows) stay inside the same caps, and mouth priority is the
 * single-label rule (closure/rounding budget, speech keeps 85 %). */
export function mixTarget({weights, phase = 'idle', speechPose = {}, blocked = false,
  warmth = EXPRESSION_POLICY.restSmile, gain = 1, smile = 1} = {}) {
  if (!['idle', 'listening', 'thinking', 'speaking'].includes(phase)) throw Error('Unknown expression phase');
  const out = zero();
  if (blocked) return out;
  const w = Array.isArray(weights) ? Object.fromEntries(MIX_FAMILIES.map((family, i) => [family, weights[i] || 0])) : (weights || {});
  // Frowns and brows show a weight w as w^mixCurve of the pose; the smile stays linear (its evidence gates were
  // tuned for that, and a curved smile turned weak, misread joy into visible smiles on sad or calm replies).
  const curve = (value, key) => { const weight = clamp(value || 0); return weight > 0 && key !== 'up' ? weight ** EXPRESSION_POLICY.mixCurve : weight; };
  const channel_ = key => softSum(MIX_FAMILIES.map(family => (FAMILY_POSES[family][key] || 0) * curve(w[family], key)));
  let up = channel_('up'), dn = channel_('dn'), rin = channel_('in'), rout = channel_('out'), low = channel_('low');
  let narrow = channel_('sq'), wide = channel_('wide');
  if (narrow > wide) { narrow -= .5 * wide; wide = 0; } else { wide -= .5 * narrow; narrow = 0; }
  const vote = key => softSum(MIX_FAMILIES.map(family => (CORNER_VOTE[family][key] || 0) * clamp(w[family] || 0)));
  const upVote = vote('up'), dnVote = vote('dn');
  if (upVote > dnVote) { up *= 1 - .5 * dnVote / upVote; dn = 0; }
  else if (dnVote > 0) { dn *= 1 - .5 * upVote / dnVote; up = 0; } else { up = 0; dn = 0; }
  const clash = Math.min(Math.max(rin, rout), low);
  rin = Math.max(0, rin - .5 * clash); rout = Math.max(0, rout - .5 * clash); low = Math.max(0, low - .5 * clash);
  let smileRaw = up; up *= smile; // the character's smile multiplier scales the emotion's smile only
  if (phase !== 'speaking' && dn === 0) { up = Math.max(up, warmth); smileRaw = Math.max(smileRaw, warmth); }
  pair(out, 'corner_up', up); pair(out, 'corner_dn', dn);
  brows(out, 'raise_in', rin); brows(out, 'raise_out', rout); brows(out, 'lower', low);
  channel(out, 'sq', narrow); channel(out, 'wide', wide);
  for (const key of ['lat', 'lid', 'sqi', 'snear', 'chin']) channel(out, key, channel_(key));
  return finishPose(out, {speechPose, phase, gain, smileRaw});
}

function validatedPose(pose) {
  if (!plain(pose)) throw Error('Invalid expression pose');
  for (const [track, value] of Object.entries(pose)) {
    if (!EXPRESSION_TRACKS.includes(track) || !finite(value) || value < 0 || value > limits[track])
      throw Error('Expression pose exceeds its owned tracks or bounds');
  }
  return {...zero(), ...pose};
}

/** Copy the speech pose without changing any speech, blink, eye or head value.
 * Only the ten additional expression tracks are replaced by the expression
 * owner's complete pose. The caller remains the single native feature writer.
 */
export function composeExpressionPose(speechPose, expressionPose,
  {phase = 'idle', blocked = false, suppressSmile = false} = {}) {
  if (!plain(speechPose)) throw Error('Invalid speech pose');
  if (!['idle', 'listening', 'thinking', 'speaking'].includes(phase)) throw Error('Unknown expression phase');
  const expression = blocked ? zero() : validatedPose(expressionPose);
  // Reapply a hard phoneme budget AFTER smoothing. Otherwise a decaying smile
  // can linger into a new pressed P/B/M or rounded O/U articulation.
  const budget = mouthBudget(speechPose, phase);
  for (const track of EXPRESSION_TRACKS) {
    if (track.startsWith('lips_')) expression[track] = Math.min(expression[track], limits[track] * budget);
  }
  if (suppressSmile || expression.lips_l_corner_dn > 0 || expression.lips_r_corner_dn > 0)
    expression.lips_l_corner_up = expression.lips_r_corner_up = 0;
  return {...speechPose, ...expression};
}

export class ExpressionSmoother {
  constructor() { this.reset(); }
  reset() { this.pose = zero(); }
  update(target, deltaSeconds, {paused = false, suppressSmile = false} = {}) {
    const wanted = validatedPose(target);
    if (!finite(deltaSeconds) || deltaSeconds < 0) throw Error('Invalid expression clock');
    if (paused) return {...this.pose};
    const delta = Math.min(.10, deltaSeconds);
    for (const track of EXPRESSION_TRACKS) {
      const current = this.pose[track], goal = wanted[track];
      const seconds = goal > current ? EXPRESSION_POLICY.attackSeconds : EXPRESSION_POLICY.releaseSeconds;
      this.pose[track] = current + (goal - current) * (1 - Math.exp(-delta / seconds));
    }
    // Negative/unknown intent suppresses a prior smile immediately. Likewise a
    // frown target must not be combined with decaying positive mouth corners.
    if (suppressSmile || wanted.lips_l_corner_dn > 0 || wanted.lips_r_corner_dn > 0) {
      this.pose.lips_l_corner_up = this.pose.lips_r_corner_up = 0;
    }
    if (wanted.lips_l_corner_up > 0 || wanted.lips_r_corner_up > 0) {
      this.pose.lips_l_corner_dn = this.pose.lips_r_corner_dn = 0;
      this.pose.eye_l_brows_lower = this.pose.eye_r_brows_lower = 0;
    }
    return {...this.pose};
  }
}
