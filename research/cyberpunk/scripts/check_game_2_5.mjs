// Read-only check of the reviewed world-knowledge pack (characters/world-knowledge.json) against an installed game 2.5, next to a copy of
// game 2.31. It never writes to either game folder: archives are opened for reading, resources are extracted with WolvenKit CLI into --work.
//
//   node research/cyberpunk/scripts/check_game_2_5.mjs <stage> --game25 DIR --game231 DIR --work DIR
//
// Stages, in order (the later ones read the files the earlier ones leave in --work):
//   cited      Every resource the pack cites (evidence, nativeRefs, fact writers) by archive entry hash: identical SHA-1 in both games or not.
//   changed    Every quest, phase, scene and journal resource whose effective version (ep1 over base) differs between the games.
//   extract    Extract and serialize the changed resources of both games (WolvenKit CLI, needs DOTNET_ROOT or vendor/dotnet-runtime-*).
//   facts      For the changed resources, the fact reads and writes that differ, and which of them touch a fact the pack uses.
//   citations  The pack's pointers, expected types and values and fact writers inside the changed resources, on both games.
//   journal    Every journal entry the pack allowlists by path and class, and the journal evidence nodes by path, on both games.
//   localization  The English on-screen strings the evidence cites, by primary key, on both games.
// docs/GAME_VERSIONS.md ("Relationship receipts and world knowledge on 2.5") has the result.
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const BS = String.fromCharCode(92);
const here = path.dirname(fileURLToPath(import.meta.url)), root = path.resolve(here, '../../..');
const args = process.argv.slice(2), stage = args[0];
const opt = (name, fallback) => { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1] : fallback; };
const GAME25 = opt('game25', 'E:/SteamLibrary/steamapps/common/Cyberpunk 2077'), GAME231 = opt('game231', 'E:/SteamLibrary/Cyberpunk2077-2.31');
const WORK = path.resolve(opt('work', path.join(process.env.TEMP || '.', 'game25-check')));
fs.mkdirSync(WORK, {recursive: true});
const games = {231: GAME231, 25: GAME25};
const ARCHIVE = {base: 'archive/pc/content/basegame_4_gamedata.archive', ep1: 'archive/pc/ep1/ep1_2_gamedata.archive'};
const KIND = /\.(quest|questphase|scene|journal)$/;

const pack = JSON.parse(fs.readFileSync(path.join(root, 'characters/world-knowledge.json'), 'utf8').replace(/^\uFEFF/, ''));
const load = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const save = (name, value) => fs.writeFileSync(path.join(WORK, name), JSON.stringify(value, null, 1));
const read = name => load(path.join(WORK, name));
const scalar = value => value && typeof value === 'object' && '$value' in value ? value.$value : value;

// ---- RDAR v12 directory (no payload is read) and the depot path hash (FNV-1a 64 of the lower-case path) ----
const OFFSET = 0xCBF29CE484222325n, PRIME = 0x100000001B3n, MASK = (1n << 64n) - 1n;
const hashPath = depot => {
  let h = OFFSET;
  for (const byte of Buffer.from(depot.toLowerCase().split('/').join(BS), 'utf8')) h = ((h ^ BigInt(byte)) * PRIME) & MASK;
  return h.toString();
};
function readToc(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const head = Buffer.alloc(20); fs.readSync(fd, head, 0, 20, 0);
    if (head.toString('latin1', 0, 4) !== 'RDAR' || head.readUInt32LE(4) !== 12) throw new Error('not an RDAR v12 archive: ' + file);
    const offset = Number(head.readBigUInt64LE(8)), size = head.readUInt32LE(16);
    const buffer = Buffer.alloc(size); fs.readSync(fd, buffer, 0, size, offset);
    const count = buffer.readUInt32LE(16), segments = 28 + count * 56, rows = new Map();
    for (let i = 0, p = 28; i < count; i++, p += 56) {
      let decoded = 0;
      for (let s = buffer.readUInt32LE(p + 20); s < buffer.readUInt32LE(p + 24); s++) decoded += buffer.readUInt32LE(segments + s * 16 + 12);
      rows.set(buffer.readBigUInt64LE(p).toString(), {sha1: buffer.subarray(p + 36, p + 56).toString('hex'), decoded});
    }
    return rows;
  } finally { fs.closeSync(fd); }
}
function allTocs(game) {
  const out = {};
  for (const dir of ['content', 'ep1']) {
    const folder = path.join(game, 'archive/pc', dir);
    for (const name of fs.readdirSync(folder)) if (name.endsWith('.archive')) out[dir + '/' + name] = readToc(path.join(folder, name));
  }
  return out;
}
// The effective entry of a depot path: ep1 over base, as the engine loads them.
const effective = (toc, hash) => toc.ep1.get(hash) ? ['ep1', toc.ep1.get(hash).sha1] : toc.base.get(hash) ? ['base', toc.base.get(hash).sha1] : null;
const gamedataTocs = game => ({base: readToc(path.join(game, ARCHIVE.base)), ep1: readToc(path.join(game, ARCHIVE.ep1))});

// ---- the pack's citations ----
const refs = [];   // {id, ref: {jsonPath, jsonPointer, expectedType, expected, ...}, fact?: name, writer?: true}
for (const row of pack.evidence) for (const ref of [row.native, ...(row.nativeRefs || [])]) if (ref?.jsonPath) refs.push({id: row.id, ref});
for (const [fact, row] of Object.entries(pack.factAllowlist)) for (const writer of row.writers || []) if (writer?.jsonPath) refs.push({id: fact, ref: writer, fact});
const depotOf = jsonPath => {
  const m = jsonPath.match(/(?:^|\/)raw\/(base|ep1)\/(.+)\.json$/);
  return m ? {archive: m[1], depot: m[2].split('/').join(BS)} : null;
};

function cited() {
  const a = allTocs(GAME231), b = allTocs(GAME25), paths = new Map();
  for (const {ref} of refs) paths.set(ref.jsonPath, depotOf(ref.jsonPath));
  const find = (tocs, hash) => Object.entries(tocs).filter(([, rows]) => rows.has(hash)).map(([name, rows]) => name + ':' + rows.get(hash).sha1);
  const out = {same: [], different: [], missing: []};
  for (const [jsonPath, d] of paths) {
    if (!d) { out.missing.push({jsonPath, why: 'not a raw archive path'}); continue; }
    const hash = hashPath(d.depot), x = find(a, hash).sort().join(), y = find(b, hash).sort().join();
    if (!x || !y) out.missing.push({jsonPath, depot: d.depot, in231: !!x, in25: !!y});
    else (x === y ? out.same : out.different).push({jsonPath, depot: d.depot});
  }
  save('cited.json', out);
  console.log(JSON.stringify({citedResources: paths.size, byteIdenticalInEveryArchive: out.same.length, differentInSomeArchive: out.different.length, missing: out.missing.length}));
}

function lister(game, archive) {
  const cli = path.join(root, 'vendor/wolvenkit-console-9.0.1/WolvenKit.CLI.exe');
  const env = {...process.env, DOTNET_ROOT: process.env.DOTNET_ROOT || path.join(root, 'vendor/dotnet-runtime-10.0.12')};
  const r = spawnSync(cli, ['archive', path.join(game, ARCHIVE[archive]), '--list', '--regex', KIND.source], {env, encoding: 'utf8', maxBuffer: 1 << 28});
  return new Set(r.stdout.split(/\r?\n/).map(line => line.trim()).filter(line => KIND.test(line)));
}
function changed() {
  const t231 = gamedataTocs(GAME231), t25 = gamedataTocs(GAME25), all = new Set(), listed = {};
  for (const archive of ['base', 'ep1']) {
    listed[archive] = {231: lister(GAME231, archive), 25: lister(GAME25, archive)};
    for (const g of ['231', '25']) listed[archive][g].forEach(p => all.add(p));
  }
  const real = [], overridden = [];
  for (const p of all) {
    const h = hashPath(p), x = effective(t231, h), y = effective(t25, h);
    if (x && y && x[1] === y[1]) { if (['base', 'ep1'].some(a => t231[a].get(h)?.sha1 !== t25[a].get(h)?.sha1)) overridden.push(p); continue; }
    real.push({p, in231: x && x[0], in25: y && y[0]});
  }
  save('changed.json', {real, overridden});
  const kinds = {}; for (const r of real) { const k = r.p.split('.').pop(); kinds[k] = (kinds[k] || 0) + 1; }
  console.log(JSON.stringify({resourcesInBothGames: all.size, effectivelyChanged: real.length, byKind: kinds, changedOnlyUnderAnEp1Override: overridden.length}));
}

function runCli(cliArgs) {
  const cli = path.join(root, 'vendor/wolvenkit-console-9.0.1/WolvenKit.CLI.exe');
  const env = {...process.env, DOTNET_ROOT: process.env.DOTNET_ROOT || path.join(root, 'vendor/dotnet-runtime-10.0.12')};
  const r = spawnSync(cli, cliArgs, {env, encoding: 'utf8', maxBuffer: 1 << 28});
  if (r.status !== 0) throw new Error('WolvenKit CLI failed: ' + cliArgs.slice(0, 2).join(' '));
}
function extract() {
  const real = read('changed.json').real.map(r => r.p);
  const regexEscape = s => [...s].map(c => '.+*?()|[]{}^$'.includes(c) || c === BS ? BS + c : c).join('');
  for (const [g, game] of Object.entries(games)) for (const archive of ['base', 'ep1']) {
    const out = path.join(WORK, 'x' + g, archive); fs.mkdirSync(out, {recursive: true});
    const have = lister(game, archive), mine = real.filter(p => have.has(p));
    for (let i = 0; i < mine.length; i += 60) {
      runCli(['extract', path.join(game, ARCHIVE[archive]), '--outpath', out, '--regex', '^(' + mine.slice(i, i + 60).map(regexEscape).join('|') + ')$']);
    }
    if (mine.length) runCli(['convert', 'serialize', out, '--regex', KIND.source]);
    console.log(g, archive, mine.length, 'extracted');
  }
  // The English on-screen strings (base and Phantom Liberty language archives) for the localization stage.
  for (const [g, game] of Object.entries(games)) for (const dir of ['content', 'ep1']) {
    const out = path.join(WORK, 'loc' + g, dir); fs.mkdirSync(out, {recursive: true});
    runCli(['extract', path.join(game, 'archive/pc', dir, 'lang_en_text.archive'), '--outpath', out, '--regex', 'en-us.onscreens.onscreens(_final)?\\.json$']);
    runCli(['convert', 'serialize', out, '--regex', 'onscreens(_final)?\\.json$']);
  }
}
const jsonOf = (g, archive, depot) => path.join(WORK, 'x' + g, archive, depot.split(BS).join('/') + '.json');
// The effective JSON of a depot path in game g: ep1's copy when the archive has one, else base's.
const effectiveJson = (g, depot) => ['ep1', 'base'].map(a => jsonOf(g, a, depot)).find(f => fs.existsSync(f));

function factsUsed(json) {
  const rows = [];
  (function walk(v, type) {
    if (Array.isArray(v)) return v.forEach(x => walk(x, type));
    if (!v || typeof v !== 'object') return;
    const t = v.$type || type;
    for (const k of ['factName', 'factName1', 'factName2']) if (typeof v[k] === 'string' && v[k]) {
      rows.push([v[k], k, t, JSON.stringify({value: v.value, setExactValue: v.setExactValue, comparisonType: v.comparisonType, varOperation: v.varOperation})]);
    }
    for (const x of Object.values(v)) walk(x, t);
  })(json, '');
  return rows;
}
function facts() {
  const universe = new Set(Object.keys(pack.factAllowlist));
  (function cond(c) { if (Array.isArray(c)) c.forEach(cond); else if (c && typeof c === 'object') { if (c.type === 'fact' && c.key) universe.add(c.key); Object.values(c).forEach(cond); } })(pack.rules.map(r => r.condition));
  const out = [], touched = new Set();
  for (const {p} of read('changed.json').real) {
    if (p.endsWith('cooked_journal.journal')) continue;
    const fa = effectiveJson('231', p), fb = effectiveJson('25', p);
    const count = rows => { const m = new Map(); for (const r of rows) { const s = JSON.stringify(r); m.set(s, (m.get(s) || 0) + 1); } return m; };
    const ca = count(fa ? factsUsed(load(fa)) : []), cb = count(fb ? factsUsed(load(fb)) : []);
    const added = [...cb].filter(([s, n]) => (ca.get(s) || 0) < n).map(([s]) => JSON.parse(s));
    const removed = [...ca].filter(([s, n]) => (cb.get(s) || 0) < n).map(([s]) => JSON.parse(s));
    [...added, ...removed].forEach(r => touched.add(r[0]));
    out.push({p, in231: !!fa, in25: !!fb, added, removed});
  }
  save('facts.json', out);
  const hits = out.filter(o => [...o.added, ...o.removed].some(r => universe.has(r[0])));
  console.log(JSON.stringify({factsTheRulesUse: universe.size, changedResourcesCompared: out.length, withNoFactChange: out.filter(o => !o.added.length && !o.removed.length).length,
    distinctFactsTouched: touched.size, touchingAFactTheRulesUse: hits.length}));
  for (const o of hits) console.log(' ', o.p, JSON.stringify({added: o.added.filter(r => universe.has(r[0])), removed: o.removed.filter(r => universe.has(r[0]))}));
}

const resolvePointer = (doc, pointer) => {
  let v = doc;
  for (const k of pointer.split('/').slice(1)) { if (v == null || typeof v !== 'object') return undefined; v = v[k.split('~1').join('/').split('~0').join('~')]; }
  return v;
};
function citations() {
  const changedPaths = new Set(read('changed.json').real.map(r => r.p.toLowerCase()));
  const cache = new Map(), tally = {231: {}, 25: {}}, failures = [];
  for (const {id, ref, fact} of refs) {
    const d = depotOf(ref.jsonPath);
    if (!d || !changedPaths.has(d.depot.toLowerCase()) || /cooked_journal|onscreens/.test(ref.jsonPath) || !ref.jsonPointer) continue;
    for (const g of ['231', '25']) {
      const file = effectiveJson(g, d.depot);
      let result = 'ok';
      if (!file) result = 'missing resource';
      else {
        if (!cache.has(file)) cache.set(file, load(file));
        const node = resolvePointer(cache.get(file), ref.jsonPointer);
        if (node === undefined) result = 'pointer unresolved';
        else if (ref.expectedType && node.$type !== ref.expectedType) result = 'type ' + node.$type;
        else {
          for (const [pointer, want] of Object.entries(ref.expected || {})) {
            const got = scalar(resolvePointer(node, pointer));
            if (JSON.stringify(got) !== JSON.stringify(want) && String(got) !== String(want)) { result = 'expected ' + pointer; break; }
          }
          if (result === 'ok' && fact && (scalar(node.factName) !== fact || (ref.setExactValue !== undefined && node.setExactValue !== ref.setExactValue && node.value !== ref.value))) result = 'writer differs';
        }
      }
      tally[g][result.split(' ')[0]] = (tally[g][result.split(' ')[0]] || 0) + 1;
      if (result !== 'ok' && g === '25') failures.push([id, ref.jsonPointer, result]);
    }
  }
  save('citations.json', {tally, failures});
  console.log(JSON.stringify({tally, failuresOnGame25: failures.length}));
  failures.slice(0, 20).forEach(f => console.log(' ', f.join(' | ')));
}

function journalTree(file) {
  const doc = load(file), handles = new Map();
  (function walk(v, ptr) {
    if (Array.isArray(v)) return v.forEach((x, i) => walk(x, ptr + '/' + i));
    if (!v || typeof v !== 'object') return;
    if (v.HandleId !== undefined && v.Data) handles.set(String(v.HandleId), [ptr + '/Data', v.Data]);
    for (const [k, x] of Object.entries(v)) walk(x, ptr + '/' + k);
  })(doc, '');
  const byPath = new Map(), byPointer = new Map();
  (function entry(holder, prefix) {
    const [pointer, e] = handles.get(String(holder.HandleId ?? holder.HandleRefId));
    const id = scalar(e.id), parts = id ? [...prefix, id] : prefix;
    byPath.set(parts.join('/'), e); byPointer.set(pointer, parts.join('/'));
    for (const child of e.entries || []) entry(child, parts);
  })(doc.Data.RootChunk.entry, []);
  return {byPath, byPointer};
}
// The base journal (base archive), the copy of it the Phantom Liberty archive carries, and the expansion's own journal.
const journalFiles = g => ['x' + g + '/base/base/journal/cooked_journal.journal.json', 'x' + g + '/ep1/base/journal/cooked_journal.journal.json', 'x' + g + '/ep1/ep1/journal/cooked_journal.journal.json'];
function journal() {
  const trees = {};
  for (const g of ['231', '25']) {
    const merged = new Map();
    for (const rel of journalFiles(g)) { const f = path.join(WORK, rel); if (fs.existsSync(f)) for (const [k, v] of journalTree(f).byPath) merged.set(k, v); }
    trees[g] = merged;
  }
  let missing = 0, wrongClass = 0;
  for (const row of Object.values(pack.journalAllowlist)) {
    const e = trees['25'].get(row.nativePath);
    if (!e) missing++; else if (e.$type !== row.nativeClass) wrongClass++;
  }
  // Journal evidence is cited by position, which moves when entries are inserted: compare the entry the 2.31 pointer names, by path.
  const normal = e => JSON.stringify(Object.fromEntries(Object.entries(e).filter(([k]) => !['entries', 'journalEntryOverrideDataList'].includes(k)))).replace(/"Handle(Ref)?Id":"[0-9]+"/g, '"H":"0"');
  const kind = j => j.includes('raw/ep1/ep1/journal') ? 2 : j.includes('raw/ep1/base/journal') ? 1 : 0;
  const file = (g, k) => path.join(WORK, journalFiles(g)[k]);
  const cache = {};
  const tree = (g, k) => cache[g + k] ??= journalTree(file(g, k));
  let cited = 0, identical = 0; const different = [];
  for (const {id, ref} of refs) {
    if (!/cooked_journal\.journal\.json$/.test(ref.jsonPath) || !ref.jsonPointer) continue;
    cited++;
    const k = kind(ref.jsonPath), a = tree('231', k), b = tree('25', k);
    let pointer = ref.jsonPointer, at = a.byPointer.get(pointer);
    while (!at && ['id', '$type', 'name', 'className'].includes(pointer.slice(pointer.lastIndexOf('/') + 1))) { pointer = pointer.slice(0, pointer.lastIndexOf('/')); at = a.byPointer.get(pointer); }
    const x = at && a.byPath.get(at), y = at && b.byPath.get(at);
    if (x && y && x.$type === y.$type && normal(x) === normal(y)) identical++; else different.push([id, at || ref.jsonPointer]);
  }
  console.log(JSON.stringify({journalEntries: {231: trees['231'].size, 25: trees['25'].size}, allowlistedByPath: Object.keys(pack.journalAllowlist).length,
    missingOn25: missing, classChangedOn25: wrongClass, journalEvidenceRefs: cited, identicalEntryOn25: identical, different: different.length}));
  different.slice(0, 20).forEach(d => console.log(' ', d.join(' | ')));
}

function localization() {
  const byKey = (g, rel) => { const doc = load(path.join(WORK, 'loc' + g, rel)); return new Map(doc.Data.RootChunk.root.Data.entries.map(e => [String(e.primaryKey), e])); };
  const docs = {};
  let cited = 0, identical = 0; const different = [];
  for (const {id, ref} of refs) {
    if (!/onscreens/.test(ref.jsonPath) || !ref.jsonPointer) continue;
    cited++;
    const rel = (ref.jsonPath.includes('raw/ep1/ep1/') ? 'ep1/ep1/' : 'content/base/') + 'localization/en-us/onscreens/' + ref.jsonPath.split('/onscreens/')[1];
    const a = (docs['231' + rel] ??= load(path.join(WORK, 'loc231', rel))).Data.RootChunk.root.Data.entries[+ref.jsonPointer.match(/entries\/(\d+)$/)[1]];
    const b = (docs['25' + rel] ??= byKey('25', rel)).get(String(a.primaryKey));
    if (b && JSON.stringify(a) === JSON.stringify(b)) identical++; else different.push([id, a.primaryKey]);
  }
  console.log(JSON.stringify({citedOnScreenStrings: cited, identicalOnGame25: identical, different: different.length}));
}

const stages = {cited, changed, extract, facts, citations, journal, localization};
if (!stages[stage]) { console.error('stage: ' + Object.keys(stages).join(' | ')); process.exit(2); }
stages[stage]();
