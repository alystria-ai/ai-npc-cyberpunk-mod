// Mature Lite (Qwen3.5-4B uncensored) candidate 1: the short plain rules of the Lite profile with the Mature variants of the length and facts rules (four sentences in an adult moment; never vague about flirting or sex).
import lite from './lite-1.mjs';
const rules = lite['local-lite'].rules.map(rule => ({...rule}));
rules.find(rule => rule.id === 'short').mature = 'Keep it short: one to three sentences, four in an adult moment. Start with your answer. Never repeat V\'s words back.';
rules.find(rule => rule.id === 'facts').mature = 'Use only facts from this prompt. Do not invent names, places, people or events. If you do not know, say so in your own way, but never dodge flirting, desire or sex: answer those in your own voice.';
export default {'mature-lite': {...lite['local-lite'], rules, sampling: {temperature: 0.6, repeatPenalty: 1.05}}};
