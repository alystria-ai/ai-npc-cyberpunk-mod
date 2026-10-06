// The research agent's listening report as data: columns, scores, per-voice lines and audio lookup. Read only.
//
// Sources (E:/CyberpunkConvai-offload/work/likeness-phase1 by default, never written):
//   page/index.html        column order, titles and header scores of the curated listening page
//   out/summary-table.md   PLS / ECAPA guard / WER per condition (the numbers shown under each column header)
//   out/gen/<cond>/<voice>__<line>.wav and page/audio/<cond>/<voice>.wav   the audio itself (line 0 on the page)
//   out/panel.json         the two held-out game lines per voice (text)
//   out/scores_per_speaker.json   per-voice ECAPA where it was measured 
// Columns are discovered on every scan, so new conditions show up as soon as their
// files land. Only conditions on the allowlist below are columns at all; every other render directory (research
// leftovers, LoRA, loudness-matched, codec round trips, ...) is ignored: it gets no column and no placeholder.
import {existsSync, readdirSync, readFileSync, statSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

// The voices the page shows (a plain JSON array of keys, also read by the Python render scripts). Everything else stays
// reachable through the API but never becomes a row.
export const SHOWN_VOICES_FILE = join(dirname(fileURLToPath(import.meta.url)), 'shown-voices.json');
export const defaultShownVoices = () => JSON.parse(readFileSync(SHOWN_VOICES_FILE, 'utf8'));
// undefined -> the file; null or an empty list -> no restriction (null result); otherwise the given keys as a Set.
export function resolveShown(list) {
  const keys = list === undefined ? defaultShownVoices() : list;
  return keys?.length ? new Set(keys) : null;
}

export const GROUPS = Object.freeze([
  {id: 'standard', label: 'Standard', shown: true},
  {id: 'clips', label: 'Multi-clip references', shown: true},
  {id: 'decoder', label: 'New Mimi decoder', shown: true},
]);
export const ORIGINAL = 'REAL-target-copy';
// What the "Recommended" quick filter shows (besides the Original column).
export const RECOMMENDED = Object.freeze(['ft6-s5000raw__decA_multiB', 'omni__s16_g2_multiB', 'omni__s32_g2_multiB']);
const RECOMMENDED_SET = new Set(RECOMMENDED);

const unescapeHtml = text => text.replace(/<[^>]*>/g, '').replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
const number = text => { const value = Number.parseFloat(text); return Number.isFinite(value) ? value : null; };

// Variant of a render condition, so Pocket and OmniVoice line up as "1 clip | 2 clips (10 s) | 3 clips (18 s)".
export const VARIANT_LABELS = {single: '1 clip', two: '2 clips (10 s)', three: '3 clips (18 s)'};
const MATRIX_VARIANTS = ['single', 'two', 'three'];
const VARIANT_ORDER = ['single', 'two', 'three'];
const LETTER_VARIANT = {C: 'two', B: 'three'};
// The allowlist: one pattern per family. Group 1 is the multi-clip letter (B = 18 s, C = 10 s).
const FAMILIES = [
  {family: 'pocket', label: 'Pocket student, old decoder', rank: 3, pattern: /^ft6-s5000raw__(?:cfg1|multi([BC]))$/, group: 'standard'},
  {family: 'pocket-dec', label: 'Pocket student, new decoder', rank: 4, pattern: /^ft6-s5000raw__decA(?:_multi([BC]))?$/, group: 'decoder'},
  {family: 'pocket-dec2', label: 'Pocket new decoder v2', rank: 4.5, pattern: /^ft6-s5000raw__decv2(?:_multi([BC]))?$/, group: 'decoder'},
  {family: 'omni16', label: 'OmniVoice 16 steps', rank: 5, pattern: /^omni__s16_g2(?:_multi([BC]))?$/, group: 'standard'},
  {family: 'omni32', label: 'OmniVoice 32 steps', rank: 6, pattern: /^omni__s32_g2(?:_multi([BC]))?$/, group: 'standard'},
];
const FIXED = {[ORIGINAL]: {family: 'original', familyLabel: 'Original', rank: 0}, 'base6-2609__cfg1': {family: 'pocket-base', familyLabel: 'Pocket base', rank: 1}};

// {allowed, family, familyLabel, variant, rank, group}. allowed is false for everything not on the allowlist.
export function classify(cond) {
  const fixed = FIXED[cond];
  if (fixed) return {...fixed, allowed: true, variant: 'single', group: 'standard'};
  for (const item of FAMILIES) {
    const match = item.pattern.exec(cond);
    if (!match) continue;
    const [, letter] = match, variant = LETTER_VARIANT[letter] ?? 'single';
    return {allowed: true, family: item.family, familyLabel: item.label, variant, rank: item.rank, group: letter ? (item.group === 'decoder' ? 'decoder' : 'clips') : item.group};
  }
  return {allowed: false, family: cond, familyLabel: '', variant: 'single', rank: 99, group: null};
}
// Group id of a condition, or null when it is not shown at all.
export const groupOf = cond => classify(cond).group;

export function parseSummary(markdown) {
  const rows = new Map();
  for (const line of markdown.split(/\r?\n/)) {
    const cells = line.split('|').slice(1, -1).map(cell => cell.trim());
    if (cells.length < 5 || cells[0] === 'Variant' || /^-+$/.test(cells[0])) continue;
    rows.set(cells[1], {variant: cells[0], pls: number(cells[2]), ecapa: number(cells[3]), wer: number(cells[4])});
  }
  return rows;
}

// Header cells of the page table in order, paired with the audio conditions of its first row.
export function parsePage(html) {
  const headRow = html.match(/<tr>\s*<th class="v">[\s\S]*?<\/tr>/)?.[0] ?? '';
  const headers = [...headRow.matchAll(/<th(?: [^>]*)?>([\s\S]*?)<\/th>/g)].slice(1).map(match => {
    const [, inner] = match, meta = inner.match(/<div class="m">([\s\S]*?)<\/div>/)?.[1] ?? '';
    return {title: unescapeHtml(inner.replace(/<div[\s\S]*$/, '')), meta: unescapeHtml(meta)};
  });
  const body = html.slice(html.indexOf('</tr>') + 5);
  const firstRow = body.match(/<tr>[\s\S]*?<\/tr>/)?.[0] ?? '';
  const conds = [...firstRow.matchAll(/src="audio\/([^/"]+)\//g)].map(match => match[1]);
  return conds.map((cond, at) => ({cond, ...(headers[at] ?? {title: '', meta: ''})}));
}

const readJsonLoose = path => JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, '').replace(/\bNaN\b/g, 'null').replace(/-?\bInfinity\b/g, 'null'));
const listDirs = path => existsSync(path) ? readdirSync(path, {withFileTypes: true}).filter(entry => entry.isDirectory()).map(entry => entry.name) : [];

export class Research {
  constructor({root, ttlMs = 15_000, shownVoices}) {
    this.root = root; this.ttlMs = ttlMs; this.cache = null; this.cachedAt = 0; this.shown = resolveShown(shownVoices);
  }
  get enabled() { return !!this.root && existsSync(join(this.root, 'out', 'gen')); }
  scan(force = false) {
    if (!force && this.cache && Date.now() - this.cachedAt < this.ttlMs) return this.cache;
    this.cache = this.enabled ? this.build() : {enabled: false, columns: [], voices: {}, groups: GROUPS, recommended: [...RECOMMENDED_SET], audio: new Map(), scanned: new Date().toISOString()};
    this.cachedAt = Date.now();
    return this.cache;
  }
  build() {
    const {root} = this, gen = join(root, 'out', 'gen'), pageAudio = join(root, 'page', 'audio');
    const read = (path, fallback) => { try { return readFileSync(path, 'utf8'); } catch { return fallback; } };
    // Header scores: averages over the shown voices when out/summary-table-shown.md exists (same format as
    // summary-table.md), else the research agent's table over all evaluation voices. Columns come from both.
    const fullSummary = parseSummary(read(join(root, 'out', 'summary-table.md'), ''));
    const shownSummary = parseSummary(read(join(root, 'out', 'summary-table-shown.md'), ''));
    const scoresShown = shownSummary.size > 0, summary = scoresShown ? shownSummary : fullSummary;
    const page = parsePage(read(join(root, 'page', 'index.html'), ''));
    const panel = (() => { try { return readJsonLoose(join(root, 'out', 'panel.json')); } catch { return {}; } })();
    const readOptional = name => { try { return readJsonLoose(join(root, 'out', name)); } catch { return {}; } };
    const perSpeaker = readOptional('scores_per_speaker.json');

    // audio index: cond -> Set("voice|line")
    const audio = new Map();
    const add = (cond, voice, line) => { if (!audio.has(cond)) audio.set(cond, new Set()); audio.get(cond).add(`${voice}|${line}`); };
    for (const cond of listDirs(gen).filter(name => classify(name).allowed)) {
      for (const file of readdirSync(join(gen, cond))) {
        const match = /^(.+)__(\d+)\.wav$/.exec(file);
        if (match) add(cond, match[1], Number(match[2]));
      }
    }
    for (const cond of listDirs(pageAudio).filter(name => classify(name).allowed)) {
      for (const file of readdirSync(join(pageAudio, cond))) {
        const match = /^(.+)\.wav$/.exec(file);
        if (match && !audio.get(cond)?.has(`${match[1]}|0`)) add(cond, match[1], 0);
      }
    }

    // columns: page order, then table rows not on the page, then anything else on the allowlist (new renders)
    const ordered = [], seen = new Set();
    const push = (cond, title, source) => { if (!seen.has(cond) && audio.has(cond)) { seen.add(cond); ordered.push({cond, title, source}); } };
    for (const item of page) push(item.cond, item.title, 'page');
    for (const [cond, row] of new Map([...fullSummary, ...shownSummary])) push(cond, row.variant, 'table');
    for (const cond of [...audio.keys()].sort()) push(cond, cond, 'discovered');

    const raw = ordered.map(({cond, title, source}) => {
      const row = summary.get(cond), header = page.find(item => item.cond === cond);
      const metaText = scoresShown ? '' : header?.meta ?? '';      // the page's own scores are over all voices
      const metrics = {pls: row?.pls ?? number(/PLS\s*([\d.]+)/.exec(metaText)?.[1]), ecapa: row?.ecapa ?? number(/guard\s*([\d.]+)/.exec(metaText)?.[1]),
        wer: row?.wer ?? number(/WER\s*([\d.]+)%/.exec(metaText)?.[1])};            // WER in percent
      const info = classify(cond), inMatrix = info.rank >= 3;
      const voices = [...audio.get(cond)].map(key => key.split('|')[0]);
      return {cond, title: inMatrix ? `${info.familyLabel}, ${VARIANT_LABELS[info.variant]}` : info.familyLabel, group: info.group, source, metrics, voices: new Set(voices).size,
        have: audio.get(cond), family: info.family, variant: info.variant, role: cond === ORIGINAL ? 'original' : undefined,
        recommended: RECOMMENDED_SET.has(cond), spanLabel: inMatrix ? info.familyLabel : '', label: inMatrix ? VARIANT_LABELS[info.variant] : info.familyLabel,
        sort: [info.rank, VARIANT_ORDER.indexOf(info.variant)]};
    });
    // Keep the 1 | 2 | 3 blocks aligned: a variant that has not been rendered yet shows as an empty column.
    for (const item of FAMILIES.filter(entry => !entry.family.startsWith('pocket-dec'))) {
      for (const variant of MATRIX_VARIANTS) {
        if (raw.some(column => column.family === item.family && column.variant === variant)) continue;
        raw.push({cond: null, placeholder: true, title: `${item.label}, ${VARIANT_LABELS[variant]}`, group: variant === 'single' ? item.group : 'clips', source: 'placeholder',
          metrics: {pls: null, ecapa: null, wer: null}, voices: 0, family: item.family, variant, recommended: false, spanLabel: item.label, label: VARIANT_LABELS[variant],
          sort: [item.rank, VARIANT_ORDER.indexOf(variant)]});
      }
    }
    // Original, Pocket base, then the 1 | 2 | 3 blocks (Pocket old decoder, Pocket new decoder, OmniVoice 16, OmniVoice 32).
    raw.sort((a, b) => a.sort[0] - b.sort[0] || a.sort[1] - b.sort[1] || (a.cond ?? '').localeCompare(b.cond ?? ''));
    // `have` is null when a column covers every voice and line of the Original column, else the list that exists.
    const everything = audio.get('REAL-target-copy') ?? new Set();
    const columns = raw.map(({sort, have, ...column}) => ({...column,
      have: have && (have.size !== everything.size || [...everything].some(key => !have.has(key))) ? [...have] : null}));

    // voices and their lines
    const voices = {};
    for (const [cond, set] of audio) {
      for (const key of set) {
        const [voice, line] = key.split('|');
        const entry = voices[voice] ??= {lines: [], conditions: 0};
        entry.conditions += cond === 'REAL-target-copy' ? 1 : 0;
        void line;
      }
    }
    for (const [voice, entry] of Object.entries(voices)) {
      const targets = panel[voice]?.targets ?? [];
      entry.lines = targets.map((target, at) => ({index: at, text: target.transcript, split: target.split ?? null}));
      if (!entry.lines.length) entry.lines = [{index: 0, text: '', split: null}];
    }
    const ecapa = {};
    for (const column of columns.filter(item => item.cond)) {
      const scores = perSpeaker[column.cond];
      if (!scores) continue;
      const byVoice = {};
      for (const [voice, value] of Object.entries(scores)) if (typeof value?.ecapa === 'number') byVoice[voice] = Math.round(value.ecapa * 1000) / 1000;
      if (Object.keys(byVoice).length) ecapa[column.cond] = byVoice;
    }
    let latest = 0;
    for (const file of ['page/index.html', 'out/summary-table.md']) { try { latest = Math.max(latest, statSync(join(root, file)).mtimeMs); } catch { /* optional */ } }
    return {enabled: true, root, columns, voices, groups: GROUPS, recommended: [...RECOMMENDED_SET], ecapa, audio, scoresShown, evaluationVoices: Object.keys(panel).length || null, scanned: new Date().toISOString(), reportUpdated: latest ? new Date(latest).toISOString() : null};
  }
  // Absolute path of a research clip, or null.
  file(cond, voice, line) {
    const scan = this.scan();
    if (!/^[A-Za-z0-9_.-]+$/.test(cond) || !/^[a-z0-9][a-z0-9-]*$/.test(voice) || !Number.isInteger(line) || line < 0) return null;
    if (!scan.audio.get(cond)?.has(`${voice}|${line}`)) return null;
    const generated = join(this.root, 'out', 'gen', cond, `${voice}__${line}.wav`);
    if (existsSync(generated)) return generated;
    const onPage = join(this.root, 'page', 'audio', cond, `${voice}.wav`);
    return line === 0 && existsSync(onPage) ? onPage : null;
  }
  // JSON for the browser (no Sets).
  describe() {
    const scan = this.scan();
    return {enabled: scan.enabled, scanned: scan.scanned, reportUpdated: scan.reportUpdated ?? null, groups: scan.groups, recommended: scan.recommended ?? [], columns: scan.columns,
      scoresShown: !!scan.scoresShown, evaluationVoices: scan.evaluationVoices ?? null, shownVoices: this.shown?.size ?? null,
      voices: this.shown ? Object.fromEntries(Object.entries(scan.voices).filter(([key]) => this.shown.has(key))) : scan.voices, ecapa: scan.ecapa ?? {}};
  }
}
