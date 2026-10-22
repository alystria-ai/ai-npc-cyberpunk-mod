#!/usr/bin/env node
// Offline end-to-end check of an installed Pocket language model, with the INSTALLED bridge code (nothing in the install is written).
//
//   <installed node.exe> scripts/Check-InstalledPocketLanguage.mjs [--lang fr] [--out <folder>]
//
// Needs: the game closed (refused while Cyberpunk2077.exe runs); the Pocket model zip and the voice pack of the language installed; the installed Pocket student.
// Does: scans the pack and the model with the installed modules; plans a French reply on Pocket the way the bridge does; starts the installed Pocket worker (its work folder
// is a private one under --out, so the install's state stays untouched), swaps the language model in, renders a French reply from the pack clip of Panam, renders it again
// (no swap), renders an English reply (swap back) and a French one again; prints the routing line the installed bridge writes for that reply, the timings, and writes the WAV files.
import {spawnSync} from 'node:child_process';
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const PLUGIN = 'E:/SteamLibrary/steamapps/common/Cyberpunk 2077/red4ext/plugins/AiNpcCyberpunkMod';
const APP = `${PLUGIN}/app`, VOICES = `${PLUGIN}/voices`;
const STATE = `${process.env.LOCALAPPDATA}/AiNpcCyberpunkMod/data`;
const args = process.argv.slice(2), option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const lang = option('--lang', 'fr'), out = resolve(option('--out', 'pocket-language-check'));
const tasks = spawnSync('tasklist', ['/FI', 'IMAGENAME eq Cyberpunk2077.exe'], {encoding: 'utf8'}).stdout ?? '';
if (/Cyberpunk2077\.exe/i.test(tasks)) { console.error('The game is running: this check needs it closed.'); process.exit(2); }
mkdirSync(`${out}/work`, {recursive: true});
for (const name of ['NODE_OPTIONS', 'NODE_PATH', 'PYTHONPATH', 'PYTHONHOME', 'PYTHONSTARTUP', 'PYTHONUSERBASE']) delete process.env[name];
const imp = name => import(pathToFileURL(`${APP}/bridge/${name}`).href);
const readJson = path => JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
const SENTENCE = {fr: 'Salut, ça fait longtemps. Night City est calme ce soir, allons boire un verre. Où veux-tu aller en premier ?'};
const text = SENTENCE[lang];
const result = {started: new Date().toISOString(), language: lang, installedVersion: readJson(`${APP}/release.json`).version, steps: []};
const log = (step, value) => { result.steps.push({step, ...value}); console.log(step, JSON.stringify(value)); };

const {VoiceLanguagePacks, LANGUAGE_PACKS} = await imp('voice-language-packs.mjs');
const {PocketLanguageModels, PocketLanguageNotice, POCKET_LANGUAGES} = await imp('pocket-language-models.mjs');
const {planTurnVoice, replyVoice} = await imp('multilingual.mjs');
const {describeVoiceRoute, formatVoiceRoute} = await imp('voice-routing-log.mjs');
const {VoiceSelection} = await imp('voice-selection.mjs');
const tag = LANGUAGE_PACKS[lang];
const packs = new VoiceLanguagePacks({roots: [VOICES], log: line => console.log('[packs] ' + line)});
await packs.scan();
const voiceConfig = readJson(`${STATE}/addons.pocket-voices.autobest.json`);
const models = new PocketLanguageModels({roots: [voiceConfig.runtime.referenceDirectory], packs, log: line => console.log('[models] ' + line)});
const report = await models.scan();
log('scan', {packs: packs.report().packs.map(pack => pack.language), models: report.models, problems: report.problems, speaks: models.speaks(tag), entry: models.entry(tag, 'panam-palmer')?.set ?? null});
if (!models.speaks(tag)) { console.error(`Pocket cannot speak ${lang}: model and voice pack must both be installed and valid.`); process.exit(3); }

// The worker's own work folder is private; its configuration is the installed one with that folder.
const runtimeConfig = {...voiceConfig, runtime: {...voiceConfig.runtime, workDirectory: `${out}/work`}, preparation: {...voiceConfig.preparation, startupProfiles: []}};
const configPath = `${out}/pocket-voices.json`;
writeFileSync(configPath, JSON.stringify(runtimeConfig));
const omniConfigs = {short: readJson(`${STATE}/addons.local-voices.autobest-short.json`), long: readJson(`${STATE}/addons.local-voices.autobest-long.json`)};
const voice = new VoiceSelection(runtimeConfig, {project: APP, configPath, pythonExecutable: runtimeConfig.runtime.pythonExecutable, omniConfigs,
  omniConfigPaths: {short: `${STATE}/addons.local-voices.autobest-short.json`, long: `${STATE}/addons.local-voices.autobest-long.json`}, previewSettleMs: 0,
  languagePacks: packs, pocketLanguages: models, omniPack: () => ({installed: false, missing: []}), profileKeys: [],
  onLog: line => { if (/error|fail|refused|language/i.test(line)) console.log('[LocalVoice] ' + line.trim().slice(0, 200)); }});
voice.update({voiceProvider: 'pocket'}, null, false);
let began = performance.now();
await voice.start();
log('start', {provider: voice.provider, ms: Math.round(performance.now() - began)});

// What the bridge decides for a reply in French on Pocket (bridge/convai-bridge.mjs localChoice, turnVoice, synthesizeReplyBody).
const key = 'panam-palmer';
const local = {uses: voice.usesProfile(key) && !voice.cloudKeyless, provider: voice.provider, convai: voice.convaiVoiceAllowed, cloud: voice.cloudActive ? voice.cloud : null,
  speaks: () => false, pocket: {speaks: language => models.speaks(language), packMissing: language => models.packMissing(language)}};
const plan = planTurnVoice({textProvider: true, language: tag, local}), reply = replyVoice({plan, text, local});
log('plan', {plan, reply});
if (reply.engine !== 'pocket') { console.error('The reply would not be spoken by Pocket.'); process.exit(4); }

const wav = (name, chunks) => {
  const pcm = Buffer.concat(chunks.map(chunk => Buffer.from(Int16Array.from(chunk, value => Math.max(-32768, Math.min(32767, Math.round(value * 32767)))).buffer)));
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVEfmt ', 8); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22); header.writeUInt32LE(24000, 24); header.writeUInt32LE(48000, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
  writeFileSync(`${out}/${name}.wav`, Buffer.concat([header, pcm]));
  return pcm.length / 2 / 24000;
};
async function speak(name, spokenText, language) {
  const chunks = [];
  began = performance.now();
  let first = null;
  const response = await voice.synthesizeStream(key, spokenText, {language, onPcm: packet => { first ??= performance.now() - began; chunks.push(packet.pcm); }});
  const seconds = wav(name, chunks);
  log(name, {firstAudioMs: Math.round(first), totalMs: Math.round(performance.now() - began), audioS: +seconds.toFixed(2), modelSha256: response.modelSha256?.slice(0, 12), language: response.language ?? null});
}

began = performance.now();
const warmed = await voice.warmPocketLanguage(key, tag);
log('warm', {ms: Math.round(performance.now() - began), receipt: warmed});
await speak('fr-1-after-warm', text, tag);
await speak('fr-2-resident', text, tag);
await speak('en-after-fr', 'Night City is quiet tonight, let us go for a drink.', undefined);
await speak('fr-3-after-english', text, tag);

// The routing line of that reply (bridge/convai-bridge.mjs logVoiceRoute composes the same facts).
const entry = packs.entry(tag, key);
const record = describeVoiceRoute({voice, input: {profileKey: key}, profile: {key, name: 'Panam Palmer'}, plan, reply, voiceKey: key, sources: {pocket: voiceConfig, omni: omniConfigs},
  languageSet: entry.set, pocketModel: {language: lang}});
const line = formatVoiceRoute(record);
console.log('ROUTING', line);
result.routing = line;

// The model without its voice pack: the bridge shows text and says so once.
const without = new PocketLanguageModels({roots: [voiceConfig.runtime.referenceDirectory], packs: {pack: () => null}});
await without.scan();
const noPack = {...local, pocket: {speaks: language => without.speaks(language), packMissing: language => without.packMissing(language)}};
const noPackReply = replyVoice({plan: planTurnVoice({textProvider: true, language: tag, local: noPack}), text, local: noPack});
const notice = new PocketLanguageNotice();
notice.note(noPackReply.language); notice.note(noPackReply.language);
log('model-without-pack', {reply: noPackReply, notice: notice.take(), second: notice.take() ?? null});

await voice.close();
result.finished = new Date().toISOString();
writeFileSync(`${out}/result.json`, JSON.stringify(result, null, 1));
console.log('done', out);
