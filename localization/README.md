# UI source catalog

`en.json` is a developer catalog, generated from reviewed UI call sites. Game runtime dictionaries are Lua files owned by the localization integration; the game does not load this JSON.

```powershell
node scripts/Extract-UiCatalog.mjs
node scripts/Extract-UiCatalog.mjs --check --summary
```

## Contract

- `strings` maps each exact English source key to its English value. Translation dictionaries must preserve every key, the named `{tokens}`, and intentional newlines. Translate values only.
- `contexts` groups keys by surface. `metadata` supplies current source locations. The script is deterministic, has no network/runtime/game dependency, and excludes comments and native resource/name literals.
- `dynamicTemplates` proposes complete sentences for reviewed concatenations. Integration must replace the originating concatenation with an explicit translation call and named values. A catalog entry does not mean that call site has already been localized.
- `planned: true` marks a root-requested language-selector string that is not yet in production source. This is explicit planned UI, not text inferred from unrelated code.
- Character names, biographies, player drafts, AI dialogue, arbitrary provider errors, resource IDs, key codes, and diagnostics are data rather than translation keys. Settings descriptions that mention named characters remain UI descriptions.

## Extraction boundaries

The scanner does **not** classify every source string as UI. It extracts complete literal values from known UI arguments (`readonly`, `setting`, `action`, `category`, `ConvaiPhoneFeedback`, selected native widget setters), reviewed manager validation returns, and player-facing CET binding labels. It recognizes root `ui.t('source', values)` calls and the `text('source', values)` alias only in the two phone/composer adapters. Explicit allowlists cover stored/conditional labels and status text. Every allowlisted literal and every dynamic-template anchor must exist in the scoped files, or generation fails; after a concatenation is replaced, its complete template source key satisfies that check. Removing or changing a source requires reviewing the selector, not silently discarding a translation.

The native `Manager.reds` screen and `manager.lua` legacy view are inventoried under `legacy.*` for completeness. MCM is the active manager; this inventory does not recommend reviving the old screen. Historical bindings in that screen are not current default-binding documentation.

## Integration notes

- Translate complete sentences around `{name}`, `{character}`, `{count}`, `{state}`, `{target}` and other named tokens. Do not translate `" is joining"`-style fragments or rely on English word order. Names and text typed by the player remain unchanged. Numeric tokens require locale-aware plural treatment if the sentence needs it; do not assume English singular/plural rules.
- Keep `CHAT`/`Chat` short enough for the native phone tab. Native Messages, Contacts, stock reply choices, and story SMS already belong to the game’s localization system.
- The F6/F8 composer currently checks English title/message text for ownership. Retain a language-independent ownership marker before presenting translated title or placeholder text.
- Redscript creates immediate phone queued/error messages and fallback hints before Lua reacts. These need a native translation bridge or tightly scoped presentation hooks. A Lua dictionary alone cannot alter compiled string literals.
- MCM owns Apply/Revert/search widgets. Its framework translations are separate from this provider’s schema. Do not use translated status text as an action-success signal.
- Provider/bridge failure text and lower-level companion errors can reach feedback as variables; this bounded catalog does not claim those unscoped origins are translated. Route known errors through explicit UI keys at their origin; preserve or sanitize unknown errors without guessing a translation.
- `nativeHandling` in the JSON records specific hooks and constraints. Catalog coverage and syntax checks do not prove native glyph coverage, layout, hot refresh, or in-game behavior; test those separately.
