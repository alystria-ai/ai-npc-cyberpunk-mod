// Mature Standard (Gemma 4 E4B MiniFantasy) candidate 1: the full rules with the comprehension rule, the Mature variants kept, the notes after V's line.
import {BASE_PROFILE} from '../../../bridge/prompt-profiles.mjs';
const rules = BASE_PROFILE.rules.map(rule => ({...rule}));
rules.splice(1, 0, {id: 'answer', text: 'Answer exactly what V just said. A question gets its answer, an insult or a threat gets your reaction to it, a greeting gets a greeting. If V says only a word or two ("Yeah.", "Hm.", "Never mind."), answer in kind in a few words, with no new topic and no offer.'});
export default {'mature-standard': {sampling: {temperature: 0.6}, rules, layout: {volatile: 'after'}}};
