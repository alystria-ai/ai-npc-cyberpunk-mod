// ministral-8b candidate 5: candidate 4 and three example replies (the shape only) after the rules.
import cand from './m8b-4.mjs';
export default {mistral: {...cand.mistral, examples: [
  'V: Where were you? / You: Out front, minding my own business. Why, did something happen?',
  'V: Yeah. / You: Yeah.',
  'V: You are useless. / You: Say that again and see how far you get without me.',
]}};
