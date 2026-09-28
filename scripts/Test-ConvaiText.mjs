import {readFile, writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {RealtimeHost} from '../bridge/realtime-host.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const keyLine = (await readFile(resolve(root, 'runtime/convai-key.txt'), 'utf8')).trim();
const key = /^api-key\s*=\s*(\S+)\s*$/i.exec(keyLine)?.[1];
if (!key) throw Error('Local key is missing');
const ids = JSON.parse(await readFile(resolve(root, 'runtime/characters.json'), 'utf8'));
const host = new RealtimeHost();
try {
  const started = performance.now();
  const result = await host.reply({key, characterId: ids['blue-moon'], ttsEnabled: false,
    text: 'Say a short hello to V in one sentence.'});
  if (!result.text || result.audio) throw Error('Text-only completion did not meet the contract');
  const evidence = {text: result.text, ttsEnabled: false, audioReceived: !!result.audio,
    elapsedMs: performance.now() - started, timing: result.timing};
  await writeFile(resolve(root, 'runtime/convai-text-only-check.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({...evidence, text: undefined, receivedText: true}));
} finally { await host.close(); }
