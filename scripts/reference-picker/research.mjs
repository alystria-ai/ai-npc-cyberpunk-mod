// The research agent's listening report as data: columns, scores, per-voice lines and audio lookup. Read only.
//
// Sources (E:/CyberpunkConvai-offload/work/likeness-phase1 by default, never written):
//   page/index.html        column order, titles and header scores of the curated listening page
//   out/summary-table.md   PLS / ECAPA guard / WER per condition (the numbers shown under each column header)
//   out/gen/<cond>/<voice>__<line>.wav and page/audio/<cond>/<voice>.wav   the audio itself (line 0 on the page)
//   out/panel.json         the two held-out game lines per voice (text)
//   out/scores_per_speaker.json   per-voice ECAPA where it was measured
// Columns are discovered on every scan, so new conditions (for example Pocket through the new Mimi decoder) show up
// as soon as their files and table rows land. A condition that is on the page or in the table is a normal column;
// a name mentioning mimi/decoder is shown too; every other render directory is listed under "Other research renders".
import {existsSync, readdirSync, readFileSync, statSync} from 'node:fs';
import {join} from 'node:path';

export const GROUPS = Object.freeze([
  {id: 'standard', label: 'Standard', shown: true},
  {id: 'clips', label: 'Multi-clip references', shown: true},
  {id: 'auto', label: 'Auto-selected', shown: true},
  {id: 'decoder', label: 'New Mimi decoder', shown: true},
  {id: 'loud', label: 'Loudness-matched', shown: false},
  {id: 'lora', label: 'LoRA checkpoints', shown: false},
  {id: 'picks', label: 'Your picks', shown: true},
  {id: 'other', label: 'Other research renders', shown: false},
]);
const STANDARD = ['REAL-target-copy', 'base6-2609__cfg1', 'ft24-u1000raw__cfg2', 'ft6-s5000raw__cfg1', 'omni__s16_g2', 'omni__s32_g2'];
const STANDARD_TITLES = {'REAL-target-copy': 'Original', 'base6-2609__cfg1': 'Pocket base', 'ft24-u1000raw__cfg2': 'Pocket teacher FT',
  'ft6-s5000raw__cfg1': 'Pocket student FT', 'omni__s16_g2': 'OmniVoice 16', 'omni__s32_g2': 'OmniVoice 32'};

const unescapeHtml = text => text.replace(/<[^>]*>/g, '').replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
const number = text => { const value = Number.parseFloat(text); return Number.isFinite(value) ? value : null; };

// Family / variant of a render condition, so Pocket and OmniVoice line up as "1 clip | 2 clips (10 s) | 3 clips (18 s)".
export const VARIANT_LABELS = {single: '1 clip', two: '2 clips (10 s)', three: '3 clips (18 s)', auto: 'auto-selected',
  loud10: '2 clips (10 s), loudness-matched', loud18: '3 clips (18 s), loudness-matched', concat: 'runtime reference + clips'};
const MATRIX_VARIANTS = ['single', 'two', 'three'];
const VARIANT_ORDER = ['single', 'two', 'three', 'auto', 'loud10', 'loud18', 'concat'];
export function classify(cond, title = '') {
  const suffix = /(?:_|__)(multi[A-E])$/.exec(cond)?.[1] ?? (/_selected$/.test(cond) ? 'selected' : null);
  const fromSuffix = {multiB: 'three', multiC: 'two', multiD: 'loud18', multiE: 'loud10', multiA: 'concat', selected: 'auto'}[suffix];
  const fromTitle = /loudness-matched/i.test(title) ? (/18/.test(title) ? 'loud18' : 'loud10') : /auto-selected/i.test(title) ? 'auto'
    : /two-clip|2[- ]clip|10 ?s/i.test(title) ? 'two' : /three-clip|3[- ]clip|18 ?s/i.test(title) ? 'three' : null;
  const variant = fromSuffix ?? fromTitle ?? 'single';
  const base = cond.replace(/(?:_|__)(?:multi[A-E]|selected|cfg\d+)$/, '');
  if (cond === 'REAL-target-copy') return {family: 'original', familyLabel: 'Original', variant: 'single', rank: 0};
  if (cond === 'base6-2609__cfg1') return {family: 'pocket-base', familyLabel: 'Pocket base', variant: 'single', rank: 1};
  if (cond === 'ft24-u1000raw__cfg2') return {family: 'pocket-teacher', familyLabel: 'Pocket teacher FT', variant: 'single', rank: 2};
  if (/mimi|decoder/i.test(`${cond} ${title}`)) return {family: base, familyLabel: title.replace(/^NEW:\s*/i, '').replace(/\s*[+(].*$/, '') || base, variant, rank: 6};
  if (/^ft6-s5000raw__/.test(cond)) return {family: 'pocket', familyLabel: 'Pocket student FT', variant, rank: 3};
  if (/^omni__s16_g2/.test(cond)) return {family: 'omni16', familyLabel: 'OmniVoice 16 steps', variant, rank: 4};
  if (/^omni__s32_g2/.test(cond)) return {family: 'omni32', familyLabel: 'OmniVoice 32 steps', variant, rank: 5};
  return {family: base, familyLabel: '', variant, rank: 9};
}

export function groupOf(cond, title = '') {
  const text = `${cond} ${title}`;
  if (/mimi|decoder/i.test(text)) return 'decoder';
  if (STANDARD.includes(cond)) return 'standard';
  if (/lora/i.test(text)) return 'lora';
  if (/loud/i.test(text) || /_multi[DE]$/.test(cond)) return 'loud';
  if (/auto-selected|_selected$/i.test(text)) return 'auto';
  if (/multi[BC]$|three-clip|two-clip|3-clip/i.test(text)) return 'clips';
  return 'other';
}

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
  constructor({root, ttlMs = 15_000}) {
    this.root = root; this.ttlMs = ttlMs; this.cache = null; this.cachedAt = 0;
  }
  get enabled() { return !!this.root && existsSync(join(this.root, 'out', 'gen')); }
  scan(force = false) {
    if (!force && this.cache && Date.now() - this.cachedAt < this.ttlMs) return this.cache;
    this.cache = this.enabled ? this.build() : {enabled: false, columns: [], voices: {}, groups: GROUPS, audio: new Map(), scanned: new Date().toISOString()};
    this.cachedAt = Date.now();
    return this.cache;
  }
  build() {
    const {root} = this, gen = join(root, 'out', 'gen'), pageAudio = join(root, 'page', 'audio');
    const read = (path, fallback) => { try { return readFileSync(path, 'utf8'); } catch { return fallback; } };
    const summary = parseSummary(read(join(root, 'out', 'summary-table.md'), ''));
    const page = parsePage(read(join(root, 'page', 'index.html'), ''));
    const panel = (() => { try { return readJsonLoose(join(root, 'out', 'panel.json')); } catch { return {}; } })();
    const perSpeaker = (() => { try { return readJsonLoose(join(root, 'out', 'scores_per_speaker.json')); } catch { return {}; } })();

    // audio index: cond -> Set("voice|line")
    const audio = new Map();
    const add = (cond, voice, line) => { if (!audio.has(cond)) audio.set(cond, new Set()); audio.get(cond).add(`${voice}|${line}`); };
    for (const cond of listDirs(gen)) {
      for (const file of readdirSync(join(gen, cond))) {
        const match = /^(.+)__(\d+)\.wav$/.exec(file);
        if (match) add(cond, match[1], Number(match[2]));
      }
    }
    for (const cond of listDirs(pageAudio)) {
      for (const file of readdirSync(join(pageAudio, cond))) {
        const match = /^(.+)\.wav$/.exec(file);
        if (match && !audio.get(cond)?.has(`${match[1]}|0`)) add(cond, match[1], 0);
      }
    }

    // columns: page order, then table rows not on the page, then decoder renders, then everything else
    const ordered = [], seen = new Set();
    const push = (cond, title, source) => { if (!seen.has(cond) && audio.has(cond)) { seen.add(cond); ordered.push({cond, title, source}); } };
    for (const item of page) push(item.cond, item.title, 'page');
    for (const [cond, row] of summary) push(cond, row.variant, 'table');
    for (const cond of [...audio.keys()].sort()) if (/mimi|decoder/i.test(cond)) push(cond, cond, 'discovered');
    for (const cond of [...audio.keys()].sort()) push(cond, cond, 'other');

    const raw = ordered.map(({cond, title, source}) => {
      const row = summary.get(cond), header = page.find(item => item.cond === cond);
      const metaText = header?.meta ?? '';
      const metrics = {pls: row?.pls ?? number(/PLS\s*([\d.]+)/.exec(metaText)?.[1]), ecapa: row?.ecapa ?? number(/guard\s*([\d.]+)/.exec(metaText)?.[1]),
        wer: row?.wer ?? number(/WER\s*([\d.]+)%/.exec(metaText)?.[1])};            // WER in percent
      const clean = (STANDARD_TITLES[cond] ?? title.replace(/^NEW:\s*/i, '')).replace(/\s+/g, ' ');
      const onTable = source === 'page' || source === 'table';
      const group = onTable || source === 'discovered' ? groupOf(cond, clean) : groupOf(cond, clean) === 'decoder' ? 'decoder' : 'other';
      const info = classify(cond, clean);
      const inMatrix = info.familyLabel && MATRIX_VARIANTS.includes(info.variant) && info.rank >= 3 && ['standard', 'clips', 'decoder'].includes(group);
      const voices = [...audio.get(cond)].map(key => key.split('|')[0]);
      return {cond, title: clean, group, source, metrics, voices: new Set(voices).size, have: audio.get(cond), family: info.family, variant: info.variant,
        spanLabel: inMatrix ? info.familyLabel : '', label: inMatrix ? VARIANT_LABELS[info.variant] : clean,
        sort: [inMatrix || info.rank < 3 ? info.rank : 7 + (group === 'auto' ? 0 : group === 'loud' ? 1 : group === 'lora' ? 2 : 3), info.family, VARIANT_ORDER.indexOf(info.variant)]};
    });
    // Keep the 1 | 2 | 3 blocks aligned: a variant that has not been rendered yet shows as an empty column.
    for (const [family, label, rank] of [['pocket', 'Pocket student FT', 3], ['omni16', 'OmniVoice 16 steps', 4], ['omni32', 'OmniVoice 32 steps', 5]]) {
      for (const variant of MATRIX_VARIANTS) {
        if (raw.some(item => item.family === family && item.variant === variant && item.spanLabel)) continue;
        raw.push({cond: null, placeholder: true, title: `${label}, ${VARIANT_LABELS[variant]}`, group: variant === 'single' ? 'standard' : 'clips', source: 'placeholder',
          metrics: {pls: null, ecapa: null, wer: null}, voices: 0, family, variant, spanLabel: label, label: VARIANT_LABELS[variant],
          sort: [rank, family, VARIANT_ORDER.indexOf(variant)]});
      }
    }
    // Original, Pocket base, Pocket teacher FT, then the 1 | 2 | 3 blocks (Pocket, OmniVoice 16, OmniVoice 32, any new
    // Mimi-decoder Pocket), then auto-selected, loudness-matched, LoRA and everything else.
    raw.sort((a, b) => a.sort[0] - b.sort[0] || (a.sort[0] === 6 || a.sort[0] >= 7 ? a.family.localeCompare(b.family) : 0) || a.sort[2] - b.sort[2] || (a.cond ?? '').localeCompare(b.cond ?? ''));
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
    return {enabled: true, root, columns, voices, groups: GROUPS, ecapa, audio, scanned: new Date().toISOString(), reportUpdated: latest ? new Date(latest).toISOString() : null};
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
    return {enabled: scan.enabled, scanned: scan.scanned, reportUpdated: scan.reportUpdated ?? null, groups: scan.groups, columns: scan.columns,
      voices: scan.voices, ecapa: scan.ecapa ?? {}};
  }
}
