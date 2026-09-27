import {readFile, writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {requestReply} from '../bridge/convai-client.mjs';
import {inspectWav} from '../bridge/speech-audio.mjs';
import {RealtimeHost} from '../bridge/realtime-host.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const keyLine = (await readFile(resolve(root, 'runtime/convai-key.txt'), 'utf8')).trim();
const key = /^api-key\s*=\s*(\S+)\s*$/i.exec(keyLine)?.[1];
if (!key) throw Error('Local key is missing');
const ids = JSON.parse(await readFile(resolve(root, 'runtime/characters.json'), 'utf8'));
const host = new RealtimeHost();
let result;
try {
  result = process.argv.includes('--rest')
    ? await requestReply({key, characterId: ids.alex, text: 'Say a brief hello to V in one sentence.', voice: true})
    : await host.reply({key, characterId: ids.alex, text: 'Say a brief hello to V in one sentence.'});
} finally { await host.close(); }
const bytes = Buffer.from(result.audio || '', 'base64');
const info = inspectWav(bytes);
await writeFile(resolve(root, 'runtime/voice-check.wav'), bytes);
await writeFile(resolve(root, 'runtime/voice-check.json'), JSON.stringify({text: result.text, faces: result.faces, captions: result.captions, ...info}, null, 2));
console.log(JSON.stringify({receivedText: !!result.text, bytes: bytes.length, faces: result.faces?.length, ...info}));
