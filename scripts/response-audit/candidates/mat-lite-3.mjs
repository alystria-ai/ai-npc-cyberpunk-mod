// Mature Lite candidate 3: candidate 1 and the slang rule.
import cand from './mat-lite-1.mjs';
const rules = cand['mature-lite'].rules.map(rule => ({...rule}));
rules.splice(rules.findIndex(rule => rule.id === 'plain') + 1, 0, {id: 'slang', text: 'Swearing and crude talk are fine in your own voice. Game slang ("choom", "gonk", "preem", "delta") is spice, not punctuation: at most one such word in a reply, and "choom" only if you are Jackie.'});
export default {'mature-lite': {...cand['mature-lite'], rules}};
