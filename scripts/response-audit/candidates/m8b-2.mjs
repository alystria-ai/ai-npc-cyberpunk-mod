// ministral-8b candidate 2: lower temperature and a rule for one-word lines (the base prompt answers "Yeah." with a new topic).
import {BASE_PROFILE} from '../../../bridge/prompt-profiles.mjs';
const rules = BASE_PROFILE.rules.map(rule => ({...rule}));
rules.splice(4, 0, {id: 'short-lines', text: 'If V says only a word or two ("Yeah.", "Hm.", "Hey.", "Never mind."), answer in kind in a few words. Do not start a new topic and do not offer anything.'});
export default {mistral: {sampling: {temperature: 0.5}, rules}};
