# Interface languages

## Player controls

Open **Companion Manager → Settings → Interface → Interface language**.
Choose a language, then use MCM's **Apply**. **Revert** discards the change.
The default, **Automatic (game interface language)**, follows Cyberpunk's
on-screen language. The mod supports English, Simplified Chinese, Traditional
Chinese, Spanish, Brazilian Portuguese, French, German, Russian, Japanese and
Korean. Unsupported game languages fall back to English.

This setting covers mod-owned manager labels, descriptions, feedback, the phone
Chat tab and composer, and the F6/F8 text box. Character names, conversation
profiles, typed messages, saved history, AI replies, voice selection and the
Convai player identity keep their original values. It does not request a new
conversation or change the language spoken by a character.

The MCM framework's header, search, Apply/Revert and shared controls, and
Codeware's generic Confirm/Cancel controls, use their own localization. Native
Messages/Contacts and story SMS follow the game. The mod does not change these
global settings or another mod's UI to match a manual selection.

## Implementation

- `mod/ui-locale.lua` owns one cached selection, dictionary and revision. Exact
  English source strings are keys. Named `{tokens}` keep character names and
  user data literal and allow each translation its own word order.
- Only top-level CET updates read the native language or load a Lua dictionary.
  Rendering and feedback callbacks use cached string lookups. This preserves
  the native callback allocation boundary established after the MCM crash.
- Auto reads `/language` → `OnScreen`, matching the installed Codeware API.
  Subtitle and voice-over language are separate. A two-second poll uses elapsed
  wall time as well as frame delta so paused menus still update. A temporarily
  unavailable setting retains the last successful choice.
- Manager settings validate and atomically save the canonical `uiLanguage`
  value before queuing a language change. Failed saves leave the old choice
  active. MCM refreshes its provider/schema after the locale revision changes;
  existing drafts defer a rebuild until Apply/Revert.
- Phone hooks target only owned Chat widgets and known mod feedback. World
  composer notification data keeps its English ownership markers while the
  rendered title/hint changes. Neither path replaces the current input text.
  Bounded current-controller scans hold no native widget handles afterward.
- Unknown provider errors remain literal. Immediate native phone invite/dismiss
  notices pass through two narrowly scoped wrappers, with no native lookups in
  the translation callback. Thinking-message suppression remains in place.
- `mod/locales/*.lua` contains the nine non-English dictionaries. English uses
  the source key directly. Missing or malformed translations fall back to that
  source, and catalog paths come only from the supported-language allowlist.

## Catalog and development workflow

`localization/en.json` is a generated developer inventory, not a runtime file.
Its 383 keys include active UI and explicitly marked historical/native sources;
coverage alone is not proof that a particular renderer is translated.

```powershell
node scripts/Extract-UiCatalog.mjs --summary
node scripts/Extract-UiCatalog.mjs --check --summary
$env:CYBERPUNK_MCM_API = 'E:\SteamLibrary\steamapps\common\Cyberpunk 2077\bin\x64\plugins\cyber_engine_tweaks\mods\ModConfigurationMenuAPI'
npm run test:ui-languages
```

Review call sites when adding text. Use a complete source sentence with named
tokens for dynamic content; do not concatenate English fragments. Add its
translation to each dictionary, regenerate the catalog, and verify token counts,
UTF-8, ownership and actual menu behavior. Do not translate arbitrary strings or
use localized display text as a success signal.

The locale core and nine dictionaries are explicitly listed in both development
and proposed release manifests. They stay in the Lua-only Scripts package.
No game fonts, credentials, histories, local benchmark recordings or developer
runtime folders are included by this change.

## Verification and limits — October 1

The combined source suite passed **1,407 tests, with no failures or skips**,
including the installed MCM API. Checks cover atomic persistence, draft safety,
Auto polling in paused menus, fallback, literal names/content, phone ownership,
native feedback, teardown and archive/development-manifest agreement. A final
call-site review also corrected two English-only feedback paths: no target for
world chat and selection of a character for memory controls, plus model-browser
fallbacks. The final focused suite passed **97 checks**. Native HUD queue
translation is scoped to the actual queue call, so a similarly worded provider
error remains literal even after a native exception.

The installed game contains native Chinese, Traditional Chinese, Japanese,
Korean and Russian font families. MCM and Codeware default to Raj; static font
inspection cannot establish fallback when the mod language differs from the
game language. In-game glyphs, text fit and hot-refresh behavior still require
visual inspection before claiming all ten layouts are qualified. Any necessary
font adjustment must include Codeware's separate input-measurement text and
must remain scoped to owned widgets. Native framework labels may remain in the
game language as described above.

The update is Lua-only. Activation needs CET's **Reload All Mods**, with no
game restart or voice-service restart. Eye contact and accepted facial/movement
behavior are outside this change.
