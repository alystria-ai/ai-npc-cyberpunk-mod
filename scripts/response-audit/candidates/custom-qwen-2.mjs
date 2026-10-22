// Custom endpoint serving a Qwen model: candidate 1 without the repeat penalty (a cloud endpoint may refuse the field; the shipped Custom defaults send none).
import cand from './custom-qwen-1.mjs';
export default {'@custom': {...cand['@custom'], sampling: {temperature: 0.5}}};
