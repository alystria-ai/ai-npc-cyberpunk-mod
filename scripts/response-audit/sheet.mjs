// Blind scoring sheets for the judge agents.
//   node scripts/response-audit/sheet.mjs --runs base-m8b,base-local --name base --parts 8 [--seed 7]
// Writes <data>/sheets/<name>/sheet-<k>.md (what a judge reads: items shuffled across runs, no provider, model or run label) and key.json (item -> run, scenario, sample).
// A judge writes <data>/sheets/<name>/scores-<k>.json (a JSON array, see rubric.mjs); aggregate.mjs reads them.
import {readFile, writeFile, mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {SCENARIOS} from './scenarios.mjs';
import {RUBRIC, FLAG_RUBRIC} from './rubric.mjs';
import {dataDir, loadPersonas} from './lib.mjs';

const argv = process.argv.slice(2);
const option = (name, fallback) => { const i = argv.indexOf(`--${name}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback; };
const runs = option('runs', '').split(',').filter(Boolean), name = option('name', 'sheet'), parts = Number(option('parts', 8)), seed = Number(option('seed', 7));
const personas = await loadPersonas();
const roster = Object.fromEntries([...JSON.parse(await readFile(resolve(import.meta.dirname, '../../characters/roster.json'), 'utf8')),
  ...JSON.parse(await readFile(resolve(import.meta.dirname, '../../characters/archetype-roster.json'), 'utf8'))].map(row => [row.key, row]));

const rng = (() => { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; }; })();
const WEATHER = {clear: 'clear sky', cloudy: 'overcast', rain: 'raining', 'heavy-rain': 'pouring rain', fog: 'foggy', smog: 'smog'};
const ACTION_WORDS = {ride: 'V asked her to drive (the game offered a drive to the waypoint).', world: 'V asked her to follow V (the game offered to let her join).', target: 'V asked her to attack a tagged enemy (the game offered the attack).', leave: 'V told her to leave (the game offered to let her go).'};
const hh = (h, m) => `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;

function situation(scn) {
  const p = scn.place ?? {}, bits = [];
  if (scn.phone) bits.push('V is texting her on the phone (she is somewhere else and cannot see V).');
  else if (scn.head) bits.push("The character is Johnny Silverhand's engram in V's head: no body, he goes where V goes, nobody else hears him.");
  else if (scn.ambient) bits.push('The character is an unnamed ordinary person V walked up to (a stranger).');
  else bits.push('The character is with V in person (a companion).');
  if (!scn.phone || p.district) bits.push(`Game time ${hh(p.hour, p.minute)}, ${(p.area ?? p.district ?? '').replace(/^.*_/, '')}${p.district ? `, ${p.district}` : ''}${p.weather ? `, ${WEATHER[p.weather] ?? p.weather}` : ''}${p.indoors ? ', indoors' : ''}.`);
  if (p.health && p.health !== 'healthy') bits.push('V is hurt.');
  if (p.heat) bits.push('V has police heat (the police are after V).');
  if (p.vehicle) bits.push(scn.party?.[0]?.activity === 'passenger' ? 'They are in V\'s car, V driving.' : 'V is in a vehicle.');
  if (scn.first) bits.push('The save shows V and the character have NOT spoken before.');
  if (scn.dialogue) bits.push('Recent lines in the game: ' + scn.dialogue.map(l => `${l.who === 'v' ? 'V' : 'the character/NPC'}: "${l.text}"`).join(' / '));
  if (scn.summary) bits.push(`The character remembers from an earlier talk: ${scn.summary} ${(scn.remembered ?? []).map(r => r.text).join(' ')}`);
  if (scn.quest && !scn.ambient) bits.push(`V's tracked quest: "${scn.quest[0]}" (${scn.quest[1]}).`);
  if (scn.offer) bits.push('ACTION REQUEST: ' + ACTION_WORDS[scn.offer]);
  return bits.join(' ');
}

const items = [];
for (const label of runs) {
  const run = JSON.parse(await readFile(resolve(dataDir, `${label}.json`), 'utf8'));
  for (const r of run.results) {
    if (r.error || !String(r.spoken ?? '').trim()) continue;
    items.push({run: label, id: r.id, sample: r.sample, row: r});
  }
}
for (let i = items.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [items[i], items[j]] = [items[j], items[i]]; }

const out = resolve(dataDir, 'sheets', name);
await mkdir(out, {recursive: true});
const key = {};
const per = Math.ceil(items.length / parts);
for (let k = 0; k < parts; k++) {
  const slice = items.slice(k * per, (k + 1) * per);
  if (!slice.length) continue;
  const lines = [`# Scoring sheet ${k + 1} of ${parts} (${slice.length} items)`, '', 'Apply the rubric you were given to every item below.', ''];
  slice.forEach((it, idx) => {
    const scn = SCENARIOS.find(s => s.id === it.id), row = it.row;
    const itemId = `${k + 1}.${idx + 1}`;
    key[itemId] = {run: it.run, id: it.id, sample: it.sample};
    const persona = personas.persona(scn.char), info = roster[scn.char];
    const who = scn.ambient ? `an unnamed ordinary ${(info?.summary ?? '').split(':')[0].replace(/^Generic /, '').replace(/\s*\((?:male|female)\)/, '')} (${/female/.test(scn.char) ? 'a woman' : 'a man'}), a stranger with no story of their own` : `${persona.name}: ${(info?.summary ?? '').slice(0, 800)}`;
    const earlier = (row.history ?? []).map(t => `  V: ${t.v}\n  ${persona.name || 'Character'}: ${t.r}`).join('\n');
    lines.push(`## ITEM ${itemId}`, `Character: ${who}`, `Situation (from the game): ${situation(scn)}`, ...(earlier ? ['Earlier in this talk:', earlier] : []),
      `V says: ${scn.text}`, `A good reply: ${scn.want}`, `REPLY: ${row.spoken}`, '');
  });
  await writeFile(resolve(out, `sheet-${k + 1}.md`), lines.join('\n'));
}
await writeFile(resolve(out, 'key.json'), JSON.stringify(key, null, 1));
await writeFile(resolve(out, 'rubric.txt'), RUBRIC);
await writeFile(resolve(out, 'flag-rubric.txt'), FLAG_RUBRIC);
console.log(`${items.length} items in ${parts} sheets -> ${out}`);
