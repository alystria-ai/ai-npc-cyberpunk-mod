# Dynamic info (Settings > Conversations > Dynamic info)

Added 2026-10-22 from a player report: NPCs said V was "standing in the middle of Little China" while V was inside the H10 apartment, and they
tended to mention where V was even when the talk had nothing to do with it. This page lists what the mod tells a character about the moment, lets
the player turn each kind off, and says how the place is worded. The audit of what is fed to a turn is `docs/DYNAMIC_CONTEXT_AUDIT.md`.

## What the player sees

**Settings > Conversations > Dynamic info (Open)** opens a page with nine switches, all on by default. An off kind is left out of every conversation
provider (Convai, Mistral, Local AI and Custom) and the mod stops reading it from the game. The page has the usual Back row and takes part in
Restore defaults (Native Settings UI's own button, and the Defaults footer button in Mod Configuration Menu).

| Switch (row id) | Saved key | What it covers | Dropped from the prompt | No longer read from the game |
| --- | --- | --- | --- | --- |
| Location (`dynamic:location`) | `dynamicInfo.location` | the district, V's apartment or the named place, indoors or outdoors; an ordinary NPC's "where you are now" | the place sentence of the right-now block (every form), `archetypeContext` | `currentDistrict()`, the indoors read, Johnny's arrival-at-a-place sampling. Not covered: the picture Convai gets of what V sees, and an add-on's own text |
| Time and weather (`dynamic:time`) | `dynamicInfo.time` | the hour and the weather | the Background line (and the clock in the block) | the game clock, the weather |
| Company and vehicle (`dynamic:company`) | `dynamicInfo.company` | who is with V, in a vehicle, driving, V's motion, what a companion is doing and whether she wears other clothes than her appearance text (docs/COMPANION_OUTFITS.md) | "Also with V", "V is in a vehicle / driving / walking" and the companion's own activity | the party read, the activity inputs, the vehicle read |
| Health, heat and fights (`dynamic:condition`) | `dynamicInfo.condition` | V's health band, the police heat, the last fight | "V is hurt", the heat sentence, the battle block of a manual turn | the health and heat reads, and the fight read of a manual turn (`battles.captureManual`: group, phone, microphone and typed text). The battle module's own capture is never gated: battle reactions carry their own fight whatever the switch says |
| V's money (`dynamic:money`) | `dynamicInfo.money` | a rough band: nearly broke ... rich | the money sentence | the money read |
| V's gear and clothes (`dynamic:gear`) | `dynamicInfo.gear` | clothes, weapons, cyberware | the gear block (and what a bystander can see) | `playerGear:capture()` |
| V's gender and lifepath (`dynamic:about`) | `dynamicInfo.about` | V's gender and lifepath | "V is a woman ..., lifepath ..." | the gender and lifepath reads for the turn (the world facts of the story may still reflect the lifepath) |
| Quest and journal (`dynamic:quest`) | `dynamicInfo.quest` | the tracked quest and objectives, open jobs, the journal history | the journal, jobs and history blocks (not even the "history is unavailable" line) | `questContext.capture()`, and the journal-history scan is not stepped, asked for or sent (unless Johnny's remarks need it) |
| Recent game dialogue (`dynamic:dialogue`) | `dynamicInfo.dialogue` | the last lines of scenes and V's chosen replies | the game-dialogue block | `gameDialogue:capture()` (the recorder stays: Johnny's remarks and the add-ons hear the game's lines through it, and it only works when the game shows a line) |

What is deliberately not a switch: what each character knows about the story (the world facts and the recent shared events, they are the character's own
knowledge and the bridge binds a conversation to the save with them), a fight reaction's own subject (battle reactions have their own setting), the pickups
of a loot reaction, the relationship style (Relationships page), the vision picture (Convai only, always on since the Companions can see setting was retired,
and it follows the same place rule: indoors or outdoors only from the text, else the picture), V's voice gender and the dialogue volume for V's typed-line
voice (they are no part of the words the model reads; they keep working with every switch off).

## Where it is applied

Both halves follow the same saved table (`runtime/settings.json`, `"dynamicInfo": {"location": true, ...}`; a missing or non-boolean value is on, a key that
is not a kind is dropped on load; the table is also in the support report's settings section, with a `dynamicInfoOff` list of the kinds that are off).

- **Game side** (`mod/manager.lua`: `dynamicInfoKinds`, `M.dynamicInfo(kind)`, `applySettings` key `dynamicInfo`, `convaiDynamicInfo` global published on load and
  on save; `mod/manager-ui.lua`: the page and the `dynamic:<kind>` rows; `mod/turn-context.lua`: `options.enabled(kind)`; `mod/init.lua`: `convaiGateCapture`,
  `convaiHistoryWanted`). All reads happen when a turn is built, never per frame. The only per-frame addition is one table read (`convaiDynamicInfo.quest`)
  in front of the journal scan, which an off switch removes. A cached turn-context snapshot is not reused under other switches.
- **Bridge side** (`bridge/dynamic-info.mjs`, followed from `runtime/settings.json` by the settings poll): every provider builds a turn's context in one place,
  `conversationContextBlocks` in `bridge/quest-context.mjs` (and `voiceConversationBlocks` for an add-on voice, `archetypeContext` in `bridge/protocol.mjs`).
  Convai sends that string as its dynamic info; Mistral, Local AI and Custom lay the same blocks out as `contextParts` for `buildMessages`. So an off kind is absent
  from all four even when an older request still carries it. `stripSnapshot` removes a kind's fields from the turn-context snapshot before it is worded.

## Where V is, in words

The district and the specific record come from `PreventionSystem:GetCurrentDistrict` (`mod/init.lua` `currentDistrict`), and whether V is in a building from
`IsEntityInInteriorArea`. `bridge/place-names.mjs` words them, `bridge/turn-context.mjs` `whereSentence` says them:

- The place is no longer part of the first sentence ("You are with V in person, standing near V."), because the Mistral and Local AI prompt repeats that sentence right
  before V's words (`[YOU, RIGHT NOW: ...]`) and a place there was worked into every reply. The place is its own second sentence.
- V's apartment or a named interior: "You are inside V's apartment in Megabuilding H10." / "You are inside Lizzie's Bar, Watson."
- The Badlands: "You are outdoors in ..., out in open country."
- A plain district with the game's own indoors reading: "You are indoors, in a building in Little China, Watson; which building is not given." or
  "You are outdoors in Little China, Watson, in the open air, not inside a building."
- Nothing says: "You are somewhere in Little China, Watson; exactly where is not given."
- A phone chat, a call and Johnny get the same sentence about V ("V is ..."). Never "standing in" or "in the middle of" a district.
- In a vehicle the interior flag says nothing about the air around the car, so a companion riding along gets the "somewhere in" form, never "in the open air".
- The guidance at the end of every form now ends "Do not recite it, and mention a place or the time only if it matters to what V says." (an ordinary NPC: "bring it up
  only when it matters to what V says"), and an ordinary NPC's district block says "Mention it only when it matters to what V says" (it used to say "let the place flavor
  what you say"). One short sentence each: prompts stay short.

Limits: the game's record for the H10 hallways or a megabuilding lobby may be a plain `LittleChina` record, in which case the sentence is the indoors / somewhere-in
form above, not the apartment. Only V's own apartment records (`HOME_PLACES` in `bridge/place-names.mjs`) and the named interiors are said by name.

## Tests

`bridge/dynamic-info.test.mjs` (every kind off, for Convai, Mistral, Local AI and Custom, with every other kind still present; the Lua reads; the location
wording), and the Dynamic info and Forget cases in `bridge/manager.test.mjs`, `bridge/nsui-manager.test.mjs`, `bridge/mcm-host.test.mjs`,
`bridge/settings-file-lua.test.mjs` and `bridge/support-report*.test.mjs`, plus `bridge/nsui-labels.test.mjs` (every label of the page fits, in all 16 languages).
