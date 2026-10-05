// Development probe: what emotion metadata does Convai actually send, and can
// it be tied to the response? Sends a few short turns as the existing TEST
// end user on Alex (memory belongs to that test identity), once with Convai
// voice and once text-only like the local voices. Records only shape evidence
// (presence of ids, skip reasons) plus the admitted label/scale, never keys.
//   node scripts/lipsync/probe_convai_emotion.mjs
import {readFile, writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {RealtimeHost} from '../../bridge/realtime-host.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const key = /^api-key\s*=\s*(\S+)\s*$/i.exec((await readFile(resolve(root, 'runtime/convai-key.txt'), 'utf8')).trim())?.[1];
if (!key) throw Error('Local key is missing');
const ids = JSON.parse(await readFile(resolve(root, 'runtime/characters.json'), 'utf8'));
const endUserId = '44634786-9337-4103-b8dd-dc553202563b';
const turns = process.argv[2] === 'voiced-pair' ? [
  {ttsEnabled: true, text: 'Okay, that was hilarious. Did you see the look on his face?'},
  {ttsEnabled: true, text: "Someone just torched our safehouse. I'm furious. Who would do this?"},
] : [
  {ttsEnabled: true, text: "Alex, it's V. I just heard Songbird might not make it. How are you holding up?"},
  {ttsEnabled: false, text: 'Good news for once: we pulled it off and everyone got out alive. Say something to celebrate.'},
];
const host = new RealtimeHost(process.env.PROBE_CLIENT ? {clientAssetsDirectory: process.env.PROBE_CLIENT} : {}), evidence = [];
try {
  for (const turn of turns) {
    const started = performance.now();
    let result, error;
    try { result = await host.reply({key, characterId: ids.alex, endUserId, ...turn}); }
    catch (failure) { error = String(failure?.message || failure).slice(0, 200); }
    const diagnostics = (await host.diagnostics()).map(page => page.value).filter(Boolean);
    const wire = diagnostics.map(value => ({emotionEvents: value.wire?.emotionEvents, accepted: value.wire?.acceptedEmotionEvents,
      skipped: value.wire?.skippedEmotionEvents, skipReasons: value.wire?.emotionSkipReasons, lastEmotion: value.wire?.lastEmotion,
      innerTypes: value.wire?.innerTypes, outerTypes: value.wire?.outerTypes, previousTurn: value.previousTurn?.expression}));
    evidence.push({ttsEnabled: turn.ttsEnabled, elapsedMs: Math.round(performance.now() - started), error,
      replyCharacters: result?.text?.length ?? 0, reply: result?.text, expressionSignal: result?.expressionSignal ?? null,
      facesReceived: result?.faces?.length ?? 0, wire});
  }
} finally { await host.close(); }
await writeFile(resolve(root, 'runtime/convai-emotion-probe.json'), JSON.stringify(evidence, null, 2));
console.log(JSON.stringify(evidence.map(({reply, wire, ...rest}) => ({...rest, wire: wire.map(w => ({accepted: w.accepted, skipped: w.skipped,
  skipReasons: w.skipReasons, lastEmotion: w.lastEmotion}))})), null, 1));
