// Builds the unlabelled per-segment evaluation units (assets/emotion/segments-units.json) from real companion replies:
//   runtime/emotion-probe/<label>-<profile>.json   (scripts/Probe-EmotionReplies.mjs: raw reply with the character's own
//                                                    inline tags, the player's line, Convai's late label)
//   runtime/follow-up-probe/*.json                  (older probes whose `raw` rows kept the tags)
// Each reply is cleaned and segmented exactly as the bridge does it for OmniVoice (tags parsed into marks, phrase edges
// from splitSpeechText as forced boundaries, then emotion-analysis segmentText), so a unit is one face segment.
//   node scripts/Build-EmotionSegmentSet.mjs [--out assets/emotion/segments-units.json] [--followup 24]
import {readFile, readdir, writeFile} from 'node:fs/promises';
import {resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseTagged} from '../bridge/speech-tags.mjs';
import {splitSpeechText} from '../bridge/speech-phrases.mjs';
import {phraseOffsets, segmentText} from '../bridge/emotion-analysis.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const option = (name, fallback) => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : fallback; };
const out = resolve(root, option('--out', 'assets/emotion/segments-units.json'));
const followUps = Number(option('--followup', 24));
const only = option('--only');   // a probe label such as set3: only those replies (no older follow-up rows)

const replies = [];
const probeDir = resolve(root, option('--probe-dir', 'runtime/emotion-probe'));
for (const file of (await readdir(probeDir)).sort()) {
  if (!file.endsWith('.json')) continue;
  const data = JSON.parse(await readFile(resolve(probeDir, file), 'utf8'));
  if (only && data.label !== only) continue;
  for (const row of data.rows) if (row.raw) replies.push({set: data.label, profile: data.profile, player: row.player, raw: row.raw, convai: row.convai ?? null});
}
// Older follow-up probes (Judy, Panam, Johnny, a gang member): only rows that kept their tags; one reply per distinct
// player line and profile, a fixed pick (every k-th) so the set is repeatable.
const followDir = resolve(root, 'runtime/follow-up-probe');
const seen = new Set(), older = [];
for (const file of (await readdir(followDir).catch(() => [])).sort()) {
  if (!file.endsWith('.json')) continue;
  const data = JSON.parse(await readFile(resolve(followDir, file), 'utf8'));
  for (const [profile, value] of Object.entries(data.profiles ?? {})) for (const row of value.rows ?? []) {
    const key = profile + '|' + row.text;
    if (!row.raw || !/\{[a-z]+(:\w+)?\}/.test(row.raw) || seen.has(key)) continue;
    seen.add(key); older.push({set: 'followup', profile, player: row.text, raw: row.raw, convai: null});
  }
}
if (!only) {
  const step = Math.max(1, Math.floor(older.length / Math.max(1, followUps)));
  replies.push(...older.filter((_, index) => index % step === 0).slice(0, followUps));
}

const units = [];
replies.forEach((entry, index) => {
  const parsed = parseTagged(entry.raw), reply = parsed.display;
  if (!reply.trim()) return;
  const phrases = splitSpeechText(reply), spans = phraseOffsets(reply, phrases);
  const segments = segmentText(reply, {breaks: spans.slice(1).map(span => span[0])});
  const id = `${entry.set}-${entry.profile}-${String(index).padStart(3, '0')}`;
  segments.forEach((segment, at) => units.push({id: `${id}-${at}`, reply: id, set: entry.set, profile: entry.profile, player: entry.player,
    replyText: reply, marks: parsed.marks.map(({at: where, name, strength}) => ({at: where, name, strength})), convai: entry.convai,
    from: segment.start, to: segment.end, text: reply.slice(segment.start, segment.end)}));
});
await writeFile(out, JSON.stringify({built: new Date().toISOString(), replies: replies.length, units}, null, 1) + '\n');
console.log(JSON.stringify({out: out.replace(root, ''), replies: replies.length, units: units.length,
  bySet: units.reduce((acc, unit) => { acc[unit.set] = (acc[unit.set] ?? 0) + 1; return acc; }, {})}));
