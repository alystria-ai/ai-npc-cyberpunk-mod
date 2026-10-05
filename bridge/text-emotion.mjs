// Conservative emotion cue from a reply's own text, for local voices: Convai
// sends no emotion metadata on text-only turns (live probe, October 5). This
// is a small lexicon with negation handling, not sentiment analysis of the
// player. It returns nothing unless one feeling clearly dominates; the face
// then stays neutral (with its light resting smile).
const LEXICON = {
  Joy: ['haha', 'hah', 'heh', 'lol', 'laugh', 'laughing', 'glad', 'happy', 'great', 'awesome', 'amazing', 'love it',
    'preem', 'nova', 'wonderful', 'fantastic', 'perfect', 'celebrate', 'cheers', 'yes!', 'hell yeah', 'fun', 'funny',
    'hilarious', 'beautiful', 'lucky', 'proud', 'smile', 'grin', 'delighted', 'thrilled', 'excited', 'drink to that'],
  Sadness: ['sorry', 'sad', 'miss him', 'miss her', 'miss them', 'lost', 'loss', 'grief', 'grieve', 'cry', 'crying',
    'tears', 'hurts', 'heartbroken', 'lonely', 'alone', 'regret', 'died', 'dead', 'funeral', 'gone now', 'mourn',
    'tragic', 'broke my heart', 'wish things', 'never came back', 'flatlined'],
  Anger: ['angry', 'furious', 'pissed', 'hate', 'bastard', 'bastards', 'damn it', 'goddamn', 'screw', 'fuck', 'fucking',
    'shut up', 'how dare', 'gonk', 'choomba better', 'son of a bitch', 'kill him', 'kill them', 'payback', 'enough!',
    'sick of', 'outrageous', 'betray', 'betrayed', 'liar'],
  Fear: ['scared', 'afraid', 'terrified', 'fear', 'nervous', 'worried', 'worry', 'panic', 'danger', 'dangerous',
    "don't like this", 'run', 'hide', 'trap', 'creepy', 'uneasy', 'anxious', 'what if they'],
  Surprise: ['wow', 'whoa', 'what?!', 'no way', 'really?', 'seriously?', 'unbelievable', "can't believe", 'shocked',
    'surprised', 'holy', 'damn!', 'wait, what'],
  Disgust: ['gross', 'disgusting', 'sick', 'nasty', 'vile', 'revolting', 'filthy', 'ugh', 'yuck'],
  Trust: ['trust you', 'got your back', 'always here', 'count on me', 'promise', 'together', 'thank you', 'thanks, v',
    'i care', 'proud of you', 'here for you'],
};
const NEGATION = new Set(['not', 'no', 'never', "don't", 'dont', "isn't", "wasn't", "aren't", 'hardly', "can't", 'cannot', 'without']);

function words(text) {
  return text.toLowerCase().replace(/[‘’]/g, "'").match(/[a-z']+|[!?]/g) || [];
}

export function textEmotion(text) {
  if (typeof text !== 'string' || !text.trim() || text.length > 12000) return undefined;
  const lower = ' ' + text.toLowerCase().replace(/[‘’]/g, "'").replace(/\s+/g, ' ') + ' ';
  const tokens = words(text), scores = {};
  for (const [emotion, cues] of Object.entries(LEXICON)) {
    let score = 0;
    for (const cue of cues) {
      const pattern = new RegExp(`(^|[^a-z'])${cue.replace(/[.*+?^${}()|[\]\\!]/g, '\\$&')}(?=$|[^a-z'])`, 'g');
      for (const match of lower.matchAll(pattern)) {
        // A negation within the two preceding words cancels the cue ("not happy").
        const before = words(lower.slice(Math.max(0, match.index - 24), match.index + match[1].length)).slice(-2);
        if (before.some(word => NEGATION.has(word))) continue;
        score += cue.includes(' ') ? 1.5 : 1;
      }
    }
    if (score) scores[emotion] = score;
  }
  const exclaims = tokens.filter(token => token === '!').length;
  for (const emotion of ['Joy', 'Anger', 'Surprise']) if (scores[emotion]) scores[emotion] += Math.min(1, exclaims * .5);
  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  if (!ranked.length) return undefined;
  const [[emotion, score], second] = ranked, margin = score - (second?.[1] ?? 0);
  // Neutral when unsure: a single weak cue, or two feelings close together.
  if (score < 1.5 || margin < 1) return undefined;
  return {emotion, scale: score >= 4 ? 2 : 1};
}

// A local voice's expression signal: exact ownership (this reply's own text).
export function textExpressionSignal(text) {
  const found = textEmotion(text);
  return found ? {version: 1, correlated: true, sequence: 0, emotion: found.emotion, scale: found.scale, basis: 'text'} : undefined;
}
