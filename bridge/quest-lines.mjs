// Scripted quest lines on the bridge (docs/QUEST_PRIMITIVES.md section 4, docs/BOND_QUESTS.md section 14.2). The game asks for a line of a story pack with a private turn of
// the speaking character: `reaction = {kind: 'scripted', pack, line, channel, expiresAt}`. The request's text is a placeholder: the words and the prepared audio come from
// the pack (bridge/bond-pack-runner.mjs lineFor), never from the request. No model, no knowledge route, no Convai memory and no allowance belong to the turn
// (bridge/convai-bridge.mjs runScriptedTurn). Pure.
import {isAmbientProfile} from './protocol.mjs';

// A pack id (the registry's) and a line id (letters, digits and ._:- , as the pack validator writes them). Conservative on purpose: both are looked up in the
// active packs, never used as a path.
export const SCRIPTED_PACK = /^[a-z][a-z0-9-]{2,47}$/;
export const SCRIPTED_LINE = /^[A-Za-z0-9._:-]{1,64}$/;
// own: in person (the default). holocall: over the phone. head: Johnny in V's ear. remote: a copy's voice in V's ear.
export const SCRIPTED_CHANNELS = Object.freeze(['own', 'holocall', 'head', 'remote']);

const plain = value => !!value && typeof value === 'object' && !Array.isArray(value);

/**
 * The reaction of a scripted line -> {kind: 'scripted', pack, line, channel, expiresAt}, or null (fail closed). A named roster character only: never an ordinary NPC
 * (resident, archetype). Extra fields are not read.
 */
export function parseScriptedReaction(value, profileKey) {
  if (!plain(value) || value.kind !== 'scripted') return null;
  if (typeof value.pack !== 'string' || !SCRIPTED_PACK.test(value.pack)) return null;
  if (typeof value.line !== 'string' || !SCRIPTED_LINE.test(value.line)) return null;
  if (!SCRIPTED_CHANNELS.includes(value.channel)) return null;
  if (!Number.isSafeInteger(value.expiresAt) || value.expiresAt <= 0) return null;
  if (typeof profileKey !== 'string' || !/^[a-z0-9-]{1,80}$/.test(profileKey) || isAmbientProfile(profileKey)) return null;
  return {kind: 'scripted', pack: value.pack, line: value.line, channel: value.channel, expiresAt: value.expiresAt};
}

// The mod's emotion categories a pack line can name (docs/BOND_QUEST_LINES.md) as the label the face plan reads (bridge/emotion-selector.mjs PROVIDER_FAMILIES).
// neutral, emphatic and the gesture words (shrug, nod, question) say nothing about the face: the plan reads the line's own words then.
const EMOTION_LABEL = Object.freeze({happy: 'happy', sad: 'sadness', fear: 'fear', angry: 'anger', surprise: 'surprise'});
// A line's feeling as an ordered emotion (the shape of a Convai label, bridge/convai-emotion.mjs: basis 'ordered', scale 1 to 3), or undefined.
export function expressionSignalFor(emotion) {
  if (typeof emotion !== 'string') return undefined;
  const label = EMOTION_LABEL[emotion.trim().toLowerCase().split('/')[0]];
  return label ? {version: 1, correlated: true, sequence: 0, emotion: label, scale: 2, basis: 'ordered'} : undefined;
}

/**
 * What the runner resolved for a line ({text, audioPath, emotion, gesture, channel, speaker}) -> the reply the turn publishes, or null when there is nothing to say.
 * {text, model: 'scripted', finishReason: 'stop', transport: 'local', expressionSignal?, audioPath | missingAudio: true}. A line with no audio file is `missingAudio`: the
 * prepared audio is always the voice (owner decision of 29 Oct 2026), so a line without it is shown as a subtitle and NEVER spoken by a live voice, whatever voice the
 * player chose. The turn logs a pack error for it (once per pack and line) and the reply file the game reads carries `missingAudio: true`, so the game can add a Phone Chat line.
 */
export function scriptedResult(resolved) {
  if (!plain(resolved) || typeof resolved.text !== 'string' || !resolved.text.trim()) return null;
  const signal = expressionSignalFor(resolved.emotion);
  const audioPath = typeof resolved.audioPath === 'string' && resolved.audioPath ? resolved.audioPath : null;
  return {text: resolved.text.trim(), model: 'scripted', finishReason: 'stop', transport: 'local', ...(signal ? {expressionSignal: signal} : {}),
    ...(audioPath ? {audioPath} : {missingAudio: true})};
}

/**
 * How a scripted reply is voiced: 'prepared' (its audio file, whatever voice the player chose) or 'text' (shown only: no file, or the player turned voice playback off).
 * There is no live-voice route: a line without a file is never given to a live voice.
 */
export function scriptedRoute(reply, {playbackEnabled = true} = {}) {
  if (!playbackEnabled || !plain(reply)) return 'text';
  return reply.audioPath ? 'prepared' : 'text';
}
