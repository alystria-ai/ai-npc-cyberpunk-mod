// What V's words ask for in a romance animation (docs/ROMANCE_ANIMATIONS.md): a kiss, a hug, holding hands, sitting, a cuddle or lying together,
// or to stop. No model is asked: a few regular expressions over a short line, in the style of bridge/romance-intent.mjs. A screen, not a judge:
// it has to be right about plain sentences ("kiss me", "give me a hug", "sit with me"). A line it cannot place gives null and the character
// just talks. Whatever it finds is only a request: the game asks V once before anything plays, and only for a romance partner.
// English only for now. The Current party list asks in every language, and a line this screen misses simply starts nothing.
import {MIC_PLACEHOLDER} from './call-meet.mjs';

const B = String.raw`(?<![\p{L}\p{N}])`;
const E = String.raw`(?![\p{L}\p{N}])`;
const ENGLISH = {
  stop: [
    String.raw`stop (?:hugging|kissing|cuddling|holding)`,
    String.raw`(?:let'?s|we should|we can|time to) get (?:up|back up)`,
    String.raw`you can (?:let go|stop)|let go of me|let me go`,
    String.raw`(?:okay|ok|alright|all right),? that'?s enough`,
  ],
  kiss: [
    String.raw`(?:kiss me|give me a kiss|give me a little kiss|come (?:here and )?kiss me|let me kiss you|can i kiss you|may i kiss you|i (?:want|wanna|would like) to kiss you|let'?s kiss|how about a kiss|one more kiss|kiss you)(?! (?:goodbye|off|of death))`,
  ],
  hug: [
    String.raw`(?:hug me|give me a (?:big |little |good )?hug|come (?:here and )?hug me|let me hug you|can i hug you|may i hug you|i (?:want|wanna|need|would like) (?:to hug you|a hug)|let'?s hug|how about a hug|come here and give me a hug|hug you)`,
  ],
  hands: [
    String.raw`(?:hold (?:my )?hands?|let'?s hold hands|can i hold your hand|hold hands with me|take my hand|stand (?:close|closer) (?:to me|with me|together))`,
  ],
  sit: [
    String.raw`(?:sit (?:down )?(?:with|next to|beside|by) me|sit (?:down )?together|let'?s sit (?:down )?(?:together|here with me|next to each other)|come sit (?:with|next to|beside) me)`,
  ],
  cuddle: [
    String.raw`(?:cuddle|snuggle)(?: up)?(?: with me| together| a bit| a while)?|(?:hold me|let'?s cuddle|let'?s snuggle|come cuddle|come snuggle|i want to cuddle|i want to snuggle)`,
  ],
  lie: [
    String.raw`(?:lie|lay) (?:down )?(?:with|next to|beside|by) me|(?:lie|lay) (?:down )?together|let'?s (?:lie|lay) down(?: together| here| for a while)?|come (?:lie|lay) (?:down )?with me`,
  ],
};
const compile = patterns => new RegExp(`${B}(?:${patterns.join('|')})${E}`, 'iu');
const SETS = Object.fromEntries(Object.entries(ENGLISH).map(([kind, patterns]) => [kind, compile(patterns)]));
// "don't kiss me", "I would never hug you", "no cuddling": a refusal or a denial is not a request. Stop is never a denial.
const DENIAL = /\b(?:don'?t|do not|never|won'?t|wouldn'?t|can'?t|cannot|no)\b[^.!?]{0,24}\b(?:kiss|hug|cuddle|snuggle|hold|sit|lie|lay)/i;
// Talk about someone else ("she kissed him"), a question about the past or a joke at someone's cost.
const OTHER = /\b(?:he|she|they|him|her|them|ned|johnny|jackie)\b[^.!?]{0,16}\b(?:kissed|hugged|cuddled)\b/i;
// The order a line with more than one is read in: ending something first, the clearer asks before the vaguer ones.
const ORDER = ['stop', 'kiss', 'cuddle', 'lie', 'hug', 'hands', 'sit'];
const normal = value => String(value ?? '').slice(0, 400).replace(/[‘’‛ʼ`´]/g, "'");

/** 'kiss' | 'hug' | 'hands' | 'sit' | 'cuddle' | 'lie' | 'stop' | null for a line V typed or the transcript of a spoken one. */
export function screenRomanceAnim(text) {
  const line = normal(text).trim();
  if (!line || line === MIC_PLACEHOLDER) return null;
  if (SETS.stop.test(line)) return 'stop';
  if (DENIAL.test(line) || OTHER.test(line)) return null;
  for (const kind of ORDER) if (kind !== 'stop' && SETS[kind].test(line)) return kind;
  return null;
}

export const ROMANCE_ANIM_KINDS = Object.freeze([...ORDER]);
