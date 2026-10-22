// Bonsai candidate 3: candidate 2 plus a shorter character text and fewer turns of history (less to read, fewer competing details).
import cand from './lite-2.mjs';
export default {'local-lite': {...cand['local-lite'], limits: {persona: 6000, turns: 4}}};
