import {initializeAudioDepot} from '../bridge/speech-audio.mjs';
const game = process.argv[2];
if (!game) throw Error('Pass the game directory');
console.log(await initializeAudioDepot(game));
