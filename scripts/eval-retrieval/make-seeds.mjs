// Picks which item each eval query is written from (seeded, so the same every run) and which queries are small talk.
//   node scripts/eval-retrieval/make-seeds.mjs   -> data/query-seeds.json
// Per speaker: 2 small talk (no gold), 4 past-conversation (memory), 2 fact, 1 story, 2 quest, 2 place = 13. Four speakers = 52 queries.
import {readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {here} from './lib.mjs';

let state = 20261030;
const random = () => { state = (state * 1664525 + 1013904223) >>> 0; return state / 2 ** 32; };
const pick = (list, count) => { const copy = [...list]; const out = []; while (out.length < count && copy.length) out.push(copy.splice(Math.floor(random() * copy.length), 1)[0]); return out; };

const items = JSON.parse(readFileSync(join(here, 'data/items.json'), 'utf8'));
const SPEAKERS = ['panam-palmer', 'judy-alvarez', 'johnny-silverhand', 'viktor-vektor'];
const PLAN = [['smalltalk', null, 2], ['memory', 'memory', 4], ['fact', 'fact', 2], ['story', 'story', 1], ['quest', 'quest', 2], ['place', 'place', 2]];
const seeds = [];
for (const speaker of SPEAKERS) {
  let n = 0;
  for (const [category, store, count] of PLAN) {
    const candidates = store ? items.filter(item => item.speaker === speaker && item.store === store) : [];
    // a memory query is more interesting when its source is concrete: skip the vague "V is testing me" kind half of the time
    const picks = store ? pick(candidates, count) : Array.from({length: count}, () => null);
    for (const source of picks) seeds.push({qid: `q-${speaker.split('-')[0]}-${String(++n).padStart(2, '0')}`, speaker, category, sourceId: source?.id ?? null, sourceText: source?.text ?? null});
  }
}
writeFileSync(join(here, 'data/query-seeds.json'), JSON.stringify(seeds, null, 1));
console.log(seeds.length, 'seeds');
