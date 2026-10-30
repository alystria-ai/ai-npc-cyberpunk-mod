// With the owner's real saved memories (copied by hand into local/real-memories.json, git-ignored): does the mod's 0.40 cosine cut-off
// let small talk through? Reports the top cosine of a few lines against each character's real memories, granite only (the mod's embedder).
import {join} from 'node:path';
import {localDir, readJson, localEmbedder, dot, unit} from './lib.mjs';
const real = readJson(join(localDir, 'real-memories.json'));
const lines = ['How have you been?', 'Nice weather tonight.', 'What is on your mind?', 'Hey, you got a minute?', 'Do you remember what I told you about my past?', 'You still mad about what I said earlier?'];
const embedder = await localEmbedder('granite');
const qvecs = (await embedder.embed(lines)).map(unit);
for (const [who, data] of Object.entries(real)) {
  const records = data.records ?? [];
  if (!records.length) continue;
  const docs = (await embedder.embed(records.map(r => r.text))).map(unit);
  console.log(who, records.length, 'real memories');
  lines.forEach((line, i) => { const scores = docs.map(d => dot(qvecs[i], d)).sort((a, b) => b - a); console.log('  ', line.padEnd(48), 'top', scores[0].toFixed(3), 'fourth', (scores[3] ?? NaN).toFixed(3), 'above 0.40:', scores.filter(s => s >= 0.4).length, 'of', scores.length); });
}
await embedder.close();
