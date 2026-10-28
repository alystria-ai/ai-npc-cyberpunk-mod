// "Expressive emotions" (always on since 2026-10-20; it had a Settings > Voices row).
//
// Without marks a local voice's face follows our text-based expression plan (bridge/emotion-analysis.mjs). Each spoken turn's dynamic context asks the character to mark where its feeling changes, inline, with a small
// fixed set of curly-brace tags that map onto the mod's own emotion families. Everything after that reuses the
// pipeline that already exists:
//   - the tags are removed where the reply leaves Convai (bridge/speech-tags.mjs `parseTagged`), so subtitles,
//     phone chat, memory and every engine's input never see one; only their character offsets in the clean text
//     stay behind as `emotionMarks`;
//   - emotion-analysis.mjs turns those marks into a plan whose segment boundaries are the marks, and the existing
//     aligner (expression-timeline.mjs) places each segment at its real time in the audio, so the face changes when
//     that part is SPOKEN: per phrase for OmniVoice (each phrase is its own audio file, so a mark at a phrase start
//     is exact), by stream position for Pocket (pauses in the mouth timeline, then a syllable estimate).
//   - a reply with no marks keeps the text-based plan.
// Pure functions plus one small state holder: no I/O.
import {EMOTION_TAG_BLOCK} from './emotion-tags.mjs';

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

// The words of the block, and the syntax the parser reads, live in bridge/emotion-tags.mjs; the wording was measured against
// real Convai characters (docs/EMOTION_TAGS.md). The October 7 wording asked for tags "only where the feeling really shifts"
// and got {calm} on 41 % of the tags and {interest} on 29 %, neither of them right most of the time.
export const EXPRESSIVE_TEXT = EMOTION_TAG_BLOCK;

/**
 * Expressive emotions is always on (the Settings row was removed 2026-10-20; a saved `expressiveEmotions` key in settings.json is ignored).
 * It acts in two places, both only where a local voice speaks (the block asks for nothing else; the Convai cloud voice and text-only
 * turns get none).
 */
export class ExpressiveEmotions {
  constructor() {
    this.enabled = true;
  }
  /** True while the marks are asked for and kept: always. */
  get active() { return true; }
  /** Settings no longer switch it: nothing ever changes, so the settings poll never has a change to report. */
  update(_settings) { return false; }
  /** The block for one turn. `engine` is the voice that will speak it; text-only turns and the Convai cloud voice get none. */
  contextFor({engine, spoken = true} = {}) {
    return this.active && spoken && (engine === 'omni' || engine === 'pocket') ? EXPRESSIVE_TEXT : '';
  }
  /** A finished reply (already cleaned by processReply in bridge/speech-tags.mjs): its marks are always kept. */
  process(result) { return result; }
}
