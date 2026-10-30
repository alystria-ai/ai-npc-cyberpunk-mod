// What V's words say about a romance (docs/SIDE_ROMANCE.md): V asks a character to be together, or ends it. No model is asked: a few regular expressions per
// language over a short line, in the style of bridge/bond-intent.mjs. A screen, not a judge: it has to be right about plain sentences ("be my girlfriend", "I love
// you", "it's over between us"). A line it cannot place gives null and nothing happens, so the character simply talks.
//   'propose'  V asks to start a romance or says they are in love        'end'  V ends the relationship (a break up beats a proposal in the same line)
// English is here; the other fourteen languages of the game's menus are in bridge/romance-intent-languages.mjs.
import {MIC_PLACEHOLDER} from './call-meet.mjs';
import {LANGUAGE_PATTERNS} from './romance-intent-languages.mjs';

const B = String.raw`(?<![\p{L}\p{N}])`;
const ENGLISH = {
  propose: [
    String.raw`be my (?:girlfriend|boyfriend|girl|boy|partner|lover|date|valentine|man|woman|better half|other half|one and only)`,
    String.raw`(?:will|would|could|can) you (?:please )?(?:be (?:mine|with me|my (?:girlfriend|boyfriend|partner|lover|date))|go out with me|date me|go steady|go on a date with me|be together with me)`,
    String.raw`(?:do|would) you (?:want|wanna|like) to (?:be (?:together|with me|a couple|my (?:girlfriend|boyfriend|partner))|go out with me|date me|be more than friends)`,
    String.raw`(?:i(?:'m| am| was)?|we(?:'re| are)?) (?:in love with you|falling (?:in love )?(?:for|with) you|fell (?:in love )?(?:for|with) you|crazy about you|head over heels for you)`,
    String.raw`i (?:have|got|developed) (?:real |strong |deep |romantic )?feelings for you`,
    String.raw`i(?:'ve| have) fallen for you`,
    String.raw`i love you(?![\p{L}']| (?:too|guys|all|both|like (?:a|my|the)|as (?:a|my)|man|bro|mate|dude|buddy|pal|so much for))`,
    String.raw`i (?:really |truly |seriously )?(?:like|want|need) you (?:more than (?:a )?friend|as more than|romantically)`,
    String.raw`i want (?:us )?to be (?:together|a couple|more than friends|with you|your (?:boyfriend|girlfriend|partner))`,
    String.raw`i want you to be (?:mine|my (?:girlfriend|boyfriend|partner|lover))`,
    String.raw`(?:can|could|should) we (?:be (?:together|a couple|more than friends|an item)|try (?:us|being together|dating)|date)`,
    String.raw`let'?s (?:be together|be a couple|start dating|date|try dating|make it official|be more than friends|go on a date|give us a (?:try|shot|chance))`,
    String.raw`(?:is|are) there (?:something|anything) (?:more )?between us|more than friends`,
  ],
  end: [
    String.raw`(?:break(?:ing)?|broke) up(?: with (?:you|me))?|break(?:ing)? it off|split(?:ting)? up with (?:you|me)`,
    String.raw`(?:i|we)(?:'m| am| are|'re| have| need| want| should| gotta| got| must) (?:to )?(?:end|ending|finish|stop|leave|leaving|quit) (?:us|our (?:relationship|thing)|the relationship|this relationship|what we have)`,
    String.raw`it'?s over between us|we'?re (?:over|through|finished)|we are (?:over|through|finished)|(?:it|this) (?:is|'s) over for us`,
    String.raw`i(?:'m| am) (?:done|through|finished) with (?:you|us)`,
    String.raw`i (?:don'?t|do not|no longer|can'?t|cannot) love you(?: anymore| any more| like that| that way)?`,
    String.raw`i (?:don'?t|do not|no longer) want to be (?:with you|together|your (?:boyfriend|girlfriend|partner)|in this (?:relationship|thing))(?: anymore| any more)?`,
    String.raw`i(?:'m| am) (?:leaving|dumping) you|i(?:'m| am) ending (?:us|our relationship|this relationship)|you(?:'re| are) dumped`,
    String.raw`let'?s (?:just )?(?:be friends|stay friends|stop seeing each other|see other people)`,
    String.raw`(?:we should|i want to|i(?:'m| am) going to|i need to) (?:see other people|stop seeing each other|just be friends)`,
  ],
};
const compile = patterns => new RegExp(`${B}(?:${patterns.join('|')})`, 'iu');
// A language row: `propose` and `end` start at a word start (Latin and Cyrillic); `anywhere` is matched anywhere in the line (Japanese, Korean and Chinese have no spaces).
const sets = row => ['propose', 'end'].map(kind => [
  ...(row[kind]?.length ? [compile(row[kind])] : []),
  ...(row.anywhere?.[kind]?.length ? [new RegExp(row.anywhere[kind].join('|'), 'iu')] : [])]);
const ALL = [ENGLISH, ...Object.values(LANGUAGE_PATTERNS)].map(row => { const [propose, end] = sets(row); return {propose, end}; });
// Every apostrophe-like mark becomes a plain one, so "it’s" and "it's" read the same.
const normal = value => String(value ?? '').slice(0, 600).replace(/[‘’‛ʼ`´]/g, "'");
// A question about feelings is not a proposal ("do you love me?"), and a line that only quotes or denies one is not either ("I would never go out with you").
const DENIAL = /\b(?:never|not|won't|wouldn't|can't|don't)\b[^.!?]{0,24}\b(?:be my|go out with|date)\b/i;

/** 'propose' | 'end' | null for a line V typed or the transcript of a spoken one. A break up wins over a proposal in the same line. */
export function screenRomance(text) {
  const value = normal(text).trim();
  if (!value || value === MIC_PLACEHOLDER) return null;
  if (ALL.some(set => set.end.some(pattern => pattern.test(value)))) return 'end';
  if (DENIAL.test(value)) return null;
  return ALL.some(set => set.propose.some(pattern => pattern.test(value))) ? 'propose' : null;
}

/** True when `text` is a real line of words (a typed line or a transcript), as against an empty line or the placeholder of a recording. */
export const hasWords = text => typeof text === 'string' && text.trim() !== '' && text.trim() !== MIC_PLACEHOLDER;
