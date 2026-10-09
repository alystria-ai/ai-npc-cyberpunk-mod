// Context-aware facial emotion selector for spoken replies (October 8).
//
// Why: the first text planner (emotion-analysis.mjs `analyseReply`) read only the reply, counted every pleasant word
// ("love", "family", "glad", "thanks", "beautiful", "laughed") as a smile, and put a resting smile under everything
// for warm characters. Judy talking about Evelyn's death therefore smiled (all seven Evelyn exchanges in the labelled
// set smiled; 76 % of sad, scared, angry or disgusted replies smiled overall).
//
// What this does instead (all local, about 0.1-0.3 ms per reply, no model, no network):
//   1. The conversation frame from the player's message, the reply and the previous turn's mood: grief and loss,
//      danger, conflict, celebration or humour. A grief frame turns reminiscing praise ("she was beautiful, I loved
//      her") into sadness instead of joy and keeps the whole reply sad where no sentence says otherwise.
//   2. Phrase patterns that a word list misses: empathy ("I'm sorry", "it's not your fault"), regret and
//      counterfactuals ("if I'd picked up", "too late", "since she's gone"), concern ("are you okay?"),
//      reassurance ("I've got you"), laughter and teasing.
//   3. Smiles need a real cue: mild words ("good", "fine", "sure", "cool", "yeah") and forms of address ("choom", "V")
//      no longer smile; joy needs laughter, a strong positive word, or a positive exclamation. The resting face is
//      neutral (mod/facial-playback.lua rest warmth 0).
//   4. The character's manner (expressive, open, reserved, cold) scales intensity and how much evidence a smile needs.
//   5. Priority: the character's own inline tags (Expressive emotions) win from the first tag on; Convai's own
//      reply-level emotion (when it arrives for this turn) is the next prior; the text decides the rest.
// The output is the same plan shape as `analyseReply`, so expression-timeline.mjs aligns it to the audio unchanged.
import {FAMILIES} from './emotion-lexicon.mjs';
import {segmentText, scoreSegment, syllables, analyseReply, baselineFromSignal, LABELS} from './emotion-analysis.mjs';
import {plannedMarks, EMOTION_FAMILY, MARK_WEIGHT} from './expressive-emotions.mjs';

// Fusion constants, calibrated on the development half of assets/emotion/segments-gold.json
// (scripts/Evaluate-EmotionSegments.mjs) and checked on characters and prompts the calibration never saw.
//   providerScale: Convai's label as a reply mood (1 = the old flat .35/.5/.65, which painted every phrase of a pleasant
//                  reply and put an emotion on over half of the segments the writers call neutral);
//   frameScale / frameAlone: the player's line as a mood, in full under a phrase with a feeling of its own and at
//                  frameAlone under one without;
//   namedPrior: the reply mood under a phrase the character's own specific tag has already named;
//   priorOther: ... under a phrase whose own words clearly say another family.
const TUNE = Object.freeze({providerScale: .75, frameScale: 1.1, frameAlone: .4, namedPrior: .35, priorOther: .5});
const clamp01 = value => Math.max(0, Math.min(1, value));
const NEGATIVE = new Set(['sadness', 'anger', 'fear', 'disgust']);
const round = value => Math.round(clamp01(value) * 1000) / 1000;

// ---- character manner ---------------------------------------------------------------------------------------
// range: multiplier on feelings; joyGate: joy evidence (lexicon score) needed before a smile shows.
export const MANNERS = Object.freeze({
  expressive: {range: 1.15, joyGate: .45, trustGate: .45},
  open: {range: 1, joyGate: .5, trustGate: .5},
  reserved: {range: .8, joyGate: .65, trustGate: .6},
  cold: {range: .6, joyGate: .85, trustGate: .8},
});
const MANNER_OF = new Map(Object.entries({
  expressive: ['jackie-welles', 'kerry-eurodyne', 'mama-welles', 'dexter-deshawn', 'panam-palmer', 'lizzy-wizzy', 'ozob-bozo'],
  reserved: ['johnny-silverhand', 'rogue-amendiares', 'takemura', 'saul-bright', 'meredith-stout', 'solomon-reed',
    'spider-murphy', 'r3n0', 'regina-jones', 'songbird', 'nix', 'judy-alvarez', 'river-ward', 'viktor-vektor', 'placide',
    'evelyn-parker', 'alex'],
  cold: ['adam-smasher', 'yorinobu-arasaka', 'hanako-arasaka', 'alan-noel', 'mr-hands'],
}).flatMap(([manner, keys]) => keys.map(key => [key, manner])));
export function mannerFor(profile) { return MANNER_OF.get(profile) ?? 'open'; }

// The face WHILE SPEAKING per character (mirrors mod/facial-playback.lua): no resting smile under any sentence, with
// the per-rig corner gain kept so real smiles and frowns still read on Judy's full lips. The light resting smile is
// idle-only and lives in Lua, held off for a while after a negative turn.
export function restingFor(profile) { return {warmth: 0, gain: profile === 'judy-alvarez' ? 1.6 : 1}; }

// ---- conversation frames ------------------------------------------------------------------------------------
// Each frame is matched on the lower-case player message and reply. Weights are the reply-level prior they give.
// Idioms that use death words without a death ("over my dead body", "died laughing") are removed first.
const DEATH_IDIOMS = /\b(over my dead body|dead (serious|tired|wrong|right|on|end|weight|ringer|giveaway|set on|broke|center)|drop dead|died laughing|dying to (know|see|try|hear|meet)|to die for|dead guy in your head|(i|we) thought (he|she|you|they) (was|were) dead|wouldn'?t be caught dead|deadline|deadpan|kill(ed|ing)? it|killer)\b/g;
const GRIEF = [
  /\b(died|dead|death|dying|funeral|grave|graves|buried (him|her|them|my|our)|burial|mourn\w*|griev\w*|grief|condolences?|ofrenda|wake for|[a-z]+'s gone|is gone\b)/,
  /\b(passed (away|on)|lost (him|her|them|my|our|a friend)|killed (him|her|them|my)|flatlined|didn'?t make it|never came back|gone now|since (she|he|they)'?s? (gone|been gone|died)|without (her|him|them) now)\b/,
  /\b(evelyn|evie|jackie'?s (death|grave|funeral|ofrenda|body|memory)|after jackie|miss(ing)? (him|her|them|jackie|evelyn|evie|alt|your \w+|my \w+)|you miss \w+( \w+)? too)\b/,
  /\b(how are you (holding up|coping|doing with)|holding up|blame yourself|sorry (about|for) (your|evelyn|jackie|what happened)|sorry for your loss|i'?m so sorry)\b/,
  /\b(months? to live|weeks? to live|not much time (left)?|running out of time|i'?m dying|you'?re dying|relic('s)? (killing|is killing|will kill))\b/,
];
// People who are dead in the story; mentioned together with past-tense talk they count as one grief cue.
const LOST = /\b(evelyn|evie|jackie|alt|saburo|scorpion|t-?bug|mitch)\b/;
const PAST = /\b(was|were|used to|loved|had|always|never got|taught|would)\b/;
// The player asking about something painful (without naming a death): a softer sad prior on the reply.
const SORE = /\b(regret\w*|blame\w*|what happened (to|with) (her|him|them|you|alt|jackie|evelyn)|still think(ing)? (about|of)|can'?t stop thinking|do you (ever )?think about|you'?ve been quiet|bad day|rough day|hard (day|time|night)|struggling|depress\w*|lonely|i'?m sad|feel(ing)? (down|low|awful|terrible|empty)|nightmares?|found (her|him)|guilt\w*|ever forgive|if you could do it over)\b/;
const DANGER = /\b(ambush\w*|being followed|following (us|me)|tailing us|hunting (us|me|you)|they'?re coming|incoming|get down|take cover|bleeding|shot (at|me|him|her)|gunshots?|wounded|max-?tac|cyberpsycho\w*|trap|danger\w*|threat\w*|bomb|hostiles?|watch your back|kill (us|you|me)|passed out|blacked out|seizure|brakes failed|not picking up|hasn'?t called|missing|smasher|drones?|scouts? spotted|heading (our|this) way|on our tail)\b/;
const CONFLICT = /\b(sold (us|me|you) out|sold the story|betray\w*|traitor|torched|burned down|backstab\w*|screwed (us|me) over|ripped (us|me) off|lied to (us|me|you)|stole|wrecked|trashed|spray ?painted|shake (you|me|us) down|attacked (our|my)|remix your|insult\w*)\b/;
const CELEBRATION = /\b(we did it|pulled it off|nailed it|congrat\w*|celebrat\w*|drinks? (are|is)? ?on me|party|payday|paid (triple|double|well)|got the job|we won|you won|it worked|good news|made it out|everyone got out|birthday|crowd was (wild|great|amazing)|(we|you) (smoked|wrecked|crushed|destroyed|smashed|owned|took out) (them|'em|those)|did you see that|hell yeah|fuck yeah)\b/;
const HUMOR = /\b(haha+|hah|lol|lmao|joke|joking|kidding\b(?! me)|funny|hilarious|laugh\w*|prank|tease|teasing)\b/;

// ---- phrase cues within a segment ---------------------------------------------------------------------------
// [pattern, {family: weight}] matched on one lower-case segment. Weights are lexicon-score units (about .85 of a
// weight becomes the face weight). These are conversational idioms that a word list cannot score.
const PHRASES = [
  // Empathy and consolation for someone's pain: sad brows, the corners down.
  [/\b(i'?m (so |really |truly )?sorry( to hear| about| for| that)?|sorry for your loss|that must (have been|be) (hard|awful|rough|terrible|tough)|i can'?t imagine|my heart (goes|breaks))\b/, {sadness: .7}],
  [/\b(it'?s not your fault|you did (everything|all) you could|nothing you could('ve| have) done|don'?t blame yourself|go easy on yourself)\b/, {sadness: .45, trust: .3}],
  // Regret, guilt and counterfactuals.
  [/\b(if (only )?i'?d|if i had|i should(n'?t)? have|i could have|should'?ve|could'?ve|wish (i|she|he|they|we|you)( had| could| would)?|never got (to|the chance)|too late|couldn'?t (save|get there|stop|help|protect)|didn'?t (get there|make it) in time|still be here|i keep (thinking|seeing)|every (damn |single )?(day|night)\b|i walked out|i let (them|the|her|him)|i'?d (stay|change|do it differently))/, {sadness: .6}],
  [/\b(since (she|he|they)'?s? (gone|been gone)|without (her|him|them)|(she|he|they)'?s? gone|feels? (hollow|empty|wrong|quiet)|so quiet|the worst (part|and the best)|it doesn'?t (get easier|stop)|never (forget|be the same|shuts? up)|heavier|weigh(s|ed)? on me|weight of it|dull ache|still hurts|tastes? like nothing|feel close to (her|him|them)|empty (seat|chair|room|bed)|didn'?t deserve (to|that|this)|deserved (so much )?better|it'?s not fair|not fair|tired of getting it wrong|no good answer|don'?t (really )?want to talk about (it|what)|still wait for|still (hear|see|smell) (his|her|their)|never (really )?got over|sets (his|her) plate|(he|she) would'?ve (liked|loved|wanted)|see ghosts|getting sentimental|bad news|can'?t (open|throw|let go|bring myself)|sit with me|pour one out|never (knew|had the chance)|(will|won'?t) (never )?have the chance|burns? down|what sticks)/, {sadness: .55}],
  // Concern for V or someone: worried brows rather than a smile.
  [/\b(take care of yourself|look after yourself|stay safe|be careful( out there)?|you look (like hell|thin|tired|awful))/, {trust: .35, fear: .1}],
  [/\b(promise me|swear to me|please,? (don'?t|stay|be)|i dreamed of you|woke up shaking)/, {fear: .55, trust: -.6}],
  [/\b(are you (okay|ok|alright|all right|hurt|sure you'?re)|you (okay|ok|alright)\b|talk to me|i'?m worried|worried about you|scared for you|that'?s not (good|like (him|her|them))|not good at all|something('?s| is) (off|wrong)|a mother knows|(he|she) always picks up|if something happened)/, {fear: .45, sadness: .2}],
  [/\b(i don'?t like (this|it|the sound|our odds)|bad feeling|we (need|have|gotta|got) to (go|move|leave|bolt|run|get out)|gotta (bolt|run|move)|keep your head down|not safe|stay (behind|close to) me|don'?t move|keep quiet|they could be anywhere|lock the door|hold on( tight)?!|come on, come on|we may not have (much )?time|what if (there'?s|they|he|she|we|i)|i can'?t (keep|stay in) control|i don'?t (even )?want to think about|did you hear that|something moved|dios m[ií]o|oh,? (hell|god|no)\b)/, {fear: .6}],
  // Reassurance and loyalty: the gentle smile (trust), sad-tinged in a grief frame (handled by the frame).
  [/\b(i'?ve got you|i got you|got your back|i'?m (right )?here (for you|with you)|i'?ll be right (there|here|next to you|beside you)|you'?re not alone|we'?ll (get through|figure (it|this) out)|it'?s (going to|gonna) be (ok|okay|alright|all right|fine)|i'?m not going anywhere|you can count on me|whatever you need|wouldn'?t be anywhere else|that'?s what friends (do|are for)|you'?d do the same|of course( i will| i do)?[.,!]|glad you'?re (okay|ok|safe|alright|here)|it (really )?matters|means a lot|come (sit|here|in)\b|you don'?t have to (explain|say|talk)|trust yourself|just breathe|hey, breathe|you'?ve (got|put in) (the skills|the work|this)|eat more|i'?ll (make|pack|cook) (you|some))/, {trust: .6}],
  [/\b(thank you|thanks)( for (asking|being|listening|remembering|that|coming|everything))?\b/, {trust: .35}],
  [/\b(any ?time[,.!]|don'?t mention it|my pleasure|de nada|you'?re (always )?welcome|(is|are) yours|you'?re one of us|light up (this|the) place|glad you (came|stopped|called|dropped|made it)|means (more|a lot|everything)( to me)?|always\.$|no trouble at all|welcome any ?time|put the kettle on|you'?ve earned it|you are a friend|you'?re a friend)/, {trust: .55}],
  // Laughter, delight and teasing.
  [/(^|[^a-z])ha!|\b(ha(ha)+|heh+|hah|lmao|lol|cheers|on the house|you'?re (such )?(a dork|an idiot|ridiculous)|oh, (shut up|stop)|i'?m (just )?(messing|teasing|kidding) (with )?you|cracks? me up|almost died laughing|you were right|okay, okay|stupidly good|loved every (second|minute)|best (\w+ ){1,2}(of my life|ever|i'?ve (ever )?(had|seen|done|edited))|haven'?t felt this (alive|good)|we'?re doing this right|let'?s celebrate|i'?m (so )?(proud of you|happy for you)|that'?s (preem|nova|amazing|awesome))\b/, {joy: .6}],
  // Attention: asking for details, offering to explain or plan.
  [/\b(tell me (what|about|more|everything|who|how|exactly)|show me\b|walk you through|which (one|part) do you|what'?s your (specialty|plan|angle|deal)|why now\?|i need specifics|let'?s (figure|work) (it|this) out|here'?s (the|what) (plan|we do))/, {anticipation: .5}],
  // Disbelief.
  [/\b(no way|you'?re (kidding|joking)( me)?|are you serious|wait,? what|what\?!|holy shit|can'?t believe|you did what\?|it was you\?|are you (insane|crazy|nuts)\?|i did not expect|i didn'?t expect (that|this)|where (the hell )?did you (find|get)|never would have guessed|not in a million years|last (person|thing) i expected|that'?s impossible|is impossible|how did (she|he|they|you) (survive|do|find|get)|you found it\?|i thought (he|she|you|they) (was|were) dead|seriously\?)/, {surprise: .65}],
  // Scorn and revulsion.
  [/\b(corpo (rat|scum|bullshit|suits?|errands|money|stink)|sucking up|makes? (my skin crawl|me sick)|ugh|gross|disgusting|what a (joke|waste)|pathetic|vultures?|vermin|bottom-?feeders?|slimy|sleazy|sell (his|her) own mother|smells? like (shit|crap|piss|garbage|a sewer|wet dog|death|rot|vomit|puke)|stinks?\b|how do you (even )?eat|hell no|typical\.|steps on (whoever|anyone|people)|not (men|human)|hmph|disgraceful|no honou?r|butchery|knock-?off|in the trash|squander\w*)/, {disgust: .6}],
  // Anger and defiance.
  [/\b(over my dead body|i'?ll (find|kill|make) (them|him|her|whoever)|make (them|him|her) (pay|regret|scrub)|they think they can|not while i'?m (breathing|alive|standing)|go to hell|al diablo|those (animals|bastards|pendejos)|with a (baseball )?bat|i'?m not (laughing|handing|letting|going to let)|like it'?s a joke|you'?re treating (it|this|me)|how dare|wouldn'?t know a real|i hate (this|them|him|her)\b|i hate that (guy|man|bastard|place|city|corpo)|(i'?ll|i will|i'?m gonna|i swear,? i'?ll) (sue|have his|have her|put (every|them|him|her)|bury|destroy|tear|rip|break|gut|skin|end)|unforgivable|i want (them|him|her|every \w+( \w+)? of them|every one of them) to (feel|pay|suffer|burn|bleed)|(want|make) them (to )?pay|don'?t ask me to let it go|greedy (little )?(rat|bastard|pig)|little rat|should have (his|her) (license|head)|murdered|after everything (they|he|she)'?ve? (taken|done)|are you kidding me\?|son of a bitch|piss(es)? me off|sick of|fed up)/, {anger: .6}],
];
// ---- everyday dialogue cues (October 9 evening) --------------------------------------------------------------------
// What a word list misses and a conversation is made of: guarded deflection, a stern warning, a rhetorical challenge,
// an echo question, dry teasing, plain affection, scorn. Each is a common English idiom in spoken dialogue, kept
// to the shape of the phrase, never to one character or one scene. Same units as PHRASES (lexicon-score weights).
const PHRASES_EVERYDAY = [
  // Guarded or defensive: deflecting a probing question. Reads as wary (worried brows), not blank.
  [/\b(people say (a lot|all kinds|many things)|i (don'?t|do not) (know|remember) what you'?re (talking|getting)|i(?:'ve| have) no idea what you|who told you|where did you (hear|get) that|none of your (business|concern)|that'?s private|i'?m not (going to|gonna) (discuss|talk about|answer)|what makes you (say|think) that|why (do|would) you (ask|want to know)|why are you asking|i'?d rather not|not something i (discuss|share)|let'?s not (go|talk)|i don'?t owe you|i prefer to keep)\b/, {fear: .5, anticipation: .1}],
  // A stern warning or a firm refusal: lowered brows.
  [/(^|[.!?]\s+)(careful|watch it|watch yourself|easy now|easy there|enough\b|back off|don'?t (push|start|test|try|even|make me|do)|stop (guessing|that|it|talking|pretending)|i wouldn'?t if i were you|mind your|that'?s enough|not another word|drop it|leave it|you'?re starting to|do not (push|test|start))/, {anger: .55}],
  [/\b(you think (this|that|it) (is|was)( a| some)? (joke|game|funny|cute|amusing)|think (that'?s|this is) funny|is this a joke|now you(?:'?re| are)? satisfied|happy now|you find (this|that|it) (funny|amusing)|mistake my \w+ for|test my patience|don'?t (waste|insult)|know your place|you'?re (not|no) (in|the one))/, {anger: .6}],
  // An echo or a short startled question ("You what?", "A chainsaw?", "Proud?"): disbelief, brows up.
  [/(^|[.!?]\s+)(?!(who|what|why|how|when|where|which|do|does|did|can|could|will|would|is|are|am|was|were|have|has|should|want|tell|any|anyone|got|ok|okay|alright|right|and|so|then|ready|need|mind|care|like|think|know|see)\b)[a-z']+( [a-z']+)?\?/, {surprise: .45}],
  [/\b(you|hand you|look at|ask|do|mean|say|want|call it|did) what\?|\bwhat\?\s*$|\bwhat do you mean\b/, {surprise: .45}],
  // Dry teasing and playful needling.
  [/(^|[.!?,]\s+)(well, )?(at least|almost\b|that'?s almost|nice try|you wish|keep dreaming|good luck with that|bold of you|try me|don'?t flatter|is that a compliment|i'?m flattered|look on the bright side|you'?re (exaggerating|imagining|terrible|impossible|cute|funny)|don'?t tempt me|how (rude|dare you)\b|cute\b|aw+[,.! ])/, {joy: .5}],
  [/(^|[.!?]\s+)(ha|heh|hah|hehe)[.,]|\b(i'?ll give you that|you could say that|fair enough|touch[eé]|point taken|you got me|lucky break|can'?t argue)\b/, {joy: .45}],
  [/\b(proud of (you|us|myself)|well done|good work|nice work|good for you|about time|nice one|you earned|that'?s my \w+|thanks? for noticing|you'?re getting (too )?good|can'?t say i'?m not|i'?ll take it|i'?ll take the compliment|worth celebrating|called it|i win\b|told you so)\b/, {joy: .55}],
  // Plain affection and togetherness.
  [/\b(we'?re in this together|in this together|we have each other|you'?re not alone|good to have you|glad to have you|i care about|take your time|rest up|have a seat|sit with me|stay close|stick around|stay with me|look out for (our|each|my)|never (let|leave)|lean on me|you can count|i'?ll be there)\b/, {trust: .55}],
  // Scorn and contempt for something or someone.
  [/\b((?:is|'s) (usually |always |just )?a lie|that'?s a (lie|myth|fantasy)|just noise|playing with (gods|toys)|children playing|pretend(s|ed|ing)? (they|to|that)|spare me|save it|cry me a river|how (touching|original|convenient)|so what\b|whatever you say|rather than being|they think they own|think they own the|full of (it|shit|themselves)|couldn'?t care less|not my problem|their loss|waste of (time|space|breath))\b/, {disgust: .5}],
  // Worry for the plan or for a person, short of alarm.
  [/\b(keep (walking|moving|going)|don'?t look back|stay (down|low)|i don'?t like (the|our|these) odds|hope you have|hopefully|if (it|that|this) (goes|gets) (sideways|bad|wrong|ugly)|in one piece|stay alert|keep your head down|watch your back|they'?re (watching|following)|tailing us|not safe|backup\b|a way to recover|get out of here|get us out|before it'?s too late|just in case|too (risky|dangerous)|bad idea|that'?s a risk|can'?t afford)\b/, {fear: .4}],
  // Wistful and tired: grief at a distance, nothing dramatic.
  [/\b(i grew up|used to be|back then|when i was (a kid|young|little)|i miss\b|long time ago|don'?t talk about|tired of|worn out|nothing left|can'?t go back)\b/, {sadness: .4}],
];
// Scornful praise; matched on the whole reply because the praise and the giveaway are often separate sentences.
const SARCASM = /\b(oh,? sure|yeah,? (sure|right)|sure,? because|because that always works|what could possibly go wrong|brilliant (plan|idea)\b(?!,? v\b)|absolutely (fucking )?brilliant|great idea,|i'?m so glad we have|thanks a lot|real (smart|clever|mature)|good job,? (genius|hero)|wow,? (thanks|really)|how (original|helpful|nice of)|as if\b|big surprise|no kidding)/;
const ALL_PHRASES = [...PHRASES, ...PHRASES_EVERYDAY];
const ABSTRACT_TRUST = /\btrust (is|isn't|takes|means|has|doesn't|can't|won't|must|gets|comes)\b|\b(earn|prove|demand|ask for|expect|deserve|lose|break|build|give|need) (my |your |their |his |her |any |that |the )?trust\b|\b(i|you|we|they) (don't|do not|didn't|can't|won't|wouldn't|never) trust\b/g;
const ABSTRACT_AFFECT = [
  [/\b(fear|dread|terror) (is|isn't|are|can|will|makes|has|doesn't|takes|means|keeps)\b|\b(not|never|no|don't|do not|won't|can't|isn't|aren't|wasn't|nothing|nobody)\b[a-z' ]{0,26}\b(scared|afraid|frightened|terrified|worried|nervous|anxious|spooked|fear)\b/g, 'fear', .6],
  [/\b(anger|rage|hatred|hate) (is|isn't|are|can|will|makes|has|doesn't|takes|means|keeps)\b|\b(not|never|no|don't|do not|won't|can't|isn't|aren't|wasn't|nothing|nobody)\b[a-z' ]{0,26}\b(angry|mad|furious|pissed|upset|annoyed)\b/g, 'anger', .6],
  [/\b(pain|grief|regret|guilt|shame|loss|sorrow) (is|isn't|are|can|will|makes|has|doesn't|takes|means|keeps)\b|\b(not|never|no|don't|do not|won't|can't|isn't|aren't|wasn't|nothing|nobody)\b[a-z' ]{0,26}\b(sad|lonely|heartbroken|hurt|sorry)\b/g, 'sadness', .6],
];
const DENIAL = /(^|[.!?,] )(i|we) (didn't|did not|am not|'m not|i'm not|do not|don't|never|wasn't|was not|haven't|have not|won't|can't|cannot|couldn't)\b/;
// Weak positives that never make a smile on their own (they still count toward real joy evidence).
const MILD_JOY = new Set(['good', 'nice', 'fine', 'sure', 'yeah', 'yes', 'cool', 'smart', 'calm', 'comfortable', 'welcome',
  'choice', 'finally', 'hope', 'relaxed', 'chill', 'content', 'party', 'win', 'best', 'gift', 'reward', 'bonus', 'clever']);

// What the PLAYER's line asks of the character, as a quiet reply-level mood (October 9 evening). A character answers a
// compliment, a tease, an apology, a probing question or a corpo rant in kind, even when no word of the reply says so
// ("People say a lot of things." after "Is that true?" is guarded, not blank). Weights are deliberately low: they put
// the mood on the face at a subtle, visible level and every phrase of the reply can still say more.
// [pattern on the lower-case player message, {family: weight}, evidence name]
const PLAYER_FRAMES = [
  [/\b(you look (really |so |very |pretty )?(good|great|beautiful|amazing|handsome|stunning|nice|sharp)|not gonna lie|i missed you|i like you|i love you|you'?re (amazing|incredible|beautiful|the best)|proud of (you|how far)|(thank you|thanks) (for|so much)|i appreciate you|means a lot|glad you'?re (here|okay|ok|safe)|i trust you|made (you )?(breakfast|dinner|coffee)|got you (a|some)|picked up a little something|close your eyes|(you|it) means)\b/, {trust: .3, joy: .12}, 'kind-player'],
  [/\b(lose a bet|snor(e|ed|ing)|like a chainsaw|fell for it|you actually fell|dumbest thing|nice outfit|don'?t laugh|jokes are terrible|haha|ha!|lol|kidding|messing with you|stole my \w+ and left|left a note|note that said|got promoted|drinks are on me|treat you)\b/, {joy: .3}, 'tease-player'],
  [/\b(i'?m (so |really )?sorry|my fault|forgive me|i (messed|screwed) up|let me (look|help|check|fix)|are you (hurt|okay|ok)|you (got|are) hurt|you'?re bleeding|how'?s the (arm|leg|wound)|looked nasty|hold still)\b/, {trust: .3}, 'care-player'],
  [/\b(is (that|it) true|who told you|what are you hiding|why did you lie|you lied|why do you always|dodge|i (do not|don'?t) trust you|prove me wrong|is this yours|found (something|this) in your|explain yourself|where were you|what'?s that supposed to mean|come clean|were you scared|read your file|bounty on your|ever going to tell me|talk your way out)\b/, {fear: .3}, 'probe-player'],
  [/\b(corpos?|corporations?|corporate|arasaka|militech|netwatch|the rich)\b/, {disgust: .3}, 'scorn-player'],
  [/\b(you'?re late|late again|late\.|you are late|complain|fed up|sick of|what the hell|are you insane|how could you|unbelievable that)\b/, {anger: .3}, 'annoyed-player'],
  [/\b(drive-?by|almost (got us )?killed|bad news|he'?s dead|they found him|car (crash|exploded)|lost (the|our) (money|job|car))\b/, {sadness: .2, fear: .2}, 'bad-news-player'],
];

function frameScores(text, speaker = '') {
  let lower = ` ${normalise(text)} `.replace(DEATH_IDIOMS, ' ');
  // The speaker's own name is not a cue of loss (Evelyn asked about Evelyn is being questioned, not mourning).
  const own = String(speaker).toLowerCase().split(/[^a-z]+/).filter(part => part && LOST.test(part));
  if (own.length) lower = lower.replace(new RegExp('\\b(' + own.join('|') + ')\\b', 'g'), ' ');
  // "I'm sorry about Mitch": condolence for a named person (case matters: the name is capitalised).
  const condolence = /\bsorry (about|for) [A-Z][a-z]+/.test(text) ? 1 : 0;
  return {grief: GRIEF.filter(pattern => pattern.test(lower)).length + condolence, lost: LOST.test(lower), past: PAST.test(lower), sore: SORE.test(lower),
    danger: (lower.match(new RegExp(DANGER.source, 'g')) || []).length,
    conflict: CONFLICT.test(lower), celebration: CELEBRATION.test(lower), humor: HUMOR.test(lower)};
}

/**
 * The reply-level context: frames found in the player's message, the reply, and the previous turn's mood.
 * Returns the prior weights for the whole reply and the evidence used.
 */
export function conversationContext({player = '', reply = '', previous, profile} = {}) {
  const asked = frameScores(player, profile), said = frameScores(reply, profile);
  // A dead character named by either side, with the reply speaking in the past: one grief cue (never when the
  // speaker is that person: Jackie talking about himself).
  const lost = (asked.lost || said.lost) && said.past && !(typeof profile === 'string' && LOST.test(profile.replace(/-/g, ' '))) ? 1 : 0;
  const grief = asked.grief + said.grief + lost;
  const prior = {}, frames = {}, evidence = [];
  if (grief) { prior.sadness = Math.min(.55, .3 + .1 * grief); evidence.push(`grief:${asked.grief}/${said.grief}`); }
  else if (asked.sore) { prior.sadness = .25; evidence.push('sore-question'); }
  if (asked.danger || said.danger >= 2) { prior.fear = .25; evidence.push('danger'); }
  if (asked.conflict) { prior.anger = .2; evidence.push('conflict'); }
  if (!grief && (asked.celebration || said.celebration)) { prior.joy = .3; evidence.push('celebration'); }
  if (!grief && asked.humor) { prior.joy = Math.max(prior.joy || 0, .2); evidence.push('humor'); }
  // The player's line itself (a compliment, a tease, an apology, a probing question): only when no heavier frame is set.
  if (!grief && !asked.sore && !prior.fear) {
    const line = ` ${normalise(player)} `;
    for (const [pattern, weights, name] of PLAYER_FRAMES) {
      if (!pattern.test(line)) continue;
      for (const [family, weight] of Object.entries(weights)) frames[family] = Math.max(frames[family] || 0, weight);
      evidence.push(name);
    }
  }
  // A mood that outlasts one turn (a grief or a fight conversation) carries into a short follow-up question.
  if (previous && NEGATIVE.has(previous.family) && !asked.celebration && !asked.humor && previous.ageMs < PREVIOUS_MS) {
    const carried = .6 * clamp01(previous.weight ?? .4);
    if (carried > (prior[previous.family] || 0)) { prior[previous.family] = carried; evidence.push(`previous:${previous.family}`); }
  }
  return {prior, frames, grief: grief > 0 || asked.sore, evidence, celebration: asked.celebration || said.celebration, humor: asked.humor || said.humor,
    probed: evidence.includes('probe-player') || evidence.includes('annoyed-player') || asked.conflict};
}

const CONTRACTIONS = [[/\bi am\b/g, "i'm"], [/\byou are\b/g, "you're"], [/\bit is\b/g, "it's"], [/\bthat is\b/g, "that's"],
  [/\bdo not\b/g, "don't"], [/\bdoes not\b/g, "doesn't"], [/\bdid not\b/g, "didn't"], [/\bcannot\b/g, "can't"],
  [/\bcan not\b/g, "can't"], [/\bis not\b/g, "isn't"], [/\bwill not\b/g, "won't"], [/\bi have\b/g, "i've"],
  [/\bi will\b/g, "i'll"], [/\bwe will\b/g, "we'll"], [/\bhe is\b/g, "he's"], [/\bshe is\b/g, "she's"], [/\bwould have\b/g, "would've"]];
export function normalise(text) {
  let lower = text.toLowerCase().replace(/[‘’]/g, "'");
  for (const [pattern, short] of CONTRACTIONS) lower = lower.replace(pattern, short);
  return lower;
}

function phraseScores(lower) {
  const scores = {}, hits = [];
  ALL_PHRASES.forEach(([pattern, weights], index) => {
    if (!pattern.test(lower)) return;
    hits.push(index);
    for (const [family, weight] of Object.entries(weights)) scores[family] = (scores[family] || 0) + weight;
  });
  return {scores, hits};
}

const TRAIT = Object.freeze({baseline: {}, range: 1});

function scoreContextSegment(segment, text, context, manner) {
  segment.text = text.slice(segment.start, segment.end);
  const lower = normalise(segment.text);
  const {scores, tags} = scoreSegment(segment, TRAIT, {address: false});
  // Joy evidence without the mild words: they may support real joy but never create it.
  const mild = segment.tokens.filter(token => token.word && MILD_JOY.has(token.lower)).length;
  const phrases = phraseScores(lower);
  // "Over my dead body", "died laughing": the lexicon's death words in an idiom are not a loss.
  const idioms = (` ${lower} `.match(DEATH_IDIOMS) || []).length;
  if (idioms) scores.sadness = Math.max(0, scores.sadness - .6 * idioms);
  for (const [family, weight] of Object.entries(phrases.scores)) scores[family] = Math.max(0, scores[family] + weight);
  if (phrases.hits.length) tags.add('phrase');
  // "Trust" as a topic or a thing to earn is not tenderness ("Trust is earned", "I don't need your trust").
  const abstractTrust = (lower.match(ABSTRACT_TRUST) || []).length;
  if (abstractTrust) { scores.trust = Math.max(0, scores.trust - .65 * abstractTrust); tags.add('abstract-trust'); }
  // A feeling named as a topic ("Fear is a luxury") or denied beyond the lexicon's three-word negation reach ("I don't
  // get paid to be scared", "nothing to be afraid of") is not the speaker's feeling.
  for (const [pattern, family, amount] of ABSTRACT_AFFECT) {
    const hits = (lower.match(pattern) || []).length;
    if (hits) { scores[family] = Math.max(0, scores[family] - amount * hits); tags.add('not-felt'); }
  }
  // Answering a probing or hostile question with a first-person denial ("I didn't lie.", "I'm not dodging.") is
  // defensive: wary brows, a little frown.
  if (context.probed && DENIAL.test(lower)) { scores.fear += .45; scores.anger += .2; tags.add('denial'); }
  const laugh = tags.has('laugh') || phrases.scores.joy > 0;
  const strongJoy = scores.joy - .2 * mild;
  const exclaimed = segment.exclaims > 0;
  if (!laugh && strongJoy < manner.joyGate && !(exclaimed && strongJoy >= .3)) scores.joy = 0;
  if (scores.trust < manner.trustGate) scores.trust = 0;
  if (context.grief) {
    // Reminiscing about someone who is gone: praise and love read as loss, gratitude stays a little warm.
    const pleasant = scores.joy + scores.trust;
    if (pleasant > 0) tags.add('grief-reframe');
    scores.sadness += .6 * scores.joy + .35 * scores.trust;
    scores.joy *= laugh ? .35 : .15; scores.trust *= .4;
  }
  if (context.prior.fear || context.prior.anger) { scores.joy *= .5; scores.trust *= .7; }
  // Hype after a win swears and talks about violence; that is not anger.
  if (context.celebration && !context.grief && scores.joy > 0) scores.anger *= .3;
  return {scores, tags, laugh};
}

// ---- Convai's own reply-level label ---------------------------------------------------------------------------------
// One `bot-emotion` per reply (Plutchik-style label + scale 1-3). Measured on 993 hand-labelled segments
// (assets/emotion/segments-gold.json): the strong labels (Joy, Anger, Disgust, Trust, Sadness at scale 2, Pensiveness,
// Annoyance) name a segment's feeling 58-72 % of the time; the gentle ones (Interest, Acceptance, Anticipation, neutral,
// Serenity at scale 1) mostly sit on calm or mildly pleasant replies (about 45 % calm); Distraction is mostly a smile
// (46 % joy). So a label contributes its family at a strength that follows how informative it is, and the weakest
// labels stay under the visible threshold on their own (they only support other evidence).
export const PROVIDER_STRENGTH = Object.freeze([.35, .5, .65]);
// A label at or above this weight (after scaling) is clear enough to damp the text feelings of other families.
const CLEAR_LABEL = .22;
// Below this a family weight is not planned at all (a faint, twitchy face under a phrase that has nothing to say).
const WEAKEST = .12;
const PROVIDER_FAMILIES = Object.freeze({
  joy: {joy: 1}, happy: {joy: 1}, happiness: {joy: 1}, ecstasy: {joy: 1.1}, serenity: {trust: .8, joy: .3},
  trust: {trust: 1}, acceptance: {trust: .6}, admiration: {trust: .9}, love: {trust: 1},
  sadness: {sadness: 1}, sad: {sadness: 1}, grief: {sadness: 1.1}, pensiveness: {sadness: .9},
  anger: {anger: 1}, angry: {anger: 1}, rage: {anger: 1.1}, annoyance: {anger: 1},
  fear: {fear: 1}, terror: {fear: 1.1}, apprehension: {fear: .9}, anxiety: {fear: 1},
  disgust: {disgust: 1}, loathing: {disgust: 1.1}, boredom: {disgust: .6},
  surprise: {surprise: .9, joy: .2}, amazement: {surprise: 1}, distraction: {joy: .7, surprise: .4},
  anticipation: {anticipation: .6}, interest: {anticipation: .45}, vigilance: {anticipation: .6},
});
/** Convai's signal as family weights (`{label, family, weights}`), or undefined when it is absent, ours, or neutral. */
export function providerPrior(signal) {
  if (!signal || !['ordered', 'response-id'].includes(signal.basis)) return undefined;
  const label = String(signal.emotion || '').toLowerCase(), families = PROVIDER_FAMILIES[label];
  if (!families) return undefined;
  const strength = PROVIDER_STRENGTH[Math.max(0, Math.min(2, (signal.scale || 1) - 1))] * TUNE.providerScale, weights = {};
  for (const [family, factor] of Object.entries(families)) weights[family] = Math.round(strength * factor * 1000) / 1000;
  const family = Object.entries(weights).sort((a, b) => b[1] - a[1])[0][0];
  return {label, family, weight: weights[family], weights};
}
// Two independent reasons for the same feeling add up (1 - (1-a)(1-b)); a single one stands alone.
const softOr = (a, b) => 1 - (1 - a) * (1 - b);

/**
 * The plan for one spoken reply.
 *   player: the player's message (what the reply answers); reply: the clean reply text;
 *   profile: the character key; previous: {family, weight, ageMs} of this character's last reply (optional);
 *   convai: Convai's own signal for this turn ({emotion, scale, basis ordered/response-id}); marks: the character's
 *   inline emotion tags (Expressive emotions); breaks: forced segment edges (Omni phrase starts).
 *
 * Evidence per segment, combined per family (October 9 evening; before, a tag replaced everything):
 *   - a SPECIFIC tag ({joy}, {anger}, ...) names the feeling (right 54-80 % of the time on real replies) and wins unless
 *     the phrase's own words clearly say something stronger;
 *   - {calm} and {interest} are NOT evidence: on real replies the character opens 52 % of its replies with {calm} and
 *     tags {interest} on 24 % of its sentences, whatever it feels (calm tags sit on a calm line 31 % of the time,
 *     interest tags on an attentive one 13 %). They no longer silence the text, Convai's label or the conversation;
 *   - Convai's label, the conversation frames and the previous mood are the reply's mood and fill phrases with no
 *     feeling of their own; the phrase's own words and the reply's mood agreeing add up.
 *
 * `spans` is the hook for a deliberate tagger (the dynamic-context tag parser): [{start, end, emotion, intensity}] over
 * `reply` (offsets into the stripped text, intensity 1/2 as the tag parser writes it, or a 0-1 weight; emotion null = untagged, the picker decides). Tags win, the picker fills the gaps: a segment inside a span
 * takes the span's feeling at its intensity exactly ({calm} is an explicit neutral face); segments outside every span
 * are picked from the evidence above. Span edges are segment edges.
 */
export function selectEmotion({player = '', reply, profile, previous, convai, marks, spans, breaks = []} = {}) {
  if (typeof reply !== 'string' || !reply.trim() || reply.length > 12000) return undefined;
  const mannerName = mannerFor(profile), manner = MANNERS[mannerName];
  const context = conversationContext({player: typeof player === 'string' ? player.slice(0, 4000) : '', reply, previous, profile});
  const evidence = [...context.evidence];
  const provider = providerPrior(convai);
  const prior = {...context.prior};
  if (provider) {
    evidence.push(`convai:${provider.family}`);
    for (const family of Object.keys(prior)) prior[family] *= .5;
    for (const [family, weight] of Object.entries(provider.weights)) prior[family] = Math.max(prior[family] || 0, weight);
  }
  const placed = plannedMarks(marks, reply.length);
  const tagged = taggedSpans(spans, reply.length);
  const edges = tagged.flatMap(span => [span.start, span.end]).filter(at => at > 0 && at < reply.length);
  const raw = segmentText(reply, {breaks: placed.length || edges.length ? [...breaks, ...placed.map(mark => mark.at), ...edges] : breaks});
  if (!raw.length) return undefined;
  const providerNegative = provider && provider.weight >= CLEAR_LABEL && NEGATIVE.has(provider.family);
  const sarcastic = SARCASM.test(normalise(reply));
  if (sarcastic) evidence.push('sarcasm');
  const segments = raw.map((segment, index) => {
    const span = tagged.find(candidate => candidate.start <= (segment.start + segment.end) / 2 && (segment.start + segment.end) / 2 < candidate.end);
    const {scores, tags} = scoreContextSegment(segment, reply, context, manner);
    if (providerNegative) { scores.joy *= .4; scores.trust *= .6; }
    if (sarcastic) { scores.disgust += .35 * (scores.joy + scores.trust) + .3; scores.joy = 0; scores.trust *= .2; tags.add('sarcasm'); }
    // A clear Convai label saw the whole conversation: text feelings of other families count for less.
    if (provider && provider.weight >= CLEAR_LABEL) for (const family of FAMILIES) if (!(family in provider.weights)) scores[family] *= .7;
    let emphasis = 1;
    if (segment.contrastNext) { emphasis *= .6; tags.add('pre-contrast'); }
    if (segment.contrast) { emphasis *= 1.18; tags.add('contrast'); }
    let feelings = {};
    for (const family of FAMILIES) {
      // A reserved or cold manner also caps the strongest phrase (.8, .6), so strong text cannot saturate Johnny
      // to Panam's level (both used to clamp at 1).
      const weight = Math.min(clamp01(scores[family] * .85 * emphasis * manner.range), manner.range);
      if (weight >= .2) feelings[family] = weight;
    }
    const mark = placed.findLast(candidate => candidate.at <= segment.start);
    let named = false;
    if (mark) {
      tags.add('llm-emotion');
      if (mark.family === null) tags.add('llm-calm');
      else if (mark.family === 'anticipation') tags.add('llm-interest');
      else {
        // A specific tag picks the feeling; the phrase's own text can make it stronger, or a clearly stronger feeling
        // of another family in the words themselves stays beside it.
        const weight = clamp01(mark.weight * manner.range), kept = {};
        for (const [family, value] of Object.entries(feelings)) {
          // A frowning tag is overruled by a smile in the words only when the words are decisive.
          const bar = NEGATIVE.has(mark.family) && (family === 'joy' || family === 'trust') ? Math.max(.7, weight) : Math.max(.5, weight);
          if (family !== mark.family && value >= bar) kept[family] = value;
        }
        feelings = {...kept, [mark.family]: Math.max(weight, feelings[mark.family] || 0)};
        named = true;
      }
    }
    // The reply's mood fills phrases with no feeling of their own, stays under weaker ones, and adds to the same family.
    const own = Math.max(0, ...Object.values(feelings)), top = Object.entries(feelings).sort((a, b) => b[1] - a[1])[0]?.[0];
    const weights = {};
    for (const family of FAMILIES) {
      // The player's line colours a phrase that has a feeling of its own, and (less) one that has none.
      const frame = (context.frames[family] || 0) * TUNE.frameScale * (own >= .2 || named ? 1 : TUNE.frameAlone);
      let fromPrior = softOr((prior[family] || 0) * manner.range, frame * manner.range);
      if (named) fromPrior *= TUNE.namedPrior;
      else if (own >= .35 && family !== top) fromPrior *= TUNE.priorOther;
      const total = softOr(feelings[family] || 0, fromPrior);
      if (total >= WEAKEST) weights[family] = round(total);
    }
    // A clearly negative phrase leaves no smile under it (the Lua mix would otherwise cross-fade toward a smile).
    const negative = [...NEGATIVE].reduce((sum, family) => sum + (weights[family] || 0), 0);
    const ratio = context.grief ? .6 : 1.5;
    for (const family of ['joy', 'trust']) if (weights[family] && negative >= ratio * weights[family]) delete weights[family];
    if (span) {   // a deliberate tag wins over everything above
      for (const family of Object.keys(weights)) delete weights[family];
      for (const family of Object.keys(feelings)) delete feelings[family];
      if (span.family) { weights[span.family] = feelings[span.family] = span.weight; }
      tags.clear(); tags.add('tagged-span');
    }
    const words = segment.tokens.filter(token => token.word), syl = words.reduce((sum, token) => sum + syllables(token.raw), 0);
    const closing = [...segment.tokens].reverse().find(token => !token.word) ?? null;
    const closingEnds = closing && segment.tokens.at(-1) === closing ? closing : null;
    const dominant = Object.entries(weights).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    return {start: segment.start, end: segment.end, weights, feelings, dominant, tags: [...tags].sort(),
      syllables: syl, seconds: syl / 4.4, pauseAfter: raw[index + 1] ? pause(closingEnds) : 0,
      mixed: Object.keys(weights).length > 1};
  });
  const plan = {version: 2, selector: 'context', length: reply.length, trait: mannerName, baseline: {}, segments, evidence};
  plan.summary = summariseContext(plan);
  settleCarriedFeelings(segments);
  return plan;
}

// October 9 (user: "sometimes the eyebrows flicker", an anger reply read .54, .30, .47 phrase by phrase): a feeling that
// carries on into the next phrase should not fall by the whole gap and climb back; its brows, lids and squint would
// sag and lift again within a few seconds, which reads as a twitch. A fall in a feeling that is already showing moves
// only SETTLE of the way down (.54 -> .30 plans .42), a rise is taken in full, and a feeling that starts, stops or
// changes family is untouched, so anger -> joy still reads at once. A deliberate span tag stays exact. The reply
// summary (the cue when no label arrived) is taken from the raw phrases, before this pass.
export const SETTLE = .5;
export function settleCarriedFeelings(segments) {
  let before = null;
  for (const segment of segments) {
    if (before && !segment.tags.includes('tagged-span')) {
      let changed = false;
      for (const [family, weight] of Object.entries(segment.weights)) {
        const held = before.weights[family];
        if (held === undefined || weight >= held) continue;
        segment.weights[family] = round(held + (weight - held) * SETTLE);
        changed = true;
      }
      if (changed) segment.dominant = Object.entries(segment.weights).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    }
    before = segment;
  }
}

/** Valid spans of a tagger ({start, end, emotion, intensity}), in order: the feeling's family (null for calm) and its weight. */
function taggedSpans(spans, length) {
  if (!Array.isArray(spans)) return [];
  const out = [];
  for (const span of spans) {
    if (!span || !Number.isFinite(span.start) || !Number.isFinite(span.end) || span.end <= span.start || span.start >= length) continue;
    const name = String(span.emotion ?? '').toLowerCase();
    const family = name in EMOTION_FAMILY ? EMOTION_FAMILY[name] : FAMILIES.includes(name) ? name : undefined;
    if (family === undefined) continue;
    // The tag parser counts 1 (subtle) and 2 (strong); a fraction is taken as the weight itself.
    const level = span.intensity, weight = level === 2 ? MARK_WEIGHT.strong : level === 1 ? MARK_WEIGHT.subtle : Number.isFinite(level) ? clamp01(level) : MARK_WEIGHT.subtle;
    out.push({start: Math.max(0, span.start), end: Math.min(length, span.end), family, weight: family === null ? 0 : round(weight)});
  }
  return out.sort((a, b) => a.start - b.start);
}

function pause(closing) {
  if (!closing) return .04;
  if (closing.ellipsis) return .45;
  if (closing.terminal) return .3;
  if (closing.comma) return .12;
  return .04;
}

// Reply-level label: per family, half its time-weighted mean and half its peak phrase (one clearly frightened
// sentence in three still makes a frightened reply), or calm when nothing reaches a visible strength.
const CALM_BELOW = .2;
function summariseContext(plan) {
  const sums = {}, peaks = {};
  let total = 0;
  for (const segment of plan.segments) {
    const span = Math.max(.2, segment.seconds);
    total += span;
    for (const [family, weight] of Object.entries(segment.weights)) {
      sums[family] = (sums[family] || 0) + weight * span;
      peaks[family] = Math.max(peaks[family] || 0, weight);
    }
  }
  const ranked = Object.keys(sums).map(family => [family, .5 * sums[family] / total + .5 * peaks[family]])
    .sort((a, b) => b[1] - a[1]);
  const [family, score] = ranked[0] ?? [null, 0];
  if (!family || score < CALM_BELOW) return {family: null, label: 'Calm', weight: 0, basis: 'calm', scale: 1};
  const weight = Math.round(score * 1000) / 1000;
  return {family, label: LABELS[family], weight, basis: 'text', scale: weight >= .7 ? 3 : weight >= .45 ? 2 : 1};
}

export const LABEL_OF = Object.freeze({joy: 'joy', trust: 'warm', anticipation: 'interest', surprise: 'surprise',
  sadness: 'sadness', fear: 'fear', anger: 'anger', disgust: 'disgust'});
/** The evaluation label of a plan: one of joy, warm, interest, surprise, sadness, fear, anger, disgust, calm. */
export function SELECTOR_LABEL(plan) {
  if (!plan?.summary?.family || plan.summary.basis === 'calm') return 'calm';
  return LABEL_OF[plan.summary.family];
}

/** The previous text planner, for the setting fallback and the comparison script. */
export function legacyPlan(text, options) { return analyseReply(text, options); }

// ---- the bridge's selection state ---------------------------------------------------------------------------
// `emotionSelector` in runtime/settings.json (no menu entry; the game keeps unknown keys): "legacy" returns to the
// previous reply-only planner, anything else (or nothing) is this selector. The previous turn's mood is kept per
// character for three minutes, in memory only.
export const PREVIOUS_MS = 180000;
export class EmotionSelection {
  constructor({now = Date.now} = {}) { this.mode = 'context'; this.recent = new Map(); this.now = now; }
  update(settings) {
    if (!settings || typeof settings !== 'object') return false;
    const next = settings.emotionSelector === 'legacy' ? 'legacy' : 'context', changed = next !== this.mode;
    this.mode = next;
    return changed;
  }
  previous(profile) {
    const held = this.recent.get(profile);
    if (!held) return undefined;
    const ageMs = this.now() - held.at;
    if (ageMs < 0 || ageMs >= PREVIOUS_MS) { this.recent.delete(profile); return undefined; }
    return {family: held.family, weight: held.weight, ageMs};
  }
  remember(profile, plan) {
    if (typeof profile !== 'string' || !plan?.summary) return;
    if (!plan.summary.family || plan.summary.basis === 'calm') { this.recent.delete(profile); return; }
    // A reply whose only feeling is the carried mood keeps the original time and its (weaker) weight, so a
    // carried mood fades within a turn or two instead of renewing itself.
    const held = this.recent.get(profile), carriedOnly = held && plan.evidence?.length === 1
      && plan.evidence[0] === `previous:${held.family}` && plan.summary.family === held.family;
    this.recent.set(profile, {family: plan.summary.family, weight: plan.summary.weight, at: carriedOnly ? held.at : this.now()});
    if (this.recent.size > 64) this.recent.delete(this.recent.keys().next().value);
  }
  /** One reply's plan. `convai` is Convai's own signal for this turn when known. Never throws. */
  plan({player, reply, profile, convai, marks, breaks} = {}) {
    try {
      if (this.mode === 'legacy') return analyseReply(reply, {profile, baseline: baselineFromSignal(convai), breaks, marks});
      return selectEmotion({player, reply, profile, previous: this.previous(profile), convai, marks, breaks});
    } catch { return undefined; }
  }
  /** A cached planner for growing stream text (continuous Convai and Pocket speech). `late.signal`, when it is set
   * later, is Convai's late emotion for a text-only turn and replaces the stream's own (absent) signal. */
  planner({player, profile, marks, breaks, late} = {}) {
    let key, plan;
    const previous = this.previous(profile), mode = this.mode;
    return (text, signal) => {
      const convai = signal ?? late?.signal, baseline = baselineFromSignal(convai), given = providerPrior(convai);
      const id = text + '\u0000' + (mode === 'legacy' ? (baseline ? baseline.family + baseline.weight : '') : (given ? given.label + given.weight : ''));
      if (id !== key) {
        key = id;
        try {
          plan = mode === 'legacy' ? analyseReply(text, {profile, baseline, breaks, marks})
            : selectEmotion({player, reply: text, profile, previous, convai, marks, breaks});
        } catch { plan = undefined; }
      }
      return plan;
    };
  }
}

/** Poll `read()` (RealtimeHost.lateEmotion) until Convai's late emotion is admitted, it can no longer arrive, or the
 * deadline passes. Resolves to the signal or undefined; never rejects. */
export async function waitLateEmotion(read, {deadlineMs = 1500, intervalMs = 80, signal, wait} = {}) {
  const sleep = wait ?? (ms => new Promise(done => setTimeout(done, ms)));
  const until = Date.now() + deadlineMs;
  while (!signal?.aborted) {
    let state;
    try { state = await read(); } catch { return undefined; }
    if (state?.signal) return state.signal;
    if (!state?.pending || Date.now() >= until) return undefined;
    await sleep(intervalMs);
  }
  return undefined;
}
