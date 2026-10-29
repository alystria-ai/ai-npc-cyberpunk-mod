// Two pure functions about audio inputs, browser-safe (no imports): the capture page embeds matchInput's source, and the Convai page's own microphone path imports it.
//
// matchInput: the input a saved name stands for. Chromium's device ids are per origin and per browser profile, so the player's choice is kept as the device's LABEL and
// matched against what the page lists now: the exact label first, then the same label without case, spacing or the trailing (vid:pid) hardware id (Windows renumbers
// "2- USB Audio Device" when the ports change). Windows' virtual 'default' and 'communications' entries never count: "Windows default" is the absence of a choice.
// It runs in the capture page too (the function's source is embedded there), so it uses nothing from this module.
export function matchInput(devices, wanted) {
  const want = String(wanted ?? '');
  if (!want) return null;
  const list = (Array.isArray(devices) ? devices : []).filter(d => d && d.label && d.deviceId !== 'default' && d.deviceId !== 'communications');
  const exact = list.find(d => d.label === want);
  if (exact) return exact;
  const norm = label => String(label).toLowerCase().replace(/\s*\([0-9a-f]{4}:[0-9a-f]{4}\)\s*$/, '').replace(/\s+/g, ' ').trim();
  const key = norm(want);
  return list.find(d => norm(d.label) === key) || null;
}

// An input that probably records what the PC PLAYS (a call's other side, music, the game) instead of, or mixed with, a microphone: a sound card's loopback ("Stereo Mix",
// "What U Hear"), a virtual cable ("CABLE Output"), a mixer's outputs (VoiceMeeter "Out", the GoXLR's stream mix and sampler, Wave Link's stream, Sonar's stream), a virtual
// audio device and anything named after Discord. Only by the name Windows and the driver give it, so it is a "likely": the settings row warns, nothing is ever picked or refused
// because of it. A real microphone of the same maker ("Chat Mic (GoXLR)", "Microphone (NVIDIA Broadcast)", "Wave Link MicrophoneFX") is not matched.
const LOOPBACK_PATTERNS = [
  /stereo\s*mix|stereomix|what\s*(u|you)\s*hear|wave[\s-]*out\s*mix|loop[\s-]*back/i,
  // Windows' own name for it in other languages (the label is the driver's, and Windows localises the common one).
  /mixage\s+st[eé]r[eé]o|mezcla\s+est[eé]reo|missaggio\s+stereo|mixagem\s+est[eé]reo|miks\s+stereo|st[eé]r[eé]o\s+mix|стерео\s*микшер|ステレオ\s*ミキサー|立体声混音|立體聲混音|스테레오\s*믹스|sztereó\s*keverő|stereo\s+karışım|стерео\s*мікшер/i,
  /\bcable[\s-]*([a-d][\s-]*)?(hi-?fi\s*)?(out|output|in|input)\b|vb-?audio|virtual[\s-]*(cable|audio|mic|input|output|device)|voice\s*meeter|\bvaio\b/i,
  /discord/i,
  /wave\s*link\s*(stream|monitor)|elgato\s+virtual|sonar\s*-\s*(stream|chat|gaming|media|aux)/i,
];
const GOXLR_MIXES = /\b(broadcast\s+stream\s+mix|stream\s+mix|sample|system|music|game|headphones|console)\b/i;
export function looksLikeLoopback(label) {
  const text = String(label ?? '').replace(/^\s*(default|communications)\s*-\s*/i, '').trim();
  if (!text) return false;
  if (LOOPBACK_PATTERNS.some(pattern => pattern.test(text))) return true;
  return /goxlr|tc-?helicon/i.test(text) && GOXLR_MIXES.test(text);
}

// The note a recording carries when the input the player chose in Settings > Voices was not there and the Windows default was used (the game says so once).
export const MIC_DEVICE_NOTE = 'mic-device-gone';
// The note when the Windows default input (no choice made) looks like it records the PC's own sound instead of a microphone (a loopback, a virtual cable, a mixer's output,
// bridge/mic-match.mjs looksLikeLoopback): the game says once that the far side of a call may be heard and where to choose the real microphone. Never when the player chose it.
export const MIC_LOOPBACK_NOTE = 'mic-loopback';
/** The note an opened input carries, if any: the chosen input was gone (default used) first, else a default that looks like a loopback. */
export function inputNote(info) {
  if (info?.missing) return MIC_DEVICE_NOTE;
  if (info?.loopback === true && !info?.requested) return MIC_LOOPBACK_NOTE;
  return undefined;
}
