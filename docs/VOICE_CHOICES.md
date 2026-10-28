# Speak dialogue choices

Settings > Gameplay > **Speak dialogue choices** (off by default). On, while the game shows its own dialogue choice list, the player can **say** a choice and it is picked: its words, a part of them, or its number ("two", "the second one", "the last one"). Nothing else happens: no character answers, no conversation starts, no Convai session or memory is touched, and no language model is called.

Built 2026-10-28 on branch `feat/voice-choices`. Not yet tried in the game (see "Live checks").

## Parts

| Part | File | Job |
|---|---|---|
| Game half | `mod/voice-choices.lua` (loaded by `mod/init.lua` only when the setting is on) | Follows the choice list by the game's own events and publishes it in `runtime/choice-hub.json`; asks the bridge's microphone to listen while the list is open; shows one short notice when the bridge could not pick |
| Listening and picking | `bridge/voice-choice.mjs` | The detector (`bridge/voice-activity.mjs`, through the microphone tap) says speech started and stopped; the same local recogniser as a voice turn writes the words; the matcher picks; the keys are pressed |
| Matcher | `bridge/voice-choice-match.mjs` | Pure function, no model, no network. Normalise, positions, token overlap weighted by how few captions contain a word, near spellings |
| Key presser | `bridge/choice-keys.py` | One short-lived Python process per spoken choice, started while the player is still speaking, ends right after the pick. Windows `SendInput` with scan codes |
| Test set | `bridge/voice-choice-cases.json` | 56 hubs, 654 spoken lines in six languages (en, de, es, fr, pl, ru) |

## How the list is followed (both game builds)

Events, never a poll. The module observes `OnDialogsData` (the whole list: `DialogChoiceHubs`, every hub's `choices[].localizedName`, resolved from `LocKey#` and stripped of markup), `OnDialogsActivateHub` and `OnDialogsSelectIndex` (the highlight). `OnDialogsData` is `InteractionUIBase`'s; the other two are on the dialogue widget, so each is tried on `InteractionUIBase` and on `dialogWidgetGameController` and an observer the game does not have is logged and skipped. A list that was already open when the setting went on is read once from the `UIInteractions` blackboard. While a list is open the game's 10 Hz tick also compares two integers (`SelectedIndex`, `ActiveChoiceHubID`) with what was published, so a missed event costs at most 0.1 s; with no list open the tick reads nothing.

Greyed-out lines (`Inactive`, `CheckFailed`) keep their position with an empty caption and are never picked. The list's **fingerprint** (hub id, size, a hash of the captions) goes into every published state and into the result.

Nothing in the shipped redscript is needed: the events, the blackboard and the choice types are the same names on 2.31 and 2.5 (checked by name against both `final.redscripts` caches), so `GameVariant.reds` has nothing to differ. The redscript of the mod still compiles on both builds.

## How a choice is applied

The game has no script call that picks a dialogue choice by index: the highlight and the confirm are the engine's own input actions (`ChoiceScrollUp/Down` mapped to `UI_MoveUp/Down`, `ChoiceApply` mapped to `DialogConfirm`, `r6/config/inputUserMappings.xml`). So the bridge presses what the player would press: **Up / Down** to move the highlight (the list does not wrap) and **Enter** to apply. Those three keys are in the game's mappings as fixed secondary keys (Up and Down for UI move, Enter for dialog confirm) that a player cannot clear. Before every key the presser checks that the foreground window belongs to `Cyberpunk2077.exe`; otherwise it sends nothing. A key that went down always comes up.

The sequence is guarded at every step: the hub file is read again after the words are recognised (same fingerprint or nothing happens), after the arrow keys (the published highlight must be on the chosen line within 0.6 s, else Enter is not pressed) and just before Enter. A list that changed while the player spoke, a highlight that did not move, the game not in front: nothing is applied and the player is not told a choice was made.

## Matching

Tried in this order, all local and in microseconds:

1. **A position**: "option two", "the second one", "number 3", "the last one", "zwei", "la tercera", ordinals and cardinals of the six languages. Nothing else may be in the sentence.
2. **The caption's words**: all of it, a part of it or its most telling words. A word weighs more the fewer visible captions contain it; function words weigh little; a near spelling counts (a recogniser's slip). The score is how much of what was **said** a caption explains, plus a smaller share for how much of the caption was said, so "no" picks "No." over "No, wait, I changed my mind.".
3. **Nothing else.** Chatter that shares only "the" and "you" with a caption is not a choice.

A pick needs a score of at least 0.6, a lead of 0.18 over the next caption and at least 1.0 of matched word weight (`THRESHOLDS` in the matcher). Two captions equally close is `ambiguous`; no fit is `none`. Both end in one short notice ("Two options fit. Say its number." / "No option matched. Say its number.", at most one per 3 s) and nothing is picked. Meaning-only paraphrases ("what does this cost" for "How much do you charge?") are left alone on purpose.

### Accuracy on the test set

`bridge/voice-choice-match.test.mjs` pins it. 654 spoken lines over 56 hubs, written in the style of the game's choice lists (a fixer's offers, vendor and ripperdoc menus, phone replies, "Never mind" exits, bracketed skill checks), each with: the caption read out, a paraphrase, one telling word, a position, a near miss (same words other meaning, or two options equally close) and chatter.

| Kind | Lines | Picked right | Picked wrong |
|---|---|---|---|
| Caption read out | 130 | 130 | 0 |
| Position ("option two") | 90 | 90 | 0 |
| One telling word | 55 | 52 | 0 |
| Paraphrase (other words, same meaning) | 131 | 18 | 0 |
| Near miss (must pick nothing) | 168 | 0 picked | 0 |
| Chatter and a missing position (must pick nothing) | 80 | 0 picked | 0 |

**Zero wrong picks and zero picks on near misses or chatter**; the test fails on a single one. Paraphrases are mostly refused by design; the player hears the short notice and says the number.

## Interplay with the other voice features

* **Voice activation** (Settings > Voices): never listens while a choice list is on screen (its own busy test), so the two never record the same sentence. Speak dialogue choices opens the same microphone tap (`listenChoice` in `mod/microphone.lua`) only while a list is open and releases it when the list closes; with Voice activation off nothing else about it changes. The bridge lets a listen request through when either setting is on.
* **V speaks your microphone lines**: no turn exists, so V says nothing for a spoken choice; the game plays V's own line for the choice it applies, as for a keypress.
* **Talk keys, group voice, a controller button on the Key bindings page**: unchanged. The game already keeps them out while a list is open (`battle-observer` marks `choices` as busy).
* **Convai, Mistral, Local AI, Custom**: not involved. Recognition needs the local recogniser or Mistral transcription already set up for voice input; without one the player gets the notice "Speaking a choice needs speech recognition on this PC.".

## Cost

Off: one boolean per game tick, nothing loaded. On, no list: the registered observers return at their first line when the setting is off; the tick reads nothing. List open: a file write per change of the list or highlight, two integer reads at 10 Hz, a microphone tap, the detector. The key presser exists only between the start of a spoken sentence and its pick. No per-frame work anywhere.

## Live checks (not run yet)

Listed in the `TODO.md` log entry of 2026-10-28 (Speak dialogue choices).
