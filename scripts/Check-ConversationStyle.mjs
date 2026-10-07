// Bounded text-only provider check. No in-game input, voice, profile writes,
// player memory writes, new end-user IDs, or synthetic game conversation turns.
// Reuses the earlier prompting experiment's synthetic identity in fresh sessions.
import {readFile, writeFile, mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {RealtimeHost} from '../bridge/realtime-host.mjs';
import {conversationContext} from '../bridge/quest-context.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
const run = args.includes('--run');
const phases = ['--before', '--after', '--exceptions'];
const phase = (phases.find(value => args.includes(value)) || '--after').slice(2);
if (args.some(value => !['--run', ...phases].includes(value))
    || phases.filter(value => args.includes(value)).length > 1) throw Error('Use [--run] [--before|--after|--exceptions].');
const normal = 'Tell me one thing you like about Night City.';
const rows = phase === 'before' ? [
  {profileKey: '8ug8ear', mode: 'on', text: normal},
  {profileKey: '8ug8ear', mode: 'on-company', text: 'I am thinking of taking a walk around the neighborhood.'},
] : phase === 'exceptions' ? [
  {profileKey: '8ug8ear', mode: 'goodbye', text: 'I need to go now. Talk later.'},
  {profileKey: '8ug8ear', mode: 'goodbye-short', text: 'See you later. Bye.'},
  {profileKey: '8ug8ear', mode: 'no-question', text: 'Tell me one thing you like about Night City. No questions back, please.'},
  {profileKey: '8ug8ear', mode: 'on', text: normal},
] : [
  ...['8ug8ear', 'judy-alvarez', 'johnny-silverhand'].flatMap(profileKey => [
    {profileKey, mode: 'on', text: normal},
  ]),
  {profileKey: '8ug8ear', mode: 'group-first', text: normal,
    group: {id: 'style-check', index: 1, total: 2, audience: ['8ug8ear', 'judy-alvarez'], heard: []}},
  {profileKey: '8ug8ear', mode: 'group-last', text: normal,
    group: {id: 'style-check', index: 2, total: 2, audience: ['judy-alvarez', '8ug8ear'], heard: []}},
  {profileKey: '8ug8ear', mode: 'goodbye', text: 'I need to go now. Talk later.'},
  {profileKey: '8ug8ear', mode: 'no-question', text: 'Tell me one thing you like about Night City. No questions back, please.'},
];
if (!run) {
  console.log(JSON.stringify({phase, turns: rows.length, profiles: [...new Set(rows.map(x => x.profileKey))],
    voice: false, identity: 'reuse existing research identity, never the player', profileWrites: false}));
  process.exit(0);
}
const read = async name => JSON.parse((await readFile(resolve(root, name), 'utf8')).replace(/^\uFEFF/, ''));
const receipt = await read('research/cyberpunk/dialogue-style/.private/receipt.json');
const endUserId = receipt.benchmarkEndUserId;
const player = await read('runtime/player-memory.json');
if (!receipt.completed || typeof endUserId !== 'string' || !endUserId
    || endUserId === player.endUserId) throw Error('An existing isolated research identity is required.');
const key = /^api-key\s*=\s*(\S+)\s*$/i.exec((await readFile(resolve(root, 'runtime/convai-key.txt'), 'utf8')).trim())?.[1];
if (!key) throw Error('Local key is missing.');
const ids = await read('runtime/characters.json');
const roster = await read('characters/roster.json');
if (rows.some(row => !ids[row.profileKey])) throw Error('Requested profile is not configured.');
const report = {phase, started: new Date().toISOString(), voice: false, reusedResearchIdentity: true,
  playerIdentityUsed: false, freshSessionPerTurn: true, profileWrites: false, rows: []};
const folder = resolve(root, 'runtime/conversation-style-check');
await mkdir(folder, {recursive: true});
const destination = resolve(folder, `${phase}-${report.started.replace(/[:.]/g, '-')}.json`);
const save = () => writeFile(destination, JSON.stringify(report, null, 2) + '\n');
await save();
const host = new RealtimeHost();
try {
  for (const input of rows) {
    const profile = roster.find(p => p.key === input.profileKey);
    const context = conversationContext(input);
    const started = performance.now();
    const result = await host.reply({key, characterId: ids[input.profileKey], endUserId, sessionId: '-1',
      scope: 'conversation-style-check', ttsEnabled: false, text: input.text, context}, {discard: true});
    const aliases = [profile.name, ...(profile.aliases || [])];
    const escaped = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const prefix = new RegExp('^\\s*(?:\\*\\*)?(?:' + aliases.map(escaped).join('|') + ')\\s*(?:\\*\\*)?\\s*:', 'i');
    const row = {...input, context, reply: result.text, elapsedMs: performance.now() - started,
      hasQuestionMark: /[?？]/.test(result.text), hasSpeakerPrefix: prefix.test(result.text),
      localProfileHash: createHash('sha256').update(JSON.stringify([profile.backstory,
        profile.speakingStyleDescription, profile.speakingStyleSampleDialogues])).digest('hex')};
    report.rows.push(row); await save();
    console.log(JSON.stringify({profile: row.profileKey, mode: row.mode, question: row.hasQuestionMark,
      speakerPrefix: row.hasSpeakerPrefix, elapsedMs: Math.round(row.elapsedMs)}));
  }
  report.completed = true;
} catch (error) {
  report.completed = false;
  report.error = [key, endUserId, ...Object.values(ids)].reduce((text, secret) => text.split(secret).join('[redacted]'),
    String(error.message)).slice(0, 1000);
  process.exitCode = 1;
} finally {
  await host.close(); report.finished = new Date().toISOString(); await save();
  console.log(JSON.stringify({completed: report.completed, turns: report.rows.length, report: destination}));
}
