'use strict';
const $ = id => document.getElementById(id);
let data, state, storageKey, mapping = null, storageOK = true;
const labels = ['X', 'Y', 'Z'];
const stopAudio = () => document.querySelectorAll('audio').forEach(a => a.pause());
document.addEventListener('play', event => {
  if (event.target.tagName === 'AUDIO') document.querySelectorAll('audio').forEach(a => { if (a !== event.target) a.pause(); });
}, true);
const char = () => data.characters.find(c => c.id === state.current);
const activeIds = () => state.all ? data.characters.map(c => c.id) : data.first_round;
const answer = () => state.answers[state.current] ||= {identity: [], roughness: [], notes: '', lengths_heard: [], play_events: []};
function save() {
  state.updated_at = new Date().toISOString();
  try { localStorage.setItem(storageKey, JSON.stringify(state)); storageOK = true; }
  catch { storageOK = false; }
  $('saved').textContent = storageOK ? 'Saved on this device' : 'Browser storage unavailable — export answers to save';
  $('saved').classList.toggle('error', !storageOK);
}
function recordPlay(label) {
  const a = answer();
  a.play_events.push({label, length: label === 'original' ? 'original' : state.length, at: new Date().toISOString()});
  if (label !== 'original' && !a.lengths_heard.includes(state.length)) a.lengths_heard.push(state.length);
  save();
}
function optionSet(id, options) {
  $(id).replaceChildren();
  options.forEach(([value, text]) => {
    const label = document.createElement('label'); label.className = 'option';
    const input = document.createElement('input'); input.type = 'checkbox'; input.value = value;
    input.checked = answer()[id].includes(value);
    input.addEventListener('change', () => {
      const a = answer(); let selected = a[id];
      if (input.checked) selected = labels.includes(value) ? [...selected.filter(x => labels.includes(x)), value] : [value];
      else selected = selected.filter(x => x !== value);
      a[id] = [...new Set(selected)]; a.skipped = false; a.edited_after_reveal = Boolean(state.revealed_at); save();
      $(id).querySelectorAll('input').forEach(i => { i.checked = a[id].includes(i.value); });
    });
    label.append(input, document.createTextNode(text)); $(id).append(label);
  });
}
function render() {
  stopAudio(); const c = char(); const ids = activeIds();
  $('character').replaceChildren(); ids.forEach(id => {
    const item = data.characters.find(x => x.id === id); const opt = document.createElement('option');
    opt.value = id; opt.textContent = item.name; $('character').append(opt);
  });
  $('character').value = c.id; $('name').textContent = c.name;
  $('progress').textContent = `${ids.indexOf(c.id) + 1} of ${ids.length}`;
  $('all').textContent = state.all ? 'Back to first six' : 'Show all 24';
  $('original').src = c.reference; $('length').value = state.length;
  $('sentence').textContent = `All three say: “${c.texts[state.length]}”`;
  $('candidates').replaceChildren();
  labels.forEach(label => {
    const card = document.createElement('div'); card.className = 'card';
    const title = document.createElement('h3'); title.textContent = label + (mapping ? ` · ${mapping.characters[c.id][label]}` : '');
    const player = document.createElement('audio'); player.controls = true; player.preload = 'none'; player.src = c.candidates[label][state.length]; player.setAttribute('aria-label', `Candidate ${label}`);
    player.addEventListener('play', () => recordPlay(label)); card.append(title, player); $('candidates').append(card);
  });
  optionSet('identity', [...labels.map(l => [l,l]), ['no_difference','No clear difference'], ['uncertain','Not sure']]);
  optionSet('roughness', [...labels.map(l => [l,l]), ['none','None are distracting'], ['uncertain','Not sure']]);
  $('notes').value = answer().notes; $('previous').disabled = ids.indexOf(c.id) === 0;
  $('next').textContent = ids.indexOf(c.id) === ids.length - 1 ? 'Finish listening' : 'Next character';
  save();
}
function go(offset) {
  const ids = activeIds(); const index = ids.indexOf(state.current) + offset;
  if (index >= ids.length) return finish();
  state.current = ids[Math.max(0,index)]; render();
}
function finish() {
  stopAudio(); state.finished_at = new Date().toISOString(); save();
  $('summary').classList.remove('hidden');
  const a = Object.values(state.answers);
  const rated = a.filter(x => x.identity.length || x.roughness.length).length;
  $('summary-count').textContent = `${rated} characters have judgments; ${a.filter(x => x.skipped).length} skipped. You can stop here — no need to rate everyone.`;
  $('summary').scrollIntoView({behavior:'smooth',block:'nearest'});
}
async function reveal() {
  if (!state.finished_at) return;
  try {
    mapping = await (await fetch('reveal-scoring.json')).json();
    if (mapping.session !== data.session) throw new Error('Scoring map mismatch');
    state.revealed_at ||= new Date().toISOString(); save(); render();
    const table = document.createElement('table');
    const head = table.createTHead().insertRow(); ['Character','X','Y','Z','Closest voice','Distracting roughness'].forEach(v => {const th=document.createElement('th'); th.textContent=v; head.append(th);});
    const tbody = table.createTBody();
    data.characters.forEach(c => {
      const a = state.answers[c.id]; if (!a) return;
      const m = mapping.characters[c.id]; const tr = tbody.insertRow();
      [c.name,m.X,m.Y,m.Z,a.identity.map(x=>m[x]||x).join(', ')||'—',a.roughness.map(x=>m[x]||x).join(', ')||'—'].forEach(v=>{tr.insertCell().textContent=v;});
    });
    $('results').replaceChildren(table); $('reveal').disabled=true; $('reveal').textContent='Model names revealed';
  } catch(e) { $('saved').textContent = `Could not reveal: ${e.message}`; }
}
function exportAnswers() {
  const payload = {schema:'blind_voice_preferences_v1', session:data.session, ...state};
  if (mapping) payload.model_mapping = mapping.characters;
  const blob = new Blob([JSON.stringify(payload,null,2)],{type:'application/json'});
  const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href=url; link.download=`voice-listening-${data.session}.json`; link.click(); setTimeout(()=>URL.revokeObjectURL(url),1000);
}
async function init() {
  try {
    const response=await fetch('listening-data.json'); if(!response.ok) throw new Error(`HTTP ${response.status}`); data=await response.json();
    storageKey=`voice-listening-${data.session}`;
    try { state=JSON.parse(localStorage.getItem(storageKey)||'null'); } catch { storageOK=false; }
    state ||= {current:data.first_round[0], all:false, length:'long', answers:{}, started_at:new Date().toISOString()};
    if (!data.characters.some(c=>c.id===state.current)) state.current=data.first_round[0];
    $('loading').classList.add('hidden'); $('app').classList.remove('hidden');
    $('original').addEventListener('play',()=>recordPlay('original'));
    $('character').onchange=()=>{state.current=$('character').value;render();};
    $('length').onchange=()=>{state.length=$('length').value;render();};
    $('all').onclick=()=>{state.all=!state.all;if(!activeIds().includes(state.current))state.current=activeIds()[0];render();};
    $('notes').oninput=()=>{answer().notes=$('notes').value;answer().edited_after_reveal=Boolean(state.revealed_at);save();};
    $('previous').onclick=()=>go(-1); $('next').onclick=()=>go(1);
    $('skip').onclick=()=>{const a=answer();a.skipped=true;a.identity=[];a.roughness=[];a.edited_after_reveal=Boolean(state.revealed_at);save();go(1);};
    $('finish').onclick=finish; $('export').onclick=exportAnswers; $('reveal').onclick=reveal;
    $('resume').onclick=()=>{$('summary').classList.add('hidden');$('name').scrollIntoView({block:'start'});};
    render(); if(state.revealed_at){finish();await reveal();}else if(state.finished_at)finish();
  } catch(error) {$('loading').textContent=`Cannot load listening set: ${error.message}. Open this page through a local HTTP server.`;}
}
init();
