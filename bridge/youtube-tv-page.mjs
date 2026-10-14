// The one local page of YouTube on V's TV (docs/YOUTUBE_TV.md): a picker (paste a link, search on YouTube's own site, recently
// watched) and the player. The player is YouTube's official embedded player (IFrame Player API) filling the window: nothing is ever
// drawn over it, its controls and branding stay, and it is never resized below 480x270 by this page.
//
// The page talks to the bridge through one binding, window.__convaiTv(message) (bridge/youtube-tv-host.mjs exposes it and accepts it
// only from this page's own origin), and is driven through window.convaiTvControl(command). Sentences arrive translated in `strings`.

export const PAGE_STRINGS = [
  'YouTube on the TV', 'Paste a YouTube link or video id', 'Play', 'Search YouTube', 'Search', 'Recently watched', 'Close',
  'That is not a YouTube link or video id.', 'This video cannot be played here. Choose another one.', 'Loading…',
  'Pick a video, then click back into the game. Use the TV to pause or stop it.',
  'Descriptions and chapters (optional)',
  'With your own YouTube Data API key your companion also knows the video’s description and chapters. Without one, only the title and channel.',
  'YouTube Data API key', 'Save key', 'Forget key', 'Key saved.', 'Key forgotten.', 'That does not look like a YouTube Data API key.',
];

const escapeHtml = value => String(value).replace(/[&<>"']/g, ch => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[ch]));

/** The page. `title` is the window title the window helper finds the window by; `strings` the translations (English keys). */
export function tvPage({title, origin, strings = {}, hasKey = false}) {
  const t = text => escapeHtml(strings[text] ?? text);
  const json = JSON.stringify({origin, hasKey, strings: Object.fromEntries(PAGE_STRINGS.map(text => [text, strings[text] ?? text]))})
    .replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="referrer" content="strict-origin-when-cross-origin">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title>
<style>
:root { color-scheme: dark; --bg: #0b0d10; --panel: #15191f; --line: #2a313b; --text: #e8ecf1; --muted: #9aa5b1; --accent: #f3e600; --bad: #ff6b6b; }
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; background: var(--bg); color: var(--text); font: 15px/1.45 "Segoe UI", system-ui, sans-serif; overflow: hidden; }
#picker { height: 100%; overflow: auto; padding: 20px 24px; }
#picker[hidden], #stage[hidden] { display: none; }
h1 { margin: 0 0 4px; font-size: 20px; letter-spacing: .02em; }
.hint { color: var(--muted); margin: 0 0 16px; font-size: 13px; }
.row { display: flex; gap: 8px; margin: 0 0 10px; }
input { flex: 1; min-width: 0; padding: 9px 11px; border-radius: 6px; border: 1px solid var(--line); background: var(--panel); color: var(--text); font: inherit; }
input:focus { outline: 2px solid var(--accent); outline-offset: 1px; }
button { padding: 9px 14px; border-radius: 6px; border: 1px solid var(--line); background: var(--panel); color: var(--text); font: inherit; cursor: pointer; }
button.primary { background: var(--accent); color: #111; border-color: var(--accent); font-weight: 600; }
button:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
#message { min-height: 1.4em; margin: 2px 0 12px; color: var(--bad); }
#message.ok { color: var(--muted); }
h2 { font-size: 14px; color: var(--muted); font-weight: 600; margin: 18px 0 8px; text-transform: uppercase; letter-spacing: .06em; }
#recent { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; }
#recent button { width: 100%; text-align: left; background: transparent; }
#recent button:hover { background: var(--panel); }
details { margin-top: 18px; border-top: 1px solid var(--line); padding-top: 12px; }
summary { cursor: pointer; color: var(--muted); }
details p { color: var(--muted); font-size: 13px; }
#close { position: fixed; top: 14px; right: 18px; }
#stage { position: fixed; inset: 0; background: #000; }
#player, #stage iframe { position: absolute; inset: 0; width: 100%; height: 100%; border: 0; }
</style></head>
<body>
<section id="picker">
  <button id="close" type="button">${t('Close')}</button>
  <h1>${t('YouTube on the TV')}</h1>
  <p class="hint">${t('Pick a video, then click back into the game. Use the TV to pause or stop it.')}</p>
  <form id="paste" class="row"><input id="link" autocomplete="off" spellcheck="false" placeholder="${t('Paste a YouTube link or video id')}" aria-label="${t('Paste a YouTube link or video id')}"><button class="primary" type="submit">${t('Play')}</button></form>
  <form id="search" class="row"><input id="query" autocomplete="off" placeholder="${t('Search YouTube')}" aria-label="${t('Search YouTube')}"><button type="submit">${t('Search')}</button></form>
  <div id="message" role="status"></div>
  <h2 id="recent-title" hidden>${t('Recently watched')}</h2>
  <ul id="recent"></ul>
  <details><summary>${t('Descriptions and chapters (optional)')}</summary>
    <p>${t('With your own YouTube Data API key your companion also knows the video’s description and chapters. Without one, only the title and channel.')}</p>
    <form id="key" class="row"><input id="key-value" type="password" autocomplete="off" spellcheck="false" placeholder="${t('YouTube Data API key')}" aria-label="${t('YouTube Data API key')}"><button type="submit">${t('Save key')}</button><button id="forget" type="button">${t('Forget key')}</button></form>
  </details>
</section>
<section id="stage" hidden><div id="player"></div></section>
<script>
(() => {
  const config = ${json};
  const t = text => config.strings[text] ?? text;
  const send = message => { try { return window.__convaiTv?.(message); } catch { return undefined; } };
  const $ = id => document.getElementById(id);
  const say = (text, ok = false) => { $('message').textContent = text; $('message').className = ok ? 'ok' : ''; };
  let player = null, apiReady = false, pendingVideo = null, timer = 0, volume = 100, ducked = false;
  const report = () => {
    if (!player || typeof player.getCurrentTime !== 'function') return;
    let data = {};
    try { data = player.getVideoData?.() ?? {}; } catch {}
    send({type: 'time', position: player.getCurrentTime(), duration: player.getDuration(), title: data.title ?? '', channel: data.author ?? ''});
  };
  const applyVolume = () => { try { player?.setVolume?.(Math.round(ducked ? volume * 0.3 : volume)); } catch {} };
  const STATES = {'-1': 'unstarted', 0: 'ended', 1: 'playing', 2: 'paused', 3: 'buffering', 5: 'cued'};
  function build(video) {
    $('picker').hidden = true; $('stage').hidden = false;
    if (player) { player.loadVideoById({videoId: video.videoId, startSeconds: video.start || 0}); return; }
    player = new YT.Player('player', {width: '100%', height: '100%', videoId: video.videoId,
      host: 'https://www.youtube.com',
      playerVars: {autoplay: 1, playsinline: 1, rel: 0, enablejsapi: 1, origin: config.origin, start: video.start || 0},
      events: {
        onReady: () => { applyVolume(); try { player.playVideo(); } catch {} send({type: 'ready'}); report(); },
        onStateChange: event => {
          const state = STATES[event.data] ?? 'unknown';
          send({type: 'state', state}); report();
          clearInterval(timer);
          if (state === 'playing') timer = setInterval(report, 2000);
        },
        // 2 bad id, 5 HTML5 error, 100 removed or private, 101/150 owner does not allow embedding, 153 missing referrer.
        onError: event => { send({type: 'error', code: Number(event.data) || 0}); },
        onAutoplayBlocked: () => { send({type: 'autoplay-blocked'}); },
      }});
    const frame = document.querySelector('#stage iframe');
    if (frame) frame.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
  }
  window.onYouTubeIframeAPIReady = () => { apiReady = true; if (pendingVideo) { build(pendingVideo); pendingVideo = null; } };
  function play(video) {
    say('');
    if (apiReady) build(video); else { pendingVideo = video; say(t('Loading…'), true); }
  }
  function showPicker(message = '') {
    clearInterval(timer);
    try { player?.stopVideo?.(); } catch {}
    $('stage').hidden = true; $('picker').hidden = false; say(message);
    setTimeout(() => $('link').focus(), 50);
  }
  function renderRecent(rows) {
    const list = $('recent'); list.textContent = '';
    $('recent-title').hidden = !rows?.length;
    for (const row of rows ?? []) {
      const item = document.createElement('li'), button = document.createElement('button');
      button.type = 'button'; button.textContent = row.title ? row.title + (row.channel ? ' — ' + row.channel : '') : row.videoId;
      button.addEventListener('click', () => send({type: 'pick', text: row.videoId}));
      item.append(button); list.append(item);
    }
  }
  window.convaiTvControl = command => {
    switch (command?.op) {
      case 'play': play(command.video); return true;
      case 'pause': try { player?.pauseVideo?.(); } catch {} return true;
      case 'resume': try { player?.playVideo?.(); } catch {} return true;
      case 'picker': showPicker(command.message ?? ''); return true;
      case 'recent': renderRecent(command.rows); return true;
      case 'volume': volume = Math.max(0, Math.min(100, Number(command.volume) || 0)); applyVolume(); return true;
      case 'duck': ducked = !!command.on; applyVolume(); return true;
      case 'message': say(command.text ?? '', !!command.ok); return true;
      case 'snapshot': report(); return true;
      default: return false;
    }
  };
  $('paste').addEventListener('submit', event => { event.preventDefault(); send({type: 'pick', text: $('link').value}); });
  $('search').addEventListener('submit', event => { event.preventDefault(); const q = $('query').value.trim(); if (q) send({type: 'search', query: q}); });
  $('key').addEventListener('submit', event => { event.preventDefault(); send({type: 'key', key: $('key-value').value}); $('key-value').value = ''; });
  $('forget').addEventListener('click', () => send({type: 'forget-key'}));
  $('close').addEventListener('click', () => send({type: 'close'}));
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && !$('picker').hidden) send({type: 'close'}); });
  setTimeout(() => $('link').focus(), 50);
  send({type: 'loaded'});
})();
</script>
<script src="https://www.youtube.com/iframe_api"></script>
</body></html>`;
}
