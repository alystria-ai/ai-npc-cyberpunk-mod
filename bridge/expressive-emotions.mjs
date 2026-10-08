// "Expressive emotions" (Settings > Voices, off by default).
//
// Off: a local voice's face follows our text-based expression plan (bridge/emotion-analysis.mjs), exactly as before.
// On: each spoken turn's dynamic context asks the character to mark where its feeling changes, inline, with a small
// fixed set of curly-brace tags that map onto the mod's own emotion families. Everything after that reuses the
// pipeline that already exists:
//   - the tags are removed where the reply leaves Convai (bridge/natural-speech.mjs `parseTagged`), so subtitles,
//     phone chat, memory and every engine's input never see one; only their character offsets in the clean text
//     stay behind as `emotionMarks`;
//   - emotion-analysis.mjs turns those marks into a plan whose segment boundaries are the marks, and the existing
//     aligner (expression-timeline.mjs) places each segment at its real time in the audio, so the face changes when
//     that part is SPOKEN: per phrase for OmniVoice (each phrase is its own audio file, so a mark at a phrase start
//     is exact), by stream position for Pocket (pauses in the mouth timeline, then a syllable estimate).
//   - a reply with no marks, or the setting off, keeps the text-based plan.
// Pure functions plus one small state holder: no I/O.
import {EMOTION_NAMES} from './natural-speech.mjs';

// Tag name -> the emotion family it drives (the eight families of bridge/emotion-lexicon.mjs). calm -> null: back to
// the character's resting face. warm is Trust, the gentle smile; interest is Anticipation, the attentive brow.
export const EMOTION_FAMILY = Object.freeze({joy: 'joy', warm: 'trust', interest: 'anticipation', surprise: 'surprise',
  sadness: 'sadness', fear: 'fear', anger: 'anger', disgust: 'disgust', calm: null});
// How strongly the family's full pose is shown. Subtle is the default; ":strong" is for a real outburst.
// October 9: .45/.8 were too timid in game (a subtle tag on Judy or Johnny, x .8 for a reserved manner, showed a
// third of the pose); the selector also lets the phrase's own text raise the tagged feeling.
export const MARK_WEIGHT = Object.freeze({subtle: .6, strong: 1});

/** Emotion marks (from parseTagged) as `{at, family, weight}`, sorted, within [0, length), one per offset. */
export function plannedMarks(marks, length = Infinity) {
  if (!Array.isArray(marks)) return [];
  const byOffset = new Map();
  for (const mark of marks) {
    if (!mark || !Number.isInteger(mark.at) || mark.at < 0 || mark.at >= length || !Object.hasOwn(EMOTION_FAMILY, mark.name)) continue;
    // Two tags before the same word: the later one wins.
    byOffset.set(mark.at, {at: mark.at, family: EMOTION_FAMILY[mark.name],
      weight: MARK_WEIGHT[mark.strength] ?? MARK_WEIGHT.subtle, name: mark.name});
  }
  return [...byOffset.values()].sort((a, b) => a.at - b.at);
}

// ---- The dynamic context ---------------------------------------------------------------------------------------

const TAGS = EMOTION_NAMES.map(name => `{${name}}`).join(', ');
export const EXPRESSIVE_TEXT = 'Expressive emotions are on. Your face is animated from the feelings you mark inline. '
  + `To mark a change of feeling, write one of these tags in curly braces right before the words it applies to: ${TAGS}. `
  + 'The face moves to that feeling when those words are spoken and stays there until the next tag; {calm} returns it to '
  + 'rest. Mark a feeling where it really shifts: several times in one reply if the text shifts, but not on every '
  + 'sentence and not in every reply; a plain, even reply needs few or none. Be subtle: a tag on its own is a slight '
  + 'expression, and ":strong" (for example {anger:strong}) is only for a real outburst. Choose by who you are: a '
  + 'reserved, controlled or cold character shows little and rarely strongly; an open, warm or volatile one shows more. '
  + 'These tags are for the face only: never say the feeling aloud, and use curly braces for nothing else (no asterisks, '
  + 'parentheses or stage directions; square brackets are a different thing). Tags are removed from the subtitles and the voice. '
  + 'Keep the same length and content you would give otherwise.';

/**
 * The setting plus the two places it acts. `enabled` follows runtime/settings.json (a missing or unreadable file
 * leaves it as it was).
 */
export class ExpressiveEmotions {
  constructor() { this.enabled = false; }
  update(settings) {
    if (!settings || typeof settings !== 'object') return false;
    const next = settings.expressiveEmotions === true, changed = next !== this.enabled;
    this.enabled = next;
    return changed;
  }
  /** The block for one turn. `engine` is the voice that will speak it; text-only turns and the cloud voice get none. */
  contextFor({engine, spoken = true} = {}) {
    return this.enabled && spoken && (engine === 'omni' || engine === 'pocket') ? EXPRESSIVE_TEXT : '';
  }
  /** A finished reply (already cleaned by NaturalSpeech.process): marks are kept only while the setting is on. */
  process(result) {
    if (!result || result.emotionMarks === undefined || this.enabled) return result;
    const {emotionMarks: _dropped, ...rest} = result;
    return rest;
  }
}
