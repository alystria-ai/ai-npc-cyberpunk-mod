// What would a character's "recent shared events" and "open jobs" sections say
// on this save? Read-only: it never writes the save.
//   node research/cyberpunk/scripts/save_overview.mjs "<save folder or sav.dat>"
//     [--who judy-alvarez] [--query "what did we do last?"] [--full] [--no-types] [--dump snapshots.json]
// The world snapshot comes from save_snapshot.mjs (facts, journal states, entry
// timestamps, game clock). The journal inventory mirrors mod/journal-history.lua
// from the save's journal states plus the cooked journal and its English text;
// --no-types drops the quest-type annotation to exercise the bridge fallback.
import {createReadStream, readFileSync, statSync, writeFileSync} from 'node:fs';
import {createInterface} from 'node:readline';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {murmur3, saveState, snapshotFromSave, loadJournalTypes} from './save_snapshot.mjs';
import {resolveKnowledge} from '../../../bridge/world-knowledge.mjs';
import {conversationContext, withConversationKnowledge} from '../../../bridge/quest-context.mjs';
import {questPathsFromPack} from '../../../bridge/quest-overview.mjs';

const here = dirname(fileURLToPath(import.meta.url)), research = resolve(here, '..'), root = resolve(research, '../..');
const args = process.argv.slice(2);
const option = name => { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1] : undefined; };
let savePath = args.find((a, i) => !a.startsWith('--') && !['--who', '--query', '--pack', '--dump'].includes(args[i - 1]));
if (!savePath) { console.log('usage: save_overview.mjs <save folder|sav.dat> [--who key] [--query text] [--full] [--no-types]'); process.exit(1); }
if (statSync(savePath).isDirectory()) savePath = join(savePath, 'sav.dat');
const who = option('who') || 'judy-alvarez', query = option('query') ?? 'what did we do last?';
const pack = JSON.parse(readFileSync(option('pack') || join(root, 'characters/world-knowledge.json'), 'utf8'));
const catalog = JSON.parse(readFileSync(join(research, 'generated/quest-catalog.json'), 'utf8'));
const state = saveState(savePath), types = await loadJournalTypes();
const male = state.metadata?.bodyGender === 'Male';

// Cooked journal rows for quests, phases and objectives, with their LocKeys.
const cooked = new Map();
for await (const line of createInterface({input: createReadStream(join(research, 'cache/game/index/journal.jsonl'))})) {
  const row = JSON.parse(line);
  if (!['gameJournalQuest', 'gameJournalQuestPhase', 'gameJournalQuestObjective', 'gameJournalQuestSubObjective'].includes(row.type)) continue;
  const key = row.type === 'gameJournalQuest' ? row.fields?.title?.value : row.fields?.description?.value;
  cooked.set(row.path, {path: row.path, id: row.id, type: row.type, questType: row.fields?.type,
    optional: row.fields?.optional === 1, locKey: typeof key === 'string' && key.startsWith('LocKey#') ? key.slice(7) : null});
}
const needed = new Set([...cooked.values()].map(row => row.locKey).filter(Boolean)), text = new Map();
for await (const line of createInterface({input: createReadStream(join(research, 'cache/game/localization/index/entries.jsonl'))})) {
  const id = /"id":"(\d+)"/.exec(line)?.[1];
  if (!id || !needed.has(id) || text.has(id) || !line.includes('"onscreen.primaryKey"')) continue;
  const row = JSON.parse(line), value = male && row.maleVariant ? row.maleVariant : row.femaleVariant;
  if (value) text.set(id, value.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim());
}

const STATE = {2: 'active', 3: 'succeeded', 4: 'failed'};
const stateOf = path => STATE[state.journal.get(murmur3(path))];
const children = new Map();
for (const row of cooked.values()) {
  const parent = row.path.slice(0, row.path.lastIndexOf('/'));
  if (!children.has(parent)) children.set(parent, []);
  children.get(parent).push(row);
}
const nowMs = Date.now(), quests = [];
for (const quest of cooked.values()) {
  if (quest.type !== 'gameJournalQuest' || !stateOf(quest.path) || !text.get(quest.locKey)) continue;
  const objectives = [];
  const visit = (node, relative) => {
    for (const child of children.get(node.path) ?? []) {
      const status = stateOf(child.path);
      if (!status) continue; // inactive or absent: the Lua filter never returns it
      const path = [...relative, child.id];
      if (child.type !== 'gameJournalQuestPhase' && text.get(child.locKey)) {
        objectives.push({id: String(murmur3(child.path)), nativeId: child.id, questRelativePath: path,
          text: text.get(child.locKey), state: status, observedAtMs: nowMs, ...(child.optional ? {optional: true} : {})});
      }
      visit(child, path);
    }
  };
  visit(quest, [quest.id]);
  const status = stateOf(quest.path), seconds = state.journalTimes.get(murmur3(quest.path))?.seconds;
  quests.push({id: String(murmur3(quest.path)), nativeId: quest.id, nativePath: quest.path, title: text.get(quest.locKey),
    state: status, lane: status === 'active' ? 'active' : 'history', observedAtMs: nowMs, objectivesComplete: true,
    objectives: objectives.slice(0, 128), ...(args.includes('--no-types') ? {} : {questType: quest.questType}),
    ...(Number.isSafeInteger(seconds) ? {gameTimeSeconds: seconds} : {})});
}
const trackedPath = state.metadata?.trackedQuestEntry;
const trackedQuest = trackedPath && quests.find(row => trackedPath.startsWith(row.nativePath + '/'));
const lane = count => ({status: 'complete', ageSeconds: 0, windowSeconds: 0, observed: count, omitted: 0, unstable: false, total: count});
const history = {version: 1, status: 'ready', generation: 1, worldToken: 'offline-save', capturedAtMs: nowMs,
  tracked: trackedQuest ? {status: 'known', questId: trackedQuest.id, objectiveId: String(murmur3(trackedPath))} : {status: 'untracked'},
  coverage: {active: lane(quests.filter(row => row.lane === 'active').length), history: lane(quests.filter(row => row.lane === 'history').length)},
  quests};

const world = snapshotFromSave(state, pack, types, {profileKeys: [who]});
// The two rebuilt captures, for other offline tools (a text probe, a comparison).
if (option('dump')) writeFileSync(option('dump'), JSON.stringify({world, history}));
const projection = resolveKnowledge({pack, snapshot: world, profileKey: who, query, maxChars: 8000});
const input = withConversationKnowledge({profileKey: who, text: query, worldKnowledge: world, journalHistory: history},
  {knowledgeContext: projection.context, generation: 1, worldToken: 'offline-save', questCatalog: catalog,
    now: Date.parse(world.capturedAt), sharedEvents: projection.shared, questPaths: questPathsFromPack(pack)});
const context = conversationContext(input);
const day = value => `day ${Math.floor(value / 86400)} ${String(Math.floor(value % 86400 / 3600)).padStart(2, '0')}:${String(Math.floor(value % 3600 / 60)).padStart(2, '0')}`;
console.log(`save ${savePath}\ngame clock ${Number.isSafeInteger(state.gameTimeSeconds) ? day(state.gameTimeSeconds) : 'unknown'}; `
  + `journal quests ${quests.length} (${history.coverage.active.observed} active); shared events ${projection.shared?.length ?? 0} for ${who}`);
const sections = context.split('\n\n');
const pick = prefix => sections.find(section => section.startsWith(prefix)) ?? '(absent)';
console.log('\n--- recent shared events ---\n' + (sections.find(s => /^(Your most recent shared events|No reviewed quest event|Your shared quest events)/.test(s)) ?? '(absent)'));
console.log('\n--- open jobs ---\n' + pick("V's open jobs"));
if (args.includes('--full')) console.log(`\n--- full context (${context.length} chars) ---\n${context}`);
else console.log(`\nfull context: ${context.length} characters`);
