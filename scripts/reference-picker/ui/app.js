'use strict';
// Reference picker front end. Cards render only when opened; audio elements use preload="none" and are never created
// for closed cards, so the page stays light even with every voice listed.

const $ = selector => document.querySelector(selector);
function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key in el && key !== 'list') el[key] = value;
    else el.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) if (child !== null && child !== undefined && child !== false) el.append(child.nodeType ? child : document.createTextNode(String(child)));
  return el;
}

const state = {voices: [], entries: new Map(), lines: {}, queue: null, jobSeen: new Map()};
const store = {
  get(key, fallback) { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } },
  set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private window */ } },
};

let toastTimer;
function toast(message, bad = false) {
  const el = $('#toast'); el.textContent = message; el.hidden = false; el.style.background = bad ? 'var(--bad)' : '';
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.hidden = true; }, bad ? 7000 : 3500);
}
async function api(path, body) {
  const response = await fetch(path, body === undefined ? {cache: 'no-store'}
    : {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(body)});
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Error(data.error || `Request failed (${response.status})`);
  return data;
}

const shortId = id => id.startsWith('live:') ? id : id.split('/').slice(1).join('/');
const seconds = value => `${Number(value).toFixed(1)} s`;
const timeOf = ts => ts ? new Date(ts).toLocaleString([], {month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'}) : '';
const ENGINE_NAMES = {pocket: 'Pocket', omni: 'OmniVoice', 'omni-short': 'Omni short (≤10 s)'};

// ---- audio: one at a time, every play logged ------------------------------------------------------------------------
document.addEventListener('play', event => {
  const audio = event.target;
  if (!(audio instanceof HTMLAudioElement)) return;
  for (const other of document.querySelectorAll('audio')) if (other !== audio && !other.paused) other.pause();
  const {voice, what, target} = audio.dataset;
  if (voice && what) api(`/api/play/${voice}`, {what, target}).catch(() => {});
}, true);
const isPlayingIn = el => [...el.querySelectorAll('audio')].some(audio => !audio.paused && !audio.ended);
function player(url, dataset) {
  return h('audio', {controls: true, preload: 'none', src: url, dataset});
}

// ---- list -------------------------------------------------------------------------------------------------------------
async function loadState() {
  const summary = await api('/api/state');
  state.summary = summary;
  state.voices = summary.voices.sort((a, b) => Number(b.proposed) - Number(a.proposed) || a.key.localeCompare(b.key));
  const list = $('#list');
  for (const voice of state.voices) {
    let entry = state.entries.get(voice.key);
    if (!entry) {
      entry = {key: voice.key, open: false, data: null, el: h('section', {class: 'card', id: `voice-${voice.key}`}), body: null};
      entry.head = h('div', {class: 'head', tabIndex: 0, role: 'button', 'aria-expanded': 'false', onclick: () => toggle(entry.key),
        onkeydown: event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); toggle(entry.key); } }});
      entry.el.append(entry.head);
      state.entries.set(voice.key, entry);
      list.append(entry.el);
    }
    entry.summary = voice;
    renderHead(entry);
  }
  applyFilter();
}
function renderHead(entry) {
  const voice = entry.summary;
  entry.head.replaceChildren(...[
    h('span', {class: 'name'}, voice.name),
    voice.kept.includes('pocket') && h('span', {class: 'badge good'}, 'Pocket kept'),
    voice.kept.includes('omni') && h('span', {class: 'badge good'}, 'Omni kept'),
    voice.kept.includes('omni-short') && h('span', {class: 'badge good'}, 'Omni short (≤10 s) kept'),
    voice.rejected > 0 && h('span', {class: 'badge bad'}, `${voice.rejected} rejected`),
    voice.job && h('span', {class: 'badge busy'}, voice.job === 'running' ? 'rendering' : 'queued'),
    !voice.proposed && h('span', {class: 'badge'}, 'no proposed set'),
    h('span', {class: 'muted'}, voice.poolSize ? `${voice.poolSize} clips` : 'no pool clips'),
  ].filter(Boolean));
  entry.head.setAttribute('aria-expanded', String(entry.open));
}
function applyFilter() {
  const text = $('#search').value.trim().toLowerCase(), mode = $('#status').value;
  let shown = 0;
  for (const entry of state.entries.values()) {
    const voice = entry.summary;
    const matches = (!text || voice.key.includes(text) || voice.name.toLowerCase().includes(text))
      && (mode === 'all' || (mode === 'proposal' && voice.proposed) || (mode === 'undecided' && !voice.kept.length)
        || (mode === 'kept' && voice.kept.length) || (mode === 'rejected' && voice.rejected));
    entry.el.hidden = !matches;
    if (matches) shown++;
  }
  $('#count').textContent = `${shown} of ${state.entries.size} voices`;
  store.set('filter', {mode, text});
}

async function toggle(key, force) {
  const entry = state.entries.get(key);
  entry.open = force ?? !entry.open;
  if (!entry.open) { entry.body?.remove(); entry.body = null; renderHead(entry); return; }
  renderHead(entry);
  await refresh(key);
  if (location.hash !== `#${key}`) history.replaceState(null, '', `#${key}`);
}
async function refresh(key, {force = false} = {}) {
  const entry = state.entries.get(key);
  const data = await api(`/api/voice/${key}?line=${state.lines[key] ?? 0}`);
  entry.data = data;
  if (!force && entry.body && isPlayingIn(entry.body)) { entry.pending = true; return; }   // never cut off what is playing
  entry.pending = false;
  render(entry);
}
document.addEventListener('pause', event => {
  const body = event.target.closest?.('.body');
  const entry = body && [...state.entries.values()].find(item => item.body === body);
  if (entry?.pending && !isPlayingIn(body)) { entry.pending = false; render(entry); }
}, true);

// ---- card ---------------------------------------------------------------------------------------------------------------
async function act(key, action, body = {}, message) {
  const entry = state.entries.get(key);
  try {
    entry.data = await api(`/api/voice/${key}/${action}`, {...body, line: state.lines[key] ?? 0});
    render(entry);
    await loadState();
    if (message) toast(message);
    return true;
  } catch (error) { toast(error.message, true); return false; }
}

function render(entry) {
  const data = entry.data, key = entry.key;
  const old = entry.body;
  entry.body = h('div', {class: 'body'},
    controls(data), originalBlock(data), samplesBlock(data),
    setBlock(data, 'full'), setBlock(data, 'short'), noteBlock(data), keptBlock(data), poolBlock(data));
  if (old) old.replaceWith(entry.body); else entry.el.append(entry.body);
  entry.pool = null;
  renderHead(entry);
}

function controls(data) {
  const key = data.key;
  const samples = Object.values(data.samples), missing = samples.filter(sample => !sample.exists).length;
  const busy = data.job && ['queued', 'running'].includes(data.job.status);
  const sequence = h('button', {class: 'small', onclick: event => playSequence(event.target.closest('.body'))}, 'Play all in order');
  return h('div', {class: 'row'},
    data.lines.length > 1 && h('span', {class: 'row'}, 'Line:', data.lines.map(line => h('button', {class: 'small' + (line.index === data.line ? ' primary' : ''),
      onclick: async () => { state.lines[key] = line.index; await refresh(key, {force: true}); }}, `${line.index + 1}`))),
    h('button', {class: 'primary', disabled: busy, title: missing ? 'Render the missing samples for this voice only' : 'Everything is already rendered for these sets; re-render anyway',
      onclick: () => act(key, 'regenerate', {force: !missing}, missing ? 'Queued' : 'Queued a full re-render')},
      busy ? `Rendering ${data.job.done}/${data.job.total}${data.job.current ? ' · ' + data.job.current : ''}` : missing ? `Regenerate this voice (${missing} missing)` : 'Re-render all'),
    sequence,
    data.job?.status === 'error' && h('span', {class: 'badge bad', title: data.job.error}, 'last render failed'));
}

function originalBlock(data) {
  return h('div', {class: 'block'}, h('h3', {}, data.hasLine ? 'Original game line' : 'No held-out game line for this voice'),
    h('div', {class: 'quote'}, `“${data.text}”`),
    data.hasLine ? player(data.lines[data.line].audio, {voice: data.key, what: 'original', target: data.lines[data.line].text.slice(0, 40)})
      : h('div', {class: 'muted'}, 'The samples use a neutral test sentence instead.'),
    h('div', {class: 'muted'}, 'All samples below say exactly this text.'));
}

function sampleCell(data, slot) {
  const sample = data.samples[slot];
  if (!sample) return null;
  const clips = sample.clips;
  const label = sample.live ? `Today: ${sample.engine === 'pocket' ? 'Pocket' : 'OmniVoice ' + sample.steps + ' steps'} (1 clip)`
    : sample.engine === 'pocket' ? `Pocket (${clips}-clip)` : `OmniVoice ${sample.steps} steps${sample.set === 'short' ? ' · Omni short (≤10 s)' : ''}`;
  const texts = {missing: 'not generated yet', queued: 'waiting in the queue', running: 'rendering…', error: sample.error || 'failed'};
  return h('div', {class: 'cell'}, h('div', {class: 'label'}, label),
    sample.exists ? player(sample.url, {voice: data.key, what: 'sample', target: slot}) : null,
    h('div', {class: 'state' + (sample.state === 'error' ? ' err' : '')}, sample.exists ? '' : texts[sample.state] ?? sample.state));
}
function samplesBlock(data) {
  const new_ = ['pocket', 'omni16', 'omni32', 'omni16s'].map(slot => sampleCell(data, slot)).filter(Boolean);
  const old = ['live-pocket', 'live-omni16', 'live-omni32'].map(slot => sampleCell(data, slot)).filter(Boolean);
  return h('div', {class: 'block'}, h('h3', {}, 'Same line with the reference set below'), h('div', {class: 'grid'}, new_),
    old.length ? [h('h3', {style: 'margin-top:12px'}, 'Same line with today’s single reference'), h('div', {class: 'grid'}, old)] : null);
}

// Loudness against the voice's median clip; far from the median tends to make OmniVoice worse (research finding).
function loudnessNote(db) {
  if (db === null || db === undefined) return null;
  const far = Math.abs(db) > 3;
  return h('div', {class: 'meta' + (far ? ' warn' : ''), title: 'Gated speech loudness relative to this voice’s median clip. Beyond ±3 dB the reference tends to hurt OmniVoice.'},
    `loudness ${db > 0 ? '+' : ''}${db.toFixed(1)} dB vs median${far ? ' (outside ±3 dB)' : ''}`);
}
function setBlock(data, set) {
  const key = data.key, info = data.sets[set], budget = set === 'short' ? 10 : 18;
  const title = set === 'short' ? 'Omni short (≤10 s) set' : 'Reference set for Pocket and OmniVoice (18 s at most)';
  const engines = set === 'short' ? ['omni-short'] : ['pocket', 'omni'];
  if (!info) {
    return h('div', {class: 'block'}, h('h3', {}, title), h('div', {class: 'muted'}, 'No Omni short (≤10 s) set exists for this voice yet.'),
      h('div', {class: 'row'}, data.poolSize ? h('button', {onclick: () => rerollAndGenerate(key, set)}, 'Draw a ≤10 s set') : null));
  }
  const history = data.history[set].filter(item => !item.current);
  const sel = h('select', {'aria-label': 'Earlier sets'}, h('option', {value: ''}, `Earlier sets (${history.length})`),
    history.map((item, at) => h('option', {value: String(at)}, `${item.ts ? timeOf(item.ts) : 'start'} · ${item.clips.length} clips · ${item.seconds ?? '?'} s · ${item.action}`)));
  return h('div', {class: 'block'}, h('h3', {}, `${title} · ${info.source}`),
    info.clips.map((clip, at) => h('div', {class: 'clip'},
      clip.missing ? h('div', {class: 'muted'}, `${clip.id} (missing)`) : player(clip.audio, {voice: key, what: 'clip', target: clip.id}),
      h('div', {}, h('div', {class: 'text'}, clip.transcript),
        h('div', {class: 'meta'}, `${at + 1}. ${clip.label ?? shortId(clip.id)} · ${seconds(clip.seconds)}`
          + (clip.typicality !== null && clip.typicality !== undefined ? ` · typical ${Math.round(clip.typicality)}` : '')
          + (clip.delivery ? ` · ${clip.delivery}-processed` : '')),
        loudnessNote(clip.loudness)))),
    h('div', {class: 'total'}, `${info.clips.length} clip${info.clips.length === 1 ? '' : 's'}, ${seconds(info.seconds)} of ${budget} s (with 0.4 s gaps)`),
    h('div', {class: 'row', style: 'margin-top:8px'},
      h('button', {disabled: !data.poolSize, title: data.poolSize ? 'Draw a different set of whole clips from this voice’s pool' : 'This voice has no spare clips', onclick: () => rerollAndGenerate(key, set)}, 'Reroll'),
      sel, h('button', {class: 'small', onclick: () => { if (sel.value !== '') act(key, 'restore', {set, clips: history[Number(sel.value)].clips}, 'Restored'); }}, 'Restore'),
      h('span', {class: 'spacer'}),
      engines.map(engine => {
        const kept = data.kept[engine];
        const isKept = kept?.isCurrent;
        return h('button', {class: isKept ? 'good' : '', title: isKept ? 'Click to un-keep' : '',
          onclick: () => isKept ? act(key, 'unkeep', {engine}, 'Un-kept') : act(key, 'keep', {engine, note: currentNote(key)}, `Kept for ${ENGINE_NAMES[engine]}`)},
          isKept ? `Kept for ${ENGINE_NAMES[engine]} ✓` : `Keep for ${ENGINE_NAMES[engine]}`);
      }),
      h('button', {class: data.rejectedNow[set] ? 'bad' : '', disabled: data.rejectedNow[set],
        onclick: () => act(key, 'reject', {set, note: currentNote(key)}, 'Rejected; rerolls will avoid this set')}, data.rejectedNow[set] ? 'Rejected' : 'Reject')));
}
async function rerollAndGenerate(key, set) {
  const ok = await act(key, 'reroll', {set}, 'New set drawn');
  if (ok && $('#autogen').checked) await act(key, 'regenerate', {}, 'Rendering this voice');
}

const noteBoxes = new Map();
const currentNote = key => noteBoxes.get(key)?.value ?? undefined;
function noteBlock(data) {
  const box = h('textarea', {placeholder: 'Optional note about this voice or set (saved with Keep / Reject)', value: data.note ?? ''});
  noteBoxes.set(data.key, box);
  return h('div', {class: 'block'}, h('h3', {}, 'Note'), box,
    h('div', {class: 'row', style: 'margin-top:6px'}, h('button', {class: 'small', onclick: () => act(data.key, 'note', {note: box.value}, 'Note saved')}, 'Save note')));
}

function keptBlock(data) {
  const rows = Object.entries(data.kept);
  if (!rows.length) return null;
  return h('div', {class: 'block'}, h('h3', {}, 'Kept'), rows.map(([engine, kept]) => h('div', {class: 'kept' + (kept.isCurrent ? '' : ' stale'), style: 'margin:4px 0'},
    `${ENGINE_NAMES[engine]}: ${kept.clips.map(clip => shortId(clip.id)).join(', ')} · ${kept.seconds ?? '?'} s · ${timeOf(kept.ts)}`,
    kept.isCurrent ? ' · this is the set shown above' : [' · a different set from the one shown ',
      h('button', {class: 'small', onclick: () => act(data.key, 'restore', {set: engine === 'omni-short' ? 'short' : 'full', clips: kept.clips.map(clip => clip.id)}, 'Showing the kept set')}, 'Show it')],
    kept.note ? ` · “${kept.note}”` : '')));
}

// ---- manual clip browser ----------------------------------------------------------------------------------------------
function poolBlock(data) {
  const key = data.key;
  const details = h('details', {}, h('summary', {}, `Choose clips by hand${data.poolSize ? ` (${data.poolSize} in the pool)` : ''}`));
  details.addEventListener('toggle', async () => {
    if (!details.open || details.dataset.loaded) return;
    details.dataset.loaded = '1';
    try {
      const {clips} = await api(`/api/pool/${key}`);
      details.append(poolTable(data, clips));
    } catch (error) { toast(error.message, true); }
  });
  return h('div', {class: 'block'}, details);
}
function poolTable(data, clips) {
  const key = data.key;
  const selected = new Set();
  let target = 'full', sortMode = 'typical', filter = '', limit = 150;
  const budgets = {full: 18, short: 10};
  const status = h('div', {class: 'total'});
  const body = h('tbody');
  const useButton = h('button', {class: 'primary', disabled: true});
  const sorter = {typical: (a, b) => (b.ty ?? -1) - (a.ty ?? -1), longest: (a, b) => b.d - a.d, shortest: (a, b) => a.d - b.d,
    words: (a, b) => b.t.length - a.t.length, loud: (a, b) => Math.abs(a.rel ?? 99) - Math.abs(b.rel ?? 99)};
  const total = () => [...selected].reduce((sum, id) => sum + clips.find(clip => clip.id === id).d, 0) + Math.max(0, selected.size - 1) * 0.4;
  function update() {
    const used = total(), over = used > budgets[target] + 1e-6;
    status.textContent = selected.size ? `${selected.size} clip${selected.size === 1 ? '' : 's'} ticked, ${seconds(used)} of ${budgets[target]} s${over ? ' (too long)' : ''}` : 'Tick up to three clips.';
    useButton.disabled = !selected.size || over;
    useButton.textContent = `Use ticked clips as the ${budgets[target]} s set`;
    for (const box of body.querySelectorAll('input[type=checkbox]')) box.disabled = !box.checked && selected.size >= 3;
  }
  function rows() {
    const needle = filter.toLowerCase();
    const list = clips.filter(clip => !needle || clip.t.toLowerCase().includes(needle) || clip.id.includes(needle)).sort(sorter[sortMode]);
    body.replaceChildren(...list.slice(0, limit).map(clip => h('tr', {},
      h('td', {}, h('input', {type: 'checkbox', checked: selected.has(clip.id), 'aria-label': `Tick ${shortId(clip.id)}`, onchange: event => {
        if (event.target.checked) selected.add(clip.id); else selected.delete(clip.id);
        update();
      }})),
      h('td', {}, player(clip.audio, {voice: key, what: 'clip', target: clip.id})),
      h('td', {}, seconds(clip.d)), h('td', {title: 'How typical of this voice: percentile of the clip’s speaker-embedding similarity to the voice’s average'}, clip.ty === null || clip.ty === undefined ? '' : Math.round(clip.ty)),
      h('td', {class: clip.rel !== null && clip.rel !== undefined && Math.abs(clip.rel) > 3 ? 'warn' : ''}, clip.rel === null || clip.rel === undefined ? '' : `${clip.rel > 0 ? '+' : ''}${clip.rel.toFixed(1)}`),
      h('td', {}, clip.label ? [h('strong', {}, clip.label), ' · '] : null, clip.t, h('div', {class: 'meta muted'}, shortId(clip.id) + (clip.k ? ` · ${clip.k}-processed` : ''))))));
    if (list.length > limit) body.append(h('tr', {}, h('td', {colspan: 6}, h('button', {class: 'small', onclick: () => { limit += 300; rows(); }}, `Show more (${list.length - limit} left)`))));
    update();
  }
  for (const id of data.sets[target]?.ids ?? []) selected.add(id);
  useButton.onclick = async () => { if (await act(key, 'set', {set: target, clips: [...selected]}, 'Set chosen')) { if ($('#autogen').checked) await act(key, 'regenerate', {}, 'Rendering this voice'); } };
  const sortSelect = h('select', {onchange: event => { sortMode = event.target.value; rows(); }},
    h('option', {value: 'typical'}, 'Most typical first'), h('option', {value: 'longest'}, 'Longest first'), h('option', {value: 'shortest'}, 'Shortest first'), h('option', {value: 'words'}, 'Longest text first'), h('option', {value: 'loud'}, 'Closest to median loudness'));
  const targetSelect = h('select', {onchange: event => { target = event.target.value; selected.clear(); for (const id of data.sets[target]?.ids ?? []) selected.add(id); rows(); }},
    h('option', {value: 'full'}, 'For the 18 s set (Pocket and OmniVoice)'), h('option', {value: 'short'}, 'For the Omni short (≤10 s) set'));
  const search = h('input', {type: 'search', placeholder: 'Search the text', oninput: event => { filter = event.target.value; limit = 150; rows(); }});
  const table = h('table', {class: 'pool'}, h('thead', {}, h('tr', {}, h('th', {}, ''), h('th', {}, 'Play'), h('th', {}, 'Length'),
    h('th', {title: 'Typicality (0-100)'}, 'Typical'), h('th', {title: 'Loudness relative to the voice’s median clip'}, 'Loud (dB)'), h('th', {}, 'Text'))), body);
  const wrap = h('div', {}, h('div', {class: 'row', style: 'margin:8px 0'}, targetSelect, sortSelect, search, useButton), status,
    h('div', {class: 'pool-wrap'}, table),
    h('div', {class: 'muted', style: 'margin-top:6px'}, 'The held-out evaluation lines are not in this list. "Typical" is the research agent’s own criterion: how close the clip is to the voice’s average speaker embedding.'));
  rows();
  return wrap;
}

// ---- play everything in order ----------------------------------------------------------------------------------------
let sequenceRun = 0;
function playSequence(body) {
  const run = ++sequenceRun;
  const elements = [...body.querySelectorAll('.block:nth-child(2) audio, .block:nth-child(3) audio')];
  let at = 0;
  const next = () => {
    if (run !== sequenceRun || at >= elements.length) return;
    const audio = elements[at++];
    audio.currentTime = 0;
    audio.addEventListener('ended', next, {once: true});
    audio.play().catch(() => {});
  };
  next();
}

// ---- queue ------------------------------------------------------------------------------------------------------------
async function pollQueue() {
  try {
    const queue = await api('/api/queue');
    const running = queue.jobs.find(job => job.status === 'running');
    const pill = $('#queue');
    pill.className = 'pill' + (running || queue.waiting ? ' busy' : '');
    pill.textContent = running ? `Rendering ${running.voice} ${running.done}/${running.total}${running.current ? ' · ' + running.current : ''}${queue.waiting ? ` · ${queue.waiting} waiting` : ''}`
      : queue.waiting ? `${queue.waiting} waiting` : 'Idle';
    pill.title = `Pocket: ${queue.engines.pocket} · OmniVoice: ${queue.engines.omni}`;
    let changed = false;
    for (const job of queue.jobs) {
      const seen = state.jobSeen.get(job.id), signature = `${job.status}:${job.done}`;
      if (seen !== signature) {
        state.jobSeen.set(job.id, signature);
        const entry = state.entries.get(job.voice);
        if (entry?.open && seen !== undefined) refresh(job.voice).catch(() => {});
        if (seen !== undefined && ['done', 'error'].includes(job.status)) changed = true;
        if (seen === undefined && !['done', 'error'].includes(job.status)) changed = true;
      }
    }
    if (changed) await loadState();
  } catch { $('#queue').textContent = 'Server not reachable'; }
}

// ---- start ------------------------------------------------------------------------------------------------------------
$('#search').addEventListener('input', applyFilter);
$('#status').addEventListener('change', applyFilter);
$('#autogen').checked = store.get('autogen', true);
$('#autogen').addEventListener('change', event => store.set('autogen', event.target.checked));
$('#gen-listed').addEventListener('click', async () => {
  const keys = [...state.entries.values()].filter(entry => !entry.el.hidden).map(entry => entry.key);
  if (!keys.length || !confirm(`Queue sample generation for ${keys.length} voice${keys.length === 1 ? '' : 's'}? Voices whose samples already exist are skipped, but a full voice takes roughly a minute.`)) return;
  try { const result = await api('/api/generate-missing', {voices: keys}); toast(`Queued ${result.queued} voices`); await loadState(); } catch (error) { toast(error.message, true); }
});
(async () => {
  const saved = store.get('filter', {mode: 'proposal', text: ''});
  $('#status').value = saved.mode ?? 'proposal'; $('#search').value = saved.text ?? '';
  try { await loadState(); } catch (error) { toast(error.message, true); return; }
  const wanted = location.hash.slice(1);
  if (wanted && state.entries.has(wanted)) { state.entries.get(wanted).el.hidden = false; await toggle(wanted, true); state.entries.get(wanted).el.scrollIntoView(); }
  await pollQueue();
  setInterval(() => { if (!document.hidden) pollQueue(); }, 1500);
})();
