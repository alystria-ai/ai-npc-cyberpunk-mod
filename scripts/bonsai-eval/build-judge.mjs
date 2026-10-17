// Builds the blinded judging batches from results/step1/*.json (stable-layout runs only).
//   node build-judge.mjs   ->  results/step1/judge/batch-A.json, batch-B.json, batch-C.json  (for the judges, model names hidden)
//                              results/step1/judge/key.json                                    (item id -> model, run; the judges never see it)
import {readFile, writeFile, mkdir, readdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const project = 'C:/Users/akshi/Desktop/Code Palace/Cyberpunk Mod';
const W = 'E:/CyberpunkConvai-offload/work/bonsai-eval/results/step1';
const {PersonaBook} = await import(pathToFileURL(resolve(project, 'bridge/mistral-prompt.mjs')).href);
const roster = [...JSON.parse(await readFile(resolve(project, 'characters/roster.json'), 'utf8')), ...JSON.parse(await readFile(resolve(project, 'characters/archetype-roster.json'), 'utf8'))];
const personas = new PersonaBook(roster);

// The supplied facts per character, mirrored from bench24.mjs (what the model was told).
const FACTS = {
  judy: {profileKey: 'judy-alvarez', facts: ['It is night, about 11 PM. V and Judy are in Japantown, Westbrook. V is a woman, Street Kid.', 'Quest journal: "Pisces", objective: "Meet Judy at the Clouds basement" (tracked).', 'V wears a Samurai Jacket, tank top, combat boots; carries Kyubi and Malorian Arms 3516; has Thermal Mantis Blades.', 'Memory of V: V once told me they like quiet places and hate crowded clubs. V promised to bring me real coffee from Japantown next time.']},
  johnny: {profileKey: 'johnny-silverhand', facts: ['It is late night, about 1 AM. V and Johnny are in Little China, Watson. V is a man, Nomad.', 'Quest journal: "Chippin\' In", objective: "Find a way to meet Rogue" (tracked).', 'V wears a Samurai Jacket, tank top, combat boots; carries Kyubi and Malorian Arms 3516; has Thermal Mantis Blades.', 'Memory of V: V told me they want to save enough eddies for a quiet apartment in Kabuki and leave this life. V said V does not like drinking alone.']},
  panam: {profileKey: 'panam-palmer', facts: ['It is early morning, about 7 AM. V and Panam are in the Badlands, in a vehicle, with Jackie Welles also along. V is a woman, Nomad.', 'Quest journal: "Riders on the Storm", objective: "Return to the Aldecaldos camp" (tracked).', 'Memory of V: V promised to bring me a good set of tools for the Basilisk. V said V grew up in the Badlands too, near a dry riverbed.', 'Turn 3 only: combat is happening now; observed opponents: 4 Maelstrom gangers (human); Panam is nearby.']},
  jackie: {profileKey: 'jackie-welles', facts: ['It is afternoon, about 4 PM. V and Jackie are at El Coyote Cojo, Heywood. V is a man, Corpo.', 'Quest journal: "The Rescue", objective: "Talk to Jackie" (tracked).', 'V wears a Samurai Jacket, tank top, combat boots; carries Kyubi and Malorian Arms 3516; has Thermal Mantis Blades.', 'No memory of earlier talks with V.', 'Turn 3 only: combat is happening now; observed opponents: 3 Tyger Claws gangsters (human); Jackie is nearby.']},
  resident: {profileKey: 'npc-street-resident-female', facts: ['This person is an unnamed street resident in Little China, Watson, a stranger to V. It is midday, about noon. V looks like a man.', 'A stranger knows nothing about V, the quest journal or the save.']},
  vendor: {profileKey: 'npc-food-vendor-male', facts: ['This person is an unnamed food and drink vendor (grilled food) in Little China, Watson, a stranger to V. It is evening, about 8 PM. V looks like a woman.', 'A stranger knows nothing about V, the quest journal or the save.', 'Turn 2 only: combat is happening now; observed opponents: 2 Maelstrom gangers (human); the vendor\'s presence in that fight is not established.', 'In turn 1, V says V\'s name is Dex.']},
};
const sheets = {};
for (const [id, f] of Object.entries(FACTS)) {
  const p = personas.persona(f.profileKey);
  sheets[id] = {character: p.name || (id === 'resident' ? 'Unnamed street resident (female, Little China)' : 'Unnamed food vendor (male, Little China)'),
    profile: p.backstory, speaking_style: p.style, supplied_facts: f.facts};
}

const files = (await readdir(W)).filter(n => n.endsWith('.json') && !n.startsWith('judge'));
const rows = [];
for (const file of files) {
  const doc = JSON.parse(await readFile(`${W}/${file}`, 'utf8'));
  if (!doc.results) continue;
  for (const r of doc.results.filter(x => x.layout === 'stable')) rows.push({model: doc.label, ...r});
}
// blind ids: shuffle with a fixed seed so the order does not follow the model
let seed = 20261012; const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
const shuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
shuffle(rows);
const key = {}; const byId = new Map();
rows.forEach((r, i) => { r.id = 'R' + String(i + 1).padStart(3, '0'); key[r.id] = {model: r.model, run: r.run, scenario: r.scenario, turn: r.turn}; byId.set(`${r.model}|${r.run}|${r.scenario}|${r.turn}`, r); });

const batches = {A: ['judy', 'johnny'], B: ['panam', 'jackie'], C: ['resident', 'vendor']};
await mkdir(`${W}/judge`, {recursive: true});
for (const [name, scenarios] of Object.entries(batches)) {
  const items = [];
  for (const r of rows.filter(x => scenarios.includes(x.scenario)).sort((a, b) => a.scenario.localeCompare(b.scenario) || a.turn - b.turn || a.id.localeCompare(b.id))) {
    // earlier lines of the same conversation (this run of this model): V's words and the character's own replies
    const earlier = [];
    for (let t = 1; t < r.turn; t++) { const e = byId.get(`${r.model}|${r.run}|${r.scenario}|${t}`); if (e) earlier.push({V: e.v, character: e.reply}); }
    items.push({id: r.id, character_key: r.scenario, turn: r.turn, turn_kind: r.kind, earlier_in_this_conversation: earlier, V_says: r.v, reply: r.reply || '(no reply)'});
  }
  await writeFile(`${W}/judge/batch-${name}.json`, JSON.stringify({characters: Object.fromEntries(scenarios.map(s => [s, sheets[s]])), items}, null, 1));
  console.log('batch', name, items.length, 'items');
}
await writeFile(`${W}/judge/key.json`, JSON.stringify(key, null, 1));
