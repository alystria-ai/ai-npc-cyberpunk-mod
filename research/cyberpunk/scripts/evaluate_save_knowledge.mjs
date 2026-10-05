// What would each character be told from this save? Read-only.
//   node research/cyberpunk/scripts/evaluate_save_knowledge.mjs "<save folder or sav.dat>"
//     [--who judy-alvarez,panam-palmer] [--query "what happened with Evelyn"] [--verbose] [--pack path]
import {readFileSync, statSync} from 'node:fs';
import {join, resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {saveState, snapshotFromSave, loadJournalTypes} from './save_snapshot.mjs';
import {resolveKnowledge} from '../../../bridge/world-knowledge.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const args = process.argv.slice(2);
const option = name => { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1] : undefined; };
let savePath = args.find(a => !a.startsWith('--') && !args[args.indexOf(a) - 1]?.startsWith('--'));
if (!savePath) { console.log('usage: evaluate_save_knowledge.mjs <save folder|sav.dat> [--who keys] [--query text] [--verbose]'); process.exit(1); }
if (statSync(savePath).isDirectory()) savePath = join(savePath, 'sav.dat');
const pack = JSON.parse(readFileSync(option('pack') || join(root, 'characters/world-knowledge.json'), 'utf8'));
const who = (option('who') || 'johnny-silverhand,panam-palmer,judy-alvarez,jackie-welles,solomon-reed,songbird,takemura,rogue-amendiares').split(',');
const state = saveState(savePath), types = await loadJournalTypes();
const base = snapshotFromSave(state, pack, types, {profileKeys: [who[0]]});
const known = rows => Object.values(rows).filter(row => row.status === 'known').length;
console.log(`save ${savePath}\nfacts ${known(base.facts)}/${Object.keys(base.facts).length} known, journal ${known(base.journal)}/${Object.keys(base.journal).length} known, lifepath ${base.lifepath.value ?? 'unknown'}`);
const rows = [];
for (const key of who) {
  const snapshot = {...base, audience: {channel: 'private', profileKeys: [key]}};
  const result = resolveKnowledge({pack, snapshot, profileKey: key, query: option('query') || '', maxChars: 8000});
  const facts = result.context ? JSON.parse(result.context.slice(result.context.indexOf('{'))).facts ?? [] : [];
  const c = result.diagnostics.counts;
  rows.push({character: key, status: result.diagnostics.status, rulesTrue: c.true, allowed: c.true - c.outsideAudience - c.conflicted,
    selected: c.selected, omittedForBudget: c.omitted, contextChars: result.diagnostics.contextChars});
  if (args.includes('--verbose')) { console.log(`\n${key}:`); for (const f of facts) console.log(`  - [${f.questKey}] ${f.text}`); }
}
console.table(rows);
