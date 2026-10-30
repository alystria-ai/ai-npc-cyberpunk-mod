// Offline check of what Panam is told when a quest invitation or a reach-out V answers reaches her while she stands beside V, and when she is far away. No model, no server, no
// game, no Convai: the prompt is built by the bridge's own builders (the pack runner's note, conversationContextBlocks, relationshipContext, romanceReminder, PersonaBook's
// buildMessages) from a synthetic turn, and the text is checked for the rule the owner asked for (live test 30 Oct): someone standing next to V never says "come over".
//
//   node scripts/Eval-BesideInvite.mjs [--dump <file.json>]      exit code 1 when a cell breaks the rule
//
// To see how a small local model answers these prompts, take the --dump file's messages to scripts/Eval-PartnerTalk.mjs's harness (it starts a llama-server of the Runtime).
import {writeFile} from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import {resolve, dirname} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const imp = name => import(pathToFileURL(resolve(project, 'bridge', name)).href);
const argv = process.argv.slice(2);
const dump = argv.includes('--dump') ? argv[argv.indexOf('--dump') + 1] : null;
const {BondPacks} = await imp('bond-pack-runner.mjs'), {shippedPacks} = await imp('bond-packs.mjs'), {ReachOuts} = await imp('reach-outs.mjs');
const {besideV} = await imp('turn-context.mjs'), {parseJournalHistory} = await imp('journal-history.mjs');
const {PersonaBook, LIMITS, joinBlocks, buildMessages} = await imp('mistral-prompt.mjs');
const {conversationContextBlocks} = await imp('quest-context.mjs'), {relationshipContext, romanceReminder} = await imp('romance-context.mjs');
const {RELATIONSHIP_PROFILES} = await imp('relationship-routing.mjs');

const DAY = 86400;
const roster = [...JSON.parse(readFileSync(resolve(project, 'characters/roster.json'), 'utf8')), ...JSON.parse(readFileSync(resolve(project, 'characters/archetype-roster.json'), 'utf8'))];
const keys = new Set(roster.map(row => row.key));
const book = new PersonaBook(roster);
const pilot = shippedPacks().map(row => row.pack).find(pack => pack.id === 'panam-sunset-coffee');
const rows = [['quests/main_quest/act_01/q104_02_av_chase', 'succeeded'], ['quests/side_quest/sq027_02_raffen_shiv_attack', 'succeeded'], ['ep1/quests/main_quest/q305_reed_epilogue', 'succeeded']];
const coverage = {status: 'complete', ageSeconds: 1, windowSeconds: 30, observed: rows.length, omitted: 0, unstable: false};
const journalHistory = parseJournalHistory({version: 1, status: 'ready', generation: 1, capturedAtMs: 2000, worldToken: 'w1', tracked: {status: 'untracked'}, coverage: {active: coverage, history: coverage},
  quests: rows.map(([path, state], index) => ({id: String(100 + index), nativeId: path.slice(path.lastIndexOf('/') + 1), nativePath: path, title: 'Quest ' + index, state, lane: 'history',
    observedAtMs: 1000, objectivesComplete: true, objectives: []}))});

let counter = 0;
const inputOf = (near, text) => ({requestId: `eval-${++counter}`, profileKey: 'panam-palmer', name: 'Panam', text, entity: 'e1', channel: 'phone', journalHistory,
  turnContext: {version: 1, status: 'ready', hour: 14, minute: 5, gameTime: 30 * DAY, party: [{key: 'panam-palmer', name: 'Panam', activity: 'standing', ...(near ? {near: true} : {})}]},
  bonds: {on: true, copy: 'party', packs: true, invitations: true}});

function cell(kind, near) {
  const input = inputOf(near, kind === 'quest' ? 'hey, what are you up to' : 'hey, got your text');
  const reach = new ReachOuts({files: [{data: {format: 1, character: 'panam-palmer', triggers: [{id: 'pr-eval', via: 'text', text: 'Truck is making a noise. Come hand me things.', partnerText: 'Truck is making a noise. Come hand me things, babe. I just want you around.', after: [{kind: 'bond', level: 3}]}]}}], log() {}});
  const runner = new BondPacks({packs: [pilot], characters: keys, random: () => 0, log() {}, bonds: {award() {}, publish() {}}, debounceMs: 0, path: 'eval.json', write: async () => {}, exists: () => false, reach});
  const facts = {level: 5, romance: 'partner', near: besideV(input)};
  if (kind === 'reach') {
    runner.forTurn(inputOf(near, 'earlier'), facts);
    reach.eligible({enabled: true, gameSeconds: 30 * DAY, journalHistory, levels: {'panam-palmer': 5}, romance: {'panam-palmer': 'partner'}});
    runner.noteReach('pr-eval', 30 * DAY);
  }
  const decision = runner.forTurn(input, facts);
  const selection = {status: 'ready', profileKey: 'panam-palmer', style: 'romantic', saveRelationship: {status: 'confirmed', evidenceRule: RELATIONSHIP_PROFILES['panam-palmer'].rule}};
  const blocks = [{tier: 'world', text: relationshipContext(selection, 'phone')}, {tier: 'volatile', text: decision?.note ?? ''}, {tier: 'closing', text: romanceReminder(selection, 'phone')}];
  const part = tier => joinBlocks(blocks.filter(block => block.tier === tier).map(block => block.text));
  const messages = buildMessages({persona: book.persona('panam-palmer'), history: [], contextParts: {now: '', notes: '', world: part('world'), volatile: part('volatile'), closing: part('closing')}, text: input.text});
  return {kind, near, note: decision?.note ?? '', messages};
}

const results = [];
let failed = 0;
for (const kind of ['quest', 'reach']) for (const near of [true, false]) {
  const result = cell(kind, near), text = result.messages.map(message => message.content).join('\n');
  const checks = {
    'the plan is in the prompt': kind === 'quest' ? /Sunset Motel/.test(text) : /Come hand me things, babe/.test(text),
    'beside V: the beside-V rule is there': near === /come with me|right beside you at this moment/.test(text),
    'the partner tone is there once (closing note)': (text.match(/Tone with V this reply|call V something fond/g) ?? []).length >= 1,
    'far away: nothing says she is beside V': near || !/right beside you at this moment/.test(text),
  };
  for (const [name, ok] of Object.entries(checks)) if (!ok) { failed++; console.log(`FAIL [${kind}, ${near ? 'beside V' : 'far away'}] ${name}`); }
  console.log(`${kind.padEnd(5)} ${near ? 'beside V ' : 'far away '} note ${result.note.length} chars, prompt ${text.length} chars, ${Object.values(checks).every(Boolean) ? 'ok' : 'BROKEN'}`);
  results.push({...result, checks});
}
if (dump) await writeFile(resolve(dump), JSON.stringify(results, null, 1));
process.exit(failed ? 1 : 0);
