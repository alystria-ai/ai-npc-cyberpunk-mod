// Rewrite the third-person character profiles in the first person (see scripts/first-person-profiles.mjs).
//
//   node scripts/Rewrite-FirstPersonProfiles.mjs extract <workdir>   writes <workdir>/input/<key>.json for every
//                                                                     third-person profile (not starting "You ")
//   node scripts/Rewrite-FirstPersonProfiles.mjs check <workdir>     checks <workdir>/output/<key>.json against the
//                                                                     input and prints the issues (exit 1 if any)
//   node scripts/Rewrite-FirstPersonProfiles.mjs apply <workdir>     checks, then writes characters/first-person-profiles.json,
//                                                                     characters/roster.json and characters/profile-text/
//   node scripts/Rewrite-FirstPersonProfiles.mjs report [base-ref]   before/after report (default base: the commit that last
//                                                                     changed roster.json before first-person-profiles.json)
//                                                                     written to runtime/first-person-report.md
//
// Nothing here talks to Convai. Applying the texts to the live characters is a separate, approved step:
//   node scripts/Provision-Characters.mjs --apply --only <keys>, then node scripts/Create-MultilingualProfiles.mjs --apply --only <keys>.

import {readFile, writeFile, mkdir, readdir} from 'node:fs/promises';
import {resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {splitBackstory, splitStyle, lineSegments, rewritable, reassemble, sha256} from './first-person-profiles.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const readJson = async file => JSON.parse((await readFile(file, 'utf8')).replace(/^﻿/, ''));
const rosterPath = resolve(root, 'characters/roster.json');
const storePath = resolve(root, 'characters/first-person-profiles.json');

// A profile still to be rewritten opens with the character's name, a description or "You are"; a finished one opens "I'm".
// (Name kept from the first pass; it means "not yet first person".)
export const isThirdPerson = row => !/^(I(?:'|’)m\b|I\b)/u.test(row.backstory);

function pieces(row) {
  const {core: backstoryCore, tail: backstoryTail} = splitBackstory(row.backstory);
  const {core: styleCore, tail: styleTail} = splitStyle(row.speakingStyleDescription);
  return {backstoryCore, backstoryTail, styleCore, styleTail,
    backstory: lineSegments(backstoryCore), style: lineSegments(styleCore, {style: true})};
}

export function makeInput(row) {
  const p = pieces(row);
  const number = (list, prefix) => rewritable(list).map((segment, i) => ({id: `${prefix}${i + 1}`, ...segment}));
  return {key: row.key, name: row.name, aliases: row.aliases, gender: row.gender,
    backstory: number(p.backstory, 'b'), style: number(p.style, 's')};
}

// ---- checks -------------------------------------------------------------------------------------------

const PRONOUN = /\b(he|she|his|her|hers|him|himself|herself)\b/giu;
const FIRST = /\b(I|I'm|I’m|I've|I’ve|I'll|I’ll|I'd|I’d|my|me|mine|myself)\b/u;
const NARRATOR = /\b(this|the|that) (character|person|man|woman|individual|resident)\b(?!-)/giu;
const META = /\b(here is|here are|rewritten|rewrite|first person|first-person|third person|as requested|note:)\b/iu;
const STOP = new Set(['the', 'and', 'for', 'with', 'from', 'that', 'this', 'not', 'are', 'was', 'were', 'his', 'her', 'she']);
const SKIP_TOKENS = new Set(['He', 'She', 'His', 'Her', 'Him', 'They', 'Their', 'The', 'This', 'That', 'These', 'Those', 'It', 'Its', 'Scope', 'If', 'When', 'As', 'In', 'On', 'At', 'A', 'An', 'No', 'Do', 'Use', 'Keep', 'Not']);

function nameParts(input) {
  const parts = new Set();
  for (const name of [input.name, ...(input.aliases || [])]) {
    for (const word of String(name).split(/[\s/]+/u)) {
      const clean = word.replace(/[^\p{L}\p{N}'’-]/gu, '').replace(/['’]s$/u, '');
      if (clean.length > 2 && !STOP.has(clean.toLowerCase())) parts.add(clean);
    }
  }
  return parts;
}
const words = text => text.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) || [];
const properTokens = text => new Set([...(text.match(/(?<![.!?]\s|^)\b[A-Z][\p{L}\p{N}'’-]+|\d[\d,.]*/gu) || [])
  .map(token => token.replace(/['’]s$/u, '')).filter(token => !SKIP_TOKENS.has(token))]);

export function checkRewrite(input, output) {
  const issues = [], add = (id, message, text) => issues.push({key: input.key, id, message, text});
  const own = nameParts(input);
  const ownPronouns = input.gender === 'MALE' ? /\b(he|his|him|himself)\b/giu : input.gender === 'FEMALE' ? /\b(she|her|hers|herself)\b/giu : PRONOUN;
  for (const [field, kind] of [['backstory', 'b'], ['style', 's']]) {
    const want = input[field], got = output[field];
    if (!Array.isArray(got) || got.length !== want.length) { add(kind, `${field}: expected ${want.length} lines, got ${got?.length}`); continue; }
    want.forEach((segment, i) => {
      const line = got[i];
      if (line.id !== segment.id) return add(segment.id, `wrong id ${line.id}`);
      const text = line.text;
      if (typeof text !== 'string' || !text.trim()) return add(segment.id, 'empty line');
      if (text.includes('\n')) add(segment.id, 'contains a line break', text);
      if (segment.kind === 'scope' && !text.startsWith('Scope: ')) add(segment.id, 'lost the "Scope: " label', text);
      if (segment.kind === 'relationship') {
        // a label that names the speaker's own relation ("her ripperdoc", "His family") becomes "my ..."
        const label = segment.text.split(': ')[0], own = label.replace(/^(his|her) /iu, m => (m[0] === 'H' ? 'My ' : 'my '));
        if (!text.startsWith(label + ': ') && !text.startsWith(own + ': ')) add(segment.id, `lost the "${label}: " label`, text);
      }
      if (META.test(text) && !META.test(segment.text)) add(segment.id, 'meta text', text);
      const ratio = text.length / segment.text.length;
      if (ratio < 0.8 || ratio > 1.25) add(segment.id, `length ratio ${ratio.toFixed(2)}`, text);
      // the opening sentence names the speaker once ("I'm Judy Alvarez"); a relationship label is someone else
      const body = segment.kind === 'relationship' ? text.slice(text.indexOf(': ') + 2)
        : segment.id === 'b1' ? text.replace(/^I(?:'|’)m [^,.;]*/u, "I'm") : text;
      const leftoverNames = [...own].filter(part => new RegExp(`(?<![\\p{L}\\p{N}-])${part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}])`, 'u').test(body));
      if (leftoverNames.length) add(segment.id, `own name still present: ${leftoverNames.join(', ')}`, text);
      // second-person profiles ("You are ...") become first person too: a you/your left over is flagged for a look
      const second = text.match(/\b(you|your|yours|yourself)\b/giu);
      if (second) add(segment.id, `you/your left (check it is not the speaker): ${[...new Set(second.map(w => w.toLowerCase()))].join(', ')}`, text);
      const narrator = text.match(NARRATOR);
      if (narrator) add(segment.id, `narrator phrase: ${narrator.join(', ')}`, text);
      const pronouns = (text.match(ownPronouns) || []);
      if (pronouns.length) add(segment.id, `he/she pronoun (check it is about someone else): ${[...new Set(pronouns.map(p => p.toLowerCase()))].join(', ')}`, text);
      // facts: every number and proper name of the original survives, except the character's own name
      const had = [...properTokens(segment.text)].filter(token => ![...own].some(part => token === part || part.startsWith(token)));
      const have = new Set(words(text).map(word => word.replace(/['’]s$/u, '')));
      const lost = had.filter(token => !have.has(token) && !text.includes(token));
      if (lost.length) add(segment.id, `names or numbers lost: ${lost.join(', ')}`, text);
      const content = [...new Set(words(segment.text.toLowerCase()).filter(word => word.length >= 7))];
      const lowerHave = new Set(words(text.toLowerCase()));
      const stems = content.filter(word => !lowerHave.has(word) && ![...lowerHave].some(other => other.startsWith(word.slice(0, 5)) || word.startsWith(other.slice(0, 5)) && other.length >= 5));
      if (content.length >= 4 && stems.length / content.length > 0.3) add(segment.id, `content words dropped: ${stems.join(', ')}`, text);
    });
  }
  const first = output.backstory?.[0]?.text || '';
  if (!FIRST.test(first)) add('b1', 'the opening line is not in the first person', first);
  const outputText = [...(output.backstory || []), ...(output.style || [])].map(line => line.text).join('\n');
  if (!FIRST.test(outputText)) add('-', 'no first-person word anywhere');
  return issues;
}

async function loadSet(workdir, keys) {
  const inputs = [], outputs = new Map();
  const names = (await readdir(resolve(workdir, 'input'))).filter(name => name.endsWith('.json')).sort();
  for (const name of names) {
    const input = await readJson(resolve(workdir, 'input', name));
    if (keys && !keys.includes(input.key)) continue;
    inputs.push(input);
    try { outputs.set(input.key, await readJson(resolve(workdir, 'output', name))); } catch { /* reported below */ }
  }
  return {inputs, outputs};
}

function checkAll({inputs, outputs}) {
  const issues = [];
  for (const input of inputs) {
    const output = outputs.get(input.key);
    if (!output) { issues.push({key: input.key, id: '-', message: 'no output file'}); continue; }
    issues.push(...checkRewrite(input, output));
  }
  return issues;
}

// ---- commands -----------------------------------------------------------------------------------------

async function extract(workdir, keys) {
  const roster = await readJson(rosterPath);
  await mkdir(resolve(workdir, 'input'), {recursive: true});
  const rows = roster.filter(row => (keys ? keys.includes(row.key) : isThirdPerson(row)));
  for (const row of rows) await writeFile(resolve(workdir, 'input', row.key + '.json'), JSON.stringify(makeInput(row), null, 1) + '\n');
  console.log(`${rows.length} third-person profiles written to ${resolve(workdir, 'input')}`);
}

async function check(workdir, {only} = {}) {
  const set = await loadSet(workdir, only);
  const issues = checkAll(set);
  const byKey = new Map();
  for (const issue of issues) byKey.set(issue.key, (byKey.get(issue.key) || 0) + 1);
  for (const issue of issues) console.log(`${issue.key} ${issue.id}: ${issue.message}${issue.text ? '\n    ' + issue.text : ''}`);
  console.log(`\n${set.inputs.length} characters, ${set.outputs.size} outputs, ${issues.length} flagged lines in ${byKey.size} characters`);
  return issues;
}

/** Compact reading view: changed lines as before/after pairs; unchanged lines only when they still look like they mention the speaker. */
export async function review(workdir, {only} = {}) {
  const {inputs, outputs} = await loadSet(workdir, only);
  const lines = [];
  for (const input of inputs) {
    const output = outputs.get(input.key);
    lines.push(`=== ${input.key} | ${input.name} | ${input.gender} | aliases: ${input.aliases.join(', ')}`);
    for (const field of ['backstory', 'style']) input[field].forEach((segment, i) => {
      const text = output?.[field]?.[i]?.text;
      if (text === undefined) return lines.push(`${segment.id} MISSING`);
      if (text !== segment.text) lines.push(`${segment.id} [${segment.kind}]\n  - ${segment.text}\n  + ${text}`);
      else if (/\b(he|she|his|her|him|they|their)\b/iu.test(segment.text) || nameParts(input).size && [...nameParts(input)].some(part => segment.text.includes(part))) {
        lines.push(`${segment.id} [${segment.kind}] UNCHANGED: ${segment.text}`);
      }
    });
  }
  return lines.join('\n');
}

async function apply(workdir) {
  const set = await loadSet(workdir);
  // Structural problems stop the run. The heuristic flags (a pronoun about someone else, a name, a length) are judgement
  // calls that were reviewed line by line; `check` still lists them.
  const issues = checkAll(set).filter(issue => /^(.*: expected|wrong id|empty line|contains a line break|lost the|meta text|the opening line|no first-person|no output file)/u.test(issue.message));
  if (issues.length) { for (const issue of issues) console.error(`${issue.key} ${issue.id}: ${issue.message}`); throw Error('The outputs have problems; fix them first'); }
  const roster = await readJson(rosterPath);
  // adds to (or replaces entries of) the stored rewrites
  const store = await readJson(storePath).catch(() => ({version: 1, note: 'First-person rewrites of the composed third-person profile texts; see scripts/first-person-profiles.mjs.', characters: {}}));
  for (const input of set.inputs) {
    const output = set.outputs.get(input.key), row = roster.find(item => item.key === input.key), p = pieces(row);
    const backstoryCore = reassemble(p.backstory, output.backstory.map(line => line.text));
    const styleCore = reassemble(p.style, output.style.map(line => line.text));
    store.characters[input.key] = {backstory: {sourceSha256: sha256(p.backstoryCore), text: backstoryCore},
      speakingStyleDescription: {sourceSha256: sha256(p.styleCore), text: styleCore}};
    row.backstory = backstoryCore + p.backstoryTail;
    row.speakingStyleDescription = styleCore + p.styleTail;
    row.backstoryWords = row.backstory.split(/\s+/).length;
  }
  await writeFile(storePath, JSON.stringify(store, null, 1) + '\n');
  await writeFile(rosterPath, JSON.stringify(roster, null, 2) + '\n');
  for (const input of set.inputs) {
    const row = roster.find(item => item.key === input.key);
    await writeFile(resolve(root, 'characters/profile-text', row.key + '.txt'), [
      'BACKSTORY (backstory)', row.backstory,
      'SPEAKING STYLE DESCRIPTION (speaking_style_description)', row.speakingStyleDescription,
      'SPEAKING STYLE SAMPLE DIALOGUES (speaking_style_sample_dialogues)', row.speakingStyleSampleDialogues,
    ].join('\n\n') + '\n');
  }
  console.log(`${set.inputs.length} profiles rewritten (roster.json, profile-text/, first-person-profiles.json)`);
}

async function report(base) {
  const git = (...args) => execFileSync('git', args, {cwd: root, encoding: 'utf8', maxBuffer: 1 << 28});
  base ||= git('log', '--format=%H', '-n', '1', '--', 'characters/first-person-profiles.json').trim() + '~1';
  const before = JSON.parse(git('show', `${base}:characters/roster.json`).replace(/^﻿/, ''));
  const after = await readJson(rosterPath);
  const out = [`# First-person profile rewrite: before and after (base ${base})\n`];
  let changed = 0;
  for (const row of after) {
    const old = before.find(item => item.key === row.key);
    if (!old || (old.backstory === row.backstory && old.speakingStyleDescription === row.speakingStyleDescription)) continue;
    changed++;
    out.push(`\n## ${row.name} (${row.key})\n`);
    for (const [field, label] of [['backstory', 'backstory'], ['speakingStyleDescription', 'speaking style']]) {
      const a = old[field].split('\n'), b = row[field].split('\n');
      if (a.length !== b.length) { out.push(`**${label}: line count changed ${a.length} to ${b.length}**\n`); continue; }
      a.forEach((line, i) => { if (line !== b[i]) out.push(`- before: ${line}\n- after:  ${b[i]}\n`); });
    }
  }
  out.splice(1, 0, `${changed} profiles changed.\n`);
  await mkdir(resolve(root, 'runtime'), {recursive: true});
  await writeFile(resolve(root, 'runtime/first-person-report.md'), out.join('\n'));
  console.log(`${changed} profiles changed; runtime/first-person-report.md written`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, arg, ...rest] = process.argv.slice(2);
  const only = rest.find(item => item.startsWith('--only='))?.slice(7).split(',');
  if (command === 'extract') await extract(resolve(arg), rest.find(item => item.startsWith('--keys='))?.slice(7).split(','));
  else if (command === 'check') process.exitCode = (await check(resolve(arg), {only})).length ? 1 : 0;
  else if (command === 'review') console.log(await review(resolve(arg), {only}));
  else if (command === 'apply') await apply(resolve(arg));
  else if (command === 'report') await report(arg);
  else { console.error('usage: extract|check|apply <workdir> | report [base-ref]'); process.exitCode = 2; }
}
