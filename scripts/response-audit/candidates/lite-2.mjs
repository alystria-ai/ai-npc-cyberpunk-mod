// Bonsai candidate 2: candidate 1 plus a lower temperature and a repeat penalty.
import cand from './lite-1.mjs';
export default {'local-lite': {...cand['local-lite'], sampling: {temperature: 0.45, repeatPenalty: 1.1}}};
