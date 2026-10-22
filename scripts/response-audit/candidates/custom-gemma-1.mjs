// Custom endpoint serving a Gemma model: the Standard profile's winning wording (short plain rules, lower temperature, the notes after V's line).
import std from './std-3.mjs';
export default {'@custom': std['local-standard']};
