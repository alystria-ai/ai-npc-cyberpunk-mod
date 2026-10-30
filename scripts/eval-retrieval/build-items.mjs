// Builds the retrieval eval's item pool from the repo's own data (no network, no keys).
//   node scripts/eval-retrieval/build-items.mjs
// Writes scripts/eval-retrieval/data/items.json: [{id, store, speaker, text}]
//   fact   one world-knowledge rule statement of the speaker (characters/world-knowledge.json), conditions ignored
//   story  one main story knowledge line (bridge/story-knowledge-data.mjs)
//   quest  one quest briefing (title, overview, people, places) the speaker gave or knows (bridge/quest-briefing-data.mjs)
//   place  one named place of Night City (bridge/named-places-data.mjs), shared by every speaker
//   memory the synthetic long-term memories (data/memories.json, written separately), merged in by speaker
import {readFileSync, writeFileSync, existsSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
export const SPEAKERS = ['panam-palmer', 'judy-alvarez', 'johnny-silverhand', 'viktor-vektor'];

const {STORY_KNOWLEDGE} = await import(pathToFileURL(join(root, 'bridge/story-knowledge-data.mjs')));
const {QUEST_BRIEFINGS} = await import(pathToFileURL(join(root, 'bridge/quest-briefing-data.mjs')));
const {NAMED_PLACES} = await import(pathToFileURL(join(root, 'bridge/named-places-data.mjs')));
const world = JSON.parse(readFileSync(join(root, 'characters/world-knowledge.json'), 'utf8'));

const items = [];
for (const speaker of SPEAKERS) {
  const short = speaker.split('-')[0];
  for (const rule of world.rules) {
    if (!(rule.audience?.speakers || []).includes(speaker)) continue;
    items.push({id: `fact-${short}-${rule.id}`, store: 'fact', speaker, text: rule.statement});
  }
  for (const row of STORY_KNOWLEDGE) {
    if (row.character !== speaker || row.verified !== true || !row.line) continue;
    items.push({id: `story-${short}-${row.topic}`, store: 'story', speaker, text: row.line});
  }
  for (const [path, brief] of Object.entries(QUEST_BRIEFINGS)) {
    if (![...(brief.givers || []), ...(brief.knowers || [])].includes(speaker)) continue;
    const slug = path.split('/').pop();
    // One item per quest: the mod picks the stage from the journal, so retrieval only has to find the right job.
    const people = [...new Set((brief.stages || []).flatMap(stage => stage.people || []))];
    const places = [...new Set((brief.stages || []).flatMap(stage => stage.places || []))];
    const text = `${brief.title}. ${brief.overview}${people.length ? ' People: ' + people.join(', ') + '.' : ''}${places.length ? ' Places: ' + places.join(', ') + '.' : ''}`;
    items.push({id: `quest-${short}-${slug}`, store: 'quest', speaker, text});
  }
  for (const place of NAMED_PLACES) items.push({id: `place-${place.id}-${short}`, store: 'place', speaker, text: place.phrase});
}
const memoriesFile = join(here, 'data/memories.json');
if (existsSync(memoriesFile))
  for (const memory of JSON.parse(readFileSync(memoriesFile, 'utf8')))
    items.push({id: memory.id, store: 'memory', speaker: memory.speaker, text: memory.text, kind: memory.kind, importance: memory.importance});
const ids = new Set(items.map(item => item.id));
if (ids.size !== items.length) throw new Error('duplicate item ids');
writeFileSync(join(here, 'data/items.json'), JSON.stringify(items, null, 1));
const count = {};
for (const item of items) count[`${item.speaker}/${item.store}`] = (count[`${item.speaker}/${item.store}`] || 0) + 1;
console.log(count);
