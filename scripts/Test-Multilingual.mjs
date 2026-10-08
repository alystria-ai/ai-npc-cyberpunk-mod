// End-to-end check of Multilingual conversations without the game, through the bridge's own modules.
//
//   node scripts/Test-Multilingual.mjs <out-folder> [--render]
//
//   routing  RelationshipRouting with the twin map and the setting on or off, ordinary and romantic: provider key and
//            Convai character ID of Judy's turn
//   context  the blocks conversationContext() builds (relationship guidance, Natural speech and Expressive emotions
//            notes for OmniVoice, the reply-language block)
//   text     RealtimeHost.reply, the bridge's realtime client page, with a throwaway end-user ID; the reply language is
//            checked with bridge/reply-language.mjs (on: the message's language; off: English)
//   voice    --render: the OmniVoice worker renders Judy's lines in es/ja/de/en with the language (needs the Omni pack
//            and a free GPU model slot, so not while the game's bridge runs Omni); without it the clips already in
//            <out-folder> (omni-judy-<lang>.wav) are used
//   mic      each clip, padded with silence, is fed as the microphone (Chromium fake capture) through
//            RealtimeHost.beginVoice/finishVoice, the Convai STT path the mod uses: the transcription shows the audio's
//            language and that the STT keeps it
// The throwaway user's memories are cleared afterwards. The key is never printed. Exit code 1 when a check fails.
import {readFile, writeFile, mkdir} from 'node:fs/promises';
import {resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {chromium} from 'playwright';
import {RealtimeHost} from '../bridge/realtime-host.mjs';
import {MultilingualConversations, multilingualTwins} from '../bridge/multilingual.mjs';
import {detectLanguage} from '../bridge/reply-language.mjs';
import {RelationshipRouting, relationshipContext} from '../bridge/relationship-routing.mjs';
import {NaturalSpeech} from '../bridge/natural-speech.mjs';
import {ExpressiveEmotions} from '../bridge/expressive-emotions.mjs';
import {PlayerMemoryApi} from '../bridge/player-memory-api.mjs';
import {ResidentVoice} from '../bridge/resident-voice.mjs';
import {resolveVoiceConfigPaths} from '../bridge/voice-config-paths.mjs';
import {inspectWav} from '../bridge/speech-audio.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(process.argv[2] || resolve(root, 'runtime/multilingual-check'));
const render = process.argv.includes('--render');
await mkdir(out, {recursive: true});
const read = async name => JSON.parse(await readFile(resolve(root, 'runtime', name), 'utf8'));
const key = /^api-key\s*=\s*(\S+)\s*$/i.exec((await readFile(resolve(root, 'runtime/convai-key.txt'), 'utf8')).trim())?.[1];
if (!key) throw Error('runtime/convai-key.txt has no key');
const ids = await read('characters.json'), variants = await read('relationship-profiles.json');
const {twins} = multilingualTwins(await read('multilingual-profiles.json'), {ordinaryIds: ids, variants});
const registry = new RelationshipRouting({ordinaryIds: ids, variants, multilingual: twins});

const boundary = {worldToken: 'multilingual-check', generation: 1};
function route(multilingual, mode) {
  const routes = new RelationshipRouting({ordinaryIds: ids, variants, multilingual: twins});
  routes.update({multilingualConversations: multilingual, relationshipModes: {'judy-alvarez': mode}}, undefined, {boundary});
  return routes.select('judy-alvarez', boundary);
}
const speech = new NaturalSpeech(), emotions = new ExpressiveEmotions();
speech.update({naturalSpeech: true}); emotions.update({expressiveEmotions: true});
function context(selection, text, multilingual) {
  const setting = new MultilingualConversations(); setting.update({multilingualConversations: multilingual});
  return ['Current situation: V is standing with Judy in her apartment in Kabuki, Night City. It is evening.',
    relationshipContext(selection, 'private'), speech.contextFor({engine: 'omni', random: () => 0}),
    emotions.contextFor({engine: 'omni'}), setting.contextFor(text)].filter(Boolean).join('\n\n');
}
const cleanup = [], failures = [];
const check = (ok, what) => { if (!ok) failures.push(what); return ok ? 'pass' : 'FAIL'; };

// ---- Text ----
const messages = [['es', '¿Qué tal, Judy? ¿Qué vas a hacer esta noche?'], ['ja', 'こんにちは、ジュディ。今夜は何をする予定？'],
  ['de', 'Hallo Judy, wie geht es dir heute Abend?']];
const textRows = [];
const host = new RealtimeHost();
try {
  for (const [name, multilingual, mode] of [['on, ordinary', true, 'off'], ['on, romantic', true, 'on'],
    ['off, ordinary', false, 'off'], ['off, romantic', false, 'on']]) {
    const selection = route(multilingual, mode);
    for (const [language, text] of messages) {
      const endUserId = randomUUID();
      cleanup.push({profileKey: selection.providerProfileKey, characterId: selection.characterId, endUserId});
      const result = await host.reply({key, characterId: selection.characterId, endUserId, ttsEnabled: false, text,
        scope: 'check:' + language, context: context(selection, text, multilingual)});
      const reply = speech.process(result).text, replyLanguage = detectLanguage(reply).language;
      const expected = multilingual ? language : 'en';
      textRows.push({case: name, character: selection.providerProfileKey, characterId: selection.characterId, sent: language,
        replyLanguage, result: check(replyLanguage === expected, `${name} ${language}`), reply});
      console.log(JSON.stringify(textRows.at(-1)));
    }
  }
} finally { await host.close(); }

// ---- Voice ----
const lines = {es: 'Probablemente me quede encerrada en el taller peleándome con un par de pistas de audio.',
  ja: 'またワークショップにこもって、編集作業に時間を溶かすと思う。', de: 'Ich sitze wahrscheinlich in der Werkstatt und kämpfe mit ein paar Tonspuren.',
  en: 'I will probably be stuck in the workshop fighting a couple of audio tracks.'};
if (render) {
  const paths = resolveVoiceConfigPaths(resolve(root, 'runtime'));
  const omni = new ResidentVoice(JSON.parse(await readFile(paths.omni.short, 'utf8')), {project: root, configPath: paths.omni.short});
  try {
    await omni.start();
    for (const [language, text] of Object.entries(lines)) {
      const result = await omni.synthesize('judy-alvarez', text, {steps: 16, language});
      await writeFile(resolve(out, `omni-judy-${language}.wav`), Buffer.from(result.audio, 'base64'));
    }
  } finally { await omni.close(); }
}

// ---- Microphone ----
const LEAD = 2.5;
async function padded(language) {
  const bytes = await readFile(resolve(out, `omni-judy-${language}.wav`));
  const header = Buffer.from(bytes.subarray(0, 44)), data = bytes.subarray(44), rate = header.readUInt32LE(24);
  const total = Buffer.concat([Buffer.alloc(Math.round(rate * LEAD) * 2), data, Buffer.alloc(rate * 2 * 2)]);
  header.writeUInt32LE(36 + total.length, 4); header.writeUInt32LE(total.length, 40);
  const path = resolve(out, `mic-${language}.wav`);
  await writeFile(path, Buffer.concat([header, total]));
  return {path, seconds: inspectWav(bytes).duration};
}
const micRows = [];
for (const [name, multilingual, language] of [['on', true, 'es'], ['on', true, 'ja'], ['on', true, 'de'], ['on', true, 'en'],
  ['off', false, 'es']]) {
  const selection = route(multilingual, 'off'), endUserId = randomUUID(), clip = await padded(language);
  cleanup.push({profileKey: selection.providerProfileKey, characterId: selection.characterId, endUserId});
  const micHost = new RealtimeHost({launchBrowser: options => chromium.launch({...options,
    args: [...(options.args || []), '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
      `--use-file-for-fake-audio-capture=${clip.path.split(String.fromCharCode(92)).join('/')}%noloop`]})});
  const channel = micHost.voiceChannel();
  try {
    const config = {key, characterId: selection.characterId, endUserId, ttsEnabled: false, scope: 'check:mic',
      context: context(selection, '', multilingual)};
    await channel.beginVoice(config);
    await new Promise(done => setTimeout(done, Math.ceil(clip.seconds * 1000) + (LEAD + 6) * 1000));
    const result = await channel.finishVoice(config);
    const reply = speech.process(result).text, heard = detectLanguage(result.userText).language;
    micRows.push({case: name, character: selection.providerProfileKey, clip: language, transcription: result.userText,
      transcriptionLanguage: heard, replyLanguage: detectLanguage(reply).language,
      result: check(heard === language && detectLanguage(reply).language === (multilingual ? language : 'en'), `mic ${name} ${language}`),
      reply});
  } catch (error) { micRows.push({case: name, clip: language, result: check(false, `mic ${name} ${language}`), error: error.message}); }
  finally { console.log(JSON.stringify(micRows.at(-1))); await channel.close().catch(() => {}); await micHost.close(); }
}

const memory = new PlayerMemoryApi({key, characterIds: registry.providerIds, markerKeys: registry.markerKeys});
let cleared = 0;
// HTTP 404: the provider stored nothing for that throwaway user, so there is nothing to clear.
for (const pair of cleanup) await memory.clearMemory(pair).then(() => cleared++, error => { if (error.status === 404) cleared++; });
await writeFile(resolve(out, 'multilingual-check.json'), JSON.stringify({text: textRows, mic: micRows,
  cleanup: `${cleared}/${cleanup.length}`, failures}, null, 2));
console.log(JSON.stringify({cleanup: `${cleared}/${cleanup.length}`, failures}));
process.exitCode = failures.length ? 1 : 0;
