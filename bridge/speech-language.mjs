// Which language is the player speaking, and which recogniser can hear it? (docs/LOCAL_STT.md, "Other languages".)
//
// The local recogniser for English (Moonshine Tiny, bridge/local-stt.mjs) hears English only. For any other language the
// recording is recognised by another engine, chosen here from what the bridge already knows, with no new work per frame:
//   1. Evidence from the player: the language of the last text they typed, or of the last recording an engine placed
//      (Mistral's transcription answers with the language it heard). Both are in memory for the life of the bridge, and the language
//      is also written to a small file in the state folder whenever it changes (player-language.json), read once at the start as the
//      first evidence: a French player with an English game gets the French recogniser from the first recording of the next launch.
//   2. The interface language: the explicit "Interface language" setting, else the game's own language as the game side wrote it
//      into runtime/ui-language.txt when it last changed (mod/init.lua). The file is read when a recording opens, never per frame.
//   3. English. Nothing is known: today's path, unchanged.
// English evidence keeps the English path whatever the interface says (an English speaker with a Russian game gets Moonshine).
//
// Pure functions and one small state holder: no I/O except the optional file read the caller passes in.
import {spokenLanguage} from './reply-language.mjs';
import {VOXTRAL_STT3_LANGUAGES} from './voxtral-languages.mjs';

// The languages Mistral's transcription model lists (Voxtral Mini Transcribe 3, docs.mistral.ai, 2026-10-21; bridge/voxtral-languages.mjs): 44 of the
// 50 it supports are named. A language that is not named (Mistral prints no full list) is still asked, without a language hint, and may be understood.
export const VOXTRAL_LANGUAGES = VOXTRAL_STT3_LANGUAGES;

// The mod's interface languages (mod/locales) as the base language the recognisers use.
export const MOD_LANGUAGES = Object.freeze(['en', 'de', 'fr', 'es', 'it', 'pt', 'pl', 'ru', 'uk', 'tr', 'cs', 'hu', 'ja', 'ko', 'zh']);

// Local multilingual recogniser packs (optional downloads, run in the same sherpa-onnx worker as Moonshine). `kind` picks the loader in
// bridge/local-stt-worker.py; `files` must all exist in `models/stt/<id>` (packaged) or `runtime/stt-model/<id>` (development).
export const LOCAL_PACKS = Object.freeze([
  Object.freeze({id: 'parakeet-tdt-0.6b-v3-int8', kind: 'nemo-transducer', label: 'NVIDIA Parakeet TDT 0.6B v3 (int8)',
    files: Object.freeze(['encoder.int8.onnx', 'decoder.int8.onnx', 'joiner.int8.onnx', 'tokens.txt']),
    languages: Object.freeze(['ru', 'uk', 'pl', 'cs', 'hu', 'de', 'fr', 'es', 'it', 'pt']), licence: 'CC-BY-4.0'}),
  Object.freeze({id: 'sense-voice-int8', kind: 'sense-voice', label: 'FunAudioLLM SenseVoice Small (int8)',
    // The original SenseVoice Small (sherpa-onnx archive 2024-07-17), measured with the real files (2026-10-19): character error zh 0.0%, ja 6.5%, ko 2.0%.
    // NOT the 2025-09-09 archive of the same name, which is a Cantonese fine-tune that reads Mandarin but not Japanese (84% error) or Korean (96%).
    files: Object.freeze(['model.int8.onnx', 'tokens.txt']), languages: Object.freeze(['zh', 'ja', 'ko']), licence: 'FunASR Model Open Source License 1.1'}),
]);

const NAMES = {english: 'en', german: 'de', french: 'fr', spanish: 'es', italian: 'it', portuguese: 'pt', polish: 'pl', russian: 'ru',
  ukrainian: 'uk', turkish: 'tr', czech: 'cs', hungarian: 'hu', japanese: 'ja', korean: 'ko', chinese: 'zh', mandarin: 'zh', dutch: 'nl',
  hindi: 'hi', arabic: 'ar'};

/** 'pt-br' / 'PT_br' / 'Russian' / 'ru' -> the base code ('pt', 'ru'), or null when it is not a language this module can use. */
export function baseLanguage(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim().toLowerCase().replace(/_/g, '-');
  if (!text || text.length > 40) return null;
  if (NAMES[text]) return NAMES[text];
  const base = text.split('-')[0];
  return /^[a-z]{2,3}$/.test(base) ? (base === 'cz' ? 'cs' : base === 'ua' ? 'uk' : base === 'jp' ? 'ja' : base === 'kr' ? 'ko' : base) : null;
}

/** The pack that hears `language` whether or not it is installed (what the player could download), or null. */
export function packThatHears(language) {
  return LOCAL_PACKS.find(pack => pack.languages.includes(language)) ?? null;
}

/** The pack (from `installed`, a Set or array of pack ids) that hears `language`, or null. */
export function packFor(language, installed = []) {
  const have = installed instanceof Set ? installed : new Set(installed);
  return LOCAL_PACKS.find(pack => have.has(pack.id) && pack.languages.includes(language)) ?? null;
}

/**
 * How one recording is recognised. `language` is the player's language ('en' = today's path). `provider` is the provider answering
 * turns ('mistral', 'local', 'custom', 'convai' for an add-on voice key). Audio goes to Mistral's transcription only while Mistral is the
 * player's conversation provider (their words already go there); the Local AI and custom routes keep it on this computer.
 *   {mode: 'english'}                              Moonshine, as always
 *   {mode: 'voxtral', hint, fallback: [..]}        Mistral transcription; `fallback` are the modes tried when it fails
 *   {mode: 'pack', pack}                           a local multilingual pack
 *   {mode: 'english', note: 'english-only'}        nothing here hears the language: English recogniser, and the player is told once
 *   {mode: 'english', note: 'pack-available'}      an optional pack that hears the language is not installed: same, and the notice names the pack
 */
export function planRecording({language = 'en', source = 'default', provider = 'convai', voxtralReady = false, installed = [], englishAvailable = true} = {}) {
  if (!language || language === 'en') return {mode: 'english', language: 'en', source};
  const pack = packFor(language, installed);
  const hint = source !== 'ui' && VOXTRAL_LANGUAGES.includes(language) ? language : null;
  if (provider === 'mistral' && voxtralReady) {
    return {mode: 'voxtral', language, source, hint, fallback: [...(pack ? [{mode: 'pack', pack}] : []), ...(englishAvailable ? [{mode: 'english'}] : [])]};
  }
  if (pack) return {mode: 'pack', language, source, pack};
  return {mode: 'english', language, source, note: packThatHears(language) ? 'pack-available' : 'english-only'};
}

/** The file that remembers the player's language between launches (state folder). */
export const PLAYER_LANGUAGE_FILE = 'player-language.json';

/** The text of the file for a language, and the language a file's text holds ('fr') or null (missing, unreadable or invalid: ignored). */
export const playerLanguageText = language => JSON.stringify({version: 1, language});
export function parsePlayerLanguage(raw) {
  if (typeof raw !== 'string' || raw.length > 400) return null;
  let value; try { value = JSON.parse(raw.replace(/^﻿/, '')); } catch { return null; }
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== 1 || typeof value.language !== 'string') return null;
  // Only a plain two or three letter code the bridge itself writes: nothing else is trusted as a language.
  return /^[a-z]{2,3}$/.test(value.language) ? value.language : null;
}

/**
 * What the bridge knows about the player's language. `readUiFile` (async, optional) returns the text of runtime/ui-language.txt.
 * `remembered` is the language of the previous launch (parsePlayerLanguage of the saved file); `remember(language)` is called, with no wait,
 * each time the evidence changes to a new language: the caller writes the file in the background. Neither is read or written per frame.
 */
export class SpeechLanguage {
  constructor({readUiFile = null, now = Date.now, remembered = null, remember = null} = {}) {
    Object.assign(this, {readUiFile, now, remember});
    this.setting = 'auto';        // settings.json "uiLanguage": 'auto' or a code
    this.chosen = null;           // the Voice language the player fixed to an Other language (bridge/other-languages.mjs), as a code
    this.evidence = null;         // {language, source: 'text' | 'voice' | 'saved', at}
    this.fileText = null; this.fileAt = 0;
    const saved = baseLanguage(remembered);
    if (saved) this.evidence = {language: saved, source: 'saved', at: 0};
  }
  /** The settings object the bridge polls (only `uiLanguage` is read). */
  update(settings) {
    const value = settings?.uiLanguage;
    this.setting = typeof value === 'string' && value ? value : 'auto';
  }
  /**
   * The language the player fixed with Voice language > Other language (a code such as 'fi'), or null. The player speaks it, so it is the recording's language
   * until the recogniser itself reports another one (a recording that says 'en' is English): the typed text of a language the word lists cannot tell ('hei') says nothing.
   */
  setChosen(code) {
    const next = typeof code === 'string' && /^[a-z]{2,3}$/.test(code) ? code : null;
    if (next === this.chosen) return false;
    this.chosen = next;
    return true;
  }
  /** Text the player typed. Only a clear language counts (a short or mixed line says nothing). Returns true when the language changed. */
  observeText(text) {
    if (typeof text !== 'string' || !text.trim()) return false;
    // A short line in Latin letters says little ("hows biz" is not Turkish): spokenLanguage keeps English and accepts another language only when solid.
    return this.#set(spokenLanguage(text), 'text');
  }
  /** The language an engine reported for a recording ('ru', 'Russian', 'pt-br'). */
  observeVoice(value) { return this.#set(baseLanguage(value), 'voice'); }
  #set(language, source) {
    if (!language) return false;
    const changed = this.evidence?.language !== language;
    this.evidence = {language, source, at: this.now()};
    if (changed && typeof this.remember === 'function') { try { this.remember(language); } catch { /* remembering is a convenience */ } }
    return changed;
  }
  async #ui() {
    if (this.setting !== 'auto') return baseLanguage(this.setting);
    if (!this.readUiFile) return null;
    // At most one read in a few seconds: the file changes only when the player changes the game language.
    if (this.now() - this.fileAt > 3000 || this.fileText === null) {
      this.fileAt = this.now();
      try { this.fileText = String(await this.readUiFile() ?? ''); } catch { this.fileText = ''; }
    }
    return baseLanguage(this.fileText);
  }
  /**
   * The game's own text language (the interface language setting, else runtime/ui-language.txt as last read), as a base code, or null. It is the
   * weakest prior of the reply-language detection (bridge/multilingual.mjs). `refreshUi()` reads the file (at most once in a few seconds).
   */
  uiPrior() {
    if (this.setting !== 'auto') return baseLanguage(this.setting);
    return this.fileText ? baseLanguage(this.fileText) : null;
  }
  async refreshUi() { await this.#ui(); return this.uiPrior(); }
  /** {language, source} for the recording that opens now: 'text' | 'voice' | 'ui' | 'default'. */
  async current() {
    if (this.chosen && this.evidence?.source !== 'voice') return {language: this.chosen, source: 'setting'};
    if (this.evidence) return {language: this.evidence.language, source: this.evidence.source};
    const ui = await this.#ui();
    return ui ? {language: MOD_LANGUAGES.includes(ui) ? ui : 'en', source: 'ui'} : {language: 'en', source: 'default'};
  }
}
