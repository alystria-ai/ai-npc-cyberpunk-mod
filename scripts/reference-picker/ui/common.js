'use strict';
// Helpers shared by the voice report (app.js) and the character page (voice.js).

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
  for (const child of children.flat(Infinity)) if (child !== null && child !== undefined && child !== false) el.append(child.nodeType ? child : document.createTextNode(String(child)));
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

// ---- audio: one at a time, every play logged ------------------------------------------------------------------------------
function audioEl(url, dataset) { return h('audio', {controls: true, preload: 'none', src: url, dataset}); }
document.addEventListener('play', event => {
  const audio = event.target;
  if (!(audio instanceof HTMLAudioElement)) return;
  for (const other of document.querySelectorAll('audio')) if (other !== audio && !other.paused) other.pause();
  if (typeof onAudioPlay === 'function') onAudioPlay(audio);
  const {voice, what, target, current} = audio.dataset;
  if (voice && what) api(`/api/play/${voice}`, {what, target, ...(current ? {current: true} : {})}).catch(() => {});
}, true);
