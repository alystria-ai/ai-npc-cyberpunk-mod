// YouTube on V's TV (docs/YOUTUBE_TV.md): the pure parts. Which video a pasted text names, the chapters in a description, the
// command file the game writes, and the "watching together" block a companion's turn carries while a video plays.
//
// Terms (docs/YOUTUBE_TV.md, "YouTube's terms"): the video only ever plays in YouTube's own embedded player (IFrame Player API),
// fully visible, with nothing drawn over it. Nothing here downloads, caches or rips a video or its captions. The title and channel come
// from YouTube's public oEmbed endpoint; the description and chapters only from the YouTube Data API with the player's own key.
// What a companion learns is said for this turn only and is never written to memory.

export const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtube-nocookie.com',
  'www.youtube-nocookie.com', 'youtu.be']);
const COMMANDS = new Set(['open', 'toggle', 'pause', 'resume', 'stop', 'hide', 'show', 'pick']);
const COMMAND_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,95}$/;
const COMMAND_MAX_BYTES = 64 * 1024, COMMAND_MAX_AGE_MS = 30_000;
// The whole watching block, framing included.
export const MAX_CONTEXT_CHARS = 900;
const MAX_TITLE = 160, MAX_CHANNEL = 80, MAX_CHAPTER = 80, MAX_DESCRIPTION = 360, MAX_CHAPTERS = 100;

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
 * add-on voice or an automatic reaction), and only while a video is open. `video` is the session's snapshot (YouTubeTv.snapshot()):
 * {videoId, title, channel, state: 'playing'|'paused'|'buffering'|'ended', position, duration, chapters, description, place}.
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
  const about = descriptionExcerpt(video.description);
  if (about) sentences.push(`Its description says: ${about}`);
  const prefix = 'Watching together (from the game, right now): ';
  const suffix = ' You only know what is written here and what V says; never invent what is on screen or what someone in it said. '
    + 'React in your own way when it fits, keep it short so V can keep watching, and do not recite this.';
  const budget = MAX_CONTEXT_CHARS - prefix.length - suffix.length;
  // Over budget: drop whole sentences from the end (the description first), never the first one.
  while (sentences.length > 1 && sentences.join(' ').length > budget) sentences.pop();
  let body = sentences.join(' ');
  if (body.length > budget) body = body.slice(0, budget - 1) + '…';
  return prefix + body + suffix;
}

/** oEmbed answer -> {title, channel} or null (public endpoint, no key; https://www.youtube.com/oembed). */
export function parseOembed(value) {
  if (!plain(value)) return null;
  const title = cleanLine(value.title, MAX_TITLE), channel = cleanLine(value.author_name, MAX_CHANNEL);
  return title ? {title, ...(channel ? {channel} : {})} : null;
}
/** ISO 8601 duration ("PT1H2M3S") -> seconds, or null. */
export function parseIsoDuration(value) {
  const match = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(typeof value === 'string' ? value : '');
  if (!match || value === 'P' || value === 'PT') return null;
  return Number(match[1] ?? 0) * 86400 + Number(match[2] ?? 0) * 3600 + Number(match[3] ?? 0) * 60 + Number(match[4] ?? 0);
}
/** YouTube Data API v3 videos.list answer -> {title, channel, description, chapters, duration} or null. */
export function parseDataApiVideo(value, videoId) {
  const item = plain(value) && Array.isArray(value.items) ? value.items.find(row => row?.id === videoId) : null;
  if (!plain(item) || !plain(item.snippet)) return null;
  const description = typeof item.snippet.description === 'string' ? item.snippet.description.slice(0, 5000) : '';
  const title = cleanLine(item.snippet.title, MAX_TITLE), channel = cleanLine(item.snippet.channelTitle, MAX_CHANNEL);
  const duration = parseIsoDuration(item.contentDetails?.duration);
  return {...(title ? {title} : {}), ...(channel ? {channel} : {}), description, chapters: parseChapters(description),
    ...(duration !== null ? {duration} : {})};
}
/** A Data API key as the player pasted it: Google API keys are 39 characters starting "AIza". */
export const validDataApiKey = key => typeof key === 'string' && /^AIza[0-9A-Za-z_-]{35}$/.test(key.trim());

/**
 * Title and channel (oEmbed), and with the player's key also the description and chapters (Data API videos.list, 1 quota unit).
 * fetch is injectable for tests. Never throws: a failed lookup gives what it could, or {}.
 */
export async function lookupVideo(videoId, {fetch = globalThis.fetch, dataApiKey = '', timeoutMs = 4000, signal} = {}) {
  if (!VIDEO_ID.test(videoId ?? '') || typeof fetch !== 'function') return {};
  const get = async url => {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs);
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, {once: true});
    try {
      const response = await fetch(url, {signal: controller.signal, headers: {accept: 'application/json'}});
      if (!response.ok) return null;
      return await response.json();
    } catch { return null; } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
  };
  const watch = `https://www.youtube.com/watch?v=${videoId}`;
  const [oembed, data] = await Promise.all([
    get(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(watch)}`),
    validDataApiKey(dataApiKey)
      ? get(`https://www.googleapis.com/youtube/v3/videos?part=snippet,contentDetails&id=${videoId}&key=${encodeURIComponent(dataApiKey.trim())}`)
      : Promise.resolve(null)]);
  return {...(parseOembed(oembed) ?? {}), ...(parseDataApiVideo(data, videoId) ?? {})};
}
