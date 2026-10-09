// Emotion cue from a reply's own text, for local voices (Pocket, Omni). Convai
// sends no emotion metadata on text-only turns (live probe, October 5), and the
// first version of this file only fired when one feeling clearly dominated,
// which left almost every reply with a dead face (October 6: Judy's "I'm just
// glad I've got someone I can actually trust" scored a single Joy hit and was
// dropped). Every reply now yields a cue:
//   1. a lexicon feeling when one clearly leads (one clear word is enough);
//   2. otherwise the reply's tone (a question lifts the brows, an exclamation
//      smiles, a negated or cold line stays flat);
//   3. otherwise a mild, character-appropriate warmth (a gentle smile for most
//      companions, a flat attentive face for the cold ones).
// This is a small lexicon with negation handling and scale from intensity, not
// sentiment analysis of the player, and it makes no network or model request.
const LEXICON = {
  Joy: [['haha', 1.5], ['hah', 1], ['heh', 1], ['lol', 1], ['laugh', 1], ['laughing', 1], ['glad', 1], ['happy', 1],
    ['great', 1], ['awesome', 1], ['amazing', 1], ['love it', 1.5], ['preem', 1], ['nova', 1], ['wonderful', 1],
    ['fantastic', 1], ['perfect', 1], ['celebrate', 1], ['cheers', 1], ['yes!', 1], ['hell yeah', 1.5], ['fun', 1],
    ['funny', 1], ['hilarious', 1.5], ['beautiful', 1], ['lucky', 1], ['proud', 1], ['smile', 1], ['grin', 1],
    ['delighted', 1.5], ['thrilled', 1.5], ['excited', 1], ['drink to that', 1.5], ['good to see you', 1.5],
    ['nice', .5], ['good news', 1], ['enjoy', .5], ['cool', .5], ['sweet', .5], ['love', .5], ['finally', .5],
    ['nailed it', 1.5], ['we did it', 1.5], ['well done', 1], ['not bad', .5], ['sounds good', .5], ['wanna', .5]],
  Sadness: [['sorry', 1], ['sad', 1], ['miss him', 1.5], ['miss her', 1.5], ['miss them', 1.5], ['lost', 1], ['loss', 1],
    ['grief', 1.5], ['grieve', 1.5], ['cry', 1], ['crying', 1], ['tears', 1], ['hurts', 1], ['heartbroken', 1.5],
    ['lonely', 1], ['alone', 1], ['regret', 1], ['died', 1.5], ['dead', 1], ['funeral', 1.5], ['gone now', 1.5],
    ['mourn', 1.5], ['tragic', 1.5], ['broke my heart', 1.5], ['wish things', 1.5], ['never came back', 1.5],
    ['flatlined', 1], ['tired', .5], ['miss you', 1], ['wish i', .5], ['too late', 1], ['empty', .5]],
  Anger: [['angry', 1], ['furious', 1.5], ['pissed', 1], ['hate', 1], ['bastard', 1], ['bastards', 1], ['damn it', 1.5],
    ['goddamn', 1], ['screw', 1], ['fuck', 1], ['fucking', 1], ['shut up', 1.5], ['how dare', 1.5], ['gonk', 1],
    ['choomba better', 1], ['son of a bitch', 1.5], ['kill him', 1.5], ['kill them', 1.5], ['payback', 1.5],
    ['enough!', 1.5], ['sick of', 1], ['outrageous', 1], ['betray', 1], ['betrayed', 1], ['liar', 1], ['idiot', 1],
    ['asshole', 1], ['corpo scum', 1.5], ['piss me off', 1.5], ['back off', 1]],
  Fear: [['scared', 1], ['afraid', 1], ['terrified', 1.5], ['fear', 1], ['nervous', 1], ['worried', 1], ['worry', 1],
    ['panic', 1.5], ['danger', 1], ['dangerous', 1], ["don't like this", 1.5], ['run', .5], ['hide', 1], ['trap', 1],
    ['creepy', 1], ['uneasy', 1], ['anxious', 1], ['what if they', 1.5], ['careful', .5], ['watch out', 1],
    ['get down', 1], ['look out', 1], ['bad feeling', 1.5]],
  Surprise: [['wow', 1], ['whoa', 1], ['what?!', 1.5], ['no way', 1.5], ['really?', 1], ['seriously?', 1],
    ['unbelievable', 1], ["can't believe", 1.5], ['shocked', 1], ['surprised', 1], ['holy', 1], ['damn!', 1],
    ['wait, what', 1.5], ['you did what', 1.5], ['oh!', .5], ['whoa!', 1]],
  Disgust: [['gross', 1], ['disgusting', 1.5], ['sick', .5], ['nasty', 1], ['vile', 1.5], ['revolting', 1.5],
    ['filthy', 1], ['ugh', 1], ['yuck', 1], ['stink', .5], ['reek', .5], ['trash', .5]],
  Trust: [['trust you', 1.5], ['got your back', 1.5], ['always here', 1.5], ['count on me', 1.5], ['promise', 1],
    ['together', .5], ['thank you', 1], ['thanks, v', 1], ['thanks', .5], ['i care', 1.5], ['proud of you', 1.5],
    ['here for you', 1.5], ['you can trust', 1.5], ['someone i can', .5], ['i trust', 1], ['with you', .5],
    ['good friend', 1], ['like family', 1.5]],
  Interest: [['curious', 1], ['wonder', .5], ['tell me', .5], ['what do you think', 1], ['interesting', 1],
    ['hmm', .5], ['listen', .5], ['got an idea', 1], ['think about it', .5], ['you know what', .5], ['plan', .5]],
};
const NEGATION = new Set(['not', 'no', 'never', "don't", 'dont', "isn't", "wasn't", "aren't", 'hardly', "can't", 'cannot', 'without']);
// Profiles whose resting manner is not warm: the face stays alert but flat
// unless the text itself carries a feeling. Warm characters rest in a clearer
// smile than everyone else (scale 2 vs 1 of the Trust pose).
const COLD = new Set(['adam-smasher', 'alt-cunningham', 'yorinobu-arasaka', 'hanako-arasaka', 'alan-noel', 'mr-hands']);
const WARM = new Set(['judy-alvarez', 'jackie-welles', 'panam-palmer', 'kerry-eurodyne', 'misty-olszewski',
  'mama-welles', 'river-ward', 'claire-russell', 'dexter-deshawn', 'padre-ibarra', 'viktor-vektor']);

function words(text) {
  return text.toLowerCase().replace(/[‘’]/g, "'").match(/[a-z']+|[!?]/g) || [];
}

function analyse(text) {
  const lower = ' ' + text.toLowerCase().replace(/[‘’]/g, "'").replace(/\s+/g, ' ') + ' ';
  const tokens = words(text), scores = {};
  let negatedPositive = false;
  for (const [emotion, cues] of Object.entries(LEXICON)) {
    let score = 0;
    for (const [cue, weight] of cues) {
      const pattern = new RegExp(`(^|[^a-z'])${cue.replace(/[.*+?^${}()|[\]\\!]/g, '\\$&')}(?=$|[^a-z'])`, 'g');
      for (const match of lower.matchAll(pattern)) {
        // A negation within the two preceding words cancels the cue ("not happy").
        const before = words(lower.slice(Math.max(0, match.index - 24), match.index + match[1].length)).slice(-2);
        if (before.some(word => NEGATION.has(word))) {
          if (['Joy', 'Trust'].includes(emotion)) negatedPositive = true;
          continue;
        }
        score += weight * (cue.includes(' ') ? 1.5 : 1);
      }
    }
    if (score) scores[emotion] = score;
  }
  const exclaims = tokens.filter(token => token === '!').length;
  for (const emotion of ['Joy', 'Anger', 'Surprise']) if (scores[emotion]) scores[emotion] += Math.min(1, exclaims * .5);
  return {scores, exclaims, questions: tokens.filter(token => token === '?').length, negatedPositive};
}

function lexiconCue(scores) {
  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  if (!ranked.length) return undefined;
  const [[emotion, score], second] = ranked;
  // Joy and Trust are both pleasant: together they reinforce rather than tie.
  const together = second && ['Joy', 'Trust'].includes(emotion) && ['Joy', 'Trust'].includes(second[0]);
  const margin = together ? score : score - (second?.[1] ?? 0);
  // Two feelings close together, or one half-weight hint, say nothing definite.
  if (score < 1 || margin < .75) return undefined;
  const strength = together ? score + second[1] : score;
  return {emotion, scale: strength >= 4 ? 3 : strength >= 1.75 ? 2 : 1};
}

// The feeling found in the text alone, or nothing.
export function textEmotion(text) {
  if (typeof text !== 'string' || !text.trim() || text.length > 12000) return undefined;
  return lexiconCue(analyse(text).scores);
}

// Always a cue for non-empty text: lexicon, then tone, then character warmth.
export function textExpression(text, {profile} = {}) {
  if (typeof text !== 'string' || !text.trim() || text.length > 12000) return undefined;
  const found = analyse(text), lexicon = lexiconCue(found.scores);
  if (lexicon) return {...lexicon, basis: 'text'};
  const cold = COLD.has(profile);
  // Hedged or refused positives ("I'm not happy about this") must not smile.
  if (found.negatedPositive) return {emotion: 'Interest', scale: 1, basis: 'tone'};
  if (found.questions && found.questions >= found.exclaims) return {emotion: 'Interest', scale: cold ? 1 : 2, basis: 'tone'};
  if (found.exclaims && !cold) return {emotion: 'Joy', scale: 1, basis: 'tone'};
  if (cold) return {emotion: 'Interest', scale: 1, basis: 'default'};
  return {emotion: 'Trust', scale: WARM.has(profile) ? 2 : 1, basis: 'default'};
}

// A local voice's expression signal: exact ownership (this reply's own text).
export function textExpressionSignal(text, options) {
  const found = textExpression(text, options);
  return found ? {version: 1, correlated: true, sequence: 0, emotion: found.emotion, scale: found.scale, basis: found.basis} : undefined;
}
