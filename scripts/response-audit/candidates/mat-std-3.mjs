// Mature Standard candidate 3: candidate 2 and a rule that keeps game slang to one word a reply (the Mature word bank put "choom", "gonk" and "preem" into every character's mouth).
import cand from './mat-std-2.mjs';
const rules = cand['mature-standard'].rules.map(rule => ({...rule}));
rules.splice(rules.findIndex(rule => rule.id === 'plain') + 1, 0, {id: 'slang', text: 'Swearing and crude talk are fine in your own voice. Game slang ("choom", "gonk", "preem", "delta") is spice, not punctuation: at most one such word in a reply, and "choom" only if you are Jackie.'});
export default {'mature-standard': {...cand['mature-standard'], rules}};
