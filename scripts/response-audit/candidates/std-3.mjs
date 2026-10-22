// Standard candidate 3: the short plain rules that suited the Lite model, a lower temperature, the notes after V's line.
import lite from './lite-1.mjs';
export default {'local-standard': {...lite['local-lite'], sampling: {temperature: 0.5}, layout: {volatile: 'after'}}};
