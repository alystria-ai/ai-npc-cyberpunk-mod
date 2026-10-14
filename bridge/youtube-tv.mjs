// YouTube on V's TV (docs/YOUTUBE_TV.md): the pure parts. Which video a pasted text names, the chapters in a description, the
// command file the game writes, and the "watching together" block a companion's turn carries while a video plays.
//
// Terms (docs/YOUTUBE_TV.md, "YouTube's terms"): the video only ever plays in YouTube's own embedded player (IFrame Player API),
// fully visible, with nothing drawn over it. Nothing here downloads, caches or rips a video. The title and channel come from YouTube's
// public oEmbed endpoint. The description, chapters and captions are read from what the embedded player itself fetched for the video
// on the TV page (its player answer and its caption track; the user accepted this grey zone on 2026-10-15): nothing is fetched for
// them, they stay in memory for the playing video only, and what a companion learns is said for this turn only, never stored.

export const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtube-nocookie.com',
  'www.youtube-nocookie.com', 'youtu.be']);
const COMMANDS = new Set(['open', 'toggle', 'pause', 'resume', 'stop', 'hide', 'show', 'pick']);
const COMMAND_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,95}$/;
const COMMAND_MAX_BYTES = 64 * 1024, COMMAND_MAX_AGE_MS = 30_000;
// The whole watching block, framing included.
export const MAX_CONTEXT_CHARS = 1300;
const MAX_TITLE = 160, MAX_CHANNEL = 80, MAX_CHAPTER = 80, MAX_DESCRIPTION = 360, MAX_CHAPTERS = 100;
// Captions: what was said in the last half minute, at most this many characters (the newest kept).
export const CAPTION_BEFORE_S = 30, CAPTION_AFTER_S = 1.5, MAX_CAPTION_CHARS = 420;
const MAX_CUES = 20_000, MAX_CUE_TEXT = 400;

const plain = value => !!value && typeof value === 'object' && !Array.isArray(value);
/** One line of untrusted text (a title, a channel, a chapter): no markup, no control characters, bounded. */
export function cleanLine(value, limit) {
  if (typeof value !== 'string') return null;
  const text = value.replace(/<[^>]*>/g, '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();   // \s also takes the line separators
  if (!text) return null;
  return text.length > limit ? text.slice(0, limit - 1).trimEnd() + '…' : text;
}

/** "1:02:03", "12:34" or "0:05" -> seconds; anything else -> null. */
export function parseClock(text) {
  const match = /^(?:(\d{1,2}):)?(\d{1,2}):(\d{2})$/.exec(String(text ?? '').trim());
  if (!match) return null;
  const [, hours = '0', minutes, seconds] = match;
  if (Number(seconds) > 59 || (match[1] !== undefined && Number(minutes) > 59)) return null;
  return Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds);
}
/** Seconds -> "m:ss" or "h:mm:ss". */
export function formatClock(total) {
  const value = Math.max(0, Math.floor(Number(total) || 0));
  const hours = Math.floor(value / 3600), minutes = Math.floor(value / 60) % 60, seconds = value % 60;
  const ss = String(seconds).padStart(2, '0');
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${ss}` : `${minutes}:${ss}`;
}
// A start time in a link: "t=90", "t=1m30s", "start=90".
function startOf(value) {
  if (typeof value !== 'string' || !value) return 0;
  if (/^\d{1,6}s?$/.test(value)) return Number(value.replace(/s$/, ''));
  const match = /^(?:(\d{1,2})h)?(?:(\d{1,3})m)?(?:(\d{1,5})s)?$/.exec(value);
  if (!match || !match[0]) return 0;
  return Number(match[1] ?? 0) * 3600 + Number(match[2] ?? 0) * 60 + Number(match[3] ?? 0);
}

/**
 * What the player pasted -> {videoId, start} or null. Accepts a bare 11-character id and the usual YouTube links: watch?v=, youtu.be/,
 * /shorts/, /live/, /embed/, /v/, on www, m., music. and the no-cookie domain. A playlist link plays its video (the list is ignored).
 */
export function parseVideoInput(text) {
  if (typeof text !== 'string') return null;
  const value = text.trim();
  if (!value || value.length > 2048) return null;
  if (VIDEO_ID.test(value)) return {videoId: value, start: 0};
  let url;
  try { url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : 'https://' + value); } catch { return null; }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  const host = url.hostname.toLowerCase();
  if (!HOSTS.has(host)) return null;
  const parts = url.pathname.split('/').filter(Boolean);
  let id = null;
  if (host === 'youtu.be') id = parts[0];
  else if (parts[0] === 'watch') id = url.searchParams.get('v');
  else if (['shorts', 'live', 'embed', 'v', 'e'].includes(parts[0])) id = parts[1];
  if (!id || !VIDEO_ID.test(id)) return null;
  return {videoId: id, start: Math.min(startOf(url.searchParams.get('t') ?? url.searchParams.get('start') ?? ''), 86_400)};
}

/**
 * Chapters as YouTube itself reads them from a description: lines that start (or end) with a timestamp, the first at 0:00, at least
 * three, each later than the one before. Anything else -> [] (a description that only mentions a few times has no chapters).
 */
export function parseChapters(description) {
  if (typeof description !== 'string' || !description) return [];
  const rows = [];
  for (const line of description.split(/\r?\n/).slice(0, 400)) {
    // "0:00 Intro", "- 1:23 - Setup", "(12:34) Results", or the timestamp at the end: "Intro - 0:00".
    const leading = /^\s*(?:[-•*▶►]\s*)?\(?((?:\d{1,2}:)?\d{1,2}:\d{2})\)?\s*(?:[-–—:|.]\s*)?(.+?)\s*$/.exec(line);
    const trailing = leading ? null : /^\s*(?:[-•*▶►]\s*)?(.+?)\s*(?:[-–—:|]\s*)?\(?((?:\d{1,2}:)?\d{1,2}:\d{2})\)?\s*$/.exec(line);
    if (!leading && !trailing) continue;
    const [clock, name] = leading ? [leading[1], leading[2]] : [trailing[2], trailing[1]];
    const start = parseClock(clock), title = cleanLine(name, MAX_CHAPTER);
    if (start === null || !title) continue;
    rows.push({start, title});
    if (rows.length > MAX_CHAPTERS) break;
  }
  if (rows.length < 3 || rows[0].start !== 0) return [];
  for (let index = 1; index < rows.length; index++) if (rows[index].start <= rows[index - 1].start) return [];
  return rows;
}
/** The chapter playing at `seconds`, or null. */
export function chapterAt(chapters, seconds) {
  if (!Array.isArray(chapters) || !chapters.length || !Number.isFinite(seconds)) return null;
  let current = null;
  for (const chapter of chapters) { if (chapter.start <= seconds) current = chapter; else break; }
  return current;
}
/** A description cut for the model: no links, no chapter list, no hashtags-only lines, bounded at a sentence or word boundary. */
export function descriptionExcerpt(description, limit = MAX_DESCRIPTION) {
  if (typeof description !== 'string' || !description.trim()) return '';
  const lines = description.split(/\r?\n/)
    .filter(line => !/((?:\d{1,2}:)?\d{1,2}:\d{2})/.test(line) && !/^\s*(#\S+\s*)+$/.test(line))
    .map(line => line.replace(/https?:\/\/\S+/g, '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim()).filter(Boolean);
  let text = lines.join(' ').replace(/\s+/g, ' ').trim();
  if (text.length <= limit) return text;
  text = text.slice(0, limit);
  const sentence = Math.max(text.lastIndexOf('. '), text.lastIndexOf('! '), text.lastIndexOf('? '));
  if (sentence > limit * 0.5) return text.slice(0, sentence + 1);
  const space = text.lastIndexOf(' ');
  return (space > limit * 0.5 ? text.slice(0, space) : text).trimEnd() + '…';
}

/**
 * The game's command (runtime/youtube-tv-command.json, written by mod/youtube-tv.lua) -> {id, action, ...} or null. Fresh commands
 * only (30 s), a known action, an id never seen before (the caller keeps the seen ids). `strings` carries the page's sentences in the
 * player's interface language (key: the English source).
 */
export function parseTvCommand(raw, now = Date.now()) {
  if (typeof raw !== 'string' || !raw || Buffer.byteLength(raw, 'utf8') > COMMAND_MAX_BYTES) return null;
  let value;
  try { value = JSON.parse(raw); } catch { return null; }
  if (!plain(value) || value.version !== 1 || typeof value.id !== 'string' || !COMMAND_ID.test(value.id)
      || !COMMANDS.has(value.action) || !Number.isFinite(value.issuedAt)
      || value.issuedAt > now + 5000 || now - value.issuedAt > COMMAND_MAX_AGE_MS) return null;
  const command = {id: value.id, action: value.action};
  if (value.action === 'pick') {
    const video = parseVideoInput(value.video);
    if (!video) return null;
    command.video = video;
  }
  if (value.action === 'hide' || value.action === 'stop') {
    command.reason = typeof value.reason === 'string' && /^[a-z0-9-]{1,40}$/.test(value.reason) ? value.reason : 'game';
  }
  if (value.action === 'open') {
    command.language = typeof value.language === 'string' && /^[a-z]{2}(-[a-z]{2})?$/i.test(value.language) ? value.language : 'en';
    command.strings = cleanStrings(value.strings);
    command.place = typeof value.place === 'string' && /^[A-Za-z_]{1,64}$/.test(value.place) ? value.place : '';
  }
  return command;
}
/** {English: translation} pairs, both short plain strings; anything else is dropped. */
export function cleanStrings(value) {
  const result = {};
  if (!plain(value)) return result;
  let count = 0;
  for (const [key, text] of Object.entries(value)) {
    if (typeof key !== 'string' || typeof text !== 'string' || key.length > 300 || text.length > 600 || !text.trim()) continue;
    result[key] = text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
    if (++count >= 80) break;
  }
  return result;
}

// V's homes (gamedataDistrict names the game reports for the apartment interiors; checked in final.redscripts 2026-10-14).
export const HOME_PLACES = Object.freeze({
  LittleChina_VApartment: "V's apartment in Megabuilding H10", Northside_Apartment: "V's apartment in Northside",
  JapanTown_Apartment: "V's apartment in Japantown", Glen_Apartment: "V's apartment in the Glen",
  CorpoPlaza_Apartment: "V's apartment at Corpo Plaza"});

/**
 * The block for one turn, or ''. Only a companion talking with V in person gets it (not a stranger, a phone chat, a holocall, an
 * add-on voice or an automatic reaction), and only while a video is open. `video` is the session's snapshot (YouTubeTv.contextFor):
 * {videoId, title, channel, state: 'playing'|'paused'|'buffering'|'ended', position, duration, chapters, description, place,
 * captions: {cues, auto}}. With captions the companion hears what was just said; without them it gets title, channel, chapter and
 * description only.
 */
export function watchingContext(input, video, {ambient = false, voice = false} = {}) {
  if (!plain(input) || !plain(video) || ambient || voice || input.reaction || input.channel === 'phone' || input.holocall) return '';
  if (!VIDEO_ID.test(video.videoId ?? '')) return '';
  const title = cleanLine(video.title, MAX_TITLE), channel = cleanLine(video.channel, MAX_CHANNEL);
  const where = HOME_PLACES[video.place] ?? "V's apartment";
  const sentences = [title
    ? `You and V are watching a YouTube video together on the TV in ${where}: "${title}"${channel ? ` from the channel ${channel}` : ''}.`
    : `You and V are watching a YouTube video together on the TV in ${where}; its title is not known.`];
  const position = Number.isFinite(video.position) ? Math.max(0, video.position) : null;
  const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : null;
  const state = video.state === 'paused' ? 'paused' : video.state === 'ended' ? 'over' : 'playing';
  if (state === 'over') sentences.push('The video has just ended.');
  else if (position !== null) sentences.push(`It is ${state} at ${formatClock(position)}${duration ? ` of ${formatClock(duration)}` : ''}.`);
  const chapter = position !== null ? chapterAt(video.chapters, position) : null;
  if (chapter) sentences.push(`The part on screen now is the chapter "${chapter.title}".`);
  const cues = plain(video.captions) && Array.isArray(video.captions.cues) ? video.captions.cues : null;
  const said = cues && position !== null ? captionWindow(cues, state === 'over' && duration ? duration : position) : '';
  if (said) {
    const source = video.captions.auto ? 'its automatic captions, which can mishear words' : 'its captions';
    sentences.push(`Just before this moment the video said (from ${source}): "${said}"`);
  }
  // With captions the description matters less, so it gets less room.
  const about = descriptionExcerpt(video.description, said ? 200 : MAX_DESCRIPTION);
  if (about) sentences.push(`Its description says: ${about}`);
  const prefix = 'Watching together (from the game, right now): ';
  const suffix = ' You only know what is written here and what V says; never invent what is on screen or anything said in it beyond this. '
    + 'React in your own way when it fits, keep it short so V can keep watching, and do not recite this.';
  const budget = MAX_CONTEXT_CHARS - prefix.length - suffix.length;
  // Over budget: drop whole sentences from the end (the description first, then the captions), never the first one.
  while (sentences.length > 1 && sentences.join(' ').length > budget) sentences.pop();
  let body = sentences.join(' ');
  if (body.length > budget) body = body.slice(0, budget - 1) + '…';
  return prefix + body + suffix;
}

/**
 * The caption text around `position`: cues that overlap the last CAPTION_BEFORE_S seconds (up to CAPTION_AFTER_S ahead), in order,
 * repeated lines dropped (automatic captions roll), at most `maxChars` with the newest words kept. '' when nothing was said.
 * `cues` is sorted by start (parseTimedText); a binary search finds the window, so a long video costs the same as a short one.
 */
export function captionWindow(cues, position, {before = CAPTION_BEFORE_S, after = CAPTION_AFTER_S, maxChars = MAX_CAPTION_CHARS} = {}) {
  if (!Array.isArray(cues) || !cues.length || !Number.isFinite(position)) return '';
  const from = position - before, to = position + after;
  // The first cue that starts after `to`; walk back from there while cues still reach into the window.
  let low = 0, high = cues.length;
  while (low < high) { const middle = (low + high) >> 1; if (cues[middle].start <= to) low = middle + 1; else high = middle; }
  const picked = [];
  for (let index = low - 1; index >= 0 && picked.length < 200; index--) {
    const cue = cues[index];
    if (cue.end < from) { if (cue.start < from - 60) break; continue; }   // long overlapping cues are rare; stop a minute back
    picked.push(cue.text);
  }
  picked.reverse();
  const lines = [];
  for (const text of picked) if (text !== lines.at(-1)) lines.push(text);
  let result = lines.join(' ').replace(/\s+/g, ' ').trim();
  if (result.length > maxChars) {
    result = result.slice(result.length - maxChars);
    const space = result.indexOf(' ');
    result = '…' + (space >= 0 && space < 40 ? result.slice(space + 1) : result);
  }
  return result;
}

const decodeEntities = text => text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|#39);/gi, (all, code) => {
  const lower = code.toLowerCase();
  if (lower === 'amp') return '&'; if (lower === 'lt') return '<'; if (lower === 'gt') return '>';
  if (lower === 'quot') return '"'; if (lower === 'apos' || lower === '#39') return "'";
  const value = lower.startsWith('#x') ? parseInt(lower.slice(2), 16) : parseInt(lower.slice(1), 10);
  return Number.isFinite(value) && value > 0 && value < 0x110000 ? String.fromCodePoint(value) : '';
});
const cueText = value => {
  const text = decodeEntities(String(value ?? '').replace(/<[^>]*>/g, '')).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return text.length > MAX_CUE_TEXT ? text.slice(0, MAX_CUE_TEXT) : text;
};
const vttClock = value => {
  const match = /^(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})$/.exec(value.trim());
  return match ? Number(match[1] ?? 0) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number(match[4].padEnd(3, '0')) / 1000 : null;
};

/**
 * A caption track as the player fetched it -> cues [{start, end, text}] in seconds, sorted, empty lines dropped. Reads YouTube's
 * json3 (what the embedded player asks for), its XML formats (srv3 <p t= d=>, srv1 <text start= dur=>) and WebVTT. Anything else -> [].
 */
export function parseTimedText(body) {
  if (typeof body !== 'string' || !body.trim()) return [];
  const cues = [];
  const push = (start, end, text) => {
    if (!Number.isFinite(start) || start < 0 || cues.length >= MAX_CUES) return;
    const clean = cueText(text);
    if (clean) cues.push({start, end: Number.isFinite(end) && end > start ? end : start + 2, text: clean});
  };
  const head = body.trimStart();
  if (head.startsWith('{')) {
    let value; try { value = JSON.parse(body); } catch { return []; }
    for (const event of Array.isArray(value?.events) ? value.events : []) {
      if (!plain(event) || !Array.isArray(event.segs) || !Number.isFinite(event.tStartMs)) continue;
      const text = event.segs.map(seg => (plain(seg) && typeof seg.utf8 === 'string' ? seg.utf8 : '')).join('');
      push(event.tStartMs / 1000, (event.tStartMs + (Number(event.dDurationMs) || 0)) / 1000, text);
    }
  } else if (head.startsWith('WEBVTT')) {
    for (const block of body.replace(/\r/g, '').split(/\n{2,}/)) {
      const lines = block.split('\n');
      const at = lines.findIndex(line => line.includes('-->'));
      if (at < 0) continue;
      const [startText, rest = ''] = lines[at].split('-->');
      push(vttClock(startText), vttClock(rest.trim().split(/\s+/)[0] ?? ''), lines.slice(at + 1).join(' '));
    }
  } else if (head.startsWith('<')) {
    for (const match of body.matchAll(/<p\b([^>]*)>([\s\S]*?)<\/p>/g)) {
      const t = /\bt="(\d+)"/.exec(match[1]), d = /\bd="(\d+)"/.exec(match[1]);
      if (t) push(Number(t[1]) / 1000, (Number(t[1]) + Number(d?.[1] ?? 0)) / 1000, match[2]);
    }
    if (!cues.length) for (const match of body.matchAll(/<text\b([^>]*)>([\s\S]*?)<\/text>/g)) {
      const start = /\bstart="([\d.]+)"/.exec(match[1]), dur = /\bdur="([\d.]+)"/.exec(match[1]);
      if (start) push(Number(start[1]), Number(start[1]) + Number(dur?.[1] ?? 0), match[2]);
    }
  }
  return cues.sort((a, b) => a.start - b.start);
}

/** A caption request the player made (https://www.youtube.com/api/timedtext?v=..&lang=..&kind=asr&tlang=..) -> its track, or null. */
export function timedTextTrack(url) {
  let value; try { value = new URL(url); } catch { return null; }
  if (value.protocol !== 'https:' || value.hostname !== 'www.youtube.com' || value.pathname !== '/api/timedtext') return null;
  const videoId = value.searchParams.get('v') ?? '';
  if (!VIDEO_ID.test(videoId)) return null;
  const languageCode = (value.searchParams.get('lang') ?? '').slice(0, 20);
  return {videoId, languageCode, auto: value.searchParams.get('kind') === 'asr', translated: !!value.searchParams.get('tlang')};
}

/**
 * How good a caption track is for the companion: written captions over automatic ones, the video's own over a machine translation,
 * then the game's interface language, then English. Higher is better.
 */
export function trackRank(track, language = 'en') {
  if (!plain(track)) return -1;
  const code = String(track.languageCode ?? '').toLowerCase(), wanted = String(language ?? 'en').toLowerCase();
  let rank = track.auto ? 0 : 100;
  if (track.translated) rank -= 60;
  if (code && (code === wanted || code.split('-')[0] === wanted.split('-')[0])) rank += 20;
  else if (code === 'en' || code.startsWith('en-')) rank += 10;
  return rank;
}

/**
 * The embedded player's own answer for the video (its youtubei/v1/player request) -> {title, channel, description, chapters,
 * duration, tracks: [{languageCode, auto, name}]} or null when it is about another video.
 */
export function parsePlayerResponse(value, videoId) {
  const details = plain(value) && plain(value.videoDetails) ? value.videoDetails : null;
  if (!details || details.videoId !== videoId || !VIDEO_ID.test(videoId ?? '')) return null;
  const description = typeof details.shortDescription === 'string' ? details.shortDescription.slice(0, 5000) : '';
  const title = cleanLine(details.title, MAX_TITLE), channel = cleanLine(details.author, MAX_CHANNEL);
  const seconds = Number(details.lengthSeconds);
  const list = value.captions?.playerCaptionsTracklistRenderer?.captionTracks;
  const tracks = (Array.isArray(list) ? list : []).slice(0, 60).filter(plain).map(track => ({
    languageCode: String(track.languageCode ?? '').slice(0, 20), auto: track.kind === 'asr',
    name: cleanLine(track.name?.simpleText ?? track.name?.runs?.[0]?.text ?? '', 60) ?? ''})).filter(track => track.languageCode);
  return {...(title ? {title} : {}), ...(channel ? {channel} : {}), description, chapters: parseChapters(description),
    ...(Number.isFinite(seconds) && seconds > 0 ? {duration: seconds} : {}), tracks};
}

/** oEmbed answer -> {title, channel} or null (public endpoint, no key; https://www.youtube.com/oembed). */
export function parseOembed(value) {
  if (!plain(value)) return null;
  const title = cleanLine(value.title, MAX_TITLE), channel = cleanLine(value.author_name, MAX_CHANNEL);
  return title ? {title, ...(channel ? {channel} : {})} : null;
}

/** Title and channel from oEmbed (no key). fetch is injectable for tests. Never throws: a failed lookup gives {}. */
export async function lookupVideo(videoId, {fetch = globalThis.fetch, timeoutMs = 4000, signal} = {}) {
  if (!VIDEO_ID.test(videoId ?? '') || typeof fetch !== 'function') return {};
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs);
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, {once: true});
  try {
    const watch = `https://www.youtube.com/watch?v=${videoId}`;
    const response = await fetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(watch)}`,
      {signal: controller.signal, headers: {accept: 'application/json'}});
    if (!response.ok) return {};
    return parseOembed(await response.json()) ?? {};
  } catch { return {}; } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}
