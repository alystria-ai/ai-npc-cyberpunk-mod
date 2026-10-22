// Custom endpoint serving a Qwen model: the short plain rules, a lower temperature and a small repeat penalty.
import lite from './lite-1.mjs';
export default {'@custom': {...lite['local-lite'], sampling: {temperature: 0.5, repeatPenalty: 1.05}, layout: {volatile: 'after'}}};
