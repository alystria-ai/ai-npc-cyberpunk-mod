'use strict';
// Voice report: the research listening report, one row per voice, with a quick verdict per character and a button that opens
// the character's reference-clip page in a new tab. Rows build lazily as you scroll, audio elements never preload, and every
// action updates the page in place (no reloads, no scroll jumps). Helpers live in common.js.

const MATRIX_GROUPS = new Set(['standard', 'clips', 'decoder', 'nophone']);
const state = {research: null, summary: [], entries: new Map(), order: [], rendered: 0, groups: {}, quick: {recommended: false, original: true},
  columns: [], current: null, observer: null};

const metricsText = metrics => [metrics.pls != null && `PLS ${metrics.pls.toFixed(metrics.pls % 1 ? 1 : 0)}`, metrics.ecapa != null && `ECAPA ${metrics.ecapa.toFixed(2)}`,
  metrics.wer != null && `WER ${metrics.wer.toFixed(1)}%`].filter(Boolean).join(' · ');

// ---- audio: keyboard control ----------------------------------------------------------------------------------------------
function onAudioPlay(audio) {
  const cell = audio.closest('td.cell');
  if (cell) markCurrent(cell);
}
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
  if (target.closest?.('button, a') && event.key === ' ') return;
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
  state.columns = (state.research?.columns ?? []).map(col => ({...col, id: col.cond ? `c:${col.cond}` : `x:${col.family}:${col.variant}`}));
}
const groupShown = id => state.groups[id] ?? true;
// Quick filters: "Original" shows or hides the original-line column in every mode; "Recommended" shows only the
// recommended columns (and their phone-free replacements) and overrides the group chips.
const isOriginal = col => col.role === 'original';
function columnShown(col) {
  if (isOriginal(col)) return state.quick.original;
  if (state.quick.recommended) return !!col.recommended && !col.placeholder;
  return groupShown(col.group);
}
const QUICK = [
  {id: 'recommended', label: 'Recommended', title: 'Show only the recommended columns: the 18 s three-clip renders of Pocket student + new decoder, OmniVoice 16 and OmniVoice 32, each with its phone-free version next to it'},
  {id: 'original', label: 'Original', title: 'The original game line column'},
];
function setQuick(id, value) { state.quick[id] = value; store.set('quick', state.quick); applyGroups(); }
function renderGroups() {
  const box = $('#groups');
  const groups = [...(state.research?.groups ?? [])].filter(group => group.id !== 'picks');
  const override = state.quick.recommended;
  fill(box,
    h('span', {class: 'chipset', role: 'group', 'aria-label': 'Quick filters'}, h('span', {class: 'muted'}, 'Quick filters:'), QUICK.map(item => h('button',
      {class: 'chip quick', 'aria-pressed': String(!!state.quick[item.id]), title: `${state.quick[item.id] ? 'Turn off' : 'Turn on'}: ${item.title}`, onclick: () => setQuick(item.id, !state.quick[item.id])}, item.label))),
    h('span', {class: 'chipset' + (override ? ' overridden' : ''), role: 'group', 'aria-label': 'Column groups',
      title: override ? 'Recommended is on, so these groups do not apply' : ''},
      h('span', {class: 'muted'}, 'Groups:'), groups.map(group => {
        const count = state.columns.filter(col => col.group === group.id && !col.placeholder && !isOriginal(col)).length;
        if (!count) return null;
        return h('button', {class: 'chip', 'aria-pressed': String(groupShown(group.id)), title: `${groupShown(group.id) ? 'Hide' : 'Show'} ${group.label}`,
          onclick: () => { state.groups[group.id] = !groupShown(group.id); store.set('groups', state.groups); applyGroups(); }}, `${group.label} (${count})`);
      })));
}
function applyGroups() {
  $('#group-style').textContent = state.columns.filter(col => !columnShown(col)).map(col => `.report [data-col="${col.id}"]{display:none}`).join(' ');
  renderGroups(); renderHead();
}
function renderHead() {
  const visible = state.columns.filter(columnShown);
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
  entry = {key: voice.key, summary: voice, line: 0, tbody: h('tbody', {class: 'voice', id: `voice-${voice.key}`})};
  state.entries.set(voice.key, entry);
  buildRow(entry);
  return entry;
}
// The game lines of a voice come from the research report.
function linesOf(entry) {
  const lines = state.research?.voices[entry.key]?.lines ?? [];
  return lines.length ? lines : [{index: 0, text: ''}];
}
function buildRow(entry) {
  entry.main = h('tr', {class: 'main'});
  entry.tbody.replaceChildren(entry.main);
  entry.left = h('td', {class: 'voicecell'});
  rebuildCells(entry);
  renderLeft(entry);
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
  for (const col of state.columns) {
    const td = h('td', {class: `cell g-${col.group}`, tabIndex: 0, dataset: {col: col.id}});
    cells.push(td);
    if (hasAudio(entry, col)) {
      td.append(audioEl(`/audio/research/${col.cond}/${entry.key}/${entry.line}`, {voice: entry.key, what: 'research', target: col.cond}));
      const ecapa = state.research.ecapa?.[col.cond]?.[entry.key];
      if (ecapa != null) td.append(h('div', {class: 'cap', title: 'ECAPA speaker similarity for this voice (average of its lines)'}, `ECAPA ${ecapa.toFixed(2)}`));
    } else { td.classList.add('na'); td.textContent = col.placeholder ? 'not rendered yet' : state.research?.voices[entry.key] ? '–' : ''; }
  }
  entry.main.replaceChildren(...cells);
}

function renderLeft(entry) {
  const voice = entry.summary, lines = linesOf(entry), verdict = voice.verdict;
  entry.tbody.classList.toggle('verdict-bad', verdict === 'bad');
  entry.tbody.classList.toggle('verdict-fine', verdict === 'fine');
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
      voice.picker ? h('a', {class: 'button small', href: `/voice/${entry.key}`, target: '_blank', rel: 'noopener', title: `Choose and compare reference clips for ${voice.name} (opens in a new tab)`}, 'Change reference clips ↗')
        : h('span', {class: 'muted'}, 'no reference clips')),
    voice.kept.length ? h('div', {class: 'vtools'}, h('span', {class: 'badge good', title: `Kept clips for: ${voice.kept.join(', ')}`}, 'clips kept')) : null);
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

function setLine(entry, line) {
  entry.line = line;
  rebuildCells(entry); renderLeft(entry);
}
async function setVerdict(entry, value) {
  const previous = entry.summary.verdict ?? '';
  const next = previous === value ? '' : value;
  const apply = verdict => { entry.summary.verdict = verdict || null; renderLeft(entry); };
  apply(next);                                          // immediate feedback
  try { await api(`/api/voice/${entry.key}/verdict`, {value: next, line: entry.line}); } catch (error) { apply(previous); toast(error.message, {bad: true}); return; }
  toast(next === 'fine' ? `${entry.summary.name}: sounds fine` : next === 'bad' ? `${entry.summary.name}: bad, fix references` : 'Verdict cleared',
    {undo: async () => { apply(previous); await api(`/api/voice/${entry.key}/verdict`, {value: previous, line: entry.line}).catch(() => {}); }});
}

// ---- list, filter, lazy rows --------------------------------------------------------------------------------------------
function filtered() {
  const text = $('#search').value.trim().toLowerCase(), mode = $('#status').value;
  return state.summary.filter(voice => {
    if (text && !voice.key.includes(text) && !voice.name.toLowerCase().includes(text)) return false;
    const verdict = voice.verdict, kept = voice.kept;
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

// ---- data loading ---------------------------------------------------------------------------------------------------------
async function loadResearch(rescan = false) {
  state.research = await api(`/api/research${rescan ? '?rescan=1' : ''}`);
  state.groups = {...Object.fromEntries((state.research.groups ?? []).map(group => [group.id, group.shown])), ...store.get('groups', {})};
  state.quick = {recommended: false, original: true, ...store.get('quick', {})};
  const research = state.research;
  $('#scores-note').textContent = research.scoresShown ? `Scores are averages over the ${research.shownVoices ?? ''} shown voices`.replace('the  ', 'the ')
    : `Scores are averages over all ${research.evaluationVoices ?? ''} evaluation voices`.replace('all  ', 'all ');
  buildColumns(); renderGroups(); applyGroups();
}
async function loadSummary() {
  const summary = await api('/api/state');
  state.summary = summary.voices;
  for (const voice of state.summary) { const entry = state.entries.get(voice.key); if (entry) entry.summary = voice; }
}

// ---- start -------------------------------------------------------------------------------------------------------------------
document.head.append(h('style', {id: 'group-style'}));
$('#search').addEventListener('input', resetList);
$('#status').addEventListener('change', resetList);
$('#rescan').addEventListener('click', async () => { try { await loadResearch(true); for (const entry of state.entries.values()) { rebuildCells(entry); renderLeft(entry); } toast(`${state.research.columns.length} research columns`); } catch (error) { toast(error.message, {bad: true}); } });
state.observer = new IntersectionObserver(items => { if (items.some(item => item.isIntersecting)) renderMore(8); }, {root: $('#report-wrap'), rootMargin: '600px'});
// The report scrolls inside its own frame (sticky headers and voice column), sized to what is left under the bar.
const sizeFrame = () => document.documentElement.style.setProperty('--bar-h', `${document.querySelector('.bar').getBoundingClientRect().height}px`);
new ResizeObserver(sizeFrame).observe(document.querySelector('.bar')); sizeFrame();
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
    const wrap = $('#report-wrap');                      // scroll only the report frame, never the page
    wrap.scrollTop = entry.tbody.offsetTop - ($('#thead').getBoundingClientRect().height);
  }
  // Coming back from a character page: pick up clips kept there.
  document.addEventListener('visibilitychange', async () => {
    if (document.hidden) return;
    try { await loadSummary(); } catch { return; }
    for (const entry of state.entries.values()) renderLeft(entry);
  });
  // New research columns or audio appear on their own; rows are rebuilt only when something changed and nothing is playing.
  setInterval(async () => {
    if (document.hidden || [...document.querySelectorAll('audio')].some(audio => !audio.paused)) return;
    const before = JSON.stringify(state.research.columns.map(col => [col.cond, col.group, col.voices]));
    try { await loadResearch(true); } catch { return; }
    if (before !== JSON.stringify(state.research.columns.map(col => [col.cond, col.group, col.voices]))) for (const entry of state.entries.values()) { rebuildCells(entry); renderLeft(entry); }
  }, 60_000);
})();
