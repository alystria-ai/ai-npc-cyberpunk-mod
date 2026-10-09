import {mkdtemp, mkdir, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

// Planted values. None of them may ever appear in a report. They are fakes made
// for the tests; no real credential or player data is read by these tests.
export const PLANTED = Object.freeze({
  hexKey: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',        // looks like a Convai key (32 hex)
  shortKey: 'sk-planted-9Zq4wLm',                      // no pattern gives it away, only the key file does
  hfToken: 'hf_PlantedTokenValue1234567890abcdefgh',
  kaggle: 'KGAT_planted0123456789abcdef',
  userId: '3f2a9c1e-7b44-4d0e-9a52-0c1d2e3f4a5b',
  characterId: '9d8c7b6a-5e4f-4a3b-8c2d-1e0f9a8b7c6d',
  sessionId: 'f0e1d2c3b4a5968778695a4b3c2d1e0f',
  windowsUser: 'PlantedPlayerName',
  chat: 'PLANTED CONVERSATION TEXT about the heist',
  base64: 'QWxhZGRpbjpvcGVuIHNlc2FtZTEyMzQ1Njc4OTBhYmNkZWZnaGlqa2xtbm9w',
});

/** Strings that must not survive the redactor, and strings that must. */
export const VECTORS = [
  {input: 'Authorization: Bearer abcdef1234567890zz', gone: ['abcdef1234567890zz']},
  {input: 'connecting with api-key=sk-live-FAKE_value_123 now', gone: ['FAKE_value_123']},
  {input: '{"api_key":"zzTopSecret99","count":1}', gone: ['zzTopSecret99'], keep: ['"count":1']},
  {input: 'GET /v1/stream?token=abc123def456ghi&room=lobby', gone: ['abc123def456ghi'], keep: ['room=lobby']},
  {input: `secret=${'0123456789abcdef'.repeat(3)}`, gone: ['0123456789abcdef0123456789abcdef']},
  {input: `user ${PLANTED.userId} joined`, gone: [PLANTED.userId], keep: ['[id:', 'joined']},
  {input: `session ${PLANTED.sessionId} opened`, gone: [PLANTED.sessionId]},
  {input: `at C:\\Users\\${PLANTED.windowsUser}\\Desktop\\mod\\x.lua:12`, gone: [PLANTED.windowsUser], keep: ['<user>', 'x.lua:12']},
  {input: `token ${PLANTED.base64} ok`, gone: [PLANTED.base64]},
  {input: 'Conversation result: generation=1 error=false', keep: ['Conversation result: generation=1 error=false']},
  {input: 'Basic information about bin/x64/plugins/cyber_engine_tweaks/mods', keep: ['Basic information about bin/x64/plugins/cyber_engine_tweaks/mods']},
  {input: "Type 'MovePolicies' not found.", keep: ["Type 'MovePolicies' not found."]},
  {input: 'E:\\SteamLibrary\\steamapps\\common\\Cyberpunk 2077\\red4ext\\logs', keep: ['E:\\SteamLibrary\\steamapps\\common\\Cyberpunk 2077\\red4ext\\logs']},
];

/** A game folder, mod folder and state folder under a temp directory. */
export async function fakeInstall(root) {
  const base = root ?? await mkdtemp(join(tmpdir(), 'convai-report-'));
  const game = join(base, 'game'), modRoot = join(game, 'bin', 'x64', 'plugins', 'cyber_engine_tweaks', 'mods', 'CyberpunkConvai');
  const runtime = join(modRoot, 'runtime'), state = join(base, 'project', 'runtime'), project = join(base, 'project');
  const cet = join(game, 'bin', 'x64', 'plugins', 'cyber_engine_tweaks');
  for (const folder of [runtime, state, cet, join(game, 'r6', 'logs'), join(game, 'red4ext', 'logs'),
    join(game, 'red4ext', 'plugins', 'CyberpunkConvaiLauncher')]) await mkdir(folder, {recursive: true});
  const put = (path, text) => writeFile(path, text);
  const files = {base, game, modRoot, runtime, state, project, cet, put};
  files.cleanup = () => rm(base, {recursive: true, force: true});
  return files;
}

export async function plantedInstall() {
  const f = await fakeInstall();
  const user = `C:\\Users\\${PLANTED.windowsUser}\\Desktop\\Code Palace`;
  // Credential files: only the redactor's scrub list may ever see their contents.
  await f.put(join(f.state, 'convai-key.txt'), `api-key=${PLANTED.shortKey}\n`);
  await f.put(join(f.state, 'huggingface-token.txt'), `${PLANTED.hfToken}\n`);
  await f.put(join(f.state, 'kaggle-access-token.txt'), `${PLANTED.kaggle}\n`);
  await f.put(join(f.state, 'bridge.stderr.log'), [
    `[Bridge] starting in ${user}`,
    `Authorization: Bearer ${PLANTED.hexKey}`,
    `request failed: api-key=${PLANTED.shortKey}`,
    `provider rejected key ${PLANTED.shortKey} for character ${PLANTED.characterId}`,
    `session ${PLANTED.sessionId} user ${PLANTED.userId}`,
    ...Array.from({length: 5000}, (_, index) => `routine line ${index}`),
    'Error: provider disconnected', ''].join('\n'));
  await f.put(join(f.state, 'bridge.stdout.log'), '[CyberpunkConvai] Convai conversation bridge ready\n');
  await f.put(join(f.runtime, 'probe.log'), [
    `2026-10-05T10:00:00Z Using key ${PLANTED.shortKey} for the first request`,
    `2026-10-05T10:00:01Z Composer opened: actor=1 name=NC Resident`, ''].join('\n'));
  await f.put(join(f.runtime, 'mcm.log'), '2026-10-05T10:00:00Z Companion Manager registered with MCM API v2\n');
  await f.put(join(f.modRoot, 'CyberpunkConvai.log'), `[2026-10-05 10:00:00] token=${PLANTED.base64}\n`);
  await f.put(join(f.runtime, 'settings.json'), JSON.stringify({version: 2, voiceProvider: 'omni', omniSteps: 32,
    apiKey: PLANTED.shortKey, convaiUserId: PLANTED.userId, note: `uses ${PLANTED.shortKey} and ${PLANTED.hfToken}`,
    enabledByKey: {'bob-sagan': true, 'judy-alvarez': false}, relationshipModes: {'judy-alvarez': 'auto'}, developerMode: true}));
  await f.put(join(f.runtime, 'knowledge-status.json'), JSON.stringify({version: 1, updated: Date.now(), currentWorld: true}));
  await f.put(join(f.runtime, 'bridge-status.json'), JSON.stringify({state: 'ready', detail: PLANTED.userId, updated: Date.now()}));
  await f.put(join(f.runtime, 'local-voice-state.json'), JSON.stringify({version: 1, state: 'ready', provider: 'omni', omniSteps: 32,
    routedProfiles: ['bob-sagan'], profiles: Array.from({length: 40}, (_, i) => `p${i}`), updated: Date.now()}));
  await f.put(join(f.runtime, 'party-connection-state.json'), JSON.stringify({profiles: ['bob-sagan'], ready: 1,
    connections: [{profile: 'bob-sagan', state: 'ready', sessionId: PLANTED.sessionId}]}));
  await f.put(join(f.runtime, 'party-connections.json'), JSON.stringify({updated: Date.now(), profiles: ['bob-sagan']}));
  await f.put(join(f.runtime, 'relationship-routing.json'), JSON.stringify({version: 1, routes: [
    {profileKey: 'judy-alvarez', mode: 'auto', status: 'ready', style: 'ordinary', reason: null}]}));
  // Never part of a report: conversation text, audio, chat history, recordings.
  await f.put(join(f.runtime, 'last-input.json'), JSON.stringify({text: PLANTED.chat}));
  await f.put(join(f.runtime, 'phone-chat-output.json'), JSON.stringify({reply: PLANTED.chat}));
  await f.put(join(f.runtime, 'microphone-capture.wav'), PLANTED.chat);
  await f.put(join(f.runtime, 'chat-history.log'), `${PLANTED.chat}\n`);
  await f.put(join(f.cet, 'cyber_engine_tweaks.log'), [
    '[2026-10-05 10:00:00 UTC+05:30] [info] [Options::Options] [1] CET version v1.99.0 [HEAD]',
    `[2026-10-05 10:00:00 UTC+05:30] [info] [Options::Options] [1] Root path: "${user}\\game"`, ''].join('\n'));
  await f.put(join(f.cet, 'scripting.log'), `[2026-10-05 10:00:01 UTC+05:30] [1] [CyberpunkConvai] error: planted ${PLANTED.shortKey}\n`);
  await f.put(join(f.game, 'r6', 'logs', 'redscript_rCURRENT.log'), '[INFO] Compiling files\n[ERROR] Cannot resolve type\n');
  await f.put(join(f.game, 'red4ext', 'logs', 'red4ext-2026-10-05-10-00-00.log'), [
    '[2026-10-05 10:00:00.000] [info] [1] [RED4ext] RED4ext (v1.30.0) is initializing...',
    '[2026-10-05 10:00:00.001] [info] [1] [RED4ext] Product version: 2.31',
    '[2026-10-05 10:00:00.002] [info] [1] [RED4ext] File version: 3.0.80.51928', ''].join('\n'));
  await f.put(join(f.game, 'red4ext', 'plugins', 'CyberpunkConvaiLauncher', 'launcher.log'), `2026-10-05 10:00:00 Game directory: ${user}\n`);
  await f.put(join(f.modRoot, 'init.lua'), '-- mod\n');
  return f;
}
