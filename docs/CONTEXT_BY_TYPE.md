# Context by character type

A player suggested on Discord (31 Oct 2026): story characters are quest-aware, side characters get quest and world context only when they need it, strangers never. This page says how a turn picks what a character is told, per type, and where the table lives.

## Before

`bridge/quest-context.mjs` `conversationContextBlocks` made one cut: a crowd person (`isAmbientProfile`, a resident or an `npc-*` archetype) got no journal, jobs, history or world facts and saw only what a bystander sees of V. Every other character, from Judy to the 575 cast sweep side characters (a shopkeeper, a ganger, a MaxTac officer), got everything: V's tracked quest, V's open jobs, the history of V's finished quests and the world facts. A side character with no part in V's story still heard about V's main job.

## The types

`bridge/character-type.mjs`, filled once at the bridge start from the roster (`setCharacterRoster(roster)` in `bridge/convai-bridge.mjs`):

| Type | Who | Source |
| --- | --- | --- |
| story | the named cast that is not a cast sweep row (companions, romances, fixers, bosses), and any key the registry does not know (a character the player made, an add-on voice) | roster row `kind: named` without `minor` |
| side | the cast sweep's side characters | roster row `kind: named` with `minor: true` (575 rows) |
| stranger | crowd people | `isAmbientProfile(key)` or a roster row of kind `ambient` or `archetype` |

## The table

`POLICY` in `bridge/character-type.mjs`. One row per type, one value per part of the context. `all` is the part as it has always been, `tied` is only what is tied to this character, `none` is never.

| Part (block key) | story | side | stranger |
| --- | --- | --- | --- |
| journal: V's tracked quest | all | tied | none |
| jobs: V's open jobs | all | tied | none |
| history: V's finished and failed quests | all | tied | none |
| recency: what V and the character did together last | all | all | none |
| story: the main story as the character knows it | all | all | none |
| briefing: a job the character gave | all | all | none |
| knowledge: the world facts the character knows | all | all | none |

recency, story, briefing and knowledge are per speaker by construction: their rules and shared events name the speaker, so a side character's `all` is only what is about her. Recent game dialogue (`bridge/game-dialogue.mjs`) is already limited to scenes the character took part in, and a stranger sees only what is in front of them (the right-now block, the group, the dialogue they overheard, a fight, loot, what a bystander sees of V's gear). To change a type, change its row. A part that is not in the table is `all`.

## What "tied" means

A quest, a job or a past event is tied to a character when one of these holds:

* **The quest catalog lists the character in it** (`characters` of `research/cyberpunk/generated/quest-catalog.json`, the same data that marks a job `involvesYou`).
* **Its words name the character, their faction or role.** The tie words are the name, the aliases and the proper names of the roster summary (the faction, the crew, the district), worked out once per character. Everyday words that are in every quest ("night", "city", "quest", "gig", "job", "gang") tie nothing.
* **Its words name the place they stand in**, the district and the named area of the turn's right-now facts.
* **V's words in this turn are about it** (the topic words of the talk).

The first three are stable between turns and stay in the stable world part of the prompt. The last one is for this turn only: a tracked quest tied only by V's words is moved to the notes of the turn, after the history, and has no key, so the prompt budget never counts it as a world block and the stable text in front of it does not change.

* journal (`journalByType` in `bridge/quest-context.mjs`): the tracked quest, judged on its title and objectives. A status line with no quest in it ("no active tracked quest") is tied to nobody.
* jobs (`availableQuestsContext(..., {tied: true})`): only jobs the catalog lists the character in. No such job, no block.
* history (`selectJournalHistory(..., {tied: true, place})`): the topic ranking is unchanged, and then the tracked quest and any quest that V's words did not bring up are kept only when tied. With nothing tied there is no block at all, not even its counts.

## The type line

Every character with a known type gets one line in the stable world part, right after the right-now block (a block with no key, so the prompt budget never cuts it):

* story: "You are one of the people V's story runs through, and you know what concerns you of it."
* side: "You are an everyday Night City person with a life of your own, not part of V's story. You know your own corner of the city, your people and your work, and you talk about the jobs V is on only when they touch you or when V brings them up."
* stranger: "You are a stranger to V, an ordinary person in Night City. You know nothing of V's story or jobs, only what is in front of you."

For a named character the role or faction follows, from the first sentence of the roster summary when it starts with the name and "is": "Your place in Night City: a member of the Animals gang, a Night City street crew known for heavy-handed muscle." That works for 620 of the 701 named rows. A character the registry does not know gets no line.

## Prompt order and cost

The line and the stable ties are world blocks. A tie made only by V's words is volatile. The right-now block stays first. Nothing is read from disk per turn, nothing runs per frame: the type, the line and the tie words are Map lookups worked out once, and a tied filter walks the quests of one snapshot once per turn (a side character only). A stranger skips the history and jobs work altogether.

## Tests and live check

`bridge/character-type.test.mjs` (the table, the types of the shipped roster, the line, the tie words, the journal in the stable and the volatile part, history, jobs, `withConversationKnowledge`, cost). Live check (owner): talk to a story character (Judy) with a quest tracked, she knows it as before. Talk to an invited side character (try Adam Giles) with the same quest tracked: "what are you up to?" and "what is V doing?" get no talk of V's main job, and "tell me about the heist" brings it up for that turn. A pedestrian knows nothing of V's jobs. The bridge log's `[TurnContext]` lines are unchanged.
