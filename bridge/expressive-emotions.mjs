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
 * The setting plus the two places it acts. `enabled` follows runtime/settings.json (a missing or unreadable file
 * leaves it as it was). On by default, like mod/manager.lua: a settings file without the key counts as on; only a saved
 * `false` turns it off. (Without a local voice nothing is asked for, whatever this says.)
 */
export class ExpressiveEmotions {
  constructor() { this.enabled = true; }
  update(settings) {
    if (!settings || typeof settings !== 'object') return false;
    const next = settings.expressiveEmotions !== false, changed = next !== this.enabled;
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
