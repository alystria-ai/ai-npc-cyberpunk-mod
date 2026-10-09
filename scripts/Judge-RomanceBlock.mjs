// Blind scoring support for scripts/Probe-RomanceBlock.mjs (docs/ROMANCE_DYNAMIC_CONTEXT.md).
//
//   node scripts/Judge-RomanceBlock.mjs packet  <probe.json> <outDir> [--seed 7] [--arms A,B]
//       Writes <outDir>/packet-<profile>.json (what a judge sees: the player line and two replies labelled X and Y, in a shuffled
//       order, no arm anywhere) and <outDir>/key.json (which arm is X and Y for every item; judges never read it).
//   node scripts/Judge-RomanceBlock.mjs merge <outDir> <summary.json>
//       Reads <outDir>/scores-<profile>.json (one array per profile: [{id, X:{warmth,voice,notForced}, Y:{...}}], each 1-5) and the key,
//       and prints and writes the per-profile, per-arm and per-category means.
import {readFile, writeFile, mkdir, readdir} from 'node:fs/promises';
import {resolve} from 'node:path';

const [command, first, second] = process.argv.slice(2);
const seedArg = process.argv.indexOf('--seed');
let seed = seedArg >= 0 ? Number(process.argv[seedArg + 1]) : 7;
const random = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
const readJson = async path => JSON.parse((await readFile(path, 'utf8')).replace(/^﻿/, ''));

const CHARACTER = {
  'judy-alvarez': {name: 'Judy Alvarez', voice: 'a braindance editor from Night City: direct, quick, colloquial, dry little jokes, guarded, independent; affection shows as understated warmth, a tease or a practical offer rather than speeches.',
    state: 'V and Judy are in a committed relationship (a save fact).'},
  'panam-palmer': {name: 'Panam Palmer', voice: 'an Aldecaldo nomad: direct, articulate, practical, fiercely loyal and proud, teasing in calm company; affection is playful and plain rather than sugary.',
    state: 'V and Panam are in a committed relationship (a save fact).'},
  'river-ward': {name: 'River Ward', voice: 'an NCPD detective: plainspoken, measured, earnest, a little awkward and gently funny in quiet company; affection shows as ordinary kindness and understatement.',
    state: 'V and River are in a committed relationship (a save fact).'},
  'kerry-eurodyne': {name: 'Kerry Eurodyne', voice: 'a rock star: expansive, mercurial, irreverent, vain and self-aware, teasing by habit with candid half-sentences; avoids polished celebrity speeches.',
    state: 'V and Kerry are in a committed relationship (a save fact).'},
  'meredith-stout': {name: 'Meredith Stout', voice: 'a senior Militech executive: controlled, terse, blunt, in command of the conversation, dry and cutting; at most a knowing, casual familiarity.',
    state: 'V and Meredith had a casual intimate encounter (a save fact). It is NOT a committed relationship, and she must not claim devotion, exclusivity or partnership.'},
};
const RUBRIC = {
  scale: 'Each reply gets three integer scores from 1 to 5.',
  warmth: 'Affection and closeness toward V that comes through in the reply, in the character\'s own manner. 1 = cold, flat or purely transactional. 3 = friendly. 5 = clearly and personally affectionate (for Meredith: knowing, casual familiarity at most).',
  voice: 'How well the reply sounds like this specific character (diction, attitude, rhythm), as opposed to a generic assistant or a generic romantic partner. 1 = generic or off. 5 = unmistakably them.',
  notForced: 'Whether romance is kept natural. 5 = the amount of affection fits what V said and reads naturally (a practical question gets a practical answer; a sincere or flirty line gets a fitting response). 1 = romance or tenderness is forced into a reply that did not call for it, or it is over-the-top, gushing, cliched or out of character (Meredith claiming commitment also scores low).',
  note: 'Judge each reply by itself against the player line, then fill in both. Do not guess how either reply was produced.',
};

if (command === 'packet') {
  const report = await readJson(first), out = resolve(second);
  await mkdir(out, {recursive: true});
  const key = {}, byProfile = {};
  const armsArg = process.argv.indexOf('--arms'), wanted = (armsArg >= 0 ? process.argv[armsArg + 1] : 'A,B').split(',');
  for (const row of report.rows.filter(row => wanted.includes(row.arm))) (byProfile[row.profile] ??= {})[`${row.scope}:${row.n}`] ??= {}, byProfile[row.profile][`${row.scope}:${row.n}`][row.arm] = row;
  for (const [profile, items] of Object.entries(byProfile)) {
    const list = [];
    for (const [id, arms] of Object.entries(items)) {
      const names = Object.keys(arms);
      if (names.length !== 2) continue; // only complete pairs are scored
      if (random() < .5) names.reverse();
      const [x, y] = names, sample = arms[x];
      key[`${profile}/${id}`] = {X: x, Y: y, cat: sample.cat, scope: sample.scope};
      list.push({id, category: sample.cat, scope: sample.scope, ...(sample.heard ? {otherSpeakerJustSaid: sample.heard} : {}),
        player: sample.player, X: arms[x].reply, Y: arms[y].reply});
    }
    // Shuffle the order too, so a judge cannot read the arm from the position in the file.
    for (let i = list.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [list[i], list[j]] = [list[j], list[i]]; }
    await writeFile(resolve(out, `packet-${profile}.json`), JSON.stringify({character: CHARACTER[profile], rubric: RUBRIC, items: list}, null, 2) + '\n');
  }
  await writeFile(resolve(out, 'key.json'), JSON.stringify(key, null, 2) + '\n');
  console.log(JSON.stringify({packets: Object.keys(byProfile), items: Object.keys(key).length}));
} else if (command === 'merge') {
  const dir = resolve(first), key = await readJson(resolve(dir, 'key.json'));
  const files = (await readdir(dir)).filter(name => /^scores-.+\.json$/.test(name));
  const total = {}; // profile -> arm -> cat -> metric -> [numbers]
  for (const file of files) {
    const profile = file.slice('scores-'.length, -'.json'.length);
    for (const row of await readJson(resolve(dir, file))) {
      const entry = key[`${profile}/${row.id}`];
      if (!entry) continue;
      for (const label of ['X', 'Y']) {
        const arm = entry[label], s = row[label];
        if (!s) continue;
        for (const metric of ['warmth', 'voice', 'notForced']) {
          for (const cat of [entry.cat, 'all']) ((((total[profile] ??= {})[arm] ??= {})[cat] ??= {})[metric] ??= []).push(Number(s[metric]));
        }
      }
    }
  }
  const mean = list => list.length ? Math.round(list.reduce((a, b) => a + b, 0) / list.length * 100) / 100 : null;
  const summary = {};
  for (const [profile, arms] of Object.entries(total)) for (const [arm, cats] of Object.entries(arms)) for (const [cat, metrics] of Object.entries(cats)) {
    ((summary[profile] ??= {})[arm] ??= {})[cat] = {n: metrics.warmth.length, ...Object.fromEntries(Object.entries(metrics).map(([m, list]) => [m, mean(list)]))};
  }
  // Across characters.
  const everyone = {};
  for (const [, arms] of Object.entries(total)) for (const [arm, cats] of Object.entries(arms)) for (const [cat, metrics] of Object.entries(cats)) {
    for (const [m, list] of Object.entries(metrics)) (((everyone[arm] ??= {})[cat] ??= {})[m] ??= []).push(...list);
  }
  summary.all = Object.fromEntries(Object.entries(everyone).map(([arm, cats]) => [arm, Object.fromEntries(Object.entries(cats).map(([cat, metrics]) =>
    [cat, {n: metrics.warmth.length, ...Object.fromEntries(Object.entries(metrics).map(([m, list]) => [m, mean(list)]))}]))]));
  await writeFile(resolve(second), JSON.stringify(summary, null, 2) + '\n');
  for (const [profile, arms] of Object.entries(summary)) {
    for (const arm of Object.keys(arms).sort()) {
      const a = arms[arm].all;
      console.log(`${profile.padEnd(16)} ${arm}  n=${String(a.n).padStart(3)}  warmth ${a.warmth}  voice ${a.voice}  not-forced ${a.notForced}`);
    }
  }
} else {
  console.error('Usage: packet <probe.json> <outDir> [--seed N] | merge <outDir> <summary.json>');
  process.exit(2);
}
