'use strict';
// Voice report: the research listening report with the reference controls in the same row. Rows build lazily as you
// scroll, audio elements never preload, and every action updates the page in place (no reloads, no scroll jumps).

const $ = selector => document.querySelector(selector);
function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key in el && key !== 'list' && key !== 'colspan' && key !== 'rowspan') el[key] = value;
    else el.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) if (child !== null && child !== undefined && child !== false) el.append(child.nodeType ? child : document.createTextNode(String(child)));
  return el;
}
// replaceChildren that drops false/null/undefined and flattens lists (the native one would print "false").
function fill(el, ...children) {
  el.replaceChildren(...children.flat(Infinity).filter(child => child !== null && child !== undefined && child !== false)
    .map(child => child.nodeType ? child : document.createTextNode(String(child))));
  return el;
}
const store = {
  get(key, fallback) { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } },
  set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private window */ } },
};

// The four clip sets of a voice (each with its own reroll, hand-picking, renders, Keep and Reject) and the renders they feed.
const SETS = {
  pocket: {label: 'Pocket · 18 s', budget: 18, slots: ['pocket'], engine: 'Pocket'},
  'pocket-short': {label: 'Pocket · 10 s', budget: 10, slots: ['pockets'], engine: 'Pocket'},
  omni: {label: 'OmniVoice · 18 s', budget: 18, slots: ['omni16', 'omni32'], engine: 'OmniVoice'},
  'omni-short': {label: 'OmniVoice · 10 s', budget: 10, slots: ['omni16s', 'omni32s'], engine: 'OmniVoice'},
};
const PICKS = [
  {slot: 'pocket', set: 'pocket', label: 'Pocket · 18 s set'}, {slot: 'pockets', set: 'pocket-short', label: 'Pocket · 10 s set'},
  {slot: 'omni16', set: 'omni', label: 'OmniVoice 16 · 18 s set'}, {slot: 'omni32', set: 'omni', label: 'OmniVoice 32 · 18 s set'},
  {slot: 'omni16s', set: 'omni-short', label: 'OmniVoice 16 · 10 s set'}, {slot: 'omni32s', set: 'omni-short', label: 'OmniVoice 32 · 10 s set'},
];
const SLOT_LABEL = Object.fromEntries(PICKS.map(item => [item.slot, item.label]));
const MATRIX_GROUPS = new Set(['standard', 'clips', 'decoder']);
const STATE_TEXT = {missing: 'not rendered for this set', queued: 'queued', running: 'rendering…', 'gpu-busy': 'GPU busy, queued', error: 'failed'};

const state = {research: null, summary: [], entries: new Map(), order: [], rendered: 0, groups: {}, columns: [], current: null, queue: null, observer: null};

// ---- small helpers ----------------------------------------------------------------------------------------------------
const shortId = id => id.startsWith('live:') ? "today's reference" : id.split('/').slice(1).join('/');
const seconds = value => `${Number(value).toFixed(1)} s`;
const timeOf = ts => ts ? new Date(ts).toLocaleString([], {month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'}) : 'start';
let toastTimer;
function toast(message, {bad = false, undo = null} = {}) {
  const el = $('#toast'), button = $('#toast-undo');
  $('#toast-text').textContent = message; el.hidden = false; el.classList.toggle('err', bad);
  button.hidden = !undo; button.onclick = undo ? () => { el.hidden = true; undo(); } : null;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.hidden = true; }, bad ? 8000 : undo ? 7000 : 3500);
}
async function api(path, body) {
  const response = await fetch(path, body === undefined ? {cache: 'no-store'} : {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(body)});
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Error(data.error || `Request failed (${response.status})`);
  return data;
}
const metricsText = metrics => [metrics.pls != null && `PLS ${metrics.pls.toFixed(metrics.pls % 1 ? 1 : 0)}`, metrics.ecapa != null && `ECAPA ${metrics.ecapa.toFixed(2)}`,
  metrics.wer != null && `WER ${metrics.wer.toFixed(1)}%`].filter(Boolean).join(' · ');

// ---- audio: one at a time, every play logged, keyboard control -------------------------------------------------------
function audioEl(url, dataset) { return h('audio', {controls: true, preload: 'none', src: url, dataset}); }
document.addEventListener('play', event => {
  const audio = event.target;
  if (!(audio instanceof HTMLAudioElement)) return;
  for (const other of document.querySelectorAll('audio')) if (other !== audio && !other.paused) other.pause();
  const cell = audio.closest('td.cell');
  if (cell) markCurrent(cell);
  const {voice, what, target} = audio.dataset;
  if (voice && what) api(`/api/play/${voice}`, {what, target}).catch(() => {});
}, true);
function markCurrent(cell) {
  state.current?.classList.remove('now');
  state.current = cell; cell?.classList.add('now');
}
const visibleCells = row => [...row.querySelectorAll('td.cell')].filter(cell => cell.offsetParent !== null && cell.querySelector('audio'));
function playCell(cell) {
  const audio = cell?.querySelector('audio');
  if (!audio) return;
  markCurrent(cell); cell.scrollIntoView({block: 'nearest', inline: 'nearest'});
  audio.currentTime = 0; audio.play().catch(() => {});
}
document.addEventListener('keydown', event => {
  const target = event.target;
  if (event.ctrlKey || event.metaKey || event.altKey || target.closest?.('input, textarea, select, [contenteditable]')) return;
  if (target.closest?.('button') && event.key === ' ') return;
  const cell = target.closest?.('td.cell') ?? state.current;
  if (event.key === ' ' && (target.closest?.('td.cell') || target instanceof HTMLAudioElement || state.current)) {
    const audio = cell?.querySelector('audio');
    if (!audio) return;
    event.preventDefault();
    if (audio.paused) { markCurrent(cell); audio.play().catch(() => {}); } else audio.pause();
    return;
  }
  if (!cell || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
  const row = cell.parentElement, cells = visibleCells(row), at = cells.indexOf(cell);
  let next = null;
  if (event.key === 'ArrowRight') next = cells[at + 1] ?? cells[0];
  else if (event.key === 'ArrowLeft') next = cells[at - 1] ?? cells.at(-1);
  else {
    const rowsNow = () => [...document.querySelectorAll('tbody.voice')].filter(body => body.offsetParent !== null);
    let rows = rowsNow(), index = rows.indexOf(row.parentElement);
    if (event.key === 'ArrowDown' && index === rows.length - 1 && state.rendered < state.order.length) { renderMore(3); rows = rowsNow(); }
    const neighbour = rows[index + (event.key === 'ArrowDown' ? 1 : -1)];
    if (neighbour) next = neighbour.querySelector(`td.cell[data-col="${cell.dataset.col}"]`);
  }
  if (next?.querySelector('audio')) { event.preventDefault(); playCell(next); next.focus({preventScroll: true}); }
});

// ---- columns -------------------------------------------------------------------------------------------------------------
function buildColumns() {
  const research = state.research?.columns ?? [];
  const lastMatrix = research.map(col => MATRIX_GROUPS.has(col.group)).lastIndexOf(true);
  const picks = PICKS.map(item => ({id: `p:${item.slot}`, pick: item, group: 'picks', spanLabel: 'Your picks', label: item.label, title: item.label, metrics: {}}));
  const columns = research.map(col => ({...col, id: col.cond ? `c:${col.cond}` : `x:${col.family}:${col.variant}`}));
  columns.splice(lastMatrix + 1, 0, ...picks);
  state.columns = columns;
}
const groupShown = id => state.groups[id] ?? true;
function renderGroups() {
  const box = $('#groups');
  const groups = [...(state.research?.groups ?? [])];
  fill(box, h('span', {class: 'muted'}, 'Columns:'), ...groups.map(group => {
    const count = state.columns.filter(col => col.group === group.id && !col.placeholder).length;
    if (group.id !== 'picks' && !count) return null;
    return h('button', {class: 'chip', 'aria-pressed': String(groupShown(group.id)), title: `${groupShown(group.id) ? 'Hide' : 'Show'} ${group.label}`,
      onclick: () => { state.groups[group.id] = !groupShown(group.id); store.set('groups', state.groups); applyGroups(); }}, `${group.label}${group.id === 'picks' ? '' : ` (${count})`}`);
  }));
}
function applyGroups() {
  let css = '';
  for (const group of state.research?.groups ?? []) if (!groupShown(group.id)) css += `.report .g-${group.id}{display:none}\n`;
  $('#group-style').textContent = css;
  renderGroups(); renderHead();
}
function renderHead() {
  const visible = state.columns.filter(col => groupShown(col.group));
  const first = h('tr', {}, h('th', {class: 'voicecell', rowspan: 2}, 'Voice and game line'));
  const second = h('tr');
  for (let at = 0; at < visible.length;) {
    const col = visible[at];
    if (!col.spanLabel) {
      first.append(h('th', {rowspan: 2, class: `g-${col.group}`, title: col.title}, col.label, h('div', {class: 'm'}, metricsText(col.metrics))));
      at++; continue;
    }
    let end = at;
    while (end < visible.length && visible[end].spanLabel === col.spanLabel) end++;
    first.append(h('th', {colspan: end - at, class: 'span'}, col.spanLabel));
    for (const item of visible.slice(at, end)) second.append(h('th', {title: item.title}, item.label, h('div', {class: 'm'}, item.placeholder ? 'not rendered yet' : metricsText(item.metrics))));
    at = end;
  }
  $('#thead').replaceChildren(first, second);
  requestAnimationFrame(() => document.documentElement.style.setProperty('--head-row', `${first.getBoundingClientRect().height}px`));
}

// ---- rows ---------------------------------------------------------------------------------------------------------------
function entryFor(voice) {
  let entry = state.entries.get(voice.key);
  if (entry) { entry.summary = voice; return entry; }
  entry = {key: voice.key, summary: voice, line: 0, card: null, open: false, tab: 'omni', prev: {}, pending: false, tbody: h('tbody', {class: 'voice', id: `voice-${voice.key}`})};
  state.entries.set(voice.key, entry);
  buildRow(entry);
  if (voice.picker) loadCard(entry).catch(() => {});
  return entry;
}
function linesOf(entry) {
  const research = state.research?.voices[entry.key]?.lines ?? [];
  const lines = entry.card?.lines?.length ? entry.card.lines.map(line => ({index: line.index, text: line.text})) : research;
  return lines.length ? lines : [{index: 0, text: entry.card?.text ?? ''}];
}
function buildRow(entry) {
  const key = entry.key, voice = entry.summary;
  entry.main = h('tr', {class: 'main'});
  entry.refs = h('tr', {class: 'refs', hidden: true});
  entry.tbody.replaceChildren(entry.main, entry.refs);
  entry.left = h('td', {class: 'voicecell'});
  rebuildCells(entry);
  renderLeft(entry);
  void key; void voice;
}
function hasAudio(entry, col) {
  if (col.placeholder || !col.cond) return false;
  const voices = state.research?.voices[entry.key];
  if (!voices) return false;
  const lineKey = `${entry.key}|${entry.line}`;
  return col.have ? col.have.includes(lineKey) : entry.line < voices.lines.length;
}
function rebuildCells(entry) {
  const cells = [entry.left];
  entry.cells = new Map();
  for (const col of state.columns) {
    const td = h('td', {class: `cell g-${col.group}${col.pick ? ' pick group-picks' : ''}`, tabIndex: 0, dataset: {col: col.id}});
    entry.cells.set(col.id, td); cells.push(td);
    if (!col.pick) {
      if (hasAudio(entry, col)) {
        td.append(audioEl(`/audio/research/${col.cond}/${entry.key}/${entry.line}`, {voice: entry.key, what: 'research', target: col.cond}));
        const ecapa = state.research.ecapa?.[col.cond]?.[entry.key];
        if (ecapa != null) td.append(h('div', {class: 'cap', title: 'ECAPA speaker similarity for this voice (average of its lines)'}, `ECAPA ${ecapa.toFixed(2)}`));
      } else { td.classList.add('na'); td.textContent = col.placeholder ? 'not rendered yet' : state.research?.voices[entry.key] ? '–' : ''; }
    }
  }
  entry.main.replaceChildren(...cells);
  renderPickCells(entry);
}

function renderLeft(entry) {
  const voice = entry.summary, key = entry.key, card = entry.card, lines = linesOf(entry);
  const verdict = card ? card.verdict?.value ?? null : voice.verdict;
  entry.tbody.classList.toggle('verdict-bad', verdict === 'bad');
  entry.tbody.classList.toggle('verdict-fine', verdict === 'fine');
  const badges = [
    ...(card ? Object.keys(card.kept) : voice.kept).map(engine => h('span', {class: 'badge good', title: `Kept ${engine}`}, `${SETS[engine]?.label ?? engine} kept`)),
    (card ? card.rejected.length : voice.rejected) > 0 && h('span', {class: 'badge bad'}, `${card ? card.rejected.length : voice.rejected} rejected`),
    entry.working && h('span', {class: 'badge busy'}, entry.working),
  ];
  fill(entry.left,
    h('div', {class: 'vname'}, voice.name),
    h('div', {class: 'vline', title: 'The held-out game line every sample in this row says'}, lines[entry.line]?.text ? `“${lines[entry.line].text}”` : ''),
    !state.research?.voices[entry.key] && h('div', {class: 'meta'}, 'No research audio for this voice yet.'),
    lines.length > 1 && h('div', {class: 'vtools'}, h('span', {class: 'muted'}, 'Line'), lines.map(line => h('button', {class: 'small' + (line.index === entry.line ? ' primary' : ''), 'aria-pressed': String(line.index === entry.line),
      onclick: () => setLine(entry, line.index)}, String(line.index + 1)))),
    h('div', {class: 'vtools'},
      h('button', {class: 'small' + (verdict === 'fine' ? ' good' : ''), 'aria-pressed': String(verdict === 'fine'), onclick: () => setVerdict(entry, 'fine')}, verdict === 'fine' ? '✓ Sounds fine' : 'Sounds fine'),
      h('button', {class: 'small' + (verdict === 'bad' ? ' bad' : ''), 'aria-pressed': String(verdict === 'bad'), onclick: () => setVerdict(entry, 'bad')}, verdict === 'bad' ? '✗ Bad, fix references' : 'Bad, fix references')),
    h('div', {class: 'vtools'},
      h('button', {class: 'small', onclick: () => playRow(entry), title: 'Play the visible samples of this row one after another'}, '▶ Play row'),
      voice.picker ? h('button', {class: 'small' + (entry.open ? ' primary' : ''), 'aria-expanded': String(entry.open), onclick: () => togglePanel(entry)}, entry.open ? 'Reference clips ▴' : 'Reference clips ▾')
        : h('span', {class: 'muted'}, 'no reference panel')),
    h('div', {class: 'vtools'}, badges.filter(Boolean)));
}
function playRow(entry) {
  const cells = visibleCells(entry.main);
  let at = 0;
  const next = () => {
    const cell = cells[at++];
    if (!cell) return;
    cell.querySelector('audio').addEventListener('ended', next, {once: true});
    playCell(cell);
  };
  next();
}

async function setLine(entry, line) {
  entry.line = line;
  rebuildCells(entry); renderLeft(entry);
  await loadCard(entry);
}
async function setVerdict(entry, value) {
  const previous = (entry.card ? entry.card.verdict?.value : entry.summary.verdict) ?? '';
  const next = previous === value ? '' : value;
  const apply = verdict => { if (entry.card) entry.card.verdict = verdict ? {value: verdict} : null; entry.summary.verdict = verdict || null; renderLeft(entry); };
  apply(next);                                          // immediate feedback
  try { await api(`/api/voice/${entry.key}/verdict`, {value: next, line: entry.line}); } catch (error) { apply(previous); toast(error.message, {bad: true}); return; }
  toast(next === 'fine' ? `${entry.summary.name}: sounds fine` : next === 'bad' ? `${entry.summary.name}: bad, fix references` : 'Verdict cleared',
    {undo: async () => { apply(previous); await api(`/api/voice/${entry.key}/verdict`, {value: previous, line: entry.line}).catch(() => {}); }});
}

// ---- cards (the picker side of a row) ------------------------------------------------------------------------------------
async function loadCard(entry) {
  const card = await api(`/api/voice/${entry.key}?line=${entry.line}`);
  applyCard(entry, card);
}
function applyCard(entry, card) {
  entry.card = card;
  entry.working = card.job && ['queued', 'running', 'waiting-gpu'].includes(card.job.status)
    ? (card.job.status === 'waiting-gpu' ? 'GPU busy, queued' : card.job.status === 'running' ? `rendering ${card.job.done}/${card.job.total}` : 'queued') : null;
  entry.summary.verdict = card.verdict?.value ?? null; entry.summary.kept = Object.keys(card.kept); entry.summary.rejected = card.rejected.length;
  renderLeft(entry); renderPickCells(entry);
  if (entry.open) { if (entry.refs.querySelector('audio') && [...entry.refs.querySelectorAll('audio')].some(audio => !audio.paused)) entry.pending = true; else renderPanel(entry); }
}
document.addEventListener('pause', event => {
  const row = event.target.closest?.('tr.refs');
  const entry = row && [...state.entries.values()].find(item => item.refs === row);
  if (entry?.pending) { entry.pending = false; renderPanel(entry); }
}, true);

function renderPickCells(entry) {
  const card = entry.card;
  for (const item of PICKS) {
    const td = entry.cells.get(`p:${item.slot}`);
    if (!td) continue;
    const sample = card?.samples[item.slot], info = card?.sets[item.set];
    const was = entry.prev[item.slot];
    td.classList.toggle('busy', sample && ['queued', 'running', 'gpu-busy'].includes(sample.state));
    if (!entry.summary.picker) { fill(td, h('span', {class: 'muted'}, 'no reference panel')); td.classList.add('na'); continue; }
    if (!card) { fill(td, h('span', {class: 'muted'}, '…')); continue; }
    if (!info) { fill(td, h('span', {class: 'muted'}, 'no clip set yet'), h('div', {class: 'cap'}, h('button', {class: 'small', onclick: () => openPanel(entry, item.set)}, 'Choose clips'))); continue; }
    const caption = h('div', {class: 'cap', title: info.clips.map(clip => `${shortId(clip.id)} ${seconds(clip.seconds)}`).join('\n')}, `${info.clips.length} clip${info.clips.length === 1 ? '' : 's'} · ${seconds(info.seconds)}`);
    if (sample?.exists) {
      const url = sample.url, existing = td.querySelector('audio');
      if (existing?.getAttribute('src') !== url) fill(td, audioEl(url, {voice: entry.key, what: 'sample', target: item.slot}), caption);
      else existing.nextSibling?.replaceWith(caption);
      if (was && was !== 'ready') { td.classList.remove('fresh'); void td.offsetWidth; td.classList.add('fresh'); }
    } else {
      const working = ['queued', 'running', 'gpu-busy'].includes(sample?.state);
      fill(td, h('div', {class: 'state' + (working ? ' working' : '')}, STATE_TEXT[sample?.state] ?? 'not rendered'),
        sample?.state === 'error' && sample.error ? h('div', {class: 'cap warn'}, sample.error) : null,
        !working ? h('button', {class: 'small', title: `Render this set with ${SETS[item.set].engine}`, onclick: () => renderSlots(entry, [item.slot])}, 'Render') : null, caption);
    }
    entry.prev[item.slot] = sample?.state ?? 'missing';
  }
}

// ---- actions ---------------------------------------------------------------------------------------------------------------
async function act(entry, action, body = {}, message, {quiet = false, undo = null} = {}) {
  try {
    const card = await api(`/api/voice/${entry.key}/${action}`, {...body, line: entry.line});
    applyCard(entry, card);
    if (message && !quiet) toast(message, {undo});
    return card;
  } catch (error) { toast(error.message, {bad: true}); renderPanel(entry); return null; }
}
async function renderSlots(entry, slots, force = false) {
  const card = await act(entry, 'regenerate', {slots, force}, 'Queued');
  if (card) entry.working = entry.working ?? 'queued';
}
async function rerollAndRender(entry, set) {
  const card = await act(entry, 'reroll', {set}, null, {quiet: true});
  if (!card) return;
  toast(`New ${SETS[set].label} set drawn`);
  if ($('#autogen').checked) await renderSlots(entry, SETS[set].slots);
}

// ---- reference panel (opens in place under the row) --------------------------------------------------------------------
function togglePanel(entry) { entry.open ? closePanel(entry) : openPanel(entry); }
function openPanel(entry, tab) {
  if (tab) entry.tab = tab;
  entry.open = true; entry.refs.hidden = false;
  renderLeft(entry); renderPanel(entry);
  if (!entry.card) loadCard(entry).catch(error => toast(error.message, {bad: true}));
}
function closePanel(entry) { entry.open = false; entry.refs.hidden = true; renderLeft(entry); }

function renderPanel(entry) {
  const card = entry.card;
  if (!card) { entry.refs.replaceChildren(h('td', {colspan: 99}, h('div', {class: 'panel muted'}, 'Loading…'))); return; }
  const job = card.job && ['queued', 'running', 'waiting-gpu'].includes(card.job.status) ? card.job : null;
  const missing = Object.values(card.samples).filter(sample => !sample.exists).length;
  const progress = job ? h('div', {class: 'row'}, h('div', {class: 'progress', role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': job.total, 'aria-valuenow': job.done},
    h('i', {style: `width:${job.total ? Math.round(100 * job.done / job.total) : 0}%`})),
    h('span', {class: 'muted'}, job.status === 'waiting-gpu' ? `GPU busy, queued (${job.waitReason ?? 'another process holds the GPU'}); Pocket renders still run` : job.status === 'queued' ? 'Queued' : `Rendering ${job.done}/${job.total}${job.current ? ' · ' + job.current : ''}`)) : null;
  const tabs = h('div', {class: 'tabs', role: 'tablist'}, Object.entries(SETS).map(([set, spec]) => {
    const kept = card.kept[set], info = card.sets[set];
    return h('button', {role: 'tab', 'aria-selected': String(entry.tab === set), onclick: () => { entry.tab = set; renderPanel(entry); }},
      spec.label, kept?.isCurrent ? ' ✓' : kept ? ' (kept: other set)' : '', card.rejectedNow[set] ? ' ✗' : '', info ? '' : ' (no set)');
  }));
  const kept = Object.entries(card.kept);
  const panel = h('div', {class: 'panel'},
    h('div', {class: 'row'}, h('strong', {}, `Reference clips · ${card.name}`), h('span', {class: 'spacer', style: 'flex:1'}),
      h('button', {class: 'primary', disabled: !!job, title: missing ? 'Render every missing sample for this voice' : 'All samples exist for these sets; render them again',
        onclick: () => renderSlots(entry, null, !missing)}, job ? (job.status === 'waiting-gpu' ? 'Waiting for GPU' : 'Rendering…') : missing ? `Render this voice (${missing} missing)` : 'Re-render this voice'),
      h('button', {class: 'small', onclick: () => closePanel(entry)}, 'Close')),
    progress, tabs, setBlock(entry, card, entry.tab),
    kept.length ? h('div', {class: 'block'}, h('h3', {}, 'Kept for this voice'), kept.map(([engine, item]) => h('div', {class: 'kept' + (item.isCurrent ? '' : ' stale')},
      `${SETS[engine].label}: ${item.clips.map(clip => shortId(clip.id)).join(', ')} · ${item.seconds ?? '?'} s · ${timeOf(item.ts)}`,
      item.isCurrent ? ' · shown above' : [' · not the set shown ', h('button', {class: 'small', onclick: () => act(entry, 'restore', {set: engine, clips: item.clips.map(clip => clip.id)}, 'Showing the kept set')}, 'Show it')],
      item.note ? ` · “${item.note}”` : ''))) : null,
    noteBlock(entry, card));
  entry.refs.replaceChildren(h('td', {colspan: 99}, panel));
}

function loudnessNote(db) {
  if (db === null || db === undefined) return null;
  const far = Math.abs(db) > 3;
  return h('div', {class: 'meta' + (far ? ' warn' : ''), title: 'Gated speech loudness relative to this voice’s median clip. Beyond ±3 dB the reference tends to hurt OmniVoice.'},
    `loudness ${db > 0 ? '+' : ''}${db.toFixed(1)} dB vs median${far ? ' (outside ±3 dB)' : ''}`);
}

function setBlock(entry, card, set) {
  const key = entry.key, spec = SETS[set], info = card.sets[set];
  const slots = spec.slots.map(slot => ({slot, sample: card.samples[slot]}));
  const job = card.job && ['queued', 'running', 'waiting-gpu'].includes(card.job.status) ? card.job : null;
  const samples = h('div', {class: 'grid'}, slots.map(({slot, sample}) => h('div', {class: 'mini'}, h('div', {class: 'label'}, SLOT_LABEL[slot]),
    sample?.exists ? audioEl(sample.url, {voice: key, what: 'sample', target: slot}) : h('div', {class: 'meta'}, STATE_TEXT[sample?.state] ?? 'not rendered for this set'))));
  if (!info) {
    return h('div', {class: 'block'}, h('h3', {}, spec.label), h('div', {class: 'muted'}, 'No clip set yet for this variant.'),
      h('div', {class: 'row', style: 'margin-top:6px'}, card.poolSize ? h('button', {onclick: () => rerollAndRender(entry, set)}, `Draw a ${spec.budget} s set`) : h('span', {class: 'muted'}, 'This voice has no pool clips.')),
      card.poolSize ? poolBlock(entry, card, set) : null);
  }
  const history = card.history[set].filter(item => !item.current);
  const sel = h('select', {'aria-label': 'Earlier sets'}, h('option', {value: ''}, `Earlier sets (${history.length})`),
    history.map((item, at) => h('option', {value: String(at)}, `${timeOf(item.ts)} · ${item.clips.length} clips · ${item.seconds ?? '?'} s · ${item.action}`)));
  const kept = card.kept[set], isKept = !!kept?.isCurrent, rejected = card.rejectedNow[set];
  const keep = () => {
    if (isKept) return act(entry, 'unkeep', {engine: set}, `Un-kept ${spec.label}`, {undo: () => act(entry, 'keep', {engine: set, clips: kept.clips.map(clip => clip.id)}, 'Kept again')});
    const previous = kept && !kept.isCurrent ? kept.clips.map(clip => clip.id) : null;
    return act(entry, 'keep', {engine: set, note: noteValue(key)}, `Kept ${spec.label} for ${card.name}`,
      {undo: () => previous ? act(entry, 'keep', {engine: set, clips: previous}, 'Back to the earlier kept set') : act(entry, 'unkeep', {engine: set}, 'Un-kept')});
  };
  const reject = () => rejected
    ? act(entry, 'unreject', {set}, 'Rejection removed')
    : act(entry, 'reject', {set, note: noteValue(key)}, `Rejected: ${spec.label}. Rerolls will avoid this set`, {undo: () => act(entry, 'unreject', {set}, 'Rejection removed')});
  const rendering = slots.some(({sample}) => ['queued', 'running', 'gpu-busy'].includes(sample?.state));
  const missing = slots.filter(({sample}) => !sample?.exists).length;
  return h('div', {class: 'block'},
    h('h3', {}, `${spec.label} set · ${info.source}`),
    info.clips.map((clip, at) => h('div', {class: 'clip'},
      clip.missing ? h('div', {class: 'muted'}, `${clip.id} (missing)`) : audioEl(clip.audio, {voice: key, what: 'clip', target: clip.id}),
      h('div', {}, h('div', {}, clip.transcript),
        h('div', {class: 'meta'}, `${at + 1}. ${clip.label ?? shortId(clip.id)} · ${seconds(clip.seconds)}`
          + (clip.typicality !== null && clip.typicality !== undefined ? ` · typical ${Math.round(clip.typicality)}` : '') + (clip.delivery ? ` · ${clip.delivery}-processed` : '')),
        loudnessNote(clip.loudness)))),
    h('div', {class: 'total'}, `${info.clips.length} clip${info.clips.length === 1 ? '' : 's'}, ${seconds(info.seconds)} of ${spec.budget} s (with 0.4 s gaps)`),
    h('h3', {style: 'margin-top:10px'}, 'Samples made from this set'), samples,
    h('div', {class: 'row', style: 'margin-top:10px'},
      h('button', {disabled: !card.poolSize, title: card.poolSize ? 'Draw a different set of whole clips from this voice’s pool' : 'This voice has no spare clips', onclick: () => rerollAndRender(entry, set)}, 'Reroll'),
      sel, h('button', {class: 'small', onclick: () => { if (sel.value !== '') act(entry, 'restore', {set, clips: history[Number(sel.value)].clips}, 'Restored'); }}, 'Restore'),
      h('button', {class: 'primary', disabled: rendering || !!job && false, onclick: () => renderSlots(entry, spec.slots, !missing)},
        rendering ? 'Rendering…' : missing ? `Render ${spec.engine} for this set` : `Re-render ${spec.engine}`),
      h('span', {style: 'flex:1'}),
      h('button', {class: isKept ? 'good' : '', 'aria-pressed': String(isKept), onclick: keep}, isKept ? `Kept ✓ (click to undo)` : `Keep for ${spec.label}`),
      h('button', {class: rejected ? 'bad' : '', 'aria-pressed': String(rejected), onclick: reject}, rejected ? 'Rejected ✗ (click to undo)' : 'Reject')),
    poolBlock(entry, card, set));
}

const noteBoxes = new Map();
const noteValue = key => noteBoxes.get(key)?.value;
function noteBlock(entry, card) {
  const box = h('textarea', {placeholder: 'Optional note about this voice or set (saved with Keep and Reject)', value: card.note ?? ''});
  noteBoxes.set(entry.key, box);
  return h('div', {class: 'block'}, h('h3', {}, 'Note'), box,
    h('div', {class: 'row', style: 'margin-top:6px'}, h('button', {class: 'small', onclick: () => act(entry, 'note', {note: box.value}, 'Note saved')}, 'Save note')));
}

// ---- hand-picking ------------------------------------------------------------------------------------------------------
function poolBlock(entry, card, set) {
  const details = h('details', {}, h('summary', {}, `Choose clips by hand${card.poolSize ? ` (${card.poolSize} in the pool)` : ''}`));
  details.addEventListener('toggle', async () => {
    if (!details.open || details.dataset.loaded) return;
    details.dataset.loaded = '1';
    try { const {clips} = await api(`/api/pool/${entry.key}`); details.append(poolTable(entry, card, set, clips)); } catch (error) { toast(error.message, {bad: true}); }
  });
  return h('div', {style: 'margin-top:8px'}, details);
}
function poolTable(entry, card, set, clips) {
  const key = entry.key, budget = SETS[set].budget, selected = new Set(card.sets[set]?.ids ?? []);
  let sortMode = 'typical', filter = '', limit = 150;
  const status = h('div', {class: 'total'}), body = h('tbody'), useButton = h('button', {class: 'primary', disabled: true});
  const sorter = {typical: (a, b) => (b.ty ?? -1) - (a.ty ?? -1), longest: (a, b) => b.d - a.d, shortest: (a, b) => a.d - b.d,
    words: (a, b) => b.t.length - a.t.length, loud: (a, b) => Math.abs(a.rel ?? 99) - Math.abs(b.rel ?? 99)};
  const total = () => [...selected].reduce((sum, id) => sum + (clips.find(clip => clip.id === id)?.d ?? 0), 0) + Math.max(0, selected.size - 1) * 0.4;
  function update() {
    const used = total(), over = used > budget + 1e-6;
    status.textContent = selected.size ? `${selected.size} clip${selected.size === 1 ? '' : 's'} ticked, ${seconds(used)} of ${budget} s${over ? ' (too long)' : ''}` : 'Tick up to three clips.';
    useButton.disabled = !selected.size || over;
    useButton.textContent = `Use ticked clips as the ${SETS[set].label} set`;
    for (const box of body.querySelectorAll('input[type=checkbox]')) box.disabled = !box.checked && selected.size >= 3;
  }
  function rows() {
    const needle = filter.toLowerCase();
    const list = clips.filter(clip => !needle || clip.t.toLowerCase().includes(needle) || clip.id.includes(needle)).sort(sorter[sortMode]);
    body.replaceChildren(...list.slice(0, limit).map(clip => h('tr', {},
      h('td', {}, h('input', {type: 'checkbox', checked: selected.has(clip.id), 'aria-label': `Tick ${shortId(clip.id)}`, onchange: event => { if (event.target.checked) selected.add(clip.id); else selected.delete(clip.id); update(); }})),
      h('td', {}, audioEl(clip.audio, {voice: key, what: 'clip', target: clip.id})),
      h('td', {}, seconds(clip.d)),
      h('td', {title: 'How typical of this voice (0-100)'}, clip.ty == null ? '' : Math.round(clip.ty)),
      h('td', {class: clip.rel != null && Math.abs(clip.rel) > 3 ? 'warn' : ''}, clip.rel == null ? '' : `${clip.rel > 0 ? '+' : ''}${clip.rel.toFixed(1)}`),
      h('td', {}, clip.label ? [h('strong', {}, clip.label), ' · '] : null, clip.t, h('div', {class: 'meta'}, shortId(clip.id) + (clip.k ? ` · ${clip.k}-processed` : ''))))));
    if (list.length > limit) body.append(h('tr', {}, h('td', {colspan: 6}, h('button', {class: 'small', onclick: () => { limit += 300; rows(); }}, `Show more (${list.length - limit} left)`))));
    update();
  }
  useButton.onclick = async () => {
    const ok = await act(entry, 'set', {set, clips: [...selected]}, 'Set chosen');
    if (ok && $('#autogen').checked) await renderSlots(entry, SETS[set].slots);
  };
  const sortSelect = h('select', {'aria-label': 'Sort', onchange: event => { sortMode = event.target.value; rows(); }},
    h('option', {value: 'typical'}, 'Most typical first'), h('option', {value: 'loud'}, 'Closest to median loudness'), h('option', {value: 'longest'}, 'Longest first'),
    h('option', {value: 'shortest'}, 'Shortest first'), h('option', {value: 'words'}, 'Longest text first'));
  const search = h('input', {type: 'search', placeholder: 'Search the text', 'aria-label': 'Search the text', oninput: event => { filter = event.target.value; limit = 150; rows(); }});
  rows();
  return h('div', {}, h('div', {class: 'row', style: 'margin:8px 0'}, sortSelect, search, useButton), status,
    h('div', {class: 'pool-wrap'}, h('table', {class: 'pool'}, h('thead', {}, h('tr', {}, h('th'), h('th', {}, 'Play'), h('th', {}, 'Length'), h('th', {title: 'Typicality'}, 'Typical'), h('th', {title: 'Loudness vs the voice median (dB)'}, 'Loud'), h('th', {}, 'Text'))), body)),
    h('div', {class: 'meta', style: 'margin-top:6px'}, 'The held-out evaluation lines are not in this list. Typical is the research agent’s own criterion: closeness to the voice’s average speaker embedding.'));
}

// ---- list, filter, lazy rows --------------------------------------------------------------------------------------------
function filtered() {
  const text = $('#search').value.trim().toLowerCase(), mode = $('#status').value;
  return state.summary.filter(voice => {
    if (text && !voice.key.includes(text) && !voice.name.toLowerCase().includes(text)) return false;
    const entry = state.entries.get(voice.key), verdict = entry?.card ? entry.card.verdict?.value ?? null : voice.verdict, kept = entry?.card ? Object.keys(entry.card.kept) : voice.kept;
    return mode === 'all' || (mode === 'new' && !verdict) || (mode === 'bad' && verdict === 'bad') || (mode === 'fine' && verdict === 'fine')
      || (mode === 'kept' && kept.length) || (mode === 'panel' && voice.picker);
  });
}
function resetList() {
  state.order = filtered(); state.rendered = 0;
  for (const body of document.querySelectorAll('#report tbody.voice')) body.remove();
  $('#count').textContent = `${state.order.length} of ${state.summary.length} voices`;
  store.set('filter', {mode: $('#status').value, text: $('#search').value});
  renderMore();
}
function renderMore(count = 10) {
  const table = $('#report');
  for (let made = 0; made < count && state.rendered < state.order.length; made++) {
    const voice = state.order[state.rendered++];
    table.append(entryFor(voice).tbody);
  }
  if (state.rendered < state.order.length) state.observer.observe($('#sentinel')); else state.observer.unobserve($('#sentinel'));
}

// ---- data loading, queue ----------------------------------------------------------------------------------------------------
async function loadResearch(rescan = false) {
  state.research = await api(`/api/research${rescan ? '?rescan=1' : ''}`);
  state.groups = {...Object.fromEntries((state.research.groups ?? []).map(group => [group.id, group.shown])), ...store.get('groups', {})};
  buildColumns(); renderGroups(); applyGroups();
}
async function loadSummary() {
  const summary = await api('/api/state');
  state.summary = summary.voices;
  for (const voice of state.summary) { const entry = state.entries.get(voice.key); if (entry) entry.summary = {...voice, verdict: entry.card ? entry.card.verdict?.value ?? null : voice.verdict}; }
}
async function pollQueue() {
  try {
    const queue = await api('/api/queue');
    const running = queue.jobs.find(job => job.status === 'running'), waitingGpu = queue.jobs.filter(job => job.status === 'waiting-gpu').length;
    const pill = $('#queue');
    pill.className = 'pill' + (running || queue.waiting ? ' busy' : '');
    pill.textContent = running ? `Rendering ${running.voice} ${running.done}/${running.total}${running.current ? ' · ' + running.current : ''}${queue.waiting ? ` · ${queue.waiting} waiting` : ''}`
      : waitingGpu ? `GPU busy, ${waitingGpu} queued` : queue.waiting ? `${queue.waiting} waiting` : 'Idle';
    const gpu = $('#gpu');
    gpu.hidden = !queue.gpu?.known;
    if (queue.gpu?.known) {
      gpu.textContent = `GPU ${(queue.gpu.usedMiB / 1024).toFixed(1)} / ${(queue.gpu.totalMiB / 1024).toFixed(1)} GB${queue.gpu.busy ? ' · busy: OmniVoice renders wait' : ''}`;
      gpu.className = 'pill' + (queue.gpu.busy ? ' warn' : '');
    }
    pill.title = `Pocket: ${queue.engines.pocket} · OmniVoice: ${queue.engines.omni}`;
    for (const job of queue.jobs) {
      const signature = `${job.status}:${job.done}:${job.waitReason ?? ''}`, seen = state.jobSeen.get(job.id);
      if (seen === signature) continue;
      state.jobSeen.set(job.id, signature);
      const entry = state.entries.get(job.voice);
      if (entry && (seen !== undefined || !['done', 'error'].includes(job.status))) loadCard(entry).catch(() => {});
    }
  } catch { $('#queue').textContent = 'Server not reachable'; }
}
state.jobSeen = new Map();

// ---- start -------------------------------------------------------------------------------------------------------------------
document.head.append(h('style', {id: 'group-style'}));
$('#search').addEventListener('input', resetList);
$('#status').addEventListener('change', resetList);
$('#autogen').checked = store.get('autogen', true);
$('#autogen').addEventListener('change', event => store.set('autogen', event.target.checked));
$('#rescan').addEventListener('click', async () => { try { await loadResearch(true); for (const entry of state.entries.values()) { rebuildCells(entry); renderLeft(entry); } toast(`${state.research.columns.length} research columns`); } catch (error) { toast(error.message, {bad: true}); } });
state.observer = new IntersectionObserver(items => { if (items.some(item => item.isIntersecting)) renderMore(8); }, {root: $('#report-wrap'), rootMargin: '600px'});
// The report scrolls inside its own frame (sticky headers and voice column), sized to what is left under the bar.
const sizeFrame = () => document.documentElement.style.setProperty('--bar-h', `${document.querySelector('.bar').getBoundingClientRect().height}px`);
const sizeWrap = () => document.documentElement.style.setProperty('--wrap-w', `${$('#report-wrap').clientWidth}px`);
new ResizeObserver(() => { sizeFrame(); sizeWrap(); }).observe(document.querySelector('.bar')); new ResizeObserver(sizeWrap).observe($('#report-wrap')); sizeFrame(); sizeWrap();
$('#columns-box').open = window.innerWidth > 700;
(async () => {
  const saved = store.get('filter', {mode: 'all', text: ''});
  $('#status').value = saved.mode ?? 'all'; $('#search').value = saved.text ?? '';
  try { await Promise.all([loadResearch(), loadSummary()]); } catch (error) { toast(error.message, {bad: true}); return; }
  resetList();
  const wanted = location.hash.slice(1), at = state.order.findIndex(voice => voice.key === wanted);
  if (at >= 0) {
    renderMore(at + 1 - state.rendered);
    const entry = state.entries.get(wanted);
    if (entry.summary.picker) openPanel(entry);
    const wrap = $('#report-wrap');                      // scroll only the report frame, never the page
    wrap.scrollTop = entry.tbody.offsetTop - ($('#thead').getBoundingClientRect().height);
  }
  await pollQueue();
  setInterval(() => { if (!document.hidden) pollQueue(); }, 1500);
  // New research columns or audio appear on their own; rows are rebuilt only when something changed and nothing is playing.
  setInterval(async () => {
    if (document.hidden || [...document.querySelectorAll('audio')].some(audio => !audio.paused)) return;
    const before = JSON.stringify(state.research.columns.map(col => [col.cond, col.group, col.voices]));
    try { await loadResearch(true); } catch { return; }
    if (before !== JSON.stringify(state.research.columns.map(col => [col.cond, col.group, col.voices]))) for (const entry of state.entries.values()) { rebuildCells(entry); renderLeft(entry); }
  }, 60_000);
})();
