# Interface languages

## Player controls

Open **Companion Manager → Settings → Interface → Interface language**.
Choose a language, then save the setting. Discarding unsaved changes restores
the previous selection.
The default, **Automatic (game interface language)**, follows Cyberpunk's
on-screen language. The mod supports English, Simplified Chinese, Traditional
Chinese, Spanish, Brazilian Portuguese, French, German, Italian, Polish, Czech,
Hungarian, Turkish, Russian, Ukrainian, Japanese and Korean (sixteen in all).
Unsupported game languages (Arabic and Thai, which need right-to-left or
script-specific font work) fall back to English.

The selector lists each language by its own name, in this order: English,
简体中文, 繁體中文, Español, Português (Brasil), Français, Deutsch, Italiano,
Polski, Čeština, Magyar, Türkçe, Русский, Українська, 日本語, 한국어. Automatic
maps the game's own codes `it-it`, `pl-pl`, `cz-cz`, `hu-hu`, `tr-tr` and
`ua-ua` (also `cs-cz` and `uk-ua`) to `it`, `pl`, `cs`, `hu`, `tr` and `uk`.

This setting covers mod-owned manager labels, descriptions, feedback, the phone
Chat tab and composer, and the F6/F8 text box. Character names, conversation
profiles, typed messages, saved history, AI replies, voice selection and the
Convai player identity keep their original values. It does not request a new
conversation or change the language spoken by a character.

MCM's header, search and settings draft controls and Codeware's generic
Confirm/Cancel controls use their own localization. Native
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
  existing drafts defer a rebuild until they are saved or discarded.
- Phone hooks target only owned Chat widgets and known mod feedback. World
  composer notification data keeps its English ownership markers while the
  rendered title/hint changes. Neither path replaces the current input text.
  Bounded current-controller scans hold no native widget handles afterward.
- Unknown provider errors remain literal. Immediate native phone invite/dismiss
  notices pass through two narrowly scoped wrappers, with no native lookups in
  the translation callback. Thinking-message suppression remains in place.
- `mod/locales/*.lua` contains the fifteen non-English dictionaries. English uses
  the source key directly. Missing or malformed translations fall back to that
  source, and catalog paths come only from the supported-language allowlist.

## Catalog and development workflow

`localization/en.json` is a generated developer inventory, not a runtime file.
Its 550 keys include active UI and explicitly marked historical/native sources;
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

The locale core and fifteen dictionaries are explicitly listed in both development
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

The first live check found missing Japanese glyphs and blank Chinese labels
under an English game. MCM/Codeware hard-code Raj; their ordinary rendering does
not supply the required fallback for our independent manual choice. A bounded
native experiment changed 91 owned text widgets to the installed Japanese font
and restored readable labels. This established the cause rather than assuming
catalog coverage proved rendering.

`ui-fonts.lua` selects the game's existing Chinese, Traditional Chinese,
Japanese, Korean and Russian families (Ukrainian uses the same Cyrillic family
as Russian; its autonym Українська is rendered with it before the choice is
saved). Italian, Polish, Czech, Hungarian and Turkish need only Basic Latin,
Latin-1 and Latin Extended-A letters (ł ą ę ś ż ő ű ř ů č ě ğ ş ı İ). The game
ships those languages with its ordinary Latin family, so they have no override
and owned text keeps its original font. `bridge/ui-catalog.test.mjs` fails if a
dictionary uses a glyph outside the range its font renders (Latin through U+017F
for those five, Cyrillic U+0400-04FF for Russian and Ukrainian) and checks that
each file really uses its characteristic letters. The tests prove the mapping
and character ranges; they cannot see the game's glyph tables, so the first
in-game look at ї є ґ and İ ı ğ ş is still worth doing. It keeps supported original weights and
uses Semi-Bold when a family lacks that weight. Per-surface scopes retain plain
original family paths, styles, locks and full-width hash strings; no widget
handles. Restoration uses ink's family/style setter and checks that a later
independent font change has not replaced the mod's font. A selector's native
language name uses its own font before the new choice is saved.

The live CET wrapper differs from Codeware's redscript declaration. The tested
getter is `ResRef.ToString(widget.fontFamily)`; passing that wrapper to
`ResourceAsyncRef.GetPath(script_ref<ResourceAsyncRef>)` fails. Raw property
assignment restores the resource value but has no explicit renderer invalidation,
so production restoration uses `SetFontFamily(originalPath, originalStyle)`.
The [CET conversion source](https://github.com/maximegmd/CyberEngineTweaks/blob/v1.37.1/src/scripting/Scripting.cpp#L848-L895)
and the actual game probe support this boundary.

Codeware's input uses a separate hidden measurement text and a cache without a
font key. Fresh empty inputs receive matching visible/measurement fonts before
measurement. Used or measuring inputs retain their existing family until safe
recreation. No synthetic SetText, selection reset or draft rewrite is used.

The production font fix is installed. All ten Settings pages were captured and
inspected, including titles, sidebar labels, descriptions and selection values.
Japanese rendered before Apply while English remained selected, and reverting
restored the original choice. The combined regression suite for that fix passed
**1,432 tests, zero failures/skips**, including the installed MCM API and font,
draft, lifecycle, input-cache and restoration coverage. Native framework labels
remain in the game language as described above.

The phone check found its popup at controller index 132, beyond the former scan
limit. Both input adapters now use a bounded 512-controller allowance. Compiled
private phone/notification widget references are absent in CET, so inspected
native subtrees provide the fallback. A notification child lookup can return
the root canvas for an unresolved path; its type must be checked before calling
text methods. These cases have 35 focused regression checks.

Japanese phone Chat/breadcrumb/hint text rendered. The user typed a short unsent
test draft and confirmed the caret stayed correct. Its visible and measurement
fonts both reported the Japanese family, Regular, 32 points. The draft survived
restoring Auto/English. An empty world composer showed matching 38-point input
fonts; its private instruction-label lookup received the additional correction
above. This is representative native evidence, not every screen size/input
method combination.

The temporary heading **UI layout check** belonged only to the development
probe. Its modal was cancelled, the test draft was removed, Auto/English and the
original voice settings were restored, and the temporary installed diagnostic
hook/helper were removed. No test dialogue was submitted. On October 1 the user
asked to stop further UI polishing; preserve the accepted interface and focus
on remaining gameplay/content work.

The update is Lua-only. Activation needs CET's **Reload All Mods**, with no
game restart or voice-service restart. Eye contact and accepted facial/movement
behavior are outside this change.
