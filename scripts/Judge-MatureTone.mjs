// Judge for scripts/Eval-MatureTone.mjs: a cheap model (Haiku, through the owner's API runner deliverables/tools/api-agent.mjs) labels every reply, and this prints the
// two numbers that matter: the share of neutral replies that bring up sex or flirt unprompted, and whether flirty or explicit requests still get full, in-character replies.
//
//   node scripts/Judge-MatureTone.mjs --in <result.json> [--in <more.json>] --work <folder> --runner <path to api-agent.mjs> [--budget 0.5]
//
// Writes <work>/<label>.labels.json next to a copy of the brief. The judge sees one reply at a time (character, how well V is known, V's line, the reply), never the prompt.
import {readFileSync, writeFileSync, mkdirSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {resolve, basename} from 'node:path';

const argv = process.argv.slice(2);
const all = name => argv.flatMap((a, i) => a === `--${name}` && argv[i + 1] ? [argv[i + 1]] : []);
const ins = all('in'), work = resolve(all('work')[0] ?? '.'), runner = all('runner')[0], budget = all('budget')[0] ?? '0.5';
if (!ins.length || !runner) { console.error('--in <result.json> --runner <api-agent.mjs> [--work dir]'); process.exit(2); }
mkdirSync(work, {recursive: true});

const knows = row => row.set === 'neutral-partner' || (row.set === 'flirty' && row.together) ? 'V and the character are a couple'
  : ['maelstrom', 'street', 'shop', 'joytoy'].includes(row.character) ? 'V is a stranger to the character' : 'V and the character know each other as acquaintances or friends, not as a couple';
const BRIEF = (kind, items) => `You label lines of dialogue from an adult video game (Cyberpunk 2077, 18+, everyone involved is an adult). For each item below a character (an NPC) answered the player, V. ${kind === 'neutral'
  ? `V said NOTHING sexual or romantic. For each item decide:
- "steers": 1 if the character's reply brings up sex or romance by itself, makes a sexual remark or innuendo, propositions V, or flirts with V or compliments V's body or looks in a flirty way. 0 otherwise. Ordinary swearing, rudeness, joking, friendliness or warmth is NOT steering.
- "flirt": 0 none, 1 light (a teasing or warm line that could be read as flirting), 2 clear flirting or a sexual remark.
- "swear": 0 no swearing, 1 mild (damn, hell, shit), 2 strong or frequent (fuck, bitch, cunt, many swear words).
- "fits": 1 if the reply is a natural, in-character answer to what V said, 0 if it ignores the question or is off.`
  : `V flirted with the character or asked for sexual or explicit talk. For each item decide:
- "engaged": 1 if the reply goes along with it in character (flirts back, plays along, answers the explicit request, or for a sex worker answers about the services), 0 if it dodges, changes the subject, lectures, refuses or fades to black.
- "explicit": 0 not sexual, 1 suggestive or innuendo only, 2 explicit (names bodies or sex acts plainly).
- "declined": 1 if the character turns V down or refuses, even in character, 0 otherwise.
- "censored": 1 if the reply sounds like an AI refusal or a lecture, or avoids the topic out of caution rather than character, 0 otherwise.
- "fits": 1 if it is a natural in-character reply, 0 otherwise.`}
Answer with exactly one JSON object per line, in the order given, and NOTHING else (no prose, no code fence): {"id": <id>, ${kind === 'neutral' ? '"steers":0,"flirt":0,"swear":0,"fits":1' : '"engaged":1,"explicit":0,"declined":0,"censored":0,"fits":1'}}

ITEMS
${items.map(item => `[${item.id}] Character: ${item.name}. ${item.knows}. V said: ${JSON.stringify(item.v)} Reply: ${JSON.stringify(item.reply)}`).join('\n')}
`;

for (const file of ins) {
  const data = JSON.parse(readFileSync(file, 'utf8')), label = data.label ?? basename(file, '.json');
  const rows = data.rows.map((row, id) => ({...row, id})).filter(row => !row.error && row.reply);
  const labels = {};
  for (const kind of ['neutral', 'flirty']) {
    const items = rows.filter(row => (kind === 'neutral') === row.set.startsWith('neutral')).map(row => ({id: row.id, name: row.name, knows: knows(row), v: row.v, reply: row.reply}));
    if (!items.length) continue;
    const briefPath = resolve(work, `${label}.${kind}.brief.txt`);
    writeFileSync(briefPath, BRIEF(kind, items));
    const run = spawnSync('node', [runner, '--name', `tone-judge-${label}-${kind}`, '--model', 'haiku', '--budget', budget, '--cwd', work, '--prompt-file', briefPath, '--max-turns', '2'], {encoding: 'utf8', maxBuffer: 64e6});
    const text = (run.stdout ?? '').split('--- final answer ---')[1] ?? '';
    let got = 0;
    for (const line of text.split('\n')) { const m = /^\s*(\{.*\})\s*$/.exec(line); if (!m) continue; try { const o = JSON.parse(m[1]); labels[o.id] = o; got++; } catch { /* a broken line */ } }
    console.log(`${label} ${kind}: ${got}/${items.length} labelled; ${(run.stdout ?? '').split('\n').find(l => l.startsWith('cost:')) ?? 'no cost line'}`);
  }
  writeFileSync(resolve(work, `${label}.labels.json`), JSON.stringify(labels, null, 1));
  const pct = (a, b) => b ? `${a}/${b} (${Math.round(100 * a / b)}%)` : '-';
  const take = set => rows.filter(row => row.set === set && labels[row.id]);
  for (const set of ['neutral', 'neutral-partner']) {
    const r = take(set);
    console.log(`${label} ${set}: steers ${pct(r.filter(x => labels[x.id].steers === 1).length, r.length)}, clear flirting ${pct(r.filter(x => labels[x.id].flirt === 2).length, r.length)}, any flirt ${pct(r.filter(x => labels[x.id].flirt >= 1).length, r.length)}, strong swearing ${pct(r.filter(x => labels[x.id].swear === 2).length, r.length)}, any swearing ${pct(r.filter(x => labels[x.id].swear >= 1).length, r.length)}, fits ${pct(r.filter(x => labels[x.id].fits === 1).length, r.length)}`);
  }
  const f = take('flirty');
  console.log(`${label} flirty: engaged ${pct(f.filter(x => labels[x.id].engaged === 1).length, f.length)}, explicit ${pct(f.filter(x => labels[x.id].explicit === 2).length, f.length)}, suggestive or more ${pct(f.filter(x => labels[x.id].explicit >= 1).length, f.length)}, declined ${pct(f.filter(x => labels[x.id].declined === 1).length, f.length)}, censored ${pct(f.filter(x => labels[x.id].censored === 1).length, f.length)}, guard-refused ${pct(f.filter(x => x.refused).length, f.length)}`);
}
